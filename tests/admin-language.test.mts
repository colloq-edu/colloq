import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { hasTranslation, setLocaleResolver, tr, translate } from '../shared/i18n.js'
import { adminMessages } from '../shared/locales/admin.js'
import { people, runningLine, signedOutNotice, ruleRefusal } from '../web/src/admin/panel.js'

afterEach(() => setLocaleResolver(() => 'ru'))

test('admin messages follow the instance locale and leave names unchanged', () => {
  let locale: 'ru' | 'en' = 'ru'
  setLocaleResolver(() => locale)
  assert.equal(people(1), '1 человек')
  assert.equal(people(2), '2 человека')
  assert.equal(people(5), '5 человек')
  assert.equal(people(21), '21 человек')
  assert.match(signedOutNotice('revoked'), /ссылку/)
  assert.match(ruleRefusal({ reason: 'network', status: 0 }), /сервер не ответил/)
  locale = 'en'
  assert.equal(people(1), '1 person')
  assert.equal(people(2), '2 people')
  assert.equal(people(21), '21 people')
  assert.match(signedOutNotice('revoked'), /new sign-in link/)
  assert.match(ruleRefusal({ reason: 'network', status: 0 }), /server did not respond/)
  assert.equal(tr('admin.environment', { p0: 'Мой Python' }), 'Environment Мой Python')
  const now = Date.UTC(2026, 8, 9, 12)
  const room = { liveCount: 2, createdAt: now - 86_400_000, liveSince: now - 120_000 }
  assert.equal(runningLine(room, now), '2 people in the room · started 2 min ago')
  locale = 'ru'
  assert.equal(runningLine(room, now), '2 человека в комнате · начался 2 мин назад')
})

test('admin catalog has complete paired translations and preserves every placeholder', () => {
  for (const [key, pair] of Object.entries(adminMessages)) {
    const variants = (value: typeof pair.ru) => typeof value === 'string' ? [value] : Object.values(value)
    const placeholders = (values: string[]) => [...new Set(values.flatMap(value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1])))].sort()
    assert.ok(variants(pair.ru).every(Boolean), `${key} RU empty`)
    assert.ok(variants(pair.en).every(Boolean), `${key} EN empty`)
    assert.deepEqual(placeholders(variants(pair.ru)), placeholders(variants(pair.en)), key)
    assert.notEqual(translate('ru', key), key, key)
    assert.notEqual(translate('en', key), key, key)
  }
})

test('every static admin translation call has a catalog entry', () => {
  const root = new URL('../web/src/admin/', import.meta.url)
  const files = readdirSync(root, { recursive: true }).map(String).filter(p => /\.(svelte|ts)$/.test(p))
  for (const file of files) {
    const source = readFileSync(new URL(file, root), 'utf8')
    for (const match of source.matchAll(/\btr\(\s*['"]([^'"]+)['"]/g)) {
      assert.ok(hasTranslation(match[1]), `${file}: missing ${match[1]}`)
    }
  }
})
