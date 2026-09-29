/**
 * The instance's competition settings — in the shared box, under
 * `competitions.*` keys.
 *
 * WHY THE SHARED BOX (`instance_settings`) and not a table of our own: these
 * are settings of the MACHINE, next to the Oracle's — how many submissions run
 * at once, how often one participant may upload, what a NEW competition starts
 * with — not state of one competition or of the queue. A missing row is not an
 * error but "as by default": everyone who upgraded has none, and reading that
 * as zero would stall the queue or refuse every upload.
 *
 * WHAT IS NOT HERE: what `auto` means on this machine. That is a question for
 * the machine (competitions/capacity.ts), and this module stays importable
 * from store.ts without dragging the kernel modules along.
 */
/*
 * The box is created by `admin/settings`, and the import is not decoration:
 * without it the table may not exist yet when the statements below are
 * prepared (the same reason runner.ts has always imported it).
 */
import '../admin/settings.js'
import { db } from '../db.js'
import type { CompetitionLimits } from '@shared/competitions'
import { SETTINGS_LIMITS, type CompetitionSettingsInput } from '@shared/competitions-settings'

const KEY = {
  slots: 'competitions.slots',
  uploadsPerMinute: 'competitions.uploadsPerMinute',
  wallSeconds: 'competitions.defaults.wallSeconds',
  memoryMb: 'competitions.defaults.memoryMb',
  cpus: 'competitions.defaults.cpus',
  perDay: 'competitions.defaults.perDay',
} as const

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
  limits: CompetitionLimits
  sources: Record<keyof CompetitionLimits, 'saved' | 'default'>
} {
  const limits = {} as CompetitionLimits
  const sources = {} as Record<keyof CompetitionLimits, 'saved' | 'default'>
  for (const field of DEFAULT_FIELDS) {
    const saved = storedWhole(KEY[field], SETTINGS_LIMITS[field])
    limits[field] = saved ?? SETTINGS_LIMITS[field].default
    sources[field] = saved === null ? 'default' : 'saved'
  }
  return { limits, sources }
}

/* ------------------------------------------------------------ the form */

/** A checked form: a value to store, or `null` to forget the stored one. */
export type SettingsPatch = CompetitionSettingsInput

export type SettingsRefusal =
  | { field: string; why: 'range'; min: number; max: number }
  | { field: string; why: 'value' }

/**
 * Read the owner's form against the bounds AND the machine.
 *
 * The machine matters for two fields: a default of 48 GB on a 16 GB machine is
 * a competition every submission of which dies of memory, and eight CPUs on a
 * docker that has four is a `docker run` refused in the middle of a class.
 * Pure: the machine comes in as numbers (capacity.ts · machineShape), so the
 * rules are checked without one.
 */
export function parseSettingsInput(
  body: unknown,
  machine: { cpus: number; memoryMb: number; reserveMb: number },
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
})
