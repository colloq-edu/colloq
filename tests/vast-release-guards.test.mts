import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('Vast up refuses missing explicit release before account access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-vast-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'bin'))
    for (const file of ['vast.sh', 'lib.sh']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(dir, 'scripts', file))
    fs.writeFileSync(path.join(dir, '.env'), 'VAST_TOKEN=test-only\n')
    fs.writeFileSync(path.join(dir, 'bin/curl'), '#!/bin/sh\necho ACCOUNT_ACCESSED >&2\nexit 99\n', { mode: 0o755 })
    const result = spawnSync('bash', ['scripts/vast.sh', 'up'], { cwd: dir, encoding: 'utf8', env: { ...process.env, RELEASE: '', PATH: path.join(dir, 'bin') + ':' + process.env.PATH } })
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /RELEASE=/); assert.doesNotMatch(result.stdout + result.stderr, /ACCOUNT_ACCESSED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('Vast deployment keeps VM safeguards and deploys only the release commit artifact', () => {
  const script = fs.readFileSync(path.join(repo, 'scripts/vast.sh'), 'utf8')
  assert.match(script, /"vms_enabled": \{"eq": True\}/); assert.match(script, /"vm": True/); assert.match(script, /"type": "ondemand"/)
  assert.match(script, /git archive/); assert.match(script, /sourceCommit/)
  assert.doesNotMatch(script, /rsync -az --delete/); assert.doesNotMatch(script, /^make service-install$/m)
  assert.match(script, /runtime-backup\.py validate/)
})
test('registry credentials and anonymous-pull declaration are checked before account access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-registry-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'bin'))
    for (const file of ['vast.sh', 'lib.sh']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(dir, 'scripts', file))
    fs.writeFileSync(path.join(dir, '.env'), 'VAST_TOKEN=test-only\n'); fs.writeFileSync(path.join(dir, 'release.json'), '{}')
    fs.writeFileSync(path.join(dir, 'bin/curl'), '#!/bin/sh\necho ACCOUNT_ACCESSED >&2\nexit 99\n', { mode: 0o755 })
    const env = { ...process.env, RELEASE: path.join(dir, 'release.json'), VAST_REGISTRY_CONFIG: '', VAST_PUBLIC_IMAGES: '', VAST_REGISTRY_READ_ONLY: '', PATH: path.join(dir, 'bin') + ':' + process.env.PATH }
    let r = spawnSync('bash', ['scripts/vast.sh', 'up'], { cwd: dir, encoding: 'utf8', env })
    assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /VAST_PUBLIC_IMAGES/); assert.doesNotMatch(r.stdout + r.stderr, /ACCOUNT_ACCESSED/)
    const registry = path.join(dir, 'registry.json'); fs.writeFileSync(registry, JSON.stringify({ auths: {}, credsStore: 'desktop' }))
    r = spawnSync('bash', ['scripts/vast.sh', 'up', '--registry-config', registry], { cwd: dir, encoding: 'utf8', env: { ...env, VAST_REGISTRY_READ_ONLY: '1' } })
    assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /registry config/i); assert.doesNotMatch(r.stdout + r.stderr, /ACCOUNT_ACCESSED/)
    fs.writeFileSync(registry, JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from('user:never-log-this-password').toString('base64') } } }))
    r = spawnSync('bash', ['scripts/vast.sh', 'up', '--registry-config', registry], { cwd: dir, encoding: 'utf8', env })
    assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /VAST_REGISTRY_READ_ONLY/); assert.doesNotMatch(r.stdout + r.stderr, /never-log-this-password|ACCOUNT_ACCESSED/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/**
 * Подсказки k3s-пути ведут в k3s-путь.
 *
 * `make vast-*` выбирает скрипт по RELEASE (Makefile · VAST_SCRIPT): без него —
 * прежний scripts/vast-legacy.sh. vast.sh же советовал голое
 * «make vast-sync NAME=hse», и человек, послушавшись, снимал копию прежним
 * путём с машины, где его нет. Здесь настоящий vast.sh говорит с выдуманным
 * vast, а настоящий Makefile показывает, куда ведёт напечатанный им совет.
 */
test('vast.sh hints route back to vast.sh: RELEASE with make, the script itself without it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-vast-hints-'))
  try {
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'bin'))
    for (const file of ['vast.sh', 'lib.sh']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(dir, 'scripts', file))
    fs.writeFileSync(path.join(dir, '.env'), 'VAST_TOKEN=test-only\nRELAY_DOMAIN=\n')
    const instances = JSON.stringify({ instances: [
      { id: 11, label: 'colloq-hse', actual_status: 'running', dph_total: 0.3, gpu_name: 'RTX 5070', num_gpus: 1 },
      { id: 12, label: 'colloq-demo', actual_status: 'running', dph_total: 0.3, gpu_name: 'RTX 5070', num_gpus: 1 },
    ] })
    // Ответ vast: тело — в файл после -o, код — в stdout, как делает curl с -w.
    fs.writeFileSync(path.join(dir, 'bin/curl'), `#!${process.execPath}
const a = process.argv.slice(2), url = a[a.length - 1]
const body = url.endsWith('/instances/') ? (process.env.FAKE_INSTANCES ?? '') : '{}'
require('node:fs').writeFileSync(a[a.indexOf('-o') + 1], body)
process.stdout.write('200')
`, { mode: 0o755 })
    // need_tools спрашивает только, есть ли они: в этом прогоне их не зовут.
    for (const tool of ['ssh', 'rsync']) fs.writeFileSync(path.join(dir, 'bin', tool), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    const run = (args: string[], extra: Record<string, string>) => {
      const r = spawnSync('bash', ['scripts/vast.sh', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env,
        PATH: path.join(dir, 'bin') + ':' + process.env.PATH, RELEASE: '', NAME: '', HOST: '', FAKE_INSTANCES: instances, ...extra } })
      return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '')
    }
    // Ни одна напечатанная make-подсказка не должна уходить без RELEASE.
    const bare = (text: string) => text.split('\n').filter(l => /make vast-(up|status|sync|logs|down)\b/.test(l) && !/RELEASE=/.test(l))

    // Скрипт позвали напрямую, RELEASE не известен — подсказки зовут сам скрипт.
    let out = run(['status'], {})
    assert.match(out, /NAME=hse scripts\/vast\.sh sync/, out)
    assert.match(out, /NAME=demo scripts\/vast\.sh sync/, out)
    assert.match(out, /NAME=<имя> scripts\/vast\.sh status/, out)
    assert.deepEqual(bare(out), [])

    // Пришли через make с RELEASE — подсказки с ним же.
    out = run(['status'], { RELEASE: '/srv/rel/release.json' })
    assert.match(out, /make vast-sync NAME=demo RELEASE=\/srv\/rel\/release\.json/, out)
    assert.match(out, /make vast-status NAME=<имя> RELEASE=\/srv\/rel\/release\.json/, out)
    assert.deepEqual(bare(out), [])

    // Названная среда, ничего не арендовано: up без релиза не работает — он назван вслух.
    out = run(['status'], { NAME: 'demo', FAKE_INSTANCES: JSON.stringify({ instances: [] }) })
    assert.match(out, /арендовать: make vast-up NAME=demo RELEASE=\/path\/release\.json/, out)
    assert.deepEqual(bare(out), [])
    // Арендована одна, копий здесь нет — совет снять их идёт тем же путём.
    out = run(['status'], { NAME: 'demo', FAKE_INSTANCES: JSON.stringify({ instances: [JSON.parse(instances).instances[1]] }) })
    assert.match(out, /снять: NAME=demo scripts\/vast\.sh sync/, out)
    assert.deepEqual(bare(out), [])

    // Справка без команды тоже не обещает make без RELEASE.
    assert.deepEqual(bare(run([], {})), [])

    // И главное — куда такой совет ведёт на самом деле: настоящий Makefile.
    fs.copyFileSync(path.join(repo, 'Makefile'), path.join(dir, 'Makefile'))
    const make = spawnSync('make', ['-n', '--no-print-directory', 'vast-sync', 'NAME=demo', 'RELEASE=/srv/rel/release.json'], { cwd: dir, encoding: 'utf8' })
    assert.equal(make.status, 0, make.stderr)
    assert.match(make.stdout, /\.\/scripts\/vast\.sh sync/)
    assert.doesNotMatch(make.stdout, /vast-legacy/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/**
 * Шаг, который уходит на машину, — как есть, с выдуманными tmux, pgrep и curl.
 * Сессия «жива», пока есть файл alive; host.sh в ней «работает», пока есть
 * running. На Ctrl+C уборка host.sh кончается через секунду; окно, заведённое
 * руками (manual), после этого остаётся жить оболочкой.
 */
function rehost(manual: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-vast-rehost-'))
  try {
    const script = fs.readFileSync(path.join(repo, 'scripts/vast.sh'), 'utf8')
    const start = script.indexOf(`TMUX_SESSION='$TMUX_SESSION' PORT='$PORT' bash -s" <<'REMOTE'\n`)
    assert.ok(start > 0, 'the remote re-host step is not found in vast.sh')
    const body = script.slice(script.indexOf('\n', start) + 1, script.indexOf('\nREMOTE\n', start))
    fs.writeFileSync(path.join(dir, 'step.sh'), body)
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin)
    const log = path.join(dir, 'calls'), alive = path.join(dir, 'alive'), running = path.join(dir, 'running')
    const done = manual ? `rm -f '${running}'` : `rm -f '${running}' '${alive}'`
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
echo "tmux $*" >> '${log}'
case "$1" in
  has-session) [ -e '${alive}' ] ;;
  send-keys) ( sleep 1; ${done} ) & ;;
  kill-session) rm -f '${alive}' '${running}' ;;
  new-session) touch '${alive}' ;;
esac
`, { mode: 0o755 })
    // Настоящий pgrep видел бы host.sh соседних тестов на этой машине.
    fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\necho "pgrep $*" >> '${log}'\n[ -e '${running}' ]\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho "curl $*" >> '${log}'\nexit 0\n`, { mode: 0o755 })
    fs.writeFileSync(alive, ''); fs.writeFileSync(running, '')
    const began = Date.now()
    const r = spawnSync('bash', [path.join(dir, 'step.sh')], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env,
      PATH: `${bin}:${process.env.PATH}`, REMOTE_DIR: dir, WANT_HOST: 'demo.colloq.ru', TMUX_SESSION: 'colloq-host', PORT: '30080' } })
    assert.equal(r.status, 0, r.stderr)
    const raw = fs.readFileSync(log, 'utf8')
    return { raw, seconds: (Date.now() - began) / 1000, calls: raw.trim().split('\n').map(l => l.split(' ').slice(0, 2).join(' ')) }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Повторный vast-up на машину с живой tmux-сессией: сначала Ctrl+C и ожидание.
 *
 * host.sh на выходе снимает свой адрес с кластера (cluster.sh public-url,
 * перезапуск приложения, до трёх минут). Прежний `tmux kill-session` обрывал
 * эту уборку, а новая сессия, стартовавшая сразу, публиковала то же имя —
 * и опоздавшая уборка старой возвращала localhost уже поверх неё. Шаг,
 * который уходит на машину, запускается здесь как есть, с выдуманными tmux и
 * curl, и порядок их вызовов — это и есть проверка.
 */
test('re-hosting stops the old tmux session gracefully and waits before health and the new session', () => {
  const { raw, calls } = rehost(false)
  const at = (what: string) => calls.indexOf(what)
  assert.ok(at('tmux send-keys') >= 0, calls.join('\n'))
  // Ждали, пока уборка кончится: сессию спрашивали после Ctrl+C не раз.
  assert.ok(calls.slice(at('tmux send-keys')).filter(c => c === 'tmux has-session').length >= 2, calls.join('\n'))
  assert.ok(at('tmux send-keys') < at('curl -sf'), 'health must be asked after the old session is gone')
  assert.ok(at('curl -sf') < at('tmux new-session'), calls.join('\n'))
  // Уборку ждут по самому host.sh, а не по строке, которую носят и сервер
  // tmux, и `sh -c` сессии: шаблон — от начала командной строки.
  const pattern = raw.match(/^pgrep -f (.*)$/m)?.[1]
  assert.ok(pattern, raw)
  const re = new RegExp(pattern)
  for (const own of ['bash scripts/host.sh', '/bin/bash ./scripts/host.sh', 'bash /opt/colloq/scripts/host.sh']) assert.match(own, re)
  for (const other of [
    "tmux new-session -d -s colloq-host cd '/opt/colloq' && COLLOQ_CLUSTER=1 COLLOQ_HOSTNAME='demo.colloq.ru' bash scripts/host.sh 2>&1 | tee -i -a host.log",
    "sh -c cd '/opt/colloq' && COLLOQ_CLUSTER=1 COLLOQ_HOSTNAME='demo.colloq.ru' bash scripts/host.sh 2>&1 | tee -i -a host.log",
    "bash -c REMOTE_DIR='/opt/colloq' WANT_HOST='x.host.sh' TMUX_SESSION='colloq-host' PORT='30080' bash -s",
  ]) assert.doesNotMatch(other, re)
  const started = raw.split('\n').find(l => l.startsWith('tmux new-session'))!
  assert.match(started, /COLLOQ_CLUSTER=1 COLLOQ_HOSTNAME='demo\.colloq\.ru' bash scripts\/host\.sh 2>&1 \| tee -i -a host\.log/)
})

/**
 * Окно, заведённое руками (`tmux new -s colloq-host` — так советует сам
 * vast.sh), после Ctrl+C остаётся жить оболочкой. По одному has-session
 * повторный vast-up простаивал бы тут все двести секунд; ждать надо уборку
 * host.sh, а окно после неё просто закрыть.
 */
test('re-hosting over a hand-made tmux window waits for host.sh, not for the window', () => {
  const { calls, seconds } = rehost(true)
  const at = (what: string) => calls.indexOf(what)
  assert.ok(seconds < 20, `waited ${seconds}s for a window that never closes`)
  assert.ok(at('tmux send-keys') < at('tmux kill-session'), calls.join('\n'))
  assert.ok(at('tmux kill-session') < at('curl -sf'), calls.join('\n'))
  assert.ok(at('curl -sf') < at('tmux new-session'), calls.join('\n'))
})
