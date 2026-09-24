/**
 * The .env that make creates is good for `make dev`.
 *
 * Caught like this: `make up` (or run, host, activity — any target with the
 * `.env` prerequisite) on a fresh clone did `cp .env.example .env`, and
 * .env.example is the production template with KERNEL_BACKEND=broker. The
 * next `make dev` (the cli/src/launch.ts supervisor) refused: "This is a
 * runtime broker installation". The target now writes the same file as
 * colloq itself (scripts/local-env.sh ↔ launch-config.ts · localClassEnv),
 * and the tests below hold three things: the copies of the text do not drift
 * apart; the order "make target, then make dev" and the reverse both work;
 * the refusal on a real production install is still there.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'dotenv'
import { launchConfig, localClassEnv, parseLaunchArgs } from '../cli/src/launch-config.js'

const repo = path.resolve(import.meta.dirname, '..')

/** A clone in miniature: exactly what the `.env` and `up` targets touch (without docker). */
function checkout(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'colloq-local-env-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const file of ['Makefile', '.env.example', 'docker-compose.yml', 'scripts/local-env.sh'])
    fs.copyFileSync(path.join(repo, file), path.join(dir, file))
  return dir
}

function make(dir: string, ...args: string[]): { code: number | null; out: string } {
  return makeIn(dir, process.env, args)
}

function makeIn(dir: string, env: NodeJS.ProcessEnv, args: string[]): { code: number | null; out: string } {
  const result = spawnSync('make', ['--no-print-directory', ...args], { cwd: dir, env, encoding: 'utf8' })
  // Makefile colours (\033[…m) are stripped from the output: we check the
  // text, not the styling.
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') }
}

/** A docker stub first on PATH: targets that call it pass without a daemon. */
function stubDocker(dir: string): NodeJS.ProcessEnv {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }
}

/** Each write gets its own token — we compare everything except its value. */
const tokenless = (text: string) => text.replace(/^JUPYTER_TOKEN=.*$/m, 'JUPYTER_TOKEN=<token>')

test('make .env writes the local class .env — the same one colloq writes, not the production template', () => {
  const dir = checkout()
  try {
    const result = make(dir, '.env')
    assert.equal(result.code, 0, result.out)
    const written = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    // The copies of the text — shell for make and TS for colloq — match line
    // for line.
    assert.equal(tokenless(written), tokenless(localClassEnv(false)))
    assert.match(written, /^KERNEL_BACKEND=docker$/m)
    assert.doesNotMatch(written, /broker|colloq-runtime|\/etc\/colloq/)
    // Its own kernel token, the same length as colloq's randomBytes(24), and
    // it does not repeat.
    const token = written.match(/^JUPYTER_TOKEN=(.*)$/m)?.[1] ?? ''
    assert.match(token, /^[0-9a-f]{48}$/)
    fs.rmSync(path.join(dir, '.env'))
    assert.equal(make(dir, '.env').code, 0)
    assert.notEqual(parse(fs.readFileSync(path.join(dir, '.env'))).JUPYTER_TOKEN, token)
    // It will hold sign-in keys — 0600, like the supervisor's file.
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('after a make target the supervisor accepts the .env: both dev and run', () => {
  const dir = checkout()
  try {
    assert.equal(make(dir, '.env').code, 0)
    const source = parse(fs.readFileSync(path.join(dir, '.env')))
    for (const action of ['dev', 'run']) {
      const config = launchConfig(dir, parseLaunchArgs([action]), source, dir)
      assert.equal(config.env.KERNEL_BACKEND, 'docker', action)
      assert.equal(config.port, 3000, action)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a template copy from an old clone: the refusal names the line and the file, not "go to cluster"', () => {
  // Everyone who has run make up since 9 Sep 2026 has such a .env: the target
  // copied the template.
  const source = parse(fs.readFileSync(path.join(repo, '.env.example')))
  assert.equal(source.KERNEL_BACKEND, 'broker', 'the production template is still about broker')
  assert.throws(
    () => launchConfig('/clone', parseLaunchArgs(['dev']), source, '/clone'),
    (error: Error) =>
      /KERNEL_BACKEND=docker/.test(error.message) &&
      error.message.includes(path.join('/clone', '.env')) &&
      /\.env\.example/.test(error.message),
  )
})

test('a real installation still does not start as a class on a laptop', () => {
  // COLLOQ_CLUSTER=1 is written only by a deployment (scripts/vast.sh) — the
  // same refusal as before.
  assert.throws(
    () => launchConfig('/vm', parseLaunchArgs(['run']), { ...localEnv(), COLLOQ_CLUSTER: '1' }),
    /runtime broker installation: use the service or cluster commands/,
  )
  // broker from the shell (the variable beats the file) is a refusal too, and
  // the file will not cancel it.
  assert.throws(
    () => launchConfig('/vm', parseLaunchArgs(['dev']), { ...localEnv(), KERNEL_BACKEND: 'broker' }),
    /service or cluster commands/,
  )
})

function localEnv(): Record<string, string> {
  return parse(localClassEnv(false))
}

test('the reverse order: make up leaves the supervisor .env alone and hands all of it to compose', () => {
  const dir = checkout()
  try {
    // This is how launch.ts writes it on the first make dev.
    const own = localClassEnv(false)
    fs.writeFileSync(path.join(dir, '.env'), own, { mode: 0o600 })
    assert.equal(make(dir, '.env').code, 0)
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), own, 'the existing .env is not rewritten')
    // make up without docker: -n prints what it would do. The .env writer is
    // not among it.
    const plan = make(dir, '-n', 'up')
    assert.equal(plan.code, 0, plan.out)
    assert.doesNotMatch(plan.out, /local-env\.sh/)
    assert.match(plan.out, /docker compose up -d --build app/)
    // Every line a person edits in this .env is also read by compose — except
    // KERNEL_BACKEND: compose sets docker itself. Otherwise editing PORT or
    // the oracle key under make up would silently change nothing.
    const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')
    const read = new Set([...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]))
    assert.match(compose, /KERNEL_BACKEND: docker/)
    for (const key of Object.keys(parse(own)).filter((k) => k !== 'KERNEL_BACKEND'))
      assert.ok(read.has(key), `${key} from the class .env does not reach make up`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Exactly a person's path: a make target created the .env, then the real
 * supervisor.
 *
 * The server port is taken in advance by our own listener, so the
 * supervisor, having accepted the settings, stops at the port check —
 * building and starting nothing. Before the fix it failed earlier, on broker.
 */
test('make .env, then launch.ts dev: it gets as far as the port check, not a refusal about broker', async () => {
  const dir = checkout()
  const blocker = net.createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busy = (blocker.address() as net.AddressInfo).port
  try {
    assert.equal(make(dir, '.env').code, 0)
    const env: NodeJS.ProcessEnv = { ...process.env, COLLOQ_HOME: dir, PORT: String(busy) }
    for (const key of ['KERNEL_BACKEND', 'COLLOQ_CLUSTER', 'COLLOQ_APP_DIR', 'DATA_DIR', 'WORKSPACE_DIR'])
      delete env[key]
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'cli/src/launch.ts', 'dev', '--no-open', '--port', String(busy === 65535 ? busy - 1 : busy + 1)],
      { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    assert.equal(code, 1, out)
    assert.match(out, new RegExp(`Port ${busy} .*already taken`), out)
    assert.doesNotMatch(out, /broker/, out)
    // The refusal left nothing behind: no receipt, no pid file.
    assert.equal(fs.existsSync(path.join(dir, '.colloq/local-session.json')), false)
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A busy default port is not a refusal: the nearest free one is taken, as
 * Jupyter does. One named explicitly (--port) is a refusal, as before. Docker
 * cannot be found here on purpose (PATH holds only node): the launch stops at
 * "Docker is not responding" without building anything — by then the line
 * about the port has already been printed.
 */
test('run: a busy default port moves to the nearest free one, a busy --port is refused', async () => {
  const dir = checkout()
  const blocker = net.createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busy = (blocker.address() as net.AddressInfo).port
  const launch = async (args: string[]): Promise<{ code: number | null; out: string }> => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COLLOQ_HOME: dir,
      PORT: String(busy),
      PATH: path.dirname(process.execPath),
    }
    for (const key of ['KERNEL_BACKEND', 'COLLOQ_CLUSTER', 'COLLOQ_APP_DIR', 'DATA_DIR', 'WORKSPACE_DIR'])
      delete env[key]
    const child = spawn(process.execPath, ['--import', 'tsx', 'cli/src/launch.ts', 'run', '--no-open', ...args], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    return { code, out }
  }
  try {
    assert.equal(make(dir, '.env').code, 0)
    const moved = await launch([])
    assert.match(moved.out, new RegExp(`Port ${busy} is taken; using ${busy + 1}\\.`), moved.out)
    assert.doesNotMatch(moved.out, /already taken/, moved.out)
    assert.match(moved.out, /Docker is not responding/, moved.out)

    const named = await launch(['--port', String(busy)])
    assert.equal(named.code, 1, named.out)
    assert.match(named.out, new RegExp(`Port ${busy} is already taken`), named.out)
    assert.doesNotMatch(named.out, /using/, named.out)
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/*
 * env-use on a fresh clone. The target rewrote .env through grep -v and
 * appended KERNEL_ENV — and when there was no file yet, the result was a .env
 * of that one line. After that neither make up nor make dev wrote their own
 * (the file exists, after all), and the class ran with the defaults and a
 * publicly known kernel token. `colloq env use` (cli/src/commands/env.ts) had
 * the same bug; for make it was closed by the .env prerequisite.
 */
test('make env-use on a fresh clone: a full class .env, not a single KERNEL_ENV line', () => {
  const dir = checkout()
  try {
    fs.mkdirSync(path.join(dir, 'kernel/environments'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'kernel/environments/cv.txt'), 'numpy\n')
    const result = makeIn(dir, stubDocker(dir), ['env-use', 'NAME=cv'])
    assert.equal(result.code, 0, result.out)
    const text = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    const env = parse(text)
    assert.equal(text.match(/^KERNEL_ENV=/gm)?.length, 1, text)
    assert.equal(env.KERNEL_ENV, 'cv')
    assert.match(env.JUPYTER_TOKEN ?? '', /^[0-9a-f]{48}$/)
    // Apart from the environment and the token it is exactly the class file:
    // env-use changes one line.
    const own = parse(localClassEnv(false))
    assert.deepEqual({ ...env, KERNEL_ENV: own.KERNEL_ENV, JUPYTER_TOKEN: '' }, { ...own, JUPYTER_TOKEN: '' })
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600)
    assert.equal(launchConfig(dir, parseLaunchArgs(['dev']), env, dir).kernelEnv, 'cv')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/*
 * The class file has no PUBLIC_URL (colloq never had one either), and make
 * run and make status printed the line from .env as is: a server that was
 * ready was announced as an empty "colloq at". Without the line the server
 * takes localhost:PORT (config.ts · readPublicUrl) — and that is what must be
 * printed.
 */
test('make status and make run without PUBLIC_URL print localhost:PORT, not an empty link', () => {
  const dir = checkout()
  try {
    assert.equal(make(dir, '.env').code, 0)
    const env = stubDocker(dir)
    const shown = () => {
      const result = makeIn(dir, env, ['status'])
      assert.equal(result.code, 0, result.out)
      return result.out.match(/^PUBLIC_URL: (.*)$/m)?.[1]
    }
    assert.equal(shown(), 'http://localhost:3000')
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^PORT=3000$/m, 'PORT=4000'))
    assert.equal(shown(), 'http://localhost:4000')
    fs.appendFileSync(file, 'PUBLIC_URL=https://demo.example.org\n')
    assert.equal(shown(), 'https://demo.example.org')
    // run starts a real server, so here only its plan is checked: the same
    // substitution.
    const plan = make(dir, '-n', 'run')
    assert.equal(plan.code, 0, plan.out)
    assert.match(plan.out, /"\$\{url:-http:\/\/localhost:4000\}"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
