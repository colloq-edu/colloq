/**
 * Browser regressions for the small entry dictionary and deferred storage.
 * API responses are fixtures: this never creates a real participant or room.
 * ENTRY_URL=http://localhost:3000/s/fixture node --import tsx scripts/entry-language-check.mjs
 * ENTRY_PLAYWRIGHT / ENTRY_CHROME have the same meaning as in entry-perf.mjs.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { messages } from '../shared/i18n.ts'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.ENTRY_PLAYWRIGHT ?? 'playwright-core')
const base = new URL(process.env.ENTRY_URL ?? 'http://localhost:3000/s/fixture')
const room = base.pathname.split('/')[2]
const info = { id: room, name: 'Entry fixture', createdAt: 1_700_000_000_000, finishedAt: null, published: null, course: null, institution: '' }
const browser = await chromium.launch({ executablePath: process.env.ENTRY_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  if (process.env.ENTRY_CASE !== 'missing') for (const locale of ['ru', 'en']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await context.route('**/*', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (request.isNavigationRequest()) {
        const response = await route.fetch()
        const html = (await response.text()).replace(/<meta name="colloq-language"[^>]*>/, '')
          .replace('</head>', `<meta name="colloq-language" content="${locale}"></head>`)
        return route.fulfill({ response, body: html })
      }
      if (path === '/api/instance') return route.fulfill({ json: { language: locale } })
      if (path.endsWith('/participants')) return route.fulfill({ json: { participants: [], online: [] } })
      if (path.endsWith('/join')) return route.fulfill({ status: 403, json: { error: 'Blocked', until: Date.now() + 60_000 } })
      if (path === `/api/sessions/${room}`) return route.fulfill({ json: info })
      return route.continue()
    })
    await page.goto(base.href)
    await page.locator('#join-name').waitFor({ state: 'visible' })
    await page.locator('#boot').waitFor({ state: 'detached' })
    assert.equal(await page.locator('html').getAttribute('lang'), locale)
    await page.getByRole('button', { name: messages['room.ui.854'][locale], exact: true }).click()
    await page.locator('[role="radiogroup"]').waitFor({ state: 'visible' })
    const untranslated = await page.locator('body').evaluate((body) => {
      const copy = [body.innerText, ...Array.from(body.querySelectorAll('[title],[aria-label],[placeholder]')).flatMap((node) => ['title', 'aria-label', 'placeholder'].map((key) => node.getAttribute(key) ?? ''))].join('\n')
      return copy.match(/\b(?:common|room|admin|server|activity)\.(?:ui\.|extra\.|mark\.)?[A-Za-z0-9_.]+/g)
    })
    assert.equal(untranslated, null, `raw translation keys on ${locale} form/picker`)
    await page.locator('#join-name').fill('Fixture')
    await page.locator('form button[type="submit"]').click()
    await page.getByText(messages['room.ui.0'][locale], { exact: true }).waitFor({ state: 'visible' })
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`${locale}: form, dynamic mark labels, and banned entry are translated`)
  }
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(({ room, info }) => {
    localStorage.setItem('colloq.room.v1', JSON.stringify({ [room]: info }))
  }, { room, info })
  let blocked = false
  await context.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/assets/persistence.svelte-')) { blocked = true; return route.abort() }
    if (path === `/api/sessions/${room}`) return route.fulfill({ status: 404, json: { error: 'session not found' } })
    return route.continue()
  })
  await page.goto(base.href)
  await page.getByRole('heading', { name: messages['room.ui.1210'].ru, exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.evaluate((room) => JSON.parse(localStorage.getItem('colloq.room.v1') ?? '{}')[room] ?? null, room), null, 'a deleted room card is forgotten before its optional IndexedDB chunk arrives')
  assert.ok(blocked, 'the failed optional cleanup import was exercised')
  assert.deepEqual(errors, [])
  await context.close()
  console.log('missing room: cached card cleared despite unavailable IndexedDB chunk')
} finally {
  await browser.close()
}
