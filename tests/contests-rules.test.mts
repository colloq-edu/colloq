/**
 * The contests' shared rules (shared/contests.ts): the standings above all.
 *
 * The board is computed once, on the server, from these functions — and the
 * class reads it as a ranking. A penalty minute counted from the wrong
 * moment, a compilation error that cost an attempt, a frozen attempt that
 * leaked its colour through «first to solve», or two people sharing a place
 * would not crash anything: a student would recount it by hand and come to
 * the teacher with the sum. These pin every one of those rules.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boardFrozen,
  boardRevealed,
  computeStandings,
  contestPhase,
  costsAttempt,
  freezeAt,
  languageOfFile,
  letterPosition,
  parseContestSlug,
  pointGroups,
  pointsFor,
  problemLetter,
  problemMaxPoints,
  problemsVisible,
  spendsLimit,
  submissionsOpenFor,
  type StandingAttempt,
  type StandingsInput,
  type TestVerdict,
} from '../shared/contests.js'

const START = Date.UTC(2026, 9, 30, 9, 30)
const at = (minutes: number): number => START + minutes * 60_000

function input(over: Partial<StandingsInput> & { attempts: StandingAttempt[] }): StandingsInput {
  return {
    rules: 'icpc',
    startsAt: START,
    penaltyMinutes: 20,
    frozenFrom: null,
    problems: [
      { id: 'A', maxScore: 100 },
      { id: 'B', maxScore: 100 },
    ],
    entrants: [
      { id: 'marfa', name: 'marfa@example.org', joinedAt: at(-30) },
      { id: 'daniil', name: 'daniil@example.org', joinedAt: at(-20) },
      { id: 'anna', name: 'anna@example.org', joinedAt: at(-10) },
    ],
    viewerId: null,
    seeAll: false,
    ...over,
  }
}

function attempt(entrantId: string, problemId: string, minutes: number, verdict: StandingAttempt['verdict'], over: Partial<StandingAttempt> = {}): StandingAttempt {
  return { entrantId, problemId, submittedAt: at(minutes), state: 'done', verdict, score: null, ...over }
}

test('ICPC: solved first, then the penalty: minutes to the accepted one plus 20 per rejected attempt before it', () => {
  const { rows } = computeStandings(input({
    attempts: [
      attempt('marfa', 'A', 9, 'OK'),
      attempt('daniil', 'A', 5, 'WA'),
      attempt('daniil', 'A', 12, 'OK'),
      attempt('daniil', 'B', 30, 'OK'),
    ],
  }))
  assert.deepEqual(rows.map((row) => [row.entrantId, row.place, row.solved, row.penalty]), [
    ['daniil', 1, 2, 12 + 20 + 30],
    ['marfa', 2, 1, 9],
    ['anna', 3, 0, 0],
  ])
  const daniilA = rows[0].cells[0]
  assert.equal(daniilA.solved, true)
  assert.equal(daniilA.attempts, 1, 'the wrong answer before the accepted one is counted')
  assert.equal(daniilA.minutes, 12)
})

test('ICPC: a compilation error and a judge failure cost nothing; attempts after the accepted one do not count', () => {
  const { rows } = computeStandings(input({
    attempts: [
      attempt('marfa', 'A', 3, 'CE'),
      attempt('marfa', 'A', 4, 'SE'),
      attempt('marfa', 'A', 7, 'OK'),
      attempt('marfa', 'A', 8, 'WA'),
    ],
  }))
  const marfa = rows.find((row) => row.entrantId === 'marfa')!
  assert.equal(marfa.penalty, 7)
  assert.equal(marfa.cells[0].attempts, 0)
  assert.equal(costsAttempt('CE'), false)
  assert.equal(costsAttempt('SE'), false)
  for (const verdict of ['WA', 'TL', 'ML', 'RE', 'OL'] as const) assert.equal(costsAttempt(verdict), true, verdict)
})

test('places are distinct even on equal results: the earlier last accepted submission is higher', () => {
  const { rows } = computeStandings(input({
    attempts: [
      // Both solve A in 10 minutes of penalty; Anna's accepted one came first.
      attempt('anna', 'A', 10, 'OK'),
      attempt('marfa', 'A', 10, 'OK', { submittedAt: at(10) + 30_000 }),
    ],
  }))
  assert.deepEqual(rows.map((row) => [row.entrantId, row.place, row.penalty]), [
    ['anna', 1, 10],
    ['marfa', 2, 10],
    ['daniil', 3, 0],
  ])
  assert.deepEqual(rows.map((row) => row.place), [1, 2, 3], 'never two people on one place')
})

test('with nothing solved, the earlier first submission and then the earlier join are higher', () => {
  const { rows } = computeStandings(input({
    attempts: [attempt('anna', 'A', 2, 'WA')],
  }))
  assert.deepEqual(rows.map((row) => row.entrantId), ['anna', 'marfa', 'daniil'])
})

test('the first solution of a problem is marked once, and only on what the viewer may see', () => {
  const frozenFrom = at(60)
  const { rows } = computeStandings(input({
    frozenFrom,
    viewerId: 'anna',
    attempts: [
      attempt('marfa', 'A', 20, 'OK'),
      attempt('daniil', 'A', 15, 'OK'),
      // Behind the freeze: Marfa's B is accepted, but Anna must not learn it from a filled cell.
      attempt('marfa', 'B', 70, 'OK'),
    ],
  }))
  const byId = new Map(rows.map((row) => [row.entrantId, row]))
  assert.equal(byId.get('daniil')!.cells[0].first, true)
  assert.equal(byId.get('marfa')!.cells[0].first, false)
  const hidden = byId.get('marfa')!.cells[1]
  assert.equal(hidden.solved, false)
  assert.equal(hidden.frozen, 1)
  assert.equal(hidden.first, false)
})

test('the freeze hides other people\'s new attempts, never the viewer\'s own, never from staff', () => {
  const attempts = [
    attempt('marfa', 'A', 70, 'OK'),
    attempt('anna', 'A', 75, 'OK'),
  ]
  const asAnna = computeStandings(input({ frozenFrom: at(60), viewerId: 'anna', attempts }))
  const anna = asAnna.rows.find((row) => row.entrantId === 'anna')!
  const marfa = asAnna.rows.find((row) => row.entrantId === 'marfa')!
  assert.equal(anna.cells[0].solved, true, 'her own verdict is hers')
  assert.equal(marfa.cells[0].solved, false)
  assert.equal(marfa.cells[0].frozen, 1)
  assert.equal(asAnna.rows[0].entrantId, 'anna', 'the ranking uses only what she sees')

  const asStaff = computeStandings(input({ frozenFrom: at(60), viewerId: null, seeAll: true, attempts }))
  assert.equal(asStaff.rows.find((row) => row.entrantId === 'marfa')!.cells[0].solved, true)
  assert.equal(asStaff.rows[0].entrantId, 'marfa')
})

test('a problem solved before the freeze stays solved; pending submissions are pending, not attempts', () => {
  const { rows } = computeStandings(input({
    frozenFrom: at(60),
    viewerId: 'anna',
    attempts: [
      attempt('marfa', 'A', 30, 'OK'),
      attempt('marfa', 'A', 70, 'WA'),
      attempt('daniil', 'B', 40, null, { state: 'running' }),
    ],
  }))
  const marfa = rows.find((row) => row.entrantId === 'marfa')!
  assert.equal(marfa.cells[0].solved, true)
  assert.equal(marfa.cells[0].frozen, 0, 'an attempt at a solved problem never mattered')
  const daniil = rows.find((row) => row.entrantId === 'daniil')!
  assert.equal(daniil.cells[1].pending, 1)
  assert.equal(daniil.cells[1].attempts, 0)
})

test('IOI: the best score per problem, the sum ranks, and the time the sum was reached breaks ties', () => {
  const ioi = (entrantId: string, problemId: string, minutes: number, score: number): StandingAttempt =>
    attempt(entrantId, problemId, minutes, score === 100 ? 'OK' : 'WA', { score })
  const { rows } = computeStandings(input({
    rules: 'ioi',
    attempts: [
      ioi('marfa', 'A', 10, 40),
      ioi('marfa', 'A', 20, 100),
      ioi('marfa', 'A', 30, 60),
      ioi('daniil', 'A', 5, 100),
      ioi('daniil', 'B', 50, 0),
      ioi('anna', 'B', 15, 100),
    ],
  }))
  // All three have 100. Daniil got there at 0:05 — his later zero on B
  // reached nothing and does not move him — Anna at 0:15, Marfa at 0:20.
  assert.deepEqual(rows.map((row) => [row.entrantId, row.score, row.place]), [
    ['daniil', 100, 1],
    ['anna', 100, 2],
    ['marfa', 100, 3],
  ])
  const marfa = rows.find((row) => row.entrantId === 'marfa')!
  assert.equal(marfa.cells[0].score, 100, 'the best, not the last')
  assert.equal(marfa.cells[0].solved, true)
  assert.equal(rows.find((row) => row.entrantId === 'daniil')!.cells[1].score, 0)
})

test('the totals row counts solvers, people who tried and attempts', () => {
  const { totals } = computeStandings(input({
    attempts: [
      attempt('marfa', 'A', 9, 'OK'),
      attempt('daniil', 'A', 5, 'WA'),
      attempt('daniil', 'A', 12, 'OK'),
      attempt('anna', 'B', 30, 'TL'),
    ],
  }))
  assert.deepEqual(totals, [
    { solved: 2, tried: 2, attempts: 3 },
    { solved: 0, tried: 1, attempts: 1 },
  ])
})

test('IOI points: examples are free, the rest share the problem\'s points, the remainder goes to the last tests', () => {
  const tests = [
    { ordinal: 1, sample: true, group: 0 },
    { ordinal: 2, sample: false, group: 1 },
    { ordinal: 3, sample: false, group: 1 },
    { ordinal: 4, sample: false, group: 2 },
  ]
  const groups = pointGroups(tests, 'tests', [])
  assert.deepEqual(groups.map((group) => group.points), [0, 33, 33, 34])
  assert.equal(problemMaxPoints(groups), 100)
  const verdicts = new Map<number, TestVerdict>([[1, 'OK'], [2, 'OK'], [3, 'WA'], [4, 'OK']])
  assert.equal(pointsFor(groups, verdicts), 67)
})

test('IOI groups pay only when every test of the group passes', () => {
  const tests = [
    { ordinal: 1, sample: true, group: 0 },
    { ordinal: 2, sample: false, group: 1 },
    { ordinal: 3, sample: false, group: 1 },
    { ordinal: 4, sample: false, group: 2 },
  ]
  const groups = pointGroups(tests, 'groups', [{ group: 0, points: 0 }, { group: 1, points: 40 }, { group: 2, points: 60 }])
  assert.equal(problemMaxPoints(groups), 100)
  assert.equal(pointsFor(groups, new Map<number, TestVerdict>([[1, 'OK'], [2, 'OK'], [3, 'WA'], [4, 'OK']])), 60)
  assert.equal(pointsFor(groups, new Map<number, TestVerdict>([[1, 'OK'], [2, 'OK'], [3, 'OK'], [4, 'skipped']])), 40)
})

test('a problem of examples alone is still worth its points', () => {
  const groups = pointGroups([{ ordinal: 1, sample: true, group: 0 }, { ordinal: 2, sample: true, group: 0 }], 'tests', [])
  assert.equal(problemMaxPoints(groups), 100)
})

test('the phase and the door follow the dates the way competitions do, and upsolving is the late door', () => {
  const live = { state: 'live' as const, startsAt: at(0), endsAt: at(180), upsolving: false }
  assert.equal(contestPhase(live, at(-1)), 'soon')
  assert.equal(contestPhase(live, at(1)), 'open')
  assert.equal(contestPhase(live, at(181)), 'over')
  assert.equal(contestPhase({ ...live, state: 'draft' }, at(1)), 'draft')
  assert.equal(contestPhase({ ...live, state: 'finished' }, at(1)), 'over')
  assert.equal(submissionsOpenFor(live, at(-1)), 'not_open')
  assert.equal(submissionsOpenFor(live, at(1)), 'open')
  assert.equal(submissionsOpenFor(live, at(181)), 'closed')
  assert.equal(submissionsOpenFor({ ...live, upsolving: true }, at(181)), 'late')
  assert.equal(problemsVisible(live, at(-1)), false)
  assert.equal(problemsVisible(live, at(0)), true)
})

test('the freeze is counted from the end and lasts until the teacher reveals it', () => {
  const contest = { freezeMinutes: 60, endsAt: at(180), unfrozenAt: null }
  assert.equal(freezeAt(contest), at(120))
  assert.equal(boardFrozen(contest, at(119)), false)
  assert.equal(boardFrozen(contest, at(120)), true)
  assert.equal(boardFrozen(contest, at(500)), true, 'still frozen after the end')
  assert.equal(boardFrozen({ ...contest, unfrozenAt: at(200) }, at(500)), false)
  assert.equal(freezeAt({ freezeMinutes: 0, endsAt: at(180) }), null)
})

test('a reveal covers the freeze it revealed: a later end freezes the board again', () => {
  const ended = { freezeMinutes: 60, endsAt: at(180), unfrozenAt: at(190) }
  assert.equal(boardFrozen(ended, at(200)), false)
  assert.equal(boardRevealed(ended), true)
  // The teacher reopens and moves the end two hours later: a new freeze window.
  const extended = { ...ended, endsAt: at(300) }
  assert.equal(freezeAt(extended), at(240))
  assert.equal(boardRevealed(extended), false)
  assert.equal(boardFrozen(extended, at(239)), false)
  assert.equal(boardFrozen(extended, at(240)), true, 'the new freeze is not covered by the old reveal')
  // A small extension inside the revealed window keeps the board open.
  assert.equal(boardFrozen({ ...ended, endsAt: at(185) }, at(200)), false)
})

test('letters, files and addresses', () => {
  assert.equal(problemLetter(0), 'A')
  assert.equal(problemLetter(25), 'Z')
  assert.equal(problemLetter(26), '?')
  assert.equal(letterPosition('c'), 2)
  assert.equal(letterPosition('C'), 2)
  assert.equal(letterPosition('cc'), null)
  assert.equal(languageOfFile('islands.py'), 'python3')
  assert.equal(languageOfFile('Main.CPP'), 'cpp20')
  assert.equal(languageOfFile('a.c'), 'c17')
  assert.equal(languageOfFile('notes.txt'), null)
  assert.equal(parseContestSlug(' Algo-K2 '), 'algo-k2')
  assert.equal(parseContestSlug('t'), null)
  assert.equal(parseContestSlug('two words'), null)
})

test('the per-problem limit is spent by everything sent except a compilation error and the judge\'s failure', () => {
  assert.equal(spendsLimit(null, 'queued'), true, 'a submission in the queue holds its place')
  assert.equal(spendsLimit('WA', 'done'), true)
  assert.equal(spendsLimit('OK', 'done'), true)
  assert.equal(spendsLimit('CE', 'done'), false)
  assert.equal(spendsLimit('SE', 'failed'), false)
})
