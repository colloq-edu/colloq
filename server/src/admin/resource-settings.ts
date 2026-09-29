/**
 * Instance-wide resource settings: what a room kernel, a class's
 * personal-notebook container and an upload get when nothing more specific
 * was said.
 *
 * All of it used to live in environment variables (KERNEL_MEM, KERNEL_CPUS,
 * KERNEL_OWN_*, KERNEL_PIDS, MAX_UPLOAD_MB, MAX_SESSION_MB): changeable only
 * over ssh and with a restart, and shown nowhere in the product. The owner
 * now sets them in the panel, and they apply without a restart.
 *
 * RESOLUTION ORDER, the same as the oracle's (admin/settings.ts): a value
 * saved from the panel wins; where there is none, the environment variable
 * answers; where that is unset or unreadable, the built-in default. An
 * instance configured entirely through .env keeps working exactly as it did,
 * and a saved value is an override the owner can add and remove (`null`
 * forgets the row). Every answer says which of the three it came from.
 *
 * Read on every call, not cached, for the reason admin/settings.ts gives: a
 * stale limit is exactly the bug a live setting must not have, and a prepared
 * SELECT over a couple of dozen rows costs microseconds. So every consumer
 * asks here at the moment it needs the number (the pool at `docker run`, the
 * upload route per request, the idle sweep per pass) instead of reading
 * process.env or the boot-time config.
 *
 * Each environment variable keeps the parse it always had (junk or too small
 * reads as unset), so a .env that worked yesterday means the same today. The
 * bounds are enforced on write, where a saved number is clamped into them.
 * The machine-dependent bounds (memory, cores) are passed in by the route:
 * they live in kernel/resources.ts, which imports the pool, and the pool
 * imports this module.
 */
import { config } from '../config.js'
import { db } from '../db.js'
import { tr } from '@shared/i18n'
import type {
  ResourceBounds,
  ResourceSetting,
  ResourceSettingName,
  ResourceSettingValues,
  ResourceSettings,
  ResourceSource,
  UpdateResourceSettingsRequest,
} from '@shared/admin'
import { putSettingRow, settingRows } from './settings.js'

const MB = 1024 * 1024

/** Every row here is `resources.<name>`: the table is the instance's shared box. */
const PREFIX = 'resources.'

/**
 * A kernel's memory floor, as in kernel/resources.ts · MIN_ROOM_MB. Repeated,
 * not imported: that module imports the pool, and the pool imports this one.
 */
const MIN_MEMORY_MB = 512

type Env = NodeJS.ProcessEnv

/** The machine's share of the bounds, which only the caller can know. */
export interface MachineBounds {
  memory: ResourceBounds
  cpus: ResourceBounds
}

/* -------------------------------------------------------------- parsing */

/**
 * A docker memory string ("4g", "512m", "2048") in megabytes, or null.
 *
 * The panel speaks gigabytes, the seminar row and this table store
 * megabytes, docker and .env speak suffixes; without one measure in the
 * middle the three drift apart, and the price is paid by a kernel that got
 * half of what the screen shows. Rounding down is deliberate: docker will not
 * give out a fractional megabyte. Junk and zero are "I do not know", not 0: a
 * zero would go into `--memory=0m`.
 */
export function parseMemMb(spec: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([bkmg])?b?\s*$/i.exec(spec)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (match[2] ?? 'b').toLowerCase()
  const bytes = value * (unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1)
  const mb = Math.floor(bytes / 1024 ** 2)
  return mb > 0 ? mb : null
}

/** KERNEL_MEM as docker writes it; empty or junk is unset, as it always was. */
const memoryVar = (name: string) => (env: Env): number | null => {
  const raw = env[name]
  return raw ? parseMemMb(raw) : null
}

/** A positive number, fractions included: docker takes `--cpus=1.5`. */
const positiveVar = (name: string) => (env: Env): number | null => {
  const value = Number(env[name] ?? '')
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * A whole number at or above `min`. Below it is junk, not a ceiling to clamp
 * to: KERNEL_PIDS=10 never meant "ten processes", and a room that cannot even
 * start Jupyter is worse than the default.
 */
const wholeVar = (name: string, min: number) => (env: Env): number | null => {
  const value = Number((env[name] ?? '').trim())
  return Number.isInteger(value) && value >= min ? value : null
}

/** Idle minutes, where `0` is meaningful (never stop) and is read before the "at least one" rule. */
const idleVar = (name: string) => (env: Env): number | null => {
  const raw = (env[name] ?? '').trim()
  if (raw === '0') return 0
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 ? value : null
}

/**
 * MAX_UPLOAD_MB and MAX_SESSION_MB are parsed once, at boot, into config
 * (config.ts), and that stays their environment layer. The variable counts as
 * set only when it is; a value that did not parse (NaN) is unset, where the
 * upload route used to read it as no limit at all.
 */
const bootVar = (name: string, bytes: () => number) => (env: Env): number | null =>
  (env[name] ?? '') === '' ? null : validMb(bytes())

function validMb(bytes: number): number | null {
  return Number.isFinite(bytes) && bytes > 0 ? bytes / MB : null
}

/* ---------------------------------------------------------------- specs */

interface Spec {
  /** The environment variable behind the setting; absent where there is none. */
  envName?: string
  readEnv?: (env: Env) => number | null
  fallback: number | null
  /**
   * What answers when nothing is saved and the variable is unset, if not the
   * fallback. Only the two upload limits need it: config holds their boot
   * value, and the tests move it there.
   */
  unset?: () => number | null
  /** 'memory' and 'cpus' are the machine's bounds, known only to the caller. */
  bounds: 'memory' | 'cpus' | ResourceBounds
  appliesTo: ResourceSetting<unknown>['appliesTo']
  dockerOnly: boolean
}

/**
 * The settings, in the order the panel lists them.
 *
 * `appliesTo` follows what each consumer can do with a running container.
 * Memory defaults wait for the next container, exactly as a room reset to
 * its default does (kernel/pool.ts · applyMemoryLimit with `null`): lowering
 * a live cgroup under a working kernel is the OOM kill this is all about.
 * Cores and the personal-notebook numbers reach running containers through
 * the pool's existing live paths (applyCpuLimit, applyOwnLimits). Process
 * ceilings are a `docker run` flag. The rest is read at the moment of use.
 *
 * The memory defaults were raised on 13 Sep 2026 after a day when 2g killed
 * the kernel on every run of a single cell. Four gigabytes is still tolerable
 * for an ordinary notebook with pandas and pictures on a laptop; a GPU
 * environment makes no sense without sixteen: the rented machine is a 3090
 * with 24 GB of video memory and 72 GB of RAM, and torch with a CUDA context
 * and a model puts no less into RAM than into video memory. This is about
 * RAM: the cgroup does not limit video memory, and rooms get the card whole.
 * KERNEL_MEM speaks for ordinary environments only, so a GPU room keeps its
 * sixteen however the rest are sized.
 */
const SPECS: Record<ResourceSettingName, Spec> = {
  roomMemoryMb: {
    envName: 'KERNEL_MEM',
    readEnv: memoryVar('KERNEL_MEM'),
    fallback: 4096,
    bounds: 'memory',
    appliesTo: 'new-containers',
    dockerOnly: true,
  },
  gpuRoomMemoryMb: { fallback: 16384, bounds: 'memory', appliesTo: 'new-containers', dockerOnly: true },
  roomCpus: {
    envName: 'KERNEL_CPUS',
    readEnv: positiveVar('KERNEL_CPUS'),
    fallback: 2,
    bounds: 'cpus',
    appliesTo: 'live',
    dockerOnly: true,
  },
  ownMemoryMb: { fallback: null, bounds: 'memory', appliesTo: 'live', dockerOnly: true },
  ownCpus: { fallback: null, bounds: 'cpus', appliesTo: 'live', dockerOnly: true },
  ownMax: {
    envName: 'KERNEL_OWN_MAX',
    readEnv: wholeVar('KERNEL_OWN_MAX', 1),
    fallback: 60,
    bounds: { min: 1, max: 500 },
    appliesTo: 'live',
    dockerOnly: true,
  },
  ownIdleMin: {
    envName: 'KERNEL_OWN_IDLE_MIN',
    readEnv: idleVar('KERNEL_OWN_IDLE_MIN'),
    fallback: 30,
    bounds: { min: 0, max: 1440 },
    appliesTo: 'live',
    dockerOnly: true,
  },
  ownPids: {
    envName: 'KERNEL_OWN_PIDS',
    readEnv: wholeVar('KERNEL_OWN_PIDS', 64),
    fallback: 2048,
    bounds: { min: 64, max: 32768 },
    appliesTo: 'new-containers',
    dockerOnly: true,
  },
  roomPids: {
    envName: 'KERNEL_PIDS',
    readEnv: wholeVar('KERNEL_PIDS', 64),
    fallback: 512,
    bounds: { min: 64, max: 32768 },
    appliesTo: 'new-containers',
    dockerOnly: true,
  },
  uploadMb: {
    envName: 'MAX_UPLOAD_MB',
    readEnv: bootVar('MAX_UPLOAD_MB', () => config.maxUploadBytes),
    fallback: 50,
    unset: () => validMb(config.maxUploadBytes),
    bounds: { min: 1, max: 2048 },
    appliesTo: 'live',
    dockerOnly: false,
  },
  sessionMb: {
    envName: 'MAX_SESSION_MB',
    readEnv: bootVar('MAX_SESSION_MB', () => config.maxSessionBytes),
    fallback: 1024,
    unset: () => validMb(config.maxSessionBytes),
    bounds: { min: 16, max: 65536 },
    appliesTo: 'live',
    dockerOnly: false,
  },
}

export const RESOURCE_SETTING_NAMES = Object.keys(SPECS) as ResourceSettingName[]

export function isResourceSettingName(value: string): value is ResourceSettingName {
  return Object.hasOwn(SPECS, value)
}

/* ------------------------------------------------------------ resolution */

interface Resolved {
  value: number | null
  source: ResourceSource
  /** The variable's own reading, whether or not it won. */
  env: number | null
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** The bounds a saved row is held to when read: the static part only, the machine is not asked here. */
function readBounds(spec: Spec): ResourceBounds {
  if (spec.bounds === 'memory') return { min: MIN_MEMORY_MB, max: Infinity }
  if (spec.bounds === 'cpus') return { min: 1, max: Infinity }
  return spec.bounds
}

/** A saved row; a hand-edited one that does not parse is ignored rather than trusted. */
function savedOf(name: ResourceSettingName, rows: Map<string, string>): number | null {
  const raw = rows.get(PREFIX + name)
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  const { min, max } = readBounds(SPECS[name])
  return clamp(Math.round(value), min, max)
}

function resolve(name: ResourceSettingName, rows: Map<string, string>, env: Env): Resolved {
  const spec = SPECS[name]
  const fromEnv = spec.readEnv ? spec.readEnv(env) : null
  const saved = savedOf(name, rows)
  if (saved !== null) return { value: saved, source: 'saved', env: fromEnv }
  if (fromEnv !== null) return { value: fromEnv, source: 'env', env: fromEnv }
  return { value: spec.unset?.() ?? spec.fallback, source: 'default', env: null }
}

/**
 * One setting's effective value: saved, otherwise the environment, otherwise
 * the default. `env` is a parameter only so that a test can hand in its own.
 */
export function resourceValue<K extends ResourceSettingName>(
  name: K,
  env: Env = process.env,
): ResourceSettingValues[K] {
  // Only ownMemoryMb and ownCpus have a null fallback, and their type allows it.
  return resolve(name, settingRows(PREFIX), env).value as ResourceSettingValues[K]
}

/** Every setting with where it came from, for the panel. */
export function resourceSettings(env: Env = process.env): ResourceSettings {
  const rows = settingRows(PREFIX)
  const out: Partial<Record<ResourceSettingName, ResourceSetting<number | null>>> = {}
  for (const name of RESOURCE_SETTING_NAMES) {
    const spec = SPECS[name]
    const resolved = resolve(name, rows, env)
    out[name] = {
      value: resolved.value,
      source: resolved.source,
      ...(spec.envName ? { env: resolved.env, envName: spec.envName } : {}),
      default: spec.fallback,
      appliesTo: spec.appliesTo,
      dockerOnly: spec.dockerOnly,
    }
  }
  return out as ResourceSettings
}

/**
 * KERNEL_MEM_<ENVIRONMENT>: one environment's own memory, which beats both
 * defaults. The name is upper-cased with non-alphanumerics as `_`
 * (`base-gpu` → KERNEL_MEM_BASE_GPU).
 *
 * Environment-only on purpose: it is an operator's statement about one image
 * ("this one needs sixteen"), and the panel already has a per-room field for
 * the teacher's version of the same statement. It is reported read-only.
 */
export function perEnvironmentMemoryMb(environment: string, env: Env = process.env): number | null {
  const raw = env[`KERNEL_MEM_${environment.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`]
  return raw ? parseMemMb(raw) : null
}

/** The upload ceiling for one file, in bytes, as the upload paths compare it. */
export function uploadLimitBytes(): number {
  return resourceValue('uploadMb') * MB
}

/** The ceiling for all of a room's files together, in bytes. */
export function sessionLimitBytes(): number {
  return resourceValue('sessionMb') * MB
}

/** What a saved number is clamped into, the machine's bounds included. */
export function resourceBounds(machine: MachineBounds): Record<ResourceSettingName, ResourceBounds> {
  const out: Partial<Record<ResourceSettingName, ResourceBounds>> = {}
  for (const name of RESOURCE_SETTING_NAMES) {
    const bounds = SPECS[name].bounds
    out[name] =
      bounds === 'memory' ? { ...machine.memory } : bounds === 'cpus' ? { ...machine.cpus } : { ...bounds }
  }
  return out as Record<ResourceSettingName, ResourceBounds>
}

/* ----------------------------------------------------------------- write */

export type ResourcePatchResult = { patch: UpdateResourceSettingsRequest } | { error: string }

/**
 * An untrusted body as a patch. Lives beside the store, like parseOraclePatch:
 * wrong *types* are refused here, out-of-range *numbers* are clamped on
 * write.
 *
 * Unknown fields are refused rather than ignored: a typo in a script
 * (`ownmax`) that silently changes nothing is how an owner ends up believing
 * a limit is set. Fractions are refused too: the panel sends whole megabytes
 * and cores, and a fraction is a sign that it was not the panel that sent it.
 */
export function parseResourcePatch(body: unknown): ResourcePatchResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: tr('common.settingsRequired') }
  }
  const patch: UpdateResourceSettingsRequest = {}
  for (const [field, value] of Object.entries(body as Record<string, unknown>)) {
    if (!isResourceSettingName(field)) return { error: tr('server.resources.unknownField', { field }) }
    if (value === null) {
      patch[field] = null
      continue
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { error: tr('server.resources.wholeNumber', { field }) }
    }
    patch[field] = value
  }
  return { patch }
}

/** A patch that cannot be applied as a whole; its message is for the person who sent it. */
export class ResourceRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResourceRefusal'
  }
}

function currentValues(): Record<ResourceSettingName, number | null> {
  const rows = settingRows(PREFIX)
  const out: Partial<Record<ResourceSettingName, number | null>> = {}
  for (const name of RESOURCE_SETTING_NAMES) out[name] = resolve(name, rows, process.env).value
  return out as Record<ResourceSettingName, number | null>
}

/** Whole megabytes in a sentence; a fraction only shows up when an operator wrote one into .env. */
const megabytes = (mb: number): string => (Number.isInteger(mb) ? String(mb) : mb.toFixed(1))

/*
 * One transaction: either the whole patch lands or none of it. The
 * room-ceiling check has to see the patch already applied (the new upload
 * limit against the new or the inherited ceiling), so it runs inside, and a
 * refusal rolls everything back.
 */
const write = db.transaction((patch: UpdateResourceSettingsRequest, machine: MachineBounds) => {
  const bounds = resourceBounds(machine)
  for (const name of RESOURCE_SETTING_NAMES) {
    const value = patch[name]
    if (value === undefined) continue
    const { min, max } = bounds[name]
    putSettingRow(PREFIX + name, value === null ? null : String(clamp(value, min, max)))
  }
  if (patch.uploadMb !== undefined || patch.sessionMb !== undefined) {
    const upload = resourceValue('uploadMb')
    const session = resourceValue('sessionMb')
    /*
     * Refused, not clamped: moving the field the owner did NOT touch (or
     * quietly shrinking the one they did) is worse than one sentence naming
     * both numbers.
     */
    if (session < upload) {
      throw new ResourceRefusal(
        tr('server.resources.sessionBelowUpload', { p0: megabytes(session), p1: megabytes(upload) }),
      )
    }
  }
})

/**
 * Apply a parsed patch; answers the settings whose effective value changed,
 * so that the caller can carry exactly those to running containers.
 * Throws ResourceRefusal when the patch breaks a rule between two fields.
 */
export function updateResourceSettings(
  patch: UpdateResourceSettingsRequest,
  machine: MachineBounds,
): ResourceSettingName[] {
  const before = currentValues()
  write(patch, machine)
  const after = currentValues()
  return RESOURCE_SETTING_NAMES.filter((name) => before[name] !== after[name])
}
