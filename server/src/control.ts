/**
 * The run-control socket.
 *
 * Everything the room *sees* — source, outputs, kernel status — travels through
 * the CRDT. This channel carries the things a CRDT cannot express: "run this",
 * "stop", "start over", and the two pieces of side-band state the document has
 * no home for (the workspace file listing and a plain error sentence).
 *
 * Running a cell is open to every participant. That is not an oversight: a
 * seminar where only the lecturer may press Run is a screen share, and the
 * whole point of Colloq is that a student can try the thing being discussed
 * without leaving the room. Interrupt and restart are host-only, because those
 * are destructive to everyone else's kernel state.
 *
 * The terminal splits the same way. Opening it and typing into it are open to
 * everyone — it is the room's shell, and a student who needs a library should be
 * able to install it. Clearing and closing are host-only, because both destroy
 * something the whole room can see: shared history, and the shell itself.
 */
import { WebSocket, type RawData } from 'ws'
import { cellId, cellType, getCells, getMeta, type KernelStatus } from '@shared/notebook'
import { colorForId } from '@shared/protocol'
import type {
  ControlClientMessage,
  ControlServerMessage,
  FileEntry,
  Participant,
} from '@shared/protocol'
import type { TokenPayload } from './auth.js'
import { getSessionDoc } from './collab/index.js'
import { LINE_LENGTH } from './kernel/format.js'
import { allows } from '@shared/rules'
import { getParticipant, getRules } from './db.js'
import {
  answerInput,
  clearOutputs,
  formatSession,
  kernelNote,
  interruptSession,
  onWorkspaceChanged,
  requestRun,
  restartSession,
  cancelRun,
  startedTheRunningCell,
} from './kernel/index.js'
import {
  clearTerminal,
  closeTerminal,
  interruptTerminal,
  onTerminalPhase,
  openTerminal,
  runCommand,
  terminalPhase,
} from './kernel/terminal.js'
import { listFiles } from './workspace.js'

/** Same reason as the collab socket: stay under the usual 30s idle timeout. */
const PING_INTERVAL_MS = 25_000
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2
/** Control frames are tiny by construction; anything larger is not ours. */
const MAX_FRAME_BYTES = 8192
/** A shell command, not a shell script: anything longer is a paste accident. */
const MAX_COMMAND_BYTES = 4096

interface Room {
  sockets: Set<WebSocket>
  unwatch: () => void
}

const rooms = new Map<string, Room>()

/* ----------------------------------------------------------------- send */

function send(ws: WebSocket, message: ControlServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(message))
  } catch {
    /* the socket died between the check and the write */
  }
}

function broadcast(sessionId: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  if (!room) return
  const frame = JSON.stringify(message)
  for (const ws of room.sockets) {
    if (ws.readyState !== WebSocket.OPEN) continue
    try {
      ws.send(frame)
    } catch {
      /* dropped; the close handler will clean it up */
    }
  }
}

/**
 * Push the workspace listing to a session. Called after an upload or delete and,
 * via `onWorkspaceChanged`, whenever a cell writes a file — so `df.to_csv(...)`
 * makes the Files panel update for the whole room, not just for whoever ran it.
 */
/**
 * Send everyone in a room home and stop watching it. Called when the seminar
 * itself is deleted: a control socket that outlives its seminar can still ask
 * for a run, and every path in kernel/index.ts reaches for the document through
 * getSessionDoc(), which would build the deleted room again from nothing.
 */
export function closeControlRoom(sessionId: string): void {
  const room = rooms.get(sessionId)
  if (!room) return
  rooms.delete(sessionId)
  room.unwatch()
  for (const ws of room.sockets) {
    try {
      ws.close(1001, 'this seminar was deleted')
    } catch {
      /* already gone */
    }
  }
  room.sockets.clear()
}

export function broadcastFiles(sessionId: string): void {
  const room = rooms.get(sessionId)
  if (!room || room.sockets.size === 0) return
  let files: FileEntry[]
  try {
    files = listFiles(sessionId)
  } catch {
    return
  }
  broadcast(sessionId, { t: 'files', files })
}

// Registered once, at import: the kernel runtime has no idea who is listening.
onWorkspaceChanged(broadcastFiles)

// The transcript is in the document; the terminal's health is not, so it comes
// down this channel the same way kernel status does.
onTerminalPhase((sessionId, status) => broadcast(sessionId, { t: 'terminal', status }))

/* ----------------------------------------------------------------- doc */

function kernelStatus(sessionId: string): KernelStatus {
  try {
    const status = getMeta(getSessionDoc(sessionId).doc).get('kernelStatus')
    return typeof status === 'string' ? (status as KernelStatus) : 'starting'
  } catch {
    return 'starting'
  }
}

/**
 * Kernel health lives in the document, so the browser already re-renders from
 * there. Mirroring it onto this socket costs one small frame and keeps clients
 * that are watching only the control channel honest.
 */
function watchKernelStatus(sessionId: string): () => void {
  const meta = getMeta(getSessionDoc(sessionId).doc)
  let last = meta.get('kernelStatus') as KernelStatus | undefined
  const onChange = () => {
    const status = meta.get('kernelStatus') as KernelStatus | undefined
    if (!status || status === last) return
    last = status
    broadcast(sessionId, { t: 'kernel', status })
  }
  meta.observe(onChange)
  return () => meta.unobserve(onChange)
}

/**
 * Code cell ids in document order. With `upToCellId`, stops after that cell —
 * and returns nothing if the id is unknown, so a stale "run above" from a tab
 * that missed a deletion cannot silently turn into "run the whole notebook".
 */
function codeCellIds(sessionId: string, upToCellId?: string): string[] {
  const cells = getCells(getSessionDoc(sessionId).doc)
  const ids: string[] = []
  for (let i = 0; i < cells.length; i++) {
    const cell = cells.get(i)
    const id = cellId(cell)
    if (cellType(cell) === 'code') ids.push(id)
    if (upToCellId !== undefined && id === upToCellId) return ids
  }
  return upToCellId === undefined ? ids : []
}

/** Output attribution is a human name or nothing worth showing. */
function displayName(sessionId: string, participantId: string): string {
  try {
    return getParticipant(sessionId, participantId)?.name || 'Someone'
  } catch {
    return 'Someone'
  }
}

/**
 * Terminal lines carry the typist's colour as well as their name — in a shared
 * shell, "who ran that" is the first question anyone asks.
 */
function sender(
  sessionId: string,
  participantId: string,
): { name: string; color: string; participantId: string } {
  let participant: Participant | null = null
  try {
    participant = getParticipant(sessionId, participantId)
  } catch {
    participant = null
  }
  return {
    name: participant?.name || 'Someone',
    color: participant?.color || colorForId(participantId),
    participantId,
  }
}

/* ------------------------------------------------------------- dispatch */

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return (data as Buffer).toString('utf8')
}

function parse(data: RawData): ControlClientMessage | null {
  const text = frameText(data)
  if (text.length === 0 || text.length > MAX_FRAME_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const t = (parsed as { t?: unknown }).t
    if (typeof t !== 'string') return null
    return parsed as ControlClientMessage
  } catch {
    return null
  }
}

/**
 * May this person start the kernel on something?
 *
 * The first of the room's rules to be enforced, and the reason it is first: one
 * kernel serves everybody, so a class where twenty people press Run is one
 * queue, and a lecture usually wants the queue to be the teacher's. Every other
 * rule in RoomRules costs more to keep than this one — they live in the CRDT,
 * where the server would have to start refusing document updates.
 *
 * The refusal is spoken rather than silent. A button that does nothing is a bug
 * report; a button that says why is a rule.
 */
function mayRun(sessionId: string, payload: TokenPayload, ws: WebSocket): boolean {
  if (allows(getRules(sessionId).run, payload.role)) return true
  send(ws, {
    t: 'error',
    message: 'Only the teacher runs cells in this seminar.',
  })
  return false
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined
}

function dispatch(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
  message: ControlClientMessage,
): void {
  switch (message.t) {
    case 'ping':
      send(ws, { t: 'pong' })
      return

    case 'run': {
      const id = optionalId(message.cellId)
      if (!id) return
      if (!mayRun(sessionId, payload, ws)) return
      requestRun(sessionId, [id], displayName(sessionId, payload.participantId), payload.participantId)
      return
    }

    case 'cancel': {
      const id = optionalId(message.cellId)
      if (!id) return
      // Silent when there was nothing of theirs waiting: two people pressing
      // cancel on the same cell is a race, not an error worth a message.
      cancelRun(sessionId, [id], payload.participantId, payload.role === 'host')
      return
    }

    case 'runAll': {
      if (!mayRun(sessionId, payload, ws)) return
      const ids = codeCellIds(sessionId)
      if (ids.length > 0) {
        requestRun(sessionId, ids, displayName(sessionId, payload.participantId), payload.participantId)
      }
      return
    }

    case 'runAbove': {
      const id = optionalId(message.cellId)
      if (!id) return
      if (!mayRun(sessionId, payload, ws)) return
      const ids = codeCellIds(sessionId, id)
      if (ids.length > 0) {
        requestRun(sessionId, ids, displayName(sessionId, payload.participantId), payload.participantId)
      }
      return
    }

    case 'interrupt': {
      /*
       * The host can always stop the kernel. So can whoever started the cell
       * that is running: they are stopping their own work, only one cell runs
       * at a time, and a seminar with no teacher in the room otherwise has no
       * way at all to end a loop that will not end itself.
       *
       * By participant id, not by name — two students called Anna are two
       * people, and a name is not a credential.
       */
      if (payload.role !== 'host' && !startedTheRunningCell(sessionId, payload.participantId)) {
        send(ws, {
          t: 'error',
          message: 'Only the host, or whoever started the running cell, can interrupt the kernel.',
        })
        return
      }
      void interruptSession(sessionId).catch((err: unknown) => {
        send(ws, { t: 'error', message: reason(err, 'Could not interrupt the kernel.') })
      })
      return
    }

    case 'restart': {
      if (payload.role !== 'host') {
        send(ws, { t: 'error', message: 'Only the host can restart the kernel.' })
        return
      }
      void restartSession(sessionId, displayName(sessionId, payload.participantId)).catch((err: unknown) => {
        send(ws, { t: 'error', message: reason(err, 'Could not restart the kernel.') })
      })
      return
    }

    case 'clearOutputs': {
      clearOutputs(sessionId, optionalId(message.cellId))
      return
    }

    case 'input': {
      const value = typeof message.value === 'string' ? message.value : ''
      void answerInput(sessionId, value).catch((err: unknown) => {
        send(ws, { t: 'error', message: reason(err, 'Could not send that to the cell.') })
      })
      return
    }

    case 'format': {
      /*
       * The result goes to the terminal transcript rather than back down this
       * socket: everybody's notebook just changed under them, so everybody
       * deserves the sentence explaining it — not only whoever pressed the
       * button. It is also the one place that can say "three cells were left
       * alone", which is the part somebody will want to check.
       */
      void formatSession(sessionId)
        .then((outcome) => {
          if (outcome.error) return
          if (outcome.changed === 0 && outcome.skipped === 0) {
            kernelNote(sessionId, 'Formatted with black — everything was already in shape.')
            return
          }
          const parts = [`${outcome.changed} ${outcome.changed === 1 ? 'cell' : 'cells'} reformatted`]
          if (outcome.skipped > 0) {
            parts.push(
              `${outcome.skipped} left alone (a magic, a shell line, or code mid-sentence — black could not read them)`,
            )
          }
          kernelNote(sessionId, `Formatted with black, ${LINE_LENGTH} columns: ${parts.join('; ')}.`)
        })
        .catch((err: unknown) => {
          send(ws, { t: 'error', message: reason(err, 'Could not format the notebook.') })
        })
      return
    }

    case 'term:open': {
      void openTerminal(sessionId).catch((err: unknown) => {
        send(ws, { t: 'error', message: reason(err, 'Could not open the terminal.') })
      })
      return
    }

    case 'term:run': {
      const command = typeof message.command === 'string' ? message.command : ''
      if (command.trim().length === 0) return
      if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
        send(ws, {
          t: 'error',
          message: `That command is over ${MAX_COMMAND_BYTES.toLocaleString('en-GB')} characters. Put it in a file and run the file.`,
        })
        return
      }
      runCommand(sessionId, command, sender(sessionId, payload.participantId))
      return
    }

    case 'term:interrupt': {
      interruptTerminal(sessionId)
      return
    }

    case 'term:clear': {
      if (payload.role !== 'host') {
        send(ws, {
          t: 'error',
          message: 'Only the host can clear the terminal — that history belongs to the room.',
        })
        return
      }
      clearTerminal(sessionId)
      return
    }

    case 'term:close': {
      if (payload.role !== 'host') {
        send(ws, { t: 'error', message: 'Only the host can close the terminal.' })
        return
      }
      void closeTerminal(sessionId).catch((err: unknown) => {
        send(ws, { t: 'error', message: reason(err, 'Could not close the terminal.') })
      })
      return
    }
  }
}

function reason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/* --------------------------------------------------------------- socket */

export function handleControlSocket(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
): void {
  let room = rooms.get(sessionId)
  if (!room) {
    room = { sockets: new Set<WebSocket>(), unwatch: () => {} }
    rooms.set(sessionId, room)
    // Attach after the room exists, so the first status change has somewhere to go.
    room.unwatch = watchKernelStatus(sessionId)
  }
  room.sockets.add(ws)

  // Before anything else: the browser gates its own interrupt/restart controls
  // on this, and the token it holds may say something staler than the truth.
  send(ws, { t: 'role', role: payload.role })

  let missedPongs = 0
  const pingTimer = setInterval(() => {
    if (missedPongs >= MAX_MISSED_PONGS) {
      ws.terminate()
      return
    }
    missedPongs++
    try {
      ws.ping()
    } catch {
      ws.terminate()
    }
  }, PING_INTERVAL_MS)

  const drop = () => {
    clearInterval(pingTimer)
    const current = rooms.get(sessionId)
    if (!current) return
    current.sockets.delete(ws)
    if (current.sockets.size === 0) {
      current.unwatch()
      rooms.delete(sessionId)
    }
  }

  ws.on('pong', () => {
    missedPongs = 0
  })

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return
    const message = parse(data)
    if (!message) return
    try {
      dispatch(ws, sessionId, payload, message)
    } catch (err) {
      // One bad request costs that click, never the seminar.
      console.error(`[control ${sessionId}] ${message.t} failed:`, reason(err, 'unknown error'))
      send(ws, { t: 'error', message: reason(err, 'That did not work.') })
    }
  })

  ws.on('close', drop)
  ws.on('error', drop)

  send(ws, { t: 'ready', kernel: kernelStatus(sessionId) })
  send(ws, { t: 'terminal', status: terminalPhase(sessionId) })
  let files: FileEntry[]
  try {
    files = listFiles(sessionId)
  } catch {
    files = []
  }
  send(ws, { t: 'files', files })
}
