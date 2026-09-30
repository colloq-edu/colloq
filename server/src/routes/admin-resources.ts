/**
 * The instance's resource defaults, as one door for the panel.
 *
 * GET is for staff: a teacher sizing a class needs to see what a room gets by
 * default and how much of the machine is already promised. PUT is the
 * owner's, for the same reason the oracle's settings are: one number here
 * reaches every class on the machine, including the ones other teachers are
 * running right now, while a teacher's own class already has its own fields
 * (routes/admin-instance.ts · memoryMb, cpus, the ownMemoryMb/ownCpus rules).
 *
 * Both answer with the same payload, so the panel never has to guess what a
 * clamped write turned into.
 */
import { Router, type Response } from 'express'
import { currentStaff, ownerOnly, requireStaff } from '../admin/auth.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import {
  parseResourcePatch,
  perEnvironmentMemoryMb,
  ResourceRefusal,
  resourceBounds,
  resourceSettings,
  updateResourceSettings,
  type MachineBounds,
} from '../admin/resource-settings.js'
import { slotsResolution } from '../competitions/capacity.js'
import { competitionDefaults } from '../competitions/settings.js'
import { listNames } from '../environments.js'
import { reapplyInstanceDefaults, runningKernelLimits, type RunningKernel } from '../kernel/pool.js'
import {
  cpuBounds,
  forgetResources,
  HOST_RESERVE_MB,
  machineResources,
  memoryBounds,
} from '../kernel/resources.js'
import { kernelBackend } from '../kernel/runtime-client.js'
import type {
  AdminErrorBody,
  InstanceResources,
  ResourceBudget,
  ResourceSettingName,
  ResourceSettingsResponse,
} from '@shared/admin'

function invalid(res: Response, error: string): Response {
  const body: AdminErrorBody = { error, reason: 'invalid' }
  return res.status(400).json(body)
}

/** The machine's share of the bounds, asked after a collection so the daemon's numbers are fresh. */
function machineBounds(): MachineBounds {
  return { memory: memoryBounds(), cpus: cpuBounds() }
}

/* ---------------------------------------------------------- competitions */

/**
 * ADAPTER: the competitions queue's share of the machine, read from the
 * competitions side's own settings (server/src/competitions/*, owned
 * separately): the slots in effect times what a new submission gets by
 * default. A ceiling on concurrency, not current use: a slot is a promise the
 * queue may cash in at any moment.
 *
 * Kept to this one function so that a change on their side is a change here
 * only. If their settings cannot be read, the answer is "unknown" and the bar
 * leaves the segment out: a made-up number on a capacity bar is worse than a
 * missing one. The shape is the contract (shared/admin.ts ·
 * ResourceBudget.competitions).
 */
function competitionShare(): ResourceBudget['competitions'] {
  try {
    const slots = slotsResolution().effective
    const { limits } = competitionDefaults()
    return { slots, memoryMb: slots * limits.memoryMb, cpus: slots * limits.cpus }
  } catch (err) {
    const why = err instanceof Error ? err.message : err
    console.warn('[admin] competition settings unreadable for the budget:', why)
    return { slots: null, memoryMb: null, cpus: null }
  }
}

/* ---------------------------------------------------------------- budget */

/**
 * How the machine is promised right now, for a stacked bar: running room
 * kernels, running personal-notebook containers and competition slots, each
 * by the limits they are held to, against the machine minus its reserve.
 *
 * A container the runtime could not size is counted by the room default
 * (under the broker that is the broker's own). Memory decides `overcommitted`;
 * cores are a share of time (`--cpus`), and promising more of them than exist
 * slows rooms down rather than killing them.
 */
async function budget(machine: InstanceResources): Promise<ResourceBudget> {
  let census: RunningKernel[] = []
  let complete = true
  try {
    census = await runningKernelLimits()
  } catch {
    complete = false
  }
  const held = (role: RunningKernel['role']): ResourceBudget['rooms'] => {
    const kernels = census.filter((kernel) => kernel.role === role)
    const { defaultMemoryMb, defaultCpus } = machine.kernel
    return {
      count: kernels.length,
      memoryMb: kernels.reduce((sum, kernel) => sum + (kernel.memoryMb ?? defaultMemoryMb), 0),
      cpus: kernels.reduce((sum, kernel) => sum + (kernel.cpus ?? defaultCpus), 0),
    }
  }
  const rooms = held('room')
  const own = held('own')
  const competitions = competitionShare()
  const totalMb = machine.memory.totalMb
  const reserveMb = Math.min(HOST_RESERVE_MB, totalMb)
  const promised = rooms.memoryMb + own.memoryMb + (competitions.memoryMb ?? 0)
  return {
    totalMb,
    totalCpus: machine.cpus,
    reserveMb,
    rooms,
    own,
    competitions,
    freeMb: Math.max(0, totalMb - reserveMb - promised),
    overcommitted: promised > totalMb - reserveMb,
    complete,
  }
}

/** KERNEL_MEM_<ENVIRONMENT> for the environments that exist; read-only in the panel. */
function environmentOverrides(): ResourceSettingsResponse['perEnvironmentMemory'] {
  let names: string[] = []
  try {
    names = listNames()
  } catch {
    // An unreadable catalog is no reason to refuse the whole answer.
  }
  return names.flatMap((environment) => {
    const mb = perEnvironmentMemoryMb(environment)
    return mb === null ? [] : [{ environment, mb }]
  })
}

async function payload(): Promise<ResourceSettingsResponse> {
  const collected = await machineResources()
  const bounds = machineBounds()
  const machine: InstanceResources = { ...collected, limits: { ...bounds.memory, cpus: bounds.cpus } }
  return {
    settings: resourceSettings(),
    bounds: resourceBounds(bounds),
    perEnvironmentMemory: environmentOverrides(),
    backend: kernelBackend(),
    machine,
    budget: await budget(machine),
  }
}

export function adminResourceRoutes(): Router {
  const router = Router()

  router.get('/api/admin/resources', requireStaff, (_req, res, next) => {
    payload()
      .then((body) => res.set('Cache-Control', 'no-store').json(body))
      .catch(next)
  })

  router.put('/api/admin/resources', ownerOnly('server.ownerAction.resources'), (req, res, next) => {
    const parsed = parseResourcePatch(req.body)
    if ('error' in parsed) return invalid(res, parsed.error)
    let changed: ResourceSettingName[]
    try {
      changed = updateResourceSettings(parsed.patch, machineBounds())
    } catch (err) {
      if (err instanceof ResourceRefusal) return invalid(res, err.message)
      return next(err)
    }
    if (changed.length > 0) {
      console.log(`[admin] instance resources changed: ${changed.join(', ')}`)
      // What each changed setting is now: one number per name, the whole story.
      const now = resourceSettings()
      recordAdminEvent({
        actor: currentStaff(req),
        action: 'settings.resources_changed',
        target: { type: 'settings', id: 'resources' },
        detail: { changed, ...Object.fromEntries(changed.map((name) => [name, now[name].value])) },
        req,
      })
      // The class form and the room list label their fields with these defaults.
      forgetResources()
      // Not awaited: `docker update` on a busy machine takes hundreds of
      // milliseconds per container, and the settings are already saved.
      void reapplyInstanceDefaults(new Set(changed)).catch((err: unknown) => {
        const why = err instanceof Error ? err.message : err
        console.error('[admin] instance defaults did not reach running containers:', why)
      })
    }
    payload()
      .then((body) => res.set('Cache-Control', 'no-store').json(body))
      .catch(next)
  })

  return router
}
