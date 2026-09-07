/**
 * Тетрадь на статической странице: чей это шаг и что в файле.
 *
 * Ссылка «Скачать тетрадь» была одна на все шаги, а файл под ней — один на
 * публикацию, собранный из ПОСЛЕДНЕГО шага. Читатель, сравнивающий «до» и
 * «после» на шаге 2 из 5 — ровно тот, ради кого шаг живёт в адресе, — уносил
 * состояние шага 5 и узнавал об этом, только открыв файл.
 *
 * В комнате это чинит `?step=` (routes/courses.ts), а здесь маршрутов нет
 * вовсе — значит, файл на каждый шаг. И подпись рядом: та же, что в читалке,
 * слово в слово, потому что расходиться этим двум страницам нельзя.
 */
import './_env.mts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStep } from '../server/src/publish/render.js'
import { exportSite } from '../server/src/publish/export.js'
import { createSession } from '../server/src/db.js'
import { setPublicationSlug, writePublication } from '../server/src/publish/store.js'
import type { PublicCell } from '../shared/publish.js'

const cell = (id: string, source: string): PublicCell => ({
  id,
  type: 'code',
  source,
  outputs: [],
  execCount: 1,
  ranMs: null,
})

/* ------------------------------------------------------------- страница */

const RAIL = [
  { seq: 3, label: 'перед упражнением', at: 1, cellCount: 1 },
  { seq: 5, label: 'после упражнения', at: 2, cellCount: 1 },
  { seq: 0, label: 'сейчас', at: 3, cellCount: 1 },
]

/** Страница шага под номером `i` в рельсе. Первый шаг — корень публикации. */
function page(i: number, rail = RAIL): string {
  return renderStep({
    title: 'Деревья и леса',
    publishedAt: 1,
    course: null,
    steps: rail,
    step: { seq: rail[i].seq, label: rail[i].label, at: rail[i].at, cells: [cell('c1', 'x = 1')] },
    depth: i === 0 ? 1 : 2,
    base: 'https://colloq.ru',
  })
}

test('страница шага ведёт в свою тетрадь, а не в общую', () => {
  // Первый шаг лежит в корне публикации, а корневая тетрадь занята последним
  // шагом — значит, ссылка спускается в каталог шага.
  assert.match(page(0), /href="3\/notebook\.ipynb"/)
  // Остальные шаги — рядом со своей страницей.
  assert.match(page(1), /href="notebook\.ipynb"/)
  assert.ok(
    !/href="\.\.\/notebook\.ipynb"/.test(page(1)),
    'страница шага снова отдаёт тетрадь всей публикации',
  )
  assert.match(page(2), /href="notebook\.ipynb"/)
})

test('подпись под ссылкой называет шаг и молчание выводов', () => {
  /*
   * Те же три формулировки, что в читалке (web/src/screens/ReaderScreen.svelte):
   * второй отрисовщик тетради на то и второй, что расходится молча, — а
   * расходиться здесь нечему, обещание одно.
   */
  assert.match(page(0), /Код этого шага, без выводов — чтобы запустить у себя\./)
  assert.match(page(1), /Код этого шага, без выводов — чтобы запустить у себя\./)
  assert.match(page(2), /Код последнего шага, без выводов — чтобы запустить у себя\./)

  const alone = page(0, [{ seq: 0, label: 'сейчас', at: 1, cellCount: 1 }])
  assert.match(alone, /Код без выводов — чтобы запустить у себя\./)
  assert.ok(!/этого шага|последнего шага/.test(alone), 'у единственного шага подпись про шаги')
})

/* ------------------------------------------------------------- выгрузка */

test('в выгрузке у каждого шага своя тетрадь, а корневая — прежняя', (t) => {
  const id = 'pub-step-notebook'
  createSession(id, 'Шаги и тетради', null)
  const pub = writePublication({
    sessionId: id,
    title: 'Шаги и тетради',
    by: 'Ада',
    steps: [
      { seq: 4, label: 'перед упражнением', at: 1, cells: [cell('c1', 'before = 1')] },
      { seq: 0, label: 'сейчас', at: 2, cells: [cell('c2', 'after = 2')] },
    ],
    blobs: [],
  })
  assert.equal(setPublicationSlug(pub.id, 'shagi'), 'ok')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-site-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  exportSite(root, 'https://colloq.ru')

  const read = (...parts: string[]): string => fs.readFileSync(path.join(root, ...parts), 'utf8')
  const code = (...parts: string[]): string =>
    (JSON.parse(read(...parts)) as { cells: { source: string[] }[] }).cells
      .map((c) => c.source.join(''))
      .join('\n')

  assert.equal(code('p', 'shagi', '4', 'notebook.ipynb'), 'before = 1')
  assert.equal(code('p', 'shagi', '0', 'notebook.ipynb'), 'after = 2')
  // Корневой адрес не меняет содержимого: на него скопированы розданные ранее
  // ссылки, и под прежним именем публикации он тоже остаётся.
  assert.equal(code('p', 'shagi', 'notebook.ipynb'), 'after = 2')
  assert.equal(code('p', pub.id, 'notebook.ipynb'), 'after = 2')

  assert.match(read('p', 'shagi', 'index.html'), /href="4\/notebook\.ipynb"/)
  assert.match(read('p', 'shagi', '0', 'index.html'), /href="notebook\.ipynb"/)
  assert.match(read('p', 'shagi', 'index.html'), /Код этого шага, без выводов/)
  assert.match(read('p', 'shagi', '0', 'index.html'), /Код последнего шага, без выводов/)
})
