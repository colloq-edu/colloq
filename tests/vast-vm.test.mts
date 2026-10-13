/**
 * scripts/vast-vm.sh, the search half: what it asks Vast for, and which offer
 * it then goes to rent.
 *
 * The script runs for real (bash, python3) against a stand-in `curl` that
 * answers the offer search from a list and answers the rent with nothing, so
 * the run stops exactly where money would be spent: no request leaves the
 * machine, no ssh, and the settings come from a .env of the test's own
 * (ENV_FILE, which scripts/lib.sh honours), never from the developer's.
 *
 * What is held here:
 *
 *   1. a plain `make vast-vm` asks what it asked before GPUS= and GPU_RAM=
 *      existed, with the disk and the price cap from .env;
 *   2. DISK= and MAX_PRICE= on the command line win over .env, and GPUS= and
 *      GPU_RAM= become num_gpus and gpu_ram, the latter in megabytes as
 *      GB × 1000 (a "24 GB" card reports 24564 MB);
 *   3. OFFER= is asked for by its number, so an offer past the first page of
 *      the market is found. On 13 Oct 2026 no answer held more than 64
 *      offers, whatever the limit, and an "id" condition gave none at all;
 *      ask_contract_id, the same number, gave exactly the one;
 *   4. a value that is not a number stops the script in words, before any
 *      request;
 *   5. an offer refused only for its Max CUDA is refused in words that name
 *      that floor. Since 13 Oct 2026 the floor is 13.0 (base-gpu's torch 2.14.1
 *      is built for CUDA 13.0), and the message listed every condition but
 *      that one: a 2 × 4090 offer at CUDA 12.8 was "not matching" GPU, cards,
 *      memory, price and disk it all passed, while the README said 12.1.
 */
import './_cli.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts/vast-vm.sh')

/** VM offers, cheapest first, the way the API answers; the third lies past the stand-in's first page. */
const OFFERS = [101, 102, 103].map((id, i) => ({
  id, ask_contract_id: id, num_gpus: i + 1, gpu_name: 'RTX 4090', gpu_ram: 24564, cuda_max_good: 13.0,
  dph_total: 0.3 + i / 10, cpu_cores_effective: 32, cpu_ram: 64000, geolocation: 'EE',
}))

/*
 * The stand-in curl. Every call is logged as JSON. The search answers like
 * the API in the two respects that matter here: a broad query gets only the
 * first FAKE_PAGE offers, an ask_contract_id gets that offer alone (or none).
 * The rent gets an empty object, and the script stops on "did not say what it
 * rented" before anything else.
 */
const FAKE_CURL = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1] }
const call = { method: at('-X') ?? 'GET', url: args[args.length - 1], body: at('-d') }
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify(call) + '\\n')
if (call.method === 'POST' && call.url.endsWith('/bundles/')) {
  const asked = JSON.parse(call.body).ask_contract_id
  const offers = JSON.parse(process.env.FAKE_OFFERS)
  const page = asked ? offers.filter((o) => o.ask_contract_id === asked.eq) : offers.slice(0, Number(process.env.FAKE_PAGE))
  process.stdout.write(JSON.stringify({ offers: page, truncated: false }))
} else process.stdout.write('{}')
`

type Call = { method: string; url: string; body: string | null }

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-vast-vm-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 })
  const key = path.join(dir, 'id_test')
  fs.writeFileSync(key, 'not a key\n', { mode: 0o600 })
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile, `VAST_TOKEN=test-token\nVAST_SSH_KEY=${key}\nVAST_DISK=70\nVAST_MAX_PRICE=0.9\n`)
  const onstart = path.join(dir, 'onstart.sh')
  fs.writeFileSync(onstart, 'export COLLOQ_IMAGE="ghcr.io/colloq-edu/colloq-vast:0.21.0"\nexport COLLOQ_HOSTNAME=""\n')
  const log = path.join(dir, 'curl.log')
  const run = (vars: Record<string, string> = {}) => {
    fs.rmSync(log, { force: true })
    // stdin from /dev/null: on macOS node's pipes are sockets, and bash on a
    // socket takes itself for an rsh session and reads ~/.bashrc. The
    // environment is built, not inherited: a DISK or GPU in the developer's
    // shell must not leak into the search.
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ENV_FILE: envFile, ONSTART: onstart, FORCE: '1',
        FAKE_CURL_LOG: log, FAKE_OFFERS: JSON.stringify(OFFERS), FAKE_PAGE: '2', ...vars },
    })
    const calls: Call[] = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
    const search = calls.find((c) => c.url.endsWith('/bundles/'))
    const rent = calls.find((c) => c.method === 'PUT')
    return {
      status: r.status,
      out: (r.stdout ?? '') + (r.stderr ?? ''),
      calls,
      query: search ? JSON.parse(search.body!) : null,
      rent: rent ? { url: rent.url, body: JSON.parse(rent.body!) } : null,
    }
  }
  return { run, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a plain make vast-vm asks what it asked before, with the disk and the price cap from .env', () => {
  const m = rig()
  try {
    const r = m.run()
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /vast did not say what it rented/)
    assert.deepEqual(r.query.num_gpus, { gte: 1 })
    assert.deepEqual(r.query.disk_space, { gte: 80 })
    assert.deepEqual(r.query.dph_total, { lte: 0.9 })
    assert.equal(r.query.limit, 60)
    for (const key of ['gpu_ram', 'ask_contract_id', 'gpu_name', 'cpu_cores_effective', 'cpu_ram']) {
      assert.equal(r.query[key], undefined, `${key} was not asked for`)
    }
    // The cheapest suitable offer is the one it goes to rent, with .env's disk.
    assert.match(r.rent!.url, /\/asks\/101\/$/)
    assert.equal(r.rent!.body.disk, 70)
    assert.equal(r.rent!.body.vm, true)
  } finally { m.done() }
})

test('DISK= and MAX_PRICE= win over .env, GPUS= and GPU_RAM= ask for the cards', () => {
  const m = rig()
  try {
    const r = m.run({ DISK: '100', MAX_PRICE: '1.5', GPUS: '2', GPU_RAM: '24' })
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(r.query.disk_space, { gte: 110 })
    assert.deepEqual(r.query.dph_total, { lte: 1.5 })
    assert.deepEqual(r.query.num_gpus, { gte: 2 })
    // GB × 1000, not × 1024: a 4090 reports 24564 MB and must pass 24.
    assert.deepEqual(r.query.gpu_ram, { gte: 24000 })
    assert.equal(r.rent!.body.disk, 100)
  } finally { m.done() }
})

test('OFFER= is asked for by its number and found past the first page of the market', () => {
  const m = rig()
  try {
    // 103 is not among the two offers a broad search returns here, as an
    // offer past the 64th was not in September.
    let r = m.run({ OFFER: '103' })
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(r.query.ask_contract_id, { eq: 103 })
    assert.equal(r.query.id, undefined, 'an "id" condition makes the API answer with nothing')
    // The filters stay: OFFER does not lift the price cap or the disk.
    assert.deepEqual(r.query.dph_total, { lte: 0.9 })
    assert.deepEqual(r.query.disk_space, { gte: 80 })
    assert.match(r.rent!.url, /\/asks\/103\/$/)
    // An offer the filters (or the market) do not have is named, and nothing is rented.
    r = m.run({ OFFER: '999' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /no VM offer matches: GPU "any", offer 999,/)
    assert.equal(r.rent, null)
  } finally { m.done() }
})

test('a value that is not a number stops the script in words, before any request', () => {
  const m = rig()
  try {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ DISK: 'lots' }, /DISK= \(VAST_DISK in \.env\) is a size in GB, not "lots"/],
      [{ MAX_PRICE: '1$' }, /MAX_PRICE= \(VAST_MAX_PRICE in \.env\) is dollars per hour/],
      [{ GPUS: 'two' }, /GPUS= is a whole number of cards, 1 or more/],
      [{ GPUS: '0' }, /GPUS= is a whole number of cards, 1 or more/],
      [{ GPU_RAM: '24GB' }, /GPU_RAM= is one card's memory in GB, not "24GB"/],
      [{ OFFER: '51006376x' }, /OFFER= is an offer number from the list/],
    ]
    for (const [vars, said] of cases) {
      const r = m.run(vars)
      assert.equal(r.status, 1, r.out)
      assert.match(r.out, said)
      assert.deepEqual(r.calls, [], `${JSON.stringify(vars)} reached the API`)
    }
  } finally { m.done() }
})

test('an offer refused for its Max CUDA alone is refused in words that name the floor', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8')
  const floor = /cuda_max_good"\) or 0\) >= (\d+\.\d+)/.exec(script)?.[1]
  assert.ok(floor, 'the Max CUDA filter is gone from the answer stage')
  const m = rig()
  try {
    // Two 24 GB cards, under the price cap, with the disk: everything the
    // message names passes. Only the host's driver is too old for base-gpu.
    const old = { ...OFFERS[1], id: 104, ask_contract_id: 104, cuda_max_good: 12.8 }
    const r = m.run({ OFFER: '104', GPUS: '2', GPU_RAM: '24', FAKE_OFFERS: JSON.stringify([...OFFERS, old]) })
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(r.query.ask_contract_id, { eq: 104 }, 'the offer was asked for, and the API answered with it')
    assert.equal(r.rent, null)
    assert.match(r.out, new RegExp(`no VM offer matches: GPU "any", offer 104, from 2 cards, from 24 GB per card, .*, Max CUDA from ${floor.replace('.', '\\.')}\\.`))
  } finally { m.done() }
  // The README tells the same floor, and why.
  const readme = fs.readFileSync(path.join(ROOT, 'deploy/vast/README.md'), 'utf8')
  assert.match(readme, new RegExp(`\\*Max CUDA\\* \\(at least ${floor.replace('.', '\\.')}\\)`), 'deploy/vast/README.md names another Max CUDA than the script rents by')
  assert.doesNotMatch(readme, /\b12\.1\b/, 'deploy/vast/README.md still names the old 12.1 floor')
})
