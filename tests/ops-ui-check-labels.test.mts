import { translate, tr } from '../shared/i18n.js'
/**
 * The live stand finds buttons by their labels — and nothing else is left to
 * remind anyone of that.
 *
 * scripts/ui-check.mts drives a real Chrome and presses what is written on
 * the button. The label changes in the component, the stand does not find
 * out, and `until(...)` waits for a result right up to the timeout — silently,
 * because there is nothing for it to wait for. It has happened before: "Erase"
 * in the lecture bar became two-step (wipeAsked), and the stand kept pressing
 * once — that is, it only armed the button and checked for an erase it had
 * not asked for.
 *
 * Here the two sides of one label are compared: what LectureView draws and
 * what the stand looks for. No live browser is needed for that, and `make ui`
 * is run by hand and not every day.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const view = read('web/src/components/lecture/LectureView.svelte')
const stand = read('scripts/ui-check.mts')

test('the two-step labels of the lecture bar and the stand talk about the same buttons', () => {
  // Both buttons are irreversible, and both ask for a second press. The order
  // in the ternary matters: the question is the "asked" state, not the label
  // at rest.
  assert.match(view, /\{wipeAsked \? tr\('room\.ui\.288'\) : tr\('room\.ui\.221'\)\}/)
  assert.match(view, /\{stopAsked \? tr\('room\.ui\.294'\) : tr\('room\.ui\.230'\)\}/)

  for (const label of ['room.ui.221', 'room.ui.288', 'room.ui.230', 'room.ui.294'].map(key => translate('ru', key))) {
    assert.ok(stand.includes(label), `ui-check does not know the label "${label}"`)
  }
})

test('the stand presses them twice, not once', () => {
  // One press on a two-step button is a check that checks nothing: it arms
  // the button and waits for a result it did not ask for.
  assert.match(stand, /const pressTwice = async \(/)
  assert.match(stand, /pressTwice\(host, \['Стереть', 'Стереть всё\?'\]\)/)

  // For "End" the second press is written separately — between the steps the
  // stand checks that the first one only asked.
  const at = stand.indexOf(`'the first "End" asks rather than ends'`)
  assert.notEqual(at, -1, 'the stand no longer checks that the first press only asks')
  const after = stand.slice(at)
  assert.match(
    after.slice(0, 600),
    /\['Закончить','Закончить лекцию\?'\]\.includes/,
    'after the question the stand does not press a second time — the lecture will not end',
  )
})

test('the stand presses where a person would', () => {
  /*
   * Selection listens to what is marked `data-cell-pick`, and the gaps around
   * it are neutral on purpose. An event bubbles up: a `pointerdown` on the
   * `[data-cell-id]` root never reaches the handler, and the stand, aiming
   * there, selected nothing — four checks in a row blamed the product for it,
   * and the fifth fell over on `null` and took the whole tail of the run with
   * it.
   */
  const cell = readFileSync(path.join(root, 'web/src/components/notebook/CellView.svelte'), 'utf8')
  // Only the attribute — on a line of its own in the markup: the comments
  // nearby spell out the same name, and counting them would mean counting
  // explanations.
  const picks = [...cell.matchAll(/^ *data-cell-pick$/gm)].map((m) => m.index ?? 0)
  assert.equal(picks.length, 2, `the press marker sits on ${picks.length} nodes instead of two: the body and the number`)
  for (const at of picks) {
    assert.match(
      cell.slice(at, at + 200),
      /onpointerdown(?:capture)?=\{\(event\) => onselect\(event\)\}/,
      'the marked cell node does not select — the stand is aiming at the wrong place',
    )
  }
  assert.match(stand, /const body=cells\[\$\{n\}\]\.querySelector\('\[data-cell-pick\]:not\(span\)'\)/)
})

test('the cell number selects it, and the area around clears the selection', () => {
  /*
   * A selected cell is marked by its NUMBER — a filled rectangle — so that is
   * exactly what people aim at. While the number was neutral, pressing the
   * selection mark cleared the selection: a person tapped what they saw and
   * lost the choice.
   *
   * It is checked as a pair because it works as a pair: the marker on the
   * number (otherwise it will not select) and the same marker in the clearing
   * check (otherwise it clears right after selecting — the handlers sit on
   * different events and do not interfere with each other).
   */
  const cell = readFileSync(path.join(root, 'web/src/components/notebook/CellView.svelte'), 'utf8')
  const at = cell.search(/<span\n *data-cell-pick/)
  assert.notEqual(at, -1, 'the cell number is no longer marked as a press target')
  assert.match(cell.slice(at, at + 1200), /\{ordinal\}/, 'something other than the number is marked')

  const screen = readFileSync(path.join(root, 'web/src/screens/SessionScreen.svelte'), 'utf8')
  assert.match(
    screen,
    /closest\('\[data-cell-pick\]'\)\) return/,
    'clearing the selection checks the wrong marker — a press on the number will clear what it has just selected',
  )
})
