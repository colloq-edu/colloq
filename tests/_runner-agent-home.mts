/**
 * A home and a Docker for a machine's agent, both fake, for the
 * runner-agent tests: no network beyond the loopback, no daemon.
 *
 * THE HOME speaks /api/runners/v1 (shared/remote-runner.ts) on a port of its
 * own: every reply carries the marker unless a test says otherwise (the
 * relay's page, frps's 504), blobs are served by hash with Range, uploads are
 * gunzipped and checked against their headers, and each call is recorded
 * with its headers, so a test can see where the secret went. A test answers
 * any call itself by setting the handler for it; the defaults answer as a
 * home with nothing to give would.
 *
 * AND IT READS EVERY REQUEST AS HOME DOES, with the contract's strict
 * parsers (parseRemoteJoinRequest, parseRemoteSyncRequest,
 * parseRemoteOutcomeRequest, parseRemoteUploadMeta) before any handler sees
 * it. One they refuse is answered as home's router answers it (400, or 426
 * for another protocol) and written down in `violations`, and close() fails
 * the test that made it. A conformance regression of the agent — a sync held
 * too long while busy, progress outside `running`, a card on an accepted
 * attempt, a decline over its cap — would turn every sync at a real home
 * into a 400 and lose every lease on the machine; here it fails the agent's
 * own tests. A test that sends a bad request on purpose takes the
 * violations it expects out of the list.
 *
 * THE DOCKER answers what the agent asks of its own (docker.ts): `info`, the
 * card probe, pulls, inspects and tags of revisions, the sweep of its check
 * containers and `update --restart=no`. The runs themselves never reach it:
 * the agent's tests hand it a runner stand-in (RunSeam), and the argv test
 * the real DockerCompetitionRunner with its own docker swapped.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  REMOTE_MARKER,
  REMOTE_MARKER_HEADER,
  REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_HEADER,
  RemoteProtocolError,
  parseRemoteJoinRequest,
  parseRemoteOutcomeRequest,
  parseRemoteSyncRequest,
  parseRemoteUploadMeta,
  remoteManifest,
  type RemoteLease,
  type RemoteOutcomeReply,
  type RemoteSyncReply,
  type RemoteSyncRequest,
  type RemoteDataFile,
} from '../shared/remote-runner.ts'
import { HARNESS_REVISION } from '../server/src/competitions/harness.ts'
import { layersFingerprint } from '../server/src/dependencies/image-identity.ts'
import type { DockerOptions, DockerResult } from '../server/src/runner-agent/docker.ts'
import type { RunSeam } from '../server/src/runner-agent/execute.ts'
import type { Capacity, RunOutcome, RunRequest } from '../server/src/competitions/runner-port.ts'

export const sha256 = (body: string | Uint8Array): string => createHash('sha256').update(body).digest('hex')
export const hex = (bytes: number): string => randomBytes(bytes).toString('hex')

/** What a test answers a call with. `marker: false` — a reply that is not home's (the relay's page, frps). */
export interface Reply {
  status?: number
  json?: unknown
  text?: string
  body?: Buffer
  marker?: boolean
  headers?: Record<string, string>
  /** Hold the reply this long first (a long-poll held at home). */
  delayMs?: number
  /** Send the body in these pieces, waiting before each (a slow link); the reply ends when `until` resolves after the last. */
  slow?: { pieces: Buffer[]; gapMs: number; until?: Promise<void> }
}

export interface Call {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: unknown
  raw: Buffer
}

type Handler<T> = (input: T, call: Call) => Reply | Promise<Reply>

export interface FakeHome {
  url: string
  calls: Call[]
  /** Blobs by hash, served with Range. */
  blobs: Map<string, Buffer>
  /** What each PUT stored: attempt → name → the file, gunzipped. */
  stored: Map<string, Map<string, Buffer>>
  onJoin: Handler<any>
  onSync: Handler<RemoteSyncRequest>
  onOutcome: Handler<{ attemptId: string; body: any }>
  onUpload: Handler<{ attemptId: string; name: string; sha256: string; bytes: number; file: Buffer }> | null
  onBlob: Handler<{ sha: string; range: string | undefined }> | null
  relay: { known: boolean; tunnel: boolean } | null
  /** Requests the contract's parsers refused, as `METHOD path: why`; close() fails while any is left here. */
  violations: string[]
  /** Sync requests, newest last. */
  syncs(): RemoteSyncRequest[]
  close(): Promise<void>
}

export const RUNNER_ID = 'runnerab'
export const SECRET = 'c'.repeat(64)

/** A sync reply with nothing in it but what a test puts there. */
export function syncReply(partial: Partial<RemoteSyncReply> = {}): RemoteSyncReply {
  return {
    seq: 0,
    leases: [],
    revoke: [],
    applied: [],
    want: { revisions: [], data: [], bundles: [] },
    forget: [],
    drain: false,
    trusted: false,
    approvedSlots: null,
    perDevice: 1,
    compatible: true,
    homeVersion: '0.24.0',
    ...partial,
  }
}

/** An outcome's reply with nothing in it but what a test puts there: applied, no next work, trusted as the default machine is not. */
export function outcomeReply(partial: Partial<RemoteOutcomeReply> = {}): RemoteOutcomeReply {
  return { result: 'applied', seq: 0, leases: [], trusted: false, ...partial }
}

export async function fakeHome(): Promise<FakeHome> {
  const calls: Call[] = []
  const home: FakeHome = {
    url: '',
    calls,
    blobs: new Map(),
    stored: new Map(),
    onJoin: () => ({ json: { runnerId: RUNNER_ID, secret: SECRET, trusted: false, approvedSlots: null } }),
    // Held a little, as home holds a long-poll: an agent answered at once would spin.
    onSync: () => ({ json: syncReply(), delayMs: 20 }),
    onOutcome: () => ({ json: outcomeReply() }),
    onUpload: null,
    onBlob: null,
    relay: null,
    violations: [],
    syncs: () => calls.filter((call) => call.path.endsWith('/sync')).map((call) => call.body as RemoteSyncRequest),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (home.violations.length > 0) throw new Error(`the agent sent requests home's parsers refuse:\n${home.violations.join('\n')}`)
    },
  }
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://home')
    let body: unknown = null
    if (req.headers['content-type']?.includes('json')) {
      try { body = JSON.parse(raw.toString('utf8')) } catch { body = null }
    }
    const call: Call = { method: req.method ?? '', path: url.pathname, headers: req.headers, body, raw }
    calls.push(call)
    let reply: Reply
    try {
      reply = await route(home, call, url, req)
    } catch (error) {
      reply = { status: 500, json: { error: 'failed', detail: String(error).slice(0, 200) } }
    }
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
    if (res.destroyed) return
    const headers: Record<string, string> = { ...(reply.headers ?? {}) }
    if (reply.marker !== false) {
      headers[REMOTE_MARKER_HEADER] = REMOTE_MARKER
      headers[REMOTE_PROTOCOL_HEADER] ??= String(REMOTE_PROTOCOL)
    }
    if (reply.json !== undefined) headers['Content-Type'] = 'application/json'
    res.writeHead(reply.status ?? 200, headers)
    if (reply.slow) {
      for (const piece of reply.slow.pieces) {
        await new Promise((resolve) => setTimeout(resolve, reply.slow!.gapMs))
        if (res.destroyed) return
        res.write(piece)
      }
      await reply.slow.until
      if (!res.destroyed) res.end()
      return
    }
    res.end(reply.body ?? (reply.json !== undefined ? JSON.stringify(reply.json) : reply.text ?? ''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  home.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return home
}

/**
 * A request through the contract's parser, as home's router reads it: null
 * when it parses; otherwise the refusal home's router would answer, and the
 * violation written down for close() to fail the test with.
 */
function conforming(home: FakeHome, call: Call, parse: () => unknown): Reply | null {
  try {
    parse()
    return null
  } catch (error) {
    if (!(error instanceof RemoteProtocolError)) throw error
    home.violations.push(`${call.method} ${call.path}: ${error.message}`)
    const status = error.code === 'protocol' ? 426 : error.code === 'too_large' ? 413 : 400
    return { status, json: { error: error.code, detail: error.message.slice(0, 300) } }
  }
}

async function route(home: FakeHome, call: Call, url: URL, req: http.IncomingMessage): Promise<Reply> {
  const at = url.pathname
  if (at === '/.relay/state') {
    return home.relay ? { json: home.relay, marker: false } : { status: 404, text: '<html>no such room</html>', marker: false }
  }
  const api = '/api/runners/v1/'
  if (!at.startsWith(api)) return { status: 404, text: 'not here', marker: false }
  const rest = at.slice(api.length)
  if (rest === 'join' && call.method === 'POST') return conforming(home, call, () => parseRemoteJoinRequest(call.body)) ?? home.onJoin(call.body, call)
  if (rest === 'sync' && call.method === 'POST') return conforming(home, call, () => parseRemoteSyncRequest(call.body)) ?? home.onSync(call.body as RemoteSyncRequest, call)
  const blob = /^blobs\/([a-f0-9]{64})$/.exec(rest)
  if (blob && call.method === 'GET') {
    const range = req.headers.range
    if (home.onBlob) return home.onBlob({ sha: blob[1]!, range }, call)
    return serveBlob(home.blobs.get(blob[1]!), range)
  }
  const file = /^attempts\/([a-f0-9]{32})\/files\/(submission\.csv|executed\.ipynb)$/.exec(rest)
  if (file && call.method === 'PUT') {
    // The upload's headers, as home's router checks them before a byte of the body (upload.ts · parseRemoteUploadMeta).
    const meta = { name: file[2], encoding: req.headers['content-encoding'], sha256: req.headers['x-colloq-sha256'], bytes: req.headers['x-colloq-bytes'] }
    const refused = conforming(home, call, () => parseRemoteUploadMeta(meta))
    if (refused) return refused
    const gunzipped = zlib.gunzipSync(call.raw)
    const declared = { sha256: String(req.headers['x-colloq-sha256'] ?? ''), bytes: Number(req.headers['x-colloq-bytes'] ?? -1) }
    if (sha256(gunzipped) !== declared.sha256 || gunzipped.length !== declared.bytes) return { status: 422, json: { error: 'mismatch' } }
    if (home.onUpload) {
      const answer = await home.onUpload({ attemptId: file[1]!, name: file[2]!, ...declared, file: gunzipped }, call)
      if ((answer.status ?? 200) !== 200 || answer.marker === false) return answer
    }
    const kept = home.stored.get(file[1]!) ?? new Map<string, Buffer>()
    kept.set(file[2]!, gunzipped)
    home.stored.set(file[1]!, kept)
    return { json: { name: file[2], sha256: declared.sha256, bytes: declared.bytes } }
  }
  const outcome = /^attempts\/([a-f0-9]{32})\/outcome$/.exec(rest)
  if (outcome && call.method === 'POST') return conforming(home, call, () => parseRemoteOutcomeRequest(call.body)) ?? home.onOutcome({ attemptId: outcome[1]!, body: call.body }, call)
  return { status: 404, json: { error: 'not_found' } }
}

/** A blob with Range, as home's blob route serves one; `undefined` — out of scope. */
export function serveBlob(body: Buffer | undefined, range: string | undefined): Reply {
  if (!body) return { status: 404, json: { error: 'not_found' } }
  const asked = /^bytes=(\d+)-$/.exec(range ?? '')
  if (!asked) return { status: 200, body, headers: { 'Content-Type': 'application/octet-stream' } }
  const start = Number(asked[1])
  if (start >= body.length) return { status: 416, json: { error: 'invalid', detail: 'range' } }
  return { status: 206, body: body.subarray(start), headers: { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Type': 'application/octet-stream' } }
}

/* ------------------------------------------------------------- leases */

export const REVISION = { id: 'a'.repeat(32), ref: `ghcr.io/colloq-edu/colloq-kernel@sha256:${'1'.repeat(64)}` }
export const DIFF_IDS = [`sha256:${'2'.repeat(64)}`, `sha256:${'3'.repeat(64)}`]
export const LAYERS = layersFingerprint('linux', 'amd64', DIFF_IDS)

/** Data files and the manifest they make, with the bytes for home's blob route. */
export function dataSet(files: Record<string, string>): { files: RemoteDataFile[]; manifest: string; bodies: Map<string, Buffer> } {
  const bodies = new Map<string, Buffer>()
  const list: RemoteDataFile[] = Object.entries(files).map(([name, text]) => {
    const body = Buffer.from(text)
    bodies.set(sha256(body), body)
    return { name, sha256: sha256(body), bytes: body.length }
  })
  return { files: list, manifest: remoteManifest(list, sha256), bodies }
}

export const NOTEBOOK = Buffer.from(JSON.stringify({ cells: [{ cell_type: 'code', source: 'print(1)', metadata: {}, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))

let leaseSeq = 0

/** A lease the contract's parser takes: a CPU run of a two-minute notebook by default. */
export function makeLease(partial: Partial<RemoteLease> & { data: string }): RemoteLease {
  const submissionId = partial.submissionId ?? 'subabcde'
  return {
    attemptId: hex(16),
    seq: ++leaseSeq,
    competitionId: 'compabcd',
    submissionId,
    container: `colloq-comp-${submissionId}-${hex(4)}-run`,
    deadlineMs: 30 * 60_000,
    revision: { id: REVISION.id, ref: REVISION.ref, layers: LAYERS },
    harness: HARNESS_REVISION,
    limits: { wallSeconds: 120, memoryMb: 2048, cpus: 2, pids: 256, fsizeBytes: 256 * 1024 * 1024, tmpfsMb: 256, targetBytes: 64 * 1024 * 1024, outputBytes: 2_000_000, outputKillBytes: 64 * 1024 * 1024 },
    sealed: false,
    gpu: false,
    notebook: { sha256: sha256(NOTEBOOK), bytes: NOTEBOOK.length, inline: NOTEBOOK.toString('base64') },
    ...partial,
  }
}

/* ------------------------------------------------------------- docker */

export interface FakeAgentDocker {
  (args: string[], options?: DockerOptions): Promise<DockerResult>
  calls: string[][]
  /** Images by name: what `image inspect` answers (their layers), and what a pull brings. */
  images: Map<string, { diffIds: string[] }>
  /** What a pull of a ref brings: its layers; absent — the pull fails. */
  registry: Map<string, { diffIds: string[] }>
  /** The card probe's answer; null — a machine without the NVIDIA runtime. */
  cards: string | null
  driver: string
  /** The GPU smoke test's answer. */
  smoke: DockerResult
  /**
   * What `stat -f` says in the throwaway container that measures Docker's own
   * disk (machine.ts · measureDockerDisk): one `fsid block free total` line for
   * the store, one for the tree; null — the measure fails (no such answer).
   */
  statfs: string | null
  /** Answer any call first (a promise holds it until the test says); nothing — go on. */
  intercept: ((args: string[]) => DockerResult | void | Promise<DockerResult | void>) | null
}

export function fakeAgentDocker(): FakeAgentDocker {
  const docker = (async (args: string[], options: DockerOptions = {}) => {
    docker.calls.push(args)
    const caught = await docker.intercept?.(args)
    if (caught) return caught
    const [command] = args
    if (command === 'info') {
      return { code: 0, out: JSON.stringify({ ServerVersion: '28.3.1', Driver: 'overlay2', Name: 'vast-4090-host', NCPU: 32, MemTotal: 64 * 1024 ** 3, OSType: 'linux', Architecture: 'x86_64', DockerRootDir: '/var/lib/docker' }) }
    }
    if (command === 'run' && args.includes('stat')) return docker.statfs === null ? { code: 125, out: 'docker: stat is not in this fake' } : { code: 0, out: docker.statfs }
    if (command === 'ps') return { code: 0, out: '' }
    if (command === 'update' || command === 'tag' || command === 'rmi' || command === 'rm') {
      if (command === 'tag') docker.images.set(args[2]!, docker.images.get(args[1]!) ?? { diffIds: DIFF_IDS })
      if (command === 'rmi') docker.images.delete(args[1]!)
      return { code: 0, out: '' }
    }
    if (command === 'inspect' && args[1] === '-f') return { code: 0, out: 'ghcr.io/colloq-edu/colloq-server:0.24.0' }
    if (command === 'image' && args[1] === 'inspect') {
      const image = docker.images.get(args[2]!)
      if (!image) return { code: 1, out: `Error: No such image: ${args[2]}` }
      return { code: 0, out: JSON.stringify([{ Os: 'linux', Architecture: 'amd64', RootFS: { Type: 'layers', Layers: image.diffIds }, RepoDigests: [args[2]] }]) }
    }
    if (command === 'pull') {
      const pulled = docker.registry.get(args[1]!)
      if (!pulled) return { code: 1, out: `Error response from daemon: manifest unknown: ${args[1]}` }
      for (const [index] of pulled.diffIds.entries()) options.onLine?.(`${String(index).repeat(12)}: Pull complete`)
      docker.images.set(args[1]!, pulled)
      return { code: 0, out: 'Status: Downloaded newer image' }
    }
    if (command === 'run' && args.includes('nvidia-smi')) {
      if (docker.cards === null) return { code: 125, out: 'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].' }
      if (args.some((arg) => arg.startsWith('--query-gpu=driver_version'))) return { code: 0, out: `${docker.driver}\n` }
      return { code: 0, out: docker.cards }
    }
    if (command === 'run' && args.includes('python')) return docker.smoke
    return { code: 1, out: `fake docker: ${args.join(' ')}` }
  }) as FakeAgentDocker
  docker.calls = []
  docker.images = new Map()
  docker.registry = new Map()
  docker.cards = null
  docker.driver = '580.65.06'
  docker.smoke = { code: 0, out: 'cuda-ok 13.0' }
  docker.statfs = null
  docker.intercept = null
  return docker
}

/* ------------------------------------------------------------- the run */

/**
 * The runner stand-in a machine's tests give the agent: it writes what the
 * harness's export would (run.json, the answer, the executed notebook) into
 * the attempt's result folder and says how the run went, or waits until it
 * is told to finish or its signal aborts (a revoke, a stop).
 */
export class FakeSeam implements RunSeam {
  runs: RunRequest[] = []
  sweeps = 0
  /** What the next runs come to; `wait` — until release() or the signal. */
  next: 'ok' | 'wait' | 'cell_error' = 'ok'
  private releases: Array<() => void> = []

  async run(request: RunRequest): Promise<RunOutcome> {
    this.runs.push(request)
    request.onProgress?.({ phase: 'notebook', cell: 0, cells: 1, outputBytes: 10 })
    if (this.next === 'wait') {
      await new Promise<void>((resolve) => {
        this.releases.push(resolve)
        request.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    fs.mkdirSync(request.resultDir, { recursive: true })
    const status = request.signal?.aborted ? 'exit' : this.next === 'cell_error' ? 'cell_error' : 'ok'
    fs.writeFileSync(path.join(request.resultDir, 'run.json'), JSON.stringify({ attemptId: request.attemptId, status, cell: 0, cells: 1 }))
    if (status === 'ok') fs.writeFileSync(path.join(request.resultDir, 'submission.csv'), 'id,target\n1,0.5\n')
    fs.writeFileSync(path.join(request.resultDir, 'executed.ipynb'), JSON.stringify({ cells: [], executed: true }))
    return {
      status, cell: 0, cells: 1, wall: 1234, submission: status === 'ok' ? path.join(request.resultDir, 'submission.csv') : null,
      detail: status === 'cell_error' ? 'Traceback\nValueError: boom' : '', log: '',
      diagnostics: { exit: 0, oomKilled: false, backend: 'docker' },
    }
  }

  release(): void {
    for (const release of this.releases.splice(0)) release()
  }

  async sweep(): Promise<number> {
    this.sweeps++
    return 0
  }

  async capacity(): Promise<Capacity> {
    return { availableMb: null, heldMb: 0, heldGpus: {} }
  }
}

/** Poll until `check` holds, or fail after `timeoutMs` with `what`. */
export async function waitFor<T>(check: () => T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export const PROTOCOL = REMOTE_PROTOCOL
