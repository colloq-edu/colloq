/**
 * The rules two sides have to agree on. Each of these was, at some point, stated
 * twice in the codebase and drifted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PARTICIPANT_COLORS,
  actionAllowedIn,
  colorForId,
  type AiAction,
} from '../shared/protocol.js'

const ACTIONS: AiAction[] = ['explain', 'fix', 'debug', 'improve', 'hint', 'ask']

test('an oracle that is off accepts nothing at all', () => {
  for (const action of ACTIONS) assert.equal(actionAllowedIn('off', action), false, action)
})

test('full mode accepts every action', () => {
  for (const action of ACTIONS) assert.equal(actionAllowedIn('full', action), true, action)
})

test('hints mode keeps the question and refuses the answer', () => {
  // The point of the mode: a student may still ask and may still be pointed at
  // the problem; what they may not get is the code written for them.
  assert.equal(actionAllowedIn('hints', 'hint'), true)
  assert.equal(actionAllowedIn('hints', 'ask'), true)
  for (const action of ['fix', 'debug', 'improve', 'explain'] as AiAction[]) {
    assert.equal(actionAllowedIn('hints', action), false, action)
  }
})

test('a participant colour is stable for an id and spread over the palette', () => {
  assert.equal(colorForId('p_abc'), colorForId('p_abc'))
  const seen = new Set<string>()
  for (let i = 0; i < 400; i++) seen.add(colorForId(`p_${i}`))
  // Not a distribution test — just that it is not collapsing onto one colour,
  // which is what a broken hash looks like from the outside.
  assert.ok(seen.size >= PARTICIPANT_COLORS.length - 1, `only ${seen.size} colours used`)
  const palette: readonly string[] = PARTICIPANT_COLORS
  for (const colour of seen) assert.ok(palette.includes(colour), colour)
})
