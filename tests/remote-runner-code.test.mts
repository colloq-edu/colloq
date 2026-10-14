/**
 * The enrollment minter of the instance's console (server/src/ops/runner-code.ts,
 * built to dist/runner-code.js and run by `colloq-host runner-code` through
 * the image's entry point): its contract, run as a process on a database of
 * its own.
 *
 * colloq-host reads exactly one JSON line from stdout and nothing else; a
 * refusal must print no code and exit non-zero, or colloq-host would print
 * join commands with a code nobody can join with. And the row must be the
 * one the panel writes — by the same function, with the same bounds — or a
 * code minted on the console would join machines the panel's would not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'

const ROOT = path.resolve(import.meta.dirname, '..')
const ENTRY = path.join(ROOT, 'server/src/ops/runner-code.ts')
const TSX = ['--import', import.meta.resolve('tsx')]

function mint(dataDir: string, args: string[]) {
  return spawnSync(process.execPath, [...TSX, ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: ROOT,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'),
      DATA_DIR: dataDir,
      WORKSPACE_DIR: path.join(dataDir, '..', 'workspace'),
      SESSION_SECRET: 'test-secret-not-random-on-purpose',
      KERNEL_BACKEND: 'test',
      NODE_ENV: 'test',
    },
  })
}

test('the console\'s minter prints one JSON line with the code, and writes the panel\'s row by its sha256', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-code-'))
  try {
    const data = path.join(root, 'data')
    const before = Date.now()
    const run = mint(data, ['--machines', '3', '--hours', '12', '--trusted', '--slots', '4', '--prefix', 'vast-4090'])
    assert.equal(run.status, 0, run.stderr)
    const lines = run.stdout.trim().split('\n')
    assert.equal(lines.length, 1, 'stdout is the code\'s alone')
    const answer = JSON.parse(lines[0]) as { code: string; expiresAt: number; machines: number; trusted: boolean }
    assert.deepEqual(Object.keys(answer).sort(), ['code', 'expiresAt', 'machines', 'trusted'])
    assert.match(answer.code, /^[a-f0-9]{32}$/)
    assert.equal(answer.machines, 3)
    assert.equal(answer.trusted, true)
    assert.ok(answer.expiresAt >= before + 12 * 3600_000 && answer.expiresAt <= Date.now() + 12 * 3600_000)
    const db = new Database(path.join(data, 'colloq.db'), { readonly: true })
    try {
      const row = db.prepare('SELECT * FROM remote_runner_codes WHERE code_sha256 = ?').get(createHash('sha256').update(answer.code).digest('hex')) as Record<string, unknown> | undefined
      assert.ok(row, 'the row is there, by the code\'s sha256')
      assert.equal(row.uses_left, 3)
      assert.equal(row.machines, 3)
      assert.equal(row.trusted, 1)
      assert.equal(row.approved_slots, 4)
      assert.equal(row.name_prefix, 'vast-4090')
      assert.equal(row.created_by, 'colloq-host')
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM remote_runner_codes').all()).includes(answer.code), 'the code itself nowhere')
    } finally {
      db.close()
    }

    // Defaults: one machine for a day, not trusted.
    const plain = mint(data, [])
    assert.equal(plain.status, 0, plain.stderr)
    const second = JSON.parse(plain.stdout) as { machines: number; trusted: boolean; expiresAt: number }
    assert.equal(second.machines, 1)
    assert.equal(second.trusted, false)

    // Refusals print no code, say why on stderr, and exit non-zero.
    for (const [args, status, said] of [
      [['--machines', '0'], 2, /--machines/],
      [['--hours', '25'], 2, /--hours/],
      [['--slots', '99'], 2, /--slots/],
      [['--prefix', 'a b'], 2, /--prefix/],
      [['--machines'], 64, /needs a value/],
      [['--machines', 'three'], 64, /whole number/],
      [['--everything'], 64, /unknown option/],
    ] as const) {
      const refused = mint(data, [...args])
      assert.equal(refused.status, status, `${args.join(' ')}: ${refused.stderr}`)
      assert.equal(refused.stdout, '')
      assert.match(refused.stderr, said)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
