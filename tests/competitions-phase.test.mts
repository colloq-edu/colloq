/**
 * The phase a competition is in, one word on every screen (Paper 07 · D1–D4).
 *
 * The stored state moves only by hand, and a deadline never touches it: past
 * its deadline a competition stays `live`. Lists that grouped by the stored
 * state kept such a competition under «Идут сейчас» with «приём закрыт» in
 * its own row, said nothing about late intake, and the teacher's console
 * offered «Завершить сейчас» for what had ended hours ago — while its own
 * page already said «Завершено». These pin the one rule all of them now read.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Response as ExpressResponse } from 'express'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { STAFF_COOKIE } from '../shared/admin.js'
import {
  ENTRANT_COOKIE,
  competitionPhase,
  phaseWord,
  publicCompetition,
  type Competition,
} from '../shared/competitions.js'
import type { EntrantCompetitionList, EntrantCompetitionRow } from '../shared/competitions-entrant.js'
import type { CompetitionsList } from '../shared/competitions-api.js'
import { setLocaleResolver } from '../shared/i18n.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getCompetition,
  leaveQueue,
  setCompetitionState,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { app } from '../server/src/app.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 4, 18, 0)

const at = (over: Partial<Pick<Competition, 'state' | 'startsAt' | 'deadlineAt'>>) => ({
  state: 'live' as Competition['state'],
  startsAt: null,
  deadlineAt: null,
  ...over,
})

test('the phase comes from the dates, in the order submissions are judged by', () => {
  assert.equal(competitionPhase(at({ state: 'draft', deadlineAt: NOW - HOUR }), NOW), 'draft')
  assert.equal(competitionPhase(at({ startsAt: NOW + HOUR, deadlineAt: NOW + 2 * HOUR }), NOW), 'soon')
  assert.equal(competitionPhase(at({ deadlineAt: NOW + HOUR }), NOW), 'open')
  assert.equal(competitionPhase(at({}), NOW), 'open', 'no deadline: open until someone finishes it')
  assert.equal(competitionPhase(at({ deadlineAt: NOW - HOUR }), NOW), 'over', 'live past its deadline is over')
  assert.equal(competitionPhase(at({ state: 'finished', deadlineAt: NOW + HOUR }), NOW), 'over', 'finished early')
  // A deadline moved later reopens it with no second press: nothing was stored.
  assert.equal(competitionPhase(at({ deadlineAt: NOW + 24 * HOUR }), NOW), 'open')
})

test('the phase words are the badge words the rest of the product uses', () => {
  setLocaleResolver(() => 'ru')
  assert.equal(phaseWord('open'), 'ИДЁТ')
  assert.equal(phaseWord('over'), 'ЗАВЕРШЕНО')
  assert.equal(phaseWord('draft'), 'ЧЕРНОВИК')
  assert.equal(phaseWord('soon'), 'СКОРО')
  setLocaleResolver(() => 'en')
  assert.equal(phaseWord('soon'), 'SOON')
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------------- the list */

let dir = ''
let List: Component<any>

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-phase-render-'))
  const source = await readFile(new URL('../web/src/components/competitions/CompetitionsList.svelte', import.meta.url), 'utf8')
  let code = compile(source, { filename: 'CompetitionsList.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['svelte', import.meta.resolve('svelte')],
    ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
    ['@shared/competitions', new URL('../shared/competitions.ts', import.meta.url).href],
    ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
  ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
  await writeFile(path.join(dir, 'CompetitionsList.mjs'), code)
  List = (await import(pathToFileURL(path.join(dir, 'CompetitionsList.mjs')).href)).default
})
after(async () => {
  setLocaleResolver(() => 'ru')
  if (dir) await rm(dir, { recursive: true, force: true })
})

function row(over: Partial<Competition>, extra: Partial<EntrantCompetitionRow> = {}): EntrantCompetitionRow {
  const competition: Competition = {
    id: over.slug ?? 'c',
    slug: 'c',
    title: 'C',
    blurb: '',
    description: '',
    state: 'live',
    startsAt: null,
    deadlineAt: NOW + HOUR,
    metric: { name: 'ROC AUC', direction: 'higher', code: '' },
    publicPercent: 30,
    splitSeed: 1,
    limits: { perDay: 5 },
    scoring: 'last',
    privateRelease: 'auto',
    privateOpenedAt: null,
    environment: 'base',
    createdBy: null,
    createdAt: NOW - 48 * HOUR,
    updatedAt: NOW - 48 * HOUR,
    ...over,
  } as Competition
  return {
    competition: publicCompetition(competition),
    entrants: 24,
    submissions: 61,
    bestPublic: 0.85,
    baselinePublic: 0.82,
    privateOpen: false,
    mine: null,
    ...extra,
  }
}

function list(rows: EntrantCompetitionRow[]): string {
  setLocaleResolver(() => 'ru')
  return render(List, {
    props: {
      rows,
      now: NOW,
      joining: null,
      joinBusy: false,
      joinRefusal: null,
      defaultName: '',
      onopen: () => {},
      onjoin: () => {},
      onjoinstart: () => {},
    },
  }).body
}

const section = (html: string, from: string, to?: string) => {
  const start = html.indexOf(from)
  assert.ok(start >= 0, `no section «${from}»`)
  const end = to ? html.indexOf(to, start) : html.length
  return html.slice(start, end < 0 ? html.length : end)
}

test('a competition past its deadline is finished in the list, and says late intake is open', () => {
  const html = list([
    row({ slug: 'running', title: 'Отток абонентов' }),
    row(
      { slug: 'kamery', title: 'Аварии холодильных камер', deadlineAt: NOW - 5 * HOUR, lateSubmissions: true },
      { privateOpen: true, bestFinal: 0.8102, mine: { joined: true, place: 2, score: 0.85, submissions: 3, inFlight: 0, leftToday: 2, finalPlace: 3, finalScore: 0.803 } },
    ),
    row({ slug: 'closed', title: 'Дефекты деталей', deadlineAt: NOW - 6 * HOUR }, { privateOpen: true, bestFinal: 0.9361 }),
  ])
  const running = section(html, 'ИДУТ СЕЙЧАС', 'ЗАВЕРШЁННЫЕ')
  const finished = section(html, 'ЗАВЕРШЁННЫЕ')
  assert.match(running, /Отток абонентов/)
  assert.doesNotMatch(running, /Аварии холодильных камер|Дефекты деталей/)
  assert.doesNotMatch(running, /приём закрыт/, 'a running card never says intake is closed')
  assert.match(finished, /Аварии холодильных камер/)
  assert.match(finished, /Дефекты деталей/)
  // The late mark, the counted standings and the winner — the page's own words.
  assert.match(finished, /приём поздних посылок открыт/)
  assert.equal(html.split('приём поздних посылок открыт').length - 1, 1, 'only the competition that takes late ones')
  assert.match(finished, /В ЗАЧЁТЕ/)
  assert.match(finished, /3-й · 0\.8030/)
  assert.match(finished, /лучший в зачёте 0\.8102/)
  assert.match(finished, /лучший в зачёте 0\.9361/)
  // Late intake first: it can still be solved, the closed one only looked at.
  assert.ok(finished.indexOf('Аварии') < finished.indexOf('Дефекты'))
})

test('with nothing running, «Идут сейчас» points at the late ones below', () => {
  const late = list([row({ slug: 'k', title: 'K', deadlineAt: NOW - HOUR, lateSubmissions: true })])
  assert.match(late, /В завершённые ниже ещё можно отправить решение вне зачёта/)
  const closed = list([row({ slug: 'k', title: 'K', deadlineAt: NOW - HOUR })])
  assert.match(closed, /Сейчас ничего не идёт\./)
  assert.doesNotMatch(closed, /вне зачёта/)
})

test('a competition before its start is running, with the time to the start', () => {
  const html = list([row({ slug: 's', title: 'Скоро', startsAt: NOW + 2 * HOUR, deadlineAt: NOW + 50 * HOUR })])
  const running = section(html, 'ИДУТ СЕЙЧАС', 'ЗАВЕРШЁННЫЕ')
  assert.match(running, /ДО СТАРТА/)
  assert.match(running, /2 ч/)
})

/* ----------------------------------------------------------- the server */

let base = ''
let server: http.Server
let staffCookie = ''

before(async () => {
  useCompetitionRunner(null)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const teacher = createTeacher({ name: 'Преподаватель', email: 'phase.teacher@example.edu', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  staffCookie = `${STAFF_COOKIE}=${value}`
})
after(() => server?.close())

function scored(c: Competition, entrantId: string, publicScore: number, privateScore: number, late = false) {
  const row = acceptSubmission({
    competitionId: c.id,
    entrantId,
    fileName: 'a.ipynb',
    bytes: 1,
    at: late ? Date.now() - 1000 : c.deadlineAt! - 10 * 60 * 1000,
    ...(late ? { late: true } : {}),
  })
  leaveQueue(row.id)
  return updateSubmission(row.id, { state: 'scored', stage: 'score', publicScore, privateScore })!
}

test('the lists carry the counted standings once the results are open, and the late count', async () => {
  const made = createCompetition({
    slug: 'phase-over',
    title: 'Phase over',
    metric: { name: 'ROC AUC', direction: 'higher', code: 'def score(solution, submission):\n    return 0.5\n' },
    limits: { perDay: 5 },
    deadlineAt: Date.now() - HOUR,
    lateSubmissions: true,
    scoring: 'last',
  })
  assert.ok(made)
  setCompetitionState(made.id, 'live')
  const c = getCompetition(made.id)!
  // Anna joins through the door (late intake lets her in), Boris is made directly.
  const joined = await fetch(`${base}/api/k/competitions/phase-over/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '@anna_phase' }),
  })
  assert.equal(joined.status, 200)
  const anna = ((await joined.json()) as { entrant: { id: string } }).entrant.id
  const cookie = (joined.headers.getSetCookie?.() ?? []).find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))!.split(';')[0]
  const boris = createEntrant('@boris_phase').entrant.id
  scored(c, anna, 0.9, 0.7)
  scored(c, boris, 0.8, 0.75)
  scored(c, anna, 0.99, 0.99, true)

  const body = (await (await fetch(`${base}/api/k/competitions`, { headers: { cookie } })).json()) as EntrantCompetitionList
  const mine = body.competitions.find((r) => r.competition.slug === 'phase-over')!
  assert.equal(mine.privateOpen, true)
  assert.equal(mine.bestFinal, 0.75, 'the winner of the counted board, never the late one')
  assert.equal(mine.mine?.place, 1, 'the public place stays what it was')
  assert.equal(mine.mine?.finalPlace, 2, 'the counted place: second behind Boris')
  assert.equal(mine.mine?.finalScore, 0.7)

  const admin = (await (await fetch(`${base}/api/admin/competitions`, { headers: { cookie: staffCookie } })).json()) as CompetitionsList
  const teacherRow = admin.competitions.find((r) => r.competition.slug === 'phase-over')!
  assert.equal(teacherRow.bestPrivate, 0.75)
  assert.equal(teacherRow.late, 1)
  assert.equal(teacherRow.bestPublic, 0.9)
})
