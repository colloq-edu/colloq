/**
 * The council on the client: the arithmetic shared by the console window and
 * the showing banner.
 *
 * Everything checked here breaks silently: a group glued together by the
 * wrong key looks like one more solution; pick the wrong representative, and
 * the teacher answers "all 311" to whoever submitted last; the chip of a
 * failed attempt without the exception name does not say what to show the
 * class. None of these mistakes crashes or turns red.
 *
 * The stack order, the strip segments, the arrow-key neighbours and the "rare
 * groups" are no longer here: the console under the cell with the card and
 * "‹ ›" moved into the console window and became a feed, and its arithmetic
 * is checked by council-pult.test.mts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilAttempt, CouncilOracle } from '../shared/protocol.js'
import { attemptStatus, groupStatus } from '../shared/protocol.js'
import {
  groupAttempts,
  groupTitle,
  normalizeAttempt,
  oracleState,
  staleBy,
  statusLabel,
} from '../web/src/lib/council-board.js'

/** An attempt with its key computed by the same function as on the server. */
function attempt(id: string, text: string, over: Partial<CouncilAttempt> = {}): CouncilAttempt {
  return {
    participantId: id,
    name: id,
    color: '#000',
    avatar: null,
    text,
    submittedAt: 1000,
    updatedAt: 1000,
    status: 'unrun',
    run: null,
    reply: null,
    correct: null,
    shown: false,
    groupKey: normalizeAttempt(text),
    ...over,
  }
}

test('a group ignores whitespace, blank lines and comments', () => {
  const a = attempt('a', 'x = 1\nprint(x)', { submittedAt: 10 })
  const b = attempt('b', 'x=1   # единица\n\n\nprint( x )\r\n', { submittedAt: 20 })
  // A hash inside a string is not a comment: a different key, a different
  // group.
  const c = attempt('c', 'x = 1\nprint("#x")', { submittedAt: 30 })
  const groups = groupAttempts([a, b, c])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].members, ['a', 'b'])
  assert.deepEqual(groups[1].members, ['c'])
  // Case is part of the solution: Print and print are not the same thing.
  assert.notEqual(normalizeAttempt('Print(x)'), normalizeAttempt('print(x)'))
})

test('the representative is the earliest submitter; the group status and "on screen" come from all members', () => {
  const late = attempt('late', 'y = 2', { submittedAt: 300, status: 'correct' })
  const early = attempt('early', 'y=2', { submittedAt: 100, status: 'failed' })
  const mid = attempt('mid', 'y =2', { submittedAt: 200, shown: true })
  const [group] = groupAttempts([late, early, mid])
  assert.equal(group.representative, 'early')
  // A teacher's mark on the card of a NON-representative is still the group's
  // mark.
  assert.equal(group.status, 'correct')
  assert.equal(group.shown, true, "a group member was shown, so the group's text is on screen")
  assert.equal(group.sample, 'y=2')
  assert.equal(group.count, 3)
  assert.deepEqual(group.members, ['early', 'mid', 'late'])

  // Without a mark, a failure is louder: in a shared kernel the outcome of the
  // same text depends on the state.
  assert.equal(groupStatus(['unrun', 'ran', 'failed']), 'failed')
  assert.equal(groupStatus(['unrun', 'ran']), 'ran')
  assert.equal(groupStatus(['unrun', 'wrong', 'failed']), 'wrong')
  assert.equal(groupStatus([]), 'unrun')
  const [plain] = groupAttempts([
    attempt('a', 'z', { status: 'unrun' }),
    attempt('b', 'z', { status: 'failed' }),
  ])
  assert.equal(plain.status, 'failed')
  assert.equal(plain.shown, false)
})

test('those still writing are not grouped; a group is named by the oracle or by its first line', () => {
  const writing = attempt('w', 'z = 3', { submittedAt: null })
  const done = attempt('d', '\n\n  z = 3  # done', { submittedAt: 5 })
  const groups = groupAttempts([writing, done], { [done.groupKey]: 'через z' })
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].members, ['d'])
  assert.equal(groups[0].label, 'через z')
  assert.equal(groupTitle(groups[0]), 'через z')
  assert.equal(groupTitle({ label: null, sample: done.text }), 'z = 3  # done')
  assert.equal(groupAttempts([writing]).length, 0)
})

test('groups go from largest to smallest; on a tie, whichever was submitted first', () => {
  const attempts = [
    attempt('p1', 'a', { submittedAt: 50 }),
    attempt('q1', 'b', { submittedAt: 10 }),
    attempt('q2', 'b', { submittedAt: 60 }),
    attempt('r1', 'c', { submittedAt: 20 }),
  ]
  const groups = groupAttempts(attempts)
  assert.deepEqual(
    groups.map((g) => g.key),
    ['b', 'c', 'a'],
  )
})

test('a submitted blank sheet is a group with its own key and its own name', () => {
  // A lone comment normalizes to an empty string, and people do submit that.
  const empty = attempt('e', '# не знаю', { submittedAt: 10 })
  assert.equal(empty.groupKey, '')
  const groups = groupAttempts([empty])
  assert.equal(groups.length, 1)
  // The group name is exactly what the header in the console prints: "Group 2
  // · 87 identical" does not say WHAT those eighty-seven wrote.
  assert.equal(groupTitle(groups[0]), '# не знаю')
})

test('the chip of a failed attempt names the exception', () => {
  const run = {
    state: 'error' as const,
    outputs: [
      { kind: 'stream' as const, name: 'stdout' as const, text: 'hi' },
      { kind: 'error' as const, ename: 'TypeError', evalue: 'bad', traceback: [] },
    ],
    execCount: 1,
    ranMs: 400,
    startedAt: 0,
    by: 'host' as const,
  }
  assert.equal(statusLabel({ status: 'failed', run }), 'TypeError')
  assert.equal(statusLabel({ status: 'failed', run: null }), 'ошибка запуска')
  // The teacher's mark outranks the run.
  assert.equal(statusLabel({ status: 'correct', run }), 'верно')
  assert.equal(statusLabel({ status: 'unrun', run: null }), 'не запускали')
})

test('"wrong" is a mark that outranks the run, and the chip shows it with the same word', () => {
  /*
   * The whole product knows the `wrong` status (the chip, a mark that outranks
   * the run for the oracle), yet there was nothing to set it with: the old
   * console sent only `true` and `null`. The ✗ button lives on the console's
   * action bar (council-pult-craft); here is the chain "what the button sends
   * → which status that is → which word it comes out as".
   */
  const run = {
    state: 'ok' as const,
    outputs: [],
    execCount: 1,
    ranMs: 12,
    startedAt: 0,
    by: 'host' as const,
  }
  assert.equal(attemptStatus({ run: null, correct: false }), 'wrong')
  assert.equal(statusLabel({ status: 'wrong', run: null }), 'неверно')
  assert.equal(attemptStatus({ run, correct: false }), 'wrong', 'the mark lost to the run')
  assert.equal(attemptStatus({ run, correct: null }), 'ran')
})

test('the oracle goes stale by the number of submitters; the server does not report it at all', () => {
  const oracle: CouncilOracle = {
    state: 'ready',
    askedAt: 1,
    basedOn: 100,
    summary: ['a', 'b', 'c'],
    groupLabels: {},
    drafts: {},
    error: null,
  }
  assert.equal(oracleState(null, 5), 'idle')
  assert.equal(oracleState({ ...oracle, state: 'idle' }, 500), 'idle')
  assert.equal(oracleState({ ...oracle, state: 'reading' }, 500), 'reading')
  assert.equal(oracleState(oracle, 100), 'ready')
  assert.equal(oracleState(oracle, 112), 'stale')
  assert.equal(staleBy(oracle, 112), 12)
  // Fewer submitters now (a ban): not "minus three" but zero.
  assert.equal(staleBy(oracle, 97), 0)
})
