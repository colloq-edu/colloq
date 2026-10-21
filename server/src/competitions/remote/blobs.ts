/**
 * `GET blobs/<sha256>`: what a machine fetches by content hash (§4.2) — the
 * open data, the hidden test for a trusted machine, package wheels, and
 * submitted notebooks too big to ride inside their lease.
 *
 * IT RESOLVES BY CONSTRUCTION, never by path. A hash names a file only
 * through a database row this server wrote: an open or hidden-test row of
 * competition_files with that sha256, a wheel in dependency_artifacts, the
 * notebook of a lease. Nothing else is ever looked up, so `secret/`, the
 * metric's `score/` and `score-out/`, and `baseline/` cannot be reached however a hash is guessed —
 * the answers keep no hash at all (store.ts · putFile) — and a hash of
 * `solution.csv` or `metric.py` is simply not a blob.
 *
 * AND ONLY WITHIN THE MACHINE'S SCOPE: the manifests of the leases it holds,
 * and what its last sync reply asked it to hold (want). A hash outside both
 * is 404, as an unknown one is; a machine learns nothing about what else
 * this server keeps. The hidden test's hashes are in a machine's scope only
 * while it is trusted (decision 1), and every fetch of one is in its log.
 * A hash in scope whose file has since been replaced (a new upload of
 * train.csv) is 410: the next sync names the new one.
 *
 * BANDWIDTH (§4.5). One token bucket for every competition blob together, at
 * the owner's «Скорость раздачи» (runnerBlobMBps), and at «Раздача посылок во
 * время занятий» at most while a class lives on a machine: the relay and the
 * tunnel carry the class's rooms too, and a 150 MB dataset fetched by five
 * machines at once must not be felt in a lecture. A class's own files for its
 * copy on a machine (the `room` source, remote-classes.md §8.2) go through
 * buckets of their own (Pace, split by flow, §4.9), every one refilled
 * continuously with a small burst. One stream per machine and
 * REMOTE_BLOB_STREAMS for the instance; past them 429 with Retry-After. The
 * class archive (files.zip) is never used for this: its queue is the
 * class's.
 *
 * WHAT A RUN NEEDS NOW GOES FIRST, across machines too. A lease's own blobs —
 * its notebook when it is too big to ride inside the lease, a wheel of its
 * set from here — have one of the instance's streams kept for them that
 * prefetch never takes, and when even that one is taken a prefetch stream
 * is cut for them (the prefetcher resumes with Range). Three machines
 * prefetching a replaced dataset kept the other machines' leases at 429 until
 * their preparation ran out, and each lease came back as a decline of `data`
 * counted against a healthy machine. A lease still told to wait is marked
 * starved (starvedLease), and its decline for data is no refusal of the
 * machine's (release.ts · declineLease).
 *
 * A STREAM ENDS WHEN ITS MACHINE MAY NO LONGER HAVE IT, or no longer reads
 * it: the owner disconnects the machine (every stream) or stops trusting it
 * (the hidden test's), the machine asks for something else (its own newer
 * stream replaces the old one, never a 429 for it), or nothing has been
 * taken off it for BLOB_STALL_MS — a machine destroyed mid-download held its
 * stream, one of three for the whole instance, until TCP gave up a quarter
 * of an hour later.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import {
  REMOTE_BLOB_STREAMS,
  REMOTE_BLOB_STREAMS_PER_RUNNER,
  REMOTE_RUN_MS_MAX,
  REMOTE_SHA256,
  type RemoteWant,
} from '@shared/remote-runner'
import { CLASS_BULK_IDLE_MBPS, CLASS_BULK_PROMOTED_MBPS, CLASS_PACE_BURST_BYTES } from '@shared/remote-kernels'
import { db } from '../../db.js'
import { classMachineSettings } from '../../admin/resource-settings.js'
import { cachedSha256, dependencyRoot } from '../../dependencies/files.js'
import { clientAddress } from '../../net/inbound.js'
import { tooOften } from '../../net/too-often.js'
import { resolveInSession, workspaceFs } from '../../workspace.js'
import { classFiles } from '../../kernel/remote/files.js'
import { runnerBlobMBpsSetting } from '../settings.js'
import { competitionsFs, inputDir, NOTEBOOK_FILE, openDir, sealedDir } from '../storage.js'
import { classPlacementsLive, lastSync, runnerCards, wantedBefore } from './heard.js'
import { liveLeases, remoteEvent, type RunnerRow } from './store.js'
import { homeStock, runnerWant } from './want.js'

/* ------------------------------------------------------------------ scope */

/**
 * What a machine's last sync reply asked it to hold: the data files by hash —
 * EVERY file that has the hash, not one of them: two competitions may hold
 * the very same file (one task for two groups, a hidden-test copy), and one
 * of them replacing its copy must not make the other's 410, which the machine
 * would ask about again at every want, for a file it still needs — and the
 * package sets by id.
 */
interface WantScope {
  files: Map<string, Array<{ competitionId: string; name: string; sealed: boolean }>>
  bundles: Set<string>
}

const wantScopes = new Map<string, WantScope>()

/** Called with every sync reply (routes.ts): the blobs its `want` names become fetchable for that machine. */
export function noteWantScope(runnerId: string, want: RemoteWant): void {
  const files = new Map<string, Array<{ competitionId: string; name: string; sealed: boolean }>>()
  for (const entry of want.data) {
    for (const file of entry.files) {
      const sources = files.get(file.sha256) ?? []
      sources.push({ competitionId: entry.competitionId, name: file.name, sealed: entry.sealed })
      files.set(file.sha256, sources)
    }
  }
  wantScopes.set(runnerId, { files, bundles: new Set(want.bundles.map((bundle) => bundle.id)) })
}

export function forgetWantScope(runnerId: string): void {
  wantScopes.delete(runnerId)
}

/**
 * A MACHINE'S SCOPE OUTLIVES THIS SERVER'S RESTART. The want a machine was
 * last asked for lived only in memory, filled when a sync reply went out, and
 * a machine whose download came back before its first sync of the new life
 * (each waits out a backoff of its own) was refused what it had been asked to
 * hold: 404, which the agent does not ask again for five minutes — no data,
 * and none of the competition's work, for five minutes after a routine
 * update. So a machine this life has answered no sync of yet has its scope
 * worked out on the spot, from what outlives the process: the competitions
 * this server would want it to hold now (want.ts · homeStock and runnerWant,
 * as its next reply will say them), its trust and its cards as its row keeps
 * them, and its live leases — exactly what that reply's want will name.
 */
async function scopeOf(runner: RunnerRow): Promise<WantScope | null> {
  const known = wantScopes.get(runner.id)
  if (known) return known
  const stock = await homeStock().catch(() => null)
  // A reply may have gone out while the stock was being worked out: its want is the machine's word for now.
  const replied = wantScopes.get(runner.id)
  if (replied) return replied
  if (!stock) return null
  const want = runnerWant({
    stock,
    trusted: runner.trusted,
    cards: runnerCards(runner).length > 0,
    sync: lastSync(runner.id),
    leases: liveLeases(runner.id),
    wantedBefore: wantedBefore(runner.id),
  })
  noteWantScope(runner.id, want.want)
  return wantScopes.get(runner.id) ?? null
}

/** Where a hash in a machine's scope is to be read from, and for which of its leases when a lease needs it (`lease`, its attempt). */
type BlobSource =
  | { kind: 'open' | 'sealed'; competitionId: string; name: string; lease?: string }
  | { kind: 'notebook'; competitionId: string; submissionId: string; lease: string }
  | { kind: 'wheel'; lease?: string }
  /** A class's file a push of its copy names (remote-classes.md §8.2): `promoted` — a run waits on it. */
  | { kind: 'room'; sessionId: string; path: string; bytes: number; promoted: boolean; lease?: undefined }

/*
 * THE `room` SOURCE (§15): a file of a class placed on the machine, named by
 * hash by an unacked push of the class's copy there, and nothing else — a
 * hash of any other file of any class is 404 for it, as one of no class is
 * (kernel/remote/files.ts · blobFor). Its bytes moving are the progress a run
 * at that class's barrier waits for (noteServed); a file rewritten here since
 * its push named it is 410, and its push is planned again (blobGone).
 */
const roomBlobs = {
  blobFor: (runnerId: string, hash: string) => classFiles().blobFor(runnerId, hash),
  noteServed: (runnerId: string, hash: string, bytes: number) => classFiles().noteServed(runnerId, hash, bytes),
  blobGone: (runnerId: string, hash: string) => classFiles().blobGone(runnerId, hash),
}

/**
 * Where `hash` may be read from for `runner`, in order, if the hash is in its
 * scope; empty — it is not (404). Leases first: what a run needs now outranks
 * what is prefetched. The hidden test only while the machine is trusted.
 * Every source, not the first: the same bytes may be several competitions'
 * files, and the one replaced since is not the only one there is.
 */
function scopedSources(runner: RunnerRow, hash: string, want: WantScope | null): BlobSource[] {
  const out: BlobSource[] = []
  // A class's file for its copy on this machine: never beside a lease's (a hash of either names one content).
  const room = runner.classes ? roomBlobs.blobFor(runner.id, hash) : null
  if (room) return [{ kind: 'room', ...room }]
  const leases = liveLeases(runner.id)
  for (const lease of leases) {
    const m = lease.manifest
    const open = m.data.files.find((file) => file.sha256 === hash)
    if (open) out.push({ kind: 'open', competitionId: lease.competitionId, name: open.name, lease: lease.attemptId })
    const sealed = runner.trusted && lease.sealed ? m.sealed?.files.find((file) => file.sha256 === hash) : undefined
    if (sealed) out.push({ kind: 'sealed', competitionId: lease.competitionId, name: sealed.name, lease: lease.attemptId })
    if (m.notebook.sha256 === hash) out.push({ kind: 'notebook', competitionId: lease.competitionId, submissionId: lease.submissionId, lease: lease.attemptId })
  }
  for (const file of want?.files.get(hash) ?? []) {
    if (!file.sealed || runner.trusted) out.push({ kind: file.sealed ? 'sealed' : 'open', competitionId: file.competitionId, name: file.name })
  }
  if (out.length > 0) return out
  const leased = new Map(leases.flatMap((lease) => (lease.manifest.bundle ? [[lease.manifest.bundle.id, lease.attemptId] as const] : [])))
  const bundles = new Set([...(want?.bundles ?? []), ...leased.keys()])
  if (bundles.size > 0) {
    const sets = db.prepare('SELECT bundle_id FROM dependency_bundle_artifacts WHERE sha256 = ?').all(hash) as { bundle_id: string }[]
    const of = sets.find((set) => leased.has(set.bundle_id)) ?? sets.find((set) => bundles.has(set.bundle_id))
    if (of) return [{ kind: 'wheel', ...(leased.has(of.bundle_id) ? { lease: leased.get(of.bundle_id)! } : {}) }]
  }
  return []
}

/** A source resolved to an open file of the expected length; `null` — it has been replaced or is gone (410). */
function openSource(source: BlobSource, hash: string): { fd: number; bytes: number } | null {
  try {
    if (source.kind === 'open' || source.kind === 'sealed') {
      const row = db.prepare('SELECT bytes, sha256 FROM competition_files WHERE competition_id = ? AND visibility = ? AND name = ?')
        .get(source.competitionId, source.kind, source.name) as { bytes: number; sha256: string | null } | undefined
      if (!row || row.sha256 !== hash) return null
      const dir = source.kind === 'open' ? openDir(source.competitionId) : sealedDir(source.competitionId)
      const held = competitionsFs.openRead(path.join(dir, source.name))
      return sized(held.fd, row.bytes)
    }
    if (source.kind === 'notebook') {
      const held = competitionsFs.openRead(path.join(inputDir(source.competitionId, source.submissionId), NOTEBOOK_FILE))
      return sized(held.fd, null)
    }
    const row = db.prepare('SELECT bytes FROM dependency_artifacts WHERE sha256 = ?').get(hash) as { bytes: number } | undefined
    if (!row) return null
    const fd = fs.openSync(path.join(dependencyRoot, 'artifacts', hash), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    return sized(fd, row.bytes)
  } catch {
    return null
  }
}

/**
 * A class's file for its copy (the `room` source), opened through the
 * anchored file system (never through a link, never outside the class
 * folder), of the length its push named, and of its hash still: a file
 * rewritten here since its push is not the blob asked for (410, and the push
 * is planned again).
 */
async function openRoomSource(source: Extract<BlobSource, { kind: 'room' }>, hash: string): Promise<{ fd: number; bytes: number } | null> {
  const full = resolveInSession(source.sessionId, source.path)
  if (!full) return null
  let held: ReturnType<typeof workspaceFs.openRead>
  try {
    held = workspaceFs.openRead(full)
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(held.fd)
    if (!stat.isFile() || stat.size !== source.bytes) {
      held.close()
      return null
    }
    const sha = await cachedSha256(full, stat, () => fs.createReadStream('', { fd: held.fd, start: 0, autoClose: false }))
    if (sha !== hash) {
      held.close()
      return null
    }
    return { fd: held.fd, bytes: stat.size }
  } catch {
    held.close()
    return null
  }
}

/** The descriptor if it is a regular file of `bytes` (when known); closed and `null` otherwise. */
function sized(fd: number, bytes: number | null): { fd: number; bytes: number } | null {
  const info = fs.fstatSync(fd)
  if (!info.isFile() || (bytes !== null && info.size !== bytes)) {
    fs.closeSync(fd)
    return null
  }
  return { fd, bytes: info.size }
}

/* ------------------------------------------------------------ the buckets */

/** How far a bucket may run ahead of its rate: a burst of a quarter of a second, and never more than PACE_BURST_BYTES. */
const BURST_MS = 250
/**
 * THE BURST OF A BUCKET, at most (remote-classes.md §4.9, K0): a class's
 * kernels and every student share the one leg between the relay and this
 * server, and K0 measured what bursts cost there — paced smoothly at 4 MiB/s
 * a 150 MB transfer leaves the tunnel's p95 where it was, sent in
 * one-second bursts at the same rate it adds a third and a p99 above a
 * second. So every bucket refills continuously and lets at most this much go
 * ahead of its rate.
 */
export const PACE_BURST_BYTES = CLASS_PACE_BURST_BYTES

/**
 * A token bucket by the generic cell rate algorithm: continuous refill at
 * `rate()` bytes a second (read at every chunk: the owner's numbers are
 * live), a burst of at most min(BURST_MS of it, PACE_BURST_BYTES).
 */
export class Pace {
  /** Theoretical arrival time of the next byte, ms. */
  private tat = 0

  constructor(private readonly rate: () => number) {}

  /** How long `bytes` must wait to keep this flow at its rate. */
  reserve(bytes: number, now = Date.now()): number {
    const perMs = Math.max(1, this.rate()) / 1000
    this.tat = Math.max(this.tat, now) + bytes / perMs
    return Math.max(0, this.tat - now - Math.min(BURST_MS, PACE_BURST_BYTES / perMs))
  }

  reset(): void {
    this.tat = 0
  }

  /** A stream that lets its chunks through at the bucket's rate. */
  transform(onChunk?: (bytes: number) => void): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, done: TransformCallback) => {
        onChunk?.(chunk.length)
        const wait = this.reserve(chunk.length)
        if (wait <= 0) return done(null, chunk)
        setTimeout(() => done(null, chunk), wait).unref?.()
      },
    })
  }
}

const MiB = 1024 * 1024

/**
 * THE BUCKET IS SPLIT BY FLOW (§4.9, D18). Competition blobs keep the
 * owner's «Скорость раздачи», and while any class lives on a machine they go
 * at «Раздача посылок во время занятий» at most; a class's files go to its
 * machine at «Файлы занятий» (classBulkMBps), and a push a run waits on at
 * CLASS_BULK_PROMOTED_MBPS; a class's files coming home are read at
 * classBulkMBps (upload.ts · receiveClassFile).
 */
export const competitionPace = new Pace(() => {
  const own = runnerBlobMBpsSetting().value
  return (classPlacementsLive() ? Math.min(own, classMachineSettings().competitionMBps) : own) * MiB
})
export const roomPace = new Pace(() => classMachineSettings().classBulkMBps * MiB)
export const promotedPace = new Pace(() => Math.max(classMachineSettings().classBulkMBps, CLASS_BULK_PROMOTED_MBPS) * MiB)
export const classUploadPace = new Pace(() => (classPlacementsLive() ? classMachineSettings().classBulkMBps : CLASS_BULK_IDLE_MBPS) * MiB)

/* ----------------------------------------------------------------- serving */

/** One blob response under way. */
interface OpenStream {
  runnerId: string
  /** It serves a file of the hidden test: an untrust cuts it. */
  sealed: boolean
  /** The lease whose blob it is (its attempt); `null` — prefetch for the want, or a class's file. */
  lease: string | null
  /** A run waits on it (a lease's blob, a class file of a promoted push): never cut for another's. */
  urgent: boolean
  /** Still counted against the streams: one cut is counted out at once, not when its socket closes. */
  counted: boolean
  res: Response
}

const open = new Set<OpenStream>()
/** Streams counted against REMOTE_BLOB_STREAMS now. */
let total = 0
/** Of the instance's streams, how many prefetch may never take: they are the leases'. */
const LEASE_STREAMS = 1
/** How long a stream may go with nothing taken off it before it is cut (useBlobStallMs for tests). */
const BLOB_STALL_MS = 45_000
let stallMs = BLOB_STALL_MS
export const blobCounts = { bytes: 0, served: 0, refused: 0, gone: 0, cut: 0, stalled: 0 }

function countOut(stream: OpenStream): void {
  if (!stream.counted) return
  stream.counted = false
  total = Math.max(0, total - 1)
}

/** End a stream now: counted out at once, its socket destroyed (the machine resumes with Range, if it still may). */
function cutStream(stream: OpenStream, why: 'cut' | 'stalled' = 'cut'): void {
  countOut(stream)
  open.delete(stream)
  blobCounts[why]++
  stream.res.destroy()
}

/**
 * Cut the streams open to a machine: `all` — it was disconnected or left;
 * `sealed` — it is no longer trusted with the hidden test. Returns how many.
 */
export function cutBlobStreams(runnerId: string, which: 'all' | 'sealed'): number {
  let n = 0
  for (const stream of [...open]) {
    if (stream.runnerId !== runnerId || (which === 'sealed' && !stream.sealed)) continue
    cutStream(stream)
    n++
  }
  return n
}

/*
 * Leases this server told to wait for one of their own blobs (429 with every
 * stream taken by other leases): their decline for data is this server's
 * back-pressure, not the machine's refusal (release.ts · declineLease). By
 * attempt, for as long as any lease can live.
 */
const starved = new Map<string, number>()

/** The lease was told to wait for a blob of its own (the route's 429 below); exported for the tests of what such a decline costs. */
export function markStarved(attemptId: string, now = Date.now()): void {
  if (starved.size >= 10_000) starved.delete(starved.keys().next().value!)
  starved.set(attemptId, now)
}

/** Whether this server kept the lease waiting for a blob it needed (blobs of its own, 429). */
export function starvedLease(attemptId: string, now = Date.now()): boolean {
  const at = starved.get(attemptId)
  return at !== undefined && now - at <= REMOTE_RUN_MS_MAX
}

/** A refusal of a blob, with the router's code for it (REMOTE_ERRORS). */
export class BlobRefusal extends Error {
  constructor(readonly code: 'invalid' | 'not_found' | 'gone' | 'too_often', readonly retryAfterS?: number) {
    super(code)
  }
}

/** `Range: bytes=a-b` within `size`; `null` — none asked; `'bad'` — one asked that cannot be served. */
function rangeOf(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return 'bad'
  let start: number
  let end: number
  if (match[1] === '') {
    // The last N bytes.
    const tail = Number(match[2])
    start = Math.max(0, size - tail)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'bad'
  return { start, end }
}

/**
 * Serve one blob to `runner`, or throw a BlobRefusal before anything is
 * sent. Resumable with Range (a 200 MB dataset over a tunnel that drops is
 * fetched once, not once per drop); the ETag is the hash.
 */
export async function serveBlob(req: Request, res: Response, runner: RunnerRow, hash: string): Promise<void> {
  if (!REMOTE_SHA256.test(hash)) throw new BlobRefusal('invalid')
  const sources = scopedSources(runner, hash, await scopeOf(runner))
  if (sources.length === 0) {
    blobCounts.refused++
    throw new BlobRefusal('not_found')
  }
  const lease = sources.find((one) => one.lease !== undefined)?.lease ?? null
  const first = sources[0]!
  // What a run waits on now: a lease's own blob, or a class's file of a push its barrier promoted (§8.2).
  const urgent = lease !== null || (first.kind === 'room' && first.promoted)
  /*
   * The machine's own stream it no longer reads makes room for this one: an
   * agent runs one stream at a time, and its new request means it let the
   * old one go (its own lease's blob preempting its prefetch, cache.ts ·
   * enqueue). That old stream was counted until its socket's close crossed
   * the relay, and the new request, often there first, got 429 and five
   * seconds added to the lease.
   */
  const own = [...open].filter((stream) => stream.counted && stream.runnerId === runner.id)
  for (const stream of own.slice(0, Math.max(0, own.length - REMOTE_BLOB_STREAMS_PER_RUNNER + 1))) cutStream(stream)
  if (!urgent ? total >= REMOTE_BLOB_STREAMS - LEASE_STREAMS : total >= REMOTE_BLOB_STREAMS) {
    // A blob a run waits on takes the newest prefetch stream's place: the prefetcher resumes with Range.
    const prefetch = !urgent ? undefined : [...open].reverse().find((stream) => stream.counted && !stream.urgent)
    if (prefetch) cutStream(prefetch)
    else {
      if (lease !== null) markStarved(lease, Date.now())
      blobCounts.refused++
      throw new BlobRefusal('too_often', 5)
    }
  }
  let source: BlobSource | null = null
  let file: { fd: number; bytes: number } | null = null
  for (const candidate of sources) {
    file = candidate.kind === 'room' ? await openRoomSource(candidate, hash) : openSource(candidate, hash)
    if (file) {
      source = candidate
      break
    }
  }
  if (!file || !source) {
    blobCounts.gone++
    if (first.kind === 'room') roomBlobs.blobGone(runner.id, hash)
    throw new BlobRefusal('gone')
  }
  const range = rangeOf(req.headers.range, file.bytes)
  if (range === 'bad') {
    fs.closeSync(file.fd)
    res.status(416).setHeader('Content-Range', `bytes */${file.bytes}`)
    res.json({ error: 'invalid', detail: 'Range not satisfiable' })
    return
  }
  const stream: OpenStream = { runnerId: runner.id, sealed: source.kind === 'sealed', lease, urgent, counted: true, res }
  open.add(stream)
  total++
  // Nothing taken off the stream for stallMs: the machine is gone (no FIN crosses the relay from a destroyed VM), and its stream is freed.
  const stall = setTimeout(() => cutStream(stream, 'stalled'), stallMs)
  stall.unref?.()
  try {
    if (source.kind === 'sealed') noteSealedFetch(runner.id, source.competitionId, source.name, hash, clientAddress(req), range)
    const start = range?.start ?? 0
    const end = range?.end ?? file.bytes - 1
    res.status(range ? 206 : 200)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('ETag', `"${hash}"`)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Length', String(file.bytes === 0 ? 0 : end - start + 1))
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${file.bytes}`)
    if (file.bytes === 0) {
      fs.closeSync(file.fd)
      res.end()
      return
    }
    const body = fs.createReadStream('', { fd: file.fd, start, end, autoClose: true, highWaterMark: 64 * 1024 })
    const room = source.kind === 'room' ? source : null
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done: TransformCallback) {
        blobCounts.bytes += chunk.length
        // A chunk taken in is the stream moving: the stall's clock starts over.
        stall.refresh()
        // And a class's file moving is the progress its run's barrier waits for.
        if (room) roomBlobs.noteServed(runner.id, hash, chunk.length)
        done(null, chunk)
      },
    })
    // Each flow through its own bucket (§4.9): a class's files at their rate, a promoted push faster, the rest as the owner set.
    const pace = room ? (room.promoted ? promotedPace : roomPace) : competitionPace
    await pipeline(body, pace.transform(), counted, res).catch(() => {
      // The machine hung up mid-stream, or the stream was cut: it resumes with Range, if it still may.
      body.destroy()
    })
    blobCounts.served++
  } finally {
    clearTimeout(stall)
    countOut(stream)
    open.delete(stream)
  }
}

/*
 * EVERY FETCH OF THE HIDDEN TEST IS IN THE MACHINE'S LOG, WITH ITS ADDRESS
 * (§6 "Audit": the events log is what limits a stolen trusted secret). Once
 * per machine and file for the whole life of the process, and with no
 * address, a second fetch of the same file — the same credential from
 * somewhere else — left no trace at all. Now a line per machine, file and
 * address at most every SEALED_LINE_EVERY_MS (a resume after a dropped tunnel
 * is the same fetch, not a new line a second), with the range when one was
 * asked, and at most SEALED_LINES_PER_HOUR a machine: a fetch from a new
 * address is always written the first time.
 */
const SEALED_LINE_EVERY_MS = 10 * 60_000
const SEALED_LINES_PER_HOUR = 120
const sealedLines = new Map<string, number[]>()
const sealedPerRunner = new Map<string, number[]>()

function noteSealedFetch(runnerId: string, competitionId: string, name: string, hash: string, address: string | null, range: { start: number; end: number } | null): void {
  if (tooOften(sealedLines, `${runnerId}|${hash}|${address ?? '?'}`, SEALED_LINE_EVERY_MS, 1)) return
  if (tooOften(sealedPerRunner, runnerId, 60 * 60_000, SEALED_LINES_PER_HOUR)) return
  remoteEvent(runnerId, 'sealed_fetched', { address, detail: range ? `${competitionId}/${name} · ${range.start}-${range.end}` : `${competitionId}/${name}` })
}

/** For tests: streams counted now, the instance's and one machine's. */
export function openBlobStreams(runnerId?: string): number {
  return runnerId === undefined ? total : [...open].filter((stream) => stream.counted && stream.runnerId === runnerId).length
}

/** For tests: empty buckets, and the stall's limit as it is in production. */
export function resetBlobBucket(): void {
  for (const pace of [competitionPace, roomPace, promotedPace, classUploadPace]) pace.reset()
  stallMs = BLOB_STALL_MS
}

/** For tests: how long a stream may go with nothing taken off it. */
export function useBlobStallMs(ms: number): void {
  stallMs = ms
}
