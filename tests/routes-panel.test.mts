/**
 * Двери панели: право, ответ и мерка.
 *
 * Четыре разных промаха одной природы — маршрут делает не то, что обещает
 * снаружи:
 *
 *  - Build отвечал «202 Accepted» только когда сборка целиком заканчивалась,
 *    то есть через минуты; вкладка всё это время держала строку занятой, живого
 *    журнала не открывала и не давала нажать Cancel на своей же сборке.
 *  - курс стирал любой преподаватель одним запросом — при том что удаление
 *    семинара и «стереть страницу» владельческие, и ровно по той причине,
 *    которая к курсу подходит ещё лучше: `/c/slug` раздают всему потоку.
 *  - публикация с повторяющимся адресом шага молча теряла шаг, а `seq: 0` —
 *    адрес, зарезервированный за последней страницей, — уезжал в транзакцию.
 *  - PATCH преподавателя обещал в комментарии необязательные поля и требовал
 *    имя с адресом вместе.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, getTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { adminAuthRoutes } from '../server/src/routes/admin-auth.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { withinRoomBudget } from '../server/src/routes/admin-import.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createCourse, getCourse, setCourseItems } from '../server/src/publish/store.js'
import { config } from '../server/src/config.js'
import type { SkippedStep } from '../shared/publish.js'

let base = ''
let server: http.Server
let ownerCookie = ''
let teacherCookie = ''

/** Сборка, которая не кончается, пока её не отпустят: настоящая ходит в docker. */
let releaseBuild: (() => void) | null = null
let buildsStarted = 0

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.panel@test.local', role: 'owner' })
  const teacher = createTeacher({ name: 'Нина', email: 'nina.panel@test.local', role: 'teacher' })
  assert.ok(owner)
  assert.ok(teacher)
  rotateLinkKey(owner.id)
  rotateLinkKey(teacher.id)
  ownerCookie = cookieFor(owner)
  teacherCookie = cookieFor(teacher)

  const app = express()
  app.use(express.json())
  app.use(adminAuthRoutes())
  app.use(courseRoutes())
  app.use(
    adminEnvironmentRoutes({
      environmentAbilities: () =>
        Promise.resolve({
          canBuild: true,
          cannotBuildReason: null,
          canSetDefault: true,
          cannotSetDefaultReason: null,
        }),
      startBuild: (_name: string) =>
        new Promise<void>((resolve) => {
          buildsStarted += 1
          releaseBuild = resolve
        }),
    }),
  )
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  releaseBuild?.()
  server?.close()
  shutdownCollab()
})

/* ------------------------------------------------------------------ сборка */

test('Build отвечает сразу, а не когда соберётся', async () => {
  const res = await fetch(`${base}/api/admin/environments/base/build`, {
    method: 'POST',
    headers: { cookie: ownerCookie },
  })
  assert.equal(res.status, 202)
  // Ответ пришёл, сборка идёт: именно в этом промежутке вкладка открывает
  // живой журнал и держит рабочей кнопку Cancel.
  assert.equal(buildsStarted, 1)
  assert.ok(releaseBuild, 'сборку успели закончить до ответа')
  releaseBuild?.()
  releaseBuild = null
})

/* -------------------------------------------------------------------- курс */

test('курс стирает владелец, и только он', async () => {
  const course = createCourse('Матстат', null, 'Ада')
  const asTeacher = await fetch(`${base}/api/admin/courses/${course.id}`, {
    method: 'DELETE',
    headers: { cookie: teacherCookie },
  })
  assert.equal(asTeacher.status, 403, 'курс стёр не владелец')
  assert.ok(getCourse(course.id), 'курс всё-таки удалили')

  const asOwner = await fetch(`${base}/api/admin/courses/${course.id}`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie },
  })
  assert.equal(asOwner.status, 200)
  assert.equal(getCourse(course.id), null)
})

test('курса нет — 404, а не «удалено»', async () => {
  const res = await fetch(`${base}/api/admin/courses/c_nope`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie },
  })
  assert.equal(res.status, 404)
})

/* -------------------------------------------------------------- публикация */

const publish = (id: string, steps: unknown[]) =>
  fetch(`${base}/api/admin/seminars/${id}/publish`, {
    method: 'POST',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ steps }),
  })

test('шаг с занятым адресом назван вслух, а не потерян молча', async () => {
  const id = 'publish-dupes'
  createSession(id, 'Семинар с шагами', null)
  const res = await publish(id, [
    { seq: 5, label: 'первый' },
    { seq: 5, label: 'второй' },
  ])
  assert.equal(res.status, 200, 'повтор адреса уронил транзакцию')
  const body = (await res.json()) as { skipped: SkippedStep[] }
  assert.ok(
    body.skipped.some((s) => s.seq === 5 && s.reason === 'duplicate'),
    'второй шаг с тем же адресом исчез без слова',
  )
})

test('нулевой и дробный адрес шага — отказ словами', async () => {
  const id = 'publish-zero'
  createSession(id, 'Семинар с нулём', null)
  for (const seq of [0, -3, 1.5]) {
    const res = await publish(id, [{ seq, label: 'шаг' }])
    assert.equal(res.status, 400, `seq=${seq} приняли`)
    const body = (await res.json()) as { error?: string }
    assert.match(body.error ?? '', /версией из ленты/)
  }
})

/* ------------------------------------------------------------ вид курса */

test('панель и публичная страница показывают один и тот же курс', async () => {
  /*
   * Сборка «курс с живыми именами» была написана дважды — в маршруте и в
   * выгрузке на сайт — и уже разошлась: выгрузка подставляла имя записи, если
   * комнаты не стало, а маршрут возвращал строку как есть, вместе с устаревшей
   * ссылкой на чтение. Один и тот же курс выглядел по-разному в зависимости от
   * того, каким адресом его открыли.
   */
  const id = 'course-view-room'
  createSession(id, 'Неделя 1', null)
  const course = createCourse('Анализ данных', null, 'Ада')
  assert.ok(
    setCourseItems(course.id, course.rev, [
      { kind: 'seminar', sessionId: id, name: 'Старое имя', publication: null },
    ]),
  )

  const panel = await fetch(`${base}/api/admin/courses/${course.id}`, {
    headers: { cookie: ownerCookie },
  })
  const fromPanel = (await panel.json()) as { course: { items: { name: string }[] } }
  assert.equal(fromPanel.course.items[0]?.name, 'Неделя 1', 'панель показала имя из записи')

  const open = await fetch(`${base}/api/c/${course.id}`)
  const fromPublic = (await open.json()) as {
    course: { items: { name: string; sessionId?: string }[] }
  }
  assert.equal(fromPublic.course.items[0]?.name, 'Неделя 1')
  // И идентификатор комнаты наружу по-прежнему не уходит.
  assert.equal(fromPublic.course.items[0]?.sessionId, '')
})

/* ------------------------------------------------------------- список штата */

test('имя правится без адреса: поля правда необязательные', async () => {
  const person = createTeacher({ name: 'Иваннов', email: 'ivanov@test.local', role: 'teacher' })
  assert.ok(person)
  const res = await fetch(`${base}/api/admin/teachers/${person.id}`, {
    method: 'PATCH',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Иванов' }),
  })
  assert.equal(res.status, 200, 'опечатку в фамилии всё ещё лечат удалением')
  const after = getTeacher(person.id)
  assert.equal(after?.name, 'Иванов')
  assert.equal(after?.email, 'ivanov@test.local', 'адрес поехал вслед за именем')
  assert.equal(after?.role, 'teacher', 'роль поехала вслед за именем')
})

test('адрес правится без имени', async () => {
  const person = createTeacher({ name: 'Пётр', email: 'petr.old@test.local', role: 'teacher' })
  assert.ok(person)
  const res = await fetch(`${base}/api/admin/teachers/${person.id}`, {
    method: 'PATCH',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'petr.new@test.local' }),
  })
  assert.equal(res.status, 200)
  const after = getTeacher(person.id)
  assert.equal(after?.email, 'petr.new@test.local')
  assert.equal(after?.name, 'Пётр')
})

/* ------------------------------------------------------------------ импорт */

test('импорт считает потолок комнаты, а не только размер файла', () => {
  const tunable: { maxSessionBytes: number } = config
  const was = tunable.maxSessionBytes
  tunable.maxSessionBytes = 100
  try {
    const entry = (name: string, size: number) => ({
      name,
      path: name,
      type: 'file' as const,
      size,
      downloadUrl: `https://example.invalid/${name}`,
    })
    const { files, skipped } = withinRoomBudget([
      entry('week1.csv', 60),
      entry('week2.csv', 60),
      entry('notes.txt', 10),
    ])
    // Первый влезает, второй — нет, а третий влезает в остаток: потолок
    // считается суммой, а не «отсекаем всё после первого лишнего».
    assert.deepEqual(
      files.map((f) => f.name),
      ['week1.csv', 'notes.txt'],
    )
    assert.deepEqual(skipped, ['week2.csv'])
  } finally {
    tunable.maxSessionBytes = was
  }
})
