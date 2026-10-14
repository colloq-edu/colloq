/**
 * The home of tests/remote-e2e.test.mts: the REAL app (server/src/app.ts) in
 * the test's own process, on an ephemeral port of 127.0.0.1, with the
 * temporary DATA_DIR of tests/_env.mts and the stand-in runner
 * (competitions/fake-runner.ts) for this server's own jobs — so the metric
 * lane scores what the machines ran without a Docker here.
 *
 * STARTED AS index.ts STARTS THE SERVER, in its order: listen, then the
 * machines' boot pass and clock (remote/liveness.ts · startRemoteRunners:
 * offers of a previous life withdrawn, outcomes left `applying` driven
 * again), then the queue's reclaim and its pump. A restart is that again
 * after a crash: the port closed and every connection cut (the machines see
 * the home go away mid-call), the clock and the pump stopped, then a new life
 * (heard.ts · resetHeard, the boot grace counted anew) on the same DATA_DIR
 * and the same port, which is all a machine knows its home by. The database
 * stays the same file, as it does across a real restart; it is never reopened
 * here, because db.ts opens it once, when it loads.
 *
 * EVERY REQUEST IS WRITTEN DOWN as it arrives (method, path, which machine's
 * credential), so a test can say what a machine never asked for — the hidden
 * test's blobs above all — and `stall` holds chosen requests back from the app.
 *
 * WHAT THE PARTICIPANT SEES is read through the participant's own doors
 * (/api/k/…, signed in by the cookie the join door gives), what the owner sees
 * through the owner's (/api/admin/…, a staff cookie minted as the panel's
 * tests mint one), and the rest from the database by the store's own reads.
 */
import './_env.mts'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { parseRemoteAuthorization } from '../shared/remote-runner.js'
import type { EntrantSubmissions, SubmissionAccepted } from '../shared/competitions-entrant.js'
import { app } from '../server/src/app.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { parseInboundPolicy, useInboundPolicy } from '../server/src/net/inbound.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { reclaimCompetitionQueue, startCompetitionPump, stopCompetitionPump, wakeCompetitionPump } from '../server/src/competitions/runner.js'
import { createCompetition, putFile, queueRows, leaveQueue, setCompetitionState, setQueuePaused } from '../server/src/competitions/store.js'
import { putOpenFile, putSealedFile, putSecretFile } from '../server/src/competitions/storage.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { noteRevisionImage, putRevision, selectRevision } from '../server/src/dependencies/store.js'
import { startRemoteRunners, stopRemoteRunners } from '../server/src/competitions/remote/liveness.js'
import { resetHeard } from '../server/src/competitions/remote/heard.js'
import { forgetWantScope, resetBlobBucket } from '../server/src/competitions/remote/blobs.js'
import { listRunners } from '../server/src/competitions/remote/store.js'
import { forgetStock } from '../server/src/competitions/remote/want.js'
import { publishKernel, type Fleet } from './_remote-e2e-agent.mts'

/*
 * Every machine and every participant of these tests calls from 127.0.0.1,
 * and the router's one per-address limit (ten joins in ten minutes) and the
 * participant doors' would refuse a suite's worth of them: the address many
 * people share, as an operator names a campus NAT (net/inbound.ts).
 */
useInboundPolicy(parseInboundPolicy({ ...process.env, SHARED_ADDRESSES: '127.0.0.1' }))

/** This server's own runner: the notebooks it runs itself (when it does) and every metric. */
export const homeRunner = new FakeCompetitionRunner()
useCompetitionRunner(homeRunner)

export const sha256 = (body: string | Uint8Array): string => createHash('sha256').update(body).digest('hex')
export const enc = (text: string): Buffer => Buffer.from(text, 'utf8')

/* ------------------------------------------------------------------ the home */

export interface LoggedRequest {
  at: number
  method: string
  path: string
  /** The machine whose credential the request carried; null — none. */
  runnerId: string | null
  status: number | null
}

export class Home {
  port = 0
  url = ''
  readonly requests: LoggedRequest[] = []
  /** Requests to keep from the app: `true` — never handed to it (a path that swallows them), a number — handed to it after that many ms. */
  stall: ((req: http.IncomingMessage) => boolean | number) | null = null
  private server: http.Server | null = null
  private ownerCookie: string | null = null

  /** Whether it listens: a scenario that crashed it and failed before the restart leaves it down. */
  get up(): boolean {
    return this.server !== null
  }

  async start(port = 0): Promise<void> {
    const server = http.createServer((req, res) => {
      const entry: LoggedRequest = {
        at: Date.now(),
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0]!,
        runnerId: parseRemoteAuthorization(req.headers.authorization)?.runnerId ?? null,
        status: null,
      }
      this.requests.push(entry)
      res.once('finish', () => (entry.status = res.statusCode))
      const stalled = this.stall?.(req) ?? false
      if (stalled === true) return
      if (typeof stalled === 'number' && stalled > 0) {
        // A call its machine gave up on meanwhile (an agent cuts a held sync short on news) never reaches the app: nobody waits for it.
        setTimeout(() => {
          if (!req.destroyed && !res.destroyed) app(req, res)
        }, stalled)
        return
      }
      app(req, res)
    })
    // index.ts's own timeouts: the machines' connections are reused as they are against the real server.
    server.keepAliveTimeout = 130_000
    server.headersTimeout = 135_000
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        // index.ts, in the listen callback: the machines' boot pass and clock first.
        startRemoteRunners()
        resolve()
      })
    })
    this.port = (server.address() as AddressInfo).port
    this.url = `http://127.0.0.1:${this.port}`
    // Then the queue (index.ts · workerStartup.startExecution): what a previous life cut short, then the pump.
    await reclaimCompetitionQueue()
    startCompetitionPump()
  }

  /**
   * The process dies, as far as the machines can tell: nothing listens on the
   * port, every open connection — a held sync, an upload — is cut, the clock
   * and the pump stop. Synchronous up to the pump, so it can be called from
   * inside a request this very moment (the crash in the middle of an apply).
   */
  crash(): Promise<void> {
    const server = this.server
    this.server = null
    server?.close()
    server?.closeAllConnections()
    stopRemoteRunners()
    return stopCompetitionPump()
  }

  /**
   * A new life on the same DATA_DIR and port. Everything the machines' code
   * keeps in memory, and only that, is what a new process starts without: what
   * was heard of each machine (heard.ts, the boot grace counted from now), the
   * blobs each machine's last reply put in its scope (blobs.ts), the bucket,
   * the stock. What is on disk is as the crash left it.
   */
  async restart(): Promise<void> {
    if (this.server) await this.crash()
    resetHeard(Date.now())
    for (const runner of listRunners()) forgetWantScope(runner.id)
    resetBlobBucket()
    forgetStock()
    await this.start(this.port)
  }

  async close(): Promise<void> {
    await this.crash()
  }

  /** The machine join target for a code: COLLOQ_RUNNER_JOIN. */
  joinTarget(code: string): string {
    return `${this.url}#${code}`
  }

  /* -------------------------------------------------------------- the owner */

  private owner(): string {
    if (this.ownerCookie) return this.ownerCookie
    const made = createTeacher({ name: 'Владелица машин e2e', email: `owner.e2e.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
    rotateLinkKey(made.id)
    let value = ''
    issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
    this.ownerCookie = `${STAFF_COOKIE}=${value}`
    return this.ownerCookie
  }

  /** A call through the owner's door. */
  async admin<T>(method: string, at: string, body?: unknown): Promise<{ status: number; body: T }> {
    const answer = await fetch(`${this.url}${at}`, {
      method,
      headers: { cookie: this.owner(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await answer.text()
    return { status: answer.status, body: (text ? JSON.parse(text) : null) as T }
  }

  /** A code minted by the owner in «Подключить машину» (POST /api/admin/runners/codes). */
  async mintCode(options: { trusted?: boolean; approvedSlots?: number | null; machines?: number } = {}): Promise<string> {
    const minted = await this.admin<{ code: string }>('POST', '/api/admin/runners/codes', {
      machines: options.machines ?? 1, hours: 1, trusted: options.trusted ?? false, approvedSlots: options.approvedSlots ?? null,
    })
    if (minted.status !== 200) throw new Error(`the owner could not mint a code: ${minted.status} ${JSON.stringify(minted.body)}`)
    return minted.body.code
  }

  /** The requests a machine made, by path. */
  requestsOf(runnerId: string): LoggedRequest[] {
    return this.requests.filter((entry) => entry.runnerId === runnerId)
  }
}

/* ---------------------------------------------------------- the competitions */

export interface E2eCompetition {
  id: string
  slug: string
  revisionId: string
  registryRef: string
  /** The open data's files by name, with their sha256. */
  open: Record<string, string>
  /** The hidden test's, when there is one. */
  sealed: Record<string, string>
  solutionSha: string
}

let made = 0

export const SAMPLE = 'id,target\n1,0\n2,0\n'
export const HIDDEN = 'id,feature\n101,hidden-row\n'

/**
 * A live competition the way a teacher leaves one before class: open data
 * (and a hidden test), the answer key, and its environment pinned to a kernel
 * in the fleet's registry — a revision machines may run, its layers the ones
 * a pull of its ref brings. The metric is this server's stand-in's.
 */
export function competition(fleet: Fleet, options: { sealed?: boolean; wallSeconds?: number; perDay?: number; bigFileBytes?: number } = {}): E2eCompetition {
  made += 1
  const tag = `${process.pid}-${made}-${randomBytes(3).toString('hex')}`
  const created = createCompetition({
    slug: `machines-e2e-${made}-${randomBytes(2).toString('hex')}`,
    title: `Машины e2e ${made}`,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    limits: { wallSeconds: options.wallSeconds ?? 600, memoryMb: 512, cpus: 1, perDay: options.perDay ?? 0 },
    environment: 'base',
  })
  if (!created) throw new Error('the competition could not be created')
  setCompetitionState(created.id, 'live')
  const open: Record<string, string> = {}
  const files: Array<[string, Buffer]> = [['train.csv', enc(`id,feature\n1,0.5\n2,0.7\n# ${tag}\n`)], ['sample_submission.csv', enc(SAMPLE)]]
  // A file that takes a while to fetch at the owner's least «Скорость раздачи»: its rows, then filler up to the size asked.
  if (options.bigFileBytes) files.push(['big.csv', Buffer.concat([enc(`id,blob\n# ${tag}\n`), Buffer.alloc(options.bigFileBytes, 'x')])])
  for (const [name, body] of files) {
    const stored = putOpenFile(created.id, name, body)
    putFile({ competitionId: created.id, name, bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
    open[name] = stored.sha256
  }
  const solution = enc(`id,target\n1,1\n2,2\n# ${tag}\n`)
  putSecretFile(created.id, 'solution.csv', solution)
  putFile({ competitionId: created.id, name: 'solution.csv', bytes: solution.length, visibility: 'hidden' })
  const sealed: Record<string, string> = {}
  if (options.sealed) {
    const hidden = putSealedFile(created.id, 'test.csv', enc(`${HIDDEN}# ${tag}\n`))
    putFile({ competitionId: created.id, name: 'test.csv', bytes: hidden.bytes, visibility: 'sealed', sha256: hidden.sha256 })
    sealed['test.csv'] = hidden.sha256
  }
  const diffIds = [`sha256:${sha256(`layer one ${tag}`)}`, `sha256:${sha256(`layer two ${tag}`)}`]
  const kernel = publishKernel(fleet, `ghcr.io/colloq-edu/colloq-kernel@sha256:${sha256(`kernel ${tag}`)}`, diffIds)
  const revision = putRevision({
    environmentName: 'base', imageDigest: `sha256:${sha256(`image ${tag}`)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/amd64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash',
  })
  if (!noteRevisionImage(revision.id, { registryRef: kernel.ref, layers: kernel.layers })) throw new Error('the revision\'s image could not be noted')
  selectRevision(created.id, revision.id)
  forgetStock()
  return { id: created.id, slug: created.slug, revisionId: revision.id, registryRef: kernel.ref, open, sealed, solutionSha: sha256(solution) }
}

/** A notebook of `cells` code cells, the first one carrying the runners' directive (fake-runner.ts · DIRECTIVE). */
export function notebook(directive: Record<string, unknown> | null, cells = 2): Buffer {
  const sources = Array.from({ length: cells }, (_, index) => (index === 0 && directive ? `# colloq-test: ${JSON.stringify(directive)}\nx = 1` : `y${index} = ${index}`))
  return enc(JSON.stringify({
    cells: sources.map((source) => ({ cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null })),
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }))
}

/** This server runs notebooks itself, or only scores («Тетради на этом сервере»). */
export function homeNotebooks(on: boolean): void {
  saveCompetitionSettings({ homeNotebooks: on })
  wakeCompetitionPump()
}

/** An empty queue, running, and only the machines running notebooks. */
export function quietQueue(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  homeNotebooks(false)
}

/* ------------------------------------------------------------ a participant */

/** A participant, through the participant's own doors only. */
export class Entrant {
  cookie = ''
  readonly name: string

  constructor(readonly home: Home, readonly competition: E2eCompetition, name?: string) {
    this.name = name ?? `@e2e_${randomBytes(4).toString('hex')}`
  }

  private async call<T>(method: string, at: string, init: { json?: unknown; form?: FormData } = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const answer = await fetch(`${this.home.url}${at}`, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
    })
    const text = await answer.text()
    return { status: answer.status, body: (text ? JSON.parse(text) : null) as T, headers: answer.headers }
  }

  /** «Участвовать»: a newcomer gets a key and a cookie. */
  async join(): Promise<this> {
    const joined = await this.call<{ entrant: { id: string } | null }>('POST', `/api/k/competitions/${this.competition.slug}/join`, { json: { name: this.name } })
    if (joined.status !== 200) throw new Error(`the join door refused ${this.name}: ${joined.status} ${JSON.stringify(joined.body)}`)
    const cookie = joined.headers.getSetCookie().map((line) => line.split(';')[0]!).find(Boolean)
    if (!cookie) throw new Error('the join door set no cookie')
    this.cookie = cookie
    return this
  }

  /** Send a notebook as the page does (multipart, field `file`). */
  async submit(body: Buffer): Promise<SubmissionAccepted['submission']> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(body)], { type: 'application/x-ipynb+json' }), 'solution.ipynb')
    const sent = await this.call<SubmissionAccepted>('POST', `/api/k/competitions/${this.competition.slug}/submissions`, { form })
    if (sent.status !== 200) throw new Error(`the upload door refused ${this.name}: ${sent.status} ${JSON.stringify(sent.body)}`)
    return sent.body.submission
  }

  async submissions(): Promise<EntrantSubmissions> {
    const listed = await this.call<EntrantSubmissions>('GET', `/api/k/competitions/${this.competition.slug}/submissions`)
    if (listed.status !== 200) throw new Error(`the list door refused ${this.name}: ${listed.status}`)
    return listed.body
  }

  async submission(id: string): Promise<EntrantSubmissions['submissions'][number]> {
    const found = (await this.submissions()).submissions.find((one) => one.id === id)
    if (!found) throw new Error(`${this.name} does not see submission ${id}`)
    return found
  }

  async cancel(id: string): Promise<number> {
    return (await this.call('POST', `/api/k/competitions/${this.competition.slug}/submissions/${id}/cancel`)).status
  }
}

/* ----------------------------------------------------------------- waiting */

/** Poll until `check` gives a value, or fail with `what` (and `detail` for the reader of a red test). */
export async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 15_000, detail: () => string = () => ''): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${detail() ? `\n${detail()}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

