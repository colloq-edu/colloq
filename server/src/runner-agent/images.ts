/**
 * The kernels a machine runs, by digest: what home's `want` names is pulled
 * from its registry, checked against the pin, smoke-tested on a card when it
 * is a GPU kernel, and tagged `colloq-revision:<id>`, the name the machine's
 * runs start it by (docs/architecture/remote-runners.md §4.4).
 *
 * WHY THE CHECK AFTER THE PULL. A digest names the manifest, and the manifest
 * names the image, but two image stores disagree about what an image's id is
 * (the classic store gives it its config's digest, containerd its manifest's
 * or index's), and a registry ref home recorded may not be pullable at all: a
 * local build tagged with a registry name and never pushed has a RepoDigests
 * entry under containerd (§13 note 6), and that pull fails here — reported as
 * an `image` problem, never as ready. What both stores agree on is the
 * image's uncompressed layers (RootFS.Layers), so the pin is their
 * fingerprint (dependencies/image-identity.ts · imageIdentity, the one
 * definition there is, §13 note 1), and a pulled image whose layers are not
 * the pinned ones is a `layers` problem: it is not what home scored the
 * competition's other submissions in.
 *
 * WHY THE SMOKE TEST. A GPU kernel on a machine whose driver is older than
 * CUDA 13 wants (REMOTE_DRIVER_MIN), or whose container toolkit is missing,
 * pulls fine and then fails every notebook on its first `.cuda()`, each one a
 * participant's attempt spent on our machinery. So before a GPU revision is
 * ready, torch must see CUDA on card 0 in it (REMOTE_GPU_SMOKE_MS for the
 * check itself; the import of torch from a cold disk is given its own time),
 * and a driver the probe already read as too old fails without a pull: four
 * gigabytes for an answer known in advance.
 *
 * One pull at a time, in the order `want` lists them, and a failed one waits a
 * while before it is tried again. When the disk runs low, revisions nobody
 * wanted for REMOTE_EVICT_AFTER_MS go first (evict).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  REMOTE_DRIVER_MIN,
  REMOTE_EVICT_AFTER_MS,
  REMOTE_GPU_SMOKE_MS,
  REMOTE_IMAGE_REF,
  REMOTE_REASON_CHARS,
  REMOTE_REVISIONS_MAX,
  REMOTE_REVISION_ID,
  REMOTE_SHA256,
  remoteText,
  type RemoteFetch,
  type RemoteProblem,
  type RemoteProblemCode,
  type RemoteWantRevision,
} from '@shared/remote-runner'
import { imageIdentity } from '../dependencies/image-identity.js'
import { dockerMissing, dockerWords, type Docker } from './docker.js'
import { driverMajor } from './machine.js'
import { readJson, writeWhole } from './state.js'

/** The name a machine's runs start a revision by, once its layers matched (DockerCompetitionRunner's RunRequest.imageDigest). */
export const REVISION_TAG = 'colloq-revision'
export const revisionImage = (id: string): string => `${REVISION_TAG}:${id}`

/**
 * The label of the agent's own throwaway containers (the smoke test): swept
 * at every start like the runs are, should a life end in the middle of one.
 */
export const CHECK_LABEL = 'colloq.kind=runner-check'

/** A pull of four gigabytes over a slow link; past it, the pull is a problem and tried again later. */
const PULL_TIMEOUT_MS = 60 * 60_000
/** The smoke test's container: starting it and importing torch from a cold disk, then REMOTE_GPU_SMOKE_MS for CUDA itself. */
const SMOKE_TIMEOUT_MS = REMOTE_GPU_SMOKE_MS + 110_000
/** How long a failed revision waits before it is tried again: doubling from the first to the last. */
const RETRY_MS = { first: 2 * 60_000, last: 30 * 60_000 } as const

/** What the machine keeps about a revision it was asked for (books/revisions/<id>.json). */
export interface RevisionBook {
  id: string
  ref: string
  layers: string
  gpu: boolean
  /** When it was pulled, checked and tagged; null — not (yet, or any more). */
  readyAt: number | null
  /** When home last wanted it, or a lease ran in it: eviction goes by this. */
  wantedAt: number
}

export interface ImagesOptions {
  docker: Docker
  /** books/revisions under the state root. */
  dir: string
  now?: () => number
  /** The cards and driver as the probe last found them: a GPU kernel is no use without either. */
  cards: () => { count: number; driver: string | null }
  /** Something a sync reports has changed (a revision became ready, a problem, a pull's progress). */
  onChange?: () => void
  log?: (line: string) => void
}

/** The python of the smoke test: torch must see a card and use it within the time (signal.alarm stops it). */
const SMOKE_SCRIPT = [
  'import signal, sys',
  'import torch',
  `signal.alarm(${Math.ceil(REMOTE_GPU_SMOKE_MS / 1000)})`,
  'if not torch.cuda.is_available() or torch.cuda.device_count() < 1:',
  '    print("cuda-missing", flush=True)',
  '    sys.exit(3)',
  'torch.zeros(1, device="cuda").add_(1).item()',
  'print("cuda-ok", torch.version.cuda, flush=True)',
].join('\n')

export class Images {
  private readonly docker: Docker
  private readonly dir: string
  private readonly now: () => number
  private readonly options: ImagesOptions
  private readonly books = new Map<string, RevisionBook>()
  private readonly problems = new Map<string, RemoteProblem>()
  /** Pulls under way: revision → percent of its layers in place. */
  private readonly percent = new Map<string, number>()
  /** A failed revision is not tried again before this, and the next failure waits twice as long. */
  private readonly retry = new Map<string, { at: number; waitMs: number }>()
  private wanted: RemoteWantRevision[] = []
  private working: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(options: ImagesOptions) {
    this.options = options
    this.docker = options.docker
    this.dir = options.dir
    this.now = options.now ?? Date.now
  }

  /**
   * What an earlier life left: each revision it had ready is ready again only
   * if its tag is still there with the pinned layers (an operator's `docker
   * image prune`, another store after a daemon change).
   */
  async load(): Promise<void> {
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const id = /^([a-f0-9]{32})\.json$/.exec(name)?.[1]
      const book = id ? bookOf(readJson(path.join(this.dir, name), 64 * 1024), id) : null
      if (!book) continue
      if (book.readyAt !== null && (await this.layersOf(revisionImage(book.id))) !== book.layers) book.readyAt = null
      this.books.set(book.id, book)
    }
  }

  /** Home's list of the revisions it wants here, in its order: the first not ready is pulled first. */
  want(revisions: readonly RemoteWantRevision[]): void {
    const now = this.now()
    this.wanted = [...revisions]
    for (const revision of revisions) {
      const book = this.books.get(revision.id)
      if (!book || book.ref !== revision.ref || book.layers !== revision.layers || book.gpu !== revision.gpu) {
        // A pin never changes under its id; a book that disagrees is not to be trusted, whatever it says.
        this.books.set(revision.id, { id: revision.id, ref: revision.ref, layers: revision.layers, gpu: revision.gpu, readyAt: null, wantedAt: now })
        this.save(revision.id)
      } else if (now - book.wantedAt > 60 * 60_000) {
        // Written down once an hour at most: eviction counts in days.
        book.wantedAt = now
        this.save(revision.id)
      } else {
        book.wantedAt = now
      }
    }
    // A problem about a revision home no longer wants is no longer anyone's.
    for (const [key, problem] of this.problems) if (problem.revisionId && !revisions.some((revision) => revision.id === problem.revisionId)) this.problems.delete(key)
    this.kick()
  }

  /** The revisions ready here, the wanted ones first, as many as a sync carries. */
  readyIds(): string[] {
    const wanted = new Set(this.wanted.map((revision) => revision.id))
    return [...this.books.values()]
      .filter((book) => book.readyAt !== null)
      .sort((a, b) => Number(wanted.has(b.id)) - Number(wanted.has(a.id)) || b.wantedAt - a.wantedAt)
      .slice(0, REMOTE_REVISIONS_MAX)
      .map((book) => book.id)
  }

  /**
   * The image a lease runs, checked once more right before its run: the tag
   * is there and its layers are the lease's pin. `null` — not here or not
   * that image, which declines the lease (`image`) before any container.
   */
  async verify(revision: { id: string; layers: string }): Promise<string | null> {
    const book = this.books.get(revision.id)
    if (!book || book.readyAt === null || book.layers !== revision.layers) return null
    if ((await this.layersOf(revisionImage(revision.id))) !== revision.layers) {
      book.readyAt = null
      this.save(revision.id)
      this.options.onChange?.()
      this.kick()
      return null
    }
    book.wantedAt = this.now()
    return revisionImage(revision.id)
  }

  problemList(): RemoteProblem[] {
    return [...this.problems.values()]
  }

  fetchingList(): RemoteFetch[] {
    return [...this.percent].map(([revisionId, percent]) => ({ revisionId, percent }))
  }

  /**
   * Below the disk's floor: revisions nobody wanted for REMOTE_EVICT_AFTER_MS
   * and no lease holds go, the longest unwanted first, until the floor holds
   * again. The tag goes, and the image by its ref unless another revision kept
   * here is the same image. Returns how many went.
   */
  async evict(inUse: ReadonlySet<string>, freeMb: () => number | null, floorMb: number): Promise<number> {
    const now = this.now()
    const wanted = new Set(this.wanted.map((revision) => revision.id))
    const candidates = [...this.books.values()]
      .filter((book) => !inUse.has(book.id) && !wanted.has(book.id) && now - book.wantedAt >= REMOTE_EVICT_AFTER_MS)
      .sort((a, b) => a.wantedAt - b.wantedAt)
    let removed = 0
    for (const book of candidates) {
      const free = freeMb()
      if (free === null || free >= floorMb) break
      const untagged = await this.docker(['rmi', revisionImage(book.id)], { timeoutMs: 120_000 })
      if (untagged.code !== 0 && !dockerMissing(untagged)) continue
      const shared = [...this.books.values()].some((other) => other.id !== book.id && other.ref === book.ref)
      if (!shared) await this.docker(['rmi', book.ref], { timeoutMs: 120_000 })
      this.books.delete(book.id)
      fs.rmSync(path.join(this.dir, `${book.id}.json`), { force: true })
      removed++
      this.options.log?.(`[runner] evicted revision ${book.id.slice(0, 12)} (not wanted for ${Math.round((now - book.wantedAt) / 3_600_000)} h) for disk`)
    }
    if (removed > 0) this.options.onChange?.()
    return removed
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  /** Settled when no pull is under way; for tests and for an orderly stop. */
  idle(): Promise<void> {
    return this.working ?? Promise.resolve()
  }

  /* -------------------------------------------------------------- pulls */

  private kick(): void {
    if (this.working || this.stopped) return
    this.working = (async () => {
      for (let next = this.next(); next && !this.stopped; next = this.next()) await this.prepare(next)
    })()
      .catch((error: unknown) => this.options.log?.(`[runner] revision preparation failed: ${String(error)}`))
      .finally(() => {
        this.working = null
        this.wake()
      })
  }

  /** The first wanted revision that is not ready, may be tried now, and is for this machine at all. */
  private next(): RemoteWantRevision | null {
    const now = this.now()
    const cards = this.options.cards().count
    return this.wanted.find((revision) => {
      const book = this.books.get(revision.id)
      if (book && book.readyAt !== null) return false
      if ((this.retry.get(revision.id)?.at ?? 0) > now) return false
      // Home asks for a GPU kernel only where it saw cards; a probe that has not found them yet waits.
      return !revision.gpu || cards > 0
    }) ?? null
  }

  /** The next try of a revision that failed, when its wait is over. */
  private wake(): void {
    if (this.stopped || this.timer) return
    const waits = [...this.retry.values()].map((retry) => retry.at).filter((at) => at > this.now())
    if (waits.length === 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.kick()
    }, Math.max(1_000, Math.min(...waits) - this.now()))
    this.timer.unref?.()
  }

  private async prepare(revision: RemoteWantRevision): Promise<void> {
    const { id, ref, layers, gpu } = revision
    if (gpu) {
      const { driver } = this.options.cards()
      const major = driverMajor(driver)
      if (major !== null && major < REMOTE_DRIVER_MIN) {
        this.fail(revision, 'smoke', `the NVIDIA driver here is ${driver}, older than the ${REMOTE_DRIVER_MIN} CUDA 13 kernels need`)
        return
      }
    }
    this.percent.set(id, 0)
    this.options.onChange?.()
    try {
      // Already here: pulled by an earlier life, or the same image as another revision.
      let pinned = await this.layersOf(ref)
      if (pinned === undefined) {
        const layerState = new Map<string, boolean>()
        const pulled = await this.docker(['pull', ref], { timeoutMs: PULL_TIMEOUT_MS, onLine: (line) => this.pullLine(id, line, layerState) })
        if (pulled.code !== 0) return this.fail(revision, 'image', `docker pull ${ref} failed: ${dockerWords(pulled)}`)
        pinned = await this.layersOf(ref)
        if (pinned === undefined) return this.fail(revision, 'image', `the pulled ${ref} cannot be inspected`)
      }
      if (pinned !== layers) {
        return this.fail(revision, 'layers', `the pulled image's layers (${pinned?.slice(0, 12) ?? 'unreadable'}) are not the pinned ${layers.slice(0, 12)}: not the image home runs`)
      }
      if (gpu) {
        const smoke = await this.smoke(id, ref)
        if (smoke !== null) return this.fail(revision, 'smoke', smoke)
      }
      const tagged = await this.docker(['tag', ref, revisionImage(id)], { timeoutMs: 60_000 })
      if (tagged.code !== 0) return this.fail(revision, 'image', `docker tag failed: ${dockerWords(tagged)}`)
      const book = this.books.get(id) ?? { id, ref, layers, gpu, readyAt: null, wantedAt: this.now() }
      book.readyAt = this.now()
      this.books.set(id, book)
      this.save(id)
      this.retry.delete(id)
      for (const code of ['image', 'layers', 'smoke'] as const) this.problems.delete(`${code}:${id}`)
      this.options.log?.(`[runner] revision ${id.slice(0, 12)} is ready (${ref})`)
    } finally {
      this.percent.delete(id)
      this.options.onChange?.()
    }
  }

  private fail(revision: RemoteWantRevision, code: Extract<RemoteProblemCode, 'image' | 'layers' | 'smoke'>, detail: string): void {
    for (const other of ['image', 'layers', 'smoke'] as const) this.problems.delete(`${other}:${revision.id}`)
    this.problems.set(`${code}:${revision.id}`, { code, revisionId: revision.id, detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') })
    const before = this.retry.get(revision.id)
    const waitMs = before ? Math.min(RETRY_MS.last, before.waitMs * 2) : RETRY_MS.first
    this.retry.set(revision.id, { at: this.now() + waitMs, waitMs })
    this.options.log?.(`[runner] revision ${revision.id.slice(0, 12)} is not ready (${code}): ${detail}; tried again in ${Math.round(waitMs / 60_000)} min`)
  }

  /**
   * One line of `docker pull`'s plain output: each layer is listed when the
   * pull starts it ("Pulling fs layer", "Waiting", "Already exists") and once
   * more when it is in place ("Pull complete"), so the share of layers in
   * place is how far the pull has got. Short of done until the pull says so.
   */
  private pullLine(id: string, line: string, layers: Map<string, boolean>): void {
    const match = /^([a-f0-9]{12,64}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/.exec(line.trim())
    if (!match) return
    layers.set(match[1]!, match[2] === 'Pull complete' || match[2] === 'Already exists')
    const done = [...layers.values()].filter(Boolean).length
    const percent = Math.min(99, Math.floor((done / layers.size) * 100))
    if (percent !== this.percent.get(id)) {
      this.percent.set(id, percent)
      this.options.onChange?.()
    }
  }

  /** The smoke test (see the header); null — torch used card 0, otherwise what went wrong. */
  private async smoke(id: string, ref: string): Promise<string | null> {
    const name = `colloq-runner-check-${id.slice(0, 12)}`
    await this.docker(['rm', '-f', name], { timeoutMs: 30_000 })
    const ran = await this.docker([
      'run', '--rm', '--pull=never', '--name', name, '--label', CHECK_LABEL,
      '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
      '--tmpfs=/tmp:rw,nosuid,nodev,size=256m', '-e', 'HOME=/tmp', '--user=1000:1000',
      '--gpus', 'device=0', '--entrypoint', 'python', ref, '-I', '-c', SMOKE_SCRIPT,
    ], { timeoutMs: SMOKE_TIMEOUT_MS })
    if (ran.code === 0 && /\bcuda-ok\b/.test(ran.out)) return null
    // Killed at the timeout: the client is gone, the container may not be.
    if (ran.code === -1) await this.docker(['rm', '-f', name], { timeoutMs: 30_000 })
    if (/\bcuda-missing\b/.test(ran.out)) return 'torch sees no CUDA device on card 0 (the NVIDIA container toolkit or the driver)'
    if (ran.code === 142) return `torch did not reach card 0 within ${REMOTE_GPU_SMOKE_MS / 1000} s`
    return `the GPU check failed: ${dockerWords(ran)}`
  }

  /** The layer fingerprint of an image as `docker image inspect` reports it; undefined — no such image; null — unreadable. */
  private async layersOf(image: string): Promise<string | null | undefined> {
    const inspected = await this.docker(['image', 'inspect', image], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
    if (inspected.code !== 0) return undefined
    try {
      const value: unknown = JSON.parse(inspected.out)
      return imageIdentity(Array.isArray(value) ? value[0] : value).layers
    } catch {
      return null
    }
  }

  private save(id: string): void {
    const book = this.books.get(id)
    if (!book) return
    try {
      writeWhole(path.join(this.dir, `${id}.json`), JSON.stringify(book), { mode: 0o600 })
    } catch (error) {
      this.options.log?.(`[runner] could not write the book of revision ${id.slice(0, 12)}: ${String(error)}`)
    }
  }
}

/** A revision's book as written down; null — not one this code wrote. */
function bookOf(value: unknown, id: string): RevisionBook | null {
  const v = value as Partial<RevisionBook> | null
  if (!v || v.id !== id || !REMOTE_REVISION_ID.test(id) || typeof v.ref !== 'string' || !REMOTE_IMAGE_REF.test(v.ref)
    || typeof v.layers !== 'string' || !REMOTE_SHA256.test(v.layers) || typeof v.gpu !== 'boolean'
    || !(v.readyAt === null || Number.isSafeInteger(v.readyAt)) || !Number.isSafeInteger(v.wantedAt)) return null
  return { id, ref: v.ref, layers: v.layers, gpu: v.gpu, readyAt: v.readyAt ?? null, wantedAt: v.wantedAt as number }
}
