/**
 * Site icons as real files — all from one site/favicon.svg.
 *
 * The landing page's icon was embedded in the page as a `data:` link. That is
 * enough for a browser, not for a search engine: Google shows an icon in its
 * results only if it is an ordinary URL its crawler can download, and the
 * image is square with a side that is a multiple of 48 px (or SVG). It does
 * not take `data:` at all, and /favicon.ico answered 404 — so colloq.ru had a
 * grey globe in the results.
 *
 * The raster comes from resvg — the same one that draws link cards on the
 * server, so there are no new dependencies. The ICO is assembled by hand: it
 * is a container, and PNG inside it is understood by everything that needs
 * ICO at all.
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

/** ICO from PNG frames: a header, a directory of 16 bytes per frame, then the PNGs themselves. */
function ico(sizes: number[]): Buffer {
  const frames = sizes.map((size) => ({ size, data: png(size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  let offset = 6 + 16 * frames.length
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.data)])
}

/*
 * 48 and 96 are what Google asks for (multiples of 48); 192 is the Android
 * home-screen shortcut; 180 is the iOS bookmark; 512 is the "organization
 * logo" in the landing page's JSON-LD: it needs a raster of at least 112 px.
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
