import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import config from '../web/vite.config.js'

// Exercise the emitted head script: it decides which downloads start before
// the app exists. A bare /s/ URL used to fetch the entire editor in incognito.
const plugin = (config as any).plugins.find((plugin: any) => plugin.name === 'colloq-first-paint')
const html = plugin.transformIndexHtml.handler('<html><head></head><body></body></html>', {
  bundle: {
    app: { type: 'chunk', name: 'App', fileName: 'assets/App-test.js', imports: ['assets/index-test.js'] },
    room: { type: 'chunk', name: 'SessionScreen', fileName: 'assets/SessionScreen-test.js' },
    editor: { type: 'chunk', name: 'codemirror', fileName: 'assets/codemirror-test.js' },
    render: { type: 'chunk', name: 'render', fileName: 'assets/render-test.js' },
    language: { type: 'chunk', name: 'full-language', fileName: 'assets/full-language-test.js' },
    admin: { type: 'chunk', name: 'AdminScreen', fileName: 'assets/AdminScreen-test.js' },
    reader: { type: 'chunk', name: 'ReaderScreen', fileName: 'assets/ReaderScreen-test.js' },
  },
}) as string

function downloads(path: string, saved: string | null, denied = false, ready = false): string[] {
  const requested: string[] = []
  const listeners = new Map<string, () => void>()
  const context = {
    window: { addEventListener: (event: string, listener: () => void) => listeners.set(event, listener) },
    location: { pathname: path },
    localStorage: { getItem: () => { if (denied) throw new Error('Storage denied'); return saved } },
    document: { createElement: () => ({}), head: { appendChild: (link: { href: string }) => requested.push(link.href) } },
  }
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) runInNewContext(script[1], context)
  if (ready) listeners.get('colloq:ready')?.()
  return requested
}

test('cold seminar links do not request editor downloads before the join form', () => {
  assert.deepEqual(downloads('/s/room1', null), [])
})

test('only a saved identity for this room warms the notebook', () => {
  assert.deepEqual(downloads('/s/room1', '{"room1":{"token":"saved-token"}}'), [
    '/assets/SessionScreen-test.js', '/assets/codemirror-test.js', '/assets/render-test.js', '/assets/full-language-test.js',
  ])
  assert.deepEqual(downloads('/s/room1', '{"room2":{"token":"saved-token"}}'), [])
  assert.deepEqual(downloads('/admin', '{"room1":{"token":"saved-token"}}'), ['/assets/full-language-test.js', '/assets/AdminScreen-test.js'])
})

test('unavailable or invalid browser storage keeps cold entry usable', () => {
  for (const saved of ['bad json', 'null', '{}']) assert.deepEqual(downloads('/s/room1', saved), [])
  assert.deepEqual(downloads('/s/room1', null, true), [])
})

test('the form and its shared dependencies are requested from the initial document', () => {
  const links = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(links, ['/assets/App-test.js', '/assets/index-test.js'])
})

// The join screen is usable now; waiting for /join and then document sync
// before fetching the editor creates two avoidable network stages.
test('a cold room warms after the join form paints, including denied storage', () => {
  const wanted = ['/assets/SessionScreen-test.js', '/assets/codemirror-test.js', '/assets/render-test.js', '/assets/full-language-test.js']
  assert.deepEqual(downloads('/s/room1', null, false, true), wanted)
  assert.deepEqual(downloads('/s/room1', null, true, true), wanted)
  assert.deepEqual(downloads('/admin', null, false, true), ['/assets/full-language-test.js', '/assets/AdminScreen-test.js'])
  assert.deepEqual(downloads('/p/room1', null, false, true), ['/assets/full-language-test.js', '/assets/ReaderScreen-test.js', '/assets/render-test.js'])
})

test('ready does not duplicate a returning room preload', () => {
  assert.equal(downloads('/s/room1', '{"room1":{"token":"saved-token"}}', false, true).length, 4)
})

test('non-room screens fetch their catalog and code concurrently without warming the editor', () => {
  assert.deepEqual(downloads('/admin', null), ['/assets/full-language-test.js', '/assets/AdminScreen-test.js'])
  assert.deepEqual(downloads('/c/course', null), ['/assets/full-language-test.js', '/assets/ReaderScreen-test.js', '/assets/render-test.js'])
  assert.deepEqual(downloads('/admin-elsewhere', null), [])
})

test('code font preload waits for a cold form but stays early for returning rooms', () => {
  // Reuse the existing fixture bundle, extracting the generated font guard
  // alone so the assertions concern fonts rather than notebook module order.
  const generated = plugin.transformIndexHtml.handler(
    '<html><head><link rel="preload" href="/fonts/jetbrains-mono-latin.woff2" as="font" crossorigin></head></html>',
    { bundle: {
      app: { type: 'chunk', name: 'App', fileName: 'App.js', imports: [] },
      room: { type: 'chunk', name: 'SessionScreen', fileName: 'SessionScreen.js' },
      editor: { type: 'chunk', name: 'codemirror', fileName: 'codemirror.js' },
      render: { type: 'chunk', name: 'render', fileName: 'render.js' },
      language: { type: 'chunk', name: 'full-language', fileName: 'full-language.js' },
    } },
  ) as string
  const script = /<script data-colloq-mono-preload>([\s\S]*?)<\/script>/.exec(generated)?.[1]
  assert.ok(script)
  function fonts(path: string, saved: string | null): string[] {
    const requested: string[] = []
    runInNewContext(script!, {
      location: { pathname: path }, localStorage: { getItem: () => saved },
      document: { createElement: () => ({}), head: { appendChild: (link: { href: string }) => requested.push(link.href) } },
    })
    return requested
  }
  assert.deepEqual(fonts('/s/room1', null), [])
  assert.deepEqual(fonts('/s/room1', 'broken'), [])
  assert.deepEqual(fonts('/s/room1', '{"room1":{"token":"saved"}}'), ['/fonts/jetbrains-mono-latin.woff2'])
  assert.deepEqual(fonts('/admin', null), ['/fonts/jetbrains-mono-latin.woff2'])
})
