/**
 * What home hands a machine by content hash, kept by it (docs/architecture/
 * remote-runners.md §4.2–4.3): the competitions' open data, the hidden test
 * on a trusted machine, the participants' wheels, and the notebooks too big to
 * ride inside a lease.
 *
 * THE LAYOUT IS HOME'S, so that the Docker runner mounts what it always does:
 *
 *   data/competitions/.blobs/<sha256>          open data, wheels, big notebooks
 *   data/competitions/.sealed/<sha256>         the hidden test, apart (purge)
 *   data/competitions/<c>/inputs/<manifest12>/ a data manifest as hard links: /data
 *   data/competitions/<c>/s/<s>/attempts/<a>/inputs/   a hidden-test run's own /data
 *   data/dependencies/bundles/<b>/{wheels/,requirements.lock,manifest.json}
 *
 * Hard links, never copies: two hundred megabytes of data cost one metadata
 * operation per run, as at home (storage.ts · placeCompetitionFile), and a
 * replaced file is a new hash in a new manifest, so a run holding the old one
 * keeps its bytes. Every name under /data is the manifest's and nothing else's:
 * the notebook lists the folder.
 *
 * EVERY BLOB IS CHECKED ON ARRIVAL. A download is written beside its name
 * (.<sha256>.part) and takes the name only once its length and sha256 are the
 * ones asked for; a name in the CAS is a verified blob. A download cut short
 * resumes with a Range request from where it stopped, its first bytes hashed
 * again from the disk, and a home that ignores the range (200) starts it over.
 *
 * ONE STREAM TO HOME AT A TIME (REMOTE_BLOB_STREAMS_PER_RUNNER: home answers a
 * second one with 429). Prefetch goes in `want`'s order, competitions with
 * waiting submissions first, and a blob a lease waits for (a big notebook, a
 * wheel the index would not give) goes ahead of it: the prefetch in progress
 * is stopped, keeps its partial file, and resumes after. Wheels come from the
 * package index's CDN (their own URL, sha256-checked, one at a time beside
 * home's stream), and from home by their hash when the index fails.
 *
 * THE HIDDEN TEST IS KEPT ONLY WHILE IT MUST BE (decision 1): in a directory
 * of its own, purged on forget, untrust, revoke, drain and 401, and its blobs
 * dropped as soon as no wanted manifest or held lease names them. A run that
 * already holds its links keeps them until its attempt is deleted.
 *
 * When the disk runs low, what nobody wants goes, least recently used first,
 * until the floor holds again (evict).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  REMOTE_BUNDLES_MAX,
  REMOTE_DATA_NAME,
  REMOTE_MANIFESTS_MAX,
  REMOTE_REASON_CHARS,
  REMOTE_SHA256,
  REMOTE_WHEEL_NAME,
  remoteManifest,
  remoteText,
  remoteWheelUrl,
  type RemoteDataFile,
  type RemoteFetch,
  type RemoteLease,
  type RemoteProblem,
  type RemoteWantBundle,
  type RemoteWantData,
  type RemoteWheel,
} from '@shared/remote-runner'
import { attemptDir, competitionDir, competitionsDir, inputDir, NOTEBOOK_FILE } from '../competitions/storage.js'
import { bundleDir, dependencyRoot } from '../dependencies/files.js'
import { Backoff, type RemoteClient } from './client.js'
import { readJson, writeWhole } from './state.js'

const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex')

/** How long a download may go without a byte before it is given up as transient and resumed later. */
const IDLE_MS = 60_000
/** A partial download nobody resumed for this long is no longer anyone's. */
const PARTIAL_KEEP_MS = 24 * 60 * 60_000
/** A blob home refused or that failed its hash is not asked for again before this (the next `want` may name another). */
const REFUSED_WAIT_MS = 5 * 60_000

/** Why a fetch did not end in a verified blob. */
export class CacheError extends Error {
  override name = 'CacheError'
  constructor(
    message: string,
    /**
     * `transient`: try again (the path hiccuped); `refused`: home will not
     * hand it out (out of scope, 404); `gone`: replaced since (410), the next
     * want names the new one; `mismatch`: what came is not what was asked;
     * `unauthorized`: the machine is revoked; `preempted`: a lease's blob went
     * first; `purged`: the hidden test was purged meanwhile.
     */
    readonly kind: 'transient' | 'refused' | 'gone' | 'mismatch' | 'unauthorized' | 'preempted' | 'purged',
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
  }
}

/** A data manifest as `want` described it: its files, by the names the notebook reads. */
export interface ManifestRecord {
  competitionId: string
  manifest: string
  sealed: boolean
  files: RemoteDataFile[]
}

/** A package set as `want` described it: its lock and its wheels. */
export interface BundleRecord {
  id: string
  packagesMb: number
  lock: string
  wheels: RemoteWheel[]
}

/** What eviction must leave alone: wanted, or held by a lease. */
export interface Keep {
  manifests: ReadonlySet<string>
  bundles: ReadonlySet<string>
  blobs: ReadonlySet<string>
}

export interface CacheOptions {
  /** Home's blob route. */
  client: Pick<RemoteClient, 'blob'>
  /** books/ under the state root: manifests/ and bundles/ are written there. */
  books: string
  /** The fetch wheels come from the index with: the process's own (its proxy), or a test's. */
  fetch?: typeof fetch
  now?: () => number
  /** Something a sync reports has changed: a manifest or a set became ready, a problem, a fetch's progress. */
  onChange?: () => void
  /** Home answered 401: the machine is revoked (sync.ts stops everything). */
  onUnauthorized?: () => void
  /** The manifests and sets that held leases need, which a `want` without them must not drop. */
  inUse?: () => { manifests: ReadonlySet<string>; bundles: ReadonlySet<string> }
  log?: (line: string) => void
  /** Tests: the wait without a byte, and the backoff's bounds. */
  idleMs?: number
  backoff?: Backoff
}

interface Waiter {
  resolve: (file: string) => void
  reject: (error: Error) => void
}

/** One blob to fetch from home: deduplicated by hash and kind, its waiters woken together. */
interface BlobJob {
  key: string
  sha: string
  bytes: number
  sealed: boolean
  /** 1: a lease waits for it; 0: prefetch. */
  priority: 0 | 1
  order: number
  notBefore: number
  waiters: Set<Waiter>
}

const blobKey = (sha: string, sealed: boolean): string => `${sealed ? 's' : 'o'}:${sha}`

export class Cache {
  readonly blobsDir = path.join(competitionsDir, '.blobs')
  readonly sealedDir = path.join(competitionsDir, '.sealed')
  private readonly options: CacheOptions
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly backoff: Backoff
  private readonly records = new Map<string, ManifestRecord>()
  private readonly bundles = new Map<string, BundleRecord>()
  /** Verified blobs on disk, by blobKey: completeness is asked every sync, and a stat per file per sync is a lot. */
  private readonly present = new Set<string>()
  private readonly installed = new Set<string>()
  private readonly problems = new Map<string, RemoteProblem>()
  private readonly jobs = new Map<string, BlobJob>()
  private readonly refusedUntil = new Map<string, number>()
  private wantedData: string[] = []
  private wantedBundles: string[] = []
  private current: { job: BlobJob; abort: AbortController; received: number } | null = null
  private streaming = false
  private indexing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private order = 0
  private stopped = false

  constructor(options: CacheOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.backoff = options.backoff ?? new Backoff()
  }

  /* -------------------------------------------------------------- start */

  /**
   * What an earlier life left: the verified blobs (a name in the CAS is one),
   * the manifests and sets it was told about, the sets it installed. Partial
   * downloads stay for their resume, unless nobody resumed them for a day.
   */
  load(): void {
    for (const [dir, sealed] of [[this.blobsDir, false], [this.sealedDir, true]] as const) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const name of fs.readdirSync(dir)) {
        if (REMOTE_SHA256.test(name)) this.present.add(blobKey(name, sealed))
        else if (/^\.[a-f0-9]{64}\.part$/.test(name)) {
          const file = path.join(dir, name)
          try {
            if (this.now() - fs.statSync(file).mtimeMs > PARTIAL_KEEP_MS) fs.rmSync(file, { force: true })
          } catch { /* gone meanwhile */ }
        }
      }
    }
    for (const record of this.readBooks<ManifestRecord>('manifests', manifestRecordOf)) this.records.set(record.manifest, record)
    // Data folders moved aside or half built by an earlier life: no container of it is left (the sweep comes first).
    let competitions: string[] = []
    try {
      competitions = fs.readdirSync(competitionsDir)
    } catch { /* none yet */ }
    for (const competition of competitions) {
      if (competition.startsWith('.')) continue
      const inputs = path.join(competitionsDir, competition, 'inputs')
      let names: string[] = []
      try {
        names = fs.readdirSync(inputs)
      } catch {
        continue
      }
      for (const name of names) if (/^\.[a-f0-9]{12}\.(?:old-[a-f0-9]{8}|[a-f0-9]{8}\.tmp)$/.test(name)) fs.rmSync(path.join(inputs, name), { recursive: true, force: true })
    }
    for (const record of this.readBooks<BundleRecord>('bundles', bundleRecordOf)) {
      this.bundles.set(record.id, record)
      if (this.bundleInPlace(record)) this.installed.add(record.id)
    }
  }

  stop(): void {
    this.stopped = true
    this.current?.abort.abort(new CacheError('the agent stops', 'transient'))
    if (this.timer) clearTimeout(this.timer)
    for (const job of this.jobs.values()) for (const waiter of job.waiters) waiter.reject(new CacheError('the agent stops', 'transient'))
    this.jobs.clear()
  }

  /* --------------------------------------------------------------- want */

  /**
   * Home's `want` for data and package sets, in its order. Each data entry is
   * checked against its own name (remoteManifest over its files): a manifest
   * whose files do not hash to it is a `data` problem and is not fetched.
   * Prefetch follows the new list; a hidden test no longer wanted and held by
   * no lease is dropped at once.
   */
  want(data: readonly RemoteWantData[], bundles: readonly RemoteWantBundle[]): void {
    const wanted: string[] = []
    for (const entry of data) {
      if (remoteManifest(entry.files, sha256) !== entry.manifest) {
        this.problem(`data:${entry.manifest}`, { code: 'data', manifest: entry.manifest, detail: 'the files home listed do not hash to the manifest they were listed under' })
        continue
      }
      const known = this.records.get(entry.manifest)
      if (!known || known.competitionId !== entry.competitionId || known.sealed !== entry.sealed) {
        const record: ManifestRecord = { competitionId: entry.competitionId, manifest: entry.manifest, sealed: entry.sealed, files: [...entry.files] }
        this.records.set(entry.manifest, record)
        this.writeBook('manifests', entry.manifest, record)
      }
      wanted.push(entry.manifest)
    }
    this.wantedData = wanted
    for (const entry of bundles) {
      if (entry.lock !== undefined && entry.wheels !== undefined) {
        const record: BundleRecord = { id: entry.id, packagesMb: entry.packagesMb, lock: entry.lock, wheels: [...entry.wheels] }
        const known = this.bundles.get(entry.id)
        if (!known || known.lock !== record.lock || JSON.stringify(known.wheels) !== JSON.stringify(record.wheels)) {
          this.bundles.set(entry.id, record)
          this.writeBook('bundles', entry.id, record)
          if (known) this.installed.delete(entry.id)
        }
      }
    }
    this.wantedBundles = bundles.map((entry) => entry.id)
    const inUse = this.options.inUse?.() ?? { manifests: new Set<string>(), bundles: new Set<string>() }
    // The hidden test of a manifest nobody wants or holds is not kept a minute longer.
    for (const record of [...this.records.values()]) {
      if (record.sealed && !wanted.includes(record.manifest) && !inUse.manifests.has(record.manifest)) this.dropManifest(record)
    }
    // Problems about what home no longer lists are nobody's; one it still lists, refused or not, stays said.
    const listed = new Set(data.map((entry) => entry.manifest))
    for (const [key, problem] of this.problems) {
      if ((problem.manifest && !listed.has(problem.manifest)) || (problem.bundleId && !this.wantedBundles.includes(problem.bundleId))) this.problems.delete(key)
    }
    this.schedule()
  }

  /* ---------------------------------------------------------- readiness */

  /** Complete open manifests, the wanted ones first, as many as a sync carries. */
  readyData(): string[] {
    return this.ready(false)
  }

  /** Complete hidden-test manifests (a trusted machine's only: an untrusted one keeps none). */
  readySealed(): string[] {
    return this.ready(true)
  }

  readyBundles(): string[] {
    const wanted = new Set(this.wantedBundles)
    return [...this.installed].sort((a, b) => Number(wanted.has(b)) - Number(wanted.has(a))).slice(0, REMOTE_BUNDLES_MAX)
  }

  manifest(manifest: string): ManifestRecord | null {
    return this.records.get(manifest) ?? null
  }

  complete(manifest: string): boolean {
    const record = this.records.get(manifest)
    return !!record && record.files.every((file) => this.present.has(blobKey(file.sha256, record.sealed)))
  }

  private ready(sealed: boolean): string[] {
    const wanted = new Set(this.wantedData)
    return [...this.records.values()]
      .filter((record) => record.sealed === sealed && this.complete(record.manifest))
      .sort((a, b) => Number(wanted.has(b.manifest)) - Number(wanted.has(a.manifest)))
      .slice(0, REMOTE_MANIFESTS_MAX)
      .map((record) => record.manifest)
  }

  problemList(): RemoteProblem[] {
    return [...this.problems.values()]
  }

  /**
   * Fetches under way for the panel's «данные ↓ 45 %»: a wanted manifest or
   * set some of whose bytes are here and some not. Bytes count, not files: a
   * manifest of one big table and two small ones is not two thirds done.
   */
  fetchingList(): RemoteFetch[] {
    const found: RemoteFetch[] = []
    const partial = (sha: string, sealed: boolean): number => {
      if (this.current && this.current.job.sha === sha && this.current.job.sealed === sealed) return this.current.received
      try {
        return fs.statSync(this.partPath(sha, sealed)).size
      } catch {
        return 0
      }
    }
    for (const manifest of this.wantedData) {
      const record = this.records.get(manifest)
      if (!record || this.complete(manifest)) continue
      const total = record.files.reduce((sum, file) => sum + file.bytes, 0)
      const have = record.files.reduce((sum, file) => sum + (this.present.has(blobKey(file.sha256, record.sealed)) ? file.bytes : partial(file.sha256, record.sealed)), 0)
      // Wanted and not begun is «ждёт», which the panel tells from the absence here.
      const begun = have > 0 || record.files.some((file) => this.current?.job.key === blobKey(file.sha256, record.sealed))
      if (begun) found.push({ manifest, percent: percentOf(have, total) })
    }
    for (const id of this.wantedBundles) {
      const record = this.bundles.get(id)
      if (!record || this.installed.has(id)) continue
      const total = record.wheels.reduce((sum, wheel) => sum + wheel.bytes, 0)
      const have = record.wheels.reduce((sum, wheel) => sum + (this.present.has(blobKey(wheel.sha256, false)) ? wheel.bytes : 0), 0)
      if (have > 0) found.push({ bundleId: id, percent: percentOf(have, total) })
    }
    return found
  }

  /* ---------------------------------------------------- what a lease uses */

  /**
   * A blob a lease waits for, from home, ahead of any prefetch. The path of
   * the verified blob, or a CacheError: `transient` only when `signal` gave
   * up first, since a lease's blob is asked again through every hiccup until
   * the lease's own preparation stops waiting.
   */
  blob(sha: string, bytes: number, options: { sealed?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    const sealed = options.sealed === true
    const file = this.blobPath(sha, sealed)
    if (this.present.has(blobKey(sha, sealed))) {
      touch(file, this.now())
      return Promise.resolve(file)
    }
    return new Promise<string>((resolve, reject) => {
      const job = this.enqueue(sha, bytes, sealed, 1)
      const waiter: Waiter = {
        resolve: (found) => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve(found)
        },
        reject: (error) => {
          options.signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      const onAbort = (): void => {
        job.waiters.delete(waiter)
        // A blob only this lease asked for and nobody wants since goes back to the queue's order, or out.
        if (job.waiters.size === 0) job.priority = 0
        reject(new CacheError('the lease stopped waiting', 'transient'))
      }
      if (options.signal?.aborted) return onAbort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      job.waiters.add(waiter)
      this.pump()
    })
  }

  /**
   * A data manifest as a folder of hard links (data/competitions/<c>/inputs/
   * <manifest12>/), the open data a run mounts as /data. Reused while it
   * holds exactly the manifest's files; anything else there is rebuilt
   * beside it and renamed into place, and the old folder is moved aside, not
   * emptied: a run of the same manifest may have it mounted, and deleting its
   * entries would empty that run's /data under the notebook. What was moved
   * aside goes at the next start, when no container of this life is left.
   * Throws when a blob is missing.
   */
  dataDir(manifest: string): string {
    const record = this.records.get(manifest)
    if (!record || record.sealed) throw new CacheError(`data manifest ${manifest.slice(0, 12)} is not known here`, 'refused')
    const inputs = path.join(competitionDir(record.competitionId), 'inputs')
    const name = manifest.slice(0, 12)
    const dir = path.join(inputs, name)
    if (this.linkedAs(dir, record)) {
      for (const file of record.files) touch(this.blobPath(file.sha256, false), this.now())
      return dir
    }
    fs.mkdirSync(inputs, { recursive: true, mode: 0o755 })
    const temporary = path.join(inputs, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
    fs.mkdirSync(temporary, { mode: 0o755 })
    try {
      for (const file of record.files) this.link(file, false, path.join(temporary, file.name))
      if (fs.existsSync(dir)) fs.renameSync(dir, path.join(inputs, `.${name}.old-${randomBytes(4).toString('hex')}`))
      fs.renameSync(temporary, dir)
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true })
      throw error
    }
    fs.chmodSync(dir, 0o755)
    return dir
  }

  /**
   * A hidden-test run's own /data (storage.ts · composeRunInputs, the same
   * rule): the open files, with the hidden ones put over them by name, as
   * links in the attempt's `inputs` folder, gone with the attempt.
   */
  composeSealed(lease: Pick<RemoteLease, 'competitionId' | 'submissionId' | 'attemptId' | 'data' | 'sealedData'>): string {
    const open = this.records.get(lease.data)
    const hidden = lease.sealedData ? this.records.get(lease.sealedData) : undefined
    if (!open || open.sealed || !hidden || !hidden.sealed) throw new CacheError('the hidden test of this lease is not known here', 'refused')
    const dir = attemptDir(lease.competitionId, lease.submissionId, lease.attemptId, 'inputs')
    fs.chmodSync(dir, 0o755)
    const replaced = new Set(hidden.files.map((file) => file.name))
    for (const file of open.files) if (!replaced.has(file.name)) this.link(file, false, path.join(dir, file.name))
    for (const file of hidden.files) this.link(file, true, path.join(dir, file.name))
    return dir
  }

  /**
   * The lease's notebook where its run mounts it, alone in its folder
   * (data/competitions/<c>/s/<s>/in/notebook.ipynb, storage.ts · inputDir):
   * from the lease itself when it rides inline, from home by its hash
   * otherwise, and checked against the lease's sha256 and length either way.
   * Returns the folder.
   */
  async placeNotebook(lease: Pick<RemoteLease, 'competitionId' | 'submissionId' | 'notebook'>, signal?: AbortSignal): Promise<string> {
    const dir = inputDir(lease.competitionId, lease.submissionId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const target = path.join(dir, NOTEBOOK_FILE)
    const { sha256: wanted, bytes, inline } = lease.notebook
    if (inline !== undefined) {
      const body = Buffer.from(inline, 'base64')
      if (body.length !== bytes || sha256(body) !== wanted) throw new CacheError('the notebook inside the lease is not the one it names', 'mismatch')
      writeWhole(target, body, { mode: 0o644 })
      return dir
    }
    const blob = await this.blob(wanted, bytes, { signal })
    const temporary = path.join(dir, `.${NOTEBOOK_FILE}.${randomBytes(4).toString('hex')}.tmp`)
    linkOrCopy(blob, temporary)
    fs.renameSync(temporary, target)
    return dir
  }

  /**
   * A package set installed where the harness reads it
   * (data/dependencies/bundles/<id>/: wheels/ and requirements.lock), its
   * wheels fetched now when they are not here, ahead of any prefetch. `null`
   * — home has not described the set yet (it does so for the sets of live
   * leases first, a few per reply); the caller waits for the next sync.
   */
  async bundle(id: string, signal?: AbortSignal): Promise<string | null> {
    const record = this.bundles.get(id)
    if (!record) return null
    if (this.installed.has(id) && this.bundleInPlace(record)) {
      for (const wheel of record.wheels) touch(this.blobPath(wheel.sha256, false), this.now())
      return bundleDir(id)
    }
    this.installed.delete(id)
    for (const wheel of record.wheels) await this.wheel(wheel, signal, 1)
    return this.install(record)
  }

  /** Whether any of the hidden test is kept here: a manifest of it, or a blob. */
  holdsSealed(): boolean {
    return [...this.records.values()].some((record) => record.sealed) || [...this.present].some((key) => key.startsWith('s:')) || [...this.jobs.values()].some((job) => job.sealed)
  }

  /* ------------------------------------------------------- purge, forget */

  /**
   * Every hidden test this machine holds, gone: on untrust, a drain, a revoke
   * and a 401 (decision 1). Its fetches stop, its manifests are forgotten, and
   * the next want of a trusted machine names them again.
   */
  purgeSealed(why: string): void {
    let dropped = 0
    for (const record of [...this.records.values()]) if (record.sealed) { this.dropManifest(record); dropped++ }
    for (const job of [...this.jobs.values()]) if (job.sealed) this.cancel(job, new CacheError(`the hidden test was purged (${why})`, 'purged'))
    fs.rmSync(this.sealedDir, { recursive: true, force: true })
    fs.mkdirSync(this.sealedDir, { recursive: true, mode: 0o700 })
    for (const key of [...this.present]) if (key.startsWith('s:')) this.present.delete(key)
    if (dropped > 0) {
      this.options.log?.(`[runner] the hidden test is purged (${why})`)
      this.options.onChange?.()
    }
  }

  /**
   * Competitions closed or deleted: their data folders go, their manifests
   * are forgotten, their hidden test purged. Except what a held lease mounts:
   * removing the entries of a folder a running container has as /data would
   * empty it under the notebook. Home revokes those leases itself.
   */
  forget(competitionIds: readonly string[]): void {
    if (competitionIds.length === 0) return
    const forgotten = new Set(competitionIds)
    const inUse = this.options.inUse?.().manifests ?? new Set<string>()
    for (const record of [...this.records.values()]) {
      if (!forgotten.has(record.competitionId) || inUse.has(record.manifest)) continue
      this.dropManifest(record)
      if (!record.sealed) fs.rmSync(path.join(competitionDir(record.competitionId), 'inputs', record.manifest.slice(0, 12)), { recursive: true, force: true })
    }
    this.options.onChange?.()
  }

  /**
   * Below the disk's floor, what nobody wants goes until it holds again:
   * first the data folders and package sets of manifests and sets no one
   * keeps (their links hold their blobs' bytes), then unkept blobs, the least
   * recently used first. `freeMb` is asked again after each removal. Returns
   * whether the floor holds.
   */
  evict(keep: Keep, freeMb: () => number | null, floorMb: number): boolean {
    const below = (): boolean => {
      const free = freeMb()
      return free !== null && free < floorMb
    }
    if (!below()) return true
    for (const record of this.records.values()) {
      if (record.sealed || keep.manifests.has(record.manifest)) continue
      fs.rmSync(path.join(competitionDir(record.competitionId), 'inputs', record.manifest.slice(0, 12)), { recursive: true, force: true })
    }
    for (const id of [...this.installed]) {
      if (keep.bundles.has(id)) continue
      fs.rmSync(bundleDir(id), { recursive: true, force: true })
      this.installed.delete(id)
    }
    const candidates: Array<{ file: string; key: string; at: number }> = []
    for (const key of this.present) {
      if (!key.startsWith('o:')) continue
      const sha = key.slice(2)
      if (keep.blobs.has(sha)) continue
      const file = this.blobPath(sha, false)
      try {
        candidates.push({ file, key, at: fs.statSync(file).mtimeMs })
      } catch {
        this.present.delete(key)
      }
    }
    candidates.sort((a, b) => a.at - b.at)
    let removed = 0
    for (const candidate of candidates) {
      if (!below()) break
      fs.rmSync(candidate.file, { force: true })
      this.present.delete(candidate.key)
      removed++
    }
    if (removed > 0) {
      this.options.log?.(`[runner] evicted ${removed} cached file(s) for disk`)
      this.options.onChange?.()
    }
    return !below()
  }

  /** What the wanted manifests and sets need, for eviction's keep set. */
  wantedNeeds(): { manifests: string[]; bundles: string[]; blobs: string[] } {
    const blobs: string[] = []
    for (const manifest of this.wantedData) for (const file of this.records.get(manifest)?.files ?? []) blobs.push(file.sha256)
    for (const id of this.wantedBundles) for (const wheel of this.bundles.get(id)?.wheels ?? []) blobs.push(wheel.sha256)
    return { manifests: [...this.wantedData], bundles: [...this.wantedBundles], blobs }
  }

  /** The blobs of a manifest and of a set, for eviction's keep set. */
  needsOf(manifests: Iterable<string>, bundles: Iterable<string>): string[] {
    const blobs: string[] = []
    for (const manifest of manifests) for (const file of this.records.get(manifest)?.files ?? []) blobs.push(file.sha256)
    for (const id of bundles) for (const wheel of this.bundles.get(id)?.wheels ?? []) blobs.push(wheel.sha256)
    return blobs
  }

  /** Settled when no fetch is under way or queued; for tests. */
  async idle(): Promise<void> {
    while (this.streaming || this.indexing || this.jobs.size > 0) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  blobPath(sha: string, sealed: boolean): string {
    if (!REMOTE_SHA256.test(sha)) throw new CacheError('not a sha256', 'refused')
    return path.join(sealed ? this.sealedDir : this.blobsDir, sha)
  }

  /* ----------------------------------------------------------- the stream */

  /** Queue what the wanted manifests and sets lack, in want's order; drop prefetch nobody wants any more. */
  private schedule(): void {
    if (this.stopped) return
    const needed = new Set<string>()
    for (const manifest of this.wantedData) {
      const record = this.records.get(manifest)
      if (!record) continue
      for (const file of record.files) {
        const key = blobKey(file.sha256, record.sealed)
        if (this.present.has(key) || (this.refusedUntil.get(key) ?? 0) > this.now()) continue
        needed.add(key)
        this.enqueue(file.sha256, file.bytes, record.sealed, 0)
      }
    }
    for (const job of [...this.jobs.values()]) {
      if (job.priority === 0 && job.waiters.size === 0 && !needed.has(job.key) && !(job.key.startsWith('o:') && this.wheelWanted(job.sha))) this.cancel(job, null)
    }
    this.pump()
    this.prefetchWheels()
  }

  private enqueue(sha: string, bytes: number, sealed: boolean, priority: 0 | 1): BlobJob {
    const key = blobKey(sha, sealed)
    let job = this.jobs.get(key)
    if (!job) {
      job = { key, sha, bytes, sealed, priority, order: this.order++, notBefore: 0, waiters: new Set() }
      this.jobs.set(key, job)
    } else if (priority > job.priority) {
      job.priority = priority
      job.notBefore = 0
    }
    // A lease's blob goes ahead of the prefetch under way, which keeps its bytes and resumes after.
    if (priority === 1 && this.current && this.current.job.priority === 0 && this.current.job.key !== key) {
      this.current.abort.abort(new CacheError('a lease needs the stream', 'preempted'))
    }
    return job
  }

  private cancel(job: BlobJob, error: CacheError | null): void {
    this.jobs.delete(job.key)
    if (this.current?.job === job) this.current.abort.abort(error ?? new CacheError('not wanted any more', 'preempted'))
    for (const waiter of job.waiters) waiter.reject(error ?? new CacheError('not wanted any more', 'refused'))
  }

  private next(): BlobJob | null {
    const now = this.now()
    let best: BlobJob | null = null
    for (const job of this.jobs.values()) {
      if (job.notBefore > now) continue
      if (!best || job.priority > best.priority || (job.priority === best.priority && job.order < best.order)) best = job
    }
    return best
  }

  private pump(): void {
    if (this.streaming || this.stopped) return
    this.streaming = true
    void (async () => {
      try {
        for (let job = this.next(); job && !this.stopped; job = this.next()) await this.take(job)
      } finally {
        this.streaming = false
        this.current = null
        this.wake()
      }
    })()
  }

  /** One job through the stream, and what follows from how it ended. */
  private async take(job: BlobJob): Promise<void> {
    const abort = new AbortController()
    this.current = { job, abort, received: 0 }
    try {
      const file = await this.download(job, abort.signal)
      this.backoff.reset()
      this.jobs.delete(job.key)
      this.present.add(job.key)
      this.refusedUntil.delete(job.key)
      for (const waiter of job.waiters) waiter.resolve(file)
      this.clearProblemsOf(job)
      this.afterArrival(job)
    } catch (raw) {
      const error = raw instanceof CacheError ? raw : new CacheError(String(raw), 'transient')
      if (error.kind === 'preempted' || error.kind === 'purged') return
      if (error.kind === 'unauthorized') {
        for (const pending of [...this.jobs.values()]) this.cancel(pending, error)
        this.options.onUnauthorized?.()
        return
      }
      if (error.kind === 'transient') {
        // Through every hiccup, a lease's blob and a prefetch alike: after a wait.
        job.notBefore = this.now() + this.backoff.next(error.retryAfterMs)
        return
      }
      // Refused, gone, or not what was asked: not asked again for a while, and said.
      this.jobs.delete(job.key)
      this.refusedUntil.set(job.key, this.now() + REFUSED_WAIT_MS)
      for (const waiter of job.waiters) waiter.reject(error)
      this.problemOf(job, error)
    } finally {
      this.current = null
      this.options.onChange?.()
    }
  }

  /** The earliest wait of a queued job, as a timer: a backoff ends by itself. */
  private wake(): void {
    if (this.stopped || this.timer) return
    const waits = [...this.jobs.values()].map((job) => job.notBefore)
    if (waits.length === 0) return
    const delay = Math.max(0, Math.min(...waits) - this.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, delay)
    this.timer.unref?.()
  }

  /**
   * One blob from home into the CAS (see the header): resumed with a Range
   * when part of it is here, hashed as it comes, given its name only whole.
   */
  private async download(job: BlobJob, signal: AbortSignal): Promise<string> {
    const final = this.blobPath(job.sha, job.sealed)
    if (fs.existsSync(final) && fs.statSync(final).size === job.bytes) return final
    fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 })
    const part = this.partPath(job.sha, job.sealed)
    let offset = 0
    try {
      offset = fs.statSync(part).size
    } catch { /* nothing yet */ }
    if (offset > job.bytes) {
      fs.rmSync(part, { force: true })
      offset = 0
    }
    const hash = createHash('sha256')
    if (offset > 0) for await (const chunk of fs.createReadStream(part, { start: 0, end: offset - 1 })) hash.update(chunk as Buffer)
    // Nothing to ask for: a blob of no bytes, or a partial file a crash left whole before its rename.
    if (offset === job.bytes) {
      try {
        return this.seal(part, final, hash.digest('hex'), job, offset)
      } catch (error) {
        // Its first bytes were not the blob's after all: from the start, now.
        if (offset === 0) throw error
        return this.download(job, signal)
      }
    }
    const reply = await this.options.client.blob(job.sha, offset, signal)
    if (signal.aborted && signal.reason instanceof CacheError) {
      if (reply.kind === 'ok') await reply.body.cancel().catch(() => undefined)
      throw signal.reason
    }
    if (reply.kind === 'refused') {
      if (reply.error === 'unauthorized') throw new CacheError('home answered 401', 'unauthorized')
      if (reply.error === 'gone') throw new CacheError(`home replaced ${job.sha.slice(0, 12)} since`, 'gone')
      // A range past the end: the partial file is not a prefix of this blob. From the start.
      if (reply.status === 416 && offset > 0) {
        fs.rmSync(part, { force: true })
        return this.download(job, signal)
      }
      throw new CacheError(`home refused ${job.sha.slice(0, 12)}: ${reply.error}${reply.detail ? ` (${reply.detail})` : ''}`, 'refused')
    }
    if (reply.kind === 'transient') throw new CacheError(reply.reason, 'transient', reply.retryAfterMs)
    let start = 0
    if (reply.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(reply.headers.get('Content-Range') ?? '')
      if (!range || Number(range[1]) !== offset || (range[3] !== '*' && Number(range[3]) !== job.bytes)) {
        await reply.body.cancel().catch(() => undefined)
        fs.rmSync(part, { force: true })
        throw new CacheError('home answered a range that is not the one asked for', 'transient')
      }
      start = offset
    }
    // The whole blob came instead of the rest (200 to a Range): start over from its first byte.
    if (start === 0) return this.write(reply.body, part, final, start === offset ? hash : createHash('sha256'), 0, job, signal)
    try {
      return await this.write(reply.body, part, final, hash, start, job, signal)
    } catch (error) {
      // The rest came and the whole is not the blob: the bytes kept from before were not its start. From the start, once.
      if (!(error instanceof CacheError) || error.kind !== 'mismatch') throw error
      fs.rmSync(part, { force: true })
      return this.download(job, signal)
    }
  }

  private async write(body: ReadableStream<Uint8Array>, part: string, final: string, hash: ReturnType<typeof createHash>, start: number, job: BlobJob, signal: AbortSignal): Promise<string> {
    const fd = fs.openSync(part, start === 0 ? 'w' : 'a', 0o644)
    const reader = body.getReader()
    let written = start
    const idle = this.options.idleMs ?? IDLE_MS
    try {
      for (;;) {
        const step = await readWithin(reader, idle, signal)
        if (step.done) break
        written += step.value.byteLength
        if (written > job.bytes) throw new CacheError(`${job.sha.slice(0, 12)} is longer than the ${job.bytes} bytes asked for`, 'mismatch')
        hash.update(step.value)
        fs.writeSync(fd, step.value)
        if (this.current?.job === job) this.current.received = written
      }
      fs.fsyncSync(fd)
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      if (error instanceof CacheError && error.kind === 'mismatch') {
        fs.closeSync(fd)
        fs.rmSync(part, { force: true })
        throw error
      }
      fs.closeSync(fd)
      // Cut short: the bytes stay for the resume. A stop, a preemption and a purge say why they stopped it.
      const reason = signal.reason
      if (reason instanceof CacheError) throw reason
      throw error instanceof CacheError ? error : new CacheError(`the download of ${job.sha.slice(0, 12)} stopped: ${String(error)}`, 'transient')
    }
    fs.closeSync(fd)
    return this.seal(part, final, hash.digest('hex'), job, written)
  }

  /** The partial file takes its name only when it is exactly what was asked for. */
  private seal(part: string, final: string, digest: string, job: BlobJob, written: number): string {
    if (written !== job.bytes || digest !== job.sha) {
      fs.rmSync(part, { force: true })
      throw new CacheError(`${job.sha.slice(0, 12)} arrived as ${written} bytes hashing to ${digest.slice(0, 12)}: not what was asked`, 'mismatch')
    }
    if (written === 0) fs.writeFileSync(part, '', { mode: 0o644 })
    fs.chmodSync(part, 0o644)
    fs.renameSync(part, final)
    return final
  }

  private partPath(sha: string, sealed: boolean): string {
    return path.join(sealed ? this.sealedDir : this.blobsDir, `.${sha}.part`)
  }

  /** After a blob arrived: a set whose wheels are all here is installed. */
  private afterArrival(job: BlobJob): void {
    if (job.sealed) return
    for (const id of this.wantedBundles) {
      const record = this.bundles.get(id)
      if (record && !this.installed.has(id) && record.wheels.some((wheel) => wheel.sha256 === job.sha) && record.wheels.every((wheel) => this.present.has(blobKey(wheel.sha256, false)))) {
        try {
          this.install(record)
        } catch (error) {
          this.problem(`wheels:${id}`, { code: 'wheels', bundleId: id, detail: `the set could not be installed: ${String(error)}` })
        }
      }
    }
  }

  /* -------------------------------------------------------------- wheels */

  private wheelWanted(sha: string): boolean {
    return this.wantedBundles.some((id) => this.bundles.get(id)?.wheels.some((wheel) => wheel.sha256 === sha) && !this.installed.has(id))
  }

  /** The wanted sets' wheels from the index, one at a time beside home's stream; the index failing, from home. */
  private prefetchWheels(): void {
    if (this.indexing || this.stopped) return
    this.indexing = (async () => {
      for (const id of this.wantedBundles) {
        const record = this.bundles.get(id)
        if (!record || this.installed.has(id)) continue
        try {
          for (const wheel of record.wheels) {
            if (this.stopped) return
            await this.wheel(wheel, undefined, 0)
          }
          this.install(record)
        } catch (error) {
          this.problem(`wheels:${id}`, { code: 'wheels', bundleId: id, detail: error instanceof Error ? error.message : String(error) })
        }
      }
    })().finally(() => {
      this.indexing = null
    })
  }

  /**
   * One wheel into the CAS: from its index URL when it has one (no
   * credentials, no Range: the CDN's file is small enough to fetch again),
   * checked against its sha256 and length; from home by its hash otherwise or
   * when the index failed. A wheel from the index that is not the one pinned
   * is not used, whatever the index says.
   */
  private async wheel(wheel: RemoteWheel, signal: AbortSignal | undefined, priority: 0 | 1): Promise<string> {
    const key = blobKey(wheel.sha256, false)
    const final = this.blobPath(wheel.sha256, false)
    if (this.present.has(key)) return final
    const url = remoteWheelUrl(wheel.url)
    if (url) {
      try {
        await this.fromIndex(url, wheel, signal)
        this.present.add(key)
        return final
      } catch (error) {
        this.options.log?.(`[runner] ${wheel.fileName} from the index: ${error instanceof Error ? error.message : String(error)}; asking home`)
      }
    }
    if (priority === 1) return this.blob(wheel.sha256, wheel.bytes, { signal })
    const job = this.enqueue(wheel.sha256, wheel.bytes, false, 0)
    return new Promise<string>((resolve, reject) => {
      job.waiters.add({ resolve, reject })
      this.pump()
    })
  }

  private async fromIndex(url: string, wheel: RemoteWheel, signal?: AbortSignal): Promise<void> {
    const final = this.blobPath(wheel.sha256, false)
    const part = path.join(this.blobsDir, `.${wheel.sha256}.index.part`)
    const stop = new AbortController()
    const signals = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
    // The headers within the stream's idle time; the bytes then under the idle timeout itself.
    const headers = setTimeout(() => stop.abort(new Error('the index did not answer')), this.options.idleMs ?? IDLE_MS)
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: signals, headers: { Accept: 'application/octet-stream' } })
    } finally {
      clearTimeout(headers)
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`the index answered ${response.status}`)
    }
    const hash = createHash('sha256')
    const fd = fs.openSync(part, 'w', 0o644)
    const reader = response.body.getReader()
    let written = 0
    try {
      for (;;) {
        const step = await readWithin(reader, this.options.idleMs ?? IDLE_MS, signals)
        if (step.done) break
        written += step.value.byteLength
        if (written > wheel.bytes) throw new Error('the file is longer than the pinned wheel')
        hash.update(step.value)
        fs.writeSync(fd, step.value)
      }
    } catch (error) {
      stop.abort()
      await reader.cancel().catch(() => undefined)
      fs.closeSync(fd)
      fs.rmSync(part, { force: true })
      throw error
    }
    fs.closeSync(fd)
    if (written !== wheel.bytes || hash.digest('hex') !== wheel.sha256) {
      fs.rmSync(part, { force: true })
      throw new Error('the file is not the pinned wheel (its sha256 or length differs)')
    }
    fs.renameSync(part, final)
  }

  /**
   * A set's folder, built beside its name and renamed into place: the lock
   * and the wheels as links to their blobs, and the list it was built from.
   */
  private install(record: BundleRecord): string {
    const dir = bundleDir(record.id)
    if (this.bundleInPlace(record)) {
      this.installed.add(record.id)
      return dir
    }
    const root = path.join(dependencyRoot, 'bundles')
    fs.mkdirSync(root, { recursive: true, mode: 0o755 })
    const temporary = path.join(root, `.${record.id}.${randomBytes(4).toString('hex')}.tmp`)
    fs.mkdirSync(path.join(temporary, 'wheels'), { recursive: true, mode: 0o755 })
    try {
      for (const wheel of record.wheels) linkOrCopy(this.blobPath(wheel.sha256, false), path.join(temporary, 'wheels', wheel.fileName))
      fs.writeFileSync(path.join(temporary, 'requirements.lock'), record.lock, { mode: 0o444 })
      fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({ id: record.id, packagesMb: record.packagesMb, packages: record.wheels }), { mode: 0o444 })
      fs.chmodSync(temporary, 0o755)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.renameSync(temporary, dir)
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true })
      throw error
    }
    this.installed.add(record.id)
    this.problems.delete(`wheels:${record.id}`)
    this.options.log?.(`[runner] package set ${record.id.slice(0, 12)} is installed (${record.wheels.length} wheels)`)
    this.options.onChange?.()
    return dir
  }

  /** Whether a set's folder holds its lock and each of its wheels at its length. */
  private bundleInPlace(record: BundleRecord): boolean {
    const dir = bundleDir(record.id)
    try {
      if (fs.readFileSync(path.join(dir, 'requirements.lock'), 'utf8') !== record.lock) return false
      return record.wheels.every((wheel) => {
        const stat = fs.lstatSync(path.join(dir, 'wheels', wheel.fileName))
        return stat.isFile() && stat.size === wheel.bytes
      })
    } catch {
      return false
    }
  }

  /* ------------------------------------------------------------- helpers */

  /** A manifest's file at `to`: a hard link to its blob, which must be here. */
  private link(file: RemoteDataFile, sealed: boolean, to: string): void {
    if (!REMOTE_DATA_NAME.test(file.name) || file.name.includes('..')) throw new CacheError(`a data file name this machine will not write: ${JSON.stringify(file.name.slice(0, 40))}`, 'refused')
    const from = this.blobPath(file.sha256, sealed)
    if (!this.present.has(blobKey(file.sha256, sealed))) throw new CacheError(`${file.name} (${file.sha256.slice(0, 12)}) is not here`, 'refused')
    linkOrCopy(from, to)
    touch(from, this.now())
  }

  /**
   * Whether a data folder holds exactly a manifest's files at their lengths.
   * Only this agent writes there, each file from its verified blob (a link,
   * or a copy where the filesystem refuses links), so a name of the right
   * length is that blob's bytes; a missing name, a stray one, or a length
   * that differs is a folder to rebuild.
   */
  private linkedAs(dir: string, record: ManifestRecord): boolean {
    try {
      const names = fs.readdirSync(dir)
      if (names.length !== record.files.length) return false
      return record.files.every((file) => {
        const at = fs.lstatSync(path.join(dir, file.name))
        return at.isFile() && at.size === file.bytes
      })
    } catch {
      return false
    }
  }

  private dropManifest(record: ManifestRecord): void {
    this.records.delete(record.manifest)
    fs.rmSync(path.join(this.options.books, 'manifests', `${record.manifest}.json`), { force: true })
    this.problems.delete(`data:${record.manifest}`)
    if (!record.sealed) return
    // Its blobs, unless another hidden test still kept here names them.
    const kept = new Set([...this.records.values()].filter((other) => other.sealed).flatMap((other) => other.files.map((file) => file.sha256)))
    for (const file of record.files) {
      if (kept.has(file.sha256)) continue
      const key = blobKey(file.sha256, true)
      const job = this.jobs.get(key)
      if (job) this.cancel(job, new CacheError('the hidden test was dropped', 'purged'))
      fs.rmSync(this.blobPath(file.sha256, true), { force: true })
      fs.rmSync(this.partPath(file.sha256, true), { force: true })
      this.present.delete(key)
    }
  }

  private problem(key: string, problem: RemoteProblem): void {
    this.problems.set(key, { ...problem, detail: remoteText(problem.detail, REMOTE_REASON_CHARS, 'start') })
    this.options.onChange?.()
  }

  /** A blob that failed is a problem of every wanted manifest or set that names it. */
  private problemOf(job: BlobJob, error: CacheError): void {
    const detail = error.message
    for (const manifest of this.wantedData) {
      const record = this.records.get(manifest)
      if (record && record.sealed === job.sealed && record.files.some((file) => file.sha256 === job.sha)) this.problem(`data:${manifest}`, { code: 'data', manifest, detail })
    }
    if (!job.sealed) {
      for (const id of this.wantedBundles) {
        if (this.bundles.get(id)?.wheels.some((wheel) => wheel.sha256 === job.sha)) this.problem(`wheels:${id}`, { code: 'wheels', bundleId: id, detail })
      }
    }
    this.options.log?.(`[runner] ${job.sha.slice(0, 12)}: ${detail}`)
  }

  private clearProblemsOf(job: BlobJob): void {
    for (const [key, problem] of this.problems) {
      if (problem.manifest && this.records.get(problem.manifest)?.files.some((file) => file.sha256 === job.sha)) this.problems.delete(key)
    }
  }

  private readBooks<T>(kind: 'manifests' | 'bundles', check: (value: unknown, name: string) => T | null): T[] {
    const dir = path.join(this.options.books, kind)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const found: T[] = []
    for (const name of names) {
      const id = /^([a-f0-9]{32}|[a-f0-9]{64})\.json$/.exec(name)?.[1]
      const value = id ? check(readJson(path.join(dir, name)), id) : null
      if (value) found.push(value)
      else fs.rmSync(path.join(dir, name), { force: true })
    }
    return found
  }

  private writeBook(kind: 'manifests' | 'bundles', id: string, value: unknown): void {
    try {
      writeWhole(path.join(this.options.books, kind, `${id}.json`), JSON.stringify(value), { mode: 0o600 })
    } catch (error) {
      this.options.log?.(`[runner] could not write the book of ${kind} ${id.slice(0, 12)}: ${String(error)}`)
    }
  }
}

/* ------------------------------------------------------------------ files */

/** A hard link, or a copy where the filesystem refuses links (storage.ts · placeCompetitionFile's rule). */
function linkOrCopy(from: string, to: string): void {
  try {
    fs.linkSync(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EEXIST') {
      fs.rmSync(to, { force: true })
      fs.linkSync(from, to)
      return
    }
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS'].includes(code)) throw error
    fs.copyFileSync(from, to)
    fs.chmodSync(to, 0o644)
  }
}

/** Mark a blob used now: eviction goes least recently used first. */
function touch(file: string, now: number): void {
  try {
    const at = new Date(now)
    fs.utimesSync(file, at, at)
  } catch { /* gone: the next use fetches it again */ }
}

function percentOf(have: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(99, Math.floor((have / total) * 100)))
}

/** One read of a stream, given up when nothing comes for `idleMs` or the signal aborts. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number, signal: AbortSignal): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new CacheError('stopped', 'transient')
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CacheError(`no byte in ${Math.round(idleMs / 1000)} s`, 'transient')), idleMs)
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new CacheError('stopped', 'transient'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function manifestRecordOf(value: unknown, manifest: string): ManifestRecord | null {
  const v = value as Partial<ManifestRecord> | null
  if (!v || v.manifest !== manifest || typeof v.competitionId !== 'string' || typeof v.sealed !== 'boolean' || !Array.isArray(v.files)) return null
  const files = v.files.filter((file): file is RemoteDataFile =>
    !!file && typeof file.name === 'string' && REMOTE_DATA_NAME.test(file.name) && typeof file.sha256 === 'string' && REMOTE_SHA256.test(file.sha256) && Number.isSafeInteger(file.bytes))
  if (files.length !== v.files.length) return null
  try {
    return remoteManifest(files, sha256) === manifest ? { competitionId: v.competitionId, manifest, sealed: v.sealed, files } : null
  } catch {
    return null
  }
}

function bundleRecordOf(value: unknown, id: string): BundleRecord | null {
  const v = value as Partial<BundleRecord> | null
  if (!v || v.id !== id || !Number.isSafeInteger(v.packagesMb) || typeof v.lock !== 'string' || !Array.isArray(v.wheels)) return null
  const wheels = v.wheels.filter((wheel): wheel is RemoteWheel =>
    !!wheel && typeof wheel.fileName === 'string' && REMOTE_WHEEL_NAME.test(wheel.fileName) && typeof wheel.sha256 === 'string' && REMOTE_SHA256.test(wheel.sha256) && Number.isSafeInteger(wheel.bytes))
  return wheels.length === v.wheels.length ? { id, packagesMb: v.packagesMb as number, lock: v.lock, wheels } : null
}
