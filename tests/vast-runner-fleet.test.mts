/**
 * Machines for submissions as a fleet on Vast, and the GPU kernels they run
 * (docs/architecture/remote-runners.md, phase P7): scripts/vast-vm.sh with
 * ROLE=runner, scripts/vast-runner.sh (make vast-runner, runners-update,
 * runners-down), make runner-dev, and scripts/kernel-publish.sh (make
 * kernel-publish, the release-time step of RELEASING.md).
 *
 * The scripts run for real (bash, python3) against a made-up Vast (a `curl`
 * that answers the API from a JSON file, renting and destroying in it) and a
 * made-up `ssh` that answers for colloq-host on the VMs: no request leaves the
 * machine and nothing is rented. kernel-publish runs with a stand-in docker and
 * git; the Makefile is asked with `make -n`, which prints and runs nothing.
 *
 * What is held here:
 *
 *   1. a machine is rented as a VM labelled colloq-runner, with an on-start
 *      that carries the home and the code and no relay token, and is ready when
 *      `colloq-host runner status` says it has joined, never by /api/health;
 *   2. COUNT copies rent one after another, so no two go for the same offer,
 *      and one refused for an offer that vanished searches again;
 *   3. the fleet commands touch the colloq-runner instances and nothing else,
 *      say each machine's home, and with URL= touch that home's alone; down
 *      leaves before it destroys, and says so when a machine could not; an
 *      update runs detached on the machine and is polled, and leaves alone a
 *      machine already on its home's build; a machine rented that never
 *      joined is named with its destroy command, or destroyed;
 *   4. the GPU kernels are published parents first, each checked on a card
 *      before its push, under the very tag the entry point pulls;
 *   5. everything a value can break is refused in words before any request.
 */
import './_cli.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const VM = path.join(ROOT, 'scripts/vast-vm.sh')
const RUNNER = path.join(ROOT, 'scripts/vast-runner.sh')
const PUBLISH = path.join(ROOT, 'scripts/kernel-publish.sh')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const CODE = '0123456789abcdef0123456789abcdef'
const HOME = 'https://vsos.colloq.ru'

/** VM offers, cheapest first, the way the API answers. */
const OFFERS = [101, 102, 103].map((id, i) => ({
  id, ask_contract_id: id, num_gpus: 2, gpu_name: 'RTX 4090', gpu_ram: 24564, cuda_max_good: 13.0,
  dph_total: 0.5 + i / 10, cpu_cores_effective: 32, cpu_ram: 64000, geolocation: 'EE',
}))

/*
 * The made-up Vast. A search lists the offers nobody has rented, except that
 * with `lag` the first search after a rent still lists the offer just taken,
 * as the market did for a few seconds after a rent. A rent of a taken offer is
 * refused the way Vast refuses one; a rent of a free one makes an instance,
 * which answers with a running VM and its own ssh port. Every call goes to
 * the shared log, the state file is rewritten whole by a rename.
 */
const FAKE_CURL = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1] }
const call = { tool: 'curl', method: at('-X') ?? 'GET', url: args[args.length - 1], body: at('-d') }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(call) + '\\n')
const file = process.env.FAKE_VAST
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => { const tmp = file + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, file) }
const out = (o) => process.stdout.write(JSON.stringify(o))
const where = call.url.replace(/^https:\\/\\/console\\.vast\\.ai\\/api\\/v0\\//, '')
let m
if (call.method === 'POST' && where === 'bundles/') {
  let offers = st.offers.filter((o) => !st.rented.includes(o.id))
  if (st.lag && st.lastRented) { offers = [st.offers.find((o) => o.id === st.lastRented), ...offers]; st.lag = false; save() }
  out({ offers })
} else if (call.method === 'PUT' && (m = /^asks\\/(\\d+)\\/$/.exec(where))) {
  const id = Number(m[1]); const body = JSON.parse(call.body)
  st.rents.push({ offer: id, body })
  if (st.rented.includes(id)) { save(); out({ success: false, error: 'no_such_ask', msg: 'Instance type by id ' + id + ' is not available.' }) }
  else { st.rented.push(id); st.lastRented = id; const contract = 900 + st.rented.length; save(); out({ success: true, new_contract: contract }) }
} else if (call.method === 'GET' && (m = /^instances\\/(\\d+)\\/$/.exec(where))) {
  const id = Number(m[1])
  out({ instances: { id, actual_status: 'running', cur_state: 'running', status_msg: '', public_ipaddr: '198.51.100.' + (id % 250),
    ports: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: String(40000 + id) }] } } })
} else if (call.method === 'GET' && where === 'instances/') {
  out({ instances: st.listed })
} else if (call.method === 'DELETE' && (m = /^instances\\/(\\d+)\\/$/.exec(where))) {
  st.destroyed.push(Number(m[1])); save(); out({ success: true })
} else out({})
`

/*
 * The made-up ssh: colloq-host on VMs that have joined their homes. The
 * on-start a copy uploads is kept, and so is every script sent to `bash -s`.
 * A host in FAKE_SSH_FAIL fails whatever it is asked. What each machine says
 * lives in FAKE_MACHINES, a JSON file by host: its home and its agent's status
 * line for the survey, `unjoined` for one whose agent never joins, and `polls`,
 * the answers its detached update gives one poll after another (`running`,
 * `drop` for a poll whose connection drops, `gone`, or `exit <code>`; the last
 * one repeats). How far each machine's polls have got is a file of its own:
 * the machines are polled at once, and one file rewritten by each would lose
 * the other's count.
 */
const FAKE_SSH = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
let i = 0, port = ''
while (i < args.length) {
  const a = args[i]
  if (a === '-o' || a === '-i') { i += 2; continue }
  if (a === '-p') { port = args[i + 1]; i += 2; continue }
  if (a.startsWith('-')) { i++; continue }
  break
}
const host = (args[i] || '').replace(/^root@/, ''); const command = args.slice(i + 1).join(' ')
const input = command.includes('cat > /etc/colloq/onstart.sh') || command.startsWith('bash -s') ? fs.readFileSync(0, 'utf8') : ''
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'ssh', host, port, command, input }) + '\\n')
if ((process.env.FAKE_SSH_FAIL || '').split(',').includes(host)) { process.stderr.write('[colloq-host] ERROR: the agent did not answer\\n'); process.exit(1) }
const file = process.env.FAKE_MACHINES
const m = (file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {})[host] || {}
const out = (s) => process.stdout.write(s)
if (command.startsWith('systemctl is-system-running')) out('running\\n')
else if (input.includes('colloq-runner-fleet: survey')) out('home ' + (m.home || '') + '\\nstatus ' + (m.status || '') + '\\n')
else if (input.includes('colloq-runner-fleet: start the update')) out('colloq-host runner update' + (command.slice('bash -s --'.length) ? ' ' + command.slice('bash -s --'.length).trim() : '') + ' runs detached on this machine\\n')
else if (input.includes('colloq-runner-fleet: poll the update')) {
  const steps = m.polls || ['exit 0']
  const counter = file + '.polled.' + host
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0
  const step = steps[Math.min(n, steps.length - 1)]
  fs.writeFileSync(counter, String(n + 1))
  if (step === 'drop') { process.stderr.write('Connection to ' + host + ' closed by remote host.\\n'); process.exit(255) }
  if (step === 'running') out('[colloq-host] draining colloq-runner\\n\\x1f' + (n + 1) + ' running\\n')
  else if (step === 'gone') out('\\x1f' + n + ' gone\\n')
  else out('[colloq-host] colloq-runner has joined its home\\n\\x1f' + (n + 1) + ' ' + step + '\\n')
}
else if (command.includes('colloq-host runner status')) {
  if (m.unjoined) process.exit(1)
  if (!command.includes('>/dev/null')) out('{"joined":true}\\n')
}
else if (command.includes('colloq-host runner leave')) out('[colloq-host] left: the home no longer counts on this machine\\n')
process.exit(0)
`

type Call = { tool: 'curl' | 'ssh'; method?: string; url?: string; body?: string | null; host?: string; port?: string; command?: string; input?: string }
type Vast = { offers: typeof OFFERS; rented: number[]; rents: { offer: number; body: Record<string, unknown> }[]; listed: unknown[]; destroyed: number[]; lag: boolean; lastRented?: number }

function write(file: string, text: string, mode = 0o755): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode })
}

type Machine = { home?: string; status?: string; unjoined?: boolean; polls?: string[] }

/**
 * A laptop with .env, a key, the made-up Vast and ssh, all in a temporary
 * directory. `fast` puts a `sleep` in front that takes a hundredth of a
 * second, for scripts that wait minutes on a real VM.
 */
function rig(vast: Partial<Vast> = {}, machines: Record<string, Machine> = {}, opts: { fast?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-fleet-'))
  const bin = path.join(dir, 'bin')
  write(path.join(bin, 'curl'), FAKE_CURL)
  write(path.join(bin, 'ssh'), FAKE_SSH)
  if (opts.fast) write(path.join(bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.01\n')
  const machinesFile = path.join(dir, 'machines.json')
  fs.writeFileSync(machinesFile, JSON.stringify(machines))
  const key = path.join(dir, 'id_test')
  fs.writeFileSync(key, 'not a key\n', { mode: 0o600 })
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile, `VAST_TOKEN=test-token\nVAST_SSH_KEY=${key}\nVAST_MAX_PRICE=0.9\n`)
  const state = path.join(dir, 'vast.json')
  fs.writeFileSync(state, JSON.stringify({ offers: OFFERS, rented: [], rents: [], listed: [], destroyed: [], lag: false, ...vast }))
  const log = path.join(dir, 'calls.log')
  const logs = path.join(dir, 'logs')
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    fs.rmSync(log, { force: true })
    // stdin from /dev/null: on macOS node's pipes are sockets, and bash on a
    // socket takes itself for an rsh session and reads ~/.bashrc. Nothing of
    // this process's environment but PATH: a GPU or a NAME in the developer's
    // shell must not leak into the rental.
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ENV_FILE: envFile, FAKE_VAST: state, FAKE_LOG: log, FAKE_MACHINES: machinesFile,
        RUNNER_LOGS: logs, RENT_RETRY_SEC: '0', RUNNER_POLL_SEC: '0', ...env },
    })
    const calls: Call[] = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls }
  }
  return {
    dir, envFile, logs, run,
    vast: (): Vast => JSON.parse(fs.readFileSync(state, 'utf8')),
    // From the log, which every process appends to whole: the state file is
    // rewritten by whichever of two parallel destroys renames last.
    destroyed: (calls: Call[]): number[] => calls.filter((c) => c.method === 'DELETE')
      .map((c) => Number(/\/instances\/(\d+)\/$/.exec(c.url!)![1])).sort((a, b) => a - b),
    filledOnstart: () => {
      const file = path.join(dir, 'onstart-runner.sh')
      fs.writeFileSync(file, read('deploy/vast/onstart-runner.sh')
        .replace(/^export COLLOQ_RUNNER_URL="[^"]*"/m, `export COLLOQ_RUNNER_URL="${HOME}"`)
        .replace(/^export COLLOQ_RUNNER_CODE="[^"]*"/m, `export COLLOQ_RUNNER_CODE="${CODE}"`))
      return file
    },
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

// ------------------------------------------------- scripts/vast-vm.sh ROLE

test('vast-vm.sh with ROLE=runner rents a VM labelled colloq-runner and waits for colloq-host runner status', () => {
  const m = rig()
  try {
    const onstart = m.filledOnstart()
    const r = m.run(VM, [], { ROLE: 'runner', ONSTART: onstart, FORCE: '1', DISK: '150' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /VM offer 101.*: 2 x RTX 4090, \$0\.500\/hr, a machine for https:\/\/vsos\.colloq\.ru/)
    const rent = m.vast().rents[0]!
    assert.equal(rent.body.label, 'colloq-runner')
    assert.equal(rent.body.vm, true)
    assert.equal(rent.body.disk, 150)
    assert.equal(rent.body.onstart, fs.readFileSync(onstart, 'utf8'))
    const ssh = r.calls.filter((c) => c.tool === 'ssh')
    // Vast does not run a VM's on-start: it is uploaded and started over ssh, as for an instance.
    assert.equal(ssh.find((c) => c.command!.includes('cat > /etc/colloq/onstart.sh'))!.input, fs.readFileSync(onstart, 'utf8'))
    assert.ok(ssh.some((c) => c.command === 'colloq-host runner status'), ssh.map((c) => c.command).join('\n'))
    assert.ok(!ssh.some((c) => c.command!.includes('/api/health')), 'a machine has no /api/health to wait for')
    assert.match(r.out, /on the VM: colloq-host runner status \| logs \| leave/)
    // NAME= labels a batch of its own.
    const named = rig()
    try {
      assert.equal(named.run(VM, [], { ROLE: 'runner', ONSTART: named.filledOnstart(), FORCE: '1', NAME: 'gpu' }).status, 0)
      assert.equal(named.vast().rents[0]!.body.label, 'colloq-runner-gpu')
    } finally { named.done() }
  } finally { m.done() }
})

test('vast-vm.sh with ROLE=runner refuses an unfilled on-start, a class address and an unknown role, before any request', () => {
  const m = rig()
  try {
    const template = path.join(ROOT, 'deploy/vast/onstart-runner.sh')
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ROLE: 'runner', ONSTART: template }, /COLLOQ_RUNNER_URL and COLLOQ_RUNNER_CODE in .* are not filled in/],
      [{ ROLE: 'runner', ONSTART: m.filledOnstart(), HOST: 'vsos' }, /HOST= names a class address, and a machine for submissions has none/],
      [{ ROLE: 'home', ONSTART: m.filledOnstart() }, /ROLE= is app or runner, not "home"/],
    ]
    for (const [env, said] of cases) {
      const r = m.run(VM, [], { FORCE: '1', ...env })
      assert.equal(r.status, 1, r.out)
      assert.match(r.out, said)
      assert.deepEqual(r.calls, [], `${JSON.stringify(env)} reached the API`)
    }
  } finally { m.done() }
})

// ------------------------------------------------ scripts/vast-runner.sh up

test('vast-runner up rents COUNT machines one after another, and one refused for a vanished offer searches again', () => {
  const m = rig({ lag: true })
  try {
    const r = m.run(RUNNER, ['up'], { COUNT: '2', CODE, URL: `${HOME}/`, FORCE: '1', GPU: 'RTX 4090', GPUS: '2' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /2 of 2 joined https:\/\/vsos\.colloq\.ru/)
    const vast = m.vast()
    // The second copy first went for the offer the first had just taken, was refused, and took the next.
    assert.deepEqual(vast.rents.map((x) => x.offer), [101, 101, 102])
    assert.deepEqual(vast.rented, [101, 102])
    assert.match(r.out, /\[2\].*the offer was gone; searching again in 0 s \(try 2 of 3\)/)
    for (const rent of vast.rents) {
      assert.equal(rent.body.label, 'colloq-runner')
      assert.equal(rent.body.vm, true)
      assert.equal(rent.body.disk, 120, 'a machine with cards gets the GPU floor by default')
      const onstart = String(rent.body.onstart)
      assert.match(onstart, new RegExp(`^export COLLOQ_RUNNER_URL="${HOME.replace(/[.]/g, '\\.')}"`, 'm'))
      assert.match(onstart, new RegExp(`^export COLLOQ_RUNNER_CODE="${CODE}"`, 'm'))
      assert.ok(!onstart.includes('RELAY_TOKEN'), 'no relay token in a machine\'s on-start')
    }
    // One after another: no search starts before the rent before it has its instance.
    const calls = r.calls.filter((c) => c.tool === 'curl')
    const searches = calls.map((c, i) => (c.url!.endsWith('/bundles/') ? i : -1)).filter((i) => i >= 0)
    const rents = calls.map((c, i) => (c.method === 'PUT' ? i : -1)).filter((i) => i >= 0)
    assert.equal(searches.length, 3)
    assert.ok(rents[0]! < searches[1]! && rents[1]! < searches[2]!, calls.map((c) => `${c.method} ${c.url}`).join('\n'))
    // Each search asked for the filters given once, for every machine.
    for (const c of calls.filter((c) => c.url!.endsWith('/bundles/'))) {
      const q = JSON.parse(c.body!)
      assert.deepEqual(q.gpu_name, { in: ['RTX 4090'] })
      assert.deepEqual(q.num_gpus, { gte: 2 })
      assert.deepEqual(q.dph_total, { lte: 0.9 })
      assert.equal(q.ask_contract_id, undefined, 'no copy rents an offer named for all of them')
    }
    // Both machines were waited for by colloq-host runner status, on their own VMs.
    const status = r.calls.filter((c) => c.tool === 'ssh' && c.command === 'colloq-host runner status').map((c) => c.host).sort()
    assert.deepEqual(status, ['198.51.100.151', '198.51.100.152'])
    // A log per machine, the last try's.
    assert.match(fs.readFileSync(path.join(m.logs, 'runner-2.log'), 'utf8'), /instance 902 \(label colloq-runner\)/)
    assert.ok(!fs.readFileSync(path.join(m.logs, 'runner-1.log'), 'utf8').includes(CODE), 'the code stays out of the logs')
  } finally { m.done() }
})

test('vast-runner up refuses in words before any request: the count, the code, the home, the disk, the terminal', () => {
  const m = rig()
  try {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ COUNT: '0' }, /COUNT= is how many machines to rent, 1 to 16, not "0"/],
      [{ COUNT: '17' }, /COUNT= is how many machines to rent, 1 to 16/],
      [{ COUNT: 'two' }, /COUNT= is how many machines to rent/],
      [{ CODE: '' }, /CODE= is the enrollment code from the home's owner/],
      [{ CODE: 'abc' }, /CODE= is not an enrollment code: 32 hex digits/],
      [{ URL: '' }, /URL= names the home these machines join/],
      [{ URL: 'https://vsos.colloq.ru/admin' }, /URL=https:\/\/vsos\.colloq\.ru\/admin is not a home's address/],
      [{ URL: 'vsos.colloq.ru' }, /URL=vsos\.colloq\.ru: the home's address starts with https:\/\//],
      [{ DISK: 'lots' }, /DISK= is a size in GB, not "lots"/],
      [{ MAX_PRICE: '1$' }, /MAX_PRICE= \(VAST_MAX_PRICE in \.env\) is dollars per hour/],
      // NAME becomes a label and a pattern the copies' logs are read with.
      [{ NAME: 'gpu.*' }, /NAME= is a short word \(lowercase letters, digits, hyphens\), not "gpu\.\*"/],
      // No FORCE, and no terminal to ask in: nothing is rented.
      [{ FORCE: '' }, /no terminal to ask in\. FORCE=1 rents without asking\./],
    ]
    for (const [env, said] of cases) {
      const r = m.run(RUNNER, ['up'], { COUNT: '2', CODE, URL: HOME, FORCE: '1', ...env })
      assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.out}`)
      assert.match(r.out, said)
      assert.deepEqual(r.calls, [], `${JSON.stringify(env)} reached the API`)
    }
    // The usual home can live in .env.
    fs.appendFileSync(m.envFile, `VAST_RUNNER_URL=${HOME}\n`)
    const r = m.run(RUNNER, ['up'], { COUNT: '1', CODE, FORCE: '1' })
    assert.equal(r.status, 0, r.out)
    assert.match(String(m.vast().rents[0]!.body.onstart), /^export COLLOQ_RUNNER_URL="https:\/\/vsos\.colloq\.ru"/m)
  } finally { m.done() }
})

test('vast-runner up names each machine rented but never joined with its destroy command, and DESTROY_UNJOINED=1 destroys it', () => {
  // Machine 2 (instance 902) boots and its ssh lets us in, but its agent never joins.
  const m = rig({}, { '198.51.100.152': { unjoined: true } }, { fast: true })
  try {
    const r = m.run(RUNNER, ['up'], { COUNT: '2', CODE, URL: HOME, FORCE: '1' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /1 {2}instance 901 {2}joined/)
    assert.match(r.out, /2 {2}instance 902 {2}\S*rented, not joined/)
    assert.match(r.out, /rented but not joined, these bill by the hour until destroyed:\S*\n {2}vastai destroy instance 902\n/)
    assert.match(r.out, /DESTROY_UNJOINED=1 on make vast-runner destroys such machines at the end of the run/)
    assert.deepEqual(m.destroyed(r.calls), [], 'nothing is destroyed unasked')
  } finally { m.done() }
  const d = rig({}, { '198.51.100.152': { unjoined: true } }, { fast: true })
  try {
    const r = d.run(RUNNER, ['up'], { COUNT: '2', CODE, URL: HOME, FORCE: '1', DESTROY_UNJOINED: '1' })
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(d.destroyed(r.calls), [902], 'the joined machine stays')
    assert.match(r.out, /instance 902 destroyed \(DESTROY_UNJOINED=1\): it no longer bills/)
    assert.match(r.out, /1 of 2 joined https:\/\/vsos\.colloq\.ru/)
  } finally { d.done() }
  // A machine its copy destroyed already (ssh never let it in) is said to be gone, and not destroyed twice.
  const broken = rig({}, {}, { fast: true })
  try {
    const r = broken.run(RUNNER, ['up'], { COUNT: '2', CODE, URL: HOME, FORCE: '1', DESTROY_UNJOINED: '1', FAKE_SSH_FAIL: '198.51.100.152' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /2 {2}instance 902 {2}\S*not joined, and destroyed already/)
    assert.deepEqual(broken.destroyed(r.calls), [902], 'destroyed once, by the copy that rented it')
  } finally { broken.done() }
})

// ------------------------------------------- scripts/vast-runner.sh fleet

const vm = (id: number, label: string, running = true) => ({
  id, label, actual_status: running ? 'running' : 'exited', gpu_name: 'RTX 4090', num_gpus: 2,
  public_ipaddr: running ? `198.51.100.${id}` : '', ports: running ? { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: String(40000 + id) }] } : {},
})
const LISTED = [vm(11, 'colloq-runner'), vm(12, 'colloq-runner-gpu'), vm(13, 'colloq-vm'), vm(14, 'colloq'), vm(15, 'colloq-runnerx')]

// What an agent says in its status (the fields the fleet reads: joined, and
// compatible from its last sync, else version against homeVersion).
const OUTDATED = '{"joined":true,"compatible":false,"version":"0.24.0","homeVersion":"0.25.0"}'
const CURRENT = '{"joined":true,"compatible":true,"version":"0.24.0","homeVersion":"0.24.1"}'
const LAB = 'https://lab.example.org'

/** The updates a run started, host:port and the remote command, sorted. */
const starts = (calls: Call[]) => calls.filter((c) => c.tool === 'ssh' && c.input?.includes('colloq-runner-fleet: start the update'))
  .map((c) => `${c.host}:${c.port} ${c.command}`).sort()

test('runners-update starts colloq-host runner update detached on every colloq-runner machine, polls it, and touches nothing else', () => {
  const m = rig({ listed: LISTED }, { '198.51.100.11': { home: HOME, status: OUTDATED }, '198.51.100.12': { home: HOME, status: OUTDATED } })
  try {
    let r = m.run(RUNNER, ['update'], { VERSION: '0.25.0', NOW: '1' })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(starts(r.calls), ['198.51.100.11:40011 bash -s -- 0.25.0 --now', '198.51.100.12:40012 bash -s -- 0.25.0 --now'])
    // Detached, so that a dropped ssh cannot kill it halfway; then polled until it ends.
    const start = r.calls.find((c) => c.input?.includes('colloq-runner-fleet: start the update'))!
    assert.match(start.input!, /^setsid nohup bash -c '.*colloq-host runner update "\$@" > "\$0\/log" 2>&1; echo "\$\?" > "\$0\/exit"' "\$d" "\$@" < \/dev\/null > \/dev\/null 2>&1 &$/m)
    assert.ok(r.calls.some((c) => c.host === '198.51.100.11' && c.input?.includes('colloq-runner-fleet: poll the update')))
    assert.ok(!r.calls.some((c) => c.tool === 'ssh' && ['13', '14', '15'].some((n) => c.host === `198.51.100.${n}`)), 'no other instance of the account is touched')
    // Each machine's home, asked over ssh before anything, is in the list.
    assert.match(r.out, /instance 11 {2}colloq-runner {2}running {2}198\.51\.100\.11:40011 {2}home https:\/\/vsos\.colloq\.ru {2}\(outdated\)/)
    assert.match(r.out, /\[11\].*colloq-runner has joined its home/)
    assert.match(r.out, /every machine is on 0\.25\.0/)
    // Without a version: each machine asks its own home.
    r = m.run(RUNNER, ['update'])
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(starts(r.calls), ['198.51.100.11:40011 bash -s --', '198.51.100.12:40012 bash -s --'])
    assert.match(r.out, /to the version of their home, their runs finished first/)
    // NAME= takes one batch.
    r = m.run(RUNNER, ['update'], { NAME: 'gpu' })
    assert.deepEqual(starts(r.calls), ['198.51.100.12:40012 bash -s --'])
    // A machine that fails is named, and the run fails.
    r = m.run(RUNNER, ['update'], { FAKE_SSH_FAIL: '198.51.100.12' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /\[12\].*the agent did not answer/)
    assert.match(r.out, /some machines did not update/)
    // A version that would be more than a word on the remote command line never gets there.
    r = m.run(RUNNER, ['update'], { VERSION: '0.25.0; reboot' })
    assert.equal(r.status, 1)
    assert.match(r.out, /VERSION= is a version \(0\.24\.0\) or an image, not "0\.25\.0; reboot"/)
    assert.deepEqual(r.calls, [])
  } finally { m.done() }
})

test('runners-update takes the machines of URL= alone, leaves those already on their home\'s build unless FORCE=1, and moves no two homes to one version', () => {
  const m = rig({ listed: [vm(11, 'colloq-runner'), vm(12, 'colloq-runner'), vm(16, 'colloq-runner'), vm(17, 'colloq-runner', false)] }, {
    '198.51.100.11': { home: HOME, status: OUTDATED },
    '198.51.100.12': { home: HOME, status: CURRENT },
    '198.51.100.16': { home: LAB, status: OUTDATED },
  })
  try {
    let r = m.run(RUNNER, ['update'], { URL: `${HOME}/` })
    assert.equal(r.status, 0, r.out)
    // The home is read on the machine, up to the # of its join: the code never comes back.
    const survey = r.calls.find((c) => c.input?.includes('colloq-runner-fleet: survey'))!
    assert.ok(survey.input!.includes('/etc/colloq/runner.env') && survey.input!.includes('#.*/\\1/p'), survey.input)
    // Of vsos's machines, only the one not on vsos's build yet; the others of the account are named and left.
    assert.deepEqual(starts(r.calls), ['198.51.100.11:40011 bash -s --'])
    assert.match(r.out, /\[12\].*its runner build is already its home's \(https:\/\/vsos\.colloq\.ru\): left as it is \(FORCE=1 updates it all the same\)/)
    assert.match(r.out, /instance 16 {2}colloq-runner {2}left alone: its home is https:\/\/lab\.example\.org/)
    assert.match(r.out, /instance 17 {2}colloq-runner {2}left alone: its home is not known/)
    // FORCE=1 updates it all the same.
    r = m.run(RUNNER, ['update'], { URL: HOME, FORCE: '1' })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(starts(r.calls), ['198.51.100.11:40011 bash -s --', '198.51.100.12:40012 bash -s --'])
    // One version for the machines of two homes would move some off their own home's: refused before anything starts.
    r = m.run(RUNNER, ['update'], { VERSION: '0.25.0' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /these machines serve 2 homes, and VERSION=0\.25\.0 would move all of them: name one with URL=/)
    assert.deepEqual(starts(r.calls), [])
    // Named, it goes to that home's machines; VERSION= skips none.
    r = m.run(RUNNER, ['update'], { VERSION: '0.25.0', URL: LAB })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(starts(r.calls), ['198.51.100.16:40016 bash -s -- 0.25.0'])
    // A home no machine serves: said, and nothing happens.
    r = m.run(RUNNER, ['update'], { URL: 'https://nobody.example.org' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /no machine serves https:\/\/nobody\.example\.org/)
    assert.deepEqual(starts(r.calls), [])
    r = m.run(RUNNER, ['update'], { URL: 'vsos.colloq.ru' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /URL=vsos\.colloq\.ru: the home's address starts with https:\/\//)
    assert.deepEqual(r.calls, [])
  } finally { m.done() }
})

test('an update outlives a dropped ssh: the polls go on where they were, and a machine that rebooted under its update is said so', () => {
  const m = rig({ listed: [vm(11, 'colloq-runner'), vm(12, 'colloq-runner')] }, {
    '198.51.100.11': { home: HOME, status: OUTDATED, polls: ['running', 'drop', 'running', 'exit 0'] },
    '198.51.100.12': { home: HOME, status: OUTDATED, polls: ['running', 'gone'] },
  })
  try {
    const r = m.run(RUNNER, ['update'])
    assert.equal(r.status, 1, r.out)
    const polls = (host: string) => r.calls.filter((c) => c.host === host && c.input?.includes('colloq-runner-fleet: poll the update')).map((c) => c.command)
    // Each poll asks for the lines past those printed; the dropped one changed nothing.
    assert.deepEqual(polls('198.51.100.11'), ['bash -s -- 0', 'bash -s -- 1', 'bash -s -- 1', 'bash -s -- 3'])
    assert.match(r.out, /\[11\].*no answer over ssh \(poll 1 of 40\); the update goes on on the machine/)
    assert.match(r.out, /\[11\].*colloq-runner has joined its home/)
    assert.match(r.out, /\[12\].*the update stopped without finishing \(the machine rebooted\?\)/)
    assert.match(r.out, /some machines did not update/)
    // One start each: a poll never starts a second update.
    assert.equal(r.calls.filter((c) => c.input?.includes('colloq-runner-fleet: start the update')).length, 2)
  } finally { m.done() }
})

test('runners-down: every machine leaves its home first, then is destroyed; the list names each home, URL= takes one home\'s, NOW=1 destroys at once', () => {
  const homes = { '198.51.100.11': { home: HOME, status: OUTDATED }, '198.51.100.12': { home: LAB, status: OUTDATED } }
  const m = rig({ listed: LISTED }, homes)
  try {
    // No terminal and no FORCE: nothing is destroyed, and nobody leaves.
    let r = m.run(RUNNER, ['down'])
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /no terminal to ask in\. FORCE=1 destroys without asking\./)
    assert.equal(r.calls.filter((c) => c.method === 'DELETE' || c.command === 'colloq-host runner leave').length, 0)
    // What would be destroyed is listed with each machine's home.
    assert.match(r.out, /instance 11 {2}colloq-runner {2}running {2}198\.51\.100\.11:40011 {2}home https:\/\/vsos\.colloq\.ru\n/)
    assert.match(r.out, /instance 12 {2}colloq-runner-gpu {2}running {2}198\.51\.100\.12:40012 {2}home https:\/\/lab\.example\.org\n/)
    r = m.run(RUNNER, ['down'], { FORCE: '1' })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(m.destroyed(r.calls), [11, 12])
    for (const id of [11, 12]) {
      const leave = r.calls.findIndex((c) => c.tool === 'ssh' && c.host === `198.51.100.${id}` && c.command === 'colloq-host runner leave')
      const destroy = r.calls.findIndex((c) => c.method === 'DELETE' && c.url!.endsWith(`/instances/${id}/`))
      assert.ok(leave >= 0 && leave < destroy, `instance ${id}: leave ${leave}, destroy ${destroy}`)
    }
    assert.match(r.out, /done: the fleet is gone/)
  } finally { m.done() }
  const one = rig({ listed: LISTED }, homes)
  try {
    // URL=: vsos's machine leaves and is destroyed; the lab's is named and left.
    const r = one.run(RUNNER, ['down'], { FORCE: '1', URL: HOME })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(one.destroyed(r.calls), [11])
    assert.ok(!r.calls.some((c) => c.command === 'colloq-host runner leave' && c.host === '198.51.100.12'))
    assert.match(r.out, /instance 12 {2}colloq-runner-gpu {2}left alone: its home is https:\/\/lab\.example\.org/)
  } finally { one.done() }
  const now = rig({ listed: LISTED })
  try {
    const r = now.run(RUNNER, ['down'], { FORCE: '1', NOW: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.calls.filter((c) => c.command === 'colloq-host runner leave').length, 0)
    assert.deepEqual(now.destroyed(r.calls), [11, 12])
    assert.match(r.out, /its home still lists it: revoke it there/)
  } finally { now.done() }
  const stuck = rig({ listed: LISTED })
  try {
    // A machine that cannot leave is destroyed all the same (it bills by the hour), and the run says so.
    const r = stuck.run(RUNNER, ['down'], { FORCE: '1', FAKE_SSH_FAIL: '198.51.100.12' })
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(stuck.destroyed(r.calls), [11, 12])
    assert.match(r.out, /\[12\].*it did not leave its home/)
    assert.match(r.out, /not every machine left its home or was destroyed/)
  } finally { stuck.done() }
  const none = rig({ listed: [vm(13, 'colloq-vm'), vm(14, 'colloq')] })
  try {
    const r = none.run(RUNNER, ['down'], { FORCE: '1' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /no machines for submissions are rented/)
    assert.deepEqual(none.destroyed(r.calls), [])
  } finally { none.done() }
})

// ----------------------------------------------------------- the Makefile

function make(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('make', ['--no-print-directory', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH!, HOME: os.homedir(), ...env },
  })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

test('the Makefile hands the fleet targets their variables, and lists them', () => {
  let r = make(['-n', 'vast-runner', 'COUNT=3', `CODE=${CODE}`, `URL=${HOME}`, 'GPU=RTX 4090', 'GPUS=2', 'DISK=150', 'MAX_PRICE=1.5'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`COUNT="3" CODE="${CODE}" URL="https://vsos\\.colloq\\.ru" NAME="" GPU="RTX 4090" GPUS="2"`))
  assert.match(r.out, /DISK="150" MAX_PRICE="1\.5" DESTROY_UNJOINED="" \.\/scripts\/vast-runner\.sh up/)
  r = make(['-n', 'vast-runner', 'COUNT=1', `CODE=${CODE}`, 'DESTROY_UNJOINED=1'])
  assert.match(r.out, /DESTROY_UNJOINED="1" \.\/scripts\/vast-runner\.sh up/)
  r = make(['-n', 'runners-update', 'VERSION=0.25.0', 'NOW=1'])
  assert.match(r.out, /NAME="" URL="" VERSION="0\.25\.0" NOW="1" FORCE="" \.\/scripts\/vast-runner\.sh update/)
  r = make(['-n', 'runners-update', `URL=${HOME}`, 'FORCE=1'])
  assert.match(r.out, /NAME="" URL="https:\/\/vsos\.colloq\.ru" VERSION="" NOW="" FORCE="1" \.\/scripts\/vast-runner\.sh update/)
  r = make(['-n', 'runners-down', 'NOW=1', 'FORCE=1', `URL=${HOME}`])
  assert.match(r.out, /NAME="" URL="https:\/\/vsos\.colloq\.ru" NOW="1" FORCE="1" \.\/scripts\/vast-runner\.sh down/)
  const help = make(['help']).out.replace(/\x1b\[[0-9;]*m/g, '')
  for (const target of ['vast-runner', 'runners-update', 'runners-down', 'runner-dev', 'kernel-publish']) {
    assert.match(help, new RegExp(`^ +${target} +\\S`, 'm'), `make help lacks ${target}`)
    assert.match(read('Makefile'), new RegExp(`^\\.PHONY:.*\\b${target}\\b`, 'm'), `${target} is not .PHONY`)
  }
})

test('make runner-dev runs the agent from the sources against a dev home, its tree under .colloq/, and needs a code', () => {
  // RUNNER_DEV_NODE22 pointed nowhere: the node on PATH, as on a machine without Homebrew's node@22.
  let r = make(['-n', 'runner-dev', `CODE=${CODE}`, 'URL=http://localhost:4000', 'RUNNER_DEV_NODE22=/nonexistent/node'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`COLLOQ_RUNNER_JOIN="http://localhost:4000#${CODE}"`))
  assert.match(r.out, /COLLOQ_RUNNER_STATE="\$state" DATA_DIR="\$state\/data" NODE_ENV=development KERNEL_BACKEND=docker COMPETITION_BACKEND=docker/)
  // Never the checkout's own data/: from a checkout that is the home's tree (server/src/data-dir.ts).
  assert.doesNotMatch(r.out, /DATA_DIR="?\$PWD\/data|DATA_DIR=data\b/)
  assert.match(r.out, /mktemp -d "\$PWD\/\.colloq\/runner-dev\.XXXXXX"/)
  // make dev's home has no bundle and reports `dev`, which only the sources match (decision 5).
  assert.match(r.out, /^\s*node --import tsx server\/src\/runner-agent\/main\.ts$/m)
  r = make(['-n', 'runner-dev', `CODE=${CODE}`, 'URL=http://localhost:4000', 'DIST=1', 'RUNNER_DEV_NODE22=/nonexistent/node'])
  assert.match(r.out, /^\s*node server\/dist\/runner\.js$/m)
  // Without a code it stops at once, and starts nothing.
  const before = fs.existsSync(path.join(ROOT, '.colloq')) ? fs.readdirSync(path.join(ROOT, '.colloq')) : []
  r = make(['runner-dev'])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /Specify the code from the home's panel: make runner-dev CODE=<32 hex digits>/)
  const after = fs.existsSync(path.join(ROOT, '.colloq')) ? fs.readdirSync(path.join(ROOT, '.colloq')) : []
  assert.deepEqual(after, before, 'a refused runner-dev left a directory behind')
})

test('make runner-dev joins only a home named on the command line, on node 22, without the compose paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-dev-'))
  try {
    // A node of the test's own, as node@22 and on PATH: should the refusal below ever go, what it starts is this, never an
    // agent that joins the instance this checkout serves.
    const node = path.join(dir, 'node22')
    const dump = path.join(dir, 'dump')
    write(node, `#!/bin/sh\n{ echo "ARGS $*"; env; } > '${dump}'\n`)
    write(path.join(dir, 'bin', 'node'), `#!/bin/sh\nexec '${node}' "$@"\n`)
    const stand = { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` }
    // No default home: the only one there could be is this checkout's own port, the live instance on a machine that serves a class.
    const before = fs.existsSync(path.join(ROOT, '.colloq')) ? fs.readdirSync(path.join(ROOT, '.colloq')) : []
    let r = make(['runner-dev', `CODE=${CODE}`, `RUNNER_DEV_NODE22=${node}`], stand)
    assert.notEqual(r.status, 0)
    assert.match(r.out, /Specify the home: make runner-dev URL=http:\/\/localhost:<port> CODE=…, a dev home of your own on another port than this checkout's server .*never the live instance/)
    assert.doesNotMatch(r.out, /localhost:3000/)
    assert.equal(fs.existsSync(dump), false, 'nothing was started')
    const after = fs.existsSync(path.join(ROOT, '.colloq')) ? fs.readdirSync(path.join(ROOT, '.colloq')) : []
    assert.deepEqual(after, before)
    assert.doesNotMatch(read('Makefile'), /COLLOQ_RUNNER_JOIN="\$\(or \$\(URL\)/, 'no fallback for URL in the join')
    // Homebrew's node@22 when it is there, for the Node the image and CI run.
    assert.match(read('Makefile'), /^RUNNER_DEV_NODE22 := \/opt\/homebrew\/opt\/node@22\/bin\/node$/m)
    r = make(['-n', 'runner-dev', `CODE=${CODE}`, 'URL=http://localhost:4000', `RUNNER_DEV_NODE22=${node}`])
    assert.ok(r.out.includes(`${node} --import tsx server/src/runner-agent/main.ts`), r.out)
    // Run for real with that stand-in node, from a shell that carries make up's compose paths.
    const tree = path.join(dir, 'tree')
    r = make(['runner-dev', `CODE=${CODE}`, 'URL=http://localhost:4000', `STATE=${tree}`, `RUNNER_DEV_NODE22=${node}`],
      { DATA_HOST_DIR: '/compose/data', WORKSPACE_HOST_DIR: '/compose/workspace' })
    assert.equal(r.status, 0, r.out)
    const seen = fs.readFileSync(dump, 'utf8')
    assert.match(seen, /^ARGS --import tsx server\/src\/runner-agent\/main\.ts$/m)
    assert.ok(seen.includes(`\nCOLLOQ_RUNNER_JOIN=http://localhost:4000#${CODE}\n`), seen)
    assert.ok(seen.includes(`\nCOLLOQ_RUNNER_STATE=${tree}\n`) && seen.includes(`\nDATA_DIR=${tree}/data\n`), seen)
    assert.doesNotMatch(seen, /^(DATA_HOST_DIR|WORKSPACE_HOST_DIR)=/m, 'the agent hands the daemon its own paths')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('make kernel-publish takes ENV from the command line only', () => {
  let r = make(['-n', 'kernel-publish', 'ENV=base-gpu,kaggle-gpu'])
  assert.match(r.out, /ENVIRONMENTS="base-gpu,kaggle-gpu" OWNER="" REPO="" \\\n\s+\.\/scripts\/kernel-publish\.sh/)
  // An ENV in the environment is the shell's startup file, not a list of kernels.
  r = make(['-n', 'kernel-publish'], { ENV: '/home/someone/.shrc' })
  assert.match(r.out, /ENVIRONMENTS="base-gpu kaggle-gpu"/)
})

// -------------------------------------------------- scripts/kernel-publish.sh

function publishRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-kernel-publish-'))
  const bin = path.join(dir, 'bin')
  const log = path.join(dir, 'docker.log')
  // A docker whose registry holds only what PUBLISHED names, whose builds
  // write a digest of their own each, and whose runs fail where FAKE_FAIL_RUN says.
  write(path.join(bin, 'docker'), `#!/bin/sh
{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> "$LOG"
case "$1" in
  info) [ -z "$FAKE_NVIDIA" ] || echo "Runtimes: nvidia runc"; exit 0 ;;
  run) if [ -n "$FAKE_FAIL_RUN" ]; then case "$*" in *"$FAKE_FAIL_RUN"*) exit 1 ;; esac; fi; exit 0 ;;
esac
if [ "$1 $2" = "buildx inspect" ]; then exit 1; fi
if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then
  case " $PUBLISHED " in *" $4 "*) echo "sha256:$(printf '%064d' 7)"; exit 0 ;; esac
  exit 1
fi
if [ "$1 $2" = "buildx build" ]; then
  n="$(grep -c '^buildx build' "$LOG")"
  while [ "$#" -gt 0 ]; do [ "$1" = --metadata-file ] && printf '{\\n  "containerimage.digest": "sha256:%064d"\\n}\\n' "$n" > "$2"; shift; done
fi
exit 0
`)
  write(path.join(bin, 'git'), `#!/bin/sh
case "$1" in
  describe) [ -n "$FAKE_TAG" ] || exit 128; echo "$FAKE_TAG" ;;
  diff) exit "\${FAKE_DIRTY:-0}" ;;
  rev-parse) echo c0ffee0000000000000000000000000000000000 ;;
  ls-files) if [ -n "$FAKE_UNTRACKED" ]; then case "$*" in *"$FAKE_UNTRACKED"*) exit 1 ;; esac; fi ;;
esac
exit 0
`)
  const version = JSON.parse(read('package.json')).version as string
  const run = (env: Record<string, string>) => {
    fs.rmSync(log, { force: true })
    const r = spawnSync('bash', [PUBLISH], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, LOG: log, FAKE_TAG: `v${version}`, FAKE_NVIDIA: '1', ...env },
    })
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
    return { status: r.status, out: r.stdout + r.stderr, calls }
  }
  return { version, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('kernel-publish builds the GPU kernels parents first, checks each on a card, and pushes it under the release tag', () => {
  const p = publishRig()
  try {
    const repo = 'ghcr.io/colloq-edu/colloq-kernel'
    const tag = `v${p.version}`
    const r = p.run({ ENVIRONMENTS: 'base-gpu,kaggle-gpu' })
    assert.equal(r.status, 0, r.out)
    const builds = r.calls.filter((c) => c.startsWith('buildx build'))
    assert.equal(builds.length, 4, r.calls.join('\n'))
    const [gpuLoad, gpuPush, kaggleLoad, kagglePush] = builds
    assert.match(gpuLoad!, /--builder colloq-kernel-publish --platform linux\/amd64 -f kernel\/Dockerfile --build-arg KERNEL_ENV=base-gpu /)
    assert.doesNotMatch(gpuLoad!, /PARENT=/, 'base-gpu is a root on the Dockerfile\'s own python')
    // Loaded for its check under a name of this run's own, never the instance's colloq-kernel:<env>.
    const probe = (load: string, env: string) => {
      const ref = /--provenance=false --load -t (\S+) kernel$/.exec(load)?.[1] ?? ''
      assert.match(ref, new RegExp(`^colloq-kernel-publish:${tag.replace(/[.]/g, '\\.')}-${env}-\\d+$`), load)
      return ref
    }
    const gpuProbe = probe(gpuLoad!, 'base-gpu')
    const kaggleProbe = probe(kaggleLoad!, 'kaggle-gpu')
    assert.ok(!r.calls.some((c) => /colloq-kernel:(base-gpu|kaggle-gpu)\b/.test(c)), 'a name an instance on the builder may move at any moment')
    // The names go when the run ends.
    for (const ref of [gpuProbe, kaggleProbe]) assert.ok(r.calls.includes(`image rm ${ref}`), r.calls.join('\n'))
    assert.match(gpuPush!, new RegExp(`--push --provenance=mode=max --sbom=true --metadata-file \\S+ -t ${repo.replace(/[.]/g, '\\.')}:${tag.replace(/[.]/g, '\\.')}-base-gpu kernel$`))
    // kaggle-gpu stands on the base-gpu just pushed, by its digest (the second build's).
    for (const b of [kaggleLoad!, kagglePush!]) assert.ok(b.includes(`--build-arg PARENT=${repo}@sha256:${'0'.repeat(63)}2`), b)
    assert.ok(kagglePush!.endsWith(`-t ${repo}:${tag}-kaggle-gpu kernel`), kagglePush)
    for (const b of builds) {
      assert.match(b, new RegExp(`--label org\\.opencontainers\\.image\\.version=${p.version.replace(/[.]/g, '\\.')} `))
      assert.match(b, /--label org\.opencontainers\.image\.revision=c0ffee0{34} /)
      assert.match(b, /--label colloq\.environment=(base-gpu|kaggle-gpu) /)
    }
    // Every image runs before its push: the imports, the kaggle check for the kaggle stack, torch on a card.
    const at = (c: string) => r.calls.indexOf(c)
    const runs = r.calls.filter((c) => c.startsWith('run '))
    const gpuRuns = runs.filter((c) => c.includes(` ${gpuProbe} `))
    const kaggleRuns = runs.filter((c) => c.includes(` ${kaggleProbe} `))
    assert.equal(gpuRuns.length, 2)
    assert.equal(kaggleRuns.length, 3)
    for (const c of gpuRuns) assert.ok(at(gpuLoad!) < at(c) && at(c) < at(gpuPush!), c)
    for (const c of kaggleRuns) assert.ok(at(kaggleLoad!) < at(c) && at(c) < at(kagglePush!), c)
    assert.ok(gpuRuns.some((c) => c.includes(`--network none --gpus device=0 ${gpuProbe} python -c`) && c.includes('torch.cuda.is_available()')))
    assert.ok(kaggleRuns.some((c) => c.includes(`scripts/check-kaggle-base.py:/check.py:ro ${kaggleProbe} python /check.py`)))
    assert.match(r.calls.find((c) => c.startsWith('buildx create'))!, /--name colloq-kernel-publish --driver docker-container/)
    // The tag the entry point pulls for this version is the one pushed.
    const lifted = /^kernel_pull_ref\(\) \{\n[\s\S]*?\n\}\n/m.exec(read('deploy/vast/entrypoint.sh'))![0]
    const pull = spawnSync('bash', ['-c', `${lifted}kernel_pull_ref base-gpu 0`], { encoding: 'utf8', env: { PATH: process.env.PATH!, VERSION: p.version } })
    assert.equal(pull.stdout, `${repo}:${tag}-base-gpu`)
  } finally { p.done() }
})

test('kernel-publish takes a published parent as it is, and stops before the push when a check fails', () => {
  const p = publishRig()
  try {
    const repo = 'ghcr.io/colloq-edu/colloq-kernel'
    const tag = `v${p.version}`
    // kaggle-gpu alone brings its parent along; a parent already published is never built again.
    let r = p.run({ ENVIRONMENTS: 'kaggle-gpu', PUBLISHED: `${repo}:${tag}-base-gpu` })
    assert.equal(r.status, 0, r.out)
    const builds = r.calls.filter((c) => c.startsWith('buildx build'))
    assert.equal(builds.filter((b) => b.includes('KERNEL_ENV=base-gpu')).length, 0)
    assert.ok(builds.every((b) => b.includes(`PARENT=${repo}@sha256:${'0'.repeat(63)}7`)), builds.join('\n'))
    assert.match(r.out, /is already published \(sha256:0+7\); not building it again/)
    // torch sees no card: nothing of that image is pushed.
    r = p.run({ ENVIRONMENTS: 'base-gpu', FAKE_FAIL_RUN: 'torch.cuda' })
    assert.notEqual(r.status, 0, r.out)
    assert.equal(r.calls.filter((c) => c.startsWith('buildx build') && c.includes('--push')).length, 0)
    // A fork publishes under its own name.
    r = p.run({ ENVIRONMENTS: 'base-gpu', OWNER: 'A-Fork' })
    assert.equal(r.status, 0, r.out)
    assert.ok(r.calls.some((c) => c.includes(`-t ghcr.io/a-fork/colloq-kernel:${tag}-base-gpu kernel`)))
    assert.ok(r.calls.some((c) => c.includes('--label org.opencontainers.image.source=https://github.com/a-fork/colloq ')))
  } finally { p.done() }
})

test('kernel-publish refuses, before any build, what would put the wrong image under a release tag', () => {
  const p = publishRig()
  try {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ FAKE_TAG: '' }, new RegExp(`HEAD is not the release tag v${p.version.replace(/[.]/g, '\\.')}: check the tag out`)],
      [{ FAKE_DIRTY: '1' }, /kernel\/ has local changes: an image published as v.* is built from the tag itself/],
      [{ FAKE_NVIDIA: '' }, /this builder's Docker has no NVIDIA runtime, so torch cannot be checked on a card before the push/],
      [{ ENVIRONMENTS: 'nope' }, /no kernel\/environments\/nope\.txt/],
      [{ FAKE_UNTRACKED: 'kernel/environments/base-gpu.txt' }, /kernel\/environments\/base-gpu\.txt is not part of v/],
    ]
    for (const [env, said] of cases) {
      const r = p.run({ ENVIRONMENTS: 'base-gpu kaggle-gpu', ...env })
      assert.notEqual(r.status, 0, `${JSON.stringify(env)}: ${r.out}`)
      assert.match(r.out, said)
      assert.equal(r.calls.filter((c) => c.startsWith('buildx build')).length, 0, `${JSON.stringify(env)} built something`)
    }
  } finally { p.done() }
})

// ------------------------------------------------------------- the docs

test('RELEASING.md makes the GPU kernels a step of every release, and publish.yml points there', () => {
  const releasing = read('RELEASING.md')
  // GitHub's anchor for the heading: lowercase, punctuation dropped, spaces to hyphens.
  const heading = /^### (GPU kernels, at release time)$/m.exec(releasing)?.[1]
  assert.ok(heading, 'RELEASING.md has no GPU kernels section')
  const anchor = heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')
  const links = [...releasing.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]).filter((a) => a!.startsWith('gpu-kernels'))
  assert.ok(links.length >= 2, 'the version table and the workflows table should both point at it')
  for (const link of links) assert.equal(link, anchor)
  assert.match(releasing, /make kernel-publish ENV=base-gpu,kaggle-gpu/)
  assert.match(releasing, /14 GB\s+of SSD/)
  // An instance that built its GPU kernels itself keeps them, and pulls the published ones only once the name is free.
  assert.match(releasing, /\*\*An instance that built its GPU kernels itself keeps them\.\*\*/)
  const keep = releasing.indexOf('docker image tag colloq-kernel:base-gpu colloq-kernel:base-gpu-built-here')
  const free = releasing.indexOf('docker image rm colloq-kernel:base-gpu ')
  const pull = releasing.indexOf('colloq-host stop && colloq-host start')
  assert.ok(keep > 0 && keep < free && free < pull, 'keep the old build, free the name, then restart to pull')
  assert.match(releasing, /`colloq-kernel-publish:…`/)
  const publish = read('.github/workflows/publish.yml')
  const comment = publish.slice(0, publish.indexOf('\n  kernels:\n'))
  assert.doesNotMatch(comment, /a GPU\s+#?\s*machine builds it once anyway/)
  assert.match(comment, /`make kernel-publish`/)
  for (const file of ['scripts/vast-runner.sh', 'scripts/kernel-publish.sh', 'scripts/vast-vm.sh']) {
    assert.equal(spawnSync('bash', ['-n', path.join(ROOT, file)]).status, 0, file)
  }
})
