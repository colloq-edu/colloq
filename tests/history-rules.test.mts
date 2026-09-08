/**
 * Кому лента версий, а кому только смотреть на тетрадь.
 *
 * У ленты три двери и два права. Читать её по умолчанию может вся комната —
 * тетрадь общая, и кто что менял, не секрет от тех, при ком это менялось; но
 * семинар, где тетрадь показывают, а не пишут вместе, вправе её закрыть
 * (`history: 'host'`): там лента — черновики преподавателя, которые он не
 * показывал. Возврат версии и чекпоинт преподавательские всегда: первый
 * переписывает то, на что смотрит вся комната, второй ставит метку в общей
 * ленте.
 *
 * Проверялся из этого ровно один случай — 404 удалённого семинара, — так что
 * снятая проверка `allows()` не роняла ничего: правило было, а теста на него не
 * было.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { signToken } from '../server/src/auth.js'
import { createSession, setRules, storedRules, upsertParticipant } from '../server/src/db.js'
import { readRules } from '../shared/rules.js'
import { app } from '../server/src/app.js'
import { peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

const ROOM = 'history-rules'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Лекция с лентой', null)
  upsertParticipant({
    id: 'p_student',
    sessionId: ROOM,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })
  upsertParticipant({
    id: 'p_teacher',
    sessionId: ROOM,
    name: 'Преподаватель',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })

  /*
   * Приложение целиком (server/src/app.ts), а не свой express рядом: копия
   * порядка middleware расхождений с продуктом не ловит, она их повторяет.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/*
 * Роль в токене всегда 'participant': её пересчитывает `sessionAuth` на каждом
 * запросе — по куке штата и по столбцу token_host, а не по тому, что в токене
 * написано. Ведущий здесь — тот, у кого token_host стоит в строке.
 */
const bearer = (id: string) => ({
  authorization: `Bearer ${signToken({ sessionId: ROOM, participantId: id, role: 'participant' })}`,
})

const ask = (path: string, id: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api/sessions/${ROOM}${path}`, {
    method,
    headers: body ? { ...bearer(id), 'content-type': 'application/json' } : bearer(id),
    body: body ? JSON.stringify(body) : undefined,
  })

test('по умолчанию ленту читает вся комната', async () => {
  const res = await ask('/history', 'p_student')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { versions: unknown[] }
  assert.ok(Array.isArray(body.versions))
})

test("history: 'host' закрывает ленту от участника и оставляет её преподавателю", async () => {
  setRules(ROOM, readRules({ ...storedRules(ROOM), history: 'host' }))

  const student = await ask('/history', 'p_student')
  assert.equal(student.status, 403, 'черновики преподавателя показали залу')
  const refusal = (await student.json()) as { error?: string }
  // Отказ словами: «Лента версий в этом семинаре — преподавательская».
  assert.match(refusal.error ?? '', /может только преподаватель/i)

  const teacher = await ask('/history', 'p_teacher')
  assert.equal(teacher.status, 200, 'правило закрыло ленту и от самого преподавателя')
})

test('возврат версии и чекпоинт участнику закрыты и при открытой ленте', async () => {
  setRules(ROOM, readRules({ ...storedRules(ROOM), history: 'everyone' }))
  // Лента читается — а писать в неё всё равно нельзя.
  assert.equal((await ask('/history', 'p_student')).status, 200)

  const restored = await ask('/history/1/restore', 'p_student', 'POST', {})
  assert.equal(restored.status, 403, 'участник вернул версию всей комнате')

  const marked = await ask('/history/checkpoint', 'p_student', 'POST', { label: 'до упражнения' })
  assert.equal(marked.status, 403, 'участник поставил метку в общей ленте')
})

test('чтение ленты не селит тетрадь в памяти и не дописывает строк', async () => {
  /*
   * Лента поднимает документ комнаты — без него у семинара, который никто не
   * открывал с перезапуска, нет базовой строки, и панель показала бы пустой
   * список для комнаты, полной работы. Но поднятый документ выселялся только
   * удалением семинара: открыть ленту у двадцати архивных семинаров значило
   * поселить в памяти двадцать чужих тетрадей с картинками до перезапуска.
   */
  const first = await ask('/history', 'p_teacher')
  const before = ((await first.json()) as { versions: unknown[] }).versions.length
  assert.equal(peekSessionDoc(ROOM), null, 'тетрадь осталась в памяти после чтения ленты')

  await ask('/history', 'p_teacher')
  const again = await ask('/history', 'p_teacher')
  const after = ((await again.json()) as { versions: unknown[] }).versions.length
  // И каждое чтение не дописывает «открыли семинар» заново.
  assert.equal(after, before)
})

test('преподаватель ставит чекпоинт, и он появляется в ленте', async () => {
  const marked = await ask('/history/checkpoint', 'p_teacher', 'POST', { label: 'до упражнения' })
  assert.equal(marked.status, 201)
  const { seq } = (await marked.json()) as { seq: number }

  const list = await ask('/history', 'p_teacher')
  const { versions } = (await list.json()) as {
    versions: { seq: number; label: string | null; authorName: string | null }[]
  }
  const marked2 = versions.find((v) => v.seq === seq)
  assert.ok(marked2, 'названный момент не виден в ленте')
  assert.equal(marked2.label, 'до упражнения')
  /*
   * Имя автора берётся из одной карты участников на запрос, а не запросом на
   * строку: четыреста строк ленты — это четыреста синхронных SELECT, а лента
   * открывается у всей комнаты разом.
   */
  assert.equal(marked2.authorName, 'Преподаватель')
})
