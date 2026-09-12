/**
 * Карточка комнаты для мессенджера: настоящий PNG нужного размера, кэш по
 * комнате и маршрут, который её отдаёт.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-card-'))
fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><html><head><title>Colloq</title></head><body></body></html>')
process.env.STATIC_DIR = staticDir

let base = ''
let server: http.Server

before(async () => {
  const { app } = await import('../server/src/app.js')
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  fs.rmSync(staticDir, { recursive: true, force: true })
})

/** Ширина и высота из IHDR — первого чанка любого PNG. */
const pngSize = (png: Buffer): { width: number; height: number } => {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'не PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

test('карточка — PNG 1200×630, и по одной комнате рисуется один раз', async () => {
  const { roomCardPng, roomCardRenders, CARD_WIDTH, CARD_HEIGHT } = await import('../server/src/og-card.js')
  const room = { name: 'MMDA | week01', createdAt: 1789214082146, host: 'hse.colloq.ru', language: 'ru' as const }
  const before = roomCardRenders()
  const png = await roomCardPng(room)
  assert.deepEqual(pngSize(png), { width: CARD_WIDTH, height: CARD_HEIGHT })
  assert.ok(png.length > 10_000, 'картинка подозрительно мала')
  await roomCardPng({ ...room })
  assert.equal(roomCardRenders() - before, 1, 'вторую картинку той же комнаты нарисовали заново')
  // Другое имя — другая картинка.
  await roomCardPng({ ...room, name: 'Другое занятие' })
  assert.equal(roomCardRenders() - before, 2)
})

test('длинное имя не роняет рисовалку и режется с многоточием', async () => {
  const { renderRoomCard, cardName } = await import('../server/src/og-card.js')
  const name = 'Очень длинное название занятия, '.repeat(6)
  assert.ok([...cardName(name)].length <= 90)
  assert.ok(cardName(name).endsWith('…'))
  assert.equal(cardName('Короткое'), 'Короткое')
  const png = await renderRoomCard({ name, createdAt: Date.now(), host: 'hse.colloq.ru', language: 'en' })
  assert.equal(pngSize(png).width, 1200)
})

test('маршрут отдаёт картинку комнаты и 404 незнакомой', async () => {
  const { createSession } = await import('../server/src/db.js')
  createSession('cardroom', 'Карточка', null)
  const ok = await fetch(`${base}/og/rooms/cardroom.png`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.match(ok.headers.get('cache-control') ?? '', /max-age=3600/)
  assert.equal(pngSize(Buffer.from(await ok.arrayBuffer())).height, 630)
  const missing = await fetch(`${base}/og/rooms/nosuchroom.png`)
  assert.equal(missing.status, 404)
})
