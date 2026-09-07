/**
 * «А меня-то пускают» — единственная дверь, которая обязана ответить закрытому.
 *
 * Вкладка, которой отказали в рукопожатии, не знает о себе ничего: сокет
 * закрывается ДО апгрейда и без слов, браузер видит 1006. Случая три — комнаты
 * нет, ключ протух, преподаватель закрыл доступ, — и различить их можно только
 * спросив. Пока спрашивать было негде, забаненный после перезагрузки читал
 * «место истекло», терял свою личность в комнате и назавтра входил новым
 * человеком: попытки консилиума и авторство оставались за тем, кого больше нет.
 *
 * Ошибка здесь тихая в обе стороны, поэтому проверяется и то, чего дверь НЕ
 * делает: она не стоит за общим `banDoor` (иначе забаненный получал бы 403 без
 * объяснения), и она отвечает про несуществующую комнату НАШИМИ словами — по
 * ним клиент решает стереть местную копию тетради (shared/protocol.ts ·
 * SESSION_MISSING).
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_MISSING, type SessionMe } from '../shared/protocol.js'
import { signToken } from '../server/src/auth.js'
import { banParticipant, liftBan } from '../server/src/bans.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { fileRoutes } from '../server/src/routes/files.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

const ROOM = 'me-room'
const OTHER = 'me-other-room'
let base = ''
let server: http.Server

before(async () => {
  for (const id of [ROOM, OTHER]) createSession(id, `Комната ${id}`, null)
  upsertParticipant({
    id: 'p_asks',
    sessionId: ROOM,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })

  const app = express()
  app.use(express.json())
  // Тот же порядок, что в app.ts: маршруты комнаты первыми, файловые следом.
  // Порядок здесь и есть предмет проверки — `banDoor` файлового роутера висит
  // на том же префиксе.
  app.use(sessionRoutes())
  app.use(fileRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

const tokenFor = (sessionId: string, participantId: string) =>
  signToken({ sessionId, participantId, role: 'participant' })

async function ask(room: string, token?: string): Promise<{ status: number; body: SessionMe }> {
  const res = await fetch(`${base}/api/sessions/${room}/me`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.status, body: (await res.json()) as SessionMe }
}

test('свой ключ — комната признаёт его и называет, кем', async () => {
  const { status, body } = await ask(ROOM, tokenFor(ROOM, 'p_asks'))
  assert.equal(status, 200)
  assert.deepEqual(body, {
    tokenValid: true,
    ban: null,
    participantId: 'p_asks',
    role: 'participant',
  })
})

test('без ключа — «предъявите ключ», а не «вас удалили»', async () => {
  const { status, body } = await ask(ROOM)
  assert.equal(status, 200, 'дверь заведена ровно затем, чтобы отвечать; молчать ей нельзя')
  assert.deepEqual(body, { tokenValid: false, ban: null, participantId: null, role: null })
})

test('ключ от другой комнаты — не ключ', async () => {
  const { body } = await ask(ROOM, tokenFor(OTHER, 'p_asks'))
  assert.equal(body.tokenValid, false, 'чужой ключ признан своим')
  assert.equal(body.participantId, null)
})

test('комнаты нет — 404 НАШИМИ словами', async () => {
  const res = await fetch(`${base}/api/sessions/no-such-room/me`)
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: string }
  // По этим словам клиент стирает местную копию тетради. Любой другой 404 —
  // от ретранслятора, от статики — для него обрыв связи, а не приговор.
  assert.equal(body.error, SESSION_MISSING)
})

test('забаненному эта дверь отвечает — и говорит, до какого часа', async () => {
  const until = Date.now() + 45 * 60 * 1000
  const ban = banParticipant({
    sessionId: ROOM,
    participantId: 'p_asks',
    ip: null,
    byTeacher: 'Ада',
    until,
  })
  assert.ok(ban, 'бан не завёлся — проверять нечего')

  const token = tokenFor(ROOM, 'p_asks')
  const { status, body } = await ask(ROOM, token)
  assert.equal(status, 200, 'дверь для забаненного ответила отказом — как раз то, чего нельзя')
  assert.equal(body.tokenValid, true, 'ключ цел: человека закрыли, а не разлогинили')
  assert.equal(body.ban?.until, until, 'экран бана рисует час окончания по этому числу')

  // А остальные двери комнаты для него закрыты — то есть дело не в том, что
  // бан не действует, а в том, что эта дверь заведена отдельно и намеренно.
  const closed = await fetch(`${base}/api/sessions/${ROOM}/participants`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(closed.status, 403, 'бан перестал закрывать комнату')

  // И файловая дверь, которая вешает свой banDoor на тот же префикс, тоже:
  // порядок роутеров не должен утаскивать /me за чужую дверь.
  const files = await fetch(`${base}/api/sessions/${ROOM}/files`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(files.status, 403)

  liftBan(ROOM, ban.id)
  const after = await ask(ROOM, token)
  assert.equal(after.body.ban, null, 'снятый бан остался в ответе')
})
