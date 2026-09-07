/**
 * Бухгалтерия присутствия: что доходит до экрана, а что нет.
 *
 * Присутствие — самый болтливый провод в продукте: курсор публикуется на каждое
 * нажатие у каждого из пятисот, и раньше каждый такой кадр пересобирал список
 * людей новым массивом. Новый массив будит ВСЕХ его читателей: счётчик в шапке,
 * панель людей, аватары оракула и поиск «кто запускал» в каждой смонтированной
 * ячейке — то есть сотни пересборок в секунду на каждом ноутбуке в аудитории.
 *
 * Ломается это молча: интерфейс остаётся правильным, просто у всех лагает
 * набор. Поэтому здесь проверяется не «что нарисовано», а «что дошло»:
 * тождественность массива после кадра, в котором не изменилось ничего из
 * нарисованного, — единственное, что отличает починенное от сломанного.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextPeers,
  peersById,
  samePeerUser,
  PRESENCE_TICK_MS,
  type Peer,
} from '../web/src/lib/peers.js'
import type { AwarenessUser } from '../shared/protocol.js'

function user(over: Partial<AwarenessUser> = {}): AwarenessUser {
  return {
    id: 'p1',
    name: 'Ада',
    avatar: null,
    color: '#0FA0D7',
    role: 'participant',
    activeCellId: null,
    ...over,
  }
}

/** Состояния присутствия так, как их отдаёт `awareness.getStates()`. */
function states(...rows: [number, AwarenessUser][]): Map<number, { user: AwarenessUser }> {
  return new Map(rows.map(([id, u]) => [id, { user: u }]))
}

test('кадр, в котором не изменилось нарисованное, не доходит ни до кого', () => {
  const self = 7
  const first = nextPeers(states([self, user({ id: 'me', name: 'Я' })], [8, user()]), self, [])
  assert.equal(first.length, 2)

  // Тот же состав, но объекты присутствия ДРУГИЕ: их декодируют заново на
  // каждом кадре, и тождественность сама по себе ничего не значит.
  const again = nextPeers(states([self, user({ id: 'me', name: 'Я' })], [8, user()]), self, first)
  assert.equal(again, first, 'вернулся новый массив — проснулись все читатели')
})

test('курсор, проехавший внутри той же ячейки, не считается изменением', () => {
  const before = nextPeers(states([8, user({ activeCellId: 'c1' })]), 7, [])
  const after = nextPeers(states([8, user({ activeCellId: 'c1' })]), 7, before)
  assert.equal(after, before)
})

test('переход в другую ячейку доходит, и прежние вкладки сохраняют себя', () => {
  const start = nextPeers(
    states([8, user({ id: 'a', name: 'Ада' })], [9, user({ id: 'b', name: 'Боря' })]),
    7,
    [],
  )
  const moved = nextPeers(
    states(
      [8, user({ id: 'a', name: 'Ада' })],
      [9, user({ id: 'b', name: 'Боря', activeCellId: 'c4' })],
    ),
    7,
    start,
  )
  assert.notEqual(moved, start, 'метка «правит ячейку» не доехала до экрана')
  assert.equal(moved[0], start[0], 'у не изменившегося соседа отняли тождественность')
  assert.equal(moved[1].user.activeCellId, 'c4')
})

test('ушедший и пришедший — это изменение', () => {
  const two = nextPeers(states([8, user({ id: 'a' })], [9, user({ id: 'b' })]), 7, [])
  const one = nextPeers(states([8, user({ id: 'a' })]), 7, two)
  assert.equal(one.length, 1)
  const three = nextPeers(
    states([8, user({ id: 'a' })], [9, user({ id: 'b' })], [10, user({ id: 'c' })]),
    7,
    one,
  )
  assert.equal(three.length, 3)
})

test('себя — первым, остальных по имени, независимо от порядка кадров', () => {
  const self = 7
  const order = nextPeers(
    states(
      [8, user({ id: 'b', name: 'Яна' })],
      [self, user({ id: 'me', name: 'Ярослав' })],
      [9, user({ id: 'c', name: 'Ада' })],
    ),
    self,
    [],
  )
  assert.deepEqual(
    order.map((peer) => peer.user.name),
    ['Ярослав', 'Ада', 'Яна'],
  )
  assert.equal(order[0].isSelf, true)
})

test('перестановка людей — тоже изменение: список рисуется в этом порядке', () => {
  const before = nextPeers(
    states([8, user({ id: 'a', name: 'Ада' })], [9, user({ id: 'b', name: 'Боря' })]),
    7,
    [],
  )
  // Ада переименовалась в Яну — порядок обязан поменяться.
  const after = nextPeers(
    states([8, user({ id: 'a', name: 'Яна' })], [9, user({ id: 'b', name: 'Боря' })]),
    7,
    before,
  )
  assert.notEqual(after, before)
  assert.deepEqual(
    after.map((peer) => peer.user.name),
    ['Боря', 'Яна'],
  )
})

test('сокет без личности — это входящая страница, а не человек', () => {
  const list = nextPeers(
    new Map([
      [8, { user: undefined }],
      [9, { user: user({ id: '' }) }],
      [10, { user: user({ id: 'a' }) }],
    ]) as Map<number, { user?: unknown }>,
    7,
    [],
  )
  assert.equal(list.length, 1)
})

test('каждое поле, которое рисуют, считается изменением', () => {
  const base = user({ id: 'a' })
  const changes: Partial<AwarenessUser>[] = [
    { name: 'Боря' },
    { color: '#000000' },
    { avatar: 'data:image/png;base64,x' },
    { role: 'host' },
    { activeCellId: 'c1' },
    { editing: 'utils.py' },
    { composing: true },
    { inTerminal: true },
    { viewing: { file: 'lecture.pdf', page: 3, y: 0.2 } },
  ]
  for (const over of changes) {
    assert.equal(
      samePeerUser(base, { ...base, ...over }),
      false,
      `изменение ${Object.keys(over)[0]} не доехало бы до экрана`,
    )
  }
  // А место на странице — это тоже поле: страница та же, доля высоты другая.
  const at = user({ id: 'a', viewing: { file: 'lecture.pdf', page: 3, y: 0.2 } })
  assert.equal(
    samePeerUser(at, { ...at, viewing: { file: 'lecture.pdf', page: 3, y: 0.7 } }),
    false,
  )
  // Отсутствие поля и его пустое значение — одно и то же: старая сборка соседа
  // не шлёт `composing` вовсе, и это не повод перерисовывать комнату.
  assert.equal(samePeerUser(base, { ...base, composing: false, inTerminal: false }), true)
  assert.equal(samePeerUser(base, { ...base, viewing: null }), true)
})

test('карта по участнику сводит вкладки одного человека в одно лицо', () => {
  const peers: Peer[] = [
    { clientId: 1, isSelf: false, user: user({ id: 'a', name: 'Ада' }) },
    { clientId: 2, isSelf: false, user: user({ id: 'a', name: 'Ада', activeCellId: 'c1' }) },
    { clientId: 3, isSelf: false, user: user({ id: 'b', name: 'Боря' }) },
  ]
  const byId = peersById(peers)
  assert.equal(byId.size, 2)
  assert.equal(byId.get('a')?.name, 'Ада')
  assert.equal(byId.get('b')?.name, 'Боря')
  assert.equal(byId.get('нет такого'), undefined)
})

test('тик склейки — сотая доля секунды: не «на каждое нажатие» и ещё не заметно', () => {
  assert.ok(PRESENCE_TICK_MS >= 50, 'слишком часто — склейки почти нет')
  assert.ok(PRESENCE_TICK_MS <= 200, 'метка «правит здесь» начнёт отставать заметно')
})
