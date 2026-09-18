/**
 * Значки сайта настоящими файлами — из одного site/favicon.svg.
 *
 * Значок лендинга был вшит в страницу `data:`-ссылкой. Браузеру этого хватает,
 * поисковику — нет: Google показывает значок в выдаче, только если это обычный
 * адрес, который его робот может скачать, и картинка квадратная со стороной,
 * кратной 48 px (или SVG). `data:` он не берёт вовсе, а /favicon.ico отвечал
 * 404 — поэтому в выдаче у colloq.ru стоял серый глобус.
 *
 * Растр делает resvg — тот же, что рисует карточки ссылок на сервере, так что
 * новых зависимостей нет. ICO собирается руками: это контейнер, и PNG внутри
 * него понимают все, кому ICO вообще нужен.
 *
 *   node --import tsx scripts/site-icons.mts     (make site-icons)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site')
const svg = fs.readFileSync(path.join(site, 'favicon.svg'), 'utf8')

function png(size: number): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
}

/** ICO из PNG-кадров: заголовок, каталог по 16 байт на кадр, затем сами PNG. */
function ico(sizes: number[]): Buffer {
  const frames = sizes.map((size) => ({ size, data: png(size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // тип: значок
  header.writeUInt16LE(frames.length, 4)
  let offset = 6 + 16 * frames.length
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4) // плоскости
    entry.writeUInt16LE(32, 6) // бит на точку
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.data)])
}

/*
 * 48 и 96 — то, что просит Google (кратно 48); 192 — ярлык на Android;
 * 180 — закладка на iOS; 512 — «логотип организации» в JSON-LD лендинга:
 * ему нужен растр не меньше 112 px.
 */
const files: Record<string, Buffer> = {
  'favicon.ico': ico([16, 32, 48]),
  'favicon-48.png': png(48),
  'favicon-96.png': png(96),
  'favicon-192.png': png(192),
  'apple-touch-icon.png': png(180),
  'icon-512.png': png(512),
}
for (const [name, data] of Object.entries(files)) {
  fs.writeFileSync(path.join(site, name), data)
  console.log(name, data.length, 'B')
}
