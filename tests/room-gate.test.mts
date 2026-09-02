/**
 * Правило комнаты, доведённое до документа.
 *
 * Разбор говорит, ЧТО в кадре; правила — кому это можно. Здесь проверяется
 * стык, и проверяется на настоящих кадрах: два документа, обмен байтами,
 * никаких выдуманных приговоров. Ошибка здесь выглядит как работающий гейт и
 * стоит либо запертой комнаты при разрешающих умолчаниях, либо правила,
 * которое ничего не значит.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import type { WebSocket } from 'ws'
import { ownAwareness } from '../server/src/collab/index.js'
import { classify, permits } from '../server/src/collab/gate.js'
import { OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import { CELLS_KEY, META_KEY, createCell } from '../shared/notebook.js'
import { mayReload, refusalHealed, stashRefusal, takeRefusal } from '../web/src/lib/refusal.js'

/*
 * У узла нет sessionStorage — а модуль про него и написан. Подделка ровно того
 * размера, который он читает: если он однажды начнёт хранить иначе, тест это
 * заметит, а не пройдёт мимо.
 */
const store = new Map<string, string>()
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

function pair(): { server: Y.Doc; client: Y.Doc; frame: (write: () => void) => Uint8Array } {
  const server = new Y.Doc()
  const client = new Y.Doc()
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Семинар')
    server.getArray(CELLS_KEY).push([createCell('code', 'print(1)', 'c1'), createCell('code', 'x', 'c2')])
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

/** Прошёл бы этот кадр в такой комнате от такого человека. */
function passes(
  server: Y.Doc,
  bytes: Uint8Array,
  rules: Partial<RoomRules>,
  role: 'host' | 'participant',
): string | null {
  const judged = classify(server, bytes)
  if (!judged.ok) return judged.why
  const verdict = permits(judged.verdicts, { ...OPEN_ROOM, ...rules }, role)
  return verdict.ok ? null : verdict.message
}

const typing = (client: Y.Doc): void => {
  const cell = client.getArray(CELLS_KEY).get(0) as Y.Map<unknown>
  ;(cell.get('source') as Y.Text).insert(0, 'ы')
}

/* --------------------------------------------------------------- печатать */

test('в лекционной комнате студент не пишет, а преподаватель пишет', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => typing(client))
  assert.match(passes(server, bytes, { edit: 'host' }, 'participant') ?? '', /преподавател/i)
  assert.equal(passes(server, bytes, { edit: 'host' }, 'host'), null)
  assert.equal(passes(server, bytes, {}, 'participant'), null, 'умолчание закрыло тетрадь')
})

/* ------------------------------------------------------------ состав листа */

test('«только дописывать» разрешает свою ячейку и запрещает убрать чужую', () => {
  const { server, client, frame } = pair()
  const added = frame(() => client.getArray(CELLS_KEY).push([createCell('code', 'моё', 'c9')]))
  assert.equal(passes(server, added, { structure: 'add' }, 'participant'), null)
  Y.applyUpdate(server, added)

  const removed = frame(() => client.getArray(CELLS_KEY).delete(0, 1))
  assert.match(passes(server, removed, { structure: 'add' }, 'participant') ?? '', /убирает/i)
  assert.equal(passes(server, removed, { structure: 'add' }, 'host'), null)
})

test('«состав — преподавательский» запрещает и добавление', () => {
  const { server, client, frame } = pair()
  const added = frame(() => client.getArray(CELLS_KEY).push([createCell('code', 'моё', 'c9')]))
  assert.match(passes(server, added, { structure: 'host' }, 'participant') ?? '', /добавляет/i)
})

/* ------------------------------------------------------------- имя семинара */

test('имя семинара меняет преподаватель, при любых правилах', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getMap(META_KEY).set('title', 'Моё имя'))
  for (const rules of [{}, { edit: 'room' as const }, { structure: 'room' as const }]) {
    assert.ok(passes(server, bytes, rules, 'participant'), 'имя переписали при правилах ' + JSON.stringify(rules))
  }
  assert.equal(passes(server, bytes, {}, 'host'), null)
})

/* --------------------------------------------------------------------- пол */

test('пол комнаты не поднимается никакими правилами', () => {
  /*
   * Разрешительнее «всем можно всё» правил не бывает — а это по-прежнему
   * отказывает, и должно: сервер пишет вывод сам, и никакая настройка не
   * делает подделку чужого вывода вопросом настройки.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<style>*{display:none}</style>' }))
    ;((client.getArray(CELLS_KEY).get(0) as Y.Map<unknown>).get('outputs') as Y.Array<unknown>).push([out])
  })
  const everything: Partial<RoomRules> = {
    edit: 'room',
    run: 'room',
    structure: 'room',
    board: 'room',
    files: 'room',
    agent: 'room',
    wipe: 'room',
    restart: 'room',
    history: 'room',
  }
  assert.ok(passes(server, bytes, everything, 'participant'))
  assert.ok(passes(server, bytes, everything, 'host'), 'преподавателю подделка вывода тоже закрыта')
})

/* ---------------------------------------------------- ужесточение на ходу */

test('правило, поменявшееся посреди пары, действует на следующий же кадр', () => {
  // Правила читаются на каждый кадр, а не на подключение: иначе «глаза сюда»
  // начинало бы работать только после того, как все переподключились.
  const { server, client, frame } = pair()
  const before = frame(() => typing(client))
  assert.equal(passes(server, before, {}, 'participant'), null)
  Y.applyUpdate(server, before)
  const after = frame(() => typing(client))
  assert.ok(passes(server, after, { edit: 'host' }, 'participant'))
})

/* ------------------------------------------- что делает отказанный браузер */

test('записка об отказе переживает перезагрузку — и ровно один раз', () => {
  /*
   * Браузер, которому отказали, пересобирает документ перезагрузкой: убрать у
   * него структуру протокол не умеет, а без пересборки он нем навсегда — все
   * его следующие кадры ссылаются на такты, которых у сервера нет.
   *
   * Перезагрузка без записки была бы молчаливым стиранием чужой работы, что не
   * лучше молчаливо онемевшего браузера.
   */
  const note = {
    sessionId: 'gate-room',
    message: 'Тетрадь принадлежит преподавателю.',
    text: 'df.head()',
    at: Date.now(),
  }
  stashRefusal(note)
  const back = takeRefusal('gate-room')
  assert.equal(back?.text, 'df.head()')
  assert.equal(back?.message, note.message)
  // Ровно один раз: показать её на второй перезагрузке — объяснять человеку то,
  // чего он уже не помнит.
  assert.equal(takeRefusal('gate-room'), null)
})

test('записка из другой комнаты и записка позавчерашняя не показываются', () => {
  stashRefusal({ sessionId: 'другая', message: 'нет', text: 'x', at: Date.now() })
  assert.equal(takeRefusal('gate-room'), null, 'чужая комната показала записку')

  stashRefusal({ sessionId: 'gate-room', message: 'нет', text: 'x', at: Date.now() - 300_000 })
  assert.equal(takeRefusal('gate-room'), null, 'старая записка пережила свой смысл')
})

/* ------------------------------------------------------------ присутствие */

test('кадр присутствия про чужого человека не принимается', () => {
  /*
   * `applyAwarenessUpdate` принимает состояние ЛЮБОГО clientID, лишь бы такт
   * был выше. То есть один участник мог убрать всех остальных из панели людей
   * для всей комнаты или переписать чужой курсор вместе с именем и ролью.
   */
  const alice = new Awareness(new Y.Doc())
  alice.setLocalStateField('user', { name: 'Алиса' })
  const bob = new Awareness(new Y.Doc())
  bob.setLocalStateField('user', { name: 'Боб' })

  const room = new Awareness(new Y.Doc())
  applyAwarenessUpdate(room, encodeAwarenessUpdate(bob, [bob.clientID]), 'bob')

  const socket = {} as WebSocket
  const entry = {
    awareness: room,
    conns: new Map([[socket, { clientIds: new Set<number>() } as never]]),
  }

  // Своё лицо — можно, и сокет его запоминает.
  assert.equal(ownAwareness(entry, socket, encodeAwarenessUpdate(alice, [alice.clientID])), true)
  assert.equal(ownAwareness(entry, socket, encodeAwarenessUpdate(alice, [alice.clientID])), true)

  // Чужое, уже стоящее в комнате, — нет.
  assert.equal(
    ownAwareness(entry, socket, encodeAwarenessUpdate(bob, [bob.clientID])),
    false,
    'один сокет переписал чужое присутствие',
  )

  alice.destroy()
  bob.destroy()
  room.destroy()
})

test('эхо соседней вкладки не достаётся сокету, который своё лицо уже привёл', () => {
  /*
   * `y-websocket` пересылает в сокет КАЖДОЕ обновление присутствия, которое
   * применил, — в том числе приехавшее по BroadcastChannel из соседней вкладки
   * того же семинара. Пока сосед на связи, эхо отбивается тем, что его лицо
   * уже стоит в комнате. Но стоит соседу оборваться, его лицо снимают — и эхо
   * проходило: вкладка А присваивала себе clientID вкладки Б, кадры
   * переподключившегося Б молча отбрасывались, а уход А уносил Б из панели
   * людей.
   */
  const room = new Awareness(new Y.Doc())
  const a = new Awareness(new Y.Doc())
  a.setLocalStateField('user', { name: 'Вкладка А' })
  const b = new Awareness(new Y.Doc())
  b.setLocalStateField('user', { name: 'Вкладка Б' })

  const socketA = {} as WebSocket
  const socketB = {} as WebSocket
  const stateA = { clientIds: new Set<number>() }
  const stateB = { clientIds: new Set<number>() }
  const entry = {
    awareness: room,
    conns: new Map([
      [socketA, stateA as never],
      [socketB, stateB as never],
    ]),
  }

  assert.equal(ownAwareness(entry, socketA, encodeAwarenessUpdate(a, [a.clientID])), true)
  assert.equal(ownAwareness(entry, socketB, encodeAwarenessUpdate(b, [b.clientID])), true)
  applyAwarenessUpdate(room, encodeAwarenessUpdate(b, [b.clientID]), 'b')

  // У Б моргнул Wi-Fi: сокет закрыт, лицо из комнаты снято.
  entry.conns.delete(socketB)
  removeAwarenessStates(room, [b.clientID], null)

  assert.equal(
    ownAwareness(entry, socketA, encodeAwarenessUpdate(b, [b.clientID])),
    false,
    'сокет А присвоил себе лицо соседней вкладки',
  )

  // А сам Б, переподключившись, заходит со своим прежним clientID первым кадром.
  const back = {} as WebSocket
  entry.conns.set(back, { clientIds: new Set<number>() } as never)
  assert.equal(
    ownAwareness(entry, back, encodeAwarenessUpdate(b, [b.clientID])),
    true,
    'переподключившаяся вкладка не смогла вернуть себе своё лицо',
  )

  a.destroy()
  b.destroy()
  room.destroy()
})

test('один сокет не наполняет комнату выдуманными людьми', () => {
  // Без потолка панель людей заполняется участниками, у каждого из которых имя,
  // цвет и курсор в чужой ячейке.
  const room = new Awareness(new Y.Doc())
  const socket = {} as WebSocket
  const entry = {
    awareness: room,
    conns: new Map([[socket, { clientIds: new Set<number>() } as never]]),
  }
  const made: Awareness[] = []
  let accepted = 0
  for (let i = 0; i < 8; i += 1) {
    const face = new Awareness(new Y.Doc())
    face.setLocalStateField('user', { name: `Призрак ${i}` })
    made.push(face)
    if (ownAwareness(entry, socket, encodeAwarenessUpdate(face, [face.clientID]))) accepted += 1
  }
  assert.equal(accepted, 4, 'потолок на лица с одного сокета не сработал')
  for (const face of made) face.destroy()
  room.destroy()
})

test('перезагрузка после отказа не превращается в круг', () => {
  /*
   * Перезагрузка лечит только вместе с очисткой кэша. Если `clear()` не удался
   * — приватное окно, запрет на хранилище, — `y-indexeddb` переиграет
   * отказанную правку, сервер откажет снова, и страница начнёт
   * перезагружаться по кругу. Немой браузер плох; вечно перезагружающийся хуже.
   */
  refusalHealed()
  assert.equal(mayReload(), true)
  assert.equal(mayReload(), true)
  assert.equal(mayReload(), false, 'третья перезагрузка подряд — это круг')

  // А ожившее соединение серию НЕ обрывает: серверный sync приходит раньше,
  // чем сервер разберёт наш кадр и откажет, так что обнулять счёт по нему
  // значило бы не сработать ни разу. Рвёт серию прожитое время — см.
  // web/src/lib/refusal.ts и tests/panels.test.mts.
  refusalHealed()
  assert.equal(mayReload(), false, 'sync посреди круга обнулил счёт попыток')
})
