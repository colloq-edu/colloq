import { translate, tr } from '../shared/i18n.js'
/**
 * The terminal drawer speaks one language — including the machine's state.
 *
 * 'starting', 'idle', 'dead' are protocol words, and in code that is what they
 * should be. But in the drawer they went straight into a Russian line: "ядро
 * python · starting — оболочка · idle" in the kernel log and a bare `idle` in
 * the command line, under the Russian prompt "оболочка запускается…". This is
 * the same finding as the one about panel titles, only its last half is the
 * machine one.
 *
 * The words live in `shared/machine.ts` as one list: a `Record` over the type
 * will not let a state appear without a name, and this test holds two things
 * the type does not see — that the names are Russian and that the markup takes
 * them instead of printing the status.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KERNEL_WORD, SHELL_WORD } from '../shared/machine.js'

const DRAWER = 'web/src/components/panels/TerminalDrawer.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** The members of a string union — straight from the type declaration, not a list here. */
function unionOf(rel: string, name: string): string[] {
  const line = new RegExp(`export type ${name} =([^\\n]+)`).exec(read(rel))
  assert.ok(line, `${name}: the declaration was not found`)
  return [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

test('every protocol state has a Russian word chosen for it', () => {
  for (const [rel, name, words] of [
    ['shared/notebook.ts', 'KernelStatus', KERNEL_WORD],
    ['shared/protocol.ts', 'TerminalStatus', SHELL_WORD],
  ] as const) {
    const states = unionOf(rel, name)
    assert.ok(states.length >= 5, `${name}: the union was parsed`)
    for (const state of states) {
      const word = (words as Record<string, string | undefined>)[state]
      assert.ok(word, `${name}.${state} is a state without a word`)
      assert.doesNotMatch(word, /[A-Za-z]/, `${name}.${state}: "${word}" is not a Russian word`)
    }
    assert.equal(Object.keys(words).length, states.length, `${name}: no extra words`)
  }
})

test('the shell is named the same in the command line and in the word list', () => {
  // One state named in two different ways in one drawer reads as two
  // different states: the line prompt was written before the list, and it is
  // the reference.
  const term = read(DRAWER)
  for (const [state, prompt, key] of [
    ['starting', 'оболочка запускается…', 'room.ui.703'],
    ['dead', 'оболочка остановилась', 'room.ui.704'],
    ['closed', 'оболочка не запущена', 'room.ui.705'],
  ] as const) {
    assert.ok(term.includes(`tr('${key}')`), `the prompt "${prompt}" is in place`)
    assert.equal(translate('ru', key), prompt)
    assert.ok(prompt.includes(SHELL_WORD[state]), `"${prompt}" and "${SHELL_WORD[state]}" are one word`)
  }
})

test('the drawer markup does not print the machine state as is', () => {
  const markup = read(DRAWER)
    .split('</script>')[1]
    .split('<style>')[0]
    .replace(/<!--[\s\S]*?-->/g, '')

  assert.doesNotMatch(markup, /\{\s*status\s*\}/, 'a bare `starting`/`idle` in the command line')
  assert.doesNotMatch(markup, /\{[^{}]*kernelStatus[^{}]*\}/, 'a bare kernel status in the log')
  assert.match(markup, /\{kernelWord\}/, 'the kernel is named with a word')
  assert.match(markup, /\{shellWord\}/, 'the shell is named with a word')
  assert.match(
    read(DRAWER),
    /import \{ KERNEL_WORD, SHELL_WORD \} from '@shared\/machine'/,
    'the words come from the shared list, not from a copy of its own',
  )
})
