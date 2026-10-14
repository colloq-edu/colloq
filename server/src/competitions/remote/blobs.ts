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
 * BANDWIDTH (§4.5). One token bucket for every blob together, at the owner's
 * «Скорость раздачи» (runnerBlobMBps): the relay and the tunnel carry the
 * class's rooms too, and a 150 MB dataset fetched by five machines at once
 * must not be felt in a lecture. One stream per machine and
 * REMOTE_BLOB_STREAMS for the instance; past them 429 with Retry-After. The
 * class archive (files.zip) is never used for this: its queue is the
 * class's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import {
  REMOTE_BLOB_STREAMS,
  REMOTE_BLOB_STREAMS_PER_RUNNER,
  REMOTE_SHA256,
  type RemoteWant,
} from '@shared/remote-runner'
import { db } from '../../db.js'
import { dependencyRoot } from '../../dependencies/files.js'
import { runnerBlobMBpsSetting } from '../settings.js'
import { competitionsFs, inputDir, NOTEBOOK_FILE, openDir, sealedDir } from '../storage.js'
import { liveLeases, remoteEvent, type RunnerRow } from './store.js'

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

/** Where a hash in a machine's scope is to be read from. */
type BlobSource =
  | { kind: 'open' | 'sealed'; competitionId: string; name: string }
  | { kind: 'notebook'; competitionId: string; submissionId: string }
  | { kind: 'wheel' }

/**
 * Where `hash` may be read from for `runner`, in order, if the hash is in its
 * scope; empty — it is not (404). Leases first: what a run needs now outranks
 * what is prefetched. The hidden test only while the machine is trusted.
 * Every source, not the first: the same bytes may be several competitions'
 * files, and the one replaced since is not the only one there is.
 */
function scopedSources(runner: RunnerRow, hash: string): BlobSource[] {
  const out: BlobSource[] = []
  const leases = liveLeases(runner.id)
  for (const lease of leases) {
    const m = lease.manifest
    const open = m.data.files.find((file) => file.sha256 === hash)
    if (open) out.push({ kind: 'open', competitionId: lease.competitionId, name: open.name })
    const sealed = runner.trusted && lease.sealed ? m.sealed?.files.find((file) => file.sha256 === hash) : undefined
    if (sealed) out.push({ kind: 'sealed', competitionId: lease.competitionId, name: sealed.name })
    if (m.notebook.sha256 === hash) out.push({ kind: 'notebook', competitionId: lease.competitionId, submissionId: lease.submissionId })
  }
  const want = wantScopes.get(runner.id)
  for (const file of want?.files.get(hash) ?? []) {
    if (!file.sealed || runner.trusted) out.push({ kind: file.sealed ? 'sealed' : 'open', competitionId: file.competitionId, name: file.name })
  }
  if (out.length > 0) return out
  const bundles = new Set([...(want?.bundles ?? []), ...leases.flatMap((lease) => (lease.manifest.bundle ? [lease.manifest.bundle.id] : []))])
  if (bundles.size > 0) {
    const sets = db.prepare('SELECT bundle_id FROM dependency_bundle_artifacts WHERE sha256 = ?').all(hash) as { bundle_id: string }[]
    if (sets.some((set) => bundles.has(set.bundle_id))) return [{ kind: 'wheel' }]
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

/** The descriptor if it is a regular file of `bytes` (when known); closed and `null` otherwise. */
function sized(fd: number, bytes: number | null): { fd: number; bytes: number } | null {
  const info = fs.fstatSync(fd)
  if (!info.isFile() || (bytes !== null && info.size !== bytes)) {
    fs.closeSync(fd)
    return null
  }
  return { fd, bytes: info.size }
}

/* ------------------------------------------------------------- the bucket */

/** How far the bucket may run ahead of its rate: a burst of a quarter of a second. */
const BURST_MS = 250
/** Theoretical arrival time of the next byte, ms (the generic cell rate algorithm). */
let tat = 0

/** How long `bytes` must wait to keep every blob together at the owner's rate. */
function reserve(bytes: number, now = Date.now()): number {
  const perMs = (runnerBlobMBpsSetting().value * 1024 * 1024) / 1000
  tat = Math.max(tat, now) + bytes / perMs
  return Math.max(0, tat - now - BURST_MS)
}

function throttled(): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      const wait = reserve(chunk.length)
      if (wait <= 0) return done(null, chunk)
      setTimeout(() => done(null, chunk), wait).unref?.()
    },
  })
}

/* ----------------------------------------------------------------- serving */

const streams = new Map<string, number>()
let total = 0
export const blobCounts = { bytes: 0, served: 0, refused: 0, gone: 0 }

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
  const sources = scopedSources(runner, hash)
  if (sources.length === 0) {
    blobCounts.refused++
    throw new BlobRefusal('not_found')
  }
  if ((streams.get(runner.id) ?? 0) >= REMOTE_BLOB_STREAMS_PER_RUNNER || total >= REMOTE_BLOB_STREAMS) {
    blobCounts.refused++
    throw new BlobRefusal('too_often', 5)
  }
  let source: BlobSource | null = null
  let file: { fd: number; bytes: number } | null = null
  for (const candidate of sources) {
    file = openSource(candidate, hash)
    if (file) {
      source = candidate
      break
    }
  }
  if (!file || !source) {
    blobCounts.gone++
    throw new BlobRefusal('gone')
  }
  const range = rangeOf(req.headers.range, file.bytes)
  if (range === 'bad') {
    fs.closeSync(file.fd)
    res.status(416).setHeader('Content-Range', `bytes */${file.bytes}`)
    res.json({ error: 'invalid', detail: 'Range not satisfiable' })
    return
  }
  streams.set(runner.id, (streams.get(runner.id) ?? 0) + 1)
  total++
  try {
    if (source.kind === 'sealed') noteSealedFetch(runner.id, source.competitionId, source.name, hash)
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
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done: TransformCallback) {
        blobCounts.bytes += chunk.length
        done(null, chunk)
      },
    })
    await pipeline(body, throttled(), counted, res).catch(() => {
      // The machine hung up mid-stream: it resumes with Range.
      body.destroy()
    })
    blobCounts.served++
  } finally {
    streams.set(runner.id, Math.max(0, (streams.get(runner.id) ?? 1) - 1))
    if ((streams.get(runner.id) ?? 0) === 0) streams.delete(runner.id)
    total = Math.max(0, total - 1)
  }
}

/** A trusted machine fetched a file of the hidden test: once per machine and file in its log (§6 "Audit"). */
const sealedSeen = new Set<string>()

function noteSealedFetch(runnerId: string, competitionId: string, name: string, hash: string): void {
  const key = `${runnerId}|${hash}`
  if (sealedSeen.has(key)) return
  if (sealedSeen.size > 10_000) sealedSeen.clear()
  sealedSeen.add(key)
  remoteEvent(runnerId, 'sealed_fetched', { detail: `${competitionId}/${name}` })
}

/** For tests: streams open now, the instance's and one machine's. */
export function openBlobStreams(runnerId?: string): number {
  return runnerId === undefined ? total : (streams.get(runnerId) ?? 0)
}

/** For tests: an empty bucket. */
export function resetBlobBucket(): void {
  tat = 0
}
