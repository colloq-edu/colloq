/**
 * /api/runners/v1 — the door of the machines that run this server's
 * submissions (§3.1, §3.2). Five calls: join, sync, blobs, the result files,
 * the outcome.
 *
 * MOUNTED BEFORE EVERYTHING THE BROWSER DOORS NEED (app.ts): right after the
 * security headers, before compression (a Range download must not be
 * re-encoded, and a result upload is gzip already), before the sign-in
 * proxy's identity, express.json and the same-origin gate. None of those
 * are about machines: a machine is no browser, carries no cookie and sends
 * no Origin, and its bodies have caps of their own (REMOTE_JOIN_BYTES,
 * REMOTE_SYNC_BYTES, REMOTE_OUTCOME_BYTES; REMOTE_FILE_BYTES uncompressed).
 *
 * EVERY REPLY CARRIES THE MARKER (REMOTE_MARKER_HEADER), refusals included,
 * set before anything can answer: a reply without it is the relay's page or
 * frps's 504, and the agent takes it for a hiccup of the path, never for
 * home's word (shared/remote-runner.ts · remoteTransient).
 *
 * ONE CREDENTIAL, AND ONLY HERE. A machine sends `Authorization: Bearer
 * cr1.<id>.<secret>`; its secret is compared as sha256 digests in constant
 * time (store.ts · authenticateRunner). No staff cookie, room token or
 * participant cookie is accepted here, and no other door accepts this
 * credential (admin/auth.ts · currentStaff, competitions/identity.ts ·
 * currentEntrant, auth.ts · verifyToken, the WebSocket upgrades). Limits are
 * per machine, never per address — machines behind one NAT never throttle
 * each other — except for join, which has no machine yet: ten per address
 * per ten minutes.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import {
  REMOTE_ERRORS,
  REMOTE_HOLD_BUSY_MS,
  REMOTE_HOLD_IDLE_MS,
  REMOTE_JOIN_BYTES,
  REMOTE_JOINS_PER_ADDRESS,
  REMOTE_MARKER,
  REMOTE_MARKER_HEADER,
  REMOTE_OUTCOME_BYTES,
  REMOTE_REASON_CHARS,
  REMOTE_SYNC_BYTES,
  RemoteProtocolError,
  parseRemoteAuthorization,
  parseRemoteJoinRequest,
  parseRemoteOutcomeRequest,
  parseRemoteSyncRequest,
  remoteCompatible,
  remoteText,
  type RemoteErrorCode,
  type RemoteErrorReply,
  type RemoteJoinReply,
  type RemoteOutcomeReply,
  type RemoteSyncReply,
  type RemoteSyncRequest,
} from '@shared/remote-runner'
import { getTeacher } from '../../admin/store.js'
import { recordAdminEvent } from '../../admin/audit-log.js'
import { addressForLimits, clientAddress } from '../../net/inbound.js'
import { tooOften } from '../../net/too-often.js'
import { gpuPerDeviceSetting } from '../settings.js'
import { applyOutcome } from './apply.js'
import { homeWords } from './words.js'
import { BlobRefusal, noteWantScope, serveBlob } from './blobs.js'
import { lastSync, noteCall, noteSent, noteSync, sentDigest, wantedBefore, type SyncNews } from './heard.js'
import { pendingOffers, reconcileSync, runnerOffer, syncVerdicts, takeForRunner } from './lease.js'
import { leaveRunner } from './release.js'
import {
  authenticateRunner,
  boundedPerDevice,
  getRunner,
  homeRunnerBuild,
  homeVersion,
  joinRunner,
  liveLeases,
  remoteEvent,
  runnerStanding,
  updateRunner,
  type RunnerRow,
} from './store.js'
import { UploadRefusal, receiveUpload } from './upload.js'
import { homeStock, runnerWant } from './want.js'
import { waitForNews } from './wake.js'

/** Prometheus' counts of the calls (ops/metrics.ts). */
export const callCounts = { joins: 0, joinsRefused: 0, syncs: 0, outcomes: 0, unauthorized: 0 }

/* ----------------------------------------------------------------- replies */

/** A refusal in the contract's words: its code, its status, and a reason of one line. */
function refuse(res: Response, code: RemoteErrorCode, detail?: string, retryAfterS?: number): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (retryAfterS !== undefined) res.setHeader('Retry-After', String(retryAfterS))
  const body: RemoteErrorReply = { error: code, ...(detail ? { detail: remoteText(detail, REMOTE_REASON_CHARS, 'start') } : {}) }
  res.status(REMOTE_ERRORS[code]).json(body)
}

/** Express's own refusals of a body (body-parser) and ours, as the contract names them. */
function routerErrors(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof RemoteProtocolError) return refuse(res, error.code, error.message)
  if (error instanceof UploadRefusal) return refuse(res, error.code, error.message, error.retryAfterS)
  if (error instanceof BlobRefusal) return refuse(res, error.code, undefined, error.retryAfterS)
  const failed = error as { type?: string; status?: number } | null
  if (failed?.type === 'entity.too.large' || failed?.status === 413) return refuse(res, 'too_large')
  if (failed?.type === 'entity.parse.failed' || failed?.type === 'encoding.unsupported' || failed?.type === 'charset.unsupported' || (typeof failed?.status === 'number' && failed.status >= 400 && failed.status < 500)) {
    return refuse(res, 'invalid')
  }
  console.error('[runners] a call failed:', error instanceof Error ? (error.stack ?? error.message) : error)
  refuse(res, 'failed')
}

/* ------------------------------------------------------------- the machine */

interface RunnerLocals {
  runner: RunnerRow
}

/** Calls per machine per minute, by kind: generous for honest work, a ceiling for a loop (net/too-often.ts). */
const PER_MINUTE = { sync: 240, blob: 600, file: 600, outcome: 600 } as const
const buckets = { sync: new Map<string, number[]>(), blob: new Map<string, number[]>(), file: new Map<string, number[]>(), outcome: new Map<string, number[]>() }
const joinBucket = new Map<string, number[]>()
/** Problem lines one machine may add to its log in an hour (noteFacts). */
const PROBLEM_EVENTS = 60
const problemEvents = new Map<string, number[]>()

/** The machine a call's credential names, or 401; then its own rate for this kind of call, or 429. */
function machine(kind: keyof typeof PER_MINUTE) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const credential = parseRemoteAuthorization(req.headers.authorization)
    const runner = credential ? authenticateRunner(credential.runnerId, credential.secret) : null
    if (!runner) {
      callCounts.unauthorized++
      return refuse(res, 'unauthorized')
    }
    if (tooOften(buckets[kind], runner.id, 60_000, PER_MINUTE[kind])) return refuse(res, 'too_often', undefined, 5)
    noteCall(runner.id, Date.now(), clientAddress(req))
    ;(res.locals as RunnerLocals).runner = runner
    next()
  }
}

const json = (limit: number) => express.json({ limit, strict: true, type: () => true })

/* ------------------------------------------------------------------ router */

export function remoteRunnerRoutes(): Router {
  const router = Router()

  // Before any handler, so that every answer carries it — a refusal of the body's size as much as a reply.
  router.use((_req, res, next) => {
    res.setHeader(REMOTE_MARKER_HEADER, REMOTE_MARKER)
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  router.post('/join', (req, res, next) => {
    if (tooOften(joinBucket, addressForLimits(req), REMOTE_JOINS_PER_ADDRESS.windowMs, REMOTE_JOINS_PER_ADDRESS.count)) {
      return refuse(res, 'too_often', undefined, 60)
    }
    next()
  }, json(REMOTE_JOIN_BYTES), (req, res) => {
    const request = parseRemoteJoinRequest(req.body)
    const now = Date.now()
    const address = clientAddress(req)
    const joined = joinRunner({ code: request.code, joinId: request.joinId, build: request.build, facts: request.facts, address }, now)
    if (!joined.ok) {
      callCounts.joinsRefused++
      return refuse(res, 'code')
    }
    callCounts.joins++
    noteCall(joined.runner.id, now, address)
    if (!joined.repeated) {
      remoteEvent(joined.runner.id, 'joined', { address, detail: `${request.facts.hostname} · ${request.facts.version}` }, now)
      // The owner who minted the code is who enrolled the machine (§6 "Audit").
      const owner = getTeacher(joined.runner.createdBy)
      recordAdminEvent({
        actor: owner,
        action: 'runner.enrolled',
        target: { type: 'runner', id: joined.runner.id, label: joined.runner.name },
        detail: { trusted: joined.runner.trusted, approvedSlots: joined.runner.approvedSlots, hostname: request.facts.hostname, version: request.facts.version },
        req,
      })
    }
    const body: RemoteJoinReply = { runnerId: joined.runner.id, secret: joined.secret, trusted: joined.runner.trusted, approvedSlots: joined.runner.approvedSlots }
    res.json(body)
  })

  router.post('/sync', machine('sync'), json(REMOTE_SYNC_BYTES), (req, res, next) => {
    void sync(req, res).catch(next)
  })

  router.get('/blobs/:sha256', machine('blob'), (req, res, next) => {
    const runner = (res.locals as RunnerLocals).runner
    void serveBlob(req, res, runner, String(req.params.sha256)).catch(next)
  })

  router.put('/attempts/:attempt/files/:name', machine('file'), (req, res, next) => {
    const runner = (res.locals as RunnerLocals).runner
    void receiveUpload(req, runner, String(req.params.attempt), String(req.params.name))
      .then((stored) => res.json(stored))
      .catch(next)
  })

  router.post('/attempts/:attempt/outcome', machine('outcome'), json(REMOTE_OUTCOME_BYTES), (req, res, next) => {
    void outcome(req, res).catch(next)
  })

  router.use((_req, res) => refuse(res, 'not_found'))
  router.use(routerErrors)
  return router
}

/* -------------------------------------------------------------------- sync */

/** The least time between two recomputes of one held sync's reply. */
const RECOMPUTE_MS = 200

/**
 * The heartbeat, the long-poll and the reconciliation (§3.4). What the sync
 * says is written down at once (reconcileSync); the reply is held for at
 * most what the machine allows (REMOTE_HOLD_IDLE_MS, REMOTE_HOLD_BUSY_MS
 * while it holds anything) and answered early on news — a lease, a revoke,
 * an outcome applied, or anything else of the reply changed since the last
 * one it got (newsDigest).
 */
async function sync(req: Request, res: Response): Promise<void> {
  const runner = (res.locals as RunnerLocals).runner
  const request = parseRemoteSyncRequest(req.body)
  const now = Date.now()
  callCounts.syncs++
  const address = clientAddress(req)
  const news = noteSync(runner.id, request, now, address)
  const current = noteFacts(runner, request, news, now, address)
  reconcileSync(current, request, now)
  // A machine leaving with nothing held revokes itself: its next call is refused, and it stops (colloq-host runner leave).
  if (request.state === 'leaving' && request.attempts.length === 0) leaveRunner(current.id, now)
  const hold = Math.min(request.holdMs, request.attempts.length > 0 ? REMOTE_HOLD_BUSY_MS : REMOTE_HOLD_IDLE_MS)
  const ends = now + hold
  const hungUp = new AbortController()
  res.on('close', () => hungUp.abort())
  let reply = await syncReply(current.id, request, request.state === 'leaving')
  let computed = Date.now()
  while (reply !== null && !reply.news && Date.now() < ends && !hungUp.signal.aborted) {
    await waitForNews(current.id, ends - Date.now(), hungUp.signal)
    if (hungUp.signal.aborted) return
    /*
     * A burst of uploads is a burst of wakes, each of every held sync: one
     * recompute per RECOMPUTE_MS takes them all in, rather than a take per
     * upload per machine.
     */
    const pause = Math.min(computed + RECOMPUTE_MS - Date.now(), ends - Date.now())
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause))
    if (hungUp.signal.aborted) return
    reply = await syncReply(current.id, request, request.state === 'leaving')
    computed = Date.now()
  }
  if (hungUp.signal.aborted) return
  if (reply === null) return refuse(res, 'unauthorized')
  noteSent(current.id, reply.digest, reply.wanted, reply.body.forget)
  noteWantScope(current.id, reply.body.want)
  res.json(reply.body)
}

/** What a sync says about the machine itself into its row, and its readiness news into its log. */
function noteFacts(runner: RunnerRow, request: RemoteSyncRequest, news: SyncNews, now: number, address: string | null): RunnerRow {
  const patch: Parameters<typeof updateRunner>[1] = {}
  if (request.facts && JSON.stringify(request.facts) !== JSON.stringify(runner.facts)) {
    patch.facts = request.facts
    patch.version = request.facts.version
  }
  if (request.build !== runner.build) {
    patch.build = request.build
    // Of another build from now on: it finishes what it holds and is given nothing new (decision 5).
    if (!remoteCompatible(homeRunnerBuild(), request.build)) remoteEvent(runner.id, 'outdated', { address, detail: request.facts?.version ?? runner.version ?? null }, now)
  }
  // The cards' echo outlives a restart for the GPU door (heard.ts · remoteCardsSeen): what they are, not how busy.
  const shape = (cards: RemoteSyncRequest['cards']) => JSON.stringify(cards.map((card) => [card.device, card.name, card.memoryMb, card.perDevice]))
  if (shape(request.cards) !== shape(runner.cards)) patch.cards = request.cards
  const updated = Object.keys(patch).length > 0 ? (updateRunner(runner.id, patch) ?? runner) : runner
  // The machine's log names the address each change was heard from (§6 "Audit": addresses go to remote_events).
  for (const id of news.revisions) remoteEvent(runner.id, 'image_ready', { address, detail: id }, now)
  for (const manifest of [...news.data, ...news.sealed]) remoteEvent(runner.id, 'data_ready', { address, detail: manifest.slice(0, 12) }, now)
  // A machine's problems are its own words: at most PROBLEM_EVENTS of them an hour reach its log, however often they change.
  for (const problem of news.problems) {
    if (tooOften(problemEvents, runner.id, 60 * 60_000, PROBLEM_EVENTS)) break
    remoteEvent(runner.id, 'problem', { address, detail: `${problem.code}: ${homeWords(problem.detail)}` }, now)
  }
  return updated
}

interface SyncAnswer {
  body: RemoteSyncReply
  /** Something in it the machine must hear now, rather than at the end of the hold. */
  news: boolean
  digest: string
  wanted: string[]
}

/**
 * The reply as things stand now, with new work taken for the machine when
 * it may take it: active by the owner's word and its own, of this server's
 * build. `null` — the machine was revoked meanwhile (its held sync answers
 * 401).
 */
async function syncReply(runnerId: string, request: RemoteSyncRequest, leaving: boolean): Promise<SyncAnswer | null> {
  const stock = await homeStock()
  const now = Date.now()
  const runner = getRunner(runnerId)
  if (!runner || (!runnerStanding(runner) && !(leaving && runner.state === 'left'))) return null
  const compatible = remoteCompatible(homeRunnerBuild(), request.build)
  const taken = compatible && runner.state === 'active' && request.state === 'active'
    ? takeForRunner(runner, runnerOffer(runner, request.free, request), now)
    : []
  const fresh = getRunner(runnerId) ?? runner
  const leases = runner.state === 'left' ? [] : pendingOffers(runnerId, now)
  const { revoke, applied } = syncVerdicts(runnerId, request)
  const want = runner.state === 'left'
    ? { want: { revisions: [], data: [], bundles: [] }, forget: [...wantedBefore(runnerId)], wanted: [] }
    : runnerWant({ stock, trusted: fresh.trusted, cards: request.cards.length > 0, sync: request, leases: liveLeases(runnerId), wantedBefore: wantedBefore(runnerId) })
  const body: RemoteSyncReply = {
    seq: fresh.offerSeq,
    leases,
    revoke,
    applied,
    want: want.want,
    forget: want.forget,
    drain: fresh.state !== 'active',
    trusted: fresh.trusted,
    approvedSlots: fresh.approvedSlots,
    perDevice: boundedPerDevice(fresh.perDevice ?? gpuPerDeviceSetting().value),
    compatible,
    homeVersion: homeVersion(),
  }
  const digest = newsDigest(body)
  // A leave is answered at once: `runner leave` waits on it, and nothing will come for a machine that is gone.
  const news = runner.state === 'left' || taken.length > 0 || leases.length > 0 || revoke.length > 0 || applied.length > 0 || digest !== sentDigest(runnerId)
  return { body, news, digest, wanted: want.wanted }
}

/** Everything of a reply but its per-call lists: what the machine has to hear again when it changes. */
function newsDigest(body: RemoteSyncReply): string {
  const { leases: _leases, revoke: _revoke, applied: _applied, seq: _seq, ...rest } = body
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

/* ---------------------------------------------------------------- outcome */

/**
 * An attempt's outcome (§3.6): applied once by its digest, and the reply
 * carries the machine's next work at once, from the room the outcome says
 * it has now — the stale-capacity rule judged against its last sync.
 */
async function outcome(req: Request, res: Response): Promise<void> {
  const runner = (res.locals as RunnerLocals).runner
  const request = parseRemoteOutcomeRequest(req.body)
  callCounts.outcomes++
  const answer = await applyOutcome(runner.id, String(req.params.attempt), request)
  if (!answer.ok) return refuse(res, answer.code)
  const now = Date.now()
  const fresh = getRunner(runner.id) ?? runner
  const sync = lastSync(runner.id)
  const compatible = remoteCompatible(homeRunnerBuild(), request.build)
  // Its last sync's list stands for what the outcome's `free` already accounts for: conservative, never over.
  if (compatible && fresh.state === 'active' && sync !== null && sync.state === 'active') takeForRunner(fresh, runnerOffer(fresh, request.free, sync), now)
  const body: RemoteOutcomeReply = { result: answer.result, seq: (getRunner(runner.id) ?? fresh).offerSeq, leases: pendingOffers(runner.id, now) }
  res.json(body)
}
