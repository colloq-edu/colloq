/**
 * The council's side of a class machine («занятия на машинах»,
 * docs/architecture/remote-classes.md §9.2, §9.5, §9.7): the epochs a
 * council's workers load, the attempts' scratch folders, and the files an
 * attempt wrote on their way to its card at home.
 *
 *   <state>/council/<id>/epochs/<sha256>   every file of the class's epochs held here, a hard
 *                                          link into the CAS: mounted read-only at /colloq/epochs
 *   <state>/council/<id>/scratch/<runId>/  an attempt's working folder, made by its worker's
 *                                          `enter`: mounted read-write at /colloq/scratch
 *                                          (root's, 1733: a worker makes its own run's
 *                                          folder there and lists none; the agent's helper
 *                                          makes it so, scratchHelperArgs)
 *   <state>/council/<id>/epochs.json       the epochs held, written whole: what a restart keeps
 *   <state>/council/<id>/.staging/         the agent's own: an export as `docker cp` copied it,
 *                                          a file of an attempt on its way home; never mounted
 *   <state>/council/.gate/<digest>/        the workers' gate (§9.6, councilGate), one for every
 *                                          class: module/ mounted read-only at /colloq/gate, its
 *                                          ipython_kernel_config.py at /etc/ipython/
 *
 * AN EPOCH IS CONTENT-ADDRESSED, AND SO IS EVERY COPY OF IT HERE. Home names
 * an epoch by its files' hashes (RemoteEpochIntent). Each comes from the CAS
 * when it is there already (an unchanged buffer of the notebook's previous
 * epoch, the same data in another class); from the export when the
 * notebook's kernel runs on this machine — `docker cp` of its
 * /tmp/colloq-epoch/<seq>/, which no other container reaches, every file
 * taken by its content and checked against the hash home named before the
 * CAS takes it, the folder then removed from the container; or from home, by
 * its hash, down the agent's one blob stream at the class's rate. Into the
 * class's epochs folder each goes as a hard link: that mount is read-only, so
 * a worker can neither change a file nor reach the CAS through it, and the
 * pages of a buffer are in the page cache once for every worker (§9.3). An
 * epoch is ready once every file of it is there, and the CAS keeps every file
 * a held epoch names (Cache · pinned: never released, never evicted).
 *
 * WHICH EPOCHS ARE HELD. For each notebook: the newest ready one, which the
 * pool loads; the newest one newer than it that may still come; and those
 * newer than it that cannot be had, two at most, said failed until a newer
 * one is ready — home keeps two a notebook (§9.2 «Registry») and, hearing the
 * newer failed, wants the older one, which a failed one never shadows. An
 * older ready one stays graceMs after a newer one is ready — loads home sent
 * before it heard of the newer one still open its files. An older one not
 * ready goes at once, unless its export is being read, or holds files the
 * coming one lacks: a refreeze writes only the buffers that changed since the
 * export before it (§9.3), so that export is read first and to the end. One
 * let go before its export was read has that export's folder removed from
 * its container all the same: nothing will read it now. A class home no
 * longer names on this machine, and whose containers are gone, goes whole.
 *
 * AN ATTEMPT'S FILES ARE PARTICIPANT DATA (§9.7, §8.6). Its scratch folder is
 * the worker's: symlinks into the read-only class folder, which resolve inside
 * the container and point anywhere at all on the host, and files of any kind
 * and size. So nothing here reads it but through the anchored filesystem
 * (secure-files.ts), which follows no link anywhere on a path: a file goes
 * home only when it is a regular file of the length and the hash home named,
 * within COUNCIL_ARTIFACTS, copied into the agent's own staging as it is
 * hashed (the bytes that go are the bytes that were hashed); a folder is
 * removed without following anything in it. Home checks names, sizes and
 * types again at its door. A collection is over, and its folder goes, only
 * once each file went home or never can (gone, changed, no regular file, past
 * a cap, refused): a home out of reach is waited for, the folder kept.
 *
 * HOME'S WORD IS LEVEL-TRIGGERED, as the rest of the block is. A reply names
 * the epochs not yet ready, what of an export read here to send home (`ship`),
 * and the attempts whose files to collect; a sync says every epoch held, and
 * the attempts whose collection is over until a sync carrying them is
 * answered. A lost reply or a lost sync is a delay, never a loss.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createGzip } from 'node:zlib'
import {
  CLASS_BULK_IDLE_MBPS,
  CLASS_PACE_BURST_BYTES,
  COUNCIL_ARTIFACTS,
  COUNCIL_EPOCHS_MOUNT,
  COUNCIL_EPOCH_BUFFERS_MAX,
  COUNCIL_GATE_CONFIG_MOUNT,
  COUNCIL_GATE_MOUNT,
  COUNCIL_SCRATCH_MOUNT,
  MACHINE_PACE_MBPS,
  REMOTE_COLLECTED_MAX,
  REMOTE_EPOCHS_MAX,
  REMOTE_SESSION_ID,
  parseRemoteKernelsReply,
  parseRemotePlacementKey,
  remoteClassPaths,
  type RemoteEpochFailure,
  type RemoteEpochIntent,
  type RemoteEpochState,
  type RemoteKernelRole,
  type RemoteKernelsReply,
  type RemoteKernelsRequest,
} from '@shared/remote-kernels'
import {
  REMOTE_API_BASE,
  REMOTE_BYTES_HEADER,
  REMOTE_ERRORS,
  REMOTE_MARKER,
  REMOTE_MARKER_HEADER,
  REMOTE_REASON_CHARS,
  REMOTE_SHA256_HEADER,
  parseRemoteErrorReply,
  remoteText,
  remoteTransient,
  type RemoteErrorCode,
} from '@shared/remote-runner'
import type { RoomMount } from '../kernel/room-spec.js'
import { COUNCIL_GATE_CONFIG, COUNCIL_GATE_DIGEST, COUNCIL_GATE_FILE, COUNCIL_GATE_PYTHON } from '../kernel/council-gate.js'
import { createAnchoredFilesystem } from '../secure-files.js'
import { CacheError, Pacer, pause } from './cache.js'
import { Backoff, retryAfter } from './client.js'
import { dockerMissing, dockerWords, type Docker } from './docker.js'
import type { RoomUploadAnswer } from './room-files.js'
import { readJson, writeWhole, type StateLayout } from './state.js'

/* ----------------------------------------------------------------- numbers */

/** How the council's side keeps time: the defaults, which tests shorten or drive by hand (beatMs 0: no timer of its own). */
export interface CouncilTimings {
  /** The beat that starts what is due: an epoch's retry, an upload, the sweeps. */
  beatMs: number
  /** A step that failed (docker, a hiccup of home's, a full disk) is tried again after this, doubling up to `last`. */
  retryMs: { first: number; last: number }
  /** An older ready epoch of a notebook stays this long after a newer one is ready. */
  graceMs: number
  /** An attempt's scratch folder that no collection names goes this long after this life first saw it. */
  scratchKeepMs: number
  /** An upload that moved no byte for this long is given up, and tried again later. */
  uploadStallMs: number
  /** A collection that is over, and a file sent home or refused there, is remembered this long: home's repeat of it is said again, never done again. */
  repeatMs: number
  /** `docker cp` of one export at most: two gigabytes off a local disk. */
  copyMs: number
}

export const COUNCIL_TIMINGS: Readonly<CouncilTimings> = Object.freeze({
  beatMs: 1_000,
  retryMs: Object.freeze({ first: 5_000, last: 60_000 }),
  graceMs: 60_000,
  scratchKeepMs: 6 * 60 * 60_000,
  uploadStallMs: 60_000,
  repeatMs: 60_000,
  copyMs: 10 * 60_000,
})

const MIB = 1024 * 1024
/** Tries of one copy of an export through docker's hiccups before the epoch fails as `source`. */
const COPY_TRIES = 5
/** Tries of one upload through transient answers before it waits: an export's file until home asks again, an attempt's until its collection's next round. */
const UPLOAD_TRIES = 5
/** Epochs of a notebook that cannot be had, newer than its ready one, held to say so: home keeps two a notebook (§9.2 «Registry»). */
const FAILED_KEPT = 2
/** Files of an export's folder looked at beyond the ones an epoch needs: a folder of thousands of strays is no export. */
const EXPORT_SLACK = 64
/** How often the scratch folders are looked at for what nobody collects. */
const SCRATCH_LOOK_MS = 60_000
/** How often a scratch space the agent cannot list itself (root's) is listed by its helper: a container's start each time. */
const SCRATCH_HELPER_LOOK_MS = 15 * 60_000

/* ------------------------------------------------------------------- paths */

/** Every class's council folder on this machine (the layout above). */
export function councilRoot(layout: StateLayout): string {
  return path.join(layout.root, 'council')
}

/** One class's council folder. */
export function councilDir(layout: StateLayout, sessionId: string): string {
  if (!REMOTE_SESSION_ID.test(sessionId)) throw new Error('Invalid class id')
  return path.join(councilRoot(layout), sessionId)
}

const epochsDir = (dir: string): string => path.join(dir, 'epochs')
const scratchDir = (dir: string): string => path.join(dir, 'scratch')

/** One class's scratch space, the attempts' folders (the layout above). */
export function councilScratchDir(layout: StateLayout, sessionId: string): string {
  return scratchDir(councilDir(layout, sessionId))
}
const stagingDir = (dir: string): string => path.join(dir, '.staging')
const recordFile = (dir: string): string => path.join(dir, 'epochs.json')

/**
 * The attempts' scratch space: root's folder at 1733, which the workers may
 * enter and make an entry in, but never list, and the sticky bit keeps them
 * from removing or renaming what is not theirs. All workers of a class share
 * a uid, so what keeps one attempt out of another's folder is that it cannot
 * find it: its name is the run's id, 32 random hex digits, and the listing is
 * shut (K7a #17; a sibling's /proc/<pid>/cwd still shows it, one uid for
 * all).
 *
 * Root's, not the agent's: the agent is uid 1000 on every machine
 * (entrypoint · drop_to_app), the kernels' own uid, and a folder's owner may
 * give it any mode — chmod asks ownership, no permission bit — list it then,
 * and take any run's folder out of it whatever the sticky bit says (K12b).
 * The agent has no root of its own, so its helper makes it so: the agent's
 * own image run by docker as root for one shell line (scratchHelperArgs), at
 * every start of a council container. The agent itself, as other, may still
 * reach a folder by its name, and remove one its uid made: a collection names
 * its run, and the sweep's names come from the helper.
 */
const SCRATCH_MODE = 0o1733

/** The kind label of the scratch space's helper runs: the perimeter's helper has its own (perimeter-core.ts · helperArgs). */
export const SCRATCH_HELPER_LABEL = 'colloq.kind=council-scratch'

/** What the helper does to a class's scratch space: make it root's for a new container, list it, or empty it for good. */
export type ScratchAction = 'fresh' | 'list' | 'remove'

/** The scratch space inside the helper's container. */
const SCRATCH_IN_HELPER = '/s'

/** The helper's line for each, ending in its word, as the perimeter's ends in its own (`colloq-perimeter: ok`). */
const SCRATCH_SCRIPTS: Readonly<Record<ScratchAction, string>> = Object.freeze({
  // A new council container's start: what the attempts before it left goes, their workers gone, and the root is root's, 1733.
  fresh: `set -e; find ${SCRATCH_IN_HELPER} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; chown 0:0 ${SCRATCH_IN_HELPER}; chmod 1733 ${SCRATCH_IN_HELPER}; echo 'colloq-scratch: ok'`,
  // The sweep's look: every entry by its path, NUL after each, then the word on a line of its own.
  list: `set -e; find ${SCRATCH_IN_HELPER} -mindepth 1 -maxdepth 1 -print0; printf '\\ncolloq-scratch: ok\\n'`,
  // The class gone from this machine: every entry, the root left for the agent to remove from its own folder.
  remove: `set -e; find ${SCRATCH_IN_HELPER} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; echo 'colloq-scratch: ok'`,
})

/**
 * The helper's `docker run` (§9.7, K7a #17): the agent's own image by its id
 * (kernels.ts · helperImage, as the perimeter's helper runs), as root with
 * the three capabilities its line needs — to give the root to root, to
 * remove the workers' folders in a sticky folder not its own — and nothing
 * else: no network, no host namespace, no new privileges, the one folder
 * mounted, gone after (`--rm`). Never a kernel image: a teacher's package list
 * must not run as root on the host.
 */
export function scratchHelperArgs(image: string, scratch: string, action: ScratchAction): string[] {
  return [
    'run',
    '--rm',
    '--network=none',
    '--user=0:0',
    '--cap-drop=ALL',
    '--cap-add=CHOWN',
    '--cap-add=FOWNER',
    '--cap-add=DAC_OVERRIDE',
    '--security-opt=no-new-privileges',
    '--pull=never',
    '--no-healthcheck',
    '--label',
    SCRATCH_HELPER_LABEL,
    '-v',
    `${scratch}:${SCRATCH_IN_HELPER}`,
    '--entrypoint=sh',
    image,
    '-c',
    SCRATCH_SCRIPTS[action],
  ]
}

/** Whether the helper's run said it did what it was asked. */
export function scratchHelperDone(out: string): boolean {
  return /(^|\n)colloq-scratch: ok\s*$/.test(out)
}

/** The entries the helper's `list` named: each by its name, the folder's path off it, nothing docker said beside them. */
export function scratchHelperNames(out: string): string[] {
  const listing = out.slice(0, Math.max(0, out.lastIndexOf('colloq-scratch: ok')))
  return listing
    .split('\0')
    // A line docker wrote on its own (a warning before the container's output) ends where the next path starts.
    .map((chunk) => {
      const at = chunk.lastIndexOf(`\n${SCRATCH_IN_HELPER}/`)
      return at >= 0 ? chunk.slice(at + 1) : chunk
    })
    .filter((chunk) => chunk.startsWith(`${SCRATCH_IN_HELPER}/`) && !chunk.slice(SCRATCH_IN_HELPER.length + 1).includes('/'))
    .map((chunk) => chunk.slice(SCRATCH_IN_HELPER.length + 1))
    .filter((name) => name !== '' && name !== '.' && name !== '..')
}

/**
 * The council container's own folders (§9.7), for its `docker run`: the
 * class's epochs read-only at COUNCIL_EPOCHS_MOUNT and the attempts' scratch
 * space read-write at COUNCIL_SCRATCH_MOUNT, made before docker would make
 * them as root; and the workers' gate (§9.6, kernel/council-gate.ts), read-
 * only from the agent's one folder of it (councilGate): its module's folder
 * at COUNCIL_GATE_MOUNT and the system IPython config that loads it into
 * every kernel the container starts at COUNCIL_GATE_CONFIG_MOUNT. The
 * scratch space is root's at SCRATCH_MODE, emptied of the attempts before,
 * only once the helper has run on it (kernels.ts · councilScratch, before
 * every start of the container); made here, it is the agent's, at that
 * mode, until then. Nothing else of the agent's is mounted: no state, no
 * socket, no card.
 */
export function councilMounts(layout: StateLayout, sessionId: string): RoomMount[] {
  const dir = councilDir(layout, sessionId)
  fs.mkdirSync(epochsDir(dir), { recursive: true, mode: 0o755 })
  const scratch = scratchDir(dir)
  if (!fs.existsSync(scratch)) {
    fs.mkdirSync(scratch, { mode: SCRATCH_MODE })
    if (process.platform !== 'win32') fs.chmodSync(scratch, SCRATCH_MODE)
  }
  const gate = councilGate(layout)
  return [
    { source: epochsDir(dir), target: COUNCIL_EPOCHS_MOUNT, readOnly: true },
    { source: scratch, target: COUNCIL_SCRATCH_MOUNT, readOnly: false },
    { source: gate.module, target: COUNCIL_GATE_MOUNT, readOnly: true },
    { source: gate.config, target: COUNCIL_GATE_CONFIG_MOUNT, readOnly: true },
  ]
}

/** The agent's folders of the gate, one per text of it: `<state>/council/.gate/<digest>` (no class's name: a dot never is one). */
const gateRoot = (layout: StateLayout): string => path.join(councilRoot(layout), '.gate')

/**
 * The workers' gate on this machine (§9.6): the module and the config of
 * kernel/council-gate.ts, written once into a folder named by their own
 * hash, `<state>/council/.gate/<digest>/` — `module/colloq_gate.py` and
 * `ipython_kernel_config.py`, 0644 in folders of 0755 — and never changed
 * in place: a container keeps the folder of the texts it was started with
 * (the next build's go into a folder of their own), and a folder that is
 * not what its name says is written again. Made whole in a staging folder
 * and renamed into place, so that a life that ends midway leaves no half
 * of it. Gone with every class's council folder (kernels.ts · removeAll),
 * and written again by the next council container's start.
 */
export function councilGate(layout: StateLayout): { module: string; config: string } {
  const root = gateRoot(layout)
  const dir = path.join(root, COUNCIL_GATE_DIGEST)
  const at = { module: path.join(dir, 'module'), config: path.join(dir, 'ipython_kernel_config.py') }
  if (gateWhole(at)) return at
  fs.mkdirSync(root, { recursive: true, mode: 0o755 })
  // What an earlier life left half made, and a folder that is not what its name says.
  for (const name of fs.readdirSync(root)) if (name.startsWith('.tmp-') || name === COUNCIL_GATE_DIGEST) removeTree(path.join(root, name))
  const staging = path.join(root, `.tmp-${randomBytes(6).toString('hex')}`)
  fs.mkdirSync(path.join(staging, 'module'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'module', COUNCIL_GATE_FILE), COUNCIL_GATE_PYTHON)
  fs.writeFileSync(path.join(staging, 'ipython_kernel_config.py'), COUNCIL_GATE_CONFIG)
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(staging, 'module', COUNCIL_GATE_FILE), 0o644)
    fs.chmodSync(path.join(staging, 'ipython_kernel_config.py'), 0o644)
    fs.chmodSync(path.join(staging, 'module'), 0o755)
    fs.chmodSync(staging, 0o755)
    fs.chmodSync(root, 0o755)
  }
  fs.renameSync(staging, dir)
  return at
}

/** The gate's folder holds its two texts as they are, and nothing stands in for them (no link). */
function gateWhole(at: { module: string; config: string }): boolean {
  try {
    const module = path.join(at.module, COUNCIL_GATE_FILE)
    for (const file of [module, at.config]) if (!fs.lstatSync(file).isFile()) return false
    if (!fs.lstatSync(at.module).isDirectory()) return false
    return fs.readFileSync(module, 'utf8') === COUNCIL_GATE_PYTHON && fs.readFileSync(at.config, 'utf8') === COUNCIL_GATE_CONFIG
  } catch {
    return false
  }
}

/**
 * One entry of a scratch space gone by its name, without listing the space
 * (root's, which the agent cannot list) and without following anything in
 * it: a folder an attempt's worker made — its uid is the agent's — through
 * the anchored filesystem from that folder, then the folder itself; anything
 * else, a link included, unlinked. Whether it went (or was not there).
 */
function removeEntry(scratch: string, name: string): boolean {
  const at = path.join(scratch, name)
  if (path.dirname(at) !== scratch) return false
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(at)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  try {
    if (!stat.isDirectory()) {
      fs.unlinkSync(at)
      return true
    }
    const afs = createAnchoredFilesystem(at)
    try {
      for (const entry of afs.readdirSync(at) as string[]) afs.rmSync(path.join(at, entry), { recursive: true, force: true })
    } finally {
      afs.close()
    }
    try {
      fs.rmdirSync(at)
    } catch (error) {
      // Swapped for a link meanwhile: the link goes, never what it points at.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
      fs.unlinkSync(at)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Every entry of a scratch folder gone, by its name (removeEntry): nothing a
 * worker left there is followed. How many would not go; null — the agent
 * cannot list it (root's, as its helper makes it), and the helper must.
 */
function emptyScratch(scratch: string): number | null {
  let names: string[]
  try {
    names = fs.readdirSync(scratch)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM' ? null : 1
  }
  return names.filter((name) => !removeEntry(scratch, name)).length
}

/**
 * A folder of the agent's own removed as far as it will go: an export's
 * staging, whose entries docker cp made with the container's modes (a
 * folder at 000 included), and a class's council folder once nothing of the
 * class runs here. A link is removed, never followed. How many entries
 * stayed.
 */
function removeTree(root: string): number {
  let stayed = 0
  const stack: Array<{ at: string; open: boolean }> = [{ at: root, open: false }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    if (top.open) {
      stack.pop()
      try {
        fs.rmdirSync(top.at)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stayed++
      }
      continue
    }
    top.open = true
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(top.at)
    } catch {
      stack.pop()
      continue
    }
    if (!stat.isDirectory()) {
      stack.pop()
      try {
        fs.unlinkSync(top.at)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stayed++
      }
      continue
    }
    try {
      fs.chmodSync(top.at, 0o700)
    } catch { /* the walk says what it could not read */ }
    let names: string[]
    try {
      names = fs.readdirSync(top.at)
    } catch {
      // Unreadable — a scratch space root's, which the helper emptied (CouncilHost · removeHelped): an empty folder goes by its
      // parent's leave all the same, whoever owns it.
      stack.pop()
      try {
        fs.rmdirSync(top.at)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stayed++
      }
      continue
    }
    for (const name of names) stack.push({ at: path.join(top.at, name), open: false })
  }
  return stayed
}

/** A regular file's sha256, read through a descriptor that follows no link, a slice at a time; null — none there, not a regular file, or `signal` gave up. */
async function hashFile(file: string, signal: AbortSignal): Promise<string | null> {
  let handle: fs.promises.FileHandle
  try {
    // Never through a link, and never waiting on a pipe: what is not a regular file is no file of an epoch.
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    if (!(await handle.stat()).isFile()) return null
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(MIB)
    for (;;) {
      if (signal.aborted) return null
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** One read of a descriptor, without holding the loop. */
function readAt(fd: number, buffer: Buffer): Promise<number> {
  return new Promise((resolve, reject) => fs.read(fd, buffer, 0, buffer.length, null, (error, read) => (error ? reject(error) : resolve(read))))
}

const sameStat = (a: fs.Stats, b: fs.Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs

/* ---------------------------------------------------------------- the seams */

/** What the council asks of the agent's CAS (cache.ts · Cache). */
export interface CouncilCas {
  /** A blob of home's by its hash, down the agent's one stream, at `pace` bytes a second: the path of the verified blob. Throws CacheError. */
  blob(sha: string, bytes: number, options: { signal: AbortSignal; pace: () => number; urgent: () => boolean }): Promise<string>
  /** Whether the CAS holds a verified blob of this hash. */
  has(sha: string): boolean
  /** A file the agent checked against `sha` itself, taken into the CAS (Cache · adopt). */
  adopt(file: string, sha: string): string
  /** A held blob's bytes at `to` too: a hard link, a copy where links are refused (Cache · place). */
  place(sha: string, to: string): 'linked' | 'copied'
  /** Where the CAS keeps a blob. */
  path(sha: string): string
  /** A blob no epoch names any more, let go unless something else of the CAS's holds it (Cache · release). */
  release(sha: string): void
}

/** One PUT to home's council doors: an epoch's file (raw), an attempt's file (gzip). */
export interface CouncilPut {
  /** The door under REMOTE_API_BASE: remoteClassPaths.epoch or .artifact. */
  door: string
  sha256: string
  /** The file's length, uncompressed (X-Colloq-Bytes). */
  bytes: number
  gzip: boolean
  body: ReadableStream<Uint8Array>
  signal: AbortSignal
}

export type CouncilUploader = (put: CouncilPut) => Promise<RoomUploadAnswer>

/**
 * Home's council doors (§15: PUT epochs/:sha256?session=&gen=, PUT
 * council/:sessionId/runs/:runId/files/:name?gen=), as the agent calls home:
 * the credential in the Authorization header and nowhere else, no redirect
 * followed, the body streamed as it is paced, X-Colloq-Sha256 and
 * X-Colloq-Bytes of the file as it is, a reply without home's marker, a 429
 * or a 5xx transient, any other refusal home's by its code — and a 413
 * without the marker a proxy's in front of home, which no retry gets past
 * (room-files.ts · homeUploader reads its door the same way).
 */
export function councilUploader(input: { home: string; credential: () => string | null; fetch?: typeof fetch }): CouncilUploader {
  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis)
  return async (put) => {
    const credential = input.credential()
    if (!credential) return { kind: 'transient', reason: 'not joined yet', retryAfterMs: null }
    let response: Response
    try {
      response = await fetchImpl(`${input.home}${REMOTE_API_BASE}/${put.door}`, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/octet-stream',
          ...(put.gzip ? { 'Content-Encoding': 'gzip' } : {}),
          [REMOTE_SHA256_HEADER]: put.sha256,
          [REMOTE_BYTES_HEADER]: String(put.bytes),
        },
        body: put.body,
        redirect: 'manual',
        signal: put.signal,
        duplex: 'half',
      } as RequestInit)
    } catch (error) {
      return { kind: 'transient', reason: put.signal.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error), retryAfterMs: null }
    }
    try {
      const marker = response.headers.get(REMOTE_MARKER_HEADER)
      if (response.status === 413 && marker?.trim() !== REMOTE_MARKER) {
        await response.body?.cancel().catch(() => undefined)
        return { kind: 'refused', status: 413, error: 'too_large', detail: 'a proxy in front of home refused a body this large', proxy: true }
      }
      if (remoteTransient(response.status, marker)) {
        await response.body?.cancel().catch(() => undefined)
        return { kind: 'transient', reason: `home answered ${response.status}`, retryAfterMs: retryAfter(response.headers.get('Retry-After')) }
      }
      const text = await cappedText(response, 64 * 1024)
      if (response.status < 400) return { kind: 'ok' }
      try {
        const reply = parseRemoteErrorReply(JSON.parse(text))
        return { kind: 'refused', status: response.status, error: reply.error, detail: reply.detail ?? '' }
      } catch {
        const error = (Object.keys(REMOTE_ERRORS) as RemoteErrorCode[]).find((code) => REMOTE_ERRORS[code] === response.status) ?? 'invalid'
        return { kind: 'refused', status: response.status, error, detail: remoteText(text.trim(), REMOTE_REASON_CHARS, 'start') }
      }
    } catch (error) {
      return { kind: 'transient', reason: error instanceof Error ? error.message : String(error), retryAfterMs: null }
    }
  }
}

/** A reply's body as text, read this far at most (and the rest let go). */
async function cappedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface CouncilHostOptions {
  layout: StateLayout
  docker: Docker
  cas: CouncilCas
  upload: CouncilUploader
  /** The gens of the class whose containers the kernel host holds (kernels.ts · heldGens): the class is here while any is. */
  held: (sessionId: string) => Array<{ role: RemoteKernelRole; gen: number }>
  /** The placement a running class container of this machine is (kernels.ts · containerOf); null — none. */
  containerOf: (container: string) => { sessionId: string; role: RemoteKernelRole; gen: number } | null
  /** The free disk of the tree's filesystem; null — unknown. An export is copied only above the floor. */
  diskFreeMb: () => number | null
  diskFloorMb: number
  /** Below the floor: the agent's eviction is asked for (sync.ts · keepDiskFloor). */
  onDiskLow?: () => void
  /**
   * The scratch space's helper (kernels.ts · councilScratch): what the agent
   * cannot do to root's folder itself — list it for the sweep, empty it when
   * the class goes. Its output, or why it would not run; none — the agent
   * lists its own folder, as before any helper.
   */
  scratch?: (sessionId: string, action: Exclude<ScratchAction, 'fresh'>) => Promise<{ ok: true; out: string } | { ok: false; why: string }>
  /** Something a sync reports changed; `urgent` — an epoch ready or failed: the held sync is cut short for it (a dispatch waits on it, D8). */
  onChange: (urgent: boolean) => void
  /** Home answered 401: the machine is revoked (sync.ts finds out by its own sync). */
  onUnauthorized?: () => void
  log: (line: string) => void
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  timings?: Partial<CouncilTimings>
  random?: () => number
  /** The bucket the class's files going home are paced through, the class folders' too (room-files.ts · RoomFilesOptions.pacer); one of its own by default. */
  pacer?: Pacer
}

/* ------------------------------------------------------------------ shapes */

/** An epoch held, or on its way. */
interface Epoch {
  readonly sessionId: string
  readonly root: string
  readonly seq: number
  /** Home's latest word on it: its files and where they come from. */
  intent: RemoteEpochIntent
  /** Every file of it, the manifest and the buffers, by hash, with its length. */
  readonly files: ReadonlyMap<string, number>
  /** The files in the class's epochs folder. */
  readonly present: Set<string>
  /** When it was whole here; null — not yet. */
  readyAt: number | null
  failed: RemoteEpochFailure | null
  /** Its export was read, and its folder in the container removed (or it has none to read). */
  read: boolean
  /** Tries in a row that failed, and when the next is due. */
  tries: number
  retryAt: number
  /** An older ready epoch's end: graceMs after a newer one of its notebook was ready. */
  leaveAt: number | null
  /** Home named it in a reply of this life, so it knows the words of `failed` (a home without them names none). */
  named: boolean
  /** No longer the one coming, held only for its export (retain): read, never fetched from home, then let go. */
  feeding: boolean
}

/** One class's council here: its epochs and the work on them, one piece at a time. */
interface Klass {
  readonly sessionId: string
  readonly dir: string
  readonly epochs: Map<string, Epoch>
  work: Promise<void> | null
  /** The epoch the work is on: dropping it stops the work. */
  current: Epoch | null
  abort: AbortController
  /** The docker exec that removes an export's folder failed once: said once. */
  dropSaid: boolean
  /** Exports in the class's containers of epochs let go before they were read: their folders go, one at a time (drive). */
  unread: Array<{ container: string; dir: string }>
}

/** An attempt whose files home asked for (RemoteKernelsReply.collect). */
interface Collection {
  readonly sessionId: string
  readonly runId: string
  readonly files: ReadonlyArray<{ name: string; sha256: string; bytes: number }>
  /** What became of each file, by name, for good: sent, or never to be (gone, changed, refused, past a cap). The others are tried again. */
  readonly outcomes: Map<string, 'sent' | 'left'>
  /** Rounds in a row that ended with home out of reach, and when the next is due. */
  tries: number
  notBefore: number
  /** Its files sent (or left) and its folder gone; null — not yet. */
  doneAt: number | null
  /** The sync that said it over was answered; home naming it again says it again. */
  said: boolean
  task: Promise<void> | null
  abort: AbortController
}

/** A file of an export read here, on its way home (RemoteEpochIntent.ship). */
interface Ship {
  readonly sessionId: string
  readonly sha: string
  bytes: number
  /** The container the export came from: its placement's gen is the PUT's. */
  container: string
  /** Named by the last reply; one no longer named is not sent. */
  wanted: boolean
  doneAt: number | null
  notBefore: number
  tries: number
  task: Promise<void> | null
  abort: AbortController
}

const epochKey = (root: string, seq: number): string => `${root}\u0000${seq}`
const pairKey = (a: string, b: string): string => `${a}\u0000${b}`
/** An epoch that cannot be had here and is not tried again (`disk` is, after a wait). */
const gaveUp = (epoch: Epoch): boolean => epoch.failed === 'source' || epoch.failed === 'files'

/** An empty block of home's, for checking what is written down with the agent's own parser (state.ts · placementOf does the same). */
const QUIET_BLOCK = { placements: [], pushes: [], verdicts: [], pulls: [], scan: [], collect: [], postmortem: [], rates: { classBulkMBps: 8, machinePaceMBps: 6 }, tunnel: 'closed' }

/* -------------------------------------------------------------------- host */

export class CouncilHost {
  private readonly options: CouncilHostOptions
  private readonly layout: StateLayout
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly timings: CouncilTimings
  private readonly pacer: Pacer
  private readonly classes = new Map<string, Klass>()
  private readonly collections = new Map<string, Collection>()
  private readonly ships = new Map<string, Ship>()
  /** Scratch entries no collection names, by class then by name: when this life first saw each. */
  private readonly strays = new Map<string, Map<string, number>>()
  /** The classes home's last reply names here, any slot of theirs. */
  private named = new Set<string>()
  private rates: RemoteKernelsReply['rates'] = { classBulkMBps: CLASS_BULK_IDLE_MBPS, machinePaceMBps: MACHINE_PACE_MBPS }
  /** What the epochs held name, for the CAS's pins; null — to count again. */
  private pins: Set<string> | null = null
  /** Home has spoken of classes in this life: a class it does not name, and nothing of which runs here, goes. */
  private activated = false
  /** Everything is being removed (clear), until a reply speaks of classes again. */
  private cleared = false
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private scratchLookedAt = 0
  /** When the helper last listed each class's scratch space for the sweep; and the classes whose space it is emptying, the class gone. */
  private readonly helperLookedAt = new Map<string, number>()
  private readonly helperGoing = new Set<string>()
  /** The helper's runs under way, for idle(). */
  private readonly helperWork = new Set<Promise<void>>()
  private readonly logged = new Set<string>()

  constructor(options: CouncilHostOptions) {
    this.options = options
    this.layout = options.layout
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? pause
    this.timings = { ...COUNCIL_TIMINGS, ...options.timings }
    this.pacer = options.pacer ?? new Pacer(this.now, CLASS_PACE_BURST_BYTES)
  }

  /* ----------------------------------------------------------- the agent's */

  /**
   * At the agent's start, after the CAS loaded: the epochs an earlier life
   * held, each as written down and checked with the agent's own parser, its
   * files in the class's epochs folder those links that are the CAS's own
   * blob (the same inode) — linked again from the CAS where a link is missing
   * or is not its blob, gone where the CAS has none — and the stagings an
   * earlier life left, gone. Held until home's first block says whose they
   * are; pinned meanwhile.
   */
  load(): void {
    let names: string[] = []
    try {
      names = fs.readdirSync(councilRoot(this.layout))
    } catch {
      return
    }
    for (const name of names) {
      if (!REMOTE_SESSION_ID.test(name)) continue
      const dir = councilDir(this.layout, name)
      try {
        if (!fs.lstatSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      removeTree(stagingDir(dir))
      const klass = this.open(name)
      const records = readJson(recordFile(dir), 64 * MIB) as { v?: unknown; epochs?: unknown } | null
      for (const record of Array.isArray(records?.epochs) && records?.v === 1 ? (records.epochs as unknown[]) : []) {
        const epoch = this.fromRecord(name, record)
        if (epoch) klass.epochs.set(epochKey(epoch.root, epoch.seq), epoch)
      }
      this.relink(klass)
    }
    this.pins = null
  }

  /**
   * A reply's block: the classes it names here, the epochs not yet ready (and
   * what of an export to send home), the attempts whose files to collect.
   * Work starts at once: a dispatch at home waits five seconds at most for a
   * refreeze (D8).
   */
  reconcile(kernels: RemoteKernelsReply): void {
    if (this.stopped) return
    this.cleared = false
    this.activated = true
    this.rates = kernels.rates
    const named = new Set<string>()
    for (const intent of kernels.placements) {
      const slot = parseRemotePlacementKey(intent.key)
      if (slot) named.add(slot.sessionId)
    }
    this.named = named
    for (const sessionId of named) {
      // A class a sweep let go while its work ran, named here again: its work starts again (drive starts none under a pulled signal).
      const klass = this.classes.get(sessionId)
      if (klass?.abort.signal.aborted) klass.abort = new AbortController()
    }
    for (const ship of this.ships.values()) ship.wanted = false
    for (const intent of kernels.epochs) this.intend(intent)
    for (const [key, ship] of [...this.ships]) {
      if (ship.wanted) continue
      // Home no longer asks for it: what is under way stops, and nothing more of it goes.
      ship.abort.abort()
      if (ship.task === null) this.ships.delete(key)
    }
    for (const entry of kernels.collect) {
      const key = pairKey(entry.sessionId, entry.runId)
      const known = this.collections.get(key)
      if (known) {
        // Over already: home did not hear it, or its reply crossed the sync that said it. Said again, never done again.
        if (known.doneAt !== null) known.said = false
        continue
      }
      this.collections.set(key, {
        sessionId: entry.sessionId, runId: entry.runId, files: entry.files.map((file) => ({ ...file })), outcomes: new Map(), tries: 0, notBefore: 0,
        doneAt: null, said: false, task: null, abort: new AbortController(),
      })
    }
    for (const klass of this.classes.values()) this.retain(klass)
    this.sweepClasses()
    this.ensureTicking()
    for (const klass of this.classes.values()) this.drive(klass)
    this.pump()
  }

  /**
   * The epochs a sync says (§15): every one held or on its way, whole or with
   * the hashes still missing (within COUNCIL_EPOCH_BUFFERS_MAX for the sync),
   * and why one cannot be had — said of an epoch home named in this life
   * only, so that a home without the word never meets it. The newest of each
   * class first, REMOTE_EPOCHS_MAX in all.
   */
  epochsNow(): RemoteEpochState[] {
    const states: RemoteEpochState[] = []
    let budget = COUNCIL_EPOCH_BUFFERS_MAX
    for (const klass of this.classes.values()) {
      for (const epoch of [...klass.epochs.values()].sort((a, b) => b.seq - a.seq)) {
        if (states.length >= REMOTE_EPOCHS_MAX) return states
        const ready = epoch.readyAt !== null
        const state: RemoteEpochState = { sessionId: epoch.sessionId, root: epoch.root, seq: epoch.seq, ready }
        if (!ready) {
          const missing = [...epoch.files.keys()].filter((sha) => !epoch.present.has(sha)).slice(0, budget)
          budget -= missing.length
          if (missing.length > 0) state.missing = missing
          if (epoch.failed !== null && epoch.named) state.failed = epoch.failed
        }
        states.push(state)
      }
    }
    return states
  }

  /** The attempts whose collection is over and not yet said in a sync home answered, REMOTE_COLLECTED_MAX at most. */
  collectedNow(): Array<{ sessionId: string; runId: string }> {
    const over: Array<{ sessionId: string; runId: string }> = []
    for (const collection of this.collections.values()) {
      if (over.length >= REMOTE_COLLECTED_MAX) break
      if (collection.doneAt !== null && !collection.said) over.push({ sessionId: collection.sessionId, runId: collection.runId })
    }
    return over
  }

  /**
   * Home took in a sync that carried this block (answered, or cut short by
   * the agent after home read it on arrival): the collections it said over
   * are said. One whose sync was lost is said again when home names it again.
   */
  said(kernels: Pick<RemoteKernelsRequest, 'collected'>): void {
    for (const entry of kernels.collected ?? []) {
      const collection = this.collections.get(pairKey(entry.sessionId, entry.runId))
      if (collection && collection.doneAt !== null) collection.said = true
    }
  }

  /** Every blob the epochs held name, and those on their way home: the CAS keeps them (Cache · pinned). */
  pinned(): ReadonlySet<string> {
    if (this.pins) return this.pins
    const pins = new Set<string>()
    for (const klass of this.classes.values()) for (const epoch of klass.epochs.values()) for (const sha of epoch.files.keys()) pins.add(sha)
    for (const ship of this.ships.values()) if (ship.task !== null) pins.add(ship.sha)
    this.pins = pins
    return pins
  }

  /** One beat: retries due, older epochs let go, uploads, strays of the scratch folders, classes no longer here. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped || this.cleared || !this.activated) return
    this.ticking = true
    try {
      const now = this.now()
      for (const klass of this.classes.values()) {
        this.retain(klass)
        this.drive(klass)
      }
      this.sweepClasses()
      if (now - this.scratchLookedAt >= SCRATCH_LOOK_MS) {
        this.scratchLookedAt = now
        this.sweepScratch()
      }
      for (const [key, collection] of this.collections) {
        if (collection.doneAt !== null && collection.said && now - collection.doneAt >= this.timings.repeatMs) this.collections.delete(key)
      }
      for (const [key, ship] of this.ships) if (!ship.wanted && ship.task === null) this.ships.delete(key)
      this.pump()
    } finally {
      this.ticking = false
    }
  }

  /** Settled once nothing is under way: no epoch's work, no upload, no collection. */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [
        ...[...this.classes.values()].map((klass) => klass.work),
        ...[...this.collections.values()].map((collection) => collection.task),
        ...[...this.ships.values()].map((ship) => ship.task),
        ...this.helperWork,
      ].filter((task): task is Promise<void> => task !== null)
      if (busy.length === 0) return
      await Promise.allSettled(busy)
    }
  }

  /**
   * Everything let go before the folders go (a revocation, a leave, a move to
   * another home: kernels.ts · removeAll removes them): what is under way
   * stops and ends, and nothing is written until a reply of a new identity
   * speaks of classes.
   */
  async clear(): Promise<void> {
    this.cleared = true
    for (const klass of this.classes.values()) klass.abort.abort()
    for (const collection of this.collections.values()) collection.abort.abort()
    for (const ship of this.ships.values()) ship.abort.abort()
    await this.idle()
    this.classes.clear()
    this.collections.clear()
    this.ships.clear()
    this.named = new Set()
    this.pins = null
  }

  /** The agent stops: the timer goes and what is under way ends; the epochs and their records stay for the next life. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const klass of this.classes.values()) klass.abort.abort()
    for (const collection of this.collections.values()) collection.abort.abort()
    for (const ship of this.ships.values()) ship.abort.abort()
  }

  /* -------------------------------------------------------------- epochs */

  /** Home's word on one epoch: held from now on (new), or its latest intent (known), and what of it to send home. */
  private intend(intent: RemoteEpochIntent): void {
    const klass = this.classes.get(intent.sessionId) ?? this.open(intent.sessionId)
    const key = epochKey(intent.root, intent.seq)
    let epoch = klass.epochs.get(key)
    if (!epoch) {
      // A notebook's epoch older than one already ready here is no epoch to fetch: the pool loads the newer one.
      const newer = [...klass.epochs.values()].some((other) => other.root === intent.root && other.seq > intent.seq && other.readyAt !== null)
      if (newer) return
      const files = new Map<string, number>([[intent.manifest.sha256, intent.manifest.bytes], ...intent.buffers.map((buffer) => [buffer.sha256, buffer.bytes] as [string, number])])
      epoch = {
        sessionId: intent.sessionId, root: intent.root, seq: intent.seq, intent, files, present: new Set(), readyAt: null, failed: null,
        read: intent.from === 'home', tries: 0, retryAt: 0, leaveAt: null, named: true, feeding: false,
      }
      klass.epochs.set(key, epoch)
      for (const sha of files.keys()) if (this.inFolder(klass, sha)) epoch.present.add(sha)
      this.pins = null
      this.persist(klass)
    } else {
      epoch.intent = intent
      epoch.named = true
      // A disk with no room may have some now: home still asks, and the next try is at once.
      if (epoch.failed === 'disk') epoch.retryAt = 0
    }
    if (intent.from !== 'home' && intent.ship) {
      const now = this.now()
      for (const sha of intent.ship) {
        const ship = this.ships.get(pairKey(intent.sessionId, sha)) ?? { sessionId: intent.sessionId, sha, bytes: epoch.files.get(sha) ?? 0, container: intent.from.container, wanted: false, doneAt: null, notBefore: 0, tries: 0, task: null, abort: new AbortController() }
        ship.wanted = true
        ship.container = intent.from.container
        ship.bytes = epoch.files.get(sha) ?? ship.bytes
        // Sent (or refused) a while ago, and home still lacks it: its reply did not cross the PUT, so it goes again.
        if (ship.doneAt !== null && now - ship.doneAt >= this.timings.repeatMs) {
          ship.doneAt = null
          ship.tries = 0
          ship.notBefore = 0
        }
        if (ship.abort.signal.aborted && ship.task === null) ship.abort = new AbortController()
        this.ships.set(pairKey(intent.sessionId, sha), ship)
      }
    }
  }

  /**
   * Which epochs of a class stay (see the header): for each notebook its
   * newest ready one; the newest one newer than that which may still come;
   * those newer than it that cannot be had, FAILED_KEPT at most; an older one
   * whose export is being read, or holds files the coming one lacks
   * (`feeding`); and an older ready one until graceMs after the newer one was
   * ready.
   */
  private retain(klass: Klass): void {
    const now = this.now()
    const roots = new Map<string, Epoch[]>()
    for (const epoch of klass.epochs.values()) roots.set(epoch.root, [...(roots.get(epoch.root) ?? []), epoch])
    const dropped: Epoch[] = []
    for (const list of roots.values()) {
      list.sort((a, b) => b.seq - a.seq)
      const ready = list.find((epoch) => epoch.readyAt !== null) ?? null
      const newer = list.filter((epoch) => epoch.readyAt === null && (ready === null || epoch.seq > ready.seq))
      // One that failed never stands in for one that may still come: home wants the older one once it hears the newer failed.
      const coming = newer.find((epoch) => !gaveUp(epoch)) ?? null
      const kept = new Set([ready, coming, ...newer.filter(gaveUp).slice(0, FAILED_KEPT)])
      for (const epoch of list) {
        epoch.feeding = false
        if (kept.has(epoch)) continue
        if (ready !== null && epoch.seq < ready.seq && epoch.readyAt !== null) {
          epoch.leaveAt ??= ready.readyAt! + this.timings.graceMs
          if (now < epoch.leaveAt) continue
        }
        // Its export, read to the end once begun, and before the coming one when that one may need it.
        if ((klass.current === epoch && !epoch.read) || (coming !== null && this.feeds(epoch, coming))) {
          epoch.feeding = true
          continue
        }
        dropped.push(epoch)
      }
    }
    if (dropped.length > 0) this.drop(klass, dropped)
  }

  /**
   * Whether an older epoch's export, not read yet, may hold files a newer one
   * lacks: an export from the same kernel's container (another container is
   * another kernel, whose export writes every file), and a file the newer one
   * names that the older names too, and that neither its folder nor the CAS
   * holds — the refreeze did not write it again, so that export is where it is.
   */
  private feeds(older: Epoch, newer: Epoch): boolean {
    const [from, to] = [older.intent.from, newer.intent.from]
    if (older.read || gaveUp(older) || older.seq > newer.seq || from === 'home' || to === 'home' || from.container !== to.container) return false
    for (const sha of newer.files.keys()) if (!newer.present.has(sha) && older.files.has(sha) && !this.options.cas.has(sha)) return true
    return false
  }

  /**
   * Epochs of a class let go: their files go from the class's folder unless
   * another epoch of it names them, and from the CAS unless any does; an
   * export of one not read yet, from the container it lies in (nothing will
   * read it now, and a refreeze writes the next beside it).
   */
  private drop(klass: Klass, epochs: readonly Epoch[]): void {
    for (const epoch of epochs) {
      klass.epochs.delete(epochKey(epoch.root, epoch.seq))
      if (klass.current === epoch) {
        klass.abort.abort()
        klass.abort = new AbortController()
      }
      if (!epoch.read && epoch.intent.from !== 'home') klass.unread.push(epoch.intent.from)
    }
    this.pins = null
    const kept = new Set<string>()
    for (const epoch of klass.epochs.values()) for (const sha of epoch.files.keys()) kept.add(sha)
    const pinned = this.pinned()
    for (const epoch of epochs) {
      for (const sha of epoch.files.keys()) {
        if (kept.has(sha)) continue
        fs.rmSync(path.join(epochsDir(klass.dir), sha), { force: true })
        if (!pinned.has(sha)) this.options.cas.release(sha)
      }
    }
    this.persist(klass)
  }

  /**
   * The next piece of an epoch's work for a class, one at a time: an older
   * export a newer epoch needs read first (the oldest of them), else the
   * newest of its epochs not whole, a failed one only once it is due. Every
   * piece ends ready, failed, read, or with its next try set later, so that
   * this never spins; a class being let go (its signal pulled) starts none.
   */
  private drive(klass: Klass): void {
    if (klass.work || this.stopped || this.cleared || klass.abort.signal.aborted) return
    if (klass.unread.length > 0) {
      klass.work = this.dropUnread(klass)
        .catch((error: unknown) => this.options.log(`[runner] the council of class ${klass.sessionId}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
        .finally(() => {
          klass.work = null
          this.drive(klass)
        })
      return
    }
    const now = this.now()
    const due = [...klass.epochs.values()]
      .filter((epoch) => epoch.readyAt === null && !gaveUp(epoch) && epoch.retryAt <= now && !(epoch.feeding && epoch.read))
      .sort((a, b) => b.seq - a.seq)
    const next = due.filter((epoch) => epoch.feeding).pop() ?? due[0]
    if (!next) return
    klass.current = next
    const signal = klass.abort.signal
    klass.work = this.advance(klass, next, signal)
      .catch((error: unknown) => {
        this.options.log(`[runner] the council of class ${klass.sessionId}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        if (klass.epochs.get(epochKey(next.root, next.seq)) === next) this.later(klass, next, null, 'its work failed')
      })
      .finally(() => {
        klass.work = null
        klass.current = null
        this.drive(klass)
      })
  }

  /**
   * One epoch as far as it goes now (see the header): what the CAS holds
   * linked into the class's folder; the export read, when it lies here; the
   * rest from home, one file at a time; ready once all of it is there.
   */
  private async advance(klass: Klass, epoch: Epoch, signal: AbortSignal): Promise<void> {
    // A disk that had no room is asked again: what it says now is what the next sync says.
    if (epoch.failed === 'disk') epoch.failed = null
    for (const sha of epoch.files.keys()) if (!epoch.present.has(sha) && this.options.cas.has(sha)) this.link(klass, sha)
    if (this.whole(epoch)) return this.ready(klass, epoch)
    if (!epoch.read) {
      const read = await this.readExport(klass, epoch, signal)
      if (!read || signal.aborted) return
      if (this.whole(epoch)) return this.ready(klass, epoch)
      // Read for a newer one: home no longer names this one, and serves none of its files.
      if (epoch.feeding) return
    }
    const missing = [...epoch.files].filter(([sha]) => !epoch.present.has(sha))
    // The manifest first, then the smaller files: a worker's load needs every one of them, and the small ones say progress soonest.
    missing.sort(([a, x], [b, y]) => Number(b === epoch.intent.manifest.sha256) - Number(a === epoch.intent.manifest.sha256) || x - y)
    for (const [sha, bytes] of missing) {
      if (signal.aborted) return
      try {
        await this.options.cas.blob(sha, bytes, { signal, pace: () => this.rates.classBulkMBps * MIB, urgent: () => false })
      } catch (error) {
        if (signal.aborted) return
        const kind = error instanceof CacheError ? error.kind : 'transient'
        const said = error instanceof Error ? error.message : String(error)
        if (kind === 'unauthorized') this.options.onUnauthorized?.()
        // A file an export read here did not hold, which home does not have either: the epoch cannot be had (home exports anew, or the council stays shared).
        if ((kind === 'unscoped' || kind === 'gone') && epoch.intent.from !== 'home') return this.fail(klass, epoch, 'files', `${sha.slice(0, 12)} was neither in the export nor at home (${said})`)
        return this.later(klass, epoch, kind === 'disk' ? 'disk' : null, `${sha.slice(0, 12)} from home: ${said}`)
      }
      this.link(klass, sha)
    }
    if (this.whole(epoch)) this.ready(klass, epoch)
    else if (!signal.aborted) this.later(klass, epoch, null, 'a file could not be put in its epochs folder')
  }

  /**
   * An export on this machine (§9.2 «Where the files go»), read: from the
   * container of a placement of the same class the machine holds, never
   * another's, copied whole into the agent's own staging (a folder there, or
   * no export at all), each file in it taken by its content — a regular file
   * of a length the epoch still lacks, hashed, and taken into the CAS when
   * its hash is one of the epoch's — then the staging removed and the folder
   * removed from the container. Whether it was read (false: the epoch failed,
   * or waits for a retry).
   */
  private async readExport(klass: Klass, epoch: Epoch, signal: AbortSignal): Promise<boolean> {
    const from = epoch.intent.from as { container: string; dir: string }
    const holder = this.options.containerOf(from.container)
    if (!holder || holder.sessionId !== epoch.sessionId || holder.role === 'council') {
      this.fail(klass, epoch, 'source', `its export lies in container ${from.container.slice(0, 12)}, which is no notebook kernel of the class on this machine`)
      return false
    }
    const need = new Map<number, Set<string>>()
    let needBytes = 0
    for (const [sha, bytes] of epoch.files) {
      if (epoch.present.has(sha)) continue
      need.set(bytes, (need.get(bytes) ?? new Set()).add(sha))
      needBytes += bytes
    }
    if (need.size > 0) {
      const free = this.options.diskFreeMb()
      if (free !== null && free - Math.ceil(needBytes / MIB) < this.options.diskFloorMb) {
        this.options.onDiskLow?.()
        this.later(klass, epoch, 'disk', `its export of ${Math.ceil(needBytes / MIB)} MB leaves less than the ${this.options.diskFloorMb} MB floor of free disk (${free} MB)`)
        return false
      }
      fs.mkdirSync(stagingDir(klass.dir), { recursive: true, mode: 0o700 })
      // A name that is not there yet: docker makes it a copy of the folder, whichever form of `cp` it takes the source in.
      const staging = path.join(stagingDir(klass.dir), `epoch-${epoch.seq}-${randomBytes(4).toString('hex')}`)
      try {
        const copied = await this.options.docker(['cp', `${from.container}:${from.dir}`, staging], { timeoutMs: this.timings.copyMs, signal })
        if (signal.aborted) return false
        if (copied.code !== 0) {
          if (dockerMissing(copied) || /could not find the file|no such file or directory/i.test(copied.out)) {
            this.fail(klass, epoch, 'source', `docker cp of its export: ${dockerWords(copied)}`)
          } else if (epoch.tries + 1 >= COPY_TRIES) {
            this.fail(klass, epoch, 'source', `docker cp of its export failed ${COPY_TRIES} times: ${dockerWords(copied)}`)
          } else {
            this.later(klass, epoch, null, `docker cp of its export: ${dockerWords(copied)}`)
          }
          return false
        }
        // What docker made of it must be a folder: a link there (docker copies one as a link) would lead every read below out of the staging.
        if (!fs.lstatSync(staging, { throwIfNoEntry: false })?.isDirectory()) {
          this.fail(klass, epoch, 'source', `its export ${from.dir} in container ${from.container.slice(0, 12)} is no folder`)
          return false
        }
        await this.takeExport(klass, epoch, staging, need, signal)
        if (signal.aborted) return false
      } finally {
        const stayed = removeTree(staging)
        if (stayed > 0) this.options.log(`[runner] the council of class ${klass.sessionId}: ${stayed} entr(ies) of an export's staging would not go`)
      }
    }
    await this.dropExport(klass, from)
    epoch.read = true
    this.persist(klass)
    return true
  }

  /** The files of a copied export the epoch lacks, by length then by hash, into the CAS and the class's folder; the rest stay in the staging, which goes. */
  private async takeExport(klass: Klass, epoch: Epoch, staging: string, need: Map<number, Set<string>>, signal: AbortSignal): Promise<void> {
    let names: string[]
    try {
      names = fs.readdirSync(staging).sort()
    } catch {
      return
    }
    let looked = 0
    const most = epoch.files.size + EXPORT_SLACK
    for (const name of names) {
      if (signal.aborted || looked >= most) return
      const file = path.join(staging, name)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(file)
      } catch {
        continue
      }
      const wanted = stat.isFile() ? need.get(stat.size) : undefined
      if (!wanted || wanted.size === 0) continue
      looked++
      const sha = await hashFile(file, signal)
      if (sha === null || !wanted.has(sha)) continue
      try {
        this.options.cas.adopt(file, sha)
      } catch (error) {
        this.options.log(`[runner] the council of class ${klass.sessionId}: ${sha.slice(0, 12)} of an export could not be kept: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      wanted.delete(sha)
      this.link(klass, sha)
    }
  }

  /** The exports of epochs let go unread (drop), each removed from its container while that is still a container of the class here. */
  private async dropUnread(klass: Klass): Promise<void> {
    for (let from = klass.unread.shift(); from; from = klass.unread.shift()) {
      if (this.stopped || this.cleared) return
      const holder = this.options.containerOf(from.container)
      if (holder?.sessionId !== klass.sessionId || holder.role === 'council') continue
      await this.dropExport(klass, from)
    }
  }

  /** The export's folder gone from its container, read or not needed: the notebook's kernel writes the next one beside it. */
  private async dropExport(klass: Klass, from: { container: string; dir: string }): Promise<void> {
    const gone = await this.options.docker(['exec', from.container, 'rm', '-rf', '--', from.dir], { timeoutMs: 60_000 })
    if (gone.code === 0 || dockerMissing(gone) || klass.dropSaid) return
    klass.dropSaid = true
    this.options.log(`[runner] the council of class ${klass.sessionId}: an export's folder could not be removed from its container (${dockerWords(gone)}); it goes with the container`)
  }

  /** A file of the CAS into the class's epochs folder, for every epoch of the class that names it. */
  private link(klass: Klass, sha: string): void {
    const to = path.join(epochsDir(klass.dir), sha)
    try {
      fs.mkdirSync(epochsDir(klass.dir), { recursive: true, mode: 0o755 })
      this.options.cas.place(sha, to)
    } catch (error) {
      this.options.log(`[runner] the council of class ${klass.sessionId}: ${sha.slice(0, 12)} could not be put in its epochs folder: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const epoch of klass.epochs.values()) if (epoch.files.has(sha)) epoch.present.add(sha)
  }

  /** Whether the class's epochs folder holds the CAS's own blob of this hash (the same inode): a link this machine made. */
  private inFolder(klass: Klass, sha: string): boolean {
    if (!this.options.cas.has(sha)) return false
    try {
      const link = fs.lstatSync(path.join(epochsDir(klass.dir), sha))
      const blob = fs.lstatSync(this.options.cas.path(sha))
      return link.isFile() && sameStat(link, blob)
    } catch {
      return false
    }
  }

  /** At load: each epoch's files that are the CAS's own links stay, the rest are linked again from the CAS or go; and what no epoch names goes. */
  private relink(klass: Klass): void {
    const named = new Set<string>()
    for (const epoch of klass.epochs.values()) for (const sha of epoch.files.keys()) named.add(sha)
    let entries: string[] = []
    try {
      entries = fs.readdirSync(epochsDir(klass.dir))
    } catch { /* none yet */ }
    for (const entry of entries) if (!named.has(entry)) fs.rmSync(path.join(epochsDir(klass.dir), entry), { recursive: true, force: true })
    for (const sha of named) {
      if (this.inFolder(klass, sha)) {
        for (const epoch of klass.epochs.values()) if (epoch.files.has(sha)) epoch.present.add(sha)
        continue
      }
      fs.rmSync(path.join(epochsDir(klass.dir), sha), { recursive: true, force: true })
      if (this.options.cas.has(sha)) this.link(klass, sha)
    }
    for (const epoch of klass.epochs.values()) {
      // Whole as written down, and still whole: ready. A ready one that lost a file is on its way again.
      if (!this.whole(epoch)) epoch.readyAt = null
    }
  }

  private whole(epoch: Epoch): boolean {
    for (const sha of epoch.files.keys()) if (!epoch.present.has(sha)) return false
    return true
  }

  private ready(klass: Klass, epoch: Epoch): void {
    epoch.readyAt = this.now()
    epoch.failed = null
    epoch.tries = 0
    epoch.read = true
    this.persist(klass)
    this.retain(klass)
    this.options.log(`[runner] the council of class ${klass.sessionId}: epoch ${epoch.seq} of ${epoch.root === 'cells' ? 'the class notebook' : 'a notebook'} is ready (${epoch.files.size} file(s))`)
    this.options.onChange(true)
    this.pump()
  }

  /** An epoch that cannot be had (RemoteEpochFailure): said so, and not tried again — but `disk`, after a wait. */
  private fail(klass: Klass, epoch: Epoch, why: RemoteEpochFailure, detail: string): void {
    const changed = epoch.failed !== why
    epoch.failed = why
    if (why === 'disk') {
      epoch.tries++
      epoch.retryAt = this.now() + this.backoff(epoch.tries)
    }
    this.persist(klass)
    if (changed) {
      this.options.log(`[runner] the council of class ${klass.sessionId}: epoch ${epoch.seq} cannot be had here (${why}): ${detail}`)
      this.options.onChange(true)
    }
  }

  /** A step that failed now and may not later: tried again after a wait that doubles, `disk` said meanwhile. */
  private later(klass: Klass, epoch: Epoch, why: 'disk' | null, detail: string): void {
    if (why === 'disk') return this.fail(klass, epoch, 'disk', detail)
    epoch.tries++
    epoch.retryAt = this.now() + this.backoff(epoch.tries)
    const said = `${klass.sessionId} ${epoch.seq} ${detail}`
    if (!this.logged.has(said)) {
      this.logged.add(said)
      this.options.log(`[runner] the council of class ${klass.sessionId}: epoch ${epoch.seq} waits (${detail}); tried again in ${Math.round((epoch.retryAt - this.now()) / 1000)} s`)
    }
  }

  /** A line for the log once per what it says (the `logged` set): a helper failing at every look would fill it. */
  private say(key: string, line: string): void {
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.options.log(line)
  }

  private backoff(tries: number): number {
    const wait = new Backoff(this.options.random ?? Math.random, this.timings.retryMs.first, this.timings.retryMs.last)
    let ms = 0
    for (let i = 0; i < Math.min(tries, 30); i++) ms = wait.next()
    return ms
  }

  /* ------------------------------------------------------------- classes */

  private open(sessionId: string): Klass {
    const klass: Klass = { sessionId, dir: councilDir(this.layout, sessionId), epochs: new Map(), work: null, current: null, abort: new AbortController(), dropSaid: false, unread: [] }
    this.classes.set(sessionId, klass)
    return klass
  }

  /**
   * A class home names nowhere on this machine, nothing of which runs here
   * any more: its epochs, its collections and its folder go. Not before home
   * has spoken in this life (an earlier life's classes wait for its word),
   * and never while a container of the class is held (its council's mounts
   * would go from under it).
   */
  private sweepClasses(): void {
    if (!this.activated || this.cleared) return
    let names: string[] = []
    try {
      names = fs.readdirSync(councilRoot(this.layout))
    } catch { /* none */ }
    const ids = new Set([...this.classes.keys(), ...names.filter((name) => REMOTE_SESSION_ID.test(name))])
    for (const sessionId of ids) {
      if (this.named.has(sessionId) || this.options.held(sessionId).length > 0) continue
      const klass = this.classes.get(sessionId)
      if (klass) {
        klass.abort.abort()
        if (klass.work) continue
        this.drop(klass, [...klass.epochs.values()])
        this.classes.delete(sessionId)
      }
      for (const [key, collection] of [...this.collections]) {
        if (collection.sessionId !== sessionId) continue
        collection.abort.abort()
        if (collection.task === null && collection.doneAt === null) this.collections.delete(key)
      }
      for (const ship of this.ships.values()) if (ship.sessionId === sessionId) ship.abort.abort()
      const dir = councilDir(this.layout, sessionId)
      if (!fs.existsSync(dir) || this.helperGoing.has(sessionId)) continue
      const emptied = fs.existsSync(scratchDir(dir)) ? emptyScratch(scratchDir(dir)) : 0
      if (emptied === null) {
        // Root's: the helper empties it, and the folder goes after.
        this.helped(this.removeHelped(sessionId, dir))
        continue
      }
      const stayed = emptied + removeTree(dir)
      this.options.log(`[runner] the council of class ${sessionId}: home no longer names the class here; its epochs and scratch space are removed${stayed > 0 ? ` (${stayed} entr(ies) would not go)` : ''}`)
      this.pins = null
    }
  }

  /** A run of the helper, kept until it settles: idle() waits for it, and its throw is never the beat's. */
  private helped(work: Promise<void>): void {
    const settled = work.catch((error: unknown) => {
      this.options.log(`[runner] the council's scratch helper failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => this.helperWork.delete(settled))
    this.helperWork.add(settled)
  }

  /** A gone class's council folder whose scratch space is root's: emptied by the helper, then the rest the agent's own. */
  private async removeHelped(sessionId: string, dir: string): Promise<void> {
    this.helperGoing.add(sessionId)
    try {
      const done = this.options.scratch ? await this.options.scratch(sessionId, 'remove') : { ok: false as const, why: 'no helper' }
      if (!done.ok) {
        this.say(`scratch-remove:${sessionId}`, `[runner] the council of class ${sessionId}: its scratch space would not go (${done.why}); tried again at the next look`)
        return
      }
      const stayed = removeTree(dir)
      this.options.log(`[runner] the council of class ${sessionId}: home no longer names the class here; its epochs and scratch space are removed${stayed > 0 ? ` (${stayed} entr(ies) would not go)` : ''}`)
      this.pins = null
    } finally {
      this.helperGoing.delete(sessionId)
    }
  }

  /**
   * Scratch folders no collection names, gone scratchKeepMs after this life
   * first saw them: an attempt whose files home never asked for, or whose
   * worker died under it. Every class's council folder here is looked at,
   * whether it holds an epoch or not.
   */
  private sweepScratch(): void {
    const now = this.now()
    let ids: string[] = []
    try {
      ids = fs.readdirSync(councilRoot(this.layout)).filter((name) => REMOTE_SESSION_ID.test(name))
    } catch { /* none */ }
    for (const sessionId of [...this.strays.keys()]) if (!ids.includes(sessionId)) this.strays.delete(sessionId)
    for (const sessionId of ids) {
      const scratch = scratchDir(councilDir(this.layout, sessionId))
      if (!fs.existsSync(scratch)) continue
      let names: string[]
      try {
        names = fs.readdirSync(scratch)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // Root's, as the helper makes it: listed by the helper now and then, while a council container of the class holds it.
        if ((code === 'EACCES' || code === 'EPERM') && this.options.scratch) this.helped(this.sweepHelped(sessionId, scratch))
        continue
      }
      this.sweepNames(sessionId, scratch, names)
    }
  }

  /** The sweep of a scratch space the agent cannot list: the helper names its entries, at most every SCRATCH_HELPER_LOOK_MS. */
  private async sweepHelped(sessionId: string, scratch: string): Promise<void> {
    const now = this.now()
    if (now - (this.helperLookedAt.get(sessionId) ?? -Infinity) < SCRATCH_HELPER_LOOK_MS) return
    // No container of its council here: nothing writes there, and the next one's start empties it (kernels.ts · councilScratch).
    if (!this.options.held(sessionId).some((held) => held.role === 'council')) return
    this.helperLookedAt.set(sessionId, now)
    const listed = await this.options.scratch!(sessionId, 'list')
    if (!listed.ok) {
      this.say(`scratch-list:${sessionId}`, `[runner] the council of class ${sessionId}: its scratch space could not be looked at (${listed.why})`)
      return
    }
    this.sweepNames(sessionId, scratch, scratchHelperNames(listed.out))
  }

  /** Strays of one scratch space by their names: first seen by this life, gone scratchKeepMs after, unless a collection names one. */
  private sweepNames(sessionId: string, scratch: string, names: readonly string[]): void {
    const now = this.now()
    const strays = this.strays.get(sessionId) ?? new Map<string, number>()
    this.strays.set(sessionId, strays)
    const asked = new Set([...this.collections.values()].filter((collection) => collection.sessionId === sessionId && collection.doneAt === null).map((collection) => collection.runId))
    for (const seen of [...strays.keys()]) if (!names.includes(seen)) strays.delete(seen)
    for (const name of names) {
      if (asked.has(name)) continue
      const first = strays.get(name) ?? now
      strays.set(name, first)
      if (now - first < this.timings.scratchKeepMs) continue
      if (removeEntry(scratch, name)) strays.delete(name)
      else this.options.log(`[runner] the council of class ${sessionId}: an old scratch folder would not go (${name})`)
    }
  }

  /* ------------------------------------------------------------- uploads */

  /**
   * The uploads due: one attempt's files at a time, and one file of an
   * export at a time beside them, through the bucket the class folders'
   * uploads go through too (CouncilHostOptions.pacer): together they keep to
   * the class's rate. An attempt's files are small and its card waits on
   * them; a buffer of an export may be gigabytes, and does not hold them up.
   */
  private pump(): void {
    if (this.stopped || this.cleared) return
    if (![...this.collections.values()].some((collection) => collection.task !== null)) {
      const now = this.now()
      const next = [...this.collections.values()].find((collection) => collection.doneAt === null && collection.task === null && collection.notBefore <= now && !collection.abort.signal.aborted)
      if (next) {
        next.task = this.collect(next)
          .catch((error: unknown) => {
            this.options.log(`[runner] the council of class ${next.sessionId}: the files of attempt ${next.runId}: ${error instanceof Error ? error.message : String(error)}`)
            // A step of the agent's own failed (its staging, its disk): over, the folder left to the sweep of strays.
            if (next.doneAt === null && !next.abort.signal.aborted) this.over(next)
          })
          .finally(() => {
            next.task = null
            this.pump()
          })
      }
    }
    if (![...this.ships.values()].some((ship) => ship.task !== null)) {
      const now = this.now()
      const next = [...this.ships.values()].find((ship) => ship.wanted && ship.task === null && ship.doneAt === null && ship.notBefore <= now && this.options.cas.has(ship.sha))
      if (next) {
        next.task = this.send(next)
          .catch((error: unknown) => {
            this.options.log(`[runner] the council of class ${next.sessionId}: ${next.sha.slice(0, 12)} did not go home: ${error instanceof Error ? error.message : String(error)}`)
            next.doneAt = this.now()
          })
          .finally(() => {
            next.task = null
            this.pins = null
            if (!next.wanted) this.ships.delete(pairKey(next.sessionId, next.sha))
            this.pump()
          })
        this.pins = null
      }
    }
  }

  /**
   * An attempt's files home asked for (§9.7), one after another, then its
   * scratch folder gone and the collection said over. Each read through the
   * anchored filesystem from the class's scratch folder, and sent only as the
   * regular file of the length and hash home named, within the caps, from the
   * agent's own copy of it. No council placement of the class here, no
   * scratch folder, or a gen home fences: nothing more is sent, and the
   * folder goes all the same. Home out of reach: the round ends there, the
   * folder stays, and a later round sends what did not go yet.
   */
  private async collect(collection: Collection): Promise<void> {
    const signal = collection.abort.signal
    const dir = councilDir(this.layout, collection.sessionId)
    const scratch = scratchDir(dir)
    // The run's own folder, reached by its name: the scratch space is root's, which the agent cannot list, nor open to anchor.
    const folder = path.join(scratch, collection.runId)
    let found: fs.Stats | null = null
    try {
      found = fs.lstatSync(folder)
    } catch { /* never made, or gone */ }
    if (!found?.isDirectory()) {
      if (found) removeEntry(scratch, collection.runId)
      return this.over(collection)
    }
    const gen = this.options.held(collection.sessionId).find((held) => held.role === 'council')?.gen ?? null
    const afs = createAnchoredFilesystem(folder)
    try {
      let sent = 0
      let total = 0
      for (const file of gen === null ? [] : collection.files) {
        if (signal.aborted) return
        const known = collection.outcomes.get(file.name)
        if (known === 'sent') {
          sent++
          total += file.bytes
        }
        if (known !== undefined) continue
        if (sent >= COUNCIL_ARTIFACTS.files || total + file.bytes > COUNCIL_ARTIFACTS.totalBytes || file.bytes > COUNCIL_ARTIFACTS.fileBytes) continue
        const outcome = await this.artifact(collection, afs, path.join(folder, file.name), file, gen!, signal)
        if (signal.aborted) return
        if (outcome === 'stop') break
        if (outcome === 'later') {
          collection.tries++
          collection.notBefore = this.now() + this.backoff(collection.tries)
          return
        }
        collection.outcomes.set(file.name, outcome)
        if (outcome === 'sent') {
          sent++
          total += file.bytes
        }
      }
      if (signal.aborted) return
    } finally {
      afs.close()
    }
    if (!removeEntry(scratch, collection.runId)) this.options.log(`[runner] the council of class ${collection.sessionId}: the scratch folder of attempt ${collection.runId} would not go`)
    this.over(collection)
  }

  private over(collection: Collection): void {
    collection.doneAt = this.now()
    collection.said = false
    this.options.onChange(false)
  }

  /**
   * One file of an attempt home's way: copied to the agent's staging through
   * a descriptor that followed no link, hashed as it is copied, and sent if it
   * is what home named. `left` — never to go (gone, changed, refused);
   * `stop` — home will take nothing more of this collection (a fenced gen, a
   * revoked machine); `later` — home did not answer, UPLOAD_TRIES times.
   */
  private async artifact(collection: Collection, afs: ReturnType<typeof createAnchoredFilesystem>, at: string, file: { name: string; sha256: string; bytes: number }, gen: number, signal: AbortSignal): Promise<'sent' | 'left' | 'stop' | 'later'> {
    const staging = stagingDir(councilDir(this.layout, collection.sessionId))
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
    const copy = path.join(staging, `artifact-${randomBytes(6).toString('hex')}`)
    try {
      let fd: number
      try {
        fd = afs.openSync(at, 'r')
      } catch {
        return 'left'
      }
      try {
        const before = fs.fstatSync(fd)
        if (!before.isFile() || before.size !== file.bytes || before.size > COUNCIL_ARTIFACTS.fileBytes) return 'left'
        const out = fs.openSync(copy, 'wx', 0o600)
        const hash = createHash('sha256')
        let bytes = 0
        try {
          const buffer = Buffer.allocUnsafe(Math.min(MIB, Math.max(1, file.bytes)))
          for (;;) {
            if (signal.aborted) return 'left'
            const read = await readAt(fd, buffer)
            if (read === 0) break
            bytes += read
            if (bytes > file.bytes) return 'left'
            hash.update(buffer.subarray(0, read))
            fs.writeSync(out, buffer, 0, read)
          }
        } finally {
          fs.closeSync(out)
        }
        if (!sameStat(fs.fstatSync(fd), before) || bytes !== file.bytes || hash.digest('hex') !== file.sha256) return 'left'
      } finally {
        fs.closeSync(fd)
      }
      const door = remoteClassPaths.artifact(collection.sessionId, collection.runId, file.name, gen)
      for (let tries = 1; ; tries++) {
        const answer = await this.put(door, copy, file.sha256, file.bytes, true, signal)
        if (signal.aborted) return 'left'
        if (answer.kind === 'ok') return 'sent'
        if (answer.kind === 'refused') {
          if (answer.error === 'unauthorized') this.options.onUnauthorized?.()
          this.options.log(`[runner] the council of class ${collection.sessionId}: home refused ${file.name} of attempt ${collection.runId} (${answer.error}${answer.detail ? `: ${answer.detail}` : ''})`)
          return answer.error === 'unauthorized' || answer.error === 'revoked' ? 'stop' : 'left'
        }
        if (tries >= UPLOAD_TRIES) {
          this.options.log(`[runner] the council of class ${collection.sessionId}: ${file.name} of attempt ${collection.runId} did not go home (${answer.reason}); tried again later`)
          return 'later'
        }
        await this.sleep(this.backoff(tries) || this.timings.retryMs.first, signal)
      }
    } finally {
      fs.rmSync(copy, { force: true })
    }
  }

  /**
   * One file of an export read here, home's way (RemoteEpochIntent.ship):
   * raw, from the CAS, under the gen of the placement whose container the
   * export came from. Sent once — a refusal is home's word, and home asking
   * again is heard again only after repeatMs.
   */
  private async send(ship: Ship): Promise<void> {
    const signal = ship.abort.signal
    const holder = this.options.containerOf(ship.container)
    if (!holder || holder.sessionId !== ship.sessionId) {
      ship.doneAt = this.now()
      return
    }
    const answer = await this.put(remoteClassPaths.epoch(ship.sha, ship.sessionId, holder.gen), this.options.cas.path(ship.sha), ship.sha, ship.bytes, false, signal)
    if (signal.aborted) return
    if (answer.kind === 'ok') {
      ship.doneAt = this.now()
      return
    }
    if (answer.kind === 'refused') {
      if (answer.error === 'unauthorized') this.options.onUnauthorized?.()
      this.options.log(`[runner] the council of class ${ship.sessionId}: home refused ${ship.sha.slice(0, 12)} of an export (${answer.error}${answer.detail ? `: ${answer.detail}` : ''})`)
      ship.doneAt = this.now()
      return
    }
    ship.tries++
    if (ship.tries >= UPLOAD_TRIES) {
      this.options.log(`[runner] the council of class ${ship.sessionId}: ${ship.sha.slice(0, 12)} of an export did not go home (${answer.reason}); sent again when home asks`)
      ship.doneAt = this.now()
      return
    }
    ship.notBefore = this.now() + (this.backoff(ship.tries) || this.timings.retryMs.first)
  }

  /** One PUT of a file of the agent's own, paced at the class's rate, given up when no byte moves for uploadStallMs. */
  private async put(door: string, file: string, sha256: string, bytes: number, gzip: boolean, signal: AbortSignal): Promise<RoomUploadAnswer> {
    const stall = new AbortController()
    let timer = setTimeout(() => stall.abort(), this.timings.uploadStallMs)
    timer.unref?.()
    const moved = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => stall.abort(), this.timings.uploadStallMs)
      timer.unref?.()
    }
    const cut = AbortSignal.any([signal, stall.signal])
    const body = this.pacedBody(file, gzip, cut, moved)
    try {
      const answer = await this.options.upload({ door, sha256, bytes, gzip, body: body.stream, signal: cut })
      if (answer.kind === 'transient' && stall.signal.aborted && !signal.aborted) return { kind: 'transient', reason: `no byte moved for ${Math.round(this.timings.uploadStallMs / 1000)} s`, retryAfterMs: null }
      return answer
    } finally {
      clearTimeout(timer)
      body.close()
    }
  }

  /**
   * A file of the agent's own as a PUT's body, gzipped or as it is, paced
   * through a bucket of CLASS_PACE_BURST_BYTES at the class's rate. Its file
   * is let go as soon as `signal` gives up or `close` is called, whatever the
   * fetch made of the stream (room-files.ts · pacedGzip).
   */
  private pacedBody(file: string, gzip: boolean, signal: AbortSignal, moved: () => void): { stream: ReadableStream<Uint8Array>; close: () => void } {
    const source = fs.createReadStream(file, { highWaterMark: 64 * 1024 })
    const piped = gzip ? source.pipe(createGzip()) : source
    if (gzip) source.once('error', (error) => piped.destroy(error))
    const release = (): void => {
      source.destroy()
      piped.destroy()
    }
    signal.addEventListener('abort', release, { once: true })
    const close = (): void => {
      signal.removeEventListener('abort', release)
      release()
    }
    const iterator = piped[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled')
          const next = await iterator.next()
          if (next.done) {
            controller.close()
            return
          }
          const delay = this.pacer.delay(next.value.length, this.rates.classBulkMBps * MIB)
          if (delay > 0) await this.sleep(delay, signal)
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled')
          moved()
          controller.enqueue(new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength))
        } catch (error) {
          close()
          controller.error(error)
        }
      },
      cancel: close,
    })
    return { stream, close }
  }

  /* ------------------------------------------------------------- records */

  /** A class's epochs written down whole (0600): what a restart keeps pinned and linked. */
  private persist(klass: Klass): void {
    const epochs = [...klass.epochs.values()].map((epoch) => ({
      intent: { sessionId: epoch.sessionId, root: epoch.root, seq: epoch.seq, manifest: epoch.intent.manifest, buffers: epoch.intent.buffers, from: epoch.intent.from },
      readyAt: epoch.readyAt,
      failed: epoch.failed,
      read: epoch.read,
    }))
    try {
      if (epochs.length === 0 && !fs.existsSync(klass.dir)) return
      writeWhole(recordFile(klass.dir), JSON.stringify({ v: 1, epochs }), { mode: 0o600 })
    } catch (error) {
      this.options.log(`[runner] the council of class ${klass.sessionId}: its epochs could not be written down: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** An epoch as written down, checked by the agent's own parser of home's block; null — not one this code wrote. */
  private fromRecord(sessionId: string, value: unknown): Epoch | null {
    const v = value as { intent?: unknown; readyAt?: unknown; failed?: unknown; read?: unknown } | null
    if (!v || typeof v !== 'object') return null
    let intent: RemoteEpochIntent | undefined
    try {
      intent = parseRemoteKernelsReply({ ...QUIET_BLOCK, epochs: [v.intent] }).epochs[0]
    } catch {
      return null
    }
    if (!intent || intent.sessionId !== sessionId) return null
    const failed = v.failed === 'source' || v.failed === 'files' || v.failed === 'disk' ? v.failed : null
    const files = new Map<string, number>([[intent.manifest.sha256, intent.manifest.bytes], ...intent.buffers.map((buffer) => [buffer.sha256, buffer.bytes] as [string, number])])
    return {
      sessionId, root: intent.root, seq: intent.seq, intent, files, present: new Set(),
      readyAt: typeof v.readyAt === 'number' && Number.isSafeInteger(v.readyAt) ? v.readyAt : null,
      failed, read: v.read === true || intent.from === 'home', tries: 0, retryAt: 0, leaveAt: null, named: false, feeding: false,
    }
  }

  private ensureTicking(): void {
    if (this.timer || this.stopped || this.timings.beatMs <= 0) return
    this.timer = setInterval(() => void this.tick(), this.timings.beatMs)
    this.timer.unref?.()
  }
}

