/**
 * A machine for another instance's submissions («машина для посылок»), as the
 * image and deploy/vast/colloq-host bring it up, run for real against
 * stand-ins (docs/architecture/remote-runners.md, phase P7).
 *
 * colloq-host runs as bash on this machine; what it drives is made up: a
 * `docker` that keeps images, containers and the agent's answers in a JSON
 * file, a `curl` that plays the home's /api/health, an `nvidia-smi` with a
 * driver of the test's choosing, and the host tools as recorders. Nothing
 * needs root or Docker, and nothing leaves the machine. The entry point's
 * functions are lifted out and run with a stand-in `node` that writes down
 * what it was started with.
 *
 * What is held here, because each would break silently on a rented VM:
 *
 *   1. a machine gets its own container, settings and image, apart from the
 *      instance's, and none of the instance's secrets (RELAY_TOKEN above all);
 *      its tree is mounted at the same path on both sides, it publishes no
 *      port, and its health is the agent's "joined and syncing";
 *   2. the image is the published colloq-server of the version the home runs,
 *      since only a machine with the home's runner code gets work; a reboot
 *      leaves a joined machine alone;
 *   3. an update pulls before it drains, drains before it replaces, and --now
 *      hands the runs back instead of waiting; a failed pull changes nothing;
 *   4. leave stops Docker from restarting the agent first, and the machine
 *      never comes back on the code it left with;
 *   5. runner-code mints on the instance and prints the code once, inside the
 *      three join commands, with the image the instance itself runs;
 *   6. the entry point starts the agent only with the daemon and its tree at
 *      the same host path, with the environment the server's code accepts for
 *      Docker, and runs the minter on the instance's own database;
 *   7. the image cannot be built without the runner bundle, its hash and the
 *      minter, and the hash is the bundle's;
 *   8. a machine joined with the panel's plain `docker run` is taken over from
 *      its own container before an update drains it, and nothing is stopped
 *      that could not be started again;
 *   9. a machine that left keeps its caches but not its revoked identity, and
 *      its tree is never a system directory;
 *  10. the image's health check knows its mode, and the agent learns its own
 *      container and image, and never a join code on a command line;
 *  11. an image without the agent in it (a home rolled back to 0.22) is
 *      refused before anything is drained, recorded or started, and the
 *      agent's word on its home's version counts only from a fresh sync;
 *  12. a running agent's leave is waited for only while its home answers,
 *      and a stopped one's one-off sees the agent's mounts, CA bundle above
 *      all; an instance started without COLLOQ_SERVER_IMAGE learns its own;
 *  13. classes on machines (docs/architecture/remote-classes.md §14): the
 *      agent runs on the host's network and finds its own container there,
 *      one an older colloq-host started is moved onto it; a machine joined
 *      with --classes is checked first; an update is a restart its home
 *      holds the classes for, and never onto a tunnel the home refuses; a
 *      leave with classes asks first, and the fleet's down answers for it;
 *      the status names the tunnel and the classes; the classes counted are
 *      this tree's agent's; the first update from 0.24, which the old
 *      colloq-host runs, is followed by one that moves the agent.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { selectKernelBackend } from '../server/src/kernel/runtime-client.ts'
import { competitionBackend } from '../server/src/competitions/runner-port.ts'
import { REMOTE_BUILD_FILE, REMOTE_RUN_MS_MAX, REMOTE_DRIVER_MIN, parseRemoteJoinTarget } from '../shared/remote-runner.ts'
import { TUNNEL_PROTOCOL } from '../shared/remote-tunnel.ts'
import { INSTANCE_LABEL } from '../server/src/runner-agent/images.ts'
import { dataDir } from '../server/src/data-dir.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOST = path.join(ROOT, 'deploy/vast/colloq-host')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const ENTRYPOINT = read('deploy/vast/entrypoint.sh')

const CODE = '0123456789abcdef0123456789abcdef'
const CODE2 = 'fedcba9876543210fedcba9876543210'
const SERVER = (v: string) => `ghcr.io/colloq-edu/colloq-server:${v}`

/*
 * The stand-in docker. Every call goes to the log as a JSON array; images,
 * the registry, containers and what the agent answers live in a JSON file the
 * test prepares and reads back. The agent's answers: `runner status` exits 0
 * while agent.joined (its syncedAt is agent.syncedAt, `now` for the moment it
 * is asked), `runner drain` and `runner leave` with agent.drain and
 * agent.leave (0 by default); a leave that succeeds stops the container, as
 * the real agent stops once the home answers 401, and agent.leave `hang` is
 * one that waits for a home that never answers, until its client is killed.
 * A throwaway `--entrypoint cat` of an image's runner.sha256 prints the
 * image's runnerBuild, and fails for an image without one (0.22 and older).
 * A container's network is the one its --network named, Docker's bridge
 * without one; the daemon's networks (`network ls`) are the state's.
 */
const FAKE_DOCKER = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const file = process.env.FAKE_DOCKER_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n')
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 1))
const out = (s) => process.stdout.write(s)
const fail = (msg) => { if (msg) process.stderr.write(msg + '\\n'); process.exit(1) }
const fmtOf = (a) => { const i = a.findIndex((x) => x === '-f' || x === '--format'); return i < 0 ? [null, a] : [a[i + 1], a.slice(0, i).concat(a.slice(i + 2))] }
const findImage = (ref) => st.images[ref] ?? Object.values(st.images).find((i) => i.id === ref)
const [cmd, ...rest] = args
if (st.down) fail('Cannot connect to the Docker daemon')
if (cmd === 'version') { out(st.version + '\\n'); process.exit(0) }
if (cmd === 'info') {
  const [f] = fmtOf(rest)
  // The daemon's security options (a rootless one says so there) and its cgroup version, as templates ask.
  if (f && f.includes('SecurityOptions')) { out(JSON.stringify(['name=seccomp,profile=builtin', ...(st.rootless ? ['name=rootless'] : ['name=apparmor']), 'name=cgroupns']) + '\\n'); process.exit(0) }
  if (f && f.includes('CgroupVersion')) { out((st.cgroup ?? '2') + '\\n'); process.exit(0) }
  out('Runtimes: ' + (st.nvidia ? 'nvidia ' : '') + 'runc\\n'); process.exit(0)
}
if (cmd === 'ps') {
  // By label (k=v, or k alone), all of them as -a; a name per line, or the label a {{.Label}} format asks for.
  const filters = []; let format = null
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--filter') filters.push(rest[++i]); else if (rest[i] === '--format') format = rest[++i] }
  const has = (c, kv) => { const [k, ...v] = kv.split('='); return v.length ? (c.labels ?? {})[k] === v.join('=') : k in (c.labels ?? {}) }
  const label = /\\{\\{\\.Label "([^"]+)"\\}\\}/.exec(format ?? '')
  for (const [name, c] of Object.entries(st.containers)) {
    if (filters.every((f) => !f.startsWith('label=') || has(c, f.slice('label='.length)))) out((label ? (c.labels ?? {})[label[1]] ?? '' : name) + '\\n')
  }
  process.exit(0)
}
if (cmd === 'login') { st.logins = (st.logins ?? []).concat([rest]); save(); process.exit(0) }
if (cmd === 'image' && rest[0] === 'inspect') {
  const [f, a] = fmtOf(rest.slice(1)); const img = findImage(a[0])
  if (!img) fail('Error: No such image: ' + a[0])
  if (f === '{{.Id}}') out(img.id + '\\n')
  else { const m = /index \\.Config\\.Labels "([^"]+)"/.exec(f ?? ''); out((m ? (img.labels ?? {})[m[1]] ?? '' : '[{}]') + '\\n') }
  process.exit(0)
}
if (cmd === 'pull') {
  const ref = rest.filter((x) => !x.startsWith('-')).pop(); const img = st.registry[ref]
  if (!img) fail('Error response from daemon: manifest unknown: ' + ref)
  st.images[ref] = { ...img }; save(); process.exit(0)
}
if (cmd === 'container' && rest[0] === 'inspect' || cmd === 'inspect') {
  const [f, a] = fmtOf(cmd === 'inspect' ? rest : rest.slice(1)); const c = st.containers[a[0]]
  if (!c) fail('Error: No such container: ' + a[0])
  if (f === null) out('[{}]\\n')
  else if (f.includes('colloq.config')) out((c.labels['colloq.config'] ?? '') + '\\n')
  else if (f.includes('State.Running')) out(String(c.running) + '\\n')
  else if (f.includes('State.Status')) out((c.running ? 'running' : 'exited') + '\\n')
  // As docker prints a template: each line, then one newline of its own.
  else if (f.includes('.Config.Env')) out(Object.entries(c.env).map(([k, v]) => k + '=' + v + '\\n').join('') + '\\n')
  else if (f.includes('.Config.Cmd')) out(c.command.map((x) => x + '\\n').join('') + '\\n')
  else if (f.includes('.Mounts')) out(c.mounts.map((m) => { const [src, dst] = m.split(':'); return dst + '\\t' + src + '\\n' }).join('') + '\\n')
  else if (f === '{{.Image}}') out(c.imageId + '\\n')
  else if (f === '{{.Config.Image}}') out(c.image + '\\n')
  // Its network: the one --network named, else Docker's default bridge.
  else if (f.includes('NetworkMode')) out((c.flags.includes('--network') ? c.flags[c.flags.indexOf('--network') + 1] : 'bridge') + '\\n')
  else out('\\n')
  process.exit(0)
}
if (cmd === 'network' && rest[0] === 'ls') {
  // By label (k=v), a name per line where -q prints an id.
  const filters = []; for (let i = 1; i < rest.length; i++) if (rest[i] === '--filter') filters.push(rest[++i])
  const has = (n, kv) => { const [k, ...v] = kv.split('='); return (n.labels ?? {})[k] === v.join('=') }
  for (const [name, n] of Object.entries(st.networks ?? {})) if (filters.every((f) => !f.startsWith('label=') || has(n, f.slice('label='.length)))) out(name + '\\n')
  process.exit(0)
}
if (cmd === 'run') {
  const valued = new Set(['--name', '--restart', '--network', '--stop-timeout', '--log-opt', '-p', '-v', '--env-file', '-e', '--label',
    '--platform', '--entrypoint', '--user', '--health-cmd', '--health-interval', '--health-timeout', '--health-start-period', '--health-retries'])
  const c = { flags: [], env: {}, labels: {}, mounts: [], restart: '' }; let i = 0
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
      if (x === '--restart') c.restart = v
      if (x === '--health-cmd') c.health = v
      if (x === '--env-file') {
        c.envFile = fs.readFileSync(v, 'utf8')
        for (const l of c.envFile.split('\\n')) { const at = l.indexOf('='); if (at > 0) c.env[l.slice(0, at)] = l.slice(at + 1) }
      }
    } else c.flags.push(x)
  }
  c.image = rest[i]; c.command = rest.slice(i + 1)
  const img = findImage(c.image); if (!img) fail('Unable to find image ' + c.image + ' locally')
  c.imageId = img.id
  if (c.flags.includes('--rm') && c.flags[c.flags.indexOf('--entrypoint') + 1] === 'cat') {
    st.peeks = (st.peeks ?? []).concat([[c.image, ...c.command]]); save()
    if (c.command.join(' ') === '/opt/colloq/server/dist/runner.sha256' && img.runnerBuild) { out(img.runnerBuild + '\\n'); process.exit(0) }
    // The image's entry point, which states the tunnel protocol of its agent from 0.25 on.
    if (c.command.join(' ') === '/usr/local/bin/colloq-vast') { out('#!/usr/bin/env bash\\n' + (img.tunnelProtocol ? 'TUNNEL_PROTOCOL=' + img.tunnelProtocol + '\\n' : '')); process.exit(0) }
    fail('cat: ' + c.command.join(' ') + ': No such file or directory')
  }
  if (c.flags.includes('--rm')) { st.oneOffs = (st.oneOffs ?? []).concat([c]); save(); process.exit(st.oneOffFails ? 1 : 0) }
  c.running = true; st.containers[c.name] = c; save(); out('0123456789ab\\n'); process.exit(0)
}
if (cmd === 'start') { const c = st.containers[rest[rest.length - 1]]; if (!c) fail('No such container'); c.running = true; save(); process.exit(0) }
if (cmd === 'stop') {
  const c = st.containers[rest[rest.length - 1]]
  // Whether the agent's tree held the restart marker when its container was stopped (its last sync would say bye: restart).
  const marker = process.env.FAKE_TREE ? process.env.FAKE_TREE + '/restart.marker' : null
  st.stops = (st.stops ?? []).concat([{ name: rest[rest.length - 1], running: !!c?.running, marker: !!marker && fs.existsSync(marker) }])
  if (c) { c.running = false; c.stoppedWith = rest.slice(0, -1) }
  save(); process.exit(c ? 0 : 1)
}
if (cmd === 'rm') { const n = rest[rest.length - 1]; delete st.containers[n]; save(); process.exit(0) }
if (cmd === 'update') {
  const c = st.containers[rest[rest.length - 1]]; if (!c) fail('No such container')
  c.restart = rest.find((x) => x.startsWith('--restart=')).slice('--restart='.length); save(); process.exit(0)
}
if (cmd === 'logs') { out('[runner] the last words of the agent\\n'); process.exit(0) }
if (cmd === 'exec') {
  let i = 0; for (; i < rest.length && rest[i].startsWith('-'); i++) if (['-e', '-u', '-w'].includes(rest[i])) i++
  const name = rest[i]; const what = rest.slice(i + 1); const c = st.containers[name]
  if (!c || !c.running) fail('Error response from daemon: container ' + name + ' is not running')
  // Whether colloq-host's own files were there when it asked this.
  const conf = process.env.FAKE_CONF
  st.execs = (st.execs ?? []).concat([{ name, what, files: conf ? { env: fs.existsSync(conf + '/runner.env'), image: fs.existsSync(conf + '/runner-image') } : null }]); save()
  const agent = st.agent ?? {}
  if (what[0] === 'colloq-vast' && what[1] === 'runner') {
    if (what[2] === 'status') {
      // 'later': a sync of long ago for the first two asks, and one made just now from the third on.
      st.statusAsks = (st.statusAsks ?? 0) + 1; save()
      const at = agent.syncedAt === 'now' || (agent.syncedAt === 'later' && st.statusAsks > 2) ? Date.now() : agent.syncedAt === 'later' ? 0 : agent.syncedAt
      const synced = agent.syncedAt === undefined ? {} : { syncedAt: at }
      // An agent of 0.25 on: its tunnel to the home and the class containers it holds by role.
      const classes = { ...(agent.tunnel !== undefined ? { tunnel: agent.tunnel } : {}), ...(agent.classes !== undefined ? { classes: agent.classes } : {}) }
      out(JSON.stringify({ joined: !!agent.joined, ...(agent.homeVersion ? { homeVersion: agent.homeVersion } : {}), ...synced, ...classes }) + '\\n')
      process.exit(agent.joined ? 0 : 1)
    }
    if (what[2] === 'drain') process.exit(agent.drain ?? 0)
    // Waiting for a home that never answers: only a kill ends this client (CommonJS lets the script return).
    if (what[2] === 'leave' && agent.leave === 'hang') { setInterval(() => {}, 1000); return }
    if (what[2] === 'leave') { if (!agent.leave) { c.running = false; save() } process.exit(agent.leave ?? 0) }
  }
  if (what[0] === 'colloq-vast' && what[1] === 'runner-code') {
    if (!st.minted) fail('the minter refused')
    out('[vast] a line the minter printed before its answer\\n' + JSON.stringify(st.minted) + '\\n'); process.exit(0)
  }
  process.exit(0)
}
process.exit(0)
`

function write(file: string, text: string, mode = 0o755): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode })
}

type Image = { id: string; labels?: Record<string, string>; runnerBuild?: string; tunnelProtocol?: number }
type Container = {
  image: string; imageId: string; running: boolean; flags: string[]; env: Record<string, string>; labels: Record<string, string>
  mounts: string[]; publish?: string; command: string[]; restart: string; health?: string; envFile?: string; stoppedWith?: string[]
}
type State = {
  version: string
  images: Record<string, Image>
  registry: Record<string, Image>
  containers: Record<string, Container>
  agent?: {
    joined?: boolean; drain?: number; leave?: number | 'hang'; homeVersion?: string; syncedAt?: number | 'now' | 'later'
    tunnel?: unknown; classes?: { room: number; own: number; council: number }
  }
  statusAsks?: number
  execs?: { name: string; what: string[]; files?: { env: boolean; image: boolean } | null }[]
  oneOffs?: Container[]
  /** The throwaway `cat`s: image, then the file asked for. */
  peeks?: string[][]
  /** Every `docker stop`, and whether the agent's tree held the restart marker then. */
  stops?: { name: string; running: boolean; marker: boolean }[]
  minted?: Record<string, unknown>
  /** The daemon runs rootless; its cgroup version ('2' unless said). */
  rootless?: boolean
  cgroup?: string
  /** Its networks by name, with their labels (`docker network ls --filter label=…`). */
  networks?: Record<string, { labels?: Record<string, string> }>
  [key: string]: unknown
}

/** A release with machines for submissions: its runner build is a hash of its own. */
const release = (id: string, version: string): Image => ({
  id, labels: { 'org.opencontainers.image.version': version }, runnerBuild: createHash('sha256').update(`runner.js of ${id}`).digest('hex'),
})
/** A release from before them (0.22.0 and older): no dist/runner.sha256, no `runner` mode. */
const preRunner = (id: string, version: string): Image => ({ id, labels: { 'org.opencontainers.image.version': version } })

/** A machine: the stand-ins, a state file, and the paths colloq-host writes, all in a temporary directory. */
function machine(given: Partial<State> = {}, opts: { gpu?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-host-'))
  const bin = path.join(dir, 'bin')
  const calls = path.join(dir, 'calls')
  write(path.join(bin, 'docker'), FAKE_DOCKER)
  const recorder = (name: string, body = '') => write(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`)
  recorder('systemctl', 'case "$1" in is-enabled) echo enabled ;; esac\nexit 0')
  recorder('apt-mark', 'exit 0')
  recorder('apt-get', 'exit 0')
  // The home: /api/health with its version (the short answer a stranger gets, in a 503 as well).
  write(path.join(bin, 'curl'), `#!/bin/sh\necho "curl HTTPS_PROXY=$HTTPS_PROXY $*" >> '${calls}'\ncase "$*" in\n  *get.docker.com*) exit 1 ;;\n  */api/health*) [ -n "$FAKE_HOME_VERSION" ] || exit 7; printf '{"ok":false,"kernel":false,"isolation":null,"database":true,"workspace":true,"version":"%s"}' "$FAKE_HOME_VERSION" ;;\nesac\nexit 0\n`)
  if (opts.gpu !== false) {
    write(path.join(bin, 'nvidia-smi'), '#!/bin/sh\ncase "$*" in\n  *driver_version*) echo "${FAKE_DRIVER:-580.95.05}" ;;\n  *index,name*) echo "0, NVIDIA GeForce RTX 4090, 24564 MiB" ;;\n  *index*) echo 0 ;;\nesac\nexit 0\n')
  }
  write(path.join(bin, 'dpkg-query'), '#!/bin/sh\nprintf "installed nvidia-driver-580\\ninstalled libnvidia-compute-580\\n"\n')
  write(path.join(bin, 'id'), '#!/bin/sh\nif [ "$1" = -u ]; then echo "${FAKE_UID:-0}"; else exec /usr/bin/id "$@"; fi\n')
  write(path.join(bin, 'fuser'), '#!/bin/sh\nexit 1\n')
  // The host's iptables, with Docker's DOCKER-USER chain unless FAKE_NO_DOCKER_USER; its disk, FAKE_DISK_GB (200) in all.
  recorder('iptables', '[ -z "$FAKE_NO_DOCKER_USER" ] || { echo "iptables: No chain/target/match by that name." >&2; exit 1; }\nexit 0')
  write(path.join(bin, 'df'), '#!/bin/sh\nkb=$(( ${FAKE_DISK_GB:-200} * 1048576 ))\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/vda1 %s 1048576 %s 1%% /\\n" "$kb" "$kb"\n')
  const stateFile = path.join(dir, 'docker.json')
  const initial: State = { version: '28.3.1', images: {}, registry: {}, containers: {}, nvidia: true, agent: { joined: true }, ...given }
  fs.writeFileSync(stateFile, JSON.stringify(initial))
  const conf = path.join(dir, 'etc-colloq')
  const home = path.join(dir, 'state')
  const tree = path.join(dir, 'runner-state')
  const base: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: dir,
    FAKE_DOCKER_STATE: stateFile,
    FAKE_DOCKER_LOG: path.join(dir, 'docker.log'),
    COLLOQ_CONF_DIR: conf,
    COLLOQ_HOME: home,
    COLLOQ_RUNNER_STATE: tree,
    // A machine that never joins is found out in two seconds, not three minutes.
    COLLOQ_RUNNER_JOIN_WAIT: '2',
    // An agent's word on its home is taken from a sync already made or not at all, not waited a minute for.
    COLLOQ_RUNNER_FRESH_SEC: '0',
    FAKE_CONF: conf,
    FAKE_TREE: tree,
  }
  const run = (args: string[], env: Record<string, string> = {}) => {
    // stdin from /dev/null: on macOS node's pipes are sockets, and bash on a
    // socket takes itself for an rsh session and reads ~/.bashrc.
    const r = spawnSync('bash', [HOST, ...args], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...base, ...env },
    })
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
  }
  const state = (): State => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  return {
    dir, bin, conf, home, tree, run, state,
    setState: (patch: (s: State) => void) => { const s = state(); patch(s); fs.writeFileSync(stateFile, JSON.stringify(s)) },
    dockerCalls: (): string[][] => fs.existsSync(base.FAKE_DOCKER_LOG!)
      ? fs.readFileSync(base.FAKE_DOCKER_LOG!, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [],
    clearCalls: () => { fs.rmSync(base.FAKE_DOCKER_LOG!, { force: true }); fs.rmSync(calls, { force: true }) },
    hostCalls: (): string => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''),
    runnerEnv: (): string => fs.readFileSync(path.join(conf, 'runner.env'), 'utf8'),
    runnerImage: (): string | null => fs.existsSync(path.join(conf, 'runner-image')) ? fs.readFileSync(path.join(conf, 'runner-image'), 'utf8').trim() : null,
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const FREEZE = /systemctl disable --now unattended-upgrades apt-daily\.timer apt-daily-upgrade\.timer/
const callIndex = (calls: string[][], match: (c: string[]) => boolean) => calls.findIndex(match)

// ------------------------------------------------------------- runner up

test('runner up on a bare machine: the home picks the image, and the container gets only a machine\'s settings', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    const r = m.run(['runner', 'up', 'https://vsos.colloq.ru/', CODE], {
      FAKE_HOME_VERSION: '0.24.0', HTTPS_PROXY: 'http://proxy.campus:3128',
      // The instance's secrets in the caller's environment must not travel.
      RELAY_TOKEN: 'relay-secret-never-on-a-machine', OPENAI_API_KEY: 'sk-never-on-a-machine', SESSION_SECRET: 'never',
    })
    assert.equal(r.status, 0, r.out)
    // The version the home states picks the published image of that release, asked through the proxy.
    assert.match(m.hostCalls(), /curl HTTPS_PROXY=http:\/\/proxy\.campus:3128 .*https:\/\/vsos\.colloq\.ru\/api\/health/)
    assert.ok(m.dockerCalls().some((c) => c[0] === 'pull' && c.includes(SERVER('0.24.0'))))
    assert.equal(m.runnerImage(), SERVER('0.24.0'))
    const c = m.state().containers['colloq-runner']!
    assert.equal(c.image, SERVER('0.24.0'))
    assert.deepEqual(c.command, ['runner'])
    assert.equal(c.restart, 'unless-stopped')
    assert.equal(c.publish, undefined, 'a machine publishes no port')
    assert.ok(c.mounts.includes('/var/run/docker.sock:/var/run/docker.sock'), c.mounts.join(' '))
    // The tree at the same path on both sides, and the agent told where it is.
    assert.ok(c.mounts.includes(`${m.tree}:${m.tree}`), c.mounts.join(' '))
    assert.equal(c.env.COLLOQ_RUNNER_STATE, m.tree)
    assert.equal(c.labels['colloq.kind'], 'runner')
    // The image's own health check, which knows it runs a machine (entrypoint.sh · health), at a machine's pace.
    assert.equal(c.health, undefined, 'no --health-cmd: the image\'s mode-aware check applies')
    for (const [flag, value] of [['--health-interval', '30s'], ['--health-timeout', '20s'], ['--health-start-period', '120s']]) {
      assert.equal(c.flags[c.flags.indexOf(flag!) + 1], value, flag)
    }
    // A minute and a half to hand its runs back on a stop, through a relay's backoff.
    assert.equal(c.flags[c.flags.indexOf('--stop-timeout') + 1], '90')
    // On the host's network (D19), where a class kernel's Jupyter is published on 127.0.0.1 alone.
    assert.equal(c.flags[c.flags.indexOf('--network') + 1], 'host')
    // Its own image, to probe the cards with, and its own container, to stop Docker restarting it after a 401;
    // the entry point finds that container by name (under host networking the hostname is the host's).
    assert.equal(c.env.COLLOQ_RUNNER_IMAGE, SERVER('0.24.0'))
    assert.equal(c.env.COLLOQ_RUNNER_CONTAINER, 'colloq-runner')
    assert.equal(c.env.COLLOQ_CONTAINER, 'colloq-runner')
    // Its settings: the join (no trailing slash, the code after #) and the way out, nothing of the instance's.
    const env = m.runnerEnv()
    assert.match(env, new RegExp(`^COLLOQ_RUNNER_JOIN=https://vsos\\.colloq\\.ru#${CODE}$`, 'm'))
    assert.deepEqual(parseRemoteJoinTarget(/^COLLOQ_RUNNER_JOIN=(.*)$/m.exec(env)![1]!), { home: 'https://vsos.colloq.ru', code: CODE })
    assert.match(env, /^HTTPS_PROXY=http:\/\/proxy\.campus:3128$/m)
    for (const secret of ['RELAY_TOKEN', 'OPENAI_API_KEY', 'SESSION_SECRET', 'KERNEL_GPUS']) assert.doesNotMatch(env, new RegExp(`^${secret}=`, 'm'))
    assert.equal(c.envFile, env, 'the container reads runner.env, and only it')
    assert.equal(fs.statSync(path.join(m.conf, 'runner.env')).mode & 0o777, 0o600)
    // The instance's own settings are not even created.
    assert.equal(fs.existsSync(path.join(m.conf, 'colloq.env')), false)
    assert.equal(fs.existsSync(path.join(m.conf, 'image')), false)
    // Waited until the agent said it had joined.
    assert.ok(m.state().execs!.some((e) => e.name === 'colloq-runner' && e.what.join(' ') === 'colloq-vast runner status'))
    assert.match(r.out, /colloq-runner has joined https:\/\/vsos\.colloq\.ru/)
    assert.doesNotMatch(r.out, new RegExp(CODE), 'the code is never echoed')
  } finally { m.done() }
})

test('a repeated runner up (a reboot) leaves a joined machine alone; a new code replaces its container', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' }).status, 0)
    m.clearCalls()
    // The home has moved on meanwhile: a reboot must not move the machine behind its owner's back.
    let r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /colloq-runner is already running with these settings/)
    assert.equal(m.dockerCalls().filter((c) => c[0] === 'run' || c[0] === 'stop').length, 0)
    assert.doesNotMatch(m.hostCalls(), /api\/health/, 'the image is the one already chosen')
    r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE2], { FAKE_HOME_VERSION: '0.24.0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /replacing colloq-runner/)
    assert.match(m.state().containers['colloq-runner']!.envFile!, new RegExp(`^COLLOQ_RUNNER_JOIN=https://vsos\\.colloq\\.ru#${CODE2}$`, 'm'))
  } finally { m.done() }
})

test('runner up refuses what is not a home or a code before touching Docker, and a home that does not answer is named', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    const refused: Array<[string[], RegExp]> = [
      [['vsos.colloq.ru', CODE], /starts with https:\/\//],
      [['https://vsos.colloq.ru/api', CODE], /is not a home's address: give its origin alone/],
      [['https://user@vsos.colloq.ru', CODE], /is not a home's address/],
      [['https://vsos.colloq.ru?x=1', CODE], /is not a home's address/],
      [['https://vsos.colloq.ru', 'not-a-code'], /that is not an enrollment code \(32 hex digits\)/],
      [['https://vsos.colloq.ru', CODE.toUpperCase()], /that is not an enrollment code/],
      [['https://vsos.colloq.ru'], /usage: colloq-host runner up https:\/\/<home> <code> \[IMAGE\]/],
    ]
    for (const [args, said] of refused) {
      const r = m.run(['runner', 'up', ...args], { FAKE_HOME_VERSION: '0.24.0' })
      assert.notEqual(r.status, 0, args.join(' '))
      assert.match(r.out, said)
      assert.doesNotMatch(r.out, /not-a-code|0123456789ABCDEF/, 'a mistyped code is not repeated back')
    }
    assert.deepEqual(m.dockerCalls(), [], 'nothing reached Docker')
    // A home that does not say its version: the image is named in words, and nothing starts.
    let r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /https:\/\/vsos\.colloq\.ru did not say which version it runs .*colloq-host runner up https:\/\/vsos\.colloq\.ru <code> ghcr\.io\/colloq-edu\/colloq-server:<version>/)
    assert.equal(m.dockerCalls().filter((c) => c[0] === 'run').length, 0)
    // Named, the image needs no answer from the home.
    r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE, SERVER('0.24.0')])
    assert.equal(r.status, 0, r.out)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.24.0'))
    // An agent that never joins is reported, with its log, and the call fails.
    m.setState((s) => { s.agent = { joined: false } })
    r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE2, SERVER('0.24.0')])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /\[runner\] the last words of the agent/)
    assert.match(r.out, /colloq-runner has not joined https:\/\/vsos\.colloq\.ru in 2 s, and keeps trying/)
  } finally { m.done() }
})

test('on a private registry, runner up logs the host\'s Docker in first, and the token stays out of the machine\'s settings', () => {
  const own = 'registry.example.org/colloq/colloq-server:0.24.0'
  const m = machine({ registry: { [own]: release('sha256:own24', '0.24.0') } })
  try {
    const r = m.run(['runner', 'up', 'https://colloq.campus.example', CODE, own],
      { COLLOQ_REGISTRY_USER: 'machine-7', COLLOQ_REGISTRY_TOKEN: 'read-only-token-of-machine-7' })
    assert.equal(r.status, 0, r.out)
    const calls = m.dockerCalls()
    const login = callIndex(calls, (c) => c[0] === 'login')
    assert.deepEqual(calls[login], ['login', 'registry.example.org', '-u', 'machine-7', '--password-stdin'], 'the token goes on stdin, never as an argument')
    assert.ok(login < callIndex(calls, (c) => c[0] === 'pull'), 'logged in before the pull')
    assert.doesNotMatch(m.runnerEnv(), /COLLOQ_REGISTRY|read-only-token/, 'the host\'s Docker needs the token, not the agent\'s environment')
    assert.equal(m.state().containers['colloq-runner']!.image, own)
    assert.equal(m.runnerImage(), own)
  } finally { m.done() }
})

test('on Vast the machine freezes updates and states its driver; off Vast the host is left alone', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    let r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE],
      { FAKE_HOME_VERSION: '0.24.0', COLLOQ_ON_VAST: '1', COLLOQ_FREEZE_UPDATES: '1', FAKE_DRIVER: '535.183.01' })
    assert.equal(r.status, 0, r.out)
    assert.match(m.hostCalls(), FREEZE)
    assert.match(m.hostCalls(), /apt-mark hold nvidia-driver-580 libnvidia-compute-580/)
    assert.match(r.out, new RegExp(`NVIDIA driver 535\\.183\\.01: the GPU kernels need ${REMOTE_DRIVER_MIN} or newer, so this machine takes CPU submissions only`))
    const env = m.runnerEnv()
    assert.match(env, /^COLLOQ_ON_VAST=1$/m)
    assert.match(env, /^COLLOQ_FREEZE_UPDATES=1$/m)
    assert.doesNotMatch(env, /^KERNEL_GPUS=/m, 'a machine shares out its own cards; no list for rooms')
  } finally { m.done() }
  const kept = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    const r = kept.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' })
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(kept.hostCalls(), FREEZE, 'a server somebody keeps keeps its update policy')
    assert.match(r.out, /NVIDIA driver 580\.95\.05: GPU submissions can run here/)
  } finally { kept.done() }
  const cpu = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') }, nvidia: false }, { gpu: false })
  try {
    const r = cpu.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /no NVIDIA GPU on this machine: it takes CPU submissions only/)
  } finally { cpu.done() }
})

// ---------------------------------------------------------- runner update

test('runner update pulls first, drains, then restarts on the home\'s version; --now hands the runs back', () => {
  const m = machine({ registry: {
    [SERVER('0.24.0')]: release('sha256:r24', '0.24.0'), [SERVER('0.25.0')]: release('sha256:r25', '0.25.0'),
    [SERVER('0.26.0')]: release('sha256:r26', '0.26.0'), 'registry.example.org/colloq-server:0.26.1': release('sha256:x261', '0.26.1'),
  } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' }).status, 0)
    m.clearCalls()
    let r = m.run(['runner', 'update'], { FAKE_HOME_VERSION: '0.25.0' })
    assert.equal(r.status, 0, r.out)
    let calls = m.dockerCalls()
    const pulled = callIndex(calls, (c) => c[0] === 'pull' && c.includes(SERVER('0.25.0')))
    const drained = callIndex(calls, (c) => c[0] === 'exec' && c.slice(-3).join(' ') === 'colloq-vast runner drain')
    const stopped = callIndex(calls, (c) => c[0] === 'stop')
    const started = callIndex(calls, (c) => c[0] === 'run' && c[1] === '-d' && c.includes(SERVER('0.25.0')))
    // The new image was asked whether the agent is in it after the pull and before the drain.
    const peeked = callIndex(calls, (c) => c[0] === 'run' && c.includes('--rm') && c.includes('cat') && c.includes(SERVER('0.25.0')))
    assert.ok(pulled >= 0 && pulled < peeked && peeked < drained && drained < stopped && stopped < started, calls.map((c) => c.join(' ')).join('\n'))
    assert.match(r.out, /draining colloq-runner: it finishes the runs it holds and takes no new ones \(at most 262 min/)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.25.0'))
    assert.equal(m.runnerImage(), SERVER('0.25.0'))
    // The stop that ends a drain gives the agent its minute and a half.
    assert.equal(calls[stopped]![calls[stopped]!.indexOf('-t') + 1], '90', calls[stopped]!.join(' '))

    // The same image again is no update: no drain, nothing replaced.
    m.clearCalls()
    r = m.run(['runner', 'update', '0.25.0'])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /colloq-runner already runs ghcr\.io\/colloq-edu\/colloq-server:0\.25\.0/)
    assert.equal(m.dockerCalls().filter((c) => c[0] === 'exec' && c.includes('drain')).length, 0)
    assert.equal(m.dockerCalls().filter((c) => c[0] === 'run' || c[0] === 'stop').length, 0)

    // --now: no drain, the stop hands the runs back.
    m.clearCalls()
    r = m.run(['runner', 'update', '--now', '0.26.0'])
    assert.equal(r.status, 0, r.out)
    calls = m.dockerCalls()
    assert.equal(calls.filter((c) => c[0] === 'exec' && c.includes('drain')).length, 0)
    assert.match(r.out, /stopping colloq-runner now \(--now\): the runs it holds go back to the home's queue/)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.26.0'))

    // A pull that fails costs the machine nothing: no drain, no stop, the old image stays.
    m.clearCalls()
    r = m.run(['runner', 'update', '0.27.0'])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /could not pull ghcr\.io\/colloq-edu\/colloq-server:0\.27\.0/)
    calls = m.dockerCalls()
    assert.equal(calls.filter((c) => c[0] === 'exec' || c[0] === 'stop' || c[0] === 'run').length, 0, calls.map((c) => c.join(' ')).join('\n'))
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.26.0'))
    assert.equal(m.runnerImage(), SERVER('0.26.0'))

    // A full image is taken as it is; an agent that cannot drain is stopped all the same.
    m.setState((s) => { s.agent = { joined: true, drain: 2 } })
    r = m.run(['runner', 'update', 'registry.example.org/colloq-server:0.26.1'])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /did not drain on request \(above\); stopping it hands its runs back to the home's queue/)
    assert.equal(m.state().containers['colloq-runner']!.image, 'registry.example.org/colloq-server:0.26.1')

    // A version that is not one is refused before any pull.
    m.clearCalls()
    r = m.run(['runner', 'update', 'v1'])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /v1 is neither a version \(0\.24\.0\) nor an image/)
    assert.deepEqual(m.dockerCalls().filter((c) => c[0] === 'pull'), [])
  } finally { m.done() }
})

test('runner update follows the home through the agent when this host cannot ask the home itself', () => {
  const m = machine({ registry: {
    [SERVER('0.24.0')]: release('sha256:r24', '0.24.0'), [SERVER('0.25.0')]: release('sha256:r25', '0.25.0'), [SERVER('0.26.0')]: release('sha256:r26', '0.26.0'),
  } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' }).status, 0)
    m.setState((s) => { s.agent = { joined: true, homeVersion: '0.25.0', syncedAt: 'now' } })
    let r = m.run(['runner', 'update'])
    assert.equal(r.status, 0, r.out)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.25.0'))
    // Neither knows: the version is asked for in words.
    m.setState((s) => { s.agent = { joined: true } })
    r = m.run(['runner', 'update'])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /neither https:\/\/vsos\.colloq\.ru nor the agent says which version the home runs \(the agent's word counts from a sync since this update began, and none came: is the home up\?\); name it: colloq-host runner update <version>/)
    // Right after its home moved on: the home's container replaced, its tunnel not back, the agent's
    // status still saying the release it left, from a sync a minute ago. That is no answer: the machine
    // is not "already" on it, and nothing is pulled or drained on its word.
    m.setState((s) => { s.agent = { joined: true, homeVersion: '0.25.0', syncedAt: Date.now() - 60_000 } })
    m.clearCalls()
    r = m.run(['runner', 'update'])
    assert.notEqual(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /already runs/)
    assert.match(r.out, /nor the agent says which version the home runs \(the agent's word counts from a sync since this update began/)
    assert.deepEqual(m.dockerCalls().filter((c) => c[0] === 'pull' || c[0] === 'stop' || (c[0] === 'exec' && c.includes('drain'))), [])
    // A sync that comes while the update waits for one counts: the agent heard the home on 0.26.0.
    m.setState((s) => { s.agent = { joined: true, homeVersion: '0.26.0', syncedAt: 'later' }; s.statusAsks = 0 })
    r = m.run(['runner', 'update'], { COLLOQ_RUNNER_FRESH_SEC: '10' })
    assert.equal(r.status, 0, r.out)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.26.0'))
  } finally { m.done() }
})

test('a home rolled back to a release from before machines for submissions: runner update and up refuse before anything changes', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0'), [SERVER('0.22.0')]: preRunner('sha256:r22', '0.22.0') } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' }).status, 0)
    m.clearCalls()
    // `colloq-host restore --image …:0.22.0` on the home, then the documented next step here.
    let r = m.run(['runner', 'update'], { FAKE_HOME_VERSION: '0.22.0' })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /the home runs 0\.22\.0, a release from before machines for submissions: ghcr\.io\/colloq-edu\/colloq-server:0\.22\.0 has no runner mode\. Nothing was changed: colloq-runner keeps running ghcr\.io\/colloq-edu\/colloq-server:0\.24\.0/)
    // Asked of the image itself, by a throwaway container that runs nothing of it.
    assert.deepEqual(m.state().peeks!.at(-1), [SERVER('0.22.0'), '/opt/colloq/server/dist/runner.sha256'])
    const touched = (calls: string[][]) => calls.filter((c) => c[0] === 'stop' || c[0] === 'rm' || (c[0] === 'run' && c[1] === '-d') || (c[0] === 'exec' && c.includes('drain')))
    assert.deepEqual(touched(m.dockerCalls()), [], 'no drain, no stop, nothing started')
    const c = m.state().containers['colloq-runner']!
    assert.equal(c.running, true)
    assert.equal(c.image, SERVER('0.24.0'))
    assert.equal(m.runnerImage(), SERVER('0.24.0'), 'a reboot keeps the working agent')
    // The version named by mistake, or the image itself: the same.
    for (const named of ['0.22.0', SERVER('0.22.0')]) {
      m.clearCalls()
      r = m.run(['runner', 'update', named])
      assert.notEqual(r.status, 0, named)
      assert.match(r.out, /ghcr\.io\/colloq-edu\/colloq-server:0\.22\.0 has no machines for submissions in it \(no runner mode: a release from before them, or not a colloq-server image\); nothing was changed: colloq-runner keeps running/)
      assert.deepEqual(touched(m.dockerCalls()), [], named)
    }
    assert.equal(m.runnerImage(), SERVER('0.24.0'))
  } finally { m.done() }
  // A machine joining a home on such a release: nothing is recorded, nothing started.
  const fresh = machine({ registry: { [SERVER('0.22.0')]: preRunner('sha256:r22', '0.22.0') } })
  try {
    const r = fresh.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.22.0' })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /https:\/\/vsos\.colloq\.ru runs 0\.22\.0, a release from before machines for submissions: ghcr\.io\/colloq-edu\/colloq-server:0\.22\.0 has no runner mode, and nothing was started/)
    assert.equal(fresh.runnerImage(), null)
    assert.equal(fresh.state().containers['colloq-runner'], undefined)
    // An image named for it is refused the same way.
    const named = fresh.run(['runner', 'up', 'https://vsos.colloq.ru', CODE, SERVER('0.22.0')])
    assert.notEqual(named.status, 0)
    assert.match(named.out, /has no machines for submissions in it .*nothing was started/)
    assert.equal(fresh.state().containers['colloq-runner'], undefined)
  } finally { fresh.done() }
})

test('the drain is bounded by the longest a run can last', () => {
  // colloq-host waits at most the ceiling of the longest wall (remote-runner.ts)
  // for a drain; past it the stop hands the rest back.
  const host = read('deploy/vast/colloq-host')
  const bound = /setting COLLOQ_RUNNER_DRAIN_SEC (\d+)/.exec(host)?.[1]
  assert.equal(Number(bound), REMOTE_RUN_MS_MAX / 1000)
})

// ------------------------------------------------ a machine joined by hand

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A machine joined with the panel's plain `docker run` (§8.1 of the design):
 * its container and nothing of colloq-host's. Its environment holds the
 * image's own ENV next to what the person gave with -e.
 */
function plainRunner(tree: string, extra: { env?: Record<string, string>; mounts?: string[]; command?: string[] } = {}): Container {
  return {
    image: SERVER('0.24.0'), imageId: 'sha256:r24', running: true, flags: [], restart: 'unless-stopped',
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', NODE_VERSION: '22.20.0', COLLOQ_VERSION: '0.24.0',
      COLLOQ_HOME: '/workspace/colloq', PORT: '3000', NODE_OPTIONS: '--enable-source-maps',
      COLLOQ_RUNNER_JOIN: `https://vsos.colloq.ru#${CODE}`, COLLOQ_RUNNER_STATE: tree, HTTPS_PROXY: 'http://proxy.campus:3128',
      ...extra.env,
    },
    labels: { 'org.opencontainers.image.version': '0.24.0' },
    mounts: extra.mounts ?? ['/var/run/docker.sock:/var/run/docker.sock', `${tree}:${tree}`],
    command: extra.command ?? ['runner'],
  }
}

test('runner update takes over a machine joined with a plain docker run, writes what it needs, and only then drains and replaces it', () => {
  const m = machine({ registry: { [SERVER('0.25.0')]: release('sha256:r25', '0.25.0') } })
  try {
    fs.mkdirSync(m.tree, { recursive: true })
    fs.writeFileSync(path.join(m.tree, 'runner.json'), '{"runnerId":"joined-by-hand"}\n')
    m.setState((s) => { s.images[SERVER('0.24.0')] = release('sha256:r24', '0.24.0'); s.containers['colloq-runner'] = plainRunner(m.tree) })
    assert.equal(fs.existsSync(m.conf), false, 'nothing of colloq-host\'s on the machine')
    // No COLLOQ_RUNNER_STATE given: the tree is the container's, not colloq-host's default.
    const r = m.run(['runner', 'update'], { FAKE_HOME_VERSION: '0.25.0', COLLOQ_RUNNER_STATE: '' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /colloq-runner was started without colloq-host: its settings are now in \S+runner\.env and its image \(ghcr\.io\/colloq-edu\/colloq-server:0\.24\.0\)/)
    // Its home was read out of its join and asked for its version.
    assert.match(m.hostCalls(), /curl .*https:\/\/vsos\.colloq\.ru\/api\/health/)
    // Drained only once colloq-host's own files were there: nothing after the stop can fail for want of them.
    const drain = m.state().execs!.find((e) => e.what.join(' ') === 'colloq-vast runner drain')
    assert.ok(drain, 'it was drained, not stopped under its runs')
    assert.deepEqual(drain.files, { env: true, image: true })
    const calls = m.dockerCalls()
    const drained = callIndex(calls, (c) => c[0] === 'exec' && c.slice(-3).join(' ') === 'colloq-vast runner drain')
    const stopped = callIndex(calls, (c) => c[0] === 'stop')
    const started = callIndex(calls, (c) => c[0] === 'run' && c[1] === '-d' && c.includes(SERVER('0.25.0')))
    assert.ok(drained >= 0 && drained < stopped && stopped < started, calls.map((c) => c.join(' ')).join('\n'))
    // The new container is colloq-host's, on the old one's join, tree and way out, and nothing of the image's ENV.
    const c = m.state().containers['colloq-runner']!
    assert.equal(c.image, SERVER('0.25.0'))
    assert.match(c.labels['colloq.config'] ?? '', /^[a-f0-9]{16}$/)
    assert.ok(c.mounts.includes(`${m.tree}:${m.tree}`), c.mounts.join(' '))
    assert.equal(c.env.COLLOQ_RUNNER_STATE, m.tree)
    const env = m.runnerEnv()
    assert.match(env, new RegExp(`^COLLOQ_RUNNER_JOIN=https://vsos\\.colloq\\.ru#${CODE}$`, 'm'))
    assert.match(env, /^HTTPS_PROXY=http:\/\/proxy\.campus:3128$/m)
    assert.match(env, new RegExp(`^COLLOQ_RUNNER_STATE=${esc(m.tree)}$`, 'm'))
    for (const theirs of ['PATH', 'NODE_VERSION', 'COLLOQ_VERSION', 'COLLOQ_HOME', 'PORT', 'NODE_OPTIONS']) {
      assert.doesNotMatch(env, new RegExp(`^${theirs}=`, 'm'), `${theirs} is the image's own`)
    }
    assert.equal(fs.statSync(path.join(m.conf, 'runner.env')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(m.conf).mode & 0o777, 0o700)
    assert.equal(m.runnerImage(), SERVER('0.25.0'))
    assert.equal(fs.readFileSync(path.join(m.tree, 'runner.json'), 'utf8'), '{"runnerId":"joined-by-hand"}\n', 'its identity stays')
    // From now on it is colloq-host's: the same update again is none.
    m.clearCalls()
    assert.equal(m.run(['runner', 'update', '0.25.0']).status, 0)
    assert.equal(m.dockerCalls().filter((x) => x[0] === 'run' || x[0] === 'stop').length, 0)
  } finally { m.done() }
})

test('a machine that cannot be taken over, or would lose what it was started with, is left running as it was', () => {
  const cases: Array<[string, (tree: string) => Container, RegExp]> = [
    ['its tree from another host path', (tree) => plainRunner(tree, { mounts: ['/var/run/docker.sock:/var/run/docker.sock', `/srv/elsewhere:${tree}`] }),
      /colloq-runner was not started by colloq-host, and cannot be taken over: its tree \S+ is mounted from \/srv\/elsewhere.*Nothing was changed/],
    ['a mount colloq-host does not give', (tree) => plainRunner(tree, { mounts: ['/var/run/docker.sock:/var/run/docker.sock', `${tree}:${tree}`, '/srv/models:/models:ro'] }),
      /colloq-runner also mounts \/models \(from \/srv\/models\), which colloq-host does not give the agent, .*nothing was changed/],
    ['a CA bundle that is not on this machine', (tree) => plainRunner(tree, { env: { NODE_EXTRA_CA_CERTS: '/etc/ssl/campus-missing.pem' } }),
      /NODE_EXTRA_CA_CERTS=\/etc\/ssl\/campus-missing\.pem is not a file on this machine, .*nothing was changed/],
  ]
  for (const [what, container, said] of cases) {
    const m = machine({ registry: { [SERVER('0.25.0')]: release('sha256:r25', '0.25.0') } })
    try {
      fs.mkdirSync(m.tree, { recursive: true })
      m.setState((s) => { s.images[SERVER('0.24.0')] = release('sha256:r24', '0.24.0'); s.containers['colloq-runner'] = container(m.tree) })
      const r = m.run(['runner', 'update', '0.25.0'], { COLLOQ_RUNNER_STATE: '' })
      assert.notEqual(r.status, 0, what)
      assert.match(r.out, said, what)
      const calls = m.dockerCalls()
      const touched = calls.filter((c) => ['stop', 'rm', 'run', 'update'].includes(c[0]!) || (c[0] === 'exec' && c.includes('drain')))
      assert.deepEqual(touched, [], `${what}: ${calls.map((c) => c.join(' ')).join('\n')}`)
      const c = m.state().containers['colloq-runner']!
      assert.equal(c.running, true, what)
      assert.equal(c.image, SERVER('0.24.0'), what)
    } finally { m.done() }
  }
})

test('runner status and logs take a plain docker run machine over quietly, and status prints the agent\'s line alone', () => {
  const m = machine()
  try {
    fs.mkdirSync(m.tree, { recursive: true })
    // The join given as words in its command (colloq-vast runner join URL CODE), not in its environment.
    const joinedByWords = plainRunner(m.tree, { command: ['runner', 'join', 'https://vsos.colloq.ru/', CODE] })
    delete joinedByWords.env.COLLOQ_RUNNER_JOIN
    m.setState((s) => { s.images[SERVER('0.24.0')] = release('sha256:r24', '0.24.0'); s.containers['colloq-runner'] = joinedByWords })
    let r = m.run(['runner', 'status'], { COLLOQ_RUNNER_STATE: '' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.stdout, '{"joined":true}\n', 'what scripts read is the agent\'s line alone')
    assert.match(r.out, /colloq-runner was started without colloq-host/)
    assert.match(m.runnerEnv(), new RegExp(`^COLLOQ_RUNNER_JOIN=https://vsos\\.colloq\\.ru#${CODE}$`, 'm'))
    assert.equal(m.runnerImage(), SERVER('0.24.0'))
  } finally { m.done() }
  const odd = machine()
  try {
    odd.setState((s) => { s.containers['colloq-runner'] = plainRunner(odd.tree, { mounts: [`/srv/elsewhere:${odd.tree}`] }) })
    // One that cannot be taken over still answers, says why, and writes nothing.
    let r = odd.run(['runner', 'status'], { COLLOQ_RUNNER_STATE: '' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.stdout, '{"joined":true}\n')
    assert.match(r.out, /WARNING: colloq-runner was not started by colloq-host, and is not taken over: its tree \S+ is mounted from \/srv\/elsewhere/)
    assert.equal(fs.existsSync(path.join(odd.conf, 'runner.env')), false)
    r = odd.run(['runner', 'logs'], { COLLOQ_RUNNER_STATE: '' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /\[runner\] the last words of the agent/)
  } finally { odd.done() }
})

test('runner leave takes a plain docker run machine over first: its join is recorded, its identity put aside in its own tree', () => {
  const m = machine()
  try {
    fs.mkdirSync(m.tree, { recursive: true })
    fs.writeFileSync(path.join(m.tree, 'runner.json'), '{"runnerId":"joined-by-hand"}\n')
    m.setState((s) => { s.images[SERVER('0.24.0')] = release('sha256:r24', '0.24.0'); s.containers['colloq-runner'] = plainRunner(m.tree) })
    const r = m.run(['runner', 'leave'], { COLLOQ_RUNNER_STATE: '' })
    assert.equal(r.status, 0, r.out)
    assert.equal(m.state().containers['colloq-runner'], undefined)
    assert.equal(fs.readFileSync(path.join(m.conf, 'runner.left'), 'utf8').trim(), createHash('sha256').update(`https://vsos.colloq.ru#${CODE}`).digest('hex'))
    assert.doesNotMatch(m.runnerEnv(), /COLLOQ_RUNNER_JOIN/)
    assert.equal(fs.existsSync(path.join(m.tree, 'runner.json')), false)
    assert.equal(fs.readdirSync(m.tree).filter((f) => f.startsWith('runner.json.left-')).length, 1)
  } finally { m.done() }
})

// -------------------------------------------------- what a machine is given

test('a machine whose toolkit cannot be installed joins for CPU submissions, and says so', () => {
  // A card, but no NVIDIA runtime in Docker, and no way to install one: apt-get refuses.
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') }, nvidia: false })
  try {
    write(path.join(m.bin, 'apt-get'), `#!/bin/sh\necho "apt-get $*" >> '${path.join(m.dir, 'calls')}'\necho "E: no Debian packages on this host" >&2\nexit 100\n`)
    const r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /WARNING: nvidia-container-toolkit could not be installed \(apt-get update failed\): this machine takes CPU submissions only until it is installed by hand/)
    assert.doesNotMatch(r.out, /GPU submissions can run here/)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.24.0'))
  } finally { m.done() }
})

test('the machine\'s tree is a directory of its own: colloq-host and the entry point refuse a system one alike', () => {
  const host = read('deploy/vast/colloq-host')
  const rule = shellFunction(host, 'runner_state_problem')
  assert.equal(shellFunction(ENTRYPOINT, 'runner_state_problem'), rule, 'the entry point\'s copy is colloq-host\'s, word for word')
  const verdict = (p: string) => {
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${rule}runner_state_problem "$1" /workspace/colloq`, 'rule', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const refused: Array<[string, RegExp]> = [
    ['/', /is a system directory/], ['/var', /is a system directory/], ['/var/lib', /is a system directory/],
    ['/usr', /is a system directory/], ['/usr/local/colloq-runner', /is a system directory/], ['/etc', /is a system directory/],
    ['/etc/colloq', /is a system directory/], ['/home', /is a system directory/], ['/home/alice', /is a system directory/],
    ['/root', /is a system directory/], ['/srv', /is a system directory/], ['/data', /is a system directory/], ['/mnt', /is a system directory/],
    ['/opt', /is a system directory/], ['/tmp', /is a system directory/], ['/var/lib/docker', /is a system directory/],
    ['/var/lib/docker/volumes/x', /is a system directory/], ['/var/lib/containerd', /is a system directory/], ['/var/log/colloq', /is a system directory/],
    ['/proc/1', /is a system directory/], ['/opt/colloq', /is a system directory/], ['/workspace', /is a system directory/],
    ['/workspace/colloq', /is the instance's state directory/], ['/workspace/colloq/runner', /is inside the instance's state directory/],
    ['var/lib/colloq-runner', /is not an absolute path/], ['/srv/a b', /without colons or spaces/], ['/srv/a:b', /without colons or spaces/],
    ['/var/lib/colloq-runner/../..', /a plain path/], ['/srv/./colloq-runner', /a plain path/], ['/srv//colloq-runner', /a plain path/],
  ]
  for (const [p, said] of refused) assert.match(verdict(p), said, p)
  for (const p of ['/var/lib/colloq-runner', '/srv/colloq-runner', '/data/runner', '/mnt/disk1/colloq-runner', '/opt/colloq-runner',
    '/home/alice/colloq-runner', '/root/colloq-runner', '/workspace/colloq-runner', '/var/folders/xy/T/runner', '/tmp/colloq-test/runner']) {
    assert.equal(verdict(p), '', p)
  }
  // colloq-host refuses before it touches Docker, a trailing slash or not.
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    const r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0', COLLOQ_RUNNER_STATE: '/var/' })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /COLLOQ_RUNNER_STATE=\/var is a system directory: give the machine's tree a directory of its own, like \/var\/lib\/colloq-runner/)
    assert.deepEqual(m.dockerCalls(), [])
  } finally { m.done() }
  // The entry point refuses before its walk hands anything to uid 1000.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-prepare-'))
  try {
    const bin = path.join(dir, 'bin')
    for (const tool of ['chown', 'chmod', 'find', 'mkdir']) write(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${path.join(dir, 'calls')}'\n`)
    const body = SHELL_HEAD + shellFunction(ENTRYPOINT, 'install_registry_config') + shellFunction(ENTRYPOINT, 'runner_state_problem')
      + shellFunction(ENTRYPOINT, 'prepare_runner_as_root') + 'APP_UID=1000; APP_GID=1000; STATE=/workspace/colloq; RUNNER_STATE=/var\nprepare_runner_as_root full\n'
    const r = spawnSync('bash', ['-c', body], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(r.status, 78, r.stderr)
    assert.match(r.stderr, /COLLOQ_RUNNER_STATE=\/var is a system directory.*Nothing under it was touched\.\n$/)
    assert.equal(fs.existsSync(path.join(dir, 'calls')), false, 'nothing was walked, chowned or made')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a machine for submissions is a machine of its own: the header says so, and runner up says so next to an instance', () => {
  const header = read('deploy/vast/colloq-host').split('\nset -euo pipefail')[0]!
  assert.doesNotMatch(header, /still run a class of its own|lend its Docker to another instance/, 'a runner shares out every card and ignores the class\'s rooms')
  assert.match(header, /needs a machine of its own/)
  assert.match(header, /shares out every card/)
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    m.setState((s) => { s.containers.colloq = { image: 'ghcr.io/colloq-edu/colloq-vast:0.24.0', imageId: 'sha256:app', running: true, flags: [], env: {}, labels: {}, mounts: [], command: [], restart: 'unless-stopped' } })
    const r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /WARNING: this machine runs an instance too \(colloq\): the agent shares out every card here and admits submissions by the whole machine's memory, knowing nothing of its rooms; give the submissions a machine of their own/)
  } finally { m.done() }
  const alone = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    const r = alone.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' })
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /runs an instance too/)
  } finally { alone.done() }
})

// ----------------------------------------------------------- runner leave

test('runner leave: Docker stops restarting it first, and the machine never comes back on the code it left with', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0', HTTPS_PROXY: 'http://proxy:3128' }).status, 0)
    // What the agent keeps in its tree: its identity, and the caches it fetched.
    const blob = path.join(m.tree, 'data/competitions/.blobs', 'a'.repeat(64))
    fs.mkdirSync(path.dirname(blob), { recursive: true })
    fs.writeFileSync(blob, 'open data')
    fs.writeFileSync(path.join(m.tree, 'runner.json'), '{"runnerId":"left-machine"}\n')
    m.clearCalls()
    let r = m.run(['runner', 'leave'])
    assert.equal(r.status, 0, r.out)
    // The revoked identity is put aside, so that the next join starts without it; the caches stay for it.
    assert.equal(fs.existsSync(path.join(m.tree, 'runner.json')), false, 'a new code would meet the revoked identity and hear 401 for good')
    const aside = fs.readdirSync(m.tree).filter((f) => /^runner\.json\.left-\d{8}T\d{6}Z$/.test(f))
    assert.equal(aside.length, 1, fs.readdirSync(m.tree).join(' '))
    assert.equal(fs.readFileSync(path.join(m.tree, aside[0]!), 'utf8'), '{"runnerId":"left-machine"}\n')
    assert.equal(fs.readFileSync(blob, 'utf8'), 'open data')
    assert.match(r.out, /its revoked identity is put aside as .*runner\.json\.left-/)
    const calls = m.dockerCalls()
    const policy = callIndex(calls, (c) => c[0] === 'update' && c.includes('--restart=no'))
    const leave = callIndex(calls, (c) => c[0] === 'exec' && c.slice(-3).join(' ') === 'colloq-vast runner leave')
    const removed = callIndex(calls, (c) => c[0] === 'rm' && c.includes('-f'))
    assert.ok(policy >= 0 && policy < leave && leave < removed, calls.map((c) => c.join(' ')).join('\n'))
    assert.equal(m.state().containers['colloq-runner'], undefined)
    // The join goes, the machine's other settings stay; the image goes with the home it followed.
    const env = m.runnerEnv()
    assert.doesNotMatch(env, /COLLOQ_RUNNER_JOIN/)
    assert.match(env, /^HTTPS_PROXY=http:\/\/proxy:3128$/m)
    assert.equal(m.runnerImage(), null)
    const left = fs.readFileSync(path.join(m.conf, 'runner.left'), 'utf8')
    assert.match(left, /^[a-f0-9]{64}\n$/)
    assert.ok(!left.includes(CODE), 'the record of a code is its hash, never the code')
    assert.equal(left.trim(), createHash('sha256').update(`https://vsos.colloq.ru#${CODE}`).digest('hex'))
    // The next boot's on-start says the same `runner up`: refused, nothing started.
    m.clearCalls()
    r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /this machine left https:\/\/vsos\.colloq\.ru with this code \(colloq-host runner leave\); a new code/)
    assert.deepEqual(m.dockerCalls(), [])
    // A new code joins it again, on the home's version of the day.
    r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE2], { FAKE_HOME_VERSION: '0.24.0' })
    assert.equal(r.status, 0, r.out)
    // Nothing to leave is no failure.
    m.setState((s) => { s.containers = {} })
    r = m.run(['runner', 'leave'])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /there is no colloq-runner on this machine: nothing to leave/)
  } finally { m.done() }
})

test('a leave that fails keeps the machine running as it was; a stopped one leaves from a one-off container', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' }).status, 0)
    m.setState((s) => { s.agent = { joined: true, leave: 1 } })
    let r = m.run(['runner', 'leave'])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /colloq-runner did not leave \(its words are above\) and keeps running/)
    const c = m.state().containers['colloq-runner']!
    assert.equal(c.running, true)
    assert.equal(c.restart, 'unless-stopped', 'the restart policy is given back')
    assert.match(m.runnerEnv(), /^COLLOQ_RUNNER_JOIN=/m)
    // A failed leave keeps the identity where it is: the machine is still joined.
    fs.writeFileSync(path.join(m.tree, 'runner.json'), '{"runnerId":"still-here"}\n')
    m.setState((s) => { s.agent = { joined: true, leave: 1 } })
    assert.notEqual(m.run(['runner', 'leave']).status, 0)
    assert.equal(fs.existsSync(path.join(m.tree, 'runner.json')), true)
    // Stopped: the agent's own `runner leave` in a one-off container with the tree and the socket.
    m.setState((s) => { s.agent = { joined: true }; s.containers['colloq-runner']!.running = false })
    r = m.run(['runner', 'leave'])
    assert.equal(r.status, 0, r.out)
    assert.equal(fs.existsSync(path.join(m.tree, 'runner.json')), false)
    const oneOff = m.state().oneOffs!.find((o) => o.command.join(' ') === 'runner leave')!
    assert.equal(oneOff.image, SERVER('0.24.0'))
    assert.ok(oneOff.mounts.includes(`${m.tree}:${m.tree}`) && oneOff.mounts.includes('/var/run/docker.sock:/var/run/docker.sock'), oneOff.mounts.join(' '))
    assert.equal(oneOff.env.COLLOQ_RUNNER_STATE, m.tree)
    assert.equal(m.state().containers['colloq-runner'], undefined)
  } finally { m.done() }
})

test('the one-off a stopped machine leaves from sees what the agent saw: the CA bundle above all', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    // A university server behind an internal CA (or a TLS-inspecting proxy), joined as the docs say.
    const ca = path.join(m.dir, 'campus-ca.pem')
    fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
    let r = m.run(['runner', 'up', 'https://colloq.campus.example', CODE], { FAKE_HOME_VERSION: '0.24.0', NODE_EXTRA_CA_CERTS: ca, HTTPS_PROXY: 'http://proxy.campus:3128' })
    assert.equal(r.status, 0, r.out)
    const agent = m.state().containers['colloq-runner']!
    assert.ok(agent.mounts.includes(`${ca}:${ca}:ro`), agent.mounts.join(' '))
    // Stopped (a reboot that left it down, a docker stop), then asked to leave.
    m.setState((s) => { s.containers['colloq-runner']!.running = false })
    r = m.run(['runner', 'leave'])
    assert.equal(r.status, 0, r.out)
    const oneOff = m.state().oneOffs!.find((o) => o.command.join(' ') === 'runner leave')!
    assert.equal(oneOff.env.NODE_EXTRA_CA_CERTS, ca, 'told to trust it')
    assert.ok(oneOff.mounts.includes(`${ca}:${ca}:ro`), `and given it: ${oneOff.mounts.join(' ')}`)
    // The very mounts the agent had, the same list, and its network: the host's, its way to the home.
    assert.deepEqual(oneOff.mounts, agent.mounts)
    assert.equal(oneOff.flags[oneOff.flags.indexOf('--network') + 1], 'host')
    // Its image to probe with, and no container of its own: this one-off is not the machine's.
    assert.equal(oneOff.env.COLLOQ_RUNNER_IMAGE, SERVER('0.24.0'))
    assert.equal(oneOff.env.COLLOQ_RUNNER_CONTAINER, '')
    assert.equal(oneOff.env.COLLOQ_RUNNER_STATE, m.tree)
  } finally { m.done() }
})

test('a running agent\'s leave is waited for only while its home answers, and never for good', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' }).status, 0)
    fs.writeFileSync(path.join(m.tree, 'runner.json'), '{"runnerId":"still-here"}\n')
    // The home is gone (destroyed before its machines, its tunnel down): the agent last heard it an hour ago,
    // and its leave waits for an answer that never comes.
    const status = (syncedAt: number) => fs.writeFileSync(path.join(m.tree, 'status.json'), `${JSON.stringify({ state: 'leaving', syncedAt, updatedAt: Date.now() })}\n`)
    status(Date.now() - 3_600_000)
    m.setState((s) => { s.agent = { joined: true, leave: 'hang' } })
    const began = Date.now()
    let r = m.run(['runner', 'leave'], { COLLOQ_RUNNER_LEAVE_SILENT_SEC: '2' })
    assert.notEqual(r.status, 0, r.out)
    assert.ok(Date.now() - began < 30_000, 'given up within seconds, not waited for good')
    assert.match(r.out, /colloq-runner has heard nothing from its home \(https:\/\/vsos\.colloq\.ru\) for 2 s while leaving, and a leave ends with the home's answer\. It keeps running and leaving: it takes no new work, and revokes itself as soon as the home answers/)
    // The machine is as it was: running, restarted by Docker again, still joined, its identity in place.
    let c = m.state().containers['colloq-runner']!
    assert.equal(c.running, true)
    assert.equal(c.restart, 'unless-stopped', 'the restart policy is given back')
    assert.match(m.runnerEnv(), /^COLLOQ_RUNNER_JOIN=/m)
    assert.equal(fs.existsSync(path.join(m.tree, 'runner.json')), true)
    // A home that answers is waited for while the runs finish, up to the bound, and no longer.
    status(Date.now() + 3_600_000)
    r = m.run(['runner', 'leave'], { COLLOQ_RUNNER_LEAVE_SEC: '2' })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /colloq-runner has not left in 2 s: it still finishes its runs, or waits for its home \(its words are above\)/)
    c = m.state().containers['colloq-runner']!
    assert.equal(c.running, true)
    assert.equal(c.restart, 'unless-stopped')
    // The defaults: ten minutes of silence, the drain's bound and ten minutes in all.
    const host = read('deploy/vast/colloq-host')
    assert.match(host, /bound="\$\(setting COLLOQ_RUNNER_LEAVE_SEC \$\(\(drain \+ 600\)\)\)"/)
    assert.match(host, /silent="\$\(setting COLLOQ_RUNNER_LEAVE_SILENT_SEC 600\)"/)
  } finally { m.done() }
})

test('runner status answers for the agent, and says so when there is none', () => {
  const m = machine({ registry: { [SERVER('0.24.0')]: release('sha256:r24', '0.24.0') } })
  try {
    let r = m.run(['runner', 'status'])
    assert.equal(r.status, 1)
    assert.match(r.out, /there is no colloq-runner on this machine: colloq-host runner up https:\/\/<home> <code>/)
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.24.0' }).status, 0)
    r = m.run(['runner', 'status'])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /\{"joined":true\}/)
    m.setState((s) => { s.agent = { joined: false } })
    assert.equal(m.run(['runner', 'status']).status, 1)
    m.setState((s) => { s.containers['colloq-runner']!.running = false })
    r = m.run(['runner', 'status'])
    assert.equal(r.status, 1)
    assert.match(r.out, /colloq-runner is not running \(exited\); why: colloq-host runner logs/)
    // The commands are listed where an operator looks.
    const help = m.run(['help']).out + m.run(['runner', 'help']).out
    for (const word of ['runner up URL CODE [IMAGE]', 'runner update [VERSION|IMAGE] [--now]', 'runner status', 'runner logs', 'runner leave', 'runner-code [--machines N]']) {
      assert.ok(help.includes(word), `colloq-host help lacks ${word}`)
    }
  } finally { m.done() }
})

// ----------------------------------------------------------- runner-code

test('runner-code mints on the instance and prints the code once, inside the three join commands', () => {
  const appImage = 'ghcr.io/colloq-edu/colloq-vast:0.24.0'
  const m = machine({
    images: { [appImage]: release('sha256:app24', '0.24.0') },
    // 14 Oct 2025 12:00 UTC, in milliseconds.
    minted: { code: CODE, expiresAt: Date.UTC(2025, 9, 14, 12, 0), machines: 3, trusted: true },
  })
  try {
    m.setState((s) => { s.containers.colloq = { image: appImage, imageId: 'sha256:app24', running: true, flags: [], env: {}, labels: {}, mounts: [], command: [], restart: 'unless-stopped' } })
    fs.mkdirSync(m.home, { recursive: true })
    fs.writeFileSync(path.join(m.home, '.env'), 'KERNEL_ENV=base\nPUBLIC_URL=https://vsos.colloq.ru\n')
    const r = m.run(['runner-code', '--machines', '3', '--hours', '12', '--trusted', '--slots', '4', '--prefix', 'vast'])
    assert.equal(r.status, 0, r.out)
    // Asked of the instance itself, through its entry point (which drops to the server's user).
    const exec = m.state().execs!.find((e) => e.what[1] === 'runner-code')!
    assert.equal(exec.name, 'colloq')
    assert.deepEqual(exec.what, ['colloq-vast', 'runner-code', '--machines', '3', '--hours', '12', '--trusted', '--slots', '4', '--prefix', 'vast'])
    assert.match(r.out, /a code for 3 machine\(s\), valid until 2025-10-14 12:00 UTC; trusted with the hidden test; at most 4 places each/)
    // The three commands of the design, filled in: the image the instance runs, under its colloq-server name.
    assert.ok(r.out.includes([
      '  docker run -d --name colloq-runner --restart unless-stopped --network host --stop-timeout 90 \\',
      '    -v /var/run/docker.sock:/var/run/docker.sock \\',
      '    -v /var/lib/colloq-runner:/var/lib/colloq-runner \\',
      `    -e COLLOQ_RUNNER_JOIN='https://vsos.colloq.ru#${CODE}' \\`,
      `    ${SERVER('0.24.0')} runner`,
    ].join('\n')), r.out)
    assert.ok(r.out.includes([
      '  command -v docker || curl -fsSL https://get.docker.com | sh',
      `  docker run --rm -v /usr/local/sbin:/host ${SERVER('0.24.0')} install-host /host`,
      `  colloq-host runner up https://vsos.colloq.ru ${CODE}`,
    ].join('\n')), r.out)
    assert.ok(r.out.includes(`  make vast-runner COUNT=3 CODE=${CODE} URL=https://vsos.colloq.ru`), r.out)
    assert.equal(r.out.split(CODE).length - 1, 3, 'the code appears inside the three commands and nowhere else')
  } finally { m.done() }
})

test('runner-code with an image of its own names it, and refuses what it cannot mint', () => {
  const own = 'registry.example.org/colloq/colloq-vast:0.24.0-campus'
  const m = machine({ images: { [own]: release('sha256:own', '0.24.0') }, minted: { code: CODE, expiresAt: Date.UTC(2025, 9, 14, 12, 0), machines: 1, trusted: false } })
  try {
    fs.mkdirSync(m.home, { recursive: true })
    fs.writeFileSync(path.join(m.home, '.env'), 'PUBLIC_URL=http://localhost:3000\n')
    // No instance running: nothing to mint with.
    let r = m.run(['runner-code'])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /colloq is not running here: the code is minted by the instance itself/)
    m.setState((s) => { s.containers.colloq = { image: own, imageId: 'sha256:own', running: true, flags: [], env: {}, labels: {}, mounts: [], command: [], restart: 'unless-stopped' } })
    const refused: Array<[string[], RegExp]> = [
      [['--machines', '0'], /--machines is how many machines may join with the code: 1 to 100/],
      [['--hours', '25'], /--hours is how long the code stays valid: 1 to 24/],
      [['--slots', '99'], /--slots caps the places on each machine: 1 to 64/],
      [['--prefix', 'a b'], /--prefix is a short name/],
      [['--machines'], /--machines needs a value/],
      [['--everything'], /unknown option --everything/],
    ]
    for (const [args, said] of refused) {
      const out = m.run(['runner-code', ...args])
      assert.notEqual(out.status, 0, args.join(' '))
      assert.match(out.out, said)
    }
    assert.equal((m.state().execs ?? []).length, 0, 'nothing was minted for a refused call')
    r = m.run(['runner-code'])
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(m.state().execs!.at(-1)!.what, ['colloq-vast', 'runner-code', '--machines', '1', '--hours', '24'])
    assert.match(r.out, /http:\/\/localhost:3000 is this machine's own loopback: a machine anywhere else cannot reach it/)
    assert.match(r.out, /not given the hidden test/)
    // The instance's own image, whole, in both commands; Vast machines would not match it.
    assert.ok(r.out.includes(`    ${own} runner`), r.out)
    assert.ok(r.out.includes(`  colloq-host runner up http://localhost:3000 ${CODE} ${own}`), r.out)
    assert.doesNotMatch(r.out, /make vast-runner COUNT/)
    assert.match(r.out, /make vast-runner is left out: its machines take the published colloq-server of this release, and this instance runs registry\.example\.org/)
    // --url names the address machines reach.
    r = m.run(['runner-code', '--url', 'https://colloq.campus.example'])
    assert.equal(r.status, 0, r.out)
    assert.ok(r.out.includes(`COLLOQ_RUNNER_JOIN='https://colloq.campus.example#${CODE}'`), r.out)
    assert.doesNotMatch(r.out, /own loopback/)
  } finally { m.done() }
})

// -------------------------------------------------------- the entry point

/** One function of a shell script, `name() {` to the `}` that closes it at the start of a line. */
function shellFunction(source: string, name: string): string {
  const found = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(source)
  assert.ok(found, `${name}() is not in the script`)
  return found[0]
}

/** One of the entry point's one-line functions (say, warn, die), as it defines it: a copy here would test the copy. */
function oneLiner(source: string, name: string): string {
  const found = new RegExp(`^${name}\\(\\)\\s+\\{.*\\}$`, 'm').exec(source)
  assert.ok(found, `${name}() is not a one-line function of the script`)
  return found[0]
}

const SHELL_HEAD = `set -euo pipefail\n${['say', 'warn', 'die'].map((n) => oneLiner(ENTRYPOINT, n)).join('\n')}\n`

/**
 * Functions lifted out of the entry point, run with a stand-in docker (its
 * daemon up or down, our container's mounts from FAKE_MOUNTS and its image
 * from FAKE_IMAGE) and a stand-in node that writes down its arguments and
 * environment. `argv0` is the script's own name, "$0", for what calls the
 * entry point again.
 */
function entrypointRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-entry-'))
  const bin = path.join(dir, 'bin')
  write(path.join(bin, 'docker'), `#!/bin/sh
case "$1" in
  version) [ -z "$FAKE_DOCKER_DOWN" ] || exit 1; echo 28.3.1 ;;
  inspect)
    [ "$*" != "inspect $FAKE_SELF" ] || exit 0
    case "$*" in
      *"{{range .Mounts}}"*) printf '%b' "$FAKE_MOUNTS" ;;
      *"{{.Config.Image}}"*) [ -n "$FAKE_IMAGE" ] || exit 1; echo "$FAKE_IMAGE" ;;
      *) exit 1 ;;
    esac ;;
esac
exit 0
`)
  write(path.join(bin, 'node'), `#!/bin/sh\n{ echo "ARGS $*"; echo "PWD $(pwd)"; env; } > "$DUMP"\n`)
  const run = (names: string[], tail: string, env: Record<string, string> = {}, argv0?: string) => {
    const dump = path.join(dir, 'node.dump')
    fs.rmSync(dump, { force: true })
    const body = SHELL_HEAD + names.map((n) => shellFunction(ENTRYPOINT, n)).join('\n') + tail
    const r = spawnSync('bash', ['-c', body, ...(argv0 ? [argv0] : [])], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, DUMP: dump, FAKE_SELF: 'self0123', COLLOQ_CONTAINER: 'self0123', ...env },
    })
    const node = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : null
    const nodeEnv: Record<string, string> = {}
    for (const line of (node ?? '').split('\n')) { const at = line.indexOf('='); if (at > 0 && !line.startsWith('ARGS ')) nodeEnv[line.slice(0, at)] = line.slice(at + 1) }
    return { status: r.status, out: r.stdout + r.stderr, args: /^ARGS (.*)$/m.exec(node ?? '')?.[1] ?? null, cwd: /^PWD (.*)$/m.exec(node ?? '')?.[1] ?? null, env: nodeEnv }
  }
  return { dir, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const RUNNER_FUNCTIONS = ['require_docker', 'locate_self', 'own_container_id', 'host_path_of', 'require_same_path', 'runner_state_problem', 'runner_join_args', 'runner']

test('the agent starts only with the daemon and its tree at the same host path, with the backend the server accepts', () => {
  const rig = entrypointRig()
  try {
    const tail = (args: string) => `APP='${rig.dir}'; RUNNER_STATE=/var/lib/colloq-runner; VERSION=0.24.0; SELF=""\nrunner ${args}\n`
    // No daemon: a refusal that says what a machine needs.
    let r = rig.run(RUNNER_FUNCTIONS, tail(''), { FAKE_DOCKER_DOWN: '1' })
    assert.equal(r.status, 78, r.out)
    assert.match(r.out, /no Docker daemon is reachable[\s\S]*A machine for submissions runs every notebook in a container of its own/)
    assert.equal(r.args, null, 'the agent did not start')
    // Its tree in the container's own layer.
    r = rig.run(RUNNER_FUNCTIONS, tail(''), { FAKE_MOUNTS: '/var/run/docker.sock\\t/var/run/docker.sock\\n' })
    assert.equal(r.status, 78, r.out)
    assert.match(r.out, /\/var\/lib\/colloq-runner is not a mounted directory\. Mount it from the host at the same path:\s+-v \/var\/lib\/colloq-runner:\/var\/lib\/colloq-runner/)
    // Mounted from another host path: the daemon would mount empty directories into every submission.
    r = rig.run(RUNNER_FUNCTIONS, tail(''), { FAKE_MOUNTS: '/var/lib/colloq-runner\\t/data/runner\\n' })
    assert.equal(r.status, 78, r.out)
    assert.match(r.out, /\/var\/lib\/colloq-runner is mounted from \/data\/runner on the host\. Mount it at the same path/)
    // Right, through a parent mount too: the agent, from the application directory.
    for (const mounts of ['/var/lib/colloq-runner\\t/var/lib/colloq-runner\\n', '/var/lib\\t/var/lib\\n/var/run/docker.sock\\t/var/run/docker.sock\\n']) {
      r = rig.run(RUNNER_FUNCTIONS, tail(''), { FAKE_MOUNTS: mounts, RELAY_TOKEN: 'never', CLOUDFLARE_TUNNEL_TOKEN: 'never', DATA_HOST_DIR: '/elsewhere' })
      assert.equal(r.status, 0, r.out)
      assert.equal(r.args, 'server/dist/runner.js')
      assert.equal(fs.realpathSync(r.cwd!), fs.realpathSync(rig.dir))
      assert.equal(r.env.NODE_ENV, 'development')
      assert.equal(r.env.KERNEL_BACKEND, 'docker')
      assert.equal(r.env.COMPETITION_BACKEND, 'docker')
      assert.equal(r.env.COLLOQ_RUNNER_STATE, '/var/lib/colloq-runner')
      assert.equal(r.env.DATA_DIR, '/var/lib/colloq-runner/data')
      for (const gone of ['RELAY_TOKEN', 'CLOUDFLARE_TUNNEL_TOKEN', 'DATA_HOST_DIR']) assert.equal(r.env[gone], undefined, `${gone} reached the agent`)
      // The server's own code agrees: Docker for rooms and for submissions.
      assert.equal(selectKernelBackend({ NODE_ENV: r.env.NODE_ENV, KERNEL_BACKEND: r.env.KERNEL_BACKEND }), 'docker')
      assert.equal(competitionBackend({ NODE_ENV: r.env.NODE_ENV, KERNEL_BACKEND: r.env.KERNEL_BACKEND, COMPETITION_BACKEND: r.env.COMPETITION_BACKEND, KERNEL_RUNTIME_URL: 'http://broker:8787' }), 'docker')
    }
    // Its commands answer without the daemon, and pass their words on; join is the agent and needs it,
    // and its code moves into the agent's environment, off every command line (ps, /proc, docker top).
    r = rig.run(RUNNER_FUNCTIONS, tail('status'), { FAKE_DOCKER_DOWN: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.args, 'server/dist/runner.js status')
    r = rig.run(RUNNER_FUNCTIONS, tail(`drain`), { FAKE_DOCKER_DOWN: '1' })
    assert.equal(r.args, 'server/dist/runner.js drain')
    r = rig.run(RUNNER_FUNCTIONS, tail(`join https://vsos.colloq.ru ${CODE}`), { FAKE_DOCKER_DOWN: '1' })
    assert.equal(r.status, 78, r.out)
    r = rig.run(RUNNER_FUNCTIONS, tail(`join https://vsos.colloq.ru/ ${CODE}`), { FAKE_MOUNTS: '/var/lib/colloq-runner\\t/var/lib/colloq-runner\\n' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.args, 'server/dist/runner.js', 'the agent starts with no words, and none of them the code')
    assert.equal(r.env.COLLOQ_RUNNER_JOIN, `https://vsos.colloq.ru#${CODE}`)
    assert.ok(!r.out.includes(CODE), 'the code is not said')
    // A join without its two words is refused, and starts nothing.
    r = rig.run(RUNNER_FUNCTIONS, tail('join https://vsos.colloq.ru'), { FAKE_MOUNTS: '/var/lib/colloq-runner\\t/var/lib/colloq-runner\\n' })
    assert.equal(r.status, 64, r.out)
    assert.match(r.out, /usage: colloq-vast runner join https:\/\/<home> <code>, or the join in the environment: -e COLLOQ_RUNNER_JOIN=/)
    assert.equal(r.args, null)
  } finally { rig.done() }
})

test('runner-code runs the minter on the instance\'s own database, without the tunnel\'s secrets', () => {
  const rig = entrypointRig()
  try {
    const r = rig.run(['runner_code'], `APP='${rig.dir}'; STATE=/workspace/colloq\nrunner_code --machines 2 --hours 3 --trusted\n`, { RELAY_TOKEN: 'never' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.args, 'server/dist/runner-code.js --machines 2 --hours 3 --trusted')
    assert.equal(r.env.DATA_DIR, '/workspace/colloq/data')
    assert.equal(r.env.WORKSPACE_DIR, '/workspace/colloq/workspace')
    assert.equal(r.env.NODE_ENV, 'development')
    assert.equal(r.env.RELAY_TOKEN, undefined)
  } finally { rig.done() }
})

test('the state directory is still found through the longest mount', () => {
  const rig = entrypointRig()
  try {
    const locate = (mounts: string) => rig.run(['locate_host_state', 'host_path_of'],
      'STATE=/workspace/colloq; SELF=self0123; HOST_STATE=""\nlocate_host_state\nprintf "HOST %s\\n" "$HOST_STATE"\n', { FAKE_MOUNTS: mounts })
    assert.match(locate('/workspace\\t/srv/w\\n/workspace/colloq\\t/data/colloq\\n').out, /^HOST \/data\/colloq$/m)
    assert.match(locate('/workspace\\t/srv/w\\n').out, /^HOST \/srv\/w\/colloq$/m)
    // A prefix of the name is not a parent directory.
    const r = locate('/workspace/col\\t/srv/col\\n')
    assert.notEqual(r.status, 0)
    assert.match(r.out, /\/workspace\/colloq is not a mounted directory/)
  } finally { rig.done() }
})

test('a refusal of the entry point says its words and exits with its code, and the code is never one of the words', () => {
  const rig = entrypointRig()
  try {
    const tail = 'SELF=self0123\nrequire_same_path /var/lib/colloq-runner\n'
    for (const [mounts, end] of [['', /files that live on the host\.$/], ['/var/lib/colloq-runner\\t/data/runner\\n', /nothing on a machine translates them\.$/]] as const) {
      const r = rig.run(['host_path_of', 'require_same_path'], tail, { FAKE_MOUNTS: mounts })
      assert.equal(r.status, 78, r.out)
      assert.match(r.out.trimEnd(), end)
      assert.doesNotMatch(r.out, /\s78\s*$/, 'the exit code ended up in the message')
    }
  } finally { rig.done() }
})

test('the agent learns its own container and image: from colloq-host, or from the daemon for a plain docker run', () => {
  const rig = entrypointRig()
  try {
    const start = (env: Record<string, string>) => rig.run(RUNNER_FUNCTIONS,
      `APP='${rig.dir}'; RUNNER_STATE=/var/lib/colloq-runner; VERSION=0.24.0; SELF=""\nrunner\n`,
      { FAKE_MOUNTS: '/var/lib/colloq-runner\\t/var/lib/colloq-runner\\n', FAKE_IMAGE: SERVER('0.24.0'), ...env })
    let r = start({})
    assert.equal(r.status, 0, r.out)
    assert.equal(r.env.COLLOQ_RUNNER_CONTAINER, 'self0123', 'the container the daemon knows this one by')
    assert.equal(r.env.COLLOQ_RUNNER_IMAGE, SERVER('0.24.0'))
    // What colloq-host passes wins.
    r = start({ COLLOQ_RUNNER_CONTAINER: 'colloq-runner', COLLOQ_RUNNER_IMAGE: 'registry.example.org/colloq-server:0.24.0' })
    assert.equal(r.env.COLLOQ_RUNNER_CONTAINER, 'colloq-runner')
    assert.equal(r.env.COLLOQ_RUNNER_IMAGE, 'registry.example.org/colloq-server:0.24.0')
    // The agent's commands are a docker exec into it: they get the container's own environment, and nothing is asked.
    r = rig.run(RUNNER_FUNCTIONS, `APP='${rig.dir}'; RUNNER_STATE=/var/lib/colloq-runner; VERSION=0.24.0; SELF=""\nrunner status\n`, { FAKE_DOCKER_DOWN: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.env.COLLOQ_RUNNER_IMAGE, undefined)
    assert.equal(r.env.COLLOQ_RUNNER_CONTAINER, undefined)
  } finally { rig.done() }
})

test('an instance started without COLLOQ_SERVER_IMAGE learns its own image from the daemon, for the panel\'s join commands', () => {
  // An instance updated to this release by the colloq-host of the one before: its container was started
  // without the variable, and its settings' fingerprint does not count it, so nothing ever adds it.
  const serve = shellFunction(ENTRYPOINT, 'serve')
  assert.ok(serve.indexOf('locate_self') < serve.indexOf('locate_server_image') && serve.indexOf('locate_server_image') < serve.indexOf('start_server'),
    'serve asks after it has found its container, and before the server starts')
  const rig = entrypointRig()
  try {
    // A child process sees it: the server, started by serve, inherits it.
    const ask = (env: Record<string, string>) => rig.run(['locate_server_image'],
      'SELF=self0123\nlocate_server_image\nbash -c \'printf "IMAGE[%s]\\n" "${COLLOQ_SERVER_IMAGE:-}"\'\n', env)
    const own = 'registry.example.org/colloq/colloq-vast:0.24.0-campus'
    let r = ask({ FAKE_IMAGE: own })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`^IMAGE\\[${esc(own)}\\]$`, 'm'))
    // What colloq-host passes wins.
    r = ask({ FAKE_IMAGE: own, COLLOQ_SERVER_IMAGE: 'ghcr.io/colloq-edu/colloq-vast:0.24.0' })
    assert.match(r.out, /^IMAGE\[ghcr\.io\/colloq-edu\/colloq-vast:0\.24\.0\]$/m)
    // A bare id is no name a machine can pull, and a daemon that does not say leaves it unknown: the panel then names the published image.
    for (const id of [`sha256:${'a'.repeat(64)}`, 'a'.repeat(64), '0123456789ab', '']) {
      r = ask({ FAKE_IMAGE: id })
      assert.equal(r.status, 0, r.out)
      assert.match(r.out, /^IMAGE\[\]$/m, id)
    }
  } finally { rig.done() }
})

test('the image\'s health check knows its mode: the agent\'s status for a machine, the server\'s livez for an instance', () => {
  const dockerfile = read('deploy/vast/Dockerfile')
  assert.match(dockerfile, /^HEALTHCHECK [^\n]*\\\n\s+CMD \["\/usr\/local\/bin\/colloq-vast", "health"\]$/m)
  assert.doesNotMatch(dockerfile.slice(dockerfile.indexOf('HEALTHCHECK')), /^\s+CMD curl/m, 'no port of its own in the image\'s check')
  // health is answered before the root preparation, which a check every quarter minute has no business running.
  const main = ENTRYPOINT.slice(ENTRYPOINT.indexOf('# ------------------------------------------------------------------ main'))
  assert.match(/case "\$cmd" in\n([\s\S]*?)\nesac/.exec(main)![1]!, /^ {2}health\) health ;;$/m)
  const rig = entrypointRig()
  try {
    const calls = path.join(rig.dir, 'calls')
    write(path.join(rig.dir, 'bin', 'curl'), `#!/bin/sh\necho "curl $*" >> '${calls}'\nexit "\${FAKE_CURL_RC:-0}"\n`)
    // The entry point itself, which the agent's status goes through again ("$0").
    const entry = path.join(rig.dir, 'colloq-vast')
    write(entry, `#!/bin/sh\necho "entry $*" >> '${calls}'\nexit "\${FAKE_STATUS_RC:-0}"\n`)
    const cmdline = path.join(rig.dir, 'cmdline')
    const check = (pid1: string[] | null, env: Record<string, string> = {}) => {
      fs.rmSync(calls, { force: true })
      if (pid1) fs.writeFileSync(cmdline, pid1.map((a) => `${a}\0`).join(''))
      else fs.rmSync(cmdline, { force: true })
      const r = rig.run(['container_mode', 'health'], `PORT=3000; PID1_CMDLINE='${cmdline}'\nhealth\n`, env, entry)
      return { status: r.status, out: r.out, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' }
    }
    const tini = ['/usr/bin/tini', '-g', '--', '/usr/local/bin/colloq-vast']
    // A machine: colloq-host's, the panel's plain docker run with the join as words, under docker's --init.
    for (const pid1 of [[...tini, 'runner'], [...tini, 'runner', 'join', 'https://vsos.colloq.ru', CODE], ['/sbin/docker-init', '--', ...tini, 'runner']]) {
      let r = check(pid1)
      assert.equal(r.status, 0, r.out)
      assert.equal(r.calls, 'entry runner status\n', pid1.join(' '))
      // Any failure is 1 for Docker, never the agent's own code: Docker keeps 2 for itself.
      r = check(pid1, { FAKE_STATUS_RC: '2' })
      assert.equal(r.status, 1)
    }
    // An instance, by its command or by the image's CMD alone, and a container whose first process says nothing.
    for (const pid1 of [[...tini, 'serve'], tini, null]) {
      let r = check(pid1)
      assert.equal(r.status, 0, r.out)
      assert.match(r.calls, /^curl -fsS --noproxy \* -o \/dev\/null --max-time \d+ http:\/\/127\.0\.0\.1:3000\/api\/livez\n$/)
      r = check(pid1, { FAKE_CURL_RC: '7' })
      assert.equal(r.status, 1)
    }
  } finally { rig.done() }
})

test('the main block drops to uid 1000 before either command, and walks the tree only for the agent itself', () => {
  const main = ENTRYPOINT.slice(ENTRYPOINT.indexOf('# ------------------------------------------------------------------ main'))
  // Neither is among the commands that run before the drop.
  const early = /case "\$cmd" in\n([\s\S]*?)\nesac/.exec(main)![1]!
  assert.doesNotMatch(early, /runner/)
  const drop = /if \[ "\$\(id -u\)" = 0 \][\s\S]*?\nfi\n/.exec(main)![0]
  assert.match(drop, /runner\)\n\s+# .*\n\s+case "\$\{1:-\}" in\n\s+''\) prepare_runner_as_root full ;;\n\s+\*\) prepare_runner_as_root ;;/)
  assert.ok(drop.indexOf('prepare_runner_as_root') < drop.indexOf('drop_to_app "$cmd" "$@"'))
  // `runner join URL CODE` turns into COLLOQ_RUNNER_JOIN before the drop re-executes the script with its words.
  const join = /if \[ "\$cmd" = runner \] && \[ "\$\{1:-\}" = join \]; then\n\s+runner_join_args "\$@"\n\s+set --\nfi\n/.exec(main)
  assert.ok(join, 'the main block does not move the join into the environment')
  assert.ok(main.indexOf(join[0]) < main.indexOf('if [ "$(id -u)" = 0 ]'))
  assert.match(main, /\n {2}runner\) runner "\$@" ;;\n {2}runner-code\) runner_code "\$@" ;;\n/)
  // The preparation itself: the tree to uid 1000, private, walked whole only for the agent's start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-prepare-'))
  try {
    const bin = path.join(dir, 'bin')
    for (const tool of ['chown', 'find']) write(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${path.join(dir, 'calls')}'\n`)
    const tree = path.join(dir, 'tree')
    const prepare = (walk: string) => {
      fs.rmSync(path.join(dir, 'calls'), { force: true })
      const body = SHELL_HEAD + shellFunction(ENTRYPOINT, 'install_registry_config') + shellFunction(ENTRYPOINT, 'runner_state_problem') + shellFunction(ENTRYPOINT, 'prepare_runner_as_root')
        + `APP_UID=1000; APP_GID=1000; RUNNER_STATE='${tree}'\nprepare_runner_as_root ${walk}\n`
      const r = spawnSync('bash', ['-c', body], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `${bin}:${process.env.PATH}` } })
      assert.equal(r.status, 0, r.stderr)
      return fs.readFileSync(path.join(dir, 'calls'), 'utf8')
    }
    assert.match(prepare('full'), new RegExp(`^find ${tree} -xdev .* -exec chown -h 1000:1000 \\{\\} \\+$`, 'm'))
    // Save a council's scratch space: root's on purpose (runner-agent/council.ts · scratchHelperArgs), never handed to uid 1000.
    assert.match(prepare('full'), new RegExp(`^find ${tree} -xdev -path ${tree}/council/\\*/scratch -prune -o `, 'm'))
    assert.equal(prepare(''), `chown 1000:1000 ${tree}\n`)
    assert.equal(fs.statSync(tree).mode & 0o777, 0o700)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --------------------------------------------------------------- the image

test('the image cannot be built without the runner bundle, its hash and the minter, and the hash is the bundle\'s', () => {
  const dockerfile = read('deploy/vast/Dockerfile')
  // server/dist goes in whole, where the entry point runs it from (APP=/opt/colloq).
  assert.match(dockerfile, /^WORKDIR \/opt\/colloq$/m)
  assert.match(dockerfile, /^COPY --from=build \/app\/server\/dist \.\/server\/dist$/m)
  assert.match(ENTRYPOINT, /^APP=\/opt\/colloq$/m)
  assert.match(shellFunction(ENTRYPOINT, 'runner'), /node server\/dist\/runner\.js "\$@"/)
  assert.match(shellFunction(ENTRYPOINT, 'runner_code'), /node server\/dist\/runner-code\.js "\$@"/)
  // The root Dockerfile (colloq-app) takes the same directory whole too.
  assert.match(read('Dockerfile'), /^COPY --from=build \/app\/server\/dist \.\/dist$/m)
  // The guard, after the server's build and in its stage, is run here as it is.
  const guard = /\nRUN set -eu; \\\n((?: {4}.*\\\n)*? {4}.*sha256sum -c -)\n/.exec(dockerfile)
  assert.ok(guard, 'deploy/vast/Dockerfile has no guard for the runner files')
  assert.ok(dockerfile.indexOf(guard[0]) > dockerfile.indexOf('npm run build -w @colloq/server'))
  assert.ok(dockerfile.indexOf(guard[0]) < dockerfile.indexOf('AS deps'))
  assert.ok(guard[1]!.includes(REMOTE_BUILD_FILE), `the guard checks another file than ${REMOTE_BUILD_FILE}`)
  const script = 'set -eu; ' + guard[1]!.replace(/\\\n/g, '\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-guard-'))
  try {
    const dist = path.join(dir, 'server/dist')
    fs.mkdirSync(dist, { recursive: true })
    const bundle = 'export const agent = 1\n'
    const digest = createHash('sha256').update(bundle).digest('hex')
    const check = (files: Record<string, string>) => {
      for (const f of ['runner.js', 'runner.sha256', 'runner-code.js']) fs.rmSync(path.join(dist, f), { force: true })
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dist, name), text)
      const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: r.status, out: r.stdout + r.stderr }
    }
    // The digest alone, or as sha256sum prints it (remote-runner.ts · parseRemoteBuildFile).
    assert.equal(check({ 'runner.js': bundle, 'runner.sha256': `${digest}\n`, 'runner-code.js': 'x' }).status, 0)
    assert.equal(check({ 'runner.js': bundle, 'runner.sha256': `${digest}  runner.js\n`, 'runner-code.js': 'x' }).status, 0)
    const stale = check({ 'runner.js': bundle + '// edited after hashing\n', 'runner.sha256': `${digest}\n`, 'runner-code.js': 'x' })
    assert.notEqual(stale.status, 0, 'a hash that is not the bundle\'s must stop the build')
    const missing = check({ 'runner.js': bundle, 'runner.sha256': `${digest}\n` })
    assert.notEqual(missing.status, 0)
    assert.match(missing.out, /server\/dist\/runner-code\.js is missing: the server build no longer writes it/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------------------- the on-start

test('the runner on-start carries the home and the code, and nothing that is a secret', () => {
  const onstart = read('deploy/vast/onstart-runner.sh')
  assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'deploy/vast/onstart-runner.sh')]).status, 0)
  const code = onstart.split('\n').filter((l) => !/^\s*#/.test(l))
  const exported = code.map((l) => /^export ([A-Z_]+)=/.exec(l)?.[1]).filter(Boolean)
  assert.deepEqual(exported, ['COLLOQ_RUNNER_URL', 'COLLOQ_RUNNER_CODE', 'COLLOQ_RUNNER_REPO', 'COLLOQ_ON_VAST', 'COLLOQ_FREEZE_UPDATES'])
  for (const line of code) assert.doesNotMatch(line, /RELAY|TOKEN|SECRET|PASSWORD|API_KEY/, `the on-start's code names a secret: ${line}`)
  assert.match(onstart, /^export COLLOQ_RUNNER_URL="https:\/\/HOME"/m)
  assert.match(onstart, /^export COLLOQ_RUNNER_CODE="CODE"/m)
  // The Vast flags are set before colloq-host runs, and the machine joins with the image it installed colloq-host from.
  const exec = onstart.indexOf('exec /usr/local/sbin/colloq-host runner up "$COLLOQ_RUNNER_URL" "$COLLOQ_RUNNER_CODE" "$image"')
  assert.ok(exec > 0)
  assert.ok(onstart.indexOf('export COLLOQ_FREEZE_UPDATES=1') < exec && onstart.indexOf('export COLLOQ_ON_VAST=1') < exec)
  assert.ok(onstart.indexOf('install-host /host') < exec)
  // After an update it keeps the image update chose; before, the published one of the home's version,
  // from the same repository colloq-host takes by default (COLLOQ_RUNNER_REPO for a fork, as there).
  assert.match(onstart, /^export COLLOQ_RUNNER_REPO=""/m)
  assert.match(onstart, /image="\$\(head -1 \/etc\/colloq\/runner-image/)
  const repo = /image="\$\{COLLOQ_RUNNER_REPO:-(ghcr\.io\/[^}]+)\}:\$version"/.exec(onstart)?.[1]
  assert.equal(repo, /setting COLLOQ_RUNNER_REPO ([^)]+)\)/.exec(read('deploy/vast/colloq-host'))?.[1])
  // The image ships it next to the instance's own on-start, executable, and the scripts parse.
  const dockerfile = read('deploy/vast/Dockerfile')
  assert.match(dockerfile, /^COPY deploy\/vast\/colloq-host deploy\/vast\/onstart\.sh deploy\/vast\/onstart-runner\.sh \.\/deploy\/vast\/$/m)
  assert.match(dockerfile, /^RUN chmod 0755 [^\n]*\.\/deploy\/vast\/onstart-runner\.sh/m)
  for (const file of ['entrypoint.sh', 'colloq-host']) {
    assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'deploy/vast', file)]).status, 0, file)
  }
})

test('the runner on-start takes the home\'s version from the repository COLLOQ_RUNNER_REPO names, and hands it on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-onstart-'))
  try {
    const bin = path.join(dir, 'bin')
    const sbin = path.join(dir, 'sbin')
    const calls = path.join(dir, 'calls')
    // The image's runner build, read by a throwaway cat: there, or (FAKE_PRE_RUNNER) a release from before machines for submissions.
    write(path.join(bin, 'docker'), `#!/bin/sh\necho "docker $*" >> '${calls}'\ncase "$*" in\n  *"--entrypoint cat "*runner.sha256) [ -z "$FAKE_PRE_RUNNER" ] || { echo "cat: no such file" >&2; exit 1; }; echo ${'c'.repeat(64)} ;;\nesac\nexit 0\n`)
    write(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n')
    write(path.join(bin, 'curl'), `#!/bin/sh\necho "curl $*" >> '${calls}'\nprintf '{"ok":false,"version":"0.24.0"}'\n`)
    write(path.join(sbin, 'colloq-host'), `#!/bin/sh\necho "colloq-host $* REPO=$COLLOQ_RUNNER_REPO" >> '${calls}'\n`)
    // The file as make vast-runner fills it, with its machine paths moved into this directory.
    const boot = (repo: string, env: Record<string, string> = {}) => {
      fs.rmSync(calls, { force: true })
      const script = path.join(dir, 'onstart-runner.sh')
      fs.writeFileSync(script, read('deploy/vast/onstart-runner.sh')
        .replace(/^export COLLOQ_RUNNER_URL="[^"]*"/m, 'export COLLOQ_RUNNER_URL="https://vsos.colloq.ru"')
        .replace(/^export COLLOQ_RUNNER_CODE="[^"]*"/m, `export COLLOQ_RUNNER_CODE="${CODE}"`)
        .replace(/^export COLLOQ_RUNNER_REPO="[^"]*"/m, `export COLLOQ_RUNNER_REPO="${repo}"`)
        .replaceAll('/var/log/colloq-onstart.log', path.join(dir, 'onstart.log'))
        .replaceAll('/etc/colloq/', `${path.join(dir, 'etc-colloq')}/`)
        .replaceAll('/usr/local/sbin', sbin))
      const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `${bin}:/usr/bin:/bin`, ...env } })
      return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' }
    }
    let r = boot('')
    assert.equal(r.status, 0, r.out)
    assert.match(r.calls, /^curl -sS --max-time 20 https:\/\/vsos\.colloq\.ru\/api\/health$/m)
    assert.ok(r.calls.includes(`docker run --rm -v ${sbin}:/host ${SERVER('0.24.0')} install-host /host\n`), r.calls)
    assert.ok(r.calls.includes(`colloq-host runner up https://vsos.colloq.ru ${CODE} ${SERVER('0.24.0')} REPO=\n`), r.calls)
    // The image was asked whether the agent is in it before its colloq-host replaced the one here.
    const peek = r.calls.indexOf(`docker run --rm --network none --entrypoint cat ${SERVER('0.24.0')} /opt/colloq/server/dist/runner.sha256\n`)
    assert.ok(peek >= 0 && peek < r.calls.indexOf('install-host'), r.calls)
    // A home rolled back to a release from before machines for submissions: the boot stops in words,
    // before that release's colloq-host (one with no `runner` at all) is put on the machine.
    r = boot('', { FAKE_PRE_RUNNER: '1' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /ghcr\.io\/colloq-edu\/colloq-server:0\.24\.0 has no machines for submissions in it \(a release from before them\): https:\/\/vsos\.colloq\.ru must run a release with them first/)
    assert.doesNotMatch(r.calls, /install-host|colloq-host runner up/)
    // A fork's registry: its image of the home's version, and colloq-host told the repository for the updates to come.
    const fork = 'registry.example.org/fork/colloq-server'
    r = boot(fork)
    assert.equal(r.status, 0, r.out)
    assert.ok(r.calls.includes(`docker run --rm -v ${sbin}:/host ${fork}:0.24.0 install-host /host\n`), r.calls)
    assert.ok(r.calls.includes(`colloq-host runner up https://vsos.colloq.ru ${CODE} ${fork}:0.24.0 REPO=${fork}\n`), r.calls)
    assert.doesNotMatch(r.calls, /ghcr\.io\/colloq-edu/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------- classes on machines (0.25)

/**
 * The label the agent of a tree puts on its containers (runner-agent/images.ts · INSTANCE_LABEL: the hash of
 * its data root, `<tree>/data`), as `key=value`; one test below holds it equal to images.ts's own.
 */
const instanceOf = (tree: string): string => `ru.colloq.competition-instance=${createHash('sha256').update(path.resolve(tree, 'data')).digest('hex').slice(0, 16)}`

/** A class kernel's container as the agent of `tree` starts one (room-spec.ts · machineRoomRunArgs): its kind, its placement, its agent's label. */
function classKernel(tree: string, sessionId: string, role: 'room' | 'own' | 'council', gen = 1): Container {
  const [key, value] = instanceOf(tree).split('=') as [string, string]
  return {
    image: `ghcr.io/colloq-edu/colloq-kernel@sha256:${'d'.repeat(64)}`, imageId: 'sha256:kernel', running: true, flags: [], env: {},
    labels: { 'colloq.kind': 'class-kernel', 'colloq.placement': `${sessionId}:${role}:${gen}`, [key]: value }, mounts: [], command: [], restart: 'no',
  }
}

/** A release of 0.25 or later: its entry point states the tunnel protocol its agent speaks. */
const tunnelRelease = (id: string, version: string, protocol: number): Image => ({ ...release(id, version), tunnelProtocol: protocol })

test('an agent an older colloq-host started on Docker\'s bridge is moved onto the host\'s network by the next runner up, as a restart', () => {
  const m = machine({ registry: { [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1) } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    // What the colloq-host of 0.24 left: the same image and settings, no --network, and its fingerprint, which knew no network.
    const sorted = m.runnerEnv().split('\n').filter(Boolean).sort().map((line) => `${line}\n`).join('')
    const before = createHash('sha256').update(`${SERVER('0.25.0')}\nsha256:r25\n${sorted}state ${m.tree}\n`).digest('hex').slice(0, 16)
    m.setState((s) => {
      const c = s.containers['colloq-runner']!
      c.flags = c.flags.filter((flag, i, all) => flag !== '--network' && all[i - 1] !== '--network')
      c.labels['colloq.config'] = before
      s.containers['colloq-class-a1b2c3-c1-room'] = classKernel(m.tree, 'c1', 'room')
    })
    m.clearCalls()
    const r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /replacing colloq-runner \(new image or settings\); class kernels keep running/)
    const c = m.state().containers['colloq-runner']!
    assert.equal(c.flags[c.flags.indexOf('--network') + 1], 'host')
    // A restart, not an end: the agent's last sync says so (the marker in its tree), and the marker does not outlive the stop.
    assert.deepEqual(m.state().stops!.map((stop) => [stop.name, stop.running, stop.marker]), [['colloq-runner', true, true]])
    assert.equal(fs.existsSync(path.join(m.tree, 'restart.marker')), false)
    // The class kernels are not colloq-host's to stop: they wait for the new agent to adopt them.
    assert.equal(m.state().containers['colloq-class-a1b2c3-c1-room']!.running, true)
    // From then on the fingerprint is this colloq-host's own: a reboot's runner up leaves the agent alone.
    assert.match(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).out, /colloq-runner is already running with these settings/)
  } finally { m.done() }
})

test('runner up --classes checks first that the machine can take classes, and refuses before anything is written, pulled or started', () => {
  const registry = { [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1) }
  const app = (labels: Record<string, string> = {}): Container => ({ image: 'ghcr.io/colloq-edu/colloq-vast:0.25.0', imageId: 'sha256:app', running: true, flags: [], env: {}, labels, mounts: [], command: [], restart: 'unless-stopped' })
  const fine = machine({ registry, nvidia: false }, { gpu: false })
  try {
    // 57 GB of a 60 GB floor passes: a disk shows a few percent less than it was rented at.
    const r = fine.run(['runner', 'up', '--classes', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0', FAKE_DISK_GB: '57' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /this machine can take classes: Docker run by root with its iptables, cgroup v2, no Colloq server on this Docker, disk enough for the class folders/)
    assert.equal(fine.state().containers['colloq-runner']!.image, SERVER('0.25.0'))
    assert.match(fine.hostCalls(), /^iptables -w -n -L DOCKER-USER$/m, 'the chain was asked of the host\'s own iptables')
  } finally { fine.done() }
  const cases: Array<[string, Partial<State>, Record<string, string>, RegExp, boolean]> = [
    ['a rootless daemon', { rootless: true }, {}, /ERROR: Docker here runs rootless: classes need the daemon run by root, whose iptables rules fence the network of every class/, false],
    ['no DOCKER-USER chain', {}, { FAKE_NO_DOCKER_USER: '1' }, /ERROR: Docker here does not manage iptables \(no DOCKER-USER chain: "iptables": false in \/etc\/docker\/daemon\.json, its nftables backend, or no iptables at all\)/, false],
    ['cgroup v1', { cgroup: '1' }, {}, /ERROR: this machine runs cgroup 1, and classes need cgroup v2/, false],
    ['an instance beside it', { containers: { colloq: app() } }, {}, /ERROR: a Colloq server runs on this Docker \(its container, its rooms, or its rooms' network\): a machine that takes classes needs a Docker of its own/, false],
    ['an instance under another name', { containers: { 'campus-colloq': app({ 'colloq.kind': 'app' }) } }, {}, /ERROR: a Colloq server runs on this Docker/, false],
    ['a pip home\'s rooms', { containers: { 'colloq-room-abc': { ...app({ 'colloq.kind': 'room-kernel' }), image: 'colloq-kernel:base' } } }, {}, /ERROR: a Colloq server runs on this Docker/, false],
    // Every room of it idle, so their containers gone: the network they live on stays, and the agent counts it (D20).
    ['a pip home\'s rooms\' network alone', { networks: { 'colloq-rooms': { labels: { 'colloq.kind': 'room-network' } } } }, {}, /ERROR: a Colloq server runs on this Docker/, false],
    ['a small disk', {}, { FAKE_DISK_GB: '50' }, /ERROR: the disk of \S+ holds 50 GB, and a machine without cards that takes classes needs 60 GB: the 40 GB any machine without cards needs, and 20 GB for the class folders/, false],
    ['a small disk with cards', {}, { FAKE_DISK_GB: '130' }, /ERROR: the disk of \S+ holds 130 GB, and a machine with cards that takes classes needs 140 GB: the 120 GB any machine with cards needs, and 20 GB for the class folders/, true],
  ]
  for (const [what, given, env, said, gpu] of cases) {
    const m = machine({ registry, nvidia: gpu, ...given }, { gpu })
    try {
      const r = m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE, '--classes'], { FAKE_HOME_VERSION: '0.25.0', ...env })
      assert.notEqual(r.status, 0, what)
      assert.match(r.out, said, what)
      assert.match(r.out, /this machine cannot take classes \(above\), and nothing was pulled or started: fix what is said and run this again, or join it for submissions only with a code that takes no classes/, what)
      assert.deepEqual(m.dockerCalls().filter((c) => c[0] === 'pull' || c[0] === 'run'), [], `${what}: nothing pulled or started`)
      assert.equal(fs.existsSync(path.join(m.conf, 'runner.env')), false, `${what}: nothing written`)
    } finally { m.done() }
  }
  // Every problem at once, for the person who fixes them.
  const all = machine({ registry, rootless: true, cgroup: '1', nvidia: false }, { gpu: false })
  try {
    const r = all.run(['runner', 'up', 'https://vsos.colloq.ru', CODE, '--classes'], { FAKE_HOME_VERSION: '0.25.0', FAKE_NO_DOCKER_USER: '1', FAKE_DISK_GB: '20' })
    assert.notEqual(r.status, 0)
    assert.equal(r.out.match(/\[colloq-host\] ERROR: /g)!.length, 5, r.out)
  } finally { all.done() }
  // Without --classes the same machine joins for what its code says, and an instance beside it is only said.
  const plain = machine({ registry, rootless: true, cgroup: '1', containers: { colloq: app() } })
  try {
    const r = plain.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0', FAKE_NO_DOCKER_USER: '1' })
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /take classes/)
    assert.match(r.out, /WARNING: this machine runs an instance too \(colloq\)/)
    // A word that is no option is refused before anything.
    const odd = plain.run(['runner', 'up', 'https://vsos.colloq.ru', CODE, '--class'])
    assert.notEqual(odd.status, 0)
    assert.match(odd.out, /usage: colloq-host runner up https:\/\/<home> <code> \[IMAGE\] \[--classes\]/)
  } finally { plain.done() }
})

test('runner update stops the agent as a restart: the marker is in its tree for its last sync, and gone after', () => {
  const m = machine({ registry: {
    [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1), [SERVER('0.25.1')]: tunnelRelease('sha256:r251', '0.25.1', 1),
    [SERVER('0.25.2')]: tunnelRelease('sha256:r252', '0.25.2', 1), [SERVER('0.25.3')]: tunnelRelease('sha256:r253', '0.25.3', 1),
  } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    const marker = path.join(m.tree, 'restart.marker')
    // The stops of one update: whether each found the agent running, and the marker in its tree.
    const stopsOf = (run: () => { status: number | null; out: string }) => {
      const before = (m.state().stops ?? []).length
      const r = run()
      assert.equal(r.status, 0, r.out)
      return m.state().stops!.slice(before).map((stop) => [stop.running, stop.marker])
    }
    // Drained, then stopped with the marker there: its goodbye says restart, and its home holds the classes for it.
    // (The replacement after it finds the agent stopped already, and writes none.)
    assert.deepEqual(stopsOf(() => m.run(['runner', 'update'], { FAKE_HOME_VERSION: '0.25.1' })), [[true, true], [false, false]])
    assert.equal(fs.existsSync(marker), false, 'no marker outlives the stop')
    // --now, the same.
    assert.deepEqual(stopsOf(() => m.run(['runner', 'update', '--now', '0.25.2'])), [[true, true], [false, false]])
    assert.equal(fs.existsSync(marker), false)
    // A stopped agent says nothing more: none is written for it.
    m.setState((s) => { s.containers['colloq-runner']!.running = false })
    assert.deepEqual(stopsOf(() => m.run(['runner', 'update', '0.25.3'])), [[false, false]])
    assert.equal(fs.existsSync(marker), false)
    // A leave is an end, never a restart.
    const stops = m.state().stops!.length
    assert.equal(m.run(['runner', 'leave']).status, 0)
    assert.equal(m.state().stops!.length, stops, 'the agent stops itself on a leave')
    assert.equal(fs.existsSync(marker), false)
  } finally { m.done() }
})

test('runner update keeps classes running, and refuses an agent whose tunnel its home would refuse while they run', () => {
  const registry = {
    [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1), [SERVER('0.25.1')]: tunnelRelease('sha256:r251', '0.25.1', 1),
    [SERVER('0.26.0')]: tunnelRelease('sha256:r26', '0.26.0', 2),
  }
  const m = machine({ registry })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    // Two classes: one with its room and personal kernels, one with its council.
    m.setState((s) => {
      s.containers['colloq-class-a1b2c3-c1-room'] = classKernel(m.tree, 'c1', 'room')
      s.containers['colloq-class-a1b2c3-c1-own'] = classKernel(m.tree, 'c1', 'own')
      s.containers['colloq-class-a1b2c3-c2-council'] = classKernel(m.tree, 'c2', 'council', 4)
    })
    const touched = (calls: string[][]) => calls.filter((c) => c[0] === 'stop' || c[0] === 'rm' || (c[0] === 'run' && c[1] === '-d') || (c[0] === 'exec' && c.includes('drain')))
    // Another protocol, named while the home runs 0.25.0: refused before anything is drained or stopped.
    m.clearCalls()
    let r = m.run(['runner', 'update', '0.26.0'], { FAKE_HOME_VERSION: '0.25.0' })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /this machine holds 2 class\(es\), reached through its agent's tunnel in protocol 1, its home's, and the agent of ghcr\.io\/colloq-edu\/colloq-server:0\.26\.0 speaks 2: its home would refuse that tunnel, and the classes would move to the server, their variables lost\. Nothing was changed: update to the release the home runs \(0\.25\.0: colloq-host runner update\), or once the classes are over/)
    assert.deepEqual(touched(m.dockerCalls()), [])
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.25.0'))
    assert.equal(m.runnerImage(), SERVER('0.25.0'))
    // The protocols of both images were read from their entry points, by throwaway containers that run nothing of them.
    assert.deepEqual(m.state().peeks!.filter((p) => p[1] === '/usr/local/bin/colloq-vast').map((p) => p[0]), [SERVER('0.26.0'), 'sha256:r25'])
    // The same protocol: updated, and the classes keep running for the new agent to adopt.
    r = m.run(['runner', 'update', '0.25.1'], { FAKE_HOME_VERSION: '0.25.0' })
    assert.equal(r.status, 0, r.out)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.25.1'))
    for (const name of ['colloq-class-a1b2c3-c1-room', 'colloq-class-a1b2c3-c1-own', 'colloq-class-a1b2c3-c2-council']) assert.equal(m.state().containers[name]!.running, true, name)
    // The home went first, as the order goes: following it is the update that brings the agent back to its protocol.
    r = m.run(['runner', 'update'], { FAKE_HOME_VERSION: '0.26.0' })
    assert.equal(r.status, 0, r.out)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.26.0'))
  } finally { m.done() }
  // Without classes on it a machine's tunnel is nobody's yet: it updates as before.
  const idle = machine({ registry })
  try {
    assert.equal(idle.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    const r = idle.run(['runner', 'update', '0.26.0'], { FAKE_HOME_VERSION: '0.25.0' })
    assert.equal(r.status, 0, r.out)
    assert.equal(idle.state().containers['colloq-runner']!.image, SERVER('0.26.0'))
    assert.deepEqual((idle.state().peeks ?? []).filter((p) => p[1] === '/usr/local/bin/colloq-vast'), [], 'and nothing is read for it')
  } finally { idle.done() }
})

test('runner leave on a machine with classes asks first, changes nothing without --force, and moves them with it', () => {
  const m = machine({ registry: { [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1) } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    m.setState((s) => {
      s.containers['colloq-class-a1b2c3-c1-room'] = classKernel(m.tree, 'c1', 'room')
      s.containers['colloq-class-a1b2c3-c1-own'] = classKernel(m.tree, 'c1', 'own')
      s.containers['colloq-class-a1b2c3-c2-room'] = { ...classKernel(m.tree, 'c2', 'room', 7), running: false }
    })
    m.clearCalls()
    let r = m.run(['runner', 'leave'])
    // Its own exit, which the fleet's runners-down reads (scripts/vast-runner.sh · down_one).
    assert.equal(r.status, 3, r.out)
    assert.match(r.out, /ERROR: this machine holds 2 class\(es\) of its home: leaving moves them off it, and their variables are lost \(colloq-host runner leave --force leaves all the same\)/)
    assert.deepEqual(m.dockerCalls().filter((c) => c[0] === 'update' || c[0] === 'exec' || c[0] === 'stop' || c[0] === 'rm'), [], 'nothing was changed')
    const c = m.state().containers['colloq-runner']!
    assert.deepEqual([c.running, c.restart], [true, 'unless-stopped'])
    assert.match(m.runnerEnv(), /^COLLOQ_RUNNER_JOIN=/m)
    // --force: it leaves, and says what becomes of its classes.
    r = m.run(['runner', 'leave', '--force'])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /--force: the 2 class\(es\) on this machine move off it as it leaves, and their variables are lost/)
    assert.equal(m.state().containers['colloq-runner'], undefined)
    // What is no option is refused.
    const odd = m.run(['runner', 'leave', '--now'])
    assert.notEqual(odd.status, 0)
    assert.match(odd.out, /usage: colloq-host runner leave \[--force\]/)
  } finally { m.done() }
})

test('runner status names the tunnel and the classes on stderr, and leaves stdout the agent\'s line alone', () => {
  const m = machine({ registry: { [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1) } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    m.setState((s) => { s.agent = { joined: true, tunnel: { up: true, rttMs: 48, since: 1_760_000_000_000 }, classes: { room: 1, own: 2, council: 0 } } })
    let r = m.run(['runner', 'status'])
    assert.equal(r.status, 0, r.out)
    assert.equal(r.stdout, '{"joined":true,"tunnel":{"up":true,"rttMs":48,"since":1760000000000},"classes":{"room":1,"own":2,"council":0}}\n')
    assert.match(r.out, /^\[colloq-host\] tunnel: up · RTT 48 ms$/m)
    assert.match(r.out, /^\[colloq-host\] classes: room 1 · own 2 · council 0$/m)
    // Down, with no round trip to tell; a word for a tunnel reads the same; the agent's exit is the command's.
    m.setState((s) => { s.agent = { joined: false, tunnel: { up: false, rttMs: null }, classes: { room: 0, own: 0, council: 0 } } })
    r = m.run(['runner', 'status'])
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /^\[colloq-host\] tunnel: down$/m)
    assert.match(r.out, /^\[colloq-host\] classes: room 0 · own 0 · council 0$/m)
    m.setState((s) => { s.agent = { joined: true, tunnel: 'up' } })
    assert.match(m.run(['runner', 'status']).out, /^\[colloq-host\] tunnel: up$/m)
    // A machine that takes no classes (no tunnel asked for, none held), and an agent from before classes: nothing is added.
    for (const agent of [{ joined: true, tunnel: null, classes: { room: 0, own: 0, council: 0 } }, { joined: true }]) {
      m.setState((s) => { s.agent = agent })
      r = m.run(['runner', 'status'])
      assert.equal(r.stdout, `${JSON.stringify(agent)}\n`)
      assert.doesNotMatch(r.out, /tunnel:|classes:/)
    }
    // Classes held while the tunnel is not asked for (between two syncs): the classes are said all the same.
    m.setState((s) => { s.agent = { joined: true, tunnel: null, classes: { room: 0, own: 0, council: 1 } } })
    assert.match(m.run(['runner', 'status']).out, /^\[colloq-host\] classes: room 0 · own 0 · council 1$/m)
  } finally { m.done() }
})

test('runner-code --classes mints a code that takes classes, whose bare machine checks first; never with --trusted', () => {
  const appImage = 'ghcr.io/colloq-edu/colloq-vast:0.25.0'
  const m = machine({ images: { [appImage]: release('sha256:app25', '0.25.0') }, minted: { code: CODE, expiresAt: Date.UTC(2025, 9, 14, 12, 0), machines: 2, trusted: false, classes: true } })
  try {
    m.setState((s) => { s.containers.colloq = { image: appImage, imageId: 'sha256:app25', running: true, flags: [], env: {}, labels: {}, mounts: [], command: [], restart: 'unless-stopped' } })
    fs.mkdirSync(m.home, { recursive: true })
    fs.writeFileSync(path.join(m.home, '.env'), 'PUBLIC_URL=https://vsos.colloq.ru\n')
    let r = m.run(['runner-code', '--machines', '2', '--classes'])
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(m.state().execs!.at(-1)!.what, ['colloq-vast', 'runner-code', '--machines', '2', '--hours', '24', '--classes'])
    assert.match(r.out, /a code for 2 machine\(s\), valid until 2025-10-14 12:00 UTC; takes classes, and is never given the hidden test/)
    assert.match(r.out, /it lets those machines take this instance's submissions and its classes, whose code, files and personal notebooks they see/)
    assert.ok(r.out.includes(`  docker run -d --name colloq-runner --restart unless-stopped --network host --stop-timeout 90 \\\n`), r.out)
    assert.ok(r.out.includes(`  colloq-host runner up https://vsos.colloq.ru ${CODE} --classes\n`), r.out)
    assert.ok(r.out.includes(`  make vast-runner COUNT=2 CODE=${CODE} URL=https://vsos.colloq.ru\n`), r.out)
    // Both flags at once: refused before anything is minted (D3).
    const execs = m.state().execs!.length
    r = m.run(['runner-code', '--classes', '--trusted'])
    assert.notEqual(r.status, 0)
    assert.match(r.out, /--classes and --trusted do not go together: a machine that takes classes is never given the hidden test/)
    assert.equal(m.state().execs!.length, execs, 'nothing was minted')
  } finally { m.done() }
})

test('the entry point states its agent\'s tunnel protocol as shared/remote-tunnel.ts has it, and colloq-host reads it from an image', () => {
  assert.equal(/^TUNNEL_PROTOCOL=(\d+)$/m.exec(ENTRYPOINT)?.[1], String(TUNNEL_PROTOCOL))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-tunnel-'))
  try {
    // A docker whose throwaway `cat` of the image's entry point prints this checkout's.
    const entry = path.join(ROOT, 'deploy/vast/entrypoint.sh')
    write(path.join(dir, 'bin', 'docker'), `#!/bin/sh\ncase "$*" in\n  "run --rm --network none --entrypoint cat img:new /usr/local/bin/colloq-vast") cat '${entry}' ;;\n  "run --rm --network none --entrypoint cat img:old /usr/local/bin/colloq-vast") echo '#!/usr/bin/env bash' ;;\n  *) exit 1 ;;\nesac\n`)
    const reader = shellFunction(read('deploy/vast/colloq-host'), 'tunnel_protocol_of')
    const protocolOf = (img: string) => spawnSync('bash', ['-c', `set -euo pipefail\n${reader}printf '[%s]' "$(tunnel_protocol_of ${img})"`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` } })
    assert.equal(protocolOf('img:new').stdout, `[${TUNNEL_PROTOCOL}]`)
    // An image from before classes, and one that cannot be read: no protocol.
    assert.equal(protocolOf('img:old').stdout, '[]')
    assert.equal(protocolOf('img:gone').stdout, '[]')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the agent finds its own container on the host\'s network, where its hostname is the host\'s', () => {
  const rig = entrypointRig()
  try {
    // Under --network host Docker gives the container the host's name, and no container is called that.
    write(path.join(rig.dir, 'bin', 'hostname'), '#!/bin/sh\necho vast-host-17\n')
    const id = 'c0ffee'.padEnd(64, '0')
    const mountinfo = path.join(rig.dir, 'mountinfo')
    fs.writeFileSync(mountinfo, [
      '1001 999 0:52 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC',
      `1012 1001 254:1 /var/lib/docker/containers/${id}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw`,
      `1013 1001 254:1 /var/lib/docker/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw`,
      '',
    ].join('\n'))
    const start = (env: Record<string, string>, mounts = mountinfo) => rig.run(RUNNER_FUNCTIONS,
      `APP='${rig.dir}'; RUNNER_STATE=/var/lib/colloq-runner; VERSION=0.25.0; SELF=""; MOUNTINFO='${mounts}'\nrunner\n`,
      { FAKE_MOUNTS: '/var/lib/colloq-runner\\t/var/lib/colloq-runner\\n', FAKE_IMAGE: SERVER('0.25.0'), COLLOQ_CONTAINER: '', ...env })
    // The panel's plain docker run: by the id Docker's own mounts name.
    let r = start({ FAKE_SELF: id })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.env.COLLOQ_RUNNER_CONTAINER, id)
    assert.equal(r.env.COLLOQ_CONTAINER, id, 'the server\'s own code finds the container by it too (perimeter.ts · helperImage)')
    assert.equal(r.env.COLLOQ_RUNNER_IMAGE, SERVER('0.25.0'))
    // colloq-host names it: that name.
    r = start({ FAKE_SELF: 'colloq-runner', COLLOQ_CONTAINER: 'colloq-runner' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.env.COLLOQ_RUNNER_CONTAINER, 'colloq-runner')
    // Another runtime, no such mounts: the hostname, as before host networking.
    const bare = path.join(rig.dir, 'mountinfo-bare')
    fs.writeFileSync(bare, '1001 999 0:52 / / rw,relatime - overlay overlay rw\n')
    r = start({ FAKE_SELF: 'vast-host-17' }, bare)
    assert.equal(r.status, 0, r.out)
    assert.equal(r.env.COLLOQ_RUNNER_CONTAINER, 'vast-host-17')
    // Found by none: refused in words.
    r = start({ FAKE_SELF: 'someone-else' }, bare)
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /cannot inspect this container as "vast-host-17"\. Start it without --hostname, or set COLLOQ_CONTAINER=<its name>\./)
  } finally { rig.done() }
})

test('runners-down answers for its machines: one with classes is asked to leave again with --force, the code of colloq-host\'s refusal', () => {
  const fleet = read('scripts/vast-runner.sh')
  const holds = /^LEAVE_HOLDS_CLASSES=(\d+)$/m.exec(fleet)?.[1]
  assert.equal(holds, /^LEAVE_HOLDS_CLASSES=(\d+)$/m.exec(read('deploy/vast/colloq-host'))?.[1], 'the code colloq-host exits with')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-down-'))
  try {
    const calls = path.join(dir, 'calls')
    const down = (plain: number, forced: number) => {
      fs.rmSync(calls, { force: true })
      const script = [
        'set -euo pipefail',
        `LEAVE_HOLDS_CLASSES=${holds}`,
        `say() { printf '%s\\n' "$*"; }`,
        `ssh_to() { shift 2; printf 'ssh %s\\n' "$*" >> '${calls}'; case "$*" in *--force) return ${forced} ;; *) return ${plain} ;; esac; }`,
        `api() { printf 'api %s\\n' "$*" >> '${calls}'; }`,
        shellFunction(fleet, 'down_one'),
        'down_one 11 198.51.100.11 40011 running',
      ].join('\n')
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: r.status, out: r.stdout + r.stderr, calls: fs.readFileSync(calls, 'utf8') }
    }
    // Classes on it: the second leave says yes, and the machine is destroyed having left.
    let r = down(Number(holds), 0)
    assert.equal(r.status, 0, r.out)
    assert.equal(r.calls, 'ssh colloq-host runner leave\nssh colloq-host runner leave --force\napi DELETE instances/11/\n')
    assert.match(r.out, /its classes move off it \(their variables are lost\), and it leaves/)
    assert.doesNotMatch(r.out, /did not leave/)
    // None: one leave, as before.
    r = down(0, 0)
    assert.equal(r.status, 0, r.out)
    assert.equal(r.calls, 'ssh colloq-host runner leave\napi DELETE instances/11/\n')
    // Any other refusal is no question to answer: destroyed all the same, and said so.
    r = down(1, 0)
    assert.equal(r.status, 1, r.out)
    assert.equal(r.calls, 'ssh colloq-host runner leave\napi DELETE instances/11/\n')
    assert.match(r.out, /it did not leave its home \(above\)/)
    r = down(Number(holds), 1)
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /it did not leave its home \(above\)/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the classes a leave or an update asks about are this tree\'s agent\'s, by the label images.ts gives it', () => {
  // colloq-host's label for a tree is the agent's own for it: images.ts reads DATA_DIR, which the test env makes <root>/data.
  const tree = path.dirname(dataDir)
  const label = spawnSync('bash', ['-c', `set -euo pipefail\nRUNNER_STATE='${tree}'\n${shellFunction(read('deploy/vast/colloq-host'), 'instance_label')}instance_label`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(label.stdout, INSTANCE_LABEL, label.stderr)
  assert.equal(instanceOf(tree), INSTANCE_LABEL, 'and so are the class kernels made up below')
  // Another agent's classes on this Docker (a second tree's): this machine's update and leave are no question about them.
  const m = machine({ registry: { [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1), [SERVER('0.26.0')]: tunnelRelease('sha256:r26', '0.26.0', 2) } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    m.setState((s) => { s.containers['colloq-class-0f0f0f-c9-room'] = classKernel(path.join(m.dir, 'another-tree'), 'c9', 'room') })
    let r = m.run(['runner', 'update', '0.26.0'], { FAKE_HOME_VERSION: '0.25.0' })
    assert.equal(r.status, 0, r.out)
    assert.equal(m.state().containers['colloq-runner']!.image, SERVER('0.26.0'))
    r = m.run(['runner', 'leave'])
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /class\(es\)/)
    assert.equal(m.state().containers['colloq-class-0f0f0f-c9-room']!.running, true, 'nobody stops another agent\'s class')
  } finally { m.done() }
})

test('the first update from 0.24 leaves the agent on Docker\'s bridge: status says so, the next update moves it, and the fleet runs that one at once', () => {
  // What the colloq-host of 0.24 leaves once it has updated a machine to 0.25 (its run_runner, its fingerprint)
  // and installed this one at its end.
  const m = machine({ registry: { [SERVER('0.25.0')]: tunnelRelease('sha256:r25', '0.25.0', 1) } })
  try {
    assert.equal(m.run(['runner', 'up', 'https://vsos.colloq.ru', CODE], { FAKE_HOME_VERSION: '0.25.0' }).status, 0)
    const sorted = m.runnerEnv().split('\n').filter(Boolean).sort().map((line) => `${line}\n`).join('')
    m.setState((s) => {
      const c = s.containers['colloq-runner']!
      c.flags = c.flags.filter((flag, i, all) => flag !== '--network' && all[i - 1] !== '--network')
      c.labels['colloq.config'] = createHash('sha256').update(`${SERVER('0.25.0')}\nsha256:r25\n${sorted}state ${m.tree}\n`).digest('hex').slice(0, 16)
      s.agent = { joined: true, tunnel: null, classes: { room: 0, own: 0, council: 0 } }
    })
    let r = m.run(['runner', 'status'])
    assert.equal(r.status, 0, r.out)
    assert.equal(r.stdout, '{"joined":true,"tunnel":null,"classes":{"room":0,"own":0,"council":0}}\n', 'stdout stays the agent\'s line alone')
    assert.match(r.out, /WARNING: colloq-runner runs on Docker's network \(bridge\), not the host's, as a colloq-host from before 0\.25 starts it: it takes submissions, and no classes until colloq-host runner update moves it onto the host's network/)
    // An agent from before classes is told nothing of them.
    m.setState((s) => { s.agent = { joined: true } })
    assert.doesNotMatch(m.run(['runner', 'status']).out, /not the host's/)
    r = m.run(['runner', 'update'], { FAKE_HOME_VERSION: '0.25.0' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /colloq-runner runs ghcr\.io\/colloq-edu\/colloq-server:0\.25\.0 already, but not with these settings: it is replaced the same way/)
    const c = m.state().containers['colloq-runner']!
    assert.equal(c.flags[c.flags.indexOf('--network') + 1], 'host')
  } finally { m.done() }
  const fleet = read('scripts/vast-runner.sh')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-twice-'))
  try {
    // The survey reads the agent's network, and an agent that could hold classes off the host's network is no
    // `current`, whatever its build; one from before classes holds none anywhere.
    const bin = path.join(dir, 'bin')
    write(path.join(bin, 'colloq-host'), `#!/bin/sh\nprintf '{"joined":true,"state":"active","compatible":true,"syncedAt":%s%s}\\n' "$(date +%s)999" "$FAKE_CLASSES"\n`)
    write(path.join(bin, 'docker'), '#!/bin/sh\ncase "$*" in "inspect -f {{.HostConfig.NetworkMode}} colloq-runner") echo "$FAKE_NETWORK" ;; *) exit 1 ;; esac\n')
    const survey = /\nSURVEY_SCRIPT='([\s\S]*?)'\n/.exec(fleet)![1]!.replaceAll('/etc/colloq/runner.env', path.join(dir, 'runner.env'))
    fs.writeFileSync(path.join(dir, 'runner.env'), `COLLOQ_RUNNER_JOIN=https://vsos.colloq.ru#${CODE}\n`)
    const answers = path.join(dir, 'answers')
    fs.mkdirSync(answers)
    const verdictOn = (network: string, classes = ',"classes":{"room":0,"own":0,"council":0}') => {
      const said = spawnSync('bash', ['-c', survey, 'survey', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `${bin}:${process.env.PATH}`, FAKE_NETWORK: network, FAKE_CLASSES: classes } })
      fs.writeFileSync(path.join(answers, '11'), said.stdout)
      const py = spawnSync('python3', ['-c', /\nFLEET_PY='([\s\S]*?)'\n/.exec(fleet)![1]!], { input: ['11', '198.51.100.11', '40011', 'running', 'colloq-runner'].join('\x1f') + '\n',
        encoding: 'utf8', env: { ...process.env, SURVEY: answers, WANT: '' } })
      assert.equal(py.status, 0, py.stderr)
      return py.stdout.trim().split('\x1f').pop()
    }
    assert.equal(verdictOn('bridge'), 'off_host')
    assert.equal(verdictOn('host'), 'current')
    assert.equal(verdictOn(''), 'current', 'a machine whose Docker did not say')
    assert.equal(verdictOn('bridge', ''), 'current', 'an agent from before classes')
    // What update_one asks on the machine after an update: the network of an agent that could hold classes, and only of one.
    const networkScript = /\nNETWORK_SCRIPT='([\s\S]*?)'\n/.exec(fleet)![1]!
    const askedOf = (classes: string) => spawnSync('bash', ['-c', networkScript], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `${bin}:${process.env.PATH}`, FAKE_NETWORK: 'bridge', FAKE_CLASSES: classes } }).stdout
    assert.equal(askedOf(',"classes":{"room":0,"own":0,"council":0}'), 'bridge\n')
    assert.equal(askedOf(''), '')
    // The update of one machine: once more when it leaves the agent off the host's network, and only once more.
    const calls = path.join(dir, 'calls')
    const update = (networks: string[]) => {
      fs.rmSync(calls, { force: true })
      fs.writeFileSync(path.join(dir, 'networks'), networks.map((n) => `${n}\n`).join(''))
      fs.writeFileSync(path.join(dir, 'asked'), '0')
      const script = [
        'set -euo pipefail',
        `say() { printf '%s\\n' "$*"; }`,
        // The machine over ssh: an update started, or the network its agent is on (one answer a question).
        `ssh_to() { shift 2; printf 'ssh %s\\n' "$*" >> '${calls}'; grep -q 'colloq-runner-fleet: the network of its agent' || return 0; local i; i=$(( $(cat '${dir}/asked') + 1 )); echo "$i" > '${dir}/asked'; sed -n "\${i}p" '${dir}/networks'; }`,
        `follow_update() { printf 'followed\\n' >> '${calls}'; }`,
        'NOW_FLAG=""; UPDATE_START="(the start)"',
        `NETWORK_SCRIPT='${networkScript}'`,
        shellFunction(fleet, 'agent_network'),
        shellFunction(fleet, 'update_one'),
        'update_one 11 198.51.100.11 40011 running colloq-runner https://vsos.colloq.ru off_host',
      ].join('\n')
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: r.status, out: r.stdout + r.stderr, starts: fs.readFileSync(calls, 'utf8').split('\n').filter((line) => line === 'ssh bash -s --').length }
    }
    let r = update(['bridge', 'host'])
    assert.equal(r.status, 0, r.out)
    assert.equal(r.starts, 2)
    assert.match(r.out, /its agent runs on Docker's network \(bridge\), not the host's, as the colloq-host of its old release starts it, and takes no classes there: updated once more, by the colloq-host this update brought/)
    for (const network of ['host', '']) {
      r = update([network])
      assert.equal(r.status, 0, r.out)
      assert.equal(r.starts, 1, `${network || 'no answer'}: one update`)
    }
    // Still off it: the colloq-host there could not be replaced (the update's own lines say why), and that is said.
    r = update(['bridge', 'bridge'])
    assert.equal(r.status, 1, r.out)
    assert.equal(r.starts, 2)
    assert.match(r.out, /its agent still runs on Docker's network \(bridge\): the colloq-host there is still one from before 0\.25/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
