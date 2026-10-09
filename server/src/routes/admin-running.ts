/**
 * «Работают сейчас» on the Resources tab: what holds the machine's memory
 * right now, and the owner's way to free it.
 *
 * Until 0.20 the panel showed how much was promised, as one bar, and nothing
 * else. On 9 Oct 2026 a fifteen-gigabyte machine refused every new kernel
 * for an evening: three classes nobody was in held four gigabytes of
 * reservation each, and the only things that could free them were a two-hour
 * idle timer and ssh. This lists every class container with what it reserves
 * and really uses, who is in the room and what it computes, plus the
 * competition runs and package preparations holding reservations, and lets
 * the owner stop a class's kernels, or every idle one at once.
 *
 * GET is for staff, scoped like the rest of the panel since 0.19: a room the
 * viewer does not teach is a row of numbers ("another class"), never its name
 * or its people, because the machine is shared and its sums must add up on
 * every screen. Stopping is the owner's: it reaches into other teachers'
 * classes, the same reason the instance resources are the owner's to change.
 *
 * Competition runs are listed but not stopped here: they have their door
 * (POST /api/admin/competitions/queue/kill), and a second one would be a
 * second set of rules to keep in step.
 */
import { Router, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import { CELLS_KEY, bookList, defaultBookName } from '@shared/notebook'
import { canSeeCourse, canSeeRoom, coursesOfRoom, isOwner, type StaffLike } from '../admin/access.js'
import { currentStaff, ownerOnly, requireStaff } from '../admin/auth.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import { liveSince, onlineCount, peekSessionDoc } from '../collab/index.js'
import { runReservationMb } from '../competitions/runner.js'
import { limitsFor } from '../competitions/runner-port.js'
import { canSeeCompetition } from '../competitions/scope.js'
import { getCompetition, getSubmission, runningRows } from '../competitions/store.js'
import { getParticipant, getSession, storedRules } from '../db.js'
import { runningPreparations } from '../dependencies/service.js'
import {
  classActivity,
  environmentOf,
  kernelClasses,
  KernelStopRefusal,
  stopBlocker,
  stopKernelsByOwner,
  type ClassActivity,
  type ClassBusy,
} from '../kernel/index.js'
import { forgetResources } from '../kernel/resources.js'
import { kernelBackend } from '../kernel/runtime-client.js'
import { containerCensus, forgetContainerUsage, type ContainerCensus, type ContainerReading } from '../kernel/usage.js'
import { getCourse } from '../publish/store.js'
import type {
  AdminErrorBody,
  RunningBook,
  RunningBusy,
  RunningClass,
  RunningContainer,
  RunningKernels,
  RunningPreparation,
  RunningRun,
  StopIdleKernelsResponse,
  StopKernelBusy,
  StopKernelResponse,
} from '@shared/admin'

const iso = (at: number | null | undefined): string | null =>
  typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : null

/** A notebook's path as the room shows it, without loading a document that is not in memory. */
function pathsOf(sessionId: string): (root: string) => string {
  const doc = peekSessionDoc(sessionId)?.doc ?? null
  const books = doc ? bookList(doc) : []
  return (root) => books.find((book) => book.root === root)?.path ?? (root === CELLS_KEY ? defaultBookName() : root)
}

/** Personal notebooks' owners by root, by the name they had when they made them. */
function ownersOf(sessionId: string): (root: string) => string | null {
  let books: ReturnType<typeof storedRules>['books'] | undefined
  try {
    books = storedRules(sessionId).books
  } catch {
    books = undefined
  }
  return (root) => books?.[root]?.ownerName ?? null
}

/**
 * What the class is busy with, in words a viewer may read. Who pressed is a
 * name, and only for a room the viewer teaches; another class says only the
 * kind of work and since when.
 */
function busyView(sessionId: string, busy: ClassBusy | null, visible: boolean): RunningBusy | null {
  if (!busy) return null
  if (!visible) return { kind: busy.kind, who: null, book: null, since: iso(busy.since) }
  const who = busy.participantId ? (getParticipant(sessionId, busy.participantId)?.name ?? null) : null
  return { kind: busy.kind, who, book: busy.root === null ? null : pathsOf(sessionId)(busy.root), since: iso(busy.since) }
}

function containerView(reading: ContainerReading | undefined): RunningContainer | null {
  if (!reading) return null
  return {
    role: reading.role,
    state: reading.state,
    reservedMb: reading.memoryMb,
    usedMb: reading.usedMb,
    cpus: reading.cpus,
    cpuPercent: reading.cpuPercent,
    startedAt: iso(reading.startedAt),
  }
}

/** The first course seating the room that the viewer may see. */
function courseOf(sessionId: string, viewer: StaffLike): RunningClass['course'] {
  for (const courseId of coursesOfRoom(sessionId)) {
    if (!canSeeCourse(viewer, courseId)) continue
    const course = getCourse(courseId)
    if (course) return { id: course.id, name: course.name }
  }
  return null
}

interface Held {
  room?: ContainerReading
  own?: ContainerReading
}

/** The class's containers by role, from one census. */
function heldBy(census: ContainerCensus): Map<string, Held> {
  const out = new Map<string, Held>()
  for (const container of census.containers) {
    const held = out.get(container.session) ?? {}
    held[container.role] = container
    out.set(container.session, held)
  }
  /*
   * Classes with live kernels this process holds, though no container was
   * counted: the test backend has none, and a census that failed must not
   * make a computing room vanish from the list.
   */
  if (kernelBackend() === 'test' || !census.complete) {
    for (const id of kernelClasses()) if (!out.has(id)) out.set(id, {})
  }
  return out
}

function classRow(sessionId: string, held: Held, activity: ClassActivity, viewer: StaffLike): RunningClass {
  const visible = canSeeRoom(viewer, sessionId)
  const online = onlineCount(sessionId)
  const busy = busyView(sessionId, activity.busy, visible)
  const idle = online === 0 && activity.busy === null && !activity.stopping
  const room = containerView(held.room)
  const own = containerView(held.own)
  const somethingToStop = room !== null || own !== null || activity.scopes.length > 0
  const common = {
    gpu: held.room?.gpu ?? null,
    online,
    liveSince: iso(liveSince(sessionId)),
    busy,
    idleSince: iso(activity.idleSince),
    stopsAt: iso(activity.stopsAt),
    room,
    own,
    canStop: isOwner(viewer) && somethingToStop && !activity.stopping,
    idle,
  }
  if (!visible) {
    return { id: null, hidden: true, name: null, course: null, environment: null, books: [], ...common }
  }
  const path = pathsOf(sessionId)
  const owner = ownersOf(sessionId)
  const books: RunningBook[] = activity.scopes.map((scope) => ({
    root: scope.root,
    path: path(scope.root),
    role: scope.role,
    phase: scope.phase,
    owner: scope.role === 'own' ? owner(scope.root) : null,
    lastWorkAt: iso(scope.lastWorkAt),
  }))
  return {
    id: sessionId,
    hidden: false,
    name: getSession(sessionId)?.name ?? null,
    course: courseOf(sessionId, viewer),
    // The label the container was started with; without a container, what this process's kernel came up on.
    environment: held.room?.environment ?? held.own?.environment ?? environmentOf(sessionId),
    books,
    ...common,
  }
}

/** Competition runs holding a reservation; another course's is a slot and a clock, nothing of whose. */
function runRows(viewer: StaffLike): RunningRun[] {
  const out: RunningRun[] = []
  for (const row of runningRows()) {
    const competition = getCompetition(row.competitionId)
    const submission = getSubmission(row.submissionId)
    const startedAt = iso(row.startedAt ?? submission?.acceptedAt ?? null) ?? new Date().toISOString()
    const visible = competition !== null && canSeeCompetition(viewer, competition)
    out.push({
      submissionId: visible ? row.submissionId : null,
      competitionId: visible ? row.competitionId : null,
      competition: visible ? competition.title : null,
      hidden: !visible,
      kind: row.kind === 'metric' ? 'score' : 'run',
      startedAt,
      limitSec: competition ? limitsFor(competition, row.kind).wallSeconds : null,
      reservedMb: competition ? runReservationMb(competition, row.kind) : 0,
      canStop: visible,
    })
  }
  return out
}

/** Package preparations holding their lease; the competition's title only for whoever may read it. */
function preparationRows(viewer: StaffLike): RunningPreparation[] {
  return runningPreparations().map((prep) => {
    const competition = getCompetition(prep.competitionId)
    const visible = competition !== null && canSeeCompetition(viewer, competition)
    return {
      id: prep.id,
      label: visible ? competition.title : null,
      reservedMb: prep.memoryMb,
      startedAt: iso(prep.startedAt),
    }
  })
}

async function runningKernels(viewer: StaffLike): Promise<RunningKernels> {
  const now = Date.now()
  const census = await containerCensus()
  const held = heldBy(census)
  const classes = [...held]
    .map(([sessionId, containers]) => classRow(sessionId, containers, classActivity(sessionId, now), viewer))
    .sort((a, b) => reservedOf(b) - reservedOf(a) || (a.name ?? '').localeCompare(b.name ?? ''))
  const containers = census.containers
  const live = census.usage === 'live'
  return {
    backend: kernelBackend(),
    complete: census.complete,
    sampledAt: new Date(now).toISOString(),
    usage: live ? 'live' : 'unknown',
    reservedMb: containers.reduce((sum, container) => sum + (container.memoryMb ?? 0), 0),
    usedMb: live ? containers.reduce((sum, container) => sum + (container.usedMb ?? 0), 0) : null,
    classes,
    runs: runRows(viewer),
    preparations: preparationRows(viewer),
  }
}

function reservedOf(row: RunningClass): number {
  return (row.room?.reservedMb ?? 0) + (row.own?.reservedMb ?? 0)
}

/* ------------------------------------------------------------------ stop */

type Skip = StopIdleKernelsResponse['skipped'][number]['reason']

type StopOutcome =
  | { status: 200; body: StopKernelResponse }
  /** `skip`: the same refusal in the batch's words (`stop-idle`). */
  | { status: 404 | 409 | 503; body: AdminErrorBody | StopKernelBusy; skip: Skip }

/**
 * Stop one class's kernels (`class`) or only its personal notebooks' (`own`),
 * then record it. The memory freed is what the stopped containers reserved,
 * read before the stop from the same census the list shows; and it is said
 * only when the runtime confirmed the removal (kernel/pool.ts · OwnerStop),
 * since a failed one answers 503 instead.
 *
 * `via: 'idle'` is one class of the batch: the batch's census is reused
 * rather than sampled again per class (each `docker stats` is a second or
 * two, a second or two in which someone may walk in), and the stop itself
 * refuses a class that is no longer empty and quiet (`idleOnly`), in the
 * same synchronous stretch as its gate going up.
 */
async function stopOne(
  req: Request,
  sessionId: string,
  what: 'class' | 'own',
  force: boolean,
  via: 'row' | 'idle',
  taken?: ContainerCensus,
): Promise<StopOutcome> {
  const census = taken ?? (await containerCensus())
  const held = census.containers.filter(
    (container) => container.session === sessionId && (what === 'class' || container.role === 'own'),
  )
  const scopes = classActivity(sessionId).scopes.filter((scope) => what === 'class' || scope.role === 'own')
  if (held.length === 0 && scopes.length === 0) {
    // A census that did not answer is not proof there is nothing: say so.
    if (!census.complete) {
      return { status: 503, body: { error: tr('server.running.censusUnavailable'), reason: 'failed' }, skip: 'failed' }
    }
    return { status: 404, body: { error: tr('server.running.notFound'), reason: 'not_found' }, skip: 'gone' }
  }
  const online = onlineCount(sessionId)
  const cut = stopBlocker(sessionId, what)
  try {
    await stopKernelsByOwner(sessionId, what, { force, idleOnly: via === 'idle' })
  } catch (err) {
    if (err instanceof KernelStopRefusal) {
      if (err.reason === 'busy' && err.busy) {
        const busy = busyView(sessionId, err.busy, true)!
        return { status: 409, body: { error: err.message, reason: 'busy', busy }, skip: 'busy' }
      }
      // Somebody came in: only the batch asks for that refusal, and it reads `skip`.
      if (err.reason === 'online') return { status: 409, body: { error: err.message, reason: 'busy' }, skip: 'online' }
      return { status: 409, body: { error: err.message, reason: 'stopping' }, skip: 'stopping' }
    }
    const why = err instanceof Error ? err.message : String(err)
    console.error(`[admin] the owner's stop of ${sessionId} (${what}) failed:`, why)
    return { status: 503, body: { error: tr('server.running.failed', { p0: why }), reason: 'failed' }, skip: 'failed' }
  } finally {
    // Whatever happened, the bar and the list must ask again.
    forgetResources()
    forgetContainerUsage()
  }
  const freedMb = held.reduce((sum, container) => sum + (container.memoryMb ?? 0), 0)
  recordAdminEvent({
    actor: currentStaff(req),
    action: 'room.kernel_stopped',
    target: { type: 'room', id: sessionId, label: getSession(sessionId)?.name ?? null },
    // Numbers only: who was computing is a student's name, and this log is not theirs.
    detail: { what, freedMb, forced: force && cut !== null, online, ...(via === 'idle' ? { idle: true } : {}) },
    req,
  })
  return { status: 200, body: { stopped: true, freedMb } }
}

/** The body of `stop-idle`: the classes the owner confirmed, or `undefined` for every idle one. */
function confirmedIds(body: unknown): string[] | undefined | null {
  const ids = (body as { ids?: unknown } | null | undefined)?.ids
  if (ids === undefined) return undefined
  if (!Array.isArray(ids) || ids.length > 1000 || !ids.every((id) => typeof id === 'string' && id.length > 0)) return null
  return [...new Set(ids as string[])]
}

export function adminRunningRoutes(): Router {
  const router = Router()

  router.get('/api/admin/resources/running', requireStaff, (req, res, next) => {
    const viewer = currentStaff(req)!
    runningKernels(viewer)
      .then((body) => res.set('Cache-Control', 'no-store').json(body))
      .catch(next)
  })

  /*
   * Registered before `/:sessionId/stop` would not matter (two segments
   * against three), but kept first so that the path reads as what it is.
   */
  router.post('/api/admin/resources/running/stop-idle', ownerOnly('server.ownerAction.stopKernel'), (req, res, next) => {
    /*
     * `ids`: the classes the confirmation listed (StopIdleKernelsRequest).
     * Only those are stopped, and only those are reported: the owner agreed
     * to these names and this many gigabytes, and a class that went idle
     * since the dialog opened is not among them. Without it, as from a
     * script, every class the census shows is considered.
     */
    const requested = confirmedIds(req.body)
    if (requested === null) {
      const refusal: AdminErrorBody = { error: tr('server.running.idsInvalid'), reason: 'invalid' }
      res.status(400).json(refusal)
      return
    }
    void (async () => {
      const census = await containerCensus()
      const ids = requested ?? [...heldBy(census).keys()]
      const out: StopIdleKernelsResponse = { stopped: [], skipped: [], freedMb: 0 }
      /*
       * One by one, and each re-checked at its own moment, inside the stop
       * (`idleOnly`): the list the owner pressed on is up to fifteen seconds
       * old, and a class someone walked into since is not idle any more. One
       * the sweep or another stop took meanwhile is `gone`.
       */
      for (const id of ids) {
        const outcome = await stopOne(req, id, 'class', false, 'idle', census)
        if (outcome.status === 200) {
          const freedMb = outcome.body.freedMb
          out.stopped.push({ id, freedMb })
          out.freedMb += freedMb
          continue
        }
        out.skipped.push({ id, reason: outcome.skip })
      }
      res.set('Cache-Control', 'no-store').json(out)
    })().catch(next)
  })

  router.post(
    '/api/admin/resources/running/:sessionId/stop',
    ownerOnly('server.ownerAction.stopKernel'),
    (req: Request, res: Response, next) => {
      const sessionId = String(req.params.sessionId)
      const body = (req.body ?? {}) as { what?: unknown; force?: unknown }
      if (body.what !== 'class' && body.what !== 'own') {
        const refusal: AdminErrorBody = { error: tr('server.running.whatInvalid'), reason: 'invalid' }
        return res.status(400).json(refusal)
      }
      stopOne(req, sessionId, body.what, body.force === true, 'row')
        .then((outcome) => res.status(outcome.status).set('Cache-Control', 'no-store').json(outcome.body))
        .catch(next)
    },
  )

  return router
}
