/**
 * Переподключение — не правка, и гейт обязан его пережить.
 *
 * Браузер при каждом входе предлагает серверу всё, чего у того нет (step2), и
 * в это «всё» входит ВЕСЬ набор удалений документа — навсегда, потому что
 * набор удалений не убывает. Две поломки здесь стоили живой комнате вечера:
 * обход удалённого по одному такту упирался в потолок после девяти вычищенных
 * лент оракула, а нажатия с дырой перед ними подвисали в документе и катались
 * в каждом step2 туда и обратно. Обе видны только на настоящем объёме, поэтому
 * числа ниже — с той комнаты.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { WebSocket } from 'ws'
import { classify, MAX_SYNC_STEP2_BYTES } from '../server/src/collab/gate.js'
import { createSession, loadDocSnapshot, saveDocSnapshot } from '../server/src/db.js'
import { getSessionDoc, handleCollabSocket, shutdownCollab } from '../server/src/collab/index.js'
import { flushPersistence } from '../server/src/collab/persistence.js'
import { createChatEntry, getCells, getChat } from '../shared/notebook.js'

after(() => shutdownCollab())

/** Вкладка, синхронная с сервером. */
function tabOf(server: Y.Doc): Y.Doc {
  const tab = new Y.Doc()
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
  return tab
}

/** То, что вкладка предложит серверу при входе. */
function step2(tab: Y.Doc, server: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(tab, Y.encodeStateVector(server))
}

function sourceOf(doc: Y.Doc, i: number): Y.Text {
  return (getCells(doc).get(i) as Y.Map<unknown>).get('source') as Y.Text
}

/**
 * Кадр с дырой: вкладка напечатала «a» и «b», а серверу отдаёт только «b».
 * Так выглядит нажатие, пришедшее следом за отказанным кадром того же клиента.
 * «b» ставится в конец текста, чтобы ссылалась она на то, что сервер знает, —
 * иначе отказ пришёл бы раньше и по другой причине.
 */
function holed(server: Y.Doc): { tab: Y.Doc; frame: Uint8Array } {
  const tab = tabOf(server)
  const text = sourceOf(tab, 1)
  tab.transact(() => text.insert(0, 'a'))
  const afterA = Y.encodeStateVector(tab)
  tab.transact(() => text.insert(text.length, 'b'))
  return { tab, frame: Y.encodeStateAsUpdate(tab, afterA) }
}

/* -------------------------------------------------------- набор удалений */

test('вычищенная лента не запирает комнату: переподключение проходит', () => {
  createSession('walk-gc', 'Лента', null)
  const { doc: server } = getSessionDoc('walk-gc')
  /*
   * Один ответ оракула на сто пятьдесят тысяч знаков, вычищенный баном. После
   * удаления записи её текст собирается в мусор одним куском такой же длины, и
   * обход «по такту» стоил бы здесь полтора потолка MAX_WALK. На живой комнате
   * таких кусков было 432 на 122 тысячи тактов.
   */
  const entry = createChatEntry({ participantId: 'p_x', name: 'X', color: '#000', question: 'q' })
  server.transact(() => {
    getChat(server).push([entry])
    entry.set('answer', new Y.Text('x'.repeat(150_000)))
  }, 'server')
  server.transact(() => getChat(server).delete(0, 1), 'server')

  const tab = tabOf(server)
  const frame = step2(tab, server)
  const ds = (Y.decodeUpdate(frame) as unknown as { ds: { clients: Map<number, { len: number }[]> } })
    .ds
  let span = 0
  for (const ranges of ds.clients.values()) for (const r of ranges) span += r.len
  assert.ok(span >= 150_000, `набор удалений мал для проверки: ${span}`)

  const judged = classify(server, frame, MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true, judged.ok ? '' : `${judged.why} (${judged.path})`)
  if (judged.ok) assert.deepEqual(judged.verdicts, [], 'синхронная вкладка что-то «делает»')
})

test('большая комната переподключается и тогда, когда вкладка предлагает весь документ', () => {
  /*
   * Потолок обхода был постоянным — сто тысяч шагов, — а набор удалений
   * проходится по структуре и растёт с каждым занятием. На живой комнате
   * zxrrsac6 (35 тыс. структур) синхронная вкладка стоила 55 тыс. шагов, а
   * вкладка, заново предложившая весь документ, — больше ста, и получала
   * «кадр слишком велик» при каждом входе. Здесь та же форма: сорок тысяч
   * нажатий в начало текста (так они не склеиваются в одну структуру), и
   * половина из них стёрта.
   */
  createSession('walk-big', 'Большая', null)
  // Копия без наблюдателей комнаты: сорок тысяч транзакций через историю и
  // запись на диск шли бы минутами, а гейту нужен только сам документ.
  const server = tabOf(getSessionDoc('walk-big').doc)
  const text = sourceOf(server, 1)
  for (let i = 0; i < 40_000; i++) server.transact(() => text.insert(0, 'x'), 'server')
  for (let i = 0; i < 20_000; i++) server.transact(() => text.delete(i, 1), 'server')

  const tab = tabOf(server)
  const judged = classify(server, Y.encodeStateAsUpdate(tab), MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true, judged.ok ? '' : `${judged.why} (${judged.path})`)
  if (judged.ok) assert.deepEqual(judged.verdicts, [], 'синхронная вкладка что-то «делает»')
})

/* ------------------------------------------------------------------ дыры */

test('кадр с дырой в нажатиях — отказ, а не подвисание', () => {
  createSession('walk-hole', 'Дыра', null)
  const { doc: server } = getSessionDoc('walk-hole')
  const { frame } = holed(server)

  // Вот что делал бы Yjs без отказа: принял бы и повесил навсегда.
  const naive = tabOf(server)
  Y.applyUpdate(naive, frame)
  assert.ok(
    (naive.store as unknown as { pendingStructs: unknown }).pendingStructs,
    'кадр без дыры — проверка ничего не проверяет',
  )

  const judged = classify(server, frame)
  assert.equal(judged.ok, false)
  if (!judged.ok) assert.match(judged.why, /продолжает нажатия/)
})

test('подряд идущие нажатия — не дыра', () => {
  createSession('walk-run', 'Подряд', null)
  const { doc: server } = getSessionDoc('walk-run')
  const tab = tabOf(server)
  const before = Y.encodeStateVector(tab)
  const text = sourceOf(tab, 1)
  tab.transact(() => {
    text.insert(text.length, 'a')
    text.insert(text.length, 'b')
    text.insert(0, 'c')
  })
  const judged = classify(server, Y.encodeStateAsUpdate(tab, before))
  assert.equal(judged.ok, true, judged.ok ? '' : `${judged.why} (${judged.path})`)
})

test('подвисшее у вкладки в кэше — отказ при входе, и только он', () => {
  /*
   * Вкладка, получившая от прежнего сервера step2 с подвисшим, держит его у
   * себя и предлагает обратно. Yjs записывает такую разницу с явным пропуском
   * (Skip) — это та же дыра, и ответ тот же.
   */
  createSession('walk-skip', 'Пропуск', null)
  const { doc: server } = getSessionDoc('walk-skip')
  const { frame } = holed(server)
  const tab = tabOf(server)
  Y.applyUpdate(tab, frame)
  const judged = classify(server, step2(tab, server), MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, false)
  if (!judged.ok) assert.match(judged.why, /пропуском|продолжает нажатия/)
})

/* ---------------------------------------------------------------- снимок */

test('подвисшее в снимке выбрасывается при подъёме, и снимок переписывается чистым', () => {
  createSession('walk-pending', 'Снимок', null)
  const seed = getSessionDoc('walk-pending').doc
  // Снимок, как его записал бы сервер до проверки дыр: документ плюс подвисшее.
  const dirty = tabOf(seed)
  Y.applyUpdate(dirty, holed(seed).frame)
  assert.ok((dirty.store as unknown as { pendingStructs: unknown }).pendingStructs)
  shutdownCollab()
  saveDocSnapshot('walk-pending', Y.encodeStateAsUpdate(dirty))

  const { doc: server } = getSessionDoc('walk-pending')
  assert.equal(
    (server.store as unknown as { pendingStructs: unknown }).pendingStructs,
    null,
    'подвисшее поднялось вместе с комнатой',
  )
  // Вкладке от такого сервера достаётся чистый документ — и её step2 пуст.
  const judged = classify(server, step2(tabOf(server), server), MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true)

  // И на диск ложится уже чистое — иначе каждый перезапуск поднимал бы мусор.
  flushPersistence('walk-pending')
  const again = new Y.Doc()
  Y.applyUpdate(again, loadDocSnapshot('walk-pending')!)
  assert.equal(
    (again.store as unknown as { pendingStructs: unknown }).pendingStructs,
    null,
    'снимок на диске всё ещё несёт подвисшее',
  )
})

/* ---------------------------------------------------------------- сокет */

interface Fake {
  ws: WebSocket
  fire(event: string, ...args: unknown[]): void
  closedWith: { code?: number; reason?: string } | null
}

/** Ровно то, что читает handleCollabSocket, — и слово, с которым закрыли. */
function socket(): Fake {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const out: Fake = {
    ws: null as unknown as WebSocket,
    fire(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    closedWith: null,
  }
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    send() {},
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close(code?: number, reason?: string) {
      fake.readyState = WebSocket.CLOSED
      out.closedWith ??= { code, reason }
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  out.ws = fake as unknown as WebSocket
  return out
}

function syncFrame(write: (encoder: encoding.Encoder) => void): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // MESSAGE_SYNC
  write(encoder)
  return Buffer.from(encoding.toUint8Array(encoder))
}

test('отказ первой синхронизации закрывает сокет словом «stale», отказ правке — правилом', () => {
  createSession('walk-word', 'Слово', null)
  const { doc: server } = getSessionDoc('walk-word')
  const warned: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '))
  try {
    const { frame } = holed(server)

    const entering = socket()
    handleCollabSocket(entering.ws, 'walk-word', 'participant', 'p_one')
    entering.fire(
      'message',
      syncFrame((encoder) => {
        encoding.writeVarUint(encoder, 1) // step2
        encoding.writeVarUint8Array(encoder, frame)
      }),
    )
    assert.deepEqual(entering.closedWith, { code: 4403, reason: 'stale' })

    const typing = socket()
    handleCollabSocket(typing.ws, 'walk-word', 'participant', 'p_two')
    typing.fire(
      'message',
      syncFrame((encoder) => syncProtocol.writeUpdate(encoder, frame)),
    )
    assert.deepEqual(typing.closedWith, { code: 4403, reason: 'edit' })
  } finally {
    console.warn = original
  }
  // Журналу — причина гейта словами и с путём, а не одна общая фраза про кэш.
  const line = warned.find((w) => w.includes('[gate walk-word]'))
  assert.ok(line, 'отказ не попал в журнал')
  assert.match(line!, /продолжает нажатия.*\(cells#\d+\)/)
})
