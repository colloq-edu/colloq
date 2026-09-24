/**
 * `make host` on a k3s machine: no docker, with a panel link, with cleanup.
 *
 * Three failures found on one and the same path — `make vast-up HOST=…` under
 * a release, where scripts/host.sh runs with COLLOQ_CLUSTER=1:
 *
 *  - the script required docker on its first line, although under a release
 *    the server and the kernels live in k3s and the VM may have no docker at
 *    all — the tmux session with the tunnel died a second later and the
 *    address was never set;
 *  - the panel link was printed only for someone who had set DATA_DIR
 *    themselves: the k3s token lives in <COLLOQ_STATE_DIR>/data
 *    (/var/lib/colloq/data), while the script looked for it in ./data;
 *  - after Ctrl+C the cluster kept handing out links to a dead tunnel: the
 *    cleanup went around cluster.sh.
 *
 * The script here is real; around it are made-up curl, dig, cloudflared and
 * scripts/cluster.sh, and PATH is assembled name by name, without docker:
 * otherwise it would be found on a developer's machine and hide the first
 * failure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TUNNEL = 'https://quick-test.trycloudflare.com'
const LOCAL = 'http://127.0.0.1:30080'
const TOKEN = 'k3s-setup-token-1234567890'

/** System utilities that host.sh calls on this path, and not a single extra. */
const TOOLS = ['bash', 'sh', 'cat', 'grep', 'tail', 'cut', 'mktemp', 'rm', 'wc', 'sed', 'seq', 'sleep',
  'head', 'tr', 'dirname', 'env', 'mkdir', 'ls', 'id', 'uname']

function stand() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-cluster-host-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const file of ['host.sh', 'lib.sh']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(dir, 'scripts', file))
  const calls = path.join(dir, 'cluster-calls')
  // cluster.sh is made up: it records what it was called with. On
  // --if-current it answers 4 when the test says "the address is someone
  // else's now", and 75 with a reason when "the state lock is taken".
  fs.writeFileSync(path.join(dir, 'scripts/cluster.sh'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in *--if-current*)
  [ -z "$FAKE_FOREIGN" ] || exit 4
  [ -z "$FAKE_LOCKED" ] || { echo 'operation lock: another operation is active' >&2; exit 75; };;
esac
exit 0
`, { mode: 0o755 })
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin)
  for (const tool of TOOLS) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    assert.ok(found.startsWith('/'), `no ${tool} on this machine`)
    fs.symlinkSync(found, path.join(bin, tool))
  }
  const fake = (name: string, code: string) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}\n`, { mode: 0o755 })
  // Health, the outside probe and the token sign-in all go through curl. The
  // k3s health names room isolation as broker: without that field host.sh
  // publishes nothing.
  fake('curl', `const a = process.argv.slice(2)
if (a.some(x => x.endsWith('/api/admin/signin/token'))) {
  const body = JSON.parse(a[a.indexOf('-d') + 1])
  process.stdout.write(body.token === ${JSON.stringify(TOKEN)} ? '200' : '401')
} else if (a.includes('-w')) process.stdout.write('200')
else if (a.some(x => x.endsWith('/api/health')) && !a.includes('-o')) process.stdout.write(process.env.FAKE_HEALTH || '{"status":"ok","isolation":"broker"}')`)
  fake('dig', `process.stdout.write('127.0.0.1\\n')`)
  fake('cloudflared', `process.stdout.write(${JSON.stringify(TUNNEL)} + '\\n'); setInterval(() => {}, 1000)`)
  const state = path.join(dir, 'state')
  fs.mkdirSync(path.join(state, 'data'), { recursive: true })
  fs.writeFileSync(path.join(state, 'data/setup-token'), TOKEN + '\n')
  fs.writeFileSync(path.join(dir, '.env'), `COLLOQ_CLUSTER=1\nRELAY_DOMAIN=\nPUBLIC_URL=${LOCAL}\n`)
  const env: NodeJS.ProcessEnv = { PATH: bin, HOME: dir, COLLOQ_STATE_DIR: state }
  return { dir, bin, calls, env }
}

/** Start host.sh and wait until it sets the address and prints the links. */
async function publish(s: ReturnType<typeof stand>, extra: NodeJS.ProcessEnv = {}) {
  const bash = path.join(s.bin, 'bash')
  const host = spawn(bash, ['scripts/host.sh'], { cwd: s.dir, env: { ...s.env, ...extra } })
  let output = ''
  host.stdout!.on('data', d => { output += d }); host.stderr!.on('data', d => { output += d })
  const deadline = Date.now() + 20000
  while (!/Everything runs here/.test(output) && host.exitCode === null && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50))
  }
  return { host, read: () => output.replace(/\x1b\[[0-9;]*m/g, '') }
}

async function stop(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return
  const done = new Promise<void>(r => host.once('exit', () => r()))
  host.kill('SIGINT')
  await Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('host.sh did not exit')), 10000).unref())])
}

const lines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
const publicUrl = (dir: string) => fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n').filter(l => l.startsWith('PUBLIC_URL='))

test('k3s: no docker needed, the panel link comes from the cluster state and Ctrl+C takes the address back', async () => {
  const s = stand()
  let run: Awaited<ReturnType<typeof publish>> | undefined
  try {
    // Not "exactly 1": bash answers a name it cannot find with 1, while dash
    // (sh on Ubuntu, where CI runs) answers 127. Only one thing matters: docker
    // is not found in the stand.
    assert.notEqual(spawnSync(path.join(s.bin, 'sh'), ['-c', 'command -v docker'], { env: s.env }).status, 0, 'docker leaked into the stand PATH')
    run = await publish(s)
    const out = run.read()
    assert.equal(run.host.exitCode, null, out)
    assert.doesNotMatch(out, /docker/i)
    assert.deepEqual(lines(s.calls), [`public-url ${TUNNEL}`], out)
    // The panel link: without DATA_DIR, from <COLLOQ_STATE_DIR>/data.
    assert.match(out, new RegExp(`${TUNNEL}/admin/t/${TOKEN}`), out)
    assert.match(out, /taken off the cluster too/)

    await stop(run.host)
    const after = run.read()
    // Exactly our address was taken down, and only while it was ours.
    assert.deepEqual(lines(s.calls), [`public-url ${TUNNEL}`, `public-url ${LOCAL} --if-current ${TUNNEL}`], after)
    assert.match(after, new RegExp(`PUBLIC_URL is back at ${LOCAL}`))
    // The .env entry that vast-status reads the machine's address from is
    // back too.
    assert.deepEqual(publicUrl(s.dir), [`PUBLIC_URL=${LOCAL}`])
  } finally {
    if (run) await stop(run.host).catch(() => run!.host.kill('SIGKILL'))
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})

test('k3s: an address someone else set after us is left alone on exit', async () => {
  const s = stand()
  let run: Awaited<ReturnType<typeof publish>> | undefined
  try {
    run = await publish(s, { FAKE_FOREIGN: '1' })
    assert.equal(run.host.exitCode, null, run.read())
    // Another address was set over ours, by a second `make host` or by hand.
    fs.writeFileSync(path.join(s.dir, '.env'), `COLLOQ_CLUSTER=1\nRELAY_DOMAIN=\nPUBLIC_URL=https://other.example\n`)
    await stop(run.host)
    const after = run.read()
    assert.deepEqual(lines(s.calls).at(-1), `public-url ${LOCAL} --if-current ${TUNNEL}`)
    assert.match(after, /not https:\/\/quick-test\.trycloudflare\.com any more — left as it is/)
    assert.doesNotMatch(after, /PUBLIC_URL is back/)
    assert.deepEqual(publicUrl(s.dir), ['PUBLIC_URL=https://other.example'])
  } finally {
    if (run) await stop(run.host).catch(() => run!.host.kill('SIGKILL'))
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})

test('k3s: a failure before publication leaves the cluster address untouched', () => {
  const s = stand()
  try {
    // The tunnel did not come up: cloudflared died without naming an address.
    fs.writeFileSync(path.join(s.bin, 'cloudflared'), `#!${process.execPath}\nprocess.exit(1)\n`, { mode: 0o755 })
    const r = spawnSync(path.join(s.bin, 'bash'), ['scripts/host.sh'], { cwd: s.dir, env: s.env, encoding: 'utf8', timeout: 20000 })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /cloudflared died/)
    assert.deepEqual(lines(s.calls), [])
    assert.deepEqual(publicUrl(s.dir), [`PUBLIC_URL=${LOCAL}`])
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }) }
})

test('k3s: a server that does not confirm room isolation is not published at all', () => {
  const s = stand()
  try {
    // Healthy, but names no isolation: a server that predates the lock, or a
    // backend without isolation.
    const r = spawnSync(path.join(s.bin, 'bash'), ['scripts/host.sh'], {
      cwd: s.dir, env: { ...s.env, FAKE_HEALTH: '{"status":"ok","kernel":true}' }, encoding: 'utf8', timeout: 20000,
    })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /not publishing: .*does not confirm that every room/s)
    assert.doesNotMatch(r.stdout, /opening the quick Cloudflare tunnel/)
    assert.deepEqual(lines(s.calls), [])
    assert.deepEqual(publicUrl(s.dir), [`PUBLIC_URL=${LOCAL}`])
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }) }
})

test('k3s: when the cluster refuses to take the address back, the reason and the manual command are shown', async () => {
  const s = stand()
  let run: Awaited<ReturnType<typeof publish>> | undefined
  try {
    // The cleanup ran into the state lock — say, a vast-sync is running just
    // then.
    run = await publish(s, { FAKE_LOCKED: '1' })
    assert.equal(run.host.exitCode, null, run.read())
    await stop(run.host)
    const after = run.read()
    assert.match(after, /could not take https:\/\/quick-test\.trycloudflare\.com off the cluster \(exit 75\)/, after)
    assert.match(after, /operation lock: another operation is active/, after)
    assert.match(after, new RegExp(`By hand, as root: bash scripts/cluster\\.sh public-url ${LOCAL}`), after)
    assert.doesNotMatch(after, /PUBLIC_URL is back/)
    // The cluster still holds the tunnel address, and the .env entry that
    // vast-status uses to check the machine from outside says the same.
    assert.deepEqual(publicUrl(s.dir), [`PUBLIC_URL=${TUNNEL}`])
  } finally {
    if (run) await stop(run.host).catch(() => run!.host.kill('SIGKILL'))
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})
