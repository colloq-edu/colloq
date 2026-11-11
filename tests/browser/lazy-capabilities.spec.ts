import { test, expect, type Page, type Locator } from '@playwright/test'

const ROOM = 'browser-shared'
const TERMINAL = 'Terminal, kernel log and history'

function editorIn(page: Page): Locator {
  return page.locator(`[data-cell-id="${ROOM}"] .cm-content[contenteditable="true"]`)
}
async function codeIn(editor: Locator): Promise<string> {
  return editor.evaluate(element => Array.from(element.querySelectorAll('.cm-line')).map(line => {
    const copy = line.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.cm-ySelectionCaret').forEach(caret => caret.remove())
    return copy.textContent ?? ''
  }).join('\n'))
}
async function identityIn(page: Page): Promise<string> {
  return page.evaluate(room => JSON.parse(localStorage.getItem('colloq.identity.v1') ?? '{}')[room]?.participantId, ROOM)
}
async function join(page: Page): Promise<Locator> {
  await page.goto(`/s/${ROOM}`)
  await page.locator('#join-name').fill('Reader')
  await page.getByRole('button', { name: 'Join the class', exact: true }).click()
  const editor = editorIn(page)
  await expect(editor).toBeVisible()
  return editor
}
async function edit(page: Page, text: string): Promise<string> {
  const editor = editorIn(page)
  await editor.click()
  await editor.press('ControlOrMeta+End')
  await page.keyboard.insertText(`\n${text}`)
  await expect(editor).toContainText(text)
  return codeIn(editor)
}

/** Actually use the offered recovery, then open the capability and verify both
 * identity and exact edited code. Merely finding a Reload button is not success. */
async function recoverByReload(page: Page, participant: string, expected: string): Promise<void> {
  const error = page.getByRole('alert').filter({ hasText: 'Reload the page.' })
  await expect(error).toBeVisible()
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    error.getByRole('button', { name: 'Reload', exact: true }).click(),
  ])
  const editor = editorIn(page)
  await expect(editor).toBeVisible()
  await expect(page.locator('#join-name')).toHaveCount(0)
  expect(await identityIn(page)).toBe(participant)
  await expect.poll(() => codeIn(editor)).toBe(expected)
  await page.getByRole('button', { name: TERMINAL, exact: true }).click()
  await expect(page.getByRole('button', { name: 'History', exact: true })).toBeVisible()
  await expect.poll(() => codeIn(editor)).toBe(expected)
}

test('a failed capability fetch recovers without losing identity or edits', async ({ page }, testInfo) => {
  let blocked = true, requests = 0
  await page.route(/\/assets\/TerminalDrawer-[^/]+\.js$/, route => {
    requests++
    return blocked ? route.abort('failed') : route.continue()
  })
  const editor = await join(page)
  const participant = await identityIn(page)
  expect(participant).toBeTruthy()
  const expected = await edit(page, '# survives capability retry')
  await page.getByRole('button', { name: TERMINAL, exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load this part of the app.' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('capability-error.png') })
  await page.screenshot({ path: 'scratchpad/room-lazy-failure.png' })
  blocked = false
  const initialRequests = requests
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  const history = page.getByRole('button', { name: 'History', exact: true })
  const reload = page.getByRole('button', { name: 'Reload', exact: true })
  await expect(history.or(reload)).toBeVisible()
  if (await history.isVisible()) {
    // Some browsers retry a failed module fetch in the same document.
    await expect.poll(() => codeIn(editor)).toBe(expected)
    expect(await identityIn(page)).toBe(participant)
    expect(requests).toBeGreaterThan(initialRequests)
  } else {
    // Others cache the failure in their module map and do not issue a second
    // request. Continue editing while the error is visible, then use recovery.
    expect(requests).toBe(initialRequests)
    const fresh = await edit(page, '# also survives after the failed retry')
    await recoverByReload(page, participant, fresh)
    expect(requests).toBeGreaterThan(initialRequests)
  }
  await page.screenshot({ path: 'scratchpad/room-lazy-recovered.png' })
})

test('a cached module evaluation failure recovers by explicit reload with fresh edits intact', async ({ page }) => {
  let requests = 0
  await page.route(/\/assets\/TerminalDrawer-[^/]+\.js$/, route => {
    requests++
    // A fetched module that failed evaluation remains failed in the document's
    // module map. The server has a good copy by the next request.
    return requests === 1
      ? route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("fixture capability evaluation failure")' })
      : route.continue()
  })
  await join(page)
  const participant = await identityIn(page)
  expect(participant).toBeTruthy()
  await edit(page, '# before the cached evaluation failure')
  await page.getByRole('button', { name: TERMINAL, exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load this part of the app.' })).toBeVisible()
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
  expect(requests).toBe(1)
  const expected = await edit(page, '# fresh edit before explicit recovery')
  await recoverByReload(page, participant, expected)
  expect(requests).toBe(2)
})
