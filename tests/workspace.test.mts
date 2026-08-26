/**
 * The workspace is a directory a student can name files in, from a browser and
 * from arbitrary Python. Everything here is an attempt to leave it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveInSession, safeName, sessionDir } from '../server/src/workspace.js'

const SID = 'seminar1'

test('a plain filename resolves inside the session directory', () => {
  const resolved = resolveInSession(SID, 'data.csv')
  assert.ok(resolved)
  assert.equal(path.dirname(resolved), sessionDir(SID))
  assert.equal(path.basename(resolved), 'data.csv')
})

test('nothing escapes the session directory', () => {
  const escapes = [
    '../secret',
    '../../etc/passwd',
    '../../../data/colloq.db',
    'sub/../../out',
    '/etc/passwd',
    '/../../etc/passwd',
    './../../x',
    '..',
    '.',
    '',
    '   ',
  ]
  for (const name of escapes) {
    const resolved = resolveInSession(SID, name)
    if (resolved === null) continue
    // If it resolves at all it must still be a direct child of this seminar's
    // directory — a workspace that leaks upward reaches the SQLite file and the
    // setup token, both of which live under DATA_DIR beside it.
    assert.equal(path.dirname(resolved), sessionDir(SID), `${name} -> ${resolved}`)
    assert.ok(!path.basename(resolved).includes('..'), name)
  }
})

test('one seminar cannot name another seminar file', () => {
  const resolved = resolveInSession(SID, '../seminar2/data.csv')
  if (resolved !== null) assert.equal(path.dirname(resolved), sessionDir(SID))
})

test('a separator or a control character never survives into a name', () => {
  const nasty = ['a/b.csv', 'a\\b.csv', 'a b.csv', 'a\nb.csv', 'a\u0000b.csv', 'a\u001fb.csv']
  for (const name of nasty) {
    const safe = safeName(name)
    if (safe === null) continue
    assert.ok(!/[/\\]/.test(safe), `${JSON.stringify(name)} -> ${safe}`)
    // eslint-disable-next-line no-control-regex -- control characters are the subject
    assert.ok(!/[\u0000-\u001f]/.test(safe), `${JSON.stringify(name)} -> ${safe}`)
  }
})

test('a name that is only dots or slashes is refused outright', () => {
  for (const name of ['..', '.', '/', '//', '../..']) {
    assert.equal(safeName(name), null, name)
  }
})

test('a dot file is refused rather than accepted and then hidden', () => {
  // The listing filters names beginning with a dot, which is how the kernel's
  // own .ipynb_checkpoints stays out of the room's way. Accepting an upload and
  // then never showing it is the worst of both.
  for (const name of ['.hidden', '.env', '.ipynb_checkpoints', '.DS_Store']) {
    assert.equal(safeName(name), null, name)
    assert.equal(resolveInSession(SID, name), null, name)
  }
})

test('a name in another alphabet survives intact', () => {
  // A student at a Russian university uploads данные.csv and then writes
  // pd.read_csv('данные.csv'). The two have to be the same string.
  for (const name of ['данные.csv', 'пример данных.csv', '结果.csv', 'übung.md']) {
    assert.equal(safeName(name), name, name)
    const resolved = resolveInSession(SID, name)
    assert.ok(resolved?.endsWith(name), `${name} -> ${resolved}`)
  }
})

test('a name is kept as typed, case and spaces included', () => {
  for (const name of ['UPPER.CSV', 'spaces in name.txt', 'Mixed Case File.md']) {
    assert.equal(safeName(name), name, name)
  }
})

test('a name at the length limit is kept and one past it is not', () => {
  const at = 'a'.repeat(196) + '.csv'
  assert.equal(safeName(at), at)
  assert.equal(safeName('a'.repeat(201)), null)
})
