/**
 * «Принимает занятия» on machines and codes (docs/architecture/remote-classes.md
 * D2, D3, §6.7, §11.5-11.6): the classes flag as competitions/remote/store.ts
 * keeps it, and the join reply that hands it to a machine.
 *
 * Each would break without a word. A column added only by CREATE TABLE is
 * missing on every install that updates, and the first join there fails on
 * the INSERT; a code minted with the hidden test and classes together puts
 * the test on a host whose students' code can reach it; a join reply with
 * both is refused by its own agent (remote-runner.ts · parseRemoteJoinReply),
 * so a machine stuck that way never gets in; and the class quarantine and
 * the tunnel takeovers are counted from the log, so a kind the log does not
 * keep is a rule that never fires.
 *
 * THE DATABASE IS ONE 0.24.0 LEFT. The two tables with every column that
 * release had, a trusted machine and a code with a use left, written before
 * any server module opens the file: this release's store meets it as an
 * update does. A database made from nothing is the console minter's
 * (tests/remote-runner-code.test.mts).
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const OLD_CODE = 'ab'.repeat(16)
const OLD_RUNNER = 'oldtrstd'

{
  const dir = process.env.DATA_DIR!
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const old = new Database(path.join(dir, 'colloq.db'))
  // The data schema of 0.24.0, so that this release's stamp finds nothing to raise (db.ts · stampDataSchema).
  old.pragma('user_version = 2')
  old.exec(`
    CREATE TABLE remote_runners (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_sha256 TEXT NOT NULL, join_id TEXT UNIQUE,
      trusted INTEGER NOT NULL DEFAULT 0, approved_slots INTEGER, per_device INTEGER, state TEXT NOT NULL DEFAULT 'active',
      build TEXT, version TEXT, facts TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      revoked_at INTEGER, last_seen_at INTEGER, last_address TEXT, offer_seq INTEGER NOT NULL DEFAULT 0,
      code_sha256 TEXT, cards TEXT NOT NULL DEFAULT '[]', quarantined_at INTEGER, quarantine_seen INTEGER NOT NULL DEFAULT 0,
      wanted TEXT, resumed_at INTEGER
    );
    CREATE TABLE remote_runner_codes (
      code_sha256 TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      uses_left INTEGER NOT NULL, trusted INTEGER NOT NULL DEFAULT 0, approved_slots INTEGER, name_prefix TEXT NOT NULL,
      machines INTEGER NOT NULL DEFAULT 1
    );
  `)
  const now = Date.now()
  old.prepare(`INSERT INTO remote_runners (id, name, secret_sha256, join_id, trusted, state, build, version, created_by, created_at)
    VALUES (?, 'vast-old', ?, ?, 1, 'active', 'dev', '0.24.0', 'tests', ?)`).run(OLD_RUNNER, sha('a secret of 0.24.0'), 'c'.repeat(32), now)
  old.prepare(`INSERT INTO remote_runner_codes (code_sha256, created_by, created_at, expires_at, uses_left, trusted, approved_slots, name_prefix, machines)
    VALUES (?, 'tests', ?, ?, 1, 0, NULL, '', 1)`).run(sha(OLD_CODE), now, now + 3_600_000)
  old.close()
}

const store = await import('../server/src/competitions/remote/store.ts')
const { db } = await import('../server/src/db.ts')
const { Machine, close, reset, serve } = await import('./_remote.mts')

after(() => close())

/** A code minted the way the panel mints one, with the flags asked. */
function mint(flags: { trusted?: boolean; classes?: boolean } = {}): string {
  return store.mintRemoteCode({ machines: 1, hours: 1, trusted: flags.trusted ?? false, classes: flags.classes, approvedSlots: null, namePrefix: null, createdBy: 'tests' }).code
}

/** A machine joined with `joinCode`, as its agent joins: the reply parsed by the agent's own parser (_remote.mts · Machine.join). */
async function joined(joinCode: string) {
  const m = new Machine(await serve())
  const reply = await m.join(joinCode)
  assert.equal(reply.status, 200, JSON.stringify(reply.body))
  return { m, body: reply.body as { trusted: boolean; classes?: boolean }, runner: store.getRunner(m.runnerId)! }
}

const columns = (table: string) => Object.fromEntries((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[])
  .map((c) => [c.name, { notnull: c.notnull, dflt: c.dflt_value }]))

test('an install from before classes gains the columns, and what it held reads as it did: no classes', async () => {
  const runners = columns('remote_runners')
  assert.deepEqual(runners.classes, { notnull: 1, dflt: '0' })
  assert.deepEqual(runners.classes_quarantined_at, { notnull: 0, dflt: null })
  assert.deepEqual(runners.classes_resumed_at, { notnull: 0, dflt: null })
  assert.deepEqual(columns('remote_runner_codes').classes, { notnull: 1, dflt: '0' })
  // The trusted machine of 0.24.0 is still trusted, and takes no classes.
  const old = store.getRunner(OLD_RUNNER)!
  assert.deepEqual([old.trusted, old.classes, old.classesQuarantinedAt, old.classesResumedAt], [true, false, null, null])
  assert.equal(store.codeBySha(sha(OLD_CODE))!.classes, false)
  // Its live code enrolls as it would have: a machine without classes, told so.
  reset()
  const { body, runner } = await joined(OLD_CODE)
  assert.equal(body.classes, false)
  assert.equal(runner.classes, false)
})

test('a code is never minted for classes and the hidden test together, and the refusal writes nothing (D3)', () => {
  const ask = { machines: 1, hours: 1, approvedSlots: null, namePrefix: null }
  assert.equal(store.mintRefusal({ ...ask, trusted: true, classes: true }), 'classes')
  for (const flags of [{}, { trusted: true }, { classes: true }, { trusted: false, classes: false }]) assert.equal(store.mintRefusal({ ...ask, ...flags }), null, JSON.stringify(flags))
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM remote_runner_codes').get() as { n: number }).n
  const before = count()
  assert.throws(() => store.mintRemoteCode({ ...ask, trusted: true, classes: true, createdBy: 'tests' }), /Invalid enrollment code request: classes/)
  assert.equal(count(), before)
  // Either alone is minted, and says which it is; a code minted without the word takes no classes.
  const classes = store.mintRemoteCode({ ...ask, trusted: false, classes: true, createdBy: 'tests' })
  assert.deepEqual([classes.trusted, classes.classes], [false, true])
  assert.equal(store.codeBySha(sha(classes.code))!.classes, true)
  const plain = store.mintRemoteCode({ ...ask, trusted: true, createdBy: 'tests' })
  assert.deepEqual([plain.trusted, plain.classes], [true, false])
  assert.equal(count(), before + 2)
})

test('a machine takes the classes flag of the code it joins with, and the join reply carries it', async () => {
  reset()
  const classes = await joined(mint({ classes: true }))
  assert.deepEqual([classes.body.trusted, classes.body.classes], [false, true])
  assert.deepEqual([classes.runner.trusted, classes.runner.classes], [false, true])
  // A join whose reply was lost, repeated: the same machine, with the same flag.
  const code = mint({ classes: true })
  const first = await joined(code)
  const repeated = await first.m.join(code)
  assert.equal(repeated.status, 200)
  assert.equal((repeated.body as { classes: boolean }).classes, true)
  // A trusted code enrolls a trusted machine without classes; a plain one neither; the reply always says.
  const trusted = await joined(mint({ trusted: true }))
  assert.deepEqual([trusted.body.trusted, trusted.body.classes, trusted.runner.classes], [true, false, false])
  const plain = await joined(mint())
  assert.deepEqual([plain.body.trusted, plain.body.classes, plain.runner.classes], [false, false, false])
})

test('the store holds D3 for every writer, and a row hand-edited into both reads as the machine it was before classes', async () => {
  reset()
  const classes = await joined(mint({ classes: true }))
  assert.throws(() => store.updateRunner(classes.runner.id, { trusted: true }), store.RunnerFlagsError)
  assert.equal(store.getRunner(classes.runner.id)!.trusted, false, 'the refused write left the row alone')
  const trusted = await joined(mint({ trusted: true }))
  assert.throws(() => store.updateRunner(trusted.runner.id, { classes: true }), store.RunnerFlagsError)
  assert.deepEqual(store.setRunnerClasses(trusted.runner.id, true), { refused: 'trusted' })
  assert.equal(store.getRunner(trusted.runner.id)!.classes, false)
  // The pair as it will be is what counts: one flag for the other in one write is no pair.
  assert.deepEqual(pick(store.updateRunner(classes.runner.id, { trusted: true, classes: false })!), [true, false])
  assert.deepEqual(pick(store.updateRunner(classes.runner.id, { trusted: false, classes: true })!), [false, true])
  // Both, by hand in sqlite: no classes are read off it, and its repeated join is one its agent accepts.
  const code = mint({ trusted: true })
  const edited = await joined(code)
  db.prepare('UPDATE remote_runners SET classes = 1 WHERE id = ?').run(edited.runner.id)
  assert.deepEqual(pick(store.getRunner(edited.runner.id)!), [true, false])
  const repeated = await edited.m.join(code)
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body))
  assert.deepEqual([(repeated.body as { trusted: boolean }).trusted, (repeated.body as { classes: boolean }).classes], [true, false])
  // A code edited so, the same: it enrolls the trusted machine of 0.23, and the reply is one the agent takes.
  const both = mint({ trusted: true })
  db.prepare('UPDATE remote_runner_codes SET classes = 1 WHERE code_sha256 = ?').run(sha(both))
  assert.deepEqual(pick(store.codeBySha(sha(both))!), [true, false])
  const enrolled = await joined(both)
  assert.deepEqual([enrolled.body.trusted, enrolled.body.classes], [true, false])
  assert.deepEqual(pick(enrolled.runner), [true, false])
  assert.equal((db.prepare('SELECT classes FROM remote_runners WHERE id = ?').get(enrolled.runner.id) as { classes: number }).classes, 0, 'and the row says it too')
})

/** A machine's two flags: trusted, classes. */
function pick(runner: { trusted: boolean; classes: boolean }): [boolean, boolean] {
  return [runner.trusted, runner.classes]
}

test('setRunnerClasses and resumeRunnerClasses are the owner\'s toggle and «Вернуть»: the row alone, and whether it changed', async () => {
  reset()
  assert.deepEqual(store.setRunnerClasses('nosuchid', true), { refused: 'unknown' })
  assert.deepEqual(store.resumeRunnerClasses('nosuchid'), { refused: 'unknown' })
  const { runner } = await joined(mint())
  const events = () => store.runnerEvents(runner.id, 100).length
  const logged = events()
  let set = store.setRunnerClasses(runner.id, true)
  assert.ok('runner' in set)
  assert.deepEqual([set.changed, set.runner.classes], [true, true])
  set = store.setRunnerClasses(runner.id, true)
  assert.ok('runner' in set)
  assert.equal(set.changed, false)
  // Not under the class quarantine: nothing to resume.
  let resumed = store.resumeRunnerClasses(runner.id, 1_000)
  assert.ok('runner' in resumed)
  assert.equal(resumed.changed, false)
  // Under it: lifted, and the next window starts at the resume; the submissions' own quarantine is another one, untouched.
  store.updateRunner(runner.id, { classesQuarantinedAt: 500, quarantinedAt: 400 })
  resumed = store.resumeRunnerClasses(runner.id, 1_000)
  assert.ok('runner' in resumed)
  assert.deepEqual([resumed.changed, resumed.runner.classesQuarantinedAt, resumed.runner.classesResumedAt, resumed.runner.quarantinedAt, resumed.runner.classes], [true, null, 1_000, 400, true])
  set = store.setRunnerClasses(runner.id, false)
  assert.ok('runner' in set)
  assert.deepEqual([set.changed, set.runner.classes], [true, false])
  // The lines in the log are their callers' (unclassRunner's `unclassed`, the panel's `classes_resumed`).
  assert.equal(events(), logged)
  // A machine revoked or gone is not one to change.
  store.updateRunner(runner.id, { state: 'revoked' })
  assert.deepEqual(store.setRunnerClasses(runner.id, true), { refused: 'gone' })
  assert.deepEqual(store.resumeRunnerClasses(runner.id), { refused: 'gone' })
})

test('the log takes the kinds of classes, and the class rules read them back by kind and time, oldest first', async () => {
  reset()
  const { runner } = await joined(mint({ classes: true }))
  const t0 = 1_800_000_000_000
  store.REMOTE_CLASS_EVENT_KINDS.forEach((kind, i) => store.remoteEvent(runner.id, kind, { detail: `${kind} ${i}` }, t0 + i))
  store.remoteEvent(runner.id, 'tunnel_replaced', { address: '9.10.11.12', detail: 'from 5.6.7.8' }, t0 + 100)
  store.remoteEvent(runner.id, 'class_failover', { detail: 'silence' }, t0 + 200)
  // The machine's page lists them by their kinds, newest first, as any line.
  const listed = store.runnerEvents(runner.id, 100).map((event) => event.kind as string)
  for (const kind of store.REMOTE_CLASS_EVENT_KINDS) assert.ok(listed.includes(kind), kind)
  assert.deepEqual(listed.slice(0, 2), ['class_failover', 'tunnel_replaced'])
  // What the quarantine and the takeover banner count: their kind, from a moment on.
  const failovers = store.runnerEventsOf(runner.id, ['class_failover'], t0 + 1)
  assert.deepEqual(failovers.map((event) => [event.at, event.detail]), [[t0 + 1, 'class_failover 1'], [t0 + 200, 'silence']])
  const takeovers = store.runnerEventsOf(runner.id, ['tunnel_replaced'], t0 + 50)
  assert.deepEqual(takeovers.map((event) => [event.kind, event.address, event.detail]), [['tunnel_replaced', '9.10.11.12', 'from 5.6.7.8']])
  assert.deepEqual(store.runnerEventsOf(runner.id, ['tunnel_replaced', 'perimeter_failing'], t0).map((event) => event.kind), ['tunnel_replaced', 'perimeter_failing', 'tunnel_replaced'])
  assert.deepEqual(store.runnerEventsOf(runner.id, [], 0), [])
  // Another machine's lines are not this one's.
  const other = await joined(mint({ classes: true }))
  assert.deepEqual(store.runnerEventsOf(other.runner.id, ['class_failover', 'tunnel_replaced'], 0), [])
})
