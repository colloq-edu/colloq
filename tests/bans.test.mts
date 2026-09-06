/**
 * Бан: кого комната перестаёт пускать и на чём это держится.
 *
 * Аккаунтов в продукте нет, поэтому бан опирается на две дырявые метки —
 * идентификатор участника и метку устройства в куке, — и первое, что здесь
 * проверяется, это ровно то, что обещано: обе ловят возврат в тот же браузер,
 * и ни одна не ловит чистый. Обещать герметичность нельзя, а тест, который
 * притворялся бы, что она есть, был бы хуже отсутствующего.
 *
 * Второе — цена промаха. Забанить себя со второй вкладки легко: список
 * участников состоит из имён, а не из лиц. Штат обязан проходить любой бан,
 * иначе одно нажатие запирает преподавателя снаружи его собственной комнаты
 * посреди пары.
 *
 * Ни сети, ни ядра: комната настоящая, вход настоящий, соседняя комната рядом —
 * чтобы бан, поставленный в одной, было видно, если он потечёт в другую.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher } from '../server/src/admin/store.js'
import {
  addressOf,
  banFor,
  banParticipant,
  banRefusal,
  deviceOf,
  DEVICE_COOKIE,
  discardBans,
  liftBan,
  listBans,
  markDevice,
  BAN_MS,
} from '../server/src/bans.js'
import { createSession, db, upsertParticipant } from '../server/src/db.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'
import type { JoinResponse } from '../shared/protocol.js'

const ROOM = 'bans-room'
const OTHER = 'bans-other'
/**
 * Метка — 32 символа алфавита base64url; настоящие такие же, только случайные.
 * Своя на тест: метка — это браузер, а забаненный браузер и должен оставаться
 * забаненным до конца прогона.
 */
const mark = (letter: string) => letter.repeat(32)
const PHONE = mark('p')
const LAPTOP = mark('l')

let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Семинар', null)
  createSession(OTHER, 'Соседняя', null)
  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

interface Attempt {
  name: string
  participantId?: string
  token?: string
  device?: string
  cookie?: string
  room?: string
}

async function join(attempt: Attempt): Promise<Answer> {
  const cookie =
    attempt.cookie ?? (attempt.device ? `${DEVICE_COOKIE}=${attempt.device}` : undefined)
  const res = await fetch(`${base}/api/sessions/${attempt.room ?? ROOM}/join`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      name: attempt.name,
      participantId: attempt.participantId ?? null,
      token: attempt.token ?? null,
    }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

interface Answer {
  status: number
  body: Record<string, unknown>
}

/** Вошёл и запомнил, чем доказывать, что он — это он. */
async function newcomer(name: string, device?: string): Promise<JoinResponse> {
  const res = await join({ name, device })
  assert.equal(res.status, 200, `${name} не вошёл`)
  return res.body as unknown as JoinResponse
}

const ban = (participantId: string, until?: number) =>
  banParticipant({ sessionId: ROOM, participantId, ip: null, byTeacher: 'Ада', until })

/* ------------------------------------------------------------ две метки */

test('бан по идентификатору не пускает того же человека обратно', async () => {
  const kostya = await newcomer('Костя')
  assert.ok(ban(kostya.participant.id))

  const back = await join({
    name: 'Костя',
    participantId: kostya.participant.id,
    token: kostya.token,
  })
  assert.equal(back.status, 403)
  // Человек обязан понять, что это решение преподавателя, а не поломка
  // комнаты, — поэтому в отказе стоит его имя.
  assert.match(String(back.body.error), /Костя/)
  assert.match(String(back.body.error), /преподаватель/i)
  // Время — числом: часы рисует браузер, сервер в контейнере живёт по UTC.
  assert.equal(typeof back.body.until, 'number')
  assert.ok(Number(back.body.until) > Date.now())
})

test('бан ловит и по метке устройства — вернувшегося «новым человеком»', async () => {
  const nina = await newcomer('Нина', mark('n'))
  assert.ok(ban(nina.participant.id))

  // Чистый localStorage: ни идентификатора, ни токена. Кука на месте — это тот
  // же браузер, и это единственный случай, который бан обязан ловить.
  const again = await join({ name: 'Не Нина', device: mark('n') })
  assert.equal(again.status, 403)
  assert.match(String(again.body.error), /Нина/)
})

test('чистый браузер проходит — и это сказано вслух, а не забыто', async () => {
  const oleg = await newcomer('Олег', mark('o'))
  assert.ok(ban(oleg.participant.id))

  // Инкогнито: другая кука, другой идентификатор. Такой возврат бан не ловит и
  // не обещал ловить; преподаватель видит его в списке участников.
  const incognito = await join({ name: 'Олег', device: mark('i') })
  assert.equal(incognito.status, 200)
})

test('снятие возвращает вход', async () => {
  const petya = await newcomer('Петя')
  const row = ban(petya.participant.id)
  assert.ok(row)

  assert.equal(liftBan(ROOM, row.id), true)
  assert.equal(liftBan(ROOM, row.id), false, 'снимать нечего дважды')
  const back = await join({
    name: 'Петя',
    participantId: petya.participant.id,
    token: petya.token,
  })
  assert.equal(back.status, 200)
})

test('просроченный бан не действует и убирается первым же чтением', async () => {
  const sveta = await newcomer('Света')
  const stale = ban(sveta.participant.id, Date.now() - 1000)
  assert.ok(stale)
  assert.equal(rowsFor(ROOM, stale.id), 1, 'строка легла в базу')

  const back = await join({
    name: 'Света',
    participantId: sveta.participant.id,
    token: sveta.token,
  })
  assert.equal(back.status, 200, 'срок вышел — бан не держит ни секунды сверх')
  // Таймера нет: строку убирает тот, кто следующим пришёл читать баны комнаты.
  assert.equal(rowsFor(ROOM, stale.id), 0)
})

function rowsFor(sessionId: string, banId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM bans WHERE session_id = ? AND id = ?')
    .get(sessionId, banId) as { n: number }
  return row.n
}

/* --------------------------------------------------------- цена промаха */

test('штат проходит любой бан — промах не запирает вас снаружи', async () => {
  const ada = await newcomer('Ада', mark('a'))
  assert.ok(ban(ada.participant.id))

  const teacher = createTeacher({ email: 'ada@test.local', name: 'Ада', role: 'owner' })
  assert.ok(teacher)
  const staff = mintStaffCookie(teacher)

  const back = await join({
    name: 'Ада',
    participantId: ada.participant.id,
    token: ada.token,
    cookie: `${staff}; ${DEVICE_COOKIE}=${mark('a')}`,
  })
  assert.equal(back.status, 200)
  assert.equal(
    back.body.participant && (back.body.participant as { id: string }).id,
    ada.participant.id,
  )
})

test('преподавателя комнаты забанить нельзя вовсе', () => {
  upsertParticipant({
    id: 'p_host',
    sessionId: ROOM,
    name: 'Ведущий',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.equal(ban('p_host'), null)
  // И того, кого в комнате нет, — тоже: банить некого.
  assert.equal(ban('p_nobody'), null)
})

/* ------------------------------------------------------- границы комнаты */

test('бан в одной комнате не закрывает соседнюю', async () => {
  const grisha = await newcomer('Гриша', mark('g'))
  assert.ok(ban(grisha.participant.id))

  const next = await join({ name: 'Гриша', device: mark('g'), room: OTHER })
  assert.equal(next.status, 200, 'соседний семинар — не тот, из которого закрыли')
  assert.equal(banFor(OTHER, grisha.participant.id, `${DEVICE_COOKIE}=${mark('g')}`), null)
})

/* ------------------------------------------------ что видит преподаватель */

test('в списке стоит имя, кто закрыл и своё ли это устройство', async () => {
  const room = 'bans-list'
  createSession(room, 'Список', null)
  upsertParticipant({
    id: 'p_shura',
    sessionId: room,
    name: 'Шура',
    avatar: null,
    role: 'participant',
    device: PHONE,
  })
  const row = banParticipant({
    sessionId: room,
    participantId: 'p_shura',
    ip: '10.1.2.3',
    byTeacher: 'Ада',
  })
  assert.ok(row)
  assert.equal(row.name, 'Шура')
  assert.equal(row.byTeacher, 'Ада')
  assert.ok(row.until - row.createdAt === BAN_MS)

  // «Своё устройство» — только про совпавшую метку.
  const asPhone = listBans(room, PHONE)
  assert.equal(asPhone.length, 1)
  assert.equal(asPhone[0].mine, true)
  assert.equal(listBans(room, LAPTOP)[0].mine, false)
  assert.equal(listBans(room, null)[0].mine, false, 'два браузера без метки — не одно устройство')

  // Метка и адрес легли в строку, но наружу в списке их нет.
  const stored = db.prepare('SELECT device, ip FROM bans WHERE id = ?').get(row.id) as {
    device: string | null
    ip: string | null
  }
  assert.equal(stored.device, PHONE)
  assert.equal(stored.ip, '10.1.2.3')
  assert.equal('device' in asPhone[0], false)
  assert.equal('ip' in asPhone[0], false)

  discardBans(room)
  assert.deepEqual(listBans(room, PHONE), [], 'семинар удалили — адрес ушёл с ним')
})

test('отказ называет человека и момент конца, а часы оставляет браузеру', () => {
  const until = Date.now() + BAN_MS
  const said = banRefusal({ id: 'b_x', name: 'Костя', until })
  assert.equal(said.until, until)
  assert.match(said.error, /^Костя, /)
  // Ни «15:40», ни ISO: сервер в контейнере живёт по UTC, и собранное им время
  // указывало бы в аудитории не на тот час.
  assert.equal(/\d{1,2}:\d{2}/.test(said.error), false)
})

/* ------------------------------------------------------- метка устройства */

function mintStaffCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

interface Written {
  name: string
  value: string
  options: { httpOnly?: boolean; sameSite?: string; maxAge?: number; secure?: boolean }
}

function pageRequest(opts: { cookie?: string; forwardedProto?: string; secure?: boolean }): {
  req: Request
  written: Written[]
} {
  const written: Written[] = []
  const req = {
    headers: { cookie: opts.cookie },
    secure: opts.secure ?? false,
    get: (name: string) =>
      name.toLowerCase() === 'x-forwarded-proto' ? opts.forwardedProto : undefined,
  } as unknown as Request
  const res = {
    cookie: (name: string, value: string, options: Written['options']) =>
      written.push({ name, value, options }),
  } as unknown as Response
  markDevice(req, res)
  return { req, written }
}

test('метка ставится один раз и переживает возврат', () => {
  const first = pageRequest({})
  assert.equal(first.written.length, 1)
  const [mark] = first.written
  assert.equal(mark.name, DEVICE_COOKIE)
  assert.match(mark.value, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(mark.options.httpOnly, true)
  assert.equal(mark.options.sameSite, 'lax')
  assert.ok((mark.options.maxAge ?? 0) >= 365 * 24 * 60 * 60 * 1000)

  // Пришли снова с этой же кукой — второй метки не заводится.
  const again = pageRequest({ cookie: `${DEVICE_COOKIE}=${mark.value}` })
  assert.deepEqual(again.written, [])
})

test('Secure — по схеме этого запроса, иначе кука не сохранится вовсе', () => {
  assert.equal(pageRequest({}).written[0].options.secure, false)
  assert.equal(pageRequest({ secure: true }).written[0].options.secure, true)
  // За ретранслятором сервер видит http всегда; про https говорит caddy.
  assert.equal(pageRequest({ forwardedProto: 'https' }).written[0].options.secure, true)
})

test('кривая или чужая кука — это отсутствие метки, а не метка', () => {
  assert.equal(deviceOf(undefined), null)
  assert.equal(deviceOf('colloq_staff=abc'), null)
  assert.equal(deviceOf(`${DEVICE_COOKIE}=слишком-коротко`), null)
  assert.equal(deviceOf(`${DEVICE_COOKIE}=${'x'.repeat(4096)}`), null)
  assert.equal(deviceOf(`${DEVICE_COOKIE}=%`), null, 'кривая печенька не роняет разбор')
  assert.equal(deviceOf(`${DEVICE_COOKIE}=${PHONE}; other=1`), PHONE)
})

/* ---------------------------------------------------------------- адрес */

test('заголовку с адресом верим только от прокси на этой же машине', () => {
  const headers = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }
  // За ретранслятором сосед по сокету — петля, и настоящий адрес только в
  // заголовке.
  assert.equal(addressOf({ headers, socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.7')
  assert.equal(addressOf({ headers, socket: { remoteAddress: '::1' } }), '203.0.113.7')
  // А присланный кем угодно напрямую — выдумка: подсказка «кажется, вернулся»
  // указала бы на человека, который сидел тихо.
  assert.equal(addressOf({ headers, socket: { remoteAddress: '198.51.100.4' } }), '198.51.100.4')
  assert.equal(addressOf({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
  assert.equal(addressOf({ headers: {} }), null)
})
