/**
 * Where each slot of a class runs now, and where its class wants it
 * (docs/architecture/remote-classes.md §6.2, §6.7): the remote_placements
 * table, the class's setting as the code reads it, and the one question the
 * pool asks on every start — `machinePlaced`.
 *
 * THE SCHEMA IS HERE, with one owner, as competitions/remote/store.ts keeps
 * the machines' own: no other module writes this table. A slot of a class is
 * one row, keyed by (session, role), whose `gen` bumps on every placement
 * and fences everything a machine says about it (§6.9). A slot with no LIVE
 * row (starting, ready, unreachable, stopping) runs here, if it runs at all:
 * classes from before machines carry no rows, and nothing about them
 * changes. `stopped` and `lost` rows are history, for the chooser's «the
 * machine that hosted the class last» and for the next gen — kept for good,
 * one row per slot: a gen used twice would open the fence it is (the tunnel
 * refuses a (machine, slot, gen) it was told was lost, and the token would
 * be the old placement's). No revision triggers: usage, the link and file
 * progress live in memory, as heard.ts keeps a machine's sync.
 *
 * A MODULE THAT IMPORTS THE DATABASE AND THE SETTINGS ALONE, on purpose: the
 * pool (pool.ts) asks `machinePlaced` at the top of every slot operation and
 * loads with the server's first imports, while the placement itself
 * (placement.ts) reaches the machines' router, the tunnel and the
 * competitions' store, which import the pool. The pool reaches placement.ts
 * by a dynamic import, only for a class that has something on a machine.
 */
import {
  CLASS_PLACEMENT_DEFAULT,
  CLASS_PLACEMENT_PRESETS,
  storedClassPlacement,
  type ClassPlacement,
} from '@shared/admin'
import { db, sessionPlacement, useNewClassPlacement } from '../../db.js'
import { classMachineSettings } from '../../admin/resource-settings.js'
import { needsGpu } from '../../environments.js'
import type { RoomRole } from '../room-spec.js'

/* ----------------------------------------------------------------- schema */

db.exec(`
  /*
   * One slot of a class on one machine at one generation. \`state\`:
   * starting (written, the machine told), ready (the machine reported it and
   * home checked its echoes), unreachable (ready, but its machine's tunnel is
   * down), stopping (home asked for its removal and waits for the machine to
   * stop listing it), stopped and lost (history: ended by a stop, or by a
   * failover with its cause in \`reason\`).
   *
   * The revision is pinned whole (id, registry reference, layers), as a lease
   * pins it: a recreate or a later sync names the very image the container
   * was asked with, whatever the revision row learns since (a push gives it
   * another reference). \`gpu\`: NULL no card; '' a whole card asked and not
   * yet named by the machine; otherwise the card it holds (§6.5).
   */
  CREATE TABLE IF NOT EXISTS remote_placements (
    session_id      TEXT NOT NULL,
    role            TEXT NOT NULL,
    gen             INTEGER NOT NULL,
    runner_id       TEXT NOT NULL,
    state           TEXT NOT NULL,
    environment     TEXT NOT NULL,
    revision_id     TEXT NOT NULL,
    revision_ref    TEXT NOT NULL,
    revision_layers TEXT NOT NULL,
    memory_mb       INTEGER NOT NULL,
    cpus            INTEGER NOT NULL,
    gpu             TEXT,
    workers         INTEGER,
    container       TEXT,
    ready_at        INTEGER,
    ended_at        INTEGER,
    reason          TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (session_id, role)
  );
  CREATE INDEX IF NOT EXISTS remote_placements_runner ON remote_placements(runner_id, state);
`)

/* ------------------------------------------------------------------- rows */

export type PlacementState = 'starting' | 'ready' | 'unreachable' | 'stopping' | 'stopped' | 'lost'

/** The states in which the slot is the machine's: anything else runs here. */
export const LIVE_PLACEMENT_STATES: readonly PlacementState[] = ['starting', 'ready', 'unreachable', 'stopping']
const LIVE_SQL = `(${LIVE_PLACEMENT_STATES.map((state) => `'${state}'`).join(', ')})`

export interface PlacementRow {
  sessionId: string
  role: RoomRole
  gen: number
  runnerId: string
  state: PlacementState
  environment: string
  revision: { id: string; ref: string; layers: string }
  memoryMb: number
  cpus: number
  /** null — no card; '' — a whole card asked, not named yet; otherwise the card the machine holds for the slot. */
  gpu: string | null
  /** The council's planned pool size; null for the other roles. */
  workers: number | null
  /** The container's id, from the machine's ready report. */
  container: string | null
  readyAt: number | null
  endedAt: number | null
  /** Why it ended (a failover's cause, `stopped`), or why it waits. */
  reason: string | null
  /** When this gen was written. */
  createdAt: number
}

interface PlacementRaw {
  session_id: string
  role: string
  gen: number
  runner_id: string
  state: string
  environment: string
  revision_id: string
  revision_ref: string
  revision_layers: string
  memory_mb: number
  cpus: number
  gpu: string | null
  workers: number | null
  container: string | null
  ready_at: number | null
  ended_at: number | null
  reason: string | null
  created_at: number
}

const ROLES: readonly RoomRole[] = ['room', 'own', 'council']
const STATES: readonly PlacementState[] = ['starting', 'ready', 'unreachable', 'stopping', 'stopped', 'lost']

/** A row as the code reads it; one a hand left unreadable reads as `lost`, history the chooser can still use. */
function toPlacement(raw: PlacementRaw): PlacementRow {
  return {
    sessionId: raw.session_id,
    role: (ROLES as readonly string[]).includes(raw.role) ? (raw.role as RoomRole) : 'room',
    gen: raw.gen,
    runnerId: raw.runner_id,
    state: (STATES as readonly string[]).includes(raw.state) ? (raw.state as PlacementState) : 'lost',
    environment: raw.environment,
    revision: { id: raw.revision_id, ref: raw.revision_ref, layers: raw.revision_layers },
    memoryMb: raw.memory_mb,
    cpus: raw.cpus,
    gpu: raw.gpu,
    workers: raw.workers,
    container: raw.container,
    readyAt: raw.ready_at,
    endedAt: raw.ended_at,
    reason: raw.reason,
    createdAt: raw.created_at,
  }
}

const selectSlot = db.prepare('SELECT * FROM remote_placements WHERE session_id = ? AND role = ?')
const selectClass = db.prepare('SELECT * FROM remote_placements WHERE session_id = ? ORDER BY role')
const selectRunner = db.prepare(`SELECT * FROM remote_placements WHERE runner_id = ? AND state IN ${LIVE_SQL} ORDER BY session_id, role`)
const selectLive = db.prepare(`SELECT * FROM remote_placements WHERE state IN ${LIVE_SQL} ORDER BY session_id, role`)
const selectLiveSlot = db.prepare(`SELECT 1 FROM remote_placements WHERE session_id = ? AND role = ? AND state IN ${LIVE_SQL}`)
const selectLiveClass = db.prepare(`SELECT 1 FROM remote_placements WHERE session_id = ? AND state IN ${LIVE_SQL} LIMIT 1`)
const selectAnyLive = db.prepare(`SELECT 1 FROM remote_placements WHERE state IN ${LIVE_SQL} LIMIT 1`)

/** The slot's row in whatever state: the live placement, or the last one's history. */
export function placementRow(sessionId: string, role: RoomRole): PlacementRow | null {
  const raw = selectSlot.get(sessionId, role) as PlacementRaw | undefined
  return raw ? toPlacement(raw) : null
}

/** The slot's live placement (starting, ready, unreachable or stopping), or null: it runs here, if at all. */
export function livePlacement(sessionId: string, role: RoomRole): PlacementRow | null {
  const row = placementRow(sessionId, role)
  return row && LIVE_PLACEMENT_STATES.includes(row.state) ? row : null
}

/** Whether the slot is the machine's now: one indexed lookup, for the pool's hot paths. */
export function hasLivePlacement(sessionId: string, role: RoomRole): boolean {
  return selectLiveSlot.get(sessionId, role) !== undefined
}

/** Whether any slot of the class is the machine's now. */
export function classHasLivePlacement(sessionId: string): boolean {
  return selectLiveClass.get(sessionId) !== undefined
}

/** Whether any class has anything live on any machine: what decides the classes' faster clock. */
export function anyLivePlacement(): boolean {
  return selectAnyLive.get() !== undefined
}

/** Every row of a class, live and history. */
export function classPlacementRows(sessionId: string): PlacementRow[] {
  return (selectClass.all(sessionId) as PlacementRaw[]).map(toPlacement)
}

/** The live rows of one machine. */
export function runnerPlacementRows(runnerId: string): PlacementRow[] {
  return (selectRunner.all(runnerId) as PlacementRaw[]).map(toPlacement)
}

/** Every live row. */
export function livePlacementRows(): PlacementRow[] {
  return (selectLive.all() as PlacementRaw[]).map(toPlacement)
}

const upsert = db.prepare(`INSERT INTO remote_placements (session_id, role, gen, runner_id, state, environment, revision_id, revision_ref,
    revision_layers, memory_mb, cpus, gpu, workers, container, ready_at, ended_at, reason, created_at)
  VALUES (@session_id, @role, @gen, @runner_id, @state, @environment, @revision_id, @revision_ref, @revision_layers, @memory_mb, @cpus,
    @gpu, @workers, @container, @ready_at, @ended_at, @reason, @created_at)
  ON CONFLICT(session_id, role) DO UPDATE SET gen = excluded.gen, runner_id = excluded.runner_id, state = excluded.state,
    environment = excluded.environment, revision_id = excluded.revision_id, revision_ref = excluded.revision_ref,
    revision_layers = excluded.revision_layers, memory_mb = excluded.memory_mb, cpus = excluded.cpus, gpu = excluded.gpu,
    workers = excluded.workers, container = excluded.container, ready_at = excluded.ready_at, ended_at = excluded.ended_at,
    reason = excluded.reason, created_at = excluded.created_at`)

/**
 * A new placement of the slot, at the gen after the last one's: the row is
 * the slot's, so the previous placement (live or history) is replaced, and
 * everything the machine still says about an older gen is stale from here.
 * In one transaction with its read: two placements of one slot never share a
 * gen. Rows are never deleted, so the count never starts over.
 */
export const writePlacement = db.transaction((row: Omit<PlacementRow, 'gen'>): PlacementRow => {
  const before = selectSlot.get(row.sessionId, row.role) as PlacementRaw | undefined
  const gen = (before?.gen ?? 0) + 1
  upsert.run({
    session_id: row.sessionId,
    role: row.role,
    gen,
    runner_id: row.runnerId,
    state: row.state,
    environment: row.environment,
    revision_id: row.revision.id,
    revision_ref: row.revision.ref,
    revision_layers: row.revision.layers,
    memory_mb: row.memoryMb,
    cpus: row.cpus,
    gpu: row.gpu,
    workers: row.workers,
    container: row.container,
    ready_at: row.readyAt,
    ended_at: row.endedAt,
    reason: row.reason,
    created_at: row.createdAt,
  })
  return { ...row, gen }
})

export type PlacementPatch = Partial<Pick<PlacementRow, 'state' | 'memoryMb' | 'cpus' | 'gpu' | 'container' | 'readyAt' | 'endedAt' | 'reason'>>

const COLUMN: Record<keyof PlacementPatch, string> = {
  state: 'state',
  memoryMb: 'memory_mb',
  cpus: 'cpus',
  gpu: 'gpu',
  container: 'container',
  readyAt: 'ready_at',
  endedAt: 'ended_at',
  reason: 'reason',
}

/**
 * Change the slot's row at its gen, and only while it is in one of `from`:
 * the fence of every write (a report, a stop, a failover) against a newer
 * placement written in between. Whether the row changed.
 */
export function updatePlacement(sessionId: string, role: RoomRole, gen: number, patch: PlacementPatch, from: readonly PlacementState[] = STATES): boolean {
  const sets: string[] = []
  const params: Record<string, unknown> = { session_id: sessionId, role, gen }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const column = COLUMN[key as keyof PlacementPatch]
    sets.push(`${column} = @${column}`)
    params[column] = value
  }
  if (sets.length === 0 || from.length === 0) return false
  const states = from.map((state) => `'${state}'`).join(', ')
  return db.prepare(`UPDATE remote_placements SET ${sets.join(', ')} WHERE session_id = @session_id AND role = @role AND gen = @gen AND state IN (${states})`)
    .run(params).changes > 0
}

/* ---------------------------------------------------------------- setting */

/**
 * The class's «Где считается», every field filled: its stored setting, and
 * for what a row lacks (or never had) everything here with the owner's
 * «Переезд через».
 */
export function classPlacement(sessionId: string): ClassPlacement {
  return storedClassPlacement(sessionPlacement(sessionId), placementDefaults())
}

/** Everything here, with the instance's failover delay: what a class that never chose has. */
export function placementDefaults(): ClassPlacement {
  return { ...CLASS_PLACEMENT_DEFAULT, failoverSec: classMachineSettings().failoverSec }
}

/** Whether the setting puts this slot on machines: `room` and `own` by their own field, the council's pool by its. */
export function wantsMachines(placement: Pick<ClassPlacement, 'room' | 'own' | 'council'>, role: RoomRole): boolean {
  return placement[role] === 'machines'
}

/**
 * Whether the pool must ask the placement about this slot: it is on a
 * machine now, or its class wants it on machines (a start there, or the
 * fallback here, is the placement's to decide). Synchronous and two indexed
 * reads: the pool asks it at the top of every slot operation, and for a
 * class with nothing on machines the answer is no, at once.
 */
export function machinePlaced(sessionId: string, role: RoomRole): boolean {
  if (hasLivePlacement(sessionId, role)) return true
  const stored = sessionPlacement(sessionId)
  return stored !== null && wantsMachines(storedClassPlacement(stored, CLASS_PLACEMENT_DEFAULT), role)
}

/**
 * A new class's first setting (db.ts · createSession): the owner's tile,
 * except that a GPU class put on machines takes the card's tile, D31's
 * «Всё на машине с картой». A tile of everything here is stored as nothing:
 * the class reads the same, and its row stays as a class's from before.
 */
export function newClassPlacement(environment: string | null): ClassPlacement | null {
  const settings = classMachineSettings()
  if (settings.newClasses === 'home') return null
  let gpu = false
  try {
    gpu = environment !== null && needsGpu(environment)
  } catch {
    /* an environment that cannot be read is no GPU one */
  }
  const tile = CLASS_PLACEMENT_PRESETS[gpu ? 'gpu' : settings.newClasses]
  return { ...placementDefaults(), ...tile }
}

useNewClassPlacement(newClassPlacement)
