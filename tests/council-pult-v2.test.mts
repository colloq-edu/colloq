import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attemptReview, attemptExecution, pultShortcutAllowed, matchesFilter } from '../web/src/lib/council-pult.js'

test('execution success does not imply a correct solution, and a grade does not erase execution status', () => {
  const run = { state: 'ok' as const }
  assert.equal(attemptReview({ submittedAt: 1, correct: null }).tone, 'neutral')
  assert.equal(attemptReview({ submittedAt: 1, correct: false }).tone, 'warning')
  assert.equal(attemptReview({ submittedAt: 1, correct: true }).tone, 'positive')
  assert.equal(attemptExecution({ run }).tone, 'positive')
  assert.notEqual(attemptReview({ submittedAt: 1, correct: true }).label, attemptExecution({ run }).label)
})

test('draft, queued, running, failed and requested execution are visually distinct states', () => {
  assert.notEqual(attemptReview({ submittedAt: null, correct: null }).label, attemptReview({ submittedAt: 1, correct: null }).label)
  const states = ['queued','running','error','ok'] as const
  assert.equal(new Set(states.map(state => attemptExecution({ run: {state} }).label)).size, 4)
  assert.equal(attemptExecution({ run: {state:'error'} }).tone, 'danger')
  assert.equal(attemptExecution({ run: null, runRequest: {status:'pending'} }).tone, 'warning')
  assert.equal(attemptExecution({ run: {state:'queued'}, runRequest: {status:'pending'} }).tone, 'accent')
  assert.equal(attemptExecution({ run: null }).tone, 'neutral')
})

test('queue, Oracle and navigation focus never execute shortcuts against a hidden work', () => {
  for (const action of ['show','run','correct','wrong','clearShown','next','toggleGroup'] as const) {
    assert.equal(pultShortcutAllowed(action,'queue',false),false)
    assert.equal(pultShortcutAllowed(action,'oracle',false),false)
    assert.equal(pultShortcutAllowed(action,'work',true),false)
    assert.equal(pultShortcutAllowed(action,'work',false),true)
  }
  for (const action of ['help','escape','search'] as const)
    assert.equal(pultShortcutAllowed(action,'oracle',true),true)
})


test('error filter includes execution errors independently from teacher grade', () => {
  const one = { participantId:'one', status:'correct', correct:true, run:{state:'error'} } as any
  assert.equal(matchesFilter(one,'error',new Set(),new Set()),true)
  assert.equal(matchesFilter({...one,correct:false,run:{state:'ok'}},'error',new Set(),new Set()),true)
  assert.equal(matchesFilter({...one,run:{state:'ok'}},'error',new Set(),new Set()),false)
})

test('a ban menu or confirmation blocks every console shortcut against the work behind it', () => {
  for (const action of ['show','run','correct','wrong','clearShown','next','search','help'] as const)
    assert.equal(pultShortcutAllowed(action, 'work', false, true), false)
})
