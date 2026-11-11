/*
 * The perf harness costs each route in each language by what the build says
 * that route fetches, and charges no route for another's files.
 *
 * It used to lift every "/assets/…" literal out of the head scripts: the
 * panel's and the reader's files, in both languages, landed in the price of a
 * seminar link (691.79 KiB on 0.30.1), while the room's own files, behind the
 * one script it skipped, were counted as lazy. Here the real first-paint plugin
 * writes a small build's page and preload manifest, and the real harness reads
 * them, as `npm run perf` would.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import config from '../web/vite.config.js'
import { PRELOAD_MANIFEST } from '../web/scripts/preload-manifest.ts'

const plugin = (config as any).plugins.find((plugin: any) => plugin.name === 'colloq-first-paint')
const root = path.resolve(import.meta.dirname, '..')

/** A chunk as Rollup hands it to the plugin: name, file, STATIC imports, stylesheets. */
function chunk(name: string, imports: string[] = [], css: string[] = []) {
  return {
    type: 'chunk', name, fileName: `assets/${name}-t.js`,
    imports: imports.map((other) => `assets/${other}-t.js`),
    viteMetadata: { importedCss: new Set(css.map((sheet) => `assets/${sheet}-t.css`)) },
  }
}

/*
 * The shape of the real build in miniature: a shared chunk the room and the
 * panel both import, a chunk only the panel imports, the renderer the room and
 * the reader share, a dictionary per area and language, and a chunk nobody
 * reaches statically.
 */
const bundle = Object.fromEntries([
  chunk('index', [], ['index']),
  chunk('App', ['index'], ['App']),
  chunk('plural', [], ['plural']),
  chunk('SessionScreen', ['index', 'plural', 'yjs'], ['SessionScreen']),
  chunk('yjs'),
  chunk('codemirror'),
  chunk('render'),
  chunk('standings'),
  chunk('AdminScreen', ['index', 'plural', 'standings'], ['AdminScreen']),
  chunk('ReaderScreen', ['index', 'yjs']),
  chunk('pdf'),
  ...['room', 'admin', 'reader'].flatMap((area) => ['ru', 'en'].map((locale) => chunk(`${area}-${locale}`))),
].map((value) => [value.name, value]))

let dist = ''
const sizes = new Map<string, { raw: number; gzip: number }>()

before(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-perf-routes-'))
  const html = plugin.transformIndexHtml.handler(
    '<html><head><link rel="preload" href="/fonts/jetbrains-mono-latin.woff2" as="font" crossorigin>' +
    '<script type="module" crossorigin src="/assets/index-t.js"></script>' +
    '<link rel="stylesheet" crossorigin href="/assets/index-t.css"></head><body></body></html>',
    { bundle },
  ) as string
  const emitted: Array<{ fileName: string; source: string }> = []
  plugin.generateBundle.handler.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) })
  assert.deepEqual(emitted.map((file) => file.fileName), [PRELOAD_MANIFEST])
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(dist, path.dirname(PRELOAD_MANIFEST)), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), html)
  fs.writeFileSync(path.join(dist, PRELOAD_MANIFEST), emitted[0].source)
  // Random bytes, so no two files weigh the same and every sum below is checkable.
  let index = 0
  const files = new Set<string>()
  for (const value of Object.values(bundle)) {
    files.add(value.fileName)
    for (const sheet of value.viteMetadata.importedCss) files.add(sheet)
  }
  for (const file of files) {
    index += 1
    const imports = (bundle as Record<string, ReturnType<typeof chunk>>)[path.basename(file, '-t.js')]?.imports ?? []
    // The harness walks the entry's static imports itself, from the code.
    const code = file.endsWith('.js')
      ? imports.map((other) => `import"./${path.basename(other)}";`).join('') + '\n'
      : ''
    const bytes = Buffer.concat([Buffer.from(code), randomBytes(1000 + index * 97)])
    fs.writeFileSync(path.join(dist, file), bytes)
    sizes.set('/' + file, { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length })
  }
})

after(() => fs.rmSync(dist, { recursive: true, force: true }))

/** The harness, as `npm run perf -- --json` runs it, on the fixture build and no server. */
function perf(): { status: number | null; report: any } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/perf.mts', '--json'], {
    cwd: root,
    // Port 1: nothing answers, so the sections that need a server are skipped.
    env: { ...process.env, PERF_DIST: dist, PERF_BASE_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(run.error, undefined)
  return { status: run.status, report: JSON.parse(run.stdout) }
}

const weight = (files: string[]) => files.reduce((sum, file) => sum + sizes.get(file)!.gzip, 0)
const FORM = ['/assets/index-t.js', '/assets/index-t.css', '/assets/App-t.js', '/assets/App-t.css']
const OTHER_ROUTES = /AdminScreen|admin-|standings|ReaderScreen|reader-/

test('a seminar link is costed by the room alone, once per language', () => {
  const { report } = perf()
  const scenarios = new Map<string, any>(report.bundle.scenarios.map((s: any) => [`${s.route} ${s.locale}`, s]))
  assert.deepEqual([...scenarios.keys()].sort(), [
    'admin en', 'admin ru', 'form null', 'reader en', 'reader ru', 'room en', 'room ru',
  ])
  for (const locale of ['ru', 'en']) {
    const room = scenarios.get(`room ${locale}`)
    const expected = [
      ...FORM,
      '/assets/SessionScreen-t.js', '/assets/SessionScreen-t.css', '/assets/plural-t.js', '/assets/plural-t.css',
      '/assets/yjs-t.js', '/assets/codemirror-t.js', `/assets/room-${locale}-t.js`,
    ].sort()
    assert.deepEqual(room.files, expected)
    assert.equal(room.files.filter((file: string) => OTHER_ROUTES.test(file)).length, 0,
      'a file of the panel or the reader was charged to the seminar link')
    assert.equal(room.gzip, weight(expected))
    const budget = report.budgets.find((b: any) => b.name === `seminar link first fetch gzip (${locale})`)
    assert.equal(budget.actual, room.gzip / 1024)
  }
  // The single figure that summed every route and both languages is gone.
  assert.equal(report.budgets.some((b: any) => b.name === 'seminar link first fetch gzip'), false)
})

test('the panel and the reader are costed with what importing their screen pulls in', () => {
  const { report } = perf()
  const of = (route: string, locale: string) =>
    report.bundle.scenarios.find((s: any) => s.route === route && s.locale === locale).files
  assert.deepEqual(of('admin', 'en'), [
    ...FORM,
    '/assets/AdminScreen-t.js', '/assets/AdminScreen-t.css', '/assets/plural-t.js', '/assets/plural-t.css',
    '/assets/standings-t.js', '/assets/admin-en-t.js',
  ].sort())
  assert.deepEqual(of('reader', 'ru'), [
    ...FORM, '/assets/ReaderScreen-t.js', '/assets/render-t.js', '/assets/yjs-t.js', '/assets/reader-ru-t.js',
  ].sort())
  assert.deepEqual(report.bundle.scenarios.find((s: any) => s.route === 'form').files, [...FORM].sort())
})

test('each chunk says on which routes and in which language it goes out at once', () => {
  const { report } = perf()
  const load = new Map<string, { load: string; routes: string[] }>(
    report.bundle.chunks.map((c: any) => [c.file, { load: c.load, routes: c.routes }]))
  assert.deepEqual(load.get('/assets/index-t.js'), { load: 'blocking', routes: [] })
  // main.ts keeps the shell up until this sheet applies: the form waits for it.
  assert.deepEqual(load.get('/assets/index-t.css'), { load: 'blocking', routes: [] })
  assert.deepEqual(load.get('/assets/App-t.js'), { load: 'preload', routes: [] })
  assert.deepEqual(load.get('/assets/AdminScreen-t.js'), { load: 'route', routes: ['admin'] })
  assert.deepEqual(load.get('/assets/admin-ru-t.js'), { load: 'route', routes: ['admin ru'] })
  assert.deepEqual(load.get('/assets/plural-t.js'), { load: 'route', routes: ['room', 'admin'] })
  assert.deepEqual(load.get('/assets/render-t.js'), { load: 'route', routes: ['reader'] })
  assert.deepEqual(load.get('/assets/pdf-t.js'), { load: 'lazy', routes: [] })
  assert.deepEqual(report.bundle.strays, [])
})

test('a build without the manifest fails out loud instead of guessing the routes', () => {
  const manifest = path.join(dist, PRELOAD_MANIFEST)
  const kept = fs.readFileSync(manifest)
  fs.rmSync(manifest)
  try {
    const { status, report } = perf()
    assert.equal(status, 1)
    assert.match(report.bundle.manifestProblem, /rebuild/)
    assert.equal(report.budgets.find((b: any) => b.name === 'preload manifest')?.ok, false)
    assert.deepEqual(report.bundle.scenarios.map((s: any) => s.route), ['form'])
  } finally {
    fs.writeFileSync(manifest, kept)
  }
})

test('splitting a Plotly file cannot hide the full cold chart transfer', () => {
  const directory = path.join(dist, 'plotly')
  fs.mkdirSync(path.join(directory, 'chunks'), { recursive: true })
  try {
    // Each file fits 450KiB, but an ordinary chart imports both and pays
    // over 450KiB. Random payloads avoid a repetitive fixture compressing away.
    const payload = () => `export const data = "${randomBytes(280_000).toString('base64')}";`
    fs.writeFileSync(path.join(directory, 'plotly.min.js'), 'import "./chunks/large.js";' + payload())
    fs.writeFileSync(path.join(directory, 'chunks/large.js'), payload())
    const { status, report } = perf()
    assert.equal(status, 1)
    assert.equal(report.budgets.find((b: any) => b.name === 'largest file outside the graph')?.ok, true)
    assert.equal(report.budgets.find((b: any) => b.name === 'cold Plotly graph gzip')?.ok, false)
    assert.deepEqual(report.bundle.plotly.files, ['/plotly/chunks/large.js', '/plotly/plotly.min.js'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
