/**
 * "The oracle has taken this cell" — a sign that rests on three joints.
 *
 * The check is by source, not by behaviour, and it is the same choice as in
 * sanitize.test.mts: seeing the running bar takes a browser, which this suite
 * does not have. And each of the three joints is one line in one place, and
 * losing any of them turns the sign off SILENTLY: the button was pressed, the
 * oracle is working, and the cell still shows nothing.
 *
 * The first joint is the observer. The feed registry wakes cells only on the
 * listed keys, and `state` got into that list precisely for busyness: without
 * it the `streaming` → `done` change goes past, and the sign NEVER goes out.
 *
 * The second joint is precedence. The kernel and the oracle may both take on
 * one cell, and the slot in the number field goes to the kernel: it changes
 * the cell, while the oracle so far only reads, and the two must not be
 * confused in one sign.
 *
 * The third joint is the twinkle itself. It lives on TWO paths inside the
 * icon, and it is held together by the pairing "class on the wrapper +
 * nth-of-type". Change the icon's shape and the twinkle quietly disappears,
 * leaving the sign a motionless sparkle that cannot be told from a plain mark.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

test('the feed registry wakes cells when a turn changes state', () => {
  const source = read('web/src/lib/yreactive.svelte.ts')
  const keys = /const PATCH_KEYS = \[([^\]]*)\]/.exec(source)
  assert.ok(keys, 'the list of keys the registry watches is gone')
  assert.match(keys[1], /'state'/, 'without state the busy sign will never go out')
  assert.match(keys[1], /'cellIds'/, 'the agent takes several cells in one turn')
  /*
   * On the FEED there is one observer per document, and busyness is computed in
   * the same pass as proposals. A second observer on the feed would mean a
   * second walk on every event — exactly the cost the registry exists to avoid
   * (the file has other observeDeep calls too: on metadata, on outputs — those
   * are about something else).
   */
  assert.equal((source.match(/#chat\.observeDeep/g) ?? []).length, 1)
})

test('a turn still in progress counts as busy, with both forms of addressing', () => {
  const source = read('web/src/lib/yreactive.svelte.ts')
  const working = source.slice(source.indexOf('#working()'), source.indexOf('busy(id: string)'))
  assert.match(working, /'streaming'/, 'busyness is not computed from the turn state')
  assert.match(working, /cellId/)
  assert.match(working, /cellIds/)
})

test('the sparkle sits in the number field and gives way to execution', () => {
  /*
   * It is the same slot as the execution mark: "what is being done to this cell
   * right now". If both have taken it, the slot stays with `[*]`: the kernel
   * CHANGES the cell, the oracle so far only reads. In that case the line under
   * the cell speaks for the oracle.
   */
  const cell = read('web/src/components/notebook/CellView.svelte')
  const at = cell.indexOf('{#if oracleBusy && !shownRunning}')
  assert.notEqual(at, -1, 'the sparkle no longer gives way to execution')
  const slot = cell.slice(at, cell.indexOf('{/if}', at))
  assert.match(slot, /name="sparkles"/, 'the oracle sign has changed, and people recognise the oracle by it')
  assert.match(slot, /cell-sparkle/, 'without the class the twinkle has nothing to hook onto')
  assert.match(slot, /\{:else if mark\}/, 'the execution mark has to come back after the turn')
})

test('a word under the cell, not just motion', () => {
  // Motion at the edge means "something is happening"; the word says who exactly
  // is busy. The word is what all of this is for: the oracle panel may be collapsed.
  const cell = read('web/src/components/notebook/CellView.svelte')
  assert.match(cell, /\{#if oracleBusy\}[\s\S]{0,600}room\.oracle\.working/)
})

test('both halves of the icon twinkle, and in antiphase', () => {
  const css = read('web/src/index.css')
  assert.match(css, /\.cell-sparkle path:nth-of-type\(1\)/)
  assert.match(css, /\.cell-sparkle path:nth-of-type\(2\)/)
  // Antiphase is what makes it a twinkle: at any moment one half is brighter than the other.
  const big = /@keyframes cell-sparkle-big \{([\s\S]*?)\}\s*\}/.exec(css)
  const small = /@keyframes cell-sparkle-small \{([\s\S]*?)\}\s*\}/.exec(css)
  assert.ok(big && small, 'the twinkle keyframes are gone')
  assert.notEqual(big[1].trim(), small[1].trim(), 'both halves twinkle the same: that is not a twinkle')

  /*
   * ONLY opacity changes, and that is why the twinkle has no quiet twin: by the
   * policy in the header of index.css, such indicators stay as they are under
   * `prefers-reduced-motion` — a stopped indicator is a lie about the system.
   */
  for (const frames of [big[1], small[1]]) {
    assert.doesNotMatch(frames, /transform|translate|scale/, 'the twinkle started moving the icon')
  }
  const quiet = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'), css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.doesNotMatch(quiet, /cell-sparkle/, 'the twinkle must not be taken away: it moves nothing')

  // And the icon has to stay two-part: the twinkle rests on nth-of-type.
  const icon = read('web/src/components/ui/Icon.svelte')
  const sparkles = /sparkles:\s*\n?\s*'([^']*)'/.exec(icon)
  assert.ok(sparkles, 'the oracle sign has disappeared from the set')
  assert.equal((sparkles[1].match(/<path/g) ?? []).length, 2, 'the sign no longer has two halves: nothing to twinkle with')
})
