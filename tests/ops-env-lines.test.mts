/**
 * .env as a settings file, not as a program for the shell.
 *
 * Two bugs, each of which cost a class. The first: `set -a; . ./.env` before
 * starting the server. That is not reading the file but executing it, and a
 * line like `INSTITUTION=Высшая школа экономики` — exactly the form that
 * .env.example and README ask for — is, for bash, the command `школа` with a
 * prefix assignment: rc=127. In `scripts/host.sh` under `set -euo pipefail`
 * this killed the subshell AFTER the line above had already killed the old
 * server: the teacher was left with no server at all right before class.
 *
 * The second: `read_env`, copied into three scripts, stripped every space
 * with `tr -d ' \r'`, wherever it stood. GPU names in the vast API are written
 * with a space, and `VAST_GPU=RTX 4090` turned into "RTX4090", for which
 * there are no offers — and the script advised putting into .env what was
 * already there.
 *
 * Both are checked here: that starting the server sources nothing, that
 * dotenv (the path the server actually reads .env through) takes a value with
 * spaces whole, and that the shared read_env touches only the edges.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The value everything broke on: spaces inside, Cyrillic. */
const INSTITUTION = 'Высшая школа экономики'

/** This file's directories — and cleanup after them: without it /tmp grows with every run. */
const made: string[] = []
after(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-env-'))
  made.push(dir)
  return dir
}

/** One line from .env as the shared read_env (scripts/lib.sh) sees it. */
function readEnv(dir: string, name: string): string {
  return execFileSync(
    'bash',
    ['-c', `. "${path.join(repo, 'scripts/lib.sh')}"; read_env ${name}`],
    { cwd: dir, encoding: 'utf8' },
  )
}

test('starting the server does not source .env: neither the Makefile nor host.sh', () => {
  /*
   * Guard the form, not the whole line: `. ./.env`, `source .env`, `set -a`
   * next to the start — all of these bring back the same failure.
   */
  const suspects = [
    'Makefile',
    'scripts/host.sh',
    'scripts/service.sh',
    'scripts/vast.sh',
    'scripts/restore.sh',
  ]
  for (const file of suspects) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    const lines = text.split('\n')
    for (const [i, line] of lines.entries()) {
      // Comments tell about this bug — we do not catch them.
      const code = line.replace(/^\s*@?#.*/, '').replace(/^\s*@?:\s+'.*/, '')
      assert.ok(
        !/(^|[;&(\s])(\.|source)\s+\.?\/?\.env(\s|$|;|\))/.test(code),
        `${file}:${i + 1} sources .env with the shell: ${line.trim()}`,
      )
    }
  }
})

test('a value with spaces reaches the server through dotenv, not through the shell', () => {
  const dir = tmpdir()
  fs.writeFileSync(
    path.join(dir, '.env'),
    `PORT=3000\nINSTITUTION=${INSTITUTION}\nVAST_GPU=RTX 4090\n`,
  )
  /*
   * Exactly the path the server reads through: `import 'dotenv/config'` as the
   * first line of server/src/config.ts, the file taken from the process's
   * working directory. The package is named by its full path only because the
   * process runs outside the repository — it still reads .env from its cwd.
   */
  const dotenvConfig = path.join(repo, 'node_modules/dotenv/config.js')
  const env = { ...process.env }
  delete env.INSTITUTION
  const out = execFileSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(dotenvConfig)}); console.log(process.env.INSTITUTION)`],
    { cwd: dir, encoding: 'utf8', env },
  )
  assert.equal(out.trim(), INSTITUTION)
})

test('while the old way — executing the file with the shell — fails on this very line', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.env'), `INSTITUTION=${INSTITUTION}\n`)
  const r = spawnSync('bash', ['-c', 'set -euo pipefail; ( set -a; . ./.env; set +a; true )'], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0, 'source .env with a value containing a space must fail — that is why it was removed')
  assert.match(r.stderr, /command not found|не найдена/i)
})

test('read_env keeps spaces inside a value and strips only the edges', () => {
  const dir = tmpdir()
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      'VAST_GPU=RTX 4090',
      `INSTITUTION=${INSTITUTION}`,
      'PORT=  3001  ',
      'QUOTED="two words"',
      "APOS=it's",
      '',
    ].join('\n'),
  )
  assert.equal(readEnv(dir, 'VAST_GPU'), 'RTX 4090')
  assert.equal(readEnv(dir, 'INSTITUTION'), INSTITUTION)
  assert.equal(readEnv(dir, 'PORT'), '3001')
  assert.equal(readEnv(dir, 'QUOTED'), 'two words')
  assert.equal(readEnv(dir, 'APOS'), "it's")
  assert.equal(readEnv(dir, 'MISSING'), '')
})

test('read_env: a Windows carriage return does not end up inside the value', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.env'), 'RELAY_ADDR=1.2.3.4\r\nPORT=3000\r\n')
  assert.equal(readEnv(dir, 'RELAY_ADDR'), '1.2.3.4')
})

test('read_env takes the last line: what is appended at the end wins', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.env'), 'KERNEL_ENV=base\nKERNEL_ENV=gpu\n')
  assert.equal(readEnv(dir, 'KERNEL_ENV'), 'gpu')
})

test('only one copy of read_env is left — in scripts/lib.sh', () => {
  const others = ['scripts/host.sh', 'scripts/vast.sh', 'scripts/restore.sh', 'scripts/dns.sh']
  for (const file of others) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    assert.ok(
      !/^\s*read_env\(\)/m.test(text),
      `${file} has its own copy of read_env — an edit to one of them will drift from the rest`,
    )
    assert.ok(/lib\.sh/.test(text), `${file} must source scripts/lib.sh`)
  }
})

test('dns.sh asks .env for the relay address and does not touch the zone without it', () => {
  const dir = tmpdir()
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const f of ['dns.sh', 'lib.sh']) {
    fs.copyFileSync(path.join(repo, 'scripts', f), path.join(dir, 'scripts', f))
  }
  fs.chmodSync(path.join(dir, 'scripts/dns.sh'), 0o755)
  // There is a token but no relay address: it must not get as far as the network.
  fs.writeFileSync(path.join(dir, '.env'), 'CF_TOKEN=not-a-real-token\nCF_ZONE=zzz\n')
  // A shell variable is stronger than the file — whoever runs the tests may
  // have it set, and then it would not be the file being checked.
  const env = { ...process.env }
  delete env.RELAY_ADDR
  const r = spawnSync('bash', [path.join(dir, 'scripts/dns.sh')], {
    encoding: 'utf8',
    timeout: 20_000,
    env,
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /RELAY_ADDR/)

  // And the hard-wired address is gone from the script — it was exactly what
  // silently pointed `*.colloq.ru` back at the old machine after the relay
  // moved.
  const text = fs.readFileSync(path.join(repo, 'scripts/dns.sh'), 'utf8')
  assert.ok(
    !/RELAY=\$\{RELAY_ADDR:-[0-9]/.test(text),
    'the default address is back in dns.sh',
  )
})
