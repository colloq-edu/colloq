/**
 * Link cards for a course and a class page.
 *
 * A course link pasted into the group chat used to unfurl with the first
 * four room names («Неделя 1 (повтор)») and a count that included breaks.
 * Now the card lists the titles students are given, skips the breaks, and
 * without a blurb says how many classes there are and which one is next.
 * A class page unfurls as «04 · Лики и хаки данных» with its day, what is on
 * it and its course, under the course's own picture.
 */
import './_env.mts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, formatDay } from '../shared/class-day.js'
import type { CourseItem } from '../shared/publish.js'
import { createSession } from '../server/src/db.js'
import { courseCardOf, linkPreview, pageCardOf } from '../server/src/link-preview.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
import { putPageFile } from '../server/src/publish/page-files.js'
import {
  createCourse,
  renameCourse,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  writePublication,
  type StoredMaterial,
} from '../server/src/publish/store.js'
import { forgetCourseIndex } from '../server/src/routes/course-view.js'
import { instanceToday } from '../server/src/time-zone.js'

const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-course-card-'))
const ROOM = 'lpc4room'
let courseId = ''
let pubId = ''
const nextDay = addDays(instanceToday(), 2)

const notebook = (key: string, name: string) =>
  notebookMaterial({
    key,
    name,
    path: `${key}.ipynb`,
    cells: [{ id: 'c1', type: 'code', source: 'x = 1', outputs: [], execCount: 1, ranMs: null }],
    blob: () => null,
  })

function file(key: string, kind: StoredMaterial['kind'], name: string, p: string): StoredMaterial {
  const stored = putPageFile(Buffer.from(`${key}\n`), 'application/octet-stream')
  return { key, kind, name, path: p, hash: stored.hash, bytes: stored.bytes }
}

before(() => {
  fs.mkdirSync(path.join(staticDir, 'og'), { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'og', 'colloq.png'), 'not really a png')
  createSession(ROOM, 'Неделя 4 (повтор)', null)
  pubId = writePublication({
    sessionId: ROOM,
    title: 'Неделя 4 (повтор)',
    by: null,
    materials: [
      notebook('lecture', 'Лекция'),
      notebook('seminar', 'Семинар'),
      file('slides', 'pdf', 'Слайды лекции', 'slides.pdf'),
      file('train', 'data', 'data/train.csv', 'data/train.csv'),
    ],
    blobs: [],
  }).id
  assert.equal(setPublicationSlug(pubId, 'lpc-ml-04'), 'ok')

  // 33 classes and a break: three held, the fourth (this room) in two days.
  const rows: CourseItem[] = [
    { kind: 'planned', id: 'rlpc0001', name: 'Введение', when: '', day: addDays(instanceToday(), -19) },
    { kind: 'planned', id: 'rlpc0002', name: 'Каникулы', when: '', pause: true },
    { kind: 'planned', id: 'rlpc0003', name: 'Тема 2', when: '', title: 'Линейные модели', day: addDays(instanceToday(), -12) },
    { kind: 'planned', id: 'rlpc0004', name: 'Тема 3', when: '', title: 'EDA', day: addDays(instanceToday(), -5) },
    { kind: 'seminar', id: 'rlpc0005', sessionId: ROOM, name: 'x', publication: null, title: 'Лики и хаки данных', day: nextDay },
  ]
  for (let n = 5; n <= 33; n++) {
    rows.push({ kind: 'planned', id: `rlpc1${String(n).padStart(3, '0')}`, name: `Тема ${n}`, when: '', day: addDays(nextDay, 7 * (n - 4)) })
  }
  const course = createCourse('МЛ | сильная группа', null, null)
  courseId = course.id
  assert.equal(setCourseSlug(course.id, 'lpc-ml'), 'ok')
  assert.ok(setCourseItems(course.id, course.rev, rows))
  forgetCourseIndex()
})

after(() => fs.rmSync(staticDir, { recursive: true, force: true }))

const meta = (head: string, property: string): string | null =>
  new RegExp(`<meta property="${property}" content="([^"]*)">`).exec(head)?.[1] ?? null

test('the course card lists student titles, skips breaks, and names the next class', async () => {
  const card = courseCardOf('lpc-ml', 'ru')!
  assert.deepEqual(card.card.lessons, ['Введение', 'Линейные модели', 'EDA', 'Лики и хаки данных'])
  assert.equal(card.card.total, 33)
  const sentence = `33 занятия · следующее: ${formatDay(nextDay, 'ru')} — Лики и хаки данных`
  assert.equal(card.description, sentence)
  const { head } = await linkPreview('/c/lpc-ml', 'ru', staticDir)
  assert.equal(meta(head!, 'og:description'), sentence)
  assert.equal(courseCardOf('lpc-ml', 'en')!.description, `33 classes · next: ${formatDay(nextDay, 'en')} — Лики и хаки данных`)

  // A blurb, when the teacher wrote one, says it better.
  renameCourse(courseId, 'МЛ | сильная группа', 'Восемь недель машинного обучения.')
  assert.equal(courseCardOf('lpc-ml', 'ru')!.description, 'Восемь недель машинного обучения.')
  renameCourse(courseId, 'МЛ | сильная группа', null)
})

test('a class page unfurls with its number, day, materials and course, under the course card', async () => {
  const card = pageCardOf('lpc-ml-04', 'ru')!
  assert.equal(card.title, '04 · Лики и хаки данных')
  assert.equal(
    card.description,
    `${formatDay(nextDay, 'ru')} · лекция, семинар, слайды, данные · МЛ | сильная группа`,
  )
  // A tab, and a 0.12 step address the reader redirects, unfurl as the page.
  for (const p of ['/p/lpc-ml-04', `/p/${pubId}`, '/p/lpc-ml-04/seminar', '/p/lpc-ml-04/3']) {
    const extras = await linkPreview(p, 'ru', staticDir)
    assert.equal(meta(extras.head!, 'og:title'), '04 · Лики и хаки данных', p)
    assert.equal(extras.title, '04 · Лики и хаки данных · Colloq', p)
    assert.match(meta(extras.head!, 'og:image') ?? '', /\/og\/courses\/lpc-ml\.png\?v=/, p)
    assert.ok(!`${extras.title}${extras.head}`.includes(ROOM), `${p} carries the room id`)
  }
  // An unknown page is any page.
  assert.equal(meta((await linkPreview('/p/no-such-page', 'ru', staticDir)).head!, 'og:url'), null)
})

test('a page outside a course: its own title and day, and the common picture', async () => {
  createSession('lpcalone', 'Разбор контрольной', null)
  const alone = writePublication({
    sessionId: 'lpcalone',
    title: 'Разбор контрольной',
    by: null,
    materials: [notebook('notebook', 'Тетрадь')],
    blobs: [],
    heldOn: '2026-09-30',
  })
  const card = pageCardOf(alone.id, 'ru')!
  assert.equal(card.title, 'Разбор контрольной')
  assert.equal(card.description, `${formatDay('2026-09-30', 'ru')} · тетрадь`)
  assert.equal(card.course, null)
  const { head } = await linkPreview(`/p/${alone.id}`, 'ru', staticDir)
  assert.match(meta(head!, 'og:image') ?? '', /\/og\/colloq\.png/)
})
