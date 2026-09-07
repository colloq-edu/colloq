/**
 * Занятый адрес: кем занят и как его отпустить.
 *
 * «Адрес «ml-2025» уже занят» — тупик, и чаще всего неправдоподобный: курса с
 * таким адресом в списке нет. Держит его ПРЕЖНЕЕ имя другого курса — тот
 * переименовали в «ml-2025-fall», а старое имя осталось адресом ради ссылки,
 * розданной классу, — и увидеть это в панели негде. Преподаватель, готовящий
 * курс следующего года, ищет то, чего не видно, и заканчивает адресом с цифрой
 * на конце.
 *
 * Отказ теперь называет держателя, а прежнее имя владелец может отпустить сам.
 * Цена названа вслух и остаётся ценой: отпущенный адрес перестаёт вести
 * куда-либо, и это решение владельца.
 *
 * Держатель проверяется тем же путём, которым доходит до экрана: тело 409 →
 * `addressHolderOf` → кнопка «Отпустить прежний адрес». Панель читает поле, а
 * не фразу, так что фраза и поле проверяются порознь.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createCourse, findCourse, formerSlugs } from '../server/src/publish/store.js'
import { AdminApiError, addressHolderOf } from '../web/src/lib/adminApi.js'

let base = ''
let server: http.Server
let cookie = ''

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  const teacher = createTeacher({ name: 'Ада', email: 'ada.addr@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  cookie = cookieFor(teacher)

  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

interface Refusal {
  status: number
  error: string
  body: unknown
}

async function setSlug(id: string, slug: string): Promise<Refusal> {
  const res = await fetch(`${base}/api/admin/slug/course/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ slug }),
  })
  const body = (await res.json()) as { error?: string }
  return { status: res.status, error: body.error ?? '', body }
}

/** Тот же путь, что и в панели: тело отказа → держатель → кнопка или тишина. */
const seenByPanel = (taken: Refusal) =>
  addressHolderOf(new AdminApiError(taken.error, taken.status, 'invalid', taken.body))

async function release(id: string, slug: string): Promise<number> {
  const res = await fetch(`${base}/api/admin/slug/course/${id}/former/${slug}`, {
    method: 'DELETE',
    headers: { cookie },
  })
  return res.status
}

test('живой адрес занят — отказ называет курс по имени', async () => {
  const mine = createCourse('Матстат', null, 'Ада')
  const other = createCourse('Матстат для физиков', null, 'Ада')
  assert.equal((await setSlug(mine.id, 'matstat')).status, 200)

  const taken = await setSlug(other.id, 'matstat')
  assert.equal(taken.status, 409)
  assert.equal(taken.error, 'Адрес «matstat» занят курсом «Матстат».')
  // Живой адрес чужого курса отсюда не отпускают: кнопки быть не должно, а
  // держатель всё равно назван — чтобы было к кому пойти.
  assert.deepEqual(seenByPanel(taken), {
    kind: 'course',
    id: mine.id,
    name: 'Матстат',
    former: false,
  })
})

test('прежнее имя держит адрес — и отказ говорит, что с этим делать', async () => {
  const course = createCourse('ML 2025', null, 'Ада')
  const next = createCourse('ML 2026', null, 'Ада')
  assert.equal((await setSlug(course.id, 'ml-2025')).status, 200)
  // Переименование не отменяет розданную ссылку: старое имя остаётся адресом.
  assert.equal((await setSlug(course.id, 'ml-2025-fall')).status, 200)
  assert.deepEqual(formerSlugs('course', course.id), ['ml-2025'])

  const taken = await setSlug(next.id, 'ml-2025')
  assert.equal(taken.status, 409)
  assert.equal(
    taken.error,
    'Адрес «ml-2025» — прежнее имя курса «ML 2025».',
    'отказ снова не называет держателя — искать его негде',
  )
  // Отпускают у того же поля адреса, и совет уйти в чужие настройки был бы
  // неправдой в двух сантиметрах от кнопки, которая делает это здесь.
  assert.doesNotMatch(taken.error, /настройк/)

  // Кнопку «Отпустить прежний адрес» панель показывает по полю, а не по фразе,
  // и зовёт маршрут с идентификатором ДЕРЖАТЕЛЯ, а не просителя.
  assert.deepEqual(seenByPanel(taken), {
    kind: 'course',
    id: course.id,
    name: 'ML 2025',
    former: true,
  })
})

test('панель видит прежние имена курса — иначе отпускать нечего', async () => {
  const course = createCourse('Алгоритмы', null, 'Ада')
  assert.equal((await setSlug(course.id, 'algo-2025')).status, 200)
  assert.equal((await setSlug(course.id, 'algo-2026')).status, 200)

  const res = await fetch(`${base}/api/admin/courses/${course.id}`, { headers: { cookie } })
  const body = (await res.json()) as { course: { slug: string | null; former?: string[] } }
  assert.equal(body.course.slug, 'algo-2026')
  // Прежние имена курс показывает у себя: без этого списка владелец не увидит,
  // что «algo-2025» всё ещё занято им же, и отпускать ему будет нечего.
  assert.deepEqual(body.course.former, ['algo-2025'])
})

test('прежнее имя отпускает владелец, и только своё', async () => {
  const course = createCourse('Линал', null, 'Ада')
  const stranger = createCourse('Линал у соседей', null, 'Ада')
  assert.equal((await setSlug(course.id, 'linal-2025')).status, 200)
  assert.equal((await setSlug(course.id, 'linal-2026')).status, 200)

  assert.equal(
    await release(stranger.id, 'linal-2025'),
    404,
    'чужое прежнее имя отпустил не хозяин',
  )
  assert.equal(await release(course.id, 'linal-2026'), 404, 'отпустили ЖИВОЕ имя, а не прежнее')
  assert.ok(findCourse('linal-2025'), 'адрес перестал вести на курс раньше времени')

  assert.equal(await release(course.id, 'linal-2025'), 200)
  // Цена: ссылка с прежним адресом теперь не ведёт никуда — и это было решением
  // владельца, а не побочным эффектом.
  assert.equal(findCourse('linal-2025'), null)
  assert.equal(await release(course.id, 'linal-2025'), 404, 'отпустили дважды, и оба раза «ок»')

  // А новый курс может его наконец занять.
  assert.equal((await setSlug(stranger.id, 'linal-2025')).status, 200)
})
