/**
 * deploy/vast/colloq-host as a university's server and a Vast VM see it, run
 * for real against stand-ins.
 *
 * The script itself runs (bash, as on the machine); what it drives is made
 * up: a `docker` that keeps images, containers and networks in a JSON file,
 * and `systemctl`, `apt-mark`, `curl` and the other host tools as recorders.
 * Real Docker is never touched, and nothing here needs root: `id -u` answers
 * 0 by a stand-in, and the paths colloq-host writes (/etc/colloq, the state
 * directory, the systemd units) are moved into a temporary directory by the
 * variables the script offers for that.
 *
 * What is held here, because each broke or would break silently on a server:
 *
 *   1. no quiet host changes: unattended-upgrades and the NVIDIA packages are
 *      touched only under COLLOQ_FREEZE_UPDATES=1, which the Vast on-start
 *      sets (and on a VM an older on-start rented, recognised by the on-start
 *      file make vast-vm leaves), never on a machine somebody keeps;
 *   2. settings given once to `up` (the state directory, the bind address,
 *      the port) still hold for a later `update`: otherwise an update starts
 *      the new version on an empty directory or cuts off the proxy;
 *   3. an update to another image takes a backup first, prints the way back
 *      before anything is replaced, and changes nothing when the backup fails;
 *   4. bundle → load → up works with no network at all: no pull, no
 *      get.docker.com, kernels named colloq-kernel:<env>, COLLOQ_OFFLINE=1;
 *   5. doctor answers FAIL/WARN/PASS for the questions it is for, and exits
 *      non-zero on a FAIL, before any container exists;
 *   6. backup-timer writes a daily, persistent systemd timer and takes it away.
 */
import './_cli.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOST = path.join(ROOT, 'deploy/vast/colloq-host')

/*
 * The stand-in docker. Every call is appended to the log as a JSON array, and
 * the state (images, the registry it pulls from, containers, networks) lives
 * in a JSON file the test prepares and reads back.
 */
const FAKE_DOCKER = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
const file = process.env.FAKE_DOCKER_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n')
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 1))
const out = (s) => process.stdout.write(s)
const fail = (msg) => { if (msg) process.stderr.write(msg + '\\n'); process.exit(1) }
const fmtOf = (a) => { const i = a.findIndex((x) => x === '-f' || x === '--format'); return i < 0 ? [null, a] : [a[i + 1], a.slice(0, i).concat(a.slice(i + 2))] }
const findImage = (ref) => st.images[ref] ?? Object.values(st.images).find((i) => i.id === ref)
const stamp = () => { st.seq = (st.seq ?? 0) + 1; return '20260930-1200' + String(st.seq).padStart(2, '0') }
const backup = (home) => { fs.mkdirSync(path.join(home, 'backups'), { recursive: true }); const f = path.join(home, 'backups', 'colloq-' + stamp() + '.db'); fs.writeFileSync(f, 'SQLite format 3\\0'); out('backup: ' + f + '\\n') }
const imageFmt = (img, f) => {
  if (f === '{{.Id}}') return img.id
  if (f === '{{.Architecture}}') return img.arch ?? 'amd64'
  if (f.includes('RepoTags')) return Object.entries(st.images).filter(([, i]) => i.id === img.id).map(([r]) => r + '\\n').join('')
  if (f.includes('RepoDigests')) return (img.digests ?? []).map((d) => d + '\\n').join('')
  if (f.includes('Config.Env')) return (img.env ?? []).map((e) => e + '\\n').join('')
  const labels = img.labels ?? {}
  const keys = [...f.matchAll(/index \\.Config\\.Labels "([^"]+)"/g)].map((m) => labels[m[1]] ?? '')
  if (keys.length) return keys.join(' ')
  return ''
}
const [cmd, ...rest] = args
if (st.down && !['--help'].includes(rest[0])) fail('Cannot connect to the Docker daemon')
if (cmd === 'version') { out(st.version + '\\n'); process.exit(0) }
if (cmd === 'info') {
  const [f] = fmtOf(rest)
  if (f === null) out('Runtimes: ' + (st.nvidia ? 'nvidia ' : '') + 'runc\\n')
  else if (f.includes('CgroupVersion')) out('2\\n')
  else if (f.includes('SecurityOptions')) out((st.security ?? 'name=seccomp,profile=builtin name=cgroupns') + '\\n')
  else if (f.includes('FirewallBackend')) out((st.firewall ?? 'iptables') + '\\n')
  else if (f.includes('HTTPSProxy')) out((st.daemonProxy ?? '') + '\\n')
  else out('\\n')
  process.exit(0)
}
if (cmd === 'image' && rest[0] === 'inspect') {
  const [f, a] = fmtOf(rest.slice(1)); const img = findImage(a[0])
  if (!img) fail('Error: No such image: ' + a[0])
  out(f === null ? '[{}]\\n' : imageFmt(img, f) + '\\n'); process.exit(0)
}
if (cmd === 'pull') {
  const ref = rest.filter((x, i) => !x.startsWith('-') && rest[i - 1] !== '--platform').pop()
  const img = st.registry[ref]
  if (!img) fail('Error response from daemon: manifest unknown: ' + ref)
  st.images[ref] = { ...img }; save(); process.exit(0)
}
if (cmd === 'tag') { const img = findImage(rest[0]); if (!img) fail('No such image'); st.images[rest[1]] = { ...img }; save(); process.exit(0) }
if (cmd === 'network') {
  const [f, a] = fmtOf(rest.slice(1)); const name = a[a.length - 1]
  if (rest[0] === 'create') { st.networks[name] = { gateway: '172.30.0.1' }; save(); process.exit(0) }
  const net = st.networks[name]; if (!net) fail('network ' + name + ' not found')
  out(f && f.includes('Gateway') ? net.gateway + ' \\n' : '[{}]\\n'); process.exit(0)
}
if (cmd === 'container' && rest[0] === 'inspect' || cmd === 'inspect') {
  const [f, a] = fmtOf(cmd === 'inspect' ? rest : rest.slice(1)); const c = st.containers[a[0]]
  if (!c) fail('Error: No such container: ' + a[0])
  if (f === null) out('[{}]\\n')
  else if (f.includes('colloq.config')) out((c.labels['colloq.config'] ?? '') + '\\n')
  else if (f.includes('State.Running')) out(String(c.running) + '\\n')
  else if (f === '{{.Image}}') out(c.imageId + '\\n')
  else out((c.running ? 'running' : 'exited') + ', image ' + c.image + '\\n')
  process.exit(0)
}
if (cmd === 'run') {
  const valued = new Set(['--name', '--restart', '--network', '--stop-timeout', '--log-opt', '-p', '-v', '--env-file', '-e', '--label', '--platform', '--entrypoint', '--user'])
  const c = { flags: [], env: {}, labels: {}, mounts: [] }; let i = 0
  for (; i < rest.length; i++) {
    const x = rest[i]
    if (!x.startsWith('-')) break
    if (valued.has(x)) {
      const v = rest[++i]; c.flags.push(x, v)
      if (x === '-e') { const [k, ...vv] = v.split('='); c.env[k] = vv.join('=') }
      if (x === '--label') { const [k, ...vv] = v.split('='); c.labels[k] = vv.join('=') }
      if (x === '-v') c.mounts.push(v)
      if (x === '--name') c.name = v
      if (x === '-p') c.publish = v
    } else c.flags.push(x)
  }
  c.image = rest[i]; c.command = rest.slice(i + 1)
  const img = findImage(c.image); if (!img) fail('Unable to find image ' + c.image + ' locally')
  c.imageId = img.id
  if (c.flags.includes('--rm')) {
    st.oneOffs = (st.oneOffs ?? []).concat([c])
    if (c.command[0] === 'backup') { if (st.backupFails) { save(); fail('backup failed') } backup(c.env.COLLOQ_HOME) }
    save(); process.exit(0)
  }
  c.running = true; st.containers[c.name] = c; save(); out('0123456789ab\\n'); process.exit(0)
}
if (cmd === 'start') { const c = st.containers[rest[rest.length - 1]]; if (!c) fail('No such container'); c.running = true; save(); process.exit(0) }
if (cmd === 'stop') { const c = st.containers[rest[rest.length - 1]]; if (c) { c.running = false; save() } process.exit(c ? 0 : 1) }
if (cmd === 'rm') { const n = rest[rest.length - 1]; delete st.containers[n]; delete (st.created ?? {})[n]; save(); process.exit(0) }
if (cmd === 'exec') {
  const env = {}; let i = 0
  for (; i < rest.length && rest[i].startsWith('-'); i++) if (rest[i] === '-e') { const [k, ...v] = rest[++i].split('='); env[k] = v.join('=') }
  const c = st.containers[rest[i]]; const what = rest.slice(i + 1)
  if (!c || !c.running) fail('container is not running')
  st.execs = (st.execs ?? []).concat([{ env, what }])
  if (what.includes('backup')) { if (st.backupFails) { save(); fail('backup failed') } backup(c.env.COLLOQ_HOME) }
  if (what.includes('link')) out('[vast] address for the class: http://localhost:3000\\n')
  save(); process.exit(0)
}
if (cmd === 'create') { st.created = st.created ?? {}; const id = 'cid' + Object.keys(st.created).length; st.created[id] = rest[rest.length - 1]; save(); out(id + '\\n'); process.exit(0) }
if (cmd === 'cp') {
  const [src, dst] = rest; const inner = src.slice(src.indexOf(':') + 1)
  const from = path.join(process.env.FAKE_DOCKER_REPO, inner.replace('/opt/colloq/', ''))
  fs.cpSync(from, dst, { recursive: true }); process.exit(0)
}
if (cmd === 'save') {
  if (rest.includes('--help')) { out('Usage: docker image save [OPTIONS] IMAGE\\n      --platform string\\n'); process.exit(0) }
  const o = rest.indexOf('-o'); const refs = rest.slice(o + 2)
  const images = {}; for (const r of refs) { const img = findImage(r); if (!img) fail('No such image: ' + r); images[r] = img }
  fs.writeFileSync(rest[o + 1], JSON.stringify({ images })); st.saved = { flags: rest.slice(0, o), refs }; save(); process.exit(0)
}
if (cmd === 'load') {
  const text = fs.readFileSync(0, 'utf8'); const { images } = JSON.parse(text)
  for (const [r, img] of Object.entries(images)) { st.images[r] = img; out('Loaded image: ' + r + '\\n') }
  save(); process.exit(0)
}
process.exit(0)
`

function write(file: string, text: string, mode = 0o755): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode })
}

type Image = { id: string; labels?: Record<string, string>; env?: string[]; digests?: string[]; arch?: string }
type State = {
  version: string
  images: Record<string, Image>
  registry: Record<string, Image>
  containers: Record<string, { image: string; imageId: string; running: boolean; flags: string[]; env: Record<string, string>; mounts: string[]; publish?: string; command: string[] }>
  networks: Record<string, { gateway: string }>
  execs?: { env: Record<string, string>; what: string[] }[]
  oneOffs?: { image: string; command: string[]; env: Record<string, string> }[]
  saved?: { flags: string[]; refs: string[] }
  [key: string]: unknown
}

const APP = 'ghcr.io/colloq-edu/colloq-vast:0.9.0'
const NEXT = 'ghcr.io/colloq-edu/colloq-vast:0.9.1'
const appImage = (id: string, version: string): Image => ({
  id,
  labels: { 'org.opencontainers.image.version': version },
  env: ['COLLOQ_VERSION=' + version, 'COLLOQ_KERNEL_REPO=ghcr.io/colloq-edu/colloq-kernel'],
  digests: ['ghcr.io/colloq-edu/colloq-vast@sha256:' + id.slice(7, 15).padEnd(64, '0')],
})

/** A machine: a temporary directory with the stand-ins, a state file and the paths colloq-host writes. */
function machine(state: Partial<State> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-host-test-'))
  const bin = path.join(dir, 'bin')
  const calls = path.join(dir, 'calls')
  write(path.join(bin, 'docker'), FAKE_DOCKER)
  // Recorders: the call goes to a log named after the tool.
  const recorder = (name: string, body = '') =>
    write(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`)
  recorder('systemctl', `case "$1" in is-enabled) echo enabled ;; esac\nexit 0`)
  recorder('apt-mark', 'exit 0')
  recorder('apt-get', 'exit 0')
  recorder('curl', `case "$*" in *get.docker.com*) exit 1 ;; *ghcr.io*) printf '%s' "\${FAKE_CURL_CODE:-401}" ;; esac\nexit 0`)
  recorder('iptables', 'exit ${FAKE_IPTABLES:-0}')
  write(path.join(bin, 'dpkg-query'), '#!/bin/sh\nprintf "installed nvidia-driver-580\\ninstalled libnvidia-compute-580\\ninstalled curl\\nnot-installed nvidia-old\\n"\n')
  write(path.join(bin, 'id'), '#!/bin/sh\nif [ "$1" = -u ]; then echo "${FAKE_UID:-0}"; else exec /usr/bin/id "$@"; fi\n')
  write(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo "${FAKE_ARCH:-x86_64}" ;; -r) echo 6.8.0-45-generic ;; *) echo Linux ;; esac\n')
  write(path.join(bin, 'nproc'), '#!/bin/sh\necho 16\n')
  write(path.join(bin, 'ip'), '#!/bin/sh\necho "2: eth0    inet 10.0.0.20/24 brd 10.0.0.255 scope global eth0"\n')
  write(path.join(bin, 'fuser'), '#!/bin/sh\nexit 1\n')
  write(path.join(bin, 'getent'), '#!/bin/sh\nexit ${FAKE_GETENT:-0}\n')
  write(path.join(bin, 'timedatectl'), '#!/bin/sh\necho yes\n')
  write(path.join(bin, 'getenforce'), '#!/bin/sh\necho Disabled\n')
  write(path.join(bin, 'nvidia-smi'), '#!/bin/sh\nexit 0\n')
  write(path.join(bin, 'ss'), '#!/bin/sh\necho "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process"\n[ -z "$FAKE_SS" ] || echo "$FAKE_SS"\n')
  const stateFile = path.join(dir, 'docker.json')
  const initial: State = { version: '28.3.1', images: {}, registry: {}, containers: {}, networks: {}, nvidia: true, ...state }
  fs.writeFileSync(stateFile, JSON.stringify(initial))
  const conf = path.join(dir, 'etc-colloq')
  const home = path.join(dir, 'state')
  const systemd = path.join(dir, 'systemd')
  const base: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: dir,
    FAKE_DOCKER_STATE: stateFile,
    FAKE_DOCKER_LOG: path.join(dir, 'docker.log'),
    FAKE_DOCKER_REPO: ROOT,
    COLLOQ_CONF_DIR: conf,
    COLLOQ_SYSTEMD_DIR: systemd,
  }
  const run = (args: string[], env: Record<string, string> = {}, opts: { home?: boolean; path?: string } = {}) => {
    // stdin from /dev/null: on macOS node's pipes are sockets, and bash on a
    // socket takes itself for an rsh session and reads ~/.bashrc.
    const r = spawnSync('bash', [HOST, ...args], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...base, ...(opts.home === false ? {} : { COLLOQ_HOME: home }), ...(opts.path ? { PATH: opts.path } : {}), ...env },
    })
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }
  return {
    dir,
    bin,
    conf,
    home,
    systemd,
    run,
    state: (): State => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    setState: (patch: (s: State) => void) => {
      const s: State = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      patch(s)
      fs.writeFileSync(stateFile, JSON.stringify(s))
    },
    dockerCalls: (): string[][] =>
      fs.existsSync(base.FAKE_DOCKER_LOG!)
        ? fs.readFileSync(base.FAKE_DOCKER_LOG!, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [],
    hostCalls: (): string => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''),
    envFile: (): string => fs.readFileSync(path.join(conf, 'colloq.env'), 'utf8'),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const FREEZE = /systemctl disable --now unattended-upgrades apt-daily\.timer apt-daily-upgrade\.timer/

test('off Vast, up leaves the host update policy alone and trusts the local proxy', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0') } })
  try {
    const r = m.run(['up'], { COLLOQ_IMAGE: APP, PUBLIC_URL: 'https://colloq.example.edu', COLLOQ_TUNNEL: 'none' })
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(m.hostCalls(), FREEZE, 'unattended-upgrades must not be touched off Vast')
    assert.doesNotMatch(m.hostCalls(), /apt-mark/, 'no package may be held off Vast')
    assert.doesNotMatch(r.out, /switching off automatic updates/)
    const env = m.envFile()
    assert.match(env, /^PUBLIC_URL=https:\/\/colloq\.example\.edu$/m)
    assert.doesNotMatch(env, /COLLOQ_ON_VAST|COLLOQ_FREEZE_UPDATES/)
    const c = m.state().containers.colloq!
    assert.equal(c.image, APP)
    // The port on loopback: a proxy on this host arrives from the gateway of
    // the rooms' network, and the server is told to believe it.
    assert.equal(c.env.TRUSTED_PROXIES, 'loopback,172.30.0.1')
    assert.equal(c.publish, '127.0.0.1:3000:3000')
  } finally { m.done() }
})

test('an nvidia-smi that fails is not taken for a list of cards (30 Sep 2026, a driver update under the loaded module)', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0') } })
  try {
    // nvidia-smi prints this on stdout and exits non-zero.
    fs.writeFileSync(path.join(m.bin, 'nvidia-smi'), '#!/bin/sh\necho "Failed to initialize NVML: Driver/library version mismatch"\necho "NVML library version: 580.178"\nexit 18\n', { mode: 0o755 })
    const r = m.run(['up'], { COLLOQ_IMAGE: APP, PUBLIC_URL: 'https://colloq.example.edu', COLLOQ_TUNNEL: 'none' })
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(m.envFile(), /KERNEL_GPUS/, 'an error message is not a list of cards')
    assert.match(r.out, /nvidia-smi does not answer \(Failed to initialize NVML/)
    const d = m.run(['doctor'], {})
    assert.match(d.out, /WARN\s+gpu\s+nvidia-smi fails/)
  } finally { m.done() }
})

test('COLLOQ_FREEZE_UPDATES=1 (the Vast on-start) switches automatic updates off and holds the NVIDIA packages', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0') } })
  try {
    const r = m.run(['up'], { COLLOQ_IMAGE: APP, COLLOQ_ON_VAST: '1', COLLOQ_FREEZE_UPDATES: '1' })
    assert.equal(r.status, 0, r.out)
    assert.match(m.hostCalls(), FREEZE)
    assert.match(m.hostCalls(), /apt-mark hold nvidia-driver-580 libnvidia-compute-580\n/)
    const env = m.envFile()
    assert.match(env, /^COLLOQ_ON_VAST=1$/m)
    assert.match(env, /^COLLOQ_FREEZE_UPDATES=1$/m)
    // Remembered: a later `up` by hand, without the variables, still freezes.
    fs.rmSync(path.join(m.dir, 'calls'), { force: true })
    assert.equal(m.run(['up']).status, 0)
    assert.match(m.hostCalls(), FREEZE)
  } finally { m.done() }
})

test('a Vast VM started from an on-start copied before the flags keeps the Vast behaviour; =0 refuses it', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0') } })
  try {
    // What scripts/vast-vm.sh leaves on every VM it rents.
    write(path.join(m.conf, 'onstart.sh'), '#!/bin/bash\n', 0o600)
    let r = m.run(['up'], { COLLOQ_IMAGE: APP })
    assert.equal(r.status, 0, r.out)
    assert.match(m.hostCalls(), FREEZE)
    assert.match(m.envFile(), /^COLLOQ_ON_VAST=1$/m, 'the container must learn it is on Vast')
    fs.rmSync(path.join(m.dir, 'calls'), { force: true })
    r = m.run(['up'], { COLLOQ_FREEZE_UPDATES: '0' })
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(m.hostCalls(), FREEZE)
  } finally { m.done() }
})

test('settings given once to up hold for a later update: state directory, bind address, port', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0'), [NEXT]: appImage('sha256:bbb2', '0.9.1') } })
  try {
    let r = m.run(['up'], { COLLOQ_IMAGE: APP, COLLOQ_BIND: '10.0.0.20', PORT: '8080', TRUSTED_PROXIES: '10.0.0.5' })
    assert.equal(r.status, 0, r.out)
    let c = m.state().containers.colloq!
    assert.equal(c.publish, '10.0.0.20:8080:8080')
    // The operator's own list: nothing is added to it.
    assert.equal(c.env.TRUSTED_PROXIES, undefined)
    assert.match(m.envFile(), /^TRUSTED_PROXIES=10\.0\.0\.5$/m)
    // A month later, from a shell without any of it (not even COLLOQ_HOME).
    r = m.run(['update', NEXT], {}, { home: false })
    assert.equal(r.status, 0, r.out)
    c = m.state().containers.colloq!
    assert.equal(c.image, NEXT)
    assert.equal(c.publish, '10.0.0.20:8080:8080')
    assert.ok(c.mounts.includes(`${m.home}:${m.home}`), c.mounts.join(' '))
    assert.equal(c.env.COLLOQ_HOME, m.home)
  } finally { m.done() }
})

test('update to another image backs up first, prints the way back, and a failed backup changes nothing', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0'), [NEXT]: appImage('sha256:bbb2', '0.9.1') } })
  try {
    assert.equal(m.run(['up'], { COLLOQ_IMAGE: APP }).status, 0)
    fs.mkdirSync(path.join(m.home, 'data'), { recursive: true })
    fs.writeFileSync(path.join(m.home, 'data', 'colloq.db'), 'SQLite format 3\0')

    m.setState((s) => { s.backupFails = true })
    let r = m.run(['update', NEXT])
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /backup before the update failed, and nothing was changed/)
    assert.equal(m.state().containers.colloq!.image, APP)
    assert.equal(fs.readFileSync(path.join(m.conf, 'image'), 'utf8').trim(), APP)

    m.setState((s) => { s.backupFails = false })
    r = m.run(['update', NEXT], { BACKUP_KEEP: '30' })
    assert.equal(r.status, 0, r.out)
    const calls = m.dockerCalls().map((c) => c.join(' '))
    const backupAt = calls.findIndex((c) => /^exec .*colloq colloq-vast backup$/.test(c))
    const runAt = calls.findIndex((c) => c.startsWith('run -d') && c.endsWith(NEXT))
    assert.ok(backupAt >= 0 && runAt > backupAt, calls.join('\n'))
    assert.deepEqual(m.state().execs!.filter((e) => e.what.includes('backup')).pop()!.env, { BACKUP_KEEP: '30' })
    const db = /backup before the update: (\S+\.db)/.exec(r.out)?.[1]
    assert.ok(db && db.startsWith(path.join(m.home, 'backups')), r.out)
    // The previous image by the name that still means it: the versioned tag.
    assert.ok(r.out.includes(`REPLACE=1 colloq-host restore --image ${APP} ${db}`), r.out)
    assert.ok(r.out.indexOf('REPLACE=1 colloq-host restore') < r.out.indexOf(`started colloq from ${NEXT}`), 'the way back comes before the replacement')
    assert.equal(m.state().containers.colloq!.image, NEXT)

    // The way back: the old image and the old data together.
    r = m.run(['restore', '--image', APP, db!], { REPLACE: '1' })
    assert.equal(r.status, 0, r.out)
    const restoreRun = m.state().oneOffs!.find((o) => o.command[0] === 'restore')!
    assert.equal(restoreRun.image, APP)
    assert.equal(m.state().containers.colloq!.image, APP)
    assert.equal(fs.readFileSync(path.join(m.conf, 'image'), 'utf8').trim(), APP)

    // COLLOQ_BACKUP_BEFORE_UPDATE=0: said out loud, and no backup.
    const before = m.state().execs!.length
    r = m.run(['update', NEXT], { COLLOQ_BACKUP_BEFORE_UPDATE: '0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /no backup before this update/)
    assert.equal(m.state().execs!.filter((e) => e.what.includes('backup')).length, m.state().execs!.slice(0, before).filter((e) => e.what.includes('backup')).length)
  } finally { m.done() }
})

test('the same image again is no update: no backup, the running container stays', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0') } })
  try {
    assert.equal(m.run(['up'], { COLLOQ_IMAGE: APP }).status, 0)
    fs.mkdirSync(path.join(m.home, 'data'), { recursive: true })
    fs.writeFileSync(path.join(m.home, 'data', 'colloq.db'), 'x')
    const r = m.run(['update'])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /already running with these settings/)
    assert.equal((m.state().execs ?? []).filter((e) => e.what.includes('backup')).length, 0)
  } finally { m.done() }
})

test('an offline update after load names the previous version by its own tag', () => {
  // Loaded images carry no registry digest; the old version keeps its tag.
  const loaded = (id: string, version: string): Image => ({ ...appImage(id, version), digests: [] })
  const m = machine({ images: { [APP]: loaded('sha256:aaa1', '0.9.0') } })
  try {
    assert.equal(m.run(['up'], { COLLOQ_IMAGE: APP, COLLOQ_OFFLINE: '1' }).status, 0)
    fs.mkdirSync(path.join(m.home, 'data'), { recursive: true })
    fs.writeFileSync(path.join(m.home, 'data', 'colloq.db'), 'SQLite format 3\0')
    // What `load` of the next bundle leaves: the new image here, named in the file.
    m.setState((s) => { s.images[NEXT] = loaded('sha256:bbb2', '0.9.1') })
    fs.writeFileSync(path.join(m.conf, 'image'), NEXT + '\n')
    const r = m.run(['update'])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`REPLACE=1 colloq-host restore --image ${APP.replace(/[.]/g, '\\.')} `))
    assert.equal(m.dockerCalls().filter((c) => c[0] === 'pull').length, 0)
    assert.equal(m.state().containers.colloq!.image, NEXT)
  } finally { m.done() }
})

test('bundle on a connected machine, load and up on a server with no network at all', () => {
  const kernel = (env: string, id: string): Image => ({
    id,
    labels: { 'org.opencontainers.image.version': '0.9.0', 'colloq.environment': env },
  })
  const connected = machine({
    registry: {
      [APP]: appImage('sha256:aaa1', '0.9.0'),
      'ghcr.io/colloq-edu/colloq-kernel:v0.9.0-base': kernel('base', 'sha256:ba5e'),
      'ghcr.io/colloq-edu/colloq-kernel:v0.9.0-kaggle-base': kernel('kaggle-base', 'sha256:ca66'),
    },
  })
  const server = machine()
  try {
    const archive = path.join(connected.dir, 'colloq-0.9.0.tar')
    // Not root: a laptop with Docker is enough to pack.
    let r = connected.run(['bundle', archive, APP], { FAKE_UID: '501', KERNEL_PRELOAD: 'kaggle-base' })
    assert.equal(r.status, 0, r.out)
    const members = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' }).stdout.trim().split('\n')
    assert.deepEqual(members, ['manifest.txt', 'colloq-host', 'images.tar'])
    const manifest = spawnSync('tar', ['-xOf', archive, 'manifest.txt'], { encoding: 'utf8' }).stdout
    assert.match(manifest, /^format 1$/m)
    assert.match(manifest, /^version 0\.9\.0$/m)
    assert.match(manifest, /^created \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m)
    assert.match(manifest, new RegExp(`^app ${APP} sha256:aaa1$`, 'm'))
    // kaggle-base brings its parent along: rooms default to base.
    assert.match(manifest, /^kernel base ghcr\.io\/colloq-edu\/colloq-kernel:v0\.9\.0-base sha256:ba5e published$/m)
    assert.match(manifest, /^kernel kaggle-base ghcr\.io\/colloq-edu\/colloq-kernel:v0\.9\.0-kaggle-base sha256:ca66 published$/m)
    const saved = connected.state().saved!
    assert.deepEqual(saved.flags, ['--platform', 'linux/amd64'])
    assert.equal(saved.refs.length, 3)
    // The bundled host script is the one inside the image, byte for byte.
    const bundledHost = spawnSync('tar', ['-xOf', archive, 'colloq-host'], { encoding: 'utf8' }).stdout
    assert.equal(bundledHost, fs.readFileSync(HOST, 'utf8'))
    assert.deepEqual(fs.readdirSync(connected.dir).filter((f) => f.startsWith('.colloq-bundle')), [], 'the work directory is removed')

    // The server: Docker installed, nothing reachable. The state directory has
    // a list of its own for kaggle-base, whose image must stay the server's.
    fs.mkdirSync(path.join(server.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(server.home, 'environments', 'kaggle-base.txt'), 'timm\n')
    r = server.run(['load', archive])
    assert.equal(r.status, 0, r.out)
    const images = server.state().images
    assert.equal(images['colloq-kernel:base']?.id, 'sha256:ba5e')
    assert.equal(images['colloq-kernel:kaggle-base'], undefined)
    assert.match(r.out, /kept colloq-kernel:kaggle-base: this server has its own "kaggle-base" list/)
    assert.equal(fs.readFileSync(path.join(server.conf, 'image'), 'utf8').trim(), APP)
    assert.match(server.envFile(), /^COLLOQ_OFFLINE=1$/m)
    assert.ok(server.state().oneOffs!.some((o) => o.command[0] === 'install-host'), 'colloq-host is installed from the loaded image')

    r = server.run(['up'])
    assert.equal(r.status, 0, r.out)
    const calls = server.dockerCalls()
    assert.equal(calls.filter((c) => c[0] === 'pull').length, 0, 'an offline up pulls nothing')
    assert.doesNotMatch(server.hostCalls(), /get\.docker\.com|apt-get/)
    assert.equal(server.state().containers.colloq!.env.COLLOQ_HOME, server.home)
    assert.match(server.envFile(), /^COLLOQ_OFFLINE=1$/m)
  } finally { connected.done(); server.done() }
})

test('offline, a missing Docker or image is named instead of downloaded', () => {
  const m = machine()
  try {
    const noDocker = `${m.bin}-nodocker`
    fs.cpSync(m.bin, noDocker, { recursive: true })
    fs.rmSync(path.join(noDocker, 'docker'))
    let r = m.run(['up'], { COLLOQ_OFFLINE: '1', COLLOQ_IMAGE: APP }, { path: `${noDocker}:/usr/bin:/bin:/usr/sbin:/sbin` })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /Docker is not installed, and COLLOQ_OFFLINE=1 downloads nothing/)
    assert.doesNotMatch(m.hostCalls(), /get\.docker\.com/)
    r = m.run(['up'], { COLLOQ_OFFLINE: '1', COLLOQ_IMAGE: APP })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /is not on this machine, and COLLOQ_OFFLINE=1 allows no pulls: bring it with colloq-host bundle/)
    assert.equal(m.dockerCalls().filter((c) => c[0] === 'pull').length, 0)
    fs.rmSync(noDocker, { recursive: true, force: true })
  } finally { m.done() }
})

test('doctor: PASS on a ready machine, before any container, without changing anything', () => {
  const m = machine({ images: { [APP]: appImage('sha256:aaa1', '0.9.0') } })
  try {
    const r = m.run(['doctor'], { COLLOQ_IMAGE: APP, PUBLIC_URL: 'https://colloq.example.edu' })
    assert.equal(r.status, 0, r.out)
    for (const line of [
      /^PASS {2}arch +x86_64$/m,
      /^PASS {2}kernel +Linux 6\.8\.0-45-generic$/m,
      /^PASS {2}docker +Docker 28\.3\.1$/m,
      /^PASS {2}cgroup +v2$/m,
      /^PASS {2}firewall +iptables/m,
      /^PASS {2}port +127\.0\.0\.1:3000 is free$/m,
      /^PASS {2}registry +ghcr\.io answers \(HTTP 401\)$/m,
      /^PASS {2}public-url +https:\/\/colloq\.example\.edu$/m,
      /^PASS {2}proxies +loopback bind/m,
      /^PASS {2}image +ghcr\.io\/colloq-edu\/colloq-vast:0\.9\.0 is here \(version 0\.9\.0\)$/m,
      /^INFO {2}sizing +a server to start with: 16 vCPU, 64 GB RAM, 250 GB NVMe/m,
      /^INFO {2}config +.* does not exist yet/m,
    ]) assert.match(r.out, line)
    assert.doesNotMatch(r.out, /^FAIL/m)
    // Read-only: no settings, no container, no network created.
    assert.equal(fs.existsSync(m.conf), false)
    assert.deepEqual(m.dockerCalls().filter((c) => ['run', 'create', 'pull', 'network'].includes(c[0]!) && c[1] !== 'inspect'), [])
  } finally { m.done() }
})

test('doctor: FAIL lines exit non-zero, WARN lines name what to set', () => {
  const m = machine({ version: '27.5.1' })
  try {
    let r = m.run(['doctor'], { COLLOQ_BIND: '0.0.0.0', PUBLIC_URL: 'http://colloq.example.edu/lab' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /^WARN {2}docker +Docker 27\.5\.1: Colloq is tested with Docker 28 and newer/m)
    assert.match(r.out, /^WARN {2}proxies +Colloq listens on 0\.0\.0\.0: set TRUSTED_PROXIES=/m)
    assert.match(r.out, /^WARN {2}public-url +http:\/\/colloq\.example\.edu\/lab is plain http/m)
    assert.match(r.out, /^WARN {2}public-url +Colloq sits at the root of a hostname/m)
    assert.match(r.out, /^WARN {2}image +no image named yet/m)
    assert.match(r.out, /^INFO {2}port +published on every interface/m)

    // A bind address the machine does not have.
    r = m.run(['doctor'], { COLLOQ_BIND: '10.0.0.99', TRUSTED_PROXIES: '10.0.0.5' })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /^FAIL {2}port +COLLOQ_BIND=10\.0\.0\.99 is not an address of this machine/m)
    r = m.run(['doctor'], { COLLOQ_BIND: '10.0.0.20', TRUSTED_PROXIES: '10.0.0.5' })
    assert.doesNotMatch(r.out, /is not an address of this machine/)
    assert.match(r.out, /^PASS {2}proxies +TRUSTED_PROXIES=10\.0\.0\.5$/m)

    // Off Vast, no address at all.
    r = m.run(['doctor'])
    assert.match(r.out, /^WARN {2}public-url +not set: every link Colloq hands out will say http:\/\/localhost:3000/m)

    // Something else on the port, a Docker too old, and its nftables backend.
    m.setState((s) => { s.firewall = 'nftables'; s.version = '19.03.1' })
    r = m.run(['doctor'], {
      PUBLIC_URL: 'https://colloq.example.edu',
      FAKE_SS: 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("nginx",pid=812,fd=6))',
    })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /^FAIL {2}docker +Docker 19\.03\.1 is too old/m)
    assert.match(r.out, /^FAIL {2}firewall +Docker uses its nftables backend/m)
    assert.match(r.out, /^FAIL {2}port +127\.0\.0\.1:3000 is taken: 127\.0\.0\.1:3000 users:\(\("nginx"/m)
    assert.match(r.out, /\d+ FAIL, \d+ WARN: fix the FAIL lines/)

    // No Docker at all.
    fs.rmSync(path.join(m.dir, 'calls'), { force: true })
    const noDocker = `${m.bin}-nodocker`
    fs.cpSync(m.bin, noDocker, { recursive: true })
    fs.rmSync(path.join(noDocker, 'docker'))
    r = m.run(['doctor'], { COLLOQ_OFFLINE: '1' }, { path: `${noDocker}:/usr/bin:/bin:/usr/sbin:/sbin` })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /^FAIL {2}docker +not installed, and an offline install never downloads it/m)
    assert.match(r.out, /^INFO {2}registry +not asked: COLLOQ_OFFLINE=1$/m)
    assert.doesNotMatch(m.hostCalls(), /curl .*ghcr\.io/, 'offline, the registry is not even asked')
    fs.rmSync(noDocker, { recursive: true, force: true })
  } finally { m.done() }
})

test('doctor offline: an image that load has not brought is a FAIL, and so is a missing kernel', () => {
  const m = machine()
  try {
    const r = m.run(['doctor'], { COLLOQ_OFFLINE: '1', COLLOQ_IMAGE: APP, PUBLIC_URL: 'https://colloq.example.edu' })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /^FAIL {2}image +ghcr\.io\/colloq-edu\/colloq-vast:0\.9\.0 is not on this machine, and COLLOQ_OFFLINE=1: colloq-host load/m)
    assert.match(r.out, /^FAIL {2}kernels +colloq-kernel:base is not here, and offline/m)
    assert.match(r.out, /^INFO {2}offline +COLLOQ_OFFLINE=1/m)
  } finally { m.done() }
})

test('backup-timer on writes a daily persistent timer at COLLOQ_BACKUP_AT; off takes it away', () => {
  const m = machine()
  try {
    let r = m.run(['backup-timer', 'on'], { COLLOQ_BACKUP_AT: '25:00' })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /COLLOQ_BACKUP_AT=25:00 is not a time of day/)

    r = m.run(['backup-timer', 'on'], { BACKUP_KEEP: '30' })
    assert.equal(r.status, 0, r.out)
    const timer = fs.readFileSync(path.join(m.systemd, 'colloq-backup.timer'), 'utf8')
    const service = fs.readFileSync(path.join(m.systemd, 'colloq-backup.service'), 'utf8')
    assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00$/m)
    assert.match(timer, /^Persistent=true$/m)
    assert.match(timer, /^WantedBy=timers\.target$/m)
    assert.match(service, /^Type=oneshot$/m)
    assert.match(service, /^ExecStart=\S*colloq-host backup$/m)
    assert.match(service, new RegExp(`^Environment=COLLOQ_CONF_DIR=${m.conf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(m.hostCalls(), /systemctl daemon-reload\nsystemctl enable --now colloq-backup\.timer/)
    assert.match(m.envFile(), /^BACKUP_KEEP=30$/m)

    r = m.run(['backup-timer', 'on'], { COLLOQ_BACKUP_AT: '02:15' })
    assert.equal(r.status, 0, r.out)
    assert.match(fs.readFileSync(path.join(m.systemd, 'colloq-backup.timer'), 'utf8'), /^OnCalendar=\*-\*-\* 02:15:00$/m)

    r = m.run(['backup-timer', 'off'])
    assert.equal(r.status, 0, r.out)
    assert.equal(fs.existsSync(path.join(m.systemd, 'colloq-backup.timer')), false)
    assert.equal(fs.existsSync(path.join(m.systemd, 'colloq-backup.service')), false)
    assert.match(m.hostCalls(), /systemctl disable --now colloq-backup\.timer/)
  } finally { m.done() }
})

test('backup with the container stopped comes from a one-off container of the same image', () => {
  const m = machine({ registry: { [APP]: appImage('sha256:aaa1', '0.9.0') } })
  try {
    assert.equal(m.run(['up'], { COLLOQ_IMAGE: APP }).status, 0)
    assert.equal(m.run(['stop']).status, 0)
    const r = m.run(['backup'])
    assert.equal(r.status, 0, r.out)
    const oneOff = m.state().oneOffs!.find((o) => o.command[0] === 'backup')!
    assert.equal(oneOff.image, APP)
    assert.equal(oneOff.env.COLLOQ_HOME, m.home)
    assert.equal(fs.readdirSync(path.join(m.home, 'backups')).filter((f) => f.endsWith('.db')).length, 1)
  } finally { m.done() }
})
