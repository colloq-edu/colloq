import { test, expect } from '@playwright/test'
import { SETUP_TOKEN } from './fixture'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

for (const locale of ['ru', 'en'] as const) {
  test(`a cold ${locale} code room stays within its transfer budget through the first edit`, async ({ page, request }, testInfo) => {
    // Change only the disposable fixture instance through its owner API; the
    // page still joins as an ordinary participant with a fresh browser cache.
    expect((await request.post('/api/admin/signin/token', { data: { token: SETUP_TOKEN } })).ok()).toBe(true)
    expect((await request.patch('/api/admin/instance/settings', { data: { language: locale } })).ok()).toBe(true)
    try {
      const files = new Set<string>()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        const file = new URL(request.url()).pathname
        if (file.startsWith('/assets/') && /\.(?:js|css)$/.test(file)) files.add(file)
      })
      await page.goto('/s/browser-shared')
      await page.locator('#join-name').fill(`Transfer ${locale}`)
      await page.getByRole('button', { name: /^(Join the class|Войти на занятие)$/ }).click()
      const editor = page.locator('[data-cell-id="browser-shared"] .cm-content[contenteditable="true"]')
      await expect(editor).toBeVisible()
      await editor.click()
      await editor.press('End')
      await editor.pressSequentially(` # initial edit ${locale}`)
      await expect(editor).toContainText(`initial edit ${locale}`)
      await editor.press('ControlOrMeta+z')
      await expect(editor).not.toContainText(`initial edit ${locale}`)
      // Keep observing after the editor is fully active: deferred timers or a
      // second request wave must not disguise an initial resource as optional.
      await page.waitForTimeout(1200)
      const resources = [...files].sort().map(file => ({
        file, gzip: gzipSync(fs.readFileSync(path.join('web/dist', file)), { level: 9 }).length,
      }))
      const gzipKiB = resources.reduce((sum, resource) => sum + resource.gzip, 0) / 1024
      fs.writeFileSync(`scratchpad/room-transfer-${locale}.json`, JSON.stringify({ locale, gzipKiB, resources }, null, 2) + '\n')
      await page.screenshot({ path: `scratchpad/room-final-${locale}.png` })
      await testInfo.attach('initial-room-transfer', { body: JSON.stringify({ locale, gzipKiB, resources }, null, 2), contentType: 'application/json' })
      expect(gzipKiB).toBeLessThanOrEqual(400)
      expect(resources.some(resource => /codemirror-/.test(resource.file))).toBe(true)
      expect(resources.some(resource => /room-extra|ChatTurn|CellOutputs|Markdown|render-/.test(resource.file))).toBe(false)
      expect(await page.locator('body').innerText()).not.toMatch(/\b(?:room|common|activity|server)\.[a-zA-Z_][\w.]*/)

      // Optional UI evaluates only after its dictionary; changing the language
      // then reloads that dictionary without replacing the editing document.
      await editor.evaluate(element => { element.setAttribute('data-editor-stayed', 'yes') })
      await page.getByRole('button', { name: locale === 'en' ? 'Terminal, kernel log and history' : 'Терминал, журнал ядра и история', exact: true }).click()
      await expect(page.getByRole('button', { name: locale === 'en' ? 'History' : 'История', exact: true })).toBeVisible()
      await page.getByRole('button', { name: locale === 'en' ? 'History' : 'История', exact: true }).evaluate(element => element.setAttribute('data-feature-stayed', 'yes'))
      const next = locale === 'en' ? 'ru' : 'en'
      expect((await request.patch('/api/admin/instance/settings', { data: { language: next } })).ok()).toBe(true)
      await expect(page.getByRole('button', { name: next === 'en' ? 'History' : 'История', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: next === 'en' ? 'History' : 'История', exact: true })).toHaveAttribute('data-feature-stayed', 'yes')
      await expect(editor).toHaveAttribute('data-editor-stayed', 'yes')
      expect(await page.locator('body').innerText()).not.toMatch(/\b(?:room|common|activity|server)\.[a-zA-Z_][\w.]*/)
      expect(errors).toEqual([])
    } finally {
      await request.patch('/api/admin/instance/settings', { data: { language: 'en' } })
    }
  })
}
