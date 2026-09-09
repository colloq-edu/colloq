/** Terminal refusals must resolve to complete UI messages in both instance languages. */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTranslation, translate } from '../shared/i18n.js'

const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8')
function terminalKeys(): string[] {
  const source = read('server/src/control.ts')
  const start = source.indexOf("case 'term:open'")
  const end = source.indexOf('\nfunction ', start)
  assert.ok(start >= 0 && end > start, 'terminal dispatch must be present')
  const body = source.slice(start, end)
  return [...new Set([...body.matchAll(/tr\(["'](server\.[^"']+)["']/g)].map(match => match[1]))]
}

test('terminal refusals have explicit Russian and English translations', () => {
  const keys = terminalKeys()
  assert.ok(keys.length >= 6, 'terminal messages must remain covered')
  for (const key of keys) {
    assert.ok(hasTranslation(key), key)
    assert.match(translate('ru', key), /[А-Яа-яЁё]/, key)
    assert.match(translate('en', key), /[a-z]/i, key)
    assert.doesNotMatch(translate('en', key), /[А-Яа-яЁё]/, key)
  }
})

test('terminal refusals never promise an unavailable Stop button', () => {
  for (const locale of ['ru', 'en'] as const) {
    const messages = terminalKeys().map(key => translate(locale, key)).join('\n')
    assert.doesNotMatch(messages, /«Стоп»|Press Stop|with Clear/)
    assert.match(messages, locale === 'ru' ? /преподаватель/ : /teacher/)
  }
  const drawer = read('web/src/components/panels/TerminalDrawer.svelte')
  const keys = [...drawer.matchAll(/tr\(["']([^"']+)["']/g)].map(match => match[1])
  assert.ok(keys.some(key => translate('ru', key) === 'Очистить' && translate('en', key) === 'Clear'), 'the drawer must have its translated Clear button')
})
