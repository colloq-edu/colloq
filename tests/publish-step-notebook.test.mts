/**
 * The notebook on a static page: whose step it is and what is in the file.
 *
 * The "Download notebook" link was one for all steps, and the file behind it
 * was one per publication, built from the LAST step. A reader comparing
 * "before" and "after" at step 2 of 5 — exactly the reader for whom the step
 * lives in the address — took away the state of step 5 and learned of it only
 * on opening the file.
 *
 * In the room `?step=` fixes this (routes/courses.ts), but here there are no
 * routes at all — so there is a file for every step. And a caption next to it:
 * the same as in the reader, word for word, because these two pages must not
 * drift apart.
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

/* ------------------------------------------------------------- the page */

const RAIL = [
  { seq: 3, label: 'перед упражнением', at: 1, cellCount: 1 },
  { seq: 5, label: 'после упражнения', at: 2, cellCount: 1 },
  { seq: 0, label: 'сейчас', at: 3, cellCount: 1 },
]

/** The page of step number `i` in the rail. The first step is the publication root. */
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

test('a step page links to its own notebook, not to the shared one', () => {
  // The first step lives at the publication root, and the root notebook is taken
  // by the last step — so the link goes down into the step's directory.
  assert.match(page(0), /href="3\/notebook\.ipynb"/)
  // The other steps sit next to their own page.
  assert.match(page(1), /href="notebook\.ipynb"/)
  assert.ok(
    !/href="\.\.\/notebook\.ipynb"/.test(page(1)),
    'a step page serves the notebook of the whole publication again',
  )
  assert.match(page(2), /href="notebook\.ipynb"/)
})

test('the caption under the link names the step and the missing outputs', () => {
  /*
   * The same three wordings as in the reader (web/src/screens/ReaderScreen.svelte):
   * a second notebook renderer is second precisely in that it drifts silently —
   * and there is nothing to drift apart here, the promise is one.
   */
  assert.match(page(0), /Код этого шага, без выводов — чтобы запустить у себя\./)
  assert.match(page(1), /Код этого шага, без выводов — чтобы запустить у себя\./)
  assert.match(page(2), /Код последнего шага, без выводов — чтобы запустить у себя\./)

  const alone = page(0, [{ seq: 0, label: 'сейчас', at: 1, cellCount: 1 }])
  assert.match(alone, /Код без выводов — чтобы запустить у себя\./)
  assert.ok(!/этого шага|последнего шага/.test(alone), 'a lone step has a caption about steps')
})

/* ----------------------------------------------------------- the export */

test('in the export every step has its own notebook, and the root one stays as it was', (t) => {
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
  // The root address does not change its content: links handed out earlier point
  // to it, and it also stays under the publication's former name.
  assert.equal(code('p', 'shagi', 'notebook.ipynb'), 'after = 2')
  assert.equal(code('p', pub.id, 'notebook.ipynb'), 'after = 2')

  assert.match(read('p', 'shagi', 'index.html'), /href="4\/notebook\.ipynb"/)
  assert.match(read('p', 'shagi', '0', 'index.html'), /href="notebook\.ipynb"/)
  assert.match(read('p', 'shagi', 'index.html'), /Код этого шага, без выводов/)
  assert.match(read('p', 'shagi', '0', 'index.html'), /Код последнего шага, без выводов/)
})
