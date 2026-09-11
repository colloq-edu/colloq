import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVITY_CATEGORIES, ACTIVITY_KIND_LEVEL, ACTIVITY_LEVELS } from '../shared/activity.js'
import { translate } from '../shared/i18n.js'

test('every activity kind and filter has a registered human label in both languages', () => {
  const keys = [
    ...Object.keys(ACTIVITY_KIND_LEVEL).map((kind) => `activity.${kind}`),
    ...ACTIVITY_CATEGORIES.map((category) => `activity.category.${category}`),
    ...ACTIVITY_LEVELS.flatMap((level) => [`activity.${level}`, `activity.hint.${level}`]),
  ]
  for (const locale of ['ru', 'en'] as const) {
    for (const key of keys) assert.notEqual(translate(locale, key), key, `${locale}: ${key}`)
  }
})
