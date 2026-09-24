/**
 * A note image that lies as a FILE in the seminar folder.
 *
 * The third way to put an image into a text cell — and until now the only one
 * that worked nowhere. The first two (`data:` in the text and an nbformat
 * attachment) arrive from the .ipynb and go to the shelf; this one does not
 * arrive from the notebook file at all — the file holds a path to a
 * neighbouring file, which Jupyter reads from disk.
 *
 * In the room such a path stayed as written, and the browser resolved it
 * against the page address: `/s/<room>/assets/fig01.png`. The app sits there,
 * and it answers any path with its index.html — 200 and `text/html`. There is
 * no image, and the network does not even show a 404: a success with nothing
 * to show.
 *
 * What is checked here is the parsing — the half shared by the browser and
 * the server — and that publication takes the file along: the seminar folder
 * lives exactly as long as the room does, and the page gets opened on
 * Wednesday evening.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { findWorkspaceImages, workspacePathOf } from '../shared/images.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, releaseSessionDoc } from '../server/src/collab/index.js'
import { makeDir, readBytes, sessionDir } from '../server/src/workspace.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import { createCell, getCells } from '../shared/notebook.js'

/** A real PNG: eight header bytes and a little after them. */
function png(seed = 1): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([head, Buffer.alloc(2048, seed)])
}

/** The note added by the test: a new room has the welcome note first. */
function addedNote(doc: Y.Doc): string {
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  return cells[cells.length - 1].source
}

/** A room with an image in the folder and one note that refers to it. */
function roomWith(id: string, note: string, files: Record<string, Buffer>): Y.Doc {
  createSession(id, 'Лекция', null)
  makeDir(id, 'assets')
  for (const [rel, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(sessionDir(id), rel), body)
  }
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    getCells(doc).push([createCell('markdown', note)])
  })
  return doc
}

/** The paths found in the text. */
const paths = (source: string): string[] => findWorkspaceImages(source).map((ref) => ref.path)

/** The text with the address substituted — the way the note does it. */
function substituted(source: string, url: string): string {
  let out = source
  for (const ref of [...findWorkspaceImages(source)].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, ref.start) + url + out.slice(ref.end)
  }
  return out
}

test('a path to a neighbouring file is found in both image notations', () => {
  assert.deepEqual(paths('![Четыре вопроса](assets/fig01_four_questions.png)'), [
    'assets/fig01_four_questions.png',
  ])
  assert.deepEqual(paths('<img src="assets/fig01.png" alt="схема">'), ['assets/fig01.png'])
  assert.deepEqual(paths("<img alt='схема' src='assets/fig01.png'>"), ['assets/fig01.png'])
  assert.deepEqual(paths('<img src=assets/fig01.png>'), ['assets/fig01.png'])
})

test('the address is replaced, not the caption', () => {
  // `![assets/x.png](assets/x.png)` — a substring search would find the first
  // occurrence, that is, the caption. Hence counting from the length of what
  // stands BEFORE the path.
  assert.equal(
    substituted('![assets/x.png](assets/x.png)', 'URL'),
    '![assets/x.png](URL)',
  )
})

test('"the same folder written differently" is the same folder', () => {
  assert.deepEqual(paths('![схема](./assets/fig01.png)'), ['assets/fig01.png'])
  assert.deepEqual(paths('![схема](assets//fig01.png)'), ['assets/fig01.png'])
  // Markdown writes a space in a name as %20, while an attribute uses a space.
  assert.deepEqual(paths('![схема](assets/my%20fig.png)'), ['assets/my fig.png'])
  assert.deepEqual(paths('<img src="assets/my fig.png">'), ['assets/my fig.png'])
})

test('there is no way out of the seminar folder', () => {
  assert.deepEqual(paths('![x](../../etc/passwd)'), [])
  assert.deepEqual(paths('![x](/etc/passwd)'), [])
  assert.deepEqual(paths('![x](assets/../../secret)'), [])
  assert.equal(workspacePathOf('..'), null)
  assert.equal(workspacePathOf('/api/sessions/x/file'), null)
})

test('what is fetched from elsewhere is not touched', () => {
  // The room shelf, an external address, an inline image and an anchor: each
  // has its own path through the note, and they must not be replaced with a
  // file from the folder.
  assert.deepEqual(paths('![x](attachment:abc123.png)'), [])
  assert.deepEqual(paths('![x](https://example.com/a.png)'), [])
  assert.deepEqual(paths('![x](//example.com/a.png)'), [])
  assert.deepEqual(paths('![x](data:image/png;base64,AAAA)'), [])
  assert.deepEqual(paths('<img src="#anchor">'), [])
})

test('a link is not an image', () => {
  // `[text](assets/x.png)` without an exclamation mark is a link, and it is not
  // issued a ticket to the file: downloading has its own path through the
  // file panel.
  assert.deepEqual(paths('[данные](data/train.csv)'), [])
})

test('several images in one note — all of them', () => {
  const source = [
    '# Лекция',
    '![один](assets/fig01.png)',
    'текст',
    '<img src="assets/fig03.png">',
    '![два](./assets/fig04.png)',
  ].join('\n\n')
  assert.deepEqual(paths(source), ['assets/fig01.png', 'assets/fig04.png', 'assets/fig03.png'])
})

test('publication takes the image from the folder along', () => {
  // The seminar folder lives exactly as long as the room does, and the page
  // gets opened on Wednesday evening: the path `assets/fig01.png` on it is a
  // dead link.
  const body = png(7)
  const doc = roomWith(
    'note-ws-publish',
    '![схема](assets/fig01.png)',
    { 'assets/fig01.png': body },
  )
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  const note = cells[cells.length - 1].source
  assert.match(note, /!\[схема\]\(blob:[0-9a-f]+\.png\)/, `note: ${note}`)
  assert.equal(bag.all().length, 1)
  assert.deepEqual(bag.all()[0].body, body)
  assert.ok(releaseSessionDoc('note-ws-publish') !== undefined)
})

test('`<img>` markup is carried into the publication the same way', () => {
  const doc = roomWith(
    'note-ws-publish-img',
    '<img src="assets/fig03.png" alt="схема">',
    { 'assets/fig03.png': png(3) },
  )
  const note = addedNote(doc)
  assert.match(note, /<img src="blob:[0-9a-f]+\.png" alt="схема">/, `note: ${note}`)
  assert.ok(releaseSessionDoc('note-ws-publish-img') !== undefined)
})

test('what is not an image or not a file stays as written', () => {
  // `![](data/train.csv.gz)` is not an illustration but a dataset: there is no
  // reason to read it whole into memory in the middle of building a
  // publication. And a link to a file that does not exist must stay a link
  // rather than turn into a publication record.
  const doc = roomWith(
    'note-ws-publish-skip',
    '![данные](data/train.csv.gz)\n\n![нет такого](assets/missing.png)',
    { 'assets/fig01.png': png(1) },
  )
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  const note = cells[cells.length - 1].source
  assert.match(note, /!\[данные\]\(data\/train\.csv\.gz\)/)
  assert.match(note, /!\[нет такого\]\(assets\/missing\.png\)/)
  assert.equal(bag.all().length, 0)
  assert.ok(releaseSessionDoc('note-ws-publish-skip') !== undefined)
})

test('a file above the ceiling is not read at all', () => {
  const room = 'note-ws-big'
  createSession(room, 'Лекция', null)
  makeDir(room, 'assets')
  fs.writeFileSync(path.join(sessionDir(room), 'assets/huge.png'), Buffer.alloc(64 * 1024))
  assert.notEqual(readBytes(room, 'assets/huge.png', 128 * 1024), null)
  assert.equal(readBytes(room, 'assets/huge.png', 1024), null)
  // And it does not step outside the seminar folder — like everything else
  // that reads it.
  assert.equal(readBytes(room, '../../etc/passwd', 1024), null)
})
