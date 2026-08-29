/**
 * Lifting a proposed cell out of an answer.
 *
 * This is the seam where prose becomes something the room can apply with one
 * press, so it has to be strict in both directions: a block that is really
 * there must be found exactly, and an answer that proposes nothing must produce
 * nothing. Inventing a patch out of an explanation would be the model saying
 * "your cell is fine" while the interface offers to rewrite it.
 */
import './_env.mts'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastCodeBlock } from '../server/src/ai/index.js'

test('a fenced python block is the proposal', () => {
  const answer = 'The batch is too large.\n\n```python\nmodel = Net(32)\n```\n'
  assert.equal(lastCodeBlock(answer), 'model = Net(32)')
})

test('an unlabelled fence counts too', () => {
  assert.equal(lastCodeBlock('sure\n\n```\nx = 1\n```'), 'x = 1')
})

test('the last block wins, because the broken one is shown first', () => {
  const answer = 'This line is the problem:\n\n```python\nmodel = Net(64)\n```\n\nUse instead:\n\n```python\nmodel = Net(32)\n```'
  assert.equal(lastCodeBlock(answer), 'model = Net(32)')
})

test('an answer with no code proposes nothing', () => {
  assert.equal(lastCodeBlock('The cell already does that — nothing to change.'), null)
})

test('an empty block proposes nothing', () => {
  assert.equal(lastCodeBlock('here:\n\n```python\n\n```'), null)
})

test('an unclosed fence proposes nothing', () => {
  // A stopped generation. Applying half a block would break the cell.
  assert.equal(lastCodeBlock('almost there\n\n```python\nmodel = Net('), null)
})

test('indentation inside the block survives', () => {
  const answer = '```python\ndef f():\n    return 1\n```'
  assert.equal(lastCodeBlock(answer), 'def f():\n    return 1')
})

test('every action the protocol names is one the route accepts', async () => {
  /*
   * These two lists are written out separately — the union in shared/protocol.ts
   * and the runtime filter in routes/ai.ts — and when they drifted, the request
   * carrying the new action was silently downgraded to a plain question. No
   * error anywhere: the button worked, the answer arrived, and nothing could be
   * applied. Pinning the pair is cheaper than finding that twice.
   */
  const source = await readFile(new URL('../server/src/routes/ai.ts', import.meta.url), 'utf8')
  const line = source.match(/const ACTIONS: readonly AiAction\[\] = \[(.*?)\]/s)
  assert.ok(line, 'the route no longer declares ACTIONS the way this test reads it')
  const accepted = [...line[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()

  /*
   * Объединение читается до точки с запятой, а не до конца строки.
   *
   * Раньше здесь стояло `(.*)`, и тест падал от одного прогона prettier,
   * который разложил объединение по строкам, ничего не изменив по смыслу.
   * Проверка, ломающаяся от переноса строки, ловит форматирование, а не
   * расхождение — а расхождение здесь и есть то, ради чего она написана.
   */
  const protocol = await readFile(new URL('../shared/protocol.ts', import.meta.url), 'utf8')
  // До пустой строки: объединение может быть и в одну строку, и в столбик, а
  // за ним идёт комментарий, в котором те же слова в кавычках упомянуты ещё раз.
  const union = protocol.match(/export type AiAction =([\s\S]*?)\n[ \t]*\n/)
  assert.ok(union, 'AiAction is no longer declared as a union type')
  const declared = [...union[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()

  assert.deepEqual(accepted, declared)
})
