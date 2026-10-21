/**
 * A machine's results arriving (§3.6 "PUT"): `submission.csv` and
 * `executed.ipynb` of one attempt, gzipped, one PUT each.
 *
 * WHAT COMES BACK IS PARTICIPANT DATA (§6), and is taken in as such. Only the
 * two names; the body is gzip, and X-Colloq-Sha256 and X-Colloq-Bytes say
 * what the file is uncompressed. The caps apply AFTER decompression — the
 * answer at most its lease's `targetBytes`, the notebook at most
 * REMOTE_FILE_BYTES — and decompression stops at the declared length plus
 * one byte, so a gzip bomb costs one byte past what it declared. The file is
 * kept only when its length and its sha256 are what the headers said.
 *
 * STAGED OUTSIDE THE ATTEMPT'S TREE: competitions/.remote/<attempt>/, a
 * folder no submission's directory is under. The outcome moves the files in
 * (apply.ts), so an upload for an attempt that was cancelled or erased
 * meanwhile can never recreate the directories of a submission that is gone
 * — it is refused before a byte is written, and nothing is created for it.
 * The staged name carries the file's own sha256, so the same file PUT again
 * is a no-op. Each PUT writes a `.part` of its own, renamed into that name
 * only once its bytes are what the headers said: a machine's retry that
 * arrives while its first PUT is still streaming (the relay kept that one
 * alive) never truncates the other's file under it, so what is kept is one
 * whole write, never two halves. A part left by an interrupted write is
 * removed with it, or with the staging folder (liveness.ts · sweepStaging).
 *
 * BACK-PRESSURE. At most `runnerUploads` uploads are stored at once across
 * the instance (REMOTE_UPLOADS), and each needs REMOTE_UPLOAD_FREE_BYTES of
 * free disk by statfs: past the first, 503 with Retry-After; below the floor,
 * 507. The machine keeps its outcome and tries again; nothing is lost.
 *
 * ONE MACHINE NEVER HOLDS EVERY SLOT: at most half of them (machineShare),
 * and a body that sends nothing for UPLOAD_STALL_MS is ended. A machine that
 * kept four PUTs trickling held the instance's four slots for as long as it
 * liked, every other machine's results got 503 until their leases reached the
 * ceiling, and those losses were charged to the honest machines' quarantine.
 *
 * A CLASS'S FILES COME THE SAME WAY, BY A DOOR OF THEIR OWN (PUT
 * rooms/:sessionId/files, remote-classes.md §8.3): a file of a class's folder
 * copy on a machine that home pulled, gzipped and checked like a result, but
 * staged under a temporary name in the class folder itself (renamed into its
 * place by kernel/remote/files.ts), through upload slots of their own — at
 * most REMOTE_CLASS_UPLOADS a machine, so a class's dataset never keeps a
 * submission's result waiting — and read through the class bucket
 * (blobs.ts · classUploadPace). A fenced gen's late file is a 409.
 *
 * AN ATTEMPT STAGES AT MOST ONE FILE PER NAME, and at most what its two caps
 * add up to (stagingRoom). The staged name carries the sha256, so a PUT of the
 * same name with other bytes used to land beside the first — and a machine
 * could stage gigabytes under one lease from kilobytes of gzip, on the volume
 * colloq.db shares, down to the disk floor. A file with a new hash for a name
 * now replaces the one staged under it, and a PUT past the attempt's room is
 * refused before its body is read. An honest agent never meets either: its
 * hashes are fixed in its persisted outcome.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PassThrough, Transform, Writable, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import type { Request } from 'express'
import {
  REMOTE_BYTES_HEADER,
  REMOTE_FILE_BYTES,
  REMOTE_FILE_NAMES,
  REMOTE_SHA256,
  REMOTE_SHA256_HEADER,
  REMOTE_UPLOAD_FREE_BYTES,
  RemoteProtocolError,
  parseRemoteUploadMeta,
  type RemoteFileName,
  type RemoteUploadReply,
} from '@shared/remote-runner'
import { REMOTE_CLASS_UPLOADS } from '@shared/remote-kernels'
import { COMPETITION_ATTEMPT_ID } from '@shared/competition-runtime'
import { normalizePath } from '@shared/paths'
import { config } from '../../config.js'
import { resolveInSession, sessionDir, tempNameIn, workspaceFs } from '../../workspace.js'
import { PullRefused, classFiles, type RoomFileStored } from '../../kernel/remote/files.js'
import { competitionsDir, competitionsFs } from '../storage.js'
import { runnerUploadsSetting } from '../settings.js'
import { classUploadPace } from './blobs.js'
import { getLease, type LeaseRow, type RunnerRow } from './store.js'

/** The folder an attempt's uploads wait in until its outcome moves them (or the sweep removes them). */
export function stagingDir(attemptId: string): string {
  if (!COMPETITION_ATTEMPT_ID.test(attemptId)) throw new Error('Invalid attempt id')
  return path.join(competitionsDir, '.remote', attemptId)
}

/** A staged file, named by its own sha256: one name per content. */
export function stagedPath(attemptId: string, name: RemoteFileName, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid sha256')
  return path.join(stagingDir(attemptId), `${name}.${sha256}`)
}

/** Whether a file is staged whole: present under its sha256, with its length. */
export function stagedWhole(attemptId: string, file: { name: RemoteFileName; sha256: string; bytes: number }): boolean {
  try {
    const info = competitionsFs.statSync(stagedPath(attemptId, file.name, file.sha256))
    return info.isFile() && info.size === file.bytes
  } catch {
    return false
  }
}

export function dropStaging(attemptId: string): void {
  try {
    competitionsFs.rmSync(stagingDir(attemptId), { recursive: true, force: true })
  } catch {
    // The sweep tries again (liveness.ts · sweepStaging).
  }
}

/** Every attempt that has a staging folder, for the sweep. */
export function stagedAttempts(): string[] {
  try {
    return (competitionsFs.readdirSync(path.join(competitionsDir, '.remote')) as string[]).filter((name) => COMPETITION_ATTEMPT_ID.test(name))
  } catch {
    return []
  }
}

/** Uploads being stored now, across the instance and by machine. */
let active = 0
const activeBy = new Map<string, number>()
/** What the uploads under way declared, by attempt and name: what an attempt's room counts beside what it has staged (stagingRoom). */
const declared = new Map<string, Map<RemoteFileName, number[]>>()
export const uploadCounts = { stored: 0, repeated: 0, refused: 0, busy: 0, replaced: 0, stalled: 0 }

/**
 * A machine's share of the instance's upload slots: half of them, and never
 * none. The agent puts an attempt's two files side by side, so the default
 * four leave every machine its two and keep two for the rest of the fleet.
 */
export function machineShare(slots: number): number {
  return Math.max(1, Math.floor(slots / 2))
}

/** How long an upload's body may send nothing before it is ended and its slot freed (useUploadStallMs for tests). */
const UPLOAD_STALL_MS = 60_000
let uploadStallMs = UPLOAD_STALL_MS

/** The most one attempt stages: its answer at its cap and its executed notebook at its own. */
export function attemptRoomBytes(targetBytes: number): number {
  return Math.min(targetBytes, REMOTE_FILE_BYTES) + REMOTE_FILE_BYTES
}

/** An attempt's completed staged files (no `.part`), by the name and sha256 their file names carry. */
function stagedFiles(attemptId: string): Array<{ name: RemoteFileName; sha256: string; bytes: number; file: string }> {
  const dir = stagingDir(attemptId)
  let names: string[]
  try {
    names = competitionsFs.readdirSync(dir) as string[]
  } catch {
    return []
  }
  const out: Array<{ name: RemoteFileName; sha256: string; bytes: number; file: string }> = []
  for (const entry of names) {
    const match = /^(submission\.csv|executed\.ipynb)\.([a-f0-9]{64})$/.exec(entry)
    if (!match) continue
    try {
      const file = path.join(dir, entry)
      const info = competitionsFs.statSync(file)
      if (info.isFile()) out.push({ name: match[1] as RemoteFileName, sha256: match[2], bytes: info.size, file })
    } catch {
      // Gone between the listing and the look: nothing staged under it.
    }
  }
  return out
}

/**
 * Whether one more upload of `name`, of `bytes`, fits the attempt's room:
 * for each name the larger of what is staged under it and what an upload of
 * it under way declared — the one of this name staged now is replaced by
 * this one, so only the uploads of it under way count beside it.
 */
function fitsRoom(attemptId: string, name: RemoteFileName, bytes: number, room: number): boolean {
  const staged = stagedFiles(attemptId)
  const going = declared.get(attemptId)
  let total = 0
  for (const each of REMOTE_FILE_NAMES) {
    const underWay = Math.max(0, ...(going?.get(each) ?? []))
    total += each === name
      ? Math.max(underWay, bytes)
      : Math.max(underWay, staged.filter((file) => file.name === each).reduce((sum, file) => sum + file.bytes, 0))
  }
  return total <= room
}

function noteDeclared(attemptId: string, name: RemoteFileName, bytes: number, on: boolean): void {
  let byName = declared.get(attemptId)
  if (on) {
    if (!byName) declared.set(attemptId, (byName = new Map()))
    byName.set(name, [...(byName.get(name) ?? []), bytes])
    return
  }
  const list = byName?.get(name) ?? []
  const at = list.indexOf(bytes)
  if (at >= 0) list.splice(at, 1)
  if (byName && list.length === 0) byName.delete(name)
  if (byName && byName.size === 0) declared.delete(attemptId)
}

/** A refusal of an upload, with the router's code for it (REMOTE_ERRORS). */
export class UploadRefusal extends Error {
  constructor(readonly code: 'not_found' | 'revoked' | 'conflict' | 'too_large' | 'mismatch' | 'busy' | 'disk', message: string, readonly retryAfterS?: number) {
    super(message)
  }
}

/** The lease states an upload may arrive in: the machine holds the attempt. */
const UPLOADING: ReadonlySet<string> = new Set(['offered', 'accepted', 'running'])

/** Free bytes for the competitions' volume, or `null` — unknown, which is no reason to refuse. */
function freeBytes(): number | null {
  try {
    fs.mkdirSync(competitionsDir, { recursive: true })
    const disk = fs.statfsSync(competitionsDir)
    return disk.bavail * disk.bsize
  } catch {
    return null
  }
}

/**
 * Store one uploaded file of `runner`'s attempt, or throw an UploadRefusal
 * (or the contract's RemoteProtocolError for headers that do not parse) —
 * before reading a byte of the body for every refusal that does not need
 * the body to be told.
 */
export async function receiveUpload(req: Request, runner: RunnerRow, attemptId: string, name: string): Promise<RemoteUploadReply> {
  const lease = getLease(attemptId)
  if (!lease || lease.runnerId !== runner.id) throw new UploadRefusal('not_found', 'No such attempt on this machine')
  const meta = parseRemoteUploadMeta({
    name,
    encoding: req.headers['content-encoding'],
    sha256: req.headers[REMOTE_SHA256_HEADER.toLowerCase()],
    bytes: req.headers[REMOTE_BYTES_HEADER.toLowerCase()],
  }, lease.manifest.limits.targetBytes)
  if (!UPLOADING.has(lease.state)) return repeatAfterOutcome(lease, meta)
  // The same file again (a reply that was lost): already here whole, nothing to read.
  if (stagedWhole(attemptId, meta)) {
    uploadCounts.repeated++
    return meta
  }
  const slots = runnerUploadsSetting().value
  if ((activeBy.get(runner.id) ?? 0) >= machineShare(slots)) {
    uploadCounts.busy++
    throw new UploadRefusal('busy', "This machine's uploads are at its share of the limit", 2)
  }
  if (active >= slots) {
    uploadCounts.busy++
    throw new UploadRefusal('busy', 'Uploads are at their limit', 2)
  }
  if (!fitsRoom(attemptId, meta.name, meta.bytes, attemptRoomBytes(lease.manifest.limits.targetBytes))) {
    uploadCounts.refused++
    throw new UploadRefusal('too_large', 'The attempt has staged all its two files may take')
  }
  const free = freeBytes()
  if (free !== null && free < (active + 1) * REMOTE_UPLOAD_FREE_BYTES) throw new UploadRefusal('disk', 'Too little free disk for results', 30)
  active++
  activeBy.set(runner.id, (activeBy.get(runner.id) ?? 0) + 1)
  noteDeclared(attemptId, meta.name, meta.bytes, true)
  try {
    await store(req, attemptId, meta)
    uploadCounts.stored++
    return meta
  } finally {
    active--
    const mine = (activeBy.get(runner.id) ?? 1) - 1
    if (mine > 0) activeBy.set(runner.id, mine)
    else activeBy.delete(runner.id)
    noteDeclared(attemptId, meta.name, meta.bytes, false)
  }
}

/**
 * An upload after the outcome was applied: the agent repeats a PUT whose
 * reply it never got. The file the outcome listed with this name and hash
 * is answered as stored; anything else is refused — the attempt is settled,
 * or it was cancelled, erased or lost, and the agent discards it.
 */
function repeatAfterOutcome(lease: LeaseRow, meta: RemoteUploadReply): RemoteUploadReply {
  const outcome = lease.outcome as { files?: { name: string; sha256: string; bytes: number }[] } | null
  const listed = outcome?.files?.some((file) => file.name === meta.name && file.sha256 === meta.sha256 && file.bytes === meta.bytes)
  if ((lease.state === 'applying' || lease.state === 'applied') && listed) return meta
  uploadCounts.refused++
  throw new UploadRefusal(lease.state === 'applying' || lease.state === 'applied' ? 'conflict' : 'revoked', 'The attempt is over')
}

/** How far a compressed body may run past its file's own length: gzip of incompressible bytes grows by a few per thousand. */
const compressedCap = (bytes: number): number => bytes + Math.ceil(bytes / 100) + 64 * 1024

async function store(req: Request, attemptId: string, meta: RemoteUploadReply): Promise<void> {
  const dir = stagingDir(attemptId)
  competitionsFs.mkdirSync(dir, { recursive: true })
  const part = path.join(dir, `${meta.name}.${randomUUID()}.part`)
  const fd = competitionsFs.openSync(part, 'w', 0o600)
  try {
    await receiveGzip(req, fd, meta)
    keep(attemptId, meta, part)
  } catch (error) {
    try { competitionsFs.rmSync(part, { force: true }) } catch { /* the sweep removes it */ }
    uploadCounts.refused++
    throw error
  }
}

/**
 * A gzipped body into `fd`, checked against what its headers said: at most
 * `bytes` decompressed (decompression stops one byte past it), its sha256
 * `sha256`, its compressed length within compressedCap, and a body that sends
 * nothing for uploadStallMs ended. `fd` is closed here, once no write queued
 * to it may still run, however it ends. Throws an UploadRefusal (or the
 * contract's RemoteProtocolError) for what the machine sent; the caller
 * removes what was written. `pace`: the bucket the compressed bytes are read
 * through (a class's files, upload.ts · receiveClassFile).
 */
async function receiveGzip(req: Request, fd: number, meta: { sha256: string; bytes: number }, pace?: Transform): Promise<void> {
  const hash = createHash('sha256')
  let compressed = 0
  let plain = 0
  /*
   * A body that sends nothing for uploadStallMs is ended: its slot is one of
   * the instance's few, and a machine gone mid-upload (or one holding the
   * slot on purpose) must not keep it until Node's request timeout.
   */
  const stall = setTimeout(() => {
    uploadCounts.stalled++
    body.destroy(Object.assign(new Error('The upload sent nothing for too long'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))
  }, uploadStallMs)
  stall.unref?.()
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      stall.refresh()
      compressed += chunk.length
      if (compressed > compressedCap(meta.bytes)) return done(new UploadRefusal('too_large', 'The compressed body is longer than its file could be'))
      done(null, chunk)
    },
  })
  const unzipped = new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      plain += chunk.length
      // One byte past the declared length is proof enough: decompression stops here.
      if (plain > meta.bytes) return done(new UploadRefusal('too_large', 'The file is longer than it was declared'))
      hash.update(chunk)
      done(null, chunk)
    },
  })
  /*
   * THE DESCRIPTOR OUTLIVES EVERY WRITE GIVEN TO IT. pipeline() rejects the
   * moment a stream fails, and destroys the sink without waiting for a write
   * still queued in the thread pool (fs.WriteStream waits; a bare Writable
   * does not). Closed at once, the descriptor's number went to the next file
   * opened — another upload's part — and the queued write landed there: a
   * whole, honest answer staged 64 KiB longer than it was, its outcome refused
   * and its run counted lost against a healthy machine. So every write and the
   * fsync are counted while they are queued, and the descriptor is closed only
   * once none is (drained), whichever way the pipeline ended.
   */
  let queued = 0
  const waiting: Array<() => void> = []
  const settle = (): void => {
    queued--
    if (queued === 0) for (const resolve of waiting.splice(0)) resolve()
  }
  const drained = (): Promise<void> => (queued === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve)))
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      queued++
      fs.write(fd, chunk, 0, chunk.length, null, (error) => {
        settle()
        done(error ?? null)
      })
    },
    final(done) {
      // On disk before it is renamed into its name: a crash after the rename must find the bytes it promised.
      queued++
      fs.fsync(fd, (error) => {
        settle()
        done(error ?? null)
      })
    },
  })
  /*
   * The body is read through a stream of its own, never the request itself:
   * pipeline destroys every stream it was given once one of them fails, and
   * a request destroyed halfway through its body resets the connection. Then
   * a refusal found in the middle of the body — past its declared length, not
   * gzip at all, longer compressed than its file could be — never reached
   * the machine: it saw a reset, took it for the path's hiccup, and sent the
   * same upload again for ever. Now the request is only unpiped and left
   * paused; the router answers the refusal, marked, and lets go of the rest
   * of the body after the answer (routes.ts · lingerAfter).
   */
  const body = new PassThrough()
  // A connection cut halfway ends the read as the request itself would have: pipe() passes on no error, and an upload slot must never wait for a body that is not coming.
  req.once('error', (error) => body.destroy(error))
  req.once('close', () => {
    if (!req.complete) body.destroy(Object.assign(new Error('The upload was cut short'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))
  })
  req.pipe(body)
  let failure: unknown = null
  try {
    if (pace) await pipeline(body, pace, counted, zlib.createGunzip({ chunkSize: 64 * 1024 }), unzipped, sink)
    else await pipeline(body, counted, zlib.createGunzip({ chunkSize: 64 * 1024 }), unzipped, sink)
  } catch (error) {
    failure = error
    req.unpipe(body)
    req.pause()
  } finally {
    clearTimeout(stall)
  }
  // Never closed while a write queued to it may still run: that write would land in whatever file gets the number next.
  await drained()
  try { fs.closeSync(fd) } catch { /* nothing left to close */ }
  try {
    if (failure !== null) throw failure
    if (plain !== meta.bytes || hash.digest('hex') !== meta.sha256) throw new UploadRefusal('mismatch', 'The file is not what its headers said')
  } catch (error) {
    if (error instanceof UploadRefusal || error instanceof RemoteProtocolError) throw error
    // zlib's own refusal of what is not gzip, or a body cut short: the file is not what was declared.
    if ((error as { code?: string }).code?.startsWith('Z_')) throw new UploadRefusal('mismatch', 'The body is not gzip')
    throw error
  }
}

/* ----------------------------------------------------- a class's files */

/** A class's files coming home now, by machine (REMOTE_CLASS_UPLOADS each, beside the submissions' slots). */
const classActive = new Map<string, number>()
export const classUploadCounts = { stored: 0, refused: 0, busy: 0 }

/** Free bytes for the volume the class folders live on, or `null` — unknown, which is no reason to refuse. */
function freeBytesOf(volume: string): number | null {
  try {
    const disk = fs.statfsSync(volume)
    return disk.bavail * disk.bsize
  } catch {
    return null
  }
}

/**
 * A file of a class's folder copy coming home (PUT rooms/…/files, §8.3,
 * kernel/remote/files.ts decides which and where): gzipped and checked like a
 * result (receiveGzip), read through the class bucket (classUploadPace), at
 * most REMOTE_CLASS_UPLOADS at once per machine — slots of their own, so a
 * class's dataset never keeps a submission's result waiting — and refused
 * below REMOTE_UPLOAD_FREE_BYTES of free disk. `open` gives the descriptor of
 * the staging file it is written to (a temporary name in the class folder),
 * called only once the upload may go ahead.
 */
export async function receiveClassFile(req: Request, runnerId: string, file: { open: () => number; sha256: string; bytes: number; volume: string }): Promise<void> {
  if ((classActive.get(runnerId) ?? 0) >= REMOTE_CLASS_UPLOADS) {
    classUploadCounts.busy++
    throw new UploadRefusal('busy', "This machine's class files are at their limit", 2)
  }
  const free = freeBytesOf(file.volume)
  if (free !== null && free < REMOTE_UPLOAD_FREE_BYTES + file.bytes) throw new UploadRefusal('disk', 'Too little free disk for class files', 30)
  classActive.set(runnerId, (classActive.get(runnerId) ?? 0) + 1)
  try {
    const fd = file.open()
    await receiveGzip(req, fd, file, classUploadPace.transform())
    classUploadCounts.stored++
  } catch (error) {
    classUploadCounts.refused++
    throw error
  } finally {
    const left = (classActive.get(runnerId) ?? 1) - 1
    if (left > 0) classActive.set(runnerId, left)
    else classActive.delete(runnerId)
  }
}

/** For tests: a class's files coming home now, from one machine. */
export function activeClassUploads(runnerId: string): number {
  return classActive.get(runnerId) ?? 0
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/

/**
 * PUT rooms/:sessionId/files?path=&gen= (remote-classes.md §8.3, §15): a
 * file this server pulled from a class's folder copy (kernel/remote/files.ts
 * · pullFor), gzipped, its X-Colloq-Sha256 and X-Colloq-Bytes checked after
 * decompression, staged under a temporary name at the top of the class
 * folder (the anchored file system: never through a link, never outside the
 * folder), then put in place by the same compare-and-swap as a report's
 * (landPulled). Refused before a byte is read: a fenced gen (409
 * `revoked`, which the agent drops), a file or a version this server did not
 * ask for (404), past its cap (413), the machine's class upload slots taken
 * (503), the disk below its floor (507).
 */
export async function receiveRoomFile(req: Request, runner: RunnerRow, sessionId: string, query: { path: unknown; gen: unknown }): Promise<RoomFileStored> {
  const where = typeof query.path === 'string' ? query.path : ''
  const gen = typeof query.gen === 'string' && /^[1-9][0-9]{0,15}$/.test(query.gen) ? Number(query.gen) : null
  if (where === '' || normalizePath(where) !== where || gen === null) throw new RemoteProtocolError('Invalid path or gen of a class file')
  const encoding = req.headers['content-encoding']
  const sha256 = req.headers[REMOTE_SHA256_HEADER.toLowerCase()]
  const declared = req.headers[REMOTE_BYTES_HEADER.toLowerCase()]
  if (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'gzip' || typeof sha256 !== 'string' || !REMOTE_SHA256.test(sha256)
    || typeof declared !== 'string' || !DECIMAL.test(declared)) throw new RemoteProtocolError('Invalid headers of a class file')
  const bytes = Number(declared)
  const files = classFiles()
  let target: string
  try {
    target = files.pullFor(runner.id, sessionId, where, gen, sha256, bytes).target
  } catch (error) {
    throw refusalOf(error)
  }
  if (!resolveInSession(sessionId, target)) throw new UploadRefusal('not_found', 'The file has no place in the class folder')
  let tmp: string | null = null
  try {
    /*
     * Staged at the top of the class folder, which always is there: the
     * target's folders are made only when the checked bytes land
     * (kernel/remote/files.ts · place), so a refused upload leaves no empty
     * folder in the room's tree, and none of its pushes to the machine.
     */
    tmp = tempNameIn(sessionDir(sessionId))
    const staged = tmp
    const open = (): number => workspaceFs.openSync(staged, 'wx', 0o664)
    await receiveClassFile(req, runner.id, { open, sha256, bytes, volume: config.workspaceDir })
    const verdict = await files.landPulled(runner.id, sessionId, gen, where, sha256, staged)
    return { path: where, sha256, bytes, verdict }
  } catch (error) {
    throw refusalOf(error)
  } finally {
    // Renamed into place, or not wanted: either way no temporary name stays behind (the sweep takes one a crash left).
    if (tmp !== null) {
      try { workspaceFs.rmSync(tmp, { force: true }) } catch { /* a parent swapped under it */ }
    }
  }
}

/** The class files' refusals in the contract's codes. */
function refusalOf(error: unknown): unknown {
  if (!(error instanceof PullRefused)) return error
  if (error.why === 'stale') return new UploadRefusal('revoked', error.message)
  if (error.why === 'over') return new UploadRefusal('too_large', error.message)
  return new UploadRefusal('not_found', error.message)
}

/**
 * A verified part into its staged name, in one synchronous turn: the lease
 * is asked once more (an outcome applied, or a cancel, while the body was
 * arriving: nothing is staged for an attempt that is over — the outcome
 * moves what it listed in the same kind of turn, apply.ts · finish), and the
 * other files staged under this name go — one completed file per name and
 * attempt, never one per hash.
 */
function keep(attemptId: string, meta: RemoteUploadReply, part: string): void {
  const lease = getLease(attemptId)
  if (!lease || !UPLOADING.has(lease.state)) {
    throw new UploadRefusal(lease?.state === 'applying' || lease?.state === 'applied' ? 'conflict' : 'revoked', 'The attempt ended while its file was arriving')
  }
  competitionsFs.renameSync(part, stagedPath(attemptId, meta.name, meta.sha256))
  for (const other of stagedFiles(attemptId)) {
    if (other.name !== meta.name || other.sha256 === meta.sha256) continue
    try {
      competitionsFs.rmSync(other.file, { force: true })
      uploadCounts.replaced++
    } catch {
      // The sweep removes it with the folder.
    }
  }
}

/** For tests: uploads being stored now, the instance's or one machine's. */
export function activeUploads(runnerId?: string): number {
  return runnerId === undefined ? active : (activeBy.get(runnerId) ?? 0)
}

/** For tests: how long a body may send nothing; `null` — as in production. */
export function useUploadStallMs(ms: number | null): void {
  uploadStallMs = ms ?? UPLOAD_STALL_MS
}
