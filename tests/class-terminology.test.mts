import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { messages, translate } from '../shared/i18n.js'

test('generic teaching entities use classes in both catalogs, preserving the example seminar title', () => {
  for (const [key, pair] of Object.entries(messages)) {
    if (key === 'admin.computer.vision.seminar.25.08') continue
    for (const [locale, value] of Object.entries(pair)) {
      const text = typeof value === 'string' ? value : Object.values(value).join(' ')
      assert.doesNotMatch(text, /семинар|\bseminars?\b/i, `${key} (${locale})`)
    }
  }
  assert.equal(translate('ru', 'admin.seminars'), 'Занятия')
  assert.equal(translate('en', 'admin.seminars'), 'Classes')
  assert.equal(translate('ru', 'admin.new.seminar'), 'Новое занятие')
  assert.equal(translate('ru', 'room.ui.145'), 'Это занятие удалено')
  assert.equal(translate('ru', 'session not found'), 'Занятие не найдено')
  assert.equal(translate('ru', 'server.ssr.unpublished'), 'ещё не опубликовано')
  assert.equal(translate('ru', 'admin.count.seminar', { count: 1 }), '1 занятие')
  assert.equal(translate('ru', 'admin.count.seminar', { count: 2 }), '2 занятия')
  assert.equal(translate('ru', 'admin.count.seminar', { count: 5 }), '5 занятий')
  assert.equal(translate('en', 'admin.count.seminar', { count: 1 }), '1 class')
  assert.equal(translate('en', 'admin.count.seminar', { count: 2 }), '2 classes')
  assert.equal(translate('ru', 'admin.computer.vision.seminar.25.08'), 'Семинар по компьютерному зрению — 25.08')
})

test('language menu states the shared scope and names the current language', () => {
  assert.equal(translate('ru', 'admin.language.scope'), 'Изменится у всех участников.')
  assert.equal(translate('en', 'admin.language.scope'), 'Changes for everyone on this server.')
  assert.equal(translate('ru', 'admin.language.current', { language: 'Русский' }), 'Язык интерфейса: Русский')
  assert.equal(translate('en', 'admin.language.current', { language: 'English' }), 'Interface language: English')
  assert.equal(translate('ru', 'admin.language.retry'), 'Повторить')
  assert.equal(translate('en', 'admin.language.retry'), 'Try again')
})

test('getting started names the Classes list in generated documentation', () => {
  const page = readFileSync(new URL('../site/docs/getting-started.html', import.meta.url), 'utf8')
  assert.match(page, /«Занятия»/)
  assert.doesNotMatch(page, /«Семинары»|Создайте семинар/)
})
