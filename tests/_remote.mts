/**
 * What the tests of the machines that run submissions share
 * (server/src/competitions/remote/): a competition whose environment is in a
 * registry (portable), a submission pinned to it, an enrollment code, and a
 * stand-in agent that speaks the contract over HTTP to the real app — every
 * reply it gets is parsed by the contract's own strict parsers, so a reply
 * home builds that a real agent would refuse fails the test that got it.
 *
 * No Docker and no machine: the agent's half is a few fetches.
 */
import './_env.mts'
import http from 'node:http'
import zlib from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import {
  REMOTE_API_BASE,
  REMOTE_BYTES_HEADER,
  REMOTE_MARKER,
  REMOTE_MARKER_HEADER,
  REMOTE_SHA256_HEADER,
  parseRemoteJoinReply,
  parseRemoteOutcomeReply,
  parseRemoteSyncReply,
  remoteCredential,
  type RemoteFacts,
  type RemoteFinishedRequest,
  type RemoteOutcomeReply,
  type RemoteRunOutcome,
  type RemoteSyncReply,
  type RemoteSyncRequest,
} from '../shared/remote-runner.js'
import type { Competition, Submission } from '../shared/competitions.js'
import { app } from '../server/src/app.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  leaveQueue,
  putFile,
  queueRows,
  setCompetitionState,
  setQueuePaused,
} from '../server/src/competitions/store.js'
import { putOpenFile, putSealedFile, putSecretFile, putSubmissionNotebook } from '../server/src/competitions/storage.js'
import { bindSubmission, noteRevisionImage, putRevision, selectRevision } from '../server/src/dependencies/store.js'
import { mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { forgetStock } from '../server/src/competitions/remote/want.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { db } from '../server/src/db.js'
import { resetHeard } from '../server/src/competitions/remote/heard.js'

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
export const hex = (text: string): string => createHash('sha256').update(text).digest('hex')
export const ANSWER = 'id,target\n1,0\n2,0\n'

let seq = 0

/** A revision of `environment` whose image is in a registry by digest: machines may run it. */
export function portableRevision(environment = 'base', tag = String(++seq)) {
  const revision = putRevision({
    environmentName: environment, imageDigest: `sha256:${hex(`image ${environment} ${tag}`)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/amd64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash',
  })
  noteRevisionImage(revision.id, { registryRef: `ghcr.io/colloq-edu/colloq-kernel@sha256:${hex(`ref ${revision.id}`)}`, layers: hex(`layers ${revision.id}`) })
  return revision
}

/** A revision built on this server: no registry reference, so only this server runs it. */
export function localRevision(environment = 'base') {
  return putRevision({
    environmentName: environment, imageDigest: `sha256:${hex(`local ${environment} ${++seq}`)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/amd64', packages: [], baseConstraintsHash: 'hash',
  })
}

export interface TestCompetition extends Competition {
  revisionId: string
}

/** A live competition on a portable revision, with open data hashed at upload and the answers. */
export function competition(options: { gpu?: boolean; sealed?: boolean; memoryMb?: number; cpus?: number; local?: boolean; wallSeconds?: number } = {}): TestCompetition {
  seq += 1
  const made = createCompetition({
    slug: `machines${seq}`,
    title: `Machines ${seq}`,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    limits: { wallSeconds: options.wallSeconds ?? 600, memoryMb: options.memoryMb ?? 4096, cpus: options.cpus ?? 2, perDay: 0, ...(options.gpu ? { gpu: true } : {}) },
    environment: options.gpu ? 'base-gpu' : 'base',
  })
  assert.ok(made)
  setCompetitionState(made.id, 'live')
  const train = 'id,feature\n1,0.5\n2,0.7\n'
  const stored = putOpenFile(made.id, 'train.csv', enc(train))
  putFile({ competitionId: made.id, name: 'train.csv', bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
  const sample = putOpenFile(made.id, 'sample_submission.csv', enc(ANSWER))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: sample.bytes, visibility: 'open', sha256: sample.sha256 })
  putSecretFile(made.id, 'solution.csv', enc('id,target\n1,1\n2,2\n'))
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: 18, visibility: 'hidden' })
  if (options.sealed) {
    const hidden = putSealedFile(made.id, 'test.csv', enc('id,feature\n101,hidden\n'))
    putFile({ competitionId: made.id, name: 'test.csv', bytes: hidden.bytes, visibility: 'sealed', sha256: hidden.sha256 })
  }
  const revision = options.local ? localRevision(made.environment) : portableRevision(made.environment)
  selectRevision(made.id, revision.id)
  forgetStock()
  return { ...made, revisionId: revision.id }
}

/** A submission of a fresh entrant, its notebook on disk and pinned to the competition's revision. */
export function send(c: TestCompetition, options: { cells?: string[]; at?: number; revisionId?: string | null } = {}): Submission {
  const entrant = createEntrant(`Машинный ${seq}-${randomUUID().slice(0, 6)}`).entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100, at: options.at ?? Date.now() })
  const cells = options.cells ?? ['x = 1']
  putSubmissionNotebook(c.id, submission.id, enc(JSON.stringify({
    cells: cells.map((source) => ({ cell_type: 'code', source, metadata: {}, outputs: [] })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })))
  const revisionId = options.revisionId === undefined ? c.revisionId : options.revisionId
  if (revisionId !== null) bindSubmission(submission.id, revisionId, null)
  forgetStock()
  return submission
}

/** A code for `machines` machines, minted the way the panel mints one. */
export function code(options: { machines?: number; trusted?: boolean; approvedSlots?: number | null; prefix?: string } = {}): string {
  return mintRemoteCode({ machines: options.machines ?? 1, hours: 1, trusted: options.trusted ?? false, approvedSlots: options.approvedSlots ?? null, namePrefix: options.prefix ?? null, createdBy: 'tests' }).code
}

/** Everything back to an empty queue, home's notebooks off (so only machines take notebooks), and a fresh life of the machines' clock. */
export function reset(options: { homeNotebooks?: boolean } = {}): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  saveCompetitionSettings({ homeNotebooks: options.homeNotebooks ?? false })
  db.prepare("UPDATE remote_runners SET state = 'revoked' WHERE state IN ('active', 'draining')").run()
  db.prepare("UPDATE remote_leases SET state = 'revoked', cause = 'cancelled' WHERE state IN ('offered', 'accepted', 'running', 'applying')").run()
  // The boot grace is a real rule: a test that means silence starts its clock well past it.
  resetHeard(Date.now() - 10 * 60_000)
  forgetStock()
}

/* ---------------------------------------------------------------- the app */

let server: http.Server | null = null
let base = ''

export async function serve(): Promise<string> {
  if (server) return base
  server = http.createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return base
}

export function close(): void {
  server?.close()
  server = null
}

/* ---------------------------------------------------- a stand-in machine */

export const FACTS: RemoteFacts = {
  version: '0.24.0', hostname: 'vast-test', platform: 'linux/amd64', cpus: 16, memoryMb: 65536, diskMb: 200_000,
  docker: '28.3.1', storage: 'overlay2', driver: null,
}

export function syncRequest(over: Partial<RemoteSyncRequest> = {}): RemoteSyncRequest {
  return {
    protocol: 1,
    build: 'dev',
    seq: 0,
    holdMs: 0,
    state: 'active',
    free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 },
    cards: [],
    ready: { revisions: [], data: [], sealed: [], bundles: [] },
    fetching: [],
    attempts: [],
    problems: [],
    ...over,
  }
}

export interface Reply<T> {
  status: number
  body: T
  headers: Headers
}

/** A machine as its agent would be: joined with a code, then calling with its credential. */
export class Machine {
  runnerId = ''
  secret = ''
  readonly joinId = randomUUID().replaceAll('-', '')
  /**
   * Where the machine calls from, as the relay forwards it (loopback is a
   * trusted proxy by default): an address of its own, so that the joins of
   * a suite are not ten from one address (the router's only per-address
   * limit) unless a test means them to be.
   */
  address = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`
  /** The last sync reply, parsed. */
  last: RemoteSyncReply | null = null

  constructor(readonly home: string) {}

  get credential(): string {
    return remoteCredential(this.runnerId, this.secret)
  }

  async call(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; raw?: Buffer | string; credential?: string | null } = {}): Promise<Response> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.address, ...(init.headers ?? {}) }
    const credential = init.credential === undefined ? (this.runnerId ? this.credential : null) : init.credential
    if (credential) headers.authorization = `Bearer ${credential}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    return fetch(`${this.home}${REMOTE_API_BASE}/${path}`, {
      method,
      headers,
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    })
  }

  async join(joinCode: string, facts: RemoteFacts = FACTS): Promise<Reply<unknown>> {
    const answer = await this.call('POST', 'join', { body: { protocol: 1, build: 'dev', code: joinCode, joinId: this.joinId, facts }, credential: null })
    assert.equal(answer.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER, 'every reply carries the marker')
    const body = await answer.json()
    if (answer.status === 200) {
      const reply = parseRemoteJoinReply(body)
      this.runnerId = reply.runnerId
      this.secret = reply.secret
    }
    return { status: answer.status, body, headers: answer.headers }
  }

  /** A sync; with a 200 the reply is parsed by the contract (and kept as `last`). */
  async sync(over: Partial<RemoteSyncRequest> = {}): Promise<Reply<RemoteSyncReply>> {
    const answer = await this.call('POST', 'sync', { body: syncRequest(over) })
    assert.equal(answer.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER, 'every reply carries the marker')
    const body = await answer.json()
    if (answer.status === 200) this.last = parseRemoteSyncReply(body)
    return { status: answer.status, body: body as RemoteSyncReply, headers: answer.headers }
  }

  async put(attemptId: string, name: string, content: Buffer | string, over: { sha256?: string; bytes?: string; encoding?: string; raw?: Buffer } = {}): Promise<Reply<unknown>> {
    const plain = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const answer = await this.call('PUT', `attempts/${attemptId}/files/${name}`, {
      raw: over.raw ?? zlib.gzipSync(plain),
      headers: {
        'content-encoding': over.encoding ?? 'gzip',
        [REMOTE_SHA256_HEADER]: over.sha256 ?? createHash('sha256').update(plain).digest('hex'),
        [REMOTE_BYTES_HEADER]: over.bytes ?? String(plain.length),
        'content-type': 'application/octet-stream',
      },
    })
    assert.equal(answer.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER)
    return { status: answer.status, body: await answer.json(), headers: answer.headers }
  }

  async outcome(attemptId: string, request: unknown): Promise<Reply<RemoteOutcomeReply | { error: string }>> {
    const answer = await this.call('POST', `attempts/${attemptId}/outcome`, { body: request })
    assert.equal(answer.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER)
    const body = await answer.json()
    if (answer.status === 200) parseRemoteOutcomeReply(body)
    return { status: answer.status, body, headers: answer.headers }
  }
}

/** What an honest finished run reports: ok, its two files, and the run.json its harness wrote. */
export function finished(attemptId: string, files: { name: 'submission.csv' | 'executed.ipynb'; body: string }[], over: Partial<RemoteRunOutcome> = {}): RemoteFinishedRequest {
  return {
    protocol: 1,
    build: 'dev',
    free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 },
    kind: 'finished',
    outcome: {
      status: 'ok', cell: 0, cells: 1, wall: 4200, produced: files.some((file) => file.name === 'submission.csv'),
      detail: '', log: '', diagnostics: { exit: 0, oomKilled: false, backend: 'docker' }, crowded: false,
      ...over,
    },
    runJson: Buffer.from(JSON.stringify({ attemptId, status: 'ok', cell: 0, cells: 1 })).toString('base64'),
    files: files.map((file) => ({ name: file.name, bytes: Buffer.byteLength(file.body), sha256: createHash('sha256').update(file.body).digest('hex') })),
  }
}
