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
 *
 * CLASSES RIDE THE SYNC (remote-classes.md §15). A machine that takes classes
 * gets a `kernels` block in every reply, an outdated one too — its live
 * placements must keep reconciling — and its own block, which its agent sends
 * only after a reply that carried one, is handed to the class placements
 * once, as it arrives (heard.ts · ClassPort). A machine that takes none
 * is sent no block and may send none, but while it winds classes down — turned
 * off under it, or containers its own block lists (windDownBlock).
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import {
  REMOTE_ERRORS,
  REMOTE_HOLD_BUSY_MS,
  REMOTE_HOLD_IDLE_MS,
  REMOTE_JOIN_BYTES,
  REMOTE_JOINS_PER_ADDRESS,
  REMOTE_MANIFESTS_MAX,
  REMOTE_MARKER,
  REMOTE_MARKER_HEADER,
  REMOTE_OUTCOME_BYTES,
  REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_HEADER,
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
import {
  CLASS_BULK_IDLE_MBPS,
  MACHINE_PACE_MBPS,
  REMOTE_PLACEMENT_KEY,
  REMOTE_READINGS_MAX,
  parseRemoteKernelsReply,
  parseRemotePlacementKey,
  type RemoteKernelsReply,
  type RemoteKernelsRequest,
  type RemotePlacementIntent,
} from '@shared/remote-kernels'
import { classMachineSettings } from '../../admin/resource-settings.js'
import { getTeacher } from '../../admin/store.js'
import { recordAdminEvent } from '../../admin/audit-log.js'
import { addressForLimits, clientAddress } from '../../net/inbound.js'
import { tooOften } from '../../net/too-often.js'
import { gpuPerDeviceSetting } from '../settings.js'
import { applyOutcome } from './apply.js'
import { homeWords } from './words.js'
import { BlobRefusal, noteWantScope, serveBlob } from './blobs.js'
import {
  askedOf,
  classPort,
  classPlacementsLive,
  classesBeside,
  lastSync,
  loadClassPort,
  noteCall,
  noteSent,
  noteSync,
  remoteNow,
  sentDigest,
  wantedBefore,
  type SentReply,
  type SyncNews,
} from './heard.js'
import { classIntentsOf, pendingOffers, reconcileSync, runnerOffer, syncVerdicts, takeForRunner } from './lease.js'
import { leaveRunner } from './release.js'
import {
  LIVE_LEASE_STATES,
  authenticateRunner,
  boundedPerDevice,
  getLease,
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

/** How long, and how much of the rest of a refused body, is read and thrown away after the answer before the connection is closed. */
const LINGER_MS = 2_000
const LINGER_BYTES = 4 * 1024 * 1024

/**
 * A REFUSED BODY IS ANSWERED FIRST, THEN LET GO OF (a lingering close).
 * The answer goes out before the rest of the body is read — an upload of 64
 * MiB refused for the disk, for its attempt cancelled, or halfway through for
 * a length it lied about (upload.ts · store) — and then at most LINGER_BYTES
 * more of it are read and thrown away, for at most LINGER_MS, before the
 * connection is destroyed.
 *
 * Both halves were measured with the agent's own client (undici, Node 22).
 * Destroying the request at the refusal reset the connection before any
 * answer: the machine saw a reset, took it for the path's hiccup and sent the
 * same upload again for ever. Closing it right after the answer
 * (`Connection: close`) while the body still arrives raced the same reset
 * against the answer, and lost it often (EPIPE before the reply was read).
 * Draining the whole body to keep the connection, Node's own default, read up
 * to 64 MiB nobody keeps over the relay the class's rooms share. Answered and
 * lingered, the machine reads the refusal within milliseconds, and a body
 * that ends within the window leaves the connection fit for reuse.
 */
function lingerAfter(res: Response): void {
  const req = res.req
  if (req.complete) return
  res.once('finish', () => {
    if (req.complete) return
    let read = 0
    const close = (): void => {
      clearTimeout(timer)
      req.socket?.destroy()
    }
    const timer = setTimeout(close, LINGER_MS)
    timer.unref?.()
    req.on('data', (chunk: Buffer) => {
      read += chunk.length
      if (read > LINGER_BYTES) close()
    })
    req.once('end', () => clearTimeout(timer))
    req.resume()
  })
}

/** A refusal in the contract's words: its code, its status, and a reason of one line. A body it leaves unread is let go of after it (lingerAfter). */
function refuse(res: Response, code: RemoteErrorCode, detail?: string, retryAfterS?: number): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  lingerAfter(res)
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

/** What every answer of a router of the machines' carries, whatever its version: the marker, the protocol this home speaks, no caching. */
function marked(res: Response): void {
  res.setHeader(REMOTE_MARKER_HEADER, REMOTE_MARKER)
  res.setHeader(REMOTE_PROTOCOL_HEADER, String(REMOTE_PROTOCOL))
  res.setHeader('Cache-Control', 'no-store')
}

/**
 * EVERY OTHER VERSION OF THE ROUTER: /api/runners/v<n> for any n but
 * REMOTE_PROTOCOL, mounted at REMOTE_API_ROOT next to this version's router
 * (app.ts). An agent of another release calls its own version's path; without
 * this it met whatever the rest of the app answers there — no marker, which
 * the agent rightly takes for the relay's page and retries for ever, running
 * notebooks home requeued long ago and keeping the hidden test it would purge
 * on a word it could never hear. So every such call gets the one answer that
 * means "update": a marked 426 `protocol`, with the protocol this home speaks
 * beside the marker (REMOTE_PROTOCOL_HEADER), and the body left unread is let
 * go of after the answer (lingerAfter) — an upload of 64 MiB in a protocol
 * nobody here reads is not drained to be thrown away. The agent takes a
 * marked 426 as final (remoteTransient).
 */
export function remoteOtherVersions(): Router {
  const router = Router()
  router.use((req, res, next) => {
    const version = /^\/v([0-9]{1,6})(?:\/|$)/.exec(req.path)
    if (!version || Number(version[1]) === REMOTE_PROTOCOL) return next()
    marked(res)
    lingerAfter(res)
    const body: RemoteErrorReply = { error: 'protocol', detail: `This home speaks protocol ${REMOTE_PROTOCOL} of the machines' router; the machine needs the release home runs` }
    res.status(REMOTE_ERRORS.protocol).json(body)
  })
  return router
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
/** Readiness lines (image_ready, data_ready) one machine may add to its log in an hour (noteFacts). */
const READY_EVENTS = 120
const readyEvents = new Map<string, number[]>()

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
    noteCall(runner.id, remoteNow(), clientAddress(req))
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
    marked(res)
    next()
  })

  router.post('/join', (req, res, next) => {
    if (tooOften(joinBucket, addressForLimits(req), REMOTE_JOINS_PER_ADDRESS.windowMs, REMOTE_JOINS_PER_ADDRESS.count)) {
      return refuse(res, 'too_often', undefined, 60)
    }
    next()
  }, json(REMOTE_JOIN_BYTES), (req, res) => {
    const request = parseRemoteJoinRequest(req.body)
    const now = remoteNow()
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
      // The owner who minted the code is who enrolled the machine (§6 "Audit"); a code minted on the
      // console has nobody to name, and says it came from there, as its mint does (ops/runner-code.ts).
      const owner = getTeacher(joined.runner.createdBy)
      const fromConsole = !owner && joined.runner.createdBy === 'colloq-host'
      recordAdminEvent({
        actor: owner,
        action: 'runner.enrolled',
        target: { type: 'runner', id: joined.runner.id, label: joined.runner.name },
        detail: {
          trusted: joined.runner.trusted, classes: joined.runner.classes, approvedSlots: joined.runner.approvedSlots, hostname: request.facts.hostname,
          version: request.facts.version, ...(fromConsole ? { source: 'colloq-host' } : {}),
        },
        req,
      })
    }
    // classes: the code's «Принимать занятия», now the machine's (D2); never beside trusted (D3, store.ts · toRunner).
    const body: RemoteJoinReply = {
      runnerId: joined.runner.id, secret: joined.secret, trusted: joined.runner.trusted, approvedSlots: joined.runner.approvedSlots, classes: joined.runner.classes,
    }
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

/*
 * ONE HELD SYNC PER MACHINE. The agent keeps one long-poll open (its loop
 * awaits each sync, and its own poke aborts the one in flight first), but
 * nothing here held it to that: a client with a machine's secret kept a
 * hundred syncs held at once within the per-minute rate, and every upload,
 * every finished metric and every outcome made this server recompute all of
 * them — the take over every waiting row, the want, the digest — in one
 * synchronous stretch: two seconds of a blocked event loop per wake, felt by
 * every room on the server. So a machine's newer sync answers its older one
 * at once, with the reply that one has (never a refusal: an honest agent's
 * aborted sync may still be held here for a moment when its next one
 * arrives), and only the newest is held — with the hold it was given
 * (syncHeldFor).
 */
const holding = new Map<string, { release: () => void; holdMs: number }>()

/** How long the machine's held sync is held at most (syncHold), while one is: for the tests, which wake it rather than wait it out. */
export function syncHeldFor(runnerId: string): number | null {
  return holding.get(runnerId)?.holdMs ?? null
}

/**
 * The heartbeat, the long-poll and the reconciliation (§3.4). What the sync
 * says is written down at once (reconcileSync); the reply is held for at
 * most what the machine allows (REMOTE_HOLD_IDLE_MS, REMOTE_HOLD_BUSY_MS
 * while it holds anything) and answered early on news — a lease, a revoke,
 * an outcome applied, or anything else of the reply changed since the last
 * one it got (newsDigest).
 */
async function sync(req: Request, res: Response): Promise<void> {
  const door = (res.locals as RunnerLocals).runner
  // A kernels block that breaks the contract is refused here, 400 like any part of a sync (the agent then drops the block).
  const request = parseRemoteSyncRequest(req.body)
  // The class placements are there before anything of a class machine's sync is taken in or answered (heard.ts · loadClassPort).
  if ((getRunner(door.id) ?? door).classes) await loadClassPort()
  /*
   * THE ROW AS IT STANDS NOW, the body read and the placements loaded — not
   * as the credential found it before the body came: an owner's click while
   * the body was on its way counts for this very sync. Taken from the door,
   * an unclass during the upload left the sync taking classes, and its block
   * went to the class placements after their failover; a revoke left a
   * revoked machine's report taken in. From here to the reply's first build
   * nothing is awaited, so no click comes between.
   */
  let runner = getRunner(door.id) ?? door
  // Revoked meanwhile, or gone by an earlier leaving sync of its own (whose repeat is still answered, as syncReply answers it).
  if (!runnerStanding(runner) && !(request.state === 'leaving' && runner.state === 'left')) return refuse(res, 'unauthorized')
  /*
   * A KERNELS BLOCK FROM A MACHINE THAT TAKES NO CLASSES is never handed to
   * the class placements. One that lists class containers starts or keeps
   * the machine's wind-down (store.ts · classesWindingDown): classes turned
   * off under it, or containers home's rows know nothing of — a restart
   * between, a hand-edited row. Every reply then tells it to hold none
   * (windDownBlock), so the containers go now, and no hidden test comes near
   * them meanwhile (heard.ts · classesBeside), whatever its trust. One that
   * lists none ends a wind-down, and is otherwise a block such a machine has
   * no reason to send: refused, and its agent syncs on without it
   * (runner-agent/sync.ts · blockRefused).
   */
  if (request.kernels && !runner.classes) {
    const listing = request.kernels.placements.length > 0
    if (!listing && !runner.classesWindingDown) return refuse(res, 'invalid', 'This machine does not take classes')
    if (listing !== runner.classesWindingDown) runner = updateRunner(runner.id, { classesWindingDown: listing }) ?? runner
  }
  const now = remoteNow()
  callCounts.syncs++
  const address = clientAddress(req)
  const news = noteSync(runner.id, request, now, address)
  const current = noteFacts(runner, request, news, now, address)
  reconcileSync(current, request, now)
  // What it says of its classes, once, as it arrives (a held sync's recompute says nothing new about them), and before a leave moves them.
  if (current.classes && runnerStanding(current) && request.kernels) classPort().noteKernelsReport(current.id, currentReadings(current.id, request.kernels), now)
  // A machine leaving with nothing held revokes itself: its next call is refused, and it stops (colloq-host runner leave).
  if (request.state === 'leaving' && request.attempts.length === 0) leaveRunner(current.id, now)
  const hold = syncHold(request, current)
  // The hold is a real connection's wait, on the wall's clock whatever clock the machines are heard on.
  const ends = Date.now() + hold
  const hungUp = new AbortController()
  res.on('close', () => hungUp.abort())
  // This sync is the machine's newest: the one it held before answers now.
  const superseded = new AbortController()
  holding.get(current.id)?.release()
  const held = { release: (): void => superseded.abort(), holdMs: hold }
  holding.set(current.id, held)
  const done = (): void => {
    if (holding.get(current.id) === held) holding.delete(current.id)
  }
  try {
    let reply = await syncReply(current.id, request, request.state === 'leaving')
    let computed = Date.now()
    while (reply !== null && !reply.news && Date.now() < ends && !hungUp.signal.aborted && !superseded.signal.aborted) {
      await waitForNews(current.id, ends - Date.now(), AbortSignal.any([hungUp.signal, superseded.signal]))
      if (hungUp.signal.aborted) return
      if (superseded.signal.aborted) break
      /*
       * A burst of uploads is a burst of wakes, each of every held sync: one
       * recompute per RECOMPUTE_MS takes them all in, rather than a take per
       * upload per machine.
       */
      const pause = Math.min(computed + RECOMPUTE_MS - Date.now(), ends - Date.now())
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause))
      if (hungUp.signal.aborted) return
      if (superseded.signal.aborted) break
      reply = await syncReply(current.id, request, request.state === 'leaving')
      computed = Date.now()
    }
    if (hungUp.signal.aborted) return
    if (reply === null) return refuse(res, 'unauthorized')
    noteSent(current.id, { digest: reply.digest, wanted: reply.wanted, gone: reply.gone, asked: reply.asked, intents: reply.body.kernels?.placements ?? [] })
    noteWantScope(current.id, reply.body.want)
    res.json(reply.body)
  } finally {
    done()
  }
}

/**
 * How long a sync is held (§3.4): what the machine allows, at most
 * REMOTE_HOLD_IDLE_MS, and REMOTE_HOLD_BUSY_MS while it holds anything — an
 * attempt, a class container its block lists, or a placement home holds on
 * it, listed or not yet: the syncs of a class machine are its classes'
 * heartbeat beside the tunnel (§11.1), and a placement just asked for, still
 * missing from the block, is no reason to hear from the machine twenty-five
 * seconds from now rather than ten.
 */
export function syncHold(request: Pick<RemoteSyncRequest, 'holdMs' | 'attempts' | 'kernels'>, runner: Pick<RunnerRow, 'id' | 'classes'>): number {
  const busy = request.attempts.length > 0 || (request.kernels?.placements.length ?? 0) > 0 || (runner.classes && classPort().hasLivePlacements(runner.id))
  return Math.min(request.holdMs, busy ? REMOTE_HOLD_BUSY_MS : REMOTE_HOLD_IDLE_MS)
}

/**
 * THE GEN FENCE, ON THE SYNC'S SIDE (§6.9, §11.3): a post-mortem reading of a
 * placement the machine no longer holds at that gen — failed over, moved,
 * stopped since — is about no kernel home has, and is not taken in, as a
 * late upload of an older gen is refused at its door. The held placements go
 * through whatever their gen: an older gen listed is how home sees a machine
 * come back, and a container still being removed still takes its memory.
 * The file reports' fence comes with the files (§8.4, §8.8): the late report
 * of a machine that comes back names the paths it changed after the fence,
 * which the room is told.
 */
function currentReadings(runnerId: string, kernels: RemoteKernelsRequest): RemoteKernelsRequest {
  const placements = classPort()
  const readings = kernels.readings.filter((entry) => {
    const slot = parseRemotePlacementKey(entry.key)
    const where = slot ? placements.placementOf(slot.sessionId, slot.role) : null
    return where?.where === 'machine' && where.runnerId === runnerId && where.gen === entry.gen
  })
  return readings.length === kernels.readings.length ? kernels : { ...kernels, readings }
}

/**
 * What a sync says about the machine itself into its row, and its readiness
 * news into its log.
 *
 * THE LOG IS BOUNDED BY WHAT HOME ASKED FOR. A machine's ready lists are its
 * own words, checked for their shape alone: one flipping between two sets of
 * made-up ids wrote 288 rows a sync, tens of thousands a minute into
 * colloq.db, kept for three months, and its page's last fifty lines were all
 * noise — the join and the hidden-test fetches pushed off it. So a readiness
 * line names only a revision or a manifest this server asked the machine for
 * (heard.ts · askedOf), at most READY_EVENTS of them an hour; `outdated` is
 * written when the machine's build stops being home's, not on every change
 * of a build string that never was.
 */
function noteFacts(runner: RunnerRow, request: RemoteSyncRequest, news: SyncNews, now: number, address: string | null): RunnerRow {
  const patch: Parameters<typeof updateRunner>[1] = {}
  if (request.facts && JSON.stringify(request.facts) !== JSON.stringify(runner.facts)) {
    patch.facts = request.facts
    patch.version = request.facts.version
  }
  if (request.build !== runner.build) {
    patch.build = request.build
    // Of another build from now on: it finishes what it holds and is given nothing new (decision 5).
    const home = homeRunnerBuild()
    if (remoteCompatible(home, runner.build ?? '') && !remoteCompatible(home, request.build)) {
      remoteEvent(runner.id, 'outdated', { address, detail: request.facts?.version ?? runner.version ?? null }, now)
    }
  }
  // The cards' echo outlives a restart for the GPU door (heard.ts · remoteCardsSeen): what they are, not how busy.
  const shape = (cards: RemoteSyncRequest['cards']) => JSON.stringify(cards.map((card) => [card.device, card.name, card.memoryMb, card.perDevice]))
  if (shape(request.cards) !== shape(runner.cards)) patch.cards = request.cards
  const updated = Object.keys(patch).length > 0 ? (updateRunner(runner.id, patch) ?? runner) : runner
  // The machine's log names the address each change was heard from (§6 "Audit": addresses go to remote_events).
  const asked = askedOf(runner.id)
  const ready = [
    ...news.revisions.filter((id) => asked.revisions.has(id)).map((id) => ['image_ready', id] as const),
    ...[...news.data, ...news.sealed].filter((manifest) => asked.manifests.has(manifest)).map((manifest) => ['data_ready', manifest.slice(0, 12)] as const),
  ]
  for (const [kind, detail] of ready) {
    if (tooOften(readyEvents, runner.id, 60 * 60_000, READY_EVENTS)) break
    remoteEvent(runner.id, kind, { address, detail }, now)
  }
  // A machine's problems are its own words: at most PROBLEM_EVENTS of them an hour reach its log, however often they change, and one about a thing reaches it only if this server asked for that thing.
  for (const problem of news.problems) {
    if ((problem.revisionId && !asked.revisions.has(problem.revisionId)) || (problem.manifest && !asked.manifests.has(problem.manifest)) || (problem.bundleId && !asked.bundles.has(problem.bundleId))) continue
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
  /** What heard.ts keeps of the reply once it goes out (noteSent). */
  wanted: SentReply['wanted']
  gone: string[]
  asked: SentReply['asked']
}

/**
 * The reply as things stand now, with new work taken for the machine when
 * it may take it: active by the owner's word and its own, of this server's
 * build. `null` — the machine was revoked meanwhile (its held sync answers
 * 401).
 */
async function syncReply(runnerId: string, request: RemoteSyncRequest, leaving: boolean): Promise<SyncAnswer | null> {
  const stock = await homeStock()
  const now = remoteNow()
  const runner = getRunner(runnerId)
  if (!runner || (!runnerStanding(runner) && !(leaving && runner.state === 'left'))) return null
  const compatible = remoteCompatible(homeRunnerBuild(), request.build)
  // The classes' wanted set first: the reply's placements take their share of the machine before any lease does (D24, lease.ts · classShare).
  const intents = classIntentsOf(runner)
  const taken = compatible && runner.state === 'active' && request.state === 'active'
    ? takeForRunner(runner, runnerOffer(runner, request.free, request, intents), now)
    : []
  const fresh = getRunner(runnerId) ?? runner
  const leases = runner.state === 'left' ? [] : pendingOffers(runnerId, now)
  const { revoke, applied } = syncVerdicts(runnerId, request)
  const held = liveLeases(runnerId)
  const takesClasses = fresh.classes && runnerStanding(fresh)
  const want = runner.state === 'left'
    ? { want: { revisions: [], data: [], bundles: [] }, forget: [...wantedBefore(runnerId).keys()].slice(0, REMOTE_MANIFESTS_MAX), wanted: [], gone: [] }
    : runnerWant({
      stock,
      // No hidden data beside classes, whatever the trust (D3, heard.ts · classesBeside).
      trusted: fresh.trusted && !classesBeside(fresh),
      cards: request.cards.length > 0,
      sync: request,
      leases: held,
      wantedBefore: wantedBefore(runnerId),
      classes: takesClasses ? classPort().classRevisionsWanted(runnerId) : [],
    })
  const kernels = takesClasses ? classesBlock(runnerId, intents) : windDownBlock(fresh)
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
    ...(kernels ? { kernels } : {}),
  }
  const digest = newsDigest(body)
  // A leave is answered at once: `runner leave` waits on it, and nothing will come for a machine that is gone.
  const news = runner.state === 'left' || taken.length > 0 || leases.length > 0 || revoke.length > 0 || applied.length > 0 || digest !== sentDigest(runnerId)
  const asked = {
    revisions: [...body.want.revisions.map((revision) => revision.id), ...held.map((lease) => lease.manifest.revision.id)],
    manifests: [...body.want.data.map((entry) => entry.manifest), ...held.flatMap((lease) => [lease.manifest.data.manifest, ...(lease.manifest.sealed ? [lease.manifest.sealed.manifest] : [])])],
    bundles: [...body.want.bundles.map((bundle) => bundle.id), ...held.flatMap((lease) => (lease.manifest.bundle ? [lease.manifest.bundle.id] : []))],
  }
  return { body, news, digest, wanted: body.want.data.map((entry) => ({ competitionId: entry.competitionId, manifest: entry.manifest })), gone: want.gone, asked }
}

/** Everything of a reply but its per-call lists: what the machine has to hear again when it changes. */
function newsDigest(body: RemoteSyncReply): string {
  const { leases: _leases, revoke: _revoke, applied: _applied, seq: _seq, ...rest } = body
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

/* ----------------------------------------------------------------- classes */

const byKey = (a: RemotePlacementIntent, b: RemotePlacementIntent): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/**
 * The block a machine that takes classes gets in every reply (§15): the
 * whole wanted set — ordered by key, so that the same set is the same reply
 * and a change of it is news that answers the held sync at once (newsDigest;
 * the class's ensure wakes it, wake.ts) — the post-mortems home asks for,
 * the rates, the tunnel. The files and the council's epochs join it with
 * their phases.
 *
 * Read with the agent's own parser before it goes. A block the agent refuses
 * is a reply it takes for the path's hiccup and asks again for ever: no
 * lease, no revoke and no word of its classes reach the machine, with the
 * reason in its log alone. A placement that breaks the contract (65 on one
 * machine, a size out of its bounds) is a bug of this server's, answered 500
 * with what broke, rather than cut out of the set: a placement left out is
 * one the machine removes, variables and all.
 */
function classesBlock(runnerId: string, intents: readonly RemotePlacementIntent[]): RemoteKernelsReply {
  const placements = classPort()
  const block: RemoteKernelsReply = {
    placements: [...intents].sort(byKey),
    pushes: [],
    verdicts: [],
    pulls: [],
    scan: [],
    epochs: [],
    collect: [],
    // A question asked twice is a block the agent refuses; the rest are asked by the next replies.
    postmortem: [...new Set(placements.postmortemWanted(runnerId))].filter((key) => REMOTE_PLACEMENT_KEY.test(key)).slice(0, REMOTE_READINGS_MAX),
    rates: classRates(),
    tunnel: placements.tunnelWanted(runnerId),
  }
  try {
    parseRemoteKernelsReply(block)
  } catch (error) {
    throw new Error(`The kernels block for machine ${runnerId} breaks the contract: ${error instanceof Error ? error.message : String(error)}`)
  }
  return block
}

/**
 * The block of a machine that takes no classes: while it winds them down
 * (store.ts · classesWindingDown — set when they were turned off, or when its
 * own block listed class containers, and on the row, so that it outlives a
 * restart of this server and of the agent), hold none — the empty wanted set,
 * the tunnel closed — and the agent removes every one now. `undefined`
 * otherwise: such a machine hears nothing of classes.
 */
function windDownBlock(runner: Pick<RunnerRow, 'classesWindingDown'>): RemoteKernelsReply | undefined {
  if (!runner.classesWindingDown) return undefined
  return { placements: [], pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [], rates: classRates(), tunnel: 'closed' }
}

/**
 * The rates a class machine paces by (§4.9, D18): class bulk at the owner's
 * «Файлы занятий» (CLASS_BULK_MBPS unless set) while any class lives on a
 * machine — every machine and every student share the one leg between the
 * relay and this server — and at CLASS_BULK_IDLE_MBPS otherwise; the
 * tunnel's lanes towards home at MACHINE_PACE_MBPS.
 */
function classRates(): RemoteKernelsReply['rates'] {
  return { classBulkMBps: classPlacementsLive() ? classMachineSettings().classBulkMBps : CLASS_BULK_IDLE_MBPS, machinePaceMBps: MACHINE_PACE_MBPS }
}

/* ---------------------------------------------------------------- outcome */

/**
 * An attempt's outcome (§3.6): applied once by its digest, and the reply
 * carries the machine's next work at once, from the room the outcome says
 * it has now — the stale-capacity rule judged against its last sync.
 *
 * The reply is made NOW, also for a repeated post (the same digest, its first
 * reply lost): the result is the one the first post got (apply.ts), but the
 * leases and the trust are what they are at this moment, never what the
 * first reply carried — an offer made then may have been withdrawn since, or
 * read the hidden test of a machine the owner has stopped trusting.
 *
 * A `draining` decline is the machine stopping (colloq-host runner update
 * --now, a leave, docker stop): its reply carries no work, new or offered
 * before. A stopping agent passes whatever a reply hands it and never syncs
 * again, so each lease in it would sit unacked for its minute
 * (REMOTE_OFFER_MS), its row held for a machine that is gone.
 *
 * THE ATTEMPT REPORTED HERE GAVE ITS PLACE BACK. Its agent may still count it
 * among what it holds in the `free` it sent (the outcome goes out before the
 * attempt is let go), and the lease is over here: counted by neither, a
 * machine at its places was given nothing in every completion reply — one
 * more sync and round trip before each next run, the design's next lease in
 * the reply never coming. So its place is added back to the places (only the
 * places: whether the machine's memory, CPUs, disk and cards hold the next
 * run is still judged by what it says it has, and the owner's cap still
 * holds), which an agent that already left it out gains nothing from.
 */
async function outcome(req: Request, res: Response): Promise<void> {
  const runner = (res.locals as RunnerLocals).runner
  const request = parseRemoteOutcomeRequest(req.body)
  callCounts.outcomes++
  const attemptId = String(req.params.attempt)
  const answer = await applyOutcome(runner.id, attemptId, request)
  if (!answer.ok) return refuse(res, answer.code)
  const now = remoteNow()
  const fresh = getRunner(runner.id) ?? runner
  const sync = lastSync(runner.id)
  const compatible = remoteCompatible(homeRunnerBuild(), request.build)
  const stopping = request.kind === 'declined' && request.reason === 'draining'
  const reported = getLease(attemptId)
  const freed = reported !== null && reported.runnerId === runner.id && !LIVE_LEASE_STATES.includes(reported.state)
  const free = freed ? { ...request.free, slots: request.free.slots + 1 } : request.free
  // Its last sync's list stands for what the outcome's `free` already accounts for: conservative, never over.
  if (!stopping && compatible && fresh.state === 'active' && sync !== null && sync.state === 'active') takeForRunner(fresh, runnerOffer(fresh, free, sync), now)
  const after = getRunner(runner.id) ?? fresh
  const body: RemoteOutcomeReply = { result: answer.result, seq: after.offerSeq, leases: stopping ? [] : pendingOffers(runner.id, now), trusted: after.trusted }
  res.json(body)
}
