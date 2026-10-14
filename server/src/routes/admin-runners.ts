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
 */
import { Router, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import type { AdminErrorBody, AdminErrorReason } from '@shared/admin'
import type { MintRemoteCodeRequest, MintRemoteCodeResponse, UpdateRemoteMachineRequest } from '@shared/remote-admin'
import { REMOTE_ATTEMPTS_MAX, REMOTE_PER_DEVICE_MAX } from '@shared/remote-runner'
import { currentStaff, ownerOnly } from '../admin/auth.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import { config } from '../config.js'
import { COLLOQ_VERSION } from '../version.js'
import { ownImage, runnerImage, runnerJoinCommands } from '../competitions/remote/commands.js'
import { revokeRunner, untrustRunner } from '../competitions/remote/release.js'
import {
  REMOTE_CODE_MACHINES_MAX,
  RUNNER_NAME_CHARS,
  getRunner,
  listRunners,
  mintRefusal,
  mintRemoteCode,
  remoteEvent,
  runnerStanding,
  updateRunner,
  type RunnerPatch,
} from '../competitions/remote/store.js'
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
    const approvedSlots = body.approvedSlots === null || body.approvedSlots === undefined ? null : whole(body.approvedSlots, 1, REMOTE_ATTEMPTS_MAX)
    if (body.approvedSlots !== null && body.approvedSlots !== undefined && approvedSlots === null) {
      return fail(res, 400, 'invalid', tr('competitions.refusal.range', { field: 'approvedSlots', min: 1, max: REMOTE_ATTEMPTS_MAX }))
    }
    const namePrefix = typeof body.namePrefix === 'string' && body.namePrefix.trim() ? body.namePrefix.trim() : null
    const input = { machines, hours, trusted: body.trusted === true, approvedSlots, namePrefix, createdBy: currentStaff(req)!.id }
    if (mintRefusal(input) === 'prefix') return fail(res, 400, 'invalid', tr('server.runners.prefixInvalid'))
    const minted = mintRemoteCode(input)
    const image = runnerImage(ownImage(), COLLOQ_VERSION)
    const answer: MintRemoteCodeResponse = {
      code: minted.code,
      expiresAt: minted.expiresAt,
      machines: minted.machines,
      trusted: minted.trusted,
      commands: runnerJoinCommands({ home: config.publicUrl, code: minted.code, image: image.image, published: image.published, machines: minted.machines }),
    }
    res.set('Cache-Control', 'no-store').json(answer)
  })

  /* «Отключить все»: every machine still connected, each recorded as the owner's disconnect of it. */
  router.post('/api/admin/runners/revoke-all', owner, (req, res, next) => {
    const now = Date.now()
    for (const runner of listRunners()) {
      if (!runnerStanding(runner)) continue
      if (revokeRunner(runner.id, now)) {
        recordAdminEvent({ actor: currentStaff(req), action: 'runner.revoked', target: { type: 'runner', id: runner.id, label: runner.name }, detail: { all: true }, req })
      }
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
    const now = Date.now()
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
    wakeRunner(runner.id)
    // More places or a trusted machine may mean work can be taken right now.
    wakeAllRunners()
    machineDetail(runner.id)
      .then((detail) => res.json(detail))
      .catch(next)
  })

  router.post('/api/admin/runners/:id/:action', owner, (req: Request, res: Response, next) => {
    const runner = getRunner(String(req.params.id))
    if (!runner) return fail(res, 404, 'not_found', tr('server.runners.notFound'))
    const action = String(req.params.action)
    const now = Date.now()
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
        // Back to work, and a quarantine forgotten: the owner has looked, and decided.
        updateRunner(runner.id, { state: 'active', quarantinedAt: null, quarantineSeen: true })
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
