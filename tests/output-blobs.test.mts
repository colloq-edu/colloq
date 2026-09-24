/**
 * An output image lives next to the room, not in its document.
 *
 * This is the change that is easy to "fix" back without noticing: everything
 * works when the base64 sits in the document too — it is just that a room of
 * five hundred people gets a hundred megabytes of egress and two seconds of
 * zlib per chart, and the history and snapshots carry a copy of it on every
 * frame. So what is checked here is not "is the image visible" but WHAT
 * EXACTLY landed in the document: a reference of a hundred and fifty bytes
 * instead of three hundred kilobytes, and how much the document itself weighs
 * after that.
 *
 * And the other side: what was moved out has to come back. A publication is
 * built as a separate object and survives the deletion of the seminar, so the
 * bytes are embedded into it anew — byte for byte.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  cellId,
  cellOutputs,
  createCell,
  getCells,
  readCell,
  readOutput,
  writeOutput,
} from '../shared/notebook.js'
import { OutputWriter } from '../server/src/kernel/outputs.js'
import {
  blobBytes,
  deleteRoomBlobs,
  noteRoomDoc,
  putBlob,
  readBlob,
  sniffMime,
  sweepOrphans,
} from '../server/src/blobs.js'
import { config } from '../server/src/config.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { signToken } from '../server/src/auth.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import { app } from '../server/src/app.js'
import { api } from '../web/src/lib/api.js'
import { withBlobs } from '../web/src/components/notebook/output-mimes.js'

const FLUSH_MS = 80
const settle = () => new Promise((r) => setTimeout(r, FLUSH_MS))

/** A real PNG signature: the server decides by it what type to serve the bytes as. */
function png(bytes: number): Buffer {
  const body = Buffer.alloc(bytes, 7)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body)
  return body
}

function cellIn(doc: Y.Doc): string {
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  return cellId(cell)
}

const outputsOf = (doc: Y.Doc, id: string) => {
  const found = getCells(doc)
    .toArray()
    .find((c) => cellId(c) === id)
  return readCell(found!).outputs
}

/* --------------------------------------------------------------- storage */

test('a room shelf: the same content is the same entry, and the whole shelf goes at once', () => {
  const room = 'blobstore1'
  createSession(room, 'Полка')
  const body = png(4096)

  const first = putBlob(room, body)
  const again = putBlob(room, body)
  assert.ok(first && again)
  assert.equal(first.sha, again.sha, 'one content, one address')
  assert.equal(first.bytes, body.length)

  assert.deepEqual(readBlob(room, first.sha), body)
  assert.equal(blobBytes(room, first.sha), body.length)
  // Another room reads nothing by the same hash: one shelf per room.
  assert.equal(readBlob('blobstore-other', first.sha), null)
  assert.equal(readBlob(room, 'нет-такого'), null)

  assert.ok(deleteRoomBlobs(room) >= 1)
  assert.equal(readBlob(room, first.sha), null)
})

test('images of a deleted seminar are swept, those of a live one are not', () => {
  const gone = 'blobgone1'
  const live = 'bloblive1'
  createSession(live, 'Живой')
  const a = putBlob(gone, png(2048))
  const b = putBlob(live, png(2048))
  assert.ok(a && b)

  sweepOrphans()
  assert.equal(readBlob(gone, a.sha), null, 'no room, no images')
  assert.ok(readBlob(live, b.sha), 'the live room keeps its images')
})

test('the content type comes from the bytes, not from the kernel', () => {
  assert.equal(sniffMime(png(64)), 'image/png')
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
  assert.equal(sniffMime(Buffer.from('<html>hi</html>')), 'application/octet-stream')
})

/* ----------------------------------------------------------- the kernel */

test('a large image goes to the shelf, and a reference stays in the document', async () => {
  const room = 'blobwrite1'
  createSession(room, 'График')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = png(200 * 1024)
  const base64 = body.toString('base64')

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ 'image/png': base64, 'text/plain': '<Figure size 640x480>' }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.equal(output.data['image/png'], undefined, 'no base64 is left in the document')
  assert.equal(output.data['text/plain'], '<Figure size 640x480>', 'the text stays in the document')
  assert.equal(output.blobs?.length, 1)
  assert.equal(output.blobs?.[0].mime, 'image/png')
  assert.equal(output.blobs?.[0].bytes, body.length)
  assert.deepEqual(readBlob(room, output.blobs![0].sha), body, 'the bytes on the shelf are the same')

  /*
   * What all of this is for: how much the document itself weighs. That is the
   * quantity that goes in full to everyone who joins and is rewritten into every snapshot.
   */
  const withRef = Y.encodeStateAsUpdate(doc).byteLength

  const plain = new Y.Doc()
  const plainId = cellIn(plain)
  const inline = new OutputWriter(plain, plainId)
  inline.data({ 'image/png': base64, 'text/plain': '<Figure size 640x480>' }, 1)
  inline.dispose()
  await settle()
  const withBase64 = Y.encodeStateAsUpdate(plain).byteLength

  assert.ok(withBase64 > 260 * 1024, `expected base64 in the document, but it has ${withBase64} B`)
  assert.ok(
    withRef < withBase64 / 50,
    `the reference should be two orders of magnitude cheaper: ${withRef} B against ${withBase64} B`,
  )
})

test('a small image and markup stay in the document', async () => {
  const room = 'blobwrite2'
  createSession(room, 'Значок')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const small = png(4 * 1024).toString('base64')
  const table = '<table>' + 'x'.repeat(64 * 1024) + '</table>'

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ 'image/png': small, 'text/html': table }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  if (output.kind !== 'data') return assert.fail('expected data')
  assert.equal(output.data['image/png'], small, 'an icon is cheaper to send along with the document')
  assert.equal(output.data['text/html'], table, 'markup is shown by the document itself')
  assert.equal(output.blobs, undefined)
})

test('without a room the writer writes as before: everything into the document', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const base64 = png(200 * 1024).toString('base64')
  const writer = new OutputWriter(doc, id)
  writer.data({ 'image/png': base64 }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  if (output.kind !== 'data') return assert.fail('expected data')
  assert.equal(output.data['image/png'], base64)
  assert.equal(output.blobs, undefined)
})

test('the cell image ceiling counts what was moved out: cheaper, but it counts', async () => {
  const room = 'blobbudget1'
  createSession(room, 'Потолок')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  // A budget of one megabyte: what is moved out costs an eighth of its weight, so
  // a megabyte of budget is eight megabytes of images and not a byte more.
  const writer = new OutputWriter(doc, id, 1024 * 1024, room)
  for (let i = 0; i < 12; i++) {
    // Different content: identical content would land as one entry under one hash.
    const body = png(1024 * 1024)
    body[100 + i] = i + 1
    writer.data({ 'image/png': body.toString('base64') }, i + 1)
  }
  writer.dispose()
  await settle()

  const outputs = outputsOf(doc, id)
  const shown = outputs.filter((o) => o.kind === 'data').length
  assert.ok(shown >= 7 && shown <= 8, `expected about eight images, shown ${shown}`)
  assert.ok(
    outputs.some((o) => o.kind === 'stream' && o.name === 'stderr' && o.text.length > 0),
    'the ceiling is announced out loud, not silently',
  )
})

test('a reference survives the round trip "document → snapshot → document"', () => {
  /*
   * Undoing a cell deletion returns the outputs from the server's memory
   * (collab/ops.ts), and it has to return the same thing: a reference lost on
   * the way is a cell whose chart silently turned into a line of text.
   */
  const output = {
    kind: 'data' as const,
    data: { 'text/plain': '<Figure>' },
    blobs: [{ sha: 'a'.repeat(64), mime: 'image/png', bytes: 4096 }],
    execCount: 3,
  }
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const cell = getCells(doc)
    .toArray()
    .find((c) => cellId(c) === id)!
  doc.transact(() => cellOutputs(cell).push([writeOutput(output)]))
  assert.deepEqual(readOutput(cellOutputs(cell).get(0)), output)
})

/* ---------------------------------------------------------- publishing */

test('a publication embeds the moved-out bytes back, byte for byte', async () => {
  const room = 'blobpub1'
  createSession(room, 'Публикация')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = png(64 * 1024)
  noteRoomDoc(room, doc)

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ 'image/png': body.toString('base64') }, 1)
  writer.dispose()
  await settle()

  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  const output = cells[0].outputs[0]
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.ok(output.data['image/png']?.startsWith('blob:'), 'the page carries the publication entry')
  const all = bag.all()
  assert.equal(all.length, 1)
  assert.deepEqual(all[0].body, body, 'the same bytes went into the publication')
  assert.equal(all[0].mime, 'image/png')
})

/* ------------------------------------------------------------ the route */

const ROOM = 'blobroute1'
const OTHER = 'blobroute2'
let base = ''
let server: http.Server
let sha = ''
const body = png(32 * 1024)

before(async () => {
  createSession(ROOM, 'Раздача')
  createSession(OTHER, 'Соседняя')
  upsertParticipant({
    id: 'p_host',
    sessionId: ROOM,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  sha = putBlob(ROOM, body)!.sha
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

const token = () => signToken({ sessionId: ROOM, participantId: 'p_host', role: 'host' })

test('an image is not served without credentials, and the key is not for just anyone', async () => {
  const bare = await fetch(`${base}/api/sessions/${ROOM}/blobs/${sha}`)
  assert.equal(bare.status, 401)
  const noTicket = await fetch(`${base}/api/sessions/${ROOM}/blobs/ticket`)
  assert.equal(noTicket.status, 401)
  const forged = await fetch(`${base}/api/sessions/${ROOM}/blobs/${sha}?token=1.abc`)
  assert.equal(forged.status, 401)
})

test('with the room key the image is served, with an eternal cache and its own type', async () => {
  const ticketRes = await fetch(`${base}/api/sessions/${ROOM}/blobs/ticket`, {
    headers: { authorization: `Bearer ${token()}` },
  })
  assert.equal(ticketRes.status, 200)
  const { token: ticket } = (await ticketRes.json()) as { token: string }

  const url = api.blobUrl(ROOM, sha, ticket)
  const res = await fetch(`${base}${url}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(res.headers.get('etag'), `"${sha}"`)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), body)

  // A second visit to the same address comes without the bytes.
  const again = await fetch(`${base}${url}`, { headers: { 'if-none-match': `"${sha}"` } })
  assert.equal(again.status, 304)

  // The same key opens nothing in the neighbouring room, and the image is not there.
  const wrongRoom = await fetch(
    `${base}/api/sessions/${OTHER}/blobs/${sha}?token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(wrongRoom.status, 401)

  const missing = await fetch(
    `${base}/api/sessions/${ROOM}/blobs/${'0'.repeat(64)}?token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(missing.status, 404)
})

test('the shelf lives in DATA_DIR, not in the room folder', () => {
  const shelf = path.join(config.dataDir, 'blobs', ROOM, sha)
  assert.ok(fs.existsSync(shelf), `expected a file on the shelf: ${shelf}`)
})

/* ----------------------------------------------------------- the screen */

test('the screen substitutes an address for a moved-out image', () => {
  const output = {
    kind: 'data' as const,
    data: { 'text/plain': '<Figure>' },
    blobs: [{ sha: 'abc', mime: 'image/png', bytes: 1024 }],
    execCount: 1,
  }
  const shown = withBlobs(output, (blob) => `/api/sessions/r/blobs/${blob.sha}?token=t`)
  assert.equal(shown.kind === 'data' && shown.data['image/png'], '/api/sessions/r/blobs/abc?token=t')
  assert.equal(shown.kind === 'data' && shown.data['text/plain'], '<Figure>')

  // No key yet: the bundle stays as it was, and the choice will reach text/plain.
  const waiting = withBlobs(output, () => null)
  assert.equal(waiting.kind === 'data' && waiting.data['image/png'], undefined)

  // Old documents have no references at all; we neither touch nor copy them.
  const old = { kind: 'data' as const, data: { 'image/png': 'AAA' }, execCount: 1 }
  assert.equal(withBlobs(old, () => '/api/x'), old)
})
