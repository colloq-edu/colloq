/** System notices are localized at emission; shell output itself is not translated. */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTranslation, translate } from '../shared/i18n.js'
const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8')
function keysIn(file: string): string[] {
  return [...new Set([...read(file).matchAll(/["'](server\.[^"']+)["']/g)].map(match => match[1]))]
}

test('terminal system messages have both languages and retain the Colloq marker', () => {
  const keys = keysIn('server/src/kernel/terminal.ts')
  const notices = keys.filter(key => translate('ru', key).startsWith('[colloq]'))
  assert.ok(notices.length >= 10, 'terminal notices must remain covered')
  for (const key of keys) assert.ok(hasTranslation(key), key)
  for (const key of notices) {
    assert.match(translate('ru', key), /[А-Яа-яЁё]/, key)
    assert.match(translate('en', key), /^\[colloq\]/, key)
    assert.doesNotMatch(translate('en', key), /[А-Яа-яЁё]/, key)
  }
})

test('notice button labels match translated drawer labels', () => {
  const source = read('web/src/components/panels/TerminalDrawer.svelte')
  const drawerKeys = [...source.matchAll(/tr\(["']([^"']+)["']/g)].map(match => match[1])
  for (const locale of ['ru', 'en'] as const) {
    const labels = drawerKeys.map(key => translate(locale, key)).join('\n')
    const notices = keysIn('server/src/kernel/terminal.ts').map(key => translate(locale, key)).join('\n')
    const names = [...notices.matchAll(locale === 'ru' ? /«([^»]+)»/g : /“([^”]+)”/g)].map(match => match[1])
    assert.ok(names.length > 0, 'system notices must explain available controls')
    for (const name of names) assert.ok(labels.includes(name), `drawer lacks ${locale} label: ${name}`)
  }
})

test('full-screen limitations and Ctrl+C are explained in both languages', () => {
  assert.match(translate('ru', 'server.terminal.screen'), /построчный вывод\. Попробуйте прервать команду через Ctrl\+C/)
  assert.match(translate('en', 'server.terminal.screen'), /line-by-line output.*Ctrl\+C/)
  const source = read('server/src/kernel/terminal.ts')
  assert.match(source, /systemLine\(term, tr\(SCREEN_NOTICE\)\)/, 'resolve the locale when the notice is emitted')
})
