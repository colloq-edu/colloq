/**
 * What an empty council sheet is seeded with.
 *
 * The sheet used to be seeded with the cell's shared text "as of opening".
 * After "Show to the class" the shared text is already someone's solution: a
 * student who connected or reloaded the page without an attempt got it as the
 * starting text of THEIR OWN sheet and with one press submitted it as their
 * own, landing in the author's group. There is no leak in this — the text is
 * on screen anyway — but the task was gone from their sheet, and an "attempt"
 * appeared.
 *
 * The order now is: one's own attempt → the task (`CouncilMine.seed`, the
 * cell's text at the moment the lock was switched to council) → the shared
 * text, if the server did not send a task. There is no Svelte compiler here:
 * `$state` is a fake, as in tests/council-client.test.mts.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilMine } from '../shared/protocol.js'

const shim = <T,>(value: T): T => value
shim.raw = <T,>(value: T): T => value
;(globalThis as { $state?: unknown }).$state = shim
;(globalThis as { $derived?: unknown }).$derived = shim

const { sheetSeed } = await import('../web/src/lib/council.svelte.js')

/** The same expression CellView uses when it creates a sheet. */
function seedForSheet(mine: Partial<CouncilMine> | null, shared: string): string {
  return sheetSeed(mine?.text, mine?.seed ?? shared)
}

const TASK = '# Посчитайте среднее по группам\ndf = pd.read_csv("marks.csv")'
const SHOWN = 'df.groupby("group")["mark"].mean()'

test('a latecomer gets the task, not the shown solution', () => {
  assert.equal(seedForSheet({ text: '', seed: TASK }, SHOWN), TASK)
})

test('your own attempt outranks the task', () => {
  assert.equal(seedForSheet({ text: 'моё', seed: TASK }, SHOWN), 'моё')
})

test('without a task from the server we seed as before — with the shared text', () => {
  // An old server does not send the field; the behaviour must stay as it was.
  assert.equal(seedForSheet({ text: '' }, TASK), TASK)
  assert.equal(seedForSheet(null, TASK), TASK)
})

test('an empty task means an empty sheet, not the shown solution', () => {
  /*
   * The lock was switched to council on an empty cell — "write it yourself".
   * The task is empty, and that is KNOWLEDGE, not ignorance: the shared text
   * must not be substituted here, because after "Show to the class" it holds
   * someone else's solution.
   */
  assert.equal(seedForSheet({ text: '', seed: '' }, SHOWN), '')
})

test('a missing field and an empty field are different things', () => {
  // `??` looks at whether the field is present, not at whether it is truthy:
  // an old server does not send the field and gets the old behaviour, a new
  // one may send an empty task.
  const fromOldServer: Partial<CouncilMine> = { text: '' }
  const emptyTask: Partial<CouncilMine> = { text: '', seed: '' }
  assert.equal(seedForSheet(fromOldServer, SHOWN), SHOWN)
  assert.equal(seedForSheet(emptyTask, SHOWN), '')
})
