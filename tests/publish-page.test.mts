/**
 * The public page: what is visible on it and what never appears there.
 *
 * The static twin of this page (`server/src/publish/render.ts`, exported into
 * the product repository by `make site`) is gone: a student now reads the
 * class page the live server serves, and what used to be checked in its HTML
 * is the reader's (web/src/components/reader). What is left here is the
 * downloaded notebook and the addresses.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { notebookWithOutputs } from '../server/src/publish/notebook.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import {
  addressHolder,
  createCourse,
  findCourse,
  formerSlugs,
  releaseFormerSlug,
  setCourseSlug,
} from '../server/src/publish/store.js'
import type { PublicCell } from '../shared/publish.js'

after(() => shutdownCollab())

const cell = (over: Partial<PublicCell> = {}): PublicCell => ({
  id: 'c1',
  type: 'code',
  source: 'df.head()',
  outputs: [],
  execCount: 1,
  ranMs: null,
  ...over,
})

/* --------------------------------------------------------------- .ipynb */

test('every cell in the .ipynb has an id: schema 4.5 requires it', () => {
  const notebook = JSON.parse(
    notebookWithOutputs([cell({ id: 'c_ok' }), cell({ id: 'плохой id', type: 'markdown' })], () => null),
  ) as { nbformat_minor: number; cells: { id: string }[] }
  assert.equal(notebook.nbformat_minor, 5)
  assert.deepEqual(
    notebook.cells.map((c) => c.id),
    ['c_ok', 'cell-2'],
  )
  for (const c of notebook.cells) assert.match(c.id, /^[a-zA-Z0-9-_]{1,64}$/)
})

/* ------------------------------------------------------------ addresses */

test('a former name names its holder and is released by that holder', () => {
  /*
   * "Address 'ml-2025' is already taken" is a dead end: there is no course with
   * that address in the list, it was renamed. The holder has to be named, and the
   * former name has to be releasable, otherwise next year's course will never get it.
   */
  const a = createCourse('Курс года', null, 'Ада')
  const b = createCourse('Курс следующего года', null, 'Ада')
  assert.equal(setCourseSlug(a.id, 'ml-2025'), 'ok')
  assert.equal(setCourseSlug(a.id, 'ml-2025-fall'), 'ok')
  assert.equal(setCourseSlug(b.id, 'ml-2025'), 'taken')

  const holder = addressHolder('course', 'ml-2025')
  assert.deepEqual(holder, { kind: 'course', id: a.id, name: 'Курс года', former: true })
  assert.equal(addressHolder('course', 'ml-2025-fall')?.former, false)

  // Only the owner releases, and only a former name.
  assert.equal(releaseFormerSlug('course', b.id, 'ml-2025'), false, 'an address was released by someone who does not own it')
  assert.equal(releaseFormerSlug('course', a.id, 'ml-2025'), true)
  assert.deepEqual(formerSlugs('course', a.id), [])
  assert.equal(findCourse('ml-2025'), null)
  assert.equal(setCourseSlug(b.id, 'ml-2025'), 'ok')
})
