/**
 * perf.mts — the measuring stick for "Colloq is fast".
 *
 * Four numbers, one table, one exit code:
 *   1 BUNDLE     what a student downloads before the page can do anything
 *   2 API        the REST calls on the critical path from link click to notebook
 *   3 SYNC       A types, B sees it — the number that decides whether it feels local
 *   4 NETWORK    TTFB, bytes actually on the wire, and the encoding really negotiated
 *
 * Sections 2-4 need a running server; without one they are skipped, not faked.
 * Deliberately dependency-free beyond what the repo already ships (yjs,
 * y-websocket, ws, node builtins) so it can run in CI with no extra install.
 *
 * Usage: npm run perf [-- --json]
 *   PERF_BASE_URL   default http://localhost:3000
 *   PERF_DIST       default web/dist
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import http from 'node:http'
import https from 'node:https'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WS from 'ws'

/* ----------------------------------------------------------------- budgets */

/*
 * Every budget below is the measured baseline plus deliberate headroom, or a
 * user-facing ceiling derived from the room Colloq is meant to run in:
 * a lecture hall on shared wifi, call it 1.5 Mbit/s ≈ 190 KB/s of real payload.
 * A budget nobody can justify gets deleted the first time it goes red, so each
 * one says where its number came from.
 */

/** 250 KB gzip ≈ 1.3s of transfer on lecture-hall wifi, spent before anything
 *  renders. A chunk this big also defeats caching: one line changes, the whole
 *  quarter-megabyte is re-fetched. Baseline: one 303 KB chunk. */
const MAX_CHUNK_GZIP_KB = 250

/** The entry script and its transitive static imports: fetched, parsed and run
 *  before the join screen exists at all. Baseline measured at 311.0 KB gzip —
 *  as one bundle, and still 311.0 KB after it was split into six files, because
 *  splitting a static import moves bytes between files without deferring any.
 *  250 KB ≈ 1.4s of transfer on lecture-hall wifi, the ceiling that still
 *  leaves room for parse and the websocket connect inside "working a few
 *  seconds after the click". Only a dynamic import() moves this number. */
const MAX_BLOCKING_GZIP_KB = 250

/** Notebook-only libraries (CodeMirror, marked, DOMPurify, ansi_up) that load
 *  before boot. Zero, because the join screen cannot call any of them: it is a
 *  name field and a button. Baseline: all four. */
const MAX_BLOCKING_DEAD_LIBS = 0

/** What a *seminar link* pulls: the blocking graph plus everything the inline
 *  head script modulepreloads on /s/:id (the editor and renderer chunks). A
 *  student never opens '/', so this — not the blocking number — is what the
 *  click on the link costs. Measured 328.2 KB gzip ≈ 1.7s on lecture-hall wifi;
 *  400 KB ≈ 2.1s is where "working a few seconds after the click" stops being
 *  true. This is the budget that goes red when codemirror or render grows. */
const MAX_SEMINAR_FIRST_FETCH_GZIP_KB = 400

/** The biggest file the room downloads that no import edge leads to: the pdf.js
 *  worker, copied from public/ rather than bundled. Measured 363.6 KB gzip, and
 *  it arrives while somebody watches a blank page waiting for page one — about
 *  1.9s of it on lecture-hall wifi. 450 KB ≈ 2.4s is the ceiling; a pdfjs
 *  upgrade that doubles the worker has to be a decision, not a surprise. */
const MAX_ONDEMAND_ASSET_GZIP_KB = 450

/** The shell in index.html must survive slow-start: ~16 KB is the first burst
 *  of packets after the handshake, so an inlined app shell that fits here costs
 *  no extra round trip. Baseline 1.1 KB, leaving room to inline critical CSS. */
const MAX_HTML_TRANSFER_KB = 16

/** Loopback REST with a SQLite write behind it measured p50 1.2 ms (slowest
 *  endpoint, GET /api/health). 25 ms is an order of magnitude of headroom: it
 *  stays green through noise, and goes red the moment someone puts a blocking
 *  call — a kernel spawn, a sync fs read — on the join path. */
const MAX_API_P50_MS = 25

/** Worst of 20, not p50: catches a first-request stall, a lazy DB open, a
 *  kernel warmed synchronously. Measured worst 6.2 ms, always the cold first
 *  hit. 250 ms is the point a student feels the join button hang, and it also
 *  survives PERF_BASE_URL pointing at a real server across a WAN. */
const MAX_API_WORST_MS = 250

/** A keystroke echoed through the server must land inside one animation frame
 *  (16.7 ms) for typing to feel local. Loopback baseline is p50 0.10 ms, so on
 *  this machine the budget is a regression gate with room to spare; the number
 *  is set at the perception threshold so it stays meaningful when this harness
 *  is pointed at a deployed server instead. */
const MAX_SYNC_P50_MS = 16

/** p95 is the one people perceive as a stutter. 50 ms = three frames; past
 *  that a fast typist watches their text land late on the other machine.
 *  Loopback baseline p95 0.45 ms. */
const MAX_SYNC_P95_MS = 50

/** TTFB for the document itself, no cache, fresh connection. Measured p50
 *  2.7 ms. 50 ms leaves room for compression and an inlined shell, and goes
 *  red if the document ever starts waiting on I/O (a DB read, a render). */
const MAX_TTFB_P50_MS = 50

/* -------------------------------------------------------------- plumbing */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = (process.env.PERF_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const DIST = resolve(ROOT, process.env.PERF_DIST ?? 'web/dist')
const JSON_MODE = process.argv.includes('--json')
/** Paths outside the repo print in full; inside it, the short form reads better. */
const DIST_LABEL = DIST.startsWith(ROOT + '/') ? relative(ROOT, DIST) : DIST

const API_N = 20
const SYNC_N = 100
const SYNC_WARMUP = 5
const NET_N = 10

const lines: string[] = []
const say = (s = '') => lines.push(s)
const flush = () => { if (!JSON_MODE) console.log(lines.join('\n')) }

const isTTY = Boolean(process.stdout.isTTY) && !JSON_MODE
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s)
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s)
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s)

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}K`
const ms = (v: number) => `${v.toFixed(v < 10 ? 2 : 1)}ms`
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))

/** Percentile over unsorted samples, nearest-rank — no interpolation to argue about. */
function pct(samples: number[], p: number): number {
  if (samples.length === 0) return NaN
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

interface Budget { name: string; limit: number; actual: number; unit: string; ok: boolean; note: string }
const budgets: Budget[] = []
function check(name: string, actual: number, limit: number, unit: string, note: string): void {
  budgets.push({ name, limit, actual, unit, ok: actual <= limit, note })
}

/* ------------------------------------------------------------- 1. bundle */

/** Distinctive strings that survive minification, so "the join screen does not
 *  load CodeMirror" is checkable instead of hoped for. Each is an internal
 *  message the library cannot drop, and each was verified to appear in exactly
 *  one built chunk — a class name like `cm-content` would not do, because the
 *  app's own theme and querySelector calls mention it without importing a byte
 *  of CodeMirror. */
const LIB_MARKERS: Record<string, string> = {
  codemirror: 'Calls to EditorView.update are not allowed',
  marked: 'markedjs',
  dompurify: 'dompurify',
  ansi_up: 'ansi-bright',
  yjs: 'Yjs was already imported',
  svelte: 'svelte.dev/e/',
  /*
   * pdf.js — полтора мегабайта, из них 139 КБ gzip в чанке и 365 КБ в воркере
   * рядом. Маркер здесь именно затем, чтобы один невнимательный статический
   * импорт не положил эти байты в блокирующий граф экрана входа: без строки
   * гейт про pdf.js просто не знает и промолчит.
   */
  pdfjs: 'PDFWorker',
}

/** Only these belong on the join screen; the rest are notebook-only weight. */
const ENTRY_ALLOWED_LIBS = new Set(['svelte', 'yjs'])

/**
 * blocking — the entry script and everything it *statically* imports, plus any
 *            render-blocking stylesheet. Splitting a static import into its own
 *            chunk improves caching and parallelism, but the module graph still
 *            has to be downloaded and executed before the app boots, so it is
 *            counted here however many files it arrives in.
 * preload   — modulepreloaded but outside that static graph. On '/' that is a
 *             warming hint for a route nobody has reached yet; on /s/:id the
 *             inline script in <head> asks for these immediately, so on a
 *             seminar link they are part of the first fetch, not a saving.
 * lazy      — reachable only through a dynamic import(): fetched on demand.
 */
type Load = 'blocking' | 'preload' | 'lazy'

interface Chunk { file: string; raw: number; gzip: number; load: Load; libs: string[] }
interface BundleReport {
  dir: string
  chunks: Chunk[]
  /** Files vite copied rather than bundled — public/ passes straight through.
   *  No import edge leads to them, so the module graph above cannot see them,
   *  and the pdf.js worker alone is bigger than any chunk in it. */
  extras: Array<{ file: string; raw: number; gzip: number }>
  totalRaw: number
  totalGzip: number
  blockingRaw: number
  blockingGzip: number
  preloadGzip: number
  entryFiles: string[]
  blockingLibs: string[]
  preloadLibs: string[]
  htmlBytes: number
  strays: string[]
  thirdParty: string[]
  preloadedCritical: number
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const attrOf = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] ?? ''

/** Tags outside <noscript>, which is a fallback the browser never fetches. */
function tagsIn(html: string): Array<{ kind: string; tag: string }> {
  return [...html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '').matchAll(/<(script|link)\b([^>]*)>/gi)]
    .map((m) => ({ kind: m[1].toLowerCase(), tag: m[2] }))
}

interface HtmlRefs {
  /** Module scripts: the roots of the critical path. */
  scripts: string[]
  /** Stylesheets that hold up the first frame (media="print" tricks excluded). */
  blockingSheets: string[]
  /** modulepreload / preload hints, plus stylesheets parked off the critical path. */
  hints: string[]
}

/** What index.html asks for, by tag — "referenced" is not one thing: a plain
 *  stylesheet blocks the first frame, the same stylesheet on media="print" with
 *  an onload flip does not, and a modulepreload is only ever a hint. */
function htmlRefs(html: string): HtmlRefs {
  const refs: HtmlRefs = { scripts: [], blockingSheets: [], hints: [] }
  for (const { kind, tag } of tagsIn(html)) {
    const url = kind === 'script' ? attrOf(tag, 'src') : attrOf(tag, 'href')
    if (!url.startsWith('/assets/')) continue
    if (kind === 'script') { refs.scripts.push(url); continue }
    const rel = attrOf(tag, 'rel').toLowerCase()
    const media = attrOf(tag, 'media').toLowerCase()
    const deferred = media !== '' && media !== 'all' && media !== 'screen'
    /*
     * The app stylesheet is the exception media="print" usually rules out:
     * vite parks it off the critical path, but main.ts holds the loading slab
     * up until that exact sheet has applied (it finds it by this attribute),
     * so the join screen does not exist until it lands. Calling it a hint made
     * the harness blind to the only file the first frame really waits on.
     */
    const heldForFirstPaint = /\bdata-colloq-css\b/i.test(tag)
    if (rel.includes('stylesheet') && (!deferred || heldForFirstPaint)) refs.blockingSheets.push(url)
    else refs.hints.push(url)
  }
  /*
   * Preloads written by a script, not by a tag.
   *
   * The first-paint plugin appends an inline <script> that modulepreloads the
   * editor and renderer chunks when the path starts with /s/ — that is, on
   * every seminar link a student ever opens. Read by tag alone those chunks
   * looked lazy, and the harness printed "only on dynamic import()" about a
   * quarter-megabyte that goes out on the wire at once. The literals are plain
   * "/assets/*.js" strings in a JSON array, so lift them out of the script.
   */
  const inline = html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '')
  for (const block of inline.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const ref of block[1].matchAll(/["'](\/assets\/[^"']+\.(?:js|mjs|css))["']/g)) {
      refs.hints.push(ref[1])
    }
  }
  refs.hints = [...new Set(refs.hints)]
  return refs
}

/** Static import edges out of one built chunk. `import("./x.js")` is deliberately
 *  excluded: a dynamic import is the whole difference between code that ships on
 *  the join screen and code that does not. */
function staticImports(file: string, code: string): string[] {
  const out: string[] = []
  const dir = file.slice(0, file.lastIndexOf('/'))
  // `from"./x.js"` covers import and re-export; `import"./x.js"` is a bare
  // side-effect import. Neither form can match `import(` — that needs a paren.
  for (const re of [/\bfrom\s*["'](\.[^"']+)["']/g, /\bimport\s*["'](\.[^"']+)["']/g]) {
    for (const m of code.matchAll(re)) out.push(new URL(m[1], `file://${dir}/`).pathname)
  }
  return [...new Set(out)]
}

/** Requests to another origin that sit on the critical path: each one costs a
 *  DNS lookup, a TLS handshake and a round trip to a host you do not control,
 *  before your own CSS or JS can apply. */
function thirdPartyBlocking(html: string): string[] {
  const hosts: string[] = []
  for (const { kind, tag } of tagsIn(html)) {
    const url = kind === 'script' ? attrOf(tag, 'src') : attrOf(tag, 'href')
    if (!/^https?:\/\//i.test(url)) continue
    const rel = attrOf(tag, 'rel').toLowerCase()
    // preconnect/dns-prefetch are hints, not requests for bytes.
    if (kind === 'link' && !rel.includes('stylesheet')) continue
    const media = attrOf(tag, 'media').toLowerCase()
    if (media !== '' && media !== 'all' && media !== 'screen') continue
    try { hosts.push(new URL(url).host) } catch { /* unparseable href, ignore */ }
  }
  return [...new Set(hosts)]
}

function bundle(): BundleReport | null {
  const indexPath = join(DIST, 'index.html')
  const assetsDir = join(DIST, 'assets')
  if (!existsSync(indexPath) || !existsSync(assetsDir)) return null

  const html = readFileSync(indexPath, 'utf8')
  const refs = htmlRefs(html)

  const code = new Map<string, string>()
  const chunks: Chunk[] = []
  for (const full of walk(assetsDir)) {
    const buf = readFileSync(full)
    const rel = '/' + relative(DIST, full).split(/[\\/]/).join('/')
    // Markers are searched in script only: a stylesheet can name a library's
    // classes without carrying any of its code.
    const text = /\.(js|mjs)$/.test(full) ? buf.toString('utf8') : ''
    if (text) code.set(rel, text)
    chunks.push({
      file: rel,
      raw: buf.length,
      // level 9 so the number matches what vite prints and what a server with
      // precompressed assets would actually put on the wire.
      gzip: gzipSync(buf, { level: 9 }).length,
      load: 'lazy',
      libs: Object.entries(LIB_MARKERS).filter(([, m]) => text.includes(m)).map(([k]) => k),
    })
  }

  // The critical path is the entry script plus its transitive *static* imports:
  // vite emits a modulepreload for each of them, which parallelises the fetch
  // but does not take one byte off what must run before the app boots.
  const critical = new Set<string>()
  const queue = [...refs.scripts]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (critical.has(file)) continue
    critical.add(file)
    queue.push(...staticImports(file, code.get(file) ?? ''))
  }
  for (const sheet of refs.blockingSheets) critical.add(sheet)
  const hinted = new Set(refs.hints)
  for (const c of chunks) c.load = critical.has(c.file) ? 'blocking' : hinted.has(c.file) ? 'preload' : 'lazy'
  chunks.sort((a, b) => b.gzip - a.gzip)

  /*
   * Everything else in dist/: the pdf.js worker (bigger than any chunk above)
   * and the fonts. Counting only assets/ made "total on disk" understate the
   * build by 1.6x and left the largest single file the room downloads outside
   * every budget. Kept apart from `chunks` on purpose — these have no import
   * edges, so blocking/preload/lazy would be three wrong answers.
   */
  const extras = walk(DIST)
    .filter((full) => !full.startsWith(assetsDir + '/') && !/\.html?$/i.test(full))
    .map((full) => {
      const buf = readFileSync(full)
      return {
        file: '/' + relative(DIST, full).split(/[\\/]/).join('/'),
        raw: buf.length,
        gzip: gzipSync(buf, { level: 9 }).length,
      }
    })
    .sort((a, b) => b.gzip - a.gzip)

  const blocking = chunks.filter((c) => c.load === 'blocking')
  const preload = chunks.filter((c) => c.load === 'preload')
  const uniq = (cs: Chunk[]) => [...new Set(cs.flatMap((c) => c.libs))].sort()
  return {
    dir: DIST_LABEL,
    chunks,
    extras,
    totalRaw: chunks.reduce((n, c) => n + c.raw, 0) + extras.reduce((n, e) => n + e.raw, 0),
    totalGzip: chunks.reduce((n, c) => n + c.gzip, 0) + extras.reduce((n, e) => n + e.gzip, 0),
    blockingRaw: blocking.reduce((n, c) => n + c.raw, 0),
    blockingGzip: blocking.reduce((n, c) => n + c.gzip, 0),
    preloadGzip: preload.reduce((n, c) => n + c.gzip, 0),
    entryFiles: [...blocking, ...preload].map((c) => c.file),
    blockingLibs: uniq(blocking),
    preloadLibs: uniq(preload),
    htmlBytes: Buffer.byteLength(html),
    thirdParty: thirdPartyBlocking(html),
    // A modulepreload on something the entry statically imports is a waterfall
    // fix, not deferral: worth saying out loud so nobody reads it as a saving.
    preloadedCritical: refs.hints.filter((h) => critical.has(h)).length,
    // Named by index.html but absent from disk: a broken build, worth shouting about.
    strays: [...refs.scripts, ...refs.blockingSheets, ...refs.hints]
      .filter((r) => !chunks.some((c) => c.file === r)),
  }
}

function printBundle(b: BundleReport | null): void {
  say(bold('1. BUNDLE') + dim('  — what the browser downloads before anything happens'))
  if (!b) {
    say(red(`   no build at ${DIST_LABEL} — run: npm run build -w @colloq/web`))
    check('missing build', 1, 0, '', 'a perf gate cannot pass without a build to measure')
    say()
    return
  }

  say(dim(`   ${b.dir} · gzip level 9 · index.html ${kb(b.htmlBytes)}`))
  say(dim('   chunk'.padEnd(42) + 'raw'.padStart(9) + 'gzip'.padStart(9) + '  load'))
  for (const c of b.chunks) {
    const over = c.gzip > MAX_CHUNK_GZIP_KB * 1024
    const row =
      '   ' + c.file.replace('/assets/', '').padEnd(39) +
      kb(c.raw).padStart(9) + kb(c.gzip).padStart(9) +
      '  ' + (c.load === 'blocking' ? c.load : dim(c.load))
    say(over ? red(row + `  ! over ${MAX_CHUNK_GZIP_KB}K gzip`) : row)
  }
  for (const e of b.extras) {
    say(dim('   ' + e.file.replace(/^\//, '').padEnd(39) +
        kb(e.raw).padStart(9) + kb(e.gzip).padStart(9) + '  on demand, outside the graph'))
  }
  const lazyGzip = b.chunks.reduce((n, c) => (c.load === 'lazy' ? n + c.gzip : n), 0)
  const extrasGzip = b.extras.reduce((n, e) => n + e.gzip, 0)
  const blockingCount = b.chunks.filter((c) => c.load === 'blocking').length
  const seminarGzip = b.blockingGzip + b.preloadGzip
  say('   ' + 'total on disk'.padEnd(39) + kb(b.totalRaw).padStart(9) + kb(b.totalGzip).padStart(9))
  say('   ' + bold('before the app can boot'.padEnd(39)) + kb(b.blockingRaw).padStart(9) + bold(kb(b.blockingGzip).padStart(9)) +
      dim(`  ${blockingCount} file(s), entry + static imports`))
  say('   ' + bold('a seminar link fetches at once'.padEnd(39)) + ''.padStart(9) + bold(kb(seminarGzip).padStart(9)) +
      dim('  + what /s/:id modulepreloads: the address a student actually opens'))
  say(dim('   ' + '+ lazy, only on dynamic import()'.padEnd(39) + ''.padStart(9) + kb(lazyGzip).padStart(9) +
      (lazyGzip === 0 ? '  nothing is deferred' : '')))
  if (extrasGzip > 0) {
    say(dim('   ' + '+ on demand, outside the graph'.padEnd(39) + ''.padStart(9) + kb(extrasGzip).padStart(9)))
  }
  if (b.preloadedCritical > 0) {
    say(dim(`   ${b.preloadedCritical} modulepreload hint(s) point at chunks the entry statically imports:` +
        ' the fetches go out in parallel instead of in a waterfall, but none of those bytes are deferred'))
  }

  // The checkable version of "the join screen does not load CodeMirror".
  const verdict = Object.keys(LIB_MARKERS).map((lib) => {
    if (b.blockingLibs.includes(lib)) return ENTRY_ALLOWED_LIBS.has(lib) ? green(`${lib} ✓`) : red(`${lib} SHIPPED`)
    // Not executed before boot, but on /s/:id it is on the wire immediately —
    // saying only "—" here was the harness claiming an absence it did not have.
    if (b.preloadLibs.includes(lib)) return dim(`${lib} preloaded on /s/`)
    return dim(`${lib} —`)
  })
  say('   join screen carries: ' + verdict.join('  '))
  const dead = b.blockingLibs.filter((l) => !ENTRY_ALLOWED_LIBS.has(l))
  if (dead.length) {
    say(dim(`   ${dead.join(', ')} cannot be called by a name field and a button, and still has to load before it`))
  }
  if (b.thirdParty.length) {
    say(dim(`   blocking third-party: ${b.thirdParty.join(', ')} — a DNS lookup, a TLS handshake and a round trip to a host you do not control, before your own CSS applies`))
  }
  if (b.strays.length) say(red(`   index.html references missing files: ${b.strays.join(', ')}`))

  const biggest = b.chunks[0]
  check('largest chunk gzip', biggest ? biggest.gzip / 1024 : 0, MAX_CHUNK_GZIP_KB, 'KB',
    'a ceiling on any one chunk, blocking or not: 1.3s of wifi whenever it is fetched, and one line re-fetches all of it')
  check('blocking payload gzip', b.blockingGzip / 1024, MAX_BLOCKING_GZIP_KB, 'KB',
    'fetched and parsed before the join screen can exist at all')
  check('seminar link first fetch gzip', seminarGzip / 1024, MAX_SEMINAR_FIRST_FETCH_GZIP_KB, 'KB',
    'blocking plus what /s/:id preloads: the bytes the student, not the teacher, waits for')
  check('dead libs on join screen', dead.length, MAX_BLOCKING_DEAD_LIBS, '',
    'notebook-only code in the render-blocking graph: bytes the join screen cannot use')
  const biggestExtra = b.extras[0]
  if (biggestExtra) {
    check('largest file outside the graph', biggestExtra.gzip / 1024, MAX_ONDEMAND_ASSET_GZIP_KB, 'KB',
      `${biggestExtra.file} — no import leads to it, so no budget above ever sees it`)
  }
  say()
}

/* ---------------------------------------------------------------- 2. api */

interface ApiRow { label: string; n: number; p50: number; p95: number; worst: number; refused: number }

async function timedJson(url: string, init?: RequestInit): Promise<{ ms: number; body: any; status: number }> {
  const t0 = performance.now()
  const res = await fetch(url, init)
  const text = await res.text() // read to completion: a header-only timing is a lie
  const elapsed = performance.now() - t0
  let body: any = null
  try { body = JSON.parse(text) } catch { /* non-JSON is fine, we only timed it */ }
  return { ms: elapsed, body, status: res.status }
}

/**
 * Creating a seminar is staff-only, so every request that makes one carries the
 * staff cookie (see signInAsStaff). The join calls do not need it and are not
 * harmed by it: what is being timed is the path a teacher's browser really
 * walks, cookie and all.
 */
let staffCookie = ''
/** Seminar ids this run created, so it can take them away again. */
const madeHere: string[][] = []

async function cleanUpSeminars(): Promise<void> {
  const ids = madeHere.flat()
  if (ids.length === 0) return
  /*
   * DELETE /api/admin/seminars/:id is owner-only. On an instance with
   * OPEN_SEMINAR_CREATION=true this run can make twenty-one seminars without a
   * cookie and then have nothing to remove them with — and it used to return
   * here in silence, leaving them in somebody's panel unannounced. Say it
   * loudly and name them: a mess somebody has to clean by hand beats a mess
   * nobody knows about.
   */
  if (!staffCookie) {
    console.log(`\ncould not clean up ${ids.length} seminar(s) this run created — not signed in as staff, and deleting one is owner-only:\n  ${ids.join('\n  ')}`)
    return
  }
  const left: string[] = []
  for (const id of ids) {
    const res = await fetch(`${BASE}/api/admin/seminars/${id}`, {
      method: 'DELETE',
      headers: { cookie: staffCookie },
    }).catch(() => null)
    if (!res?.ok) left.push(id)
  }
  console.log(`\ncleaned up ${ids.length - left.length}/${ids.length} seminars this run created`)
  if (left.length > 0) console.log(`  still there:\n  ${left.join('\n  ')}`)
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(staffCookie ? { cookie: staffCookie } : {}) },
  body: JSON.stringify(body),
})

/**
 * The same door a human uses: read <DATA_DIR>/setup-token off the disk and
 * spend it on its second job — signing in as the founding owner. Returns the
 * reason it could not, so a missing token reads as "perf could not sign in"
 * rather than as a mysteriously broken sync path.
 *
 * An unclaimed instance is refused rather than claimed. Claiming it would make
 * the harness its owner — "Perf Harness <perf@colloq.test>" in the panel — and
 * would take the first-run screen away from the teacher the instance is for,
 * which is a lot to do to somebody for the sake of a timing table.
 */
async function signInAsStaff(): Promise<string | null> {
  const tokenFile = resolve(process.env.DATA_DIR ?? join(ROOT, 'data'), 'setup-token')
  let token: string
  try {
    token = readFileSync(tokenFile, 'utf8').trim()
  } catch {
    return `no setup token at ${tokenFile}`
  }
  try {
    const state = await (await fetch(`${BASE}/api/admin/state`)).json() as { claimed?: boolean }
    if (!state?.claimed) return 'nobody has claimed this instance yet — claim it in /admin and run again'
    const res = await fetch(`${BASE}/api/admin/signin/token`, post({ token }))
    if (!res.ok) return `sign-in refused (${res.status})`
    staffCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    return staffCookie.startsWith('colloq_staff=') ? null : 'no staff cookie was issued'
  } catch (err) {
    return err instanceof Error ? err.message : 'sign-in failed'
  }
}

async function api(): Promise<ApiRow[]> {
  const rows: ApiRow[] = []
  /*
   * Every row carries how many of its twenty calls were refused. Timing a 403
   * is timing nothing: a refusal is the *fastest* response an endpoint has, so
   * without this the table printed 1.2 ms for POST /api/sessions and both
   * latency budgets went green on a request the server never did. Section 4
   * has said the same thing about a non-200 since it was written.
   */
  const run = async (label: string, fn: (i: number) => Promise<{ ms: number; status: number }>) => {
    const samples: number[] = []
    let refused = 0
    for (let i = 0; i < API_N; i++) {
      const r = await fn(i)
      samples.push(r.ms)
      if (r.status < 200 || r.status >= 300) refused++
    }
    rows.push({
      label, n: API_N, refused,
      p50: pct(samples, 50), p95: pct(samples, 95), worst: Math.max(...samples),
    })
  }

  await run('GET  /api/health', () => timedJson(`${BASE}/api/health`))

  const created: string[] = []
  madeHere.push(created)
  await run('POST /api/sessions', async (i) => {
    const r = await timedJson(`${BASE}/api/sessions`, post({ name: `perf ${Date.now()}-${i}` }))
    if (r.body?.session?.id) created.push(r.body.session.id)
    return r
  })

  // Everything below hangs off one session, the way a real seminar does.
  const sid = created[0]
  if (!sid) return rows

  let participantId: string | undefined
  await run('POST /api/sessions/:id/join', async () => {
    // Reuse the participant id after the first hit: a rejoin is the common case
    // (page reload), and it keeps the run from spraying rows into the DB.
    const r = await timedJson(`${BASE}/api/sessions/${sid}/join`, post({ name: 'perf', participantId }))
    participantId ??= r.body?.participant?.id
    return r
  })
  await run('GET  /api/sessions/:id', () => timedJson(`${BASE}/api/sessions/${sid}`))

  return rows
}

function printApi(rows: ApiRow[]): void {
  say(bold('2. API') + dim(`  — REST on the path from link click to notebook (n=${API_N} each)`))
  say(dim('   endpoint'.padEnd(42) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'worst'.padStart(10)))
  for (const r of rows) {
    const row = '   ' + r.label.padEnd(39) + ms(r.p50).padStart(9) + ms(r.p95).padStart(9) + ms(r.worst).padStart(10)
    say(r.refused > 0 ? red(row + `  ! ${r.refused}/${r.n} refused, so these are not timings of the work`) : row)
  }
  const worstP50 = Math.max(...rows.map((r) => r.p50))
  const worstAll = Math.max(...rows.map((r) => r.worst))
  check('api p50 (slowest endpoint)', worstP50, MAX_API_P50_MS, 'ms',
    'a blocking call added to the join path shows up here first')
  check('api worst of 20', worstAll, MAX_API_WORST_MS, 'ms', 'catches a cold-start stall on the first request')
  check('api calls refused', rows.reduce((n, r) => n + r.refused, 0), 0, '',
    'a refusal is the fastest answer an endpoint has: scoring one is scoring nothing')
  say()
}

/* --------------------------------------------------------------- 3. sync */

interface SyncReport { n: number; p50: number; p95: number; min: number; max: number; delivered: number; expected: number; allRemote: boolean }

/** Two real clients, one session, one Y.Text: A inserts, B observes, we time it. */
async function sync(): Promise<SyncReport | { error: string }> {
  const wsBase = BASE.replace(/^http/, 'ws')
  const j = async (url: string, init?: RequestInit) => (await fetch(url, init)).json() as any

  const created = await j(`${BASE}/api/sessions`, post({ name: `perf sync ${Date.now()}` }))
  const sid = created?.session?.id
  if (!sid) return { error: 'could not create a session' }
  madeHere.push([sid])
  const A = await j(`${BASE}/api/sessions/${sid}/join`, post({ name: 'perf-A', hostToken: created.hostToken }))
  const B = await j(`${BASE}/api/sessions/${sid}/join`, post({ name: 'perf-B' }))

  const open = (token: string) => {
    const doc = new Y.Doc()
    // Root types must exist before remote updates land or Yjs cannot tell what
    // shape they are — same reason SessionState declares them in its constructor.
    doc.getArray('cells'); doc.getMap('meta')
    const provider = new WebsocketProvider(`${wsBase}/collab`, sid, doc, {
      params: { token }, WebSocketPolyfill: WS as any, connect: true,
    })
    return { doc, provider }
  }
  const a = open(A.token)
  const b = open(B.token)

  const until = async (label: string, fn: () => boolean, limit = 20_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < limit) {
      if (fn()) return true
      await sleep(25)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  const cleanup = () => { a.provider.destroy(); b.provider.destroy() }

  try {
    await until('both clients to sync', () => (a.provider as any).synced && (b.provider as any).synced)

    const id = 'perf_' + Math.random().toString(36).slice(2, 10)
    const cell = new Y.Map<any>()
    cell.set('id', id)
    cell.set('type', 'code')
    cell.set('source', new Y.Text())
    cell.set('outputs', new Y.Array())
    cell.set('state', 'idle'); cell.set('execCount', null); cell.set('runBy', null)
    a.doc.transact(() => a.doc.getArray<Y.Map<any>>('cells').push([cell]))

    const findOn = (doc: Y.Doc) =>
      doc.getArray<Y.Map<any>>('cells').toArray().find((c) => c.get('id') === id)
    await until('B to receive the cell', () => Boolean(findOn(b.doc)))

    const textA = findOn(a.doc)!.get('source') as Y.Text
    const textB = findOn(b.doc)!.get('source') as Y.Text

    let pending: ((t: number) => void) | null = null
    // A local edit would resolve these promises in microseconds and make the
    // whole section a lie, so record where each observed change came from:
    // remote updates arrive with the provider as the transaction origin.
    let allRemote = true
    textB.observe((_event, transaction) => {
      if (transaction.origin !== b.provider) allRemote = false
      const resolve = pending
      pending = null
      resolve?.(performance.now())
    })

    const samples: number[] = []
    for (let i = 0; i < SYNC_N + SYNC_WARMUP; i++) {
      const arrived = new Promise<number>((res, rej) => {
        pending = res
        setTimeout(() => { if (pending === res) { pending = null; rej(new Error('edit never reached B')) } }, 10_000)
      })
      const t0 = performance.now()
      textA.insert(textA.length, 'x')
      const t1 = await arrived
      if (i >= SYNC_WARMUP) samples.push(t1 - t0) // first few carry connection warmup
      await sleep(5) // back-to-back inserts would coalesce into one update frame
    }

    const expected = textA.length
    const delivered = textB.length
    cleanup()
    return {
      n: samples.length,
      p50: pct(samples, 50), p95: pct(samples, 95),
      min: Math.min(...samples), max: Math.max(...samples),
      delivered, expected, allRemote,
    }
  } catch (err) {
    cleanup()
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function printSync(r: SyncReport | { error: string }): void {
  say(bold('3. SYNC') + dim('  — A types, B sees it: the "does typing feel local" number'))
  if ('error' in r) {
    say(red(`   could not measure: ${r.error}`))
    check('sync path broken', 1, 0, '', 'the product is realtime; an unmeasurable sync path is a failure')
    say()
    return
  }
  say(dim('   path'.padEnd(42) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'worst'.padStart(10)))
  say('   ' + `A → server → B (${r.n} edits)`.padEnd(39) + ms(r.p50).padStart(9) + ms(r.p95).padStart(9) + ms(r.max).padStart(10))
  say(dim(`   best ${ms(r.min)} · one frame at 60fps is 16.7ms`))
  const intact = r.delivered === r.expected && r.allRemote
  say((intact ? dim : red)(`   verified: ${r.delivered}/${r.expected} characters arrived at B` +
      (r.allRemote ? ', every one over the wire' : ', SOME LOCALLY — timing is not a round trip')))
  check('sync p50', r.p50, MAX_SYNC_P50_MS, 'ms', 'a keystroke must echo inside one animation frame')
  check('sync p95', r.p95, MAX_SYNC_P95_MS, 'ms', 'the tail is what people perceive as a stutter')
  // A fast number over a lossy channel is worse than a slow one: never let the
  // harness report speed it cannot show was correct.
  check('characters lost in sync', r.expected - r.delivered, 0, '',
    'a dropped CRDT update is not a performance win')
  say()
}

/* ------------------------------------------------------------ 4. network */

interface NetRow { label: string; url: string; status: number; ttfbP50: number; ttfbWorst: number; bytes: number; encoding: string }

/** Raw http so we see transferred bytes and the encoding: fetch() decodes and
 *  hides both. A fresh agent per request means no keep-alive reuse — an empty
 *  cache, a new visitor, the actual first-load cost. */
function rawGet(url: string): Promise<{ ttfb: number; total: number; bytes: number; encoding: string; status: number }> {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  return new Promise((resolvePromise, reject) => {
    const t0 = performance.now()
    const req = mod.request(
      u,
      {
        method: 'GET',
        agent: new mod.Agent({ keepAlive: false }),
        headers: { 'accept-encoding': 'gzip, deflate, br', 'cache-control': 'no-cache', accept: '*/*' },
      },
      (res) => {
        const ttfb = performance.now() - t0
        let bytes = 0
        res.on('data', (c: Buffer) => { bytes += c.length })
        res.on('end', () => resolvePromise({
          ttfb,
          total: performance.now() - t0,
          bytes,
          encoding: String(res.headers['content-encoding'] ?? 'identity'),
          status: res.statusCode ?? 0,
        }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function network(entryAsset?: string): Promise<NetRow[]> {
  const targets: Array<{ label: string; url: string }> = [{ label: 'GET /', url: `${BASE}/` }]
  // The document is 1 KB; the entry chunk is where compression is worth money.
  if (entryAsset) targets.push({ label: `GET ${entryAsset}`, url: `${BASE}${entryAsset}` })

  const rows: NetRow[] = []
  for (const t of targets) {
    const samples: number[] = []
    let last = await rawGet(t.url)
    for (let i = 0; i < NET_N; i++) { last = await rawGet(t.url); samples.push(last.ttfb) }
    rows.push({ label: t.label, url: t.url, status: last.status, ttfbP50: pct(samples, 50), ttfbWorst: Math.max(...samples), bytes: last.bytes, encoding: last.encoding })
  }
  return rows
}

function printNetwork(rows: NetRow[], b: BundleReport | null): void {
  say(bold('4. NETWORK') + dim(`  — empty cache, fresh connection (n=${NET_N})`))
  say(dim('   request'.padEnd(42) + 'ttfb p50'.padStart(10) + 'worst'.padStart(9) + 'on wire'.padStart(10) + '  encoding'))
  for (const r of rows) {
    const identity = r.encoding === 'identity'
    say('   ' + `${r.label} (${r.status})`.padEnd(39) + ms(r.ttfbP50).padStart(10) + ms(r.ttfbWorst).padStart(9) +
        kb(r.bytes).padStart(10) + '  ' + (identity ? red('identity — uncompressed') : green(r.encoding)))
  }
  const doc = rows.find((r) => r.label === 'GET /')
  const asset = rows.find((r) => r !== doc)
  if (asset && b) {
    const onDisk = b.chunks.find((c) => asset.url.endsWith(c.file))
    if (onDisk && asset.bytes >= onDisk.raw) {
      say(dim(`   ${kb(onDisk.gzip)} of that transfer is available for free: the file gzips to ${((1 - onDisk.gzip / onDisk.raw) * 100).toFixed(0)}% smaller`))
    }
  }
  /*
   * A server started without STATIC_DIR answers '/' with a 0.1 KB 404, which is
   * fast and small and passes both budgets below while measuring nothing at
   * all. Refusing to score a non-200 is the difference between a harness and a
   * decoration.
   */
  if (doc) check('GET / status', doc.status, 200, '', 'a 404 here is a server with no STATIC_DIR: fast, tiny, and not the app')
  if (doc && doc.status !== 200) {
    say(red(`   GET / answered ${doc.status}, so there is no document to score`))
    say(dim('   start the server with STATIC_DIR=web/dist — docker compose sets it for you'))
  } else if (doc) {
    check('document ttfb p50', doc.ttfbP50, MAX_TTFB_P50_MS, 'ms', 'the shell must not wait on I/O')
    check('document transfer', doc.bytes / 1024, MAX_HTML_TRANSFER_KB, 'KB',
      'an inlined shell that fits the first packet burst costs no extra round trip')
  }
  say()
}

/* ----------------------------------------------------------------- main */

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const startedAt = new Date().toISOString()
say()
say(bold('  colloq perf') + dim(`  ${startedAt}  ·  ${BASE}`))
say()

const b = bundle()
printBundle(b)

const up = await serverUp()
let apiRows: ApiRow[] = []
let syncReport: SyncReport | { error: string } = { error: 'not run' }
let netRows: NetRow[] = []

if (!up) {
  say(bold('2-4. API / SYNC / NETWORK') + dim(' — skipped'))
  say(red(`   no server answering at ${BASE}/api/health`))
  say(dim('   start one with: npm run dev  (or npm start after npm run build)'))
  say(dim('   bundle budgets above still apply; latency budgets were not evaluated.'))
  say()
} else {
  const signInProblem = await signInAsStaff()
  /*
   * Skipped, not faked — the same rule as a server that does not answer. The
   * sections used to run anyway: POST /api/sessions came back 403 in 1.2 ms,
   * the table printed it as a timing, and both latency budgets went green on a
   * request nobody served.
   */
  if (signInProblem) {
    say(bold('2-3. API / SYNC') + dim(' — skipped'))
    say(red(`   staff sign-in: ${signInProblem}`))
    say(dim('   POST /api/sessions is staff-only, so neither section has anything real to measure.'))
    say(dim('   The NETWORK section below needs no cookie and still runs.'))
    say()
  } else {
    apiRows = await api()
    printApi(apiRows)
    syncReport = await sync()
    printSync(syncReport)
  }
  netRows = await network(b?.entryFiles.find((f) => f.endsWith('.js')))
  printNetwork(netRows, b)
}

const failed = budgets.filter((x) => !x.ok)
const num = (v: number, unit: string) =>
  (unit === '' || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(unit === 'KB' ? 1 : 2)) + unit
say(bold('BUDGETS'))
const labelWidth = Math.max(...budgets.map((x) => `${x.name} ≤ ${num(x.limit, x.unit)}`.length)) + 2
for (const x of budgets) {
  const label = `${x.name} ≤ ${num(x.limit, x.unit)}`
  say('   ' + (x.ok ? green('pass') : red('FAIL')) + '  ' + label.padEnd(labelWidth) +
      num(x.actual, x.unit).padStart(9) + dim('   ' + x.note))
}
say()
say(failed.length
  ? red(`  ${failed.length} budget${failed.length === 1 ? '' : 's'} breached: ${failed.map((f) => f.name).join(', ')}`)
  : green('  all budgets green'))
say()

flush()

if (JSON_MODE) {
  console.log(JSON.stringify({
    startedAt,
    base: BASE,
    serverUp: up,
    bundle: b && {
      dir: b.dir,
      totalRaw: b.totalRaw, totalGzip: b.totalGzip,
      blockingRaw: b.blockingRaw, blockingGzip: b.blockingGzip, preloadGzip: b.preloadGzip,
      entryFiles: b.entryFiles,
      blockingLibs: b.blockingLibs, preloadLibs: b.preloadLibs,
      htmlBytes: b.htmlBytes,
      thirdParty: b.thirdParty,
      preloadedCritical: b.preloadedCritical,
      chunks: b.chunks,
      extras: b.extras,
    },
    api: apiRows,
    sync: syncReport,
    network: netRows,
    budgets,
    ok: failed.length === 0,
  }, null, 2))
}

/*
 * Everything this harness made, it removes. Twenty-one seminars a run is
 * nothing on its own and a panel nobody can read after a morning of them.
 */
await cleanUpSeminars()

// Explicit: live websockets and http agents would otherwise hold the loop open.
process.exit(failed.length === 0 ? 0 : 1)
