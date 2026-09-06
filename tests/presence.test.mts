/**
 * Что вкладка объявляет комнате.
 *
 * Присутствие — единственный провод, по которому вкладка говорит о СЕБЕ, и оба
 * решения web/src/lib/presence.ts про него: кого она называет и что про него
 * утверждает. Ошибка в первом не видна вовсе — она стоит серверу лишней
 * половины потока; ошибка во втором видна всем, кроме того, о ком врёт.
 *
 * Провайдера здесь нет намеренно: `y-websocket` кодирует и отправляет, а
 * решает — этот слой, и проверять его надо на настоящем `Awareness`, но без
 * сокета.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { CELLS_KEY, createCell } from '../shared/notebook.js'
import { LECTURE_ROOM, OPEN_ROOM } from '../shared/rules.js'
import { permitsIn } from '../web/src/lib/may.js'
import { cellToAnnounce, ownChanges, type AwarenessChanges } from '../web/src/lib/presence.js'

/* --------------------------------------------------------------- эхо */

/** Кадры, которые вкладка отправила бы серверу, — с тем же фильтром. */
function wiretap(awareness: Awareness, self: number): AwarenessChanges[] {
  const sent: AwarenessChanges[] = []
  awareness.on('update', (changes: AwarenessChanges) => {
    const own = ownChanges(changes, self)
    if (own) sent.push(own)
  })
  return sent
}

test('вкладка объявляет серверу только своё лицо', () => {
  /*
   * `y-websocket` шлёт обратно каждое изменение присутствия, которое применил,
   * — в том числе только что приехавшее от сервера. Сервер такое отвергает
   * (`ownAwareness`, см. room-gate), но чтобы отвергнуть, разбирает: на 500
   * вкладках это была половина всего потока присутствия.
   */
  const doc = new Y.Doc()
  const me = new Awareness(doc)
  const sent = wiretap(me, doc.clientID)

  me.setLocalStateField('user', { name: 'Я' })
  assert.deepEqual(
    sent,
    [{ added: [], updated: [doc.clientID], removed: [] }],
    'своё состояние до сервера не доехало',
  )

  const peer = new Awareness(new Y.Doc())
  peer.setLocalStateField('user', { name: 'Сосед' })
  applyAwarenessUpdate(me, encodeAwarenessUpdate(peer, [peer.clientID]), 'сервер')

  assert.equal(sent.length, 1, 'чужое состояние уехало обратно на сервер')
  // И при этом сосед на месте: фильтр стоит на отправке, а не на приёме, —
  // иначе не было бы ни ростера, ни чужих курсоров.
  assert.equal(me.getStates().has(peer.clientID), true, 'сосед не доехал до вкладки')

  // Уход соседа — тоже не наша новость: у сервера свой счёт молчащим.
  removeAwarenessStates(me, [peer.clientID], 'сервер')
  assert.equal(sent.length, 1, 'уход соседа уехал обратно на сервер')
  assert.equal(me.getStates().has(peer.clientID), false, 'сосед не ушёл из ростера')

  // А свой уход объявляется: им закрывается вкладка.
  removeAwarenessStates(me, [doc.clientID], 'вкладку закрыли')
  assert.deepEqual(sent.at(-1), { added: [], updated: [], removed: [doc.clientID] })

  peer.destroy()
  me.destroy()
})

test('кадр про своих и чужих разом уезжает без чужих', () => {
  // Провайдер складывает added+updated+removed в один список, и сервер
  // отвергает такую смесь ЦЕЛИКОМ — вместе с нашим собственным состоянием.
  const mine = 7
  assert.deepEqual(ownChanges({ added: [9], updated: [mine], removed: [3] }, mine), {
    added: [],
    updated: [mine],
    removed: [],
  })
  assert.equal(
    ownChanges({ added: [9], updated: [], removed: [3] }, mine),
    null,
    'кадр без единого своего лица всё равно бы уехал',
  )
})

/* ------------------------------------------------- метка «правит ячейку» */

function room(): { doc: Y.Doc; open: string; shut: string } {
  const doc = new Y.Doc()
  doc.transact(() => {
    const open = createCell('code', 'print(1)', 'c_open')
    doc.getArray(CELLS_KEY).push([open, createCell('code', 'print(2)', 'c_shut')])
    open.set('open', true)
  })
  return { doc, open: 'c_open', shut: 'c_shut' }
}

test('выделение закрытой ячейки не объявляет правку', () => {
  /*
   * Студент щёлкает по закрытой ячейке, чтобы прочитать её или спросить про
   * неё, — и у всей комнаты рядом с ней появлялась его метка «редактирует
   * здесь». Печатать он там не может: метка была неправдой.
   */
  const { doc, open, shut } = room()
  const student = permitsIn(LECTURE_ROOM, 'participant', false)
  assert.equal(cellToAnnounce(doc, shut, student), null)
  assert.equal(cellToAnnounce(doc, open, student), open, 'открытую ячейку человек правда правит')
  doc.destroy()
})

test('преподавателю замок метку не отнимает — он печатает везде', () => {
  const { doc, shut } = room()
  assert.equal(cellToAnnounce(doc, shut, permitsIn(LECTURE_ROOM, 'host', false)), shut)
  doc.destroy()
})

test('в открытой лаборатории метка стоит на любой ячейке', () => {
  // Замка там нет вовсе, и спрашивать не о чем: комната печатает везде.
  const { doc, shut } = room()
  assert.equal(cellToAnnounce(doc, shut, permitsIn(OPEN_ROOM, 'participant', false)), shut)
  doc.destroy()
})

test('после звонка не правит никто — и метка гаснет вместе с правом', () => {
  const { doc, open } = room()
  assert.equal(cellToAnnounce(doc, open, permitsIn(LECTURE_ROOM, 'participant', true)), null)
  assert.equal(cellToAnnounce(doc, open, permitsIn(OPEN_ROOM, 'participant', true)), null)
  doc.destroy()
})

test('ячейки, которой нет, в присутствии нет тоже', () => {
  // Её могли удалить у человека под курсором: указывать комнате на пустое
  // место — такая же неправда, только другого рода.
  const { doc } = room()
  const student = permitsIn(OPEN_ROOM, 'participant', false)
  assert.equal(cellToAnnounce(doc, 'c_ушла', student), null)
  assert.equal(cellToAnnounce(doc, null, student), null)
  doc.destroy()
})
