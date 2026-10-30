/**
 * The words and numbers of the contest pages (K1–K6), without a browser.
 *
 * All of these look plausible whatever they say: «+2» or «+3» in a cell,
 * «0:44» or «44:00» under it, «0,08 с» or «0.08 s», «тест 7» or «тест 8» on
 * the rail, a frozen cell that says «…» (and so leaks that something is being
 * judged), the window of «Рядом со мной» one row short. A student finds each
 * of them by counting by hand, in class; here a line each.
 *
 * English is checked beside Russian: the catalog carries both, and plural
 * forms follow different rules in the two.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import { contestMessages } from '../shared/locales/contests.js'
import { contestServerMessages } from '../shared/locales/contests-server.js'
import type { StandingCell, StandingRow } from '../shared/contests.js'
import type { EntrantContestSubmission, LanguageOption, ProblemMine } from '../shared/contests-entrant.js'
import {
  boardMinutes,
  cellFace,
  checkerWords,
  contestCountdown,
  contestMeta,
  currentTest,
  draftKey,
  fileChoice,
  firstErrorLine,
  firstSolvers,
  icpcCell,
  ioiCell,
  languageKey,
  languageLabel,
  limitMemory,
  limitTime,
  limitsLine,
  liveRun,
  logPieces,
  memoryWords,
  nearRows,
  ofWords,
  overLimitValue,
  overLimitWords,
  phaseBadge,
  phoneHead,
  pickLanguage,
  questionsOrder,
  railFace,
  readStored,
  samplesNote,
  secondsValue,
  sendShortcut,
  sourceBytes,
  stripCells,
  stripNote,
  submissionHead,
  submissionTone,
  testColumn,
  timeWords,
  usageWords,
  verdictCode,
  verdictLine,
  writeStored,
} from '../web/src/lib/contest-words.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const MINUTE = 60_000
const cell = (over: Partial<StandingCell> = {}): StandingCell => ({
  solved: false,
  attempts: 0,
  minutes: null,
  first: false,
  pending: 0,
  frozen: 0,
  score: null,
  tried: false,
  ...over,
})
const submission = (over: Partial<EntrantContestSubmission> = {}): EntrantContestSubmission => ({
  id: 's1',
  number: 9,
  problemId: 'p3',
  letter: 'C',
  language: 'python3',
  submittedAt: Date.UTC(2026, 9, 30, 11, 22),
  late: false,
  state: 'done',
  verdict: 'WA',
  failedTest: 4,
  passed: 3,
  total: 18,
  score: null,
  timeMs: 80,
  memoryKb: 12 * 1024,
  progress: null,
  strip: [],
  ...over,
})

/* ------------------------------------------------------------ the board */

test('an ICPC cell: «+» and «+2» over the minutes, solid only for the first solve', () => {
  assert.deepEqual(
    [icpcCell(cell({ solved: true, minutes: 9, first: true, tried: true }))].map((f) => [f.tone, f.main, f.sub]),
    [['first', '+', '0:09']],
  )
  const second = icpcCell(cell({ solved: true, attempts: 2, minutes: 44, tried: true }))
  assert.deepEqual([second.tone, second.main, second.sub], ['solved', '+2', '0:44'])
  // An hour and more is hours and minutes, not «70».
  assert.equal(icpcCell(cell({ solved: true, minutes: 70, tried: true })).sub, '1:10')
  assert.equal(boardMinutes(0), '0:00')
  assert.equal(boardMinutes(725), '12:05')
  // A start the contest never had gives no time rather than a made-up one.
  assert.equal(icpcCell(cell({ solved: true, minutes: null, tried: true })).sub, '')
})

test('an ICPC cell that is not solved: «−3» with a true minus, nothing for a compilation error alone', () => {
  const failed = icpcCell(cell({ attempts: 3, tried: true }))
  assert.deepEqual([failed.tone, failed.main, failed.sub], ['failed', '−3', ''])
  assert.equal(failed.main.codePointAt(0), 0x2212, 'U+2212, not a hyphen')
  // A CE is tried but costs no attempt (shared/contests · costsAttempt): the cell stays empty.
  assert.equal(icpcCell(cell({ tried: true })).tone, 'empty')
  assert.equal(icpcCell(cell()).tone, 'empty')
})

test('a frozen ICPC cell says only «?» and how many tries — never that something is being judged', () => {
  const frozen = icpcCell(cell({ attempts: 1, frozen: 2, tried: true }))
  assert.deepEqual([frozen.tone, frozen.main, frozen.sub], ['frozen', '?', '3 поп.'])
  // Frozen outranks pending: «…» would already say more than the freeze allows.
  assert.equal(icpcCell(cell({ frozen: 1, pending: 1, tried: true })).main, '?')
  // A cell solved before the freeze stays solved: later attempts never counted.
  assert.equal(icpcCell(cell({ solved: true, minutes: 30, frozen: 2, tried: true })).tone, 'solved')
  setLocaleResolver(() => 'en')
  assert.equal(icpcCell(cell({ frozen: 1, tried: true })).sub, '1 try')
  assert.equal(icpcCell(cell({ frozen: 2, tried: true })).sub, '2 tries')
})

test('a pending ICPC cell: «…» with the viewer’s own test, or the misses so far', () => {
  const own = icpcCell(cell({ pending: 1, tried: true }), 7)
  assert.deepEqual([own.tone, own.main, own.sub, own.busy], ['pending', '…', 'тест 7', true])
  assert.equal(icpcCell(cell({ pending: 1, attempts: 2, tried: true })).sub, '−2')
  assert.equal(icpcCell(cell({ pending: 1, tried: true })).sub, '')
})

test('an IOI cell: the full score solid, a part tinted with a bar as long as the share, a zero in red', () => {
  const full = ioiCell(cell({ solved: true, score: 100, tried: true }), 100)
  assert.deepEqual([full.tone, full.main, full.bar], ['first', '100', null])
  const part = ioiCell(cell({ score: 75, tried: true }), 100)
  assert.deepEqual([part.tone, part.main, part.bar], ['solved', '75', 0.75])
  const zero = ioiCell(cell({ score: 0, attempts: 1, tried: true }), 100)
  assert.deepEqual([zero.tone, zero.main, zero.bar], ['failed', '0', null])
  assert.equal(ioiCell(cell(), 100).tone, 'empty')
  // A score being improved keeps its number: the points earned stay earned.
  const busy = ioiCell(cell({ score: 60, pending: 1, tried: true }), 100, 3)
  assert.deepEqual([busy.tone, busy.main, busy.busy, busy.sub], ['solved', '60', true, 'тест 3'])
  // Nothing judged yet and one being judged: the pending face.
  assert.equal(ioiCell(cell({ pending: 1, tried: true }), 100).tone, 'pending')
  // A problem worth other than a hundred.
  assert.equal(ioiCell(cell({ score: 30, tried: true }), 60).bar, 0.5)
  assert.equal(cellFace('ioi', cell({ score: 30, tried: true }), 60).main, '30')
  assert.equal(cellFace('icpc', cell({ attempts: 1, tried: true }), 100).main, '−1')
})

test('every cell that shows something says it in words for a screen reader', () => {
  assert.match(icpcCell(cell({ solved: true, attempts: 2, minutes: 44, first: true, tried: true })).label, /0:44.*2.*первым/)
  assert.match(icpcCell(cell({ attempts: 3, tried: true })).label, /не решено.*3/)
  assert.match(ioiCell(cell({ score: 75, tried: true }), 100).label, /75 из 100/)
  assert.equal(icpcCell(cell()).label, '')
})

const row = (id: string, place: number, cells: StandingCell[] = []): StandingRow => ({
  place,
  entrantId: id,
  name: `Участник ${id}`,
  cells,
  solved: 0,
  penalty: 0,
  score: 0,
  improvedAt: null,
})

test('«Рядом со мной» is my row and three on either side, clipped at the ends', () => {
  const rows = Array.from({ length: 34 }, (_, i) => row(`e${i + 1}`, i + 1))
  const middle = nearRows(rows, 'e10')
  assert.deepEqual(middle.rows.map((r) => r.place), [7, 8, 9, 10, 11, 12, 13])
  assert.equal(middle.from, 6)
  assert.equal(middle.found, true)
  assert.deepEqual(nearRows(rows, 'e2').rows.map((r) => r.place), [1, 2, 3, 4, 5])
  assert.deepEqual(nearRows(rows, 'e34').rows.map((r) => r.place), [31, 32, 33, 34])
  // Not on the board: the whole board, and the page knows to grey the toggle.
  const absent = nearRows(rows, 'stranger')
  assert.equal(absent.found, false)
  assert.equal(absent.rows.length, 34)
  assert.equal(nearRows(rows, null).found, false)
})

test('the projector names the first solvers the board marked, and only those', () => {
  const rows = [
    row('a', 1, [cell({ solved: true, first: true }), cell(), cell({ frozen: 1 })]),
    row('b', 2, [cell({ solved: true }), cell({ solved: true, first: true }), cell()]),
  ]
  assert.deepEqual(firstSolvers(rows, [{ letter: 'A' }, { letter: 'B' }, { letter: 'C' }]), [
    { letter: 'A', name: 'Участник a' },
    { letter: 'B', name: 'Участник b' },
  ])
})

/* -------------------------------------------------------------- the rail */

const mine = (over: Partial<ProblemMine> = {}): ProblemMine => ({
  solved: false,
  attempts: 0,
  pending: false,
  pendingTest: null,
  score: null,
  attemptsLeft: null,
  ...over,
})

test('the rail: green with «+1», red with «−2», dashed with «тест 7», an outline when untried', () => {
  assert.deepEqual(railFace('icpc', 100, mine({ solved: true }), null), { tone: 'solved', mark: '+', label: 'решено' })
  assert.equal(railFace('icpc', 100, mine({ solved: true, attempts: 1 }), null).mark, '+1')
  assert.deepEqual([railFace('icpc', 100, mine({ attempts: 2 }), null).tone, railFace('icpc', 100, mine({ attempts: 2 }), null).mark], ['failed', '−2'])
  assert.deepEqual(railFace('icpc', 100, mine(), { test: 7 }).mark, 'тест 7')
  // The page's snapshot says pending; the live list knows the test.
  assert.equal(railFace('icpc', 100, mine({ pending: true, pendingTest: 3 }), null).mark, 'тест 3')
  assert.equal(railFace('icpc', 100, mine({ pending: true, pendingTest: 3 }), { test: 5 }).mark, 'тест 5')
  assert.equal(railFace('icpc', 100, mine({ pending: true }), { test: null }).mark, '…')
  assert.equal(railFace('icpc', 100, mine(), null).tone, 'untried')
  assert.equal(railFace('icpc', 100, null, null).tone, 'untried')
  // Solved stays green while a resubmission is judged.
  assert.equal(railFace('icpc', 100, mine({ solved: true }), { test: 2 }).tone, 'solved')
})

test('the IOI rail carries the best score: full green, partial tinted, zero red', () => {
  assert.deepEqual([railFace('ioi', 100, mine({ solved: true, score: 100 }), null).tone, railFace('ioi', 100, mine({ solved: true, score: 100 }), null).mark], ['solved', '100'])
  assert.deepEqual([railFace('ioi', 100, mine({ score: 85 }), null).tone, railFace('ioi', 100, mine({ score: 85 }), null).mark], ['partial', '85'])
  assert.equal(railFace('ioi', 100, mine({ score: 0, attempts: 1 }), null).tone, 'failed')
  assert.equal(railFace('ioi', 100, mine(), null).tone, 'untried')
})

test('the live run of a problem is its newest unjudged submission and the test it is on', () => {
  const list = [
    submission({ id: 'a', number: 4, state: 'running', progress: 6, total: 22 }),
    submission({ id: 'b', number: 5, state: 'queued', progress: null }),
    submission({ id: 'c', number: 6, problemId: 'other', state: 'running', progress: 1 }),
  ]
  assert.deepEqual(liveRun(list, 'p3'), { test: null }, 'the newest one, queued, has no test yet')
  assert.deepEqual(liveRun(list.slice(0, 1), 'p3'), { test: 7 })
  assert.equal(liveRun([submission()], 'p3'), null)
})

/* ---------------------------------------------------------- submissions */

test('the badge says the code, or «…» while the judge has not spoken', () => {
  assert.equal(verdictCode(submission()), 'WA')
  assert.equal(verdictCode(submission({ state: 'running', verdict: null })), '…')
  assert.equal(verdictCode(submission({ state: 'failed', verdict: null })), 'SE')
  assert.equal(submissionTone(submission({ verdict: 'OK' })), 'positive')
  assert.equal(submissionTone(submission({ verdict: 'TL' })), 'warning')
  assert.equal(submissionTone(submission({ verdict: 'CE' })), 'neutral')
  assert.equal(submissionTone(submission({ state: 'queued', verdict: null })), 'accent')
})

test('the line of a submission under its problem (K1)', () => {
  assert.equal(submissionHead(submission({ state: 'running', verdict: null, progress: 11, total: 18 }), 'icpc'), 'Проверяется · тест 12 из 18')
  assert.equal(submissionHead(submission(), 'icpc'), 'Неправильный ответ · тест 4')
  assert.equal(submissionHead(submission({ verdict: 'TL', failedTest: 9 }), 'icpc'), 'Превышено время · тест 9')
  assert.equal(submissionHead(submission({ verdict: 'OK', failedTest: null, total: 24, passed: 24 }), 'icpc'), 'Принято · 24 теста')
  assert.equal(submissionHead(submission({ verdict: 'CE', failedTest: null }), 'icpc'), 'Ошибка компиляции · без штрафа')
  assert.equal(submissionHead(submission({ state: 'queued', verdict: null }), 'icpc'), 'В очереди')
  assert.equal(submissionHead(submission({ verdict: 'WA', score: 60 }), 'ioi'), 'Неправильный ответ · 60 баллов')
  assert.equal(submissionHead(submission({ late: true }), 'icpc'), 'Неправильный ответ · дорешивание · тест 4')
  setLocaleResolver(() => 'en')
  assert.equal(submissionHead(submission({ verdict: 'OK', total: 1 }), 'icpc'), 'Accepted · 1 test')
  assert.equal(submissionHead(submission({ verdict: 'OK', total: 24 }), 'icpc'), 'Accepted · 24 tests')
})

test('the verdict column (K2) leaves the test to its own column', () => {
  assert.equal(verdictLine(submission(), 'icpc'), 'Неправильный ответ')
  assert.equal(verdictLine(submission({ verdict: 'OK', total: 24 }), 'icpc'), 'Принято · 24 теста')
  assert.equal(verdictLine(submission({ state: 'failed', verdict: 'SE' }), 'icpc'), 'Ошибка проверки · без штрафа')
  assert.equal(testColumn(submission()), '4')
  assert.equal(testColumn(submission({ state: 'running', verdict: null, progress: 7, total: 22 })), '7/22')
  assert.equal(testColumn(submission({ verdict: 'OK', failedTest: null })), '—')
})

test('the phone’s short line names a failed example as one (K5)', () => {
  const samples = [{ ordinal: 1 }, { ordinal: 2 }]
  assert.equal(phoneHead(submission({ failedTest: 2 }), 'icpc', 1000, samples), 'тест 2 · пример')
  assert.equal(phoneHead(submission({ verdict: 'TL', failedTest: 9 }), 'icpc', 1000, samples), 'тест 9 · > 1 с')
  assert.equal(phoneHead(submission({ failedTest: 4 }), 'icpc', 1000, samples), 'тест 4')
})

test('the running test is the one after those done, never past the last', () => {
  assert.equal(currentTest(submission({ state: 'running', progress: 6, total: 22 })), 7)
  assert.equal(currentTest(submission({ state: 'running', progress: 22, total: 22 })), 22)
  assert.equal(currentTest(submission({ state: 'queued', progress: null })), null)
})

test('the strip of tests: passed, failed, skipped, the current one and the rest', () => {
  assert.deepEqual(
    stripCells(submission({ state: 'running', verdict: null, total: 6, progress: 2, strip: ['OK', 'OK'] })),
    ['ok', 'ok', 'current', 'todo', 'todo', 'todo'],
  )
  assert.deepEqual(
    stripCells(submission({ total: 4, strip: ['OK', 'WA', 'skipped', 'skipped'] })),
    ['ok', 'fail', 'skip', 'skip'],
  )
  // A run the strip has not caught up with: finished tests are «done», not guessed green.
  assert.deepEqual(
    stripCells(submission({ state: 'running', verdict: null, total: 4, progress: 2, strip: [] })),
    ['done', 'done', 'current', 'todo'],
  )
  assert.equal(stripNote(submission({ passed: 1, total: 18, strip: ['OK', 'WA', 'skipped'] })), '1 из 18 пройден · дальше проверка остановилась')
  assert.equal(stripNote(submission({ passed: 5, total: 18, strip: ['OK', 'OK', 'OK', 'OK', 'OK', 'WA'] })), '5 из 18 пройдено')
  assert.equal(stripNote(submission({ verdict: 'OK', passed: 18, total: 18 })), '')
})

/* --------------------------------------------------------- measurements */

test('seconds and memory are written the reader’s way', () => {
  assert.equal(secondsValue(40), '0,04')
  assert.equal(timeWords(80), '0,08 с')
  assert.equal(overLimitValue(1000), '> 1,00')
  assert.equal(overLimitWords(1000), '> 1 с')
  assert.equal(limitTime(1000), '1 с')
  assert.equal(limitTime(2500), '2,5 с')
  assert.equal(limitMemory(256), '256 МБ')
  assert.equal(memoryWords(12 * 1024), '12 МБ')
  assert.equal(memoryWords(1638), '1,6 МБ')
  assert.equal(memoryWords(640), '640 КБ')
  assert.equal(memoryWords(null), '—')
  assert.equal(usageWords(submission(), 1000), '0,08 с · 12 МБ')
  assert.equal(usageWords(submission({ verdict: 'TL', timeMs: 1020, memoryKb: 31 * 1024 }), 1000), '> 1 с · 31 МБ')
  assert.equal(usageWords(submission({ timeMs: null, memoryKb: null }), 1000), '')
  setLocaleResolver(() => 'en')
  assert.equal(timeWords(80), '0.08 s')
  assert.equal(memoryWords(12 * 1024), '12 MB')
})

test('the limits line: time, memory and how the answer is checked', () => {
  assert.equal(checkerWords('tokens', 0), 'по словам')
  assert.equal(checkerWords('float', 1e-6), 'числа ± 1e-6')
  assert.equal(checkerWords('float', 0.01), 'числа ± 0,01')
  assert.equal(limitsLine({ timeLimitMs: 1000, memoryMb: 256, checker: 'tokens', checkerEpsilon: 0 }), '1 с · 256 МБ · по словам')
})

/* -------------------------------------------------------------- header */

test('the countdown points to the start, then to the end, then nowhere', () => {
  const start = Date.UTC(2026, 9, 30, 10, 0)
  const contest = { state: 'live' as const, startsAt: start, endsAt: start + 120 * MINUTE }
  assert.deepEqual(contestCountdown(contest, start - MINUTE), { kind: 'start', at: start })
  assert.deepEqual(contestCountdown(contest, start + MINUTE), { kind: 'end', at: start + 120 * MINUTE })
  assert.equal(contestCountdown(contest, start + 121 * MINUTE), null)
  assert.equal(contestCountdown({ ...contest, endsAt: null }, start + MINUTE), null)
  assert.equal(contestCountdown({ ...contest, state: 'finished' }, start + MINUTE), null)
})

test('the header line, the figures and the badge (K1)', () => {
  assert.equal(
    contestMeta({ rules: 'icpc', problems: 6, entrants: 34, penaltyMinutes: 20 }),
    'Контест · правила ICPC · 6 задач · 34 участника · штраф 20 мин за попытку',
  )
  // Before the start the problems are not sent: no «0 задач».
  assert.equal(contestMeta({ rules: 'ioi', problems: 0, entrants: 1, penaltyMinutes: 20 }), 'Контест · правила IOI · 1 участник')
  assert.equal(ofWords(5, 34), '5 из 34')
  assert.equal(ofWords(null, 34), '—')
  assert.deepEqual(phaseBadge('open'), { word: 'ИДЁТ', tone: 'accent', form: 'filled' })
  assert.deepEqual(phaseBadge('over'), { word: 'ЗАВЕРШЕНО', tone: 'neutral', form: 'filled' })
  assert.equal(phaseBadge('soon').form, 'outline')
  setLocaleResolver(() => 'en')
  assert.equal(
    contestMeta({ rules: 'icpc', problems: 1, entrants: 2, penaltyMinutes: 20 }),
    'Contest · ICPC rules · 1 problem · 2 participants · 20 min penalty per attempt',
  )
})

/* ------------------------------------------------------ languages, files */

const languages: LanguageOption[] = [
  { id: 'python3', label: 'Python 3.11', available: true },
  { id: 'cpp20', label: 'C++20 · g++ 12', available: true },
  { id: 'c17', label: 'C17 · gcc 12', available: false },
]

test('the editor opens in the language last used, never in one the image cannot run', () => {
  assert.equal(pickLanguage(languages, ['cpp20']), 'cpp20')
  assert.equal(pickLanguage(languages, ['c17', null, 'python3']), 'python3')
  assert.equal(pickLanguage(languages, [null, undefined]), 'python3')
  assert.equal(pickLanguage([languages[2]], ['c17']), null)
  assert.equal(languageLabel('cpp20', languages), 'C++20 · g++ 12')
  assert.equal(languageLabel('cpp20', []), 'C++20')
})

test('a dropped file is taken by its extension, its size and the contest’s languages', () => {
  assert.deepEqual(fileChoice({ name: 'islands.CPP', size: 900 }, languages, 65536), { language: 'cpp20' })
  assert.deepEqual(fileChoice({ name: 'a.py', size: 10 }, languages, 65536), { language: 'python3' })
  assert.match((fileChoice({ name: 'notes.txt', size: 10 }, languages, 65536) as { refusal: string }).refusal, /\.py, \.cpp или \.c/)
  assert.match((fileChoice({ name: 'header.h', size: 10 }, languages, 65536) as { refusal: string }).refusal, /\.py/)
  assert.match((fileChoice({ name: 'big.py', size: 70_000 }, languages, 65536) as { refusal: string }).refusal, /64 КБ/)
  assert.match((fileChoice({ name: 'a.c', size: 10 }, languages, 65536) as { refusal: string }).refusal, /нет в образе/)
  assert.match((fileChoice({ name: 'a.c', size: 10 }, languages.slice(0, 2), 65536) as { refusal: string }).refusal, /не принимает C17/)
  // The door counts bytes, not characters.
  assert.equal(sourceBytes('ё'), 2)
})

test('drafts are kept per contest, problem and language, and a storage that throws costs nothing', () => {
  assert.equal(draftKey('c1', 'p3', 'cpp20'), 'colloq.contest.v1:c1:p3:cpp20')
  assert.notEqual(draftKey('c1', 'p3', 'cpp20'), draftKey('c1', 'p3', 'python3'))
  assert.equal(languageKey('c1', 'p3'), 'colloq.contest.v1:c1:p3:language')
  assert.equal(languageKey('c1'), 'colloq.contest.v1:c1:language')

  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
    assert.equal(writeStored('k', 'print(1)'), true)
    assert.equal(readStored('k'), 'print(1)')
    // An emptied editor removes the draft rather than keeping an empty one.
    assert.equal(writeStored('k', ''), true)
    assert.equal(readStored('k'), null)

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: private window')
      },
    })
    assert.equal(readStored('k'), null)
    assert.equal(writeStored('k', 'x'), false)
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

/* --------------------------------------------------------------- misc */

test('the examples are promised to be the first tests only when they are', () => {
  assert.match(samplesNote([{ ordinal: 1 }, { ordinal: 2 }]), /^Примеры — первые тесты проверки/)
  assert.match(samplesNote([{ ordinal: 2 }, { ordinal: 1 }]), /^Примеры — первые тесты проверки/)
  assert.match(samplesNote([{ ordinal: 3 }]), /^Примеры входят в тесты проверки/)
})

test('the compiler’s log: the gcc words coloured, the first error’s line found', () => {
  assert.deepEqual(logPieces("solution.cpp:14:5: error: 'queue' was not declared"), [
    { text: 'solution.cpp:14:5: ', kind: null },
    { text: 'error:', kind: 'error' },
    { text: " 'queue' was not declared", kind: null },
  ])
  assert.equal(logPieces("solution.cpp:2:1: note: 'std::queue' is defined")[1].kind, 'note')
  assert.deepEqual(logPieces('   14 |     queue<int> ready;'), [{ text: '   14 |     queue<int> ready;', kind: null }])
  const log = "solution.cpp: In function 'int main()':\nsolution.cpp:14:5: error: 'queue' was not declared in this scope\nsolution.cpp:2:1: note: x"
  assert.equal(firstErrorLine(log), 14)
  assert.equal(firstErrorLine('  File "solution.py", line 3\n    print(\n         ^\nSyntaxError: \'(\' was never closed'), 3)
  assert.equal(firstErrorLine('nothing here'), null)
})

test('questions come newest first by their last event', () => {
  const q = (id: string, askedAt: number, answeredAt: number | null) =>
    ({ id, problemId: null, letter: null, question: 'q', answer: null, public: false, mine: true, askedAt, answeredAt })
  assert.deepEqual(questionsOrder([q('old', 1, null), q('answered', 0, 5), q('new', 3, null)]).map((x) => x.id), ['answered', 'new', 'old'])
})

test('the shortcut hint names the key the person has', () => {
  assert.equal(sendShortcut('MacIntel'), '⌘ ↵')
  assert.equal(sendShortcut('Win32'), 'Ctrl ↵')
})

test('every word of the contest pages exists in both languages, with the same parameters and no Russian left in the English', () => {
  // The doors' words (contests-server.ts) travel in the same catalog and are the server's to check.
  const mine = Object.entries(contestMessages).filter(([key]) => !Object.hasOwn(contestServerMessages, key))
  assert.ok(mine.length > 150, `only ${mine.length} words of the pages`)
  const forms = (text: unknown): string[] => (typeof text === 'string' ? [text] : Object.values(text as Record<string, string>))
  const parameters = (text: unknown): string[] =>
    [...new Set(forms(text).flatMap((form) => [...form.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1])))].sort()
  for (const [key, pair] of mine) {
    assert.ok(pair.ru && pair.en, key)
    assert.deepEqual(parameters(pair.ru), parameters(pair.en), key)
    for (const form of forms(pair.en)) assert.doesNotMatch(form, /[А-Яа-яЁё]/, `${key}: ${form}`)
    // Every parameter filled leaves no brace behind in either language.
    const params = Object.fromEntries(parameters(pair.ru).map((name) => [name, 1]))
    for (const locale of ['ru', 'en'] as const) assert.doesNotMatch(translate(locale, key, params), /\{[a-z]+\}/i, `${key} (${locale})`)
  }
})
