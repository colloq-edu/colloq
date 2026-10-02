/**
 * The boot migration (server/src/publish/migrate-pages.ts): courses and pages
 * written by 0.12 become class pages at the first start, and nothing changes
 * at the second.
 *
 * The 0.12 data is written here the way 0.12 wrote it, with plain SQL: rows
 * without ids or days, a page with one step and no materials, and a page a
 * rolled-back 0.12 republished after the migration had already run.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db, setFinished } from '../server/src/db.js'
import { migratePages } from '../server/src/publish/migrate-pages.js'
import { readPageFile } from '../server/src/publish/page-files.js'
import {
  createCourse,
  getCourse,
  getPublication,
  listMaterials,
  materialCellsText,
  setCourseItems,
} from '../server/src/publish/store.js'
import type { PublicCell } from '../shared/publish.js'

const ZONE = 'Europe/Moscow'
const SEPT_1 = Date.UTC(2026, 8, 1, 9)

function joined(sessionId: string, actor: string, at: number, role = 'participant'): void {
  db.prepare(
    `INSERT INTO session_activity
       (session_id, created_at, kind, level, actor_id, actor_name, actor_role, details)
     VALUES (?, ?, 'presence.joined', 2, ?, ?, ?, '{}')`,
  ).run(sessionId, at, actor, actor, role)
}

function legacyCourse(tag: string) {
  const held = `mig-held-${tag}`
  const finished = `mig-finished-${tag}`
  const never = `mig-never-${tag}`
  createSession(held, 'Деревья', null)
  createSession(finished, 'Бустинг', null)
  createSession(never, 'Ещё не было', null)
  // Created at 09:45, students in at 13:13 on Sunday 13 September, finished at 20:05 on Monday.
  joined(held, 'teacher', Date.UTC(2026, 8, 6, 9, 50), 'host')
  joined(held, 'p_a', Date.UTC(2026, 8, 13, 10, 13))
  joined(held, 'p_b', Date.UTC(2026, 8, 13, 10, 20))
  joined(held, 'p_a', Date.UTC(2026, 8, 14, 7, 0))
  setFinished(held, Date.UTC(2026, 8, 14, 17, 5))
  setFinished(finished, Date.UTC(2026, 8, 20, 20, 30))

  const course = createCourse('МЛ | сильная группа', null, 'Ада')
  db.prepare('UPDATE courses SET created_at = ? WHERE id = ?').run(SEPT_1, course.id)
  const saved = setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: held, name: 'Деревья', publication: null },
    { kind: 'seminar', sessionId: finished, name: 'Бустинг', publication: null },
    { kind: 'seminar', sessionId: never, name: 'Ещё не было', publication: null },
    { kind: 'planned', name: 'Лики и хаки данных', when: 'вс, 4 окт' },
    { kind: 'planned', name: 'Каникулы', when: 'вс, 10 янв' },
    { kind: 'planned', name: 'Неделя', when: '14–20 сен' },
    { kind: 'planned', name: 'Не тот день', when: 'пн, 4 окт' },
    { kind: 'gone', name: 'Удалённая', at: 1 },
  ])
  assert.ok(saved)
  return course.id
}

test('course rows get ids, plan rows their single days, held rooms the day they were held', () => {
  const id = legacyCourse('a')
  migratePages(ZONE)
  const course = getCourse(id)!
  const ids = course.items.map((item) => item.id)
  assert.ok(ids.every((rid) => typeof rid === 'string' && /^r[a-z2-9]{7}$/.test(rid)), ids.join())
  assert.equal(new Set(ids).size, ids.length, 'two rows got one id')
  const days = course.items.map((item) => item.day ?? null)
  assert.deepEqual(days, [
    // Attendance beats both the finish (the next day) and the creation of the room.
    '2026-09-13',
    // Nobody joined: the day the class was finished.
    '2026-09-20',
    // Never held: stays undated until its own «Завершить занятие».
    null,
    '2026-10-04',
    '2027-01-10',
    // A week range is not a day.
    null,
    // A weekday that disagrees is not a day either.
    null,
    null,
  ])
  // The week texts stay where they were.
  const range = course.items[5]
  assert.equal(range.kind === 'planned' && range.when, '14–20 сен')
})

test('running the migration twice changes nothing', () => {
  const id = legacyCourse('b')
  migratePages(ZONE)
  const first = getCourse(id)!
  const again = migratePages(ZONE)
  const second = getCourse(id)!
  assert.equal(second.rev, first.rev, 'the second run rewrote the course')
  assert.deepEqual(second.items, first.items)
  assert.equal(again.pages, 0)
})

test('a day a teacher cleared stays cleared', () => {
  const id = legacyCourse('c')
  migratePages(ZONE)
  const course = getCourse(id)!
  const items = course.items.map((item, i) => (i === 3 ? { ...item, day: null } : item))
  assert.ok(setCourseItems(id, course.rev, items))
  migratePages(ZONE)
  assert.equal(getCourse(id)!.items[3].day, null)
})

/** A page exactly as 0.12 left it: one step, one blob, no materials. */
function legacyPage(id: string, sessionId: string, cells: PublicCell[]): void {
  createSession(sessionId, 'Деревья и леса', null)
  db.prepare(
    `INSERT INTO publications (id, session_id, title, state, published_at, published_by, revision)
     VALUES (?, ?, 'Деревья и леса', 'published', ?, 'Ада', 3)`,
  ).run(id, sessionId, SEPT_1)
  db.prepare(
    `INSERT INTO publication_steps (pub, seq, ord, label, at, page)
     VALUES (?, 0, 0, 'Тетрадь на момент публикации', ?, ?)`,
  ).run(id, SEPT_1, JSON.stringify(cells))
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const HASH = 'c'.repeat(32)

const legacyCells: PublicCell[] = [
  { id: 'c1', type: 'markdown', source: '# Деревья\n\nТекст', outputs: [], execCount: null, ranMs: null },
  {
    id: 'c2',
    type: 'code',
    source: 'df.head()',
    outputs: [
      { kind: 'data', data: { 'text/plain': 'таблица', 'image/png': `blob:${HASH}` }, execCount: 3 },
    ],
    execCount: 3,
    ranMs: 1200,
  },
  { id: 'c3', type: 'markdown', source: '## Леса', outputs: [], execCount: null, ranMs: null },
  { id: 'c4', type: 'code', source: 'print(1)', outputs: [], execCount: null, ranMs: null },
]

test('a 0.12 page becomes one notebook material «Тетрадь», with outline, counts and outputs', () => {
  legacyPage('migpage1', 'mig-page-room', legacyCells)
  db.prepare('INSERT INTO publication_blobs (pub, hash, mime, body) VALUES (?, ?, ?, ?)').run(
    'migpage1',
    HASH,
    'image/png',
    PNG,
  )
  migratePages(ZONE)
  const pub = getPublication('migpage1')!
  assert.equal(pub.materialsRev, pub.revision)
  assert.equal(pub.revision, 3, 'the migration counted itself as a republish')
  assert.equal(pub.firstAt, SEPT_1)
  assert.ok(pub.zipBytes > 0)
  const [material, ...rest] = listMaterials(pub.id)
  assert.equal(rest.length, 0)
  assert.equal(material.key, 'notebook')
  assert.equal(material.kind, 'notebook')
  assert.equal(material.name, 'Тетрадь')
  assert.equal(material.path, 'derevya-i-lesa.ipynb')
  assert.equal(material.cellCount, 4)
  assert.equal(material.outputCount, 1)
  assert.deepEqual(material.outline, [
    { id: 'c1', level: 1, text: 'Деревья' },
    { id: 'c3', level: 2, text: 'Леса' },
  ])
  assert.deepEqual(JSON.parse(materialCellsText(pub.id, 'notebook')!), legacyCells)
  // The download carries the output with its image back inline.
  const ipynb = JSON.parse(readPageFile(material.hash)!.toString('utf8'))
  const out = ipynb.cells[1].outputs[0]
  assert.equal(out.output_type, 'execute_result')
  assert.equal(out.data['image/png'], PNG.toString('base64'))
  // The step stays for a rollback.
  const steps = db.prepare('SELECT COUNT(*) AS n FROM publication_steps WHERE pub = ?').get('migpage1') as {
    n: number
  }
  assert.equal(steps.n, 1)
})

test('a page a rolled-back 0.12 republished is migrated again, and the newer content wins', () => {
  legacyPage('migpage2', 'mig-page-again', legacyCells)
  migratePages(ZONE)
  assert.equal(migratePages(ZONE).pages, 0)
  // 0.12 republishes: revision + 1, a new step page, materials_rev untouched.
  const newer: PublicCell[] = [
    { id: 'n1', type: 'markdown', source: '# Новое', outputs: [], execCount: null, ranMs: null },
  ]
  db.prepare('UPDATE publications SET revision = revision + 1, published_at = ? WHERE id = ?').run(
    Date.now(),
    'migpage2',
  )
  db.prepare('UPDATE publication_steps SET page = ? WHERE pub = ? AND seq = 0').run(
    JSON.stringify(newer),
    'migpage2',
  )
  assert.equal(migratePages(ZONE).pages, 1)
  const pub = getPublication('migpage2')!
  assert.equal(pub.materialsRev, pub.revision)
  assert.equal(pub.firstAt, SEPT_1, 'the first publish moved')
  const [material] = listMaterials(pub.id)
  assert.equal(material.cellCount, 1)
  assert.deepEqual(material.outline, [{ id: 'n1', level: 1, text: 'Новое' }])
})

test('a 0.12 page loses its room id on the way: cells, the .ipynb and the title', () => {
  /*
   * 0.12 never scrubbed the id, and every traceback in its step holds
   * `/workspace/<id>/…`. The new routes serve the material (the tab, the
   * .ipynb with outputs, the ZIP), so the id would reach anyone with the link.
   */
  const room = 'migleakroom'
  const cells: PublicCell[] = [
    { id: 'l1', type: 'markdown', source: `# Комната ${room}`, outputs: [], execCount: null, ranMs: null },
    {
      id: 'l2',
      type: 'code',
      source: `df = pd.read_csv('/workspace/${room}/x.py')`,
      outputs: [
        { kind: 'stream', name: 'stdout', text: `saved /workspace/${room}/out.csv\n` },
        { kind: 'error', ename: 'E', evalue: room, traceback: [`File "/workspace/${room}/x.py", line 1`] },
      ],
      execCount: 1,
      ranMs: 5,
    },
  ]
  legacyPage('migleak1', room, cells)
  db.prepare('UPDATE publications SET title = ? WHERE id = ?').run(`Комната ${room}`, 'migleak1')
  migratePages(ZONE)
  const pub = getPublication('migleak1')!
  const [material] = listMaterials(pub.id)
  const text = materialCellsText(pub.id, 'notebook')!
  assert.ok(!text.includes(room), 'the room id is in the migrated cells')
  assert.ok(text.includes("read_csv('x.py')"), 'the kernel path was not made relative')
  assert.ok(!readPageFile(material.hash)!.toString('utf8').includes(room), 'the room id is in the .ipynb')
  assert.ok(!pub.title.includes(room), 'the room id is in the stored title')
  assert.ok(!material.path.includes(room.slice(0, 6)), 'the room id is in the download name')
})

test('rows of a page a rolled-back 0.12 deleted are dropped, and their files go', () => {
  // Cells of its own, so its .ipynb is a file no other page shares.
  legacyPage('migorphan', 'mig-orphan-room', [
    { id: 'o1', type: 'markdown', source: '# Сирота', outputs: [], execCount: null, ranMs: null },
  ])
  migratePages(ZONE)
  const [material] = listMaterials('migorphan')
  assert.ok(readPageFile(material.hash), 'the page had no file to begin with')
  db.prepare('INSERT INTO publication_blobs (pub, hash, mime, body) VALUES (?, ?, ?, ?)').run(
    'migorphan',
    'd'.repeat(32),
    'image/png',
    PNG,
  )
  // 0.12 deletes the page knowing nothing of publication_materials.
  db.prepare('DELETE FROM publications WHERE id = ?').run('migorphan')
  migratePages(ZONE)
  for (const table of ['publication_materials', 'publication_blobs', 'publication_steps']) {
    const left = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE pub = ?`).get('migorphan') as { n: number }
    assert.equal(left.n, 0, `${table} still holds the deleted page`)
  }
  assert.equal(readPageFile(material.hash), null, 'the deleted page’s file stayed in page_files')
})
