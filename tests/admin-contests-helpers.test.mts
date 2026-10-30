/**
 * The «Контесты» tab's decisions, without a DOM (web/src/admin/contests.ts).
 *
 * These are the words and numbers a teacher acts on in the middle of a class
 * (Paper «19 · Контесты», A1–A4): which group a contest is in right now, what
 * its window says, why a draft will not open, how much room the reference
 * leaves under the time limit, which tests a failed submission never reached,
 * and the address every tab of the console lives at. Each is checked against
 * the mockup's own text where the mockup has one.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import type { Contest } from '../shared/contests.js'
import type { ContestListRow, JudgeStatus, ProblemView, ReferenceStatus } from '../shared/contests-api.js'
import {
  averageWords,
  backFromProblem,
  contestMeta,
  contestSlugFor,
  contestSlugRefusal,
  contestTabPath,
  countdown,
  dataPreview,
  durationWords,
  epsilonWords,
  extendedEnd,
  failedReport,
  freezeNote,
  fromZonedInput,
  groupContests,
  instanceZone,
  judgeLine,
  limitsLine,
  marginWords,
  momentOf,
  notRunRange,
  phaseBadge,
  problemPath,
  readContestRoute,
  referenceBadge,
  referenceFailure,
  referenceLook,
  sortQuestions,
  stateNote,
  testResultWords,
  testsLine,
  verdictBadge,
  verdictLine,
  waitsForAnswer,
  windowLine,
  zonedInput,
} from '../web/src/admin/contests.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const MSK = 'Europe/Moscow'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** 30 Oct 2026, 14:38 in Moscow: the class of A1, 52 minutes before its 15:30 end. */
const NOW = Date.UTC(2026, 9, 30, 11, 38)
/** A moment on the Moscow clock of 30 Oct 2026. */
const at = (hour: number, minute = 0, day = 30, month = 10) => Date.UTC(2026, month - 1, day, hour - 3, minute)

function contest(over: Partial<Contest> = {}): Contest {
  return {
    id: 'c1',
    slug: 'algo-k2',
    title: 'Алгоритмы · контрольная 2: графы',
    blurb: '',
    description: '',
    state: 'live',
    rules: 'icpc',
    penaltyMinutes: 20,
    freezeMinutes: 60,
    unfrozenAt: null,
    attemptsPerProblem: 0,
    languages: ['python3', 'cpp20'],
    environment: 'base',
    startsAt: at(12, 30),
    endsAt: at(15, 30),
    upsolving: false,
    boardVisibility: 'public',
    courseId: null,
    createdBy: null,
    hiddenAt: null,
    revision: 1,
    createdAt: at(9),
    updatedAt: at(10),
    ...over,
  }
}

function row(over: Partial<Contest> = {}, extra: Partial<ContestListRow> = {}): ContestListRow {
  return {
    contest: contest(over),
    phase: 'open',
    problems: 6,
    entrants: 34,
    submissions: 187,
    averageSolved: 3.1,
    averageOf: 6,
    notReady: [],
    course: null,
    ...extra,
  }
}

const reference = (over: Partial<ReferenceStatus> = {}): ReferenceStatus => ({
  state: 'passes',
  verdict: 'OK',
  failedTest: null,
  timeMs: 310,
  memoryKb: 38 * 1024,
  slowestTest: 14,
  checkedAt: NOW,
  submissionId: 's1',
  ...over,
})

/* --------------------------------------------------------------- the list */

test('the list groups by phase on its own clock, in A1’s order, and drops empty groups', () => {
  const rows = [
    row({ id: 'over', state: 'finished', startsAt: at(9, 0, 22), endsAt: at(23, 59, 29) }),
    row({ id: 'draft', state: 'draft', startsAt: null, endsAt: null }),
    row({ id: 'soon', startsAt: at(12, 30, 6, 11), endsAt: at(15, 30, 6, 11) }),
    row({ id: 'live' }),
  ]
  const groups = groupContests(rows, NOW)
  assert.deepEqual(groups.map((group) => group.key), ['open', 'soon', 'draft', 'over'])
  assert.deepEqual(groups.map((group) => group.rows[0].contest.id), ['live', 'soon', 'draft', 'over'])
  // A contest moves from «скоро» to «идут» at its start without a reload: the
  // server's `phase` of the request is not what decides.
  const later = groupContests(rows, at(13, 0, 6, 11))
  assert.deepEqual(later.find((group) => group.key === 'open')?.rows.map((one) => one.contest.id), ['soon'])
  // The search reads the title, the address and the course.
  const coursed = row({ id: 'k3', slug: 'algo-k3', title: 'Строки' }, { course: { id: 'k', name: 'Алгоритмы, весна' } })
  assert.deepEqual(groupContests([...rows, coursed], NOW, 'весна').flatMap((group) => group.rows.map((one) => one.contest.id)), ['k3'])
  assert.deepEqual(groupContests(rows, NOW, 'ALGO').flatMap((group) => group.rows).length, 4)
  assert.deepEqual(groupContests(rows, NOW, 'нет такого'), [])
})

test('inside a group: the nearest end, the nearest start, the last edit, the newest finish first', () => {
  const live = groupContests([row({ id: 'late', endsAt: at(18) }), row({ id: 'early', endsAt: at(15, 30) })], NOW)
  assert.deepEqual(live[0].rows.map((one) => one.contest.id), ['early', 'late'])
  const drafts = groupContests(
    [row({ id: 'old', state: 'draft', updatedAt: at(9) }), row({ id: 'new', state: 'draft', updatedAt: at(11) })],
    NOW,
  )
  assert.deepEqual(drafts[0].rows.map((one) => one.contest.id), ['new', 'old'])
})

test('a phase wears the tone the panel gives that state everywhere', () => {
  // Live accent (filled solid in A1), the coming one pale accent, a draft
  // amber, a finished one grey — the competitions' table (admin-scale test).
  assert.deepEqual(phaseBadge('open'), { tone: 'accent', form: 'strong' })
  assert.deepEqual(phaseBadge('soon'), { tone: 'accent', form: 'filled' })
  assert.deepEqual(phaseBadge('draft'), { tone: 'warning', form: 'filled' })
  assert.deepEqual(phaseBadge('over'), { tone: 'neutral', form: 'filled' })
})

test('a row says the mockup’s lines: the meta, the state note, the window, the average', () => {
  const live = row({}, { course: { id: 'k', name: 'Алгоритмы, весна' } })
  assert.equal(contestMeta(live, NOW), 'ICPC · Python, C++ · курс «Алгоритмы, весна»')
  const soon = row({ slug: 'algo-k3', startsAt: at(12, 30, 6, 11), endsAt: at(15, 30, 6, 11) })
  assert.equal(contestMeta(soon, NOW), 'ICPC · Python, C++ · все эталоны проходят')
  assert.equal(contestMeta(row({ rules: 'ioi', state: 'draft' }), NOW), 'IOI · Python, C++')

  assert.deepEqual(stateNote(live, NOW, MSK), { text: 'заморожен с 14:30', tone: 'brand', dot: false })
  assert.equal(stateNote(row({ state: 'draft' }, { notReady: ['C', 'D'] }), NOW)?.text, 'эталон не проверен: C, D')
  assert.equal(stateNote(row({ state: 'draft' }), NOW), null, 'a ready draft has nothing to add')
  const over = stateNote(row({ state: 'finished', upsolving: true, freezeMinutes: 0 }), NOW)
  assert.deepEqual(over, { text: 'дорешивание открыто', tone: 'accent', dot: true })

  assert.deepEqual(windowLine(contest(), NOW, MSK), { when: 'сегодня, 12:30–15:30', note: 'осталось 52 мин', empty: false })
  assert.deepEqual(windowLine(contest({ startsAt: at(12, 30, 6, 11), endsAt: at(15, 30, 6, 11) }), NOW, MSK), {
    when: '6.11, 12:30–15:30',
    note: 'через 7 дней',
    empty: false,
  })
  assert.deepEqual(windowLine(contest({ state: 'finished', startsAt: at(9, 0, 22), endsAt: at(23, 59, 29) }), NOW, MSK), {
    when: '22.10 – 29.10, 23:59',
    note: 'вчера',
    empty: false,
  })
  assert.deepEqual(windowLine(contest({ state: 'draft', startsAt: null, endsAt: null }), NOW, MSK), {
    when: 'сроки не заданы',
    note: null,
    empty: true,
  })

  assert.equal(averageWords(live), '3,1 из 6')
  assert.equal(averageWords(row({ rules: 'ioi' }, { averageSolved: 212.4, averageOf: 400 })), '212 из 400')
  assert.equal(averageWords(row({}, { averageSolved: null })), null)
})

test('the judge strip: what runs, how many at once, on what terms — or that nothing can', () => {
  const judge: JudgeStatus = { backend: 'docker', running: 2, queued: 0, slots: 4, judgedToday: 312, medianMs: 1400, paused: false }
  assert.deepEqual(judgeLine(judge), {
    head: 'проверяет 2 посылки · 0 ждут',
    slots: 'до 4 одновременно',
    tail: 'без сети · сегодня проверено 312, в среднем 1,4 с',
    lit: true,
  })
  const paused = judgeLine({ ...judge, paused: true, running: 0, queued: 1 })
  assert.equal(paused.head, 'на паузе · 1 ждёт')
  assert.equal(paused.lit, false)
  assert.equal(judgeLine({ ...judge, running: 0, medianMs: null }).tail, 'без сети · сегодня проверено 312')
  const none = judgeLine({ ...judge, backend: 'none' })
  assert.equal(none.slots, null, 'no slots to set on a server that cannot judge')
  assert.match(none.tail, /Docker/)
  assert.match(judgeLine({ ...judge, backend: 'test' }).tail, /тестовая проверка/)
})

/* ------------------------------------------------------------ the editor */

test('limits, tests and durations read as A2 writes them', () => {
  assert.equal(limitsLine({ timeLimitMs: 1000, memoryMb: 256 }), '1 с · 256 МБ')
  assert.equal(limitsLine({ timeLimitMs: 1500, memoryMb: 64 }), '1,5 с · 64 МБ')
  const tests = (samples: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({ sample: i < samples })) as ProblemView['tests']
  assert.equal(testsLine({ tests: tests(2, 14) }), '14 · 2 прим.')
  assert.equal(testsLine({ tests: tests(0, 9) }), '9')
  assert.equal(durationWords(at(12, 30), at(15, 30)), '3 ч')
  assert.equal(durationWords(at(12, 30), at(14)), '1 ч 30 мин')
  assert.equal(durationWords(at(12), at(15, 0, 1, 11)), '2 дн 3 ч')
  assert.equal(durationWords(at(15), at(12)), null, 'the wrong way round is said by the form, not counted')
  assert.equal(durationWords(null, at(12)), null)
})

test('the date fields read and write the instance’s clock, summer time included', () => {
  const start = at(12, 30)
  assert.equal(zonedInput(start, MSK), '2026-10-30T12:30')
  assert.equal(fromZonedInput('2026-10-30T12:30', MSK), start)
  assert.equal(zonedInput(null, MSK), '')
  assert.equal(fromZonedInput('', MSK), null)
  assert.equal(fromZonedInput('30.10.2026', MSK), null)
  // Berlin moves its clocks on 29 Mar and 25 Oct 2026: either side of a
  // change the field means the wall clock, not a fixed offset.
  const BERLIN = 'Europe/Berlin'
  assert.equal(new Date(fromZonedInput('2026-03-29T01:30', BERLIN)!).toISOString(), '2026-03-29T00:30:00.000Z')
  assert.equal(new Date(fromZonedInput('2026-03-29T03:30', BERLIN)!).toISOString(), '2026-03-29T01:30:00.000Z')
  assert.equal(new Date(fromZonedInput('2026-07-01T12:00', BERLIN)!).toISOString(), '2026-07-01T10:00:00.000Z')
  for (const value of ['2026-01-15T09:05', '2026-07-01T23:59']) {
    assert.equal(zonedInput(fromZonedInput(value, BERLIN), BERLIN), value, `${value} round-trips`)
  }
  // Without a zone from the server it is the reader's own, as competitions do.
  assert.equal(zonedInput(fromZonedInput('2026-10-30T12:30', null), null), '2026-10-30T12:30')
  assert.equal(instanceZone({ timeZone: 'Europe/Moscow' }), 'Europe/Moscow')
  assert.equal(instanceZone({ timeZone: 'MSK' }), null, 'a name the runtime cannot resolve is not trusted')
  assert.equal(instanceZone({}), null)
})

test('an address is refused in words, and a title suggests one', () => {
  assert.match(contestSlugRefusal('')!, /пустой/)
  assert.match(contestSlugRefusal('t')!, /занят самим Colloq/)
  assert.match(contestSlugRefusal('new')!, /занят самим Colloq/)
  assert.match(contestSlugRefusal('Algo K2')!, /строчные латинские/)
  assert.equal(contestSlugRefusal('algo-k2'), null)
  assert.equal(contestSlugRefusal('  ALGO-K2 '), null, 'case and spaces are the form’s to fix, as the server does')
  assert.equal(contestSlugFor('Алгоритмы · контрольная 2'), 'algoritmy-kontrolnaya-2')
})

/* ---------------------------------------------------------- the reference */

test('a problem row and the editor’s badge say how the reference fares', () => {
  const problem = (ref: Partial<ReferenceStatus>, language: ProblemView['referenceLanguage'] = 'cpp20') => ({
    reference: reference(ref),
    referenceLanguage: language,
  })
  assert.deepEqual(referenceLook(problem({ timeMs: 80 })), { tone: 'positive', word: 'проходит', detail: '0,08 с · C++' })
  assert.deepEqual(referenceLook(problem({ state: 'fails', verdict: 'TL', failedTest: 27 }, 'python3')), {
    tone: 'danger',
    word: 'TL на тесте 27',
    detail: 'Python',
  })
  assert.equal(referenceLook(problem({ state: 'missing' })).word, 'нет эталона')
  assert.equal(referenceLook(problem({ state: 'unchecked' })).tone, 'warning')
  assert.equal(referenceLook(problem({ state: 'running' })).tone, 'accent')
  assert.equal(referenceFailure({ verdict: 'CE', failedTest: null }), 'ошибка компиляции')
  assert.deepEqual(referenceBadge({ state: 'passes' }), { word: 'эталон проходит', tone: 'positive' })
  assert.deepEqual(referenceBadge({ state: 'fails' }), { word: 'эталон не проходит', tone: 'danger' })
  assert.equal(referenceBadge({ state: 'queued' }).tone, 'accent')
})

test('the margin under the time limit: room, a tight fit, or over', () => {
  assert.deepEqual(marginWords(reference({ timeMs: 310 }), 1000), {
    text: 'самый долгий тест эталона — 0,31 с, втрое меньше предела',
    tone: 'ink',
  })
  assert.equal(marginWords(reference({ timeMs: 450 }), 1000).text, 'самый долгий тест эталона — 0,45 с, вдвое меньше предела')
  assert.equal(marginWords(reference({ timeMs: 450 }), 1000).tone, 'warning', 'half the limit leaves Python no room')
  assert.equal(marginWords(reference({ timeMs: 100 }), 1000).text, 'самый долгий тест эталона — 0,1 с, в 10 раз меньше предела')
  assert.equal(marginWords(reference({ timeMs: 220 }), 1000).text, 'самый долгий тест эталона — 0,22 с, в 4 раза меньше предела')
  assert.equal(marginWords(reference({ timeMs: 700 }), 1000).tone, 'warning')
  assert.deepEqual(marginWords(reference({ state: 'fails', timeMs: 1200 }), 1000).tone, 'danger')
  assert.equal(marginWords(reference({ state: 'unchecked', timeMs: null }), 1000).tone, 'muted')
})

test('an epsilon and a test’s data read in one line', () => {
  assert.equal(epsilonWords(1e-6), '1e-6')
  assert.equal(epsilonWords(0.001), '0.001')
  assert.equal(epsilonWords(0.5), '0.5')
  assert.equal(dataPreview('4 5\n##..#\n#...#\n'), '4 5 ⏎ ##..# ⏎ #...#')
  assert.equal(dataPreview('1000 1000\n' + '#.'.repeat(500), 24), '1000 1000 ⏎ #.#.#.#.#.#.…')
  assert.equal(dataPreview(undefined), null)
  assert.equal(testResultWords({ verdict: 'OK', timeMs: 20 }), 'OK · 0,02')
  assert.equal(testResultWords({ verdict: 'skipped', timeMs: null }), 'не запускался')
  assert.equal(testResultWords(undefined), null)
})

/* ------------------------------------------------------------ the drawer */

test('the drawer names the failed test and the tests never reached', () => {
  const ran = [1, 2, 3].map((ordinal) => ({ ordinal, verdict: 'OK' as const })).concat([{ ordinal: 4, verdict: 'WA' as const }])
  assert.equal(notRunRange(ran, 31), 'Тесты 5–31 не запускались.')
  assert.equal(notRunRange(ran, 5), 'Тест 5 не запускался.')
  assert.equal(notRunRange(ran, 4), null)
  // An IOI group stops at its own failure: the report marks the rest skipped.
  const ioi = [
    { ordinal: 1, verdict: 'OK' as const },
    { ordinal: 2, verdict: 'WA' as const },
    { ordinal: 3, verdict: 'skipped' as const },
    { ordinal: 4, verdict: 'OK' as const },
    { ordinal: 5, verdict: 'skipped' as const },
  ]
  assert.equal(notRunRange(ioi, 5), 'Не запускались тесты 3, 5.')
  assert.equal(failedReport(ioi)?.ordinal, 2)
  assert.equal(failedReport(ran.slice(0, 3)), null)
})

test('a verdict reads as A4 writes it, and is drawn in its family’s colour', () => {
  const base = { state: 'done' as const, failedTest: null, total: 31, progress: null, score: null }
  assert.equal(verdictLine({ ...base, verdict: 'WA', failedTest: 4 }), 'Неправильный ответ на тесте 4 из 31')
  assert.equal(verdictLine({ ...base, verdict: 'OK' }), 'Принято · 31 тест')
  assert.equal(verdictLine({ ...base, verdict: 'OK', score: 100 }, 100), 'Принято · 31 тест · 100 из 100 баллов')
  assert.equal(verdictLine({ ...base, verdict: 'CE', total: null }), 'Ошибка компиляции')
  assert.equal(verdictLine({ ...base, state: 'running', verdict: null, progress: 6 }), 'Проверяется · тест 7 из 31')
  assert.equal(verdictLine({ ...base, state: 'queued', verdict: null }), 'Ждёт проверки')
  assert.deepEqual(verdictBadge('OK', 'done'), { word: 'OK', tone: 'positive', form: 'strong' })
  assert.deepEqual(verdictBadge('WA', 'done'), { word: 'WA', tone: 'danger', form: 'filled' })
  assert.deepEqual(verdictBadge('TL', 'done'), { word: 'TL', tone: 'warning', form: 'filled' })
  assert.deepEqual(verdictBadge('CE', 'done'), { word: 'CE', tone: 'neutral', form: 'filled' })
  assert.deepEqual(verdictBadge(null, 'running'), { word: '…', tone: 'accent', form: 'outline' })
})

/* ------------------------------------------------------------ the console */

test('the header’s clock, the freeze note and «Продлить»', () => {
  assert.equal(countdown(52 * MIN + 40_000), '00:52:40')
  assert.equal(countdown(26 * HOUR + 5_000), '26:00:05')
  assert.equal(countdown(-5), '00:00:00')
  const c = contest()
  assert.deepEqual(freezeNote(c, 'open', NOW, MSK), { text: 'таблица заморожена с 14:30 · участники видят «?»', frozen: true })
  assert.deepEqual(freezeNote(c, 'open', at(13), MSK), { text: 'заморозка в 14:30', frozen: false })
  assert.equal(freezeNote(c, 'over', at(16), MSK)?.text, 'таблица заморожена с 14:30 · разморозьте, чтобы показать итог')
  assert.deepEqual(freezeNote({ ...c, unfrozenAt: at(16) }, 'over', at(17), MSK), { text: 'таблица разморожена', frozen: false })
  assert.equal(freezeNote({ ...c, freezeMinutes: 0 }, 'open', NOW, MSK), null)
  // From the end while it is ahead; from now once it has passed — fifteen
  // minutes added to an hour-old deadline would extend nothing.
  assert.equal(extendedEnd(at(15, 30), NOW, 15), at(15, 45))
  assert.equal(extendedEnd(at(12), NOW, 15), NOW + 15 * MIN)
  assert.equal(extendedEnd(null, NOW, 30), NOW + 30 * MIN)
  assert.equal(momentOf(at(14, 36), NOW, MSK), '14:36')
  assert.equal(momentOf(at(14, 36, 29), NOW, MSK), '29.10, 14:36')
})

test('questions: the unanswered first, oldest first; an announcement never waits', () => {
  const q = (id: string, askedAt: number, answer: string | null, question = 'Может ли быть кратное ребро?') => ({
    id,
    askedAt,
    answeredAt: answer === null ? null : askedAt + MIN,
    answer,
    question,
  })
  const list = [q('answered', at(14), 'Да'), q('late', at(14, 32), null), q('early', at(14, 10), null), q('news', at(14, 20), 'n ≤ 10⁵', '')]
  assert.deepEqual(sortQuestions(list).map((one) => one.id), ['early', 'late', 'news', 'answered'])
  assert.equal(waitsForAnswer(q('blank', NOW, '   ')), true, 'an empty answer is no answer')
  assert.equal(waitsForAnswer(q('news', NOW, null, '')), false)
})

test('every tab of the console, and a problem, is an address the router reads back', () => {
  assert.deepEqual(readContestRoute('/admin/contests/c1'), { id: 'c1', tab: 'submissions', problem: null })
  assert.deepEqual(readContestRoute('/admin/contests/c1/board'), { id: 'c1', tab: 'board', problem: null })
  assert.deepEqual(readContestRoute('/admin/contests/c1/problems/p9'), { id: 'c1', tab: 'problems', problem: 'p9' })
  assert.deepEqual(readContestRoute('/admin/contests/c1/nonsense'), { id: 'c1', tab: 'submissions', problem: null })
  assert.deepEqual(readContestRoute('/admin/contests/new'), { id: 'new', tab: 'submissions', problem: null })
  assert.equal(readContestRoute('/admin/contests'), null)
  // The doors' own words are not contests: `settings` is the judge's settings.
  assert.equal(readContestRoute('/admin/contests/settings'), null)
  for (const tab of ['submissions', 'board', 'questions', 'problems', 'entrants', 'settings'] as const) {
    assert.equal(readContestRoute(contestTabPath('c1', tab))?.tab, tab)
  }
  assert.equal(contestTabPath('c1', 'submissions'), '/admin/contests/c1')
  assert.equal(readContestRoute(problemPath('c1', 'p2'))?.problem, 'p2')
  assert.equal(backFromProblem({ id: 'c1', state: 'draft' }), '/admin/contests/c1')
  assert.equal(backFromProblem({ id: 'c1', state: 'live' }), '/admin/contests/c1/problems')
})

test('the words follow the instance’s language', () => {
  setLocaleResolver(() => 'en')
  const judge: JudgeStatus = { backend: 'docker', running: 1, queued: 3, slots: 4, judgedToday: 12, medianMs: 900, paused: false }
  assert.equal(judgeLine(judge).head, 'judging 1 submission · 3 waiting')
  assert.equal(verdictLine({ state: 'done', verdict: 'WA', failedTest: 4, total: 31, progress: null, score: null }), 'Wrong answer on test 4 of 31')
  assert.equal(windowLine(contest(), NOW, MSK).note, '52 min left')
  assert.equal(windowLine(contest({ startsAt: at(12, 30, 6, 11), endsAt: at(15, 30, 6, 11) }), NOW, MSK).when, 'Nov 6, 12:30–15:30')
  assert.equal(marginWords(reference({ timeMs: 100 }), 1000).text, 'the reference’s slowest test takes 0.1 s, 10 times under the limit')
})

test('«через», «завтра», «вчера» count calendar days on the contest’s clock, not hours', () => {
  // 1 Nov 03:38 is two calendar days after 30 Oct, though 37 hours away.
  assert.equal(windowLine(contest({ startsAt: NOW + DAY + 13 * HOUR, endsAt: NOW + 2 * DAY }), NOW, MSK).note, 'через 2 дня')
  // Tomorrow morning from late tonight is «завтра», not «через 10 ч».
  assert.equal(windowLine(contest({ startsAt: at(9, 0, 31), endsAt: at(12, 0, 31) }), at(23), MSK).note, 'завтра')
  // Later today is a span.
  assert.equal(windowLine(contest({ startsAt: at(16), endsAt: at(18) }), NOW, MSK).note, 'через 1 ч 22 мин')
  // Ended at 23:59 yesterday is «вчера» at 14:38, and three days back is said in days.
  assert.equal(windowLine(contest({ state: 'finished', startsAt: at(9, 0, 27), endsAt: at(12, 0, 27) }), NOW, MSK).note, '3 дня назад')
  assert.equal(windowLine(contest({ state: 'finished', startsAt: at(9), endsAt: at(11) }), NOW, MSK).note, '3 ч назад')
})
