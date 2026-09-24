import { authorizeSocket, type SocketCredentials } from '../socket-authorization.js'
import { tr } from '@shared/i18n'
/**
 * One open file — one Yjs document bound to the bytes on disk.
 *
 * A notebook lives in the room's document and in a snapshot in the database.
 * Files do not: a file already has a canonical place of storage, and that is
 * the file itself. The kernel reads it with the same `open()`, a script runs
 * from it, an upload puts it there. So the document here is not storage but a
 * way to type together: it is created from disk on first open, written to disk
 * with a delay and disappears when the last tab closes.
 *
 * Three decisions, each of which would have been costly had it been made
 * differently.
 *
 * **A separate document per file, not a section in the room's document.** The
 * room document lies whole in the snapshot, unfolds whole in the version
 * history and is cached whole in the browser via y-indexeddb. A seminar folder
 * of a hundred files would make each of these three things a hundred times
 * heavier — for text that is on disk anyway.
 *
 * **Disk is the source of truth between sessions, the document during a
 * session.** While a file is open, the truth is in the document: it sees
 * everyone typing at once. When nobody has it open, the truth is on disk. The
 * seam between the two states is what is written here.
 *
 * **A change from the other side is applied by splicing, not by rewriting.** A
 * cell writes `results.csv`, the oracle edits a script, `git checkout` in the
 * terminal changes half the folder — and all of this happens to a file with
 * someone's cursor in it. Replacing the text whole means killing the cursor and
 * undo; so only what differs is changed — the common head and the common tail
 * stay the very same Yjs characters.
 */
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import { WebSocket, type RawData } from 'ws'
import type { ParticipantRole } from '@shared/protocol'
import { actsAfterClass, allows, CLASS_IS_OVER } from '@shared/rules'
import { isInside } from '@shared/paths'
import { onEviction } from '../bans.js'
import { getRules, isFinished } from '../db.js'
import { MAX_TEXT_BYTES, readText, statPath, writeText } from '../workspace.js'
import { ownAwareness } from './index.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

/** The key of the text inside a file document. There is only one. */
export const TEXT_KEY = 'text'

/** The origin of a write that came from disk: by it the save recognizes itself. */
const DISK = 'disk'
/** The origin of a write the server made on someone's behalf (the oracle). */
const SERVER = 'server'

/**
 * How long to wait after the last keystroke before writing to disk.
 *
 * Seven hundred milliseconds is a pause between words, not between sessions: a
 * file being edited reaches the disk before the person has time to switch to
 * the terminal and run it. Less — and every tenth character becomes a disk
 * write in a container that is computing at that moment.
 */
const SAVE_AFTER_MS = 700

/**
 * How often to check whether someone changed the file past us.
 *
 * Polling, not `fs.watch`: recursive watching behaves differently on three
 * platforms, and what needs watching is a dozen open files, not a tree. Two
 * seconds is the delay with which a line appended by a cell appears in the
 * editor; for a file edited by hand it is not noticeable at all.
 */
const WATCH_EVERY_MS = 2_000

/** How long a document lives after the last one leaves. A page reload is not a close. */
const LINGER_MS = 5_000

const PING_INTERVAL_MS = 25_000
const MAX_MISSED_PONGS = 2

/**
 * "The file exceeds the ceiling" is a separate close code.
 *
 * The client reads 4404 as "no such file" and closes the tab silently: a click
 * on a three-megabyte CSV looked like a tab that blinked and vanished without
 * saying anything. With this code the tab stays and tells the truth — the file
 * exists, it cannot be edited in the editor, it can be downloaded and read from
 * a cell.
 */
const TOO_BIG = 4413

interface ConnState {
  participantId: string | null
  clientIds: Set<number>
  missedPongs: number
  pingTimer: NodeJS.Timeout
  role: ParticipantRole
}

interface FileDoc {
  key: string
  sessionId: string
  path: string
  doc: Y.Doc
  awareness: Awareness
  conns: Map<WebSocket, ConnState>
  /** The text we believe is on disk right now. */
  onDisk: string
  /** The disk fingerprint by which someone else's write is recognized. */
  stamp: string
  saveTimer: NodeJS.Timeout | null
  watchTimer: NodeJS.Timeout | null
  lingerTimer: NodeJS.Timeout | null
  /**
   * The entry is buried: the file is gone, it moved past the tree or stopped
   * being editable text. There is nowhere left to write, and it must not be
   * revived — the next open creates the document from disk anew.
   */
  gone: boolean
}

const open = new Map<string, FileDoc>()

function keyOf(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`
}

function stampOf(sessionId: string, path: string): string {
  const stat = statPath(sessionId, path)
  return stat ? `${stat.modifiedAt}:${stat.size}` : ''
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Replace the document's text so that everything that did not change survives.
 *
 * The common head and common tail are counted character by character and stay
 * in place; between them, one deletion and one insertion. A full line diff does
 * not fit here: it is quadratic, and a file can be thirty thousand lines long,
 * and recomputing it every two seconds for every open file is work exactly
 * where nobody asked for it. A cursor inside the changed piece slides to its
 * edge: any editor whose file was changed from outside behaves the same way.
 */
export function spliceText(text: Y.Text, next: string): boolean {
  const now = text.toString()
  if (now === next) return false
  let head = 0
  const max = Math.min(now.length, next.length)
  while (head < max && now[head] === next[head]) head++
  let tail = 0
  while (tail < max - head && now[now.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  /*
   * A boundary has no right to fall in the middle of a surrogate pair. Adjacent
   * emoji share their high half, and the head stops right between the halves:
   * Yjs replaces the torn one with U+FFFD, lib0 encodes a lone surrogate as
   * another one in transit — and the server's document diverges from the
   * browsers' documents until the end of the session, and the damage goes to
   * disk. The boundaries are moved outwards, and the count becomes per
   * character, as it is declared above.
   */
  if (head > 0 && isHighSurrogate(now.charCodeAt(head - 1))) head -= 1
  if (tail > 0 && isLowSurrogate(now.charCodeAt(now.length - tail))) tail -= 1
  const removed = now.length - head - tail
  const added = next.slice(head, next.length - tail)
  if (removed > 0) text.delete(head, removed)
  if (added.length > 0) text.insert(head, added)
  return true
}

/**
 * Open a file's document, creating it from disk if it is not open yet.
 *
 * `null` means the file does not exist, is not text or is too big. For the
 * document all three cases mean one thing: there is nothing to edit and no
 * reason to open a socket. For a person they do not, so `handleFileSocket`
 * tells the last one apart with a separate code.
 */
export function getFileDoc(sessionId: string, path: string): FileDoc | null {
  const existing = open.get(keyOf(sessionId, path))
  if (existing && !existing.gone) {
    if (existing.lingerTimer) {
      clearTimeout(existing.lingerTimer)
      existing.lingerTimer = null
    }
    return existing
  }

  const read = readText(sessionId, path)
  if (!read || read.binary || read.truncated) return null

  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  doc.getText(TEXT_KEY).insert(0, read.text)

  const entry: FileDoc = {
    key: keyOf(sessionId, path),
    sessionId,
    path,
    doc,
    awareness,
    conns: new Map(),
    onDisk: read.text,
    stamp: `${read.modifiedAt}:${read.size}`,
    saveTimer: null,
    watchTimer: null,
    lingerTimer: null,
    gone: false,
  }
  open.set(entry.key, entry)

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    broadcastUpdate(entry, update, origin)
    // A write from disk does not go back to disk: these are its own bytes, and
    // a second pass would differ from the first only in the modification time
    // — which would be enough for the watcher to take it for someone else's
    // edit and go for a third round.
    if (origin === DISK || origin === SERVER) return
    scheduleSave(entry)
  })

  awareness.on(
    'update',
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const state = origin instanceof WebSocket ? entry.conns.get(origin) : undefined
      if (state) {
        for (const id of changes.added) state.clientIds.add(id)
        for (const id of changes.removed) state.clientIds.delete(id)
      }
      broadcastAwareness(entry, changes.added.concat(changes.updated, changes.removed))
    },
  )

  entry.watchTimer = setInterval(() => watchDisk(entry), WATCH_EVERY_MS)
  entry.watchTimer.unref?.()
  return entry
}

/** Whether this file is open right now — and its document, if so. */
export function openFileDoc(sessionId: string, path: string): FileDoc | null {
  const entry = open.get(keyOf(sessionId, path))
  return entry && !entry.gone ? entry : null
}

/**
 * Write a file on behalf of the server — so that open editors see it as an
 * edit, not as a swap.
 *
 * The only write path for everything that is not a browser: the oracle in
 * "Act" mode, restoring after undoing a turn. If the file is open, the edit
 * goes into the document and straight to disk; if not, straight to disk. A
 * completed write is reported to the file panel at once, before the oracle's
 * answer about success. There must not be two paths: they would drift apart
 * exactly at the moment someone is looking at the file.
 *
 * "Save now without changing the text" does not belong here; `flushFile`
 * exists for that. Before it, running a file and renaming went through this
 * door: they took the document's text and put it into the same document, only
 * to get to the disk write.
 */
export function putText(sessionId: string, path: string, text: string): boolean {
  /*
   * The ceiling comes before everything else and is the same for both paths.
   * For an open file, saving would refuse by it, and the document would keep
   * text that would never be on disk, while the answer said "done"; for a
   * closed one nobody would refuse, and a file would appear on disk that could
   * then be opened neither by the editor nor by the next step of the same
   * oracle.
   */
  if (tooBig(text)) return false
  const entry = openFileDoc(sessionId, path)
  if (!entry) {
    /*
     * Nobody has read a file larger than the ceiling in full: both the oracle
     * and turn undo assemble the text from its beginning. Putting such text in
     * the file's place means silently cutting off the tail — three megabytes of
     * metrics become one and a half, and the next cell honestly computes on
     * half of the set.
     */
    const at = statPath(sessionId, path)
    if (at && !at.dir && at.size > MAX_TEXT_BYTES) return false
    const wrote = writeText(sessionId, path, text)
    if (wrote) fileSaved?.(sessionId, path, 'server')
    return wrote
  }
  // Commit the durable file first. Yjs updates synchronously reach observers
  // and sockets; rolling back after an I/O failure would already be too late.
  const at = statPath(sessionId, path)
  if (!at || at.dir) return false
  if (!writeText(sessionId, path, text)) return false
  if (entry.saveTimer) clearTimeout(entry.saveTimer)
  entry.saveTimer = null
  entry.onDisk = text
  entry.stamp = stampOf(sessionId, path)
  entry.doc.transact(() => spliceText(entry.doc.getText(TEXT_KEY), text), SERVER)
  fileSaved?.(sessionId, path, 'server')
  return true
}

/**
 * The file's text — from the document if it is open, otherwise from disk.
 *
 * `null` also for a file larger than the ceiling: from disk it is read as its
 * beginning, and handing out that beginning as "the file's text" means letting
 * it be written back in place of the whole.
 */
export function currentText(sessionId: string, path: string): string | null {
  const entry = openFileDoc(sessionId, path)
  if (entry) return entry.doc.getText(TEXT_KEY).toString()
  const read = readText(sessionId, path)
  if (!read || read.binary || read.truncated) return null
  return read.text
}

/**
 * Whether this text is over the ceiling — in BYTES, the same measure as the
 * read truncation.
 *
 * `MAX_TEXT_BYTES` is bytes (`workspace.ts` compares `stat.size` with it),
 * while here `text.length` was compared, that is, UTF-16 units. For Cyrillic
 * that is a factor of two, for emoji four: a file of 1.4 million Russian
 * characters passed the write check and landed on disk whole at 2.8 MB, and on
 * the next open it was read truncated and closed with the "file exceeds the
 * ceiling" code. The very file that was just being edited suddenly stopped
 * opening — and there was no way to explain that to a person.
 */
function tooBig(text: string): boolean {
  // Cut-offs at the edges: in UTF-8 one UTF-16 unit takes one to three bytes,
  // so a real count is needed only in between.
  if (text.length > MAX_TEXT_BYTES) return true
  if (text.length * 3 <= MAX_TEXT_BYTES) return false
  return Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES
}

function scheduleSave(entry: FileDoc): void {
  if (entry.saveTimer) return
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null
    saveNow(entry)
  }, SAVE_AFTER_MS)
  entry.saveTimer.unref?.()
}

/** Write the document to disk. `false`: not written, and the file stayed as it was. */
function saveNow(entry: FileDoc, origin: FileSaveOrigin = 'editor'): boolean {
  if (entry.saveTimer) {
    clearTimeout(entry.saveTimer)
    entry.saveTimer = null
  }
  if (entry.gone) return false
  const text = entry.doc.getText(TEXT_KEY).toString()
  if (text === entry.onDisk) return true
  /*
   * The ceiling is checked here, not only on open: the file opened small and
   * became big — someone pasted a megabyte from the clipboard. The refusal used
   * to be silent, and that was the worst place in the module: the edit was
   * never saved, while the editor showed it as if nothing had happened and
   * returned `true` to the oracle. Now the tabs learn about it by the same 4403
   * as for a rejected edit — "read-only from here on" is the literal truth
   * here, and what was typed stays on screen, where it can be taken from.
   */
  if (tooBig(text)) {
    entry.gone = true
    closeAll(entry, 4403, tr("server.theFileExceedsTheSizeLimitAnd.2d3114"))
    dispose(entry)
    return false
  }
  /*
   * The file may have moved past the tree: `mv` in the terminal, `os.rename` in
   * a cell. The watcher will notice it no sooner than two seconds later, and
   * the delayed save gets there first — and `writeText` creates the file again
   * at the old path, that is, silently undoes someone else's rename and breeds
   * two copies in the room.
   */
  const at = statPath(entry.sessionId, entry.path)
  if (!at || at.dir) {
    entry.gone = true
    closeAll(entry, 4404, tr("server.theFileNoLongerExists.353e66"))
    dispose(entry)
    return false
  }
  if (!writeText(entry.sessionId, entry.path, text)) return false
  entry.onDisk = text
  entry.stamp = stampOf(entry.sessionId, entry.path)
  fileSaved?.(entry.sessionId, entry.path, origin)
  return true
}

type FileSaveOrigin = 'editor' | 'server'
let fileSaved: ((sessionId: string, path: string, origin: FileSaveOrigin) => void) | null = null

/**
 * Whom to tell that a file has landed on disk. Registered by control.ts: the
 * room learns the new size and time, and importing it from here would close a
 * loop.
 */
export function onFileSaved(listener: (sessionId: string, path: string, origin: FileSaveOrigin) => void): void {
  fileSaved = listener
}

function watchDisk(entry: FileDoc): void {
  if (entry.gone) return
  // While a save is queued, the disk certainly lags behind the document:
  // looking at it now means taking our own yesterday's text for someone else's
  // edit.
  if (entry.saveTimer) return
  const stamp = stampOf(entry.sessionId, entry.path)
  if (stamp === entry.stamp) return
  if (stamp === '') {
    // The file was removed. The room will learn about it from the file list;
    // what matters here is to stop writing — otherwise the next save would
    // resurrect it.
    entry.gone = true
    closeAll(entry, 4404, tr("server.theFileNoLongerExists.353e66"))
    dispose(entry)
    return
  }
  const read = readText(entry.sessionId, entry.path)
  if (!read || read.binary || read.truncated) {
    /*
     * The file stopped being something that can be edited: it outgrew the
     * ceiling (the kernel writes a log into it), became binary (a pickle
     * landed on top) or cannot be read at all. There used to be a silent
     * return here, and the document stayed forever with the text as of opening
     * — the very first keystroke put that short old text over the grown file.
     * Files have neither a snapshot nor version history, so there would be
     * nothing to bring back what the kernel appended with.
     *
     * One that outgrew the ceiling gets its own code: the file is in place, and
     * the tab has something to tell the person other than silently vanishing.
     */
    entry.gone = true
    if (read?.truncated) closeAll(entry, TOO_BIG, tr("server.theFileExceedsTheSizeLimit.59e6dd"))
    else closeAll(entry, 4404, tr("server.theFileCanNoLongerBeOpened.0fbdee"))
    dispose(entry)
    return
  }
  entry.stamp = stamp
  if (read.text === entry.onDisk) return
  entry.onDisk = read.text
  entry.doc.transact(() => spliceText(entry.doc.getText(TEXT_KEY), read.text), DISK)
}

function dispose(entry: FileDoc): void {
  /*
   * Only our own entry. Under this key there may already be ANOTHER one — the
   * file came back and was opened while this one lived out its five seconds —
   * or this one was already buried. Removing someone else's means leaving the
   * room with two documents for one file: two tabs type into different copies
   * and take turns writing over each other.
   */
  if (open.get(entry.key) !== entry) return
  open.delete(entry.key)
  if (entry.watchTimer) clearInterval(entry.watchTimer)
  if (entry.saveTimer) clearTimeout(entry.saveTimer)
  if (entry.lingerTimer) clearTimeout(entry.lingerTimer)
  entry.watchTimer = null
  entry.saveTimer = null
  entry.lingerTimer = null
  entry.doc.destroy()
}

/**
 * Close all of an entry's sockets — and forget them right here, without
 * waiting for the `close` event.
 *
 * The event comes on the next tick, and until then the entry would live with
 * the full list of connections: closing the last of them would schedule a
 * delayed death of an entry already buried, and five seconds later that one
 * would throw the NEW document of the same file out of the map. Everyone who
 * calls this calls `dispose` right after, so presence goes along with the
 * document.
 */
function closeAll(entry: FileDoc, code: number, reason: string): void {
  for (const [conn, state] of [...entry.conns]) {
    entry.conns.delete(conn)
    clearInterval(state.pingTimer)
    try {
      conn.close(code, reason)
    } catch {
      /* already closed */
    }
  }
}

/* --------------------------------------------------------------- socket */

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  }
  const buf = data as Buffer
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function send(entry: FileDoc, conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
    closeConn(entry, conn)
    return
  }
  try {
    conn.send(message, (err) => {
      if (err) closeConn(entry, conn)
    })
  } catch {
    closeConn(entry, conn)
  }
}

function broadcastUpdate(entry: FileDoc, update: Uint8Array, origin: unknown): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  for (const conn of entry.conns.keys()) {
    if (conn === origin) continue
    send(entry, conn, message)
  }
}

function broadcastAwareness(entry: FileDoc, clients: number[]): void {
  if (clients.length === 0) return
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients),
  )
  const message = encoding.toUint8Array(encoder)
  for (const conn of entry.conns.keys()) send(entry, conn, message)
}

function closeConn(entry: FileDoc, conn: WebSocket): void {
  const state = entry.conns.get(conn)
  if (!state) return
  entry.conns.delete(conn)
  clearInterval(state.pingTimer)
  awarenessProtocol.removeAwarenessStates(entry.awareness, [...state.clientIds], null)
  try {
    conn.close()
  } catch {
    /* already closed */
  }
  if (entry.conns.size > 0) return
  /*
   * The last one left. Save immediately — a page reload must not cost the last
   * seconds typed — and keep the document a little longer: the same reload
   * will come back in a fraction of a second, and rebuilding the document from
   * scratch would mean losing undo for nothing.
   */
  saveNow(entry)
  // The entry may already be gone: the save found that the file is no longer
  // on disk. Scheduling a delayed death for it would mean removing from the
  // map, five seconds later, the document created in its place — and getting
  // two documents for one file.
  if (entry.gone) return
  entry.lingerTimer = setTimeout(() => {
    if (entry.conns.size === 0) dispose(entry)
  }, LINGER_MS)
  entry.lingerTimer.unref?.()
}

/**
 * Refuse a connection's frame.
 *
 * By closing, as in the room's document, and for the same reason: nothing in
 * the sync protocol can take away from a client a structure it already has. A
 * client that got 4403 rebuilds the document and shows that the edit did not
 * go through.
 *
 * The reason is in words. The file socket has no control channel through which
 * the room gate sends the refusal phrase (`collab/index.ts · onRefusal`), and
 * the only place an explanation fits here is the `reason` field of the close
 * frame. It is limited to 123 bytes: a phrase that does not fit in them `ws`
 * will not send but throw.
 */
function refuse(entry: FileDoc, conn: WebSocket, why: string): void {
  try {
    conn.close(4403, why)
  } catch {
    /* already closed */
  }
  closeConn(entry, conn)
}

/**
 * Whether a frame carries an edit.
 *
 * y-websocket always answers the server's step 1 — including with an empty
 * frame that has not a single structure in it. Refusing by subtype means
 * breaking the handshake for everyone who may not edit files: they have not
 * written anything yet, and they already get "the edit was not accepted" and a
 * file frozen forever. The room socket parses the contents for exactly this
 * reason.
 */
function carriesEdit(payload: Uint8Array): boolean {
  try {
    const update = Y.decodeUpdate(payload)
    if (update.structs.length > 0) return true
    for (const ranges of update.ds.clients.values()) if (ranges.length > 0) return true
    return false
  } catch {
    // The frame cannot be parsed — we count it as an edit: letting unread data
    // through means applying it after the check stopped looking.
    return true
  }
}

function handleMessage(entry: FileDoc, conn: WebSocket, data: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(data)
    const encoder = encoding.createEncoder()
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        const peek = decoding.clone(decoder)
        const subtype = decoding.readVarUint(peek)
        if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
          const state = entry.conns.get(conn)
          const role = state?.role ?? 'participant'
          /*
           * The right is read now, not when the socket opened: the room's
           * rules change in the middle of a class, and a socket opened before
           * the tightening would live by the old rules until it reconnected.
           */
          if (
            !allows(getRules(entry.sessionId).files, role) &&
            carriesEdit(decoding.readVarUint8Array(peek))
          ) {
            /*
             * The words are the same ones the button in the file panel goes
             * dark with (`web/src/lib/may.ts · filesWhy`): one rule, so one
             * explanation. After the end of the class the rule is
             * indistinguishable from "files are the teacher's", but the reason
             * is different, and that is what has to be said.
             */
            return refuse(
              entry,
              conn,
              actsAfterClass(isFinished(entry.sessionId), role)
                ? tr("server.onlyTheTeacherMayEditFilesIn.0ca25b")
                : tr(CLASS_IS_OVER),
            )
          }
        }
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, conn)
        if (encoding.length(encoder) > 1) send(entry, conn, encoding.toUint8Array(encoder))
        break
      }
      case MESSAGE_AWARENESS: {
        const payload = decoding.readVarUint8Array(decoder)
        if (!ownAwareness(entry, conn, payload)) break
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, payload, conn)
        break
      }
    }
  } catch (err) {
    console.error(`[files] bad message in ${entry.sessionId}:${entry.path}`, err)
    refuse(entry, conn, tr("server.theEditCouldNotBeReadAnd.fab4ce"))
  }
}

export function handleFileSocket(
  ws: WebSocket,
  sessionId: string,
  path: string,
  role: ParticipantRole,
  participantId: string | null,
  credentials?: SocketCredentials,
): void {
  const authorized = authorizeSocket(ws, credentials)
  const entry = getFileDoc(sessionId, path)
  if (!entry) {
    /*
     * Why it did not open — different answers. No file (or not text): the tab
     * must be closed; a file larger than the ceiling: say that it exists and
     * close nothing. The measure is the same as `readText`'s, and it costs one
     * `lstat`: reading a megabyte and a half a second time for a close code is
     * pointless.
     */
    const at = statPath(sessionId, path)
    const tooBig = at !== null && !at.dir && at.size > MAX_TEXT_BYTES
    try {
      if (tooBig) ws.close(TOO_BIG, tr("server.theFileExceedsTheSizeLimit.59e6dd"))
      else ws.close(4404, tr("server.theFileCannotBeOpened.a0670d"))
    } catch {
      /* already closed */
    }
    return
  }

  ws.binaryType = 'arraybuffer'
  const state: ConnState = {
    participantId,
    clientIds: new Set(),
    missedPongs: 0,
    pingTimer: setInterval(() => {
      const here = entry.conns.get(ws)
      if (!here) return
      if (here.missedPongs >= MAX_MISSED_PONGS) return closeConn(entry, ws)
      here.missedPongs += 1
      try {
        ws.ping()
      } catch {
        closeConn(entry, ws)
      }
    }, PING_INTERVAL_MS),
    role,
  }
  state.pingTimer.unref?.()
  entry.conns.set(ws, state)

  ws.on('pong', () => {
    const here = entry.conns.get(ws)
    if (here) here.missedPongs = 0
  })
  ws.on('message', (data: RawData) => {
    if (authorized()) handleMessage(entry, ws, toUint8Array(data))
  })
  ws.on('close', () => closeConn(entry, ws))
  ws.on('error', () => closeConn(entry, ws))

  // Sync step 1 comes from the server, as in the room's document.
  const sync = encoding.createEncoder()
  encoding.writeVarUint(sync, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(sync, entry.doc)
  send(entry, ws, encoding.toUint8Array(sync))

  const states = entry.awareness.getStates()
  if (states.size > 0) {
    const hello = encoding.createEncoder()
    encoding.writeVarUint(hello, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      hello,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, [...states.keys()]),
    )
    send(entry, ws, encoding.toUint8Array(hello))
  }
}

/**
 * The ban's third door: a file open in the editor.
 *
 * The first two — the notebook and the control socket — are closed by
 * `evictBanned` (control.ts): it holds their sockets itself. The file sockets
 * live here, in their own map, and each carries the `participantId` from the
 * handshake — that is how they are found.
 *
 * Without this a ban threw the person out halfway: a tab with `utils.py` open
 * kept accepting their edits and broadcasting them to the whole room until they
 * reloaded the page themselves. Exactly the spam people get banned for — in a
 * shared file, not in the notebook.
 *
 * By the same path as an ordinary leave (`closeConn`): it removes the ping and
 * the presence, so the evicted person's cursor disappears for the neighbours at
 * once instead of hanging until a timeout. With code 1008, as for the control
 * socket — by it the tab tells "you were evicted" from a dropped connection and
 * does not knock again: the handshake checks the ban before the upgrade.
 */
export function dropFileParticipant(sessionId: string, participantId: string): void {
  for (const entry of [...open.values()]) {
    if (entry.sessionId !== sessionId) continue
    // A copy: closeConn edits the same map the loop walks over.
    for (const [conn, state] of [...entry.conns]) {
      if (state.participantId !== participantId) continue
      try {
        conn.close(1008, tr("server.bannedFromThisSeminar.234bce"))
      } catch {
        /* already closed */
      }
      closeConn(entry, conn)
    }
  }
}

/*
 * A subscription, not a call from `evictBanned`. Calling this module from there
 * would be possible — `control.ts` imports it anyway, and files.ts does not
 * look back at control.ts at all, there is no cycle. But then the list of wires
 * would live in the module that handles presses, and every next wire would have
 * to be remembered exactly there. The event is declared in the ban module
 * (bans.ts · onEviction) — where the very notion "this person may no longer
 * come here" lives — and whoever holds a wire subscribes to it on their side.
 */
onEviction(dropFileParticipant)

/**
 * Run the disk poll now — for a test that has nothing to wait for.
 *
 * The disk is watched by a two-second `setInterval` (WATCH_EVERY_MS), and there
 * was no way to ask it to fire: the check "someone else's write reached the
 * open document" slept longer than the interval — five seconds of pure sleep
 * per file, and a red test at the slightest timer drift under load. Here is the
 * same pass the timer makes, but on demand: the sleep disappears, and exactly
 * the same thing as before is checked — `watchDisk` itself.
 *
 * One room or all of them: the map is shared by the instance, and without a
 * boundary checking one room would touch the open files of all the others.
 */
export function pollFilesNow(sessionId?: string): void {
  // A copy: `watchDisk` buries an entry whose file vanished or outgrew the
  // ceiling — that is, it edits the same map the loop walks over.
  for (const entry of [...open.values()]) {
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue
    watchDisk(entry)
  }
}

/** Write out everything unsaved — when the process stops and in tests. */
export function flushAllFiles(): void {
  for (const entry of [...open.values()]) saveNow(entry)
}

/**
 * The same, but for one room: before a run that reads the disk.
 *
 * A cell and the oracle's `run_file` read the file through the kernel, that is,
 * from disk, while the write is deferred until a pause in typing. They have no
 * right to wait for it — but no right to flush for everyone either: the map
 * here is shared by the instance, and without this boundary every run in one
 * room would touch the open files of all the others.
 */
export function flushSessionFiles(sessionId: string): void {
  for (const entry of [...open.values()]) {
    if (entry.sessionId === sessionId) saveNow(entry)
  }
}

/**
 * Write one open file to disk right now.
 *
 * The write is deferred until a pause in typing (`SAVE_AFTER_MS`), and two
 * places have no right to wait for it. Running: `python` reads the disk, and
 * without this it reads the text without the last typed lines — the error
 * arrives about a line that looks correct on screen. Renaming: `forgetFile`
 * takes away the document together with the deferred write, and after the move
 * there is nowhere left to write.
 *
 * A file nobody opened is on disk anyway — then there is nothing to do.
 */
export function flushFile(sessionId: string, path: string): void {
  const entry = openFileDoc(sessionId, path)
  if (entry) saveNow(entry)
}

/**
 * Forget a file — or a folder with everything in it: they were renamed or
 * removed.
 *
 * Without this the document would outlive its own file and write it back to
 * the old place on the next save — the rename would undo itself a second
 * later, and there would be no way to explain it. The disk watcher would notice
 * the same thing, but only two seconds later, and the window between them is
 * exactly the one in which the deferred save manages to fire.
 *
 * The whole path, not an exact match: a FOLDER can be renamed and removed, and
 * the documents live under the paths of the files inside it. Forgetting one
 * exact path, we left them alive — and the next save created the old folder
 * again with one file in it, while the edits of the last seconds stayed in
 * that ghost path, not in the new one.
 */
export function forgetFile(sessionId: string, path: string): void {
  if (!path) return
  for (const entry of [...open.values()]) {
    if (entry.sessionId !== sessionId) continue
    if (!isInside(entry.path, path)) continue
    entry.gone = true
    closeAll(entry, 4404, tr("server.theFileNoLongerExists.353e66"))
    dispose(entry)
  }
}

/** Close everything: the room was deleted, the process is stopping. */
export function forgetFiles(sessionId: string): void {
  for (const entry of [...open.values()]) {
    if (entry.sessionId !== sessionId) continue
    saveNow(entry)
    closeAll(entry, 1001, tr("server.theRoomIsClosed.23a989"))
    dispose(entry)
  }
}
