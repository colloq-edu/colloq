/**
 * Access to a SEPARATE notebook of the room.
 *
 * The room rules were the same for all notebooks, and in class this broke
 * on the most common gesture: a student makes themselves a copy of the
 * walkthrough and cannot type in their own notebook, because the room is a
 * lecture. Now a notebook has its own access, and the whole fork lives in
 * ONE function (`rulesForBook`), used by both the server and the browser.
 *
 * Hence the order of the checks. First the function itself and reading the
 * rules: a mistake there is silent and costs either a locked room or
 * someone else's notebook left open. Then the gate on real frames: a button
 * can go unpressed while a frame is sent around the interface, and the
 * server must refuse. Then the control socket: run, move, format. And
 * finally the author record: the server makes it at the moment the notebook
 * is created, and it decides whom the menu names as the owner.
 *
 * No network and no kernel, except for one route: "a participant does not
 * change access" is checked over real HTTP, because there is one door there
 * and it is the door that checks it.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import {
  bookHasOwnKernel,
  bookRefusal,
  BOOK_IS_PERSONAL,
  BOOK_IS_THE_TEACHERS,
  MAX_BOOK_OWNER_NAME,
  MAX_BOOK_RULES,
  MAX_OWN_BOOKS,
  OPEN_ROOM,
  readRules,
  rulesAfterClass,
  rulesForBook,
  type BookRule,
  type RoomRules,
} from '../shared/rules.js'
import {
  bookAt,
  bookCells,
  CELLS_KEY,
  cellSource,
  createCell,
  META_KEY,
} from '../shared/notebook.js'
import { classify, permits } from '../server/src/collab/gate.js'
import {
  createSession,
  getRules,
  setFinished,
  setRules,
  storedRules,
  upsertParticipant,
} from '../server/src/db.js'
import { dispatch } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { createBook, dropBook, moveBook, openBook, ownBooksOf, ownsBookAt } from '../server/src/collab/books.js'
import { makeFile, statPath } from '../server/src/workspace.js'
import { writeIpynb } from '../shared/ipynb.js'
import { app } from '../server/src/app.js'
import { signToken, type TokenPayload } from '../server/src/auth.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import { accessOptions, accessPatch, bookMark } from '../web/src/lib/book-access.js'
import { permitsIn } from '../web/src/lib/may.js'

const AKIM = 'p_akim'
const BORIS = 'p_boris'

/** A room where one notebook is personal: Akim's. */
function withPersonal(room: Partial<RoomRules>, root = 'nb:one'): RoomRules {
  return {
    ...OPEN_ROOM,
    ...room,
    books: { [root]: { access: 'owner', owner: AKIM, ownerName: 'Аким' } },
  }
}

const student = (id: string) => ({ role: 'participant' as const, participantId: id })

/* ----------------------------------------------------- the fork itself */

test('a personal notebook is open to its author and the teacher, and closed to everyone else', () => {
  // The room is a lecture: nobody but the host may type or run in it.
  const rules = withPersonal({ edit: 'host', run: 'host', structure: 'host' })

  const mine = rulesForBook(rules, 'nb:one', student(AKIM))
  assert.deepEqual(
    [mine.edit, mine.run, mine.structure],
    ['room', 'room', 'room'],
    'the author did not get their notebook',
  )
  const theirs = rulesForBook(rules, 'nb:one', student(BORIS))
  assert.deepEqual([theirs.edit, theirs.run, theirs.structure], ['host', 'host', 'host'])

  /*
   * The kernel and output of ONE'S OWN notebook are one's own, and that is
   * exactly two knobs.
   *
   * A personal notebook has its own kernel in a separate container
   * (`bookHasOwnKernel`): "restart" in it takes away one person's variables,
   * and "clear outputs" their own output. Requiring the teacher for this
   * would mean raising a hand in the middle of a lecture to declare `x`
   * again in one's own draft.
   */
  assert.deepEqual([mine.restart, mine.wipe], ['room', 'room'], 'the author was not given their own kernel')
  assert.deepEqual(
    [theirs.restart, theirs.wipe],
    [rules.restart, rules.wipe],
    'a personal notebook of another person handed out rights to its kernel',
  )

  // The other room rules are not touched by a notebook: board, files, history.
  assert.equal(mine.files, rules.files)
  assert.equal(mine.board, rules.board)

  // The room notebook stays the room's for both, and it is the same object.
  assert.equal(rulesForBook(rules, CELLS_KEY, student(AKIM)), rules)
  // The teacher passes straight through: a notebook closed "to them only" is not closed to them.
  assert.equal(rulesForBook(rules, 'nb:one', { role: 'host', participantId: 'p_host' }), rules)
})

test('"open to everyone" lets in when the room is closed, "teacher only" closes when it is open', () => {
  const open: RoomRules = {
    ...OPEN_ROOM,
    edit: 'host',
    run: 'host',
    structure: 'host',
    books: { 'nb:one': { access: 'all', owner: null, ownerName: null } },
  }
  const all = rulesForBook(open, 'nb:one', student(BORIS))
  assert.deepEqual([all.edit, all.run, all.structure], ['room', 'room', 'room'])
  /*
   * "Open to everyone" does not hand out kernels.
   *
   * A notebook open to everyone is still the CLASS's notebook: its kernel
   * lives in the room's container (`bookHasOwnKernel` answers "no" for it),
   * and "restart" in it means wiping the class's variables. That is exactly
   * the difference from a personal one, and without this line it would rest
   * on a single word in the code.
   */
  assert.deepEqual([all.restart, all.wipe], [open.restart, open.wipe])

  const shut: RoomRules = {
    ...OPEN_ROOM,
    books: { 'nb:one': { access: 'host', owner: null, ownerName: null } },
  }
  const only = rulesForBook(shut, 'nb:one', student(BORIS))
  assert.deepEqual([only.edit, only.run, only.structure], ['host', 'host', 'host'])
  // And the room stayed open meanwhile: the override lives on one notebook.
  assert.equal(rulesForBook(shut, CELLS_KEY, student(BORIS)).edit, 'room')
})

test('when the notebook refuses, the notebook speaks, not the room', () => {
  const rules = withPersonal({ edit: 'host' })
  assert.deepEqual(bookRefusal(rules, 'nb:one', student(BORIS)), {
    key: BOOK_IS_PERSONAL,
    name: 'Аким',
  })
  // The notebook does not refuse its author or the teacher at all.
  assert.equal(bookRefusal(rules, 'nb:one', student(AKIM)), null)
  assert.equal(bookRefusal(rules, 'nb:one', { role: 'host', participantId: 'p_host' }), null)
  // "Open to everyone" is no refusal either: it allows.
  const opened: RoomRules = {
    ...OPEN_ROOM,
    books: { 'nb:one': { access: 'all', owner: null, ownerName: null } },
  }
  assert.equal(bookRefusal(opened, 'nb:one', student(BORIS)), null)
  const shut: RoomRules = {
    ...OPEN_ROOM,
    books: { 'nb:one': { access: 'host', owner: null, ownerName: null } },
  }
  assert.deepEqual(bookRefusal(shut, 'nb:one', student(BORIS))?.key, BOOK_IS_THE_TEACHERS)
})

test('the end of a class is stronger than notebook access: after the bell nothing is opened', () => {
  const rules = withPersonal({})
  const over = rulesAfterClass(rules)
  assert.equal(over.books, undefined, 'the notebook map survived the bell')
  const mine = rulesForBook(over, 'nb:one', student(AKIM))
  assert.deepEqual([mine.edit, mine.run, mine.structure], ['host', 'host', 'host'])
  // And "open to everyone" too: after the bell only the teacher acts.
  const everyone: RoomRules = {
    ...OPEN_ROOM,
    books: { 'nb:one': { access: 'all', owner: null, ownerName: null } },
  }
  assert.equal(rulesForBook(rulesAfterClass(everyone), 'nb:one', student(BORIS)).edit, 'host')
  // The stored rules are intact meanwhile: the class gets reopened.
  assert.equal(rules.books?.['nb:one'].access, 'owner')
})

/* ---------------------------------------------------- reading the rules */

test('rules without a notebook map read as before, and garbage falls back to the default', () => {
  // A row written before notebook access existed.
  const old = readRules('{"run":"host","edit":"host"}')
  assert.equal(old.books, undefined)
  assert.equal(old.ownBooks, 'off', 'own notebooks got allowed by themselves')

  // Garbage in every place.
  const junk = readRules({
    books: {
      'nb:ok': { access: 'owner', owner: AKIM, ownerName: 'Аким' },
      'nb:bad': { access: 'нет такого', owner: AKIM },
      'nb:empty': 7,
      '': { access: 'host' },
      // "As in the room" without an author means nothing and is not stored.
      'nb:noop': { access: 'room', owner: null },
    },
    ownBooks: 'что угодно',
  })
  assert.deepEqual(Object.keys(junk.books ?? {}), ['nb:ok'])
  assert.equal(junk.ownBooks, 'off')
  // For a short while the field had another pair of values; "personal" reads as "allowed".
  assert.equal(readRules({ ownBooks: 'owner' }).ownBooks, 'on')
  assert.equal(readRules({ ownBooks: 'room' }).ownBooks, 'off')
  // But an "as in the room" record WITH an author stays: the menu will name the owner by it.
  const kept = readRules({ books: { 'nb:x': { access: 'room', owner: AKIM, ownerName: 'Аким' } } })
  assert.equal(kept.books?.['nb:x'].owner, AKIM)
})

test('the notebook map is limited in size, and the author name in length', () => {
  const many: Record<string, unknown> = {}
  for (let i = 0; i < MAX_BOOK_RULES + 40; i++) {
    many[`nb:${i}`] = { access: 'owner', owner: AKIM, ownerName: 'Аким' }
  }
  assert.equal(Object.keys(readRules({ books: many }).books ?? {}).length, MAX_BOOK_RULES)

  const long = readRules({
    books: { 'nb:x': { access: 'owner', owner: 'x'.repeat(400), ownerName: 'и'.repeat(300) } },
  })
  assert.equal(long.books?.['nb:x'].ownerName?.length, MAX_BOOK_OWNER_NAME)
  assert.ok((long.books?.['nb:x'].owner?.length ?? 0) <= 128)
})

test('access survives a round trip through the database', () => {
  const id = 'book-db'
  createSession(id, 'Круг', null)
  setRules(id, withPersonal({ edit: 'host' }))
  assert.equal(storedRules(id).books?.['nb:one'].ownerName, 'Аким')
  assert.equal(getRules(id).books?.['nb:one'].access, 'owner')
})

/* ------------------------------------------------------------------ gate */

/**
 * Two notebooks in one document and a tab that sends frames into them.
 *
 * The frames are real: the right is checked on bytes, not on made-up
 * verdicts. Exactly this can be sent around the interface, and the server
 * must refuse.
 */
function twoBooks(): {
  server: Y.Doc
  client: Y.Doc
  frame: (write: () => void) => Uint8Array
} {
  const server = new Y.Doc()
  const client = new Y.Doc()
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Семинар')
    server.getArray(CELLS_KEY).push([createCell('code', 'print(1)', 'c1')])
    server.getArray('nb:one').push([createCell('code', 'print(2)', 'c2')])
  })
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  const frame = (write: () => void): Uint8Array => {
    let captured: Uint8Array | null = null
    const grab = (u: Uint8Array): void => {
      captured = captured ? Y.mergeUpdates([captured, u]) : u
    }
    client.on('update', grab)
    client.transact(write)
    client.off('update', grab)
    assert.ok(captured)
    return captured!
  }
  return { server, client, frame }
}

/** Would this frame from this person pass under these rules. `null` means it passes. */
function passes(
  server: Y.Doc,
  bytes: Uint8Array,
  rules: RoomRules,
  role: 'host' | 'participant',
  participantId: string | null,
  finished = false,
): string | null {
  const judged = classify(server, bytes)
  if (!judged.ok) return judged.why
  const verdict = permits(judged.verdicts, rules, role, finished, participantId)
  return verdict.ok ? null : verdict.message
}

const typeInto = (client: Y.Doc, root: string): void => {
  const cell = client.getArray(root).get(0) as Y.Map<unknown>
  ;(cell.get('source') as Y.Text).insert(0, 'ы')
}

test('the gate rejects a frame into a personal notebook of another person and accepts one into your own when the room is closed', () => {
  const rules = withPersonal({ edit: 'host', structure: 'host', run: 'host' })
  {
    const { server, client, frame } = twoBooks()
    const bytes = frame(() => typeInto(client, 'nb:one'))
    // Your own passes, although the room is a lecture.
    assert.equal(passes(server, bytes, rules, 'participant', AKIM), null)
    // Someone else's is refused, and it is the NOTEBOOK that refuses, naming the author.
    const said = passes(server, bytes, rules, 'participant', BORIS) ?? ''
    assert.match(said, /Аким/, `the refusal did not name the author: ${said}`)
    // The teacher writes everywhere.
    assert.equal(passes(server, bytes, rules, 'host', 'p_host'), null)
  }
  {
    // The room's main notebook is edited by none of the students, including
    // the author of a personal one: the override lives on one notebook, not
    // on a person.
    const { server, client, frame } = twoBooks()
    const bytes = frame(() => typeInto(client, CELLS_KEY))
    assert.ok(passes(server, bytes, rules, 'participant', AKIM))
    assert.ok(passes(server, bytes, rules, 'participant', BORIS))
  }
})

test('the author changes the structure of a personal notebook, and nobody else does', () => {
  const rules = withPersonal({ edit: 'host', structure: 'host' })
  const { server, client, frame } = twoBooks()
  const bytes = frame(() => client.getArray('nb:one').push([createCell('code', 'new', 'c9')]))
  assert.equal(passes(server, bytes, rules, 'participant', AKIM), null)
  assert.match(passes(server, bytes, rules, 'participant', BORIS) ?? '', /Аким/)
})

test('"open to everyone" lets a frame in within a closed room, "teacher only" keeps it out of an open one', () => {
  {
    const { server, client, frame } = twoBooks()
    const bytes = frame(() => typeInto(client, 'nb:one'))
    const opened: RoomRules = {
      ...OPEN_ROOM,
      edit: 'host',
      books: { 'nb:one': { access: 'all', owner: null, ownerName: null } },
    }
    assert.equal(passes(server, bytes, opened, 'participant', BORIS), null)
  }
  {
    const { server, client, frame } = twoBooks()
    const bytes = frame(() => typeInto(client, 'nb:one'))
    const shut: RoomRules = {
      ...OPEN_ROOM,
      books: { 'nb:one': { access: 'host', owner: null, ownerName: null } },
    }
    assert.ok(passes(server, bytes, shut, 'participant', BORIS))
    // A notebook closed "to the teacher only" is not closed to the teacher.
    assert.equal(passes(server, bytes, shut, 'host', 'p_host'), null)
  }
})

test('after the bell even your own personal notebook is closed, and the words are about the bell', async () => {
  const { server, client, frame } = twoBooks()
  const bytes = frame(() => typeInto(client, 'nb:one'))
  const rules = rulesAfterClass(withPersonal({}))
  const said = passes(server, bytes, rules, 'participant', AKIM, true) ?? ''
  assert.ok(said, 'your own personal notebook survived the bell')
  assert.doesNotMatch(said, /Аким/, 'after the bell the refusal must talk about the bell')
  // The teacher still has everything.
  assert.equal(passes(server, bytes, rules, 'host', 'p_host', true), null)
})

test('a frame without a sender name is judged as a stranger, not as the author', () => {
  const { server, client, frame } = twoBooks()
  const bytes = frame(() => typeInto(client, 'nb:one'))
  const rules = withPersonal({ edit: 'host' })
  assert.ok(passes(server, bytes, rules, 'participant', null), 'a nameless frame passed as the author')
})

/* ------------------------------------------------------ control socket */

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

function who(sessionId: string, participantId: string, role: 'host' | 'participant'): TokenPayload {
  return { sessionId, participantId, role }
}

function say(
  sessionId: string,
  payload: TokenPayload,
  message: ControlClientMessage,
): string | null {
  const { ws, said } = socket()
  dispatch(ws, sessionId, payload, message)
  return said[0] ?? null
}

/** A room with two notebooks and real cells in both. */
function roomWithBooks(id: string): { main: string; own: string } {
  createSession(id, 'Тетради', null)
  const { doc } = getSessionDoc(id)
  // Own notebooks are allowed: otherwise the student creates none, and there
  // would be nothing to check access on.
  setRules(id, { ...OPEN_ROOM, ownBooks: 'on' })
  const made = createBook(id, 'Аким.ipynb', {
    participantId: AKIM,
    name: 'Аким',
    role: 'participant',
  })
  assert.ok(made.ok)
  const own = made.ok ? made.book.root : ''
  doc.transact(() => {
    bookCells(doc, CELLS_KEY).push([createCell('code', 'print(1)', `${id}-main`)])
    bookCells(doc, own).push([createCell('code', 'print(2)', `${id}-own`)])
  })
  return { main: `${id}-main`, own: `${id}-own` }
}

test('a run asks the notebook it was pressed in', () => {
  const id = 'book-run'
  const cells = roomWithBooks(id)
  const root = storedRules(id).books ? Object.keys(storedRules(id).books!)[0] : ''
  setRules(id, {
    ...OPEN_ROOM,
    run: 'host',
    edit: 'host',
    structure: 'host',
    books: { [root]: { access: 'owner', owner: AKIM, ownerName: 'Аким' } },
  })
  const akim = who(id, AKIM, 'participant')
  const boris = who(id, BORIS, 'participant')

  // Your own notebook computes even in a lecture; the room notebook does not.
  assert.equal(say(id, akim, { t: 'run', cellId: cells.own }), null)
  assert.ok(say(id, akim, { t: 'run', cellId: cells.main }))
  // Someone else's personal notebook does not compute, and the refusal names the author.
  assert.match(say(id, boris, { t: 'run', cellId: cells.own }) ?? '', /Аким/)

  // The whole sheet goes by the same notebook.
  assert.equal(say(id, akim, { t: 'runAll', book: 'Аким.ipynb' }), null)
  assert.ok(say(id, akim, { t: 'runAll' }), 'Run All over the room notebook went through in a lecture')
  assert.ok(say(id, boris, { t: 'runAll', book: 'Аким.ipynb' }))
})

test('moving, formatting and clearing output go by the notebook of the cell', () => {
  const id = 'book-move'
  const cells = roomWithBooks(id)
  const root = Object.keys(storedRules(id).books ?? {})[0]
  setRules(id, {
    ...OPEN_ROOM,
    run: 'host',
    edit: 'host',
    structure: 'host',
    books: { [root]: { access: 'owner', owner: AKIM, ownerName: 'Аким' } },
  })
  const akim = who(id, AKIM, 'participant')
  const boris = who(id, BORIS, 'participant')

  assert.equal(say(id, akim, { t: 'cells:move', cellId: cells.own, direction: 1 }), null)
  assert.ok(say(id, akim, { t: 'cells:move', cellId: cells.main, direction: 1 }))
  assert.match(say(id, boris, { t: 'cells:move', cellId: cells.own, direction: 1 }) ?? '', /Аким/)

  // Your own cell is cleared by the right to type, that is, by the rules of your own notebook.
  assert.equal(say(id, akim, { t: 'clearOutputs', cellId: cells.own }), null)
  assert.ok(say(id, akim, { t: 'clearOutputs', cellId: cells.main }))

  // black rewrites EVERY cell of the named notebook, and asks that notebook.
  assert.ok(say(id, boris, { t: 'format', book: 'Аким.ipynb' }))
  assert.ok(say(id, akim, { t: 'format' }), 'formatting of the room notebook went through in a lecture')
})

test('the author restarts the kernel and clears the output of their own notebook', () => {
  /*
   * A personal notebook has its own kernel in a separate container, and
   * "restart" in it takes away one person's variables, their own. Requiring
   * the teacher for this would mean raising a hand in the middle of a
   * lecture to declare `x` again in one's own draft. In the room notebook
   * and in someone else's personal one the rule is as before: restart
   * belongs to the teacher.
   */
  const id = 'book-restart'
  roomWithBooks(id)
  const root = Object.keys(storedRules(id).books ?? {})[0]
  setRules(id, {
    ...OPEN_ROOM,
    wipe: 'host',
    restart: 'host',
    books: { [root]: { access: 'owner', owner: AKIM, ownerName: 'Аким' } },
  })
  const akim = who(id, AKIM, 'participant')
  const boris = who(id, BORIS, 'participant')

  assert.equal(say(id, akim, { t: 'restart', book: 'Аким.ipynb' }), null, 'the author could not restart their own kernel')
  assert.equal(say(id, akim, { t: 'clearOutputs', book: 'Аким.ipynb' }), null, 'the author could not clear their own output')

  // The room notebook and someone else's personal one are as before: teacher only.
  assert.ok(say(id, akim, { t: 'restart' }), 'the class kernel restart went to a student')
  assert.ok(say(id, akim, { t: 'clearOutputs' }), 'clearing the whole room went to a student')
  assert.ok(say(id, boris, { t: 'restart', book: 'Аким.ipynb' }))
  assert.ok(say(id, boris, { t: 'clearOutputs', book: 'Аким.ipynb' }))

  // A named notebook that does not exist answers with its own phrase, not with the rules.
  assert.ok(say(id, who(id, 'p_host', 'host'), { t: 'restart', book: 'Нет.ipynb' }))
})

test('"teacher only" closes a notebook in an open room', () => {
  const id = 'book-hostonly'
  const cells = roomWithBooks(id)
  const root = Object.keys(storedRules(id).books ?? {})[0]
  setRules(id, {
    ...OPEN_ROOM,
    books: { [root]: { access: 'host', owner: AKIM, ownerName: 'Аким' } },
  })
  const akim = who(id, AKIM, 'participant')
  // Even to the author: the notebook was handed to the teacher.
  assert.ok(say(id, akim, { t: 'run', cellId: cells.own }))
  assert.equal(say(id, akim, { t: 'run', cellId: cells.main }), null)
  assert.equal(say(id, who(id, 'p_host', 'host'), { t: 'run', cellId: cells.own }), null)
})

/* ----------------------------------------------------------- author */

test('the server records the author, and the record survives a file rename', () => {
  const id = 'book-author'
  createSession(id, 'Автор', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, ownBooks: 'on' })
  const made = createBook(id, 'Аким.ipynb', {
    participantId: AKIM,
    name: '  Аким  ',
    role: 'participant',
  })
  assert.ok(made.ok)
  const root = made.ok ? made.book.root : ''
  const rule = storedRules(id).books?.[root]
  assert.deepEqual(rule, { access: 'owner', owner: AKIM, ownerName: 'Аким' } satisfies BookRule)

  // A file rename does not touch access: the key is the root, not the path.
  moveBook(id, 'Аким.ipynb', 'Разбор.ipynb')
  assert.equal(bookAt(getSessionDoc(id).doc, 'Разбор.ipynb')?.root, root)
  assert.equal(storedRules(id).books?.[root].access, 'owner')

  // The notebook was removed, and the record left with it.
  dropBook(id, 'Разбор.ipynb')
  assert.equal(storedRules(id).books?.[root], undefined)
})

test('a notebook by the teacher gets no author, while a notebook a student creates is personal right away', () => {
  const id = 'book-own'
  createSession(id, 'Свои', null)
  getSessionDoc(id)
  const byHost = createBook(id, 'Лекция.ipynb', {
    participantId: 'p_host',
    name: 'Ада',
    role: 'host',
  })
  assert.ok(byHost.ok)
  assert.equal(storedRules(id).books, undefined, 'the teacher notebook got an author')

  setRules(id, { ...storedRules(id), ownBooks: 'on' })
  const byStudent = createBook(id, 'Аким.ipynb', {
    participantId: AKIM,
    name: 'Аким',
    role: 'participant',
  })
  assert.ok(byStudent.ok)
  const root = byStudent.ok ? byStudent.book.root : ''
  assert.equal(storedRules(id).books?.[root].access, 'owner', 'the own notebook did not become personal')
  // And "Personal" in the menu is available: the author is known.
  assert.equal(
    accessOptions(storedRules(id).books?.[root] ?? null).find((o) => o.access === 'owner')
      ?.disabled,
    false,
  )
})

/*
 * Someone else's file from the shared folder does not become personal.
 *
 * On 20 Sep 2026 at a live class a student clicked on `seminar.ipynb`, the
 * teacher's handout lying in the class folder, and the whole group's
 * seminar became their personal notebook: only they could edit and run in
 * it. "Students' own notebooks" is about a draft a student created FOR
 * THEMSELVES (createBook); this rule says nothing about bringing in a
 * ready-made file.
 */
test('a student brings a file of someone else into the room, and the notebook stays the room notebook', () => {
  const id = 'book-brought'
  createSession(id, 'Раздатка', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, files: 'room', ownBooks: 'on' })
  const by = { participantId: AKIM, name: 'Аким', role: 'participant' as const }

  // A file in the folder, as if the teacher had put it there.
  assert.equal(makeFile(id, 'Семинар.ipynb', writeIpynb([])), 'ok')
  const brought = openBook(id, 'Семинар.ipynb', by)
  assert.ok(brought.ok, 'the student was not allowed to bring the file into the room')
  const root = brought.ok ? brought.book.root : ''
  assert.equal(storedRules(id).books?.[root], undefined, 'the brought file became a personal notebook')
  assert.equal(ownBooksOf(id, getSessionDoc(id).doc, AKIM), 0, 'a file of someone else took up the own notebooks ceiling')

  // But your own, created right here, is still personal.
  const mine = createBook(id, 'Аким.ipynb', by)
  assert.ok(mine.ok)
  assert.equal(storedRules(id).books?.[mine.ok ? mine.book.root : ''].access, 'owner')
})

/* -------------------------------- the right to create your own notebook */

test('with own notebooks off, a student neither creates nor brings in a single one', () => {
  const id = 'book-off'
  createSession(id, 'Нельзя', null)
  getSessionDoc(id)
  // Files are open to the room, own notebooks are not: these are different rules.
  setRules(id, { ...OPEN_ROOM, files: 'room', ownBooks: 'off' })
  const by = { participantId: AKIM, name: 'Аким', role: 'participant' as const }

  const made = createBook(id, 'Аким.ipynb', by)
  assert.equal(made.ok, false)
  assert.match(made.ok ? '' : made.why, /преподавател/i)
  // And no file is left behind the refusal: the right is asked before the disk.
  assert.equal(statPath(id, 'Аким.ipynb'), null, 'the refusal left a file behind')

  // An .ipynb may be put into the folder, but not brought into the room as a notebook.
  assert.equal(makeFile(id, 'Готовое.ipynb', writeIpynb([])), 'ok')
  const brought = openBook(id, 'Готовое.ipynb', by)
  assert.equal(brought.ok, false)
  assert.equal(bookAt(getSessionDoc(id).doc, 'Готовое.ipynb'), null)

  // The teacher always may: the rules are about what the class may do.
  const host = createBook(id, 'Лекция.ipynb', { participantId: 'p_host', name: 'Ада', role: 'host' })
  assert.equal(host.ok, true)
})

test('with files off, an own notebook is still created: these are different rules', () => {
  const id = 'book-files-host'
  createSession(id, 'Лекция', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, files: 'host', edit: 'host', run: 'host', ownBooks: 'on' })
  const made = createBook(id, 'Аким.ipynb', {
    participantId: AKIM,
    name: 'Аким',
    role: 'participant',
  })
  assert.equal(made.ok, true, 'the notebook file is its projection, the server writes it')
  assert.equal(made.ok ? storedRules(id).books?.[made.book.root].access : null, 'owner')
})

test('no more than three own notebooks, and a removed one frees its place', () => {
  const id = 'book-limit'
  createSession(id, 'Потолок', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, ownBooks: 'on' })
  const by = { participantId: AKIM, name: 'Аким', role: 'participant' as const }
  for (let i = 0; i < MAX_OWN_BOOKS; i++) {
    assert.equal(createBook(id, `Аким-${i}.ipynb`, by).ok, true, `notebook ${i} was not created`)
  }
  const extra = createBook(id, 'Аким-лишняя.ipynb', by)
  assert.equal(extra.ok, false)
  assert.match(extra.ok ? '' : extra.why, new RegExp(String(MAX_OWN_BOOKS)))
  // The ceiling is per person: the neighbour has their own three.
  assert.equal(
    createBook(id, 'Борис-0.ipynb', { participantId: BORIS, name: 'Борис', role: 'participant' }).ok,
    true,
  )
  // Removed your own, and a place was freed.
  assert.equal(ownsBookAt(id, 'Аким-0.ipynb', AKIM), true)
  assert.equal(ownsBookAt(id, 'Аким-0.ipynb', BORIS), false, 'a personal notebook of another person reads as your own')
  dropBook(id, 'Аким-0.ipynb')
  assert.equal(createBook(id, 'Аким-снова.ipynb', by).ok, true)
})

test('after the bell no own notebook is created, before the bell it is', () => {
  const id = 'book-after-class'
  createSession(id, 'Звонок', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, ownBooks: 'on' })
  const by = { participantId: AKIM, name: 'Аким', role: 'participant' as const }
  assert.equal(createBook(id, 'До.ipynb', by).ok, true)
  setFinished(id, Date.now())
  const after = createBook(id, 'После.ipynb', by)
  assert.equal(after.ok, false)
  // The stored choice is intact: the class gets reopened.
  assert.equal(storedRules(id).ownBooks, 'on')
  setFinished(id, null)
  assert.equal(createBook(id, 'Снова.ipynb', by).ok, true)
})

/* --------------------------------------------------------------- route */

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

function tokenFor(sessionId: string, role: 'host' | 'participant'): string {
  const participantId = `p_${sessionId}_${role}`
  upsertParticipant({
    id: participantId,
    sessionId,
    name: role === 'host' ? 'Ада' : 'Аким',
    avatar: null,
    role,
    tokenHost: role === 'host',
  })
  return signToken({ sessionId, participantId, role, iat: Date.now() - 3 * 60_000 })
}

test('notebook access is changed by the teacher, and only by the teacher', async () => {
  const id = 'book-route'
  createSession(id, 'Дверь', null)
  const books = { 'nb:one': { access: 'owner', owner: AKIM, ownerName: 'Аким' } }

  const asStudent = await fetch(`${base}/api/sessions/${id}/rules`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${tokenFor(id, 'participant')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ rules: { books, ownBooks: 'on' } }),
  })
  assert.equal(asStudent.status, 403)
  assert.equal(storedRules(id).books, undefined, 'a participant wrote notebook access')

  const asHost = await fetch(`${base}/api/sessions/${id}/rules`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${tokenFor(id, 'host')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ rules: { books, ownBooks: 'on' } }),
  })
  assert.equal(asHost.status, 200)
  assert.equal(storedRules(id).books?.['nb:one'].owner, AKIM)
  assert.equal(storedRules(id).ownBooks, 'on')
})

/* ------------------------------------------------------------ interface */

test('"own kernel" means a personal notebook, and only that', () => {
  /*
   * There is no routing by this flag today: runs in all notebooks go to the
   * room kernel. The function exists so that the step that gives a personal
   * notebook its own container asks ONE place, and it is checked here so that
   * the answer does not drift from the meaning of `owner` on the way to that
   * step.
   */
  const rules: RoomRules = {
    ...OPEN_ROOM,
    books: {
      'nb:own': { access: 'owner', owner: AKIM, ownerName: 'Аким' },
      'nb:all': { access: 'all', owner: null, ownerName: null },
      'nb:host': { access: 'host', owner: null, ownerName: null },
    },
  }
  assert.equal(bookHasOwnKernel(rules, 'nb:own'), true)
  assert.equal(bookHasOwnKernel(rules, 'nb:all'), false, '"open to everyone" is the shared class notebook')
  assert.equal(bookHasOwnKernel(rules, 'nb:host'), false)
  assert.equal(bookHasOwnKernel(rules, CELLS_KEY), false)
  assert.equal(bookHasOwnKernel(rules, null), false)
  assert.equal(bookHasOwnKernel(OPEN_ROOM, 'nb:own'), false)
})

test('the tab label appears only where access differs from the room', () => {
  assert.equal(bookMark(null, AKIM), null)
  assert.equal(bookMark({ access: 'room', owner: AKIM, ownerName: 'Аким' }, BORIS), null)
  assert.equal(bookMark({ access: 'owner', owner: AKIM, ownerName: 'Аким' }, AKIM)?.tone, 'mine')
  const theirs = bookMark({ access: 'owner', owner: AKIM, ownerName: 'Аким' }, BORIS)
  assert.equal(theirs?.tone, 'personal')
  assert.match(theirs?.text ?? '', /Аким/)
  assert.equal(bookMark({ access: 'all', owner: null, ownerName: null }, BORIS)?.tone, 'all')
  assert.equal(bookMark({ access: 'host', owner: null, ownerName: null }, BORIS)?.tone, 'host')
})

test('"Personal" is unavailable where there is no author, and explains why', () => {
  const none = accessOptions(null).find((o) => o.access === 'owner')
  assert.equal(none?.disabled, true)
  assert.ok(none?.hint)
  assert.equal(accessOptions(null).filter((o) => o.disabled).length, 1, 'something else got disabled')
})

test('an access patch does not lose the author, even when access is set back to the room', () => {
  const rules = withPersonal({}, 'nb:one')
  const patch = accessPatch(rules, 'nb:one', 'room')
  assert.deepEqual(patch.books?.['nb:one'], {
    access: 'room',
    owner: AKIM,
    ownerName: 'Аким',
  } satisfies BookRule)
  // And the patch does not touch neighbouring notebooks.
  const two: RoomRules = {
    ...rules,
    books: { ...rules.books!, 'nb:two': { access: 'all', owner: null, ownerName: null } },
  }
  assert.equal(accessPatch(two, 'nb:one', 'host').books?.['nb:two'].access, 'all')
})

test('the browser disables buttons by the same fork as the server', () => {
  const rules = withPersonal({ edit: 'host', run: 'host', structure: 'host' })
  const mine = permitsIn(rules, 'participant', false, { root: 'nb:one', participantId: AKIM })
  assert.equal(mine.edit, true)
  assert.equal(mine.run, true)
  assert.equal(mine.add, true)

  const theirs = permitsIn(rules, 'participant', false, { root: 'nb:one', participantId: BORIS })
  assert.equal(theirs.edit, false)
  assert.match(theirs.editWhy, /Аким/, 'the refusal reason said nothing about the notebook')
  assert.match(theirs.runWhy, /Аким/)

  // The room notebook goes by the room rules, and the reason is the room one.
  const room = permitsIn(rules, 'participant', false, { root: CELLS_KEY, participantId: AKIM })
  assert.equal(room.edit, false)
  assert.doesNotMatch(room.editWhy, /Аким/)

  // After the bell there is one phrase about the bell, and your own notebook does not save you.
  const over = permitsIn(rules, 'participant', true, { root: 'nb:one', participantId: AKIM })
  assert.equal(over.edit, false)
  assert.doesNotMatch(over.editWhy, /Аким/)
})

test('a cell of a personal notebook is edited by its author even when the room is closed', () => {
  // The same thing CellView draws: rights are computed by the root of the cell's notebook.
  const doc = new Y.Doc()
  doc.getArray('nb:one').push([createCell('code', 'x', 'c1')])
  assert.equal(cellSource(doc.getArray('nb:one').get(0) as Y.Map<unknown>).toString(), 'x')
  const rules = withPersonal({ edit: 'host' })
  assert.equal(
    permitsIn(rules, 'participant', false, { root: 'nb:one', participantId: AKIM }).edit,
    true,
  )
})

test('personal notebook numbers are read totally and the bell leaves them alone', () => {
  /*
   * `null` means "as for the class", and that is the default: one number for
   * both containers until the teacher decides otherwise.
   */
  assert.equal(OPEN_ROOM.ownMemoryMb, null)
  assert.equal(OPEN_ROOM.ownCpus, null)

  const good = readRules({ ...OPEN_ROOM, ownMemoryMb: 2048, ownCpus: 2 })
  assert.deepEqual([good.ownMemoryMb, good.ownCpus], [2048, 2])

  /*
   * Garbage becomes `null`, not a refusal: every sync frame reads the rules,
   * and a database row spoiled by someone's hand must not lock the room.
   */
  for (const bad of ['4g', 1.5, -1, 0, 1e9, null, undefined, {}, NaN]) {
    const read = readRules({ ...OPEN_ROOM, ownMemoryMb: bad, ownCpus: bad } as never)
    assert.deepEqual([read.ownMemoryMb, read.ownCpus], [null, null], String(bad))
  }
  // One CPU is a legitimate number, while for memory it is already below the floor.
  assert.equal(readRules({ ...OPEN_ROOM, ownCpus: 1 } as never).ownCpus, 1)
  assert.equal(readRules({ ...OPEN_ROOM, ownMemoryMb: 1 } as never).ownMemoryMb, null)

  /*
   * The end of a class is about rights, not hardware: it closes the door to
   * personal notebooks (`ownBooks: 'off'`), but the number will be needed the
   * very second the class is reopened.
   */
  const after = rulesAfterClass({ ...OPEN_ROOM, ownBooks: 'on', ownMemoryMb: 4096, ownCpus: 2 })
  assert.equal(after.ownBooks, 'off')
  assert.deepEqual([after.ownMemoryMb, after.ownCpus], [4096, 2])
})
