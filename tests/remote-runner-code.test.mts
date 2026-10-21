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
 * The mint is in the audit log as the panel's is: a code is a door for its
 * machines and its hours, and the console's was the one the log never saw.
 * A code for classes (--classes) is never also one for the hidden test
 * (docs/architecture/remote-classes.md D3), and a database this release
 * makes from nothing has the columns that say so.
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

test('the console\'s minter prints one JSON line with the code, writes the panel\'s row by its sha256, and audits the mint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-code-'))
  try {
    const data = path.join(root, 'data')
    const before = Date.now()
    const run = mint(data, ['--machines', '3', '--hours', '12', '--trusted', '--slots', '4', '--prefix', 'vast-4090'])
    assert.equal(run.status, 0, run.stderr)
    // Nothing of the panel came along with the log: its sign-in writes a setup token at load when there is none.
    assert.ok(!fs.existsSync(path.join(data, 'setup-token')), 'the console\'s minter wrote a setup token')
    const lines = run.stdout.trim().split('\n')
    assert.equal(lines.length, 1, 'stdout is the code\'s alone')
    const answer = JSON.parse(lines[0]) as { code: string; expiresAt: number; machines: number; trusted: boolean; classes: boolean }
    assert.deepEqual(Object.keys(answer).sort(), ['classes', 'code', 'expiresAt', 'machines', 'trusted'])
    assert.match(answer.code, /^[a-f0-9]{32}$/)
    assert.equal(answer.machines, 3)
    assert.equal(answer.trusted, true)
    assert.equal(answer.classes, false)
    assert.ok(answer.expiresAt >= before + 12 * 3600_000 && answer.expiresAt <= Date.now() + 12 * 3600_000)
    const sha = createHash('sha256').update(answer.code).digest('hex')
    const db = new Database(path.join(data, 'colloq.db'), { readonly: true })
    try {
      const row = db.prepare('SELECT * FROM remote_runner_codes WHERE code_sha256 = ?').get(sha) as Record<string, unknown> | undefined
      assert.ok(row, 'the row is there, by the code\'s sha256')
      assert.equal(row.uses_left, 3)
      assert.equal(row.machines, 3)
      assert.equal(row.trusted, 1)
      assert.equal(row.approved_slots, 4)
      assert.equal(row.name_prefix, 'vast-4090')
      assert.equal(row.created_by, 'colloq-host')
      assert.equal(row.classes, 0)
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM remote_runner_codes').all()).includes(answer.code), 'the code itself nowhere')
      // The panel's line in the audit log, by the code's id in the owner's list (store.ts · codeIdOf):
      // nobody signed in, the console named, the code nowhere.
      const audited = db.prepare("SELECT * FROM admin_audit_log WHERE action = 'runner.code_minted'").all() as Record<string, unknown>[]
      assert.equal(audited.length, 1)
      const event = audited[0]
      assert.deepEqual([event.actor_id, event.actor_name, event.actor_email, event.actor_role, event.ip], [null, null, null, null, null])
      assert.deepEqual([event.target_type, event.target_id, event.target_label], ['runner_code', sha.slice(0, 16), 'vast-4090'])
      assert.deepEqual(JSON.parse(String(event.detail)), { machines: 3, hours: 12, trusted: true, classes: false, approvedSlots: 4, source: 'colloq-host' })
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM admin_audit_log').all()).includes(answer.code), 'nor in the audit log')
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

    // A line for each code minted, the defaults' with no prefix to name it by, and none for a refusal.
    const log = new Database(path.join(data, 'colloq.db'), { readonly: true })
    try {
      const minted = log.prepare("SELECT target_label, detail FROM admin_audit_log WHERE action = 'runner.code_minted' ORDER BY id").all() as { target_label: string | null; detail: string }[]
      assert.equal(minted.length, 2)
      assert.equal(minted[1].target_label, null)
      assert.deepEqual(JSON.parse(minted[1].detail), { machines: 1, hours: 24, trusted: false, classes: false, approvedSlots: null, source: 'colloq-host' })
    } finally {
      log.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('--classes mints a code whose machines take classes, into a fresh database that has the columns; never together with --trusted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-code-classes-'))
  try {
    const data = path.join(root, 'data')
    const run = mint(data, ['--machines', '2', '--classes', '--prefix', 'lab'])
    assert.equal(run.status, 0, run.stderr)
    const answer = JSON.parse(run.stdout.trim()) as { code: string; machines: number; trusted: boolean; classes: boolean }
    assert.equal(answer.classes, true)
    assert.equal(answer.trusted, false)
    const sha = createHash('sha256').update(answer.code).digest('hex')
    const db = new Database(path.join(data, 'colloq.db'), { readonly: true })
    try {
      // A database made from nothing by this release: the columns are there, with their defaults.
      const columns = (table: string) => Object.fromEntries((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[])
        .map((c) => [c.name, { notnull: c.notnull, dflt: c.dflt_value }]))
      const runners = columns('remote_runners')
      assert.deepEqual(runners.classes, { notnull: 1, dflt: '0' })
      assert.deepEqual(runners.classes_quarantined_at, { notnull: 0, dflt: null })
      assert.deepEqual(runners.classes_resumed_at, { notnull: 0, dflt: null })
      assert.deepEqual(columns('remote_runner_codes').classes, { notnull: 1, dflt: '0' })
      const row = db.prepare('SELECT * FROM remote_runner_codes WHERE code_sha256 = ?').get(sha) as Record<string, unknown>
      assert.equal(row.classes, 1)
      assert.equal(row.trusted, 0)
      const audited = db.prepare("SELECT detail FROM admin_audit_log WHERE action = 'runner.code_minted'").get() as { detail: string }
      assert.deepEqual(JSON.parse(audited.detail), { machines: 2, hours: 24, trusted: false, classes: true, approvedSlots: null, source: 'colloq-host' })
    } finally {
      db.close()
    }
    // No hidden test beside classes (D3): refused by the minter's rules, in words, with no code and no row.
    for (const args of [['--classes', '--trusted'], ['--trusted', '--machines', '3', '--classes']]) {
      const refused = mint(data, args)
      assert.equal(refused.status, 2, refused.stderr)
      assert.equal(refused.stdout, '')
      assert.match(refused.stderr, /--classes and --trusted do not go together: a machine that takes classes is never given the hidden test/)
    }
    const after = new Database(path.join(data, 'colloq.db'), { readonly: true })
    try {
      assert.equal((after.prepare('SELECT COUNT(*) AS n FROM remote_runner_codes').get() as { n: number }).n, 1)
      assert.equal((after.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'runner.code_minted'").get() as { n: number }).n, 1)
    } finally {
      after.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
