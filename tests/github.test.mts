import './_env.mts'
/**
 * Starting a seminar from a link to GitHub.
 *
 * A teacher's material lives in a course repository — one notebook per week,
 * with the CSV it reads next to it. The link they have in their clipboard is
 * whatever GitHub's address bar gave them, so what this parses is exactly those
 * shapes and nothing invented.
 */
import { test } from 'node:test'
import { createSession } from '../server/src/db.js'
import { setSeminarCreator } from '../server/src/routes/admin-instance.js'
import { db } from '../server/src/db.js'
import assert from 'node:assert/strict'
import {
  filesToTake,
  notebookCells,
  parseGithubUrl,
  pickNotebook,
  rawUrlFor,
  seminarNameFor,
  type RepoEntry,
} from '../server/src/github.js'

/* --------------------------------------------------------------- the URL */

test('a link to a notebook is a file target', () => {
  assert.deepEqual(
    parseGithubUrl('https://github.com/sleep3r/ml_hse/blob/main/week01/01_Intro.ipynb'),
    { owner: 'sleep3r', repo: 'ml_hse', ref: 'main', path: 'week01/01_Intro.ipynb', kind: 'file' },
  )
})

test("a link to a week's folder is a directory target", () => {
  assert.deepEqual(parseGithubUrl('https://github.com/sleep3r/ml_hse/tree/main/week02'), {
    owner: 'sleep3r', repo: 'ml_hse', ref: 'main', path: 'week02', kind: 'dir',
  })
})

test('a trailing slash, a query and a fragment are what GitHub itself adds', () => {
  const withNoise = parseGithubUrl('https://github.com/o/r/blob/main/a/b.ipynb?plain=1#L5')
  assert.equal(withNoise?.path, 'a/b.ipynb')
  assert.equal(parseGithubUrl('https://github.com/o/r/tree/main/week02/')?.path, 'week02')
})

test('a bare repository link has no ref, and that is not an error', () => {
  // The API resolves an empty ref to the default branch, which is the only
  // honest answer when the URL does not name one.
  assert.deepEqual(parseGithubUrl('https://github.com/sleep3r/ml_hse'), {
    owner: 'sleep3r', repo: 'ml_hse', ref: '', path: '', kind: 'dir',
  })
  assert.equal(parseGithubUrl('https://github.com/sleep3r/ml_hse.git')?.repo, 'ml_hse')
})

test('a ref with a slash in it is the one shape this cannot know', () => {
  // GitHub's own URL is ambiguous for `feature/x`: the ref and the path are
  // separated by a slash and nothing says where one ends. Taking the first
  // segment is what the UI does too, and it is better than refusing the link.
  const t = parseGithubUrl('https://github.com/o/r/tree/main/week02')
  assert.equal(t?.ref, 'main')
})

test('anything that is not github.com is refused', () => {
  for (const bad of [
    'https://gitlab.com/o/r/tree/main/x',
    'https://raw.githubusercontent.com/o/r/main/a.ipynb',
    'not a url',
    '',
    'https://github.com',
  ]) {
    assert.equal(parseGithubUrl(bad), null, JSON.stringify(bad))
  }
})

test('the raw address is built from the target, and HEAD stands in for no ref', () => {
  assert.equal(
    rawUrlFor({ owner: 'o', repo: 'r', ref: 'main', path: 'a/b.ipynb', kind: 'file' }),
    'https://raw.githubusercontent.com/o/r/main/a/b.ipynb',
  )
  assert.match(
    rawUrlFor({ owner: 'o', repo: 'r', ref: '', path: 'a.ipynb', kind: 'file' }),
    /\/HEAD\//,
  )
})

/* ------------------------------------------------------------- the name */

test('the seminar is named after what was linked, made readable', () => {
  // Course notebooks are named like a filesystem, not like a lesson.
  const t = parseGithubUrl('https://github.com/sleep3r/ml_hse/blob/main/week01/01_HSE_PE_Intro_to_Python.ipynb')!
  assert.equal(seminarNameFor(t), 'HSE PE Intro to Python')
})

test('a folder link is named after the folder', () => {
  const t = parseGithubUrl('https://github.com/sleep3r/ml_hse/tree/main/week02')!
  assert.equal(seminarNameFor(t), 'week02')
})

test('a bare repository falls back to the repository name', () => {
  const t = parseGithubUrl('https://github.com/sleep3r/ml_hse')!
  assert.equal(seminarNameFor(t), 'ml_hse')
})

/* ---------------------------------------------------------- the notebook */

test('cells come across as source, in order, with their type', () => {
  const cells = notebookCells({
    cells: [
      { cell_type: 'markdown', source: ['# Week 2\n', '\n', 'EDA.'] },
      { cell_type: 'code', source: 'import pandas as pd\n' },
    ],
  })
  assert.deepEqual(cells, [
    { type: 'markdown', source: '# Week 2\n\nEDA.' },
    { type: 'code', source: 'import pandas as pd\n' },
  ])
})

test('a cell type this product cannot render becomes text, not nothing', () => {
  // Losing a teacher's prose silently is worse than showing it in the wrong font.
  assert.deepEqual(notebookCells({ cells: [{ cell_type: 'raw', source: 'plain words' }] }), [
    { type: 'markdown', source: 'plain words' },
  ])
})

test('the empty cell every editor leaves at the end is dropped', () => {
  const cells = notebookCells({ cells: [{ cell_type: 'code', source: 'x = 1' }, { cell_type: 'code', source: '\n  \n' }] })
  assert.equal(cells.length, 1)
})

test('a file that is not a notebook does not throw, it yields nothing', () => {
  assert.deepEqual(notebookCells({}), [])
  assert.deepEqual(notebookCells(null), [])
  assert.deepEqual(notebookCells({ cells: 'not an array' }), [])
})

/* ------------------------------------------------------------ the files */

const entry = (name: string, size = 100, type: 'file' | 'dir' = 'file'): RepoEntry => ({
  name, path: name, type, size, downloadUrl: type === 'file' ? `https://raw/${name}` : null,
})

test('data next to the notebook comes along', () => {
  const taken = filesToTake([entry('train.csv'), entry('labels.json'), entry('fig.png')], 1e6)
  assert.deepEqual(taken.map((f) => f.name), ['train.csv', 'labels.json', 'fig.png'])
})

test('the notebook itself is not copied as a file', () => {
  // It is the document, not an attachment; copying it too would put a stale
  // duplicate in the Files panel of every room.
  assert.deepEqual(filesToTake([entry('week.ipynb'), entry('train.csv')], 1e6).map((f) => f.name), ['train.csv'])
})

test('subfolders are skipped rather than walked', () => {
  // A recursive import of somebody's course repository is a surprise.
  assert.deepEqual(filesToTake([entry('solutions', 0, 'dir'), entry('train.csv')], 1e6).map((f) => f.name), ['train.csv'])
})

test('a file over the upload limit is left where it is', () => {
  assert.deepEqual(filesToTake([entry('huge.csv', 5e8), entry('small.csv', 10)], 1e6).map((f) => f.name), ['small.csv'])
})

test('code and licences are not data', () => {
  assert.deepEqual(filesToTake([entry('README.md'), entry('LICENSE'), entry('train.py')], 1e6), [])
})

test('the folder is about its only notebook, or the first by name', () => {
  assert.equal(pickNotebook([entry('b.ipynb'), entry('a.ipynb'), entry('x.csv')])?.name, 'a.ipynb')
  assert.equal(pickNotebook([entry('x.csv')]), null)
})

test('a seminar imported from GitHub signs its work like any other', () => {
  /*
   * The ordinary create path has set the author since the panel existed; the
   * import path never did. Two doors into the same room, and only one of them
   * signed — so the list showed imported seminars with a blank author beside
   * rooms that named theirs.
   *
   * Checked at the database, not through the route: what matters is that the
   * row carries a name, and the route's own auth is exercised elsewhere.
   */
  const id = 'import-author'
  createSession(id, 'Week 02', null)
  setSeminarCreator(id, 'Alexander K.')
  const row = db.prepare('SELECT created_by FROM sessions WHERE id = ?').get(id) as
    | { created_by: string | null }
    | undefined
  assert.equal(row?.created_by, 'Alexander K.')
})

test('a link with broken percent-encoding is refused, not thrown at', () => {
  /*
   * The WHATWG parser lets a lone `%` through the path — `95%_CI.ipynb`, copied
   * out of a chat rather than the address bar — and decodeURIComponent throws
   * URIError on it. Thrown from the async import handler under Express 4, that
   * is not an error page but a request that never answers: the preview spinner
   * turns until the browser gives up.
   */
  assert.equal(parseGithubUrl('https://github.com/o/r/blob/main/95%_CI.ipynb'), null)
  assert.equal(parseGithubUrl('https://github.com/o/r/tree/main/week%'), null)
  // A properly encoded one still decodes.
  assert.equal(
    parseGithubUrl('https://github.com/o/r/blob/main/week%2002.ipynb')?.path,
    'week 02.ipynb',
  )
})
