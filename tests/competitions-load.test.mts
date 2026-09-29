/**
 * A class at the deadline: fifteen people behind one NAT send at once.
 *
 * What is checked is what broke on a real class and would break again
 * silently. The upload limiter counted by ADDRESS, and a lecture hall behind
 * one router is one address: the thirteenth notebook in the last minute got
 * "too often". A notebook whose upload began before the deadline lost to the
 * classroom Wi-Fi. A person who fixed a typo could not resend while the first
 * notebook waited. The final board opened at the deadline with half the
 * queue still running. And the queue ran one submission at a time on a
 * machine with room for eight.
 *
 * No docker: the stand-in runner (fake-runner.ts) holds each run for a moment,
 * which is enough to see how many run at once.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import type { EntrantLeaderboard, EntrantSubmissions } from '../shared/competitions-entrant.js'
import {
  createCompetition,
  getSubmission,
  leaveQueue,
  queueRows,
  runningRows,
  setCompetitionState,
  setQueuePaused,
  updateCompetition,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile } from '../server/src/competitions/storage.js'
import { putFile } from '../server/src/competitions/store.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome, type RunRequest } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue, queueSlots, setQueueSlots } from '../server/src/competitions/runner.js'
import { useCompetitionCapabilities } from '../server/src/competitions/capabilities.js'
import { app } from '../server/src/app.js'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { CompetitionSettings } from '../shared/competitions-settings.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'

/** One address for the whole class: the relay in front of a lecture hall. */
const CLASS_ADDRESS = '203.0.113.7'
const SLOTS = 8
const PEOPLE = 15

/** Counts how many notebooks run at the same moment. */
class CountingRunner extends FakeCompetitionRunner {
  active = 0
  peak = 0
  override async run(request: RunRequest): Promise<RunOutcome> {
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    try {
      return await super.run(request)
    } finally {
      this.active -= 1
    }
  }
}

const runner = new CountingRunner()
let base = ''
let port = 0
let server: http.Server
let competitionId = ''

before(async () => {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(SLOTS)
  useCompetitionRunner(runner)
  const made = createCompetition({
    slug: 'load',
    title: 'Load',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 0.5\n' },
    limits: { perDay: 3 },
    privateRelease: 'auto',
  })
  assert.ok(made)
  competitionId = made.id
  ensureCompetition(competitionId)
  const sample = new TextEncoder().encode('id,orders\n1,0\n2,0\n')
  putOpenFile(competitionId, 'sample_submission.csv', sample)
  putFile({ competitionId, name: 'sample_submission.csv', bytes: sample.length, rows: 2, visibility: 'open' })
  const solution = new TextEncoder().encode('id,orders\n1,7\n2,9\n')
  putSecretFile(competitionId, 'solution.csv', solution)
  putFile({ competitionId, name: 'solution.csv', bytes: solution.length, rows: 2, visibility: 'hidden' })
  setCompetitionState(competitionId, 'live')

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => {
  useCompetitionRunner(null)
  server?.close()
})

/* --------------------------------------------------------------- helpers */

function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  headers.set('x-forwarded-for', CLASS_ADDRESS)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers })
}

/** A notebook the stand-in holds for a moment: long enough to overlap with the others. */
const notebook = (tag: string) => JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [{ cell_type: 'code', source: `# colloq-test: {"hold": 120}\n# ${tag}`, outputs: [], metadata: {}, execution_count: null }],
})

async function join(name: string, slug = 'load'): Promise<{ cookie: string; id: string }> {
  const res = await call(`/api/k/competitions/${slug}/join`, { method: 'POST', body: JSON.stringify({ name }) })
  assert.equal(res.status, 200, `joining ${name}`)
  const cookie = (res.headers.getSetCookie?.() ?? []).find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))?.split(';')[0]
  assert.ok(cookie, 'no entrant cookie')
  return { cookie, id: ((await res.json()) as { entrant: { id: string } }).entrant.id }
}

function upload(cookie: string, tag: string, slug = 'load') {
  const form = new FormData()
  form.append('file', new Blob([notebook(tag)]), `${tag}.ipynb`)
  return call(`/api/k/competitions/${slug}/submissions`, { method: 'POST', body: form, cookie })
}

async function mine(cookie: string): Promise<EntrantSubmissions> {
  const res = await call('/api/k/competitions/load/submissions', { cookie })
  assert.equal(res.status, 200)
  return (await res.json()) as EntrantSubmissions
}

async function board(slug = 'load'): Promise<EntrantLeaderboard> {
  return (await (await call(`/api/k/competitions/${slug}/leaderboard`)).json()) as EntrantLeaderboard
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

/**
 * An upload whose headers arrive now and whose body arrives when told: the
 * classroom Wi-Fi, reduced to one call.
 */
function slowUpload(cookie: string, tag: string): { finish: () => void; response: Promise<{ status: number; body: any }> } {
  const boundary = `----colloq-load-${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${tag}.ipynb"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  const whole = Buffer.concat([head, Buffer.from(notebook(tag)), Buffer.from(`\r\n--${boundary}--\r\n`)])
  const cut = head.length + 16
  let finish = () => {}
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/k/competitions/load/submissions',
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(whole.length),
        'x-forwarded-for': CLASS_ADDRESS,
        cookie,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }))
    })
    request.on('error', reject)
    request.write(whole.subarray(0, cut))
    finish = () => request.end(whole.subarray(cut))
  })
  return { finish: () => finish(), response }
}

/* ------------------------------------------------------------------ test */

test('fifteen people behind one address send at the deadline: accepted, estimated, replaced, drained, then the final board', async () => {
  const people = [] as { cookie: string; id: string }[]
  for (let i = 0; i < PEOPLE; i++) people.push(await join(`@student_${i + 1}`))
  const late = await join('@late_on_wifi')

  // All of them in the same second, from one address — the old per-address
  // limit refused the thirteenth.
  updateCompetition(competitionId, { deadlineAt: Date.now() + 60_000 })
  const burst = await Promise.all(people.map((person, i) => upload(person.cookie, `v1-${i}`)))
  for (const res of burst) assert.equal(res.status, 200, 'a notebook from the class was refused')
  const accepted = await Promise.all(burst.map(async (res) => (await res.json()) as { submission: { id: string; number: number }; leftToday: number }))
  for (const one of accepted) assert.equal(one.leftToday, 2)

  // Everyone waits, and everyone sees a place and an estimate — the same
  // estimate for the same place, aware of eight slots.
  const views = await Promise.all(people.map((person) => mine(person.cookie)))
  const spots = views.map((view) => {
    assert.equal(view.live.length, 1)
    const live = view.live[0]
    assert.ok(live.place !== null && live.place >= 1 && live.place <= PEOPLE, 'no place in the queue')
    assert.ok(typeof live.etaMs === 'number' && live.etaMs > 0, 'no estimate')
    return { place: live.place!, etaMs: live.etaMs! }
  })
  assert.deepEqual(spots.map((spot) => spot.place).sort((a, b) => a - b), Array.from({ length: PEOPLE }, (_, i) => i + 1))
  const byPlace = [...spots].sort((a, b) => a.place - b.place)
  for (let i = 1; i < SLOTS; i++) assert.equal(byPlace[i].etaMs, byPlace[0].etaMs, 'the first eight start together')
  assert.equal(byPlace[SLOTS].etaMs, byPlace[0].etaMs * 2, 'the ninth waits for a slot to free up')

  // Person 5 fixes a typo while still waiting: the new notebook takes the old
  // one's place, and the day's quota does not move.
  const fixer = people[4]
  const before = views[4]
  const oldId = before.live[0].submissionId
  const oldPlace = before.live[0].place
  const again = await upload(fixer.cookie, 'v1-fixed')
  assert.equal(again.status, 200)
  const replaced = (await again.json()) as { submission: { id: string }; leftToday: number; replacedNumber: number | null }
  assert.equal(replaced.replacedNumber, getSubmission(oldId)?.number)
  assert.equal(replaced.leftToday, before.leftToday, 'a replacement used another submission of the day')
  const after = await mine(fixer.cookie)
  assert.equal(after.live.length, 1)
  assert.equal(after.live[0].submissionId, replaced.submission.id)
  assert.equal(after.live[0].place, oldPlace, 'the replacement lost its place in the queue')
  const old = after.submissions.find((one) => one.id === oldId)
  assert.equal(old?.state, 'cancelled')
  assert.equal(old?.replacedBy, getSubmission(replaced.submission.id)?.number)

  // The deadline comes close. One upload begins a second before it and its
  // body arrives half a second after — the Wi-Fi's fault, not the student's.
  const deadline = Date.now() + 1000
  updateCompetition(competitionId, { deadlineAt: deadline })
  const slow = slowUpload(late.cookie, 'late')
  await sleep(deadline + 500 - Date.now())
  // Intake is over but that upload is still arriving: the board waits for it too.
  const counting = await board()
  assert.equal(counting.privateOpen, false)
  assert.equal(counting.privatePending, PEOPLE + 1)
  slow.finish()
  const landed = await slow.response
  assert.equal(landed.status, 200, `a notebook that began before the deadline was refused: ${JSON.stringify(landed.body)}`)
  // One that begins after the deadline is refused, as before.
  const tooLate = await upload(late.cookie, 'too-late')
  assert.equal(tooLate.status, 403)
  assert.equal(((await tooLate.json()) as { reason: string }).reason, 'closed')

  // Results are still being counted: the final board stays closed and says how many are left.
  const waiting = await board()
  assert.equal(waiting.privateOpen, false)
  assert.equal(waiting.private, null)
  assert.equal(waiting.privatePending, PEOPLE + 1)

  // The queue drains with at most eight at a time — and does use them.
  let busiest = 0
  const watch = setInterval(() => { busiest = Math.max(busiest, runningRows().length) }, 2)
  try {
    await drainCompetitionQueue()
  } finally {
    clearInterval(watch)
  }
  assert.ok(runner.peak <= SLOTS, `ran ${runner.peak} at once with ${SLOTS} slots`)
  assert.equal(runner.peak, SLOTS, 'the slots were not used in parallel')
  assert.ok(busiest <= SLOTS)
  assert.equal(queueRows().length, 0)

  // Now every result is in, and the final board opens by itself.
  const final = await board()
  assert.equal(final.privatePending, 0)
  assert.equal(final.privateOpen, true)
  assert.ok(final.private && final.private.length === PEOPLE + 1, 'not everyone is on the final board')
  const scored = await Promise.all([...people, late].map((person) => mine(person.cookie)))
  for (const view of scored) {
    assert.equal(view.live.length, 0)
    assert.ok(view.submissions.some((one) => one.state === 'scored'))
  }
  // The replaced one never ran and did not count: the fixer spent one of three.
  assert.equal(scored[4].leftToday, 2)
})

test('an upload that passed the door before the deadline keeps the final board shut while the runtime is still being asked', async () => {
  // A competition of its own: the one above has spent its deadline.
  const made = createCompetition({
    slug: 'door',
    title: 'Door',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 0.5\n' },
    privateRelease: 'auto',
  })
  assert.ok(made)
  const sample = new TextEncoder().encode('id,orders\n1,0\n2,0\n')
  putOpenFile(made.id, 'sample_submission.csv', sample)
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: sample.length, rows: 2, visibility: 'open' })
  const solution = new TextEncoder().encode('id,orders\n1,7\n2,9\n')
  putSecretFile(made.id, 'solution.csv', solution)
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: solution.length, rows: 2, visibility: 'hidden' })
  setCompetitionState(made.id, 'live')
  const person = await join('@at_the_door', 'door')

  // A runtime probe that answers when told: the docker one takes up to seconds.
  let asked = 0
  let answer = () => {}
  const answered = new Promise<void>((resolve) => (answer = resolve))
  const ready = { available: true, code: 'available', reason: null }
  useCompetitionCapabilities(async () => {
    asked += 1
    await answered
    return { execution: ready, preparation: ready }
  })
  try {
    const deadline = Date.now() + 1000
    updateCompetition(made.id, { deadlineAt: deadline })
    const sent = upload(person.cookie, 'at-the-door', 'door')
    // Through the door before the deadline, then held at the probe past it.
    for (const giveUp = Date.now() + 5000; asked === 0; await sleep(5)) {
      if (Date.now() > giveUp) assert.fail('the upload never reached the runtime probe')
    }
    assert.ok(Date.now() < deadline, 'the upload reached the probe only after the deadline')
    await sleep(deadline + 100 - Date.now())
    const held = await board('door')
    assert.equal(held.privateOpen, false, 'the final board opened while an upload from before the deadline was at the door')
    assert.equal(held.private, null)
    assert.equal(held.privatePending, 1)
    answer()
    const landed = await sent
    assert.equal(landed.status, 200, `a notebook that began before the deadline was refused: ${await landed.text()}`)
    assert.equal((await board('door')).privatePending, 1, 'the accepted notebook is a result still to come')
    await drainCompetitionQueue()
    const final = await board('door')
    assert.equal(final.privateOpen, true)
    assert.equal(final.private?.length, 1)
  } finally {
    answer()
    useCompetitionCapabilities(null)
  }
})

/* -------------------------------------------------------------- settings */

function staffCookie(name: string, email: string, role: 'owner' | 'teacher'): string {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

test('the owner sets slots, the upload rate and the defaults; a teacher reads them and cannot', async () => {
  const owner = staffCookie('Хозяйка', 'owner.load@example.edu', 'owner')
  const teacher = staffCookie('Преподаватель', 'teacher.load@example.edu', 'teacher')
  const admin = (method: string, cookie: string, body?: unknown) => fetch(`${base}/api/admin/competitions/settings`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const read = await admin('GET', teacher)
  assert.equal(read.status, 200)
  const shown = (await read.json()) as CompetitionSettings
  assert.equal(shown.slots.effective, queueSlots())
  assert.deepEqual(shown.slots.perSlot, { cpus: shown.defaults.cpus, memoryMb: shown.defaults.memoryMb + 256 })
  assert.equal(shown.uploadsPerMinute.value, 12)

  const refused = await admin('PUT', teacher, { slots: 4 })
  assert.equal(refused.status, 403)

  const saved = await admin('PUT', owner, { slots: 4, uploadsPerMinute: 30, cpus: 1, memoryMb: 2048 })
  assert.equal(saved.status, 200)
  const now = (await saved.json()) as CompetitionSettings
  assert.deepEqual({ mode: now.slots.mode, effective: now.slots.effective, source: now.slots.source }, { mode: 'fixed', effective: 4, source: 'saved' })
  assert.equal(queueSlots(), 4)
  assert.equal(now.uploadsPerMinute.value, 30)
  assert.deepEqual(now.defaults, { wallSeconds: 600, memoryMb: 2048, cpus: 1, perDay: 5 })
  // `auto` is sized by the defaults: the same numbers the tab prints beside it.
  assert.deepEqual(now.slots.perSlot, { cpus: 1, memoryMb: 2304 })

  const tooMuch = await admin('PUT', owner, { memoryMb: 70_000 })
  assert.equal(tooMuch.status, 400)
  const beyond = await admin('PUT', owner, { slots: 65 })
  assert.equal(beyond.status, 400)

  // `null` forgets: back to the environment or `auto`, and the stock defaults.
  const reset = await admin('PUT', owner, { slots: null, uploadsPerMinute: null, cpus: null, memoryMb: null })
  assert.equal(reset.status, 200)
  const back = (await reset.json()) as CompetitionSettings
  assert.equal(back.slots.mode, 'auto')
  assert.equal(back.uploadsPerMinute.source, 'default')
  assert.deepEqual(back.defaults, { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 })
  setQueueSlots(SLOTS)
})
