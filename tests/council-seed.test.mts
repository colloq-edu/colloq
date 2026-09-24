/**
 * The council task — what an empty sheet is seeded with.
 *
 * The sheet used to be seeded with the cell's shared text, and after "Show to
 * the class" the shared text is already somebody's solution: a latecomer got
 * it as the starting text of their sheet and submitted it as their own with
 * one press. So the cell's text is captured once, when the lock switches to
 * council (control.ts · cell:lock calls `rememberSeed`), and travels to
 * everyone in `CouncilMine.seed`.
 *
 * Here is the server half: storage, both branches of `mineFor`, a restart and
 * the deletion of a room. What the sheet does with this field is checked by
 * tests/notebook-council-seed.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import {
  discardCouncil,
  mineFor,
  rememberSeed,
  resetCouncilCache,
  saveDraft,
  seedOf,
} from '../server/src/council.js'

const TASK = '# Посчитайте среднее по группам\ndf = pd.read_csv("marks.csv")'
const SHOWN = 'df.groupby("group")["mark"].mean()'

let n = 0

/** A room of its own per test: attempts live in a shared table keyed by the seminar. */
function room(): { id: string; cell: string } {
  n += 1
  const id = `seed-${n}`
  createSession(id, `Семинар ${n}`)
  return { id, cell: `cell-${n}` }
}

test('an empty sheet arrives with the task, not with what is in the cell now', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  // "Show to the class" rewrote the shared text — the task does not change
  // because of that: it was captured once, when the council opened.
  const mine = mineFor(at.id, at.cell, 'late', false)
  assert.equal(mine?.text, '')
  assert.equal(mine?.seed, TASK)
  assert.notEqual(mine?.seed, SHOWN)
})

test('the task also travels to someone who already has an attempt', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  saveDraft(at.id, at.cell, 'ada', 'df.head()', 1000)
  const mine = mineFor(at.id, at.cell, 'ada', false)
  assert.equal(mine?.text, 'df.head()')
  assert.equal(mine?.seed, TASK)
})

test('no task remembered — no field at all, and the client seeds the old way', () => {
  const at = room()
  const mine = mineFor(at.id, at.cell, 'ada', false)
  assert.equal(mine?.text, '')
  // Not `undefined` in the field but the absence of the field: an empty
  // string here means "the council was opened on an empty cell", and the two
  // must not be confused.
  assert.equal('seed' in (mine as object), false)
})

test('an empty cell is a legitimate task: an empty sheet for everyone', () => {
  const at = room()
  rememberSeed(at.id, at.cell, '')
  const mine = mineFor(at.id, at.cell, 'ada', false)
  assert.equal('seed' in (mine as object), true)
  assert.equal(mine?.seed, '')
})

test('the task survives a server restart', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  // The same as a restart: the room cache is forgotten, the truth stays in
  // SQLite.
  resetCouncilCache(at.id)
  assert.equal(seedOf(at.id, at.cell), TASK)
  assert.equal(mineFor(at.id, at.cell, 'late', false)?.seed, TASK)
})

test('the seminar was deleted — the task went with it', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  discardCouncil(at.id)
  resetCouncilCache(at.id)
  assert.equal(seedOf(at.id, at.cell), null)
})

test('a second opening of the council on the same cell sets a new task', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  // The lock was closed and opened again — the cell holds another task, and
  // that is what gets captured.
  rememberSeed(at.id, at.cell, SHOWN)
  assert.equal(seedOf(at.id, at.cell), SHOWN)
})
