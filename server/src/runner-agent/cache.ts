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
 * EVERY BLOB IS CHECKED ON ARRIVAL. A download is written beside its name,
 * in a partial file that is its own and nobody else's (.<sha256>.part for
 * home's one stream, a name of its own for each fetch from a package index),
 * and takes the name only once its length and sha256 are the ones asked for.
 * Two fetches of one wheel once shared a partial file: the second truncated
 * what the first was writing, the first checked only its own stream, and a
 * wheel with kilobytes of zeros in it took its name and was installed, to
 * fail `pip --require-hashes` in a participant's run. A download cut short
 * resumes with a Range request from where it stopped, its first bytes hashed
 * again from the disk, and a home that ignores the range (200) starts it over.
 *
 * AND A NAME IS CHECKED AGAIN WHEREVER IT IS TAKEN ON TRUST, by its hash and
 * never by its length: what an earlier life left in the CAS (load), a package
 * set's folder reused for a lease (bundleInPlace), a data folder reused for a
 * run (linkedAs). What a file hashes to is booked by what says it has not
 * changed since (HashBook): a restart and a lease read nothing again that was
 * read before.
 *
 * ONE STREAM TO HOME AT A TIME (REMOTE_BLOB_STREAMS_PER_RUNNER: home answers a
 * second one with 429). Prefetch goes in `want`'s order, competitions with
 * waiting submissions first, and a blob a lease waits for (a big notebook, a
 * wheel the index would not give) goes ahead of it: the prefetch in progress
 * is stopped, keeps its partial file, and resumes after. Wheels come from the
 * package index's CDN (their own URL, sha256-checked, one at a time beside
 * home's stream), and from home by their hash when the index fails. A class's
 * files come down the same stream, paced at the class's rate (room-files.ts,
 * remote-classes.md §4.9): ahead of a lease's blob while a run waits on their
 * push, behind it otherwise, ahead of the prefetch always (rankOf); and they
 * leave the CAS once they are copied into their folder (release).
 *
 * THE COUNCIL'S EPOCHS LIVE HERE TOO (council.ts, remote-classes.md §9.2):
 * fetched down the same stream at the class's rate and never ahead of a run
 * waiting on its push, or read from a class container's export by the agent
 * and taken in already checked (adopt); hard-linked into the class's epochs
 * folder, which its council container mounts read-only (place); and pinned —
 * never released nor evicted while an epoch held here names them (pinned).
 *
 * THE HIDDEN TEST IS KEPT ONLY WHILE IT MUST BE (decision 1): in a directory
 * of its own, purged on forget, untrust, revoke, drain and 401, and its blobs
 * dropped as soon as no wanted manifest or held lease names them. A run that
 * already holds its links keeps them until its attempt is deleted.
 *
 * When the disk runs low, what nobody wants goes, least recently used first,
 * until the floor holds again (evict). And no fetch starts below a floor
 * (CacheOptions.diskGate): a prefetch only while the disk is above the one
 * eviction keeps, a lease's own blob only while it leaves what the machine
 * promised home it always keeps free. A write the disk refuses (ENOSPC) is a
 * `disk` problem for the agent to say, and waits: asked again at once, it
 * would only be refused again.
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
import { CLASS_PACE_BURST_BYTES } from '@shared/remote-kernels'
import { COMPETITION_ROW_ID } from '@shared/competition-runtime'
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
/** A fetch the disk had no room for is not tried again before this: eviction (sync.ts · keepDiskFloor) needs a moment, a full disk longer. */
export const DISK_WAIT_MS = 30_000
/** A partial file of a fetch from a package index: never resumed (the CDN's file is fetched whole), so any left at a start is a crash's. */
const INDEX_PART = /^\.[a-f0-9]{64}\.(?:[a-f0-9]{8}\.)?index\.part$/

/** Why a fetch did not end in a verified blob. */
export class CacheError extends Error {
  override name = 'CacheError'
  constructor(
    message: string,
    /**
     * `transient`: try again (the path hiccuped); `refused`: home will not
     * hand it out, or it is not here to be had; `unscoped`: home answered 404,
     * the blob out of this machine's scope as home sees it now (a want that
     * raced its index, a lease since gone), asked again by the next want that
     * still lists it; `gone`: replaced since (410), the next want names the
     * new one; `mismatch`: what came is not what was asked; `unauthorized`:
     * the machine is revoked; `preempted`: a lease's blob went first;
     * `purged`: the hidden test was purged meanwhile; `disk`: no room for it
     * (below a floor, or a write the disk refused), after a wait.
     */
    readonly kind: 'transient' | 'refused' | 'unscoped' | 'gone' | 'mismatch' | 'unauthorized' | 'preempted' | 'purged' | 'disk',
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
  }
}

/** A write the disk refused for want of room: ENOSPC, or a quota (EDQUOT). */
export function diskRefused(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOSPC' || code === 'EDQUOT'
}

/**
 * A data manifest as `want` described it: its files, by the names the
 * notebook reads, and the competitions home listed it for.
 *
 * ONE RECORD PER MANIFEST AND KIND, MANY COMPETITIONS. A manifest names a set
 * of files by their names and hashes alone (remoteManifest), so two
 * competitions with the same files share one (a task set for two groups),
 * and one competition's open data and its hidden test may be the same
 * manifest; home lists each (competition, kind) once (shared/remote-runner.ts
 * · wantOf). The open data and the hidden test are kept apart whatever their
 * hashes (.blobs/ and .sealed/: the hidden test is purged alone), and the
 * open data's folder of links is each competition's own
 * (data/competitions/<c>/inputs/<manifest12>/, home's layout), made for the
 * competition of the lease that mounts it.
 */
export interface ManifestRecord {
  competitions: string[]
  manifest: string
  sealed: boolean
  files: RemoteDataFile[]
}

/** A record's key: its kind and its manifest (one hash may be both a competition's open data and its hidden test). */
const recordKey = (manifest: string, sealed: boolean): string => `${sealed ? 's' : 'o'}:${manifest}`

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
  /**
   * Whether a fetch of `bytes` may start now, for a lease that waits for it
   * or for the prefetch (sync.ts · mayFetch: the floors, and eviction asked
   * for when one does not hold). Absent: always.
   */
  diskGate?: (bytes: number, forLease: boolean) => boolean
  /** A write the disk refused for want of room (ENOSPC): the agent says it as a `disk` problem. */
  onDiskFull?: (detail: string) => void
  /**
   * Blobs held by something besides the manifests and the package sets: the
   * files of the council's epochs (council.ts), which a worker maps from the
   * class's epochs folder by a hard link and a pool on another machine may be
   * sent. Never released, never evicted while named here (§17.1: epochs
   * pinned against LRU).
   */
  pinned?: () => ReadonlySet<string>
  log?: (line: string) => void
  /** Tests: the wait without a byte, the backoff's bounds, and the wait for room on the disk (DISK_WAIT_MS). */
  idleMs?: number
  backoff?: Backoff
  diskWaitMs?: number
  /** The waits a paced blob keeps to (blob's `pace`); tests count them on a clock of their own. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
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
  /**
   * A class's file (room-files.ts): read at the class's rate, in bytes a
   * second, asked anew at every chunk; null — as fast as home sends it, as for
   * everything a lease or the prefetch waits on.
   */
  pace: (() => number) | null
  /** A class's file: whether a run waits on its push now (home promoted it, §8.2), asked whenever the stream chooses. */
  urgent: (() => boolean) | null
}

const blobKey = (sha: string, sealed: boolean): string => `${sealed ? 's' : 'o'}:${sha}`

/**
 * What the one stream takes first, highest first: a class's file a run waits
 * on (a push its barrier promoted, 3), a lease's blob (2), a class's file no
 * run waits on yet (1), the prefetch (0). A job of a higher rank stops the
 * one under way, which keeps its bytes and resumes with a Range after: a
 * lesson's Run is never held behind a submission's dataset for the 30 s its
 * barrier allows (§8.2), and a submission is never held behind a class's
 * files nobody waits on (§4.9).
 */
function rankOf(job: BlobJob): number {
  if (job.priority === 0) return 0
  if (job.pace === null) return 2
  return job.urgent?.() ? 3 : 1
}

export class Cache {
  readonly blobsDir = path.join(competitionsDir, '.blobs')
  readonly sealedDir = path.join(competitionsDir, '.sealed')
  private readonly options: CacheOptions
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly backoff: Backoff
  private readonly records = new Map<string, ManifestRecord>()
  private readonly bundles = new Map<string, BundleRecord>()
  /** What the files of this tree hash to, booked by what says they have not changed since (see HashBook). */
  private readonly hashes: HashBook
  /** Verified blobs on disk, by blobKey: completeness is asked every sync, and a stat per file per sync is a lot. */
  private readonly present = new Set<string>()
  private readonly installed = new Set<string>()
  private readonly problems = new Map<string, RemoteProblem>()
  private readonly jobs = new Map<string, BlobJob>()
  private readonly refusedUntil = new Map<string, number>()
  /** Blobs home answered 404 for since the last want (`unscoped`): their pause ends with the next want. */
  private readonly unscoped = new Set<string>()
  private wantedData: string[] = []
  private wantedBundles: string[] = []
  /** The class files' bucket: one stream at a time, so one bucket for them all. */
  private readonly pacer: Pacer
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
    this.hashes = new HashBook(path.join(options.books, 'hashes.json'), options.log)
    this.pacer = new Pacer(this.now, CLASS_PACE_BURST_BYTES)
  }

  /* -------------------------------------------------------------- start */

  /**
   * What an earlier life left: the blobs that still hash to their names, the
   * manifests and sets it was told about, the sets it installed whose wheels
   * are still the pinned ones. A name is not a verified blob just for being
   * in the CAS: a crash between a rename and the disk's flush, or an earlier
   * build that let two fetches write one file, leaves the wrong bytes under a
   * right name, so each is checked by its hash (from the book when it has not
   * changed since it was hashed) and one that fails goes. Partial downloads
   * stay for their resume, unless nobody resumed them for a day; a package
   * index's never resume, and go.
   */
  load(): void {
    this.hashes.load()
    for (const [dir, sealed] of [[this.blobsDir, false], [this.sealedDir, true]] as const) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name)
        if (REMOTE_SHA256.test(name)) {
          if (this.hashes.sha(file) === name) this.present.add(blobKey(name, sealed))
          else {
            fs.rmSync(file, { recursive: true, force: true })
            this.options.log?.(`[runner] ${name.slice(0, 12)} in the cache does not hash to its name; it is removed and fetched again when wanted`)
          }
        } else if (/^\.[a-f0-9]{64}\.part$/.test(name)) {
          try {
            if (this.now() - fs.statSync(file).mtimeMs > PARTIAL_KEEP_MS) fs.rmSync(file, { force: true })
          } catch { /* gone meanwhile */ }
        } else if (INDEX_PART.test(name)) {
          fs.rmSync(file, { force: true })
        }
      }
    }
    for (const record of this.readBooks<ManifestRecord>('manifests', manifestRecordOf)) this.records.set(recordKey(record.manifest, record.sealed), record)
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
    for (const record of this.readBooks<BundleRecord>('bundles', (value, id, sealed) => (sealed ? null : bundleRecordOf(value, id)))) {
      this.bundles.set(record.id, record)
      if (this.bundleInPlace(record)) this.installed.add(record.id)
    }
    // What the book knew of files no longer here (evicted, purged, replaced) is nobody's.
    this.hashes.prune()
    this.hashes.save()
  }

  stop(): void {
    this.stopped = true
    this.current?.abort.abort(new CacheError('the agent stops', 'transient'))
    if (this.timer) clearTimeout(this.timer)
    for (const job of this.jobs.values()) for (const waiter of job.waiters) waiter.reject(new CacheError('the agent stops', 'transient'))
    this.jobs.clear()
    this.hashes.flush()
  }

  /* --------------------------------------------------------------- want */

  /**
   * Home's `want` for data and package sets, in its order. Each data entry is
   * checked against its own name (remoteManifest over its files): a manifest
   * whose files do not hash to it is a `data` problem and is not fetched.
   * A manifest listed for a second competition is the same record with one
   * more competition (ManifestRecord): its blobs are fetched once. Prefetch
   * follows the new list; a hidden test no longer wanted and held by no lease
   * is dropped at once.
   */
  want(data: readonly RemoteWantData[], bundles: readonly RemoteWantBundle[]): void {
    const wanted: string[] = []
    for (const entry of data) {
      if (remoteManifest(entry.files, sha256) !== entry.manifest) {
        this.problem(`data:${entry.manifest}`, { code: 'data', manifest: entry.manifest, detail: 'the files home listed do not hash to the manifest they were listed under' })
        continue
      }
      const key = recordKey(entry.manifest, entry.sealed)
      const known = this.records.get(key)
      if (!known) {
        const record: ManifestRecord = { competitions: [entry.competitionId], manifest: entry.manifest, sealed: entry.sealed, files: [...entry.files] }
        this.records.set(key, record)
        this.writeBook('manifests', bookName(record), record)
      } else if (!known.competitions.includes(entry.competitionId)) {
        known.competitions.push(entry.competitionId)
        this.writeBook('manifests', bookName(known), known)
      }
      if (!wanted.includes(key)) wanted.push(key)
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
      if (record.sealed && !wanted.includes(recordKey(record.manifest, true)) && !inUse.manifests.has(record.manifest)) this.dropManifest(record)
    }
    // Problems about what home no longer lists are nobody's; one it still lists, refused or not, stays said.
    const listed = new Set(data.map((entry) => entry.manifest))
    for (const [key, problem] of this.problems) {
      if ((problem.manifest && !listed.has(problem.manifest)) || (problem.bundleId && !this.wantedBundles.includes(problem.bundleId))) this.problems.delete(key)
    }
    /*
     * A blob home answered 404 for, and lists again, is asked for again now,
     * not after REFUSED_WAIT_MS: a want names only what home means this
     * machine to have, so a 404 under it is home's scope catching up (its
     * index built after the want was sent, a lease that ended between them),
     * and five minutes of waiting kept a competition's data short here — its
     * notebooks leased to no machine without it — for a blob home would have
     * served at the next ask. Once a want, never in a loop: a refusal again
     * waits for the next one.
     */
    for (const key of this.unscoped) this.refusedUntil.delete(key)
    this.unscoped.clear()
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

  manifest(manifest: string, sealed = false): ManifestRecord | null {
    return this.records.get(recordKey(manifest, sealed)) ?? null
  }

  /** Whether every file of a manifest of this kind (open, or the hidden test) is here, verified. */
  complete(manifest: string, sealed = false): boolean {
    const record = this.records.get(recordKey(manifest, sealed))
    return !!record && record.files.every((file) => this.present.has(blobKey(file.sha256, record.sealed)))
  }

  private ready(sealed: boolean): string[] {
    const wanted = new Set(this.wantedData)
    const key = (record: ManifestRecord): string => recordKey(record.manifest, record.sealed)
    return [...this.records.values()]
      .filter((record) => record.sealed === sealed && this.complete(record.manifest, sealed))
      .sort((a, b) => Number(wanted.has(key(b))) - Number(wanted.has(key(a))))
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
    // One line a manifest: a hash that is both open data and a hidden test is one fetch to the panel (and twice the same subject a sync may not say).
    const said = new Set<string>()
    for (const key of this.wantedData) {
      const record = this.records.get(key)
      if (!record || said.has(record.manifest) || this.complete(record.manifest, record.sealed)) continue
      const total = record.files.reduce((sum, file) => sum + file.bytes, 0)
      const have = record.files.reduce((sum, file) => sum + (this.present.has(blobKey(file.sha256, record.sealed)) ? file.bytes : partial(file.sha256, record.sealed)), 0)
      // Wanted and not begun is «ждёт», which the panel tells from the absence here.
      const begun = have > 0 || record.files.some((file) => this.current?.job.key === blobKey(file.sha256, record.sealed))
      if (!begun) continue
      said.add(record.manifest)
      found.push({ manifest: record.manifest, percent: percentOf(have, total) })
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
   *
   * A CLASS'S FILE TAKES THE SAME ONE STREAM (room-files.ts): home keeps one
   * blob stream for each machine and cuts the older when a newer comes
   * (blobs.ts), so a second stream of the agent's own would only cut this
   * one's. It goes ahead of the prefetch; behind a lease's blob until
   * `urgent` says a run waits on its push, then ahead of it (rankOf); and
   * `pace` (bytes a second, asked at every chunk) holds it to the class's
   * rate through a bucket of CLASS_PACE_BURST_BYTES — unless a lease waits on
   * the same blob too, which then comes as fast as home sends it.
   */
  blob(sha: string, bytes: number, options: { sealed?: boolean; signal?: AbortSignal; pace?: () => number; urgent?: () => boolean } = {}): Promise<string> {
    const sealed = options.sealed === true
    const file = this.blobPath(sha, sealed)
    if (this.present.has(blobKey(sha, sealed))) {
      this.touch(file)
      return Promise.resolve(file)
    }
    return new Promise<string>((resolve, reject) => {
      const job = this.enqueue(sha, bytes, sealed, 1, options.pace ?? null, options.urgent ?? null)
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
   * <manifest12>/), the open data a run of competition `competitionId` mounts
   * as /data: each competition's own, as at home, whoever else shares the
   * manifest. Reused while it holds exactly the manifest's files; anything
   * else there is rebuilt beside it and renamed into place, and the old folder
   * is moved aside, not emptied: a run of the same manifest may have it
   * mounted, and deleting its entries would empty that run's /data under the
   * notebook. What was moved aside goes at the next start, when no container
   * of this life is left. Throws when a blob is missing.
   */
  dataDir(manifest: string, competitionId: string): string {
    const record = this.records.get(recordKey(manifest, false))
    if (!record) throw new CacheError(`data manifest ${manifest.slice(0, 12)} is not known here`, 'refused')
    // A folder of a competition the record does not name would be one that forget and eviction never find.
    if (!record.competitions.includes(competitionId)) {
      record.competitions.push(competitionId)
      this.writeBook('manifests', bookName(record), record)
    }
    const inputs = path.join(competitionDir(competitionId), 'inputs')
    const name = manifest.slice(0, 12)
    const dir = path.join(inputs, name)
    if (this.linkedAs(dir, record)) {
      for (const file of record.files) this.touch(this.blobPath(file.sha256, false))
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
    const open = this.records.get(recordKey(lease.data, false))
    const hidden = lease.sealedData ? this.records.get(recordKey(lease.sealedData, true)) : undefined
    if (!open || !hidden) throw new CacheError('the hidden test of this lease is not known here', 'refused')
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
      for (const wheel of record.wheels) this.touch(this.blobPath(wheel.sha256, false))
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
   *
   * But for `keep`, the hidden test of the leases still held, on a drain or a
   * leave: those are to finish (a drain's whole promise), and one that has not
   * yet linked its inputs (composeSealed) would otherwise be declined for
   * `data`, a decline counted against the submission and the machine for our
   * own purge. Their manifests stay until the leases settle, and the next
   * `want` of a draining machine, which lists no hidden test, drops them. An
   * untrust and a revocation keep nothing: an untrusted machine holds none of
   * it, whatever it runs (the held runs are home's to revoke).
   */
  purgeSealed(why: string, keep: ReadonlySet<string> = new Set()): void {
    let dropped = 0
    for (const record of [...this.records.values()]) if (record.sealed && !keep.has(record.manifest)) { this.dropManifest(record); dropped++ }
    const kept = new Set([...this.records.values()].filter((record) => record.sealed).flatMap((record) => record.files.map((file) => file.sha256)))
    for (const job of [...this.jobs.values()]) if (job.sealed && !kept.has(job.sha)) this.cancel(job, new CacheError(`the hidden test was purged (${why})`, 'purged'))
    // Whatever else is in its directory (a partial download, a blob of a manifest no longer known) goes too.
    fs.mkdirSync(this.sealedDir, { recursive: true, mode: 0o700 })
    for (const name of fs.readdirSync(this.sealedDir)) {
      if (kept.has(name)) continue
      fs.rmSync(path.join(this.sealedDir, name), { recursive: true, force: true })
    }
    for (const key of [...this.present]) if (key.startsWith('s:') && !kept.has(key.slice(2))) this.present.delete(key)
    if (dropped > 0) {
      this.options.log?.(`[runner] the hidden test is purged (${why})${kept.size > 0 ? ', but for what the runs still held read' : ''}`)
      this.options.onChange?.()
    }
  }

  /**
   * Competitions closed or deleted: their data folders go, their manifests
   * are forgotten, their hidden test purged — a manifest another competition
   * still lists stays, for that one. Except what a held lease mounts:
   * removing the entries of a folder a running container has as /data would
   * empty it under the notebook. Home revokes those leases itself.
   */
  forget(competitionIds: readonly string[]): void {
    if (competitionIds.length === 0) return
    const forgotten = new Set(competitionIds)
    const inUse = this.options.inUse?.().manifests ?? new Set<string>()
    for (const record of [...this.records.values()]) {
      const gone = record.competitions.filter((competition) => forgotten.has(competition))
      if (gone.length === 0 || inUse.has(record.manifest)) continue
      if (!record.sealed) for (const competition of gone) fs.rmSync(path.join(competitionDir(competition), 'inputs', record.manifest.slice(0, 12)), { recursive: true, force: true })
      record.competitions = record.competitions.filter((competition) => !forgotten.has(competition))
      if (record.competitions.length === 0) this.dropManifest(record)
      else this.writeBook('manifests', bookName(record), record)
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
      for (const competition of record.competitions) fs.rmSync(path.join(competitionDir(competition), 'inputs', record.manifest.slice(0, 12)), { recursive: true, force: true })
    }
    for (const id of [...this.installed]) {
      if (keep.bundles.has(id)) continue
      fs.rmSync(bundleDir(id), { recursive: true, force: true })
      this.installed.delete(id)
    }
    const candidates: Array<{ file: string; key: string; at: number }> = []
    const pinned = this.options.pinned?.() ?? new Set<string>()
    for (const key of this.present) {
      if (!key.startsWith('o:')) continue
      const sha = key.slice(2)
      if (keep.blobs.has(sha) || pinned.has(sha)) continue
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
    const manifests: string[] = []
    for (const key of this.wantedData) {
      const record = this.records.get(key)
      if (!record) continue
      manifests.push(record.manifest)
      for (const file of record.files) blobs.push(file.sha256)
    }
    for (const id of this.wantedBundles) for (const wheel of this.bundles.get(id)?.wheels ?? []) blobs.push(wheel.sha256)
    return { manifests, bundles: [...this.wantedBundles], blobs }
  }

  /** The blobs of a manifest (of either kind) and of a set, for eviction's keep set. */
  needsOf(manifests: Iterable<string>, bundles: Iterable<string>): string[] {
    const blobs: string[] = []
    for (const manifest of manifests) {
      for (const sealed of [false, true]) for (const file of this.records.get(recordKey(manifest, sealed))?.files ?? []) blobs.push(file.sha256)
    }
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

  /**
   * A class's file copied into its folder (room-files.ts), let go: its blob
   * leaves the CAS unless a manifest, a package set or a fetch still names
   * it. A class folder is a copy, never a link (§8.1: an `open('r+')` in a
   * cell must not rewrite a blob submissions mount), and the blob would
   * otherwise keep the same bytes a second time on the disk until eviction.
   */
  release(sha: string): void {
    if (!REMOTE_SHA256.test(sha)) return
    const key = blobKey(sha, false)
    if (this.jobs.has(key) || !this.present.has(key) || this.options.pinned?.().has(sha)) return
    for (const record of this.records.values()) if (!record.sealed && record.files.some((file) => file.sha256 === sha)) return
    for (const record of this.bundles.values()) if (record.wheels.some((wheel) => wheel.sha256 === sha)) return
    this.present.delete(key)
    fs.rmSync(this.blobPath(sha, false), { force: true })
  }

  /** Whether a verified blob of the open kind is here, by its hash. */
  has(sha: string): boolean {
    return REMOTE_SHA256.test(sha) && this.present.has(blobKey(sha, false))
  }

  /**
   * A file whose bytes the agent itself checked against `sha` (an epoch's
   * export, council.ts, read from the agent's own staging, which no container
   * reaches), taken into the CAS under its hash: renamed there — copied when
   * the CAS is on another filesystem — or dropped when the CAS holds the
   * blob already; booked with its hash, so that no later load reads it again.
   * The blob's path.
   */
  adopt(file: string, sha: string): string {
    const final = this.blobPath(sha, false)
    const key = blobKey(sha, false)
    if (this.present.has(key) && this.hashes.sha(final) === sha) {
      fs.rmSync(file, { force: true })
      this.touch(final)
      return final
    }
    fs.mkdirSync(this.blobsDir, { recursive: true, mode: 0o700 })
    try {
      fs.renameSync(file, final)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw this.diskOr(error, sha.slice(0, 12))
      const part = path.join(this.blobsDir, `.${sha}.${randomBytes(4).toString('hex')}.adopt.part`)
      try {
        fs.copyFileSync(file, part)
        fs.renameSync(part, final)
      } catch (copied) {
        fs.rmSync(part, { force: true })
        throw this.diskOr(copied, sha.slice(0, 12))
      }
      fs.rmSync(file, { force: true })
    }
    fs.chmodSync(final, 0o644)
    this.hashes.note(final, sha)
    this.present.add(key)
    this.refusedUntil.delete(key)
    return final
  }

  /**
   * A verified blob's bytes at `to` as well: a hard link (a copy where the
   * filesystem refuses links), the blob marked used. For a folder no
   * container writes (the council's epochs, mounted read-only): a link shares
   * the blob's inode, so a write through it would be a write into the CAS.
   */
  place(sha: string, to: string): 'linked' | 'copied' {
    if (!this.has(sha)) throw new CacheError(`${sha.slice(0, 12)} is not here`, 'refused')
    const from = this.blobPath(sha, false)
    const how = linkOrCopy(from, to)
    if (how === 'copied') this.hashes.note(to, sha)
    this.touch(from)
    return how
  }

  /* ----------------------------------------------------------- the stream */

  /**
   * Queue what the wanted manifests and sets lack, in want's order; drop
   * prefetch nobody wants any more.
   *
   * IN THE ORDER OF THE LATEST WANT, NOT THE ONE A BLOB WAS FIRST QUEUED IN.
   * Home lists the competitions with waiting submissions first (§4.3), and a
   * list changes: a competition gets waiting rows, a teacher replaces a file
   * (a new manifest). The queue kept each job where it first came, and the
   * stream takes the lowest place first, so the class's new file waited
   * behind every file still queued of two other groups' homework, minutes at
   * the shared rate, while its notebooks were leased to no machine that
   * lacked it. So every needed blob is placed anew, in this want's order, and
   * whatever else is queued (a wheel home serves) after them in its own; the
   * download under way is left alone.
   */
  private schedule(): void {
    if (this.stopped) return
    const needed = new Set<string>()
    for (const wanted of this.wantedData) {
      const record = this.records.get(wanted)
      if (!record) continue
      for (const file of record.files) {
        const key = blobKey(file.sha256, record.sealed)
        if (needed.has(key) || this.present.has(key) || (this.refusedUntil.get(key) ?? 0) > this.now()) continue
        needed.add(key)
        this.enqueue(file.sha256, file.bytes, record.sealed, 0).order = this.order++
      }
    }
    for (const job of [...this.jobs.values()]) {
      if (job.priority === 0 && job.waiters.size === 0 && !needed.has(job.key) && !(job.key.startsWith('o:') && this.wheelWanted(job.sha))) this.cancel(job, null)
    }
    for (const job of [...this.jobs.values()].filter((other) => !needed.has(other.key)).sort((a, b) => a.order - b.order)) job.order = this.order++
    this.pump()
    this.prefetchWheels()
  }

  private enqueue(sha: string, bytes: number, sealed: boolean, priority: 0 | 1, pace: (() => number) | null = null, urgent: (() => boolean) | null = null): BlobJob {
    const key = blobKey(sha, sealed)
    let job = this.jobs.get(key)
    if (!job) {
      job = { key, sha, bytes, sealed, priority, order: this.order++, notBefore: 0, waiters: new Set(), pace, urgent }
      this.jobs.set(key, job)
    } else {
      if (priority > job.priority) {
        job.priority = priority
        job.notBefore = 0
      }
      // Anyone who waits on it unpaced (a lease, the prefetch) has it unpaced: a class's rate is the class's alone.
      if (pace === null) job.pace = null
      const before = job.urgent
      if (urgent) job.urgent = before ? () => before() || urgent() : urgent
    }
    // Ahead of the job under way when it ranks above it (rankOf): that one keeps its bytes and resumes after.
    this.hurry()
    return job
  }

  /**
   * The job under way stopped for one that ranks above it (rankOf), which
   * keeps its bytes and resumes with a Range after: asked when a job comes,
   * and when a class's push is promoted while its file waits behind a lease's
   * (room-files.ts).
   */
  hurry(): void {
    const current = this.current
    if (!current || this.stopped) return
    const best = this.next()
    if (best && best.key !== current.job.key && rankOf(best) > rankOf(current.job)) {
      current.abort.abort(new CacheError(best.priority === 1 && best.pace === null ? 'a lease needs the stream' : 'a run needs the stream', 'preempted'))
    }
  }

  private cancel(job: BlobJob, error: CacheError | null): void {
    this.jobs.delete(job.key)
    if (this.current?.job === job) this.current.abort.abort(error ?? new CacheError('not wanted any more', 'preempted'))
    for (const waiter of job.waiters) waiter.reject(error ?? new CacheError('not wanted any more', 'refused'))
  }

  private next(): BlobJob | null {
    const now = this.now()
    let best: BlobJob | null = null
    let bestRank = -1
    for (const job of this.jobs.values()) {
      if (job.notBefore > now) continue
      const rank = rankOf(job)
      if (!best || rank > bestRank || (rank === bestRank && job.order < best.order)) {
        best = job
        bestRank = rank
      }
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
    if (!this.mayFetch(job.bytes, job.priority === 1)) {
      this.waitForDisk(job, new CacheError(`${job.sha.slice(0, 12)} is not fetched: the disk is below its floor`, 'disk'))
      return
    }
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
      const error = raw instanceof CacheError ? raw : new CacheError(String(raw), diskRefused(raw) ? 'disk' : 'transient')
      if (error.kind === 'preempted' || error.kind === 'purged') return
      if (error.kind === 'unauthorized') {
        for (const pending of [...this.jobs.values()]) this.cancel(pending, error)
        this.options.onUnauthorized?.()
        return
      }
      if (error.kind === 'disk') {
        this.options.onDiskFull?.(error.message)
        this.waitForDisk(job, error)
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
      // Out of scope is home's word of the moment, not the blob's: the next want that still lists it asks again (want).
      if (error.kind === 'unscoped') this.unscoped.add(job.key)
      for (const waiter of job.waiters) waiter.reject(error)
      this.problemOf(job, error)
    } finally {
      this.current = null
      this.options.onChange?.()
    }
  }

  /** Whether a fetch of `bytes` may start now (CacheOptions.diskGate). */
  private mayFetch(bytes: number, forLease: boolean): boolean {
    return this.options.diskGate?.(bytes, forLease) ?? true
  }

  /**
   * A job with no room on the disk: a lease waiting for it hears so at once
   * (and declines for `disk`, rather than wait out its preparation for a disk
   * that will not change), and the job itself waits DISK_WAIT_MS with what
   * the prefetch still wants of it, while eviction makes room.
   */
  private waitForDisk(job: BlobJob, error: CacheError): void {
    for (const waiter of job.waiters) waiter.reject(error)
    job.waiters.clear()
    job.priority = 0
    job.notBefore = this.now() + (this.options.diskWaitMs ?? DISK_WAIT_MS)
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
    // Already under its name (a fetch from the index got there first): the blob, if it hashes to it; anything else there goes.
    if (fs.existsSync(final)) {
      if (this.hashes.sha(final) === job.sha) return final
      fs.rmSync(final, { recursive: true, force: true })
    }
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
      throw new CacheError(`home refused ${job.sha.slice(0, 12)}: ${reply.error}${reply.detail ? ` (${reply.detail})` : ''}`, reply.error === 'not_found' ? 'unscoped' : 'refused')
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
        // A class's file at its class's rate, read anew for every chunk: a promoted push is faster from its next one on.
        const pace = job.pace
        if (pace) {
          const delay = this.pacer.delay(step.value.byteLength, pace())
          if (delay > 0) await (this.options.sleep ?? pause)(delay, signal)
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new CacheError('stopped', 'transient')
        }
      }
      fs.fsyncSync(fd)
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      if (error instanceof CacheError && error.kind === 'mismatch') {
        fs.closeSync(fd)
        fs.rmSync(part, { force: true })
        throw error
      }
      if (diskRefused(error)) {
        // No room for the rest of it: the part goes too (it holds the very room the disk lacks), and the job waits for eviction.
        fs.closeSync(fd)
        fs.rmSync(part, { force: true })
        throw new CacheError(`writing ${job.sha.slice(0, 12)} failed: ${String((error as Error).message ?? error)}`, 'disk')
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
    // Hashed as it was written, a moment ago, by this stream alone: booked without reading it again.
    this.hashes.note(final, job.sha)
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
          // No room: the machine's `disk` problem, not this set's, and no other set fits either; the next want tries again.
          if (error instanceof CacheError && error.kind === 'disk') return
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
        await this.fromIndex(url, wheel, priority === 1, signal)
        this.present.add(key)
        return final
      } catch (error) {
        // No room for it: home's copy would need the same room.
        if (error instanceof CacheError && error.kind === 'disk') throw error
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

  /**
   * One wheel from its index, into a partial file that is this fetch's alone:
   * the prefetch and a lease fetch the same wheel at once whenever a reply
   * describes a set together with its lease (want, then prepareRun), and two
   * leases of one set do too. Each fetch hashes what it writes and renames
   * only its own file, so whichever is renamed last, the name holds the pin.
   */
  private async fromIndex(url: string, wheel: RemoteWheel, forLease: boolean, signal?: AbortSignal): Promise<void> {
    if (!this.mayFetch(wheel.bytes, forLease)) throw new CacheError(`${wheel.fileName} is not fetched: the disk is below its floor`, 'disk')
    const final = this.blobPath(wheel.sha256, false)
    const part = path.join(this.blobsDir, `.${wheel.sha256}.${randomBytes(4).toString('hex')}.index.part`)
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
    let fd: number
    try {
      fd = fs.openSync(part, 'wx', 0o644)
    } catch (error) {
      await response.body.cancel().catch(() => undefined)
      throw this.diskOr(error, wheel.fileName)
    }
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
      fs.fsyncSync(fd)
    } catch (error) {
      stop.abort()
      await reader.cancel().catch(() => undefined)
      fs.closeSync(fd)
      fs.rmSync(part, { force: true })
      throw this.diskOr(error, wheel.fileName)
    }
    fs.closeSync(fd)
    if (written !== wheel.bytes || hash.digest('hex') !== wheel.sha256) {
      fs.rmSync(part, { force: true })
      throw new Error('the file is not the pinned wheel (its sha256 or length differs)')
    }
    fs.renameSync(part, final)
    this.hashes.note(final, wheel.sha256)
  }

  /** A write the disk refused, said to the agent and turned into a `disk` CacheError; any other error as it was. */
  private diskOr(error: unknown, what: string): unknown {
    if (!diskRefused(error)) return error
    const refused = new CacheError(`writing ${what} failed: ${error instanceof Error ? error.message : String(error)}`, 'disk')
    this.options.onDiskFull?.(refused.message)
    return refused
  }

  /**
   * A set's folder, built beside its name and renamed into place: the lock
   * and the wheels as links to their blobs, and the list it was built from.
   * Each blob is checked by its hash before it is linked (from the book: it
   * was hashed as it arrived), and one that is not its pin leaves the cache
   * and fails the install, so that the next try fetches it again rather than
   * install it for every lease of the set.
   */
  private install(record: BundleRecord): string {
    const dir = bundleDir(record.id)
    if (this.bundleInPlace(record)) {
      this.installed.add(record.id)
      return dir
    }
    for (const wheel of record.wheels) {
      const blob = this.blobPath(wheel.sha256, false)
      if (this.hashes.sha(blob) === wheel.sha256) continue
      fs.rmSync(blob, { recursive: true, force: true })
      this.present.delete(blobKey(wheel.sha256, false))
      throw new CacheError(`${wheel.fileName} in the cache is not the pinned wheel; it is fetched again`, 'mismatch')
    }
    const root = path.join(dependencyRoot, 'bundles')
    fs.mkdirSync(root, { recursive: true, mode: 0o755 })
    const temporary = path.join(root, `.${record.id}.${randomBytes(4).toString('hex')}.tmp`)
    fs.mkdirSync(path.join(temporary, 'wheels'), { recursive: true, mode: 0o755 })
    try {
      for (const wheel of record.wheels) this.linkBlob(this.blobPath(wheel.sha256, false), path.join(temporary, 'wheels', wheel.fileName), wheel.sha256)
      fs.writeFileSync(path.join(temporary, 'requirements.lock'), record.lock, { mode: 0o444 })
      /*
       * The wheels by their file, hash and length, and no download address:
       * this folder is the participant's /deps, readable by the notebook, and
       * the address of an institution's package mirror is not named to the
       * class (home keeps its own manifest.json the same way: dependencies/
       * preparation-contract.ts · manifestPackages). The addresses stay in the
       * set's book (books/bundles), which no container mounts.
       */
      const packages = record.wheels.map((wheel) => ({ fileName: wheel.fileName, sha256: wheel.sha256, bytes: wheel.bytes }))
      fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({ id: record.id, packagesMb: record.packagesMb, packages }), { mode: 0o444 })
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

  /**
   * Whether a set's folder holds its lock and each of its wheels, by its hash.
   * Not by its length: a wheel of the right length was once kilobytes of
   * zeros (two fetches wrote one file), and was reused for every lease of the
   * set, each run failing `pip --require-hashes` in a participant's attempt.
   * A wheel linked from the CAS is its blob's inode, booked when it arrived,
   * so asking costs a stat; a copy is read once, then booked too.
   */
  private bundleInPlace(record: BundleRecord): boolean {
    const dir = bundleDir(record.id)
    try {
      if (fs.readFileSync(path.join(dir, 'requirements.lock'), 'utf8') !== record.lock) return false
      // An earlier build named the wheels' download addresses in it (install): such a folder is built again, never mounted as it is.
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { packages?: unknown }
      if (!Array.isArray(manifest.packages) || manifest.packages.some((pkg: unknown) => !pkg || typeof pkg !== 'object' || 'url' in pkg)) return false
      return record.wheels.every((wheel) => {
        const file = path.join(dir, 'wheels', wheel.fileName)
        const stat = fs.lstatSync(file)
        return stat.isFile() && stat.size === wheel.bytes && this.hashes.sha(file) === wheel.sha256
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
    this.linkBlob(from, to, file.sha256)
    this.touch(from)
  }

  /** A verified blob at `to`, linked or copied (linkOrCopy); a copy is booked with the blob's hash, which it was made from. */
  private linkBlob(from: string, to: string, sha: string): void {
    if (linkOrCopy(from, to) === 'copied') this.hashes.note(to, sha)
  }

  /**
   * Whether a data folder holds exactly a manifest's files, each the blob it
   * names: a missing name, a stray one, or a file that does not hash to its
   * blob is a folder to rebuild. By the hash, as bundleInPlace checks a set,
   * and as cheaply: a link is its blob's inode, booked when it arrived.
   */
  private linkedAs(dir: string, record: ManifestRecord): boolean {
    try {
      const names = fs.readdirSync(dir)
      if (names.length !== record.files.length) return false
      return record.files.every((file) => {
        const at = path.join(dir, file.name)
        const stat = fs.lstatSync(at)
        return stat.isFile() && stat.size === file.bytes && this.hashes.sha(at) === file.sha256
      })
    } catch {
      return false
    }
  }

  private dropManifest(record: ManifestRecord): void {
    this.records.delete(recordKey(record.manifest, record.sealed))
    fs.rmSync(path.join(this.options.books, 'manifests', `${bookName(record)}.json`), { force: true })
    // Its problem, unless the same hash is still kept as the other kind (the problem names the hash alone).
    if (!this.records.has(recordKey(record.manifest, !record.sealed))) this.problems.delete(`data:${record.manifest}`)
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
    for (const key of this.wantedData) {
      const record = this.records.get(key)
      if (record && record.sealed === job.sealed && record.files.some((file) => file.sha256 === job.sha)) this.problem(`data:${record.manifest}`, { code: 'data', manifest: record.manifest, detail })
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
      const record = problem.manifest ? this.records.get(recordKey(problem.manifest, job.sealed)) : undefined
      if (record?.files.some((file) => file.sha256 === job.sha)) this.problems.delete(key)
    }
  }

  /** Each book by its file's name (`<id>.json`, a hidden test's `<manifest>.sealed.json`); a file that is not one this code wrote goes. */
  private readBooks<T>(kind: 'manifests' | 'bundles', check: (value: unknown, name: string, sealed: boolean) => T | null): T[] {
    const dir = path.join(this.options.books, kind)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const found: T[] = []
    for (const name of names) {
      const parts = /^([a-f0-9]{32}|[a-f0-9]{64})(\.sealed)?\.json$/.exec(name)
      const value = parts ? check(readJson(path.join(dir, name)), parts[1]!, parts[2] !== undefined) : null
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

  /**
   * Mark a blob used now: eviction goes least recently used first, by mtime.
   * The mark moves the mtime the hash book keys on, so the book is told: what
   * it knew of the blob before the touch, it knows after (HashBook.retimed).
   */
  private touch(file: string): void {
    try {
      const before = fs.lstatSync(file, { bigint: true })
      const at = new Date(this.now())
      fs.utimesSync(file, at, at)
      this.hashes.retimed(file, before)
    } catch { /* gone: the next use fetches it again */ }
  }
}

/* ------------------------------------------------------------------ files */

/** A hard link, or a copy where the filesystem refuses links (storage.ts · placeCompetitionFile's rule): which it was. */
function linkOrCopy(from: string, to: string): 'linked' | 'copied' {
  try {
    fs.linkSync(from, to)
    return 'linked'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EEXIST') {
      fs.rmSync(to, { force: true })
      fs.linkSync(from, to)
      return 'linked'
    }
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS'].includes(code)) throw error
    fs.copyFileSync(from, to)
    fs.chmodSync(to, 0o644)
    return 'copied'
  }
}

/* -------------------------------------------------------- the hash book */

/** What the book keeps of a file: its length and mtime when it was hashed (decimal strings: bigints in JSON), its ctime in a book that keeps it, and its sha256. */
interface Booked {
  size: string
  mtimeNs: string
  ctimeNs?: string
  sha256: string
}

/** How long after a change the book is written: a burst of arrivals is one write. */
const BOOK_WRITE_MS = 2_000
/** The most of it read back: some tens of thousands of files, each under 150 bytes. */
const BOOK_BYTES = 32 * 1024 * 1024

/**
 * WHAT EACH FILE OF THE CACHE HASHES TO, WITHOUT READING IT AGAIN.
 *
 * A file is checked by its hash wherever its name is taken on trust (see the
 * header), and two hundred megabytes of data or half a gigabyte of wheels
 * read for each of those would cost a restart minutes and a lease seconds.
 * So a hash is booked by what says the file has not changed since it was
 * hashed: its device and inode, its length, and its mtime to the nanosecond
 * (books/hashes.json, written soon after a change and when the agent stops).
 * A file written since has another mtime, a file replaced another inode, and
 * either is read again. A file hashed as it was downloaded is booked without
 * a read (note).
 *
 * Not its ctime: every hard link into a data folder or a package set moves
 * it, and those are made from every blob. And the cache's own mark of use
 * (Cache.touch) moves the mtime: the book carries an entry over a touch it
 * saw before and after (retimed), so marking a blob used is never taken for
 * a change of its bytes. A hard link shares its blob's inode and so its entry:
 * a set's wheels and a data folder's files cost a stat each, never a read.
 *
 * What the book holds of files no longer here goes when the cache loads
 * (prune): what is booked is only ever what a load or this life found.
 *
 * THE CLASS FOLDERS KEEP A BOOK OF THEIR OWN (room-files.ts), by the stats a
 * walk read through the anchored filesystem (`known`, `noteStat`): never by a
 * path this book opens itself, which follows a link a kernel planted. That
 * book keeps the ctime too (`ctime`): nothing there is hard-linked, and a
 * kernel's `shutil.copy2`, `touch -r` or a tar's whole-second times put the
 * old length and mtime back on new bytes — which moves the ctime alone.
 */
export class HashBook {
  private readonly entries = new Map<string, Booked>()
  /** The entries a load or this life has used: the rest are pruned. */
  private readonly used = new Set<string>()
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private failed = false

  /** `ctime`: a file is the one booked only while its ctime holds too (the class folders' book). */
  constructor(private readonly file: string, private readonly log?: (line: string) => void, private readonly options: { ctime?: boolean } = {}) {}

  load(): void {
    const value = readJson(this.file, BOOK_BYTES) as { v?: unknown; files?: unknown } | null
    if (!value || value.v !== 1 || !value.files || typeof value.files !== 'object') return
    const width = this.options.ctime ? 4 : 3
    for (const [key, entry] of Object.entries(value.files as Record<string, unknown>)) {
      if (!/^\d+:\d+$/.test(key) || !Array.isArray(entry) || entry.length !== width) continue
      const [size, mtimeNs, ...rest] = entry as unknown[]
      const sha = rest.at(-1)
      const ctimeNs = this.options.ctime ? rest[0] : undefined
      if (typeof size === 'string' && /^\d+$/.test(size) && typeof mtimeNs === 'string' && /^\d+$/.test(mtimeNs) && typeof sha === 'string' && REMOTE_SHA256.test(sha)
        && (!this.options.ctime || (typeof ctimeNs === 'string' && /^\d+$/.test(ctimeNs)))) {
        this.entries.set(key, { size, mtimeNs, ...(this.options.ctime ? { ctimeNs: ctimeNs as string } : {}), sha256: sha })
      }
    }
  }

  /** Whether a booked entry is of the file these stats are of, unchanged. */
  private holds(booked: Booked | undefined, stat: fs.BigIntStats): booked is Booked {
    return booked !== undefined && booked.size === String(stat.size) && booked.mtimeNs === String(stat.mtimeNs) && (!this.options.ctime || booked.ctimeNs === String(stat.ctimeNs))
  }

  /**
   * What a regular file hashes to: from the book when the file is the one it
   * booked, read and booked otherwise. `null` — no regular file there.
   */
  sha(file: string): string | null {
    let stat: fs.BigIntStats
    try {
      stat = fs.lstatSync(file, { bigint: true })
    } catch {
      return null
    }
    if (!stat.isFile()) return null
    const key = keyOf(stat)
    const booked = this.entries.get(key)
    if (this.holds(booked, stat)) {
      this.used.add(key)
      return booked.sha256
    }
    let sha: string
    try {
      sha = hashFile(file)
    } catch {
      return null
    }
    // Booked only if nothing wrote to it while it was read: a file that changed under the read is read again next time.
    try {
      const after = fs.lstatSync(file, { bigint: true })
      if (keyOf(after) === key && after.size === stat.size && after.mtimeNs === stat.mtimeNs) this.book(key, stat, sha)
    } catch { /* gone meanwhile */ }
    return sha
  }

  /** What a regular file of these stats hashes to, as booked; null — not booked, or changed since. */
  known(stat: fs.BigIntStats): string | null {
    if (!stat.isFile()) return null
    const key = keyOf(stat)
    const booked = this.entries.get(key)
    if (!this.holds(booked, stat)) return null
    this.used.add(key)
    return booked.sha256
  }

  /** A file whose bytes the caller hashed through a descriptor whose stats were these, before the read and after it. */
  noteStat(stat: fs.BigIntStats, sha: string): void {
    if (stat.isFile()) this.book(keyOf(stat), stat, sha)
  }

  /** A file whose bytes were hashed as they were written, by the only one who wrote them: booked as it is now. */
  note(file: string, sha: string): void {
    try {
      const stat = fs.lstatSync(file, { bigint: true })
      if (stat.isFile()) this.book(keyOf(stat), stat, sha)
    } catch { /* gone meanwhile */ }
  }

  /** A file whose times were set by the cache itself (`before` is how it was just before): what was booked of it holds after. */
  retimed(file: string, before: fs.BigIntStats): void {
    const key = keyOf(before)
    const booked = this.entries.get(key)
    if (!this.holds(booked, before)) return
    try {
      const after = fs.lstatSync(file, { bigint: true })
      if (keyOf(after) === key && after.size === before.size) this.book(key, after, booked.sha256)
    } catch { /* gone meanwhile */ }
  }

  /** Forget what no load and nothing of this life has used: files evicted, purged or replaced while the agent was down. */
  prune(): void {
    for (const key of [...this.entries.keys()]) {
      if (this.used.has(key)) continue
      this.entries.delete(key)
      this.dirty = true
    }
  }

  /** Written soon: a burst of arrivals is one write. */
  save(): void {
    if (!this.dirty || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, BOOK_WRITE_MS)
    this.timer.unref?.()
  }

  /** Written now, if anything changed (the agent stops). A book that cannot be written costs the next start a read of what it would have said. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty) return
    const files: Record<string, string[]> = {}
    for (const [key, entry] of this.entries) files[key] = this.options.ctime ? [entry.size, entry.mtimeNs, entry.ctimeNs ?? '0', entry.sha256] : [entry.size, entry.mtimeNs, entry.sha256]
    try {
      writeWhole(this.file, JSON.stringify({ v: 1, files }), { mode: 0o600 })
      this.dirty = false
      this.failed = false
    } catch (error) {
      if (!this.failed) this.log?.(`[runner] could not write the book of hashes: ${String(error)}`)
      this.failed = true
    }
  }

  private book(key: string, stat: fs.BigIntStats, sha: string): void {
    this.entries.set(key, { size: String(stat.size), mtimeNs: String(stat.mtimeNs), ...(this.options.ctime ? { ctimeNs: String(stat.ctimeNs) } : {}), sha256: sha })
    this.used.add(key)
    this.dirty = true
    this.save()
  }
}

const keyOf = (stat: fs.BigIntStats): string => `${stat.dev}:${stat.ino}`

/* ------------------------------------------------------------- the pace */

/**
 * A rate kept smoothly (§4.9, K0: never in bursts of a second): the generic
 * cell rate algorithm over bytes, ahead of its rate by `burstBytes` at most.
 * The rate is given at every call, so that a push promoted while it moves is
 * faster from its next chunk on.
 */
export class Pacer {
  /** Theoretical arrival time of the next byte, ms. */
  private tat = 0

  constructor(
    private readonly now: () => number,
    private readonly burstBytes: number,
  ) {}

  /** How long `bytes` must wait to keep to `bytesPerSecond`, the wait booked; 0 — at once. */
  delay(bytes: number, bytesPerSecond: number): number {
    if (!(bytesPerSecond > 0) || !Number.isFinite(bytesPerSecond)) return 0
    const now = this.now()
    const perMs = bytesPerSecond / 1000
    this.tat = Math.max(this.tat, now) + bytes / perMs
    return Math.max(0, Math.ceil(this.tat - now - this.burstBytes / perMs))
  }
}

/** A wait that ends early when the signal aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** A file's sha256, read in pieces (a 200 MB table is never in memory whole). */
function hashFile(file: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
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

/** A manifest's book's name: the hash, and `.sealed` for a hidden test (a hash may be both). */
const bookName = (record: Pick<ManifestRecord, 'manifest' | 'sealed'>): string => `${record.manifest}${record.sealed ? '.sealed' : ''}`

/** A manifest's book as written down; null — not one this code wrote (its kind must be its name's). */
function manifestRecordOf(value: unknown, manifest: string, sealed: boolean): ManifestRecord | null {
  const v = value as (Partial<ManifestRecord> & { competitionId?: unknown }) | null
  if (!v || v.manifest !== manifest || v.sealed !== sealed || !Array.isArray(v.files)) return null
  // An earlier build named one competition (`competitionId`); this one keeps every competition that lists the manifest.
  const competitions = Array.isArray(v.competitions) ? v.competitions : typeof v.competitionId === 'string' ? [v.competitionId] : null
  if (!competitions || competitions.length === 0 || !competitions.every((competition) => typeof competition === 'string' && COMPETITION_ROW_ID.test(competition))) return null
  const files = v.files.filter((file): file is RemoteDataFile =>
    !!file && typeof file.name === 'string' && REMOTE_DATA_NAME.test(file.name) && typeof file.sha256 === 'string' && REMOTE_SHA256.test(file.sha256) && Number.isSafeInteger(file.bytes))
  if (files.length !== v.files.length) return null
  try {
    return remoteManifest(files, sha256) === manifest ? { competitions: [...new Set(competitions as string[])], manifest, sealed, files } : null
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
