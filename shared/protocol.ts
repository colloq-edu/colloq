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
  | { t: 'ping' }

export type TerminalStatus = 'closed' | 'starting' | 'idle' | 'busy' | 'dead'

export type ControlServerMessage =
  | { t: 'ready'; kernel: KernelStatus }
  | { t: 'terminal'; status: TerminalStatus }
  | { t: 'kernel'; status: KernelStatus }
  | { t: 'files'; files: FileEntry[] }
  | { t: 'error'; message: string }
  | { t: 'pong' }

/* ------------------------------------------------------------------- AI */

export type AiAction = 'explain' | 'fix' | 'debug' | 'improve' | 'hint' | 'ask'

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
  '#7c7cf0', // indigo
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
  /** True while they are typing into the assistant composer. */
  composing?: boolean
  /** True while their cursor is in the terminal. */
  inTerminal?: boolean
}

/** Per-viewer preference, never shared with the room. */
export type ThemeName = 'light' | 'dark'
