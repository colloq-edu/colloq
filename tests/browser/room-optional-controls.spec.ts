import { test, expect, type Page, type Route } from '@playwright/test'
import { SETUP_TOKEN } from './fixture'

async function join(page: Page, name = 'Optional controls reader'): Promise<void> {
  await page.goto('/s/browser-shared')
  const form = page.locator('#join-name')
  const editor = page.locator('[data-cell-id="browser-shared"] .cm-content')
  await expect(form.or(editor)).toBeVisible()
  if (await form.isVisible()) {
    await form.fill(name)
    await page.getByRole('button', { name: 'Join the class', exact: true }).click()
  }
  await expect(editor).toBeVisible()
}

test('a text file loads its action bar on opening and keeps the editor through a language change', async ({ page }) => {
  expect((await page.request.post('/api/admin/signin/token', { data: { token: SETUP_TOKEN } })).ok()).toBe(true)
  let pending: Route | undefined
  await page.route(/\/assets\/FileBar-[^/]+\.js$/, route => { pending = route })
  await join(page)
  expect(pending).toBeUndefined()
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('colloq.identity.v1')!)['browser-shared'].token)
  const headers = { authorization: `Bearer ${token}` }
  expect((await page.request.post('/api/sessions/browser-shared/files', {
    headers, multipart: { file: { name: 'optional-controls.py', mimeType: 'text/x-python', buffer: Buffer.from('print("optional")\n') } },
  })).ok()).toBe(true)
  try {
    await page.getByRole('region', { name: 'Class files' }).getByRole('button', { name: /^optional-controls\s*\.py$/ }).click()
    await expect.poll(() => Boolean(pending), { timeout: 3000 }).toBe(true)
    await pending!.continue()
    const run = page.getByRole('button', { name: 'Run', exact: true })
    await expect(run).toBeEnabled()
    await expect(run).toHaveAttribute('title', /optional-controls\.py/)
    const editor = page.locator('.cm-content[contenteditable="true"]').filter({ hasText: 'print("optional")' })
    await expect(editor).toBeVisible()
    await editor.evaluate(element => element.setAttribute('data-file-stayed', 'yes'))
    expect((await page.request.patch('/api/admin/instance/settings', { data: { language: 'ru' } })).ok()).toBe(true)
    await expect(page.getByRole('button', { name: 'Запустить', exact: true })).toBeVisible()
    await expect(editor).toHaveAttribute('data-file-stayed', 'yes')
    expect(await page.locator('body').innerText()).not.toMatch(/\b(?:room|common)\.[a-zA-Z_][\w.]*/)
  } finally {
    await page.request.patch('/api/admin/instance/settings', { data: { language: 'en' } })
    await page.request.delete('/api/sessions/browser-shared/file?path=optional-controls.py', { headers })
  }
})

test('the first removal gesture survives a slow optional menu and cancel preserves the participant', async ({ page, browser }) => {
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  try {
    await join(student, 'Menu participant')
    expect((await page.request.post('/api/admin/signin/token', { data: { token: SETUP_TOKEN } })).ok()).toBe(true)
    let pending: Route | undefined
    await page.route(/\/assets\/BanMenu-[^/]+\.js$/, route => { pending = route })
    await join(page, 'Menu teacher')
    const person = page.getByRole('region', { name: 'Who is in the room' }).getByText('Menu participant', { exact: true })
    await expect(person).toBeVisible()
    expect(pending).toBeUndefined()
    await person.click({ button: 'right' })
    await expect.poll(() => Boolean(pending), { timeout: 3000 }).toBe(true)
    await pending!.continue()
    await page.getByRole('menuitem', { name: 'Remove from class…', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Menu participant')
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(student.locator('[data-cell-id="browser-shared"] .cm-content[contenteditable="true"]')).toBeVisible()
    await person.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove from class…', exact: true }).click()
    let ban: Route | undefined
    await page.route('**/api/sessions/browser-shared/bans', route => {
      if (route.request().method() === 'POST') ban = route
      else void route.continue()
    })
    await dialog.getByRole('button', { name: 'Remove from class', exact: true }).click()
    await expect.poll(() => Boolean(ban)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
    await ban!.fulfill({ status: 403, json: { error: 'Fixture ban refused' } })
    await expect(dialog.getByRole('alert')).toContainText('Fixture ban refused')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(student.locator('[data-cell-id="browser-shared"] .cm-content[contenteditable="true"]')).toBeVisible()
    expect(await page.locator('body').innerText()).not.toMatch(/\b(?:room|common)\.[a-zA-Z_][\w.]*/)
  } finally {
    await studentContext.close()
  }
})

test('canceling a pending removal menu prevents its late module from opening it', async ({ page, browser }) => {
  const studentContext = await browser.newContext()
  try {
    await join(await studentContext.newPage(), 'Menu participant')
    expect((await page.request.post('/api/admin/signin/token', { data: { token: SETUP_TOKEN } })).ok()).toBe(true)
    let pending: Route | undefined
    await page.route(/\/assets\/BanMenu-[^/]+\.js$/, route => { pending = route })
    await join(page, 'Menu teacher')
    const person = page.getByRole('region', { name: 'Who is in the room' }).getByText('Menu participant', { exact: true })
    await person.click({ button: 'right' })
    await expect.poll(() => Boolean(pending)).toBe(true)
    await page.keyboard.press('Escape')
    await pending!.continue()
    await expect(page.getByRole('menu')).toHaveCount(0)
    // Reopen without a second download. A stale completion cannot reset the
    // pending/mounted ownership of Escape or discard this new request.
    await person.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Remove from class…', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  } finally {
    await studentContext.close()
  }
})

test('a guest teacher gets the deferred explanation in both languages and can dismiss it', async ({ page, request }) => {
  await page.route('**/api/sessions/browser-shared/join', async route => {
    const response = await route.fetch()
    const body = await response.json()
    // Keep real participant credentials and permission rules; only supply the
    // guest-teacher context that this disposable room does not normally have.
    await route.fulfill({ response, json: { ...body, staffGuest: { course: null, teachers: ['Guest mentor'] } } })
  })
  let pending: Route | undefined
  await page.route(/\/assets\/StaffGuestStrip-[^/]+\.js$/, route => { pending = route })
  await join(page)
  await expect.poll(() => Boolean(pending)).toBe(true)
  await pending!.continue()
  const explanation = page.getByRole('status').filter({ hasText: 'Guest mentor' })
  await expect(explanation).toContainText('You are here as a participant.')
  await explanation.evaluate(element => element.setAttribute('data-guest-stayed', 'yes'))
  expect((await request.post('/api/admin/signin/token', { data: { token: SETUP_TOKEN } })).ok()).toBe(true)
  try {
    expect((await request.patch('/api/admin/instance/settings', { data: { language: 'ru' } })).ok()).toBe(true)
    await expect(explanation).toContainText('Вы здесь как участник.')
    await expect(explanation).toHaveAttribute('data-guest-stayed', 'yes')
    await explanation.getByRole('button', { name: 'Понятно', exact: true }).click()
    await expect(explanation).toHaveCount(0)
    expect(await page.locator('body').innerText()).not.toMatch(/\b(?:room|common)\.[a-zA-Z_][\w.]*/)
  } finally {
    await request.patch('/api/admin/instance/settings', { data: { language: 'en' } })
  }
})

test('a failed removal menu keeps a focused cancel action after retry', async ({ page, browser }, testInfo) => {
  const studentContext = await browser.newContext()
  try {
    await join(await studentContext.newPage(), 'Menu participant')
    expect((await page.request.post('/api/admin/signin/token', { data: { token: SETUP_TOKEN } })).ok()).toBe(true)
    await page.route(/\/assets\/BanMenu-[^/]+\.js$/, route => route.abort('failed'))
    await join(page, 'Menu teacher')
    const editor = page.locator('[data-cell-id="browser-shared"] .cm-content[contenteditable="true"]')
    await editor.focus()
    // Dispatch the real row's context-menu handler with a known focused
    // opener. Native pointer-down can blur it before contextmenu is emitted.
    await page.getByRole('region', { name: 'Who is in the room' }).getByText('Menu participant', { exact: true })
      .dispatchEvent('contextmenu', { button: 2, clientX: 100, clientY: 100 })
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load this part of the app.' })).toBeVisible()
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
    await expect(cancel).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('ban-load-failed.png') })
    await page.setViewportSize({ width: 844, height: 320 })
    await cancel.scrollIntoViewIfNeeded()
    const bounds = await cancel.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320)
    await page.screenshot({ path: testInfo.outputPath('ban-load-failed-landscape.png') })
    await cancel.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(editor).toBeFocused()
    await editor.press('ControlOrMeta+End')
    await page.keyboard.insertText('\n# menu failure dismissed')
    await expect(editor).toContainText('# menu failure dismissed')
  } finally {
    await studentContext.close()
  }
})
