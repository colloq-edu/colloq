/**
 * Duplicating a file — the tree's fourth verb next to "create", "move" and
 * "remove".
 *
 * It breaks in the same ways as its neighbours, plus one of its own: a copy is
 * a WRITE to disk whose size nobody ordered. So this is about the right (a
 * copy adds, so the rule is `files`, not the role), about the name (a taken
 * one is the normal case, not a refusal), about the bounds of the class folder
 * and about both caps: per file and for the room as a whole.
 *
 * No network, no kernel: the socket is fake, the room is real — the same
 * technique as in `tree-move-server.test.mts`.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import {
  freeCopyName,
  listFiles,
  makeDir,
  makeFile,
  readText,
  resolveInSession,
  sessionDir,
  statPath,
} from '../server/src/workspace.js'
import { closeControlRoom, dispatch } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { addBook, bookAt, bookCells, createCell } from '../shared/notebook.js'
import { config } from '../server/src/config.js'
import { setLocaleResolver } from '../shared/i18n.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Exactly what `send` reads: the state and the frame intake. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on() {
      return this
    },
    ping: () => {},
    terminate: () => {},
    close: () => {},
  } as unknown as WebSocket
  return { ws, heard }
}

let rooms = 0

function room(): string {
  const id = `copy-${++rooms}`
  createSession(id, 'Копия', null)
  return id
}

function who(sessionId: string, role: 'host' | 'participant'): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** What the server said in reply; `null` means it said nothing. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, heard } = socket()
  dispatch(ws, sessionId, who(sessionId, role), message)
  const refusal = heard.find(
    (frame): frame is Extract<ControlServerMessage, { t: 'error' }> => frame.t === 'error',
  )
  return refusal?.message ?? null
}

/* ------------------------------------------------------------ copy name */

test('a copy is named a copy, and the next one the second: a person sees the name', () => {
  const id = room()
  makeFile(id, 'train.py', 'x = 1\n')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'train.py' }), null)
  assert.ok(statPath(id, 'train (копия).py'), 'there is no copy next to the original')
  assert.ok(statPath(id, 'train.py'), 'the original vanished — this is not copying')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'train.py' }), null)
  assert.ok(statPath(id, 'train (копия 2).py'), 'the second copy did not get its number')
  closeControlRoom(id)
})

test('an extension stays an extension, and a name without a dot stays a name', () => {
  const id = room()
  makeFile(id, 'данные.tar.gz', 'x')
  makeFile(id, 'Makefile', 'all:\n')

  say(id, 'host', { t: 'tree:copy', path: 'данные.tar.gz' })
  say(id, 'host', { t: 'tree:copy', path: 'Makefile' })

  // The LAST dot is taken: "данные.tar (копия).gz" would open in an archiver,
  // and "данные.tar.gz (копия)" in nothing.
  assert.ok(statPath(id, 'данные.tar (копия).gz'), 'the archive copy is named wrongly')
  assert.ok(statPath(id, 'Makefile (копия)'), 'a file without a dot got an extension added')
  closeControlRoom(id)
})

test('the copy lands in the same folder as the original', () => {
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'src/model.py', 'import torch\n')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'src/model.py' }), null)

  assert.ok(statPath(id, 'src/model (копия).py'), 'the copy left its folder')
  assert.equal(statPath(id, 'model (копия).py'), null, 'the copy landed in the root')
  closeControlRoom(id)
})

test('the word for "copy" comes from the dictionary: in an English room the name is English', () => {
  const id = room()
  makeFile(id, 'train.py', 'x = 1\n')
  setLocaleResolver(() => 'en')
  try {
    assert.equal(say(id, 'host', { t: 'tree:copy', path: 'train.py' }), null)
    assert.ok(statPath(id, 'train copy.py'), 'in an English room the copy is named in Russian')
  } finally {
    setLocaleResolver(() => 'ru')
  }
  closeControlRoom(id)
})

test('a long name is trimmed, not rejected for its length', () => {
  /*
   * `safeSegment` rejects a segment longer than 120 characters outright, and
   * without trimming, duplicating a file with a hundred-and-seventeen-letter
   * name — an ordinary export from an LMS — would answer "the name is not
   * valid" about a name the person never typed.
   */
  const id = room()
  const long = 'о'.repeat(112) + '.csv'
  makeFile(id, long, 'a,b\n')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: long }), null)

  const copy = listFiles(id).find((entry) => entry.name !== long)
  assert.ok(copy, 'no copy of the long name appeared')
  assert.ok(copy.name.length <= 120, `the copy name is longer than the limit: ${copy.name.length}`)
  assert.match(copy.name, /\(копия\)\.csv$/)
  closeControlRoom(id)
})

/* ----------------------------------------------------------- the right */

test('duplicating is open to whoever the room rule allows files — not only the teacher', () => {
  /*
   * A copy ADDS a file, like "new file" and like an upload, so its rule is
   * `files`, not the role. Renaming and deleting stay with the teacher: they
   * remove the previous path, and this does not.
   */
  const open = room()
  makeFile(open, 'решение.py', 'print(1)\n')
  assert.equal(say(open, 'participant', { t: 'tree:copy', path: 'решение.py' }), null)
  assert.ok(statPath(open, 'решение (копия).py'), 'a student could not duplicate in an open room')
  closeControlRoom(open)

  const closed = room()
  setRules(closed, { files: 'host' })
  makeFile(closed, 'раздатка.csv', 'a,b\n')
  const refusal = say(closed, 'participant', { t: 'tree:copy', path: 'раздатка.csv' })
  assert.match(refusal ?? '', /преподаватель/i)
  assert.equal(statPath(closed, 'раздатка (копия).csv'), null, 'the file was copied after all')
  // But the teacher in the same room may.
  assert.equal(say(closed, 'host', { t: 'tree:copy', path: 'раздатка.csv' }), null)
  assert.ok(statPath(closed, 'раздатка (копия).csv'))
  closeControlRoom(closed)
})

/* -------------------------------------------------------------- bounds */

test('a copy does not leave the class folder: neither by ".." nor by an absolute path', () => {
  const id = room()
  makeFile(id, 'train.py', 'x = 1\n')
  const outside = path.join(sessionDir(id), '..', 'чужое.txt')
  fs.writeFileSync(outside, 'секрет')

  for (const wanted of ['../чужое.txt', '/etc/hosts', 'src/../../чужое.txt']) {
    const refusal = say(id, 'host', { t: 'tree:copy', path: wanted })
    assert.ok(refusal, `the path "${wanted}" went through silently`)
  }
  // And nothing was created either next to the folder or inside it.
  assert.equal(fs.readFileSync(outside, 'utf8'), 'секрет')
  assert.deepEqual(
    listFiles(id).map((entry) => entry.path),
    ['train.py'],
  )
  fs.rmSync(outside, { force: true })
  closeControlRoom(id)
})

test('a symlink pointing outside is not copied, even if it is visible in the folder', () => {
  /*
   * A cell can call `os.symlink('/etc/hosts', 'hosts.txt')`. There is no such
   * entry in the tree (`listTree` walks with lstat), but the frame can be sent
   * by hand too. Copying must refuse, not carry the target's contents into the
   * room as an ordinary file.
   */
  const id = room()
  const link = path.join(sessionDir(id), 'hosts.txt')
  try {
    fs.symlinkSync('/etc/hosts', link)
  } catch {
    return // on a file system without links there is nothing to check
  }
  const refusal = say(id, 'host', { t: 'tree:copy', path: 'hosts.txt' })
  assert.ok(refusal, 'the link was copied silently')
  assert.equal(statPath(id, 'hosts (копия).txt'), null, 'the contents of the link target landed in the room')
  fs.rmSync(link, { force: true })
  closeControlRoom(id)
})

test('a folder is not duplicated, and the refusal says exactly that', () => {
  const id = room()
  makeDir(id, 'данные')
  makeFile(id, 'данные/train.csv', 'a,b\n')

  const refusal = say(id, 'host', { t: 'tree:copy', path: 'данные' })
  assert.match(refusal ?? '', /Папки не дублируются/)
  assert.equal(statPath(id, 'данные (копия)'), null)
  closeControlRoom(id)
})

test('a vanished file answers "it is no longer there", not "it did not work"', () => {
  const id = room()
  const refusal = say(id, 'host', { t: 'tree:copy', path: 'которого.нет' })
  assert.match(refusal ?? '', /уже нет|no longer/i)
  closeControlRoom(id)
})

/* ----------------------------------------------------------------- caps */

test('a file larger than the upload cap is not duplicated, and the refusal names the megabytes', () => {
  const id = room()
  const full = resolveInSession(id, 'big.bin')
  assert.ok(full)
  // Larger than the per-file cap, but certainly smaller than the room cap: it
  // is the first boundary that must be checked.
  fs.writeFileSync(full, Buffer.alloc(config.maxUploadBytes + 1024))

  const refusal = say(id, 'host', { t: 'tree:copy', path: 'big.bin' })
  assert.match(refusal ?? '', /МБ|MB/)
  assert.equal(statPath(id, 'big (копия).bin'), null, 'the copy of the large file landed after all')
  fs.rmSync(full, { force: true })
  closeControlRoom(id)
})

test('a copy that does not fit under the room cap is not written at all', () => {
  const id = room()
  const full = resolveInSession(id, 'dataset.bin')
  assert.ok(full)
  // One file of half the room cap passes its own cap, but its copy next to it
  // no longer does.
  const half = Math.floor(config.maxSessionBytes / 2) + 1024
  const was = config.maxUploadBytes
  try {
    ;(config as { maxUploadBytes: number }).maxUploadBytes = config.maxSessionBytes
    fs.writeFileSync(full, Buffer.alloc(half))
    const refusal = say(id, 'host', { t: 'tree:copy', path: 'dataset.bin' })
    assert.match(refusal ?? '', /вмещает|room for/i)
    assert.equal(statPath(id, 'dataset (копия).bin'), null)
    // And not a single half-written leftover: temporary names start with a dot
    // and do not show up in the tree, yet they take up space.
    const left = fs.readdirSync(sessionDir(id)).filter((name) => name.startsWith('.'))
    assert.deepEqual(left, [], `temporary files were left after the refusal: ${left.join(', ')}`)
  } finally {
    ;(config as { maxUploadBytes: number }).maxUploadBytes = was
    fs.rmSync(full, { force: true })
  }
  closeControlRoom(id)
})

/* ------------------------------------------------------------- notebook */

test('a room notebook is copied fresh — the projection is flushed before copying', () => {
  /*
   * The notebook file is written with a delay of a second and a half after the
   * last edit (collab/books.ts). Copying it without flushing the projection
   * means handing the person a notebook without the cell they have just
   * typed — and silently.
   *
   * The copy stays an ordinary .ipynb in the folder: bringing it into the room
   * is a separate action with a separate rule.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  makeFile(id, 'занятие.ipynb', '{}')
  const book = addBook(doc, 'занятие.ipynb')
  bookCells(doc, book.root).push([createCell('code', 'import pandas as pd')])

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'занятие.ipynb' }), null)

  const copy = readText(id, 'занятие (копия).ipynb')
  assert.ok(copy, 'there is no copy of the notebook')
  assert.match(copy.text, /import pandas as pd/, 'the copy is behind the document by the last cell')
  // And it is a file, not a second room notebook: bringing it in is a
  // separate action.
  assert.equal(bookAt(doc, 'занятие (копия).ipynb'), null)
  closeControlRoom(id)
})

/* ------------------------------------------------------------ direct call */

test('freeCopyName does not offer a taken name', () => {
  const id = room()
  makeFile(id, 'a.txt', '1')
  makeFile(id, 'a (копия).txt', '1')
  makeFile(id, 'a (копия 2).txt', '1')

  assert.equal(freeCopyName(id, 'a.txt'), 'a (копия 3).txt')
  closeControlRoom(id)
})
