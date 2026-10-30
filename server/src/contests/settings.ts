/**
 * The instance's judge settings — in the shared box (`instance_settings`),
 * under `contests.*` keys, next to the competitions' own.
 *
 * Two of them, both of the MACHINE, not of a contest: how many submissions
 * are judged at once (`contests.judgeSlots`), and whether the judge takes new
 * work at all (`contests.judgePaused`). A missing row is not an error but «as
 * by default» — automatic slots, not paused: everyone who upgraded has none,
 * and reading that as zero would stall every contest on the instance.
 */
/*
 * The box is created by admin/settings, and the import is not decoration:
 * without it the table may not exist yet when the statements below are
 * prepared (competitions/settings.ts imports it for the same reason).
 */
import '../admin/settings.js'
import os from 'node:os'
import { db } from '../db.js'
import { JUDGE_SLOTS } from '@shared/contests'

const KEY = {
  judgeSlots: 'contests.judgeSlots',
  paused: 'contests.judgePaused',
} as const

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

/** The machine's CPUs as Node counts them. A function, so a test can ask what `auto` means elsewhere. */
function machineCpus(): number {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
}

/**
 * What `auto` means here: half the CPUs, between one and eight.
 *
 * Half, because a judging is one CPU busy (--cpus 1) and the class next to it
 * runs kernels on the same machine; at most eight, because past that the
 * memory each judging reserves (a gigabyte and a half) matters more than the
 * cores. At least one: a contest whose judge never starts is no contest.
 */
export function autoJudgeSlots(cpus = machineCpus()): number {
  return Math.min(8, Math.max(1, Math.floor(cpus / 2)))
}

/** What the owner saved; null — nothing: automatic. A value outside the bounds reads as not saved. */
export function savedJudgeSlots(): number | null {
  const raw = stored(KEY.judgeSlots)
  if (raw === null || !/^\d+$/.test(raw.trim())) return null
  const value = Number(raw)
  return value >= JUDGE_SLOTS.min && value <= JUDGE_SLOTS.max ? value : null
}

/** Save the slots: a number within JUDGE_SLOTS, or null for automatic. */
export function saveJudgeSlots(slots: number | null): void {
  if (slots === null) dropSetting.run(KEY.judgeSlots)
  else writeSetting.run(KEY.judgeSlots, String(slots))
}

/** How many submissions are judged at once now. */
export function judgeSlots(): number {
  return savedJudgeSlots() ?? autoJudgeSlots()
}

/**
 * The form's value: a whole number within JUDGE_SLOTS, or null (automatic);
 * `'invalid'` — anything else, refused at the door rather than clamped
 * («сохранилось 32» for a typed 320 is a number nobody chose).
 */
export function parseJudgeSlots(raw: unknown): number | null | 'invalid' {
  if (raw === null || raw === 'auto') return null
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN
  if (!Number.isInteger(value) || value < JUDGE_SLOTS.min || value > JUDGE_SLOTS.max) return 'invalid'
  return value
}

/**
 * The judge's pause. It stops new judgings of every kind from starting and
 * touches none that is running: «start no new ones» and «kill what runs» are
 * different promises (the competitions' pause makes the same one).
 */
export function judgePaused(): boolean {
  return stored(KEY.paused) === '1'
}

export function setJudgePaused(paused: boolean): void {
  if (paused) writeSetting.run(KEY.paused, '1')
  else dropSetting.run(KEY.paused)
}
