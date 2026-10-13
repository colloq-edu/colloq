/**
 * The instance's competition settings — in the shared box, under
 * `competitions.*` keys.
 *
 * WHY THE SHARED BOX (`instance_settings`) and not a table of our own: these
 * are settings of the MACHINE, next to the Oracle's — how many submissions run
 * at once, how often one participant may upload, what a NEW competition starts
 * with, how the work is shared with the machines that run submissions for it
 * — not state of one competition or of the queue. A missing row is not an
 * error but "as by default": everyone who upgraded has none, and reading that
 * as zero would stall the queue or refuse every upload.
 *
 * WHAT IS NOT HERE: what `auto` means on this machine. That is a question for
 * the machine (competitions/capacity.ts), and this module stays importable
 * from store.ts without dragging the kernel modules along. Nor what the cards
 * given to submissions mean on this machine (competitions/gpu.ts): only which
 * ones the owner chose — so that kernel/pool.ts, which loads before anything
 * competition-shaped, can leave them out of the rooms' pool without an import
 * cycle.
 */
/*
 * The box is created by `admin/settings`, and the import is not decoration:
 * without it the table may not exist yet when the statements below are
 * prepared (the same reason runner.ts has always imported it).
 */
import '../admin/settings.js'
import { db } from '../db.js'
import {
  SETTINGS_LIMITS,
  type CompetitionDefaults,
  type CompetitionGpuSettingsInput,
  type CompetitionRunnerSettings,
  type CompetitionRunnerSettingsInput,
  type CompetitionSettingsInput,
  type SettingSource,
} from '@shared/competitions-settings'

const KEY = {
  slots: 'competitions.slots',
  uploadsPerMinute: 'competitions.uploadsPerMinute',
  wallSeconds: 'competitions.defaults.wallSeconds',
  memoryMb: 'competitions.defaults.memoryMb',
  cpus: 'competitions.defaults.cpus',
  perDay: 'competitions.defaults.perDay',
  /** A JSON array of `KERNEL_GPUS` entries; `[]` is "none", unlike a missing row. */
  gpuDevices: 'competitions.gpu.devices',
  gpuPerDevice: 'competitions.gpu.perDevice',
  /** `1` or `0`; a missing row is the default, on. */
  homeNotebooks: 'competitions.homeNotebooks',
  scoreSlots: 'competitions.scoreSlots',
  runnerBlobMBps: 'competitions.runners.blobMBps',
  runnerUploads: 'competitions.runners.uploads',
} as const

/** The machines' numbers: each read like the slots of the box, by its own bounds. */
const RUNNER_NUMBERS = ['scoreSlots', 'runnerBlobMBps', 'runnerUploads'] as const

const DEFAULT_FIELDS = ['wallSeconds', 'memoryMb', 'cpus', 'perDay'] as const

const readSetting = db.prepare('SELECT value FROM instance_settings WHERE key = ?')
const writeSetting = db.prepare(`
  INSERT INTO instance_settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`)
const dropSetting = db.prepare('DELETE FROM instance_settings WHERE key = ?')

function stored(key: string): string | null {
  const row = readSetting.get(key) as { value: string } | undefined
  return row ? row.value : null
}

/** A stored whole number within bounds; anything else reads as "not set". */
function storedWhole(key: string, range: { min: number; max: number }): number | null {
  const raw = stored(key)
  if (raw === null || !/^\d+$/.test(raw.trim())) return null
  const value = Number(raw)
  return value >= range.min && value <= range.max ? value : null
}

/* ------------------------------------------------------------------ slots */

/**
 * `auto` or a whole number; `null` — not a slots value at all.
 *
 * Bounds are not applied here: the saved value is checked by the form parser,
 * the environment's is clamped where it is used (capacity.ts).
 */
export function parseSlots(raw: unknown): 'auto' | number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (text.toLowerCase() === 'auto') return 'auto'
  if (!/^\d+$/.test(text)) return null
  return Number(text)
}

/** What the owner saved; `null` — nothing, the environment or `auto` decide. */
export function savedSlots(): 'auto' | number | null {
  const raw = stored(KEY.slots)
  return raw === null ? null : parseSlots(raw)
}

/** Save the slots setting: a number, `auto`, or `null` to forget it. */
export function saveSlots(slots: 'auto' | number | null): void {
  if (slots === null) dropSetting.run(KEY.slots)
  else writeSetting.run(KEY.slots, String(slots))
}

/* ------------------------------------------------------ uploads, defaults */

/** Uploads per minute per participant: what parsing a notebook is allowed to cost. */
export function uploadsPerMinute(): { value: number; source: 'saved' | 'default' } {
  const saved = storedWhole(KEY.uploadsPerMinute, SETTINGS_LIMITS.uploadsPerMinute)
  return saved === null
    ? { value: SETTINGS_LIMITS.uploadsPerMinute.default, source: 'default' }
    : { value: saved, source: 'saved' }
}

/**
 * The limits a new competition starts with, each field on its own.
 *
 * Field by field rather than all or nothing: an owner who raised only the
 * memory must not have their CPUs fall back because the other three were
 * never touched.
 */
export function competitionDefaults(): {
  limits: CompetitionDefaults
  sources: Record<keyof CompetitionDefaults, 'saved' | 'default'>
} {
  const limits = {} as CompetitionDefaults
  const sources = {} as Record<keyof CompetitionDefaults, 'saved' | 'default'>
  for (const field of DEFAULT_FIELDS) {
    const saved = storedWhole(KEY[field], SETTINGS_LIMITS[field])
    limits[field] = saved ?? SETTINGS_LIMITS[field].default
    sources[field] = saved === null ? 'default' : 'saved'
  }
  return { limits, sources }
}

/* ------------------------------------------------------- runner cards */

/*
 * The cards given to competition submissions, and how many runs share one.
 *
 * Only the SETTING lives here: the ids the owner chose, as saved or as the
 * environment names them. What they mean on this machine — which of them
 * KERNEL_GPUS still lists, who holds them now, how much memory a run gets —
 * is competitions/gpu.ts's question; this half is what kernel/pool.ts needs to
 * keep those cards out of the rooms' pool, and the pool cannot import gpu.ts.
 *
 * The same order as every setting of the box: the owner's saved choice, then
 * the environment (COMPETITION_GPUS, COMPETITION_GPU_PER_DEVICE — how an
 * instance is configured through .env), then the default: no card, one run
 * per card. No card by default, and that is the point: a machine with cards
 * keeps giving every one of them to rooms, exactly as it did before
 * submissions could have one, until the owner moves a card over.
 */

/** A device list as KERNEL_GPUS is written: comma-separated, trimmed, each id once. */
export function parseDeviceList(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map((device) => device.trim()).filter((device) => device.length > 0))]
}

/**
 * Which cards are given to submissions: the saved list, then
 * COMPETITION_GPUS, then none. Pure, so the order is checked without a
 * database. A saved `[]` is an answer ("none"), not a missing row: an owner
 * who took every card back from submissions must not have .env hand them out
 * again.
 */
export function resolveRunnerGpus(input: { saved: string[] | null; env?: string }): { devices: string[]; source: SettingSource } {
  if (input.saved !== null) return { devices: input.saved, source: 'saved' }
  const fromEnv = parseDeviceList(input.env)
  if (fromEnv.length > 0) return { devices: fromEnv, source: 'env' }
  return { devices: [], source: 'default' }
}

/**
 * Runs per card: the saved number, then COMPETITION_GPU_PER_DEVICE, then one.
 * A typo in .env is passed over rather than obeyed; a number past the bounds is
 * pulled into them, the way COMPETITION_SLOTS is.
 */
export function resolveGpuPerDevice(input: { saved: number | null; env?: string }): { value: number; source: SettingSource } {
  const range = SETTINGS_LIMITS.gpuPerDevice
  if (input.saved !== null) return { value: input.saved, source: 'saved' }
  const raw = (input.env ?? '').trim()
  if (/^\d+$/.test(raw)) return { value: Math.min(range.max, Math.max(range.min, Number(raw))), source: 'env' }
  return { value: range.default, source: 'default' }
}

/** What the owner saved; `null` — nothing (or a row nobody can read), the environment decides. */
export function savedRunnerGpus(): string[] | null {
  const raw = stored(KEY.gpuDevices)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some((device) => typeof device !== 'string' || !device.trim())) return null
    return [...new Set(parsed.map((device: string) => device.trim()))]
  } catch {
    return null
  }
}

/**
 * The cards given to submissions as the setting names them — NOT yet checked
 * against KERNEL_GPUS (competitions/gpu.ts · runnerGpuDevices does that).
 * Read on every call, like every setting of the box: kernel/pool.ts asks it
 * at each room start, and a stale answer would hand a submissions' card to a
 * class.
 */
export function runnerGpuSetting(env: NodeJS.ProcessEnv = process.env): { devices: string[]; source: SettingSource } {
  return resolveRunnerGpus({ saved: savedRunnerGpus(), env: env.COMPETITION_GPUS })
}

/** How many runs share one runner card, and where the number came from. */
export function gpuPerDeviceSetting(env: NodeJS.ProcessEnv = process.env): { value: number; source: SettingSource } {
  return resolveGpuPerDevice({
    saved: storedWhole(KEY.gpuPerDevice, SETTINGS_LIMITS.gpuPerDevice),
    env: env.COMPETITION_GPU_PER_DEVICE,
  })
}

/* --------------------------------------------- machines that run submissions */

/*
 * The settings of the machines that run submissions for this server
 * (docs/architecture/remote-runners.md §5.1). No environment variable names
 * any of them: they are decided in the panel, while the machines join, and an
 * .env value would be a second answer to «does this server run notebooks»
 * that the switch could not overrule. Read on every call, like the rest of
 * the box: the pump asks each pass, and an owner who turns this server's
 * notebooks off between two passes must see the next one take none.
 */

/** A stored switch: `1` on, `0` off; anything else reads as "not set". */
function storedFlag(key: string): boolean | null {
  const raw = stored(key)?.trim()
  return raw === '1' ? true : raw === '0' ? false : null
}

/**
 * «Тетради на этом сервере»: whether the pump's notebook lane runs here
 * (runner.ts · pumpOnce). Off, this server takes no notebook and only scores
 * — the metric lane runs whatever the switch says.
 */
export function homeNotebooksSetting(): { value: boolean; source: 'saved' | 'default' } {
  const saved = storedFlag(KEY.homeNotebooks)
  return saved === null ? { value: SETTINGS_LIMITS.homeNotebooks.default, source: 'default' } : { value: saved, source: 'saved' }
}

/** A stored whole number within its bounds, or the default. */
function runnerNumber(field: (typeof RUNNER_NUMBERS)[number]): { value: number; source: 'saved' | 'default' } {
  const saved = storedWhole(KEY[field], SETTINGS_LIMITS[field])
  return saved === null ? { value: SETTINGS_LIMITS[field].default, source: 'default' } : { value: saved, source: 'saved' }
}

/** The metric lane's places: metric-only work run here at once. */
export function scoreSlotsSetting(): { value: number; source: 'saved' | 'default' } {
  return runnerNumber('scoreSlots')
}

/** «Скорость раздачи»: MB/s for every blob the machines fetch, together. */
export function runnerBlobMBpsSetting(): { value: number; source: 'saved' | 'default' } {
  return runnerNumber('runnerBlobMBps')
}

/** Results the machines upload that are stored at once. */
export function runnerUploadsSetting(): { value: number; source: 'saved' | 'default' } {
  return runnerNumber('runnerUploads')
}

/** All four, as the machines' block reads them. */
export function runnerSettings(): CompetitionRunnerSettings {
  return {
    homeNotebooks: homeNotebooksSetting(),
    scoreSlots: scoreSlotsSetting(),
    runnerBlobMBps: runnerBlobMBpsSetting(),
    runnerUploads: runnerUploadsSetting(),
  }
}

/* ------------------------------------------------------------ the form */

/** A checked form: a value to store, or `null` to forget the stored one. */
export type SettingsPatch = CompetitionSettingsInput & CompetitionGpuSettingsInput & CompetitionRunnerSettingsInput

export type SettingsRefusal =
  | { field: string; why: 'range'; min: number; max: number }
  | { field: string; why: 'value' }
  /** A card that is not an entry of KERNEL_GPUS. */
  | { field: 'gpuDevices'; why: 'device'; device: string }
  /** Under Kubernetes the cluster sets the submissions' cards, not this form. */
  | { field: 'gpuDevices' | 'gpuPerDevice'; why: 'managed' }

/**
 * Read the owner's form against the bounds AND the machine.
 *
 * The machine matters for two fields: a default of 48 GB on a 16 GB machine is
 * a competition every submission of which dies of memory, and eight CPUs on a
 * docker that has four is a `docker run` refused in the middle of a class.
 * Pure: the machine comes in as numbers (capacity.ts · machineShape), so the
 * rules are checked without one. Its cards come in the same way: `gpus` is
 * KERNEL_GPUS (none when absent), and `gpuManaged` says the cluster has them.
 */
export function parseSettingsInput(
  body: unknown,
  machine: { cpus: number; memoryMb: number; reserveMb: number; gpus?: readonly string[]; gpuManaged?: boolean },
): { patch: SettingsPatch } | { refusal: SettingsRefusal } {
  const raw = (body ?? {}) as Record<string, unknown>
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key)
  const cleared = (value: unknown) => value === null || value === ''
  const patch: SettingsPatch = {}

  if (has('slots')) {
    const range = SETTINGS_LIMITS.slots
    if (cleared(raw.slots)) patch.slots = null
    else {
      const value = parseSlots(raw.slots)
      if (value === null) return { refusal: { field: 'slots', why: 'value' } }
      if (value !== 'auto' && (value < range.min || value > range.max)) {
        return { refusal: { field: 'slots', why: 'range', min: range.min, max: range.max } }
      }
      patch.slots = value
    }
  }

  const bounds = {
    uploadsPerMinute: SETTINGS_LIMITS.uploadsPerMinute,
    wallSeconds: SETTINGS_LIMITS.wallSeconds,
    memoryMb: {
      min: SETTINGS_LIMITS.memoryMb.min,
      max: Math.max(SETTINGS_LIMITS.memoryMb.min, Math.min(SETTINGS_LIMITS.memoryMb.max, machine.memoryMb - machine.reserveMb)),
    },
    cpus: { min: SETTINGS_LIMITS.cpus.min, max: Math.max(1, Math.min(SETTINGS_LIMITS.cpus.max, machine.cpus)) },
    perDay: SETTINGS_LIMITS.perDay,
  }
  for (const field of ['uploadsPerMinute', ...DEFAULT_FIELDS] as const) {
    if (!has(field)) continue
    if (cleared(raw[field])) {
      patch[field] = null
      continue
    }
    const value = whole(raw[field])
    const range = bounds[field]
    if (value === null) return { refusal: { field, why: 'value' } }
    if (value < range.min || value > range.max) {
      return { refusal: { field, why: 'range', min: range.min, max: range.max } }
    }
    patch[field] = value
  }

  /*
   * The cards. Only a card the server already gives out: an entry of
   * KERNEL_GPUS, spelled as there. Docker gets the id as written, and the same
   * card named "GPU-…" here while KERNEL_GPUS calls it "0" would be one card
   * handed out twice — to a class and to submissions — with no isolation
   * between them. The list is stored in KERNEL_GPUS order, each card once.
   *
   * Under Kubernetes the cluster has the cards (RUNTIME_COMPETITION_GPU_*),
   * and a value saved here would be a promise nothing keeps; forgetting one
   * (`null`) is still allowed, it changes nothing.
   */
  if (has('gpuDevices')) {
    if (cleared(raw.gpuDevices)) patch.gpuDevices = null
    else {
      if (machine.gpuManaged) return { refusal: { field: 'gpuDevices', why: 'managed' } }
      const list = raw.gpuDevices
      if (!Array.isArray(list) || list.some((device) => typeof device !== 'string' || !device.trim())) {
        return { refusal: { field: 'gpuDevices', why: 'value' } }
      }
      const known = [...new Set(machine.gpus ?? [])]
      const chosen = new Set((list as string[]).map((device) => device.trim()))
      for (const device of chosen) {
        if (!known.includes(device)) return { refusal: { field: 'gpuDevices', why: 'device', device } }
      }
      patch.gpuDevices = known.filter((device) => chosen.has(device))
    }
  }
  if (has('gpuPerDevice')) {
    if (cleared(raw.gpuPerDevice)) patch.gpuPerDevice = null
    else {
      if (machine.gpuManaged) return { refusal: { field: 'gpuPerDevice', why: 'managed' } }
      const value = whole(raw.gpuPerDevice)
      const range = SETTINGS_LIMITS.gpuPerDevice
      if (value === null) return { refusal: { field: 'gpuPerDevice', why: 'value' } }
      if (value < range.min || value > range.max) {
        return { refusal: { field: 'gpuPerDevice', why: 'range', min: range.min, max: range.max } }
      }
      patch.gpuPerDevice = value
    }
  }

  /*
   * The machines' half. The switch is true or false, never "anything truthy"
   * (panel.ts · lateSubmissions): "false" as a string is the form that would
   * stop this server's notebooks by accident. The numbers have bounds of
   * their own, not the machine's: a lane of eight metrics or eight uploads
   * fits any server that runs a class.
   */
  if (has('homeNotebooks')) {
    if (cleared(raw.homeNotebooks)) patch.homeNotebooks = null
    else if (typeof raw.homeNotebooks !== 'boolean') return { refusal: { field: 'homeNotebooks', why: 'value' } }
    else patch.homeNotebooks = raw.homeNotebooks
  }
  for (const field of RUNNER_NUMBERS) {
    if (!has(field)) continue
    if (cleared(raw[field])) {
      patch[field] = null
      continue
    }
    const value = whole(raw[field])
    const range = SETTINGS_LIMITS[field]
    if (value === null) return { refusal: { field, why: 'value' } }
    if (value < range.min || value > range.max) {
      return { refusal: { field, why: 'range', min: range.min, max: range.max } }
    }
    patch[field] = value
  }
  return { patch }
}

/** The editor's measure (panel.ts · number): a number or a numeric string, rounded. */
function whole(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

/** Store a checked form in one transaction: half-saved settings are worse than none. */
export const saveCompetitionSettings = db.transaction((patch: SettingsPatch): void => {
  if (patch.slots !== undefined) saveSlots(patch.slots)
  for (const field of ['uploadsPerMinute', ...DEFAULT_FIELDS] as const) {
    const value = patch[field]
    if (value === undefined) continue
    if (value === null) dropSetting.run(KEY[field])
    else writeSetting.run(KEY[field], String(value))
  }
  if (patch.gpuDevices !== undefined) {
    if (patch.gpuDevices === null) dropSetting.run(KEY.gpuDevices)
    else writeSetting.run(KEY.gpuDevices, JSON.stringify(patch.gpuDevices))
  }
  if (patch.gpuPerDevice !== undefined) {
    if (patch.gpuPerDevice === null) dropSetting.run(KEY.gpuPerDevice)
    else writeSetting.run(KEY.gpuPerDevice, String(patch.gpuPerDevice))
  }
  if (patch.homeNotebooks !== undefined) {
    if (patch.homeNotebooks === null) dropSetting.run(KEY.homeNotebooks)
    else writeSetting.run(KEY.homeNotebooks, patch.homeNotebooks ? '1' : '0')
  }
  for (const field of RUNNER_NUMBERS) {
    const value = patch[field]
    if (value === undefined) continue
    if (value === null) dropSetting.run(KEY[field])
    else writeSetting.run(KEY[field], String(value))
  }
})
