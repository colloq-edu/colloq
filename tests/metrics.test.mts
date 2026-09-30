/**
 * GET /metrics: Prometheus text format, behind METRICS_TOKEN.
 *
 * A bank's platform team scrapes it with a ServiceMonitor and writes alerts
 * on it, so three things are checked as they will meet them: the door (off
 * without the token, 401 without the right Bearer credential), the format
 * (HELP and TYPE per family, names Prometheus accepts, counters that only
 * grow), and the labels (a fixed set of values: a room id or a name in a
 * label would be a new series per class, and personal data in someone
 * else's monitoring).
 */
import './_env.mts'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { SUBMISSION_STATES } from '../shared/competitions.js'
import { app } from '../server/src/app.js'
import { config } from '../server/src/config.js'
import { createSession, db, upsertParticipant } from '../server/src/db.js'
import { signToken } from '../server/src/auth.js'
import { tally } from '../server/src/log.js'
import { COLLOQ_VERSION } from '../server/src/version.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { parseInboundPolicy, useInboundPolicy } from '../server/src/net/inbound.js'
import { takeSnapshot } from '../server/src/db-snapshots.js'
import { countResponses, exposition } from '../server/src/ops/metrics.js'
import {
  counterValues,
  countKernelStart,
  countOracleRequest,
  refusalReason,
  type RefusalReason,
} from '../server/src/ops/counters.js'

const TOKEN = 'metrics-token-for-tests-0123456789abcdef'

let base = ''
let server: http.Server

before(async () => {
  fs.mkdirSync(config.workspaceDir, { recursive: true })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

afterEach(() => {
  delete process.env.METRICS_TOKEN
  useInboundPolicy(null)
})

/** null sends no Authorization header at all. */
function scrape(authorization: string | null = `Bearer ${TOKEN}`): Promise<Response> {
  return fetch(`${base}/metrics`, { headers: authorization === null ? {} : { authorization } })
}

/* ------------------------------------------------------------- the parser */

interface Family {
  help?: string
  type?: string
  samples: { labels: Record<string, string>; value: number }[]
}

/**
 * The text format read strictly, the way Prometheus reads it: HELP, then
 * TYPE, then the family's samples, never interleaved with another family,
 * and a newline at the end.
 */
function parse(text: string): Map<string, Family> {
  assert.ok(text.endsWith('\n'), 'the exposition must end with a newline')
  const families = new Map<string, Family>()
  let current: string | null = null
  for (const line of text.slice(0, -1).split('\n')) {
    const help = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/.exec(line)
    if (help) {
      assert.ok(!families.has(help[1]), `a second HELP for ${help[1]}`)
      families.set(help[1], { help: help[2], samples: [] })
      current = help[1]
      continue
    }
    const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge)$/.exec(line)
    if (type) {
      assert.equal(type[1], current, `TYPE ${type[1]} does not follow its HELP`)
      const family = families.get(type[1])!
      assert.equal(family.type, undefined, `a second TYPE for ${type[1]}`)
      family.type = type[2]
      continue
    }
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line)
    assert.ok(sample, `not a sample line: ${JSON.stringify(line)}`)
    assert.equal(sample[1], current, `${sample[1]} outside its family's block`)
    const family = families.get(sample[1])!
    assert.ok(family.type, `${sample[1]} before its TYPE`)
    const labels: Record<string, string> = {}
    if (sample[2] !== undefined) {
      const pairs = [...sample[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)]
      assert.equal(pairs.map((pair) => pair[0]).join(','), sample[2], `malformed labels: ${line}`)
      for (const [, name, value] of pairs) {
        assert.ok(!(name in labels), `label ${name} twice: ${line}`)
        labels[name] = value.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
      }
    }
    const value = sample[3] === '+Inf' ? Infinity : sample[3] === '-Inf' ? -Infinity : Number(sample[3])
    assert.ok(sample[3] === 'NaN' || !Number.isNaN(value), `not a number: ${line}`)
    family.samples.push({ labels, value })
  }
  return families
}

async function read(): Promise<Map<string, Family>> {
  const res = await scrape()
  assert.equal(res.status, 200)
  return parse(await res.text())
}

function value(families: Map<string, Family>, name: string, labels: Record<string, string> = {}): number {
  const family = families.get(name)
  assert.ok(family, `no ${name}`)
  const found = family.samples.filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
  assert.equal(found.length, 1, `${name}${JSON.stringify(labels)} matches ${found.length} samples`)
  return found[0].value
}

const seriesCount = (families: Map<string, Family>) =>
  [...families.values()].reduce((sum, family) => sum + family.samples.length, 0)

/* ------------------------------------------------------------------ door */

test('without METRICS_TOKEN the address is a plain 404, token or not, and never the page', async () => {
  for (const unset of [undefined, '', '   ']) {
    if (unset === undefined) delete process.env.METRICS_TOKEN
    else process.env.METRICS_TOKEN = unset
    for (const authorization of [null, 'Bearer anything', `Bearer ${unset ?? ''}`]) {
      const res = await scrape(authorization)
      assert.equal(res.status, 404, `METRICS_TOKEN=${JSON.stringify(unset)} with ${authorization}`)
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/)
      const body = await res.text()
      assert.doesNotMatch(body, /colloq_|<html/i)
    }
  }
})

test('a wrong, missing or differently spelled credential is 401; the right Bearer token opens it', async () => {
  // A Secret written with `echo` carries a newline; the token is read trimmed.
  process.env.METRICS_TOKEN = `${TOKEN}\n`
  const wrong = [
    null,
    'Bearer',
    'Bearer ',
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`,
    `Bearer ${TOKEN.toUpperCase()}`,
    `Basic ${Buffer.from(`prometheus:${TOKEN}`).toString('base64')}`,
    TOKEN,
    `Token ${TOKEN}`,
  ]
  for (const authorization of wrong) {
    const res = await scrape(authorization)
    assert.equal(res.status, 401, `accepted: ${authorization}`)
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer realm=/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.doesNotMatch(await res.text(), /colloq_/)
  }
  assert.equal((await scrape(`Bearer ${TOKEN}`)).status, 200)
  // The scheme is case-insensitive (RFC 7235), the token is not.
  assert.equal((await scrape(`bearer ${TOKEN}`)).status, 200)
})

/* ---------------------------------------------------------------- format */

const EXPECTED = [
  'process_cpu_user_seconds_total',
  'process_cpu_system_seconds_total',
  'process_cpu_seconds_total',
  'process_resident_memory_bytes',
  'nodejs_heap_size_used_bytes',
  'nodejs_heap_size_total_bytes',
  'process_start_time_seconds',
  'colloq_uptime_seconds',
  'colloq_build_info',
  'colloq_rooms_open',
  'colloq_participants_online',
  'colloq_sync_frames_total',
  'colloq_sync_frames_refused_total',
  'colloq_kernels',
  'colloq_kernel_starts_total',
  'colloq_kernel_start_failures_total',
  'colloq_cell_runs_queued',
  'colloq_cell_runs_running',
  'colloq_notebook_save_failures_total',
  'colloq_notebooks_unsaved',
  'colloq_notebook_oldest_unsaved_seconds',
  'colloq_oracle_requests_total',
  'colloq_oracle_failures_total',
  'colloq_competition_queue_waiting',
  'colloq_competition_queue_running',
  'colloq_competition_queue_oldest_wait_seconds',
  'colloq_competition_submissions',
  'colloq_competition_attempts_started_total',
  'colloq_competition_attempts_completed_total',
  'colloq_competition_attempt_retries_total',
  'colloq_competition_cleanup_failures_total',
  'colloq_http_requests_total',
  'colloq_rate_limited_total',
  'colloq_http_client_aborts_total',
  'colloq_disk_free_bytes',
  'colloq_disk_size_bytes',
  'colloq_db_snapshot_interval_seconds',
  'colloq_db_snapshots',
  'colloq_db_snapshot_failures_total',
]

test('the exposition is the 0.0.4 text format: HELP and TYPE per family, then its samples', async () => {
  process.env.METRICS_TOKEN = TOKEN
  const res = await scrape()
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const families = parse(await res.text())
  for (const name of EXPECTED) assert.ok(families.has(name), `missing ${name}`)
  for (const [name, family] of families) {
    assert.ok(family.help && family.help.length >= 10, `${name} has no real HELP`)
    assert.ok(family.type, `${name} has no TYPE`)
    assert.ok(family.samples.length > 0, `${name} is printed without samples`)
    if (family.type === 'counter') {
      assert.match(name, /_total$/, `counter ${name} does not end in _total`)
      for (const sample of family.samples) assert.ok(sample.value >= 0, `${name} is negative`)
    } else {
      assert.doesNotMatch(name, /_total$/, `gauge ${name} is named like a counter`)
    }
    for (const sample of family.samples) assert.ok(Number.isFinite(sample.value), `${name} = ${sample.value}`)
  }
  assert.equal(value(families, 'colloq_build_info', { version: COLLOQ_VERSION }), 1)
  assert.ok(value(families, 'process_resident_memory_bytes') > 1_000_000)
  assert.ok(Math.abs(value(families, 'process_start_time_seconds') - (Date.now() / 1000 - process.uptime())) < 5)
  // Both volumes, even when they share a filesystem (they do here).
  assert.ok(value(families, 'colloq_disk_free_bytes', { volume: 'data' }) > 0)
  assert.ok(value(families, 'colloq_disk_size_bytes', { volume: 'workspace' }) > 0)
  // Every kernel role and state is a series from the start, so an alert on
  // one has something to evaluate before the first kernel ever dies.
  assert.equal(families.get('colloq_kernels')!.samples.length, 8)
  assert.equal(value(families, 'colloq_kernels', { backend: 'test', role: 'own', state: 'dead' }), 0)
  assert.equal(families.get('colloq_competition_submissions')!.samples.length, SUBMISSION_STATES.length)
  assert.equal(value(families, 'colloq_db_snapshot_interval_seconds'), 0, 'snapshots are off unless DB_SNAPSHOT_HOURS is set')
})

test('the event loop is measured from the first scrape on, in seconds beyond the due time', async () => {
  process.env.METRICS_TOKEN = TOKEN
  await read()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const families = await read()
  const p50 = value(families, 'colloq_event_loop_lag_p50_seconds')
  const p99 = value(families, 'colloq_event_loop_lag_p99_seconds')
  const max = value(families, 'colloq_event_loop_lag_max_seconds')
  assert.ok(p50 >= 0 && p50 <= p99 && p99 <= max, `${p50} ${p99} ${max}`)
  // An idle test process: well under the 20 ms resolution the monitor adds.
  assert.ok(p50 < 0.02, `p50 ${p50}`)
})

test('exposition() escapes labels and help, spells NaN and infinities, and leaves out an empty family', () => {
  const text = exposition([
    { name: 'a_total', type: 'counter', help: 'back\\slash\nnewline', samples: [{ labels: { l: 'q"uote\\back\nline' }, value: 1 }] },
    { name: 'b', type: 'gauge', help: 'nothing measured', samples: [] },
    { name: 'c', type: 'gauge', help: 'odd numbers', samples: [{ value: NaN }, { labels: { s: 'up' }, value: Infinity }, { labels: { s: 'down' }, value: -Infinity }] },
  ])
  assert.equal(
    text,
    '# HELP a_total back\\\\slash\\nnewline\n# TYPE a_total counter\na_total{l="q\\"uote\\\\back\\nline"} 1\n' +
      '# HELP c odd numbers\n# TYPE c gauge\nc NaN\nc{s="up"} +Inf\nc{s="down"} -Inf\n',
  )
  assert.equal(exposition([]), '')
})

/* ---------------------------------------------------------------- counts */

test('HTTP answers are counted by status class', async () => {
  process.env.METRICS_TOKEN = TOKEN
  const before = await read()
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/api/no-such-route-${i}`)).status, 404)
  const later = await read()
  const delta = (status: string) =>
    value(later, 'colloq_http_requests_total', { status_class: status }) - value(before, 'colloq_http_requests_total', { status_class: status })
  assert.equal(delta('4xx'), 2)
  // The first scrape itself, counted once its answer went out.
  assert.ok(delta('2xx') >= 1)
  assert.equal(delta('5xx'), 0)
})

test("429s are counted by the limit that refused: the room's two and the Oracle's, end to end", async () => {
  process.env.METRICS_TOKEN = TOKEN
  const before = await read()
  const join = (room: string, i: number, address: string) =>
    fetch(`${base}/api/sessions/${room}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify({ name: `Гость ${i}` }),
    })

  // Sixty newcomers per address per room, then 429: the address limit.
  createSession('metrics-join-address', 'Адрес', null)
  for (let i = 0; i < 60; i++) assert.equal((await join('metrics-join-address', i, '203.0.113.50')).status, 200)
  assert.equal((await join('metrics-join-address', 60, '203.0.113.50')).status, 429)

  // Behind an address the operator named as shared, only the room's own
  // ceiling is left, and it is the one that refuses.
  useInboundPolicy(parseInboundPolicy({ SHARED_ADDRESSES: '198.51.100.0/24' }))
  createSession('metrics-join-room', 'Комната', null)
  for (let i = 0; i < 600; i++) assert.equal((await join('metrics-join-room', i, '198.51.100.9')).status, 200, `join ${i}`)
  assert.equal((await join('metrics-join-room', 600, '198.51.100.9')).status, 429)
  useInboundPolicy(null)

  // The Oracle: a token minted this second asks too early.
  updateOracleSettings({ apiKey: 'test-key', model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', questionsPerHour: 20, slowModeSeconds: 0 })
  createSession('metrics-oracle', 'Оракул', null)
  upsertParticipant({ id: 'p_metrics', sessionId: 'metrics-oracle', name: 'p_metrics', avatar: null, role: 'participant' })
  const ask = await fetch(`${base}/api/sessions/metrics-oracle/ai/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${signToken({ sessionId: 'metrics-oracle', participantId: 'p_metrics', role: 'participant' })}`,
    },
    body: JSON.stringify({ message: 'что такое DataFrame?' }),
  })
  assert.equal(ask.status, 429)

  const later = await read()
  const delta = (reason: RefusalReason) =>
    value(later, 'colloq_rate_limited_total', { reason }) - value(before, 'colloq_rate_limited_total', { reason })
  assert.equal(delta('join_address'), 1)
  assert.equal(delta('join_room'), 1)
  assert.equal(delta('oracle'), 1)
  assert.equal(delta('competitions'), 0)
  assert.equal(delta('other'), 0)
})

test('a 429 without a note is classified by its address, and a note wins over the address', () => {
  const finish = (url: string, status: number, reason?: RefusalReason) => {
    const res = Object.assign(new EventEmitter(), { statusCode: status, locals: {} as Record<string, unknown> })
    if (reason) refusalReason(res, reason)
    countResponses({ originalUrl: url, url } as never, res as never, () => {})
    res.emit('finish')
  }
  const before = counterValues()
  finish('/api/k/competitions/titanic/submissions?x=1', 429)
  finish('/api/sessions/r1/council/c1/oracle', 429)
  finish('/api/sessions/r1/ai/ask', 429)
  finish('/api/admin/whatever', 429)
  finish('/api/sessions/r1/join', 429, 'join_room')
  finish('/api/sessions/r1/ai/ask', 503)
  const later = counterValues()
  const delta = (reason: RefusalReason) => later.rateLimited[reason] - before.rateLimited[reason]
  assert.equal(delta('competitions'), 1)
  assert.equal(delta('oracle'), 2)
  assert.equal(delta('other'), 1)
  assert.equal(delta('join_room'), 1)
  assert.equal(later.httpResponses['4xx'] - before.httpResponses['4xx'], 5)
  assert.equal(later.httpResponses['5xx'] - before.httpResponses['5xx'], 1)
})

test('kernel starts, Oracle requests and the tallies reach the page as counters', async () => {
  process.env.METRICS_TOKEN = TOKEN
  const before = await read()
  countKernelStart('own', false)
  countKernelStart('room', true)
  countKernelStart('room', true)
  countOracleRequest()
  tally('oracle')
  tally('frames', 5)
  tally('gate', 2)
  const later = await read()
  const delta = (name: string, labels: Record<string, string> = {}) => value(later, name, labels) - value(before, name, labels)
  assert.equal(delta('colloq_kernel_start_failures_total', { backend: 'test', role: 'own' }), 1)
  assert.equal(delta('colloq_kernel_start_failures_total', { backend: 'test', role: 'room' }), 0)
  assert.equal(delta('colloq_kernel_starts_total', { backend: 'test', role: 'room' }), 2)
  assert.equal(delta('colloq_oracle_requests_total'), 1)
  assert.equal(delta('colloq_oracle_failures_total'), 1)
  assert.equal(delta('colloq_sync_frames_total'), 5)
  assert.equal(delta('colloq_sync_frames_refused_total'), 2)
})

/* ---------------------------------------------------------------- labels */

/** Every label the page may carry, with every value it may take. */
const LABELS: Record<string, Record<string, readonly string[] | RegExp>> = {
  colloq_build_info: { version: /^\d+\.\d+\.\d+/ },
  colloq_kernels: { backend: ['broker', 'docker', 'test', 'unknown'], role: ['room', 'own'], state: ['idle', 'busy', 'starting', 'dead'] },
  colloq_kernel_starts_total: { backend: ['broker', 'docker', 'test', 'unknown'], role: ['room', 'own'] },
  colloq_kernel_start_failures_total: { backend: ['broker', 'docker', 'test', 'unknown'], role: ['room', 'own'] },
  colloq_competition_submissions: { state: [...SUBMISSION_STATES, 'other'] },
  colloq_http_requests_total: { status_class: ['1xx', '2xx', '3xx', '4xx', '5xx'] },
  colloq_rate_limited_total: { reason: ['join_room', 'join_address', 'oracle', 'competitions', 'other'] },
  colloq_disk_free_bytes: { volume: ['data', 'workspace'] },
  colloq_disk_size_bytes: { volume: ['data', 'workspace'] },
}

test('labels come from fixed sets: rooms, people and addresses never reach the page, and classes add no series', async () => {
  process.env.METRICS_TOKEN = TOKEN
  const before = await read()
  for (let i = 0; i < 25; i++) {
    const room = `metrics-private-room-${i}`
    createSession(room, `Секретный семинар ${i}`, null)
    const res = await fetch(`${base}/api/sessions/${room}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${100 + i}` },
      body: JSON.stringify({ name: `Студентка Иванова ${i}` }),
    })
    assert.equal(res.status, 200)
  }
  const res = await scrape()
  const text = await res.text()
  assert.doesNotMatch(text, /metrics-private-room|Секретный|Иванова|203\.0\.113|="p_/)
  const later = parse(text)
  assert.equal(seriesCount(later), seriesCount(before), 'twenty-five rooms changed the number of series')
  for (const [name, family] of later) {
    const allowed = LABELS[name] ?? {}
    for (const sample of family.samples) {
      for (const [label, got] of Object.entries(sample.labels)) {
        const rule = allowed[label]
        assert.ok(rule, `${name} carries an unexpected label ${label}`)
        assert.ok(rule instanceof RegExp ? rule.test(got) : rule.includes(got), `${name}{${label}="${got}"}`)
      }
    }
  }
  assert.ok(seriesCount(later) < 120, `${seriesCount(later)} series`)
})

/* ------------------------------------------------------------- snapshots */

test('the newest database snapshot reaches /metrics and /api/instance/operations, without a path', async () => {
  process.env.METRICS_TOKEN = TOKEN
  const taken = await takeSnapshot(db, config.dataDir, { keep: 7 })
  assert.ok(taken.ok, JSON.stringify(taken))
  const families = await read()
  assert.equal(value(families, 'colloq_db_snapshots'), 1)
  assert.ok(Math.abs(value(families, 'colloq_db_snapshot_last_timestamp_seconds') - Date.now() / 1000) < 5)
  assert.equal(value(families, 'colloq_db_snapshot_last_size_bytes'), taken.bytes)
  assert.ok(value(families, 'colloq_db_snapshot_last_duration_seconds') >= 0)
  assert.equal(value(families, 'colloq_db_snapshot_failures_total'), 0)

  let cookie = ''
  issueStaffCookie(
    { cookie: (name: string, v: string) => (cookie = `${name}=${v}`) } as never,
    createTeacher({ name: 'Metrics', email: 'metrics@test.local', role: 'owner' })!,
  )
  const operations = await (await fetch(`${base}/api/instance/operations`, { headers: { cookie } })).json()
  assert.equal(operations.snapshots.count, 1)
  assert.equal(operations.snapshots.last.name, taken.name)
  assert.equal(operations.snapshots.last.kind, 'periodic')
  assert.equal(operations.snapshots.last.bytes, taken.bytes)
  assert.equal(operations.snapshots.everyHours, 0)
  assert.equal(operations.snapshots.keep, 7)
  assert.equal(operations.snapshots.running, false)
  assert.ok(!JSON.stringify(operations.snapshots).includes(config.dataDir), 'a path in the operations answer')
})
