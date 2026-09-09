import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  translate,
  tr,
  setLocaleResolver,
  getLocale,
  formatNumber,
  formatDate,
  messages,
} from '../shared/i18n.js'

test('locale selection changes live translations and uses Russian as a safe default', () => {
  let locale = 'ru'
  setLocaleResolver(() => locale)
  assert.equal(tr('common.loading'), 'Загрузка…')
  locale = 'en'
  assert.equal(tr('common.loading'), 'Loading…')
  locale = 'bad'
  assert.equal(getLocale(), 'ru')
  assert.equal(tr('unregistered diagnostic'), 'unregistered diagnostic')
  setLocaleResolver(() => 'ru')
})
test('interpolation is literal and plural rules follow the selected language', () => {
  assert.equal(translate('ru', 'common.people', { count: 1 }), '1 человек')
  assert.equal(translate('ru', 'common.people', { count: 2 }), '2 человека')
  assert.equal(translate('ru', 'common.people', { count: 5 }), '5 человек')
  assert.equal(translate('ru', 'common.people', { count: 21 }), '21 человек')
  assert.equal(translate('en', 'common.people', { count: 21 }), '21 people')
  assert.equal(
    translate('en', 'common.greeting', { name: '<b>{count}</b>' }),
    'Hello, <b>{count}</b>',
  )
})
test('number and date formatting use the instance locale', () => {
  setLocaleResolver(() => 'en')
  assert.equal(formatNumber(1234.5), '1,234.5')
  assert.match(formatDate('2026-09-09T12:00:00Z', { month: 'long', timeZone: 'UTC' }), /September/)
  setLocaleResolver(() => 'ru')
  assert.match(formatNumber(1234.5), /1\s234,5/)
  assert.match(formatDate('2026-09-09T12:00:00Z', { month: 'long', timeZone: 'UTC' }), /сентябр/i)
})
test('every registered message has both languages and matching interpolation parameters', () => {
  for (const [key, pair] of Object.entries(messages)) {
    const parameters = (value: unknown) =>
      [
        ...new Set(
          (typeof value === 'string' ? [value] : Object.values(value as object)).flatMap((text) =>
            [...String(text).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]),
          ),
        ),
      ].sort()
    assert.ok(pair.ru && pair.en, key)
    assert.deepEqual(parameters(pair.ru), parameters(pair.en), key)
  }
})
