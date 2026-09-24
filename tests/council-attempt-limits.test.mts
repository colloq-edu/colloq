/**
 * Output ceilings of an attempt: where "it fit" ends and "cut off" begins.
 *
 * An attempt's card travels to the host together with the whole stack, so the
 * ceiling here is lower than a cell's — which makes it all the more important
 * that it triggers exactly where it should. The comparison was non-strict
 * (`>=`), and text that fit the budget to the character was declared
 * truncated: under it appeared "stopped after 64 KB — write to a file", and
 * everything the attempt printed after that (usually the very answer, on the
 * last line) was silently thrown away.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CouncilOutputBuffer,
  MAX_ATTEMPT_OUTPUT_CHARS,
} from '../server/src/kernel/council.js'

const truncationNotice = (outputs: ReturnType<CouncilOutputBuffer['snapshot']>) =>
  outputs.find((o) => o.kind === 'stream' && /остановлен после/.test(o.text))

test('text exactly at the budget passes whole and without a warning', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'a'.repeat(MAX_ATTEMPT_OUTPUT_CHARS))
  const outputs = buffer.snapshot()

  assert.equal(outputs.length, 1, `${outputs.length} entries: ${JSON.stringify(outputs)}`)
  assert.ok(outputs[0].kind === 'stream')
  assert.equal(outputs[0].text.length, MAX_ATTEMPT_OUTPUT_CHARS, 'the text was cut although it fit')
  assert.equal(truncationNotice(outputs), undefined, 'there was no truncation, yet it says there was')
})

test('one character past the budget is truncation at last, and it is announced', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'a'.repeat(MAX_ATTEMPT_OUTPUT_CHARS))
  buffer.stream('stdout', 'итог: 42\n')
  const outputs = buffer.snapshot()

  assert.ok(truncationNotice(outputs), 'truncated silently')
  const body = outputs.filter((o) => o.kind === 'stream' && !/остановлен после/.test(o.text))
  const total = body.reduce((sum, o) => sum + (o.kind === 'stream' ? o.text.length : 0), 0)
  assert.equal(total, MAX_ATTEMPT_OUTPUT_CHARS, 'extra text leaked past the ceiling')
})

test('text one character longer than the budget is cut exactly at it', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'a'.repeat(MAX_ATTEMPT_OUTPUT_CHARS + 1))
  const outputs = buffer.snapshot()

  assert.ok(truncationNotice(outputs), 'there was truncation but no warning')
  assert.ok(outputs[0].kind === 'stream')
  assert.equal(outputs[0].text.length, MAX_ATTEMPT_OUTPUT_CHARS)
})

test('an ordinary attempt loses nothing', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'считаю\n')
  buffer.stream('stdout', 'готово\n')
  const outputs = buffer.snapshot()

  assert.equal(outputs.length, 1)
  assert.ok(outputs[0].kind === 'stream')
  assert.equal(outputs[0].text, 'считаю\nготово\n')
})
