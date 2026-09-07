/**
 * Бан закрывает и HTTP, а не только дверь и сокет.
 *
 * `banFor` спрашивали в двух местах: `/join` и рукопожатие сокета. А токен
 * участника подписан и живёт до тридцати суток, отобрать его нечем — поэтому
 * закрытый доступ закрывал комнату и не закрывал ничего из того, за что человека
 * обычно и закрывают: раздатку, загрузку файлов (тот самый спам), ленту версий,
 * вопросы оракулу за ключ инстанса. Забаненный со старым Bearer-токеном
 * продолжал как ни в чём не бывало.
 *
 * Дверь одна на все маршруты комнаты (routes/sessions.ts · banDoor), и отвечает
 * она словами про бан, а не «войдите в семинар»: человек должен понять, что это
 * решение преподавателя.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { signToken } from '../server/src/auth.js'
import { banParticipant } from '../server/src/bans.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { app } from '../server/src/app.js'
import { sessionDir } from '../server/src/workspace.js'

const ROOM = 'ban-http'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Комната с баном', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'handout.csv'), 'a,b\n1,2\n')
  for (const id of ['p_rude', 'p_quiet']) {
    upsertParticipant({
      id,
      sessionId: ROOM,
      name: id === 'p_rude' ? 'Гриша' : 'Нина',
      avatar: null,
      role: 'participant',
    })
  }

  /*
   * Двери монтируются приложением (server/src/app.ts), а не тремя роутерами
   * рядом: дверь бана стоит в продукте за разбором json и проверкой
   * происхождения, и «остался открыт» должно значить открыт ТАМ, а не здесь.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

const tokenFor = (id: string) =>
  signToken({ sessionId: ROOM, participantId: id, role: 'participant' })

const bearer = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` })

async function upload(id: string, name = `drop-${id}.txt`): Promise<number> {
  const form = new FormData()
  form.append('file', new Blob(['spam\n']), name)
  const res = await fetch(`${base}/api/sessions/${ROOM}/files`, {
    method: 'POST',
    headers: bearer(id),
    body: form,
  })
  return res.status
}

test('до бана участник читает и пишет, как и положено', async () => {
  const files = await fetch(`${base}/api/sessions/${ROOM}/files`, { headers: bearer('p_rude') })
  assert.equal(files.status, 200)
  assert.equal(await upload('p_rude'), 200)
})

test('после бана те же двери отвечают отказом, и отказ называет причину', async () => {
  const ban = banParticipant({
    sessionId: ROOM,
    participantId: 'p_rude',
    ip: null,
    byTeacher: 'Преподаватель',
  })
  assert.ok(ban, 'бан не завёлся')

  for (const door of ['files', 'history']) {
    const res = await fetch(`${base}/api/sessions/${ROOM}/${door}`, { headers: bearer('p_rude') })
    assert.equal(res.status, 403, `${door} остался открыт`)
    const body = (await res.json()) as { error?: string; until?: number }
    // Слова про бан, а не «join the session first»: человек должен понять, что
    // это решение преподавателя, а не поломка комнаты.
    assert.match(body.error ?? '', /доступ/i, `${door}: отказ не про бан`)
    assert.equal(typeof body.until, 'number', `${door}: некогда ждать конца`)
  }

  // И главное — загрузка: именно за неё чаще всего и закрывают доступ.
  assert.equal(await upload('p_rude', 'after-ban.txt'), 403)
  assert.equal(
    fs.existsSync(path.join(sessionDir(ROOM), 'after-ban.txt')),
    false,
    'файл забаненного всё-таки лёг в комнату',
  )
})

test('соседа по комнате бан не касается', async () => {
  const res = await fetch(`${base}/api/sessions/${ROOM}/files`, { headers: bearer('p_quiet') })
  assert.equal(res.status, 200)
  assert.equal(await upload('p_quiet'), 200)
})

test('преподаватель проходит любой бан — в том числе свой собственный', async () => {
  /*
   * Промах — забанить себя со второй вкладки — не должен запирать
   * преподавателя снаружи его собственной комнаты посреди пары. Это правило
   * живёт в `banFor` (штат проходит по куке), и дверь обязана спрашивать
   * именно его, а не заводить своё.
   */
  const teacher = createTeacher({ name: 'Ада', email: 'ada.banhttp@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, teacher)
  const cookie = `${STAFF_COOKIE}=${value}`

  const res = await fetch(`${base}/api/sessions/${ROOM}/files`, {
    headers: { ...bearer('p_rude'), cookie },
  })
  assert.equal(res.status, 200, 'кука штата не открыла дверь')
})

test('вход в комнату забаненный по-прежнему получает своим отказом', async () => {
  /*
   * `/join` проверяет бан сам и своими словами — токен у него в теле запроса, а
   * не в заголовке, и общая дверь его намеренно пропускает. Иначе пришедший
   * увидел бы «семинар не найден» вместо объяснения.
   */
  const res = await fetch(`${base}/api/sessions/${ROOM}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Гриша', participantId: 'p_rude', token: tokenFor('p_rude') }),
  })
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error?: string }
  assert.match(body.error ?? '', /доступ/i)
})
