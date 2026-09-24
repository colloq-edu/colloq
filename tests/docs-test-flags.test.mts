/**
 * The header of `tests/README.md` explains why the run is set up exactly
 * this way, and cites numbers nobody has recounted since. Both are checked —
 * because nobody builds or type-checks this file.
 *
 * Flags. The paragraphs about `--test-concurrency=1` and `--test-force-exit`
 * are not a note to self: the first keeps the suite from silently
 * undercounting the tail of a file, the second keeps the run from hanging on
 * a server module's timer. Remove a flag from `npm test` — and the README
 * stays the only place that still has it: the suite starts losing tests
 * again, while the explanation tells why that does not happen.
 *
 * Numbers. "232, 232, 230, 232" and "twelve extra seconds" are a
 * measurement from the time the suite had 232 tests; today there are many
 * times more, and exactly how many is deliberately not written here. A
 * number in the text grows with other people's edits, while it lives in a
 * file nobody opens meanwhile — exactly the way the line "about 220 tests"
 * in the root README lied (see `docs-readme-drift.test.mts`). So the old
 * number must be named as the past, and the live one taken from the end of
 * the run, not from here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const doc = read('tests/README.md')
const npmTest: string = JSON.parse(read('package.json')).scripts.test

/**
 * The paragraph starting with these words: up to the first blank line, as
 * one line.
 *
 * Line breaks are collapsed on purpose — the paragraph wraps at eighty
 * characters, and the phrase breaks wherever the boundary falls today; a
 * check sensitive to it would fail from a reformat, not from an untruth.
 */
function paragraph(from: string): string {
  const at = doc.indexOf(from)
  assert.notEqual(at, -1, `tests/README.md has no paragraph "${from}…"`)
  return doc.slice(at, doc.indexOf('\n\n', at)).replace(/\s+/g, ' ')
}

/** How many tests are declared in the tree. The same count as in the root README. */
function declared(): number {
  const dir = path.join(root, 'tests')
  let n = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.mts')) continue
    n += (readFileSync(path.join(dir, name), 'utf8').match(/^[ \t]*(?:test|it)\(/gm) ?? []).length
  }
  return n
}

test('the flags tests/README.md explains are in npm test', () => {
  paragraph('`--test-concurrency=1` is deliberate')
  assert.match(
    npmTest,
    /--test-concurrency=1\b/,
    'tests/README.md explains the sequential run, but npm test no longer asks for it: the suite undercounts the tail of a file again',
  )

  paragraph('`--test-force-exit` is deliberate')
  assert.match(
    npmTest,
    /--test-force-exit\b/,
    'tests/README.md explains --test-force-exit, but npm test no longer passes it: the run will hang on a server module\'s timer',
  )
})

test('the old measurement in the header is named as the past, not the present', (t) => {
  const said = paragraph('`--test-concurrency=1` is deliberate')
  const then = 232
  if (!said.includes(String(then))) {
    t.skip('the paragraph was remeasured: the old number is no longer in it, there is nothing to date')
    return
  }
  const now = declared()
  assert.ok(now > 0, 'no declared test was found in tests/ — the count is broken, not the README')
  // While the count stays within the same order, the number still describes
  // the suite by itself.
  if (now < then * 2 && now > then / 2) return

  assert.match(
    said,
    /\bthen\b|\bhistory\b/i,
    `the header still says ${then} tests, while ${now} are declared: the number must be named as the past or remeasured`,
  )
})

test('the header says where today\'s number and time come from', () => {
  const said = paragraph('`--test-concurrency=1` is deliberate')
  assert.match(said, /duration_ms/, 'it is not said where to look for the real run time')
  assert.match(said, /ℹ tests/, 'it is not said where to look for the real number of tests')
})
