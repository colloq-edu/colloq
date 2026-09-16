import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pultPresence, filterLabel } from '../web/src/lib/council-pult.js'
import { tr } from '../shared/i18n.js'

test('saved attempts do not imply that their author is connected', () => {
  const people = new Map([['student', {}]])
  assert.equal(pultPresence(true, people, 'student'), 'online')
  people.delete('student')
  assert.equal(pultPresence(true, people, 'student'), 'offline')
  assert.equal(pultPresence(false, people, 'student'), 'unknown')
  people.set('student', {})
  assert.equal(pultPresence(false, people, 'student'), 'unknown', 'stale awareness during reconnect is not current presence')
  assert.equal(pultPresence(true, people, 'student'), 'online')
})

test('unsent work and its count are labelled drafts, never live typing', () => {
  assert.match(filterLabel('writing'), /черновик/i)
  assert.match(tr('room.ui.1311'), /черновик/i)
  assert.match(tr('room.ui.1056', {count: 2}), /черновик/i)
  assert.doesNotMatch(tr('room.ui.1056', {count: 2}), /пиш/)
})
