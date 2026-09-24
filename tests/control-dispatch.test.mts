/**
 * Control messages that had never gone through `dispatch` until now.
 *
 * The rights table is checked row by row (control-rules), the lock separately
 * (control-lock), yet three doors had not a single assertion: the
 * `term:interrupt` command, where a student could take away the teacher's
 * queue, and `tree:mkdir` and `book:open` under the `files` rule. Plus two
 * places where the refusal was the wrong one: one's own cell opened by the
 * teacher, and a notebook named by a name that is not in the room.
 *
 * No network, no kernel: the socket is fake, the room is real. There used to
 * be a promise here that a refusal must sound before the action, so a missed
 * check "would fail not with an assertion but with an attempt to reach a
 * nonexistent Jupyter". That is not true, and it must not be relied on:
 * `JUPYTER_URL` points at a dead port, the connection refusal is swallowed
 * silently, and the allowing half of every row goes there too and stays green.
 * A miss is caught by something else — what is said, and what is left in the
 * room afterwards: the queue (`stateOf`), a folder on disk, a notebook in the
 * document. That is why each allowing half below has not only `null` but also
 * a trace — or says plainly that it has no trace at all.
 *
 * A side effect of the same silence: an allowed `run` wakes a kernel
 * reconnect that lives until `--test-force-exit`.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { WebSocket, type RawData } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { dispatch, handleControlSocket, closeControlRoom } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { sessionDir } from '../server/src/workspace.js'
import { bookAt, cellId, createCell, findCell, getCells, isCellOpen } from '../shared/notebook.js'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Exactly what `send` reads: the state and taking in a frame. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

function room(rules: Partial<RoomRules> = {}): string {
  const id = `disp-${++rooms}`
  createSession(id, 'Пульт', null)
  setRules(id, { ...OPEN_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** What the server said in reply to this message; `null` if it said nothing. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, said } = socket()
  dispatch(ws, sessionId, who(role, sessionId), message)
  return said[0] ?? null
}

/** A code cell in the room's notebook, and its name. */
function cell(sessionId: string, source: string): string {
  const { doc } = getSessionDoc(sessionId)
  const made = createCell('code', source)
  doc.transact(() => getCells(doc).push([made]))
  return cellId(made)
}

function stateOf(sessionId: string, id: string): string {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return (found?.cell.get('state') as string) ?? 'no such cell'
}

/** Cell output: what "clear output" must remove and a refusal must keep. */
function putOutput(sessionId: string, id: string): void {
  const { doc } = getSessionDoc(sessionId)
  const found = findCell(doc, id)
  assert.ok(found, 'the cell is not in the notebook')
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('json', JSON.stringify({ name: 'stdout', text: 'посчитано\n' }))
    ;(found.cell.get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')
}

function outputsOf(sessionId: string, id: string): number {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return (found?.cell.get('outputs') as Y.Array<unknown> | undefined)?.length ?? -1
}

/* ---------------------------------------------------------------- shell */

test("Ctrl+C in the shell: the author stops their own command, the teacher stops anyone's", () => {
  /*
   * The fork `role === 'host' ? undefined : participantId` is the rule itself:
   * a student who interrupted their own stuck `pip install` must not take away
   * the queue the teacher set up. There is no command in the room at all, so
   * the student has no "own running one" either — a refusal.
   */
  const id = room()
  // The refusal is in the room's language, like the whole drawer transcript:
  // it pops up as a toast over Russian tabs and a Russian prompt (audit ·
  // panels-15).
  assert.match(say(id, 'participant', { t: 'term:interrupt' }) ?? '', /Прервать команду/)
  /*
   * The allowing half has no trace and cannot have one: no shell was opened in
   * the room, `interruptTerminal` returns on its first line for such a room,
   * and all one can assert here is silence. Said plainly so that `null` is not
   * read as a check of the action.
   */
  assert.equal(say(id, 'host', { t: 'term:interrupt' }), null)
})

/* ---------------------------------------------------------------- files */

test('under the files rule the teacher creates folders, while a notebook asks its own rule', () => {
  const id = room({ files: 'host' })
  assert.match(
    say(id, 'participant', { t: 'tree:mkdir', path: 'разбор' }) ?? '',
    /Создавать файлы/,
    "a participant created a folder in a room where files are the teacher's",
  )
  // A refusal to a participant also means a folder that did not appear on
  // disk.
  assert.equal(
    fs.existsSync(path.join(sessionDir(id), 'разбор')),
    false,
    'the folder appeared, yet the refusal was sent',
  )
  assert.equal(say(id, 'host', { t: 'tree:mkdir', path: 'разбор' }), null)
  // And permission means a folder on disk, not a silent wire.
  assert.ok(
    fs.statSync(path.join(sessionDir(id), 'разбор')).isDirectory(),
    'the teacher was allowed, yet there is no folder',
  )

  /*
   * Bringing an .ipynb into the room means ADDING a notebook, and that has its
   * own rule (shared/rules.ts · ownBooks), not `files`. The latter used to be
   * checked, and the combination "files are the teacher's, personal notebooks
   * allowed" was impossible; now the refusal comes from its own rule and talks
   * about it — in its own words, the ones in the rules line.
   */
  assert.match(
    say(id, 'participant', { t: 'book:open', path: 'прошлая.ipynb' }) ?? '',
    /Личные тетради/,
  )
  /*
   * The teacher gets a refusal too — there is no file on disk — but a
   * DIFFERENT one: the right check is passed, and from there the file itself
   * speaks.
   */
  const asHost = say(id, 'host', { t: 'book:open', path: 'прошлая.ipynb' }) ?? ''
  assert.doesNotMatch(asHost, /Свои тетради/)
  // And neither of them got a notebook in the document: the name is empty.
  assert.equal(
    bookAt(getSessionDoc(id).doc, 'прошлая.ipynb'),
    null,
    'a notebook entered the room from a nonexistent file',
  )
})

/* ------------------------------------------------------------------ run */

test('"one at a time": the same person\'s second cell does not get into the queue', () => {
  /*
   * The ceiling comes from the rule, and that makes "one at a time" a limit
   * rather than a press counter: a scripted loop gets one cell in the queue
   * and one sentence. Until now only the Run All refusal was checked.
   */
  const id = room({ run: 'single' })
  const first = cell(id, 'x = 1')
  const second = cell(id, 'y = 2')
  assert.equal(say(id, 'participant', { t: 'run', cellId: first }), null)
  assert.equal(stateOf(id, first), 'queued')
  assert.match(say(id, 'participant', { t: 'run', cellId: second }) ?? '', /по одной/)
  assert.equal(stateOf(id, second), 'idle', 'the second cell got into the queue after all')
  // But the ceiling does not get in the teacher's way: the rule is about the
  // class not clogging the kernel queue, not about there being no queue.
  assert.equal(say(id, 'host', { t: 'run', cellId: second }), null)
  assert.equal(stateOf(id, second), 'queued', 'the teacher was allowed, yet the queue did not grow')
  closeControlRoom(id)
})

/* ------------------------------------------------------------ own cell */

test('in an open cell a student clears their own output', () => {
  /*
   * The right to "clear one cell's output" is the same as the right to type in
   * it, lock included. Otherwise in a lecture notebook a student runs an open
   * cell, gets a traceback half a screen long and reads "the notebook belongs
   * to the teacher" about a cell that was opened for them.
   */
  const id = room({ ...LECTURE_ROOM })
  const open = cell(id, 'открыто = 1')
  const shut = cell(id, 'закрыто = 1')
  putOutput(id, open)
  putOutput(id, shut)
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)
  assert.equal(isCellOpen(findCell(getSessionDoc(id).doc, open)!.cell), true, 'the lock did not open')

  assert.equal(say(id, 'participant', { t: 'clearOutputs', cellId: open }), null)
  assert.equal(outputsOf(id, open), 0, 'allowed, yet the traceback is still there')
  assert.match(
    say(id, 'participant', { t: 'clearOutputs', cellId: shut }) ?? '',
    /редактировать тетрадь может только преподаватель/i,
    'the closed cell was given away along with the open one',
  )
  assert.equal(outputsOf(id, shut), 1, "the closed cell's output was cleared, yet the refusal was sent")
  // The whole board still goes by the `wipe` rule, and the lock does not open
  // it.
  assert.match(say(id, 'participant', { t: 'clearOutputs' }) ?? '', /доск/i)
  assert.equal(outputsOf(id, shut), 1, 'the board was wiped after the refusal')
})

/* ------------------------------------------------------------ notebooks */

test("format with the name of a removed notebook does not format the room's notebook", () => {
  /*
   * Further down the road an unknown path means "no notebook named" — that is,
   * black would rewrite every code cell of the ROOM notebook on a press in a
   * tab that had not yet learned the file was removed.
   */
  const id = room()
  assert.match(say(id, 'host', { t: 'format', book: 'убранная.ipynb' }) ?? '', /тетради/i)
  // Its siblings in meaning give the same answer, as they did before.
  assert.match(say(id, 'host', { t: 'runAll', book: 'убранная.ipynb' }) ?? '', /тетради/i)
  assert.match(
    say(id, 'host', { t: 'clearOutputs', book: 'убранная.ipynb' }) ?? '',
    /тетради/i,
  )
})

/* ---------------------------------------------------------------- frame */

test('a frame bigger than the ceiling is not dropped silently', () => {
  /*
   * For a council attempt silence is the worst this wire can do: the student
   * keeps writing on the sheet, snapshots stop arriving without a single word,
   * and on "Submit" the teacher sees text half an hour old.
   */
  const id = room()
  const said: string[] = []
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb)
      return this
    },
    ping() {},
    terminate() {},
    close() {},
  } as unknown as WebSocket
  handleControlSocket(ws, id, who('participant', id))

  const onMessage = handlers.get('message')
  assert.ok(onMessage, 'the socket did not subscribe to messages')
  const huge = JSON.stringify({ t: 'council:draft', cellId: 'c_1', text: 'ы'.repeat(40_000) })
  onMessage(Buffer.from(huge, 'utf8') as unknown as RawData, false)
  assert.match(said[0] ?? '', /слишком длинн/i)
  closeControlRoom(id)
})
