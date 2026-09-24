/**
 * Tapped the hedgehog — joined as the hedgehog.
 *
 * The server is the judge of mark uniqueness: it replaces a taken mark with a
 * free one, otherwise a class that opened the link within one minute ends up
 * with identical animals (a pair gets the same cursor in the notebook, and
 * the colour does not tell them apart — it is minted from the id). There was
 * nothing in the /join body to tell a mark handed out by the screen from one
 * tapped with a finger, and both were replaced: a person tapped the hedgehog
 * and turned out to be an otter — without a single word, because by then the
 * join card had already gone off into the room.
 *
 * What is checked here is the contract that carries this difference, and the
 * second half of the same promise: the picker draws taken marks as taken — by
 * the list read at the moment it opens, not when the form mounts.
 *
 * It is read straight from the files, as in `screens-craft.test.mts`: a test
 * with its own copy of the rule passes forever while the screen drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Where a line is wrapped is up to the formatter, not the test. */
function flat(source: string): string {
  return code(source).replace(/\s+/g, ' ')
}

const JOIN = 'web/src/screens/JoinScreen.svelte'
const PICKER = 'web/src/components/join/MarkPicker.svelte'
const PROTOCOL = 'shared/protocol.ts'

/* ------------------------------------------------- picked-by-hand flag */

test('the /join body carries the "picked by hand" flag', () => {
  const protocol = code(read(PROTOCOL))
  const request = protocol.slice(
    protocol.indexOf('interface JoinRequest'),
    protocol.indexOf('interface JoinResponse'),
  )
  assert.match(request, /picked\?: boolean/, 'the server has nothing to tell a picked mark from a handed-out one')
})

test('the join screen really sends this flag', () => {
  const join = flat(read(JOIN))
  assert.match(
    join,
    /api\.join\(session\.id, \{ name: who, avatar: mark, picked,/,
    'the mark goes to the server without the picked flag — it will be replaced too',
  )
})

/* ---------------------------------------------------- fresh occupancy */

test('the picker opens together with a re-read of the room', () => {
  const join = flat(read(JOIN))
  assert.match(join, /onclick=\{openPicker\}/, '"Change" opens the picker directly again')
  assert.doesNotMatch(
    join,
    /onclick=\{\(\) => \(picking = true\)\}/,
    'an open without a read is still there',
  )
  assert.match(
    join,
    /function openPicker\(\): void \{ picking = true void readRoom\(\)/,
    'the grid is drawn from a roster a minute old',
  )
})

test('reading the room goes through the shared mark-choice rule', () => {
  // markToClaim is the only copy of the rule (components/join/pick.ts): what
  // we handed out is recomputed, what was picked by hand is left alone. A
  // second copy here would drift apart from the one the tests stand on.
  const join = flat(read(JOIN))
  assert.match(
    join,
    /async function readRoom\(\)[\s\S]*mark = markToClaim\(mark, picked, taken, profile\.avatar\)/,
    'reading the room has grown its own copy of the rule',
  )
})

/* ---------------------------------------------------------- own tile */

test('your own mark stays yours even when someone has taken it meanwhile', () => {
  const picker = flat(read(PICKER))
  const grid = picker.slice(picker.indexOf('role="radiogroup"'))
  // The roster is re-read when the picker opens, and the animal picked by
  // hand may arrive here already taken. It must not turn grey then: "which
  // one is mine" cannot be read on forty tiles without the border.
  assert.match(
    grid,
    /\{selected \? 'border-accent[^']*' : held \?/,
    'being taken recolours your own mark and the border is lost',
  )
  assert.match(
    grid,
    /held && !selected \? 'opacity-25'/,
    'your own animal fades to a quarter of its visibility',
  )
  // And the wearer's dot still stays: someone else is wearing it next to you.
  assert.match(grid, /\{#if held\}/, 'the dot of the wearer vanished along with the grey')
})
