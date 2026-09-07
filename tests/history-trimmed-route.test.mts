/**
 * Лента говорит, что она — не вся.
 *
 * История комнаты ограничена по объёму: `trimHistory` (db.ts) убирает начало
 * целым отрезком, до ближайшего снимка. После этого панель показывает остаток
 * ровно так же, как показала бы полную ленту короткой пары, — и по списку
 * нельзя отличить «тут ничего не писали» от «до этого места не сохранилось».
 * Смотрят же историю обычно как раз тогда, когда что-то потеряли.
 *
 * Признак считает сервер, по состоянию, а не по памяти о событии: самой первой
 * строкой комнаты всегда пишется `opened`, и второй раз она не появится
 * (collab/history.ts · beginHistory). Значит «самая старая строка не `opened`»
 * и есть «начало срезано» — ответ переживает перезапуск сервера.
 *
 * Здесь проверяется, что признак доезжает до панели: считать его правильно и
 * оставить в базе — это ровно та же молчаливая неполнота.
 *
 * Про окно ленты он не говорит ничего: `MAX_VERSIONS` (routes/history.ts) тоже
 * отдаёт не все строки, но те в базе есть и открываются по ссылке — смешивать
 * два вида неполноты в одном слове нельзя.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { VersionList } from '../shared/history.js'
import { signToken } from '../server/src/auth.js'
import {
  appendVersion,
  createSession,
  db,
  trimHistory,
  upsertParticipant,
} from '../server/src/db.js'
import { app } from '../server/src/app.js'
import { shutdownCollab } from '../server/src/collab/index.js'

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** Комната с одним участником, которому лента положена по умолчанию. */
function room(id: string, title: string): void {
  createSession(id, title, null)
  upsertParticipant({
    id: 'p_nina',
    sessionId: id,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })
  // Комнаты в тестах живут в одной базе: чужие строки с этим id сбили бы счёт.
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)
}

/** Строка истории заданного веса; возвращает её seq. */
function line(sessionId: string, kind: string, bytes: number): number {
  return appendVersion({
    sessionId,
    update: new Uint8Array(bytes),
    kind,
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: kind,
    added: 0,
    removed: 0,
    cells: [],
  })
}

async function history(id: string): Promise<VersionList> {
  const token = signToken({ sessionId: id, participantId: 'p_nina', role: 'participant' })
  const res = await fetch(`${base}/api/sessions/${id}/history`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 200)
  return (await res.json()) as VersionList
}

test('целая лента приходит без признака обрезки', async () => {
  const id = 'hist-whole'
  room(id, 'Полная история')

  const body = await history(id)
  // Первое чтение поднимает тетрадь, а с ней и строку «открылась»: комната,
  // где ещё ничего не записано, — не обрезанная, и говорить ей об этом нечего.
  assert.equal(body.trimmed, false, 'панели сказали, что начало срезано, а его никто не резал')
  assert.ok(body.versions.length >= 1, 'в ленте нет даже строки открытия')
})

test('после обрезки по объёму лента признаётся неполной', async () => {
  const id = 'hist-cut'
  room(id, 'Длинная пара')

  line(id, 'opened', 4_000)
  line(id, 'edit', 4_000)
  const keyframe = line(id, 'keyframe', 64)
  line(id, 'edit', 64)

  // Потолок ниже накопленного: граница встаёт ровно на снимок, и «открылась»
  // уходит вместе со всем, что было до него.
  assert.ok(trimHistory(id, 1_000) > 0, 'потолок ничего не убрал — резать было нечего')
  const oldest = db
    .prepare('SELECT MIN(seq) AS seq FROM doc_history WHERE session_id = ?')
    .get(id) as { seq: number }
  assert.equal(oldest.seq, keyframe, 'обрезка встала не на снимок')

  const body = await history(id)
  assert.equal(body.trimmed, true, 'начала истории нет, а панель об этом не знает')
  // И строки, что остались, приходят как обычно: признак — приписка к ленте, а
  // не замена ей.
  assert.ok(body.versions.length > 0, 'вместе с признаком пропала и сама лента')
})
