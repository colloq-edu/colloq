/**
 * What the kernel itself says about memory: /proc/meminfo, read when asked
 * and parsed, with nothing decided from it.
 *
 * ONE READER, AND A PURE ONE. Two copies of it lived in modules a machine for
 * submissions must not load: competitions/capacity.ts (the queue's admission,
 * which reads MemAvailable raw — its own header says why) and
 * kernel/resources.ts (the seminar form's "free now"), both behind the room
 * census and the database. A machine that runs submissions for a home
 * instance (docs/architecture/remote-runners.md) sizes what it offers home
 * from these very numbers (§5.2: MemTotal less the host's reserve and its own
 * runs, capped by MemAvailable), from an agent (dist/runner.js) that carries
 * neither the census nor the database. So the reading is here, both of those
 * modules call it, and nothing in this file runs before it is called.
 *
 * Nothing here throws, and nothing is made up: a machine without /proc of
 * its own (macOS, whose containers live in a VM it cannot see into) answers
 * `null`, "don't know", and each caller decides what "don't know" means for
 * it — for the queue's admission it is never a refusal (capacity.ts ·
 * admitJob).
 */
import fs from 'node:fs'

/** The two lines that are read, in MB rounded down; `null` — the line is not there. */
export interface Meminfo {
  /** MemTotal: all the memory the kernel manages. */
  totalMb: number | null
  /**
   * MemAvailable: the kernel's own estimate of how much can be taken without
   * going to swap, page cache it would give back included — not `freemem`,
   * which on a working Linux server is always near zero (resources.ts says
   * more about why).
   */
  availableMb: number | null
}

/** "MemTotal:  65799928 kB" and friends: the kernel prints kibibytes, the callers think in MB. */
export function parseMeminfo(text: string): Meminfo {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text)
    return match ? Math.floor(Number(match[1]) / 1024) : null
  }
  return { totalMb: field('MemTotal'), availableMb: field('MemAvailable') }
}

/** The machine's meminfo now; `null` — not Linux, or /proc is not mounted. `file` is for tests. */
export function readMeminfo(file = '/proc/meminfo'): Meminfo | null {
  try {
    return parseMeminfo(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The kernel's MemAvailable, raw, MB; `null` — unknown. */
export function hostMemAvailableMb(): number | null {
  return readMeminfo()?.availableMb ?? null
}
