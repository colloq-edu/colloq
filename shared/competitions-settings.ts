/**
 * The instance's competition settings: how many submissions run at once, how
 * often one participant may upload, and what a NEW competition starts with.
 *
 * A file of its own rather than more fields in `competitions-api.ts`: these
 * are settings of the MACHINE, not of one competition, and they travel through
 * their own pair of doors (`/api/admin/competitions/settings`). The bounds for
 * the defaults are the competition editor's own (`LIMITS`): a default the
 * editor would refuse to save is not a default.
 */
import { LIMITS, type CompetitionLimits } from './competitions.js'

export const SETTINGS_LIMITS = {
  /** Parallel executors when the owner fixes the number by hand. */
  slots: { min: 1, max: 64 },
  /** Uploads per minute per participant — the parsing budget, not the day's quota. */
  uploadsPerMinute: { min: 1, max: 120, default: 12 },
  wallSeconds: LIMITS.wallSeconds,
  memoryMb: LIMITS.memoryMb,
  cpus: LIMITS.cpus,
  perDay: LIMITS.perDay,
} as const

/** Where a number came from: the owner's choice, the environment, or our default. */
export type SettingSource = 'saved' | 'env' | 'default'

/**
 * How many submissions the queue runs at once.
 *
 * `value` is what the setting names (the fixed number, or what `auto` works
 * out for this machine), `effective` is what the pump uses right now after
 * clamping — the two differ only for a stored number the bounds no longer
 * allow.
 */
export interface SlotsResolution {
  mode: 'auto' | 'fixed'
  value: number
  effective: number
  source: SettingSource
}

/** The limits a new competition starts with, field by field. */
export type CompetitionDefaults = CompetitionLimits

export interface CompetitionSettings {
  slots: SlotsResolution & {
    /** What `auto` would give on this machine — shown next to a fixed number. */
    auto: number
    /**
     * What one automatic slot is sized for: the default CPUs, and the default
     * memory plus the container's 256 MB cushion.
     */
    perSlot: { cpus: number; memoryMb: number }
  }
  uploadsPerMinute: { value: number; source: Exclude<SettingSource, 'env'> }
  defaults: CompetitionDefaults
  defaultSources: Record<keyof CompetitionDefaults, Exclude<SettingSource, 'env'>>
  /** The machine the numbers are checked against: `docker info` or the host. */
  machine: { cpus: number; memoryMb: number }
  /** What the form may send; memory and CPUs are capped by the machine. */
  bounds: {
    slots: { min: number; max: number }
    uploadsPerMinute: { min: number; max: number }
    wallSeconds: { min: number; max: number }
    memoryMb: { min: number; max: number }
    cpus: { min: number; max: number }
    perDay: { min: number; max: number }
  }
}

/**
 * What the owner's form sends. Every field is optional; `null` (or an empty
 * string) removes the stored value, and the number falls back to the
 * environment or the default.
 */
export interface CompetitionSettingsInput {
  slots?: 'auto' | number | null
  uploadsPerMinute?: number | null
  wallSeconds?: number | null
  memoryMb?: number | null
  cpus?: number | null
  perDay?: number | null
}
