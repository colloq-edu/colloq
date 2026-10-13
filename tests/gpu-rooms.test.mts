/**
 * A GPU room and the competition queue on one machine: a card the queue has
 * bound to a submission is no class's from the moment of the take, not from
 * the moment its container appears, and the rooms' pool is read when the card
 * is picked, not a docker round trip before.
 *
 * Both rules fail quietly, and both failures end the same way: a lecture and
 * a submission on one card with no wall between their video memory — at one
 * run per card the submission is not even capped. The queue writes the card
 * into the run's row inside the take; the run's container, which carries the
 * `colloq.gpu` label the room census reads, comes seconds later (tens of
 * seconds on the first GPU run after a restart). A card the owner gave back to
 * classes in that window went to the next lecture (review of 13 Oct 2026).
 * And a room that read the pool before its two docker censuses picked from a
 * pool one round trip old: a card the owner gave to submissions meanwhile,
 * which the pump bound at once, went to the room as well. A room refused
 * because a submission still holds a card given back to classes is told
 * that, not that other classes hold every card.
 *
 * Docker is faked at the process boundary (tests/_fake-docker.mts). The
 * queue's rows are written into its real table the way its take writes them;
 * the room start, the censuses and the panels are the real ones.
 */
import './_env.mts'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { EnvironmentsState, ResourceSettingsResponse } from '../shared/admin.js'
import { setLocaleResolver } from '../shared/i18n.js'
import { getInstanceLanguage } from '../server/src/admin/settings.js'
import { createSession, db } from '../server/src/db.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { dropRoomKernel, endpointForSession, gpuRefusal, roomGpuDevices, submissionGpuCards } from '../server/src/kernel/pool.js'
import { forgetPerimeter } from '../server/src/kernel/perimeter.js'
import { forgetResources, useDockerInfo } from '../server/src/kernel/resources.js'
import { fakeDocker, type FakeDocker } from './_fake-docker.mts'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
let owner = ''

before(async () => {
  app = await startApp()
  owner = staffMember('Card owner', 'owner').cookie
})

after(() => app?.close())

/* ------------------------------------------------------------- the stand */

let stand: { fake: FakeDocker; rooms: string[]; restore: () => void } | null = null
/** Called once at the room's first census (`docker ps` of submissions' containers): the moment its pick used to be stale. */
let duringCensus: (() => void) | null = null
const unbinds: Array<() => void> = []

/**
 * Docker with a lecture on card 0 of KERNEL_GPUS=0,1, a daemon with room for
 * any class, and the room's Jupyter answering at once.
 */
function machine(): FakeDocker {
  const fake = fakeDocker()
  process.env.KERNEL_GPUS = '0,1'
  fake.add('lecture', 'room', { gpu: '0' })
  fake.intercept = (args) => {
    if (args[0] === 'ps' && args.includes('label=colloq.kind=competition-run')) {
      const now = duringCensus
      duringCensus = null
      now?.()
      return undefined
    }
    // A room's container keeps the card it was started with, as its label does.
    if (args[0] === 'run' && args.includes('--name')) {
      const name = args[args.indexOf('--name') + 1]!
      const card = args.includes('--gpus') ? args[args.indexOf('--gpus') + 1]!.replace(/^device=/, '') : ''
      fake.add(name.replace(/^colloq-room-/, ''), 'room', { gpu: card })
      return { code: 0, out: name }
    }
    return undefined
  }
  const fetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.startsWith('http://colloq-room-') ? Promise.resolve(new Response('{}', { status: 200 })) : fetch(input, init)
  }) as typeof fetch
  useDockerInfo(async () => ({ code: 0, out: `${512 * 1024 ** 3} 64` }))
  forgetResources()
  forgetPerimeter()
  stand = {
    fake,
    rooms: [],
    restore: () => {
      globalThis.fetch = fetch
      fake.restore()
      useDockerInfo(null)
      forgetResources()
      forgetPerimeter()
    },
  }
  return fake
}

afterEach(async () => {
  duringCensus = null
  for (const unbind of unbinds.splice(0)) unbind()
  saveCompetitionSettings({ gpuDevices: null })
  if (!stand) return
  for (const room of stand.rooms) await dropRoomKernel(room).catch(() => {})
  stand.restore()
  stand = null
})

/** A class that starts a GPU room. */
function seminar(id: string): string {
  createSession(id, id)
  stand?.rooms.push(id)
  return id
}

/** The cards `docker run` gave this room's container, as `--gpus` values. */
function cardsGiven(fake: FakeDocker, room: string): string[] {
  return fake.calls
    .filter((args) => args[0] === 'run' && args[args.indexOf('--name') + 1] === `colloq-room-${room}`)
    .map((args) => args[args.indexOf('--gpus') + 1] ?? '')
}

let taken = 0
/**
 * A GPU notebook the queue has just taken onto `card`, written as the take
 * writes it (competitions/store.ts · takeNext): running, its card in its row,
 * and no container yet.
 */
function bindCard(card: string): void {
  const id = `taken-gpu-run-${++taken}`
  const at = Date.now()
  db.prepare(
    `INSERT INTO competition_queue (submission_id, competition_id, entrant_id, kind, state, enqueued_at, started_at, attempts, gpu)
     VALUES (?, 'gpu-competition', 'gpu-entrant', 'notebook', 'running', ?, ?, 1, ?)`,
  ).run(id, at, at, card)
  unbinds.push(() => db.prepare('DELETE FROM competition_queue WHERE submission_id = ?').run(id))
}

/* ------------------------------------------------------------ the binding */

test("a card the queue has bound to a run whose container is not up yet is no class's: not a new room's, and not free on the panels", async () => {
  const fake = machine()
  // Card 1 is the submissions', and the pump takes a GPU notebook onto it...
  saveCompetitionSettings({ gpuDevices: ['1'] })
  bindCard('1')
  // ...and before its container is up, the owner gives card 1 back to classes.
  saveCompetitionSettings({ gpuDevices: [] })
  assert.deepEqual(roomGpuDevices(), ['0', '1'])
  // A run that holds no card, and a row that is not running, hold nothing.
  db.prepare(
    `INSERT INTO competition_queue (submission_id, competition_id, entrant_id, kind, state, enqueued_at, started_at, attempts, gpu)
     VALUES ('cpu-run', 'cpu-competition', 'cpu-entrant', 'notebook', 'running', 1, 1, 1, NULL),
            ('waiting-run', 'gpu-competition', 'gpu-entrant', 'notebook', 'waiting', 1, NULL, 0, NULL)`,
  ).run()
  unbinds.push(() => db.prepare("DELETE FROM competition_queue WHERE submission_id IN ('cpu-run', 'waiting-run')").run())

  // No submission's container carries the label yet; the queue's row is the binding.
  assert.deepEqual(await submissionGpuCards(), ['1'])
  // The panels promise no class the card: the environments page counts no
  // free card, the machine bar counts card 1 as the submissions'.
  const environments = await call(app.base, 'GET', '/api/admin/environments', { cookie: owner })
  assert.equal(environments.status, 200)
  assert.deepEqual(((await environments.json()) as EnvironmentsState).gpus, { total: 2, free: 0, runners: 0 })
  const resources = await call(app.base, 'GET', '/api/admin/resources', { cookie: owner })
  assert.equal(resources.status, 200)
  assert.deepEqual(((await resources.json()) as ResourceSettingsResponse).budget.gpus, { total: 2, rooms: 1, runners: 1 })

  // A teacher starting a GPU seminar is refused, not put on the card the
  // submission is about to start on — and told that a submission has it, not
  // that both cards are in use by other classes (one is the lecture's).
  const room = seminar('seminar-bound')
  const refusal = gpuRefusal('base-gpu', ['0', '1'], 0, 1)
  assert.match(refusal, /досчитывается посылка соревнования/)
  assert.doesNotMatch(refusal, /другими занятиями/)
  await assert.rejects(endpointForSession(room, 'base-gpu'), { message: refusal })
  assert.deepEqual(cardsGiven(fake, room), [])

  // The run ends and its row leaves the queue: the card is the classes' again.
  for (const unbind of unbinds.splice(0)) unbind()
  assert.deepEqual(await submissionGpuCards(), [])
  await endpointForSession(room, 'base-gpu')
  assert.deepEqual(cardsGiven(fake, room), ['device=1'])
})

/* ------------------------------------------------------- the pool, read late */

test("the rooms' pool is read when the card is picked: a card given back meanwhile is taken, one given to submissions meanwhile is not", async () => {
  const fake = machine()
  // Card 1 is the submissions'; while the room asks docker who holds what,
  // the owner gives it back to classes. The room takes it.
  saveCompetitionSettings({ gpuDevices: ['1'] })
  duringCensus = () => saveCompetitionSettings({ gpuDevices: [] })
  const given = seminar('seminar-given-back')
  await endpointForSession(given, 'base-gpu')
  assert.deepEqual(cardsGiven(fake, given), ['device=1'])
  await dropRoomKernel(given)

  // Both cards are the classes'; while the room asks docker, the owner gives
  // card 1 to submissions and the pump, woken by the save, binds a GPU
  // notebook to it at once. The room is refused — with the pool it would see
  // now, one card, held by the lecture — rather than started on card 1.
  saveCompetitionSettings({ gpuDevices: [] })
  duringCensus = () => {
    saveCompetitionSettings({ gpuDevices: ['1'] })
    bindCard('1')
  }
  const late = seminar('seminar-too-late')
  // The card the submission holds is not in the rooms' pool: the class's card is what is in use.
  await assert.rejects(endpointForSession(late, 'base-gpu'), { message: gpuRefusal('base-gpu', ['0'], 1, 0) })
  assert.deepEqual(cardsGiven(fake, late), [])
})

/* ------------------------------------------------------------- the words */

test('a seminar refused for a card a submission still holds is told so, in both languages, and waits for the run', async () => {
  const fake = machine()
  // The lecture is on card 0, and card 1 — given back to classes mid-run — still carries a submission's container.
  const intercept = fake.intercept!
  fake.intercept = (args) =>
    args[0] === 'ps' && args.includes('label=colloq.kind=competition-run') ? { code: 0, out: '1\n' } : intercept(args)
  const room = seminar('seminar-finishing')
  await assert.rejects(endpointForSession(room, 'base-gpu'), { message: gpuRefusal('base-gpu', ['0', '1'], 0, 1) })
  assert.deepEqual(cardsGiven(fake, room), [])

  const one = gpuRefusal('base-gpu', ['0', '1'], 0, 1)
  assert.match(one, /«base-gpu»/)
  assert.match(one, /на 1 из них ещё досчитывается посылка соревнования/)
  assert.match(one, /вернули занятиям/)
  assert.match(one, /Подождите/)
  assert.match(one, /без GPU/, 'still a refusal, never a quiet start on the CPU')
  assert.doesNotMatch(one, /другими занятиями/)
  assert.match(gpuRefusal('base-gpu', ['0', '1', '2'], 0, 2), /на 2 из них ещё досчитываются посылки соревнований/)
  // Every card held by classes keeps its words.
  assert.match(gpuRefusal('base-gpu', ['0', '1'], 0, 0), /все заняты другими занятиями/)
  setLocaleResolver(() => 'en')
  try {
    const english = gpuRefusal('base-gpu', ['0', '1'], 0, 1)
    assert.match(english, /a competition submission is still running on 1 of them/)
    assert.doesNotMatch(english, /other classes/)
    assert.match(gpuRefusal('base-gpu', ['0', '1', '2'], 0, 2), /competition submissions are still running on 2 of them/)
  } finally {
    setLocaleResolver(getInstanceLanguage)
  }
})
