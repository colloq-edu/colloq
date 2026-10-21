/**
 * The owner's doors to «Машины для посылок» (shared/remote-admin.ts, Paper
 * page 16): the list, a machine's page, minting a code for the «Подключить
 * машину» dialog, a machine's settings, draining, resuming, disconnecting.
 *
 * OWNER-ONLY, every one of them. A machine sees rivals' notebooks and, when
 * trusted, the hidden test; who may connect one, trust one or read its log
 * is the instance's business, not a course's. A teacher is refused like on
 * the other instance-wide doors (ownerOnly).
 *
 * The code is shown ONCE, here, inside the three join commands
 * (remote/commands.ts) filled in with this server's address and its
 * release's image; the server keeps only its sha256 (remote/store.ts ·
 * mintRemoteCode). `colloq-host runner-code` mints through the same function
 * on the instance's console (ops/runner-code.ts), when the panel is out of
 * reach.
 *
 * CLASSES ON MACHINES (docs/architecture/remote-classes.md §11.5, §15, D2,
 * D3, D32): a code may carry «Принимать занятия», a machine's PATCH turns
 * «Принимает занятия» on or off, «Вернуть» lifts its class quarantine, and
 * «Перенести занятия» moves every class off it now. A machine with classes
 * holds its students' code, files and memory, so the hidden test never goes
 * with them: the pair is refused in words before anything is written, here
 * as in the store (RunnerFlagsError) and the join reply.
 */
import { Router, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import type { AdminErrorBody, AdminErrorReason } from '@shared/admin'
import type { MintRemoteCodeRequest, MintRemoteCodeResponse, RemoteClassAction, UpdateRemoteMachineRequest } from '@shared/remote-admin'
import { REMOTE_ATTEMPTS_MAX, REMOTE_PER_DEVICE_MAX } from '@shared/remote-runner'
import { currentStaff, ownerOnly } from '../admin/auth.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import { config } from '../config.js'
import { COLLOQ_VERSION } from '../version.js'
import { ownImage, runnerImage, runnerJoinCommands } from '../competitions/remote/commands.js'
import { loopbackAddress } from '../competitions/remote/origin.js'
import { loadClassPort, remoteNow } from '../competitions/remote/heard.js'
import { revokeRunner, unclassRunner, untrustRunner } from '../competitions/remote/release.js'
import {
  REMOTE_CODE_MACHINES_MAX,
  RUNNER_NAME_CHARS,
  codeIdOf,
  endLiveCodes,
  endRemoteCode,
  getRunner,
  listRunners,
  mintRefusal,
  mintRemoteCode,
  remoteEvent,
  resumeRunnerClasses,
  runnerStanding,
  setRunnerClasses,
  updateRunner,
  type RunnerPatch,
  type RunnerRow,
} from '../competitions/remote/store.js'
import { runnerPlacementRows } from '../kernel/remote/placement-store.js'
import { machineDetail, machinesResponse } from '../competitions/remote/views.js'
import { wakeAllRunners, wakeRunner } from '../competitions/remote/wake.js'

function fail(res: Response, status: number, reason: AdminErrorReason, message: string): void {
  const body: AdminErrorBody = { error: message, reason }
  res.status(status).json(body)
}

const owner = ownerOnly('server.ownerAction.runners')

/** A whole number in [min, max], or `null` for anything else (a string, a fraction, a boolean). */
function whole(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

/**
 * The two flags a machine never holds together (D3), asked of a PATCH before
 * anything of it is written: trusting a machine that takes classes, or
 * opening one that stays trusted to classes. A patch that untrusts and opens
 * in one go is the owner's order of the two, and passes. `null` — nothing to
 * refuse.
 */
export function flagsRefusal(runner: { trusted: boolean; classes: boolean }, body: { trusted?: unknown; classes?: unknown }): string | null {
  if (body.trusted === true && (runner.classes || body.classes === true)) return tr('admin.runners.classes.trustRefused')
  if (body.classes === true && runner.trusted && body.trusted !== false) return tr('admin.runners.classes.trustedRefused')
  return null
}

/** A machine's name as the owner types it: trimmed, one line, at most RUNNER_NAME_CHARS. */
function nameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= RUNNER_NAME_CHARS && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name) ? name : null
}

export function adminRunnerRoutes(): Router {
  const router = Router()

  router.get('/api/admin/runners', owner, (_req, res, next) => {
    machinesResponse()
      .then((body) => res.set('Cache-Control', 'no-store').json(body))
      .catch(next)
  })

  /*
   * Mint a code (M2). Declared before `/:id`, as every fixed path is:
   * express matches in order, and a machine's id is eight letters that could
   * one day spell a word.
   */
  router.post('/api/admin/runners/codes', owner, (req, res) => {
    const body = (req.body ?? {}) as Partial<MintRemoteCodeRequest>
    const machines = whole(body.machines, 1, REMOTE_CODE_MACHINES_MAX)
    if (machines === null) return fail(res, 400, 'invalid', tr('competitions.refusal.range', { field: 'machines', min: 1, max: REMOTE_CODE_MACHINES_MAX }))
    const hours = whole(body.hours, 1, 24)
    if (hours === null) return fail(res, 400, 'invalid', tr('competitions.refusal.range', { field: 'hours', min: 1, max: 24 }))
    if (body.trusted !== undefined && typeof body.trusted !== 'boolean') return fail(res, 400, 'invalid', tr('server.runners.trustedInvalid'))
    if (body.classes !== undefined && typeof body.classes !== 'boolean') return fail(res, 400, 'invalid', tr('admin.runners.classes.invalid'))
    const approvedSlots = body.approvedSlots === null || body.approvedSlots === undefined ? null : whole(body.approvedSlots, 1, REMOTE_ATTEMPTS_MAX)
    if (body.approvedSlots !== null && body.approvedSlots !== undefined && approvedSlots === null) {
      return fail(res, 400, 'invalid', tr('competitions.refusal.range', { field: 'approvedSlots', min: 1, max: REMOTE_ATTEMPTS_MAX }))
    }
    const namePrefix = typeof body.namePrefix === 'string' && body.namePrefix.trim() ? body.namePrefix.trim() : null
    const input = { machines, hours, trusted: body.trusted === true, classes: body.classes === true, approvedSlots, namePrefix, createdBy: currentStaff(req)!.id }
    const refused = mintRefusal(input)
    if (refused === 'prefix') return fail(res, 400, 'invalid', tr('server.runners.prefixInvalid'))
    // The hidden test and classes on one machine (D3): the dialog greys the one while the other is on, a script is told so.
    if (refused === 'classes') return fail(res, 400, 'invalid', tr('admin.runners.connect.classesSealed'))
    const minted = mintRemoteCode(input)
    // A code is a door for its machines and its hours, trusted ones too: who opened it, and how wide, is the audit's (§6 "Audit").
    recordAdminEvent({
      actor: currentStaff(req),
      action: 'runner.code_minted',
      target: { type: 'runner_code', id: minted.id, label: namePrefix },
      detail: { machines: minted.machines, hours, trusted: minted.trusted, classes: minted.classes, approvedSlots: minted.approvedSlots },
      req,
    })
    /*
     * The image this very server runs, as colloq-host names it to the
     * container (COLLOQ_SERVER_IMAGE): a machine joined from the panel runs
     * this instance's build, as one joined from `colloq-host runner-code`
     * does. Without the variable (a checkout, an old host script), the
     * published image of this release.
     */
    const image = runnerImage(ownImage(), COLLOQ_VERSION)
    const answer: MintRemoteCodeResponse = {
      id: minted.id,
      code: minted.code,
      expiresAt: minted.expiresAt,
      machines: minted.machines,
      trusted: minted.trusted,
      ...(minted.classes ? { classes: true } : {}),
      // A code for classes tells `runner up` so (`--classes`): the machine checks it can host them before anything is pulled.
      commands: runnerJoinCommands({ home: config.publicUrl, code: minted.code, image: image.image, published: image.published, machines: minted.machines, classes: minted.classes }),
      // An address only this machine reaches (the default PUBLIC_URL): no machine anywhere else can join with it, and the dialog says so.
      loopback: loopbackAddress(config.publicUrl),
    }
    res.set('Cache-Control', 'no-store').json(answer)
  })

  /*
   * «Отменить» a code (M1's list of codes): it enrolls no machine from now
   * on — no use left, expired now (store.ts · endRemoteCode). Declared before
   * `/:id` with the other fixed paths. The machines it already enrolled stay;
   * the owner disconnects those one by one, or all at once.
   */
  router.delete('/api/admin/runners/codes/:id', owner, (req, res, next) => {
    const id = String(req.params.id)
    const ended = endRemoteCode(id)
    if ('refused' in ended) {
      return ended.refused === 'ambiguous'
        ? fail(res, 409, 'invalid', tr('server.runners.codeAmbiguous'))
        : fail(res, 404, 'not_found', tr('server.runners.codeNotFound'))
    }
    recordAdminEvent({ actor: currentStaff(req), action: 'runner.code_ended', target: { type: 'runner_code', id, label: ended.ended.namePrefix || null }, detail: { machines: ended.ended.machines, trusted: ended.ended.trusted }, req })
    machinesResponse()
      .then((body) => res.set('Cache-Control', 'no-store').json(body))
      .catch(next)
  })

  /*
   * «Отключить все»: every machine still connected, each recorded as the
   * owner's disconnect of it — and every code still valid ended with them.
   * Disconnecting every machine while a code had uses left left the door it
   * came through open: whoever held the code (it sits in every machine's
   * COLLOQ_RUNNER_JOIN) enrolled a fresh machine at once, trusted if the code
   * was. After «Отключить все» a machine comes back only with a new code.
   */
  router.post('/api/admin/runners/revoke-all', owner, (req, res, next) => {
    const now = remoteNow()
    for (const runner of listRunners()) {
      if (!runnerStanding(runner)) continue
      if (revokeRunner(runner.id, now)) {
        recordAdminEvent({ actor: currentStaff(req), action: 'runner.revoked', target: { type: 'runner', id: runner.id, label: runner.name }, detail: { all: true }, req })
      }
    }
    for (const code of endLiveCodes(now)) {
      recordAdminEvent({ actor: currentStaff(req), action: 'runner.code_ended', target: { type: 'runner_code', id: codeIdOf(code.codeSha256), label: code.namePrefix || null }, detail: { machines: code.machines, trusted: code.trusted, all: true }, req })
    }
    machinesResponse()
      .then((body) => res.json(body))
      .catch(next)
  })

  router.get('/api/admin/runners/:id', owner, (req, res, next) => {
    machineDetail(String(req.params.id))
      .then((body) => (body ? res.set('Cache-Control', 'no-store').json(body) : fail(res, 404, 'not_found', tr('server.runners.notFound'))))
      .catch(next)
  })

  /* A machine's settings (M3). A field left out is left as it is; the whole patch or none of it. */
  router.patch('/api/admin/runners/:id', owner, (req, res, next) => {
    const runner = getRunner(String(req.params.id))
    if (!runner) return fail(res, 404, 'not_found', tr('server.runners.notFound'))
    if (!runnerStanding(runner)) return fail(res, 409, 'invalid', tr('server.runners.gone'))
    const body = (req.body ?? {}) as UpdateRemoteMachineRequest & Record<string, unknown>
    const patch: RunnerPatch = {}
    if (body.name !== undefined) {
      const name = nameOf(body.name)
      if (name === null) return fail(res, 400, 'invalid', tr('server.runners.nameInvalid', { max: RUNNER_NAME_CHARS }))
      patch.name = name
    }
    if (body.approvedSlots !== undefined) {
      const slots = body.approvedSlots === null ? null : whole(body.approvedSlots, 1, REMOTE_ATTEMPTS_MAX)
      if (body.approvedSlots !== null && slots === null) return fail(res, 400, 'invalid', tr('competitions.refusal.range', { field: 'approvedSlots', min: 1, max: REMOTE_ATTEMPTS_MAX }))
      patch.approvedSlots = slots
    }
    if (body.perDevice !== undefined) {
      const perDevice = body.perDevice === null ? null : whole(body.perDevice, 1, REMOTE_PER_DEVICE_MAX)
      if (body.perDevice !== null && perDevice === null) return fail(res, 400, 'invalid', tr('competitions.refusal.range', { field: 'perDevice', min: 1, max: REMOTE_PER_DEVICE_MAX }))
      patch.perDevice = perDevice
    }
    if (body.trusted !== undefined && typeof body.trusted !== 'boolean') return fail(res, 400, 'invalid', tr('server.runners.trustedInvalid'))
    if (body.classes !== undefined && typeof body.classes !== 'boolean') return fail(res, 400, 'invalid', tr('admin.runners.classes.invalid'))
    /*
     * The hidden test never goes beside classes (D3): refused in words here,
     * before the first write of this patch, so that a refused trust leaves
     * no half of the patch behind (a new name, a cap) and never reaches the
     * store's own lock, which would answer a 500.
     */
    const refusal = flagsRefusal(runner, body)
    if (refusal !== null) return fail(res, 409, 'invalid', refusal)
    // Turning classes off moves them first, by the class placements (loaded with the machines' clock at boot): sure to be there before a write.
    const placements = body.classes === false && runner.classes ? loadClassPort() : Promise.resolve(null)
    void placements
      .then(() => {
        applyPatch(req, res, runner, body, patch)
        return machineDetail(runner.id)
      })
      .then((detail) => {
        if (!res.headersSent) res.json(detail)
      })
      .catch(next)
  })

  /** The PATCH's writes, in their order, once nothing of it is refused: names and numbers, the trust, the classes. */
  function applyPatch(req: Request, res: Response, runner: RunnerRow, body: UpdateRemoteMachineRequest & Record<string, unknown>, patch: RunnerPatch): void {
    const now = remoteNow()
    if (Object.keys(patch).length > 0) updateRunner(runner.id, patch)
    if (patch.name !== undefined && patch.name !== runner.name) remoteEvent(runner.id, 'renamed', { detail: patch.name }, now)
    if (typeof body.trusted === 'boolean' && body.trusted !== runner.trusted) {
      // Untrusted: the runs reading the hidden test go back to the queue, and the machine purges it (release.ts · untrustRunner).
      if (body.trusted) {
        updateRunner(runner.id, { trusted: true })
        remoteEvent(runner.id, 'trusted', {}, now)
      } else untrustRunner(runner.id, now)
      recordAdminEvent({ actor: currentStaff(req), action: 'runner.trusted', target: { type: 'runner', id: runner.id, label: runner.name }, detail: { trusted: body.trusted }, req })
    }
    if (typeof body.classes === 'boolean' && body.classes !== runner.classes) {
      /*
       * On: the row alone — its classes come with the next placement that
       * fits there (§6.3). Off: its classes move FIRST, then the flag, the
       * log's `unclassed` and its tunnel closed (release.ts · unclassRunner).
       */
      if (body.classes) {
        const set = setRunnerClasses(runner.id, true)
        if ('refused' in set) {
          return set.refused === 'trusted'
            ? fail(res, 409, 'invalid', tr('admin.runners.classes.trustedRefused'))
            : fail(res, 409, 'invalid', tr('server.runners.gone'))
        }
      } else {
        const unset = unclassRunner(runner.id, now)
        if ('refused' in unset) return fail(res, 409, 'invalid', tr('server.runners.gone'))
      }
      // Who opened a machine to the classes' code, data, files and personal notebooks, and who took them off it, is the audit's (§12).
      recordAdminEvent({ actor: currentStaff(req), action: 'runner.classes', target: { type: 'runner', id: runner.id, label: runner.name }, detail: { classes: body.classes }, req })
    }
    wakeRunner(runner.id)
    // More places or a trusted machine may mean work can be taken right now.
    wakeAllRunners()
  }

  /*
   * A machine's classes (§11.5, §11.6): «Вернуть» under the class quarantine
   * banner, and «Перенести занятия». Declared before `/:id/:action`, as the
   * fixed paths are, though the two never meet (three segments against two).
   */
  router.post('/api/admin/runners/:id/classes/:action', owner, (req: Request, res: Response, next) => {
    const runner = getRunner(String(req.params.id))
    if (!runner) return fail(res, 404, 'not_found', tr('server.runners.notFound'))
    if (!runnerStanding(runner)) return fail(res, 409, 'invalid', tr('server.runners.gone'))
    const action = String(req.params.action) as RemoteClassAction
    const now = remoteNow()
    if (action === 'resume') {
      // The quarantine forgotten, its window starting over from now (store.ts · resumeRunnerClasses), said in its log, and the machine woken.
      const resumed = resumeRunnerClasses(runner.id, now)
      if ('refused' in resumed) return fail(res, 409, 'invalid', tr('server.runners.gone'))
      if (resumed.changed) {
        remoteEvent(runner.id, 'classes_resumed', {}, now)
        recordAdminEvent({ actor: currentStaff(req), action: 'runner.classes_resumed', target: { type: 'runner', id: runner.id, label: runner.name }, req })
      }
      wakeRunner(runner.id)
      machineDetail(runner.id)
        .then((detail) => res.json(detail))
        .catch(next)
      return
    }
    if (action === 'move') {
      /*
       * Every class slot on the machine moves now (§11.1 «Перенести сейчас»
       * for all of them): to another machine that fits, or here, its
       * variables lost and its files as of the last sync. The machine keeps
       * taking classes; a slot it held avoids it for a while (placement.ts ·
       * AVOID_MS). One class's refusal stops none of the others.
       */
      const slots = runnerPlacementRows(runner.id).filter((row) => row.state !== 'stopping')
      if (slots.length === 0) return fail(res, 409, 'invalid', tr('admin.runners.classes.nothingToMove'))
      const by = currentStaff(req)?.name ?? ''
      recordAdminEvent({ actor: currentStaff(req), action: 'runner.classes_moved', target: { type: 'runner', id: runner.id, label: runner.name }, detail: { slots: slots.length }, req })
      void import('../kernel/remote/placement.js')
        .then(({ moveNow }) => Promise.all(slots.map((row) => moveNow(row.sessionId, row.role, by))))
        .then(() => machineDetail(runner.id))
        .then((detail) => res.json(detail))
        .catch(next)
      return
    }
    return fail(res, 404, 'not_found', tr('server.runners.notFound'))
  })

  router.post('/api/admin/runners/:id/:action', owner, (req: Request, res: Response, next) => {
    const runner = getRunner(String(req.params.id))
    if (!runner) return fail(res, 404, 'not_found', tr('server.runners.notFound'))
    const action = String(req.params.action)
    const now = remoteNow()
    if (action === 'revoke') {
      if (revokeRunner(runner.id, now)) {
        recordAdminEvent({ actor: currentStaff(req), action: 'runner.revoked', target: { type: 'runner', id: runner.id, label: runner.name }, req })
      }
    } else if (action === 'drain' || action === 'resume') {
      if (!runnerStanding(runner)) return fail(res, 409, 'invalid', tr('server.runners.gone'))
      if (action === 'drain' && runner.state === 'active') {
        updateRunner(runner.id, { state: 'draining' })
        remoteEvent(runner.id, 'drained', {}, now)
      }
      if (action === 'resume' && (runner.state === 'draining' || runner.quarantinedAt !== null)) {
        // Back to work, and a quarantine forgotten: the owner has looked, and decided — its window starts over from here (release.ts · quarantineIfDue).
        updateRunner(runner.id, { state: 'active', quarantinedAt: null, quarantineSeen: true, resumedAt: now })
        remoteEvent(runner.id, 'resumed', {}, now)
      }
      wakeRunner(runner.id)
      wakeAllRunners()
    } else return fail(res, 404, 'not_found', tr('server.runners.notFound'))
    machineDetail(runner.id)
      .then((detail) => res.json(detail))
      .catch(next)
  })

  return router
}
