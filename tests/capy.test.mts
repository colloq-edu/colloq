/**
 * The capybara high-score table: whose name it is and who gets into the table.
 *
 * The service (scripts/relay-capy.py) lives on the relay and until now was
 * checked only by hand — and two of the rules the room sees were broken in it.
 *
 * THE FIRST: you could take someone else's name. The check "the name belongs
 * to another owner — 409" sat INSIDE `if name != ANON and owner`, that is, it
 * was asked only of whoever sent an owner key. A request without a key — a
 * three-line `curl` — wrote anything under any name and overwrote someone
 * else's record. The rule existed; you got around it simply because nobody
 * asked it.
 *
 * THE SECOND: nameless attempts. An empty name became "Аноним" (Anonymous),
 * and every such attempt took ITS OWN permanent row: in the live table of
 * eight rows, five were "Аноним". Now a row in the table starts with a name;
 * you can play without a name as much as you like, and the old nameless rows
 * stayed in the file, count towards attempts and are not shown.
 *
 * The real service is checked, on its own port with a temporary file: the
 * rules live in it, not in a TypeScript copy, and they cannot be rewritten
 * behind the test's back. The address for the rate limit is taken from the
 * last element of X-Forwarded-For — each check has its own, otherwise the
 * five-write bucket would run out halfway through the file.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const python = spawnSync('python3', ['--version'])
const HAVE_PYTHON = python.status === 0

const OWNER_A = 'a1b2c3d4e5f60718'
const OWNER_B = 'ffffffffffffffff'

/** A free port: the service listens on a real socket. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

let service: ChildProcess | null = null
let base = ''
let root = ''

async function up(): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'capy-test-'))
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  /*
   * A legacy of the live machine: a nameless row and a named one without an
   * owner, both written before the current rules. The first must not be
   * shown; the second goes to the first person who writes under that name
   * with their own key.
   */
  fs.writeFileSync(
    path.join(root, 'state', 'scores.json'),
    JSON.stringify([
      { id: 'старая-безымянная', name: 'Аноним', score: 592, at: 1 },
      { id: 'старая-ничья', name: 'Ule4ka', score: 854, at: 2 },
    ]),
  )
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  service = spawn('python3', [path.resolve(import.meta.dirname, '..', 'scripts/relay-capy.py')], {
    env: { ...process.env, CAPY_STATE: path.join(root, 'state'), CAPY_PORT: String(port) },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/.relay/capy/scores`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the capybara service did not come up')
}

function down(): void {
  service?.kill('SIGKILL')
  if (root) fs.rmSync(root, { recursive: true, force: true })
}

interface Answer {
  status: number
  body: Record<string, any>
}

/** A run token: without it a write is not accepted at all. */
async function runToken(): Promise<string> {
  const r = await fetch(`${base}/.relay/capy/start`)
  return ((await r.json()) as { run: string }).run
}

/** Write a score. `from` is each check's own address, for the rate limit. */
async function send(
  from: string,
  body: Record<string, unknown>,
  withRun = true,
): Promise<Answer> {
  const payload = withRun ? { run: await runToken(), ...body } : body
  const r = await fetch(`${base}/.relay/capy/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
    body: JSON.stringify(payload),
  })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}

async function scores(): Promise<Record<string, any>> {
  const r = await fetch(`${base}/.relay/capy/scores`)
  return (await r.json()) as Record<string, any>
}

const suite = test.suite ?? test.describe

suite('capybara high-score table', { skip: HAVE_PYTHON ? false : 'no python3' }, () => {
  test.before(up)
  test.after(down)

  test('old nameless rows are not shown but count towards attempts', async () => {
    const board = await scores()
    assert.deepEqual(
      board.top.map((r: any) => r.name),
      ['Ule4ka'],
      '"Anonymous" is in the table again',
    )
    // The attempt happened, and a person made it: count it honestly.
    assert.equal(board.total, 2)
    assert.equal(board.names, 1, 'nameless rows were counted as a name')
  })

  test('a name with its own key is written', async () => {
    const { status, body } = await send('10.0.0.1', {
      name: 'sleep3r',
      score: 30,
      owner: OWNER_A,
    })
    assert.equal(status, 200)
    assert.equal(body.name, 'sleep3r')
    assert.equal(body.best, 30)
  })

  test("someone else's key on a taken name gets 409, and the owner's record is intact", async () => {
    const { status, body } = await send('10.0.0.2', {
      name: 'SLEEP3R',
      score: 45,
      owner: OWNER_B,
    })
    assert.equal(status, 409, 'the name was given to another owner')
    assert.equal(body.error, 'name taken')
    const board = await scores()
    const mine = board.top.find((r: any) => r.name === 'sleep3r')
    assert.equal(mine.score, 30, "someone else's write overwrote the record")
  })

  test('a name cannot be taken without an owner key: 400', async () => {
    // The very hole: the 409 check was simply not asked when there was no key.
    const { status, body } = await send('10.0.0.3', { name: 'sleep3r', score: 45 })
    assert.equal(status, 400)
    assert.equal(body.error, 'owner')
    const board = await scores()
    assert.equal(board.top.find((r: any) => r.name === 'sleep3r').score, 30)
  })

  test('a garbage owner key gets the same refusal, not "no key"', async () => {
    for (const owner of ['нет', '', 'abc', 'ZZZZZZZZZZZZZZZZ', 'a1b2c3d4e5f6071']) {
      const { status, body } = await send('10.0.0.4', { name: 'sleep3r', score: 45, owner })
      assert.equal(status, 400, `key ${JSON.stringify(owner)} was accepted`)
      assert.equal(body.error, 'owner')
    }
  })

  test('no name, no write', async () => {
    for (const name of ['', '   ', '​​', undefined]) {
      const { status, body } = await send('10.0.0.5', { name, score: 40, owner: OWNER_B })
      assert.equal(status, 400, `name ${JSON.stringify(name)} was accepted`)
      assert.equal(body.error, 'name')
    }
    const board = await scores()
    assert.ok(
      !board.top.some((r: any) => r.name === 'Аноним'),
      'a nameless attempt created a row again',
    )
  })

  test('"Anonymous" is not a name: it cannot be taken', async () => {
    // Taking it, a person would get the old nameless rows along with it.
    for (const name of ['Аноним', 'аноним', ' АНОНИМ ']) {
      const { status, body } = await send('10.0.0.6', { name, score: 40, owner: OWNER_B })
      assert.equal(status, 400, `"${name}" was accepted as a name`)
      assert.equal(body.error, 'name')
    }
  })

  test('an ownerless row goes to the first person who writes under it with their own key', async () => {
    const first = await send('10.0.0.7', { name: 'Ule4ka', score: 20, owner: OWNER_B })
    assert.equal(first.status, 200)
    assert.equal(first.body.best, 854, 'the old record under this name was lost')
    // And for the second one it is already taken.
    const second = await send('10.0.0.8', { name: 'ule4ka', score: 20, owner: OWNER_A })
    assert.equal(second.status, 409)
  })

  test("a name change: the owner's rows move along with the record", async () => {
    const { status, body } = await send('10.0.0.9', { name: 'Соня', score: 10, owner: OWNER_A })
    assert.equal(status, 200)
    assert.equal(body.renamed, true, 'the previous rows stayed under the old name')
    assert.equal(body.best, 30, 'the record did not move with the name')
    const board = await scores()
    assert.ok(!board.top.some((r: any) => r.name === 'sleep3r'), 'the old name stayed in the table')
    assert.equal(board.top.find((r: any) => r.name === 'Соня').score, 30)
  })

  test('the table has one row per name and not a single "Anonymous"', async () => {
    const board = await scores()
    const names = board.top.map((r: any) => r.name)
    assert.deepEqual(new Set(names).size, names.length, 'a name repeats')
    assert.ok(!names.includes('Аноним'))
    assert.equal(board.names, names.length)
  })
})
