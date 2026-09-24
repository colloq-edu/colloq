/**
 * The oracle's turn: a command that never got the shell is REMOVED, and it
 * says exactly that.
 *
 * The word matters more than usual here: this paragraph is read not by a
 * person but by the model, and it retells it to the room in its own words.
 * The deed is done (`stopRun` in the waiting branch calls `dropPendingOf`,
 * and that it really cuts the entry out of the queue, answers the waiter and
 * does not touch someone else's command is pinned down in
 * tests/terminal.test.mts · "the Oracle turn is over — its waiting command
 * will not start later on its own"), but the word managed to drift from it:
 * the answer said "the command stayed in the queue and may start later; do
 * not queue it a second time". The model, believing it, announced to the
 * class a run that would never happen and did not run it again.
 *
 * So a pair is checked: the removal in the turn's code and the phrase that
 * talks about it. There is no network or kernel here: two places of one file
 * are compared.
 */
import { test } from 'node:test'
import { translate } from '../shared/i18n.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const agent = readFileSync(
  fileURLToPath(new URL('../server/src/ai/agent.ts', import.meta.url)),
  'utf8',
)

/** A piece of the file from a marker line to the end of the branch: crude, but to the point. */
function from(mark: string, chars: number): string {
  const at = agent.indexOf(mark)
  assert.notEqual(at, -1, `agent.ts has no ${mark}`)
  return agent.slice(at, at + chars)
}

test('the waiting deadline removes its own command from the queue instead of leaving it there', () => {
  const branch = from("if (!typedRunningCommand(hands.sessionId, hands.by.participantId)) {", 400)
  assert.match(branch, /cut = 'waiting'/)
  assert.match(branch, /dropPendingOf\(hands\.sessionId, hands\.by\.participantId\)/)
  // Ctrl+C goes only into one's own command: this branch has none at all.
  assert.doesNotMatch(branch, /interruptTerminal/)
})

test('and the model is told about it in the same words: the command is removed', () => {
  const branch = from("if (result.cut === 'waiting') {", 500)
  const said = translatedBranch(branch, 'ru')
  assert.match(translatedBranch(branch, 'en'), /removed my command from the queue/)
  assert.match(said, /сн(ял|ята) из очереди/)
  /*
   * Three promises the code does not keep. Each is checked separately: any
   * of them may come back, and they cost the same: the model tells the room
   * the run is still ahead and waits for it instead of running it.
   */
  assert.doesNotMatch(said, /осталась в очереди/)
  assert.doesNotMatch(said, /может начаться/)
  assert.doesNotMatch(said, /второй раз её ставить не надо/)
})

test('the step line in the teacher feed says the same', () => {
  const branch = from("result.cut === 'waiting'", 200)
  const step = translatedBranch(branch, 'ru')
  assert.match(translatedBranch(branch, 'en'), /did not start.*removed from the queue/)
  assert.match(step, /не начался/)
  assert.match(step, /снята/)
})

/** The branch references translation keys; verify the actual promised copy in both locales. */
function translatedBranch(source: string, locale: 'ru' | 'en'): string {
  const keys = [...source.matchAll(/tr\(["'](server\.[^"']+)["']/g)].map(match => match[1])
  assert.ok(keys.length > 0, 'the branch must use explicit translations')
  return keys.map(key => translate(locale, key)).join('')
}
