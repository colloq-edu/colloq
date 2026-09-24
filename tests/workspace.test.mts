/**
 * The workspace is a directory a student can name files in, from a browser and
 * from arbitrary Python. Everything here is an attempt to leave it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createSession } from '../server/src/db.js'
import { MAX_SEGMENT } from '../shared/paths.js'
import { listFiles, resolveInSession, sessionDir } from '../server/src/workspace.js'

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

test('a control character in a name is refused, not stripped', () => {
  // There is one yardstick for everyone and it lives in shared/paths
  // (paths.test.mts checks it itself); here — that the door to the seminar
  // folder asks exactly it. The separator is now legitimate: `src/model.py` is
  // a path, not a name with a slash inside.
  for (const name of ['a\\b.csv', 'a\nb.csv', 'a\u0000b.csv', 'a\u001fb.csv']) {
    assert.equal(resolveInSession(SID, name), null, JSON.stringify(name))
  }
})

test('a name that is only dots or slashes is refused outright', () => {
  for (const name of ['..', '.', '/', '//', '../..']) {
    assert.equal(resolveInSession(SID, name), null, name)
  }
})

test('a dot file is refused rather than accepted and then hidden', () => {
  // The listing filters names beginning with a dot, which is how the kernel's
  // own .ipynb_checkpoints stays out of the room's way. Accepting an upload and
  // then never showing it is the worst of both.
  for (const name of ['.hidden', '.env', '.ipynb_checkpoints', '.DS_Store']) {
    assert.equal(resolveInSession(SID, name), null, name)
  }
})

test('a name is kept as typed — alphabet, case and spaces included', () => {
  // A student at a Russian university uploads данные.csv and then writes
  // pd.read_csv('данные.csv'). The two have to be the same string.
  const kept = [
    'данные.csv',
    'пример данных.csv',
    '结果.csv',
    'übung.md',
    'UPPER.CSV',
    'spaces in name.txt',
    'Mixed Case File.md',
  ]
  for (const name of kept) {
    const resolved = resolveInSession(SID, name)
    assert.ok(resolved?.endsWith(name), `${name} -> ${resolved}`)
  }
})

test('a name at the length limit is kept and one past it is not', () => {
  // There is one cap for the whole path — `safeSegment` from shared/paths, a
  // hundred and twenty characters. The upload no longer has a yardstick of its
  // own: while it had one (two hundred characters), a name from the middle of
  // the gap passed it only to get a refusal one line below that named neither
  // the reason nor the cap.
  const at = 'a'.repeat(MAX_SEGMENT - 4) + '.csv'
  assert.ok(resolveInSession(SID, at)?.endsWith(at))
  assert.equal(resolveInSession(SID, 'a'.repeat(MAX_SEGMENT + 1)), null)
})

/* ------------------------------------------------ a symlink is not a file of the room */

/**
 * The kernel container runs any Python a student types, on the same mounted
 * workspace the server serves files from. So a cell can plant a symlink in the
 * room's folder pointing anywhere the server can read — and the server reads
 * its own session secret. The name check catches `../` in the request; it says
 * nothing about what an entry inside the folder points at.
 */
test('a symlink pointing out of the room is neither listed nor resolved', () => {
  const id = 'ws-symlink'
  createSession(id, 'Symlink test', null)
  const dir = sessionDir(id)
  const secret = path.join(os.tmpdir(), `colloq-secret-${process.pid}`)
  fs.writeFileSync(secret, 'the signing key')
  fs.writeFileSync(path.join(dir, 'honest.csv'), 'a,b\n')
  fs.symlinkSync(secret, path.join(dir, 'key.txt'))
  try {
    assert.deepEqual(listFiles(id).map((f) => f.name), ['honest.csv'], 'the link was listed as a file')
    assert.equal(resolveInSession(id, 'key.txt'), null, 'the link resolved to a download')
    assert.ok(resolveInSession(id, 'honest.csv'), 'an honest file still resolves')
    // A name that does not exist yet must still resolve — that is how uploads land.
    assert.ok(resolveInSession(id, 'arriving.csv'), 'a not-yet-written name stopped resolving')
  } finally {
    fs.rmSync(secret, { force: true })
  }
})
