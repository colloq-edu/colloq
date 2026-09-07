/**
 * Метку раздаёт комната, а не тридцать браузеров независимо.
 *
 * Экран входа выбирает зверя по ростеру и обещает: «того, кого в этой комнате
 * никто не занял». Обещание он сдержать не может — класс открывает ссылку в
 * одну минуту, у всех тридцати комната пуста, — и клиент это честно сузил до
 * круга сети (web/src/components/join/pick.ts): ростер перечитывается прямо
 * перед стуком. Две вкладки, постучавшие в одну секунду, друг друга всё равно
 * не видят, и сорок меток на класс из тридцати дают около одиннадцати пар с
 * одним зверем — то есть с одинаковым курсором в тетради, потому что цвет их не
 * различает (он минтуется из id). Замечают это на двадцатой минуте.
 *
 * Судья тут один, и он здесь: `/join` подменяет занятую метку свободной и
 * возвращает ту, что выдал на самом деле. Занятыми считаются двое — те, кто в
 * комнате СЕЙЧАС (присутствие), и те, кому метку выдали только что: между
 * входом и первым кадром присутствия проходит секунда, и весь класс, открывший
 * ссылку разом, укладывается в неё.
 *
 * Подменяется при этом только ВЫДАННАЯ метка. Ткнутую пальцем (`picked` в теле
 * запроса) сервер оставляет как есть: подборщик занятых нажать не даёт, так
 * что совпасть она может лишь в круге сети, — а два ежа в комнате дешевле
 * экрана, который молча выдал выдру вместо ежа.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { isMark } from '../shared/marks.js'
import type { JoinResponse } from '../shared/protocol.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

const ROOM = 'mark-judge'
const FOX = '🦊'
const TURTLE = '🐢'
const HEDGEHOG = '🦔'
const WHALE = '🐳'
const PARROT = '🦜'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Кто есть кто', null)
  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** `picked` — как его шлёт браузер: чем угодно, а не только булевым. */
type Extra = { participantId?: string; token?: string; picked?: unknown }

async function knock(name: string, avatar: string, extra?: Extra): Promise<JoinResponse> {
  const res = await fetch(`${base}/api/sessions/${ROOM}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, avatar, ...(extra ?? {}) }),
  })
  assert.equal(res.status, 200, `${name} не вошёл`)
  return (await res.json()) as JoinResponse
}

/** Вход с меткой, ткнутой пальцем: то же тело, плюс признак выбора. */
function pick(name: string, avatar: string, picked: unknown = true): Promise<JoinResponse> {
  return knock(name, avatar, { picked })
}

/** Человек в комнате — так, как его видит сервер: кадром присутствия. */
function sitsInRoom(participantId: string): void {
  const entry = getSessionDoc(ROOM)
  const guest = new Awareness(new Y.Doc())
  guest.setLocalStateField('user', { id: participantId, name: participantId, color: '#123456' })
  applyAwarenessUpdate(entry.awareness, encodeAwarenessUpdate(guest, [guest.clientID]), 'тест')
}

test('две вкладки в одну секунду расходятся с разными зверями', async () => {
  const first = await knock('Аня', FOX)
  assert.equal(first.participant.avatar, FOX, 'свободную метку подменили ни за чем')

  // Присутствия у Ани ещё нет — она даже не успела открыть сокет. Ровно этот
  // промежуток и делал из класса, открывшего ссылку разом, комнату с парами
  // одинаковых курсоров.
  const second = await knock('Боря', FOX)
  assert.notEqual(second.participant.avatar, FOX, 'два одинаковых зверя в одной комнате')
  assert.ok(
    isMark(second.participant.avatar),
    `сервер выдал ${second.participant.avatar} — это не метка из списка`,
  )
})

test('метка того, кто в комнате сейчас, занята и для опоздавшего', async () => {
  const sitting = await knock('Вера', TURTLE)
  sitsInRoom(sitting.participant.id)

  const late = await knock('Гриша', TURTLE)
  assert.notEqual(late.participant.avatar, TURTLE, 'опоздавший сел на чужой курсор')
})

test('вернувшийся остаётся собой: своя метка занятой не считается', async () => {
  const first = await knock('Дина', '🦉')
  const mine = { participantId: first.participant.id, token: first.token }
  sitsInRoom(first.participant.id)

  // Обновлённая вкладка — тот же человек с тем же ключом. Подменить ему метку
  // значило бы объявить его чужим самому себе.
  const again = await knock('Дина', '🦉', mine)
  assert.equal(again.participant.id, first.participant.id)
  assert.equal(again.participant.avatar, '🦉', 'человек вернулся и стал другим зверем')
})

test('свободную метку сервер не трогает', async () => {
  const free = await knock('Женя', '🦩')
  assert.equal(free.participant.avatar, '🦩')
})

/* --------------------------------------------------- выбранное руками */

/**
 * Подмена — против молчаливого совпадения, а не против человека.
 *
 * Подборщик занятые метки рисует занятыми и нажать на них не даёт, а ростер
 * перечитывает при открытии, так что ткнуть в чужого зверя можно только в
 * круге сети. Два ежа в комнате дешевле экрана, который молча сделал вид, что
 * не услышал: карточка входа к этому моменту уже уехала, и объяснить подмену
 * потом нечем.
 */
test('ткнули в занятого ежа — вошли ежом', async () => {
  const first = await knock('Зина', HEDGEHOG)
  assert.equal(first.participant.avatar, HEDGEHOG)
  sitsInRoom(first.participant.id)

  const byHand = await pick('Игорь', HEDGEHOG)
  assert.equal(
    byHand.participant.avatar,
    HEDGEHOG,
    'выбранного руками зверя подменили — человек нажал на ежа и стал кем-то ещё',
  )
})

test('выбранная руками занимает окно: следующему её уже не выдадут', async () => {
  const byHand = await pick('Ксюша', WHALE)
  assert.equal(byHand.participant.avatar, WHALE)

  // Присутствия у неё ещё нет — держит короткая память выдачи. Без неё
  // автоподбор через секунду выдал бы того же кита, и подмена «выбранного»
  // обернулась бы парой одинаковых курсоров с другой стороны.
  const next = await knock('Лёва', WHALE)
  assert.notEqual(next.participant.avatar, WHALE, 'кита выдали второй раз подряд')
  assert.ok(isMark(next.participant.avatar), 'сервер выдал строку, которой нет в списке меток')
})

test('признак читается строго: «true» строкой ничего не открывает', async () => {
  const first = await knock('Марк', PARROT)
  sitsInRoom(first.participant.id)

  // Тело запроса приходит из браузера, и «истинное» вроде строки или единицы
  // здесь не в счёт: иначе подмену выключает любой, кто её не хочет.
  const sneaky = await pick('Нина', PARROT, 'true')
  assert.notEqual(sneaky.participant.avatar, PARROT, 'подмену выключила строка вместо true')
})
