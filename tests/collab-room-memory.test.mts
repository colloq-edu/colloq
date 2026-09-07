/**
 * Комната в памяти сервера: сколько она там живёт и чего стоит один её кадр.
 *
 * Три вещи, каждая из которых ломается молча и видна только на пятистах.
 * Комната, в которую за семестр раз вошли, висела в памяти до удаления семинара
 * — вместе со вторым полным слепком в истории и текстами всех ячеек. Одно
 * нажатие уезжало комнате двумя кадрами на каждый сокет без склейки. И запись
 * файла тетради будила обход всей папки и дерево файлов всей комнате на каждый
 * вывод ядра, хотя на диске от вывода не меняется ни байта.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { createSession, listVersions } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import {
  getSessionDoc,
  handleCollabSocket,
  holdRoom,
  onlineCount,
  ownAwareness,
  peekSessionDoc,
  shutdownCollab,
  sweepIdleRooms,
} from '../server/src/collab/index.js'
import { onBooksWritten, openBook, projectBooks } from '../server/src/collab/books.js'
import { putText } from '../server/src/collab/files.js'
import { beginHistory, discardBurst, record } from '../server/src/collab/history.js'
import { BURST_MAX_CHARS } from '../shared/history.js'
import {
  addBook,
  bookCells,
  cellOutputs,
  cellSource,
  createCell,
  createChatEntry,
  getCells,
  getChat,
  getMeta,
} from '../shared/notebook.js'

after(() => shutdownCollab())

const MINUTE = 60 * 1000

/** Пустая комната отпускается через десять минут; берём с запасом. */
const LATER = 11 * MINUTE

/**
 * Отпустило ли уборкой ЭТУ комнату. Именно про эту, а не про список целиком:
 * карта комнат в процессе одна на всю сюиту, и соседний тест держит в ней свою.
 */
function released(id: string, at: number = Date.now() + LATER): boolean {
  return sweepIdleRooms(at).includes(id)
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------ выселение простаивающих */

test('пустая комната отпускается из памяти и возвращается целой', () => {
  const id = 'evict-plain'
  createSession(id, 'Пустеющая', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'x = 1\n'))
  const wrote = cellSource(getCells(doc).get(0)).toString()

  assert.equal(released(id), true)
  assert.equal(peekSessionDoc(id), null, 'комната осталась в памяти')

  // Возвращается из снимка — ровно так же, как после перезапуска сервера.
  const again = getSessionDoc(id).doc
  assert.equal(cellSource(getCells(again).get(0)).toString(), wrote, 'работа не доехала до диска')
})

test('комната, в которой считается ячейка, не выселяется из-под неё', () => {
  const id = 'evict-busy'
  createSession(id, 'Считающая', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => getMeta(doc).set('runningCell', 'c1'))

  assert.equal(released(id), false, 'документ снесли из-под ядра')

  doc.transact(() => getMeta(doc).set('runningCell', null))
  assert.equal(released(id), true)
})

test('очередь и перезапуск ядра держат комнату так же, как считающая ячейка', () => {
  const id = 'evict-queue'
  createSession(id, 'С очередью', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => getMeta(doc).set('kernelStatus', 'busy'))
  assert.equal(released(id), false, 'документ снесли из-под перезапуска ядра')

  doc.transact(() => {
    getMeta(doc).set('kernelStatus', 'idle')
    const queue = new Y.Array<string>()
    getMeta(doc).set('queue', queue)
    queue.push(['c2'])
  })
  assert.equal(released(id), false, 'очередь осталась без документа')

  doc.transact(() => (getMeta(doc).get('queue') as Y.Array<string>).delete(0, 1))
  assert.equal(released(id), true)
})

test('держатель документа не даёт его уничтожить, а отпустив — даёт', () => {
  const id = 'evict-hold'
  createSession(id, 'Занятая', null)
  getSessionDoc(id)
  const release = holdRoom(id)
  assert.equal(released(id), false, 'документ снесли из-под держателя')
  release()
  // Отпустить дважды — не беда: счётчик уходит в ноль один раз.
  release()
  assert.equal(released(id), true)
})

test('застрявший поток оракула держит комнату не дольше трёх часов', () => {
  const id = 'evict-stuck'
  createSession(id, 'Застрявшая', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    const entry = createChatEntry({
      participantId: 'p_one',
      name: 'Аня',
      color: '#000',
      question: 'почему?',
    })
    entry.set('state', 'streaming')
    getChat(doc).push([entry])
  })

  assert.equal(released(id), false, 'ответ оракула оборвали посреди потока')
  // Ядро сносит контейнер простаивающей комнаты за два часа; после трёх писать
  // в документ уже некому, а «streaming» остаётся навсегда.
  assert.equal(released(id, Date.now() + 4 * 60 * MINUTE), true)
})

test('комната, в которой кто-то сидит, не выселяется никогда', () => {
  const id = 'evict-occupied'
  createSession(id, 'Живая', null)
  const seat = socket()
  handleCollabSocket(seat.ws, id, 'participant', 'p_one')

  assert.equal(released(id, Date.now() + 10 * 60 * MINUTE), false, 'выселили комнату с людьми')

  seat.close()
  assert.equal(released(id), true)
})

/* ------------------------------------------------------- склейка кадров */

interface Fake {
  ws: WebSocket
  frames: Uint8Array[]
  close(): void
}

/** Ровно то, что читает `handleCollabSocket`, плюс список принятых кадров. */
function socket(): Fake {
  const frames: Uint8Array[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    // Сколько байт ждёт отправки: по нему сервер решает, слать ли этому сокету
    // курсоры и не пора ли его закрыть (collab/index.ts · send). У настоящего
    // сокета поле есть всегда, и здесь оно тоже должно быть числом.
    bufferedAmount: 0,
    // Ровно та подпись, с которой зовёт сервер: кадр, настройки сжатия и
    // обратный вызов. Пока настройки сюда не приезжали, подделка принимала их
    // за обратный вызов и звала объект — сокет закрывался на первом же кадре,
    // а тест сообщал об этом как о пропавшей склейке.
    send(frame: unknown, ...rest: unknown[]) {
      if (frame instanceof Uint8Array) frames.push(new Uint8Array(frame))
      const done = rest.find((it) => typeof it === 'function') as
        | ((err?: Error) => void)
        | undefined
      done?.()
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
      // Обработчик обязан отработать: в нём гасится сердцебиение, без него
      // интервал переживёт тест и потащит за собой всю сюиту.
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return {
    ws: fake as unknown as WebSocket,
    frames,
    close: () => fake.close(),
  }
}

/** Кадры синхронизации — те, что несут правки; первый кадр входа не в счёт. */
const syncFrames = (fake: Fake): Uint8Array[] => fake.frames.filter((frame) => frame[0] === 0)

/** Байты правки из кадра синхронизации: тип, подтип, содержимое. */
function updateIn(frame: Uint8Array): Uint8Array {
  const decoder = decoding.createDecoder(frame)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  return decoding.readVarUint8Array(decoder)
}

test('пять правок в одном тике уезжают комнате одним кадром, а не пятью', async () => {
  const id = 'coalesce-one'
  createSession(id, 'Склейка', null)
  const { doc } = getSessionDoc(id)
  const watcher = socket()
  handleCollabSocket(watcher.ws, id, 'participant', 'p_watch')
  await tick()

  const before = Y.encodeStateAsUpdate(doc)
  watcher.frames.length = 0
  for (const ch of 'abcde') {
    doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ch))
  }
  assert.equal(syncFrames(watcher).length, 0, 'кадр уехал, не дождавшись конца тика')

  await tick()
  const sent = syncFrames(watcher)
  assert.equal(sent.length, 1, `комната получила ${sent.length} кадров вместо одного`)

  // И склеенный кадр — это те же самые пять правок: вкладка приходит к тому же
  // тексту, что и сервер.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, before)
  Y.applyUpdate(tab, updateIn(sent[0]))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
  )

  watcher.close()
})

test('свои же байты автору обратно не едут, чужие — едут одним кадром', async () => {
  const id = 'coalesce-author'
  createSession(id, 'Автор', null)
  const { doc } = getSessionDoc(id)
  const author = socket()
  const reader = socket()
  handleCollabSocket(author.ws, id, 'participant', 'p_author')
  handleCollabSocket(reader.ws, id, 'participant', 'p_reader')
  await tick()
  author.frames.length = 0
  reader.frames.length = 0

  // Правка, пришедшая по сокету, несёт его в качестве происхождения — так её
  // и применяет `handleMessage`.
  for (const ch of 'xyz') {
    doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ch), author.ws)
  }
  await tick()

  assert.equal(syncFrames(author).length, 0, 'автору вернули его же нажатия')
  assert.equal(syncFrames(reader).length, 1, 'соседу уехало больше одного кадра')

  author.close()
  reader.close()
})

test('присутствие тоже склеивается: десять движений курсора — один кадр', async () => {
  const id = 'coalesce-faces'
  createSession(id, 'Курсоры', null)
  const entry = getSessionDoc(id)
  const watcher = socket()
  handleCollabSocket(watcher.ws, id, 'participant', 'p_watch')
  await tick()
  watcher.frames.length = 0

  const guest = new Awareness(new Y.Doc())
  for (let i = 0; i < 10; i += 1) {
    guest.setLocalStateField('user', { id: 'p_guest', name: 'Гость', activeCellId: `c${i}` })
    // Ровно то, что делает сервер, приняв кадр присутствия от вкладки.
    applyAwarenessUpdate(
      entry.awareness,
      encodeAwarenessUpdate(guest, [guest.clientID]),
      'приезжий',
    )
  }
  const faces = watcher.frames.filter((frame) => frame[0] === 1)
  assert.equal(faces.length, 0, 'кадр присутствия уехал, не дождавшись конца тика')

  await tick()
  assert.equal(
    watcher.frames.filter((frame) => frame[0] === 1).length,
    1,
    'десять движений курсора уехали десятью кадрами',
  )

  guest.destroy()
  watcher.close()
})

/* ------------------------------------------------- обратное давление */

/** Сколько байт «ждёт отправки» на подделке сокета. */
function stalled(fake: Fake, bytes: number): void {
  ;(fake.ws as unknown as { bufferedAmount: number }).bufferedAmount = bytes
}

/**
 * Кадр вывода ячейки с картинкой — сотни килобайт, и уезжает он КАЖДОМУ. Пока
 * `send` смотрел только на `readyState`, сервер складывал по копии такого кадра
 * в очередь каждого из пятисот сокетов, а все следующие нажатия комнаты вставали
 * в эту очередь за картинкой. Теперь у очереди две черты (collab/index.ts ·
 * AWARENESS_STALL_BYTES, HOPELESS_BYTES).
 */
test('отставшему сокету перестают слать курсоры, но правки шлют', async () => {
  const id = 'stall-faces'
  createSession(id, 'Отставший', null)
  const entry = getSessionDoc(id)
  const slow = socket()
  const quick = socket()
  handleCollabSocket(slow.ws, id, 'participant', 'p_slow')
  handleCollabSocket(quick.ws, id, 'participant', 'p_quick')
  await tick()
  slow.frames.length = 0
  quick.frames.length = 0

  // Два мегабайта в очереди: за первой чертой (1 МБ), но далеко до второй.
  stalled(slow, 2 * 1024 * 1024)

  const guest = new Awareness(new Y.Doc())
  guest.setLocalStateField('user', { id: 'p_guest', name: 'Гость', activeCellId: 'c1' })
  applyAwarenessUpdate(entry.awareness, encodeAwarenessUpdate(guest, [guest.clientID]), 'приезжий')
  entry.doc.transact(() => cellSource(getCells(entry.doc).get(0)).insert(0, 'z'))
  await tick()

  assert.equal(
    slow.frames.filter((frame) => frame[0] === 1).length,
    0,
    'курсор поехал в очередь, где и так лежит картинка',
  )
  assert.equal(syncFrames(slow).length, 1, 'отставшему не отдали правку — она и есть документ')
  assert.equal(quick.frames.filter((frame) => frame[0] === 1).length, 1, 'соседу курсор не доехал')
  assert.equal(syncFrames(quick).length, 1)

  guest.destroy()
  slow.close()
  quick.close()
})

test('безнадёжно отставший сокет закрывают, а не копят ему мегабайты', async () => {
  const id = 'stall-hopeless'
  createSession(id, 'Безнадёжный', null)
  const { doc } = getSessionDoc(id)
  const lost = socket()
  handleCollabSocket(lost.ws, id, 'participant', 'p_lost')
  await tick()
  lost.frames.length = 0
  assert.equal(onlineCount(id), 1)

  // Девять мегабайт: столько уже не догонит и телефон на краю сети — вкладка
  // соберёт документ заново одним шагом синхронизации, и это дешевле.
  stalled(lost, 9 * 1024 * 1024)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'z'))
  await tick()

  assert.equal(syncFrames(lost).length, 0, 'кадр всё-таки положили в мёртвую очередь')
  assert.equal(onlineCount(id), 0, 'комната продолжает считать безнадёжный сокет своим')
})

/* --------------------------------------------- проекция тетради и дерево */

test('вывод ячейки не будит запись тетради, а правка ячейки будит', async () => {
  const id = 'books-quiet'
  createSession(id, 'Проекция', null)
  const { doc } = getSessionDoc(id)

  const told: string[] = []
  onBooksWritten((session) => told.push(session))

  // Первая запись комнаты идёт сразу при открытии — дождаться и забыть.
  await wait(1_800)
  told.length = 0

  // Ядро пишет вывод: в файле тетради выводов нет вовсе.
  doc.transact(() => {
    const cell = getCells(doc).get(0)
    const output = new Y.Map<unknown>()
    output.set('type', 'stream')
    output.set('text', new Y.Text('привет'))
    cellOutputs(cell).push([output as never])
    cell.set('execCount', 1)
    cell.set('state', 'ok')
  }, 'kernel')
  await wait(1_800)
  assert.deepEqual(told, [], 'дерево файлов уехало комнате из-за вывода ячейки')

  // А текст ячейки в файле есть — про него комната узнаёт.
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'print(1)'))
  await wait(1_800)
  assert.deepEqual(told, [id], 'комната не узнала о переписанной тетради')

  onBooksWritten(() => {})
})

test('проекция говорит, записала ли она хоть что-нибудь', () => {
  const id = 'books-wrote'
  createSession(id, 'Проекция-2', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'y = 2'))

  assert.equal(projectBooks(id), true, 'первая запись тетради не состоялась')
  assert.equal(projectBooks(id), false, 'тетрадь переписали, хотя на диске то же самое')
})

/* ------------------------------------------------------ большая тетрадь */

/** Тетрадь на заданное число байт: один вывод раздут до нужного размера. */
function fatNotebook(bytes: number): string {
  const shell = {
    cells: [
      {
        cell_type: 'code',
        source: ['print("привет")'],
        metadata: {},
        execution_count: 1,
        outputs: [{ output_type: 'display_data', data: { 'image/png': '' }, metadata: {} }],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }
  const base = JSON.stringify(shell)
  const png = 'A'.repeat(Math.max(0, bytes - base.length))
  shell.cells[0].outputs[0].data['image/png'] = png
  return JSON.stringify(shell)
}

test('тетрадь с картинками открывается, а не объявляется «не похожей на .ipynb»', () => {
  const id = 'book-fat'
  createSession(id, 'Большая', null)
  getSessionDoc(id)
  const file = path.join(sessionDir(id), 'Лекция.ipynb')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Больше потолка редактора (1.5 МБ) — обычная преподавательская тетрадь.
  fs.writeFileSync(file, fatNotebook(2 * 1024 * 1024))

  const opened = openBook(id, 'Лекция.ipynb')
  assert.equal(opened.ok, true, `не открылась: ${opened.ok ? '' : opened.why}`)
  if (!opened.ok) return
  const cells = bookCells(getSessionDoc(id).doc, opened.book.root)
  assert.equal(cells.length, 1)
  assert.equal(cellSource(cells.get(0)).toString(), 'print("привет")')
})

test('тетрадь сверх своего потолка отказывается словами про размер', () => {
  const id = 'book-huge'
  createSession(id, 'Огромная', null)
  getSessionDoc(id)
  const file = path.join(sessionDir(id), 'Гора.ipynb')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, fatNotebook(33 * 1024 * 1024))

  const opened = openBook(id, 'Гора.ipynb')
  assert.equal(opened.ok, false)
  if (opened.ok) return
  assert.match(opened.why, /МБ/, `сказали не про размер: ${opened.why}`)
  assert.doesNotMatch(opened.why, /не похоже/, 'причина названа неверно')
})

/* --------------------------------------------------------- форма и всплеск */

function historyRoom(id: string): Y.Doc {
  createSession(id, 'История', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  return doc
}

/** Записать, как это делает `collab/index.ts`, — вместе с транзакцией. */
function watchFor(id: string, doc: Y.Doc, author: string | null): void {
  doc.on('update', (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) =>
    record(id, doc, update, author, tr),
  )
}

const edits = (id: string): number =>
  listVersions(id, 200).filter((v) => v.kind === 'edit' || v.kind === 'quiet').length

test('набор всплеск не закрывает, а перестановка ячейки — закрывает', () => {
  const id = 'shape-typing'
  const doc = historyRoom(id)
  doc.transact(() => getCells(doc).push([createCell('code', 'a', 'c1'), createCell('code', 'b', 'c2')]))
  watchFor(id, doc, 'p_one')

  const before = edits(id)
  for (const ch of 'print(1)') doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ch))
  assert.equal(edits(id), before, 'набор закрыл всплеск на каждом нажатии')

  // А состав тетради — закрывает сразу: это то, ради чего в панель и лезут.
  doc.transact(() => getCells(doc).push([createCell('code', 'c', 'c3')]))
  assert.equal(edits(id), before + 1, 'добавленная ячейка не стала версией')
  discardBurst(id)
})

test('перестановка во ВТОРОЙ тетради тоже закрывает всплеск', () => {
  const id = 'shape-second'
  const doc = historyRoom(id)
  doc.transact(() => {
    getCells(doc).push([createCell('code', 'a', 'c1')])
    addBook(doc, 'Вторая.ipynb', 'cells-2')
    bookCells(doc, 'cells-2').push([createCell('code', 'x', 'd1'), createCell('code', 'y', 'd2')])
  })
  watchFor(id, doc, 'p_one')

  const before = edits(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'z'))
  assert.equal(edits(id), before, 'набор в первой тетради закрыл всплеск')

  // Форма смотрела только в тетрадь комнаты: правка состава второй проезжала
  // мимо истории и склеивалась с чужим набором.
  doc.transact(() => bookCells(doc, 'cells-2').delete(0, 1))
  assert.equal(edits(id), before + 1, 'правка второй тетради не стала версией')
  discardBurst(id)
})

test('потолок всплеска растёт вместе с числом печатающих', () => {
  // Латиницей, чтобы символ был байтом: всплеск считает БАЙТЫ обновлений.
  const big = 'a'.repeat(BURST_MAX_CHARS + 200)

  const alone = 'burst-alone'
  const one = historyRoom(alone)
  one.transact(() => getCells(one).push([createCell('code', '', 'c1')]))
  one.on('update', (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) =>
    record(alone, one, u, 'p_one', tr),
  )
  const wasAlone = edits(alone)
  one.transact(() => cellSource(getCells(one).get(0)).insert(0, big))
  assert.equal(edits(alone), wasAlone + 1, 'у одного печатающего всплеск не закрылся по объёму')
  discardBurst(alone)

  // Тот же объём, но написанный вдвоём, — это два дела, а не одно, и порог у
  // него вдвое выше: иначе пятьсот печатающих закрывали бы всплеск десятки раз
  // в секунду, каждый раз разворачивая документ целиком.
  const pair = 'burst-pair'
  const two = historyRoom(pair)
  two.transact(() => getCells(two).push([createCell('code', '', 'c1')]))
  const wasPair = edits(pair)
  const half = 'a'.repeat(Math.floor(BURST_MAX_CHARS / 2) + 200)
  for (const author of ['p_one', 'p_two']) {
    const grab = (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) =>
      record(pair, two, u, author, tr)
    two.on('update', grab)
    two.transact(() => cellSource(getCells(two).get(0)).insert(0, half))
    two.off('update', grab)
  }
  assert.equal(edits(pair), wasPair, 'всплеск двоих закрылся по порогу одного')
  discardBurst(pair)
})

/* ------------------------------------------------------------- лица и эхо */

test('комната помнит ушедшее лицо дольше, чем длится смена пятисот вкладок', () => {
  const room = new Awareness(new Y.Doc())
  const first = {} as WebSocket
  const second = {} as WebSocket
  const conns = new Map<WebSocket, unknown>([
    [first, { clientIds: new Set<number>() }],
    [second, { clientIds: new Set<number>() }],
  ])
  const entry = { awareness: room, conns } as never

  // Лицо, которое комната уже видела и потеряло вместе с сокетом.
  const gone = new Awareness(new Y.Doc())
  gone.setLocalStateField('user', { name: 'Ушедший' })
  assert.equal(ownAwareness(entry, first, encodeAwarenessUpdate(gone, [gone.clientID])), true)

  // У соседней вкладки уже есть своё лицо — именно она и присылает эхо.
  const neighbour = new Awareness(new Y.Doc())
  neighbour.setLocalStateField('user', { name: 'Сосед' })
  assert.equal(
    ownAwareness(entry, second, encodeAwarenessUpdate(neighbour, [neighbour.clientID])),
    true,
  )

  // За пару в комнате на пятьсот человек лиц проходит намного больше двухсот
  // пятидесяти шести — столько помнил прежний потолок.
  for (let i = 0; i < 600; i += 1) {
    const passing = new Awareness(new Y.Doc())
    const seat = {} as WebSocket
    conns.set(seat, { clientIds: new Set<number>() })
    assert.equal(
      ownAwareness(entry, seat, encodeAwarenessUpdate(passing, [passing.clientID])),
      true,
    )
    conns.delete(seat)
    passing.destroy()
  }

  // Эхо соседней вкладки приносит clientID ушедшего. Забудь комната его — и
  // вкладка присвоила бы себе чужое лицо вместе с курсором и именем.
  assert.equal(
    ownAwareness(entry, second, encodeAwarenessUpdate(gone, [gone.clientID])),
    false,
    'эхо соседней вкладки присвоило себе лицо ушедшего',
  )

  gone.destroy()
  neighbour.destroy()
  room.destroy()
})

/* --------------------------------------------------------- потолок файла */

test('потолок файла меряется в байтах, а не в символах', () => {
  const id = 'file-bytes'
  createSession(id, 'Потолок', null)
  fs.mkdirSync(sessionDir(id), { recursive: true })

  // 800 тысяч кириллических символов — это 1.6 МБ в UTF-8: больше потолка,
  // хотя `length` у такой строки заведомо меньше него.
  const cyrillic = 'я'.repeat(800_000)
  assert.ok(cyrillic.length < 1_500_000 && Buffer.byteLength(cyrillic, 'utf8') > 1_500_000)
  assert.equal(putText(id, 'русский.txt', cyrillic), false, 'файл сверх потолка лёг на диск')
  assert.equal(fs.existsSync(path.join(sessionDir(id), 'русский.txt')), false)

  // А то же число байтов латиницей по-прежнему проходит.
  assert.equal(putText(id, 'latin.txt', 'a'.repeat(800_000)), true)
})
