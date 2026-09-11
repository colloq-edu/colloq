/**
 * Картинка вывода живёт рядом с комнатой, а не в её документе.
 *
 * Это та правка, которую легко «починить» обратно и не заметить: всё работает
 * и когда base64 лежит в документе — просто комната на пятьсот человек получает
 * сто мегабайт исходящего и две секунды zlib на один график, а история и
 * снимки несут его копию на каждый кадр. Поэтому здесь проверяется не «видно
 * ли картинку», а ЧТО ИМЕННО легло в документ: ссылка на полторы сотни байт
 * вместо трёхсот килобайт, и сколько после этого весит сам документ.
 *
 * И обратная сторона: вынесенное обязано вернуться. Публикация собирается
 * отдельным предметом и переживает удаление семинара, поэтому байты в неё
 * вкладываются заново — байт в байт.
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

/** Настоящая PNG-сигнатура: по ней сервер решает, чем отдавать байты. */
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

/* ------------------------------------------------------------- хранилище */

test('полка комнаты: то же содержимое — та же запись, и уносится вся сразу', () => {
  const room = 'blobstore1'
  createSession(room, 'Полка')
  const body = png(4096)

  const first = putBlob(room, body)
  const again = putBlob(room, body)
  assert.ok(first && again)
  assert.equal(first.sha, again.sha, 'одно содержимое — один адрес')
  assert.equal(first.bytes, body.length)

  assert.deepEqual(readBlob(room, first.sha), body)
  assert.equal(blobBytes(room, first.sha), body.length)
  // Чужая комната по тому же хэшу не читает ничего: полка на комнату.
  assert.equal(readBlob('blobstore-other', first.sha), null)
  assert.equal(readBlob(room, 'нет-такого'), null)

  assert.ok(deleteRoomBlobs(room) >= 1)
  assert.equal(readBlob(room, first.sha), null)
})

test('картинки удалённого семинара подметаются, живого — нет', () => {
  const gone = 'blobgone1'
  const live = 'bloblive1'
  createSession(live, 'Живой')
  const a = putBlob(gone, png(2048))
  const b = putBlob(live, png(2048))
  assert.ok(a && b)

  sweepOrphans()
  assert.equal(readBlob(gone, a.sha), null, 'комнаты нет — и картинок нет')
  assert.ok(readBlob(live, b.sha), 'у живой комнаты картинки на месте')
})

test('тип содержимого — по байтам, а не по слову ядра', () => {
  assert.equal(sniffMime(png(64)), 'image/png')
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
  assert.equal(sniffMime(Buffer.from('<html>hi</html>')), 'application/octet-stream')
})

/* ----------------------------------------------------------------- ядро */

test('крупная картинка уходит на полку, а в документе остаётся ссылка', async () => {
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
  assert.equal(output.data['image/png'], undefined, 'base64 в документе не осталось')
  assert.equal(output.data['text/plain'], '<Figure size 640x480>', 'текст остаётся в документе')
  assert.equal(output.blobs?.length, 1)
  assert.equal(output.blobs?.[0].mime, 'image/png')
  assert.equal(output.blobs?.[0].bytes, body.length)
  assert.deepEqual(readBlob(room, output.blobs![0].sha), body, 'байты на полке те же')

  /*
   * Ради чего всё: сколько весит сам документ. Это и есть та величина, которая
   * уезжает каждому вошедшему целиком и переписывается в каждый снимок.
   */
  const withRef = Y.encodeStateAsUpdate(doc).byteLength

  const plain = new Y.Doc()
  const plainId = cellIn(plain)
  const inline = new OutputWriter(plain, plainId)
  inline.data({ 'image/png': base64, 'text/plain': '<Figure size 640x480>' }, 1)
  inline.dispose()
  await settle()
  const withBase64 = Y.encodeStateAsUpdate(plain).byteLength

  assert.ok(withBase64 > 260 * 1024, `ожидали base64 в документе, а там ${withBase64} Б`)
  assert.ok(
    withRef < withBase64 / 50,
    `ссылка должна быть на два порядка дешевле: ${withRef} Б против ${withBase64} Б`,
  )
})

test('мелкая картинка и разметка остаются в документе', async () => {
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
  if (output.kind !== 'data') return assert.fail('ожидался data')
  assert.equal(output.data['image/png'], small, 'значок дешевле отдать вместе с документом')
  assert.equal(output.data['text/html'], table, 'разметку показывает сам документ')
  assert.equal(output.blobs, undefined)
})

test('без комнаты писатель пишет как раньше — всё в документ', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const base64 = png(200 * 1024).toString('base64')
  const writer = new OutputWriter(doc, id)
  writer.data({ 'image/png': base64 }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  if (output.kind !== 'data') return assert.fail('ожидался data')
  assert.equal(output.data['image/png'], base64)
  assert.equal(output.blobs, undefined)
})

test('потолок картинок ячейки считает вынесенное — дешевле, но считает', async () => {
  const room = 'blobbudget1'
  createSession(room, 'Потолок')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  // Бюджет в один мегабайт: вынесенное стоит восьмую часть своего веса, так
  // что мегабайт бюджета — это восемь мегабайт картинок и ни байтом больше.
  const writer = new OutputWriter(doc, id, 1024 * 1024, room)
  for (let i = 0; i < 12; i++) {
    // Разное содержимое: одинаковое легло бы одной записью по одному хэшу.
    const body = png(1024 * 1024)
    body[100 + i] = i + 1
    writer.data({ 'image/png': body.toString('base64') }, i + 1)
  }
  writer.dispose()
  await settle()

  const outputs = outputsOf(doc, id)
  const shown = outputs.filter((o) => o.kind === 'data').length
  assert.ok(shown >= 7 && shown <= 8, `ожидали около восьми картинок, показано ${shown}`)
  assert.ok(
    outputs.some((o) => o.kind === 'stream' && o.name === 'stderr' && o.text.length > 0),
    'о потолке сказано вслух, а не молча',
  )
})

test('ссылка переживает круг «документ → снимок → документ»', () => {
  /*
   * Отмена удаления ячейки возвращает выводы из памяти сервера
   * (collab/ops.ts), и вернуть она обязана то же самое: потерянная по дороге
   * ссылка — это ячейка, у которой график молча стал текстовой строкой.
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

/* ---------------------------------------------------------- публикация */

test('публикация вкладывает вынесенные байты обратно, байт в байт', async () => {
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
  assert.ok(output.data['image/png']?.startsWith('blob:'), 'на странице стоит запись публикации')
  const all = bag.all()
  assert.equal(all.length, 1)
  assert.deepEqual(all[0].body, body, 'в публикацию уехали те же байты')
  assert.equal(all[0].mime, 'image/png')
})

/* -------------------------------------------------------------- маршрут */

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

test('картинку не отдают без удостоверения, а ключ — не всякому', async () => {
  const bare = await fetch(`${base}/api/sessions/${ROOM}/blobs/${sha}`)
  assert.equal(bare.status, 401)
  const noTicket = await fetch(`${base}/api/sessions/${ROOM}/blobs/ticket`)
  assert.equal(noTicket.status, 401)
  const forged = await fetch(`${base}/api/sessions/${ROOM}/blobs/${sha}?token=1.abc`)
  assert.equal(forged.status, 401)
})

test('по ключу комнаты картинка отдаётся — с вечным кэшем и своим типом', async () => {
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

  // Второй заход по тому же адресу — без байтов.
  const again = await fetch(`${base}${url}`, { headers: { 'if-none-match': `"${sha}"` } })
  assert.equal(again.status, 304)

  // Тот же ключ в соседней комнате не открывает ничего, и картинки там нет.
  const wrongRoom = await fetch(
    `${base}/api/sessions/${OTHER}/blobs/${sha}?token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(wrongRoom.status, 401)

  const missing = await fetch(
    `${base}/api/sessions/${ROOM}/blobs/${'0'.repeat(64)}?token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(missing.status, 404)
})

test('полка лежит в DATA_DIR, а не в папке комнаты', () => {
  const shelf = path.join(config.dataDir, 'blobs', ROOM, sha)
  assert.ok(fs.existsSync(shelf), `ожидали файл на полке: ${shelf}`)
})

/* ---------------------------------------------------------------- экран */

test('экран подставляет адрес вместо вынесенной картинки', () => {
  const output = {
    kind: 'data' as const,
    data: { 'text/plain': '<Figure>' },
    blobs: [{ sha: 'abc', mime: 'image/png', bytes: 1024 }],
    execCount: 1,
  }
  const shown = withBlobs(output, (blob) => `/api/sessions/r/blobs/${blob.sha}?token=t`)
  assert.equal(shown.kind === 'data' && shown.data['image/png'], '/api/sessions/r/blobs/abc?token=t')
  assert.equal(shown.kind === 'data' && shown.data['text/plain'], '<Figure>')

  // Ключа ещё нет — набор остаётся прежним, и выбор дойдёт до text/plain.
  const waiting = withBlobs(output, () => null)
  assert.equal(waiting.kind === 'data' && waiting.data['image/png'], undefined)

  // Старые документы — без ссылок вовсе; их не трогаем и не копируем.
  const old = { kind: 'data' as const, data: { 'image/png': 'AAA' }, execCount: 1 }
  assert.equal(withBlobs(old, () => '/api/x'), old)
})
