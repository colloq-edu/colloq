/**
 * Colours that have to stay readable.
 *
 * A participant's colour is picked by a hash and is fixed for the life of the
 * room, so nobody chooses it and nobody can work around it being wrong. White
 * initials on the lime and amber of the palette measured 2.08:1 — invisible —
 * and the failure is invisible too, because everybody else's avatar looks fine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PARTICIPANT_COLORS, colorForId } from '../shared/protocol.js'
import { contrastRatio, inkOn, luminance } from '../web/src/lib/utils.js'

test('luminance is right at the ends of the range', () => {
  assert.equal(Math.round(luminance('#000000') * 1000) / 1000, 0)
  assert.equal(Math.round(luminance('#ffffff') * 1000) / 1000, 1)
  assert.ok(luminance('#808080') > 0.2 && luminance('#808080') < 0.3)
})

test('the contrast ratio matches the two values everybody knows', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21)
  assert.equal(contrastRatio('#123456', '#123456'), 1)
  // Order must not matter.
  assert.equal(contrastRatio('#0f2246', '#8ac44a'), contrastRatio('#8ac44a', '#0f2246'))
})

test('every colour in the participant palette carries readable initials', () => {
  const failures: string[] = []
  for (const colour of PARTICIPANT_COLORS) {
    const ink = inkOn(colour)
    const ratio = contrastRatio(ink, colour)
    if (ratio < 4.5) failures.push(`${colour} with ${ink} = ${ratio.toFixed(2)}`)
  }
  assert.deepEqual(failures, [], `initials are unreadable on ${failures.length} of the palette`)
})

test('the ink actually chosen is the better of the two, not merely adequate', () => {
  for (const colour of PARTICIPANT_COLORS) {
    const chosen = contrastRatio(inkOn(colour), colour)
    const other = contrastRatio(inkOn(colour) === '#FFFFFF' ? '#0F2246' : '#FFFFFF', colour)
    assert.ok(chosen >= other, `${colour}: chose ${chosen.toFixed(2)} over ${other.toFixed(2)}`)
  }
})

test('a colour assigned to a real id is always one of the palette', () => {
  // inkOn is only guaranteed for the palette; colorForId must not invent one.
  for (let i = 0; i < 200; i++) {
    const colour = colorForId(`p_${i}`)
    assert.ok(PARTICIPANT_COLORS.includes(colour), colour)
    assert.ok(contrastRatio(inkOn(colour), colour) >= 4.5)
  }
})

test('a colour that is not a hex triple does not crash the avatar', () => {
  // Colours arrive from the database, and an old row could hold anything.
  for (const bad of ['', 'red', '#fff', 'rgb(1,2,3)', '#zzzzzz']) {
    assert.doesNotThrow(() => inkOn(bad))
    assert.ok(typeof inkOn(bad) === 'string')
  }
})
