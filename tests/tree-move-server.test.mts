/**
 * Moving in the tree — what until now was asked for only as a rename in place.
 *
 * The tree is about to be dragged around with the mouse: `tree:move` will be
 * called ten times as often and on folders, not on a single name. This breaks
 * silently. Files move with one `rename`, while everything that remembers
 * their path by heart — the projector, the speaker notes, the notebook, an
 * open tab — stays on the old one, and people find out half an hour later,
 * when the document on the screen will not open.
 *
 * No network, no kernel: the socket is fake, the room is real. Half of the
 * assertions here are about the PHRASE, not the disk: a refusal is read in the
 * middle of class, and ""sub" is not valid as a name" instead of "cannot be
 * put inside itself" sends the teacher off to rename something that is
 * perfectly fine.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createSession, notesOf, setNote } from '../server/src/db.js'
import { listTree, makeDir, makeFile, sessionDir, statPath } from '../server/src/workspace.js'
import { boardOf, closeControlRoom, dispatch } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { addBook, bookAt } from '../shared/notebook.js'
import { lectureOf, startLecture, stopLecture } from '../server/src/lecture.js'
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
  const id = `move-${++rooms}`
  createSession(id, 'Переезд', null)
  return id
}

function who(sessionId: string, role: 'host' | 'participant'): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/**
 * What the server said in reply. `null` means it said nothing, and that is an
 * answer too: a gesture that changed nothing must not complain.
 */
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

/* ---------------------------------------------------------------- moving */

test('a file moves to another folder, not just changes its name', () => {
  // Before drag and drop, the only way to call `tree:move` was a rename in
  // place, and nobody checked a move between folders.
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'train.py', 'x = 1\n')

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'train.py', to: 'src/train.py' }), null)

  assert.ok(statPath(id, 'src/train.py'), 'the file did not reach the folder')
  assert.equal(statPath(id, 'train.py'), null, 'the file also stayed in the old place')
  closeControlRoom(id)
})

test('a folder moves with everything in it: notebook, notes, lecture and board', () => {
  /*
   * The cascade computes the new path as `to + was.slice(from.length)`, and it
   * must be checked precisely on something NESTED: for a rename in place the
   * length of `from` is the same as the folder's, and a mistake in this
   * arithmetic is not visible there.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  makeDir(id, 'курс')
  makeDir(id, 'слайды')
  makeFile(id, 'слайды/l3.pdf', '%PDF-1.4')
  makeFile(id, 'слайды/task.ipynb', '{}')
  addBook(doc, 'слайды/task.ipynb')
  setNote(id, 'слайды/l3.pdf', 7, 'спросить про поток')
  say(id, 'host', { t: 'board:open', name: 'слайды/l3.pdf' })
  startLecture(id, { file: 'слайды/l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'слайды', to: 'курс/слайды' }), null)

  assert.ok(statPath(id, 'курс/слайды/l3.pdf'), 'the file did not move')
  assert.equal(boardOf(id), 'курс/слайды/l3.pdf', 'the screen kept a path that does not exist')
  assert.equal(lectureOf(id)?.file, 'курс/слайды/l3.pdf', 'the lecture stayed on a dead path')
  assert.ok(bookAt(doc, 'курс/слайды/task.ipynb'), 'the notebook did not follow its folder')
  assert.equal(bookAt(doc, 'слайды/task.ipynb'), null, 'the notebook also stayed at the old address')
  assert.deepEqual(notesOf(id, 'курс/слайды/l3.pdf'), { 7: 'спросить про поток' })

  stopLecture(id)
  closeControlRoom(id)
})

test('a truncated tree does not leave the projector on a dead path', () => {
  /*
   * The file list hits a cap of two thousand rows, and `pip install -t .`
   * eats it whole. The move cascade was computed FROM THIS list — so a
   * document the walk did not reach did not move with its folder: the
   * projector stayed on a path that no longer exists on disk, and the speaker
   * notes for it under a key that does not exist. Exactly the file that is on
   * the screen right now is the one whose loss all twenty people will notice
   * at once.
   */
  const id = room()
  makeDir(id, 'слайды')
  makeFile(id, 'слайды/l3.pdf', '%PDF-1.4')
  setNote(id, 'слайды/l3.pdf', 3, 'здесь про дивергенцию')
  const dir = sessionDir(id)
  for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(dir, `f${i}.csv`), '')

  const tree = listTree(id)
  assert.equal(tree.truncated, true, 'the cap did not kick in — the test checks nothing')
  assert.ok(
    !tree.files.some((file) => file.path === 'слайды/l3.pdf'),
    'the document is still in the list — the test checks nothing',
  )

  say(id, 'host', { t: 'board:open', name: 'слайды/l3.pdf' })
  startLecture(id, { file: 'слайды/l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  assert.equal(say(id, 'host', { t: 'tree:move', from: 'слайды', to: 'лекции' }), null)

  assert.equal(boardOf(id), 'лекции/l3.pdf', 'the board computed the move from the truncated list')
  assert.equal(lectureOf(id)?.file, 'лекции/l3.pdf', 'the lecture computed the move from it too')
  assert.deepEqual(notesOf(id, 'лекции/l3.pdf'), { 3: 'здесь про дивергенцию' })

  stopLecture(id)
  closeControlRoom(id)
})

/* -------------------------------------------------------------- refusals */

test('a folder is not put inside itself, and this is said about the place, not the name', () => {
  /*
   * A one-row miss: a folder is dropped onto something inside itself. The
   * server answered `bad-name`, and the phrase came from `whySegmentRefused` —
   * ""src" is not valid as a name" — and the teacher went off to invent another
   * name for something that is perfectly fine. It is not the name that is
   * unfit, but the place.
   */
  const id = room()
  makeFile(id, 'src/model.py', 'x = 1\n')
  makeDir(id, 'src/deep')

  const said = say(id, 'host', { t: 'tree:move', from: 'src', to: 'src/deep/src' })

  assert.match(said ?? '', /внутрь себя/, `the refusal explained the wrong thing: ${said}`)
  assert.doesNotMatch(said ?? '', /качестве имени/, 'a complaint about the name, while the place is to blame')
  assert.ok(statPath(id, 'src/model.py'), 'the subtree left the tree')
  closeControlRoom(id)
})

test('a move to nowhere is a quiet nothing, not a file colliding with itself', () => {
  /*
   * The mouse is released where it was picked up more often than it hits the
   * neighbouring folder. `existsSync(target)` stood before the "is this the
   * same path" check, and the gesture came back with the phrase ""data.csv"
   * already exists in this folder": the person read that the file did not fit
   * next to itself, and went looking for a double.
   */
  const id = room()
  makeFile(id, 'data.csv', 'a,b\n')

  assert.equal(
    say(id, 'host', { t: 'tree:move', from: 'data.csv', to: 'data.csv' }),
    null,
    'a gesture that did not happen got scolded',
  )
  assert.ok(statPath(id, 'data.csv'), 'the file vanished out of nowhere')
  closeControlRoom(id)
})

test('a taken name in another folder names the folder, not just the file', () => {
  /*
   * ""data.csv" already exists in this folder" is right precisely for a rename
   * in place: there "this folder" is the one that is open. For a drag, "this"
   * points to the folder it was dragged FROM, and a room can have several
   * data.csv files with the same name — and the person does not understand
   * where exactly it did not fit.
   */
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'data.csv', 'a,b\n')
  makeFile(id, 'src/data.csv', 'c,d\n')

  const said = say(id, 'host', { t: 'tree:move', from: 'data.csv', to: 'src/data.csv' })

  assert.match(said ?? '', /«data\.csv»/, `the refusal did not name the file: ${said}`)
  assert.match(said ?? '', /«src»/, `the refusal did not name the folder: ${said}`)
  assert.equal(statPath(id, 'data.csv')?.size, 4, 'the file moved over a taken name')

  // And a rename in place says exactly what it always said: there is no need
  // to name the folder there, it is right in front of you.
  makeFile(id, 'src/model.py', 'x = 1\n')
  const renamed = say(id, 'host', { t: 'tree:move', from: 'src/model.py', to: 'src/data.csv' })
  assert.match(
    renamed ?? '',
    /в этой папке уже есть/,
    `the rename phrase drifted: ${renamed}`,
  )
  closeControlRoom(id)
})

test('contents that would go past the eighth level do not move silently', () => {
  /*
   * The depth was checked only for the moving path itself. A folder from the
   * seventh level landed on the sixth — and everything that ended up deeper
   * than the eighth vanished from the panel: the `listTree` walk does not go
   * there and does not set `truncated` either, so the list declares itself
   * complete. The file can be neither opened, nor downloaded, nor removed one
   * by one, yet it takes up space.
   */
  const id = room()
  makeDir(id, 'куда')
  assert.equal(makeFile(id, 'deep/a/b/c/d/e/f/g.py', 'x = 1\n'), 'ok')

  const said = say(id, 'host', { t: 'tree:move', from: 'deep', to: 'куда/deep' })

  assert.match(said ?? '', /Допустимая глубина пути — до 8 уровней/, `a move past the cap went through silently: ${said}`)
  assert.ok(statPath(id, 'deep/a/b/c/d/e/f/g.py'), 'the file went past the addressable depth after all')
  closeControlRoom(id)
})

test('contents that would go past the addressable path length do not move silently', () => {
  /*
   * The same hole as with depth, only in characters: `normalizePath` measures
   * the path that was sent, and it is short. The contents went past four
   * hundred characters — and after that `resolveInSession` does not let them
   * through: the file is in the list, but there is nothing to open, download
   * or remove it one by one with, yet it takes up space. "Remove" got a phrase
   * about the wrong thing — ""data.csv" is not valid as a name".
   */
  const id = room()
  const long = 'a'.repeat(120)
  const far = 'b'.repeat(40)
  const buried = `${long}/${long}/${long}/data.csv`
  assert.equal(makeFile(id, buried, 'a,b\n'), 'ok')
  makeDir(id, far)

  const said = say(id, 'host', { t: 'tree:move', from: long, to: `${far}/${long}` })

  assert.match(said ?? '', /превысит 400 символов/, `a move past the length went through silently: ${said}`)
  assert.match(said ?? '', /нельзя переместить/, `the refusal complained about the wrong thing: ${said}`)
  assert.ok(statPath(id, buried), 'the file moved to a path that can no longer be named')
  closeControlRoom(id)
})

test('the list shows a folder at the very bottom, but never its contents', () => {
  /*
   * The panel relies on this: under such a folder it writes "nothing visible
   * deeper", not "empty". `truncated` is not set here — it counts only rows —
   * and there will be no "not shown in full" row at the bottom either. The
   * rule lives in the walk, so it is checked here; `readsInside` in
   * web/src/lib/tree-move.ts repeats it in words.
   */
  const id = room()
  // Via a cell, not `makeFile`: nine segments is a path the room cannot name,
  // and it will not let you create one itself. `os.makedirs` does.
  const deep = 'a/b/c/d/e/f/g/h'
  fs.mkdirSync(path.join(sessionDir(id), deep), { recursive: true })
  fs.writeFileSync(path.join(sessionDir(id), `${deep}/x.py`), 'x = 1\n')

  const tree = listTree(id)

  assert.equal(tree.truncated, false, 'the depth cap passed itself off as the row cap')
  assert.ok(
    tree.files.some((file) => file.path === deep),
    'the bottom folder vanished from the list — the panel has nothing to talk about',
  )
  assert.ok(
    !tree.files.some((file) => file.path === `${deep}/x.py`),
    'the bottom contents suddenly got into the list — the test checks nothing',
  )
  closeControlRoom(id)
})

test('a name that differs only in case is a rename, not a collision', () => {
  /*
   * On macOS "Data" and "data" are the same folder, and `existsSync(target)`
   * answered "taken" with the source itself: changing the case of a name was
   * not possible at all. On Linux the same rename always went through — one
   * operation behaved differently on the developer's machine and on the
   * server.
   */
  const id = room()
  makeDir(id, 'Data')
  makeFile(id, 'Data/train.csv', 'a,b\n')

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'Data', to: 'data' }), null)

  const names = listTree(id).files.map((file) => file.name)
  assert.ok(names.includes('data'), `the folder did not change its spelling: ${names.join(', ')}`)
  assert.ok(!names.includes('Data'), 'the old spelling stayed in the tree')
  assert.ok(statPath(id, 'data/train.csv'), 'the contents did not follow the name')
  closeControlRoom(id)
})

/* ----------------------------------------------------------------- rights */

test('a teacher can move a file in the room, a participant cannot', () => {
  /*
   * Tree edits are split on purpose: CREATING is allowed by the room rule
   * (`files`), while REMOVING and RENAMING are for the teacher only, because
   * both remove: after a move the old path is gone just as a deleted file is
   * gone. Dragging is the same move, and the bar for it is the same; a
   * participant simply cannot pick up a row in the panel.
   */
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'train.py', 'x = 1\n')

  const said = say(id, 'participant', { t: 'tree:move', from: 'train.py', to: 'src/train.py' })

  assert.match(said ?? '', /преподаватель/, `a participant was allowed to move a file: ${said}`)
  assert.ok(statPath(id, 'train.py'), 'the file moved after all')
  assert.equal(say(id, 'host', { t: 'tree:move', from: 'train.py', to: 'src/train.py' }), null)
  assert.ok(statPath(id, 'src/train.py'), 'the move did not work for the teacher either')
  closeControlRoom(id)
})

/* ------------------------------------------- a refusal on one of the paths */

test('a refusal on one path does not leave the room half moved', () => {
  /*
   * Notes are the only thing in the cascade that goes to the database, and
   * there the move had a refusal of its own: the key (room, file, page) was
   * taken, and notes are deleted NOWHERE except when a seminar is deleted.
   * Someone annotated "draft.pdf", removed it, created a file with the same
   * name — and the bare `UPDATE lecture_notes SET file` failed in the middle of
   * the loop. The exception broke off the whole cascade: the files on disk
   * had already moved, while the notebook, the board and the tabs stayed on
   * the old paths, and the person got an English SQLite line instead of an
   * explanation. Now it neither fails nor loses anything — but the cascade
   * must hold even without that.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  makeFile(id, 'папка/a.pdf', '%PDF-1.4')
  makeFile(id, 'папка/task.ipynb', '{}')
  addBook(doc, 'папка/task.ipynb')
  // Notes for the path the annotated file is about to move to: that very
  // taken key pair.
  setNote(id, 'курс/a.pdf', 7, 'речь к прошлому черновику')
  setNote(id, 'папка/a.pdf', 7, 'речь к этому файлу')
  say(id, 'host', { t: 'board:open', name: 'папка/a.pdf' })

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'папка', to: 'курс' }), null)

  assert.ok(statPath(id, 'курс/a.pdf'), 'the file did not move')
  assert.equal(boardOf(id), 'курс/a.pdf', 'the board stayed on the old path because of an unrelated refusal')
  assert.ok(bookAt(doc, 'курс/task.ipynb'), 'the notebook did not arrive — the cascade broke off in the middle')
  /*
   * And the notes arrive: `moveNotesTo` moves them with `UPDATE OR REPLACE`,
   * so the leftover under the target path — notes for a document that has
   * long been gone from there — gives way to the notes for the file that has
   * just arrived there.
   */
  assert.deepEqual(
    notesOf(id, 'курс/a.pdf'),
    { 7: 'речь к этому файлу' },
    'the notes of the annotated file stayed under a path that no longer exists on disk',
  )
  assert.deepEqual(notesOf(id, 'папка/a.pdf'), {}, 'the notes also stayed on the old path')
  closeControlRoom(id)
})
