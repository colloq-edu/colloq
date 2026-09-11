/**
 * Who you are when you come back, and who says so.
 *
 * Joining twice from the same browser has to land on the same person — a
 * refresh that turns one student into two ruins the participants list and the
 * carets with it. Joining as somebody ELSE has to be impossible, and that is
 * less obvious than it sounds: awareness broadcasts every participant id to the
 * whole room so a caret can be attributed to a face, which makes "I am p_xyz" a
 * sentence any student in the seminar can say about anybody in it.
 *
 * The role is the other half. It never comes from what the client stored — a
 * badge you can hand yourself is not a badge — and it has to be re-decided on
 * every join, because the same person can be a student at ten past and staff at
 * quarter past.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { signHostToken, verifyHostToken } from '../server/src/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createHmac } from 'node:crypto'
import { signToken, verifyToken, TOKEN_MAX_AGE_MS } from '../server/src/auth.js'
import { createSession, db, getParticipant, isTokenHost } from '../server/src/db.js'
import { roleFor, sessionAuth } from '../server/src/routes/sessions.js'
import { app } from '../server/src/app.js'
import type { JoinRequest, JoinResponse } from '../shared/protocol.js'
import { ApiError } from '../web/src/lib/api.js'
import { CROWD_WAIT_MS, retryJoinIn } from '../web/src/lib/crowd.js'

const ROOM = 'identity-test'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Identity', null)
  /*
   * Приложение целиком (server/src/app.ts), а не два роутера рядом: вход и
   * история стоят в продукте за разбором json, проверкой происхождения и
   * продлением печенья штата, и проверять их надо за тем же. Своя сборка
   * express повторяла бы порядок index.ts, а не сверялась с ним.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

/** issueStaffCookie writes onto express's Response; this is the smallest thing that shape. */
function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

/** The smallest thing sessionAuth reads: a bearer header, a cookie, and :id. */
function request(token: string, cookie?: string): Request {
  return {
    headers: { authorization: token ? `Bearer ${token}` : '', cookie },
    query: {},
    params: { id: ROOM },
  } as unknown as Request
}

async function join(body: JoinRequest, cookie?: string): Promise<JoinResponse> {
  const res = await fetch(`${base}/api/sessions/${ROOM}/join`, {
    method: 'POST',
    headers: cookie ? { 'content-type': 'application/json', cookie } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(res.status, 200)
  return (await res.json()) as JoinResponse
}

test('a refresh keeps the same person', async () => {
  const first = await join({ name: 'Maria' })
  const again = await join({
    name: 'Maria',
    participantId: first.participant.id,
    token: first.token,
  })
  assert.equal(again.participant.id, first.participant.id)
})

test('claiming an id without its token makes somebody new', async () => {
  /*
   * The id alone is not a secret — it is on every caret in the room. Presented
   * without the token that was minted with it, it buys nothing: the visitor is
   * a person the room has not met.
   */
  const maria = await join({ name: 'Maria' })
  const stranger = await join({ name: 'Not Maria', participantId: maria.participant.id })

  assert.notEqual(stranger.participant.id, maria.participant.id)
  const stored = getParticipant(ROOM, maria.participant.id)
  assert.equal(stored?.name, 'Maria', 'the row was overwritten by somebody else')
})

test('a token for another room does not open this one', async () => {
  const maria = await join({ name: 'Maria' })
  const elsewhere = signToken({
    sessionId: 'another-room',
    participantId: maria.participant.id,
    role: 'host',
  })
  const stranger = await join({
    name: 'Not Maria',
    participantId: maria.participant.id,
    token: elsewhere,
  })
  assert.notEqual(stranger.participant.id, maria.participant.id)
})

test('a token for another participant does not open this identity', async () => {
  const maria = await join({ name: 'Maria' })
  const john = await join({ name: 'John' })
  const stranger = await join({
    name: 'Not Maria',
    participantId: maria.participant.id,
    token: john.token,
  })
  assert.notEqual(stranger.participant.id, maria.participant.id)
})

test('the stored role is not a credential', async () => {
  /*
   * A browser holding a host token from an earlier life cannot spend it as a
   * claim: role is decided from the staff cookie and the host token, and a
   * participant token that merely SAYS host proves only which participant it is.
   */
  const maria = await join({ name: 'Maria' })
  const forged = signToken({
    sessionId: ROOM,
    participantId: maria.participant.id,
    role: 'host',
  })
  const back = await join({ name: 'Maria', participantId: maria.participant.id, token: forged })
  assert.equal(back.participant.id, maria.participant.id, 'it is still her')
  assert.equal(back.participant.role, 'participant', 'and she is still a student')
})

test('a wrong host token is refused rather than believed', async () => {
  const nobody = await join({ name: 'Maria', hostToken: 'not-a-token' })
  assert.equal(nobody.participant.role, 'participant')
})

/* ------------------------------------------- the same rule on both channels */

test('a teacher who joined as a student is a host to HTTP too', async () => {
  /*
   * The gap this closes. The WebSocket upgrade has always let a staff cookie
   * outrank the role a token was minted with — a teacher who opened the link
   * before signing in holds a participant token for a room that is theirs — but
   * sessionAuth read the token alone. So the same person in the same browser
   * could interrupt the kernel over the socket and be refused a checkpoint over
   * HTTP in the same second.
   */
  const teacher = createTeacher({ name: 'Ada', email: 'ada.identity@hse.ru', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)

  const student = await join({ name: 'Ada' })
  assert.equal(student.participant.role, 'participant', 'joined before signing in')

  const asStudent = sessionAuth(request(student.token))
  assert.equal(asStudent?.role, 'participant')

  const asStaff = sessionAuth(request(student.token, mintCookie(teacher)))
  assert.equal(asStaff?.role, 'host', 'the cookie did not outrank the token')
  assert.equal(asStaff?.participantId, student.participant.id, 'and it is still them')
})

test('a staff cookie does not open a token minted for another room', () => {
  // The cookie raises a role; it never replaces the check that the credential
  // belongs to the seminar in the path.
  const teacher = createTeacher({ name: 'Grace', email: 'grace.identity@hse.ru', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const elsewhere = signToken({ sessionId: 'another-room', participantId: 'p_x', role: 'host' })
  assert.equal(sessionAuth(request(elsewhere, mintCookie(teacher))), null)
})

test('no credential at all is nobody, cookie or not', () => {
  const teacher = createTeacher({ name: 'Katherine', email: 'kj.identity@hse.ru', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  assert.equal(sessionAuth(request('', mintCookie(teacher))), null)
})

/* ------------------------------------------------ роль нельзя запечь навсегда */

test('токен с role:host не даёт host без cookie', async () => {
  /*
   * Роль решается на каждом запросе и никогда не читается из токена. Иначе
   * host был бы вечным: преподаватель, удалённый из списка, сохранял бы
   * Restart и Restore во всех комнатах, куда когда-либо заходил, — токен всё
   * ещё говорил бы, что он хозяин.
   */
  const student = await join({ name: 'Ada' })
  const forged = signToken({ sessionId: ROOM, participantId: student.participant.id, role: 'host' })
  assert.equal(sessionAuth(request(forged))?.role, 'participant', 'запечённый host пережил проверку')
})

test('токен старше предельного возраста не принимается', () => {
  const stale = signToken({
    sessionId: ROOM,
    participantId: 'p_old',
    role: 'participant',
    iat: Date.now() - TOKEN_MAX_AGE_MS - 1000,
  })
  assert.equal(verifyToken(stale), null, 'вечный токен — это выданная навсегда возможность')
})

test('токен без отметки времени читается: комната посреди пары не должна разлогиниться', () => {
  const body = Buffer.from(
    JSON.stringify({ sessionId: ROOM, participantId: 'p_ageless', role: 'participant' }),
  ).toString('base64url')
  const sig = createHmac('sha256', process.env.SESSION_SECRET as string).update(body).digest('base64url')
  assert.equal(verifyToken(`${body}.${sig}`)?.participantId, 'p_ageless')
})

/* --------------------------------------------------- что комната принимает */

test('аватар — знак, а не чужой адрес', async () => {
  /*
   * Строка, начинающаяся с http или data:, рисуется в комнате как <img src>:
   * один запрос — и браузер КАЖДОГО участника, включая опоздавших, идёт на
   * чужой сервер, потому что аватар стоит и в ростере, и в подписи ячеек.
   */
  for (const bad of [
    'https://attacker.example/pixel.gif',
    'http://attacker.example/p.gif',
    'data:image/gif;base64,R0lGOD',
    'javascript:alert(1)',
  ]) {
    const joined = await join({ name: 'Pixel', avatar: bad })
    assert.equal(joined.participant.avatar, null, bad)
  }
  // Эмодзи — то, ради чего поле есть, и оно доезжает целиком.
  const flag = await join({ name: 'Ada', avatar: '\u{1F469}\u200D\u{1F4BB}' })
  assert.equal(flag.participant.avatar, '\u{1F469}\u200D\u{1F4BB}')
})

test('поток новых участников ограничен: цикл не раздувает комнату', async () => {
  /*
   * Вход не требует ничего, кроме ссылки, и без доказанной пары
   * participantId+token заводит строку. Скрипт в цикле писал десятки тысяч
   * «людей», которых никто не видел, — и список приезжал каждому настоящему
   * участнику целиком.
   */
  const room = 'identity-flood'
  createSession(room, 'Поток', null)
  const knock = (body: JoinRequest, cookie?: string) =>
    fetch(`${base}/api/sessions/${room}/join`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })

  let refusedAt = 0
  let mine: JoinResponse | null = null
  // Потолок цикла обязан быть выше `MAX_NEW_PARTICIPANTS` (routes/sessions.ts):
  // предел подняли до шестисот, и цикл на двухстах перестал доходить до отказа
  // — то есть проверял, что поток НЕ ограничен, и был при этом зелёным.
  for (let i = 1; i <= 800 && refusedAt === 0; i += 1) {
    const res = await knock({ name: `Гость ${i}` })
    if (res.status === 429) refusedAt = i
    else if (i === 1) mine = (await res.json()) as JoinResponse
  }
  assert.ok(refusedAt > 0, 'цикл не встретил ни одного отказа')

  // Уже вошедший возвращается по своему токену — его отказ не касается.
  assert.ok(mine)
  const back = await knock({
    name: 'Гость 1',
    participantId: mine.participant.id,
    token: mine.token,
  })
  assert.equal(back.status, 200, 'вернувшегося не пустили в собственную комнату')

  // И преподавателя тоже: комнату под потоком ведёт кто-то живой.
  const teacher = createTeacher({ name: 'Vera', email: 'vera.flood@hse.ru', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const staff = await knock({ name: 'Vera' }, mintCookie(teacher))
  assert.equal(staff.status, 200, 'штат не смог войти в собственную комнату')
})

test('на переполненный вход вкладка стучится ещё раз — и ровно один раз', () => {
  /*
   * Отказ выше — не про этого человека: он пришёл вовремя, просто вместе со
   * всей группой. Нажать за него второй раз должна вкладка (lib/crowd.ts), но
   * ровно один: повтор без конца превращает переполненную комнату в ту, куда
   * «не пускает совсем», и делает это молча.
   */
  const crowded = new ApiError('too many people are joining this seminar at once', 429)
  assert.equal(retryJoinIn(crowded, 1), CROWD_WAIT_MS, 'первый отказ не дождался повтора')
  assert.equal(retryJoinIn(crowded, 2), null, 'повтор пошёл по кругу')

  // Всё остальное — отказ человеку, и ждать тут нечего: занятое имя, комнаты
  // нет, связи нет. Повтор молча съел бы объяснение.
  assert.equal(retryJoinIn(new ApiError('session not found', 404), 1), null)
  assert.equal(retryJoinIn(new ApiError('Could not reach the server', 0), 1), null)
  assert.equal(retryJoinIn(new TypeError('Failed to fetch'), 1), null)
})

test('временный 404 от прокси повторяет вход один раз, не выдавая его за удалённую комнату', () => {
  const proxyError = new ApiError('Не найдено (404)', 404)
  const wait = retryJoinIn(proxyError, 1)
  assert.ok(wait !== null && wait > 0 && wait <= 1000)
  assert.equal(retryJoinIn(proxyError, 2), null)
  assert.equal(retryJoinIn(new ApiError('session not found', 404), 1), null)
  for (const status of [401, 403, 500, 502, 503, 504]) {
    assert.equal(retryJoinIn(new ApiError('refused', status), 1), null)
  }
})

/* ------------------------------------------------ удалённый семинар уносит своё */

test('история удалённого семинара не читается и не воскрешает комнату', async () => {
  /*
   * Маршруты истории были единственной дверью, через которую удалённый
   * семинар оставался открыт: getSessionDoc строит документ для любого id,
   * который ему дали, — старый токен доставал ноутбук комнаты, о которой
   * панель уже отчиталась, что её нет, и заодно клал её обратно в память.
   */
  const gone = 'identity-gone'
  createSession(gone, 'Удалённый', null)
  const me = signToken({ sessionId: gone, participantId: 'p_x', role: 'participant' })
  db.prepare('DELETE FROM sessions WHERE id = ?').run(gone)

  const res = await fetch(`${base}/api/sessions/${gone}/history`, {
    headers: { authorization: `Bearer ${me}` },
  })
  assert.equal(res.status, 404)
})

test('ключ ведущего стареет и не переписывается', () => {
  const room = 'host-token-age'

  const fresh = signHostToken(room)
  assert.equal(verifyHostToken(room, fresh), true)

  // Чужой комнате он не подходит, даже свежий.
  assert.equal(verifyHostToken('other-room', fresh), false)

  // Срок стоит в самом ключе и покрыт подписью: продлить его нельзя, не зная
  // секрета. Именно это и пробуют — переписать отметку на завтрашнюю.
  const [id, , sig] = fresh.split('.')
  const forged = `${id}.${(Date.now() + 86_400_000).toString(36)}.${sig}`
  assert.equal(verifyHostToken(room, forged), false, 'подделанный срок приняли')

  // Ключ, выписанный больше тридцати дней назад, больше не ключ.
  const old = `${id}.${(Date.now() - 31 * 24 * 60 * 60 * 1000).toString(36)}.${sig}`
  assert.equal(verifyHostToken(room, old), false)

  // И старая двухчастная форма — та, что не старела никогда.
  assert.equal(verifyHostToken(room, `${id}.${sig}`), false, 'бессрочный ключ всё ещё принимается')
})

test('ведущий по токену переживает перезапуск сервера', async () => {
  /*
   * Список «кто провёл хост-токен» жил в памяти процесса. После `make stop`
   * автор семинара, заведённого скриптом, приходил в свою комнату гостем:
   * кнопки Restart и Interrupt мертвы, объяснения нет, а другого ключа от этой
   * комнаты не существует — куки у него нет по построению.
   *
   * Перезапуск здесь изображается честно: спрашиваем не то, что помнит модуль,
   * а то, что лежит в базе.
   */
  const hostToken = signHostToken(ROOM)
  const author = await join({ name: 'Scripted', hostToken })
  assert.equal(author.participant.role, 'host', 'токен не дал ведущего')

  assert.equal(
    isTokenHost(ROOM, author.participant.id),
    true,
    'после перезапуска процесса вспомнить это будет неоткуда',
  )
  // И у обычного студента такой записи нет — иначе она ничего не значит.
  const student = await join({ name: 'Nina' })
  assert.equal(isTokenHost(ROOM, student.participant.id), false)
})

test('вход по HTTP и вход по сокету отвечают одинаково', async () => {
  /*
   * Функций было две, и они расходились: HTTP смотрел в множество выданных
   * токенов, сокет про него не знал вовсе. Автор скриптового семинара получал
   * `host` на кнопках и `participant` на соединении, которым эти кнопки
   * работают, — то есть кнопки, которые ничего не делают.
   */
  const author = await join({ name: 'Scripted Two', hostToken: signHostToken(ROOM) })
  const student = await join({ name: 'Olga' })
  const teacher = createTeacher({ name: 'Emmy', email: 'emmy.identity@hse.ru', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const cookie = mintCookie(teacher)

  const cases = [
    { who: 'автор по токену', id: author.participant.id, cookie: undefined, expect: 'host' },
    { who: 'студент', id: student.participant.id, cookie: undefined, expect: 'participant' },
    { who: 'студент с кукой', id: student.participant.id, cookie, expect: 'host' },
  ] as const

  for (const { who, id, cookie, expect } of cases) {
    const token = signToken({ sessionId: ROOM, participantId: id, role: 'participant' })
    const overHttp = sessionAuth(request(token, cookie))?.role
    const overSocket = roleFor(cookie, { sessionId: ROOM, participantId: id })
    assert.equal(overHttp, overSocket, `входы разошлись: ${who}`)
    // И это не «оба всегда participant» — иначе сходство ничего не стоит.
    assert.equal(overSocket, expect, `${who}: не та роль`)
  }
})

test('кука даёт ведущего только пока она есть', async () => {
  // Куку можно отобрать — в этом её смысл, и поэтому «ведущий по куке» никогда
  // не записывается в строку участника.
  const teacher = createTeacher({ name: 'Sofia', email: 'sofia.identity@hse.ru', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const joined = await join({ name: 'Sofia' }, mintCookie(teacher))
  assert.equal(joined.participant.role, 'host', 'кука не дала ведущего при входе')
  assert.equal(
    isTokenHost(ROOM, joined.participant.id),
    false,
    'вход по куке записался навсегда — отобрать права уже нечем',
  )
  assert.equal(roleFor(undefined, { sessionId: ROOM, participantId: joined.participant.id }), 'participant')
})
