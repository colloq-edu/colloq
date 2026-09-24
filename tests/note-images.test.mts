/**
 * Note images live on the room's shelf, not in its document.
 *
 * This breaks quietly and expensively: a lecture notebook where the problem
 * statements are drawn as images moves into the room as base64 strings — a
 * measurement on the live room `pvhu2h7f` gave a 10.5 MB document, 9.4 MB of
 * which was exactly this. Such a document goes WHOLE to everyone who joins,
 * the server closes sockets that cannot keep up, and a student on a slow link
 * never catches up with the room.
 *
 * So the whole round trip is checked: file → room → file. Losing an image on
 * the way back is as bad as carrying it in the document: a notebook taken
 * home is opened without our server.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { makeFile } from '../server/src/workspace.js'
import { getSessionDoc, releaseSessionDoc } from '../server/src/collab/index.js'
import { openBook, projectBooks } from '../server/src/collab/books.js'
import { readBlob } from '../server/src/blobs.js'
import {
  inlineCellImages,
  shelveCellImages,
  shelveRoomImages,
} from '../server/src/notebook-images.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import { parseIpynb, readIpynb, writeIpynb } from '../shared/ipynb.js'
import { attachmentName, findInlineImages } from '../shared/images.js'
import { bookCells, cellSource, createCell, getCells } from '../shared/notebook.js'

/** A real PNG of ~120 KB: eight header bytes and lots of zeros after them. */
function bigPng(seed = 1): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const body = Buffer.alloc(120 * 1024, seed)
  return Buffer.concat([head, body])
}

const PNG = bigPng()
const PNG_B64 = PNG.toString('base64')

test('bringing a notebook in: an image from the text goes to the shelf, a link stays in the cell', () => {
  const room = 'note-img-import'
  createSession(room, 'Картинки', null)
  const file = JSON.stringify({
    cells: [
      {
        cell_type: 'markdown',
        source: [`## Задача\n`, `![схема](data:image/png;base64,${PNG_B64})\n`],
      },
      { cell_type: 'code', source: `img = "data:image/png;base64,${PNG_B64.slice(0, 40_000)}"\n` },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
  assert.equal(makeFile(room, 'Лекция.ipynb', file), 'ok')
  const opened = openBook(room, 'Лекция.ipynb')
  assert.ok(opened.ok, 'the notebook was not brought in')

  const { doc } = getSessionDoc(room)
  const cells = bookCells(doc, opened.ok ? opened.book.root : 'cells')
  const note = cellSource(cells.get(0)).toString()
  assert.ok(!note.includes('base64'), 'the image stayed in the cell text')
  assert.match(note, /!\[схема\]\(attachment:[0-9a-f]{64}\.png\)/)

  // The bytes are on the shelf, and they can be found by the name from the link.
  const sha = /attachment:([0-9a-f]{64})\.png/.exec(note)?.[1] ?? ''
  assert.deepEqual(readBlob(room, sha), PNG)

  /*
   * Code is NEVER touched: `data:image/png;base64,…` in it is a string a
   * person wrote, and replacing it with a link would mean silently rewriting
   * someone else's program.
   */
  assert.ok(cellSource(cells.get(1)).toString().includes('base64'), 'the code was rewritten instead of the note')

  /*
   * The document got lighter by the whole note image. It cannot be measured
   * as a whole: the same notebook deliberately holds code with base64 in a
   * string, and that stays as it was — otherwise the check would reward
   * editing someone else's program.
   */
  const weight = note.length
  assert.ok(weight < 2_000, `the note is still heavy: ${weight} characters`)
})

test('nbformat attachments reach the room and go to the shelf too', () => {
  const room = 'note-img-attach'
  createSession(room, 'Вложения', null)
  const png = bigPng(2)
  const file = JSON.stringify({
    cells: [
      {
        cell_type: 'markdown',
        source: '![схема](attachment:схема.png)\n',
        attachments: { 'схема.png': { 'image/png': png.toString('base64') } },
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
  // Parsing must carry the attachments: before, it read right past them, and
  // the link arrived in the room without its bytes.
  const flat = parseIpynb(file)
  assert.ok(flat && flat[0].attachments?.['схема.png']?.['image/png'])

  assert.equal(makeFile(room, 'Схемы.ipynb', file), 'ok')
  const opened = openBook(room, 'Схемы.ipynb')
  assert.ok(opened.ok)
  const { doc } = getSessionDoc(room)
  const note = cellSource(bookCells(doc, opened.ok ? opened.book.root : 'cells').get(0)).toString()
  const sha = /attachment:([0-9a-f]{64})\.png/.exec(note)?.[1] ?? ''
  assert.ok(sha, `the link was not rewritten: ${note.slice(0, 80)}`)
  assert.deepEqual(readBlob(room, sha), png)
})

test('the projection to disk returns the image as an attachment — the file opens without a server', () => {
  const room = 'note-img-import'
  projectBooks(room)
  const { doc } = getSessionDoc(room)
  // The file is read with the same parsing another Jupyter would use.
  const flat = parseIpynb(
    fs.readFileSync(path.join(process.env.WORKSPACE_DIR ?? '', room, 'Лекция.ipynb'), 'utf8'),
  )
  assert.ok(flat, 'the file is no longer a notebook')
  const name = Object.keys(flat[0].attachments ?? {})[0] ?? ''
  assert.match(name, /^[0-9a-f]{64}\.png$/)
  assert.equal(flat[0].attachments?.[name]?.['image/png'], PNG_B64)
  // And the link in the text points at exactly this attachment.
  assert.ok(flat[0].source.includes(`attachment:${name}`))
  assert.ok(doc)
})

test('the file → room → file round trip keeps the image bytes', () => {
  const room = 'note-img-roundtrip'
  createSession(room, 'Круг', null)
  const png = bigPng(3)
  const first = writeIpynb([
    {
      type: 'markdown',
      source: `![a](data:image/png;base64,${png.toString('base64')})`,
      id: 'c1',
    },
  ])
  const shelved = readIpynb(JSON.parse(first)).map((cell) => shelveCellImages(room, cell))
  assert.ok(!shelved[0].source.includes('base64'))
  const back = writeIpynb(shelved.map((cell) => inlineCellImages(room, cell)))
  const reread = parseIpynb(back)
  const name = attachmentName(createHash('sha256').update(png).digest('hex'), 'image/png')
  assert.equal(reread?.[0].attachments?.[name]?.['image/png'], png.toString('base64'))
})

test('a room opened after this change unloads itself, and only once', () => {
  const room = 'note-img-migrate'
  createSession(room, 'Старая комната', null)
  const { doc } = getSessionDoc(room)
  const png = bigPng(4)
  doc.transact(() => {
    getCells(doc).push([
      createCell('markdown', `![старое](data:image/png;base64,${png.toString('base64')})`),
      createCell('code', `s = "data:image/png;base64,${png.toString('base64')}"`),
    ])
  })
  const heavy = Y.encodeStateAsUpdate(doc).byteLength

  assert.equal(shelveRoomImages(room, doc), 1, 'not exactly one cell was unloaded')
  // Our cell is among the starting ones: the room seeds the notebook with a
  // greeting.
  const note = getCells(doc)
    .map((cell) => cellSource(cell).toString())
    .find((text) => text.startsWith('![старое]')) ?? ''
  assert.match(note, /attachment:[0-9a-f]{64}\.png/)
  assert.equal(findInlineImages(note).length, 0)
  assert.ok(Y.encodeStateAsUpdate(doc).byteLength < heavy, 'the document did not get lighter')

  // A second pass does not write to the document at all: otherwise every room
  // open would cost a version in the history and a snapshot in the database.
  const after = Y.encodeStateAsUpdate(doc).byteLength
  assert.equal(shelveRoomImages(room, doc), 0)
  assert.equal(Y.encodeStateAsUpdate(doc).byteLength, after)
  assert.ok(releaseSessionDoc(room) !== undefined)
})

test('publication carries the note image off into its own records, not as a base64 string', () => {
  const room = 'note-img-publish'
  createSession(room, 'Публикация', null)
  const { doc } = getSessionDoc(room)
  const png = bigPng(5)
  const shelvedSource = shelveCellImages(room, {
    type: 'markdown',
    source: `![схема](data:image/png;base64,${png.toString('base64')})`,
  }).source
  doc.transact(() => {
    getCells(doc).push([createCell('markdown', shelvedSource)])
  })
  const bag = newBlobBag()
  const page = pageOfDoc(doc, bag)
  const note = page.map((cell) => cell.source).find((text) => text.startsWith('![схема]')) ?? ''
  assert.match(note, /!\[схема\]\(blob:[0-9a-f]+\.png\)/, `note: ${note.slice(0, 90)}`)
  assert.equal(bag.all().length, 1)
  assert.deepEqual(bag.all()[0].body, png)
})
