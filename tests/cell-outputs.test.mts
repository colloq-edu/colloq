/**
 * A progress bar is one line, not two hundred.
 *
 * Nobody collapsed carriage returns in the notebook: tqdm and `pip install`
 * printed every frame as a separate line, the output climbed over the collapse
 * threshold and hid under "Show more". The folding is fiddly exactly in the
 * places the eye does not see: `\r\n`, a frame at the end of a line, a line
 * with no `\r` at all.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collapseCarriage } from '../web/src/lib/utils.js'

test('a line without a carriage return is left alone', () => {
  assert.equal(collapseCarriage('hello\nworld\n'), 'hello\nworld\n')
  // The trailing newline stays: for a cell it is significant.
  assert.equal(collapseCarriage(''), '')
})

test('the last frame of each line remains', () => {
  assert.equal(collapseCarriage('10%\r50%\r100%'), '100%')
  assert.equal(collapseCarriage('a\r1\nb\r2'), '1\n2')
})

test('a frame cut off at a carriage return does not leave an empty line', () => {
  // tqdm ends a frame with a carriage return and waits for the next one.
  assert.equal(collapseCarriage('50%\r'), '50%')
  assert.equal(collapseCarriage('\r\r30%\r\r'), '30%')
})

test('CRLF reads as a line break, not as a frame', () => {
  assert.equal(collapseCarriage('one\r\ntwo\r\n'), 'one\ntwo\n')
})

test('folding does not eat lines without frames', () => {
  const mixed = 'Collecting torch\n  0%\r 50%\r100%\nSuccessfully installed'
  assert.equal(collapseCarriage(mixed), 'Collecting torch\n100%\nSuccessfully installed')
})
