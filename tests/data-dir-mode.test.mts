/**
 * The data directory is closed to everyone but us.
 *
 * It holds the teachers' sign-in keys, the instance's model key and the
 * install token. Three places created the directory — config.ts, db.ts and
 * admin/auth.ts — and `mode: 0o700` was set in only one of them; and
 * `mkdirSync(mode)` on an already existing directory does nothing. Whoever
 * called first won, and that is always config.ts (it loads before db.ts):
 * the directory came out 0755 while a comment in db.ts promised "0700,
 * closed to everyone". There was no leak — the files themselves are 0600 —
 * but a promise in the code must be true, otherwise the next person will put
 * something less careful here, trusting it.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config, ensureDataDir } from '../server/src/config.js'
// Imported for its side effect: db.ts creates the directory on load — just
// as in the live process.
import '../server/src/db.js'

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777

test('the data directory is 0700, whichever of the three created it', () => {
  assert.equal(modeOf(config.dataDir).toString(8), '700')
})

test('a directory created before us with someone else\'s umask gets fixed instead of staying 0755', () => {
  /*
   * The usual case: `make dirs` (or a previous server version) created
   * `data/` in advance, and on start-up we come to a ready directory. This
   * is exactly where `mkdirSync(mode)` is powerless, and exactly why a chmod
   * stands next to it.
   */
  fs.chmodSync(config.dataDir, 0o755)
  assert.equal(modeOf(config.dataDir).toString(8), '755', 'chmod did not work — the test has nothing to stand on')

  ensureDataDir()

  assert.equal(modeOf(config.dataDir).toString(8), '700')
})

test('the database lies inside it and is closed itself', () => {
  assert.equal(modeOf(path.join(config.dataDir, 'colloq.db')).toString(8), '600')
})
