/**
 * "Today" on the server: one day, in one zone, for the students' daily limit,
 * the teacher's "run today" and the published pages' clocks.
 *
 * The limit used to reset at UTC midnight — three in the morning in Moscow,
 * in the middle of night work — while the panel counted the server process's
 * own zone. The day is now the instance's (`TZ`, Moscow without it), with
 * midnight wherever the local clock says 00:00, summer time included; the
 * page says when the limit starts over; and a server updated in the middle of
 * a competition takes nobody's submissions away.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { dayStartIn, nextDayStartIn, zonedClock } from '../shared/time-zone.js'
import { ENTRANT_COOKIE, submissionsLeftToday, type QuotaEntry } from '../shared/competitions.js'
import type { EntrantSubmissions } from '../shared/competitions-entrant.js'
import type { CompetitionsList } from '../shared/competitions-api.js'
import { setLocaleResolver } from '../shared/i18n.js'
import { quotaResetWords } from '../web/src/lib/competition-words.js'
import {
  instanceDayStart,
  instanceNextDayStart,
  instanceTimeZone,
  instanceToday,
} from '../server/src/time-zone.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  leaveQueue,
  leftToday,
  setCompetitionState,
  updateSubmission,
  usedToday,
} from '../server/src/competitions/store.js'
import { app } from '../server/src/app.js'

const HOUR = 60 * 60 * 1000
const MSK = 'Europe/Moscow'

/** Run with `TZ` set (or unset), and put it back whatever happens. */
function withTz<T>(value: string | undefined, body: () => T): T {
  const was = process.env.TZ
  if (value === undefined) delete process.env.TZ
  else process.env.TZ = value
  try {
    return body()
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
}

/* ------------------------------------------- the teacher's "run today" */

let base = ''
let server: http.Server
before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
after(() => server?.close())

function staffCookie(): string {
  const teacher = createTeacher({ name: 'Преподаватель', email: 'teacher.day@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

// First in the file on purpose: the panel keeps its count for two seconds.
test('"run today" in the panel ends at the same midnight as the daily limit', async () => {
  const c = createCompetition({ slug: 'day-panel', title: 'Сегодня' })
  assert.ok(c)
  const person = createEntrant('day.panel@hse.ru').entrant
  const midnight = instanceDayStart(Date.now())
  for (const at of [midnight + 1000, midnight - 1000]) {
    const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'x.ipynb', bytes: 1, at })
    leaveQueue(s.id)
    updateSubmission(s.id, { state: 'scored', publicScore: 1, durationMs: 60_000 })
  }
  const res = await fetch(`${base}/api/admin/competitions`, { headers: { cookie: staffCookie() } })
  const body = (await res.json()) as CompetitionsList
  // One after the instance's midnight, one a second before it: yesterday.
  assert.equal(body.queue.doneToday, 1)
})

/* ------------------------------------------------------------ the zone */

test('the instance zone is TZ, Moscow without it, and a name the database does not know falls back once, out loud', () => {
  assert.equal(withTz(undefined, instanceTimeZone), MSK)
  assert.equal(withTz('', instanceTimeZone), MSK)
  assert.equal(withTz('UTC', instanceTimeZone), 'UTC')
  assert.equal(withTz('Asia/Yekaterinburg', instanceTimeZone), 'Asia/Yekaterinburg')
  // POSIX allows a leading colon.
  assert.equal(withTz(':Europe/Berlin', instanceTimeZone), 'Europe/Berlin')
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    assert.equal(withTz('МСК', instanceTimeZone), MSK)
    assert.equal(withTz('МСК', instanceTimeZone), MSK)
  } finally {
    console.warn = warn
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /TZ=МСК/)
})

test('class pages date their classes in the same zone', () => {
  // 21:30 UTC on 2 September is still the 2nd in Berlin (+2) and already the
  // 3rd in Moscow (+3): the day a finished class is stamped with and the one
  // a course page calls «сегодня».
  const late = Date.UTC(2026, 8, 2, 21, 30)
  // The leading colon used to fall back to Moscow.
  assert.equal(withTz(':Europe/Berlin', () => instanceToday(late)), '2026-09-02')
  assert.equal(withTz(undefined, () => instanceToday(late)), '2026-09-03')
})

/* ------------------------------------------------------------- the day */

test('a day starts at local midnight, summer time and midnight jumps included', () => {
  // 23:30 and 00:30 Moscow time straddle Moscow's midnight, not UTC's.
  const lateMsk = Date.UTC(2026, 8, 30, 20, 30)
  const earlyMsk = Date.UTC(2026, 8, 30, 21, 30)
  assert.equal(dayStartIn(lateMsk, MSK), Date.UTC(2026, 8, 29, 21))
  assert.equal(dayStartIn(earlyMsk, MSK), Date.UTC(2026, 8, 30, 21))
  assert.equal(dayStartIn(lateMsk, 'UTC'), dayStartIn(earlyMsk, 'UTC'))
  assert.equal(nextDayStartIn(lateMsk, MSK), Date.UTC(2026, 8, 30, 21))
  // Berlin's spring day has 23 hours, its autumn day 25.
  const spring = dayStartIn(Date.UTC(2026, 2, 29, 12), 'Europe/Berlin')
  assert.equal(nextDayStartIn(spring, 'Europe/Berlin') - spring, 23 * HOUR)
  const autumn = dayStartIn(Date.UTC(2026, 9, 25, 12), 'Europe/Berlin')
  assert.equal(nextDayStartIn(autumn, 'Europe/Berlin') - autumn, 25 * HOUR)
  // Havana moves its clocks AT midnight: that day begins at 01:00.
  const havana = dayStartIn(Date.UTC(2026, 2, 8, 12), 'America/Havana')
  assert.equal(havana, Date.UTC(2026, 2, 8, 5))
  assert.equal(dayStartIn(havana - 1, 'America/Havana'), Date.UTC(2026, 2, 7, 5))
  // A half-hour zone.
  assert.equal(dayStartIn(Date.UTC(2026, 8, 30, 12), 'Asia/Kolkata'), Date.UTC(2026, 8, 29, 18, 30))
})

test('the daily limit resets at Moscow midnight, not at UTC midnight', () => {
  const c = createCompetition({ slug: 'day-limit', title: 'Лимит', limits: { perDay: 1 } })
  assert.ok(c)
  const person = createEntrant('day.limit@hse.ru').entrant
  const send = (at: number) => {
    const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'x.ipynb', bytes: 1, at })
    leaveQueue(s.id)
    updateSubmission(s.id, { state: 'scored', publicScore: 1, cellsDone: 1 })
  }
  const left = (now: number, zone: string) => leftToday(c, person.id, now, null, zone, null)
  // 23:30 on 30 September, Moscow time.
  send(Date.UTC(2026, 8, 30, 20, 30))
  assert.equal(left(Date.UTC(2026, 8, 30, 20, 45), MSK), 0)
  // 00:30 on 1 October in Moscow: a new day there, still 30 September in UTC.
  const halfPastMidnight = Date.UTC(2026, 8, 30, 21, 30)
  assert.equal(left(halfPastMidnight, MSK), 1)
  assert.equal(left(halfPastMidnight, 'UTC'), 0)
  send(halfPastMidnight)
  assert.equal(left(halfPastMidnight + HOUR, MSK), 0)
  assert.equal(usedToday(c.id, person.id, halfPastMidnight + HOUR, MSK, null), 1)
  assert.equal(usedToday(c.id, person.id, halfPastMidnight + HOUR, 'UTC', null), 2)
  // 03:30 Moscow time is UTC's midnight: the old rule's reset, not ours.
  assert.equal(left(Date.UTC(2026, 9, 1, 0, 30), 'UTC'), 1)
  assert.equal(left(Date.UTC(2026, 9, 1, 0, 30), MSK), 0)
})

/* ------------------------------------------------- the switch itself */

test('an update in the middle of the day takes nobody\'s submissions away', () => {
  // The server was updated at 10:00 Moscow time on 30 September.
  const updatedAt = Date.UTC(2026, 8, 30, 7)
  const entry = (at: number): QuotaEntry => ({ acceptedAt: at, state: 'scored', cellsDone: 1 })
  // Sent at 01:30 Moscow time: yesterday by the old UTC rule, today by Moscow's.
  const night = entry(Date.UTC(2026, 8, 29, 22, 30))
  const morning = Date.UTC(2026, 8, 30, 7, 30)
  // Without the switch rule the update alone would spend the day.
  assert.equal(submissionsLeftToday(1, [night], morning, MSK, null), 0)
  // With it, the count is what it was before the update.
  assert.equal(submissionsLeftToday(1, [night], morning, MSK, updatedAt), 1)
  assert.equal(submissionsLeftToday(1, [night], morning, 'UTC', null), 1)
  // What is sent after the update counts by Moscow's day at once…
  const after = entry(Date.UTC(2026, 8, 30, 8))
  assert.equal(submissionsLeftToday(1, [night, after], morning + HOUR, MSK, updatedAt), 0)
  // …and Moscow's next midnight is a full reset for both.
  assert.equal(submissionsLeftToday(1, [night, after], Date.UTC(2026, 8, 30, 21, 30), MSK, updatedAt), 1)
  // Something sent before the update late the same UTC day still counts, as it did.
  const early = entry(Date.UTC(2026, 8, 30, 2))
  assert.equal(submissionsLeftToday(1, [early], morning, MSK, updatedAt), 0)
})

test('the store applies the switch rule from the moment the instance recorded', () => {
  const c = createCompetition({ slug: 'day-switch', title: 'Переход', limits: { perDay: 1 } })
  assert.ok(c)
  const person = createEntrant('day.switch@hse.ru').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'x.ipynb', bytes: 1, at: Date.UTC(2026, 8, 29, 22, 30) })
  leaveQueue(s.id)
  updateSubmission(s.id, { state: 'scored', publicScore: 1, cellsDone: 1 })
  const morning = Date.UTC(2026, 8, 30, 7, 30)
  assert.equal(leftToday(c, person.id, morning, null, MSK, Date.UTC(2026, 8, 30, 7)), 1)
  assert.equal(leftToday(c, person.id, morning, null, MSK, null), 0)
})

/* -------------------------------------------- saying when it resets */

test('the page is told when the limit resets and in which zone', async () => {
  const c = createCompetition({ slug: 'day-resets', title: 'Сброс', limits: { perDay: 1 } })
  assert.ok(c)
  setCompetitionState(c.id, 'live')
  const joined = await fetch(`${base}/api/k/competitions/day-resets/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '@day_resets' }),
  })
  const cookie = joined.headers.getSetCookie().find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))!.split(';')[0]
  const before = Date.now()
  const mine = (await (await fetch(`${base}/api/k/competitions/day-resets/submissions`, { headers: { cookie } })).json()) as EntrantSubmissions
  assert.equal(mine.dayZone, instanceTimeZone())
  assert.ok([instanceNextDayStart(before), instanceNextDayStart(Date.now())].includes(mine.resetsAt!))

  // The refusal after the last submission of the day says it too.
  const person = ((await (await fetch(`${base}/api/k/me`, { headers: { cookie } })).json()) as { entrant: { id: string } }).entrant.id
  const spent = acceptSubmission({ competitionId: c.id, entrantId: person, fileName: 'x.ipynb', bytes: 1 })
  leaveQueue(spent.id)
  updateSubmission(spent.id, { state: 'scored', publicScore: 1, cellsDone: 1 })
  const form = new FormData()
  form.append('file', new Blob([JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source: 'x' }] })]), 'y.ipynb')
  // Named explicitly, so the words do not depend on the machine running the suite.
  const was = process.env.TZ
  process.env.TZ = MSK
  try {
    const refused = await fetch(`${base}/api/k/competitions/day-resets/submissions`, { method: 'POST', headers: { cookie }, body: form })
    assert.equal(refused.status, 429)
    const body = (await refused.json()) as { reason: string; error: string }
    assert.equal(body.reason, 'quota')
    assert.match(body.error, /Лимит обновится в 00:00 GMT\+3\./)
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
})

test('without a daily limit there is nothing to reset', async () => {
  const c = createCompetition({ slug: 'day-unlimited', title: 'Без лимита', limits: { perDay: 0 } })
  assert.ok(c)
  setCompetitionState(c.id, 'live')
  const joined = await fetch(`${base}/api/k/competitions/day-unlimited/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '@day_unlimited' }),
  })
  const cookie = joined.headers.getSetCookie().find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))!.split(';')[0]
  const mine = (await (await fetch(`${base}/api/k/competitions/day-unlimited/submissions`, { headers: { cookie } })).json()) as EntrantSubmissions
  assert.equal(mine.resetsAt, null)
})

test('the send box names the reset with its zone, in the reader\'s language', () => {
  const midnight = Date.UTC(2026, 8, 30, 21)
  setLocaleResolver(() => 'ru')
  assert.equal(quotaResetWords(midnight, MSK), 'Лимит обновится в 00:00 GMT+3.')
  setLocaleResolver(() => 'en')
  assert.equal(quotaResetWords(midnight, MSK), 'The limit resets at 00:00 GMT+3.')
  assert.equal(zonedClock(midnight, 'UTC', 'en'), '21:00 UTC')
  // A zone this browser does not know: the reader's own clock, still a time.
  assert.match(quotaResetWords(midnight, 'Mars/Olympus'), /The limit resets at \d{2}:\d{2}\./)
  assert.equal(quotaResetWords(null, MSK), '')
  assert.equal(quotaResetWords(undefined, undefined), '')
  setLocaleResolver(() => 'ru')
})
