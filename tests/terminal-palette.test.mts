/**
 * The terminal's own palette.
 *
 * The drawer does not use the app's colours: it is a near-black slab in both
 * themes, so that it reads as "the machine" rather than as another panel. That
 * also means the app's contrast rules do not cover it, and for a long time
 * nothing did — every contrast pass measured the room with the drawer shut, and
 * four of its labels sat at 3.37:1 and 3.67:1, under AA, in both themes.
 *
 * Read out of the component itself rather than duplicated here. A test that
 * carries its own copy of the numbers passes for ever while the file drifts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrastRatio } from '../web/src/lib/utils.js'

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, '../web/src/components/panels/TerminalDrawer.svelte'),
  'utf8',
)

function token(name: string): string {
  const found = new RegExp(`--tm-${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(source)
  assert.ok(found, `--tm-${name} is not declared in TerminalDrawer.svelte`)
  return found[1]
}

/** The two grounds text is drawn on: the transcript, and the tab bar above it. */
const GROUNDS = () => [
  { name: 'transcript', colour: token('bg') },
  { name: 'tab bar', colour: token('raised') },
]

test('every ink in the terminal is readable on both of its grounds', () => {
  const failures: string[] = []
  for (const ink of ['ink', 'muted', 'faint', 'accent', 'live']) {
    for (const ground of GROUNDS()) {
      const ratio = contrastRatio(token(ink), ground.colour)
      if (ratio < 4.5) failures.push(`--tm-${ink} on the ${ground.name} = ${ratio.toFixed(2)}`)
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of the terminal's inks are under AA`)
})

test('the three tiers stay three tiers', () => {
  // If faint creeps up to meet muted the hierarchy is gone, and the fix for the
  // contrast failure was to raise faint — which is exactly how that happens.
  const bg = token('bg')
  const [ink, muted, faint] = ['ink', 'muted', 'faint'].map((t) => contrastRatio(token(t), bg))
  assert.ok(ink > muted * 1.5, `ink ${ink.toFixed(1)} is not clearly above muted ${muted.toFixed(1)}`)
  assert.ok(muted > faint * 1.25, `muted ${muted.toFixed(1)} is not clearly above faint ${faint.toFixed(1)}`)
})

test('the slab is dark enough to read as a terminal', () => {
  // Against white: if this ever drops, the drawer has started following the
  // app's ground and stopped being the machine.
  assert.ok(contrastRatio(token('bg'), '#FFFFFF') > 15)
  assert.ok(contrastRatio(token('raised'), '#FFFFFF') > 13)
})
