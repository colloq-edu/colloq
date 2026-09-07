/**
 * Кадр присутствия с НЕСКОЛЬКИМИ лицами.
 *
 * Проверка принадлежности (`ownAwareness`) идёт по проводу руками: читает
 * clientID, такт и проходит мимо состояния. Пока в кадре одно лицо, любая
 * ошибка в шаге незаметна — после цикла больше никто ничего не читает, и все
 * прежние тесты присутствия односоставные. Со второго лица сдвиг на пару байт
 * превращает clientID в случайный байт чужого JSON, и проверка начинает
 * пропускать в комнату чужое присутствие — ровно то, ради чего написана.
 *
 * Поэтому здесь кадры настоящие и всегда многоличные: `encodeAwarenessUpdate`
 * по мешку состояний, а не по одному.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebSocket } from 'ws'
import { ownAwareness } from '../server/src/collab/index.js'

/** Лицо со своим clientID и состоянием заданной величины. */
function face(name: string): Awareness {
  const it = new Awareness(new Y.Doc())
  it.setLocalStateField('user', { name, color: '#8b5cf6' })
  return it
}

/**
 * Мешок состояний, из которого лепится кадр на несколько лиц.
 *
 * Так их и шлёт настоящий клиент: `y-websocket` возвращает серверу каждое
 * применённое обновление присутствия, а applyAwarenessUpdate успевает собрать
 * в одном такте и своё лицо, и приехавшее от сервера чужое.
 */
function bagOf(...faces: Awareness[]): Awareness {
  const bag = new Awareness(new Y.Doc())
  for (const it of faces) applyAwarenessUpdate(bag, encodeAwarenessUpdate(it, [it.clientID]), 'bag')
  return bag
}

function frame(bag: Awareness, faces: Awareness[]): Uint8Array {
  return encodeAwarenessUpdate(
    bag,
    faces.map((it) => it.clientID),
  )
}

test('два своих лица в одном кадре ложатся в сокет как есть', () => {
  /*
   * Имя длиной больше сотни знаков — не выпендрёж: длина состояния лежит на
   * проводе варинтом, и до 127 байт он однобайтовый. На коротком состоянии
   * сдвиг в один байт совпадает с началом следующей записи и может пройти
   * незамеченным; на длинном варинт двухбайтовый, и разъезд виден сразу.
   */
  const room = new Awareness(new Y.Doc())
  const first = face(`Анна Каренина, ${'очень длинное имя '.repeat(8)}`)
  const second = face('Пётр')
  const bag = bagOf(first, second)

  const socket = {} as WebSocket
  const state = { clientIds: new Set<number>() }
  const entry = { awareness: room, conns: new Map([[socket, state]]) }

  assert.equal(
    ownAwareness(entry, socket, frame(bag, [first, second])),
    true,
    'кадр с двумя своими лицами отвергнут',
  )
  assert.deepEqual(
    [...state.clientIds].sort((a, b) => a - b),
    [first.clientID, second.clientID].sort((a, b) => a - b),
    'сокет запомнил не те лица — декодер разъехался на втором',
  )

  first.destroy()
  second.destroy()
  bag.destroy()
  room.destroy()
})

test('чужое лицо вторым в кадре не проходит мимо проверки принадлежности', () => {
  /*
   * Тот самый обход: своё лицо первым, чужое — вторым. Если разбор
   * разъезжается, вторым читается мусор, мусор проверку проходит (в комнате
   * такого clientID нет), кадр объявляется своим и применяется ЦЕЛИКОМ — то
   * есть чужой курсор, имя и роль переписываются с чужого сокета.
   */
  const room = new Awareness(new Y.Doc())
  const mine = face('Аня')
  const theirs = face('Пётр, которого сейчас перепишут')
  applyAwarenessUpdate(room, encodeAwarenessUpdate(theirs, [theirs.clientID]), 'peter')

  const socket = {} as WebSocket
  const state = { clientIds: new Set<number>() }
  const entry = { awareness: room, conns: new Map([[socket, state]]) }

  assert.equal(ownAwareness(entry, socket, encodeAwarenessUpdate(mine, [mine.clientID])), true)

  const bag = bagOf(mine, theirs)
  assert.equal(
    ownAwareness(entry, socket, frame(bag, [mine, theirs])),
    false,
    'сокет переписал чужое присутствие вторым лицом в кадре',
  )
  assert.deepEqual(
    [...state.clientIds],
    [mine.clientID],
    'в сокет попало лицо, которого он не приводил',
  )

  mine.destroy()
  theirs.destroy()
  bag.destroy()
  room.destroy()
})

test('сокету записывают ровно те лица, которые кадр потом и применит', () => {
  /*
   * Главная сверка: `ownAwareness` читает кадр СВОИМИ руками, а применяет его
   * потом `applyAwarenessUpdate` по протоколу. Списки обязаны совпадать —
   * иначе всё, что стоит на `state.clientIds`, считает не тех: потолок лиц
   * (:981) отмеряет от мусора, а `closeConn` на уходе снимает присутствие по
   * этому же списку и уносит из панели людей постороннего, чей clientID
   * случайно совпал.
   *
   * Три лица в кадре, а не два: разъезд декодера накапливается, и на третьем
   * записи расходятся уже далеко.
   */
  const room = new Awareness(new Y.Doc())
  const faces = [face('Аня'), face('Аня с планшета'), face('Аня с проектора')]
  const bag = bagOf(...faces)

  const socket = {} as WebSocket
  const state = { clientIds: new Set<number>() }
  const entry = { awareness: room, conns: new Map([[socket, state]]) }

  assert.equal(ownAwareness(entry, socket, frame(bag, faces)), true, 'кадр отвергнут')
  applyAwarenessUpdate(room, frame(bag, faces), socket)

  // Своё лицо комнаты (`Awareness` заводит его сама) в кадр не приезжало.
  const applied = [...room.getStates().keys()].filter((id) => id !== room.clientID)
  assert.deepEqual(
    [...state.clientIds].sort((a, b) => a - b),
    applied.sort((a, b) => a - b),
    'сокету записали не тех, кого кадр поставил в комнату',
  )

  for (const it of faces) it.destroy()
  bag.destroy()
  room.destroy()
})
