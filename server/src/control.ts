import { authorizeSocket, type SocketCredentials } from './socket-authorization.js'
import {getLocale} from '@shared/i18n'
import {onInstanceLanguage} from './instance-language.js'
import { tr, formatNumber } from '@shared/i18n'
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
 * without leaving the room. Interrupt is the host's, and also whoever started
 * the cell that is running — see the case below. Restart is a room rule
 * (`rules.restart`), host-only by default.
 *
 * The terminal splits the same way. Opening it is open to everyone — it is the
 * room's shell, and a student who needs a library should be able to install it.
 * Clearing and closing are host-only, because both destroy something the whole
 * room can see: shared history, and the shell itself.
 *
 * And a command typed in it goes under the same rule as a cell: `python
 * train.py` in the shell is the same container and the same CPU time as Run
 * over a file, and a room where the "Run" button is greyed out with the words
 * "the teacher runs this one" cannot allow the same thing one line below. By
 * default (`run: 'room'`) it is still open to everyone.
 */
import type * as Y from 'yjs'
import { WebSocket, type RawData } from 'ws'
import {
  acceptPatch,
  allCellArrays,
  bookAt,
  bookCells,
  bookKernel,
  bookList,
  CELLS_KEY,
  cellId,
  cellLock,
  cellsAt,
  cellSource,
  cellType,
  councilSettingsOf,
  COUNCIL_RERUN_PAUSE_MAX,
  COUNCIL_RUN_LIMIT_MAX,
  DEFAULT_COUNCIL,
  findCell,
  findChatEntry,
  getCells,
  getMeta,
  isCellOpen,
  KERNELS_KEY,
  mainRoot,
  MAX_ATTEMPT_CHARS,
  openValueFor,
  readCouncilSettings,
  rejectPatch,
  rootOfCell,
  type CellLock,
  type CouncilSettings,
  type KernelStatus,
} from '@shared/notebook'
import { colorForId } from '@shared/protocol'
import { durationWords } from '@shared/text'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilAttempt,
  CouncilBoard,
  CouncilRun,
  FileEntry,
  Participant,
} from '@shared/protocol'
import type { TokenPayload } from './auth.js'
import {
  applyOnBehalf,
  dropParticipant,
  getSessionDoc,
  peekSessionDoc,
  onCellsRemoved,
  onRefusal,
} from './collab/index.js'
import { moveInCells } from './collab/ops.js'
import { defineIn } from './definitions.js'
import { LINE_LENGTH } from './kernel/format.js'
import { importHeader, nameChainAt } from './kernel/inspect-static.js'
import { kernelBackend } from './kernel/runtime-client.js'
import {
  actsAfterClass,
  allows,
  allowsAgent,
  allowsRun,
  allowsStructure,
  bookRefusal,
  CLASS_IS_OVER,
  mayEditCell,
  mayLeadCouncil,
  mayRunCell,
  mayRunCouncil,
  mayWriteCouncil,
  rulesForBook,
  runQueueCap,
  type Asker,
  type RoomRules,
  type Who,
} from '@shared/rules'
import {
  db,
  forgetRules,
  finishedAt,
  getParticipant,
  getRules,
  isFinished,
  moveNotesTo,
  notesOf,
  setFinished,
  setNote,
  storedRules,
} from './db.js'
import {
  answerInput,
  briefIn,
  clearOutputs,
  completeIn,
  formatSession,
  inspectIn,
  kernelNote,
  interruptSession,
  onWorkspaceChanged,
  requestRun,
  restartSession,
  sweepOrphanRuns,
  syncBookKernels,
  cancelRun,
  cancelCouncilRun,
  purgeCouncilRunsOf,
  councilQueuePosition,
  councilQueuePositions,
  kernelWorkOf,
  onKernelQueueChanged,
  queueIsOnly,
  requestCouncilRun,
  retimeCouncilRun,
  startedTheRunningCell,
} from './kernel/index.js'
import {
  attemptFor,
  attemptOf,
  attemptsOf,
  boardFor,
  cellsOfParticipant,
  cellsWithAttempts,
  countFor,
  countsFor,
  discardCouncil,
  mineFor,
  nextRunAtFor,
  purgeAttempts,
  recordRun,
  rememberSeed,
  saveDraft,
  setHint,
  setMark,
  setReply,
  seedOf,
  setShown,
  shownFor,
  submitAttempt,
  withdrawAttempt,
  requestAttemptRun,
  resolveRunRequest,
  clearRunRequests,
  resetCouncilCache,
} from './council.js'
import {
  clearTerminal,
  closeTerminal,
  interruptTerminal,
  onTerminalPhase,
  openTerminal,
  runCommand,
  terminalPhase,
  typedRunningCommand,
} from './kernel/terminal.js'
import {
  copyFile,
  deleteFile,
  forgetTree,
  freeCopyName,
  listFiles,
  listTree,
  makeDir,
  makeFile,
  movePath,
  sessionBytes,
  statPath,
  treeDelta,
  type FileTree,
  type TreeResult,
} from './workspace.js'
import {
  MAX_DEPTH,
  MAX_PATH,
  baseOf,
  isInside,
  kindOf,
  normalizePath,
  parentOf,
  runnerFor,
  whySegmentRefused,
} from '@shared/paths'
import { inkFullSays, LASER_EVERY_MS, MAX_NOTE_CHARS, type InkStroke } from '@shared/lecture'
import { flushFile, forgetFile, onFileSaved } from './collab/files.js'
import {
  addInk,
  clearInk,
  eraseInk,
  forgetLecture,
  handOver,
  inkPageOf,
  inkRevision,
  inkedPagesOf,
  isPresenter,
  lectureOf,
  moveLecture,
  setBlank,
  startLecture,
  stopLecture,
  turnTo,
  undoInk,
} from './lecture.js'
import {
  createBook,
  dropBook,
  forgetMissingBooks,
  isBookFile,
  moveBook,
  onBookRulesChanged,
  onBooksWritten,
  openBook,
  ownsBookAt,
  projectBooks,
  type BookAuthor,
} from './collab/books.js'
import { config } from './config.js'
import { stopAll, undoTurn } from './ai/agent.js'
import { onCouncilOracle } from './ai/council.js'
import { evicted } from './bans.js'
import { seldom } from './log.js'
import { appendActivity } from './activity.js'
import { recordQuestion } from './admin/usage.js'
import { holdOracleHint, oracleCapacity, oracleDoor } from './ai/door.js'
import { askCouncilHint, runFailed } from './ai/hint.js'

/** Same reason as the collab socket: stay under the usual 30s idle timeout. */
const PING_INTERVAL_MS = 25_000
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2
/**
 * Control socket frames are small by design — except one.
 *
 * A council attempt snapshot (`council:draft`) carries the code whole, and
 * eight kilobytes are not enough for it: a hundred lines with comments in
 * Russian are already two bytes per letter. The frame ceiling is raised to
 * what fits `MAX_ATTEMPT_CHARS` in Cyrillic together with the wrapping;
 * everything else is still many times smaller.
 */
const MAX_FRAME_BYTES = 32 * 1024
/*
 * The ceiling of the attempt itself (`MAX_ATTEMPT_CHARS`) lies in
 * shared/notebook.ts, and that is not a move for tidiness: a client that does
 * not know the number sends a snapshot on every pause in typing and gets a
 * refusal on every one. A refusal out loud, as with a note: code silently cut
 * off looks whole on screen.
 */
/** An answer to a student — a paragraph, like a page note. */
const MAX_REPLY_CHARS = 3000
/** A shell command, not a shell script: anything longer is a paste accident. */
const MAX_COMMAND_BYTES = 4096
/*
 * The ceiling on a page's speaker notes (`MAX_NOTE_CHARS`) lies in
 * shared/lecture.ts next to the ink ceilings — for the same reason they lie
 * there: the field in the console must cut exactly where the server cuts,
 * otherwise what was typed disappears silently. The copy here once already
 * drifted from reality — the comment derived three thousand characters from
 * an 8192-byte frame, although `MAX_FRAME_BYTES` above had long been 32 KB.
 */

/**
 * The origin of a write the server makes in its own name.
 *
 * The same string as in collab/index.ts, and that is no coincidence: document
 * observers skip the server's own writes by it. The server-side cell fields
 * (`state`, `outputs`, and now `open`) are written the same way — they have
 * no author, because nobody typed them.
 */
const ORIGIN = 'server'

interface Room {
  sockets: Set<WebSocket>
  /**
   * Sockets per participant and the teachers' sockets — next to the common
   * set.
   *
   * `tell` and `toTeachers` address one person and the console, and they used
   * to find the recipient by walking all the room's sockets. With twenty
   * nobody noticed; with five hundred `tellQueued` (per person on every queue
   * shift) is a quarter of a million iterations per click, and the pile on
   * every typing snapshot walks the same five hundred three times a second.
   * The sets are edited exactly where `sockets` is.
   */
  byParticipant: Map<string, Set<WebSocket>>
  hosts: Set<WebSocket>
  unwatch: () => void
  /**
   * One ping tick per room, not per socket.
   *
   * A ping is two counters and `ws.ping()`; on one socket the timer around it
   * is invisible. With five hundred it is five hundred timers in node's heap,
   * each with its own closure, and they wake up at random across the whole
   * minute — that is, the event loop is woken five hundred times where one
   * pass over the set that is lying right there would do. The deadlines are
   * the same: PING_INTERVAL_MS and MAX_MISSED_PONGS did not change, only the
   * phase moved — a room's sockets are pinged together.
   */
  pingTimer: NodeJS.Timeout | null
}

/** How many pings in a row this socket has missed. Its own `pong` resets it to zero. */
const missedPongs = new WeakMap<WebSocket, number>()

/**
 * Walk the room and ask every socket whether it is alive.
 *
 * One silent for the second time is a closed laptop lid, not a slow network:
 * such a socket is dropped, and the tab, if there is one after all, comes
 * back by itself.
 */
function pingRoom(sessionId: string): void {
  const room = rooms.get(sessionId)
  if (!room) return
  for (const ws of room.sockets) {
    const missed = missedPongs.get(ws) ?? 0
    if (missed >= MAX_MISSED_PONGS) {
      try {
        ws.terminate()
      } catch {
        /* already dead */
      }
      continue
    }
    missedPongs.set(ws, missed + 1)
    try {
      ws.ping()
    } catch {
      try {
        ws.terminate()
      } catch {
        /* already dead */
      }
    }
  }
}

const rooms = new Map<string, Room>()
onInstanceLanguage((language) => {
  for (const sessionId of rooms.keys()) broadcast(sessionId, {t:'instance:language',language})
})

/* ----------------------------------------------------------------- send */

/**
 * A frame as a string — and not a single exception escaping.
 *
 * `JSON.stringify` is not infinite: a string over ~512 MB is a RangeError
 * "Invalid string length", and it is thrown BEFORE any sending. While frame
 * assembly stood bare, such a throw from a timer (the council pile, the file
 * list) went to `uncaughtException`, and that takes down the process with
 * every room of the instance. One frame is not worth a seminar — least of all
 * someone else's: we write down the reason and stay silent on this socket.
 */
function frameOf(message: ControlServerMessage): string | null {
  try {
    return JSON.stringify(message)
  } catch (err) {
    console.error(`[control] frame ${message.t} could not be built:`, reason(err, 'unknown error'))
    return null
  }
}

/**
 * How important a frame is — and what to do with it when the socket cannot
 * keep up.
 *
 * `stream` is what makes sense right now only: a pointer position and a piece
 * of a stroke. A socket that has fallen behind does not need them at all:
 * while its queue is being cleared, the presenter's hand is already
 * elsewhere, and the next frame carries the whole position anyway.
 * `essential` is everything else: the welcome batch, the rules, the end of
 * class, a run result, a refusal. Such a frame will not be repeated, and
 * losing it means leaving a person with a room that does not exist.
 */
type FrameClass = 'essential' | 'stream'

/**
 * Frames that may be left undelivered to a socket that has fallen behind. A
 * list rather than a flag at every sending site: "may be lost" is a property
 * of the frame itself, and it should be decided once.
 */
/*
 * Answers to completion and help — here too.
 *
 * A hint makes sense exactly at the second it was asked for. A socket that is
 * a megabyte behind does not need it at all: while its queue is being
 * cleared, the person has finished the word themselves, and the next letter
 * will ask again. Delivering it would mean piling up in process memory lists
 * of names nobody will read — exactly the trouble this class of frames
 * exists for.
 */
/*
 * And the answer about where a name is defined goes here too, though its
 * argument is different.
 *
 * It arrives not on a letter but on a DELIBERATE click, and losing it would
 * be a pity — if there were anything to lose. But this answer has a shelf
 * life, and it is written down on the other side: three seconds
 * (session.svelte.ts · ASK_TIMEOUT_MS), after which the promise is closed
 * empty and a late frame is discarded as an unknown number. A socket that is
 * a megabyte behind will certainly deliver it later — that is, the frame is
 * not "lost", it was already worth nothing. And if it did arrive
 * in-time-but-late, it would drag the screen away from where the person is
 * working by then: that is exactly why `define` is not delivered after a
 * disconnect either (session.svelte.ts · DISCARDED_OFFLINE).
 */
const STREAM_FRAMES = new Set<ControlServerMessage['t']>([
  'laser',
  'ink:add',
  'complete:reply',
  'inspect:reply',
  'define:reply',
])

function frameClass(message: ControlServerMessage): FrameClass {
  return STREAM_FRAMES.has(message.t) ? 'stream' : 'essential'
}

function send(
  ws: WebSocket,
  message: ControlServerMessage,
  kind: FrameClass = frameClass(message),
): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const frame = frameOf(message)
  if (frame === null) return
  sendFrame(ws, frame, kind)
}

/**
 * An already assembled frame — into one socket.
 *
 * A `Buffer`, not only a string, and this is not about convenience.
 * `ws.send(string)` encodes it into UTF-8 anew every time — about a
 * millisecond per megabyte (measured) — and frames that go to EVERYONE
 * identical (the file tree, the lecture ink) are sent to five hundred sockets
 * in a row: half a megabyte of ink turned into half a second of event loop
 * blocking exactly as the hall came back. Whoever assembles such a frame once
 * per room also encodes it once per room; `binary: false` keeps the frame
 * textual, the way the browser expects it.
 *
 * And two backpressure lines — the same as the shared document's
 * (collab/index.ts · AWARENESS_STALL_BYTES, HOPELESS_BYTES), and for the same
 * reason. The wire is not infinite: a laptop with its lid closed, a phone in
 * a lift, a mobile network at the edge of the lecture hall receive more
 * slowly than the room talks. While only a `readyState` check stood here, the
 * server piled INTO PROCESS MEMORY everything that did not fit into the wire:
 * the file tree, the council pile (up to four megabytes) and the ink thirty
 * times a second — a copy for every socket that had fallen behind. One
 * forgotten tab ate gigabytes and took the instance down with everyone
 * else's rooms.
 */
const STREAM_STALL_BYTES = 1024 * 1024
const HOPELESS_BYTES = 8 * 1024 * 1024

function sendFrame(ws: WebSocket, frame: string | Buffer, kind: FrameClass = 'essential'): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const waiting = ws.bufferedAmount
  if (waiting > HOPELESS_BYTES) {
    if (seldom('control-backpressure')) {
      console.warn(
        `[control] socket fell ${Math.round(waiting / 1024)} KB behind — closed, ` +
          'the tab will come back by itself and rebuild the room',
      )
    }
    try {
      ws.terminate()
    } catch {
      /* already dead */
    }
    return
  }
  // Behind, but not hopelessly: it will not see a pointer position or a
  // piece of a stroke, but it will see everything that happens once.
  if (kind === 'stream' && waiting > STREAM_STALL_BYTES) return
  try {
    ws.send(frame, { binary: false })
  } catch {
    /* the socket died between the check and the write */
  }
}

export function broadcast(
  sessionId: string,
  message: ControlServerMessage,
  kind: FrameClass = frameClass(message),
): void {
  const room = rooms.get(sessionId)
  if (!room) return
  /*
   * Held-back ink goes ahead of everything else.
   *
   * Stroke pieces are glued together per tick (`inkTo`), and everything that
   * says something else about the ink must arrive AFTER them: "erase the
   * stroke", with points for it lying in the queue, would erase it before
   * they were written, and "here is the whole page" would get them twice.
   * Here, not in each of the dozen places where this is said: forgetting one
   * of them means drawing for the hall something other than what was drawn,
   * and finding out about it from the teacher.
   */
  if (message.t !== 'ink:add') flushInk(sessionId)
  const text = frameOf(message)
  if (text === null) return
  /*
   * As bytes, not a string, and exactly once per room.
   *
   * `ws.send(string)` encodes it into UTF-8 anew for EVERY socket. A pen frame
   * in a lecture is 89.6 KB per room of five hundred people (measured), thirty
   * times a second: that is 4.9 MB/s of encoding alone, which can be done
   * once. The tree and the ink have long done this themselves (`filesFrame`,
   * `inkFrame`) — here the same is done for all the other broadcasts.
   */
  const frame = Buffer.from(text, 'utf8')
  for (const ws of room.sockets) sendFrame(ws, frame, kind)
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
  /*
   * The board and the lecture go before any check for sockets, and this is
   * not order for its own sake: `rooms` is cleaned up as soon as the last
   * person leaves, while the board and the ink deliberately survive their
   * leaving. The teacher closed the laptop without pressing "End", and in the
   * evening deleted the seminar — there is nothing below to come back to, and
   * two hundred scribbled pages would stay in process memory until a restart.
   */
  boards.delete(sessionId)
  forgetLecture(sessionId)
  // And the council attempts: they are in the database, not in the document,
  // and tearing down the document will not touch them — and there is no
  // reason for them to lie under the key of a torn-down room.
  discardCouncil(sessionId)
  forgetBoards(sessionId)
  forgetQueue(sessionId)
  treeSent.delete(sessionId)
  inkFrames.delete(sessionId)
  laserHeld.delete(sessionId)
  inkHeld.delete(sessionId)
  // And all open coalescing windows: their tails would look for a room that
  // is gone.
  forgetTicks(sessionId)
  const room = rooms.get(sessionId)
  if (!room) return
  rooms.delete(sessionId)
  room.unwatch()
  if (room.pingTimer) clearInterval(room.pingTimer)
  room.pingTimer = null
  for (const ws of room.sockets) {
    try {
      ws.close(1001, tr("server.thisSeminarWasDeleted.daaaad"))
    } catch {
      /* already gone */
    }
  }
  room.sockets.clear()
}

/**
 * Put a banned person out — now, not on their next visit.
 *
 * The check at the handshake closes the door to whoever is knocking; the one
 * banned is usually someone already sitting inside, and without this line
 * they calmly keep writing in the notebook until the end of the class period
 * — their sockets opened before the ban and know nothing about it.
 *
 * The frame goes BEFORE the close. Otherwise the tab sees a dropped
 * connection and silently goes off to reconnect, showing "no connection"
 * where the reason and the term should be shown; after the frame it knows
 * what happened and does not knock back.
 *
 * Targeted, not `closeControlRoom`: the room carries on with the class. And
 * all three wires at once — the control one carries the clicks, the shared
 * document carries the text, the file one carries the `.py` open in the
 * editor — closing one while leaving the others means throwing someone out
 * halfway: the banned person keeps writing into the room's shared file until
 * they reload the page themselves.
 *
 * The third wire is closed through the ban event (bans.ts · onEviction).
 * Calling collab/files.ts directly from here would be possible — this module
 * imports it anyway — but then the list of wires would live here, in the
 * clicks module, and every next wire would have to be remembered. The
 * announcement lives where the notion "this person may no longer be here"
 * itself lives, and whoever holds a wire subscribes to it on their side.
 */
export function evictBanned(sessionId: string, participantId: string, until: number): void {
  tell(sessionId, participantId, { t: 'banned', until })
  const room = rooms.get(sessionId)
  if (room) {
    // A copy of the set: the close handler edits the same one.
    for (const ws of [...(room.byParticipant.get(participantId) ?? [])]) {
      try {
        ws.close(1008, tr("server.bannedFromThisSeminar.234bce"))
      } catch {
        /* already gone */
      }
    }
  }
  dropParticipant(sessionId, participantId)
  evicted(sessionId, participantId)
}

/**
 * The last assembled tree frame — one per room, not per socket.
 *
 * Walking the folder costs a readdir and an lstat per entry (up to two
 * thousand), and the frame is up to a hundred kilobytes of string. For one
 * connection this is unnoticeable; after a server restart five hundred tabs
 * come back within a second or two, and each got ITS OWN walk and ITS OWN
 * assembly of the same list — seconds of loop blocking exactly where everyone
 * is waiting for the comeback.
 *
 * The cache is short-lived and does not replace the broadcast: any change in
 * the tree goes through `broadcastFiles` anyway, which computes the list anew
 * and puts a fresh one here. The window is only needed for a batch of
 * connections in a row; past it the walk is done honestly.
 */
const TREE_FRESH_MS = 1000

/**
 * The tree the room is holding — one per room, and numbered.
 *
 * Two memories that used to stand apart met here: a frame for a batch of
 * connections and the receipt "this list has already been sent". They can no
 * longer be kept apart, because a number appeared: a change travels as a
 * DELTA (`files:delta`), and a delta only applies to the list it was computed
 * from. So the record has to be one — the list, its number and the assembled
 * frame.
 *
 * The number grows by one on every change of the contents. A tab that does
 * not hold the delta's `from` does not try to glue it on, but asks for the
 * whole tree (`files:ask`) — this cures both a newcomer who recomputed the
 * tree for an empty room and any divergence we do not know about.
 *
 * The broadcast tick is armed by everything that TOUCHES the folder: the
 * editor's autosave, the notebook projection, a write from a cell. The tree
 * is most often the same — the file's text changed, the list of files did
 * not. A walk that matched therefore does not move the number and does not go
 * out at all.
 */
interface TreeRecord {
  at: number
  rev: number
  files: FileEntry[]
  truncated: boolean
  frame: Buffer
}

const treeSent = new Map<string, TreeRecord>()

/** The same contents, the same number next to the name — nothing to say. */
function sameTree(before: readonly FileEntry[], after: readonly FileEntry[]): boolean {
  if (before.length !== after.length) return false
  for (let i = 0; i < before.length; i++) {
    const was = before[i]
    const now = after[i]
    if (
      was.path !== now.path ||
      was.name !== now.name ||
      was.dir !== now.dir ||
      was.size !== now.size ||
      was.modifiedAt !== now.modifiedAt
    )
      return false
  }
  return true
}

/**
 * The room's tree with its number — from memory if it is younger than
 * `reuseMs`, otherwise by a walk.
 *
 * Walking the folder costs a readdir and an lstat per entry (up to two
 * thousand), and the frame is up to a hundred kilobytes of string. For one
 * connection this is unnoticeable; after a server restart five hundred tabs
 * come back within a second or two, and each got ITS OWN walk and ITS OWN
 * assembly of the same list — seconds of loop blocking exactly where everyone
 * is waiting for the comeback. So the welcome batch takes a record younger
 * than the window as is, while the broadcast (`reuseMs = 0`) computes
 * honestly: it is called precisely because the tree has changed.
 *
 * `ready` is a tree the caller has already built (an upload builds it for
 * the response). Walking the folder is no cheaper than counting bytes, and
 * there is no reason to do it twice per upload.
 */
function treeRecord(sessionId: string, ready?: FileTree, reuseMs = 0): TreeRecord | null {
  const known = treeSent.get(sessionId)
  if (!ready && known && Date.now() - known.at < reuseMs) return known
  /*
   * The tree travels together with the truncation flag: a list that hit the
   * walk ceiling is not "the room has this many files". The panel says so out
   * loud, otherwise a person searches with their eyes for a file that is
   * lying on disk. The flag is always sent, and `false` in it is as much an
   * answer as `true`: otherwise a room that once saw truncation would be left
   * with the warning after the folder was cleaned up.
   */
  let tree: FileTree
  if (ready) tree = ready
  else {
    try {
      tree = listTree(sessionId)
    } catch {
      return null
    }
  }
  if (known && known.truncated === tree.truncated && sameTree(known.files, tree.files)) {
    known.at = Date.now()
    return known
  }
  const rev = (known?.rev ?? 0) + 1
  const text = frameOf({ t: 'files', files: tree.files, truncated: tree.truncated, rev })
  if (text === null) return null
  // As bytes, not a string: this frame goes to all of the room's sockets in a
  // row, and encoding it for each of them is wasted work (see sendFrame).
  const record: TreeRecord = {
    at: Date.now(),
    rev,
    files: tree.files,
    truncated: tree.truncated,
    frame: Buffer.from(text, 'utf8'),
  }
  treeSent.set(sessionId, record)
  return record
}

/**
 * The tree frame for someone who has just come in — shared by the whole
 * comeback batch.
 */
function filesFrame(sessionId: string): Buffer | null {
  return treeRecord(sessionId, undefined, TREE_FRESH_MS)?.frame ?? null
}

export function broadcastFiles(sessionId: string, tree?: FileTree): void {
  /*
   * The walk's short memory is forgotten BEFORE the empty-room check.
   *
   * A broadcast always uses a fresh walk: it is called precisely because the
   * tree has changed, and handing it yesterday's list would mean saying
   * nothing. The walk's own memory lives in workspace.ts (`forgetTree`), and
   * it has to be reset from here: the folder is written to bypassing
   * workspace.ts too (an upload with its own streams, the kernel from inside
   * the container), so the walk will not forget its memory by itself.
   *
   * Above the return — because a room without a single socket does not mean
   * "nothing changed". This is exactly the case when files are put in before
   * anyone enters: there is nobody to broadcast to, while the same request
   * returns `listTree` in its response right after, and with the old memory
   * it returned a tree WITHOUT the file just put there.
   */
  forgetTree(sessionId)
  const room = rooms.get(sessionId)
  if (!room || room.sockets.size === 0) return
  const before = treeSent.get(sessionId)
  const record = treeRecord(sessionId, tree)
  if (record === null) return
  /*
   * And only if it REALLY changed. The same list a second time tells the
   * panel nothing — while costing five hundred sends and five hundred
   * separate compressions. For someone who has just connected the list
   * arrives by its own path (the welcome batch), so silence here does not
   * concern them.
   */
  if (before && before.rev === record.rev) return
  const frame = deltaFrame(before, record) ?? record.frame
  for (const ws of room.sockets) sendFrame(ws, frame)
}

/**
 * A change frame — or `null` if it is cheaper and more honest to send the
 * whole list.
 *
 * The whole list is sent in three cases: the room held nothing anyway, the
 * tree is truncated (in it "the entry is absent" and "did not fit" are
 * indistinguishable, and that difference costs a notebook deleted for
 * everyone), and a change bigger than the list itself — which happens on
 * `pip install`, when the whole folder changes at once.
 */
function deltaFrame(before: TreeRecord | undefined, now: TreeRecord): Buffer | null {
  if (!before || before.truncated || now.truncated) return null
  const delta = treeDelta(before.files, now.files)
  const text = frameOf({ t: 'files:delta', from: before.rev, rev: now.rev, ...delta })
  if (text === null) return null
  const frame = Buffer.from(text, 'utf8')
  return frame.length < now.frame.length ? frame : null
}

/* ------------------------------------------------------ coalescing tick */

/**
 * One window for all the "everyone, on every event" broadcasts.
 *
 * The file list, the queue numbers and the pointer come in bursts — from
 * autosave, from every start and end of kernel work, from every hand
 * movement — and leave as a `ws.send` loop over all of the room's sockets.
 * Each of the three had its own timer with the same body: a map of pending
 * ones, `unref`, catching a throw. Three copies of one rule diverge on the
 * first edit, so there is one window here, and all that differs between them
 * is the window length and what goes out at the end.
 *
 * The first call WAITS for the window rather than going through at once: the
 * file list and the queue numbers only gain from this (changes come in a
 * burst, and the first of them is no more important than the last). Where
 * waiting is not allowed, the leading frame is sent by hand before `onTick`
 * — that is how the pointer below does it.
 *
 * The key is "what" and the room: windows of different broadcasts do not get
 * in each other's way, and cleaning up a room removes all its windows at once
 * (`forgetTicks`).
 */
const ticks = new Map<string, NodeJS.Timeout>()

function tickKey(sessionId: string, what: string): string {
  return `${what}\n${sessionId}`
}

function onTick(sessionId: string, what: string, everyMs: number, run: () => void): void {
  const key = tickKey(sessionId, what)
  if (ticks.has(key)) return
  const timer = setTimeout(() => {
    ticks.delete(key)
    /*
     * Under a catch — like everything a timer does: a throw from here has
     * nobody to catch it, it goes to `uncaughtException` and takes the process
     * down with every room of the instance. None of these frames is worth
     * someone else's seminar.
     */
    try {
      run()
    } catch (err) {
      console.error(`[control ${sessionId}] tick "${what}" did not go out:`, reason(err, 'unknown error'))
    }
  }, everyMs)
  timer.unref?.()
  ticks.set(key, timer)
}

/** The window is still open: the change will ride its tail, no need to send now. */
function ticking(sessionId: string, what: string): boolean {
  return ticks.has(tickKey(sessionId, what))
}

/** Remove all of the room's windows. The room has emptied or no longer exists. */
function forgetTicks(sessionId: string): void {
  const tail = `\n${sessionId}`
  for (const [key, timer] of ticks) {
    if (!key.endsWith(tail)) continue
    clearTimeout(timer)
    ticks.delete(key)
  }
}

/**
 * How long to wait before recomputing the tree on its own.
 *
 * One list costs a walk of the whole folder (a readdir and an lstat per
 * entry) and a frame to every socket. Twenty people editing a file each save
 * every seven hundred milliseconds NOT TOGETHER — that is up to thirty walks
 * a second and a files panel redrawing for the whole class period.
 *
 * The delay is only visible to someone waiting for their own click — so
 * direct edits of the tree (created, removed, renamed, uploaded) are
 * broadcast at once, and only what happens by itself is postponed: autosave,
 * the notebook projection, a write from a cell.
 */
const FILES_EVERY_MS = 400

function scheduleFiles(sessionId: string): void {
  onTick(sessionId, 'file list', FILES_EVERY_MS, () => broadcastFiles(sessionId))
}

/* ----------------------------------------------------- shared screen */

/**
 * The document the room is watching together.
 *
 * In process memory, next to the room, not in the shared document and not in
 * presence. Presence disappears along with the tab — the teacher's closed
 * laptop would take the material away from everyone. The shared Yjs document
 * writes every write into the version feed, and "opened a PDF" would become a
 * history row, and Ctrl+Z in a cell a way to close it for the whole room.
 *
 * The price is named out loud: a server restart closes the board for
 * everyone. The run queue goes the same way, and it is the same promise — the
 * room survives a dropped connection, but not a process restart.
 */
const boards = new Map<string, string>()

/** What the room is watching now. */
export function boardOf(sessionId: string): string | null {
  return boards.get(sessionId) ?? null
}

/** Where the pointer got to within the coalescing window; its last position goes out. */
type LaserAt = { page: number; x: number; y: number; shape: 'dot' | 'line' }
const laserHeld = new Map<string, LaserAt>()

/**
 * Turn off the pointer for the whole room.
 *
 * The pointer is not stored anywhere: where it was a second ago is not a fact
 * about the lecture but the position of a hand, and it is held only by the
 * frames coming. So every time the hand disappears without saying "off" —
 * the lecture ended, the console was handed over, the tablet unloaded from
 * memory — it has to be turned off on the hand's behalf. Otherwise a red spot
 * hangs on the slide until the end of the lecture and points to where the
 * presenter was a minute ago. A timeout does not cure this: a still pointer
 * sends no frames at all, and a timeout would turn off a normal showing.
 */
function laserOff(sessionId: string): void {
  // The held point goes ahead of the turning off: otherwise the window's tail
  // would light the spot back up sixty milliseconds after the hand was
  // removed.
  laserHeld.delete(sessionId)
  broadcast(sessionId, { t: 'laser', at: null })
}

/**
 * The pointer — to the room, but no more often than the tick: within a
 * window the last point wins.
 *
 * The pointer tick is shared, from `@shared/lecture`: the console cuts frames
 * with the same window.
 *
 * A pointer frame is not an event but the position of a hand, and nobody
 * needs the intermediate positions: the hall moves it with a spring between
 * sparse samples anyway. The server, however, paid a full round for each —
 * `JSON.stringify` and a `ws.send` loop over all of the room's sockets; with
 * five hundred listeners the presenter's hand cost tens of thousands of sends
 * a second. The console has already lowered its tick, but there is no reason
 * to take the word of a tab that may be old or someone else's.
 *
 * The first frame goes out AT ONCE, before the window: the pointer must
 * appear where it was pointed, not one tick later.
 */
function laserTo(sessionId: string, at: LaserAt): void {
  if (ticking(sessionId, 'pointer')) {
    laserHeld.set(sessionId, at)
    return
  }
  broadcast(sessionId, { t: 'laser', at })
  onTick(sessionId, 'pointer', LASER_EVERY_MS, () => {
    const held = laserHeld.get(sessionId)
    if (!held) return
    laserHeld.delete(sessionId)
    // The hand is still moving — send and open the next window.
    laserTo(sessionId, held)
  })
}

/* ------------------------------------------------------------------- ink */

/**
 * The ink coalescing tick. A little less than three screen frames — the hand
 * does not notice.
 *
 * The pen sends points in batches as it draws — twenty to thirty stroke
 * pieces a second — and each piece went out as its own frame to the whole
 * room. With five hundred listeners that is 89.6 KB per frame and 4.9 MB/s
 * (measured) for ONE line drawn: forty-eight bytes of useful points, the rest
 * is frame wrapping multiplied by the hall.
 *
 * Pieces of one stroke are folded into one frame, and that is exactly what
 * the hall would have seen anyway: the tab's `ink:add` parsing appends points
 * to the stroke with the same name (session.svelte.ts), and a glued batch is
 * the same points, in the same order, as one entry.
 *
 * The first frame goes out AT ONCE, before the window, as with the pointer:
 * the line must appear where it was started, not one tick later.
 */
const INK_EVERY_MS = 45

/** Stroke pieces held back for a tick — in order of arrival. */
const inkHeld = new Map<string, InkStroke[]>()

function inkTo(sessionId: string, stroke: InkStroke): void {
  if (ticking(sessionId, 'ink')) {
    const held = inkHeld.get(sessionId) ?? []
    const last = held.at(-1)
    /*
     * Only CONSECUTIVE pieces of one stroke: between two pen pieces there may
     * be a stroke of a second teacher from a tablet, and swapping them would
     * mean drawing for the hall something other than what was drawn.
     *
     * A copy of the points, not the room's memory: `addInk` for a new stroke
     * returns the very array that lies in the room, and appending the glued
     * batch to it would mean sending the same points out twice.
     */
    if (last && last.id === stroke.id && last.page === stroke.page) {
      last.points = [...last.points, ...stroke.points]
    } else {
      held.push({ ...stroke, points: [...stroke.points] })
    }
    inkHeld.set(sessionId, held)
    return
  }
  broadcast(sessionId, { t: 'ink:add', stroke })
  openInkWindow(sessionId)
}

function openInkWindow(sessionId: string): void {
  onTick(sessionId, 'ink', INK_EVERY_MS, () => {
    // The hand is still moving — send what was held and open the next window.
    if (flushInk(sessionId)) openInkWindow(sessionId)
  })
}

/**
 * Held pieces — into the wire now. Returns whether there was anything to
 * send.
 *
 * Called not only by the window's tail: everything that says SOMETHING ELSE
 * about the ink — "erase the stroke", "the page is clean", "here is the whole
 * page" — must go out AFTER what was held, otherwise the hall gets points
 * appended to a stroke it has already erased, or a page to which what it
 * already has gets appended right away. The place for this rule is
 * `broadcast` below: every broadcast to the room is visible there, not only
 * the ones nobody forgot about.
 */
function flushInk(sessionId: string): boolean {
  const held = inkHeld.get(sessionId)
  if (!held || held.length === 0) return false
  inkHeld.delete(sessionId)
  for (const stroke of held) broadcast(sessionId, { t: 'ink:add', stroke })
  return true
}

function setBoard(sessionId: string, name: string | null): void {
  if (name === null) boards.delete(sessionId)
  else boards.set(sessionId, name)
  broadcast(sessionId, { t: 'board', open: name })
  /*
   * A lecture runs over the document on the shared screen, and removing the
   * document means ending the lecture. Otherwise the room gets a console
   * flipping through something nobody sees, and ink on a file closed for
   * everyone.
   */
  const lecture = lectureOf(sessionId)
  if (lecture && lecture.file !== name) {
    stopLecture(sessionId)
    broadcast(sessionId, { t: 'lecture', state: null })
    laserOff(sessionId)
  }
}

/**
 * The file is gone or was rewritten — the board has to be closed.
 *
 * The teacher may delete a file, and any cell may rewrite it: `df.to_csv`
 * goes to the same folder. A reader that keeps showing a document that does
 * not exist is an empty area with no explanation.
 *
 * Exported for the sake of the second deletion door: a file is removed both
 * by the socket (`tree:remove` below) and by REST (routes/files.ts), and both
 * must turn off the board — otherwise a deleted document stays on the shared
 * screen of the whole room until a reload.
 */
export function forgetMissingBoard(sessionId: string): void {
  const open = boards.get(sessionId)
  if (!open) return
  /*
   * One `lstat` on the path itself, not a search in the tree: the walk has a
   * ceiling (see `truncated` in workspace.ts), and a document that did not
   * fit into the list has not gone anywhere. With a truncated list the board
   * would go dark in the middle of a lecture — exactly where a student
   * unpacked a two-thousand-file dataset.
   */
  if (statPath(sessionId, open)?.dir === false) return
  setBoard(sessionId, null)
}

/*
 * A file landed on disk — the room learns its new size and time.
 *
 * The editor saves itself every few seconds, and without this line the files
 * panel would show the size as it was when the tab was opened: "0 B" for a
 * file that already has forty lines.
 */
onFileSaved((sessionId, _path, origin) => {
  // Explicit agent writes (including new, unopened files) are complete now.
  // Keep editor autosave coalesced, but don't delay a reported tool result.
  if (origin === 'server') broadcastFiles(sessionId)
  else scheduleFiles(sessionId)
})

/*
 * A notebook landed on disk — the room learns about the file.
 *
 * Without this the notebook's file would appear in the tree only after
 * somebody's upload: the projection writes itself, and there is nobody to
 * tell about it.
 */
onBooksWritten((sessionId) => {
  scheduleFiles(sessionId)
  /*
   * A notebook was removed from the room — its kernel is nobody's any more.
   *
   * The same reason as with an access change: the kernel's place has ceased
   * to exist. Keeping it would mean holding a process that writes output into
   * a sheet that is not in the room — and occupying the queue and memory with
   * it until the end of the class period.
   */
  syncBookKernels(sessionId)
})

/*
 * The server changed the rules itself — the room learns about it right away.
 *
 * This happens exactly twice: a student created a notebook for themselves
 * (the server recorded its author) and a notebook was removed from the room
 * (the record about it was cleared). Without the broadcast the teacher's
 * "Access" menu would not see the author's name until the tab was reloaded —
 * that is, exactly at the minute when they are about to make the notebook
 * personal. The CHOSEN rules travel, as in all the other broadcasts: the
 * browser lays the end of class over them itself (web/src/lib/may.ts).
 */
onBookRulesChanged((sessionId) => broadcast(sessionId, { t: 'rules', rules: storedRules(sessionId) }))

/*
 * The kernel queue moved — the consoles need to know.
 *
 * A separate subscription rather than from the document observer: the
 * queue's mirror in the document knows only about CELLS (council attempts do
 * not go into it on purpose), so a whole queue of attempts would move
 * without waking anyone.
 */
onKernelQueueChanged((sessionId) => nudgeKernel(sessionId))

// Registered once, at import: the kernel runtime has no idea who is listening.
onWorkspaceChanged((sessionId) => {
  // The notebook's file may have been removed bypassing the tree — `os.remove`
  // in a cell. A notebook without a file is a tab there is nothing to close
  // with and no reason to show.
  forgetMissingBooks(sessionId)
  forgetMissingBoard(sessionId)
  scheduleFiles(sessionId)
})

/**
 * Whom a control socket belongs to.
 *
 * A refusal of an edit is addressed to one person, not the room: telling all
 * twenty that someone tried to write in someone else's notebook is not what
 * either the author of the edit or the others need.
 */
const owner = new WeakMap<WebSocket, string>()

function tell(sessionId: string, participantId: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  const mine = room?.byParticipant.get(participantId)
  if (!mine || mine.size === 0) return
  const text = frameOf(message)
  if (text === null) return
  const kind = frameClass(message)
  // As bytes — for the same reason as in `broadcast`: one person usually has
  // two sockets (a laptop and a tablet), and there is no reason to encode the
  // council sheet twice.
  const frame = mine.size > 1 ? Buffer.from(text, 'utf8') : text
  for (const ws of mine) sendFrame(ws, frame, kind)
}

/*
 * Which role a socket connected with — the room's `hosts` set, next to
 * `byParticipant` and for the same reason: the recipient is known, yet it
 * used to be found by walking all sockets.
 *
 * Not `getParticipant(...).role`: the table holds the role the person entered
 * the room with, while the socket lives with the EFFECTIVE one (see
 * `effectiveRole` in index.ts). A teacher who came in as a student through a
 * link in the chat and is already signed in to the panel is still a
 * participant in the table — asking it would mean refusing them their own
 * notes at their own lecture.
 */

/**
 * Tell all the room's teachers — and nobody else.
 *
 * The only broadcast in this file whose audience is narrower than the room,
 * and this is not caution but the essence of notes: "ask here who remembers
 * Bayes' formula; if they are silent, derive it on the board" is the
 * teacher's words to themselves, and `broadcast` would hand them out to
 * twenty students along with the answer to a question not yet asked.
 *
 * And not `tell`: a seminar may have two presenters, and an edit made on the
 * first one's laptop must be seen by the second one's tablet. One and the
 * same teacher on two devices goes here too: the tablet signs in with a key
 * as THE SAME participant, so `tell` would cover only them, and not the
 * second teacher.
 */
function toHosts(sessionId: string, file: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  if (!room || room.hosts.size === 0) return
  let frame: Buffer | null = null
  for (const ws of room.hosts) {
    if (ws.readyState !== WebSocket.OPEN) continue
    // And only to those who asked about THIS document.
    if (notesOpen.get(ws) !== file) continue
    if (frame === null) {
      const text = frameOf(message)
      if (text === null) return
      frame = Buffer.from(text, 'utf8')
    }
    sendFrame(ws, frame)
  }
}

/**
 * Which document this socket asked about with notes.
 *
 * The role is not enough. A presenter signs in on the tablet with a key as
 * the same participant, and both of their tabs — the console and the
 * PROJECTION on the lectern laptop — are equally "hosts". The teacher's words
 * to themselves must not reach the machine that stands open in front of the
 * audience, even if it does not put them on screen: a file that is not in its
 * memory cannot be shown by accident.
 */
const notesOpen = new WeakMap<WebSocket, string>()

/* --------------------------------------------------------------- council */

/**
 * The same phrase as the client's (web/src/lib/may.ts · COUNCIL_CLOSED): the
 * server's refusal and the grey button must say the same thing.
 */
const COUNCIL_CLOSED = () => tr("server.councilIsClosedYourTextRemainsIn.b08319")

/**
 * A refusal because of the pause between runs — with the same number that
 * ticks under the button.
 *
 * Seconds are rounded UP, and that is no trifle: a refusal "in 0 s" reads as
 * a breakage, and a click at exactly the millisecond the previous refusal
 * named must go through rather than meet "in 0 s" a second time.
 */
function rerunPauseNote(until: number): string {
  return tr("server.yourNextRunIsInTheTeacher.95d4f8", {
    p0: durationWords(Math.ceil(Math.max(0, until - Date.now()) / 1000)),
  })
}

/**
 * Tell all the room's teachers — and nobody else.
 *
 * Not `toHosts`: that one also filters by the notes document. The council
 * pile is addressed to the teacher's console, whatever file they have open,
 * and a second teacher on a tablet must see the same pile. The projection on
 * the lectern laptop is a host too and will get the pile too — the client
 * decides not to draw it on screen (protocol · council:count for the
 * projector).
 */
function toTeachers(sessionId: string, message: ControlServerMessage): void {
  const room = rooms.get(sessionId)
  if (!room || room.hosts.size === 0) return
  let frame: Buffer | null = null
  for (const ws of room.hosts) {
    if (ws.readyState !== WebSocket.OPEN) continue
    if (frame === null) {
      const text = frameOf(message)
      // The frame could not be built (the pile outgrew the string limit) — we
      // stay silent to all consoles alike, not to half of them.
      if (text === null) return
      frame = Buffer.from(text, 'utf8')
    }
    sendFrame(ws, frame)
  }
}

/**
 * Whether the room has at least one teacher console — otherwise there is no
 * point assembling the pile.
 */
function teachersOnline(sessionId: string): boolean {
  const room = rooms.get(sessionId)
  if (!room) return false
  for (const ws of room.hosts) if (ws.readyState === WebSocket.OPEN) return true
  return false
}

/**
 * A council cell in one read: the lock and the knobs.
 *
 * By name rather than a pair of fields on the spot: both are read together —
 * a student's sheet asks the same cell both "is the council running" and
 * "what pause is set here" — and the cell is searched for across all of the
 * room's notebooks.
 */
interface CouncilCell {
  lock: CellLock
  settings: CouncilSettings
}

/**
 * The position of the lock and the knobs — from the document, where the
 * server wrote them.
 *
 * No cell — the lock is closed: an attempt cannot be accepted into it, while
 * the pile for it is still assembled (attempts remain for viewing), only with
 * a closed lock.
 */
function councilCellOf(sessionId: string, id: string): CouncilCell {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  if (!found) return { lock: 'closed', settings: DEFAULT_COUNCIL }
  return { lock: cellLock(found.cell), settings: councilSettingsOf(found.cell) ?? DEFAULT_COUNCIL }
}

/**
 * The pile — no more often than once per this window per cell, and not
 * whole.
 *
 * Snapshots arrive on every pause in typing from each of hundreds of people.
 * Debouncing holds the frequency: the first change goes out at once (the
 * console must not wait for the window on a single click), the rest within
 * the window merge into one tail frame. The delta holds the size: every
 * attempt in the pile carries its output — up to 64 KB of text and up to 2 MB
 * of images — and a frame with the whole pile because of one letter from one
 * student would weigh tens of megabytes three times a second. So a change
 * carries only those it touched (`council:patch`); the whole pile goes only
 * where something shared changed — the lock, the knobs, the Oracle — or where
 * the console does not have the pile yet (the welcome batch). The window
 * accumulates whom it touched; within a window "everyone" beats any list.
 */
const BOARD_EVERY_MS = 300
/**
 * How much attempt output travels in ONE full pile.
 *
 * An attempt in the pile carries its output — up to 64 KB of text and up to
 * 2 MB of images (kernel/council.ts). While there are thirty attempts,
 * everything fits and nothing changes. With five hundred run with a chart it
 * is tens of megabytes in one frame: `JSON.stringify` synchronously in the
 * event loop, parsing on the iPad — and all of that on every click of the
 * lock and every console reconnect. And above ~512 MB of string
 * `JSON.stringify` throws a RangeError, which used to take the process down.
 *
 * So a frame has a budget: attempts travel with output until it is used up,
 * after that with empty `outputs` and the `outputsOmitted` flag. The console
 * asks for one card's output with `council:attempt` and gets it as a delta.
 * Deltas (`council:patch`) are not subject to the budget: they carry one to a
 * few attempts, and the output in them is what they are sent for.
 *
 * Four megabytes, not some prettier number: that is what a seminar of thirty
 * people weighs where EACH drew a chart — that is, an ordinary class period
 * passes whole and notices nothing, and what is cut is exactly the
 * five-hundred-person cohort, where the frame would otherwise grow to tens of
 * megabytes. When the console learns to ask for output per card, the number
 * can be lowered: the deal will become fair both ways.
 */
const BOARD_OUTPUT_BUDGET = 4 * 1024 * 1024

/**
 * How many characters one attempt's output costs — roughly and without
 * building a string.
 */
function outputWeight(run: CouncilRun): number {
  let total = 0
  for (const output of run.outputs) {
    if (output.kind === 'stream') total += output.text.length
    else if (output.kind === 'error') {
      total += output.ename.length + output.evalue.length
      for (const line of output.traceback) total += line.length
    } else for (const value of Object.values(output.data)) total += value.length
  }
  return total
}

/**
 * The pile within the output budget: whatever did not fit goes without
 * output, but with a flag.
 *
 * The pile is ordered by edit time, and its tail is cut: the fresh part
 * (what the teacher has just run and is looking at) keeps its output.
 */
function withinBudget(board: CouncilBoard): CouncilBoard {
  let left = BOARD_OUTPUT_BUDGET
  let cut = false
  const attempts = board.attempts.map((attempt) => {
    const run = attempt.run
    if (!run || run.outputs.length === 0) return attempt
    const weight = outputWeight(run)
    if (!cut && weight <= left) {
      left -= weight
      return attempt
    }
    cut = true
    // A copy, not an edit in place: `run` here is the very object from the
    // attempts cache, and clearing it would erase the output for the author.
    return { ...attempt, run: { ...run, outputs: [], outputsOmitted: true } }
  })
  return cut ? { ...board, attempts } : board
}

interface BoardPending {
  timer: NodeJS.Timeout | null
  last: number
  /** Whom we touched since the last frame; `'all'` means the whole pile. */
  dirty: Set<string> | 'all'
}
const boardsPending = new Map<string, BoardPending>()

function boardNow(sessionId: string, cellId: string, dirty: Set<string> | 'all'): void {
  if (!teachersOnline(sessionId)) return
  const cell = councilCellOf(sessionId, cellId)
  if (dirty === 'all') {
    toTeachers(sessionId, {
      t: 'council:board',
      cellId,
      board: withinBudget(boardFor(sessionId, cellId, cell)),
    })
    return
  }
  if (dirty.size === 0) return
  const attempts: CouncilAttempt[] = []
  const removed: string[] = []
  for (const participantId of dirty) {
    const attempt = attemptFor(sessionId, cellId, participantId)
    if (attempt) attempts.push(attempt)
    else removed.push(participantId)
  }
  toTeachers(sessionId, {
    t: 'council:patch',
    cellId,
    attempts,
    removed,
    counts: countsFor(sessionId, cellId),
    lock: cell.lock,
    settings: cell.settings,
  })
}

/**
 * The pile — to the host: without `touched` whole, with it only these people
 * (those no longer in the pile the frame will name in `removed`).
 */
function boardOut(sessionId: string, cellId: string, touched?: readonly string[]): void {
  const key = `${sessionId}\n${cellId}`
  let state = boardsPending.get(key)
  if (!state) {
    state = { timer: null, last: 0, dirty: new Set() }
    boardsPending.set(key, state)
  }
  if (touched === undefined) state.dirty = 'all'
  else if (state.dirty !== 'all') for (const id of touched) state.dirty.add(id)
  // The tail frame is already scheduled — it will carry this change too.
  if (state.timer) return
  const since = Date.now() - state.last
  if (since >= BOARD_EVERY_MS) {
    flushBoard(sessionId, cellId, state)
    return
  }
  const pending = state
  state.timer = setTimeout(() => {
    pending.timer = null
    flushBoard(sessionId, cellId, pending)
  }, BOARD_EVERY_MS - since)
  state.timer.unref?.()
}

/**
 * Hand over what accumulated during the window in one frame and start
 * accumulating anew.
 *
 * Under a catch: half the calls here come from `setTimeout`, where there is
 * nobody to catch a throw — it goes to `uncaughtException`, and that takes
 * the process down with every room of the instance. One cell's pile is not
 * worth someone else's seminar, and accumulating anew is needed in any case:
 * otherwise one failed assembly locks the window forever.
 */
function flushBoard(sessionId: string, cellId: string, state: BoardPending): void {
  const dirty = state.dirty
  state.dirty = new Set()
  state.last = Date.now()
  try {
    boardNow(sessionId, cellId, dirty)
  } catch (err) {
    console.error(
      `[control ${sessionId}] pile ${cellId} did not go out:`,
      reason(err, 'unknown error'),
    )
  }
}

/** Send the postponed piles now — for a test that has nothing to wait for. */
export function flushCouncilBoards(sessionId: string): void {
  for (const [key, state] of boardsPending) {
    if (!key.startsWith(`${sessionId}\n`) || !state.timer) continue
    clearTimeout(state.timer)
    state.timer = null
    flushBoard(sessionId, key.slice(sessionId.length + 1), state)
  }
}

function forgetBoards(sessionId: string): void {
  for (const [key, state] of boardsPending) {
    if (!key.startsWith(`${sessionId}\n`)) continue
    if (state.timer) clearTimeout(state.timer)
    boardsPending.delete(key)
  }
}

/**
 * One's own sheet — to one person, on all their sockets.
 *
 * `lock` — if the lock position has already been read outside. There is one
 * lock per cell, while sheets go out to five hundred: reading the same cell
 * for each of them (a search over all of the document's arrays) means five
 * hundred identical walks per click.
 *
 * `position` — the same about the queue number: when sheets are sent out in
 * a batch after a queue shift, the numbers of all those waiting have already
 * been computed in one pass (`councilQueuePositions`), and searching the
 * queue again for each of them is the same square, only from the other side.
 */
function mineOut(
  sessionId: string,
  cellId: string,
  participantId: string,
  cell?: CouncilCell,
  position?: number | null,
): void {
  const message = mineMessage(sessionId, cellId, participantId, cell, position)
  if (message) tell(sessionId, participantId, message)
}

function mineMessage(
  sessionId: string,
  cellId: string,
  participantId: string,
  known?: CouncilCell,
  knownPosition?: number | null,
): ControlServerMessage | null {
  // The lock and the knobs are read in one go: both sides of the sheet — "is
  // the council running" and "how long until the next run" — live on one
  // cell, and a second search for it across all notebooks would cost exactly
  // as much as the first.
  const cell = known ?? councilCellOf(sessionId, cellId)
  const position =
    knownPosition !== undefined
      ? knownPosition
      : councilQueuePosition(sessionId, cellId, participantId)
  const state = mineFor(
    sessionId,
    cellId,
    participantId,
    cell.lock !== 'council',
    // Zero means "being computed now", and `run.state` itself says so.
    position !== null && position > 0 ? position : null,
    cell.settings.rerunPauseSec,
  )
  return state ? { t: 'council:mine', cellId, state } : null
}

/** "N of M submitted" — to the whole room, without texts. */
function countOut(sessionId: string, cellId: string): void {
  const { submitted, total } = countFor(sessionId, cellId)
  broadcast(sessionId, { t: 'council:count', cellId, submitted, total })
}

/**
 * What is on screen for this cell — to the whole room, students included.
 *
 * The only council frame with someone else's code that goes out not only to
 * the teacher, and it is exactly what is on the projector right now: the
 * badge under the cell for everyone is a caption for what the class is
 * looking at anyway (shared/protocol.ts · CouncilShown).
 *
 * Called only where the showing may have changed: shown, removed, the author
 * rewrote the shown text, the teacher's run of it finished, the names knob
 * was clicked, the author was banned. Not on every kernel frame: only a
 * finished run goes into the badge, and intermediate frames change nothing
 * in it.
 */
function shownOut(sessionId: string, cellId: string): void {
  const { settings } = councilCellOf(sessionId, cellId)
  broadcast(sessionId, {
    t: 'council:shown',
    cellId,
    shown: shownFor(sessionId, cellId, settings.namesOnProjector),
  })
}

/**
 * Who is on screen for the cell right now — without assembling a frame;
 * `null` means nobody.
 */
function shownWho(sessionId: string, cellId: string): string | null {
  for (const attempt of attemptsOf(sessionId, cellId)) {
    if (attempt.shown) return attempt.participantId
  }
  return null
}

/**
 * The queue number each waiting person saw last — per room.
 *
 * Needed so as not to send a frame in which nothing changed for the person:
 * the queue twitches on every start and every end of ANY kernel work. The
 * key is "cell and person", the value is the number.
 */
const queueSent = new Map<string, Map<string, number>>()

/**
 * The queue moved — to everyone it moved, their new number.
 *
 * Without this "You are 37th" would show the number at the moment of the
 * click until the end of the class period.
 *
 * A NUMBER goes out, not a sheet. Every end of any kernel work moves the
 * number for all those waiting at once — that is, the "nothing changed for
 * this one" filter never fired — and with five hundred attempts one finished
 * run sent out five hundred `council:mine`. The server assembled each of them
 * separately (`mineFor`: reading the attempt from the database, its run, the
 * teacher's letters) and carried it whole, along with the attempt's text and
 * the task, for the sake of one number in it. Measured with five hundred
 * waiting: 0.32 MB per shift against 30 KB.
 *
 * The queue is not broadcast to the whole room, although that way it would
 * be assembled once for everyone: a list of five hundred waiting is eleven
 * kilobytes, and it would go to five hundred people (measured 5.65 MB per
 * shift) for the sake of one number each. It is cheaper to assemble five
 * hundred frames of sixty bytes — assembling such a frame costs nothing next
 * to sending it.
 *
 * And `null` to whoever is no longer in the queue: their attempt reached the
 * kernel. Nobody used to say so — the broadcast went only to those who stayed
 * in the queue — and "you are 1st" hung over an attempt being computed until
 * its end.
 *
 * Numbers come from one pass over the queue, not a search in it for each one
 * waiting: the one-by-one `councilQueuePosition` is a search over the whole
 * queue for each of its members, that is, a quarter of a million comparisons
 * per shift with five hundred attempts. The number's formula is still one and
 * lives in kernel/index.ts: it is not here and must not be.
 */
function tellQueued(sessionId: string): void {
  const queued = councilQueuePositions(sessionId)
  const was = queueSent.get(sessionId)
  if (queued.length === 0 && !was) return
  const now = new Map<string, number>()
  for (const { cellId, participantId, position } of queued) {
    now.set(`${cellId}\n${participantId}`, position)
    if (was?.get(`${cellId}\n${participantId}`) === position) continue
    tell(sessionId, participantId, { t: 'council:queue', cellId, at: position })
  }
  for (const [key] of was ?? []) {
    if (now.has(key)) continue
    const split = key.indexOf('\n')
    tell(sessionId, key.slice(split + 1), { t: 'council:queue', cellId: key.slice(0, split), at: null })
  }
  if (now.size === 0) queueSent.delete(sessionId)
  else queueSent.set(sessionId, now)
}

/**
 * What the kernel of this cell's notebook is busy with — to one console, in
 * one small frame.
 *
 * Assembled here, not in the kernel, precisely because the kernel does not
 * know names and cannot count the cell number: it has `participantId` and
 * `cellId`, while the console needs "Petya" and "cell 7". Everything the
 * kernel knows itself arrives from `kernelWorkOf` unchanged — including the
 * "does not respond to interrupt" flag.
 *
 * The names here are always real: the frame goes to one teacher, and hiding
 * them behind "Answer 12" when the knob is off is the console's job, as with
 * the pile.
 */
function kernelMessage(sessionId: string, cellId: string): ControlServerMessage | null {
  const work = kernelWorkOf(sessionId, cellId)
  // The scope has not been created yet — nothing has ever been run in this notebook.
  if (!work) return { t: 'council:kernel', cellId, kernel: { busy: null, queued: 0 } }
  const busy = work.busy
  if (!busy) return { t: 'council:kernel', cellId, kernel: { busy: null, queued: work.queued } }
  const found = findCell(getSessionDoc(sessionId).doc, busy.cellId)
  return {
    t: 'council:kernel',
    cellId,
    kernel: {
      queued: work.queued,
      busy: {
        kind: busy.kind,
        index: found ? found.index + 1 : null,
        // An attempt is named by its AUTHOR, not by whoever pressed: a teacher
        // who ran someone's solution at the board is not the one whose work it
        // is.
        name: displayName(sessionId, busy.participantId ?? busy.runById),
        participantId: busy.participantId,
        here: busy.kind === 'attempt' && busy.cellId === cellId,
        startedAt: busy.startedAt,
        limitSec: busy.limitSec,
        stuck: busy.stuck,
      },
    },
  }
}

function kernelOut(sessionId: string, cellId: string): void {
  const message = kernelMessage(sessionId, cellId)
  if (message) toTeachers(sessionId, message)
}

/**
 * The notebook's queue moved — tell the consoles, but no more often than the
 * window.
 *
 * Across all cells with a pile, not just one: the console is open on one
 * cell, but which one the server does not know and should not know (the tab
 * is switched without it). There are only a handful of council cells in a
 * class, the frame is fifty bytes, and its window is the same as the queue
 * numbers': the queue twitches twice for every piece of work.
 *
 * No console at all — nothing is assembled: in a large cohort the queue
 * twitches continuously, and there is nobody to listen to it.
 */
function nudgeKernel(sessionId: string): void {
  if (!teachersOnline(sessionId)) return
  onTick(sessionId, 'notebook kernel', QUEUE_EVERY_MS, () => {
    if (!teachersOnline(sessionId)) return
    for (const id of new Set([...councilCells(sessionId), ...cellsWithAttempts(sessionId)])) {
      kernelOut(sessionId, id)
    }
  })
}

/**
 * The queue twitched — tell those waiting their new number, but no more
 * often than the window.
 *
 * Numbers used to be sent only at the end of SOMEONE ELSE'S council attempt.
 * But the queue is one for the whole room, and a student's number also counts
 * the cells ahead: five cells of the teacher's Run All, once finished, moved
 * them from sixth place to first — and did not say a word about it until the
 * end of the next attempt.
 *
 * A window — because the queue twitches twice for every piece of kernel work,
 * and the frame goes to each person waiting: with five hundred that is a
 * noticeable batch, and gluing two consecutive changes into one is cheaper
 * than sending it twice.
 */
const QUEUE_EVERY_MS = 250

function nudgeQueue(sessionId: string): void {
  onTick(sessionId, 'queue numbers', QUEUE_EVERY_MS, () => tellQueued(sessionId))
}

/** The room has emptied: the queue it remembered is nobody's any more. */
function forgetQueue(sessionId: string): void {
  queueSent.delete(sessionId)
}

/**
 * Everyone entitled to their own sheet for this cell: those online and those
 * with an attempt.
 */
function councilAudience(sessionId: string, cellId: string): Set<string> {
  const people = new Set<string>(rooms.get(sessionId)?.byParticipant.keys())
  for (const attempt of attemptsOf(sessionId, cellId)) people.add(attempt.participantId)
  return people
}

/**
 * The lock changed — the pile to the host, each person their sheet, the room
 * the counter and the screen.
 */
function councilChanged(sessionId: string, cellId: string): void {
  boardOut(sessionId, cellId)
  // The cell is read once for everyone: the lock and the knobs on it are one,
  // while there are five hundred sheets.
  const cell = councilCellOf(sessionId, cellId)
  for (const participantId of councilAudience(sessionId, cellId))
    mineOut(sessionId, cellId, participantId, cell)
  countOut(sessionId, cellId)
  // And "what is on screen": a change of the names knob comes here too, and it
  // decides whose name captions what is shown — or the variant number instead
  // of a name.
  shownOut(sessionId, cellId)
}

/** Revoke approvals when a class/cell closes or its execution policy changes. */
export function clearCouncilRunRequests(sessionId: string, cellId?: string): void {
  tellClearedRunRequests(sessionId, clearRunRequests(sessionId, cellId))
}

/** Persist the class transition and revoke old approvals as one operation. */
export function setClassFinished(sessionId: string, at: number | null): void {
  let changed: ReturnType<typeof clearRunRequests>
  try {
    changed = db.transaction(() => {
      setFinished(sessionId, at)
      return clearRunRequests(sessionId)
    })()
  } catch (error) {
    // Both stores cache writes; a rolled-back transaction must roll back reads too.
    resetCouncilCache(sessionId)
    forgetRules(sessionId)
    throw error
  }
  tellClearedRunRequests(sessionId, changed)
}

function tellClearedRunRequests(sessionId: string, changed: ReturnType<typeof clearRunRequests>): void {
  const cells = new Map<string, string[]>()
  for (const row of changed) {
    mineOut(sessionId, row.cellId, row.participantId)
    const people = cells.get(row.cellId) ?? []
    people.push(row.participantId)
    cells.set(row.cellId, people)
  }
  for (const [id, people] of cells) boardOut(sessionId, id, people)
}

/** Cells where the council is running now — across all of the room's notebooks. */
function councilCells(sessionId: string): string[] {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return []
  const out: string[] = []
  for (const cells of allCellArrays(doc)) {
    for (const cell of cells.toArray()) if (cellLock(cell) === 'council') out.push(cellId(cell))
  }
  return out
}

/**
 * The council's welcome batch — to whoever has just connected.
 *
 * To the host — piles for all cells where the council is running or where
 * attempts remain (after closing they are for viewing). To everyone — their
 * sheets in the same cells, and the counters. Straight into this socket, not
 * through `tell`: the batch already arrived for a second tab of the same
 * person when that tab connected.
 */
function councilWelcome(ws: WebSocket, sessionId: string, payload: TokenPayload): void {
  // Cells with a council — one walk over all of the room's notebooks, not two:
  // the batch is assembled on every connection, and after a network failure
  // there are five hundred of them in a row.
  const open = councilCells(sessionId)
  const cells = new Set<string>([...open, ...cellsWithAttempts(sessionId)])
  if (payload.role === 'host') {
    for (const id of cells) {
      send(ws, {
        t: 'council:board',
        cellId: id,
        // Within the output budget: for a console coming back after a drop,
        // the pile for five hundred run attempts would otherwise weigh tens of
        // megabytes — and it is the first thing it receives.
        board: withinBudget(boardFor(sessionId, id, councilCellOf(sessionId, id))),
      })
      // And what the notebook's kernel is busy with: a console coming back
      // after a drop must see someone else's work holding the queue, not an
      // empty card.
      const kernel = kernelMessage(sessionId, id)
      if (kernel) send(ws, kernel)
    }
  }
  const mine = new Set<string>([...open, ...cellsOfParticipant(sessionId, payload.participantId)])
  for (const id of mine) {
    const message = mineMessage(sessionId, id, payload.participantId)
    if (message) send(ws, message)
  }
  for (const id of cells) {
    const { submitted, total } = countFor(sessionId, id)
    send(ws, { t: 'council:count', cellId: id, submitted, total })
    /*
     * And "what is on screen" — a frame per cell, even when there is nothing
     * to show.
     *
     * `null` here is not redundant but load-bearing: the council state lives
     * on the client longer than the socket, and a tab whose connection dropped
     * BEFORE "take off the screen" would come back with a badge that everyone
     * else no longer has, and would keep it until the teacher's next click.
     * The price is a sixty-byte frame next to the counter, which already goes
     * for the same cells.
     */
    send(ws, {
      t: 'council:shown',
      cellId: id,
      shown: shownFor(sessionId, id, councilCellOf(sessionId, id).settings.namesOnProjector),
    })
  }
  /*
   * And a full stop: the batch is over.
   *
   * As the last frame and always — even when not a single frame went before
   * it: in a room without a council emptiness is the answer, and it has to be
   * said just as explicitly. Without this full stop the client could not tell
   * "the frame is still on its way" from "there will be none", and the console
   * flickered "the cell is not in council" between the splash screen and
   * itself (shared/protocol.ts · council:ready).
   */
  send(ws, { t: 'council:ready' })
}

/**
 * Remove a banned person's attempts from all cells — and show the host the
 * piles without them.
 *
 * Called from routes/bans.ts next to purgeQuestions: people are banned for
 * spam in the shared feed, and an attempt in the council is the same text in
 * front of the teacher's eyes.
 */
export function purgeCouncilOf(sessionId: string, participantId: string): number {
  const cells = cellsOfParticipant(sessionId, participantId)
  const gone = purgeAttempts(sessionId, participantId)
  /*
   * And the queue too: there is one kernel per cohort, and its minute spent on
   * the code of a person who is no longer in the room is a minute the whole
   * rest of the class waits for. All their waiting attempts are removed; if
   * one is already spinning, only it is interrupted, and the others' queue
   * waits for the end of that interrupt.
   */
  purgeCouncilRunsOf(sessionId, participantId)
  for (const id of cells) {
    // The attempt is gone already — the frame will name the person in `removed`.
    boardOut(sessionId, id, [participantId])
    countOut(sessionId, id)
    // And the badge with their code, if they were on screen: a banned person
    // leaves the screen together with their attempt rather than staying under
    // the cell for the class.
    shownOut(sessionId, id)
  }
  return gone
}

/** An integer within bounds — otherwise we consider the knob not applied. */
function whole(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}

/**
 * Council knobs from a message — only known values.
 *
 * Anything unclear is DISCARDED, not replaced by a default: a message with
 * one knob means "switch that one", the others stay as they were, and a
 * "limit 99999" from someone else's client must not silently return the cell
 * to thirty seconds. The second lock is `readCouncilSettings` over the merged
 * knobs where they are written into the document: it also fixes what already
 * lies in the cell.
 */
function pickSettings(raw: unknown): Partial<CouncilSettings> {
  const out: Partial<CouncilSettings> = {}
  if (!raw || typeof raw !== 'object') return out
  const from = raw as Record<string, unknown>
  if (typeof from.studentRun === 'boolean' || from.studentRun === 'request') out.studentRun = from.studentRun
  if (typeof from.namesOnProjector === 'boolean') out.namesOnProjector = from.namesOnProjector
  // `null` for the limit is a legitimate value and the only non-number here:
  // "no limit" is the teacher's choice, not the absence of a knob.
  if (from.runLimitSec === null) out.runLimitSec = null
  else {
    const limit = whole(from.runLimitSec, 1, COUNCIL_RUN_LIMIT_MAX)
    if (limit !== null) out.runLimitSec = limit
  }
  const pause = whole(from.rerunPauseSec, 0, COUNCIL_RERUN_PAUSE_MAX)
  if (pause !== null) out.rerunPauseSec = pause
  return out
}

/*
 * The cells are gone — take them off execution.
 *
 * A cell standing in the queue can be removed too: the document does not
 * forbid it, and it should not — a person sees the cell and is entitled to
 * remove it. But the queue lives by names, and the kernel then honestly takes
 * from it an id that corresponds to nothing: Run All breaks off on an empty
 * spot, and `meta.queue` names cells that cannot be found in the notebook.
 *
 * `isHost` here is not about a right or a person: the server clears the queue
 * because there is nothing to run any more — one's own and someone else's
 * alike. A cell that is BEING COMPUTED right now is interrupted by the kernel
 * itself (`stopIfDeleted` in kernel/index.ts): it sees the same document
 * edit and knows what it has in progress, and from here that would be a
 * second SIGINT in the same second.
 */
onCellsRemoved((sessionId, cellIds) => {
  cancelRun(sessionId, cellIds, '', true)
  for (const cellId of cellIds) clearCouncilRunRequests(sessionId, cellId)
})

onRefusal((sessionId, participantId, refusal) => {
  tell(sessionId, participantId, {
    t: 'refused',
    rule: refusal.rule,
    message: refusal.message,
  })
})

/**
 * The Oracle on solutions changed state — tell the consoles.
 *
 * Only to teachers: the summary read the students' texts, it must not go to
 * the projector or the hall. The registration is here, not in
 * routes/council.ts: only this module knows the teachers' sockets, and
 * importing control.ts from ai/council.ts would close the modules onto each
 * other — as with onRefusal.
 *
 * And WITHOUT the pile after it. It used to go out here for the sake of the
 * captions on the summary chips, but there is no summary and no captions any
 * more, and the console puts the Oracle into its pile itself
 * (council.svelte.ts · withOracle). This extra line cost two full piles per
 * question — "reading" and "ready" — that is, two frames with all attempts
 * and their outputs on every press of "Ask".
 */
onCouncilOracle((sessionId, cellId, oracle) => {
  toTeachers(sessionId, { t: 'council:oracle', cellId, oracle })
})

// The transcript is in the document; the terminal's health is not, so it comes
// down this channel the same way kernel status does.
onTerminalPhase((sessionId, status) => broadcast(sessionId, { t: 'terminal', status }))

/* ----------------------------------------------------------------- doc */

/**
 * The kernel state of one notebook — by its entry in the `meta.kernels` map.
 *
 * Without a root — the room's notebook: that is how a tab opened before there
 * were several kernels reads it, and that is also how the first `ready` frame
 * answers.
 */
function kernelStatus(sessionId: string, root: string = CELLS_KEY): KernelStatus {
  try {
    return bookKernel(getSessionDoc(sessionId).doc, root).status
  } catch {
    return 'starting'
  }
}

/** Kernel states per notebook — what goes into the socket's first frame. */
function kernelStatuses(sessionId: string): Array<{ book: string; status: KernelStatus }> {
  try {
    const { doc } = getSessionDoc(sessionId)
    return bookList(doc).map((book) => ({
      book: book.path,
      status: bookKernel(doc, book.root).status,
    }))
  } catch {
    return []
  }
}

/**
 * Kernel health lives in the document, so the browser already re-renders from
 * there. Mirroring it onto this socket costs one small frame and keeps clients
 * that are watching only the control channel honest.
 *
 * And the queue while we are at it. It is in the same `meta`
 * (kernel/index.ts · syncQueue), and its mirror changes on every shift: a cell
 * was queued, a cell finished, an attempt went into work. From here the new
 * number goes out to those waiting — the only place where it is honest for
 * any reason, not only at the end of someone else's council attempt.
 *
 * `observeDeep`, not `observe`: the queue list is a nested Y.Array, and the
 * map does not show its edits (and they are the most frequent shift) to the
 * outside.
 */
function watchRoomMeta(sessionId: string): () => void {
  const { doc } = getSessionDoc(sessionId)
  const meta = getMeta(doc)
  /*
   * The previous state — PER NOTEBOOK.
   *
   * One `last` field per room would mean that a second notebook becoming
   * `busy` right after the first gets no frame at all: the value is the same.
   * The frame names its own sheet, and an old tab reads it as before — it
   * simply does not know the `book` field.
   */
  const last = new Map<string, KernelStatus>()
  /*
   * The notebook list is walked ONLY when the kernels map has changed.
   *
   * `observeDeep` wakes us on every queue shift — twice per cell, and with Run
   * All over forty cells that is eighty times in a row, for the whole room.
   * While there were two fields, the walk cost two reads; now it is a pass
   * over the notebook list reading each one's entry. The path of the event
   * from `meta` says where the write went: `['kernels', <root>, …]` means into
   * the map, an empty path with the `kernels` key means it was just created.
   */
  const touchesKernels = (events: Y.YEvent<any>[]): boolean =>
    events.some(
      (event) =>
        event.path[0] === KERNELS_KEY ||
        (event.path.length === 0 &&
          (event as Y.YMapEvent<any>).keysChanged?.has(KERNELS_KEY) === true),
    )
  const onChange = (events: Y.YEvent<any>[]) => {
    if (touchesKernels(events)) {
      for (const book of bookList(doc)) {
        const status = bookKernel(doc, book.root).status
        if (last.get(book.root) === status) continue
        last.set(book.root, status)
        broadcast(sessionId, { t: 'kernel', status, book: book.path })
      }
    }
    nudgeQueue(sessionId)
  }
  meta.observeDeep(onChange)
  return () => meta.unobserveDeep(onChange)
}

/**
 * Code cell ids in document order. With `upToCellId`, stops after that cell —
 * and returns nothing if the id is unknown, so a stale "run above" from a tab
 * that missed a deletion cannot silently turn into "run the whole notebook".
 *
 * `null` means "a notebook was named, and there is no such one in the room".
 * That is not the same as "no path given": without a path the room's notebook
 * is implied (that is how messages from tabs opened before there were several
 * notebooks read), whereas the tab of a removed notebook that has not yet
 * learned about it would, by pressing Run All, queue SOMEONE ELSE'S whole
 * sheet.
 */
function codeCellIds(
  sessionId: string,
  book: string | undefined,
  upToCellId?: string,
): string[] | null {
  const doc = getSessionDoc(sessionId).doc
  const named = book ? cellsAt(doc, book) : null
  if (book && !named) return null
  const cells = named ?? getCells(doc)
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

/**
 * A frame thicker than the ceiling is not garbage, and it must not be passed
 * over in silence.
 *
 * It used to be thrown away right here, together with the unparseable: no
 * error, no line in the log. For a council attempt that is the worst thing
 * the wire can do — the student keeps writing the sheet, the snapshots stop
 * arriving SILENTLY, and on "Submit" the teacher sees text half an hour old.
 * A separate answer, not `null`.
 */
const TOO_BIG = 'too-big'

function parse(data: RawData): ControlClientMessage | typeof TOO_BIG | null {
  const text = frameText(data)
  if (text.length === 0) return null
  if (text.length > MAX_FRAME_BYTES) return TOO_BIG
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

/** A full stop at the end, like the neighbouring phrases: it is a complete sentence. */
const OVER = 'server.classOverPeriod'

/**
 * A refusal by right — and one phrase for all refusals of a finished class.
 *
 * The rights after the end of class tighten by themselves: they are asked of
 * `getRules`, and it hands out the effective ones (db.ts). But the words
 * would have stayed the same — "In this seminar the teacher runs cells" sends
 * the person to look for a teacher who changed nothing. So the phrase swap
 * stands in one place that all refusals by right pass through: a check
 * written tomorrow gets it for free if it refuses through this helper.
 */
function refuse(ws: WebSocket, sessionId: string, payload: TokenPayload, message: string): void {
  send(ws, {
    t: 'error',
    message: actsAfterClass(isFinished(sessionId), payload.role) ? message : tr(OVER),
  })
}

/**
 * One phrase for a refusal by the `run` rule — and so it is a constant.
 *
 * Running a cell now asks for the right already knowing about the lock, and
 * so it names the phrase itself; without a shared name the code would have
 * two identical sentences, of which one day only one would be corrected.
 */
const RUN_IS_THE_TEACHERS = () => tr("server.onlyTheTeacherRunsCellsInThis.21ec54")

/* ---------------------------------------- rules of a SEPARATE notebook */

/**
 * Who is asking — in the form in which the notebook rules read it.
 *
 * The name is needed for exactly one question: is this their personal
 * notebook (shared/rules.ts · BookRule.owner). Everything else is decided by
 * the role, as it always was.
 */
function asker(payload: TokenPayload): Asker {
  return { role: payload.role, participantId: payload.participantId }
}

/**
 * Who creates a notebook — for the author record.
 *
 * The name is taken here, at the moment of creation, rather than looked up
 * later: a notebook outlives a semester, the participant may have been
 * removed from the database, and "personal notebook: —" explains nothing
 * (shared/rules.ts · BookRule.ownerName). The record does not concern the
 * teacher — `rememberAuthor` filters them out itself, and the role travels
 * here exactly for that.
 */
function authorOf(sessionId: string, payload: TokenPayload): BookAuthor {
  return {
    participantId: payload.participantId,
    name: displayName(sessionId, payload.participantId),
    role: payload.role,
  }
}

/**
 * The root of the notebook this cell lies in.
 *
 * `null` means there is no such cell in the room. Then the room's rules
 * decide the rights, and the refusal speaks of them: there is nothing to
 * reason about access to a notebook the cell does not have.
 */
function rootOf(sessionId: string, cellId: string): string | null {
  return rootOfCell(getSessionDoc(sessionId).doc, cellId)
}

/**
 * The root of the NAMED notebook — or of the room's notebook if none was
 * named.
 *
 * Without a name the first notebook is implied: that is how messages from
 * tabs opened before there were several notebooks read (see `bookOf`).
 * `null` means a notebook was named that is not in the room; the caller
 * answers that with its NO_SUCH_BOOK, not silently with the room's rules.
 */
/**
 * Which sheet this list of cells was COLLECTED from — by the first of them.
 *
 * Separate from `rootOfBook`, and this is not pedantry. Without a sheet name
 * the rights are asked of `mainRoot` (the first notebook in order), while the
 * cells are collected by `codeCellIds` from the `cells` root — and in a room
 * where the room's notebook was removed these two answers diverge. The queue
 * accepts only cells of ITS OWN notebook (kernel/index.ts · requestRun), so
 * having diverged they would produce a Run All that silently does nothing.
 * The queue asks the cells themselves.
 */
function rootOfCells(sessionId: string, ids: string[]): string {
  for (const id of ids) {
    const root = rootOf(sessionId, id)
    if (root) return root
  }
  return CELLS_KEY
}

function rootOfBook(sessionId: string, book: string | undefined): string | null {
  const doc = getSessionDoc(sessionId).doc
  return book ? (bookAt(doc, book)?.root ?? null) : mainRoot(doc)
}

/**
 * The effective rules of ONE notebook for THIS person.
 *
 * The same function the browser uses to compute grey buttons and the gate
 * uses to judge frames (shared/rules.ts · rulesForBook). There is
 * deliberately no second copy of the "whose notebook is this" fork in the
 * product — such copies diverge silently and in the direction of a button
 * that can be pressed and brings a refusal.
 */
function rulesIn(sessionId: string, payload: TokenPayload, root: string | null): RoomRules {
  return rulesForBook(getRules(sessionId), root, asker(payload))
}

/**
 * The words of a refusal: the notebook's, when it was the one refusing, and
 * the room's in all other cases.
 *
 * "In this seminar the teacher runs cells", said about someone else's
 * personal notebook, sends the person to a teacher who forbade nothing. The
 * end of class is laid over this by `refuse` — one phrase for everything.
 */
function whyIn(
  sessionId: string,
  payload: TokenPayload,
  root: string | null,
  own: string,
): string {
  const book = bookRefusal(getRules(sessionId), root, asker(payload))
  return book ? tr(book.key, { p0: book.name }) : own
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
 *
 * `cellOpen` is the lock on the cell: the teacher opened this one, and in it
 * the room computes even where the teacher is otherwise the one who runs.
 * The default is `false`, and this matters more than it seems: the same
 * helper is asked about Run All, running a file and a shell command, and an
 * open cell opens neither a sheet nor the terminal — it is open alone and
 * exactly alone.
 *
 * `root` is the notebook the press aims at: it may have its own access, and
 * then the room rule is replaced by it (`rulesIn`). The default `null` means
 * "this is not about a notebook", and `file:run` and `term:run` use it: a
 * script from the tree and a command in the shared shell are the room's
 * kernel, not someone's notebook, and opening them with a personal notebook
 * would be a hole in exactly the rule it was created for.
 */
function mayRun(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  message = RUN_IS_THE_TEACHERS(),
  cellOpen = false,
  root: string | null = null,
): boolean {
  if (mayRunCell(rulesIn(sessionId, payload, root), payload.role, cellOpen, isFinished(sessionId))) {
    return true
  }
  refuse(ws, sessionId, payload, whyIn(sessionId, payload, root, message))
  return false
}

/**
 * Whether this cell is open to the room.
 *
 * Asked of the document, not of the message: the server writes the field
 * (see `cell:open`), and it has to be read where it is written. The cell is
 * not in the room — then there is no lock either: the right is then decided
 * by the ordinary rules, and the refusal speaks of them, not of a cell that
 * does not exist.
 */
function cellIsOpen(sessionId: string, id: string): boolean {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return found ? isCellOpen(found.cell) : false
}

/**
 * The same for editing ONE cell — and also with the lock.
 *
 * Exactly the same question the CRDT gate asks about typing in this cell
 * (collab/gate.ts) and the client asks about a grey button
 * (web/src/lib/may.ts). An open cell is a right above the rules: in a lecture
 * notebook the hall types and runs in it, and asking a bare `rules.edit`
 * about it means answering "the notebook belongs to the teacher" about a
 * cell the teacher opened.
 */
function mayEditThis(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  cellId: string,
): boolean {
  const open = cellIsOpen(sessionId, cellId)
  // And by the rules of THE NOTEBOOK the cell lies in: a personal notebook has
  // its own answer to "who types here", and it is stronger than the room's in
  // both directions.
  const root = rootOf(sessionId, cellId)
  if (mayEditCell(rulesIn(sessionId, payload, root), payload.role, open, isFinished(sessionId))) {
    return true
  }
  refuse(
    ws,
    sessionId,
    payload,
    whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayEditTheNotebook.d8abb3")),
  )
  return false
}

/**
 * And this is about the whole sheet at once, and it is separate from the
 * previous one.
 *
 * The kernel is one, and the difference between "twenty people are
 * computing" and "twenty people clogged the queue with eight hundred cells"
 * lies exactly here. "One at a time" allows pressing on a cell and forbids
 * Run All.
 */
function mayBulkRun(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  root: string | null = null,
): boolean {
  // The whole sheet is the sheet of ONE notebook, and it is that notebook that
  // must be asked: Run All in one's own personal notebook must not run into
  // the room's lecture rule, and in someone else's personal one it must not
  // get through when the room is open.
  if (allowsRun(rulesIn(sessionId, payload, root).run, payload.role, 'bulk')) return true
  refuse(
    ws,
    sessionId,
    payload,
    whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayRunTheWhole.8359b5")),
  )
  return false
}

/** A right by a simple rule, with one phrase for the refusal. */
function may(
  sessionId: string,
  rule: Who,
  payload: TokenPayload,
  ws: WebSocket,
  message: string,
): boolean {
  if (allows(rule, payload.role)) return true
  refuse(ws, sessionId, payload, message)
  return false
}

/**
 * Whether this would break off a running lecture — and whether this person
 * is entitled to break it off.
 *
 * The shared screen and the lecture are one and the same document (see
 * `setBoard`), so "put up another file" and "remove the file" end the
 * lecture. That in itself is intentional, but the way in was wide open: a
 * click on `homework.pdf` in the files panel looks like "open the file for
 * myself" and is no different from a click on any other — and it costs forty
 * minutes of markup on the projector, in front of everyone and with no way
 * back (ink lives only in memory). The cross on the lecture document's tab is
 * the same thing: it sends `board:close`.
 *
 * So while a lecture is running, it is broken off only by two hands: the
 * presenter's (they both change the document and end it) or an explicit
 * "End". Everything else is a refusal in words, and the words name the
 * document, so that the person understands what they ran into.
 */
function lectureInTheWay(
  sessionId: string,
  payload: TokenPayload,
  ws: WebSocket,
  wanted: string | null,
): boolean {
  const going = lectureOf(sessionId)
  if (!going || going.file === wanted || going.by === payload.participantId) return false
  send(ws, {
    t: 'error',
    message: tr("server.aLectureIsUsingEndTheLecture.056f12", { p0: baseOf(going.file) }),
  })
  return true
}

/**
 * The console in hand — and the class still in progress.
 *
 * The presenter is not always the teacher: in a room with `board: 'room'`
 * students take turns showing their work, and the console in a student's
 * hands is not a hole but the point of the setting. So after the bell a role
 * alone is not enough, and `isPresenter` even less so: otherwise a student
 * presenter flips pages for the whole hall, draws and blanks the screen in a
 * room where everyone else is read-only by now.
 *
 * The bell does not turn off the lecture itself — forty minutes of markup
 * live only in memory, and losing them with a press of "End class" costs more
 * than leaving the picture on screen, where the participant was a viewer
 * anyway. What is taken away is control: the teacher takes over the console
 * with the same `lecture:start` or ends the lecture, as before.
 */
function atTheRemote(sessionId: string, payload: TokenPayload): boolean {
  return (
    isPresenter(sessionId, payload.participantId) &&
    actsAfterClass(isFinished(sessionId), payload.role)
  )
}

/**
 * Queue up and, if something did not fit, say so once.
 *
 * The ceiling comes from the rule: "one at a time" means one cell per person
 * at a time. That is what makes the rule a boundary rather than a click
 * counter: a scripted loop gets one cell in the queue and one phrase.
 *
 * `root` — whose queue. There are now as many queues as notebooks, and the
 * ceiling is counted for each separately: "one at a time" means "one at a
 * time per notebook", otherwise a cell being computed in the lecture would
 * lock a person out of their own draft. The rule is still the room's
 * (`getRules`, not `rulesIn`) and stays that way: the queue ceiling is not an
 * access right to a notebook.
 */
function queue(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
  ids: string[],
  root: string = CELLS_KEY,
): void {
  if (ids.length === 0) return
  const refused = requestRun(
    sessionId,
    ids,
    displayName(sessionId, payload.participantId),
    payload.participantId,
    runQueueCap(getRules(sessionId).run, payload.role),
    root,
  )
  if (refused > 0) {
    send(ws, {
      t: 'error',
      message: tr("server.youMayRunOneCellAtA.35e7c7"),
    })
  }
}

/**
 * One phrase for the depth ceiling — and so it is a constant.
 *
 * It is said to two parties: the input field where a path that is too long
 * was typed, and the move of a folder whose contents would go past the eighth
 * level in the new place. The reason is the same, and these two sentences
 * have no reason to drift apart.
 */
const TOO_DEEP = () => tr("server.pathsMayBeUpToLevelsDeep.8e0b25", { p0: MAX_DEPTH })

/**
 * Why a path is unfit — in the same words as in the panel's input field.
 *
 * The refusal is about the last segment: the person did not type the others,
 * they came from the tree, and complaining about them would mean pointing in
 * the wrong direction.
 */
function refusedPath(raw: unknown): string {
  const shown = typeof raw === 'string' ? raw : ''
  const last = shown.split('/').filter(Boolean).pop() ?? ''
  if (!last) return tr("server.theNameCannotBeEmpty.fc2696")
  if (shown.split('/').filter(Boolean).length > MAX_DEPTH) return TOO_DEEP()
  return whySegmentRefused(last)
}

/**
 * Everything that lies inside this path — including the path itself.
 *
 * Not only a file can be renamed and removed: `movePath` moves a directory
 * whole, `deleteFile` removes it with all its contents, and name editing in
 * the panel is started by a double click on any tree row, a folder included.
 * Meanwhile everything that remembers a path — the document open in the
 * editor, a notebook, speaker notes, the lecture and the shared screen —
 * knows only the exact name, and without this list a folder would be renamed
 * while its contents kept living at the old address: a notebook would
 * resurrect the folder with its projection, and the projector would show a
 * file that does not exist.
 *
 * Computed BEFORE the tree edit: after it there is nobody left to ask.
 */
function pathsInside(sessionId: string, dir: string): string[] {
  const found = new Set<string>([dir])
  try {
    for (const entry of listFiles(sessionId)) {
      if (!entry.dir && isInside(entry.path, dir)) found.add(entry.path)
    }
  } catch {
    /* the folder cannot be read — we make do with the path itself */
  }
  // And the notebooks by the room's list: the folder walk has a ceiling, and a
  // notebook that did not make it into the file list is exactly the one whose
  // record matters most to carry over.
  const doc = peekSessionDoc(sessionId)?.doc
  if (doc) for (const book of bookList(doc)) if (isInside(book.path, dir)) found.add(book.path)
  /*
   * And what remembers one single path by heart: the document on screen and
   * the lecture file. The argument is the same as for notebooks: the tree walk
   * is truncated — by the number of rows and by depth — and a document that
   * did not make it into the list has not gone anywhere, it is on the
   * projector right now. Asking about them costs two reads from memory;
   * skipping them means leaving the projector on a path that does not exist
   * after the move, and the talk for twenty-four pages under a key that does
   * not exist.
   */
  const shown = boardOf(sessionId)
  if (shown && isInside(shown, dir)) found.add(shown)
  const lecture = lectureOf(sessionId)?.file
  if (lecture && isInside(lecture, dir)) found.add(lecture)
  return [...found]
}

/**
 * What to say when the path is fine but the thing still could not be done.
 *
 * Two sides, not one: for a move, "not found" is about the source, and
 * "taken" is about the target, and one line for both cases named a file the
 * person had not touched: after `a.py` → `b.py` they read that "b.py" is no
 * longer in this room — about a name that never existed. Where something new
 * is created, the two sides coincide, and the function can be called with
 * one path.
 */
function treeTrouble(outcome: TreeResult, target: string, source = target): string {
  const name = baseOf(target)
  if (outcome === 'exists') {
    /*
     * The place is named when it is not the one the person is looking at.
     * They dragged a file into a neighbouring folder and got a refusal — and
     * "in this folder" from the old phrase points to the one they dragged
     * FROM, and a room can have several data.csv files of the same name.
     * Renaming in place is left word for word: there "this folder" is exactly
     * the one that is open.
     */
    const into = parentOf(target)
    if (into === parentOf(source)) return tr("server.alreadyExistsInThisFolder.3e8b1f", { p0: name })
    return into
      ? tr("server.alreadyExistsInFolder.2f1ace", { p0: name, p1: baseOf(into) })
      : tr("server.alreadyExistsInTheRoomSRoot.229dba", { p0: name })
  }
  if (outcome === 'missing') return tr("server.isNoLongerInThisRoom.2ab165", { p0: baseOf(source) })
  if (outcome === 'too-deep') return TOO_DEEP()
  /*
   * The culprit is not the entry being moved — its path is short — but what
   * lies inside it: after the move the path to that is longer than
   * addressable, and there is no longer any way to open, download or remove
   * it item by item. The panel says so in the same words (`tooLong` in
   * tree-move.ts), without waiting for a round trip over the network.
   */
  if (outcome === 'too-long') {
    return tr("server.cannotMoveANestedPathWouldExceed.541d8f", { p0: baseOf(source), p1: MAX_PATH })
  }
  // There is only one way to get this: ask to put something inside a file
  // (`report.py/data.csv`). The root does not stop being a folder, so the
  // name of what did not fit is always available here.
  if (outcome === 'not-a-folder') {
    return tr("server.isAFileChooseADestinationFolder.298ed2", { p0: baseOf(parentOf(target)) })
  }
  if (outcome === 'bad-name') return whySegmentRefused(name)
  return tr("server.isBusyTryAgainInAMoment.bb101a", { p0: baseOf(source) })
}

/**
 * Which notebook a message names.
 *
 * `undefined` means the room's notebook. A message from a tab opened before
 * there were several notebooks reads the same way: the path in it is simply
 * not set, and the only one that existed then is implied.
 */
function bookOf(message: { book?: unknown }): string | undefined {
  return typeof message.book === 'string' && message.book ? message.book : undefined
}

/**
 * One phrase for all messages naming a notebook that is not in the room.
 *
 * A notebook is removed from the room, while a neighbour's tab lives on until
 * the file list arrives — and a press in it must not silently land in the
 * room's notebook. Out loud, not in silence: "Run All did nothing" a person
 * explains to themselves, and explains wrongly.
 */
const NO_SUCH_BOOK = () => tr("server.thisNotebookIsNoLongerInThe.513a76")

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined
}

/* -------------------------------------------- kernel completion and help */

/**
 * The ceiling on text that goes to the kernel for completion.
 *
 * Twenty-four kilobytes is a cell of eight hundred lines, which notebooks do
 * not have; and a console frame is cut at thirty-two (MAX_FRAME_BYTES), and
 * between these numbers there must be room left for the JSON itself. The
 * client cuts on its side (session.svelte.ts), the server cuts once more: the
 * client is not the only one who can open this socket, and a
 * `complete_request` with a megabyte of code is jedi parsing a megabyte on a
 * kernel that is, at that moment, shared by the whole room.
 */
const MAX_COMPLETE_CHARS = 24 * 1024

/**
 * How many completion questions one socket is entitled to ask.
 *
 * A hint is asked for ON A KEYSTROKE, and that makes it the only console
 * message a person sends by the dozen per second without deliberately
 * pressing anything. A bucket of ten per second is faster than a person types
 * and slower than a tab where something got stuck; four in flight — because
 * the kernel answers one at a time, and a fifth question would wait for its
 * turn on the shell anyway.
 *
 * Whoever overdoes it gets an EMPTY answer, not silence: the promise on the
 * client must resolve with something, otherwise the editor will wait for its
 * hint until the timeout and will not show even the words from the cell
 * itself.
 */
const ASK_PER_SECOND = 10
const ASK_BURST = 10
const ASK_IN_FLIGHT = 4

interface AskBudget {
  /** A bucket refilled by time; fractional — topped up by the millisecond. */
  tokens: number
  at: number
  /** How many of this socket's questions the kernel has not yet closed. */
  flight: number
}

/*
 * Per socket, not per person: the limit here is about the wire and the
 * kernel, and a tab is the wire. A WeakMap for the same reason as `owner`: a
 * closed socket carries its entry away itself, and there is nothing to clean
 * up after it.
 */
const asking = new WeakMap<WebSocket, AskBudget>()

function mayAsk(ws: WebSocket): boolean {
  const now = Date.now()
  const budget = asking.get(ws) ?? { tokens: ASK_BURST, at: now, flight: 0 }
  asking.set(ws, budget)
  budget.tokens = Math.min(ASK_BURST, budget.tokens + ((now - budget.at) * ASK_PER_SECOND) / 1000)
  budget.at = now
  if (budget.flight >= ASK_IN_FLIGHT || budget.tokens < 1) return false
  budget.tokens -= 1
  budget.flight += 1
  return true
}

function askDone(ws: WebSocket): void {
  const budget = asking.get(ws)
  if (budget && budget.flight > 0) budget.flight -= 1
}

/**
 * Twenty-four kilobytes ENDING at the cursor.
 *
 * The beginning is cut, not the end: what gets completed is what stands
 * before the caret, and a thousand lines further down the cell are not
 * needed for parsing at all. The cursor moves along with the text —
 * otherwise the kernel would complete a different place.
 */
function trimToCursor(code: string, cursor: number): { code: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, code.length))
  const head = code.slice(0, at)
  if (head.length <= MAX_COMPLETE_CHARS) return { code: head, cursor: at }
  return { code: head.slice(head.length - MAX_COMPLETE_CHARS), cursor: MAX_COMPLETE_CHARS }
}

/**
 * The right to a hint is the same as the right to run a cell.
 *
 * And this is not caution for caution's sake. `complete_request` asks the
 * notebook's LIVE kernel: `df.` shows what variables the teacher has, `_`
 * shows what they computed last, and `__builtins__.` together with help reads
 * like the table of contents of someone else's session. A room where the
 * teacher runs cells is a room where the kernel state belongs to them;
 * reading it through a hint would be a bypass of the rule, not a convenience.
 *
 * The lock on a guessed cell is still not asked here — but a frame CAN now
 * name the cell itself, and that changes exactly one case: one's own council
 * sheet.
 *
 * The sheet is the only cell in which a student is told to write code: that
 * is what the council is opened for. In a lecture room (`run: 'host'`) the
 * old rule refused it to everyone, and refused silently: names came from the
 * words of the cell itself, while the columns of the real `df`, for which the
 * task is given, did not. There is no bypass of the rule here: the attempt is
 * computed in the kernel of ITS OWN notebook anyway (`council:run` with the
 * teacher's knob), and the same state that a hint would show the person can
 * type and run in this cell anyway.
 *
 * The cell name is trusted because it is checked: the lock is read from the
 * room's document, not from the frame. Named someone else's cell that is not
 * in council — the old rule applies; named a cell in council — then it is in
 * council for everyone.
 */
/**
 * Which sheets a hint is currently on its way for —
 * `sessionId:cellId:participantId`.
 *
 * A second press while the first is in progress is a second request to the
 * model and a second spending line: the button goes dark on the client, but
 * the client is not the only one here that can send a frame. The memory is
 * local and dies with the process: an unfinished request will not survive it.
 */
const hintsReading = new Set<string>()

function mayComplete(sessionId: string, payload: TokenPayload, cellId?: unknown): boolean {
  const id = optionalId(cellId)
  if (id && councilCellOf(sessionId, id).lock === 'council') {
    return mayWriteCouncil(payload.role, isFinished(sessionId), false)
  }
  return mayWake(sessionId, payload, cellId)
}

/**
 * Whether this question may WAKE the room's kernel — that is, the right to
 * press "Run".
 *
 * "Right = run" — and a run in THE NOTEBOOK where the typing happens.
 * Otherwise hints would be silent in a student's own notebook in the middle
 * of a lecture: they write and compute there, and completion would answer
 * with emptiness because the room is closed.
 *
 * Separate from `mayComplete` because of exactly one fork: that one also lets
 * one's own council sheet through to hints, where a student writes code in a
 * lecture room. Reading the kernel state from there is allowed, but STARTING
 * Python for the room is not: the start is seen by the whole room ("the
 * environment is starting") and heats the machine for a minute and a half.
 * Whoever presses Run is the one who wakes it.
 *
 * A finished class does not get here: `mayRunCell` is asked together with
 * `isFinished`, and in a closed room nobody wakes the kernel any more.
 */
function mayWake(sessionId: string, payload: TokenPayload, cellId?: unknown): boolean {
  const id = optionalId(cellId)
  const root = id ? rootOf(sessionId, id) : null
  return mayRunCell(rulesIn(sessionId, payload, root), payload.role, false, isFinished(sessionId))
}

/**
 * The notebook's import header — the `import …` lines from code cells ABOVE
 * this one.
 *
 * Needed by the static help parsing: jedi answers about `sns.lmplot` only if
 * it knows that `sns` is seaborn, and in a notebook there is nowhere to know
 * that from except the cell with the imports. The scope in a notebook is not
 * the cell but the kernel: the header repeats exactly that
 * (kernel/inspect-static.ts · `importHeader`).
 *
 * Above — and only above: a notebook is read and run from top to bottom, and
 * an import written below the place where the typing happens means nothing
 * yet at that moment.
 *
 * And only of ONE'S OWN notebook. There are now as many kernels as
 * notebooks, and a header collected from a neighbouring one would tell jedi
 * about imports that do not exist in this Python at all: the root arriving
 * here is the same one the kernel was chosen by.
 */
function importsAbove(sessionId: string, root: string, cell: string | undefined): string {
  if (!cell) return ''
  const doc = peekSessionDoc(sessionId)?.doc ?? getSessionDoc(sessionId).doc
  const cells = bookCells(doc, root)
  for (let i = 0; i < cells.length; i++) {
    if (cellId(cells.get(i)) !== cell) continue
    const above: string[] = []
    for (let k = 0; k < i; k++) {
      const one = cells.get(k)
      if (cellType(one) !== 'code') continue
      above.push(cellSource(one).toString())
    }
    return importHeader(above)
  }
  return ''
}

/**
 * Ask the kernel and answer — or answer empty, whatever happens.
 *
 * An empty answer for EVERY trouble: no right, no kernel, the kernel is busy,
 * more questions than allowed, the kernel threw. The promise on the other
 * side must always resolve.
 *
 * For COMPLETION the empty answer is also silent, and that is the rule: the
 * list is asked for on every letter, and a toast "the teacher runs cells
 * here" on every typed dot is a punishment for typing. But for HELP, since
 * 19 Sep 2026, a reason comes with the empty answer (`inspect:reply.reason`):
 * it is asked for by hovering, that is, deliberately and once at a time, and
 * silence in response to a gesture reads as breakage — "it does not always
 * appear". The reason travels as one word (protocol.ts · `InspectMiss`), and
 * the client picks the words for it: the texts live in the room's language,
 * not the server's.
 *
 * Nothing is written into the class log. The log is what a person DID ("ran
 * a cell", "opened the terminal"); a typed dot is not an action, and a
 * thousand "asked for completion" lines per class period would bury
 * everything else in it.
 */
function askKernel(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
  message: Extract<ControlClientMessage, { t: 'complete' | 'inspect' }>,
): void {
  const id = message.id
  if (typeof id !== 'number' || !Number.isFinite(id)) return
  /**
   * A refusal before any trip to the kernel: it has one reason — "asking was
   * not allowed".
   */
  const empty: ControlServerMessage =
    message.t === 'complete'
      ? { t: 'complete:reply', id, matches: [], start: 0, end: 0 }
      : { t: 'inspect:reply', id, found: false, reason: 'refused' }
  if (typeof message.code !== 'string' || typeof message.cursor !== 'number') {
    send(ws, empty)
    return
  }
  if (!mayComplete(sessionId, payload, message.cellId) || !mayAsk(ws)) {
    send(ws, empty)
    return
  }
  const { code, cursor } = trimToCursor(message.code, message.cursor)
  /*
   * We ask the kernel of THE notebook where the typing happens.
   *
   * There are now as many kernels as notebooks, and completion must know
   * about the variables of its own sheet: `df.` in a seminar is the seminar's
   * `df`, not the one the teacher loaded in the lecture. The frame names the
   * cell; the cell names its notebook. No cell (typing in an empty place) —
   * the room's notebook, as before.
   *
   * Everything else this door knows is measured by the same notebook: the
   * right to wake the kernel (`mayWake`) and the import header for static
   * parsing (`importsAbove`). Asking one notebook and answering by another is
   * the quietest way to show a person someone else's variables.
   */
  const askRoot = (message.cellId ? rootOf(sessionId, message.cellId) : null) ?? CELLS_KEY
  const wake = mayWake(sessionId, payload, message.cellId)
  if (message.t === 'complete') {
    void completeIn(sessionId, code, cursor, askRoot, { mayWake: wake })
      .then((result) => {
        if (result === null) {
          send(ws, empty)
          return
        }
        send(ws, {
          t: 'complete:reply',
          id,
          matches: result.matches.map(({ text, type }) => (type ? { text, type } : { text })),
          start: result.cursorStart,
          end: result.cursorEnd,
        })
      })
      .catch(() => send(ws, empty))
      .finally(() => askDone(ws))
    return
  }
  /*
   * A question about a VALUE — a short road of its own.
   *
   * No help, no waking the kernel, no static parsing: the type and size of an
   * object that already lies in the kernel. No kernel or it is busy — the
   * answer is empty, and the client stays silent: about a variable there is
   * either an instant answer or nothing (kernel/index.ts · `briefIn`).
   */
  if (message.brief === true) {
    void briefIn(sessionId, nameChainAt(code, cursor), askRoot)
      .then((brief) => {
        send(ws, { t: 'inspect:reply', id, found: brief !== null, ...(brief ? { brief } : {}) })
      })
      .catch(() => send(ws, empty))
      .finally(() => askDone(ws))
    return
  }
  void inspectIn(sessionId, code, cursor, askRoot, {
    mayWake: wake,
    header: importsAbove(sessionId, askRoot, optionalId(message.cellId)),
  })
    .then((result) => {
      send(ws, {
        t: 'inspect:reply',
        id,
        found: result.found,
        ...(result.text === null ? {} : { text: result.text }),
        ...(result.reason === null ? {} : { reason: result.reason }),
      })
    })
    .catch(() => send(ws, empty))
    .finally(() => askDone(ws))
}

/**
 * Twenty-four kilobytes AROUND the caret — the same ceiling as the
 * neighbours', and it stands here for the same reason: the client cuts on its
 * side (session.svelte.ts · windowAroundCursor), and the server cuts once
 * more, because the client is not the only one who can open this socket.
 *
 * But it is cut differently, and that is the only fork on the whole road.
 * Completion needs only the text BEFORE the caret, while a definition almost
 * always stands BELOW the place it was clicked from: `helper()` on the third
 * line with `def helper()` on the thirtieth is an ordinary cell, the reverse
 * order is a rarity. Cutting off the tail like `trimToCursor`, the server
 * would honestly answer "could not find where it is defined" exactly where
 * the jump is needed most — in a long file.
 *
 * The cursor moves by exactly as much as was cut on the left: off by one
 * character, the parser would take a DIFFERENT name — and lead confidently
 * in the wrong direction.
 */
function windowAround(code: string, cursor: number): { code: string; cursor: number; from: number } {
  const at = Math.max(0, Math.min(cursor, code.length))
  if (code.length <= MAX_COMPLETE_CHARS) return { code, cursor: at, from: 0 }
  const half = Math.floor(MAX_COMPLETE_CHARS / 2)
  const start = Math.max(0, Math.min(at - half, code.length - MAX_COMPLETE_CHARS))
  return { code: code.slice(start, start + MAX_COMPLETE_CHARS), cursor: at - start, from: start }
}

/**
 * Where this is defined — the third question of the same shape and the only
 * one answered not by the kernel.
 *
 * RIGHTS are not asked here, and that is a decision, not an omission. The
 * neighbours' `mayComplete` is about reading the state of the LIVE kernel:
 * `df.` shows the teacher's variables, `_` shows what they computed last, and
 * in a lecture room that is theirs and theirs alone. Jumping to a definition
 * does not touch the kernel at all: it reads the room's document and the .py
 * files of its folder — exactly what every participant already sees in the
 * notebook and the files panel, and reads through the CRDT without asking
 * anyone. Putting `mayComplete` here would mean turning off the jump for the
 * whole group in a lecture — for reading what they already have open on
 * screen.
 *
 * The `mayAsk` bucket is reused as is. A click is rare, and the bucket is no
 * hindrance to a person; but frames into the socket can be sent not only by
 * the editor, and each such question is a walk of the seminar folder and
 * parsing of up to eighty files (definitions.ts · MAX_FILES_READ). `askDone`
 * is right there, in `finally`: nobody waits for a kernel, the answer is
 * computed here and now, and there is no reason to hold a place "in flight"
 * — otherwise the fifth click in a row would refuse forever.
 *
 * Nothing is written into the class log — by the same argument as for
 * completion: the log is about actions, and reading where a function is
 * defined is not an action.
 */
function answerDefine(
  ws: WebSocket,
  sessionId: string,
  message: Extract<ControlClientMessage, { t: 'define' }>,
): void {
  const id = message.id
  if (typeof id !== 'number' || !Number.isFinite(id)) return
  /*
   * The answer to any trouble is `nothing`, not silence: the promise on the
   * other side must resolve. And precisely `nothing`, because it is the only
   * one the client lives through SILENTLY (goto.svelte.ts · words): where the
   * server refused because of the bucket or could not parse the frame, there
   * is nothing to tell the person — they made the right gesture, and there is
   * nothing to explain to them.
   */
  const nothing: ControlServerMessage = { t: 'define:reply', id, miss: { why: 'nothing' } }
  if (typeof message.code !== 'string' || typeof message.cursor !== 'number') {
    send(ws, nothing)
    return
  }
  if (!mayAsk(ws)) {
    send(ws, nothing)
    return
  }
  try {
    const { code, cursor, from } = windowAround(message.code, message.cursor)
    /*
     * The cuts add up: the client may have cut its window
     * (session.svelte.ts · windowAroundCursor), and here it is cut a second
     * time — for a foreign client that does not know the ceiling. Lines are
     * counted from the START OF THE SOURCE, and both cuts must reach
     * `defineIn` as one number.
     */
    const cut =
      (typeof message.from === 'number' && Number.isFinite(message.from) && message.from > 0
        ? Math.floor(message.from)
        : 0) + from
    const cellId = optionalId(message.cellId)
    const path =
      typeof message.path === 'string' && message.path.length > 0 && message.path.length <= MAX_PATH
        ? message.path
        : undefined
    const answer = defineIn(sessionId, code, cursor, cellId, path, cut)
    send(ws, { t: 'define:reply', id, ...answer })
  } catch (error) {
    // Parsing someone else's code is a place where one can go wrong at every
    // corner, and the price of such a mistake must not be "the room's socket
    // fell". A silent `nothing` and a line in the console: for the person the
    // jump simply did not work.
    if (seldom('define-failed')) console.warn('[control] jump to definition failed:', error)
    send(ws, nothing)
  } finally {
    askDone(ws)
  }
}

/**
 * Parsing one control socket message.
 *
 * Exported for the test's sake: the rights table lives here, and checking it
 * through a real socket would mean starting a kernel just to make sure it
 * was not reached. Every refusal answers before any action.
 */
export function dispatch(
  ws: WebSocket,
  sessionId: string,
  payload: TokenPayload,
  message: ControlClientMessage,
): void {
  switch (message.t) {
    case 'ping':
      // A pulse every 25 seconds — and also the most frequent occasion to
      // notice a cell that the document considers running while the server
      // knows nothing about it. This is what limits the life of such a ghost
      // to one pulse beat, rather than "until somebody presses something".
      // The pass reads one key per cell and writes only where the document is
      // wrong.
      sweepOrphanRuns(sessionId)
      // The server's clock in response: the browser computes its correction
      // from it and does not show "40.0s" on a cell that has just been
      // started. See session.svelte.ts.
      send(ws, { t: 'pong', now: Date.now() })
      return

    case 'run': {
      const id = optionalId(message.cellId)
      if (!id) return
      /*
       * We ask about the cell BEFORE asking about the right: an open lock is
       * exactly what makes this run allowed, and it can only be learned from
       * the document. The check used to stand before any knowledge of the
       * cell and so could not take it into account. The refusal remained one
       * phrase — the same one.
       */
      if (
        !mayRun(
          sessionId,
          payload,
          ws,
          RUN_IS_THE_TEACHERS(),
          cellIsOpen(sessionId, id),
          // And this cell's notebook: a personal one has its own answer to
          // "who runs here".
          rootOf(sessionId, id),
        )
      ) {
        return
      }
      queue(ws, sessionId, payload, [id], rootOf(sessionId, id) ?? CELLS_KEY)
      return
    }

    /*
     * Completion and help are the only two console frames that arrive on a
     * KEYSTROKE rather than on a button press. So they have their own door
     * with a bucket, an answer in the "may be lost" class, and not a line in
     * the class log.
     */
    case 'complete':
    case 'inspect':
      askKernel(ws, sessionId, payload, message)
      return

    /*
     * Jumping to a definition is a third frame of the same shape, but with
     * its own door: it does not go to the kernel at all, is answered
     * synchronously and rests not on the right to run but on the right to
     * read the room. All of this is in `answerDefine`.
     */
    case 'define':
      answerDefine(ws, sessionId, message)
      return

    case 'cancel': {
      const id = optionalId(message.cellId)
      if (!id) return
      // Silent when there was nothing of theirs waiting: two people pressing
      // cancel on the same cell is a race, not an error worth a message.
      cancelRun(sessionId, [id], payload.participantId, payload.role === 'host')
      return
    }

    case 'runAll': {
      /*
       * The notebook comes before the right, and that is the same order as
       * for `run` above: the right to run here is decided not only by the
       * room but also by access to the NAMED notebook, and that can only be
       * learned by finding its root. A named and nonexistent one answers with
       * its own phrase, not with the room's rules.
       */
      const book = bookOf(message)
      const root = rootOfBook(sessionId, book)
      if (book && root === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      if (!mayRun(sessionId, payload, ws, RUN_IS_THE_TEACHERS(), false, root)) return
      if (!mayBulkRun(sessionId, payload, ws, root)) return
      const ids = codeCellIds(sessionId, book)
      if (ids === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      queue(ws, sessionId, payload, ids, rootOfCells(sessionId, ids))
      return
    }

    case 'runAbove': {
      const id = optionalId(message.cellId)
      if (!id) return
      // By the notebook where it was pressed — the same argument as for Run All.
      const book = bookOf(message)
      const root = rootOfBook(sessionId, book)
      if (book && root === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      if (!mayRun(sessionId, payload, ws, RUN_IS_THE_TEACHERS(), false, root)) return
      if (!mayBulkRun(sessionId, payload, ws, root)) return
      const ids = codeCellIds(sessionId, book, id)
      if (ids === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      queue(ws, sessionId, payload, ids, rootOfCells(sessionId, ids))
      return
    }

    case 'interrupt': {
      /*
       * Which notebook we are stopping.
       *
       * A named cell outranks the sheet name: it is the very work the press
       * was for, while the sheet comes from the tab that is open at that
       * moment. Without either — the room's notebook, that is, the old
       * behaviour of a frame from a tab opened before there were several
       * kernels.
       */
      const stopBook = bookOf(message)
      const stopRoot = rootOfBook(sessionId, stopBook)
      if (stopBook && stopRoot === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      const here = stopRoot ?? CELLS_KEY
      /*
       * The host can always stop the kernel. So can whoever started the cell
       * that is running: they are stopping their own work, only one cell runs
       * at a time in a notebook, and a seminar with no teacher in the room
       * otherwise has no way at all to end a loop that will not end itself.
       *
       * The right is asked about the WHOLE class, not about the named
       * notebook: a person who has a cell being computed in the seminar stays
       * the master of their own work, whichever tab they keep open. The
       * notebook decides what exactly stops — not who is entitled to press.
       *
       * By participant id, not by name — two students called Anna are two
       * people, and a name is not a credential.
       */
      if (payload.role !== 'host' && !startedTheRunningCell(sessionId, payload.participantId)) {
        refuse(
          ws,
          sessionId,
          payload,
          tr("server.onlyTheHostOrWhoeverStartedThe.835184"),
        )
        return
      }
      /*
       * A press on a cell names its target, a room-wide one does not.
       *
       * The button on a cell is drawn from the document's state, and the
       * document lags one round trip behind the server: a press in the gap
       * between two Run All cells fell into the "nothing is running" branch
       * and wiped out the queue of the whole room. The right is checked above
       * and still by the execution environment, not by the document: the
       * target's name permits nothing, it only narrows.
       */
      /*
       * A nameless press wipes out the queue whole — including batches others
       * put there, under the same right as "stop your own cell". That is not
       * a right but a behaviour: stop anything of your own, do not touch
       * other people's batches.
       */
      const target = optionalId(message.cellId)
      // The queue is cleared for ONE notebook — so we ask that one whose it is.
      if (!target && payload.role !== 'host' && !queueIsOnly(sessionId, payload.participantId, here)) {
        send(ws, {
          t: 'error',
          message: tr("server.otherParticipantsHaveQueuedCellsStopYour.32a330"),
        })
        return
      }
      void interruptSession(sessionId, target, here).then(() => {
        appendActivity(sessionId, payload.participantId, 'execution.interrupted', target ? { cellId: target } : {}, payload.role)
      }).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, tr("server.couldNotInterruptTheKernel.ef82bf")),
        })
      })
      return
    }

    case 'restart': {
      /*
       * A restart takes away the variables of ONE notebook — the named one;
       * without a name, the room's notebook, as with a tab opened before the
       * rollout.
       */
      const restartBook = bookOf(message)
      const restartRoot = rootOfBook(sessionId, restartBook)
      if (restartBook && restartRoot === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      /*
       * The right is by NOTEBOOK, not only by room.
       *
       * By default restart belongs to the teacher: it resets the class's
       * variables, and a room where two people work is entitled to decide
       * otherwise. But in a student's personal notebook the kernel is its own
       * and the variables are its own, and asking the teacher about them
       * means raising a hand in the middle of a lecture to redeclare `x` in
       * one's own draft. The fork lives in one place (shared/rules.ts ·
       * rulesForBook), and here we simply ask it.
       */
      if (
        !may(
          sessionId,
          rulesIn(sessionId, payload, restartRoot).restart,
          payload,
          ws,
          tr("server.onlyTheHostCanRestartTheKernel.987dcb"),
        )
      ) {
        return
      }
      void restartSession(
        sessionId,
        displayName(sessionId, payload.participantId),
        restartRoot ?? CELLS_KEY,
      ).then(() => {
        appendActivity(sessionId, payload.participantId, 'execution.restarted', {}, payload.role)
      }).catch(
        (err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, tr("server.couldNotRestartTheKernel.fc63d0")),
          })
        },
      )
      return
    }

    case 'clearOutputs': {
      /*
       * One's own cell and the whole board are different actions, and their
       * rules are different. Otherwise "erasing everything is the teacher's"
       * would forbid a student to tidy up after themselves in their own cell,
       * which nobody meant.
       */
      const one = optionalId(message.cellId)
      const book = bookOf(message)
      /*
       * A named notebook must exist: below, an unknown path means "no
       * notebook named", and that is erased outputs of ALL the room's
       * notebooks — an hour and a half of computation, removed by a press in a
       * closing tab.
       */
      const wipeRoot = rootOfBook(sessionId, book)
      if (book && wipeRoot === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      /*
       * For one's own cell — the same right as for typing in it, THE LOCK
       * INCLUDED. A cell opened by the teacher means "the room works here":
       * the hall types and runs in it, and on "clear output" read a refusal
       * about the notebook that had just been opened to them — about their
       * own half-screen traceback.
       *
       * For the whole sheet — the right of THAT notebook: in a personal one
       * the output is one's own, and its author erases it (shared/rules.ts ·
       * rulesForBook).
       */
      const allowed = one
        ? mayEditThis(sessionId, payload, ws, one)
        : may(
            sessionId,
            rulesIn(sessionId, payload, wipeRoot).wipe,
            payload,
            ws,
            whyIn(sessionId, payload, wipeRoot, tr("server.onlyTheTeacherMayEraseTheWhole.56250d")),
          )
      if (!allowed) return
      clearOutputs(sessionId, one, book)
      return
    }

    /**
     * Put a document on the shared screen.
     *
     * Anyone may always look and flip pages themselves — the room's file can
     * be downloaded by anyone in it anyway. The right here is about something
     * else: about the shared screen.
     */
    case 'board:open': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          tr("server.onlyTheTeacherMayPutADocument.482e0d"),
        )
      ) {
        return
      }
      const name = normalizePath(typeof message.name === 'string' ? message.name : '') ?? ''
      if (lectureInTheWay(sessionId, payload, ws, name)) return
      /*
       * Existence is checked here, not by the viewer: otherwise the room gets
       * a name that does not exist, and twenty people see an empty area. The
       * path itself is asked: it may be absent from the tree simply because
       * the list hit the ceiling, while the document lies on disk.
       */
      if (!name || statPath(sessionId, name)?.dir !== false) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNotInTheRoom.f557d3") })
        return
      }
      setBoard(sessionId, name)
      return
    }

    case 'board:close': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          tr("server.onlyTheTeacherMayRemoveADocument.1b7a58"),
        )
      ) {
        return
      }
      if (lectureInTheWay(sessionId, payload, ws, null)) return
      setBoard(sessionId, null)
      return
    }

    /* ------------------------------------------------------------- class */

    /**
     * End the class — and open it back up.
     *
     * The room does not close because of this: the notebook, the files, the
     * terminal feed and the Oracle's answers stay open for reading — that is
     * what people come to them for after class. Actions are closed, and they
     * close by themselves: rights checks ask for the effective rules, and
     * after the end of class those are the teacher's
     * (shared/rules.ts · rulesAfterClass).
     *
     * We do not turn off the lecture: forty minutes of markup live only in
     * memory, and losing them with a press of "End class" is a loss of work,
     * while the participant was a viewer in the lecture anyway. And we do not
     * turn off the kernel: the teacher still computes after class, a cold
     * start costs a minute, and an idle one will be tidied up by the cleanup.
     */
    case 'class:finish':
    case 'class:resume': {
      const finish = message.t === 'class:finish'
      if (payload.role !== 'host') {
        refuse(
          ws,
          sessionId,
          payload,
          finish
            ? tr("server.onlyTheTeacherMayFinishTheClass.84b1b4")
            : tr("server.onlyTheTeacherMayResumeTheClass.d3e509"),
        )
        return
      }
      /*
       * A second press is not an error: the teacher has two tabs open, and on
       * the second the button is the same. But it is not a new time either —
       * "ended at 15:40" must not move to 16:10 because the button was hit
       * once more.
       */
      if (finish === (finishedAt(sessionId) !== null)) return
      const at = finish ? Date.now() : null
      setClassFinished(sessionId, at)
      appendActivity(sessionId, payload.participantId, finish ? 'class.finished' : 'class.resumed', {}, payload.role)
      broadcast(sessionId, { t: 'class', finishedAt: at })
      /*
       * And cut off the Oracle's running turn — in the same place where it is
       * cut off by erasing the thread and deleting the seminar. Otherwise it
       * would edit files for another dozen steps in a room where everyone else
       * is read-only by now.
       *
       * The queue of cells set before the bell, however, is carried through to
       * the end — and that is not an inconsistency. The turn is cut off
       * precisely because it keeps EDITING FILES: each of its next steps
       * rewrites the room after the bell. A cell rewrites nothing — it
       * finishes computing what a person started while it was allowed, and its
       * output is exactly what people come to the room for after class. What
       * has started is carried through; starting is no longer allowed.
       */
      if (finish) stopAll(sessionId)
      return
    }

    /* ----------------------------------------------------------- lecture */

    /**
     * Start a lecture.
     *
     * The right is the same as for the shared screen: putting a document in
     * front of the whole room. There is one presenter — whoever started; a
     * second attempt takes over the console, and that is intentional: two
     * teachers in a room is common, and arguing about whose tablet is the
     * main one in the middle of a class period is impossible.
     */
    case 'lecture:start': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          tr("server.onlyTheTeacherMayLeadALecture.f44eb3"),
        )
      ) {
        return
      }
      const wanted = normalizePath(typeof message.file === 'string' ? message.file : '')
      if (!wanted || kindOf(wanted) !== 'pdf') {
        send(ws, { t: 'error', message: tr("server.chooseAPdfDocumentForTheProjector.434426") })
        return
      }
      if (!statPath(sessionId, wanted)) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
        return
      }
      /*
       * The same lecture but in other hands is a HANDOVER of the console, not
       * a start.
       *
       * A second teacher has no way to say "I'll take control": the "Take
       * control" button sends the same `lecture:start` for the same file.
       * Falling through, it would go into `startLecture` and erase everything
       * the console is taken for: the page would go back to the first one, the
       * ink — every last stroke, the lecture clock — to zero. Forty minutes of
       * markup erased by pressing "take over", and erased on the projector in
       * front of everyone.
       *
       * Only when SOMEONE ELSE is presenting: the same press on one's own
       * console means "start over", and over means from scratch. The shared
       * screen is not touched here — the document is already on it, it is the
       * same lecture.
       */
      const going = lectureOf(sessionId)
      if (going && going.file === wanted && going.by === payload.participantId) {
        /*
         * One's own document in one's own hands is NOTHING.
         *
         * "More → Change document" shows all the room's PDFs, and the one
         * running now stands in the same row. A press on it reads as "make
         * sure the right one is open", not as "start over from scratch" — and
         * it would cost forty minutes of markup and the lecture clock, erased
         * on the projector in front of everyone. Starting over means ending
         * and starting: two presses, the second of which a person makes
         * deliberately.
         */
        return
      }
      if (going && going.file === wanted) {
        /*
         * Taking the console from someone else is the teacher's business, not
         * the `board` rule's.
         *
         * The rule decides who may put a document before the hall; taking
         * control away from whoever is already presenting is a different act,
         * and in an open room where anyone puts up the board it would mean a
         * student silently taking the page, the ink and the pointer for
         * themselves in the middle of class.
         */
        if (payload.role !== 'host') {
          refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayTakeOverThe.31823b"))
          return
        }
        const taken = handOver(
          sessionId,
          wanted,
          payload.participantId,
          displayName(sessionId, payload.participantId),
          colorForId(payload.participantId),
        )
        if (taken) {
          broadcast(sessionId, { t: 'lecture', state: taken })
          // The hand changed: the previous presenter's spot no longer shows
          // the hall anything, and it will not go out by itself — they no
          // longer send frames.
          laserOff(sessionId)
          return
        }
      }
      /*
       * Next — start a NEW lecture on another document, and the running one
       * ends. Only whoever is presenting is entitled to change the document
       * for the hall: for everyone else, including a second teacher, it is
       * the erased ink of someone else's lecture, with no warning and no way
       * back. For them — "End" and then "Lecture": two presses, the second of
       * which is made deliberately.
       */
      if (lectureInTheWay(sessionId, payload, ws, wanted)) return
      /*
       * A lecture also puts its document on the shared screen — before it
       * starts.
       *
       * Not for looks: the rule "the board went away — the lecture ended"
       * above rests exactly on this being the same file. The order matters —
       * setBoard manages to close the previous lecture if it ran on another
       * document, and only then does the room learn about the new one.
       */
      setBoard(sessionId, wanted)
      const started = startLecture(sessionId, {
        file: wanted,
        by: payload.participantId,
        byName: displayName(sessionId, payload.participantId),
        color: colorForId(payload.participantId),
      })
      broadcast(sessionId, { t: 'lecture', state: started })
      /*
       * A clean sheet — and an inventory for it, even though it is empty.
       *
       * The inventory travels next to EVERY full `ink` frame, and here this
       * matters most of all: it lives in the tab longer than the ink itself
       * (the sheets in the strip are counted by it), and the previous
       * lecture's inventory, not erased by the new one, would make the
       * console keep its pages as blank sheets.
       */
      broadcast(sessionId, { t: 'ink', strokes: [] })
      broadcast(sessionId, { t: 'ink:pages', pages: [] })
      return
    }

    case 'lecture:stop': {
      if (
        !may(
          sessionId,
          getRules(sessionId).board,
          payload,
          ws,
          tr("server.onlyTheTeacherMayEndTheLecture.f996c5"),
        )
      ) {
        return
      }
      /*
       * And this is a second right, not the same one: the `board` rule decides
       * who may put a document before the hall, while ending SOMEONE ELSE'S
       * lecture is an act of a different kind. In an open room where anyone
       * puts up the board, it would otherwise turn out that a student turns
       * off the teacher's projection with one press, along with all the
       * markup.
       */
      if (payload.role !== 'host' && !isPresenter(sessionId, payload.participantId)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayEndAnotherPerson.8212a2"))
        return
      }
      stopLecture(sessionId)
      broadcast(sessionId, { t: 'lecture', state: null })
      laserOff(sessionId)
      return
    }

    /*
     * Speaker notes. The right is the host role, and that is not the same as
     * the right to present a lecture.
     *
     * Not `isPresenter`: notes are written the evening before, when there is
     * no lecture at all and nobody to present. And not the `board` rule: the
     * rule decides who may show a document to the hall, while a note is never
     * shown to the hall — in an open room where anyone puts up the board, it
     * would still remain the teacher's.
     */
    case 'notes:open': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayViewSpeakerNotes.8f7a4c"))
        return
      }
      const file = normalizePath(typeof message.file === 'string' ? message.file : '')
      if (!file) {
        send(ws, { t: 'error', message: refusedPath(message.file) })
        return
      }
      /*
       * The answer goes to one socket, not to all hosts: it answers a question
       * one tab asked. A second teacher who asked nothing would get a map for
       * a document they do not have open, and their console would replace its
       * own with it.
       */
      notesOpen.set(ws, file)
      send(ws, { t: 'notes', file, notes: notesOf(sessionId, file) })
      return
    }

    case 'notes:set': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayEditSpeakerNotes.729773"))
        return
      }
      const file = normalizePath(typeof message.file === 'string' ? message.file : '')
      if (!file) {
        send(ws, { t: 'error', message: refusedPath(message.file) })
        return
      }
      const page = Number(message.page)
      if (!Number.isFinite(page) || page < 1) {
        // Out loud too: everything that loses written text must say so.
        send(ws, { t: 'error', message: tr("server.aNoteMustBelongToADocument.783591") })
        return
      }
      const text = typeof message.text === 'string' ? message.text : ''
      if (text.length > MAX_NOTE_CHARS) {
        /*
         * Out loud, not truncated. A phrase cut off in the middle looks saved,
         * and the person learns about the loss in class, reading the stump;
         * the client holds the same ceiling with the `maxlength` field, so
         * only what bypasses the client gets here.
         */
        send(ws, {
          t: 'error',
          message: tr("server.aPageNoteMayContainUpTo.86232c", { p0: MAX_NOTE_CHARS }),
        })
        return
      }
      const at = Math.floor(page)
      setNote(sessionId, file, at, text)
      // With the same text as went into the database: `setNote` trims the
      // edges, and an empty note is its absence, and the echo must say the
      // same, otherwise the second device keeps a string of spaces where there
      // is no string.
      toHosts(sessionId, file, { t: 'notes:one', file, page: at, text: text.trim() })
      return
    }

    /**
     * The ink of one page — at a tab's request.
     *
     * Not a console action and not closed by a right: it is asked not by the
     * presenter but by whoever is watching — a tab that has fallen behind the
     * hall, and the thumbnail strip on the console. The right here is the
     * same as for the welcome batch, which carries this very ink: whoever is
     * in the room sees the lecture.
     *
     * An empty list is a legitimate answer and means "the page is clean". By
     * it the tab closes the question and does not ask about this page a
     * second time; silence would leave it waiting for ink until the end of
     * the lecture — and asking again on every movement of the pen.
     */
    case 'ink:page': {
      // As with the pointer: `Number` of a foreign field gives NaN, and
      // `JSON.stringify` writes it as `null`, and the tab would take an answer
      // about "page null" for an answer about its own.
      const asked = Number(message.page)
      if (!Number.isFinite(asked)) return
      const page = Math.trunc(asked)
      // The held pieces go ahead of the answer: the page travels whole, and
      // points appended to it right after would reach the asker twice.
      flushInk(sessionId)
      send(ws, { t: 'ink:page', page, strokes: inkPageOf(sessionId, page) })
      return
    }

    /*
     * Next — what the CONSOLE controls. The right is not asked here: the
     * page, the ink and the pointer are moved by whoever is presenting, and
     * only by them — while the class is in progress (see `atTheRemote`). The
     * refusal is silent — this is not a teacher's decision that needs
     * telling, but a message from a tab that does not yet know that someone
     * else is presenting or that the bell has rung.
     */
    case 'lecture:page': {
      if (!atTheRemote(sessionId, payload)) return
      const turned = turnTo(sessionId, Number(message.page))
      if (!turned) return
      broadcast(sessionId, { t: 'lecture', state: turned })
      /*
       * And the markup of the new page — right after the state, to everyone
       * at once.
       *
       * This is not an optimisation but a condition: after the welcome batch
       * was trimmed the hall does not have this page's ink, and everyone can
       * ask for it themselves — five hundred questions on every page turn,
       * that is, exactly the broadcast round the batch was trimmed for. So the
       * tab waits for the follow-up (InkLayer · INK_WAIT_MS) and asks only if
       * it did not get it.
       *
       * One frame for everyone, regardless of who already has what: a page is
       * the unit of delivery, and `ink:page` replaces it whole, so receiving
       * the same thing a second time is harmless. A clean sheet costs an empty
       * list — tens of bytes.
       */
      broadcast(sessionId, {
        t: 'ink:page',
        page: turned.page,
        strokes: inkPageOf(sessionId, turned.page),
      })
      return
    }

    case 'lecture:blank': {
      if (!atTheRemote(sessionId, payload)) return
      const blanked = setBlank(sessionId, message.on === true)
      if (blanked) broadcast(sessionId, { t: 'lecture', state: blanked })
      return
    }

    case 'ink': {
      if (!atTheRemote(sessionId, payload)) return
      const added = addInk(sessionId, {
        id: optionalId(message.id) ?? '',
        page: Number(message.page),
        color: typeof message.color === 'string' ? message.color.slice(0, 32) : '#000000',
        width: Number.isFinite(message.width)
          ? Math.min(0.05, Math.max(0.0005, message.width))
          : 0.004,
        points: Array.isArray(message.points) ? (message.points as number[]) : [],
      })
      if (!added) return
      /*
       * The ceiling — out loud, like an overflowing note.
       *
       * Silence here cost four seconds and eight resends of the stroke WHOLE:
       * the console could not tell a refusal from a lost frame. It now counts
       * its two ceilings itself and does not open a stroke on a full page at
       * all; what gets here is what it cannot count — points that ran out in
       * the middle of a stroke, and a divergence after a reconnect. The words
       * are shared (shared/lecture.ts · inkFullSays), so that one and the same
       * refusal does not speak in two voices.
       */
      if (added.full) {
        send(ws, { t: 'error', message: inkFullSays(added.full) })
        return
      }
      inkTo(sessionId, added.stroke)
      return
    }

    case 'ink:undo': {
      if (!atTheRemote(sessionId, payload)) return
      const page = Number(message.page)
      const dropped = undoInk(sessionId, page)
      if (dropped) broadcast(sessionId, { t: 'ink:drop', page, id: dropped })
      return
    }

    case 'ink:erase': {
      if (!atTheRemote(sessionId, payload)) return
      const page = Number(message.page)
      const id = optionalId(message.id)
      if (!id || !Number.isFinite(page)) return
      /*
       * We broadcast only what was really erased. The eraser passes over one
       * stroke a dozen times per hand movement, and "erase a stroke that is
       * not there" would make twenty browsers redraw the page for nothing —
       * that is exactly why `eraseInk` answers whether it was there.
       */
      if (eraseInk(sessionId, page, id)) broadcast(sessionId, { t: 'ink:drop', page, id })
      return
    }

    case 'ink:clear': {
      if (!atTheRemote(sessionId, payload)) return
      const page = Number.isFinite(message.page) ? Number(message.page) : undefined
      clearInk(sessionId, page)
      broadcast(sessionId, { t: 'ink:clear', page: page ?? null })
      /*
       * And a fresh inventory right after — "erase" reduces the inked pages.
       *
       * The inventory speaks of pages the tab does not hold, and it will not
       * correct itself from an `ink:clear` frame: the erased page would stay
       * in it as an extra sheet in the strip and a question about ink that no
       * longer exists. It costs tens of bytes — unlike the ink it describes.
       */
      broadcast(sessionId, { t: 'ink:pages', pages: inkedPagesOf(sessionId) })
      return
    }

    /*
     * The pointer is not stored at all: where it was a second ago is not a
     * fact about the lecture but a movement of a hand. So it is simply
     * forwarded, and a latecomer does not see it until the presenter moves
     * their hand — that is, roughly half a second later.
     */
    case 'laser': {
      if (!atTheRemote(sessionId, payload)) return
      const x = Number(message.x)
      const y = Number(message.y)
      // And the page — just like x and y: without a NaN check it goes into the
      // frame as `null` (that is how JSON writes it), and the hall draws the
      // pointer on its current page while the presenter is talking about
      // another.
      const page = Number(message.page)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(page)) return
      const shape = message.shape === 'dot' ? 'dot' : 'line'
      laserTo(sessionId, { page, x, y, shape })
      return
    }

    case 'laser:off': {
      if (!atTheRemote(sessionId, payload)) return
      laserOff(sessionId)
      return
    }

    /*
     * Editing the file tree. Four verbs and two boundaries between them.
     *
     * Creating is by the `files` rule, the same one files are uploaded by:
     * both ADD, and an open room where everyone puts in their solution is an
     * ordinary seminar. Removing and renaming are the teacher's, because both
     * REMOVE: after a rename the old path is gone exactly as a deleted file is
     * gone, and the handout the class is working through disappears for
     * everyone alike. This is not a new restriction — deletion was the
     * teacher's right before too.
     */
    case 'tree:mkdir':
    case 'tree:new': {
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      /*
       * A file named .ipynb is a request for a notebook, not for an empty
       * file. It is created as a notebook right away: otherwise the person
       * would get a file that the editor opens as a JSON string, and they
       * would have to guess what to do with it.
       *
       * And it has ITS OWN rule — `ownBooks`, not `files` — so the branch
       * stands above the folder check. This is not a bypass: `files` is about
       * the class's shared folder, where handouts and solutions are put, while
       * a student's own notebook is about their own work, and its file is
       * written by the server through the projection. A lecture where files
       * are the teacher's and own notebooks are allowed is an ordinary class
       * period, and the check in the old order made such a class impossible.
       */
      if (message.t === 'tree:new' && kindOf(wanted) === 'notebook') {
        const made = createBook(sessionId, wanted, authorOf(sessionId, payload))
        if (!made.ok) {
          send(ws, { t: 'error', message: made.why })
          return
        }
        broadcastFiles(sessionId)
        return
      }
      if (
        !may(
          sessionId,
          getRules(sessionId).files,
          payload,
          ws,
          tr("server.onlyTheTeacherMayCreateFilesIn.a33c2f"),
        )
      ) {
        return
      }
      const outcome =
        message.t === 'tree:mkdir' ? makeDir(sessionId, wanted) : makeFile(sessionId, wanted)
      if (outcome !== 'ok') {
        send(ws, { t: 'error', message: treeTrouble(outcome, wanted) })
        return
      }
      broadcastFiles(sessionId)
      return
    }

    /*
     * Duplicate a file — a copy next to it, under a free name.
     *
     * The rule is `files`, the same as for "new file" and for upload, and it
     * stands here for the same reason: a copy ADDS an entry to the folder.
     * Renaming and deletion stayed the teacher's because they remove the
     * previous path, and this does not — the original file stays after the
     * copy where it was and as it was.
     *
     * The server picks the name (`freeCopyName`), not whoever pressed. A
     * taken name here is not a refusal but the ordinary case: people
     * duplicate the same thing twice in a row, and the second copy must be
     * called "copy 2" rather than answer "already exists".
     */
    case 'tree:copy': {
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      if (
        !may(
          sessionId,
          getRules(sessionId).files,
          payload,
          ws,
          tr("server.onlyTheTeacherMayCreateFilesIn.a33c2f"),
        )
      ) {
        return
      }
      /*
       * A room notebook is a document, and the file under it is a projection,
       * written a second and a half after the last edit (collab/books.ts ·
       * WRITE_AFTER_MS). Copying its file without finishing the projection
       * means handing the person a notebook without the last cell they have
       * just typed. The copy stays an ordinary .ipynb in the folder: bringing
       * it into the room is a separate action with a separate rule
       * (`ownBooks`).
       */
      if (isBookFile(sessionId, wanted)) projectBooks(sessionId)
      const info = statPath(sessionId, wanted)
      if (!info) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
        return
      }
      if (info.dir) {
        send(ws, { t: 'error', message: tr('server.files.copyFolder') })
        return
      }
      // The per-file ceiling is the same as for upload: a copy takes up space
      // exactly like a file of the same size brought from disk.
      if (info.size > config.maxUploadBytes) {
        send(ws, {
          t: 'error',
          message: tr('server.files.copyTooBig', {
            p0: baseOf(wanted),
            p1: Math.round(config.maxUploadBytes / 1024 / 1024),
          }),
        })
        return
      }
      /*
       * And the ceiling for the whole room. Counted by a walk of the folder,
       * not by the upload counter (routes/files.ts · usedBytes): the counter
       * lives in the route, and dragging it here would mean closing two
       * modules onto each other for the sake of an action a person presses
       * once a seminar. The price of the divergence is named out loud there:
       * the counter does not know about writes from a cell anyway.
       */
      if (sessionBytes(sessionId) + info.size > config.maxSessionBytes) {
        send(ws, {
          t: 'error',
          message: tr('server.files.copyNoRoom', {
            p0: Math.round(config.maxSessionBytes / 1024 / 1024),
            p1: baseOf(wanted),
          }),
        })
        return
      }
      // The unsaved tail of an open document goes to disk before copying:
      // otherwise the copy lags behind what the person sees on screen by
      // exactly the last half second of typing. The same order as for
      // `tree:move` below.
      flushFile(sessionId, wanted)
      const landing = freeCopyName(sessionId, wanted)
      const copied = copyFile(sessionId, wanted, landing)
      if (copied !== 'ok') {
        send(ws, { t: 'error', message: treeTrouble(copied, landing, wanted) })
        return
      }
      broadcastFiles(sessionId)
      return
    }

    /*
     * Bring an .ipynb into the room.
     *
     * This is ADDING a notebook, not reading a file: a notebook brought in
     * becomes part of the room — it gets into the snapshot, the history and
     * onto everyone's screen. Its right is the same as for "new notebook",
     * and one door asks it (collab/books.ts · whyNotAddBook), so there is no
     * check here at all.
     *
     * The `files` rule does not fit here, and it was exactly the one that
     * used to stand here: a file in the folder and a notebook in the room are
     * different things. With `files: 'room'` and own notebooks turned off, an
     * .ipynb can be put into the folder but not brought into the room; with
     * `files: 'host'` and them allowed — the other way round.
     *
     * Anyone can read it with their eyes without this anyway: the file is
     * downloaded like any other.
     */
    case 'book:open': {
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      const opened = openBook(sessionId, wanted, authorOf(sessionId, payload))
      if (!opened.ok) {
        send(ws, { t: 'error', message: opened.why })
        return
      }
      if (opened.imported) broadcastFiles(sessionId)
      return
    }

    case 'tree:move': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRenameFilesIn.e04cee"))
        return
      }
      const from = normalizePath(typeof message.from === 'string' ? message.from : '')
      const to = normalizePath(typeof message.to === 'string' ? message.to : '')
      if (!from || !to) {
        send(ws, { t: 'error', message: refusedPath(from ? message.to : message.from) })
        return
      }
      /*
       * A move to nowhere is a quiet nothing.
       *
       * The mouse is released where it was picked up more often than it hits
       * a neighbouring folder. Until now such a gesture reached `movePath` and
       * came back with the phrase that "data.csv" already exists in this
       * folder — that is, it explained to the person that the file had
       * collided with itself. There is nothing to say here: nothing happened
       * and nothing broke, and a refusal out of nowhere reads as breakage.
       */
      if (from === to) return
      /*
       * A folder — not into itself. The refusal stands here, not only in
       * `movePath`, for the sake of the words: that one answers `bad-name`,
       * and the phrase came out about the name (that "src" cannot be used as
       * a name), while the name is perfectly fine — the place is not.
       * Dragging gets here every time a folder is dropped onto something
       * inside itself, that is, by missing by one row.
       */
      if (isInside(to, from)) {
        send(ws, { t: 'error', message: tr("server.cannotBePlacedInsideItself.de928c", { p0: baseOf(from) }) })
        return
      }
      // A folder may have been renamed too — then everything in it moves.
      const inside = pathsInside(sessionId, from)
      // The unsaved tail goes to disk BEFORE the move: `movePath` moves what
      // already lies on disk, and `forgetFile` below takes the document away
      // together with its postponed save. Otherwise the last half second of
      // typing is lost, and there is nobody to tell about it.
      for (const path of inside) flushFile(sessionId, path)
      const outcome = movePath(sessionId, from, to)
      if (outcome !== 'ok') {
        send(ws, { t: 'error', message: treeTrouble(outcome, to, from) })
        return
      }
      for (const was of inside) {
        const now = to + was.slice(from.length)
        /*
         * One path does not break off the others.
         *
         * The files on disk have already moved — all at once, with one
         * `rename` — and a refusal in the middle of the list leaves the room
         * half on the old paths: the notebook at the new address, the
         * projector at the old one, and not a word about why. Notes are the
         * only ones here that go to the database, that is, the only ones that
         * can really refuse; they settle a dispute over a taken key in favour
         * of the moving file (db.ts · moveNotes, `UPDATE OR REPLACE`), so
         * there is nothing more to lose here — but the catch is useful in
         * itself: the board and the projector must not fall together with one
         * SQL line.
         */
        try {
          // The document of the old path no longer looks at anything: it has
          // nothing on disk, and the next save would resurrect the file under
          // its old name. The watcher will notice this by itself, but not
          // sooner than in two seconds — while the tabs open on it must learn
          // at once.
          forgetFile(sessionId, was)
          // The notebook moves together with its file: the same root, a new path.
          moveBook(sessionId, was, now)
          const moved = moveLecture(sessionId, was, now)
          if (moved) broadcast(sessionId, { t: 'lecture', state: moved })
          // The lecture moves before the board on purpose: `setBoard` ends the
          // lecture if the document on screen has diverged from its file.
          if (boardOf(sessionId) === was) setBoard(sessionId, now)
          /*
           * And the speaker notes — they are bound to the document's path, not
           * to the lecture.
           *
           * Renaming a file in the middle of class is common: the teacher
           * changes "lecture3.pdf" to "Lecture 3. Flux and divergence.pdf".
           * Without this line an evening spent on the talk for twenty-four
           * pages turns into rows that no longer have a key: the old path is
           * no longer on disk, and there is no way to restore them from the
           * interface.
           *
           * Last in the list: only they go to the database, which means only
           * they can really refuse.
           */
          moveNotesTo(sessionId, was, now)
        } catch {
          /* see above: this path did not move whole, the others still move */
        }
      }
      broadcastFiles(sessionId)
      return
    }

    case 'tree:remove': {
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      if (!wanted) {
        send(ws, { t: 'error', message: refusedPath(message.path) })
        return
      }
      /*
       * Files are removed from the room by the teacher — and by the author of
       * THEIR OWN personal notebook.
       *
       * There is exactly one exception, and without it "one's own notebook"
       * would be a half-truth: a draft the student created themselves and
       * that counts against their own ceiling (`MAX_OWN_BOOKS`) must be
       * removable by them, otherwise three failed attempts lock them out
       * until the end of class. Someone else's personal one — no, the room's
       * notebook — no, any other file — no.
       */
      if (payload.role !== 'host' && !ownsBookAt(sessionId, wanted, payload.participantId)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRemoveAFile.77a4ef"))
        return
      }
      // The panel promises "remove the folder with everything in it", and the
      // promise is kept here: the list is computed before the deletion,
      // because after it there is nothing left to ask the tree about.
      const inside = pathsInside(sessionId, wanted)
      if (!deleteFile(sessionId, wanted)) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
        return
      }
      for (const path of inside) {
        forgetFile(sessionId, path)
        // Otherwise a notebook that lay inside the folder would stay in the
        // room — and a second and a half later the projection would create
        // the folder and the file anew.
        dropBook(sessionId, path)
      }
      forgetMissingBoard(sessionId)
      broadcastFiles(sessionId)
      return
    }

    /*
     * The whole tree — to whoever asked.
     *
     * It is asked in one case: a delta arrived and there is nothing to glue it
     * to. There is no right here and there cannot be — the socket gets this
     * same list in the welcome batch. The frame is taken from the room's
     * shared memory: if everyone saw the gap at once, there will still be only
     * one folder walk.
     */
    case 'files:ask': {
      const frame = filesFrame(sessionId)
      if (frame !== null) sendFrame(ws, frame)
      return
    }

    /*
     * Running a script. The right is the same as for a cell: it is the same
     * container, the same Python and the same someone else's machine. The
     * only difference is that the output goes to the terminal, not to a cell.
     */
    case 'file:run': {
      if (!mayRun(sessionId, payload, ws)) return
      const wanted = normalizePath(typeof message.path === 'string' ? message.path : '')
      const runner = wanted ? runnerFor(wanted) : null
      if (!wanted || !runner) {
        send(ws, { t: 'error', message: tr("server.onlyPyAndShFilesCanBe.fb990d") })
        return
      }
      if (!statPath(sessionId, wanted)) {
        send(ws, { t: 'error', message: tr("server.thisFileIsNoLongerInThe.b66e1e") })
        return
      }
      /*
       * First to disk, then run: Cmd+Enter comes from the editor itself and
       * overtakes the postponed save, while `python` reads the disk. Otherwise
       * the text runs without the last typed lines — and that is the worst
       * kind of error: it is about a line that looks right on screen, and on
       * the second press everything works "by itself".
       */
      flushFile(sessionId, wanted)
      /*
       * Single quotes with escaping: the file name is typed by a person, and
       * it may have a space, a parenthesis and an apostrophe. The string goes
       * into the same shell as everything people type in the terminal by hand
       * — with the difference that this string the person did not type and
       * could not see before the run.
       */
      const quoted = `'${wanted.replace(/'/g, `'\\''`)}'`
      runCommand(
        sessionId,
        runner === 'python' ? `python -u ${quoted}` : `bash ${quoted}`,
        sender(sessionId, payload.participantId),
      )
      return
    }

    /*
     * Moving a cell is a server operation, and necessarily so: see
     * `collab/ops.ts`. The right is checked here, not in the classifier,
     * because this verb no longer exists in the document at all.
     */
    /*
     * Undo an Oracle turn: return the files to what they were before it.
     *
     * The right is almost the same as for the "do" mode itself: whoever could
     * start it can also undo it — "allowed to start but not allowed to roll
     * back" would be the worst possible pair. There is one difference, and it
     * is about `off`: the rules change in a live room, and the natural move
     * "the Oracle made a mess → I turn off the Oracle → I roll back" ran into
     * a refusal, which on top of that said "the teacher may" to that very
     * teacher. A turned-off mode stops further actions; the teacher is always
     * entitled to clean up after what has already started.
     */
    case 'ai:undo': {
      if (payload.role !== 'host' && !allowsAgent(getRules(sessionId).agent, payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayUndoAnOracle.a064cd"))
        return
      }
      const entryId = optionalId(message.entryId)
      if (!entryId) return
      const touched = undoTurn(sessionId, entryId, displayName(sessionId, payload.participantId))
      if (touched === null) {
        send(ws, {
          t: 'error',
          message:
            tr("server.thisActionCanNoLongerBeUndone.29f138"),
        })
      }
      return
    }

    case 'cells:move': {
      const id = typeof message.cellId === 'string' ? message.cellId : ''
      const direction =
        message.direction === -1 || message.direction === 1 ? message.direction : null
      if (!id || direction === null) return
      /*
       * The structure — by the rules of THE notebook where the move happens:
       * the move does not leave its bounds (`moveInCells` moves within one
       * sheet), and asking the room about it would mean forbidding a student
       * to rearrange cells in their own notebook.
       */
      const root = rootOf(sessionId, id)
      if (!allowsStructure(rulesIn(sessionId, payload, root).structure, payload.role, 'move')) {
        refuse(
          ws,
          sessionId,
          payload,
          whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayReorderCellsIn.601caf")),
        )
        return
      }
      // On behalf of whoever pressed: the version in history must have an author.
      const { doc } = getSessionDoc(sessionId)
      applyOnBehalf(sessionId, payload.participantId, () => {
        moveInCells(doc, id, direction)
      })
      return
    }

    /*
     * The lock on a cell: the teacher opens one, and in it the room types and
     * runs — in a lecture notebook where everything else is theirs.
     *
     * The right is simple and is not expressed by a room rule: it is opened
     * by whoever owns the notebook, that is, the teacher. A rule here would be
     * a rule about who hands out rights — and RoomRules has no such thing and
     * there is no reason to create one.
     */
    case 'cell:open':
    case 'cell:lock': {
      if (payload.role !== 'host') {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayOpenCells.27de8a"))
        return
      }
      /*
       * And not in a finished class. An open cell is a promise to the room
       * that it may work here; after the bell it may not anywhere
       * (shared/rules.ts · rulesAfterClass), and the promise would turn out
       * empty: the lock is open, while Run answers "the class is over". An
       * empty promise is worse than a refusal — people follow it and run into
       * a wall.
       */
      if (isFinished(sessionId)) {
        send(ws, { t: 'error', message: tr(OVER) })
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      /*
       * `cell:open` is a special case with two positions, and it is read by
       * the same code: two handlers of one lock would drift apart on the
       * first edit.
       */
      let state: CellLock
      let settings: Partial<CouncilSettings> = {}
      if (message.t === 'cell:open') {
        if (typeof message.open !== 'boolean') return
        /*
         * One click on the lock opens the way the room is set up: in a
         * lecture — the shared text, in a council — everyone their own sheet
         * (shared/rules.ts · opens). The lock menu sends `cell:lock` with an
         * explicit position and does not ask this rule.
         */
        const opens = getRules(sessionId).opens
        state = message.open ? (opens === 'council' ? 'council' : 'open') : 'closed'
      } else {
        if (message.state !== 'closed' && message.state !== 'open' && message.state !== 'council') {
          return
        }
        state = message.state
        settings = pickSettings(message.settings)
      }
      const { doc } = getSessionDoc(sessionId)
      const found = findCell(doc, id)
      if (!found) {
        send(ws, { t: 'error', message: tr("server.thisCellIsNoLongerInThe.3462ea") })
        return
      }
      const was = cellLock(found.cell)
      /*
       * The knobs: not applied — as they were; a cell in council for the
       * first time — the defaults (readCouncilSettings returns them from
       * nothing). A repeated `cell:lock` with the same position and new knobs
       * is exactly "switch a knob".
       */
      const prior = readCouncilSettings(found.cell.get('council'))
      /*
       * The merged knobs go THROUGH the sanitiser, not as they came.
       *
       * `pickSettings` has already thrown out anything unclear from the
       * message, but to the left of it stands what lies in the document, and
       * everyone in the room writes to the document. A cell with
       * `runLimitSec: "lots"` that arrived bypassing this handler would reach
       * the kernel and set an alarm there for NaN — that is, silently remove
       * the limit. The sanitiser here is that one door behind which only
       * valid knobs lie in the document.
       */
      const next: CouncilSettings | null =
        state === 'council' ? readCouncilSettings({ ...prior, ...settings }) : null
      // A repeated press is not an event: an extra version in history for
      // every click on an already open cell tells nothing.
      const sameKnobs =
        next === null ||
        (next.studentRun === prior.studentRun &&
          next.namesOnProjector === prior.namesOnProjector &&
          next.runLimitSec === prior.runLimitSec &&
          next.rerunPauseSec === prior.rerunPauseSec)
      if (was === state && sameKnobs) return
      if (was !== state || next?.studentRun !== prior.studentRun) {
        clearRunRequests(sessionId, id)
      }
      /*
       * THE TASK — taken here, on the very switch to council, and only there.
       *
       * The cell's shared text at this second is what the teacher gave the
       * class; a minute later it will not be: "Show the class" puts someone's
       * solution into the cell (see `council:show` below). A latecomer, or
       * someone who just reloaded the page, seeded their sheet with what lies
       * in the cell NOW — that is, with someone else's answer, and one press
       * of "Submit" sent it into the author's group.
       *
       * Not on every press: `cell:lock` with the same position is a knob
       * toggle, and rewriting the task with it would bring back exactly the
       * same swap. An empty string is a legitimate task: the council was
       * opened on an empty cell, "write it yourselves".
       */
      if (was !== 'council' && state === 'council') {
        rememberSeed(sessionId, id, cellSource(found.cell).toString())
      }
      /*
       * On behalf of the server, like `state` and `outputs` of the same cell:
       * `open` is a right, not someone's typing, and it has no author. The
       * `council` key is written only where it exists or is needed: for a
       * cell that has never been a council, `null` in it tells nothing.
       */
      doc.transact(() => {
        found.cell.set('open', openValueFor(state))
        if (next !== null || found.cell.get('council') != null) found.cell.set('council', next)
      }, ORIGIN)
      /*
       * A limit changed in the middle of someone's run applies to that run
       * too.
       *
       * "The rules apply at once" is a promise to the whole room, and the run
       * limit cannot be an exception to it: the teacher sets it while LOOKING
       * at a hung loop, and waiting for the end of that very loop is the one
       * thing they do not want at that second. The new limit is counted from
       * the start of the running attempt, so "thirty seconds" on an attempt
       * running for a minute fires at once (kernel/index.ts ·
       * retimeCouncilRun).
       */
      if (next !== null && next.runLimitSec !== prior.runLimitSec) {
        retimeCouncilRun(sessionId, id, next.runLimitSec)
      }
      /*
       * The council was opened, switched or closed — the room has to be told
       * over the control wire: attempts are not in the document, and a
       * student would otherwise learn about the closing only from a refusal on
       * the next snapshot. Closing does not erase attempts — they remain for
       * viewing (a board with lock: 'closed'), and the author gets
       * `closed: true`, and the text stays with them as a draft.
       */
      if (was === 'council' || state === 'council') councilChanged(sessionId, id)
      return
    }

    /*
     * Council: a student's own sheet.
     *
     * The right is `mayWriteCouncil`: the room's rules have nothing to do
     * with it (one's own sheet is created exactly where the shared text is
     * the teacher's), only a closed lock and the end of class stop it. A
     * snapshot into a cell without a council is refused in the same words as
     * the grey button on the client.
     */
    case 'council:draft':
    case 'council:submit':
    case 'council:withdraw': {
      const id = optionalId(message.cellId)
      if (!id) return
      const { lock } = councilCellOf(sessionId, id)
      if (!mayWriteCouncil(payload.role, isFinished(sessionId), lock !== 'council')) {
        if (lock !== 'council') send(ws, { t: 'error', message: `${COUNCIL_CLOSED()}.` })
        else refuse(ws, sessionId, payload, COUNCIL_CLOSED())
        return
      }
      const before = countFor(sessionId, id)
      const now = Date.now()
      if (message.t === 'council:draft') {
        if (typeof message.text !== 'string') return
        if (message.text.length > MAX_ATTEMPT_CHARS) {
          // Out loud, not truncated: code silently cut off looks whole on screen.
          send(ws, {
            t: 'error',
            message: tr("server.anAttemptMayContainUpToCharacters.ff604b", { p0: MAX_ATTEMPT_CHARS }),
          })
          return
        }
        /*
         * The text changed — a waiting run is taken out of the queue.
         *
         * `saveDraft` honestly removes from the attempt everything that was
         * said about the previous text, and `recordRun` throws away a late
         * frame — but the entry in the queue stayed, and that cost twice. For
         * the kernel — a minute on code that no longer exists, with one queue
         * for the whole cohort. For the author — a refusal "this attempt is
         * already in the queue" on an attempt to run the NEW version: until
         * the old source finishes computing, there is nothing to rerun.
         */
        const prior = attemptOf(sessionId, id, payload.participantId)
        const priorText = prior?.text
        if (priorText !== undefined && priorText !== message.text) {
          cancelCouncilRun(sessionId, id, payload.participantId)
        }
        saveDraft(sessionId, id, payload.participantId, message.text, now)
        /*
         * The author rewrote the shown text — the badge on screen is no longer
         * about anything.
         *
         * `saveDraft` honestly removes "on screen" together with the run and
         * the mark (they are glued to the text), but the room learned about it
         * only from the author's own sheet: for the others, code that nobody
         * has any more kept hanging under the cell.
         */
        if (prior?.shown && priorText !== message.text) shownOut(sessionId, id)
      } else if (message.t === 'council:submit') {
        const alreadySubmitted = attemptOf(sessionId, id, payload.participantId)?.submittedAt != null
        if (!submitAttempt(sessionId, id, payload.participantId, now)) {
          send(ws, { t: 'error', message: tr("server.theAttemptIsEmptyWriteYourSolution.f38771") })
          return
        }
        if (!alreadySubmitted) appendActivity(sessionId, payload.participantId, 'council.submitted', { cellId: id, source: 'participant' }, payload.role)
      } else {
        const wasSubmitted = attemptOf(sessionId, id, payload.participantId)?.submittedAt != null
        if (!withdrawAttempt(sessionId, id, payload.participantId)) return
        if (wasSubmitted) appendActivity(sessionId, payload.participantId, 'council.withdrawn', { cellId: id, source: 'participant' }, payload.role)
      }
      mineOut(sessionId, id, payload.participantId)
      boardOut(sessionId, id, [payload.participantId])
      // The counter goes to the room, and only when it changed: a snapshot on
      // a pause in typing does not move the counter, and a frame for each
      // would be twenty browsers for nothing.
      const after = countFor(sessionId, id)
      if (after.total !== before.total || after.submitted !== before.submitted) {
        countOut(sessionId, id)
      }
      return
    }

    /*
     * Council: what the leader does. One right for everything —
     * `mayLeadCouncil`, and after the bell too: what was submitted remains
     * for viewing, and reviewing it after class is the teacher's business.
     */
    case 'council:show':
    case 'council:show:clear': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      const clearing = message.t === 'council:show:clear'
      const target = clearing ? null : (optionalId(message.participantId) ?? null)
      if (!clearing && target === null) return
      if (target !== null && !attemptOf(sessionId, id, target)) {
        send(ws, { t: 'error', message: tr("server.thisAttemptNoLongerExists.b490bf") })
        return
      }
      /*
       * The cell's shared text is NOT touched when showing — that is the whole
       * fix.
       *
       * "Show the class" used to rewrite the cell's `source` with the
       * attempt's text as an ordinary edit on behalf of the teacher: the
       * template disappeared for everyone, the document history named the
       * presenter as the author, there was no undo (only typing by hand), and
       * nothing on screen said that this was someone's solution. Now showing
       * is a mark on the attempt plus a signed frame to the room
       * (`council:shown`), and the cell stays a cell.
       */
      // Who was shown before: it tells "showed someone else" from "pressed on
      // the same one again" — the second updates the caption time but does
      // not become an event in the history.
      const before = shownWho(sessionId, id)
      const changed = setShown(sessionId, id, target, clearing ? null : payload.participantId, Date.now())
      // Nothing to remove — and nothing to say: the room does not need a "no
      // badge" frame where there was none. But SHOWING is always resent, even
      // when nothing changed in the row: "Show again" on the card means
      // exactly "refresh the caption", and "K more wrote the same" is
      // recomputed on it.
      if (clearing && changed.length === 0) return
      const touched = target === null ? changed : [...new Set([...changed, target])]
      for (const participantId of touched) mineOut(sessionId, id, participantId)
      boardOut(sessionId, id, touched)
      shownOut(sessionId, id)
      /*
       * Into the history — both ends: "put a solution on screen" and "took it
       * off". Who decided whose code the class will see, and whose code it
       * was — the same as "suggested a cell for review" next to it, only from
       * the presenter's side. `subjectId` is the author of what was shown, the
       * actor is the teacher.
       */
      if (clearing) {
        appendActivity(sessionId, payload.participantId, 'council.unshown',
          { cellId: id, ...(before ? { subjectId: before } : {}) }, payload.role)
      } else if (before !== target) {
        appendActivity(sessionId, payload.participantId, 'council.shown',
          { cellId: id, ...(target ? { subjectId: target } : {}) }, payload.role)
      }
      return
    }

    case 'council:run:request': {
      const id = optionalId(message.cellId)
      if (!id) return
      const { lock, settings } = councilCellOf(sessionId, id)
      if (payload.role === 'host' || settings.studentRun !== 'request' ||
          !mayWriteCouncil(payload.role, isFinished(sessionId), lock !== 'council')) {
        send(ws, { t: 'error', message: tr("server.youCanRequestARunOnlyIn.dfdda0") })
        return
      }
      const attempt = attemptOf(sessionId, id, payload.participantId)
      if (!attempt?.text.trim()) {
        send(ws, { t: 'error', message: tr("server.writeYourSolutionFirst.b04f1e") })
        return
      }
      /*
       * The pause is asked on the REQUEST, not on the approval.
       *
       * Otherwise it would punish the teacher: the queue of requests piles up,
       * they review it a minute later — and half of the approvals run into a
       * pause that was already waited out while the request was lying there.
       * The student, however, learns about it where they press, and their
       * countdown under the button runs from the end of their run.
       */
      const waitUntil = nextRunAtFor(sessionId, id, payload.participantId, settings.rerunPauseSec)
      if (waitUntil !== null) {
        send(ws, { t: 'error', message: rerunPauseNote(waitUntil) })
        return
      }
      if (councilQueuePosition(sessionId, id, payload.participantId) !== null ||
          !requestAttemptRun(sessionId, id, payload.participantId, Date.now())) {
        send(ws, { t: 'error', message: tr("server.theAttemptIsAlreadyRunningOrQueued.fc3fa7") })
        return
      }
      mineOut(sessionId, id, payload.participantId)
      boardOut(sessionId, id, [payload.participantId])
      return
    }

    case 'council:run:cancel':
    case 'council:run:decline': {
      const declining = message.t === 'council:run:decline'
      if (declining && !mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayReviewRunRequests.630a48"))
        return
      }
      const id = optionalId(message.cellId)
      const requestId = optionalId(message.requestId)
      const target = declining ? optionalId(message.participantId) : payload.participantId
      if (!id || !requestId || !target) return
      if (!resolveRunRequest(sessionId, id, target, requestId, declining ? 'decline' : 'clear')) {
        send(ws, { t: 'error', message: tr("server.theRequestHasChangedOrHasAlready.aa2b45") })
        return
      }
      mineOut(sessionId, id, target)
      boardOut(sessionId, id, [target])
      return
    }

    case 'council:run:drop': {
      /*
       * Take down someone else's waiting run — without touching the person.
       *
       * The only button on someone else's queue entry used to be "Remove from
       * class": freeing the queue from a run queued by mistake was possible
       * only together with its author. Here the work is taken down and
       * nothing more — the attempt's text stays, the author stays, the right
       * to run stays.
       */
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      const target = optionalId(message.participantId)
      if (!id || !target) return
      if (!cancelCouncilRun(sessionId, id, target)) {
        // One that went into the kernel cannot be reached from here: it is
        // stopped by "Interrupt", and that has to be said with the same word
        // that is written on the button.
        send(ws, { t: 'error', message: tr("server.theAttemptIsAlreadyRunningOrQueued.fc3fa7") })
        return
      }
      /*
       * To the author — in words. A run that disappeared from the card
       * silently reads as breakage: the person pressed, saw "queued", and a
       * minute later there is no queue and no output.
       */
      tell(sessionId, target, { t: 'error', message: tr('server.council.runDropped') })
      mineOut(sessionId, id, target)
      boardOut(sessionId, id, [target])
      tellQueued(sessionId)
      return
    }

    case 'council:run:approve':
    case 'council:run': {
      const approving = message.t === 'council:run:approve'
      if (approving && !mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayReviewRunRequests.630a48"))
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      const target = optionalId(message.participantId) ?? payload.participantId
      const own = target === payload.participantId
      if (!own && !mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRunAnotherParticipant.982a38"))
        return
      }
      const { lock, settings } = councilCellOf(sessionId, id)
      if (approving && (settings.studentRun !== 'request' || lock !== 'council' || isFinished(sessionId))) {
        send(ws, { t: 'error', message: tr("server.runRequestsAreNowClosed.f23dc6") })
        return
      }
      if (!mayRunCouncil(payload.role, settings.studentRun, isFinished(sessionId))) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayRunAttemptsIn.fbe78a"))
        return
      }
      // A student — only while the council is running; the teacher computes
      // during review too.
      if (payload.role !== 'host' && lock !== 'council') {
        send(ws, { t: 'error', message: `${COUNCIL_CLOSED()}.` })
        return
      }
      const attempt = attemptOf(sessionId, id, target)
      if (!attempt) {
        send(ws, {
          t: 'error',
          message: own ? tr("server.writeYourAttemptFirst.746013") : tr("server.thisAttemptNoLongerExists.b490bf"),
        })
        return
      }
      if (approving && (attempt.runRequest?.status !== 'pending' ||
          attempt.runRequest.id !== optionalId(message.requestId))) {
        send(ws, { t: 'error', message: tr("server.theRequestHasChangedOrHasAlready.2ee147") })
        return
      }
      /*
       * The pause between one's own runs — only one's own, and never for the
       * teacher.
       *
       * The teacher never waits: they run someone else's attempt while
       * reviewing it at the board, and the author's pause has nothing to do
       * with that press — nor with approving a request that was asked on it.
       */
      if (payload.role !== 'host' && own) {
        const waitUntil = nextRunAtFor(sessionId, id, target, settings.rerunPauseSec)
        if (waitUntil !== null) {
          send(ws, { t: 'error', message: rerunPauseNote(waitUntil) })
          return
        }
      }
      const outcome = requestCouncilRun(
        sessionId,
        {
          cellId: id,
          participantId: target,
          source: attempt.text,
          by: payload.role === 'host' ? 'host' : 'author',
          /*
           * The limit is taken from the cell at the second of the press and
           * travels with the job: the kernel does not read the document
           * (kernel/council.ts · CouncilJob.limitSec). It applies to the
           * teacher's runs too: heavy code does not get lighter depending on
           * who pressed, and the kernel is one for the whole notebook.
           */
          limitSec: settings.runLimitSec,
          /*
           * Every kernel frame goes to the attempt and to the two people who
           * can see it. After a run ends the queue has moved — those waiting
           * get their new number.
           */
          onChange: (run: CouncilRun | null) => {
            /*
             * A frame that did not land is not broadcast to anyone.
             *
             * `recordRun` answers `false` in two cases: the attempt is gone
             * (a ban) and the frame is late — while the run waited in the
             * queue, the author changed the text, and the output belongs to
             * the previous one. Before, `mineOut`/`boardOut` still followed a
             * thrown-away frame: an empty delta into every socket of the room,
             * three per attempt. The queue did move for real, though — that
             * has to be told.
             */
            const landed = recordRun(sessionId, id, target, run)
            const over = run === null || run.state === 'ok' || run.state === 'error'
            if (!landed) {
              if (over) tellQueued(sessionId)
              return
            }
            mineOut(sessionId, id, target)
            boardOut(sessionId, id, [target])
            // The run of whoever is on screen has finished — its output
            // appears under the badge for the whole room. Intermediate frames
            // do not go into the badge (`shownFor` takes only a finished one),
            // and there is nowhere to send them.
            if (over && shownWho(sessionId, id) === target) shownOut(sessionId, id)
            if (over) tellQueued(sessionId)
          },
        },
        displayName(sessionId, payload.participantId),
        payload.participantId,
      )
      if (!outcome.queued) {
        /*
         * The refusal says WHAT exactly is busy. Three cases and three
         * different phrases: this same attempt is already being computed,
         * this same one is in the queue — and, recently, their work on
         * ANOTHER cell of this notebook is in the queue (kernel/index.ts ·
         * the "one run per person in flight" ceiling). One phrase for all
         * three would send the person looking for their attempt where it is
         * not.
         */
        const here = councilQueuePosition(sessionId, id, target)
        send(ws, {
          t: 'error',
          message:
            outcome.position === 0
              ? tr("server.thisAttemptIsAlreadyRunning.0efa94")
              : here !== null
                ? tr("server.thisAttemptIsAlreadyQueuedAtPosition.0c6a86", { p0: outcome.position })
                : tr('server.council.alreadyQueuedHere', { p0: outcome.position }),
        })
      }
      return
    }

    case 'council:reply': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      if (!id) return
      const text = typeof message.text === 'string' ? message.text.trim() : ''
      if (!text) return
      if (text.length > MAX_REPLY_CHARS) {
        send(ws, { t: 'error', message: tr("server.aReplyMayContainUpToCharacters.1d0ef3", { p0: MAX_REPLY_CHARS }) })
        return
      }
      /*
       * The recipient is only a person. Sending to a group of identical
       * solutions ("All N") was removed together with the grouping itself: a
       * letter written about someone's text reached people who had not
       * written it — only the code matched after normalisation. An old client
       * that sends `{groupKey}` gets silence, not a group message: better not
       * to send than to send to the wrong people.
       */
      const to = message.to as { participantId?: unknown } | undefined
      const participantId = optionalId(to?.participantId)
      if (participantId === undefined) return
      const address = { participantId }
      // The teacher's signature, not the Oracle's: the model's draft arrives
      // here already as edited text, and in the student's feed it is a person
      // who answers.
      const reply = { text, at: Date.now(), by: displayName(sessionId, payload.participantId) }
      const told = setReply(sessionId, id, address, reply)
      if (told.length === 0) {
        send(ws, { t: 'error', message: tr("server.thereIsNobodyToReplyToThis.efbb65") })
        return
      }
      for (const who of told) mineOut(sessionId, id, who)
      boardOut(sessionId, id, told)
      return
    }

    case 'council:mark': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      const target = optionalId(message.participantId)
      if (!id || !target) return
      const correct =
        message.correct === null || typeof message.correct === 'boolean'
          ? message.correct
          : undefined
      if (correct === undefined) return
      setMark(sessionId, id, target, correct)
      mineOut(sessionId, id, target)
      boardOut(sessionId, id, [target])
      // The mark also sits in the corner of the projector card: "correct",
      // said out loud, stays on screen longer than the voice.
      if (shownWho(sessionId, id) === target) shownOut(sessionId, id)
      return
    }

    /*
     * An attempt whole — with the output that was not in the pile.
     *
     * The full pile has an output budget (`withinBudget`): with five hundred
     * run attempts a frame with all the images weighs tens of megabytes,
     * while the console draws them one at a time, when a card is expanded.
     * This is the second half of the deal — "show me this one".
     *
     * The right is the same as for the whole pile: only the leader sees
     * someone else's attempt. The answer is an ordinary delta, which the
     * console already knows how to put into the pile. The attempt is gone —
     * we stay silent: it may have been banned, and `removed` has already gone
     * out.
     */
    /*
     * "Oracle hint" — to one student about their own failed attempt.
     *
     * Over the socket, not `/ai/ask`, and that is a load-bearing decision:
     * that route writes the question and the answer into the room's SHARED
     * thread, while council texts are private — the question "why does mine
     * fail" together with the code would go where forty neighbours will read
     * it. The answer comes back as a letter inside the attempt itself: it is
     * seen by the same two people who see its text, and it survives a reload.
     *
     * Someone else's attempt cannot be asked about by the frame's design:
     * participantId is not named in it at all, it is taken from the token.
     */
    case 'council:hint': {
      const id = optionalId(message.cellId)
      if (!id) return
      const author = payload.participantId
      const hintState = (asking: boolean, error?: string) =>
        send(ws, error === undefined
          ? { t: 'council:hint:state', cellId: id, asking }
          : { t: 'council:hint:state', cellId: id, asking, error })
      if (councilCellOf(sessionId, id).lock !== 'council') {
        hintState(false, tr("server.council.hintNotInCouncil"))
        return
      }
      const attempt = attemptFor(sessionId, id, author)
      /*
       * A hint is given on a FAILED run, and only on it: without a traceback
       * there is nothing to ask, and "look at my code and tell me whether it
       * is right" is solving it for the student — exactly what the council is
       * protected from.
       */
      if (!attempt || !runFailed(attempt.run)) {
        hintState(false, tr("server.council.hintNeedsError"))
        return
      }
      const refusal = oracleDoor(sessionId, payload) ?? oracleCapacity(sessionId, payload.role)
      if (refusal) {
        hintState(false, refusal.error)
        return
      }
      if (hintsReading.has(`${sessionId}:${id}:${author}`)) return
      hintsReading.add(`${sessionId}:${id}:${author}`)
      hintState(true)

      // The problem statement usually lies in the markdown cell above the
      // task; the template is in `council_seed`, because by this time it may
      // no longer be in the cell itself ("Show the class" puts someone else's
      // solution there).
      const before = (() => {
        const found = findCell(getSessionDoc(sessionId).doc, id)
        if (!found || found.index === 0) return null
        const above = found.cells.get(found.index - 1)
        return above ? cellSource(above).toString() : null
      })()
      /*
       * The spending line — on acceptance, as for `/ai/ask`: the request to
       * the provider will go out however it ends. Its own action in the
       * accounting: a hint must not hide among "asked" in the panel's
       * breakdown.
       */
      const usageId = recordQuestion({ sessionId, participantId: author, action: 'hint' })
      appendActivity(sessionId, author, 'oracle.asked', { action: 'hint', source: 'participant', cellId: id })
      const releaseCapacity = holdOracleHint(sessionId)

      void askCouncilHint({
        before,
        stub: seedOf(sessionId, id),
        attempt: attempt.text,
        run: attempt.run,
        usageId,
      })
        .then((text) => {
          if (!text) {
            hintState(false, tr("server.theModelReturnedAnEmptyResponseTry.c365b1"))
            return
          }
          setHint(sessionId, id, author, { text, at: Date.now(), by: tr('server.council.oracleName') })
          hintState(false)
          mineOut(sessionId, id, author)
          // The teacher sees the hint too: it is part of the attempt, and in a
          // review it shows what the person has already heard.
          boardOut(sessionId, id, [author])
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message.trim() : String(err)
          console.error(`[session ${sessionId}] council hint failed:`, reason)
          hintState(false, reason || tr("server.theOracleDidNotRespondCheckThe.e430c5"))
        })
        .finally(() => {
          releaseCapacity()
          hintsReading.delete(`${sessionId}:${id}:${author}`)
        })
      return
    }

    case 'council:attempt': {
      if (!mayLeadCouncil(payload.role)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheTeacherMayLeadCouncil.745e70"))
        return
      }
      const id = optionalId(message.cellId)
      const target = optionalId(message.participantId)
      if (!id || !target) return
      const attempt = attemptFor(sessionId, id, target)
      if (!attempt) return
      const cell = councilCellOf(sessionId, id)
      send(ws, {
        t: 'council:patch',
        cellId: id,
        attempts: [attempt],
        removed: [],
        counts: countsFor(sessionId, id),
        lock: cell.lock,
        settings: cell.settings,
      })
      return
    }

    /*
     * The server makes the decision on the Oracle's suggestion.
     *
     * The "still open" check inside the transaction saved against two presses
     * in one tab and did not save against two browsers: each read `'open'` in
     * its own copy, each wrote, and Yjs conscientiously merged both edits —
     * the cell got the patch twice. The server has one copy, and it parses
     * messages in turn: the second sees what the first set.
     *
     * The name is taken from the connection, not from the message: the
     * document will record who accepted, and someone else's name cannot be
     * written there.
     */
    case 'ai:decide': {
      const entryId = typeof message.entryId === 'string' ? message.entryId : ''
      if (!entryId) return
      const { doc } = getSessionDoc(sessionId)
      const entry = findChatEntry(doc, entryId)
      if (!entry) return
      /*
       * The right to accept is asked of the CELL, not only of the rule.
       *
       * Otherwise the lock would read as breakage: a cell was opened to a
       * student, they type and run in it, ask the Oracle — and cannot press
       * "accept" on a suggestion made for that very cell. The `edit` rule has
       * not gone anywhere: in a closed cell the teacher accepts, as before.
       */
      /*
       * And for the council — as a separate term.
       *
       * The `edit` rule in an open room allows a participant to edit cells,
       * but the shared council cell is THE TASK: accepting a suggestion into
       * it would mean rewriting the task for the whole class with one press.
       * The lock does not consider it "open" (`open === 'council'`), so the
       * old check did not even notice it. The teacher accepts everywhere: the
       * reference solution in the shared cell is their text.
       */
      const target = entry.get('cellId')
      const targetLock = typeof target === 'string' ? councilCellOf(sessionId, target).lock : 'closed'
      const targetOpen = targetLock === 'open'
      /*
       * And for the notebook of this cell — as the same term as the lock.
       *
       * "Accept" rewrites the cell, that is, it is an edit, and it must ask in
       * the same place where typing asks: in their own personal notebook a
       * student accepts the Oracle's suggestion even with the room closed, in
       * someone else's personal one they do not accept it even with the room
       * open.
       */
      const targetRoot = typeof target === 'string' ? rootOf(sessionId, target) : null
      if (
        message.accept &&
        (!mayEditCell(
          rulesIn(sessionId, payload, targetRoot),
          payload.role,
          targetOpen,
          isFinished(sessionId),
        ) ||
          (targetLock === 'council' && !mayLeadCouncil(payload.role)))
      ) {
        // Anyone may decline: a removed badge destroys nothing — while the
        // class is in progress and the Oracle can be asked again.
        refuse(
          ws,
          sessionId,
          payload,
          whyIn(
            sessionId,
            payload,
            targetRoot,
            tr("server.onlyTheTeacherMayApplyAnOracle.231855"),
          ),
        )
        return
      }
      /*
       * After the bell, though, it does destroy, and so declining is closed
       * too. `patchState` becomes `rejected` for good, and there is no way to
       * bring the suggestion back: the participant can no longer ask the
       * Oracle, and a badge they removed is someone else's work erased. A rule
       * does not express this: `edit` is asked for "accept", and "decline" has
       * no rule at all — hence the same boundary as for `input`.
       */
      if (!actsAfterClass(isFinished(sessionId), payload.role)) {
        send(ws, { t: 'error', message: tr(OVER) })
        return
      }
      const who = displayName(sessionId, payload.participantId)
      /*
       * On behalf of whoever pressed, not on behalf of the server.
       *
       * Having accepted a patch, the server rewrites the cell's text — that is
       * a document edit, and in history it must have an author. Without this
       * the version turned out to be nobody's: the row read as "the room",
       * although a specific person pressed, and their own Ctrl+Z did not reach
       * their own edit.
       */
      applyOnBehalf(sessionId, payload.participantId, () => {
        if (message.accept) acceptPatch(doc, entry, who)
        else rejectPatch(doc, entry, who)
      })
      return
    }

    case 'input': {
      /*
       * Whoever's cell is asking answers — or the teacher. The same form as
       * for "stop", and for the same reason: the input prompt lives in the
       * document because the room must see it — but seeing and answering are
       * not the same thing, and `input()` under a password even less so.
       */
      if (payload.role !== 'host' && !startedTheRunningCell(sessionId, payload.participantId)) {
        refuse(ws, sessionId, payload, tr("server.onlyTheParticipantWhoRanTheCell.d7ea88"))
        return
      }
      /*
       * And not after the end of class — a rule does not express this, but
       * the action is the same: the string goes into someone else's kernel
       * and moves someone else's computation further. The whole room can
       * still read the input prompt in the feed.
       */
      if (!actsAfterClass(isFinished(sessionId), payload.role)) {
        send(ws, { t: 'error', message: tr(OVER) })
        return
      }
      const value = typeof message.value === 'string' ? message.value : ''
      /*
       * And `false` is an answer too, not only a throw.
       *
       * `answerInput` returns it when the kernel is no longer waiting for
       * input (or is waiting for it in another cell): the string went nowhere.
       * While this outcome was quietly thrown away, "Send" stayed silent — the
       * person pressed it again and again while the kernel stood still. The
       * prompt in the document is cleared by the kernel itself
       * (kernel/index.ts · clearStdinOn), but the form does not disappear
       * instantly, and silence in that second reads as "sent".
       */
      void answerInput(sessionId, value, optionalId(message.cellId))
        .then((answered) => {
          if (!answered) {
            send(ws, { t: 'error', message: tr("server.theKernelIsNoLongerWaitingFor.e35793") })
          }
        })
        .catch((err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, tr("server.couldNotSendThatToTheCell.b70cd9")),
          })
        })
      return
    }

    case 'format': {
      /*
       * A named notebook must exist — the same argument as for clearOutputs
       * and Run All: further down the road an unknown path means "no notebook
       * named" (kernel/format.ts · `cellsAt(...) ?? getCells`), and that is
       * black rewriting EVERY code cell of THE ROOM'S notebook at a press in
       * the tab of a removed notebook — for everyone and without a name in the
       * terminal line.
       *
       * And before the right: black formats EXACTLY this notebook, so the rule
       * is asked of it (`rulesIn`), and its access can only be learned by
       * knowing the root.
       */
      const book = bookOf(message)
      const root = rootOfBook(sessionId, book)
      if (book && root === null) {
        send(ws, { t: 'error', message: NO_SUCH_BOOK() })
        return
      }
      /*
       * Stricter than both neighbours: black both rewrites every code cell and
       * runs on the shared kernel. Either of the two would have been enough to
       * ask.
       */
      if (
        !may(
          sessionId,
          rulesIn(sessionId, payload, root).edit,
          payload,
          ws,
          whyIn(sessionId, payload, root, tr("server.onlyTheTeacherMayEditTheNotebook.d8abb3")),
        )
      ) {
        return
      }
      if (!mayBulkRun(sessionId, payload, ws, root)) return
      /*
       * The result goes to the terminal transcript rather than back down this
       * socket: everybody's notebook just changed under them, so everybody
       * deserves the sentence explaining it — not only whoever pressed the
       * button. It is also the one place that can say "three cells were left
       * alone", which is the part somebody will want to check.
       */
      void formatSession(sessionId, book)
        .then((outcome) => {
          if (outcome.error) {
            /*
             * The refusal goes to whoever pressed, not only into the kernel
             * log.
             *
             * Its reason is now to the point: "the kernel is busy with a
             * cell", "a cell is waiting for input()", "cells are queued"
             * (kernel/index.ts · formatBlocker). The log gets these words too
             * — they concern the whole room — but whoever pressed is looking at
             * the button, not at the terminal feed, and without this line
             * Format would look as if it simply had not worked.
             */
            send(ws, { t: 'error', message: outcome.error })
            return
          }
          if (outcome.changed === 0 && outcome.skipped === 0) {
            kernelNote(sessionId, tr("server.formattingCompleteNoChangesNeeded.0b35b3"))
            return
          }
          const parts = [
            tr('server.formattedCells', { count: outcome.changed }),
          ]
          /*
           * Two different "left alone", and they must not be lumped into one
           * number: about a cell that was edited while black was working, the
           * exact opposite is said of what is said about a cell it could not
           * read. `edited` is included in `skipped`, so it is subtracted.
           */
          const unread = outcome.skipped - outcome.edited
          if (unread > 0) {
            parts.push(
              tr("server.skippedBlackCouldNotParseTheCode.ba9c0d", { p0: unread }),
            )
          }
          if (outcome.edited > 0) {
            parts.push(
              tr("server.skippedEditedWhileFormattingWasInProgress.6a01ab", { p0: outcome.edited }),
            )
          }
          kernelNote(
            sessionId,
            tr("server.formattedWithBlackColumns.105f9d", { p0: LINE_LENGTH, p1: parts.join('; ') }),
          )
        })
        .catch((err: unknown) => {
          send(ws, {
            t: 'error',
            message: reason(err, tr("server.couldNotFormatTheNotebook.a8322c")),
          })
        })
      return
    }

    case 'term:open': {
      /*
       * Opening the drawer is not an action but a look: the transcript is
       * shared, and after the end of class it is read to the end just like
       * the notebook. A command cannot be typed in it — that is `term:run` and
       * the `run` rule. The price is named out loud: the drawer will wake a
       * sleeping container, but a drawer that does not open reads as breakage,
       * not as a rule.
       *
       * After the bell, though, there is nothing left to pay that price for:
       * starting a container and a new shell for the sake of a feed that the
       * document hands out anyway is a minute of waiting and extra gigabytes
       * in a room where everyone except the teacher is read-only. So for a
       * participant the drawer opens and can be read, while the shell stays
       * asleep. There is no refusal — there is a status: without it the tab
       * would wait for a start nobody began.
       */
      if (!actsAfterClass(isFinished(sessionId), payload.role)) {
        send(ws, { t: 'terminal', status: terminalPhase(sessionId) })
        return
      }
      void openTerminal(sessionId).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, tr("server.couldNotOpenTheTerminal.b04b2c")),
        })
      })
      return
    }

    case 'term:run': {
      /*
       * The same right as for a cell, and for the same reason:
       * `python train.py` in the shell is the same container and the same CPU
       * time as Run. Without this line the `run` rule stayed honest only for
       * the notebook: the button over a file goes dark with the words "the
       * teacher runs this one", while one line below the same script is run by
       * anyone. Opening the drawer and reading someone else's output is still
       * open to the whole room — the shell is shared.
       */
      if (
        !mayRun(
          sessionId,
          payload,
          ws,
          tr("server.onlyTheTeacherMayRunCellsAnd.1d861c"),
        )
      ) {
        return
      }
      const command = typeof message.command === 'string' ? message.command : ''
      if (command.trim().length === 0) return
      if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
        send(ws, {
          t: 'error',
          message:
            tr("server.theCommandExceedsBytes.4bc32c", { p0: formatNumber(MAX_COMMAND_BYTES) }) +
            tr("server.putItInAFileAndRun.5f2e18"),
        })
        return
      }
      runCommand(sessionId, command, sender(sessionId, payload.participantId))
      return
    }

    case 'term:interrupt': {
      /*
       * Same rule as the kernel's interrupt, and for the same reason: Ctrl+C
       * throws away every command still waiting, including other people's. The
       * shell is shared, so whoever's command is running may stop it, and the
       * host may stop anything.
       */
      if (payload.role !== 'host' && !typedRunningCommand(sessionId, payload.participantId)) {
        refuse(
          ws,
          sessionId,
          payload,
          tr("server.onlyTheTeacherOrTheParticipantWho.f9b6f0"),
        )
        return
      }
      /*
       * The host resets the whole queue, the others — only their own.
       *
       * For the host the button means "stop everything in this room", and it
       * always did. For a student it means "stop my hung command", and it
       * used to mean the same as for the host: having interrupted their own
       * `pip install`, they silently took away everything the teacher had
       * managed to queue.
       */
      interruptTerminal(
        sessionId,
        displayName(sessionId, payload.participantId),
        payload.role === 'host' ? undefined : payload.participantId,
      )
      return
    }

    case 'term:clear': {
      if (
        !may(
          sessionId,
          getRules(sessionId).wipe,
          payload,
          ws,
          tr("server.onlyTheTeacherMayClearTheTranscript.695583"),
        )
      ) {
        return
      }
      clearTerminal(sessionId)
      return
    }

    case 'term:close': {
      // Closing the shell is the same as erasing the transcript: it is shared,
      // and whoever may erase shared things is the one who shuts it down.
      if (
        !may(
          sessionId,
          getRules(sessionId).wipe,
          payload,
          ws,
          tr("server.onlyTheTeacherMayCloseTheShared.c7ec17"),
        )
      ) {
        return
      }
      void closeTerminal(sessionId).catch((err: unknown) => {
        send(ws, {
          t: 'error',
          message: reason(err, tr("server.couldNotCloseTheTerminal.17d21d")),
        })
      })
      return
    }
  }
}

function reason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * The ink of the page being shown — and one collection for everyone who came
 * in between two strokes.
 *
 * A latecomer must see the same page as the hall, together with what is
 * already drawn on it. This used to be assembled from ALL the lecture's pages
 * (`inkOf` and `JSON.stringify` — nearly a megabyte for a lecture with twenty
 * minutes of writing), and after a network failure the hall came back all at
 * once: the megabyte was multiplied by five hundred. Now the batch carries
 * one page, and the inventory (`ink:pages`) speaks of the rest — tens of
 * bytes instead of a megabyte; a page someone went to without asking is
 * requested by the tab itself (`case 'ink:page'`), and one the presenter
 * moved the hall to is sent after by the server (`case 'lecture:page'`).
 *
 * The cache has stayed, and it is now keyed by the pair "ink revision +
 * page": five hundred returning tabs look at ONE page — the one the presenter
 * is showing — and there is no reason to assemble it five hundred times. The
 * revision number is global (lecture.ts · inkRevision): while nobody draws,
 * the frame is the same. It is kept as bytes: otherwise `ws.send` would
 * encode it into UTF-8 anew for every socket (see sendFrame).
 *
 * One entry per room, not one per page: pages that were asked for leave as
 * the answer, and caching them would mean keeping the whole lecture in memory
 * for the sake of a thumbnail strip opened once a class period.
 */
const inkFrames = new Map<string, { rev: number; page: number; frame: Buffer }>()

function inkFrame(sessionId: string, page: number): Buffer | null {
  const rev = inkRevision(sessionId)
  const known = inkFrames.get(sessionId)
  if (known && known.rev === rev && known.page === page) return known.frame
  const text = frameOf({ t: 'ink', strokes: inkPageOf(sessionId, page) })
  if (text === null) return null
  const frame = Buffer.from(text, 'utf8')
  inkFrames.set(sessionId, { rev, page, frame })
  return frame
}

/* --------------------------------------------------------------- socket */

export function handleControlSocket(ws: WebSocket, sessionId: string, payload: TokenPayload, credentials?: SocketCredentials): void {
  const authorized = authorizeSocket(ws, credentials)
  let room = rooms.get(sessionId)
  if (!room) {
    room = {
      sockets: new Set<WebSocket>(),
      byParticipant: new Map<string, Set<WebSocket>>(),
      hosts: new Set<WebSocket>(),
      unwatch: () => {},
      pingTimer: null,
    }
    rooms.set(sessionId, room)
    // Attach after the room exists, so the first status change has somewhere to go.
    room.unwatch = watchRoomMeta(sessionId)
    // And one ping tick for the whole room — started with its first socket
    // and removed with the last (see `pingRoom`).
    room.pingTimer = setInterval(() => pingRoom(sessionId), PING_INTERVAL_MS)
    room.pingTimer.unref?.()
  }
  room.sockets.add(ws)
  const mine = room.byParticipant.get(payload.participantId) ?? new Set<WebSocket>()
  mine.add(ws)
  room.byParticipant.set(payload.participantId, mine)
  // The role is remembered here and nowhere else: `toHosts` and the council
  // pile ask only it, and a socket lives with the role it came with — exactly
  // the one dispatch checks on every message.
  if (payload.role === 'host') room.hosts.add(ws)
  owner.set(ws, payload.participantId)

  // Before anything else: the browser gates its own interrupt/restart controls
  // on this, and the token it holds may say something staler than the truth.
  send(ws, { t: 'role', role: payload.role })
  send(ws, { t: 'instance:language', language: getLocale() })
  /*
   * And the rules — right here, not only when they change.
   *
   * Otherwise a client whose control socket blinked across a rule change
   * lives with the old rules until the end of the class period: the layer of
   * greyed-out buttons fails exactly when it is needed most, and the person
   * runs into server refusals instead of seeing what is not allowed in this
   * room.
   */
  send(ws, { t: 'rules', rules: storedRules(sessionId) })
  /*
   * The rules here are the STORED ones, and the end of class travels as a
   * separate frame, and the client lays one over the other itself
   * (shared/rules.ts · rulesAfterClass). Otherwise a teacher who opened the
   * room settings after the end of the class period would see in them not
   * what they chose but what the end of class turned it into.
   *
   * And the frame — for the same reason as the rules: someone who came in in
   * the middle must see that the class is over at once, not on the first
   * refusal.
   */
  send(ws, { t: 'class', finishedAt: finishedAt(sessionId) })
  /*
   * And what the room is watching now. Without this line a person who came
   * in in the middle of a class will not learn about the open document until
   * the teacher reopens it — that is, most likely never.
   */
  send(ws, { t: 'board', open: boardOf(sessionId) })
  /*
   * And the lecture, if one is running: a latecomer must see the same page as
   * the hall, together with what is already drawn on it — not a blank sheet
   * until the presenter's next movement.
   */
  const lecture = lectureOf(sessionId)
  send(ws, { t: 'lecture', state: lecture })
  if (lecture) {
    /*
     * Ink — ONLY for the page being shown, and an inventory travels for the
     * rest.
     *
     * Twenty minutes of markup is about a megabyte, and all of it went to
     * everyone entering, although the one entering looks at one page; after a
     * Wi-Fi failure the hall comes back all at once, and the megabyte is
     * multiplied by five hundred. The inventory costs tens of bytes and says
     * exactly what the trimmed frame no longer has: which pages are written
     * on. By it the console counts the blank sheets that were created, and
     * the thumbnail strip knows what to ask for; the tab asks for what is
     * missing itself (`ink:page`), and the page the presenter moved the hall
     * to is sent after by the server.
     *
     * The order is the frame, then the inventory: the tab takes `ink` as a
     * full replacement of the ink, and an inventory arriving before it would
     * describe the previous lecture.
     */
    // And the held pieces go before the frame: the one entering gets the page
    // whole, and a glued batch going out after it would append points they
    // already have.
    flushInk(sessionId)
    const ink = inkFrame(sessionId, lecture.page)
    if (ink !== null) sendFrame(ws, ink)
    send(ws, { t: 'ink:pages', pages: inkedPagesOf(sessionId) })
  }
  /*
   * And the council: attempts do not live in the document, and a latecomer
   * would otherwise learn neither about their own sheet, nor about the pile
   * (host), nor about the counter — until someone else's first press.
   */
  councilWelcome(ws, sessionId, payload)

  missedPongs.set(ws, 0)

  const drop = () => {
    const current = rooms.get(sessionId)
    if (!current) return
    current.sockets.delete(ws)
    current.hosts.delete(ws)
    const who = owner.get(ws)
    const mine = who ? current.byParticipant.get(who) : undefined
    if (who && mine) {
      mine.delete(ws)
      if (mine.size === 0) current.byParticipant.delete(who)
    }
    /*
     * The presenter left silently — we turn off their pointer ourselves.
     *
     * The console on the iPad gets unloaded from memory without saying "off":
     * the tab does not manage to send anything, and the lecture goes on — it
     * does not count as erased because of that. And only if the presenter has
     * not a single socket left in the room: they usually have two (a tablet
     * and the lectern laptop), and the second one leaving must not turn off a
     * spot the first is holding still.
     */
    if (who && isPresenter(sessionId, who) && !current.byParticipant.has(who)) laserOff(sessionId)
    if (current.sockets.size === 0) {
      current.unwatch()
      if (current.pingTimer) clearInterval(current.pingTimer)
      current.pingTimer = null
      rooms.delete(sessionId)
      // There is nobody left to wait in this room: the numbers it remembered
      // are nobody's.
      forgetQueue(sessionId)
      // And the welcome batch caches have no reason to outlive the last one to
      // leave: a semester of empty rooms is a semester of file lists in
      // process memory.
      treeSent.delete(sessionId)
      inkFrames.delete(sessionId)
      laserHeld.delete(sessionId)
      inkHeld.delete(sessionId)
      // The coalescing tails go the same way: there is nobody to send them to
      // and nowhere.
      forgetTicks(sessionId)
    }
  }

  ws.on('pong', () => {
    missedPongs.set(ws, 0)
  })

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (!authorized()) return
    if (isBinary) return
    const message = parse(data)
    if (message === TOO_BIG) {
      // We name both ceilings this actually reaches: an attempt snapshot and a
      // page's speaker notes. Everything else on this wire is many times
      // shorter.
      send(ws, {
        t: 'error',
        message:
          tr("server.theMessageIsTooLongAndWas.e89d1c") +
          tr("server.anAttemptMayContainUpToCharacters.6a584e", { p0: formatNumber(MAX_ATTEMPT_CHARS) }) +
          tr("server.speakerNotesMayContainUpTo.bc3e46", { p0: formatNumber(MAX_NOTE_CHARS) }),
      })
      return
    }
    if (!message) return
    try {
      dispatch(ws, sessionId, payload, message)
    } catch (err) {
      // One bad request costs that click, never the seminar.
      console.error(`[control ${sessionId}] ${message.t} failed:`, reason(err, 'unknown error'))
      send(ws, { t: 'error', message: reason(err, tr("server.couldNotCompleteTheActionTryAgain.234540")) })
    }
  })

  ws.on('close', drop)
  ws.on('error', drop)

  // A reconnected tab is exactly the one that brings along a cell "running"
  // in a process that no longer exists. One pass per connection.
  sweepOrphanRuns(sessionId)
  /*
   * `kernel` is the state of the room's notebook, as before: a tab opened
   * before there were several kernels reads only it. `kernels` is per
   * notebook, for a tab that can handle it. After that both live in the
   * document (`meta.kernels`), and this frame is only about the first moment
   * while sync is still on its way.
   */
  send(ws, {
    t: 'ready',
    kernel: kernelStatus(sessionId),
    kernels: kernelStatuses(sessionId),
    // Only the broker cannot do them: it creates one Pod per class. The test
    // backend can — its kernels live in one Jupyter, and per-notebook
    // sessions there are just as real as in a container.
    ownKernels: kernelBackend() !== 'broker',
  })
  send(ws, { t: 'terminal', status: terminalPhase(sessionId) })
  /*
   * The tree comes from the room's shared cache: after a server restart five
   * hundred tabs come here within two seconds, and a folder walk for each is
   * seconds of event loop blocking exactly when everyone is waiting for the
   * comeback. If the walk failed, we stay silent: an empty list here would
   * read as "there is nothing in the room", and that is not what happened.
   *
   * The rest of the price of the same comeback is measured and written down
   * as a number, not a guess (tests/sync-storm-cost.test.mts): in a
   * semester-long room each returning tab's step2 is 87 KB and 5.6 ms of
   * gate parsing, and the server's answer to it is the same 87 KB. That is
   * ×500 and lives not here any more but on the shared document.
   */
  /*
   * And the one entering gets the list's number along with it. This also
   * cures the divergence for which the receipt used to be dropped: while the
   * room stood empty, the tree may have changed, and the one entering
   * recomputed it — that is, moved the number. The others hold the old one,
   * and the very first delta will not fit them: they will ask for the whole
   * tree themselves (`files:ask`) instead of applying the change to someone
   * else's list.
   */
  const files = filesFrame(sessionId)
  if (files !== null) sendFrame(ws, files)
}
