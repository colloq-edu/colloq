/**
 * One contest in the panel, mounted from source against a server played by
 * the test (Paper 19 · A2, A3, A4): the draft's editor, a problem's editor,
 * and the console of a live contest with its stream.
 *
 * The doors are being written beside these screens; the screens are held to
 * the contract (shared/contests-api.ts) instead: what they ask, with what
 * body, and what they draw from the answer. The code editor and the board's
 * table are the participant pages' components and need a real browser —
 * they stand in as empty components here; the console's stream is a hand-
 * held EventSource the test pushes states through.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, type FakeElement } from './_admin-dom.mts'
import { tr } from '../shared/i18n.js'
import type { Contest, ContestTest } from '../shared/contests.js'
import type {
  AdminQuestion,
  AdminSubmissionDetail,
  AdminSubmissionRow,
  ContestLiveState,
  ContestView,
  JudgeStatus,
  ProblemView,
  ReferenceStatus,
} from '../shared/contests-api.js'

const STUB = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`
const EMPTY = STUB('export default function Empty() {}')
installDom({
  'web/src/components/ui/Icon.svelte': EMPTY,
  'web/src/admin/ui/field-rows.ts': STUB('export function levelFields() { return { destroy() {} } }'),
  'web/src/components/contests/CodeEditor.svelte': EMPTY,
  'web/src/components/contests/StandingsTable.svelte': EMPTY,
})

/* ------------------------------------------------------------- the stream */

class HeldStream {
  static all: HeldStream[] = []
  readonly url: string
  onerror: ((event: unknown) => void) | null = null
  closed = false
  #listeners = new Map<string, ((event: { data: string }) => void)[]>()
  constructor(url: string) {
    this.url = url
    HeldStream.all.push(this)
  }
  addEventListener(type: string, fn: (event: { data: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn])
  }
  close(): void {
    this.closed = true
  }
  push(state: ContestLiveState): void {
    for (const fn of this.#listeners.get('state') ?? []) fn({ data: JSON.stringify(state) })
  }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: HeldStream })

/* -------------------------------------------------------------- fixtures */

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.now()
const judge: JudgeStatus = { backend: 'docker', running: 1, queued: 0, slots: 4, judgedToday: 12, medianMs: 900, paused: false }

function contest(over: Partial<Contest>): Contest {
  return {
    id: 'c',
    slug: 'c',
    title: 'Контест',
    blurb: '',
    description: '',
    state: 'draft',
    rules: 'icpc',
    penaltyMinutes: 20,
    freezeMinutes: 60,
    unfrozenAt: null,
    attemptsPerProblem: 0,
    languages: ['python3', 'cpp20'],
    environment: 'base',
    startsAt: null,
    endsAt: null,
    upsolving: false,
    boardVisibility: 'public',
    courseId: null,
    createdBy: null,
    hiddenAt: null,
    revision: 1,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  }
}

const tests = (problemId: string, count: number, samples: number): ContestTest[] =>
  Array.from({ length: count }, (_, i) => ({
    problemId,
    ordinal: i + 1,
    sample: i < samples,
    group: 1,
    inputBytes: 28,
    answerBytes: i === count - 1 ? null : 2,
    answerFrom: 'upload' as const,
  }))

function problem(id: string, position: number, title: string, reference: Partial<ReferenceStatus>, count = 18): ProblemView {
  return {
    id,
    contestId: 'hw4',
    position,
    title,
    statement: 'Карта архипелага — прямоугольная сетка $n \\times m$.',
    timeLimitMs: 1000,
    memoryMb: 256,
    checker: 'tokens',
    checkerEpsilon: 1e-6,
    checkerCode: '',
    points: 'tests',
    referenceLanguage: 'python3',
    referenceSource: 'import sys\n',
    testsRevision: 1,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    letter: String.fromCharCode(65 + position),
    tests: tests(id, count, 2),
    groups: [],
    maxScore: 100,
    testBytes: 6_500_000,
    reference: {
      state: 'passes',
      verdict: 'OK',
      failedTest: null,
      timeMs: 310,
      memoryKb: 38 * 1024,
      slowestTest: 14,
      checkedAt: NOW - MIN,
      submissionId: `ref-${id}`,
      ...reference,
    },
    missingAnswers: 1,
    answersRunning: false,
  }
}

const languages = [
  { id: 'python3' as const, label: 'Python 3.11', available: true },
  { id: 'cpp20' as const, label: 'C++20 · g++ 12', available: true },
  { id: 'c17' as const, label: 'C17 · gcc 12', available: false },
]

const draft: ContestView = {
  contest: contest({ id: 'hw4', slug: 'algo-k2', title: 'Алгоритмы · контрольная 2: графы' }),
  phase: 'draft',
  problems: [
    problem('p1', 0, 'Сумма на отрезке', {}),
    problem('p2', 1, 'Мосты', { state: 'fails', verdict: 'TL', failedTest: 27, timeMs: 2100 }),
  ],
  languages,
  course: null,
  readiness: ['Эталон задачи B не проходит: TL на тесте 27.'],
  entrants: 0,
  submissions: 0,
  judge,
}

const live: ContestView = {
  ...draft,
  contest: contest({
    id: 'k2',
    slug: 'algo-k2',
    title: 'Алгоритмы · контрольная 2: графы',
    state: 'live',
    startsAt: NOW - 2 * HOUR,
    endsAt: NOW + 52 * MIN + 40_000,
  }),
  phase: 'open',
  readiness: [],
  entrants: 34,
  submissions: 187,
}

function submission(id: string, number: number, over: Partial<AdminSubmissionRow>): AdminSubmissionRow {
  return {
    id,
    contestId: 'k2',
    problemId: 'p2',
    entrantId: 'anna',
    kind: 'entrant',
    number,
    language: 'python3',
    sourceBytes: 400,
    submittedAt: NOW - 2 * MIN,
    late: false,
    state: 'done',
    verdict: 'WA',
    failedTest: 4,
    passed: 3,
    total: 31,
    score: null,
    timeMs: 50,
    memoryKb: 10 * 1024,
    progress: null,
    judgedAt: NOW - MIN,
    testsRevision: 1,
    letter: 'B',
    entrant: { id: 'anna', name: 'Анна Ким' },
    ...over,
  }
}

const feed: AdminSubmissionRow[] = [
  submission('s143', 143, { entrantId: 'timur', entrant: { id: 'timur', name: 'Тимур Ахметов' }, state: 'running', verdict: null, failedTest: null, progress: 6, letter: 'A', problemId: 'p1' }),
  submission('s142', 142, {}),
  submission('s141', 141, { entrant: { id: 'marfa', name: 'Марфа Соколова' }, verdict: 'OK', failedTest: null, passed: 31 }),
]

const detail: AdminSubmissionDetail = {
  ...feed[1],
  source: 'print(2)\n',
  compileLog: '',
  systemDetail: null,
  tests: [
    { ordinal: 1, verdict: 'OK', timeMs: 30, memoryKb: 9 * 1024, sample: true },
    { ordinal: 2, verdict: 'OK', timeMs: 40, memoryKb: 9 * 1024, sample: false },
    { ordinal: 3, verdict: 'OK', timeMs: 50, memoryKb: 10 * 1024, sample: false },
    { ordinal: 4, verdict: 'WA', timeMs: 50, memoryKb: 10 * 1024, sample: false, output: '2', answer: '3', input: '4 5', stderr: 'debug: 7', exit: '0' },
  ],
}

const question: AdminQuestion = {
  id: 'q1',
  problemId: 'p2',
  letter: 'B',
  question: 'Может ли в графе быть кратное ребро между двумя вершинами?',
  answer: null,
  public: false,
  mine: false,
  askedAt: NOW - 6 * MIN,
  answeredAt: null,
  entrant: { id: 'daniil', name: 'Даниил Орлов' },
}

/* ---------------------------------------------------------------- server */

interface Asked {
  method: string
  path: string
  body: unknown
}
const asked: Asked[] = []
let feedRows = feed

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  if (!path.startsWith('/')) return realFetch(input, init)
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  asked.push({ method, path, body })
  const json = (value: unknown, status = 200) => Response.json(value, { status })
  const bare = path.split('?')[0]
  if (method === 'GET' && bare === '/api/admin/contests/hw4') return json(draft)
  if (method === 'GET' && bare === '/api/admin/contests/k2') return json(live)
  if (method === 'PATCH' && bare === '/api/admin/contests/hw4') {
    return json({ ...draft, contest: { ...draft.contest, ...(body as object) } })
  }
  if (method === 'GET' && bare === '/api/admin/contests/hw4/submissions/ref-p1') {
    return json({ ...detail, id: 'ref-p1', kind: 'reference', entrant: null, verdict: 'OK', failedTest: null, passed: 18, total: 18, tests: [] })
  }
  if (method === 'GET' && bare === '/api/admin/contests/hw4/submissions/ref-p2') {
    return json({ ...detail, id: 'ref-p2', kind: 'reference', entrant: null, verdict: 'TL', failedTest: 27 })
  }
  if (method === 'GET' && bare === '/api/admin/contests/k2/submissions') return json({ submissions: feedRows, total: feedRows.length })
  if (method === 'GET' && bare === '/api/admin/contests/k2/submissions/s142') return json(detail)
  if (method === 'GET' && bare === '/api/admin/contests/k2/questions') return json({ questions: [question], unanswered: 1 })
  if (method === 'POST' && bare === '/api/admin/contests/k2/questions/q1/answer') {
    const sent = body as { answer: string; public: boolean }
    return json({ ...question, answer: sent.answer, public: sent.public, answeredAt: Date.now() })
  }
  if (method === 'GET' && (bare === '/api/admin/environments' || bare === '/api/admin/courses')) {
    return json(bare.endsWith('environments') ? { environments: [], gpus: null } : { courses: [] })
  }
  return json({ error: `unexpected ${method} ${path}`, reason: 'invalid' }, 500)
}) as typeof fetch

after(() => {
  globalThis.fetch = realFetch
})

/* ------------------------------------------------------------- mounting */

type Svelte = typeof import('svelte')
let svelte: Svelte

before(async () => {
  svelte = await import('svelte')
  const { adminAuth } = await import('../web/src/admin/auth.svelte.ts')
  adminAuth.me = {
    teacher: { id: 'owner', email: 'ada@example.test', name: 'Ада', role: 'owner', createdAt: 0, lastSeenAt: null, hasLink: true },
    ownerCount: 1,
  }
})

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    svelte.flushSync()
  }
}

const textOf = (root: FakeElement): string => root.textContent.replace(/[\s  ]+/g, ' ')

async function until(ready: () => boolean, what: string, root: FakeElement): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await settle(1)
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`never happened: ${what}; the page reads «${textOf(root).slice(0, 800)}»`)
}

const buttonWith = (root: FakeElement, text: string) =>
  root.querySelectorAll('button').find((one) => one.textContent.replace(/\s+/g, ' ').trim().includes(text)) ?? null

async function mount(props: Record<string, unknown>): Promise<{ root: FakeElement; close: () => void }> {
  const Contests = (await import('../web/src/admin/screens/Contests.svelte')).default
  const root = document.createElement('div') as unknown as FakeElement
  document.body.appendChild(root as never)
  const app = svelte.mount(Contests, { target: root as never, props: { navigate: () => {}, ...props } })
  await settle()
  return {
    root,
    close: () => {
      void svelte.unmount(app)
      root.remove()
    },
  }
}

/* ---------------------------------------------------------------- tests */

test('a draft opens in its editor: five sections, the problems’ references, and what keeps it closed', async () => {
  const screen = await mount({ open: 'hw4' })
  try {
    await until(() => screen.root.querySelector('h1')?.textContent === 'Алгоритмы · контрольная 2: графы', 'the editor', screen.root)
    const text = textOf(screen.root)
    for (const section of ['basics', 'problems', 'rules', 'terms', 'access']) {
      assert.ok(text.includes(tr(`admin.contests.section.${section}`)), `the «${tr(`admin.contests.section.${section}`)}» section`)
    }
    // The problem table: letters, limits, tests, and the reference column.
    assert.ok(text.includes('Сумма на отрезке') && text.includes('Мосты'))
    assert.ok(text.includes('1 с · 256 МБ'), 'the limits')
    assert.ok(text.includes('18 · 2 прим.'), 'the tests and examples')
    assert.ok(text.includes('проходит') && text.includes('0,31 с · Python'), 'a passing reference with its time')
    assert.ok(text.includes('TL на тесте 27'), 'and a failing one')
    // The languages as the image names them, the missing one said.
    assert.ok(text.includes('C++20 · g++ 12') && text.includes(tr('admin.contests.languageMissingShort')))
    // What blocks the opening, in the server's words, and the button greyed.
    assert.ok(text.includes('Эталон задачи B не проходит: TL на тесте 27.'), 'the readiness list')
    const open = screen.root.querySelectorAll('button').filter((one) => one.textContent.trim() === tr('admin.contests.openContest'))
    assert.ok(open.length > 0 && open.every((one) => one.hasAttribute('disabled')), '«Открыть контест» waits for the references')

    // Save sends the form's slice, the address included.
    asked.length = 0
    buttonWith(screen.root, tr('admin.contests.save'))!.click()
    await until(() => asked.some((one) => one.method === 'PATCH'), 'the save', screen.root)
    const sent = asked.find((one) => one.method === 'PATCH')!
    assert.equal(sent.path, '/api/admin/contests/hw4')
    assert.deepEqual(
      { ...(sent.body as object) },
      {
        title: 'Алгоритмы · контрольная 2: графы',
        slug: 'algo-k2',
        blurb: '',
        description: '',
        rules: 'icpc',
        penaltyMinutes: 20,
        freezeMinutes: 60,
        attemptsPerProblem: 0,
        languages: ['python3', 'cpp20'],
        environment: 'base',
        startsAt: null,
        endsAt: null,
        upsolving: false,
        boardVisibility: 'public',
        courseId: null,
      },
    )
  } finally {
    screen.close()
  }
})

test('a problem opens in its own editor: the statement, the tests, the reference and its strip', async () => {
  const screen = await mount({ open: 'hw4', problem: 'p2' })
  try {
    await until(() => screen.root.querySelector('h1')?.textContent === 'B. Мосты', 'the problem editor', screen.root)
    const text = textOf(screen.root)
    assert.ok(text.includes(tr('admin.contests.refBadge.fails')), 'the header says the reference fails')
    for (const section of ['statement', 'limits', 'tests', 'reference']) {
      assert.ok(text.includes(tr(`admin.contests.section.${section}`)), section)
    }
    assert.ok(text.includes('18 тестов · 6,2 МБ'), 'the tests’ count and size')
    assert.ok(text.includes(tr('admin.contests.answersFromReferenceCount', { count: 1 })), 'one answer for the reference to write')
    assert.ok(text.includes(tr('admin.contests.answer.missing')), 'the test without an answer says so')
    assert.ok(text.includes('по словам') && text.includes('свой чекер на Python'), 'the checker chips')
    assert.ok(text.includes('дольше предела'), 'a reference over the limit is said in the margin')
    // The reference's own report is asked for its run, and its failure named.
    await until(() => asked.some((one) => one.path === '/api/admin/contests/hw4/submissions/ref-p2'), 'the reference report', screen.root)
    assert.ok(textOf(screen.root).includes(tr('admin.contests.strip.fails')), 'the strip')
  } finally {
    screen.close()
  }
})

test('the console: the feed, a submission opened test by test, the waiting question answered to all', async () => {
  HeldStream.all.length = 0
  feedRows = feed
  const screen = await mount({ open: 'k2', tab: 'submissions' })
  try {
    await until(() => textOf(screen.root).includes('Тимур Ахметов'), 'the feed', screen.root)
    let text = textOf(screen.root)
    assert.ok(text.includes(tr('admin.contests.live.toEnd')) && /00:5[0-3]:\d\d/.test(text), 'the countdown to the end')
    assert.ok(text.includes('таблица заморожена с'), 'the freeze in the header')
    assert.ok(text.includes(`${tr('admin.contests.tab.submissions')} 187`), 'the tab counts the submissions')
    assert.ok(text.includes('Может ли в графе быть кратное ребро'), 'the waiting question under the drawer')
    const stream = HeldStream.all.at(-1)
    assert.equal(stream?.url, '/api/admin/contests/k2/stream', 'the console listens to its contest’s stream')

    // A row opens in the drawer.
    asked.length = 0
    screen.root.querySelectorAll('button').find((one) => one.textContent.includes('Анна Ким'))!.click()
    await until(() => textOf(screen.root).includes('Неправильный ответ на тесте 4 из 31'), 'the drawer', screen.root)
    text = textOf(screen.root)
    assert.ok(asked.some((one) => one.path === '/api/admin/contests/k2/submissions/s142'), 'the detail door')
    assert.ok(text.includes('Тесты 5–31 не запускались.'), 'the tests never reached')
    assert.ok(text.includes(tr('admin.contests.drawer.staffOnly')))
    assert.ok(text.includes('debug: 7'), 'the stderr of the failed test, for staff')

    // The stream says the submissions changed: the feed is read again.
    asked.length = 0
    const state = (submissions: string): ContestLiveState => ({ revision: 1, submissions, questions: 'q1', judge, now: Date.now() })
    stream!.push(state('v1'))
    stream!.push(state('v2'))
    await until(() => asked.some((one) => one.path.startsWith('/api/admin/contests/k2/submissions?')), 'the feed re-read', screen.root)

    // «Ответить всем».
    const card = screen.root.querySelectorAll('textarea').find((one) => one.getAttribute('aria-label') === tr('admin.contests.question.answerLabel'))!
    ;(card as unknown as { value: string }).value = 'Да, может. Ответ от этого не меняется.'
    card.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    asked.length = 0
    buttonWith(screen.root, tr('admin.contests.question.public'))!.click()
    await until(() => asked.some((one) => one.path.endsWith('/questions/q1/answer')), 'the answer sent', screen.root)
    assert.deepEqual(asked.find((one) => one.path.endsWith('/questions/q1/answer'))?.body, {
      answer: 'Да, может. Ответ от этого не меняется.',
      public: true,
    })
  } finally {
    screen.close()
  }
  assert.ok(HeldStream.all.every((one) => one.closed), 'leaving the console closes its stream')
})
