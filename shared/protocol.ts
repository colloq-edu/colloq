import type { RoomRules } from './rules.js'

/**
 * Wire contracts between browser and server: the control WebSocket, the REST
 * surface, and the AI streaming endpoint.
 *
 * Notebook *content* never travels through here — that is Yjs's job. This
 * channel carries intent ("run this cell") and side-band state (kernel health,
 * file listing) only.
 */
import type { CellSnapshot, KernelStatus } from './notebook'

export type ParticipantRole = 'host' | 'participant'

export interface Participant {
  id: string
  name: string
  avatar: string | null
  color: string
  role: ParticipantRole
}

export interface SessionInfo {
  id: string
  name: string
  createdAt: number
  /**
   * What this room lets people do.
   *
   * Sent to every client so the interface can be honest about itself: a Run
   * button that a student may not press should look unpressable rather than
   * fail when pressed. The server enforces the same rules independently — this
   * copy decides what is drawn, never what is allowed.
   */
  rules: RoomRules
}

export interface FileEntry {
  name: string
  size: number
  modifiedAt: number
}

/* ------------------------------------------------------------------ REST */

export interface CreateSessionRequest {
  name: string
}

export interface CreateSessionResponse {
  session: SessionInfo
  /** Signed host credential; the browser keeps it in localStorage. */
  hostToken: string
}

export interface JoinRequest {
  name: string
  avatar?: string | null
  /** Sent on a repeat visit so the same person keeps their identity. */
  participantId?: string | null
  /** Proves "I created this seminar" across a page refresh. */
  hostToken?: string | null
}

export interface JoinResponse {
  session: SessionInfo
  participant: Participant
  /** Signed credential for the control socket and AI endpoint. */
  token: string
}

/* -------------------------------------------------------- control socket */

export type ControlClientMessage =
  | { t: 'run'; cellId: string }
  /**
   * Take a cell out of the run queue. Not the same as interrupting: the cell
   * that is *running* is Interrupt's business, and cancelling never reaches it.
   * A student who pressed Run All behind somebody else's forty-second cell
   * otherwise had nothing to press — Interrupt belongs to the person whose cell
   * holds the kernel, and the queue was a one-way door.
   */
  | { t: 'cancel'; cellId: string }
  | { t: 'term:open' }
  | { t: 'term:run'; command: string }
  | { t: 'term:interrupt' }
  | { t: 'term:clear' }
  | { t: 'term:close' }
  | { t: 'runAll' }
  | { t: 'runAbove'; cellId: string }
  | { t: 'interrupt' }
  | { t: 'restart' }
  | { t: 'clearOutputs'; cellId?: string }
  /**
   * Put every code cell through black. A cell the formatter refuses — a magic,
   * a shell line, a line somebody is still typing — is left exactly as it was,
   * and the rest are still formatted.
   */
  | { t: 'format' }
  /**
   * An answer to a cell blocked inside input(). Anyone in the room may send
   * one; the first to arrive is the one the kernel gets.
   */
  | { t: 'input'; value: string }
  | { t: 'ping' }

export type TerminalStatus = 'closed' | 'starting' | 'idle' | 'busy' | 'dead'

export type ControlServerMessage =
  | { t: 'ready'; kernel: KernelStatus }
  /*
   * The role the SERVER will act on, sent as soon as the socket opens. A
   * participant token carries the role it was minted with, which goes stale:
   * a teacher who joined a seminar before signing in holds a 'participant'
   * token for a room they run, and the client would grey out interrupt and
   * restart for its own owner. Presence of a staff cookie decides it, and this
   * is how the browser is told.
   */
  | { t: 'role'; role: ParticipantRole }
  | { t: 'terminal'; status: TerminalStatus }
  | { t: 'kernel'; status: KernelStatus }
  | { t: 'files'; files: FileEntry[] }
  | { t: 'error'; message: string }
  | { t: 'pong' }

import type { OracleMode } from './admin.js'

/* ------------------------------------------------------------------- AI */

export type AiAction = 'explain' | 'fix' | 'debug' | 'improve' | 'hint' | 'ask' | 'edit'

/**
 * Which actions an oracle in this mode will accept.
 *
 * One definition, two callers: the route that refuses and the panel that
 * decides whether to draw the button. They were separate, and the panel drew
 * FIX and DEBUG in hints mode and let the student press them to be told no —
 * which is the rule leaking out as an error message instead of as a design.
 *
 * 'ask' is a typed question with no instruction of its own, so it survives
 * hints mode; the mode shapes the answer, not the right to ask.
 */
export function actionAllowedIn(mode: OracleMode, action: AiAction): boolean {
  if (mode === 'off') return false
  if (mode === 'full') return true
  /*
   * 'edit' is deliberately not in the hints list. It does not describe a fix,
   * it writes one — a diff the room can accept with one press — and a mode
   * whose whole point is that the student reaches the answer themselves cannot
   * also hand them the answer as a patch.
   */
  return action === 'hint' || action === 'ask'
}

export interface AiAskRequest {
  /** Free-form prompt. Optional when `action` carries the whole intent. */
  message: string
  action?: AiAction
  /** Cell the student had selected, if any. */
  cellId?: string | null
}

/**
 * Asking is fire-and-forget: the server appends the question to the shared
 * document and streams the answer into it, so every browser in the room sees
 * the same thread arrive without a per-client response stream.
 */
export interface AiAskResponse {
  entryId: string
}

/** Snapshot the server assembles for the model. Exported for tests/debugging. */
export interface AiContext {
  sessionName: string
  cells: CellSnapshot[]
  selectedCellId: string | null
  files: string[]
}

/* ---------------------------------------------------------------- misc */

export const PARTICIPANT_COLORS = [
  '#f97362', // coral
  '#f2a33c', // amber
  '#8ac44a', // lime
  '#3ec9a7', // teal
  '#4aa8f0', // sky
  // Nudged from #7c7cf0, which left initials at 4.48:1 — a hair under AA, and
  // the one colour in the palette where they were not readable. Six units of
  // RGB buys 4.74 and keeps it plainly indigo, and plainly not the sky or the
  // purple either side of it.
  '#7e82f0', // indigo
  '#c273e6', // violet
  '#ef6ba8', // pink
] as const

export function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length]
}

/** Shape stored in Yjs Awareness under the `user` field. */
export interface AwarenessUser {
  id: string
  name: string
  avatar: string | null
  color: string
  role: ParticipantRole
  /** Cell the person is currently focused on, for the "editing here" badge. */
  activeCellId?: string | null
  /** True while they are typing into the oracle composer. */
  composing?: boolean
  /** True while their cursor is in the terminal. */
  inTerminal?: boolean
}

/** Per-viewer preference, never shared with the room. */
export type ThemeName = 'light' | 'dark'
