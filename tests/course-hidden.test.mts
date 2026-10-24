/**
 * «Скрыть из курса»: a class put up the day before its seminar, kept from the
 * class until the teacher shows it.
 *
 * «Снять страницу» was the only way to take it back, and that is a different
 * thing: the row turns «снята», the link says the teacher withdrew it, and a
 * page that never should have been seen announces that it exists. Hidden,
 * the row is a plan row to everyone outside the staff (its number, its own
 * title or «Занятие N», its day), and every public door of its page answers
 * as for a page that does not exist. Shown again, it is byte for byte what it
 * was: nothing was unpublished, nothing rebuilt.
 */
import './_env.mts'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import express, { type Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { Course, PublicCourseView, PublicPage } from '../shared/publish.js'
import { addCourseTeacher } from '../server/src/admin/access.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher } from '../server/src/admin/store.js'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { courseCardOf, linkPreview, pageCardOf } from '../server/src/link-preview.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
import {
  createCourse,
  getCourse,
  getPublication,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  writePublication,
} from '../server/src/publish/store.js'
import { forgetCourseIndex, pageHidden } from '../server/src/routes/course-view.js'
import { adminInstanceRoutes } from '../server/src/routes/admin-instance.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

let base = ''
let owner = ''
let stranger = ''
let colleague = ''
let colleagueId = ''
let server: http.Server

const cookieOf = (teacher: Parameters<typeof issueStaffCookie>[1]): string => {
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, teacher)
  return value
}

before(async () => {
  const ada = createTeacher({ name: 'Ада', email: 'ada@course-hidden.test', role: 'owner' })!
  const vera = createTeacher({ name: 'Вера', email: 'vera@course-hidden.test', role: 'teacher' })!
  const ivan = createTeacher({ name: 'Иван', email: 'ivan@course-hidden.test', role: 'teacher' })!
  owner = cookieOf(ada)
  stranger = cookieOf(vera)
  colleague = cookieOf(ivan)
  colleagueId = ivan.id
  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  app.use(adminInstanceRoutes())
  app.use(sessionRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

const BLOB = 'b'.repeat(64)

/** A room with a one-notebook page and one picture. */
function published(sessionId: string, name: string) {
  createSession(sessionId, name, null)
  const material = notebookMaterial({
    key: 'seminar',
    name: 'Семинар',
    path: 'seminar.ipynb',
    cells: [{ id: 'c1', type: 'code', source: 'x = 1', outputs: [], execCount: 1, ranMs: null }],
    blob: () => null,
  })
  return writePublication({
    sessionId,
    title: name,
    by: 'Ада',
    materials: [material],
    blobs: [{ hash: BLOB, mime: 'image/png', body: Buffer.from('png') }],
  })
}

/**
 * A course of three: a plan row, the class hidden ahead of its day (seated
 * into the plan's topic or not), and a visible class after it.
 */
function course(prefix: string, opts: { title?: string } = {}) {
  const early = published(`${prefix}-early`, `Секретная тема ${prefix}`)
  const next = published(`${prefix}-next`, 'Следующее')
  assert.equal(setPublicationSlug(early.id, `${prefix}-02`), 'ok')
  assert.equal(setPublicationSlug(next.id, `${prefix}-03`), 'ok')
  const made = createCourse(`Курс ${prefix}`, null, null)
  assert.equal(setCourseSlug(made.id, `${prefix}-course`), 'ok')
  assert.ok(
    setCourseItems(made.id, made.rev, [
      { kind: 'planned', id: `r${prefix}01`, name: 'Введение', when: '', day: '2026-09-06' },
      {
        kind: 'seminar',
        id: `r${prefix}02`,
        sessionId: `${prefix}-early`,
        name: `Секретная тема ${prefix}`,
        publication: null,
        day: '2026-10-25',
        about: 'Про данные.',
        ...(opts.title ? { title: opts.title } : {}),
      },
      { kind: 'seminar', id: `r${prefix}03`, sessionId: `${prefix}-next`, name: 'Следующее', publication: null, day: '2026-11-01' },
    ]),
  )
  forgetCourseIndex()
  return { course: getCourse(made.id)!, early, next, row: `r${prefix}02`, room: `${prefix}-early` }
}

const hide = (courseId: string, row: string, hidden: unknown, cookie = owner) =>
  fetch(`${base}/api/admin/courses/${courseId}/rows/${row}/hidden`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `${STAFF_COOKIE}=${cookie}` } : {}) },
    body: JSON.stringify({ hidden }),
  })

const view = async (handle: string): Promise<{ course: PublicCourseView; text: string }> => {
  const res = await fetch(`${base}/api/c/${handle}`)
  assert.equal(res.status, 200)
  const text = await res.text()
  return { course: (JSON.parse(text) as { course: PublicCourseView }).course, text }
}

/** Every public door of a page, as status and body (and the cache rule, in `rules`). */
async function doors(
  handle: string,
  cookie = '',
  rules: Record<string, string> = {},
): Promise<Record<string, [number, string]>> {
  const out: Record<string, [number, string]> = {}
  const get = async (name: string, url: string, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string> | undefined), ...(cookie ? { cookie: `${STAFF_COOKIE}=${cookie}` } : {}) }
    const res = await fetch(`${base}${url}`, { redirect: 'manual', ...init, headers })
    out[name] = [res.status, await res.text()]
    rules[name] = `${res.headers.get('cache-control')} | ${res.headers.get('vary') ?? ''}`
  }
  await get('page', `/api/p/${handle}`)
  await get('notebook', `/api/p/${handle}/m/seminar`)
  await get('download', `/api/p/${handle}/m/seminar/download`)
  await get('open', `/api/p/${handle}/m/seminar/open`)
  await get('zip', `/api/p/${handle}/zip`)
  await get('ipynb', `/api/p/${handle}/notebook.ipynb`)
  await get('step', `/api/p/${handle}/step/1`)
  await get('blob', `/api/p/${handle}/blob/${BLOB}`)
  await get('room', `/api/p/${handle}/room`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokens: [] }),
  })
  return out
}

/* ------------------------------------------------------------- the course */

test('a hidden class is a plan row on the course page, and comes back exactly as it was', async () => {
  const { course: made, early, row, room } = course('ha')
  const before = await view('ha-course')
  assert.equal(before.course.classes[1].state, 'page')

  assert.equal((await hide(made.id, row, true)).status, 200)
  const { course: seen, text } = await view('ha-course')
  const hidden = seen.classes[1]
  assert.deepEqual(
    [hidden.key, hidden.n, hidden.title, hidden.state, hidden.day, hidden.page, hidden.about],
    [row, 2, 'Занятие 2', 'plan', '2026-10-25', null, 'Про данные.'],
  )
  // Neither the room's name nor its id nor the page's address goes out.
  assert.ok(!text.includes('Секретная тема'), 'the room name went out')
  assert.ok(!text.includes(room), 'the room id went out')
  assert.ok(!text.includes('ha-02') && !text.includes(early.id), 'the page address went out')
  // The neighbours keep their numbers.
  assert.deepEqual(seen.classes.map((c) => c.n), [1, 2, 3])
  assert.equal(seen.classes[2].state, 'page')

  assert.equal((await hide(made.id, row, false)).status, 200)
  const back = await view('ha-course')
  assert.equal(back.text, before.text)
  // Nothing was unpublished or rebuilt.
  const now = getPublication(early.id)!
  assert.deepEqual([now.state, now.revision, now.publishedAt], ['published', early.revision, early.publishedAt])
})

test('a hidden class keeps the title its row was given, never the room’s', async () => {
  const { course: made, row } = course('hb', { title: 'Лики и хаки данных' })
  assert.equal((await hide(made.id, row, true)).status, 200)
  const { course: seen, text } = await view('hb-course')
  assert.equal(seen.classes[1].title, 'Лики и хаки данных')
  assert.ok(!text.includes('Секретная тема'))
})

/* --------------------------------------------------------------- the page */

test('every public door of a hidden page answers as for a page that does not exist', async () => {
  const { course: made, early, row } = course('hc')
  const visible = await doors('hc-02')
  assert.equal(visible.page[0], 200)
  assert.equal(visible.notebook[0], 200)
  assert.equal(visible.blob[0], 200)
  assert.ok(JSON.parse(visible.room[1]).room, 'the visible page leads into its room')

  assert.equal((await hide(made.id, row, true)).status, 200)
  const nothing = await doors('nopage00')
  for (const handle of ['hc-02', early.id]) {
    const hidden = await doors(handle)
    for (const door of Object.keys(nothing)) {
      assert.deepEqual(hidden[door], nothing[door], `${door} of ${handle}`)
    }
  }
  assert.equal(nothing.page[0], 404)
  assert.ok(pageHidden(early))

  assert.equal((await hide(made.id, row, false)).status, 200)
  const shown = await doors('hc-02')
  assert.deepEqual(shown.page, visible.page)
  assert.deepEqual(shown.notebook, visible.notebook)
  assert.equal(shown.blob[0], 200)
})

test('the course’s staff open a hidden page as usual, and no cache keeps it for a student', async () => {
  const { course: made, row, room } = course('hm')
  const visible = await doors('hm-02')
  assert.equal((await hide(made.id, row, true)).status, 200)
  const nothing = await doors('nopage00')

  // A teacher of the course (and the owner): every door opens, marked private and per cookie.
  addCourseTeacher(made.id, colleagueId, null)
  for (const cookie of [owner, colleague]) {
    const rules: Record<string, string> = {}
    const seen = await doors('hm-02', cookie, rules)
    for (const door of ['page', 'notebook', 'download', 'zip', 'blob']) {
      assert.equal(seen[door][0], 200, door)
      assert.match(rules[door], /^private, no-store \| .*Cookie/, `${door} must not be kept by a shared cache`)
    }
    assert.equal(seen.ipynb[0], 302)
    assert.equal(seen.notebook[1], visible.notebook[1])
    assert.ok(JSON.parse(seen.room[1]).room, 'the staff are led into the room')
    const page = (JSON.parse(seen.page[1]) as { page: PublicPage }).page
    // As students will see it once shown: its own row, its number, and the mark.
    assert.deepEqual([page.n, page.title, page.hidden], [2, 'Секретная тема hm', true])
    assert.equal(page.prev?.n, 1)
  }

  // A teacher of another course, and anyone without a cookie, still get exactly nothing.
  for (const cookie of [stranger, '']) {
    const seen = await doors('hm-02', cookie)
    for (const door of Object.keys(nothing)) assert.deepEqual(seen[door], nothing[door], `${door} for ${cookie ? 'a stranger' : 'a student'}`)
  }

  // The join screen of the room points students nowhere, and its staff to the page.
  const join = async (cookie = '') =>
    ((await (await fetch(`${base}/api/sessions/${room}`, { headers: cookie ? { cookie: `${STAFF_COOKIE}=${cookie}` } : {} })).json()) as {
      published: { address: string } | null
    }).published
  assert.equal(await join(), null)
  assert.equal((await join(owner))?.address, 'hm-02')

  // Shown again: the page is public as before, without the mark.
  assert.equal((await hide(made.id, row, false)).status, 200)
  const rules: Record<string, string> = {}
  const shown = await doors('hm-02', owner, rules)
  assert.deepEqual(shown.page, visible.page)
  assert.equal(rules.notebook.split(' | ')[0], 'public, max-age=300')
  assert.equal((await join())?.address, 'hm-02')
})

test('a neighbour’s page treats a hidden class as a plan row', async () => {
  const { course: made, row } = course('hd')
  const page = async () => ((await (await fetch(`${base}/api/p/hd-03`)).json()) as { page: PublicPage }).page
  assert.equal((await page()).prev?.address, 'hd-02')
  assert.equal((await hide(made.id, row, true)).status, 200)
  const after = await page()
  assert.deepEqual(after.prev, { n: 2, title: 'Занятие 2', day: '2026-10-25', address: null })
  assert.ok(!JSON.stringify(after).includes('Секретная тема'))
})

test('the course’s room door offers nothing for a hidden class', async () => {
  const { course: made, row } = course('he')
  const knock = async (key: string) => {
    const res = await fetch(`${base}/api/c/he-course/room`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, tokens: [] }),
    })
    return [res.status, await res.text()] as const
  }
  const open = await knock(row)
  assert.equal(open[0], 200)
  assert.ok(JSON.parse(open[1]).room, 'a visible class leads into its room')
  assert.equal((await hide(made.id, row, true)).status, 200)
  // Exactly what a plan row answers.
  assert.deepEqual(await knock(row), await knock('rhe01'))
  assert.equal(JSON.parse((await knock(row))[1]).room, null)
})

test('link cards leave a hidden class out', async () => {
  const { course: made, row } = course('hf')
  assert.ok(pageCardOf('hf-02', 'ru'))
  assert.ok(courseCardOf('hf-course', 'ru')!.card.lessons.includes('Секретная тема hf'))
  assert.equal((await hide(made.id, row, true)).status, 200)
  assert.equal(pageCardOf('hf-02', 'ru'), null)
  assert.ok(!courseCardOf('hf-course', 'ru')!.card.lessons.some((t) => t.includes('Секретная')))
  const { head } = await linkPreview('/p/hf-02', 'ru', path.join(import.meta.dirname, 'nowhere'))
  assert.ok(!(head ?? '').includes('Секретная'), 'the page card named the hidden class')
})

/* ------------------------------------------------------------- the panel */

test('staff see the row as it is, marked hidden', async () => {
  const { course: made, row } = course('hg')
  assert.equal((await hide(made.id, row, true)).status, 200)
  const res = await fetch(`${base}/api/admin/courses/${made.id}`, { headers: { cookie: `${STAFF_COOKIE}=${owner}` } })
  const { course: panel } = (await res.json()) as { course: Course }
  const item = panel.items[1]
  assert.equal(item.kind, 'seminar')
  assert.equal(item.hidden, true)
  assert.equal(item.kind === 'seminar' && item.name, 'Секретная тема hg')
  assert.ok(item.kind === 'seminar' && item.publication, 'the panel still sees the page')
  const publications = await fetch(`${base}/api/admin/publications`, { headers: { cookie: `${STAFF_COOKIE}=${owner}` } })
  const listed = ((await publications.json()) as { publications: { slug: string | null; state: string }[] }).publications
  assert.equal(listed.find((p) => p.slug === 'hg-02')?.state, 'published')
})

test('a room seated in two courses: the other course’s panel says where it was hidden', async () => {
  const { course: made, row, room } = course('hn')
  const other = createCourse('Курс hn, второй поток', null, null)
  assert.ok(
    setCourseItems(other.id, other.rev, [
      { kind: 'seminar', id: 'rhn2a', sessionId: room, name: 'Секретная тема hn', publication: null, day: '2026-10-26' },
    ]),
  )
  forgetCourseIndex()
  const panel = async (id: string) =>
    ((await (await fetch(`${base}/api/admin/courses/${id}`, { headers: { cookie: `${STAFF_COOKIE}=${owner}` } })).json()) as {
      course: Course
    }).course
  assert.equal((await panel(other.id)).items[0].hiddenElsewhere, undefined)

  assert.equal((await hide(made.id, row, true)).status, 200)
  const mine = (await panel(made.id)).items[1]
  assert.deepEqual([mine.hidden, mine.hiddenElsewhere], [true, undefined])
  const theirs = await panel(other.id)
  assert.deepEqual([theirs.items[0].hidden, theirs.items[0].hiddenElsewhere], [undefined, true])
  // The list itself (the classes screen reads it) says the same.
  const list = ((await (await fetch(`${base}/api/admin/courses?scope=all`, { headers: { cookie: `${STAFF_COOKIE}=${owner}` } })).json()) as {
    courses: Course[]
  }).courses
  assert.equal(list.find((c) => c.id === other.id)?.items[0].hiddenElsewhere, true)

  // Saving the other course with the mark stores nothing.
  const saved = await fetch(`${base}/api/admin/courses/${other.id}/items`, {
    method: 'PUT',
    headers: { cookie: `${STAFF_COOKIE}=${owner}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rev: theirs.rev, items: theirs.items }),
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(Object.keys(getCourse(other.id)!.items[0]).filter((k) => k.startsWith('hidden')), [])

  assert.equal((await hide(made.id, row, false)).status, 200)
  assert.equal((await panel(other.id)).items[0].hiddenElsewhere, undefined)
})

test('each change is in the audit log with who did it; a repeat changes nothing', async () => {
  const { course: made, row, room } = course('hh')
  const count = () => listAdminEvents({ limit: 500 }).events.filter((e) => e.action.startsWith('course.class_')).length
  const was = count()
  assert.equal((await hide(made.id, row, true)).status, 200)
  const hiddenEvent = listAdminEvents({ limit: 5 }).events.find((e) => e.action === 'course.class_hidden')!
  assert.equal(hiddenEvent.actor?.name, 'Ада')
  assert.deepEqual(hiddenEvent.target, { type: 'course', id: made.id, label: made.name })
  assert.deepEqual(hiddenEvent.detail, { row, title: 'Секретная тема hh', room })
  assert.ok(Math.abs(hiddenEvent.at - Date.now()) < 60_000)
  // Hiding a hidden class again is not a second decision.
  assert.equal((await hide(made.id, row, true)).status, 200)
  assert.equal(count(), was + 1)
  assert.equal((await hide(made.id, row, false)).status, 200)
  assert.equal(listAdminEvents({ limit: 5 }).events[0].action, 'course.class_shown')
  assert.equal(count(), was + 2)
})

test('who may hide a class is who may edit the course’s rows', async () => {
  const { course: made, row } = course('hi')
  assert.equal((await hide(made.id, row, true, '')).status, 401)
  // A teacher of another course gets the course's own 404.
  const foreign = await hide(made.id, row, true, stranger)
  const missing = await hide('nocourse', row, true, stranger)
  assert.equal(foreign.status, 404)
  assert.deepEqual(await foreign.json(), await missing.json())
  assert.equal(getCourse(made.id)!.items[1].hidden, undefined)
  // One who teaches it may.
  addCourseTeacher(made.id, colleagueId, null)
  assert.equal((await hide(made.id, row, true, colleague)).status, 200)
  assert.equal(getCourse(made.id)!.items[1].hidden, true)
  // A plan row has nothing to hide, a row that is not there is a 404, and the flag is a boolean.
  assert.equal((await hide(made.id, 'rhi01', true)).status, 400)
  assert.equal((await hide(made.id, 'rmissing', true)).status, 404)
  assert.equal((await hide(made.id, row, 'yes')).status, 400)
})

test('the whole-list save neither drops the flag nor sets it', async () => {
  const { course: made, row } = course('hj')
  assert.equal((await hide(made.id, row, true)).status, 200)
  const now = getCourse(made.id)!
  const put = (items: unknown[], rev: number) =>
    fetch(`${base}/api/admin/courses/${made.id}/items`, {
      method: 'PUT',
      headers: { cookie: `${STAFF_COOKIE}=${owner}`, 'content-type': 'application/json' },
      body: JSON.stringify({ rev, items }),
    })
  // An older tab that knows nothing of the flag saves the order, reversed.
  const bare = now.items.map(({ hidden: _h, ...rest }) => rest).reverse()
  const saved = (await (await put(bare, now.rev)).json()) as { course: Course }
  assert.equal(saved.course.items.find((i) => i.id === row)?.hidden, true)
  // And a request cannot set it on another row.
  const sneaky = saved.course.items.map((i) => (i.id === `rhj03` ? { ...i, hidden: true } : i))
  const after = (await (await put(sneaky, saved.course.rev)).json()) as { course: Course }
  assert.equal(after.course.items.find((i) => i.id === 'rhj03')?.hidden, undefined)
})

test('a hidden class stays hidden when its room is deleted, and is shown from its tombstone', async () => {
  const { course: made, early, row } = course('hk')
  assert.equal((await hide(made.id, row, true)).status, 200)
  // The index is built while the row still names the room.
  assert.equal((await fetch(`${base}/api/p/hk-02`)).status, 404)
  // The panel's delete, keeping the page (the default): not a moment of it public.
  const gone = await fetch(`${base}/api/admin/seminars/hk-early`, { method: 'DELETE', headers: { cookie: `${STAFF_COOKIE}=${owner}` } })
  assert.equal(gone.status, 204)
  assert.equal((await fetch(`${base}/api/p/hk-02`)).status, 404)
  assert.equal((await fetch(`${base}/api/p/hk-02/m/seminar`)).status, 404)
  const item = getCourse(made.id)!.items[1]
  assert.deepEqual([item.kind, item.hidden], ['gone', true])
  assert.equal((await fetch(`${base}/api/p/hk-02`)).status, 404)
  assert.equal((await view('hk-course')).course.classes[1].state, 'plan')
  assert.equal((await hide(made.id, row, false)).status, 200)
  assert.equal((await view('hk-course')).course.classes[1].page?.address, 'hk-02')
  assert.equal(getPublication(early.id)!.state, 'published')
})

test('the flag survives a restart', async () => {
  const { course: made, row } = course('hl')
  assert.equal((await hide(made.id, row, true)).status, 200)
  // A second process on the same DATA_DIR: what is stored, not what this one remembers.
  const script = `
    const { getCourse } = await import(${JSON.stringify(path.join(import.meta.dirname, '../server/src/publish/store.ts'))})
    const { pageHidden } = await import(${JSON.stringify(path.join(import.meta.dirname, '../server/src/routes/course-view.ts'))})
    const { findPublication } = await import(${JSON.stringify(path.join(import.meta.dirname, '../server/src/publish/store.ts'))})
    const item = getCourse(${JSON.stringify(made.id)}).items.find((i) => i.id === ${JSON.stringify(row)})
    console.log(JSON.stringify({ hidden: item.hidden ?? null, page: pageHidden(findPublication('hl-02')) }))
    process.exit(0)
  `
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: process.env,
    encoding: 'utf8',
    cwd: path.join(import.meta.dirname, '..'),
  })
  const line = run.stdout.trim().split('\n').at(-1) ?? ''
  assert.deepEqual(JSON.parse(line || 'null'), { hidden: true, page: true }, run.stderr)
})
