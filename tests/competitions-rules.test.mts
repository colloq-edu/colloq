/**
 * Competition rules — the ones the server and the browser must compute the
 * same way.
 *
 * When they drift apart, these rules do not crash: they quietly lie. An
 * entrant sees "3 submissions left" while the server refuses the fourth; the
 * page shows seventh place and the panel sixth. So what is checked here is
 * not "the function returned a number" but exactly the special cases where
 * the copies diverge: the day boundary, a tie on the leaderboard, an
 * entrant's silence under the "entrant chooses" rule, a share that must leave
 * both parts non-empty.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import {
  DIRECTION_ARROW,
  LIMITS,
  boardOf,
  compareScores,
  competitionWord,
  countedSubmission,
  countsTowardDailyQuota,
  dayStart,
  directionWord,
  entrantBadge,
  entrantHandle,
  entrantKeyOk,
  entrantNameKey,
  isTerminal,
  metricFailedNote,
  nameForJoin,
  normalizeEntrantKey,
  parseSlug,
  placeOf,
  placesAmongPeople,
  placesByScore,
  placeShift,
  planSplit,
  privateBoardOpen,
  publicCompetition,
  publicRowCount,
  rankBoard,
  slugRefusal,
  splitByUsage,
  splitRows,
  stageWord,
  stagePosition,
  stateOfVerdict,
  submissionsLeftToday,
  teacherBadge,
  SUBMISSION_STAGES,
  SUBMISSION_STATES,
  type BoardEntry,
  type Competition,
  type QuotaEntry,
  type SubmissionState,
} from '../shared/competitions.js'

/* --------------------------------------------------------------- address */

test('competition address: the same letters as for courses, but "t" is taken by key sign-in', () => {
  assert.equal(parseSlug(' Rohlik '), 'rohlik')
  assert.equal(parseSlug('s5e12'), 's5e12')
  assert.equal(parseSlug('bpm'), 'bpm')
  // Entrant sign-in by link lives at /k/t/<key>: a competition at the address
  // "t" would take away everyone's way back in from a second device.
  assert.equal(parseSlug('t'), null)
  assert.equal(slugRefusal('t'), 'reserved')
  assert.equal(parseSlug('new'), null)
  assert.equal(parseSlug(''), null)
  assert.equal(slugRefusal(''), 'empty')
  assert.equal(parseSlug('ro hlik'), null)
  assert.equal(parseSlug('Rohlik/../etc'), null)
  assert.equal(slugRefusal('ro_hlik'), 'chars')
  assert.equal(slugRefusal('rohlik'), null)
  // A hyphen at either end is not an address: you cannot dictate it aloud
  // without "and a minus at the start".
  assert.equal(parseSlug('-rohlik'), null)
  assert.equal(parseSlug('rohlik-'), null)
})

/* ----------------------------------------------------------------- key */

test('a sign-in key is normalized to one form, and a foreign letter does not become a key', () => {
  assert.equal(normalizeEntrantKey('k7q m2x 9fd'), 'K7Q-M2X-9FD')
  assert.equal(normalizeEntrantKey('K7QM2X9FD'), 'K7Q-M2X-9FD')
  assert.equal(entrantKeyOk('K7Q-M2X-9FD'), true)
  assert.equal(entrantKeyOk('K7QM2X9FD'), false)
  // O, 0, I, 1 and L are dropped from the alphabet: keys are dictated aloud,
  // and "zero or O?" costs a request for a new key.
  assert.equal(normalizeEntrantKey('K0Q-M2X-9FD'), null)
  assert.equal(normalizeEntrantKey('KIQ-M2X-9FD'), null)
  assert.equal(normalizeEntrantKey('K7Q-M2X-9F'), null)
})

/* ----------------------------------------------------------- entrant name */

/*
 * A name is a Telegram username or an email address, and the web form and
 * both doors ask the same function. If the copies drifted apart the form
 * would send names the door refuses, or dim a JOIN the door would take.
 */

test('a Telegram username is taken with or without "@" and stored as "@" plus lower case', () => {
  assert.equal(entrantHandle('ivan_petrov'), '@ivan_petrov')
  assert.equal(entrantHandle('@ivan_petrov'), '@ivan_petrov')
  assert.equal(entrantHandle('@Ivan_Petrov'), '@ivan_petrov')
  assert.equal(entrantHandle('IVAN2007'), '@ivan2007')
  // Pasted from a profile with the spaces around it.
  assert.equal(entrantHandle('  @anya_smirnova \n'), '@anya_smirnova')
  // Five and thirty-two are the bounds, both inclusive.
  assert.equal(entrantHandle('ivanp'), '@ivanp')
  assert.equal(entrantHandle(`a${'b'.repeat(31)}`), `@a${'b'.repeat(31)}`)
  assert.equal(entrantHandle(`@a${'b'.repeat(31)}`), `@a${'b'.repeat(31)}`)
})

test('a username that Telegram would not issue is refused', () => {
  // Too short and too long.
  assert.equal(entrantHandle('ivan'), null)
  assert.equal(entrantHandle('@ivan'), null)
  assert.equal(entrantHandle(`a${'b'.repeat(32)}`), null)
  assert.equal(entrantHandle(`@a${'b'.repeat(32)}`), null)
  // It starts with a letter: not a digit, not an underscore.
  assert.equal(entrantHandle('1van_petrov'), null)
  assert.equal(entrantHandle('@2pac_fan'), null)
  assert.equal(entrantHandle('_ivan_petrov'), null)
  assert.equal(entrantHandle('@_ivan'), null)
  // Latin letters only, and nothing but letters, digits and "_".
  assert.equal(entrantHandle('Иван_Петров'), null)
  assert.equal(entrantHandle('@иван_петров'), null)
  assert.equal(entrantHandle('ivаn_petrov'), null, 'a Cyrillic «а» in a Latin name passed')
  assert.equal(entrantHandle('ivan-petrov'), null)
  assert.equal(entrantHandle('ivan.petrov'), null)
  assert.equal(entrantHandle('@@ivan_petrov'), null)
  assert.equal(entrantHandle('ivan petrov'), null)
  assert.equal(entrantHandle('@ivan petrov'), null)
})

test('an email address is taken in lower case, with "+" and subdomains', () => {
  assert.equal(entrantHandle('Ivan.Petrov@Mail.RU'), 'ivan.petrov@mail.ru')
  assert.equal(entrantHandle('ivan+kaggle@gmail.com'), 'ivan+kaggle@gmail.com')
  assert.equal(entrantHandle('i.petrov@edu.hse.ru'), 'i.petrov@edu.hse.ru')
  assert.equal(entrantHandle('anna_kim-2@students.cs.msu.ru'), 'anna_kim-2@students.cs.msu.ru')
  assert.equal(entrantHandle('a@my-uni.edu'), 'a@my-uni.edu')
  assert.equal(entrantHandle(' anna@mail.ru '), 'anna@mail.ru')
})

test('an address that is not a plausible one is refused', () => {
  // Spaces, inside either part.
  assert.equal(entrantHandle('ivan petrov@mail.ru'), null)
  assert.equal(entrantHandle('ivan@mail .ru'), null)
  // Exactly one "@", with something on both sides.
  assert.equal(entrantHandle('ivan@@mail.ru'), null)
  assert.equal(entrantHandle('ivan@mail@ru.ru'), null)
  assert.equal(entrantHandle('@mail.ru'), null)
  assert.equal(entrantHandle('ivan@'), null)
  // A domain with a letter TLD of two or more.
  assert.equal(entrantHandle('ivan@localhost'), null)
  assert.equal(entrantHandle('ivan@mail.r'), null)
  assert.equal(entrantHandle('ivan@10.0.0.1'), null)
  assert.equal(entrantHandle('ivan@mail..ru'), null)
  assert.equal(entrantHandle('ivan@-mail.ru'), null)
  // Dots only between the letters of the local part.
  assert.equal(entrantHandle('.ivan@mail.ru'), null)
  assert.equal(entrantHandle('ivan.@mail.ru'), null)
  assert.equal(entrantHandle('ivan..petrov@mail.ru'), null)
  // ASCII only: a look-alike letter would be another name to the database
  // and the same row to the eye.
  assert.equal(entrantHandle('иван@почта.рф'), null)
  assert.equal(entrantHandle('аnna@mail.ru'), null, 'a Cyrillic «а» in an address passed')
  // Longer than the stored name would be clipped into a different address.
  const long = `${'a'.repeat(LIMITS.entrantName - '@mail.ru'.length + 1)}@mail.ru`
  assert.equal(long.length, LIMITS.entrantName + 1)
  assert.equal(entrantHandle(long), null)
  assert.equal(entrantHandle(long.slice(1)), long.slice(1), 'an address exactly at the limit was refused')
})

test('a name as a person would write it is neither, and neither is nothing', () => {
  assert.equal(entrantHandle('Анна Ким'), null)
  assert.equal(entrantHandle('Анна'), null)
  assert.equal(entrantHandle('Anna Kim'), null)
  assert.equal(entrantHandle(''), null)
  assert.equal(entrantHandle('   '), null)
  assert.equal(entrantHandle('@'), null)
  assert.equal(entrantHandle(undefined as unknown as string), null)
})

test('one person is one namesake key however the handle was typed', () => {
  const key = (typed: string) => entrantNameKey(entrantHandle(typed)!)
  assert.equal(key('@Anya_Smirnova'), key('anya_smirnova'))
  assert.equal(key('ANYA_SMIRNOVA'), key('@anya_smirnova'))
  assert.equal(key('Anna.Kim@Mail.ru'), key('anna.kim@mail.ru'))
  assert.notEqual(key('@anya_smirnova'), key('@anya_smirnov'))
})

test('a join keeps a name from before the rule, but a newly typed one must be a handle', () => {
  // A newcomer has nothing to keep.
  assert.equal(nameForJoin('', null), null)
  assert.equal(nameForJoin('Анна Ким', null), null)
  assert.equal(nameForJoin('Anya_Smirnova', null), '@anya_smirnova')
  // Signed in as "Анна Ким" since before the rule: an empty field and the
  // stored name sent back (the form fills it in) both keep it as it is.
  assert.equal(nameForJoin('', 'Анна Ким'), 'Анна Ким')
  assert.equal(nameForJoin('Анна Ким', 'Анна Ким'), 'Анна Ким')
  assert.equal(nameForJoin('  анна   ким ', 'Анна Ким'), 'Анна Ким')
  // Another free-text name is a new one, and a new one has to be a handle.
  assert.equal(nameForJoin('Анна Кин', 'Анна Ким'), null)
  assert.equal(nameForJoin('@Anna_Kim', 'Анна Ким'), '@anna_kim')
  // A handle is always brought to its stored form, even when it is the same.
  assert.equal(nameForJoin('@Anna_Kim', '@anna_kim'), '@anna_kim')
})

/* ----------------------------------------------------------- state words */

test('the same state is named with different words for the entrant and for the teacher', () => {
  setLocaleResolver(() => 'ru')
  assert.equal(entrantBadge('notebookFailed')?.word, 'ОШИБКА В ТЕТРАДИ')
  assert.equal(teacherBadge('notebookFailed')?.word, 'УПАЛА ТЕТРАДЬ')
  assert.equal(entrantBadge('timedOut')?.word, 'ЛИМИТ ВРЕМЕНИ')
  assert.equal(teacherBadge('timedOut')?.word, 'ВЫШЛО ВРЕМЯ')
  assert.equal(entrantBadge('scored')?.word, 'ГОТОВО')
  assert.equal(teacherBadge('scored')?.word, 'ГОТОВО')
  // When the teacher's code fails, the entrant gets a sentence, not a badge: a
  // badge would name the entrant as the culprit.
  assert.equal(entrantBadge('metricFailed'), null)
  assert.match(metricFailedNote(), /Проверяющий код упал/)
  assert.equal(teacherBadge('metricFailed')?.word, 'УПАЛА МЕТРИКА')
  // The product's only saturated red badge — and only the teacher sees it.
  assert.equal(teacherBadge('metricFailed')?.form, 'strong')
  // Running and waiting ones are not badges in the teacher's table: they are in
  // the queue block.
  assert.equal(teacherBadge('running'), null)
  assert.equal(teacherBadge('queued'), null)
  assert.equal(entrantBadge('running')?.form, 'strong')
  assert.equal(entrantBadge('queued')?.form, 'outline')
  assert.equal(entrantBadge('rejected')?.tone, 'warning')
})

test('every state and every stage is named in both languages', () => {
  for (const locale of ['ru', 'en'] as const) {
    setLocaleResolver(() => locale)
    for (const state of SUBMISSION_STATES) {
      for (const badge of [entrantBadge(state), teacherBadge(state)]) {
        if (!badge) continue
        assert.ok(badge.word.length > 0, `${locale}/${state}`)
        assert.ok(!badge.word.includes('competitions.'), `${locale}/${state} was left as a key`)
      }
    }
    for (const stage of SUBMISSION_STAGES) {
      assert.ok(!stageWord(stage).includes('competitions.'), `${locale}/${stage}`)
    }
    for (const state of ['draft', 'live', 'finished'] as const) {
      assert.ok(!competitionWord(state).includes('competitions.'))
    }
    assert.ok(!directionWord('lower').includes('competitions.'))
  }
  setLocaleResolver(() => 'ru')
  assert.equal(competitionWord('live'), 'ИДЁТ')
  assert.equal(directionWord('lower'), 'меньше — лучше')
  setLocaleResolver(() => 'en')
  assert.equal(directionWord('higher'), 'higher is better')
  setLocaleResolver(() => 'ru')
  // The arrow is a sign, not a translation: it is the same in both languages.
  assert.equal(DIRECTION_ARROW.lower, '↓')
  assert.equal(DIRECTION_ARROW.higher, '↑')
})

test('stages: one that reached the end is fully passed, a failed one stays where it died', () => {
  assert.equal(stagePosition('scored', 'score', 'notebook'), 'done')
  assert.equal(stagePosition('scored', 'score', 'score'), 'done')
  assert.equal(stagePosition('running', 'notebook', 'accepted'), 'done')
  assert.equal(stagePosition('running', 'notebook', 'notebook'), 'current')
  assert.equal(stagePosition('running', 'notebook', 'check'), 'ahead')
  assert.equal(stagePosition('notebookFailed', 'notebook', 'notebook'), 'current')
  assert.equal(stagePosition('queued', 'queue', 'queue'), 'current')
})

test("the runner's verdict turns into a state in the same order as in the prototype", () => {
  // A kill from outside outranks anything the harness managed to write.
  assert.equal(stateOfVerdict('notebook', 'out-of-memory'), 'outOfMemory')
  assert.equal(stateOfVerdict('notebook', 'timeout'), 'timedOut')
  assert.equal(stateOfVerdict('notebook', 'cell_timeout'), 'timedOut')
  assert.equal(stateOfVerdict('notebook', 'cell_error'), 'notebookFailed')
  assert.equal(stateOfVerdict('notebook', 'kernel_died'), 'notebookFailed')
  assert.equal(stateOfVerdict('notebook', 'exit'), 'notebookFailed')
  // The notebook ran but produced no answer: that is a rejection for the
  // entrant, not a crash.
  assert.equal(stateOfVerdict('notebook', 'no-submission'), 'rejected')
  assert.equal(stateOfVerdict('notebook', 'target_too_large'), 'rejected')
  // The harness is at fault: the teacher has to sort it out, not blame the
  // entrant.
  assert.equal(stateOfVerdict('notebook', 'harness_error'), 'metricFailed')
  assert.equal(stateOfVerdict('metric', 'ok'), 'scored')
  assert.equal(stateOfVerdict('metric', 'participant_error'), 'rejected')
  assert.equal(stateOfVerdict('metric', 'metric_error'), 'metricFailed')
  assert.equal(isTerminal('queued'), false)
  assert.equal(isTerminal('running'), false)
  assert.equal(isTerminal('scored'), true)
})

/* ---------------------------------------------------------- daily quota */

const MSK = 180

test("the day boundary is computed in the class's time zone, not in UTC", () => {
  // 20 Sep 2026 23:59 MSK is 20:59 UTC, and the MSK day began at 21:00 UTC the
  // previous day.
  const lateMsk = Date.UTC(2026, 8, 20, 20, 59)
  const earlyMsk = Date.UTC(2026, 8, 20, 21, 1)
  assert.notEqual(dayStart(lateMsk, MSK), dayStart(earlyMsk, MSK))
  // In UTC the same two marks fall on one day — exactly the mistake the time
  // zone is passed as a number to prevent.
  assert.equal(dayStart(lateMsk, 0), dayStart(earlyMsk, 0))
  assert.equal(dayStart(earlyMsk, MSK), Date.UTC(2026, 8, 20, 21, 0))
})

test("cancelled and never-started submissions do not count towards the day's quota", () => {
  const at = Date.UTC(2026, 8, 20, 12)
  const entry = (state: SubmissionState, cellsDone: number): QuotaEntry => ({
    acceptedAt: at,
    state,
    cellsDone,
  })
  assert.equal(countsTowardDailyQuota(entry('cancelled', 9)), false)
  // "Failed submissions do not count towards the day if they failed before the
  // first cell".
  assert.equal(countsTowardDailyQuota(entry('notebookFailed', 0)), false)
  assert.equal(countsTowardDailyQuota(entry('notebookFailed', 1)), true)
  assert.equal(countsTowardDailyQuota(entry('rejected', 0)), false)
  assert.equal(countsTowardDailyQuota(entry('scored', 0)), true)
  // A queued one uses the quota right away, otherwise one person would queue a
  // hundred.
  assert.equal(countsTowardDailyQuota(entry('queued', 0)), true)
  assert.equal(countsTowardDailyQuota(entry('running', 0)), true)
})

test('left today: yesterday\'s do not count, zero means "no limit"', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const yesterday = now - 24 * 60 * 60 * 1000
  const made = (acceptedAt: number): QuotaEntry => ({
    acceptedAt,
    state: 'scored',
    cellsDone: 3,
  })
  assert.equal(submissionsLeftToday(5, [made(now), made(now)], now, MSK), 3)
  assert.equal(submissionsLeftToday(5, [made(yesterday)], now, MSK), 5)
  assert.equal(submissionsLeftToday(0, [made(now)], now, MSK), null)
  // The quota was lowered in the middle of the day: there is no point showing
  // the entrant "−2 left".
  assert.equal(submissionsLeftToday(1, [made(now), made(now), made(now)], now, MSK), 0)
  // A submission exactly at the day boundary already counts as today's.
  const start = dayStart(now, MSK)
  assert.equal(submissionsLeftToday(5, [made(start)], now, MSK), 4)
  assert.equal(submissionsLeftToday(5, [made(start - 1)], now, MSK), 5)
})

/* ------------------------------------------------- counting and places */

const entry = (over: Partial<BoardEntry> & { id: string }): BoardEntry => ({
  number: 1,
  acceptedAt: 0,
  state: 'scored',
  publicScore: null,
  privateScore: null,
  chosen: false,
  ...over,
})

test('what the entrant chose is counted; silence means the best by the public part', () => {
  const entries = [
    entry({ id: 'a', number: 7, acceptedAt: 10, publicScore: 0.0502 }),
    entry({ id: 'b', number: 11, acceptedAt: 20, publicScore: 0.0455, chosen: true }),
    entry({ id: 'c', number: 12, acceptedAt: 30, publicScore: 0.0440 }),
  ]
  assert.equal(countedSubmission('chosen', entries, 'lower')?.id, 'b')
  // Silence is a choice too, and the mockup names it: "Not chosen: the best by
  // the public part is taken".
  const silent = entries.map((e) => ({ ...e, chosen: false }))
  assert.equal(countedSubmission('chosen', silent, 'lower')?.id, 'c')
  assert.equal(countedSubmission('bestPublic', entries, 'lower')?.id, 'c')
  assert.equal(countedSubmission('last', entries, 'lower')?.id, 'c')
  // For a "higher is better" metric the best one is a different one.
  assert.equal(countedSubmission('bestPublic', entries, 'higher')?.id, 'a')
})

test('"last" means the last one that REACHED a score, not the last one sent', () => {
  const entries = [
    entry({ id: 'a', number: 7, acceptedAt: 10, publicScore: 0.05 }),
    entry({ id: 'fail', number: 8, acceptedAt: 99, state: 'notebookFailed' }),
  ]
  // Otherwise one failed submission before bed would strike a person off the
  // table.
  assert.equal(countedSubmission('last', entries, 'lower')?.id, 'a')
  assert.equal(countedSubmission('chosen', [entries[1]], 'lower'), null)
})

test("leaderboard: the metric's direction decides the order, time orders a tie that shares its place", () => {
  const rows = [
    { entrantId: 'anna', submissionId: 's1', score: 0.0447, at: 300 },
    { entrantId: 'marfa', submissionId: 's2', score: 0.0441, at: 200 },
    { entrantId: 'daniil', submissionId: 's3', score: 0.0441, at: 100 },
  ]
  const lower = rankBoard(rows, 'lower')
  // "Equal results share one place; the submission sent earlier is listed
  // first" — footnote in P3.
  assert.deepEqual(
    lower.map((r) => r.entrantId),
    ['daniil', 'marfa', 'anna'],
  )
  assert.deepEqual(
    lower.map((r) => r.place),
    [1, 1, 3],
  )
  const higher = rankBoard(rows, 'higher')
  assert.equal(higher[0].entrantId, 'anna')
  // A tie further down is ordered by the same rule too, not by row order.
  assert.equal(higher[1].entrantId, 'daniil')
  assert.deepEqual(higher.map((r) => r.place), [1, 2, 2])
  assert.equal(placeOf(lower, 'marfa'), 1)
  assert.equal(placeOf(lower, 'никого'), null)
  assert.ok(compareScores({ score: 1, at: 1 }, { score: 2, at: 0 }, 'lower') < 0)
  assert.ok(compareScores({ score: 1, at: 1 }, { score: 2, at: 0 }, 'higher') > 0)
})

test('the final table takes the private score of THE submission the person chose', () => {
  const people = [
    {
      entrantId: 'timur',
      entries: [
        entry({ id: 'x', acceptedAt: 10, publicScore: 0.0412, privateScore: 0.0900 }),
        entry({ id: 'y', acceptedAt: 20, publicScore: 0.0455, privateScore: 0.0452, chosen: true }),
      ],
    },
    {
      entrantId: 'anna',
      entries: [entry({ id: 'z', acceptedAt: 15, publicScore: 0.0449, privateScore: 0.0447 })],
    },
    {
      entrantId: 'platon',
      entries: [entry({ id: 'p', acceptedAt: 5, publicScore: 0.0419, privateScore: 0.0489 })],
    },
  ]
  const pub = boardOf(people, 'chosen', 'lower', 'public')
  // Timur's best public score is 0.0412 ("x"), but he chose "y", and the
  // chosen one goes into the table: otherwise the entrant's choice would mean
  // nothing.
  assert.deepEqual(
    pub.map((r) => r.entrantId),
    ['platon', 'anna', 'timur'],
  )
  assert.equal(pub[2].score, 0.0455)
  const priv = boardOf(people, 'chosen', 'lower', 'private')
  // The result takes the private score of THE SAME submission: 0.0452, not the
  // 0.0900 of "x".
  assert.deepEqual(
    priv.map((r) => r.entrantId),
    ['anna', 'timur', 'platon'],
  )
  assert.equal(priv[1].score, 0.0452)
  assert.equal(priv[1].submissionId, 'y')
  assert.equal(placeShift(placeOf(pub, 'anna'), placeOf(priv, 'anna')), 1)
  assert.equal(placeShift(placeOf(pub, 'timur'), placeOf(priv, 'timur')), 1)
  assert.equal(placeShift(placeOf(pub, 'platon'), placeOf(priv, 'platon')), -2)
  assert.equal(placeShift(3, 3), 0)
  assert.equal(placeShift(null, 2), null)
  assert.equal(placeShift(2, null), null)
})

test('a person without a single submission that reached a score does not get into the table', () => {
  const rows = boardOf(
    [{ entrantId: 'lost', entries: [entry({ id: 'q', state: 'timedOut' })] }],
    'chosen',
    'lower',
    'public',
  )
  assert.equal(rows.length, 0)
})

test('equal scores share the smallest place, and the next score takes the place after all of them', () => {
  // 29 Sep 2026: seven people with one public score read "4, 5, 6, 7, 8, 9,
  // 10" beside it, while the competition's rules gave them one place.
  const tie = 0.6722222222222224
  const rows = [
    { entrantId: 'anna', submissionId: 'a', score: 0.9, at: 50 },
    { entrantId: 'boris', submissionId: 'b', score: 0.8, at: 40 },
    { entrantId: 'vera', submissionId: 'v', score: 0.7, at: 30 },
    ...Array.from({ length: 7 }, (_, i) => ({ entrantId: `t${i}`, submissionId: `t${i}`, score: tie, at: 100 - i })),
    { entrantId: 'zoya', submissionId: 'z', score: 0.5, at: 1 },
  ]
  const board = rankBoard(rows, 'higher')
  assert.deepEqual(board.map((r) => r.place), [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 11])
  // Only the numbers are shared: inside the tie the earlier submission still
  // stands higher.
  assert.deepEqual(board.slice(3, 10).map((r) => r.entrantId), ['t6', 't5', 't4', 't3', 't2', 't1', 't0'])

  const five = [0.1, 0.2, 0.2, 0.2, 0.3].map((score, i) => ({ entrantId: `p${i}`, submissionId: `s${i}`, score, at: i }))
  assert.deepEqual(rankBoard(five, 'lower').map((r) => r.place), [1, 2, 2, 2, 5])
  assert.deepEqual(rankBoard(five, 'higher').map((r) => r.place), [1, 2, 2, 2, 5])
  // A tie at the very top, and a table that is one tie.
  assert.deepEqual(placesByScore([{ score: 3 }, { score: 3 }, { score: 1 }]).map((r) => r.place), [1, 1, 3])
  assert.deepEqual(placesByScore([{ score: 7 }, { score: 7 }, { score: 7 }]).map((r) => r.place), [1, 1, 1])
  assert.deepEqual(placesByScore([]), [])

  // Equal means the same number, not the same four digits on screen: the
  // metric told these two apart.
  const close = rankBoard([
    { entrantId: 'x', submissionId: 'x', score: 0.6722222222222224, at: 2 },
    { entrantId: 'y', submissionId: 'y', score: 0.6722222222222223, at: 1 },
  ], 'higher')
  assert.deepEqual(close.map((r) => [r.entrantId, r.place]), [['x', 1], ['y', 2]])
})

test('places among people: the baseline takes nobody\'s place and shows the one it would take', () => {
  const line = (name: string, score: number, baseline = false) => ({ name, score, baseline })
  const places = (rows: ReturnType<typeof line>[]) =>
    placesAmongPeople(rows, (row) => row.baseline).map((row) => [row.name, row.place])

  // Tied with people, it shows their place; the people after the tie count
  // only people.
  assert.deepEqual(
    places([line('anna', 0.9), line('boris', 0.8), line('baseline', 0.8, true), line('vera', 0.8), line('gleb', 0.7)]),
    [['anna', 1], ['boris', 2], ['baseline', 2], ['vera', 2], ['gleb', 4]],
  )
  // Between two scores it stands right after everyone who beat it.
  assert.deepEqual(
    places([line('anna', 0.9), line('baseline', 0.85, true), line('boris', 0.8), line('vera', 0.8)]),
    [['anna', 1], ['baseline', 2], ['boris', 2], ['vera', 2]],
  )
  // Nobody has beaten it: no place, whether nobody stands above it or someone
  // only equals it, and whoever of them submitted first.
  assert.deepEqual(places([line('baseline', 0.8, true), line('anna', 0.8), line('boris', 0.7)]), [
    ['baseline', null],
    ['anna', 1],
    ['boris', 2],
  ])
  assert.deepEqual(places([line('anna', 0.8), line('baseline', 0.8, true), line('boris', 0.7)]), [
    ['anna', 1],
    ['baseline', null],
    ['boris', 2],
  ])
  assert.deepEqual(places([line('baseline', 0.8, true)]), [['baseline', null]])
  // Without a baseline it is simply places by score.
  assert.deepEqual(
    places([line('anna', 0.9), line('boris', 0.8), line('vera', 0.8), line('gleb', 0.8), line('dina', 0.1)]).map(([, place]) => place),
    [1, 2, 2, 2, 5],
  )
})

test('the shift is counted from shared places: a tie that moves together moves by one step', () => {
  const person = (entrantId: string, at: number, publicScore: number, privateScore: number) => ({
    entrantId,
    entries: [entry({ id: entrantId, acceptedAt: at, publicScore, privateScore })],
  })
  const people = [
    person('anna', 1, 0.9, 0.84),
    person('boris', 2, 0.8, 0.85),
    person('vera', 3, 0.8, 0.85),
    person('gleb', 4, 0.8, 0.85),
    person('dina', 5, 0.7, 0.83),
    // A tie that breaks up in the final table.
    person('egor', 6, 0.6, 0.3),
    person('zhenya', 7, 0.6, 0.2),
  ]
  const pub = boardOf(people, 'bestPublic', 'higher', 'public')
  const priv = boardOf(people, 'bestPublic', 'higher', 'private')
  assert.deepEqual(pub.map((r) => r.place), [1, 2, 2, 2, 5, 6, 6])
  assert.deepEqual(priv.map((r) => [r.entrantId, r.place]), [
    ['boris', 1], ['vera', 1], ['gleb', 1], ['anna', 4], ['dina', 5], ['egor', 6], ['zhenya', 7],
  ])
  const shift = (id: string) => placeShift(placeOf(pub, id), placeOf(priv, id))
  // "2" in the public table, "1" in the final one: the same arrow for all three.
  assert.deepEqual(['boris', 'vera', 'gleb'].map(shift), [1, 1, 1])
  assert.equal(shift('anna'), -3)
  assert.equal(shift('dina'), 0)
  // "6" and "6" in the public table: one keeps it, the other slides to "7" —
  // by row numbers (6 → 6, 7 → 7) neither would have had an arrow at all.
  assert.equal(shift('egor'), 0)
  assert.equal(shift('zhenya'), -1)
})

/* ---------------------------------------------- private leaderboard */

const draft = (over: Partial<Competition>): Competition =>
  ({
    privateRelease: 'auto',
    deadlineAt: null,
    privateOpenedAt: null,
    ...over,
  }) as Competition

test('private leaderboard: by itself after the deadline, or only by hand', () => {
  const deadline = Date.UTC(2026, 8, 27, 20, 59)
  assert.equal(privateBoardOpen(draft({ deadlineAt: deadline }), deadline - 1), false)
  assert.equal(privateBoardOpen(draft({ deadlineAt: deadline }), deadline), true)
  // "I will open it by hand, at the review": no deadline will do that for the
  // teacher.
  const manual = draft({ privateRelease: 'manual', deadlineAt: deadline })
  assert.equal(privateBoardOpen(manual, deadline + 86_400_000), false)
  assert.equal(privateBoardOpen({ ...manual, privateOpenedAt: deadline }, deadline), true)
  // No deadline set: there is nothing to open.
  assert.equal(privateBoardOpen(draft({}), Date.now()), false)
})

/* ------------------------------------------------------- row split */

test('the share gives exactly the promised number of rows, and both parts are non-empty', () => {
  assert.equal(publicRowCount(397, 30), 119)
  assert.equal(publicRowCount(397, 50), 199)
  assert.equal(publicRowCount(2, 1), 1)
  assert.equal(publicRowCount(2, 99), 1)
  // A metric on zero rows either crashes or returns NaN, and a competition with
  // an empty private part is a competition without a result.
  assert.equal(publicRowCount(100, 0), 1)
  assert.equal(publicRowCount(100, 100), 99)
  assert.equal(publicRowCount(0, 30), 0)
})

test('a seeded split is reproducible and does not depend on the row order in the file', () => {
  const ids = Array.from({ length: 397 }, (_, i) => `id-${i}`)
  const first = splitRows(ids, 30, 'seed-one')
  const again = splitRows(ids, 30, 'seed-one')
  assert.deepEqual(first, again)
  assert.equal(first.filter((p) => p === 'public').length, 119)

  // A row is remembered by its key, not by its position: a shuffled answer
  // file gives the same split, otherwise a rescore after a metric fix would
  // change half of the test set.
  const shuffled = [...ids].reverse()
  const byShuffled = splitRows(shuffled, 30, 'seed-one')
  const where = new Map(shuffled.map((id, i) => [id, byShuffled[i]]))
  for (let i = 0; i < ids.length; i++) assert.equal(where.get(ids[i]), first[i])

  // A different seed, a different split; otherwise the seed would decide
  // nothing.
  const other = splitRows(ids, 30, 'seed-two')
  assert.notDeepEqual(other, first)
  assert.equal(other.filter((p) => p === 'public').length, 119)
})

test('the Usage column outranks the seed, and an unusable column does not replace the draw', () => {
  assert.deepEqual(splitByUsage(['Public', 'private', 'PUBLIC']), ['public', 'private', 'public'])
  // Foreign words are not a split.
  assert.equal(splitByUsage(['Public', 'train']), null)
  // One empty part is not a split either.
  assert.equal(splitByUsage(['Public', 'Public']), null)
  assert.equal(splitByUsage(['Private', 'Private']), null)

  const ids = ['a', 'b', 'c', 'd']
  const byUsage = planSplit({ ids, usage: ['Public', 'Private', 'Private', 'Private'] }, 30, 'seed')
  assert.equal(byUsage.by, 'usage')
  assert.deepEqual(byUsage.parts, ['public', 'private', 'private', 'private'])
  assert.equal(planSplit({ ids, usage: null }, 50, 'seed').by, 'seed')
  // A column of the wrong length is not a column.
  assert.equal(planSplit({ ids, usage: ['Public'] }, 50, 'seed').by, 'seed')
})

/* --------------------------------------------------------------- other */

test('the competition as the entrant sees it carries neither the metric code nor the seed', () => {
  const full = {
    id: 'c1',
    slug: 'rohlik',
    title: 'Rohlik',
    blurb: '',
    description: '',
    state: 'live',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(): ...' },
    publicPercent: 30,
    splitSeed: 'секрет',
    limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 },
    environment: 'base',
    startsAt: null,
    deadlineAt: null,
    privateRelease: 'auto',
    scoring: 'chosen',
    privateOpenedAt: null,
    baselineSubmissionId: null,
    createdBy: 'teacher-1',
    createdAt: 1,
    updatedAt: 1,
  } as Competition
  const seen = publicCompetition(full)
  const flat = JSON.stringify(seen)
  // Knowing the seed and the share, one could fit the answer to the hidden
  // part without solving the task.
  assert.ok(!flat.includes('секрет'))
  assert.ok(!flat.includes('def score'))
  assert.ok(!flat.includes('teacher-1'))
  assert.equal(seen.metric.name, 'MAPE')
  assert.equal(seen.publicPercent, 30)
})

test('limits are defined in one place and do not contradict themselves', () => {
  assert.ok(LIMITS.publicPercent.min >= 1 && LIMITS.publicPercent.max <= 99)
  assert.ok(LIMITS.publicPercent.default > LIMITS.publicPercent.min)
  for (const range of [
    LIMITS.wallSeconds,
    LIMITS.memoryMb,
    LIMITS.cpus,
    LIMITS.perDay,
    LIMITS.publicPercent,
  ]) {
    assert.ok(range.min <= range.default && range.default <= range.max)
  }
  // A submitted notebook is parsed whole in the container's memory, so its
  // ceiling is lower than that of the answer file, which is only copied.
  assert.ok(LIMITS.notebookBytes < LIMITS.submissionBytes)
  assert.ok(LIMITS.participantError < LIMITS.teacherError)
})
