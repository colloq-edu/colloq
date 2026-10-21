/**
 * The council's epochs at home («состояние для попыток»,
 * docs/architecture/remote-classes.md §9.2, §9.7): the registry of every
 * notebook's snapshots, this server's store of their files, what each
 * machine holds of them, the epoch part of every class machine's reply, the
 * two doors the files come home by (an export's, an attempt's), and the
 * attempts' files on their way here.
 *
 * AN EPOCH IS A MANIFEST AND FILES NAMED BY THEIR SHA256 (§9.3): the pickle
 * stream without its big buffers, and each out-of-band buffer of 64 KiB or
 * more. A buffer unchanged since the notebook's previous epoch keeps its
 * sha, and nothing of it is written, shipped or stored twice: what a machine
 * holds is a set of hashes (its CAS), what this server holds the same.
 *
 * WHERE THE FILES GO (§9.2). The notebook's kernel writes its export to
 * COUNCIL_EPOCH_DIR/<seq> inside its own container, which no personal kernel
 * and no attempt can reach. A kernel here: this server copies the folder out
 * (`docker cp`, EpochCollector), checks every file against the report's sha
 * and keeps it in its store, DATA_DIR/council-epochs/<id>/<sha256>; the
 * pool's machine fetches what it lacks by `GET blobs/<sha>` (BlobSource
 * `epoch`, served only to a machine this server named the epoch to). A
 * kernel on the pool's machine: nothing crosses the relay — the intent says
 * `from` that container, and the agent copies it itself. A kernel on another
 * machine: that machine is named the epoch with `ship`, the files this
 * server lacks, and sends each home by `PUT epochs/<sha256>?session=&gen=`
 * (the gen of the placement whose container holds the export), and the
 * pool's machine fetches them from here once all are here. The numbers are
 * the class's, one count across its notebooks (nextEpochSeq): their kernels
 * share containers, and so the folders the numbers name. An export on a
 * machine that no reply will name — one that cannot be the pool's, one too
 * big to ship, one a refreeze superseded unnamed (epochNamed) — is removed
 * by its own kernel (council-pool.ts · dropMachineExport): no agent reads
 * what home does not name.
 *
 * WHAT A MACHINE HOLDS IS WHAT ITS LAST SYNC SAID (RemoteKernelsRequest.
 * epochs: every epoch it holds or is fetching, one left out is gone), kept in
 * memory as heard.ts keeps a sync. A machine is named an epoch in every reply
 * until it reports it ready (or failed), and never again after: leaving one
 * out never asks for its removal.
 *
 * WHAT IS KEPT. The registry (db.ts · council_epochs) keeps, of each
 * notebook, the newest whatever its trouble (the console names it), the two
 * newest that could be the pool's, and the newest a machine holds whole — the
 * one the workers run while newer ones are on their way: two in the ordinary
 * case, never the one in use pruned by refreezes that cannot be the pool's.
 * A file of the store goes as soon as no kept epoch names it, and the store
 * as a whole holds at most COUNCIL_EPOCH_STORE_MB, the files of the least
 * recently used epochs going first past it: a machine that holds one keeps
 * it, a new machine is then given a fresh export instead.
 *
 * THE FILES OF AN ATTEMPT (§9.7, D10) come the same way back: the pool's
 * worker lists what the attempt wrote into its own folder, this server names
 * the files it wants within COUNCIL_ARTIFACTS in the reply's `collect`, the
 * agent PUTs each (`PUT council/<id>/runs/<runId>/files/<name>?gen=`, the gen
 * of the class's council placement there) and says the attempt `collected`.
 * Kept at DATA_DIR/council/artifacts/<id>/<runId>/<sha256>, named on the
 * attempt's card.
 *
 * Home's alone: no agent module imports this one (tests/runner-import-graph).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  COUNCIL_ARTIFACTS,
  COUNCIL_EPOCH_BUFFERS_MAX,
  COUNCIL_EPOCH_DIR,
  COUNCIL_EPOCH_MANIFEST_BYTES,
  COUNCIL_EPOCH_MB,
  COUNCIL_EPOCH_STORE_MB,
  REMOTE_CLASS_CONTAINER,
  REMOTE_COLLECTS_MAX,
  REMOTE_EPOCHS_MAX,
  REMOTE_EPOCH_FILES_MAX,
  REMOTE_RUN_ID,
  type RemoteEpochFailure,
  type RemoteEpochIntent,
  type RemoteEpochState,
  type RemoteKernelsReply,
} from '@shared/remote-kernels'
import type { CouncilRunFile } from '@shared/protocol'
import { config } from '../../config.js'
import {
  allCouncilEpochs,
  councilEpochsOf,
  discardCouncilEpochs,
  dropCouncilEpoch,
  lastCouncilEpochSeq,
  saveCouncilEpoch,
  type CouncilEpochRow,
} from '../../db.js'
import { remoteBootAt } from '../../competitions/remote/heard.js'
import { wakeRunner } from '../../competitions/remote/wake.js'
import type { RoomRole } from '../room-spec.js'
import { kernelBackend } from '../runtime-client.js'
import { livePlacement, livePlacementRows } from './placement-store.js'

/* ---------------------------------------------------------------- numbers */

const MB = 1024 * 1024
/** How long a `docker cp` of one export may take: a 2 GB first export from this server's own disk. */
const COLLECT_MS = 5 * 60_000

/* ------------------------------------------------------------------ types */

/** One file of an epoch: the manifest, the stream or a buffer, by its sha256. */
export interface EpochFile {
  sha256: string
  bytes: number
}

/** An epoch's files: the manifest, and the stream with the out-of-band buffers (the intent's `buffers`), the stream's sha named apart. */
export interface EpochFiles {
  manifest: EpochFile
  /** The stream's sha256: what `load` checks the body against. */
  body: string
  buffers: EpochFile[]
}

/**
 * Where an epoch's export lies: in this server's store, or still inside the
 * notebook kernel's container on a machine (that placement, at its gen), for
 * the agent's `docker cp`.
 */
export type EpochSource = 'home' | { runnerId: string; role: RoomRole; container: string; gen: number }

/**
 * Why an epoch may not be what the pool's workers run (the pool says it in
 * words). What it would ship across the relay is no trouble of the epoch's:
 * it depends on what one machine holds, and the pool judges it per machine
 * (council-pool.ts · want).
 */
export type EpochTrouble =
  /** It holds data on the GPU: the whole council stays in the shared kernel (D11). */
  | 'cuda'
  /** Its files together pass COUNCIL_EPOCH_MB. */
  | 'over'
  /** The export did not come together: the kernel said so, or its files did not check out. */
  | 'failed'

/** One epoch, as the pool and the console read it. */
export interface Epoch {
  sessionId: string
  root: string
  seq: number
  /** When the notebook's kernel was snapshotted, by this server's clock. */
  at: number
  /** The notebook's count of the teacher's runs then (council-pool.ts · historyRun), in `incarnation`. */
  mainRuns: number
  /** This server's life the count belongs to: the count lives in memory. */
  incarnation: string
  /** Its files together. */
  bytes: number
  /** What it ships to the pool's machine, as the export found it: the files that machine lacked. */
  shipBytes: number
  carried: string[]
  /** What it left behind, with why (the hidden module's word: `cuda`, `over budget`, `generator`, …). */
  left: Array<{ name: string; why: string }>
  /** null: an empty epoch, the notebook's kernel not running when it was asked (§9.2). */
  files: EpochFiles | null
  source: EpochSource
  trouble: EpochTrouble | null
}

/** What the registry keeps in a row's report_json (db.ts · council_epochs). */
interface EpochRecord {
  carried: string[]
  left: Array<{ name: string; why: string }>
  files: EpochFiles | null
  source: EpochSource
  trouble: EpochTrouble | null
}

/* -------------------------------------------------------- the registry */

/** This server's life, as an epoch's `incarnation` names it: the count of the teacher's runs is compared only within one. */
export function epochIncarnation(): string {
  return `life-${remoteBootAt()}`
}

/** Numbers given out in this life, by class, so that two exports asked in one turn never share one before either is written. */
const seqs = new Map<string, number>()

const notebookKey = (sessionId: string, root: string): string => `${sessionId}\0${root}`
const epochKey = (sessionId: string, root: string, seq: number): string => `${sessionId}\0${root}\0${seq}`

/**
 * The next epoch number of a class: above every one any of its notebooks
 * ever had, a restart of this server included. One count for the class, not
 * one a notebook: an export lies at COUNCIL_EPOCH_DIR/<seq> in its kernel's
 * container, and the kernels of a class's notebooks share their containers
 * (the room's, the personal notebooks'), so two notebooks' exports of one
 * number would write into one folder — and the second empty the first's.
 */
export function nextEpochSeq(sessionId: string): number {
  const next = Math.max(seqs.get(sessionId) ?? 0, lastCouncilEpochSeq(sessionId)) + 1
  seqs.set(sessionId, next)
  return next
}

function sane(value: unknown): EpochRecord {
  const record = (value && typeof value === 'object' ? value : {}) as Partial<EpochRecord>
  return {
    carried: Array.isArray(record.carried) ? record.carried.filter((name): name is string => typeof name === 'string') : [],
    left: Array.isArray(record.left) ? record.left.filter((one) => typeof one?.name === 'string' && typeof one?.why === 'string') : [],
    files: record.files && typeof record.files === 'object' ? record.files : null,
    source: record.source === 'home' || (record.source && typeof record.source === 'object') ? record.source : 'home',
    trouble: record.trouble === 'cuda' || record.trouble === 'over' || record.trouble === 'failed' ? record.trouble : null,
  }
}

function fromRow(row: CouncilEpochRow): Epoch {
  const record = sane(row.report)
  return {
    sessionId: row.sessionId,
    root: row.root,
    seq: row.seq,
    at: row.createdAt,
    mainRuns: row.mainRuns,
    incarnation: row.incarnation,
    bytes: row.bytes,
    shipBytes: row.shipBytes,
    carried: record.carried,
    left: record.left,
    files: record.files,
    source: record.source,
    trouble: record.trouble,
  }
}

/** The files an epoch names, its manifest first. */
export function epochFileList(files: EpochFiles | null): EpochFile[] {
  if (!files) return []
  const out = [files.manifest]
  for (const buffer of files.buffers) if (!out.some((one) => one.sha256 === buffer.sha256)) out.push(buffer)
  return out
}

/**
 * Keep one epoch (its row written, the notebook's others pruned to what is
 * kept, and the store's files no kept epoch names any more let go). A row of
 * the same number is replaced: the trouble found after it was written.
 */
export function recordEpoch(epoch: Epoch): void {
  saveCouncilEpoch({
    sessionId: epoch.sessionId,
    root: epoch.root,
    seq: epoch.seq,
    manifestSha256: epoch.files?.manifest.sha256 ?? null,
    bodySha256: epoch.files?.body ?? null,
    bytes: epoch.bytes,
    shipBytes: epoch.shipBytes,
    report: { carried: epoch.carried, left: epoch.left, files: epoch.files, source: epoch.source, trouble: epoch.trouble } satisfies EpochRecord,
    mainRuns: epoch.mainRuns,
    incarnation: epoch.incarnation,
    createdAt: epoch.at,
  })
  keepEpochs(epoch.sessionId, epoch.root)
  pruneStore()
}

/**
 * What of a notebook stays (the header's WHAT IS KEPT): the newest, the two
 * newest with no trouble, and the newest a machine holds whole. The rest go,
 * with whatever a machine was still to be told of them.
 */
function keepEpochs(sessionId: string, root: string): void {
  const all = councilEpochsOf(sessionId, root).map(fromRow)
  const kept = new Set<number>()
  if (all[0]) kept.add(all[0].seq)
  const sound = all.filter((epoch) => epoch.trouble === null)
  for (const epoch of sound.slice(0, 2)) kept.add(epoch.seq)
  const held = sound.find((epoch) => heldWhole(epoch))
  if (held) kept.add(held.seq)
  for (const old of all) {
    if (kept.has(old.seq)) continue
    dropCouncilEpoch(sessionId, root, old.seq)
    forgetNamed(epochKey(sessionId, root, old.seq))
  }
}

/** Whether some machine's last sync said it holds this epoch whole (an empty one is held by any). */
function heldWhole(epoch: Epoch): boolean {
  if (!epoch.files) return true
  const key = epochKey(epoch.sessionId, epoch.root, epoch.seq)
  for (const states of held.values()) if (states.get(key)?.ready) return true
  return false
}

/** A notebook's kept epochs, newest first: two at most. */
export function epochsOf(sessionId: string, root: string): Epoch[] {
  return councilEpochsOf(sessionId, root).map(fromRow)
}

export function epochOf(sessionId: string, root: string, seq: number): Epoch | null {
  return epochsOf(sessionId, root).find((epoch) => epoch.seq === seq) ?? null
}

/** The class is gone: its epochs, their files here, its attempts' files and every word to its machines about them. */
export function forgetClassEpochs(sessionId: string): void {
  discardCouncilEpochs(sessionId)
  seqs.delete(sessionId)
  for (const named of names.values()) for (const key of [...named.keys()]) if (key.startsWith(`${sessionId}\0`)) named.delete(key)
  for (const key of [...namedOnce]) if (key.startsWith(`${sessionId}\0`)) namedOnce.delete(key)
  for (const [key, collect] of collects) if (collect.sessionId === sessionId) collects.delete(key)
  for (const key of [...wanted.keys()]) if (key.startsWith(`${sessionId}\0`)) wanted.delete(key)
  stored.delete(sessionId)
  usedAt.delete(sessionId)
  for (const dir of [path.join(storeRoot(), sessionId), path.join(artifactsRoot(), sessionId)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the next prune takes what is left */
    }
  }
}

/* --------------------------------------------------------- the store */

function storeRoot(): string {
  return path.join(config.dataDir, 'council-epochs')
}

/** The store's folder for what is on its way in: an export being copied out, a file being sent home. */
const STAGING = '.staging'

/** Where a file on its way into the store is written first. */
export function epochStagingDir(): string {
  const dir = path.join(storeRoot(), STAGING)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Where this server keeps one file of a class's epochs. */
export function epochStorePath(sessionId: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid sha256')
  return path.join(storeRoot(), sessionId, sha256)
}

/**
 * What the store holds of each class, sha → bytes: read from disk once per
 * class and kept as files come and go (keepFile, pruneStore), so that a reply
 * built ten times a second asks memory rather than stat thousands of
 * buffers. Its names are their hashes, so a regular file of its length is it.
 */
const stored = new Map<string, Map<string, number>>()

function storeIndex(sessionId: string): Map<string, number> {
  let index = stored.get(sessionId)
  if (index) return index
  index = new Map()
  const dir = path.join(storeRoot(), sessionId)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    /* nothing kept for the class yet */
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue
    try {
      const info = fs.lstatSync(path.join(dir, name))
      if (info.isFile()) index.set(name, info.size)
    } catch {
      /* gone meanwhile */
    }
  }
  stored.set(sessionId, index)
  return index
}

/** Whether the store holds this file whole. */
export function storeHas(sessionId: string, file: EpochFile): boolean {
  return storeIndex(sessionId).get(file.sha256) === file.bytes
}

/** The files of an epoch this server's store lacks. */
export function storeLacks(sessionId: string, files: EpochFiles | null): EpochFile[] {
  return epochFileList(files).filter((file) => !storeHas(sessionId, file))
}

/** When a class's files were last served or stored: the store's LRU, in memory (a restart starts every class even). */
const usedAt = new Map<string, number>()

/** The store's clock for its LRU: the process's, unless a suite moves one by hand. */
let storeNow: () => number = () => Date.now()

/** For tests: the clock the store's LRU stamps its classes with (null — the process's). */
export function useStoreClock(next: (() => number) | null): void {
  storeNow = next ?? (() => Date.now())
}

/**
 * A class whose pool lives now uses its epochs, whether or not their files
 * are served this minute (a machine that holds them fetches nothing): the
 * store's LRU is told so, and lets go of the classes nobody computes on first.
 */
export function touchEpochStore(sessionId: string): void {
  usedAt.set(sessionId, storeNow())
}

/** A file into the store, by rename, once its bytes are known to hash to its name. */
function keepFile(sessionId: string, staged: string, file: EpochFile): void {
  const target = epochStorePath(sessionId, file.sha256)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.renameSync(staged, target)
  storeIndex(sessionId).set(file.sha256, file.bytes)
  usedAt.set(sessionId, storeNow())
}

/** A file out of the store, and out of its index. */
function dropFile(sessionId: string, sha256: string): void {
  fs.rmSync(path.join(storeRoot(), sessionId, sha256), { force: true, recursive: true })
  stored.get(sessionId)?.delete(sha256)
}

/** The sha256 of a file, read through a descriptor that follows no link. */
async function hashOf(file: string): Promise<{ sha256: string; bytes: number } | null> {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of fs.createReadStream('', { fd, autoClose: false, highWaterMark: 1024 * 1024 })) {
      hash.update(chunk as Buffer)
      bytes += (chunk as Buffer).length
    }
    return { sha256: hash.digest('hex'), bytes }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The store as the kept epochs name it: a file no kept epoch names goes now,
 * and past COUNCIL_EPOCH_STORE_MB the files of the classes used least lately
 * go, a class's newest epoch last. A machine that holds such an epoch keeps
 * it; a machine that does not is given a fresh export (council-pool.ts).
 */
export function pruneStore(): void {
  const root = storeRoot()
  let classes: string[]
  try {
    classes = fs.readdirSync(root)
  } catch {
    return
  }
  const epochs = allCouncilEpochs().map(fromRow)
  const named = new Map<string, Set<string>>()
  for (const epoch of epochs) {
    const set = named.get(epoch.sessionId) ?? new Set<string>()
    for (const file of epochFileList(epoch.files)) set.add(file.sha256)
    named.set(epoch.sessionId, set)
  }
  const sizes: Array<{ sessionId: string; sha256: string; bytes: number }> = []
  for (const sessionId of classes) {
    // Exports being copied out and files on their way home are no class's yet (ingestHomeExport, upload.ts · receiveEpochFile);
    // what a crash left there an hour ago is nobody's.
    if (sessionId === STAGING) {
      sweepStaging()
      continue
    }
    const dir = path.join(root, sessionId)
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of files) {
      const file = path.join(dir, name)
      // A part a crash left, or a file no kept epoch names: nothing will ever read it.
      if (!/^[a-f0-9]{64}$/.test(name) || !named.get(sessionId)?.has(name)) {
        dropFile(sessionId, name)
        continue
      }
      try {
        sizes.push({ sessionId, sha256: name, bytes: fs.lstatSync(file).size })
      } catch {
        /* gone meanwhile */
      }
    }
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch {
      /* not empty after all, or gone */
    }
  }
  let total = sizes.reduce((sum, one) => sum + one.bytes, 0)
  if (total <= COUNCIL_EPOCH_STORE_MB * MB) return
  // Whole classes, least recently used first, and within a class the oldest epoch's files before the newest's.
  const order = [...new Set(sizes.map((one) => one.sessionId))].sort((a, b) => (usedAt.get(a) ?? 0) - (usedAt.get(b) ?? 0))
  for (const sessionId of order) {
    const newest = new Map<string, number>()
    for (const epoch of epochs) {
      if (epoch.sessionId !== sessionId) continue
      for (const file of epochFileList(epoch.files)) newest.set(file.sha256, Math.max(newest.get(file.sha256) ?? 0, epoch.at))
    }
    const files = sizes.filter((one) => one.sessionId === sessionId).sort((a, b) => (newest.get(a.sha256) ?? 0) - (newest.get(b.sha256) ?? 0))
    for (const file of files) {
      if (total <= COUNCIL_EPOCH_STORE_MB * MB) return
      dropFile(sessionId, file.sha256)
      total -= file.bytes
    }
  }
}

/** How old a leftover in the store's staging may grow: well past any copy-out (COLLECT_MS) or upload's stall. */
const STAGING_STALE_MS = 60 * 60_000

function sweepStaging(): void {
  const dir = path.join(storeRoot(), STAGING)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    try {
      if (Date.now() - fs.lstatSync(path.join(dir, name)).mtimeMs > STAGING_STALE_MS) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    } catch {
      /* gone meanwhile */
    }
  }
}

/* ------------------------------------------------- an export here */

/**
 * Copy one export out of the container of a kernel of this server into
 * `into` (an empty folder of this server's): what the files' check reads.
 * The process's own runs `docker cp`, then removes the folder from the
 * container; a suite stands another in (useEpochCollector). `into` null: the
 * folder is only removed — an export this server will not keep (it did not
 * come together, holds data on the GPU, or names nothing the store lacks)
 * leaves no gigabytes in the kernel's /tmp.
 */
export type EpochCollector = (sessionId: string, role: RoomRole, seq: number, into: string | null) => Promise<void>

/** The container of a slot of this server's, as kernel/pool.ts names it (containerFor). */
function homeContainer(sessionId: string, role: RoomRole): string {
  return role === 'room' ? `colloq-room-${sessionId}` : `colloq-room-${sessionId}-${role}`
}

function docker(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (data: Buffer) => (out += data.toString()))
    child.stderr.on('data', (data: Buffer) => (out += data.toString()))
    child.on('error', (error) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: code ?? -1, out: out.trim() })
    })
  })
}

const DOCKER_COLLECTOR: EpochCollector = async (sessionId, role, seq, into) => {
  // Fake kernels have no containers, and a test server must never reach a real Docker (runtime-client.ts).
  if (kernelBackend() === 'test') throw new Error('the test kernel backend has no containers to copy an export out of')
  const container = homeContainer(sessionId, role)
  const from = `${COUNCIL_EPOCH_DIR}/${seq}`
  const copied = into === null ? null : await docker(['cp', `${container}:${from}/.`, into], COLLECT_MS)
  // The folder goes whatever the copy did: an export nobody can read is no reason to keep its gigabytes in the kernel's /tmp.
  await docker(['exec', container, 'rm', '-rf', from], 60_000)
  if (copied && copied.code !== 0) throw new Error(`docker cp of the export failed: ${copied.out.slice(-300)}`)
}

let collector: EpochCollector = DOCKER_COLLECTOR

/** For tests and harnesses: how an export of a kernel here is copied out (null — `docker cp`). */
export function useEpochCollector(next: EpochCollector | null): void {
  collector = next ?? DOCKER_COLLECTOR
}

/**
 * The export of a kernel of this server, into the store: copied out of its
 * container, every file it holds hashed and kept by its content (an export
 * writes only the buffers changed since the notebook's last one, §9.3), and
 * then every file the epoch names looked for — the store has each, or the
 * epoch did not come together. Whether it did.
 */
export async function ingestHomeExport(sessionId: string, role: RoomRole, seq: number, files: EpochFiles): Promise<boolean> {
  // Nothing it names is new here: the folder goes all the same (an unchanged refreeze still wrote its manifest and stream).
  if (storeLacks(sessionId, files).length === 0) {
    await dropHomeExport(sessionId, role, seq)
    return true
  }
  const staging = path.join(epochStagingDir(), `${sessionId}-${seq}-${randomUUID()}`)
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    try {
      await collector(sessionId, role, seq, staging)
    } catch (error) {
      console.warn(`[council ${sessionId}] the export of epoch ${seq} could not be copied out: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    const wanted = new Map(epochFileList(files).map((file) => [file.sha256, file]))
    for (const name of fs.readdirSync(staging)) {
      const staged = path.join(staging, name)
      const hashed = await hashOf(staged)
      if (!hashed) continue
      const file = wanted.get(hashed.sha256)
      // By content, never by name: a file the epoch does not name, or of another length, is not kept.
      if (!file || file.bytes !== hashed.bytes || storeHas(sessionId, file)) continue
      keepFile(sessionId, staged, file)
    }
    const lacking = storeLacks(sessionId, files)
    if (lacking.length > 0) console.warn(`[council ${sessionId}] epoch ${seq}: ${lacking.length} of its files did not check out`)
    return lacking.length === 0
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * The folder of an export of a kernel of this server that the store will not
 * take, removed from its container (§9.2: every export's folder goes once it
 * is dealt with). A failure is the log's: the kernel's next export writes a
 * folder of its own.
 */
export async function dropHomeExport(sessionId: string, role: RoomRole, seq: number): Promise<void> {
  try {
    await collector(sessionId, role, seq, null)
  } catch (error) {
    console.warn(`[council ${sessionId}] the export of epoch ${seq} could not be removed from its container: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------------------ what the machines hold */

/** Each machine's epochs, as its last sync listed them. */
const held = new Map<string, Map<string, RemoteEpochState>>()

const listeners = new Set<(sessionId: string, root: string) => void>()

/** The pool hears when a machine's word on one of its notebook's epochs changes. */
export function onEpochNews(listener: (sessionId: string, root: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function tell(sessionId: string, root: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, root)
    } catch (error) {
      console.error(`[council ${sessionId}] an epoch listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const heardListeners = new Set<(runnerId: string) => void>()

/**
 * The pool hears a machine's first sync of this life: until then nothing is
 * known of what it holds (a restart of this server forgets it), and what an
 * epoch would ship there is not judged (council-pool.ts · want).
 */
export function onEpochMachineHeard(listener: (runnerId: string) => void): () => void {
  heardListeners.add(listener)
  return () => heardListeners.delete(listener)
}

/** Whether a machine's sync said what it holds in this life of the server. */
export function epochsHeardFrom(runnerId: string): boolean {
  return held.has(runnerId)
}

/**
 * A machine's sync said what it holds (§15): the whole list, so one left out
 * is one it no longer has. The notebooks whose epoch changed state there
 * hear of it, and every pool hears the machine's first word of this life.
 */
export function noteEpochStates(runnerId: string, states: readonly RemoteEpochState[]): void {
  const first = !held.has(runnerId)
  const before = held.get(runnerId) ?? new Map<string, RemoteEpochState>()
  const now = new Map<string, RemoteEpochState>()
  for (const state of states) now.set(epochKey(state.sessionId, state.root, state.seq), state)
  held.set(runnerId, now)
  const changed = new Set<string>()
  for (const [key, state] of now) {
    const was = before.get(key)
    if (!was || was.ready !== state.ready || was.failed !== state.failed) changed.add(notebookKey(state.sessionId, state.root))
    // Ready, or never coming: no reply names it again.
    if (state.ready || state.failed) names.get(runnerId)?.delete(key)
  }
  for (const [key, state] of before) if (!now.has(key)) changed.add(notebookKey(state.sessionId, state.root))
  for (const key of changed) {
    const [sessionId, root] = key.split('\0') as [string, string]
    tell(sessionId, root)
  }
  if (!first) return
  for (const listener of [...heardListeners]) {
    try {
      listener(runnerId)
    } catch (error) {
      console.error(`[council] a machine listener failed for ${runnerId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** One epoch on one machine: there whole, on its way, given up there (with why), or nothing of it. */
export function epochOnMachine(runnerId: string, epoch: Pick<Epoch, 'sessionId' | 'root' | 'seq' | 'files'>): 'ready' | 'fetching' | 'failed' | 'none' {
  if (!epoch.files) return 'ready'
  const state = held.get(runnerId)?.get(epochKey(epoch.sessionId, epoch.root, epoch.seq))
  if (!state) return 'none'
  if (state.ready) return 'ready'
  return state.failed ? 'failed' : 'fetching'
}

/** A failure that is the machine's last word on an epoch: a full disk is not, it tries again by itself. */
const givenUp = (failure: RemoteEpochFailure | null): boolean => failure === 'source' || failure === 'files'

/** Why a machine gave an epoch up (RemoteEpochState.failed), or null: it did not. */
export function epochFailureOn(runnerId: string, epoch: Pick<Epoch, 'sessionId' | 'root' | 'seq'>): RemoteEpochFailure | null {
  const state = held.get(runnerId)?.get(epochKey(epoch.sessionId, epoch.root, epoch.seq))
  return state && !state.ready && state.failed ? state.failed : null
}

/**
 * The files a machine holds whole, as far as this server can tell: those of
 * every epoch it reported ready. What a refreeze would ship there is what
 * the new epoch names beyond these (COUNCIL_EPOCH_SHIP_MB counts nothing
 * else).
 */
export function filesOn(runnerId: string): Set<string> {
  const out = new Set<string>()
  for (const [key, state] of held.get(runnerId) ?? []) {
    if (!state.ready) continue
    const [sessionId, root, seq] = key.split('\0') as [string, string, string]
    for (const file of epochFileList(epochOf(sessionId, root, Number(seq))?.files ?? null)) out.add(file.sha256)
  }
  return out
}

/** The bytes of an epoch's files a machine lacks: what reaching it costs the relay. */
export function bytesMissingOn(runnerId: string, files: EpochFiles | null): number {
  const there = filesOn(runnerId)
  return epochFileList(files).filter((file) => !there.has(file.sha256)).reduce((sum, file) => sum + file.bytes, 0)
}

/* -------------------------------------------------------- the reply */

/** What a reply told a machine of an epoch: the blob door and the upload door read it. */
interface Named {
  sessionId: string
  root: string
  seq: number
  /** The hashes it may fetch from here (`from: 'home'`). */
  fetch: Set<string>
  /** The hashes it is to send here, and the placement whose container holds the export (§15 `ship`). */
  ship: Set<string>
  source: { role: RoomRole; gen: number } | null
}

/** Per machine: every epoch named to it, by epochKey, until it reports it ready or failed, or the epoch goes. */
const names = new Map<string, Map<string, Named>>()

/** Every epoch a reply of this life named to any machine, by epochKey, until the epoch goes. */
const namedOnce = new Set<string>()

function forgetNamed(key: string): void {
  for (const named of names.values()) named.delete(key)
  namedOnce.delete(key)
}

/**
 * Whether a reply of this life ever named the epoch to a machine, or a
 * machine's sync lists it: an export on a machine that neither is true of
 * is one no agent reads, ever, once a newer one of its notebook is what
 * replies name (council-pool.ts · dropSuperseded).
 */
export function epochNamed(epoch: Pick<Epoch, 'sessionId' | 'root' | 'seq'>): boolean {
  const key = epochKey(epoch.sessionId, epoch.root, epoch.seq)
  if (namedOnce.has(key)) return true
  for (const states of held.values()) if (states.has(key)) return true
  return false
}

/**
 * Which epoch of a notebook a pool on `runnerId` is to hold now: the newest
 * one with files and no trouble. council-pool.ts asks for it by setting
 * `wantedEpoch` (an epoch kept but not wanted is named to nobody).
 */
const wanted = new Map<string, { runnerId: string; seq: number }>()

/** The pool of a notebook wants this epoch on its machine (null: none now). Its machine is woken to hear it. */
export function wantEpoch(sessionId: string, root: string, want: { runnerId: string; seq: number } | null): void {
  const key = notebookKey(sessionId, root)
  const before = wanted.get(key)
  if (want === null) wanted.delete(key)
  else wanted.set(key, want)
  if (want && (before?.runnerId !== want.runnerId || before.seq !== want.seq)) wakeRunner(want.runnerId)
  // A machine whose export is to come home hears it at once too.
  const epoch = want ? epochOf(sessionId, root, want.seq) : null
  if (epoch && epoch.source !== 'home' && epoch.source.runnerId !== want!.runnerId) wakeRunner(epoch.source.runnerId)
}

/**
 * The epochs of a machine's reply (§15 RemoteKernelsReply.epochs): every
 * epoch a pool wants on it that it has not reported ready, with where its
 * files come from; and every epoch whose export lies in a container there
 * that a pool on another machine wants, with the files this server lacks to
 * `ship` home. At most REMOTE_EPOCHS_MAX, naming at most
 * REMOTE_EPOCH_FILES_MAX files together: the rest wait for a later reply.
 * Called once per reply built: what it names is what the doors serve.
 */
export function epochIntentsFor(runnerId: string): RemoteEpochIntent[] {
  const told = new Map<string, Named>()
  const out: RemoteEpochIntent[] = []
  let files = 0
  const add = (epoch: Epoch, intent: RemoteEpochIntent, named: Named): void => {
    const count = 1 + intent.buffers.length
    if (out.length >= REMOTE_EPOCHS_MAX || files + count > REMOTE_EPOCH_FILES_MAX) return
    files += count
    out.push(intent)
    told.set(epochKey(epoch.sessionId, epoch.root, epoch.seq), named)
    namedOnce.add(epochKey(epoch.sessionId, epoch.root, epoch.seq))
  }
  for (const [key, want] of wanted) {
    const [sessionId, root] = key.split('\0') as [string, string]
    const epoch = epochOf(sessionId, root, want.seq)
    if (!epoch?.files || epoch.trouble !== null) continue
    const buffers = epoch.files.buffers.filter((file) => file.sha256 !== epoch.files!.manifest.sha256).map((file) => ({ ...file }))
    // The export in a container of this machine: one docker names by its full id (the contract's REMOTE_CLASS_CONTAINER), or none.
    const here = epoch.source !== 'home' && epoch.source.runnerId === runnerId && REMOTE_CLASS_CONTAINER.test(epoch.source.container) ? epoch.source : null
    if (want.runnerId === runnerId) {
      // The pool's machine, until it holds it: from the container beside it, or by blobs from here once every file is here.
      const state = epochOnMachine(runnerId, epoch)
      if (state === 'ready' || state === 'failed') continue
      if (here) {
        add(epoch, { sessionId, root, seq: epoch.seq, manifest: { ...epoch.files.manifest }, buffers, from: { container: here.container, dir: `${COUNCIL_EPOCH_DIR}/${epoch.seq}` } },
          { sessionId, root, seq: epoch.seq, fetch: new Set(), ship: new Set(), source: { role: here.role, gen: here.gen } })
        continue
      }
      if (storeLacks(sessionId, epoch.files).length > 0) continue
      add(epoch, { sessionId, root, seq: epoch.seq, manifest: { ...epoch.files.manifest }, buffers, from: 'home' },
        { sessionId, root, seq: epoch.seq, fetch: new Set(epochFileList(epoch.files).map((file) => file.sha256)), ship: new Set(), source: null })
      continue
    }
    // The export lies here and the pool is elsewhere: what this server lacks of it comes home first — unless this machine gave
    // it up (its folder gone, its files not the report's): nothing more of it is asked, and the pool takes another export.
    if (!here || givenUp(epochFailureOn(runnerId, epoch))) continue
    const ship = storeLacks(sessionId, epoch.files).map((file) => file.sha256)
    if (ship.length === 0) continue
    add(epoch, { sessionId, root, seq: epoch.seq, manifest: { ...epoch.files.manifest }, buffers, from: { container: here.container, dir: `${COUNCIL_EPOCH_DIR}/${epoch.seq}` }, ship },
      { sessionId, root, seq: epoch.seq, fetch: new Set(), ship: new Set(ship), source: { role: here.role, gen: here.gen } })
  }
  names.set(runnerId, told)
  return out
}

/**
 * A file of an epoch, for `GET blobs/<sha>` (BlobSource `epoch`): only to a
 * machine the last reply named that epoch to, to fetch from here, and only
 * while the store holds it whole. Null — not this machine's to have (404).
 */
export function epochBlobFor(runnerId: string, sha256: string): { sessionId: string; path: string; bytes: number } | null {
  for (const named of names.get(runnerId)?.values() ?? []) {
    if (!named.fetch.has(sha256)) continue
    const epoch = epochOf(named.sessionId, named.root, named.seq)
    const file = epochFileList(epoch?.files ?? null).find((one) => one.sha256 === sha256)
    if (!file || !storeHas(named.sessionId, file)) return null
    usedAt.set(named.sessionId, storeNow())
    return { sessionId: named.sessionId, path: epochStorePath(named.sessionId, sha256), bytes: file.bytes }
  }
  return null
}

/** Why a machine's PUT of an epoch file is refused, as upload.ts answers it. */
export class EpochUploadRefused extends Error {
  constructor(
    readonly why: 'not-asked' | 'stale' | 'mismatch',
    message: string,
  ) {
    super(message)
  }
}

/**
 * `PUT epochs/<sha256>?session=&gen=` (§15): accepted only for a file a reply
 * asked this machine to `ship`, of an epoch of that class, whose export lies
 * in the container of that class's placement on this machine at that gen —
 * a placement since lost or replaced is 409 (`stale`, which the agent drops),
 * and a file not asked for is 404. What the file is to be, and where it goes.
 */
export function epochUploadFor(runnerId: string, sha256: string, sessionId: string, gen: number): { file: EpochFile; target: string } {
  for (const named of names.get(runnerId)?.values() ?? []) {
    if (named.sessionId !== sessionId || !named.ship.has(sha256) || !named.source) continue
    const epoch = epochOf(sessionId, named.root, named.seq)
    const file = epochFileList(epoch?.files ?? null).find((one) => one.sha256 === sha256)
    if (!file) continue
    const row = livePlacement(sessionId, named.source.role)
    if (named.source.gen !== gen || !row || row.runnerId !== runnerId || row.gen !== gen) {
      throw new EpochUploadRefused('stale', 'The placement this export lay in is no longer there')
    }
    return { file, target: epochStorePath(sessionId, sha256) }
  }
  throw new EpochUploadRefused('not-asked', 'No such epoch file asked of this machine')
}

/** A file a machine sent home, checked by upload.ts against its name and length, into the store; the pool's machine may fetch it now. */
export function landEpochUpload(runnerId: string, sessionId: string, file: EpochFile, staged: string): void {
  if (!storeHas(sessionId, file)) keepFile(sessionId, staged, file)
  for (const named of names.get(runnerId)?.values() ?? []) if (named.sessionId === sessionId) named.ship.delete(file.sha256)
  for (const [key, want] of wanted) {
    if (!key.startsWith(`${sessionId}\0`)) continue
    // The pool elsewhere may hear of its epoch now.
    if (want.runnerId !== runnerId) wakeRunner(want.runnerId)
    const [, root] = key.split('\0') as [string, string]
    tell(sessionId, root)
  }
}

/* ----------------------------------------------- the attempts' files */

/** What one attempt the pool ran is to bring home, on the card. */
export interface CollectRequest {
  sessionId: string
  runId: string
  /** The machine of the class's council placement the attempt ran in, and its gen there: the artifacts' PUTs carry it. */
  runnerId: string
  gen: number
  /** The files this server wants, within COUNCIL_ARTIFACTS: the others were named on the card with their size, and stay behind. */
  files: Array<{ name: string; sha256: string; bytes: number }>
  /** One of them is here now. */
  landed(name: string): void
  /** The machine says the collection is over (or this server stops waiting): what did not land, did not come. */
  over(): void
}

const collects = new Map<string, CollectRequest>()
const collectKey = (sessionId: string, runId: string): string => `${sessionId}\0${runId}`

function artifactsRoot(): string {
  return path.join(config.dataDir, 'council', 'artifacts')
}

/** Where a kept file of an attempt is: by the run's id and the file's own sha256 (its name stays on the card). */
export function artifactPath(sessionId: string, runId: string, sha256: string): string {
  if (!REMOTE_RUN_ID.test(runId) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid artifact')
  return path.join(artifactsRoot(), sessionId, runId, sha256)
}

/**
 * Within COUNCIL_ARTIFACTS: the files of a listing this server takes, in
 * order, each at most `fileBytes` and all at most `totalBytes`, at most
 * `files` of them. The rest stay behind, named with their size.
 */
export function artifactsWithinCaps<T extends { bytes: number }>(listed: readonly T[]): { taken: T[]; left: T[] } {
  const taken: T[] = []
  const left: T[] = []
  let total = 0
  for (const file of listed) {
    if (taken.length < COUNCIL_ARTIFACTS.files && file.bytes <= COUNCIL_ARTIFACTS.fileBytes && total + file.bytes <= COUNCIL_ARTIFACTS.totalBytes) {
      taken.push(file)
      total += file.bytes
    } else left.push(file)
  }
  return { taken, left }
}

/**
 * An attempt's files as its card names them (§9.7, CouncilRun.files), from
 * its exit's listing: those this server brings — hashed by the exit, within
 * COUNCIL_ARTIFACTS in the listed order — on their way (`kept: null`) with
 * their sha256, each turned `true` as it lands and `false` if its collection
 * ends without it; the rest left behind (`false`) from the start.
 */
export function attemptCardFiles(listed: ReadonlyArray<{ name: string; sha256: string | null; bytes: number }>): CouncilRunFile[] {
  const hashed = listed.flatMap((file) => (file.sha256 !== null ? [{ ...file, sha256: file.sha256 }] : []))
  const taken = new Map(artifactsWithinCaps(hashed).taken.map((file) => [file.name, file.sha256]))
  return listed.map((file) => {
    const sha256 = taken.get(file.name)
    return sha256 !== undefined ? { name: file.name, bytes: file.bytes, kept: null, sha256 } : { name: file.name, bytes: file.bytes, kept: false }
  })
}

/** An attempt is over: its machine is to send what this server wants of its folder, and then remove the folder. */
export function askCollect(request: CollectRequest): void {
  collects.set(collectKey(request.sessionId, request.runId), request)
  wakeRunner(request.runnerId)
}

/** The collections a machine's reply names (§15 RemoteKernelsReply.collect), until it says each is over. */
export function collectFor(runnerId: string): RemoteKernelsReply['collect'] {
  const out: RemoteKernelsReply['collect'] = []
  for (const collect of collects.values()) {
    if (collect.runnerId !== runnerId) continue
    if (out.length >= REMOTE_COLLECTS_MAX) break
    out.push({ sessionId: collect.sessionId, runId: collect.runId, files: collect.files.map((file) => ({ ...file })) })
  }
  return out
}

/** A machine's sync says these collections are over (RemoteKernelsRequest.collected): what did not land did not come. */
export function noteCollected(runnerId: string, collected: ReadonlyArray<{ sessionId: string; runId: string }>): void {
  for (const one of collected) {
    const key = collectKey(one.sessionId, one.runId)
    const collect = collects.get(key)
    if (!collect || collect.runnerId !== runnerId) continue
    collects.delete(key)
    collect.over()
  }
}

/** A class's council placement left its machine: its collections there will never be answered. */
export function dropCollects(sessionId: string, runnerId: string | null): void {
  for (const [key, collect] of collects) {
    if (collect.sessionId !== sessionId || (runnerId !== null && collect.runnerId !== runnerId)) continue
    collects.delete(key)
    collect.over()
  }
}

/** Why a machine's PUT of an attempt's file is refused. */
export class ArtifactRefused extends Error {
  constructor(
    readonly why: 'not-asked' | 'stale',
    message: string,
  ) {
    super(message)
  }
}

/**
 * `PUT council/<id>/runs/<runId>/files/<name>?gen=` (§15): only a file this
 * server named in a collection of that attempt on this machine, at the gen of
 * the class's council placement there (a placement since lost is 409
 * `stale`). What it is to be, and where it goes.
 */
export function artifactUploadFor(runnerId: string, sessionId: string, runId: string, name: string, gen: number): { sha256: string; bytes: number; target: string } {
  const collect = collects.get(collectKey(sessionId, runId))
  const file = collect?.runnerId === runnerId ? collect.files.find((one) => one.name === name) : undefined
  if (!collect || !file) throw new ArtifactRefused('not-asked', 'No such file of this attempt asked of this machine')
  const row = livePlacement(sessionId, 'council')
  if (collect.gen !== gen || !row || row.runnerId !== runnerId || row.gen !== gen) throw new ArtifactRefused('stale', 'The council placement this attempt ran in is no longer there')
  return { sha256: file.sha256, bytes: file.bytes, target: artifactPath(sessionId, runId, file.sha256) }
}

/** A file of an attempt, checked by upload.ts, is here: it goes on the card. */
export function landArtifact(sessionId: string, runId: string, name: string, staged: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.renameSync(staged, target)
  collects.get(collectKey(sessionId, runId))?.landed(name)
}

/* ---------------------------------------------------------------- tests */

/** For tests: forget what the machines said and were told, every collection, and the store's LRU. */
export function resetEpochsForTest(): void {
  held.clear()
  names.clear()
  namedOnce.clear()
  wanted.clear()
  collects.clear()
  usedAt.clear()
  seqs.clear()
  stored.clear()
}

/** What the export's report must keep to before its files are even looked at: the contract's own caps. */
export function epochFilesWithinContract(files: EpochFiles): boolean {
  const list = epochFileList(files)
  return files.manifest.bytes >= 1 && files.manifest.bytes <= COUNCIL_EPOCH_MANIFEST_BYTES && files.buffers.length <= COUNCIL_EPOCH_BUFFERS_MAX
    && list.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0)
    && list.reduce((sum, file) => sum + file.bytes, 0) <= COUNCIL_EPOCH_MB * MB
    && files.buffers.some((file) => file.sha256 === files.body)
}

/** The class placements of a machine that hold a council: the pools a reply's `wanted` epochs belong to (for the console's words). */
export function councilPlacementsOn(runnerId: string): Array<{ sessionId: string; gen: number }> {
  return livePlacementRows().filter((row) => row.role === 'council' && row.runnerId === runnerId && row.state !== 'stopping').map((row) => ({ sessionId: row.sessionId, gen: row.gen }))
}
