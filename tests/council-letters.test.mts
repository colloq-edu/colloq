/**
 * The teacher's letters on an attempt: two letters are two lines, and the old
 * server.
 *
 * An attempt has two slots for a letter, a personal one and a group one
 * (server/src/council.ts · keeping), and on screen they must read separately.
 * While both surfaces drew `reply` — the same letters glued together with a
 * blank line — the line breaks inside `<p class="flex flex-wrap">` collapsed,
 * and "Check the sign" and the group letter ran as one phrase: "Check the sign
 * Everyone: a correction". The defect is pure markup, it has no socket, and it
 * rolls back with a single line — so it is read straight from the components,
 * as in `panels-craft` and `council-stack-craft`.
 *
 * The second half is the fallback: an older server has no `replies` field at
 * all, and without falling back to `reply` a new client would show no answer
 * whatsoever. The rule is one for both surfaces and lives in shared; there
 * must be no copies.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { councilLetters, type CouncilReply } from '../shared/protocol.js'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')
/** Markup and code without comments: an explanation is not a promise. */
const code = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const SHEET = 'web/src/components/notebook/CellView.svelte'
/*
 * The second surface is the console window: `PultWork` reads the letters
 * (through the same shared function), and `PultLetters` draws them line by
 * line. The old stack under the cell, which stood here, was removed together
 * with the console in the notebook.
 */
const WORK = 'web/src/components/council/pult/PultWork.svelte'
const LETTERS = 'web/src/components/council/pult/PultLetters.svelte'

const letter = (text: string, to?: 'person' | 'group'): CouncilReply => ({
  text,
  at: 1,
  by: 'Анна Петровна',
  ...(to ? { to } : {}),
})

test('letters come from replies, and reply stays the fallback', () => {
  const personal = letter('Проверьте знак', 'person')
  const group = letter('Всем: поправка', 'group')

  assert.deepEqual(councilLetters({ reply: group, replies: [personal, group] }), [personal, group])

  // An older server: there is no `replies` field, one glued text arrives — and
  // that is what we draw.
  const glued = letter('Проверьте знак\n\nВсем: поправка')
  assert.deepEqual(councilLetters({ reply: glued }), [glued])

  // "No letters" is an empty list, not a line with nothing in it.
  assert.deepEqual(councilLetters({ reply: null }), [])
  assert.deepEqual(councilLetters({ reply: glued, replies: [] }), [])
  assert.deepEqual(councilLetters(null), [])
  assert.deepEqual(councilLetters(undefined), [])
})

test('both surfaces draw a line per letter, not a paragraph per attempt', () => {
  for (const [name, sources, mark] of [
    ['student sheet', [SHEET], /tr\('room\.ui\.70'\)/],
    // In the console the group letter is labelled "You · letter to a group":
    // for the teacher it is their own letter, and it must differ from a
    // personal one. The number of people in the caption is gone — grouping
    // was removed from the console on 20 Sep 2026 together with the "All N"
    // button, and inventing a group size the console no longer counts would
    // mean printing a made-up number.
    ['teacher console', [WORK, LETTERS], /tr\('room\.pult\.v3\.letterToGroup'\)/],
  ] as const) {
    const source = sources.map((rel) => code(read(rel))).join('\n')
    assert.match(source, /councilLetters\(/, `${name}: letters are taken around shared`)
    assert.match(
      source,
      /\{#each\s+(letters|councilLetters\([^)]*\))\s+as\s+letter/,
      `${name}: letters are not unrolled into lines`,
    )
    assert.doesNotMatch(
      source,
      /\breply\??\.(text|by|at)\b/,
      `${name}: the glued "reply" is on screen again — two letters will read as one`,
    )
    // Silence on a personal letter means "this is for you"; a group letter has
    // to be named out loud.
    assert.match(source, /letter\.to === 'group'/, `${name}: the group letter is not marked in any way`)
    assert.match(source, mark, `${name}: no word about the group letter`)
  }
})

test('the fallback rule lives in shared, in a single copy', () => {
  const shared = code(read('shared/protocol.ts'))
  assert.match(shared, /export function councilLetters\(/, 'shared no longer declares the rule')
  for (const rel of [SHEET, WORK, LETTERS]) {
    assert.doesNotMatch(
      code(read(rel)),
      /replies\s*\?\?/,
      `${rel}: a copy of its own of the fallback to reply — one day it will fall behind shared`,
    )
  }
})
