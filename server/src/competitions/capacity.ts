/**
 * How much the machine can run at once — the numbers behind parallel
 * submissions.
 *
 * TWO QUESTIONS, answered separately, because they fail differently.
 *
 * How many slots. A setting of the machine: a number the owner fixed, the
 * environment's COMPETITION_SLOTS, or `auto`, which sizes the queue by the
 * machine itself — one slot per default submission (the instance's defaults
 * for new competitions: its CPUs, its memory and the container cushion),
 * after leaving the class two CPUs and two gigabytes. Slots are a ceiling on
 * concurrency, not a promise: a slot is taken only when the job also fits
 * into memory (below).
 *
 * Whether THIS job fits now. Two checks, and each covers the other's blind
 * spot. The promised one: all reservations of running work plus this job's
 * must fit into what competitions may promise — the machine minus the host's
 * reserve minus the limits of live room kernels. It is blind to memory taken
 * outside our books. The measured one: the kernel's MemAvailable must still
 * hold this job and a safety floor. It is computed WITHOUT subtracting the
 * running jobs' reservations again: their containers already took their
 * memory out of MemAvailable, and subtracting the reservation on top made
 * every running submission cost the machine twice.
 */
import fs from 'node:fs'
import os from 'node:os'
import { HOST_RESERVE_MB, machineCpus, machineResources, memoryBounds } from '../kernel/resources.js'
import { kernelBackend } from '../kernel/runtime-client.js'
import { observedWorkCensus } from '../ops/work-budget.js'
import { SETTINGS_LIMITS, type SettingSource, type SlotsResolution } from '@shared/competitions-settings'
import { competitionDefaults, parseSlots, savedSlots } from './settings.js'

const MB = 1024 * 1024

/* ------------------------------------------------------------------ slots */

/** The most slots a fixed setting may ask for. */
export const MAX_SLOTS = SETTINGS_LIMITS.slots.max
/** `auto` never goes above this: past it the machine is a cluster, and a cluster has its own scheduler. */
const AUTO_MAX_SLOTS = 32
/** What the class keeps for itself before `auto` hands anything out. */
const AUTO_RESERVED_CPUS = 2
const AUTO_RESERVED_MB = 2048
/** The cushion a container costs above its `--memory` (runner.ts · RUN_RESERVE_MB). */
const SLOT_CUSHION_MB = 256

export interface MachineShape {
  cpus: number
  memoryMb: number
}

/**
 * What one automatic slot is sized for: a submission with the instance's
 * default limits, plus the container's cushion. The Resources tab prints the
 * same two numbers next to the `auto` figure, so they come from one place.
 */
export function slotShape(defaults: { cpus: number; memoryMb: number }): { cpus: number; memoryMb: number } {
  return { cpus: Math.max(1, Math.floor(defaults.cpus)), memoryMb: Math.max(1, Math.floor(defaults.memoryMb)) + SLOT_CUSHION_MB }
}

/**
 * How many slots `auto` gives this machine.
 *
 * A slot per default submission: its CPUs, because a notebook that shares its
 * cores with the next one runs twice as long and the queue gains nothing; its
 * memory, because a slot that does not fit is a slot the admission check will
 * refuse anyway. The smaller of the two answers wins, and never fewer than
 * one: a machine without spare room still runs one submission at a time, as
 * it always did.
 */
export function autoSlots(machine: MachineShape, defaults: { cpus: number; memoryMb: number }): number {
  const slot = slotShape(defaults)
  const cpus = Math.max(1, Math.floor(machine.cpus) - AUTO_RESERVED_CPUS)
  const memoryMb = machine.memoryMb - AUTO_RESERVED_MB
  const fit = Math.min(Math.floor(cpus / slot.cpus), Math.floor(memoryMb / slot.memoryMb))
  return Math.min(AUTO_MAX_SLOTS, Math.max(1, fit))
}

/**
 * The machine the containers run on: the docker daemon's numbers when there is
 * one (a colima VM, not the Mac), the host's otherwise.
 *
 * `memoryBounds().max` is "total minus the host's reserve" for docker and the
 * test stand; under the broker it is capped by the per-room ceiling, which
 * says nothing about the node, so the host's own memory is taken there.
 */
export function machineShape(): MachineShape {
  const memoryMb = kernelBackend() === 'broker'
    ? Math.floor(os.totalmem() / MB)
    : memoryBounds().max + HOST_RESERVE_MB
  return { cpus: machineCpus(), memoryMb }
}

/**
 * Which slots setting wins: the saved one, then COMPETITION_SLOTS, then `auto`.
 *
 * Pure, so that the order is checked without a database or a machine. An
 * environment value that is neither a number nor `auto` is ignored rather
 * than obeyed: a typo in .env must not silently turn the queue into one slot.
 */
export function resolveSlots(input: { saved: 'auto' | number | null; env?: string; auto: number }): SlotsResolution {
  const clamp = (value: number) => Math.min(MAX_SLOTS, Math.max(1, Math.floor(value)))
  const pick = (value: 'auto' | number, source: SettingSource): SlotsResolution =>
    value === 'auto'
      ? { mode: 'auto', value: input.auto, effective: clamp(input.auto), source }
      : { mode: 'fixed', value, effective: clamp(value), source }
  if (input.saved !== null) return pick(input.saved, 'saved')
  const fromEnv = input.env?.trim() ? parseSlots(input.env) : null
  if (fromEnv !== null) return pick(fromEnv, 'env')
  return pick('auto', 'default')
}

/** The slots in effect right now, with what `auto` would give next to them and what one slot is sized for. */
export function slotsResolution(env: NodeJS.ProcessEnv = process.env): SlotsResolution & {
  auto: number
  perSlot: { cpus: number; memoryMb: number }
} {
  const defaults = competitionDefaults().limits
  const auto = autoSlots(machineShape(), defaults)
  return { ...resolveSlots({ saved: savedSlots(), env: env.COMPETITION_SLOTS, auto }), auto, perSlot: slotShape(defaults) }
}

/* -------------------------------------------------------------- admission */

/** What MemAvailable must still hold after the job: the page cache and the server itself live there. */
export const MEMORY_FLOOR_MB = 512

export interface AdmissionInput {
  /** This job's reservation: its larger step plus the container cushion, MB. */
  needMb: number
  /**
   * Reservations already promised and not yet visible in the room census:
   * running competition jobs, dependency preparations, kernels still
   * starting, containers awaiting removal.
   */
  reservedMb: number
  /** What competition work may promise in total; `null` — unknown, the check is skipped. */
  usableMb: number | null
  /**
   * The kernel's MemAvailable minus what was admitted since it was measured
   * (a job started a millisecond ago has not taken its memory yet); `null` —
   * unknown (a VM, macOS), the check is skipped.
   */
  memAvailableMb: number | null
}

export type Admission = { ok: true } | { ok: false; reason: 'reservations' | 'floor' }

/**
 * May this job start now.
 *
 * "Unknown" is never a refusal: a queue that stalled because /proc could not
 * be read is worse than a submission docker refuses. A refusal happens only
 * when we know for sure the memory is not there.
 */
export function admitJob(input: AdmissionInput): Admission {
  if (input.usableMb !== null && input.reservedMb + input.needMb > input.usableMb) {
    return { ok: false, reason: 'reservations' }
  }
  if (input.memAvailableMb !== null && input.memAvailableMb < input.needMb + MEMORY_FLOOR_MB) {
    return { ok: false, reason: 'floor' }
  }
  return { ok: true }
}

/** How long an old census is still believed when the fresh one could not count every room. */
export const CENSUS_TRUST_MS = 60_000

export interface CensusReading {
  /** Memory held by live room kernels, by the last COMPLETE census. */
  memoryMb: number
  /** Whether the latest census was complete. */
  complete: boolean
  /** When the last complete census was taken. */
  at: number
}

/**
 * What competition work may promise in total: the machine minus the host's
 * reserve minus the limits of live room kernels.
 *
 * An incomplete census (one `docker inspect` timed out) no longer closes the
 * queue on the spot: the last complete one is believed for a minute, because
 * rooms do not appear that fast, and a class does not wait for a daemon
 * hiccup. Older than that, nothing is promised — a queue that waits is cheaper
 * than a machine pushed into swap under a class.
 */
export function usableMemoryMb(input: { totalMb: number | null; census: CensusReading; now: number }): number | null {
  if (input.totalMb === null) return null
  const { census } = input
  if (!census.complete && input.now - census.at > CENSUS_TRUST_MS) return 0
  return Math.max(0, input.totalMb - HOST_RESERVE_MB - census.memoryMb)
}

/**
 * The kernel's own "how much can be taken without swap", raw.
 *
 * Read here rather than through resources.ts, which hands out only the
 * smaller of it and the unpromised memory — exactly the mix that counted a
 * running submission twice.
 */
export function hostMemAvailableMb(): number | null {
  try {
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))
    return match ? Math.floor(Number(match[1]) / 1024) : null
  } catch {
    return null
  }
}

/**
 * The machine's numbers for competition admission, from one fresh census.
 *
 * `availableMb` keeps its old meaning (what resources.ts hands out) for the
 * dependency preparation, which reserves against it; the queue reads
 * `usableMb` and `memAvailableMb`. MemAvailable is only asked where the
 * containers share this kernel: a colima VM has its own, and the Mac's says
 * nothing about it.
 */
export async function competitionMemory(): Promise<{ usableMb: number | null; memAvailableMb: number | null; availableMb: number | null }> {
  try {
    const machine = await machineResources({ fresh: true, beforeReservations: true })
    const usableMb = usableMemoryMb({ totalMb: machine.memory.totalMb, census: observedWorkCensus(), now: Date.now() })
    const memAvailableMb = kernelBackend() !== 'test' && machine.memory.source === 'host' ? hostMemAvailableMb() : null
    return { usableMb, memAvailableMb, availableMb: machine.memory.availableMb }
  } catch {
    return { usableMb: null, memAvailableMb: null, availableMb: null }
  }
}
