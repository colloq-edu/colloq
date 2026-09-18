/**
 * `make host` на k3s-машине: без докера, со ссылкой на панель, с уборкой.
 *
 * Три отказа, найденные на одном и том же пути — `make vast-up HOST=…` под
 * релизом, где scripts/host.sh идёт с COLLOQ_CLUSTER=1:
 *
 *  - скрипт требовал docker на первой строке, хотя под релизом сервер и ядра
 *    живут в k3s, а докера на VM может не быть вовсе, — tmux-сессия с
 *    туннелем умирала через секунду, адрес не выставлялся;
 *  - ссылку на панель печатал только тот, кто сам выставил DATA_DIR: токен
 *    k3s лежит в <COLLOQ_STATE_DIR>/data (/var/lib/colloq/data), а скрипт
 *    искал его в ./data;
 *  - после Ctrl+C кластер так и раздавал ссылки на мёртвый туннель: уборка
 *    обходила cluster.sh стороной.
 *
 * Скрипт здесь настоящий, вокруг него — выдуманные curl, dig, cloudflared и
 * scripts/cluster.sh, а PATH собран поимённо, без docker: иначе на машине
 * разработчика он нашёлся бы и спрятал первый отказ.
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

/** Системные утилиты, которые зовёт host.sh на этом пути, — и ни одной сверх. */
const TOOLS = ['bash', 'sh', 'cat', 'grep', 'tail', 'cut', 'mktemp', 'rm', 'wc', 'sed', 'seq', 'sleep',
  'head', 'tr', 'dirname', 'env', 'mkdir', 'ls', 'id', 'uname']

function stand() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-cluster-host-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const file of ['host.sh', 'lib.sh']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(dir, 'scripts', file))
  const calls = path.join(dir, 'cluster-calls')
  // cluster.sh — выдуманный: пишет, с чем его позвали. На --if-current
  // отвечает 4, когда тест говорит «адрес уже чужой», и 75 с причиной — когда
  // «замок состояния занят».
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
  // Здоровье, проба снаружи и вход по токену — всё через curl. Здоровье k3s
  // называет изоляцию комнат брокером: без поля host.sh ничего не публикует.
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

/** Запустить host.sh и дождаться, пока он выставит адрес и напечатает ссылки. */
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
    assert.equal(spawnSync(path.join(s.bin, 'sh'), ['-c', 'command -v docker'], { env: s.env }).status, 1, 'docker leaked into the stand PATH')
    run = await publish(s)
    const out = run.read()
    assert.equal(run.host.exitCode, null, out)
    assert.doesNotMatch(out, /docker/i)
    assert.deepEqual(lines(s.calls), [`public-url ${TUNNEL}`], out)
    // Ссылка на панель — без DATA_DIR, из <COLLOQ_STATE_DIR>/data.
    assert.match(out, new RegExp(`${TUNNEL}/admin/t/${TOKEN}`), out)
    assert.match(out, /taken off the cluster too/)

    await stop(run.host)
    const after = run.read()
    // Снят ровно наш адрес, и только пока он наш.
    assert.deepEqual(lines(s.calls), [`public-url ${TUNNEL}`, `public-url ${LOCAL} --if-current ${TUNNEL}`], after)
    assert.match(after, new RegExp(`PUBLIC_URL is back at ${LOCAL}`))
    // Запись в .env, по которой vast-status узнаёт адрес машины, тоже вернулась.
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
    // Поверх нас выставили другой адрес — вторым `make host` или руками.
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
    // Туннель не поднялся: cloudflared умер, не назвав адреса.
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
    // Здоров, но изоляции не называет: сервер старше замка или бэкенд без неё.
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
    // Уборка упёрлась в замок состояния — например, в это время идёт vast-sync.
    run = await publish(s, { FAKE_LOCKED: '1' })
    assert.equal(run.host.exitCode, null, run.read())
    await stop(run.host)
    const after = run.read()
    assert.match(after, /could not take https:\/\/quick-test\.trycloudflare\.com off the cluster \(exit 75\)/, after)
    assert.match(after, /operation lock: another operation is active/, after)
    assert.match(after, new RegExp(`By hand, as root: bash scripts/cluster\\.sh public-url ${LOCAL}`), after)
    assert.doesNotMatch(after, /PUBLIC_URL is back/)
    // Кластер так и держит адрес туннеля — и запись в .env, по которой
    // vast-status проверяет машину снаружи, говорит то же самое.
    assert.deepEqual(publicUrl(s.dir), [`PUBLIC_URL=${TUNNEL}`])
  } finally {
    if (run) await stop(run.host).catch(() => run!.host.kill('SIGKILL'))
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})
