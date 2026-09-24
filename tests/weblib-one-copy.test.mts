/**
 * One rule — one copy: where the client had two.
 *
 * A person's monogram was computed twice and differently: the version feed
 * took the first and SECOND letters, the avatar and the people list the first
 * and LAST. "Иван Петрович Сидоров" came out as "ИП" in one corner of the
 * screen and "ИС" in the other — one person, one screen, two monograms, and
 * neither of them looks like a mistake.
 *
 * The council mode bar was assembled in three ways: `councilStripText` (with
 * a test and without a single call), the console markup by hand and the
 * server's counters. Here we check that the function has something to answer
 * both questions with — about the server's count and about what a person can
 * count by eye — and that someone still calls it: a function with a test and
 * no call was exactly the defect.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initials } from '../web/src/lib/utils.js'
import { initialsOf } from '../web/src/lib/history.js'
import { councilStripText } from '../web/src/lib/council.svelte.js'

test('the monogram in the version feed is the same as on the avatar', () => {
  for (const name of ['Иван Петрович Сидоров', 'Ада Лавлейс', 'Пётр', 'Anna Maria de la Cruz']) {
    assert.equal(initialsOf(name), initials(name), `${name}: two different circles on one screen`)
  }
})

test('an entry without an author has no monogram: it is the room, not an unknown person', () => {
  // `initials` answers "?" — "someone we do not know"; the feed draws a dot,
  // and that is a different statement: nobody, because it was not a person
  // who wrote it.
  assert.equal(initialsOf(null), '')
  assert.equal(initialsOf('   '), '')
  assert.equal(initials(''), '?')
})

test('the council bar counts groups by what is on the screen, not only by the server', () => {
  const counts = { attempts: 487, submitted: 446, writing: 41, groups: 6 }
  assert.equal(
    councilStripText(counts),
    '487 попыток · 446 сдали · 41 черновик · 6 разных ответов',
  )
  // The stack grouped what reached it — that is what must be in the bar.
  assert.equal(
    councilStripText(counts, 2),
    '487 попыток · 446 сдали · 41 черновик · 2 разных ответа',
  )
})

test('someone draws the mode bar: a function without a single call was exactly the defect', () => {
  // The console moved into the pult window, and the bar went with it — into
  // the filter bar.
  const filters = readFileSync(
    resolve(import.meta.dirname, '..', 'web/src/components/council/pult/PultFilters.svelte'),
    'utf8',
  )
  // With zero, not the number of groups: grouping was removed from the pult
  // entirely (20 Sep 2026), and "6 different answers" in the list caption
  // would remain its last trace — a number that cannot be counted by eye in
  // the list itself.
  assert.match(filters, /councilStripText\(counts, 0\)/)
})

test('nothing to say — we say nothing: neither "0 drafts" nor "0 different answers"', () => {
  assert.equal(
    councilStripText({ attempts: 2, submitted: 0, writing: 2, groups: 0 }, 0),
    '2 попытки · 0 сдали · 2 черновика',
  )
})
