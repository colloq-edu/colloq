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
 * ready, torch must see CUDA on a card in it (REMOTE_GPU_SMOKE_MS for the
 * check itself; the import of torch from a cold disk is given its own time),
 * and a driver the probe already read as too old fails without a pull: four
 * gigabytes for an answer known in advance.
 *
 * ON A CARD WITH ROOM, AND A FULL CARD IS NO VERDICT. The check needs a CUDA
 * context of its own, half a gigabyte, and card 0 was once the only card it
 * ran on: in a burst every share of card 0 is taken (eight runs of three
 * gigabytes on a 4090), torch answered CUDA out of memory, and the revision
 * was failed as `smoke` — a problem that reads as a driver at fault, a wait of
 * two minutes doubling to thirty, the machine taking none of that
 * competition's GPU work all the while, and still waiting long after the
 * burst had freed the card. So the check takes the card the runs would take,
 * one with a share free, and holds that share while it runs as a run holds
 * its own (ImagesOptions.smokeCard, sync.ts · checkCard); no card with a share
 * free, or a card that a run filled under it after all (out of memory), is a
 * wait of SOON_MS that does not grow and says nothing against the revision.
 *
 * AN INSPECT IS ASKED AGAIN BEFORE IT IS BELIEVED. A daemon under load fails
 * an `inspect` now and then without saying why (docker-runner.ts · retried,
 * which found it at home: one such failure read as "the container is gone").
 * Here one read as "not the pinned image": the lease checked right before its
 * run was declined `image` — a decline home counts toward the submission's
 * three and the machine's quarantine — and the revision left `ready`, so home
 * leased nothing of its competition here until it was checked again, a GPU
 * kernel by its smoke test in the middle of the very burst that made the
 * daemon slow. So a failure is asked again after a short backoff (the Docker
 * runner's own), and only an answer counts: `missing` when the daemon says
 * there is no such image, the layers when it shows them. One that failed
 * every try is `unknown`: a lease is then declined as before (a daemon that
 * cannot answer for seconds cannot start its run either), a start keeps the
 * book's word for the check before each run, and a revision being prepared
 * waits SOON_MS with the daemon's words as its `image` problem.
 *
 * One pull at a time, in the order `want` lists them, and a failed one waits a
 * while before it is tried again. When the disk runs low, revisions nobody
 * wanted for REMOTE_EVICT_AFTER_MS go first (evict). And no pull starts while
 * the disk Docker keeps images on is below the floor (ImagesOptions.diskGate:
 * Docker's own disk where it has one, measured by sync.ts), nor is one that
 * failed for want of room taken for a bad image: that is the machine's `disk`
 * problem, and the revision waits for eviction instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
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
import { dataDir } from '../data-dir.js'
import { hostPathOf } from '../competitions/storage.js'
import { imageIdentity } from '../dependencies/image-identity.js'
import { dockerMissing, dockerWords, type Docker } from './docker.js'
import { driverMajor } from './machine.js'
import { readJson, writeWhole } from './state.js'

/** The name a machine's runs start a revision by, once its layers matched (DockerCompetitionRunner's RunRequest.imageDigest). */
export const REVISION_TAG = 'colloq-revision'
export const revisionImage = (id: string): string => `${REVISION_TAG}:${id}`

/**
 * The label of the agent's own throwaway containers (the smoke test, the
 * measure of Docker's disk): swept at every start like the runs are, should a
 * life end in the middle of one.
 */
export const CHECK_LABEL = 'colloq.kind=runner-check'

/**
 * This tree's instance label: the very one the Docker runner puts on every
 * container it starts for this data root (docker-runner.ts · INSTANCE_LABEL, a
 * hash of the root as the daemon sees it). Every check container carries it
 * beside CHECK_LABEL, and the sweep takes only containers with both: two
 * agents on one daemon (make runner-dev beside a machine's own, two trees on a
 * university server) each sweep their own, and neither kills the other's
 * smoke test mid-run. Made here the way the runner makes it, which does not
 * export it; tests/runner-agent-argv.test.mts holds the two equal.
 */
const INSTANCE_SCOPE = createHash('sha256').update(path.resolve(hostPathOf(dataDir))).digest('hex').slice(0, 16)
export const INSTANCE_LABEL = `ru.colloq.competition-instance=${INSTANCE_SCOPE}`

/** The labels of a check container, as `docker run` arguments. */
export const CHECK_LABELS: readonly string[] = ['--label', CHECK_LABEL, '--label', INSTANCE_LABEL]

/** A pull that failed for want of room, in docker's words: the machine's disk, not the image. */
const NO_SPACE = /no space left on device|disk quota exceeded/i

/** How long a revision waits for room on the disk before its pull is tried again. */
const DISK_WAIT_MS = 60_000

/** A pull of four gigabytes over a slow link; past it, the pull is a problem and tried again later. */
const PULL_TIMEOUT_MS = 60 * 60_000
/** The smoke test's container: starting it and importing torch from a cold disk, then REMOTE_GPU_SMOKE_MS for CUDA itself. */
const SMOKE_TIMEOUT_MS = REMOTE_GPU_SMOKE_MS + 110_000
/** How long a failed revision waits before it is tried again: doubling from the first to the last. */
const RETRY_MS = { first: 2 * 60_000, last: 30 * 60_000 } as const
/** How long a revision waits that could not be checked for a reason not its own (soon): no card free for its smoke test, a daemon that did not answer. */
export const SOON_MS = 30_000
/** The backoff before each retry of an inspect that failed without saying why: docker-runner.ts · RETRY_DELAYS_MS, for the same daemon under the same load. */
const INSPECT_RETRY_MS: readonly number[] = [250, 750, 2000]
/**
 * A smoke test that met a card with no room for its CUDA context: torch's own
 * words for it, and the driver's. A card full of runs, not a broken revision.
 */
const CARD_FULL = /out of memory|OutOfMemoryError|CUDA_ERROR_OUT_OF_MEMORY|cudaErrorMemoryAllocation/i

/**
 * What `docker image inspect` says of an image: its layer fingerprint (null —
 * an answer that is not an image's); `missing` — the daemon said there is no
 * such image; `unknown` — it failed every try without saying why (see the
 * header), with the daemon's last words.
 */
type Inspected = { kind: 'image'; layers: string | null } | { kind: 'missing' } | { kind: 'unknown'; detail: string }

/** A card share the smoke test runs on, held until `release` (ImagesOptions.smokeCard). */
export interface SmokeCard {
  device: string
  release: () => void
}

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
  /**
   * Whether a pull may start now: the disk Docker keeps images on is above
   * the floor (sync.ts · mayPull, which asks for eviction when it is not).
   * Absent: always.
   */
  diskGate?: () => Promise<boolean>
  /** A pull that failed for want of room: the agent says it as a `disk` problem. */
  onDiskFull?: (detail: string) => void
  /**
   * The card a GPU revision's smoke test runs on: one with a share free,
   * held like a run's share until the test releases it (sync.ts · checkCard);
   * `null` — every card is full, and the test waits (see the header). Absent:
   * card 0, held by nobody.
   */
  smokeCard?: () => SmokeCard | null
  /** Tests: the backoff before each retry of an inspect that failed without saying why (INSPECT_RETRY_MS). */
  inspectRetryMs?: readonly number[]
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
  /** Revisions whose pull waits for room on the disk (waitForDisk). */
  private readonly waitingForDisk = new Set<string>()
  /** Revisions waiting SOON_MS for a reason not their own, by what was said of it (soon): said once a wait, not once a try. */
  private readonly waitingSoon = new Map<string, string>()
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
   * image prune`, another store after a daemon change). A daemon that did not
   * answer (`unknown`, after its retries) says nothing against the book, whose
   * word stands until the check right before a run asks again (verify): a
   * daemon still coming up must not unready every revision of the machine,
   * each GPU one to be smoke-tested again.
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
      if (book.readyAt !== null) {
        const found = await this.inspect(revisionImage(book.id))
        if (found.kind === 'missing' || (found.kind === 'image' && found.layers !== book.layers)) book.readyAt = null
      }
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
   * is there and its layers are the lease's pin. `null` — not here, not that
   * image, or a daemon that failed every try of the inspect (see the header),
   * which declines the lease (`image`) before any container and leaves the
   * revision to be checked again before it is ready. A lease that stops
   * waiting meanwhile (`signal`: a revoke, a stop) learnt nothing about the
   * image, and the revision stays as it was.
   */
  async verify(revision: { id: string; layers: string }, signal?: AbortSignal): Promise<string | null> {
    const book = this.books.get(revision.id)
    if (!book || book.readyAt === null || book.layers !== revision.layers) return null
    const found = await this.inspect(revisionImage(revision.id), signal)
    if (found.kind === 'image' && found.layers === revision.layers) {
      book.wantedAt = this.now()
      return revisionImage(revision.id)
    }
    if (signal?.aborted) return null
    if (found.kind === 'unknown') this.options.log?.(`[runner] revision ${revision.id.slice(0, 12)} could not be checked before a run: docker did not answer an inspect (${found.detail}); it is checked again before it is ready`)
    book.readyAt = null
    this.save(revision.id)
    this.options.onChange?.()
    this.kick()
    return null
  }

  /**
   * Whether a revision is ready here by its book (pulled, checked, tagged),
   * without asking docker: what a class placement waits on before it starts
   * (kernels.ts), which then checks the image once more by `verify`.
   */
  isReady(id: string): boolean {
    return (this.books.get(id)?.readyAt ?? null) !== null
  }

  /** What was last said against a revision (its `image`, `layers` or `smoke` problem), in the agent's words; null — nothing. */
  problemWith(id: string): string | null {
    for (const code of ['image', 'layers', 'smoke'] as const) {
      const problem = this.problems.get(`${code}:${id}`)
      if (problem) return problem.detail
    }
    return null
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
   * here is the same image. Returns how many went. `freeMb` is the free disk
   * where Docker keeps its images, asked again after each removal (a measure
   * of Docker's own disk, sync.ts, is a container's run: hence a promise).
   */
  async evict(inUse: ReadonlySet<string>, freeMb: () => number | null | Promise<number | null>, floorMb: number): Promise<number> {
    const now = this.now()
    const wanted = new Set(this.wanted.map((revision) => revision.id))
    const candidates = [...this.books.values()]
      .filter((book) => !inUse.has(book.id) && !wanted.has(book.id) && now - book.wantedAt >= REMOTE_EVICT_AFTER_MS)
      .sort((a, b) => a.wantedAt - b.wantedAt)
    let removed = 0
    for (const book of candidates) {
      const free = await freeMb()
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
      let pinned = await this.inspect(ref)
      if (pinned.kind === 'unknown') return this.soon(revision, 'image', `docker did not answer an inspect of ${ref}: ${pinned.detail}`)
      if (pinned.kind === 'missing') {
        // Gigabytes onto a disk below its floor fail midway, or fill it under the runs: not begun until eviction has made room.
        if (this.options.diskGate && !(await this.options.diskGate())) return this.waitForDisk(revision, 'the disk Docker keeps images on is below its floor')
        this.waitingForDisk.delete(id)
        const layerState = new Map<string, boolean>()
        const pulled = await this.docker(['pull', ref], { timeoutMs: PULL_TIMEOUT_MS, onLine: (line) => this.pullLine(id, line, layerState) })
        if (pulled.code !== 0 && NO_SPACE.test(pulled.out)) {
          const detail = `docker pull ${ref} ran out of disk: ${dockerWords(pulled)}`
          this.options.onDiskFull?.(detail)
          return this.waitForDisk(revision, detail)
        }
        if (pulled.code !== 0) return this.fail(revision, 'image', `docker pull ${ref} failed: ${dockerWords(pulled)}`)
        pinned = await this.inspect(ref)
        if (pinned.kind === 'unknown') return this.soon(revision, 'image', `docker did not answer an inspect of the pulled ${ref}: ${pinned.detail}`)
        if (pinned.kind === 'missing') return this.fail(revision, 'image', `the pulled ${ref} cannot be inspected`)
      }
      if (pinned.layers !== layers) {
        return this.fail(revision, 'layers', `the pulled image's layers (${pinned.layers?.slice(0, 12) ?? 'unreadable'}) are not the pinned ${layers.slice(0, 12)}: not the image home runs`)
      }
      if (gpu) {
        const card = this.options.smokeCard ? this.options.smokeCard() : { device: '0', release: () => undefined }
        if (card === null) return this.soon(revision, null, 'no card has a share free for its GPU check')
        let smoke: string | 'full' | null
        try {
          smoke = await this.smoke(id, ref, card.device)
        } finally {
          card.release()
        }
        if (smoke === 'full') return this.soon(revision, null, `card ${card.device} had no room for its GPU check (CUDA out of memory: runs hold it)`)
        if (smoke !== null) return this.fail(revision, 'smoke', smoke)
      }
      const tagged = await this.docker(['tag', ref, revisionImage(id)], { timeoutMs: 60_000 })
      if (tagged.code !== 0) return this.fail(revision, 'image', `docker tag failed: ${dockerWords(tagged)}`)
      const book = this.books.get(id) ?? { id, ref, layers, gpu, readyAt: null, wantedAt: this.now() }
      book.readyAt = this.now()
      this.books.set(id, book)
      this.save(id)
      this.retry.delete(id)
      this.waitingSoon.delete(id)
      for (const code of ['image', 'layers', 'smoke'] as const) this.problems.delete(`${code}:${id}`)
      this.options.log?.(`[runner] revision ${id.slice(0, 12)} is ready (${ref})`)
    } finally {
      this.percent.delete(id)
      this.options.onChange?.()
    }
  }

  private fail(revision: RemoteWantRevision, code: Extract<RemoteProblemCode, 'image' | 'layers' | 'smoke'>, detail: string): void {
    this.waitingSoon.delete(revision.id)
    this.problemOf(revision, code, detail)
    const before = this.retry.get(revision.id)
    const waitMs = before && before.waitMs > 0 ? Math.min(RETRY_MS.last, before.waitMs * 2) : RETRY_MS.first
    this.retry.set(revision.id, { at: this.now() + waitMs, waitMs })
    this.options.log?.(`[runner] revision ${revision.id.slice(0, 12)} is not ready (${code}): ${detail}; tried again in ${Math.round(waitMs / 60_000)} min`)
  }

  /** The revision's one problem now: a new one replaces whatever was said of it before. */
  private problemOf(revision: RemoteWantRevision, code: Extract<RemoteProblemCode, 'image' | 'layers' | 'smoke'>, detail: string): void {
    for (const other of ['image', 'layers', 'smoke'] as const) this.problems.delete(`${other}:${revision.id}`)
    this.problems.set(`${code}:${revision.id}`, { code, revisionId: revision.id, detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') })
  }

  /**
   * A revision that could not be checked for a reason not its own (see the
   * header): a daemon that did not answer, said as its `image` problem in the
   * daemon's words (`code`), or no card with room for its smoke test, said as
   * nothing (null: nothing is wrong with the revision, and a `smoke` problem
   * would read as a driver at fault; what was said of it before stands).
   * Tried again after SOON_MS, a wait that does not grow — a failure's does,
   * to half an hour, which a card freed a minute later would sit out — while
   * the failures' own wait so far is kept for those to come.
   */
  private soon(revision: RemoteWantRevision, code: 'image' | null, detail: string): void {
    if (code) this.problemOf(revision, code, detail)
    const before = this.retry.get(revision.id)
    this.retry.set(revision.id, { at: this.now() + SOON_MS, waitMs: before?.waitMs ?? 0 })
    // Said once a wait, not once a try.
    if (this.waitingSoon.get(revision.id) === detail) return
    this.waitingSoon.set(revision.id, detail)
    this.options.log?.(`[runner] revision ${revision.id.slice(0, 12)} waits: ${detail}; tried again in ${Math.round(SOON_MS / 1000)} s`)
  }

  /**
   * A pull with no room for it: no problem of the revision's (the image is
   * not to blame; the agent says `disk`), and no growing wait either: the pull
   * is tried again as soon as eviction may have made room. A failure's wait
   * so far is kept for the failures to come.
   */
  private waitForDisk(revision: RemoteWantRevision, detail: string): void {
    const before = this.retry.get(revision.id)
    this.retry.set(revision.id, { at: this.now() + DISK_WAIT_MS, waitMs: before?.waitMs ?? 0 })
    // Said once a wait, not once a minute.
    if (this.waitingForDisk.has(revision.id)) return
    this.waitingForDisk.add(revision.id)
    this.options.log?.(`[runner] revision ${revision.id.slice(0, 12)} waits for disk: ${detail}`)
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

  /**
   * The smoke test (see the header) on card `device`: null — torch used the
   * card; `full` — the card had no room for its CUDA context (runs hold it),
   * which says nothing about the revision; otherwise what went wrong.
   */
  private async smoke(id: string, ref: string, device: string): Promise<string | 'full' | null> {
    // Named for this tree as well as the revision: another agent on the daemon smoke-testing the same one has a name of its own.
    const name = `colloq-runner-check-${INSTANCE_SCOPE.slice(0, 8)}-${id.slice(0, 12)}`
    await this.docker(['rm', '-f', name], { timeoutMs: 30_000 })
    const ran = await this.docker([
      'run', '--rm', '--pull=never', '--name', name, ...CHECK_LABELS,
      '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
      '--tmpfs=/tmp:rw,nosuid,nodev,size=256m', '-e', 'HOME=/tmp', '--user=1000:1000',
      '--gpus', `device=${device}`, '--entrypoint', 'python', ref, '-I', '-c', SMOKE_SCRIPT,
    ], { timeoutMs: SMOKE_TIMEOUT_MS })
    if (ran.code === 0 && /\bcuda-ok\b/.test(ran.out)) return null
    // Killed at the timeout: the client is gone, the container may not be.
    if (ran.code === -1) await this.docker(['rm', '-f', name], { timeoutMs: 30_000 })
    if (/\bcuda-missing\b/.test(ran.out)) return `torch sees no CUDA device on card ${device} (the NVIDIA container toolkit or the driver)`
    if (CARD_FULL.test(ran.out)) return 'full'
    if (ran.code === 142) return `torch did not reach card ${device} within ${REMOTE_GPU_SMOKE_MS / 1000} s`
    return `the GPU check failed: ${dockerWords(ran)}`
  }

  /**
   * What `docker image inspect` says of an image (Inspected), a failure that
   * says nothing asked again after each of the backoff's waits (see the
   * header). A daemon's "No such image" is an answer at once. `signal` — the
   * lease that waits for it stopped waiting: no more tries.
   */
  private async inspect(image: string, signal?: AbortSignal): Promise<Inspected> {
    const waits = this.options.inspectRetryMs ?? INSPECT_RETRY_MS
    for (let tried = 0; ; tried++) {
      const inspected = await this.docker(['image', 'inspect', image], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
      if (inspected.code === 0) {
        try {
          const value: unknown = JSON.parse(inspected.out)
          return { kind: 'image', layers: imageIdentity(Array.isArray(value) ? value[0] : value).layers }
        } catch {
          return { kind: 'image', layers: null }
        }
      }
      if (dockerMissing(inspected)) return { kind: 'missing' }
      const waitMs = waits[tried]
      if (waitMs === undefined || this.stopped || signal?.aborted) return { kind: 'unknown', detail: dockerWords(inspected) }
      await pause(waitMs, signal)
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

/** A wait that ends early when the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** A revision's book as written down; null — not one this code wrote. */
function bookOf(value: unknown, id: string): RevisionBook | null {
  const v = value as Partial<RevisionBook> | null
  if (!v || v.id !== id || !REMOTE_REVISION_ID.test(id) || typeof v.ref !== 'string' || !REMOTE_IMAGE_REF.test(v.ref)
    || typeof v.layers !== 'string' || !REMOTE_SHA256.test(v.layers) || typeof v.gpu !== 'boolean'
    || !(v.readyAt === null || Number.isSafeInteger(v.readyAt)) || !Number.isSafeInteger(v.wantedAt)) return null
  return { id, ref: v.ref, layers: v.layers, gpu: v.gpu, readyAt: v.readyAt ?? null, wantedAt: v.wantedAt as number }
}
