/**
 * A fresh browser opening a copied seminar link, through an editable notebook.
 * Use a disposable room: ENTRY_JOIN=1 creates a participant, but sends no chat,
 * changes no cells, and executes no code. Without it only the form is measured.
 *
 * ENTRY_URL=http://localhost:3000/s/fixture ENTRY_JOIN=1 node scripts/entry-perf.mjs
 * ENTRY_PLAYWRIGHT can point to an existing playwright-core installation;
 * ENTRY_CHROME selects Chrome, ENTRY_OUTPUT writes the JSON report to a file.
 * ENTRY_DELAY_MS adds the same artificial delay to every HTTP request for
 * repeatable waterfall comparisons. ENTRY_DWELL_MS models typing a name.
 * ENTRY_KBIT / ENTRY_RTT_MS emulate aggregate download bandwidth and latency
 * in Chromium; for example 256 / 150 is a deliberately constrained link.
 * ENTRY_ASSERT_PRELOAD=1 checks that notebook bytes start after the form and
 * before the join response. Each invocation starts with no cache or identity.
 * ENTRY_READY=notebook also handles seminars whose first viewport is prose.
 * ENTRY_CHECK_SCROLL=1 verifies deferred cells, deep scrolling and selection
 * handoffs in a large disposable notebook after recording the entry timing.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.ENTRY_PLAYWRIGHT ?? 'playwright-core')
const url = new URL(process.env.ENTRY_URL ?? 'http://localhost:3000/s/entry-fixture')
assert.match(url.pathname, /^\/s\/[A-Za-z0-9_-]+\/?$/, 'Use a seminar room URL')
const joining = process.env.ENTRY_JOIN === '1'
const readiness = process.env.ENTRY_READY ?? 'editor'
const requestDelay = Number(process.env.ENTRY_DELAY_MS ?? 0)
const dwell = Number(process.env.ENTRY_DWELL_MS ?? 0)
const network = { kbit: Number(process.env.ENTRY_KBIT ?? 0), latency: Number(process.env.ENTRY_RTT_MS ?? 0) }
const browser = await chromium.launch({
  executablePath: process.env.ENTRY_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  if (requestDelay > 0) await context.route('**/*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, requestDelay))
    await route.continue()
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  if (network.kbit > 0 || network.latency > 0) {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: network.latency,
      downloadThroughput: network.kbit > 0 ? network.kbit * 1000 / 8 : -1,
      uploadThroughput: -1,
    })
  }
  if (process.env.ENTRY_PROFILE) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 10_000 })
    await cdp.send('Profiler.start')
  }
  const failures = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('requestfailed', (request) => failures.push({
    path: new URL(request.url()).pathname,
    error: request.failure()?.errorText,
  }))
  await page.addInitScript(() => {
    const data = window.entryPerformance = { marks: {}, sockets: [], longTasks: [] }
    const mark = (name) => { data.marks[name] ??= performance.now() }
    new PerformanceObserver((list) => {
      data.longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))
    }).observe({ type: 'longtask', buffered: true })
    const observer = new MutationObserver(() => {
      if (!data.marks.form && document.querySelector('#join-name')) mark('form')
      if (!data.marks.shellLeaving && document.querySelector('#boot[data-leaving]')) mark('shellLeaving')
      if (!data.marks.notebook && document.querySelector('[data-cell-id]:not([data-cell-deferred])')) mark('notebook')
      if (!data.marks.editable && document.querySelector('.cm-content[contenteditable="true"]')) mark('editable')
    })
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-leaving', 'contenteditable'] })
    document.addEventListener('submit', () => mark('submit'), true)
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args)
        // Paths only: the query string contains the participant credential.
        const socket = { path: new URL(args[0], location.href).pathname, created: performance.now(), open: null, firstMessage: null }
        data.sockets.push(socket)
        this.addEventListener('open', () => { socket.open = performance.now() })
        this.addEventListener('message', () => { socket.firstMessage ??= performance.now() })
      }
    }
  })
  let failure = null
  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.locator('#join-name').waitFor({ state: 'visible', timeout: 60_000 })
    await page.locator('#boot').waitFor({ state: 'detached', timeout: 60_000 })
    if (joining) {
      await page.locator('#join-name').fill(process.env.ENTRY_NAME ?? 'Entry performance check')
      if (dwell > 0) await page.waitForTimeout(dwell)
      await page.locator('form button[type="submit"]').click()
      const surface = readiness === 'notebook'
        ? page.locator('[data-cell-id]:not([data-cell-deferred]):visible').first()
        : page.locator('.cm-content[contenteditable="true"]').first()
      await surface.waitFor({ state: 'visible', timeout: 60_000 })
      await page.waitForFunction(() => {
        const sockets = window.entryPerformance.sockets
        return ['/collab/', '/control/'].every((prefix) => sockets.some((socket) => socket.path.startsWith(prefix) && socket.open !== null && socket.firstMessage !== null))
      }, null, { timeout: 60_000 })
      if (readiness === 'editor') {
        // Focus proves that the editor is interactive without modifying the room.
        await surface.focus()
        assert.equal(await surface.evaluate((element) => element === document.activeElement), true)
      }
      await page.evaluate(() => { window.entryPerformance.marks.usable = performance.now() })
    }
  } catch (error) {
    failure = error.message
  }
  const measured = await page.evaluate(() => ({
    ...window.entryPerformance,
    roomState: {
      cells: document.querySelectorAll('[data-cell-id]').length,
      deferredCells: document.querySelectorAll('[data-cell-deferred]').length,
      editors: document.querySelectorAll('.cm-content[contenteditable]').length,
      readonlyEditors: document.querySelectorAll('.cm-content[contenteditable="false"]').length,
      editorShims: document.querySelectorAll('.cm-shim').length,
      joinForm: Boolean(document.querySelector('#join-name')),
    },
    navigation: performance.getEntriesByType('navigation').map((entry) => ({ ttfb: entry.responseStart, domContentLoaded: entry.domContentLoadedEventEnd })),
    resources: performance.getEntriesByType('resource').map((entry) => ({
      path: new URL(entry.name).pathname, start: entry.startTime, response: entry.responseStart,
      end: entry.responseEnd, duration: entry.duration, transfer: entry.transferSize,
      encoded: entry.encodedBodySize, decoded: entry.decodedBodySize, protocol: entry.nextHopProtocol,
    })),
  }))
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]))
  const report = { url: url.origin + url.pathname, joining, readiness, requestDelay, dwell, network, ...measured, metrics, failures, failure }
  if (!failure && process.env.ENTRY_CHECK_SCROLL === '1') {
    assert.ok(measured.roomState.deferredCells > 100, 'a large notebook must defer its offscreen cells')
    const ids = await page.locator('[data-cell-slot]:visible').evaluateAll((nodes) => nodes.map((node) => node.dataset.cellSlot))
    const cell = (id) => page.locator(`[data-cell-id="${id}"]:not([data-cell-deferred])`)
    const firstId = ids[0]
    await cell(firstId).evaluate((node) => { window.entryFirstCell = node })
    const deepId = ids[Math.floor(ids.length * 0.75)]
    await page.locator(`[data-cell-id="${deepId}"]`).evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await cell(deepId).waitFor({ state: 'visible', timeout: 60_000 })
    await cell(firstId).evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
    assert.equal(await cell(firstId).evaluate((node) => node === window.entryFirstCell), true, 'scrolling back retains the component')
    // The same event used by keyboard/Shift+Enter handoffs, targeting a cell
    // which has never been visited. No cell is edited or run by this check.
    const selectedId = ids.at(-1)
    await page.evaluate((previous) => window.dispatchEvent(new CustomEvent('colloq:step-cell', {
      detail: { cellId: previous, direction: 1, focus: false },
    })), ids.at(-2))
    await cell(selectedId).waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await cell(selectedId).evaluate((node) => {
      const box = node.getBoundingClientRect()
      return box.top < innerHeight && box.bottom > 0
    }), true, 'selection handoff scrolls the new cell into view')
    report.scrollChecks = { initialCells: ids.length, deepScroll: true, retainedComponent: true, selectionHandoff: true }
  }
  if (process.env.ENTRY_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop')
    await writeFile(process.env.ENTRY_PROFILE, JSON.stringify(profile))
  }
  if (process.env.ENTRY_STORAGE_OUTPUT) {
    // Optional private artifact for reusing the QA participant; never printed.
    await writeFile(process.env.ENTRY_STORAGE_OUTPUT, JSON.stringify(await context.storageState()), { mode: 0o600 })
  }
  if (process.env.ENTRY_OUTPUT) await writeFile(process.env.ENTRY_OUTPUT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  assert.equal(failure, null, 'The entire requested entry flow must finish')
  assert.deepEqual(failures, [])
  if (process.env.ENTRY_ASSERT_PRELOAD === '1') {
    const join = measured.resources.find((entry) => entry.path.endsWith('/join'))
    assert.ok(join, 'A full join is needed to check the request ordering')
    for (const prefix of ['/assets/SessionScreen-', '/assets/codemirror-']) {
      const asset = measured.resources.find((entry) => entry.path.startsWith(prefix) && entry.path.endsWith('.js'))
      assert.ok(asset, `${prefix} was requested`)
      assert.ok(asset.start >= measured.marks.form, `${prefix} must not compete with the cold form`)
      assert.ok(asset.start < join.end, `${prefix} must start before the join response`)
    }
  }
} finally {
  await browser.close()
}
