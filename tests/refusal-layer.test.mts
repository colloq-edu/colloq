/**
 * The "this edit was not accepted" dialog: which surfaces have it and what it
 * lies on top of.
 *
 * A gate refusal is cured by a reload, and a reload returns the tab to where it
 * left from: from `/s/:id/pult`, back to the console. While the dialog sat at
 * z-[60], it was drawn under the opaque console wrapper (z-[95]) and under the
 * projection (z-[90]), so the teacher on a tablet got their sheet back and not
 * a word about the edit being refused and about what exactly of the typed text
 * did not get through. There is no second copy of this dialog in the product,
 * and there must not be: the dialog is not a notice but the only copy of the
 * lost text.
 *
 * It has a tier of its own, between the console and the terminal plates: above
 * the console but below "deleted" / "you were removed" / "diverged" (z-[100]) —
 * over the deleted-room plate the dialog would offer to copy the text to where
 * it can no longer be returned. The palette comes next: panels are opened from
 * it, and it cannot lie under the dialog.
 *
 * On the projection there is no dialog at all: there is nothing to type with
 * there, and somebody's notebook full-screen in the middle of a class is the
 * worst thing that can be drawn on the projector screen. The same pass also
 * closes the rules control: left open, it survived the switch to the projector
 * screen and lay under it — drawn, clickable and invisible.
 *
 * It is read straight from the components, as in `pult-one-voice.test.mts`: a
 * test with its own copy of the rule passes forever while the file drifts away.
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

const SESSION = code(read('web/src/screens/SessionScreen.svelte'))
const PALETTE = code(read('web/src/components/ui/CommandPalette.svelte'))

/** A layer's tier: the first `z-[NN]` after its branch. */
function layer(source: string, from: string): number {
  const at = source.indexOf(from)
  assert.notEqual(at, -1, `did not find "${from}"`)
  const found = /z-\[(\d+)\]/.exec(source.slice(at, at + 1200))
  assert.ok(found, `"${from}" no longer has a tier`)
  return Number(found[1])
}

const REFUSAL = '{#if refusal && refusalShown && !projection}'

test('the refusal dialog lies above the console and the projection', () => {
  const refusal = layer(SESSION, REFUSAL)
  for (const [what, under] of [
    ['the projection', layer(SESSION, '{#if projection}')],
    ['the console', layer(SESSION, '{:else if pult}')],
  ] as const) {
    assert.ok(
      refusal > under,
      `the refusal dialog (z-${refusal}) is under the wrapper of ${what} (z-${under}) again: drawn and invisible`,
    )
  }
})

test('and below the terminal plates: there is nowhere to copy to there', () => {
  const refusal = layer(SESSION, REFUSAL)
  for (const [what, over] of [
    ['"deleted"', layer(SESSION, '{#if session.gone && !pult}')],
    ['"you were removed"', layer(SESSION, '{#if session.banned !== null}')],
    ['"diverged"', layer(SESSION, '{#if session.stuck && !session.gone && !pult}')],
  ] as const) {
    assert.ok(
      refusal < over,
      `the refusal dialog (z-${refusal}) covered the ${what} plate (z-${over})`,
    )
  }
})

test('the palette stays above the refusal dialog: panels are opened from it', () => {
  const palette = layer(PALETTE, 'fixed inset-0')
  const refusal = layer(SESSION, REFUSAL)
  assert.ok(palette > refusal, `the palette (z-${palette}) went under the refusal dialog (z-${refusal})`)
  assert.ok(
    palette < layer(SESSION, '{#if session.gone && !pult}'),
    'the palette rose above the terminal plates: there is nothing left to open there',
  )
})

test('there is no dialog on the projection, but the note waits for it', () => {
  // A mode change does not recreate SessionScreen (App keeps `{#key}` on the token),
  // so `refusal` survives leaving the projector screen for the room — where the dialog is shown.
  assert.match(
    SESSION,
    /\{#if refusal && refusalShown && !projection\}/,
    'the dialog is drawn on the projector screen again: a private notebook full-screen in front of the hall',
  )
  const app = code(read('web/src/App.svelte'))
  assert.match(app, /\{#key me\.token\}/, 'the room screen is rebuilt on a mode change')
})

test('the rules control does not stay open under the projector screen', () => {
  // `rulesOpen` survives a mode change: there is one component for all three.
  // Without the mode in the branch, the panel lay under the projection (z-[90]) and
  // under the console (z-[95]), where it cannot be seen but is there — and Escape
  // does not reach it (`onKeydown` returns on its first line when `mode !== 'room'`).
  assert.match(
    SESSION,
    /\{#if rulesOpen && isHost && mode === 'room'/,
    'the rules control is drawn outside the room again',
  )
  assert.match(SESSION, /if \(mode !== 'room'\) return/, 'room keys work only in the room')
})

test('there is one refusal dialog in the product: no second copy of the lost text', () => {
  // The console says "deleted" and "diverged" in its own words (pult-one-voice),
  // and the temptation to do the same with the dialog is strong. But those plates
  // hold just a plate's worth of words, while here it is the lost text itself:
  // two copies would drift apart at the first edit.
  const roots = ['web/src/screens', 'web/src/components', 'web/src/lib']
  const seen: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.resolve(import.meta.dirname, '..', dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(svelte|ts)$/.test(entry.name) && code(read(rel)).includes("tr('room.ui.928')")) {
        seen.push(rel)
      }
    }
  }
  for (const dir of roots) walk(dir)
  assert.deepEqual(seen, ['web/src/screens/SessionScreen.svelte'], 'the refusal dialog has multiplied')
})
