/**
 * Доступ к ОТДЕЛЬНОЙ тетради комнаты.
 *
 * Правила комнаты были одни на все тетради, и на паре это ломалось об самый
 * частый жест: студент заводит себе копию разбора — и в собственной тетради
 * печатать не может, потому что комната лекционная. Теперь у тетради есть свой
 * доступ, и вся развилка живёт в ОДНОЙ функции (`rulesForBook`), которой
 * пользуются и сервер, и браузер.
 *
 * Отсюда и порядок проверок. Сначала сама функция и чтение правил — там
 * ошибка тихая и стоит либо запертой комнаты, либо открытой чужой тетради.
 * Потом гейт на настоящих кадрах: кнопку можно не нажимать, а кадр послать
 * мимо интерфейса, и отказать обязан сервер. Потом управляющий сокет — запуск,
 * перестановка, форматирование. И наконец запись автора: она делается сервером
 * в тот миг, когда тетрадь заводят, и от неё зависит, кого меню назовёт
 * хозяином.
 *
 * Ни сети, ни ядра, кроме одного маршрута: «участник не меняет доступ»
 * проверяется через настоящий HTTP, потому что дверь там одна и проверяет её
 * тоже она.
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
import { createBook, dropBook, moveBook, openBook, ownsBookAt } from '../server/src/collab/books.js'
import { makeFile, statPath } from '../server/src/workspace.js'
import { writeIpynb } from '../shared/ipynb.js'
import { app } from '../server/src/app.js'
import { signToken, type TokenPayload } from '../server/src/auth.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import { accessOptions, accessPatch, bookMark } from '../web/src/lib/book-access.js'
import { permitsIn } from '../web/src/lib/may.js'

const AKIM = 'p_akim'
const BORIS = 'p_boris'

/** Комната, в которой одна тетрадь личная — Акима. */
function withPersonal(room: Partial<RoomRules>, root = 'nb:one'): RoomRules {
  return {
    ...OPEN_ROOM,
    ...room,
    books: { [root]: { access: 'owner', owner: AKIM, ownerName: 'Аким' } },
  }
}

const student = (id: string) => ({ role: 'participant' as const, participantId: id })

/* ------------------------------------------------------- сама развилка */

test('личная тетрадь открыта автору и преподавателю, и закрыта всем остальным', () => {
  // Комната лекционная: печатать и запускать в ней нельзя никому, кроме ведущего.
  const rules = withPersonal({ edit: 'host', run: 'host', structure: 'host' })

  const mine = rulesForBook(rules, 'nb:one', student(AKIM))
  assert.deepEqual(
    [mine.edit, mine.run, mine.structure],
    ['room', 'room', 'room'],
    'автор не получил свою тетрадь',
  )
  const theirs = rulesForBook(rules, 'nb:one', student(BORIS))
  assert.deepEqual([theirs.edit, theirs.run, theirs.structure], ['host', 'host', 'host'])

  /*
   * Ядро и вывод СВОЕЙ тетради — свои, и это ровно две ручки.
   *
   * У личной тетради своё ядро в отдельном контейнере (`bookHasOwnKernel`):
   * «перезапустить» в ней уносит переменные одного человека, а «стереть
   * выводы» — его собственный вывод. Требовать на это преподавателя значило бы
   * поднимать руку посреди лекции, чтобы заново объявить `x` у себя в
   * черновике.
   */
  assert.deepEqual([mine.restart, mine.wipe], ['room', 'room'], 'автору не дали своё ядро')
  assert.deepEqual(
    [theirs.restart, theirs.wipe],
    [rules.restart, rules.wipe],
    'чужая личная тетрадь раздала права на своё ядро',
  )

  // Остальные правила комнаты тетрадью не трогаются: доска, файлы, история.
  assert.equal(mine.files, rules.files)
  assert.equal(mine.board, rules.board)

  // Тетрадь комнаты остаётся комнатной для обоих — и это тот же объект.
  assert.equal(rulesForBook(rules, CELLS_KEY, student(AKIM)), rules)
  // Преподаватель проходит насквозь: закрытая «только ему» закрыта не от него.
  assert.equal(rulesForBook(rules, 'nb:one', { role: 'host', participantId: 'p_host' }), rules)
})

test('«открыта всем» пускает при закрытой комнате, «только преподаватель» — закрывает при открытой', () => {
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
   * «Открыта всем» ядра не раздаёт.
   *
   * Тетрадь, открытая всем, — по-прежнему тетрадь ЗАНЯТИЯ: её ядро живёт в
   * контейнере комнаты (`bookHasOwnKernel` про неё отвечает «нет»), и
   * «перезапустить» в ней значит обнулить переменные пары. Разница с личной
   * ровно здесь, и без этой строки она держалась бы на одном слове в коде.
   */
  assert.deepEqual([all.restart, all.wipe], [open.restart, open.wipe])

  const shut: RoomRules = {
    ...OPEN_ROOM,
    books: { 'nb:one': { access: 'host', owner: null, ownerName: null } },
  }
  const only = rulesForBook(shut, 'nb:one', student(BORIS))
  assert.deepEqual([only.edit, only.run, only.structure], ['host', 'host', 'host'])
  // А комната при этом осталась открытой — перекрытие живёт у одной тетради.
  assert.equal(rulesForBook(shut, CELLS_KEY, student(BORIS)).edit, 'room')
})

test('отказывает тетрадь — говорит тетрадь, а не комната', () => {
  const rules = withPersonal({ edit: 'host' })
  assert.deepEqual(bookRefusal(rules, 'nb:one', student(BORIS)), {
    key: BOOK_IS_PERSONAL,
    name: 'Аким',
  })
  // Автору и преподавателю тетрадь не отказывает вовсе.
  assert.equal(bookRefusal(rules, 'nb:one', student(AKIM)), null)
  assert.equal(bookRefusal(rules, 'nb:one', { role: 'host', participantId: 'p_host' }), null)
  // «Открыта всем» тоже не отказ: она разрешает.
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

test('конец занятия сильнее доступа к тетради: после звонка не открывает ничего', () => {
  const rules = withPersonal({})
  const over = rulesAfterClass(rules)
  assert.equal(over.books, undefined, 'карта тетрадей пережила звонок')
  const mine = rulesForBook(over, 'nb:one', student(AKIM))
  assert.deepEqual([mine.edit, mine.run, mine.structure], ['host', 'host', 'host'])
  // И «открыта всем» тоже: после звонка действует один преподаватель.
  const everyone: RoomRules = {
    ...OPEN_ROOM,
    books: { 'nb:one': { access: 'all', owner: null, ownerName: null } },
  }
  assert.equal(rulesForBook(rulesAfterClass(everyone), 'nb:one', student(BORIS)).edit, 'host')
  // Хранимые правила при этом целы — занятие открывают обратно.
  assert.equal(rules.books?.['nb:one'].access, 'owner')
})

/* -------------------------------------------------------- чтение правил */

test('правила без карты тетрадей читаются как прежде, а мусор падает на умолчание', () => {
  // Строка, записанная до того, как доступ к тетради появился.
  const old = readRules('{"run":"host","edit":"host"}')
  assert.equal(old.books, undefined)
  assert.equal(old.ownBooks, 'off', 'свои тетради разрешились сами')

  // Мусор на каждом месте.
  const junk = readRules({
    books: {
      'nb:ok': { access: 'owner', owner: AKIM, ownerName: 'Аким' },
      'nb:bad': { access: 'нет такого', owner: AKIM },
      'nb:empty': 7,
      '': { access: 'host' },
      // «Как в комнате» без автора не значит ничего и не хранится.
      'nb:noop': { access: 'room', owner: null },
    },
    ownBooks: 'что угодно',
  })
  assert.deepEqual(Object.keys(junk.books ?? {}), ['nb:ok'])
  assert.equal(junk.ownBooks, 'off')
  // У поля недолго была другая пара значений; «личные» читается как «можно».
  assert.equal(readRules({ ownBooks: 'owner' }).ownBooks, 'on')
  assert.equal(readRules({ ownBooks: 'room' }).ownBooks, 'off')
  // А запись «как в комнате» С автором остаётся: по ней меню назовёт хозяина.
  const kept = readRules({ books: { 'nb:x': { access: 'room', owner: AKIM, ownerName: 'Аким' } } })
  assert.equal(kept.books?.['nb:x'].owner, AKIM)
})

test('карта тетрадей ограничена по размеру, а имя автора — по длине', () => {
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

test('доступ переживает круг через базу', () => {
  const id = 'book-db'
  createSession(id, 'Круг', null)
  setRules(id, withPersonal({ edit: 'host' }))
  assert.equal(storedRules(id).books?.['nb:one'].ownerName, 'Аким')
  assert.equal(getRules(id).books?.['nb:one'].access, 'owner')
})

/* ------------------------------------------------------------------ гейт */

/**
 * Две тетради в одном документе и вкладка, которая шлёт в них кадры.
 *
 * Кадры настоящие: право проверяется на байтах, а не на выдуманных приговорах.
 * Мимо интерфейса послать можно ровно это, и отказать обязан сервер.
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

/** Прошёл бы этот кадр от этого человека при этих правилах. `null` — прошёл. */
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

test('кадр в чужую личную тетрадь гейт отвергает, а в свою — принимает при закрытой комнате', () => {
  const rules = withPersonal({ edit: 'host', structure: 'host', run: 'host' })
  {
    const { server, client, frame } = twoBooks()
    const bytes = frame(() => typeInto(client, 'nb:one'))
    // Своя — проходит, хотя комната лекционная.
    assert.equal(passes(server, bytes, rules, 'participant', AKIM), null)
    // Чужая — отказ, и отказывает ТЕТРАДЬ, называя автора.
    const said = passes(server, bytes, rules, 'participant', BORIS) ?? ''
    assert.match(said, /Аким/, `отказ не назвал автора: ${said}`)
    // Преподаватель пишет всюду.
    assert.equal(passes(server, bytes, rules, 'host', 'p_host'), null)
  }
  {
    // Главную тетрадь комнаты не правит никто из студентов, включая автора
    // личной: перекрытие живёт у одной тетради, а не у человека.
    const { server, client, frame } = twoBooks()
    const bytes = frame(() => typeInto(client, CELLS_KEY))
    assert.ok(passes(server, bytes, rules, 'participant', AKIM))
    assert.ok(passes(server, bytes, rules, 'participant', BORIS))
  }
})

test('состав личной тетради меняет автор, а чужой не меняет', () => {
  const rules = withPersonal({ edit: 'host', structure: 'host' })
  const { server, client, frame } = twoBooks()
  const bytes = frame(() => client.getArray('nb:one').push([createCell('code', 'new', 'c9')]))
  assert.equal(passes(server, bytes, rules, 'participant', AKIM), null)
  assert.match(passes(server, bytes, rules, 'participant', BORIS) ?? '', /Аким/)
})

test('«открыта всем» пускает кадр в закрытой комнате, «только преподаватель» — не пускает в открытой', () => {
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
    // Преподавателю закрытая «только ему» тетрадь закрытой не является.
    assert.equal(passes(server, bytes, shut, 'host', 'p_host'), null)
  }
})

test('после звонка закрыта и своя личная тетрадь — и слова про звонок', async () => {
  const { server, client, frame } = twoBooks()
  const bytes = frame(() => typeInto(client, 'nb:one'))
  const rules = rulesAfterClass(withPersonal({}))
  const said = passes(server, bytes, rules, 'participant', AKIM, true) ?? ''
  assert.ok(said, 'своя личная тетрадь пережила звонок')
  assert.doesNotMatch(said, /Аким/, 'после звонка отказ обязан говорить про звонок')
  // Преподавателю — по-прежнему всё.
  assert.equal(passes(server, bytes, rules, 'host', 'p_host', true), null)
})

test('кадр без имени отправителя судится как чужой, а не как авторский', () => {
  const { server, client, frame } = twoBooks()
  const bytes = frame(() => typeInto(client, 'nb:one'))
  const rules = withPersonal({ edit: 'host' })
  assert.ok(passes(server, bytes, rules, 'participant', null), 'безымянный кадр прошёл как свой')
})

/* --------------------------------------------------- управляющий сокет */

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

/** Комната с двумя тетрадями и настоящими ячейками в обеих. */
function roomWithBooks(id: string): { main: string; own: string } {
  createSession(id, 'Тетради', null)
  const { doc } = getSessionDoc(id)
  // Свои тетради разрешены: иначе студент не заведёт ни одной, и проверять
  // доступ было бы не у чего.
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

test('запуск спрашивает ту тетрадь, в которой нажали', () => {
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

  // Своя тетрадь считает даже в лекции; тетрадь комнаты — нет.
  assert.equal(say(id, akim, { t: 'run', cellId: cells.own }), null)
  assert.ok(say(id, akim, { t: 'run', cellId: cells.main }))
  // Чужая личная не считает, и отказ называет автора.
  assert.match(say(id, boris, { t: 'run', cellId: cells.own }) ?? '', /Аким/)

  // Весь лист — по той же тетради.
  assert.equal(say(id, akim, { t: 'runAll', book: 'Аким.ipynb' }), null)
  assert.ok(say(id, akim, { t: 'runAll' }), 'Run All по тетради комнаты прошёл в лекции')
  assert.ok(say(id, boris, { t: 'runAll', book: 'Аким.ipynb' }))
})

test('перестановка, форматирование и очистка вывода идут по тетради ячейки', () => {
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

  // Своя ячейка чистится по праву печатать — значит по правилам своей тетради.
  assert.equal(say(id, akim, { t: 'clearOutputs', cellId: cells.own }), null)
  assert.ok(say(id, akim, { t: 'clearOutputs', cellId: cells.main }))

  // black переписывает КАЖДУЮ ячейку названной тетради — и спрашивает у неё.
  assert.ok(say(id, boris, { t: 'format', book: 'Аким.ipynb' }))
  assert.ok(say(id, akim, { t: 'format' }), 'форматирование тетради комнаты прошло в лекции')
})

test('ядро и вывод своей тетради перезапускает и стирает её автор', () => {
  /*
   * У личной тетради своё ядро в отдельном контейнере, и «перезапустить» в ней
   * уносит переменные одного человека — его собственные. Требовать на это
   * преподавателя значило бы поднимать руку посреди лекции, чтобы заново
   * объявить `x` у себя в черновике. В тетради комнаты и в чужой личной
   * правило прежнее: перезапуск преподавательский.
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

  assert.equal(say(id, akim, { t: 'restart', book: 'Аким.ipynb' }), null, 'автор не перезапустил своё ядро')
  assert.equal(say(id, akim, { t: 'clearOutputs', book: 'Аким.ipynb' }), null, 'автор не стёр свой вывод')

  // Тетрадь комнаты и чужая личная — как было: только преподаватель.
  assert.ok(say(id, akim, { t: 'restart' }), 'перезапуск ядра занятия достался студенту')
  assert.ok(say(id, akim, { t: 'clearOutputs' }), 'очистка всей комнаты досталась студенту')
  assert.ok(say(id, boris, { t: 'restart', book: 'Аким.ipynb' }))
  assert.ok(say(id, boris, { t: 'clearOutputs', book: 'Аким.ipynb' }))

  // Названная и несуществующая тетрадь отвечает своей фразой, а не правилами.
  assert.ok(say(id, who(id, 'p_host', 'host'), { t: 'restart', book: 'Нет.ipynb' }))
})

test('«только преподаватель» закрывает тетрадь при открытой комнате', () => {
  const id = 'book-hostonly'
  const cells = roomWithBooks(id)
  const root = Object.keys(storedRules(id).books ?? {})[0]
  setRules(id, {
    ...OPEN_ROOM,
    books: { [root]: { access: 'host', owner: AKIM, ownerName: 'Аким' } },
  })
  const akim = who(id, AKIM, 'participant')
  // Даже автору — тетрадь отдали преподавателю.
  assert.ok(say(id, akim, { t: 'run', cellId: cells.own }))
  assert.equal(say(id, akim, { t: 'run', cellId: cells.main }), null)
  assert.equal(say(id, who(id, 'p_host', 'host'), { t: 'run', cellId: cells.own }), null)
})

/* ------------------------------------------------------------ автор */

test('автора записывает сервер, и запись переживает переименование файла', () => {
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

  // Переименование файла доступ не трогает: ключ — корень, а не путь.
  moveBook(id, 'Аким.ipynb', 'Разбор.ipynb')
  assert.equal(bookAt(getSessionDoc(id).doc, 'Разбор.ipynb')?.root, root)
  assert.equal(storedRules(id).books?.[root].access, 'owner')

  // Тетрадь убрали — запись ушла вместе с ней.
  dropBook(id, 'Разбор.ipynb')
  assert.equal(storedRules(id).books?.[root], undefined)
})

test('тетрадь преподавателя автора не получает, а своя тетрадь студента личная сразу', () => {
  const id = 'book-own'
  createSession(id, 'Свои', null)
  getSessionDoc(id)
  const byHost = createBook(id, 'Лекция.ipynb', {
    participantId: 'p_host',
    name: 'Ада',
    role: 'host',
  })
  assert.ok(byHost.ok)
  assert.equal(storedRules(id).books, undefined, 'преподавательская тетрадь получила автора')

  setRules(id, { ...storedRules(id), ownBooks: 'on' })
  const byStudent = createBook(id, 'Аким.ipynb', {
    participantId: AKIM,
    name: 'Аким',
    role: 'participant',
  })
  assert.ok(byStudent.ok)
  const root = byStudent.ok ? byStudent.book.root : ''
  assert.equal(storedRules(id).books?.[root].access, 'owner', 'своя тетрадь не стала личной')
  // И «Личная» в меню доступна: автор известен.
  assert.equal(
    accessOptions(storedRules(id).books?.[root] ?? null).find((o) => o.access === 'owner')
      ?.disabled,
    false,
  )
})

/* ------------------------------------------- право завести свою тетрадь */

test('при выключенных своих тетрадях студент не заводит и не вносит ни одной', () => {
  const id = 'book-off'
  createSession(id, 'Нельзя', null)
  getSessionDoc(id)
  // Файлы комнате открыты, а свои тетради — нет: это разные правила.
  setRules(id, { ...OPEN_ROOM, files: 'room', ownBooks: 'off' })
  const by = { participantId: AKIM, name: 'Аким', role: 'participant' as const }

  const made = createBook(id, 'Аким.ipynb', by)
  assert.equal(made.ok, false)
  assert.match(made.ok ? '' : made.why, /преподавател/i)
  // И файла за отказом не осталось: право спрашивается до диска.
  assert.equal(statPath(id, 'Аким.ipynb'), null, 'отказ оставил после себя файл')

  // Положить .ipynb в папку можно — внести его в комнату тетрадью нельзя.
  assert.equal(makeFile(id, 'Готовое.ipynb', writeIpynb([])), 'ok')
  const brought = openBook(id, 'Готовое.ipynb', by)
  assert.equal(brought.ok, false)
  assert.equal(bookAt(getSessionDoc(id).doc, 'Готовое.ipynb'), null)

  // Преподавателю — можно всегда: правила про то, что можно классу.
  const host = createBook(id, 'Лекция.ipynb', { participantId: 'p_host', name: 'Ада', role: 'host' })
  assert.equal(host.ok, true)
})

test('при выключенных файлах своя тетрадь всё равно заводится — это разные правила', () => {
  const id = 'book-files-host'
  createSession(id, 'Лекция', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, files: 'host', edit: 'host', run: 'host', ownBooks: 'on' })
  const made = createBook(id, 'Аким.ipynb', {
    participantId: AKIM,
    name: 'Аким',
    role: 'participant',
  })
  assert.equal(made.ok, true, 'файл тетради — её проекция, его пишет сервер')
  assert.equal(made.ok ? storedRules(id).books?.[made.book.root].access : null, 'owner')
})

test('своих тетрадей не больше трёх, и убранная место освобождает', () => {
  const id = 'book-limit'
  createSession(id, 'Потолок', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, ownBooks: 'on' })
  const by = { participantId: AKIM, name: 'Аким', role: 'participant' as const }
  for (let i = 0; i < MAX_OWN_BOOKS; i++) {
    assert.equal(createBook(id, `Аким-${i}.ipynb`, by).ok, true, `не завелась ${i}`)
  }
  const extra = createBook(id, 'Аким-лишняя.ipynb', by)
  assert.equal(extra.ok, false)
  assert.match(extra.ok ? '' : extra.why, new RegExp(String(MAX_OWN_BOOKS)))
  // Потолок личный: у соседа свои три.
  assert.equal(
    createBook(id, 'Борис-0.ipynb', { participantId: BORIS, name: 'Борис', role: 'participant' }).ok,
    true,
  )
  // Свою убрал — место освободилось.
  assert.equal(ownsBookAt(id, 'Аким-0.ipynb', AKIM), true)
  assert.equal(ownsBookAt(id, 'Аким-0.ipynb', BORIS), false, 'чужая личная читается как своя')
  dropBook(id, 'Аким-0.ipynb')
  assert.equal(createBook(id, 'Аким-снова.ipynb', by).ok, true)
})

test('после звонка свою тетрадь не заводят, а до звонка — заводят', () => {
  const id = 'book-after-class'
  createSession(id, 'Звонок', null)
  getSessionDoc(id)
  setRules(id, { ...OPEN_ROOM, ownBooks: 'on' })
  const by = { participantId: AKIM, name: 'Аким', role: 'participant' as const }
  assert.equal(createBook(id, 'До.ipynb', by).ok, true)
  setFinished(id, Date.now())
  const after = createBook(id, 'После.ipynb', by)
  assert.equal(after.ok, false)
  // Хранимый выбор цел: занятие открывают обратно.
  assert.equal(storedRules(id).ownBooks, 'on')
  setFinished(id, null)
  assert.equal(createBook(id, 'Снова.ipynb', by).ok, true)
})

/* ------------------------------------------------------------- маршрут */

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

test('доступ к тетради меняет преподаватель, и только он', async () => {
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
  assert.equal(storedRules(id).books, undefined, 'участник записал доступ к тетради')

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

/* ------------------------------------------------------------ интерфейс */

test('«своё ядро» — это личная тетрадь, и только она', () => {
  /*
   * Маршрутизации по этому признаку сегодня нет: запуск у всех тетрадей идёт в
   * ядро комнаты. Функция заведена затем, чтобы шаг, который даст личной
   * тетради свой контейнер, спрашивал ОДНО место, — и проверяется здесь, чтобы
   * ответ не разъехался со смыслом `owner` по дороге к тому шагу.
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
  assert.equal(bookHasOwnKernel(rules, 'nb:all'), false, '«открыта всем» — общая тетрадь занятия')
  assert.equal(bookHasOwnKernel(rules, 'nb:host'), false)
  assert.equal(bookHasOwnKernel(rules, CELLS_KEY), false)
  assert.equal(bookHasOwnKernel(rules, null), false)
  assert.equal(bookHasOwnKernel(OPEN_ROOM, 'nb:own'), false)
})

test('метка на вкладке появляется только там, где доступ не комнатный', () => {
  assert.equal(bookMark(null, AKIM), null)
  assert.equal(bookMark({ access: 'room', owner: AKIM, ownerName: 'Аким' }, BORIS), null)
  assert.equal(bookMark({ access: 'owner', owner: AKIM, ownerName: 'Аким' }, AKIM)?.tone, 'mine')
  const theirs = bookMark({ access: 'owner', owner: AKIM, ownerName: 'Аким' }, BORIS)
  assert.equal(theirs?.tone, 'personal')
  assert.match(theirs?.text ?? '', /Аким/)
  assert.equal(bookMark({ access: 'all', owner: null, ownerName: null }, BORIS)?.tone, 'all')
  assert.equal(bookMark({ access: 'host', owner: null, ownerName: null }, BORIS)?.tone, 'host')
})

test('«Личная» недоступна там, где автора нет, — и объясняет почему', () => {
  const none = accessOptions(null).find((o) => o.access === 'owner')
  assert.equal(none?.disabled, true)
  assert.ok(none?.hint)
  assert.equal(accessOptions(null).filter((o) => o.disabled).length, 1, 'погасло что-то ещё')
})

test('патч доступа не теряет автора, даже когда доступ вернули к комнатному', () => {
  const rules = withPersonal({}, 'nb:one')
  const patch = accessPatch(rules, 'nb:one', 'room')
  assert.deepEqual(patch.books?.['nb:one'], {
    access: 'room',
    owner: AKIM,
    ownerName: 'Аким',
  } satisfies BookRule)
  // И соседние тетради патч не трогает.
  const two: RoomRules = {
    ...rules,
    books: { ...rules.books!, 'nb:two': { access: 'all', owner: null, ownerName: null } },
  }
  assert.equal(accessPatch(two, 'nb:one', 'host').books?.['nb:two'].access, 'all')
})

test('браузер гасит кнопки по той же развилке, что и сервер', () => {
  const rules = withPersonal({ edit: 'host', run: 'host', structure: 'host' })
  const mine = permitsIn(rules, 'participant', false, { root: 'nb:one', participantId: AKIM })
  assert.equal(mine.edit, true)
  assert.equal(mine.run, true)
  assert.equal(mine.add, true)

  const theirs = permitsIn(rules, 'participant', false, { root: 'nb:one', participantId: BORIS })
  assert.equal(theirs.edit, false)
  assert.match(theirs.editWhy, /Аким/, 'причина отказа промолчала про тетрадь')
  assert.match(theirs.runWhy, /Аким/)

  // Тетрадь комнаты — по правилам комнаты, и причина комнатная.
  const room = permitsIn(rules, 'participant', false, { root: CELLS_KEY, participantId: AKIM })
  assert.equal(room.edit, false)
  assert.doesNotMatch(room.editWhy, /Аким/)

  // После звонка — одна фраза про звонок, и своя тетрадь не спасает.
  const over = permitsIn(rules, 'participant', true, { root: 'nb:one', participantId: AKIM })
  assert.equal(over.edit, false)
  assert.doesNotMatch(over.editWhy, /Аким/)
})

test('ячейка личной тетради правится её автором и при закрытой комнате', () => {
  // То же, что рисует CellView: права считаются по корню тетради ячейки.
  const doc = new Y.Doc()
  doc.getArray('nb:one').push([createCell('code', 'x', 'c1')])
  assert.equal(cellSource(doc.getArray('nb:one').get(0) as Y.Map<unknown>).toString(), 'x')
  const rules = withPersonal({ edit: 'host' })
  assert.equal(
    permitsIn(rules, 'participant', false, { root: 'nb:one', participantId: AKIM }).edit,
    true,
  )
})
