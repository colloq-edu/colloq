import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import config from '../web/vite.config.js'

// Exercise the emitted head script: it decides which downloads start before
// the app exists. A bare /s/ URL used to fetch the entire editor in incognito.
const plugin = (config as any).plugins.find((plugin: any) => plugin.name === 'colloq-first-paint')

/** Chunks the way Rollup sees them: name, file and STATIC imports. */
const bundle = {
  app: {
    type: 'chunk', name: 'App', fileName: 'assets/App-test.js', imports: ['assets/index-test.js'],
    viteMetadata: { importedCss: new Set(['assets/App-test.css']) },
  },
  entry: { type: 'chunk', name: 'index', fileName: 'assets/index-test.js', imports: [] },
  room: {
    type: 'chunk', name: 'SessionScreen', fileName: 'assets/SessionScreen-test.js',
    imports: ['assets/index-test.js', 'assets/yjs-test.js'],
    viteMetadata: { importedCss: new Set(['assets/SessionScreen-test.css']) },
  },
  yjs: { type: 'chunk', name: 'yjs', fileName: 'assets/yjs-test.js', imports: [] },
  editor: { type: 'chunk', name: 'codemirror', fileName: 'assets/codemirror-test.js', imports: [] },
  render: { type: 'chunk', name: 'render', fileName: 'assets/render-test.js', imports: [] },
  admin: { type: 'chunk', name: 'AdminScreen', fileName: 'assets/AdminScreen-test.js', imports: [] },
  reader: { type: 'chunk', name: 'ReaderScreen', fileName: 'assets/ReaderScreen-test.js', imports: [] },
  ...Object.fromEntries(['room', 'admin', 'reader'].flatMap((area) => ['ru', 'en'].map((locale) => [
    `${area}-${locale}`,
    { type: 'chunk', name: `${area}-${locale}`, fileName: `assets/${area}-${locale}-test.js`, imports: [] },
  ]))),
}

const html = plugin.transformIndexHtml.handler(
  '<html><head><link rel="preload" href="/fonts/jetbrains-mono-latin.woff2" as="font" crossorigin>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-test.css"></head><body></body></html>',
  { bundle },
) as string

function downloads(path: string, saved: string | null, denied = false, ready = false, lang = 'ru'): string[] {
  const requested: string[] = []
  const listeners = new Map<string, () => void>()
  const context = {
    window: { addEventListener: (event: string, listener: () => void) => listeners.set(event, listener) },
    location: { pathname: path },
    localStorage: { getItem: () => { if (denied) throw new Error('Storage denied'); return saved } },
    document: {
      documentElement: { lang },
      createElement: () => ({}),
      head: { appendChild: (link: { href: string }) => requested.push(link.href) },
    },
  }
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) runInNewContext(script[1], context)
  if (ready) listeners.get('colloq:ready')?.()
  return requested
}

/** What exactly goes into the head: the whole link, not just the address. */
function links(path: string, saved: string | null, ready = false, lang = 'ru'): Record<string, unknown>[] {
  const made: Record<string, unknown>[] = []
  const listeners = new Map<string, () => void>()
  runAll({
    window: { addEventListener: (event: string, listener: () => void) => listeners.set(event, listener) },
    location: { pathname: path },
    localStorage: { getItem: () => saved },
    document: {
      documentElement: { lang },
      createElement: () => ({}),
      head: { appendChild: (link: Record<string, unknown>) => made.push(link) },
    },
  })
  if (ready) listeners.get('colloq:ready')?.()
  return made

  function runAll(context: object) {
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) runInNewContext(script[1], context)
  }
}

const ROOM = [
  '/assets/SessionScreen-test.js', '/assets/codemirror-test.js', '/assets/render-test.js',
  '/assets/yjs-test.js', '/assets/SessionScreen-test.css',
]

test('cold seminar links do not request editor downloads before the join form', () => {
  assert.deepEqual(downloads('/s/room1', null), [])
})

test('only a saved identity for this room warms the notebook', () => {
  assert.deepEqual(downloads('/s/room1', '{"room1":{"token":"saved-token"}}'), [
    '/fonts/jetbrains-mono-latin.woff2', ...ROOM, '/assets/room-ru-test.js',
  ])
  assert.deepEqual(downloads('/s/room1', '{"room2":{"token":"saved-token"}}'), [])
  assert.deepEqual(downloads('/admin', '{"room1":{"token":"saved-token"}}'),
    ['/assets/AdminScreen-test.js', '/assets/admin-ru-test.js'])
})

test('the warmed room speaks the language the server put on <html>', () => {
  assert.deepEqual(downloads('/s/room1', '{"room1":{"token":"t"}}', false, false, 'en').at(-1),
    '/assets/room-en-test.js')
  assert.deepEqual(downloads('/admin', null, false, false, 'en').at(-1), '/assets/admin-en-test.js')
  assert.deepEqual(downloads('/p/room1', null, false, false, 'en').at(-1), '/assets/reader-en-test.js')
})

test('unavailable or invalid browser storage keeps cold entry usable', () => {
  for (const saved of ['bad json', 'null', '{}']) assert.deepEqual(downloads('/s/room1', saved), [])
  assert.deepEqual(downloads('/s/room1', null, true), [])
})

// The form goes first in the document: while the room script stood above
// these links, 394 KB of notebook got to take the queue ahead of the form's
// own code.
test('the form and its shared dependencies are requested from the initial document', () => {
  const head = html.slice(0, html.indexOf('</head>'))
  const preloads = [...head.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(preloads, ['/assets/App-test.js', '/assets/index-test.js'])
  assert.ok(head.indexOf('/assets/App-test.js') < head.indexOf('data-colloq-room-preload'),
    'room bytes must not be queued ahead of the form')
})

// Vite's preload helper WAITS for App-*.css before executing App. While it
// was learned about only from the entry chunk, these 852 bytes stood between
// the entry and the screen — a whole network round later than needed.
test("the entry chunk's own stylesheet is named in the head, the page's is not repeated", () => {
  const head = html.slice(0, html.indexOf('</head>'))
  const styles = [...head.matchAll(/<link[^>]*rel="preload" as="style"[^>]*href="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(styles, ['/assets/index-test.css', '/assets/App-test.css'])
  assert.equal(head.match(/href="\/assets\/index-test\.css"/g)?.length, 2, 'stylesheet plus its noscript copy')
})

// The app stylesheet goes at high priority and does not block the first frame.
test('the app stylesheet is preloaded as a style and promoted on load', () => {
  assert.match(html, /<link rel="preload" as="style" crossorigin href="\/assets\/index-test\.css" onload="this\.rel='stylesheet'" data-colloq-css>/)
  assert.match(html, /<noscript><link rel="stylesheet" crossorigin href="\/assets\/index-test\.css"><\/noscript>/)
})

// The join screen is usable now; waiting for /join and then document sync
// before fetching the editor creates two avoidable network stages.
test('a cold room warms after the join form paints, including denied storage', () => {
  const wanted = [...ROOM, '/assets/room-ru-test.js']
  assert.deepEqual(downloads('/s/room1', null, false, true), wanted)
  assert.deepEqual(downloads('/s/room1', null, true, true), wanted)
  assert.deepEqual(downloads('/admin', null, false, true), ['/assets/AdminScreen-test.js', '/assets/admin-ru-test.js'])
  assert.deepEqual(downloads('/p/room1', null, false, true), [
    '/fonts/jetbrains-mono-latin.woff2', '/assets/ReaderScreen-test.js', '/assets/render-test.js',
    '/assets/reader-ru-test.js',
  ])
})

test('ready does not duplicate a returning room preload', () => {
  assert.equal(downloads('/s/room1', '{"room1":{"token":"saved-token"}}', false, true).length, 7)
})

// The notebook is needed AFTER the form, not instead of it: low priority is
// exactly the difference between "warming with spare bandwidth" and "taking
// from the entry screen".
test('room bytes are warmed at low priority; a screen with no form is not', () => {
  const warm = links('/s/room1', '{"room1":{"token":"t"}}')
  assert.deepEqual([...new Set(warm.slice(1).map((link) => link.fetchPriority))], ['low'])
  assert.deepEqual([...new Set(warm.slice(1).map((link) => link.rel))], ['modulepreload', 'preload'])
  assert.deepEqual(links('/admin', null).map((link) => link.fetchPriority), [undefined, undefined])
})

test('non-room screens fetch their catalog and code concurrently without warming the editor', () => {
  assert.deepEqual(downloads('/admin', null), ['/assets/AdminScreen-test.js', '/assets/admin-ru-test.js'])
  assert.deepEqual(downloads('/c/course', null), [
    '/fonts/jetbrains-mono-latin.woff2', '/assets/ReaderScreen-test.js', '/assets/render-test.js',
    '/assets/reader-ru-test.js',
  ])
  assert.deepEqual(downloads('/admin-elsewhere', null), [])
})

// The code font is needed where code is drawn. The staff sign-in form is not
// such a place.
test('code font preload follows the code, not merely the absence of a room', () => {
  const fonts = (path: string, saved: string | null) =>
    downloads(path, saved).filter((file) => file.startsWith('/fonts/'))
  assert.deepEqual(fonts('/s/room1', null), [])
  assert.deepEqual(fonts('/s/room1', 'broken'), [])
  assert.deepEqual(fonts('/s/room1', '{"room1":{"token":"saved"}}'), ['/fonts/jetbrains-mono-latin.woff2'])
  assert.deepEqual(fonts('/p/seminar', null), ['/fonts/jetbrains-mono-latin.woff2'])
  assert.deepEqual(fonts('/admin', null), [])
  assert.deepEqual(fonts('/', null), [])
})

// 26 KB of index.html is 8.9 KB of brotli on EVERY navigation, of which ten
// kilobytes of source were explanations for whoever edits it.
test('the built page carries no comments, and the source keeps every one of them', async () => {
  assert.equal(html.includes('<!--'), false)
  const built = plugin.transformIndexHtml.handler(
    ['<html><head>', '<!-- why -->', '<style>/* why */ body { color: red }</style>',
      '<script>/* keep */ var a = 1</script>', '</head><body></body></html>'].join('\n'),
    { bundle },
  ) as string
  assert.equal(built.includes('why'), false, 'HTML and CSS comments are dropped')
  assert.match(built, /\/\* keep \*\/ var a = 1/)
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'))
  assert.ok(source.includes('<!--'), 'the source page explains itself to whoever edits it')
})

// A chunk was renamed — the build must fail rather than silently bring back
// the extra network round that is removed here.
test('a renamed chunk fails the build instead of silently losing a preload', () => {
  for (const name of ['SessionScreen', 'codemirror', 'render', 'App', 'room-ru', 'admin-en']) {
    const without = Object.fromEntries(
      Object.entries(bundle).filter(([, chunk]) => (chunk as { name: string }).name !== name),
    )
    assert.throws(() => plugin.transformIndexHtml.handler('<html><head></head></html>', { bundle: without }),
      new RegExp(name))
  }
})
