/**
 * The «Контесты» list (Paper 19 · A1) mounted from its source, in the stand-in
 * document of tests/_admin-dom.mts, against a server played by the test.
 *
 * The contest doors are being written beside this screen, so the list is
 * held to the contract instead (shared/contests-api.ts): what it asks, with
 * what body, and what it draws from the answer — the placeholder while the
 * list is on its way, the groups in A1's order, the judge strip and its owner
 * controls, the inline form that makes a draft at /a/<name>, the row menu's
 * delete behind its confirmation. Every request is recorded, so a path or a
 * body that drifts from the doors table (contests.md §3) fails here first.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, type FakeElement } from './_admin-dom.mts'
import { tr } from '../shared/i18n.js'
import type { Contest } from '../shared/contests.js'
import type { ContestList, ContestListRow, ContestSettings, ContestView, JudgeStatus } from '../shared/contests-api.js'

const STUB = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`
installDom({
  // An icon is raw SVG markup, which the stand-in document does not parse.
  'web/src/components/ui/Icon.svelte': STUB('export default function Icon() {}'),
  'web/src/admin/ui/field-rows.ts': STUB('export function levelFields() { return { destroy() {} } }'),
})

/* -------------------------------------------------------------- the server */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const START = Date.now()

function contest(over: Partial<Contest>): Contest {
  return {
    id: 'c',
    slug: 'c',
    title: 'Контест',
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
    startsAt: START - 2 * HOUR,
    endsAt: START + 52 * MIN,
    upsolving: false,
    boardVisibility: 'public',
    courseId: null,
    createdBy: 'author',
    hiddenAt: null,
    revision: 1,
    createdAt: START - DAY,
    updatedAt: START - HOUR,
    ...over,
  }
}

function row(over: Partial<Contest>, extra: Partial<ContestListRow> = {}): ContestListRow {
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

let judge: JudgeStatus = { backend: 'docker', running: 2, queued: 0, slots: 4, judgedToday: 312, medianMs: 1400, paused: false }
let rows: ContestListRow[] = [
  row({ id: 'k2', slug: 'algo-k2', title: 'Алгоритмы · контрольная 2: графы' }, { course: { id: 'spring', name: 'Алгоритмы, весна' } }),
  row(
    { id: 'k3', slug: 'algo-k3', title: 'Алгоритмы · контрольная 3: строки', startsAt: START + 6 * DAY, endsAt: START + 6 * DAY + 3 * HOUR },
    { phase: 'soon', problems: 5, entrants: 0, submissions: 0, averageSolved: null },
  ),
  row(
    { id: 'hw4', slug: 'hw-4', title: 'Домашняя работа 4: деревья отрезков', state: 'draft', rules: 'ioi', startsAt: null, endsAt: null },
    { phase: 'draft', problems: 4, entrants: 0, submissions: 0, averageSolved: null, notReady: ['C', 'D'] },
  ),
  row(
    {
      id: 'hw3',
      slug: 'hw-3',
      title: 'Домашняя работа 3: динамическое программирование',
      state: 'finished',
      rules: 'ioi',
      upsolving: true,
      freezeMinutes: 0,
      startsAt: START - 8 * DAY,
      endsAt: START - DAY,
    },
    { phase: 'over', problems: 4, entrants: 41, submissions: 612, averageSolved: 212, averageOf: 400 },
  ),
]
let settings: ContestSettings = { judgeSlots: null, autoSlots: 4 }

interface Asked {
  method: string
  path: string
  body: unknown
}
const asked: Asked[] = []
/** While set, GET /api/admin/contests waits here until the test lets it go. */
let holdList: (() => void) | null = null
let holding = false

function view(c: Contest): ContestView {
  return {
    contest: c,
    phase: 'draft',
    problems: [],
    languages: [],
    course: null,
    readiness: [],
    entrants: 0,
    submissions: 0,
    judge,
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  if (!path.startsWith('/')) return realFetch(input, init)
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  asked.push({ method, path, body })
  const json = (value: unknown, status = 200) => Response.json(value, { status })
  if (method === 'GET' && path === '/api/admin/contests') {
    if (holding) await new Promise<void>((resolve) => (holdList = resolve))
    return json({ contests: rows, judge } satisfies ContestList)
  }
  if (method === 'GET' && path === '/api/admin/contests/settings') return json(settings)
  if (method === 'PUT' && path === '/api/admin/contests/settings') {
    settings = { ...settings, judgeSlots: (body as { judgeSlots: number | null }).judgeSlots }
    judge = { ...judge, slots: settings.judgeSlots ?? settings.autoSlots }
    return json(settings)
  }
  if (method === 'POST' && path === '/api/admin/contests/judge/pause') {
    judge = { ...judge, paused: (body as { paused: boolean }).paused }
    return json(judge)
  }
  if (method === 'POST' && path === '/api/admin/contests') {
    const made = contest({ id: 'fresh', state: 'draft', ...(body as { title: string; slug: string }), startsAt: null, endsAt: null })
    return json(view(made), 201)
  }
  const one = /^\/api\/admin\/contests\/([^/]+)$/.exec(path)
  if (method === 'DELETE' && one) {
    rows = rows.filter((r) => r.contest.id !== one[1])
    return new Response(null, { status: 204 })
  }
  const hide = /^\/api\/admin\/contests\/([^/]+)\/(hide|show)$/.exec(path)
  if (method === 'POST' && hide) {
    rows = rows.map((r) => (r.contest.id === hide[1] ? { ...r, contest: { ...r.contest, hiddenAt: hide[2] === 'hide' ? Date.now() : null } } : r))
    return json(view(rows.find((r) => r.contest.id === hide[1])!.contest))
  }
  // Anything else is a door the list has no business asking.
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
  // The owner: the strip's pause and slots and the rows' delete are theirs.
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

async function until(ready: () => boolean, what: string, root: FakeElement): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await settle(1)
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`never happened: ${what}; the page reads «${textOf(root).slice(0, 600)}»`)
}

const textOf = (root: FakeElement): string => root.textContent.replace(/[\s  ]+/g, ' ')
const buttonWith = (root: FakeElement, text: string) =>
  root.querySelectorAll('button').find((one) => one.textContent.replace(/\s+/g, ' ').trim().includes(text)) ?? null

function type(field: FakeElement, value: string): void {
  ;(field as unknown as { value: string }).value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mountList(navigate: (path: string) => void = () => {}): Promise<{ root: FakeElement; close: () => void }> {
  const Contests = (await import('../web/src/admin/screens/Contests.svelte')).default
  const root = document.createElement('div') as unknown as FakeElement
  document.body.appendChild(root as never)
  const app = svelte.mount(Contests, { target: root as never, props: { open: null, navigate } })
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

test('the list stands under its own placeholder while asked, then draws A1’s groups and rows', async () => {
  holding = true
  const screen = await mountList()
  try {
    assert.ok(asked.some((one) => one.method === 'GET' && one.path === '/api/admin/contests'), 'the list is asked')
    const placeholders = screen.root.querySelectorAll('[aria-busy="true"]')
    assert.ok(placeholders.some((one) => one.getAttribute('aria-label') === tr('admin.contests.loading')), 'named by its loading words')
    for (const one of placeholders) assert.equal(one.getAttribute('role'), 'status')
    assert.ok(!textOf(screen.root).includes(tr('admin.contests.none')), 'nothing claims there are no contests before the answer')

    holding = false
    holdList?.()
    await until(() => textOf(screen.root).includes('Алгоритмы · контрольная 2: графы'), 'the rows drawn', screen.root)
    const text = textOf(screen.root)

    // The groups in A1's order, each with its count.
    const headings = screen.root.querySelectorAll('.contest-group').map((one) => one.textContent.replace(/\s+/g, ' ').trim())
    assert.deepEqual(headings, [
      `${tr('admin.contests.group.open')} 1`,
      `${tr('admin.contests.group.soon')} 1`,
      `${tr('admin.contests.group.draft')} 1`,
      `${tr('admin.contests.group.over')} 1`,
    ])
    // The rows' own lines: the address, the meta, the state notes.
    assert.ok(text.includes('/a/algo-k2'), 'the address')
    assert.ok(text.includes('ICPC · Python, C++ · курс «Алгоритмы, весна»'), 'the meta line with the course')
    assert.ok(text.includes('ICPC · Python, C++ · все эталоны проходят'), 'a coming contest whose references pass')
    assert.match(text, /заморожен с \d\d:\d\d/, 'the live one is frozen')
    assert.ok(text.includes('эталон не проверен: C, D'), 'what keeps the draft closed')
    assert.ok(text.includes('дорешивание открыто'), 'upsolving on the finished one')
    assert.ok(text.includes('сроки не заданы'), 'a draft without dates')
    // The fixture ends 52 minutes after the file loaded; the screen's own
    // clock has moved on by the time it draws.
    assert.match(text, /осталось 5[12] мин/, 'the live one counts down')
    assert.ok(text.includes('3,1 из 6') && text.includes('212 из 400'), 'the averages, ICPC and IOI')

    // The judge strip and the owner's controls on it.
    assert.ok(text.includes('проверяет 2 посылки · 0 ждут'), 'what the judge does')
    assert.ok(text.includes('без сети · сегодня проверено 312, в среднем 1,4 с'), 'on what terms')
    assert.ok(buttonWith(screen.root, 'до 4 одновременно'), 'the slots are the owner’s to change')
    assert.ok(buttonWith(screen.root, tr('admin.contests.judge.pause')), 'and the pause')
  } finally {
    screen.close()
    holding = false
  }
})

test('a draft is made from the inline form at /a/<name>, and the screen goes to it', async () => {
  const went: string[] = []
  const screen = await mountList((path) => went.push(path))
  try {
    await until(() => buttonWith(screen.root, tr('admin.contests.new')) !== null, 'the page action', screen.root)
    buttonWith(screen.root, tr('admin.contests.new'))!.click()
    await settle()
    const title = screen.root.querySelectorAll('input').find((one) => one.getAttribute('aria-label') === tr('admin.contests.titleLabel'))
    const slug = screen.root.querySelectorAll('input').find((one) => one.getAttribute('aria-label') === tr('admin.contests.slugLabel'))
    assert.ok(title && slug, 'the title and the address')
    assert.ok(textOf(screen.root).includes('/a/'), 'the address is a contest’s: /a/, not a competition’s /k/')
    type(title, 'Алгоритмы · контрольная 4')
    await settle()
    assert.equal((slug as unknown as { value: string }).value, 'algoritmy-kontrolnaya-4', 'the title suggests the address')

    asked.length = 0
    buttonWith(screen.root, tr('admin.contests.createDraft'))!.click()
    await until(() => went.length > 0, 'the screen went to the draft', screen.root)
    const made = asked.find((one) => one.method === 'POST' && one.path === '/api/admin/contests')
    assert.deepEqual(made?.body, { title: 'Алгоритмы · контрольная 4', slug: 'algoritmy-kontrolnaya-4' })
    assert.deepEqual(went, ['/admin/contests/fresh'])
  } finally {
    screen.close()
  }
})

test('an address the form cannot take is said in words, and nothing is sent', async () => {
  const screen = await mountList()
  try {
    await until(() => buttonWith(screen.root, tr('admin.contests.new')) !== null, 'the page action', screen.root)
    buttonWith(screen.root, tr('admin.contests.new'))!.click()
    await settle()
    const inputs = screen.root.querySelectorAll('input')
    type(inputs.find((one) => one.getAttribute('aria-label') === tr('admin.contests.titleLabel'))!, 'Строки')
    type(inputs.find((one) => one.getAttribute('aria-label') === tr('admin.contests.slugLabel'))!, 'new')
    await settle()
    asked.length = 0
    buttonWith(screen.root, tr('admin.contests.createDraft'))!.click()
    await settle()
    assert.ok(textOf(screen.root).includes(tr('admin.contests.slug.reserved')), 'the refusal is in the form')
    assert.ok(!asked.some((one) => one.method === 'POST'), 'and the server was not asked')
  } finally {
    screen.close()
  }
})

test('the judge is paused from the strip, and its slots set from it', async () => {
  const screen = await mountList()
  try {
    await until(() => buttonWith(screen.root, tr('admin.contests.judge.pause')) !== null, 'the pause', screen.root)
    asked.length = 0
    buttonWith(screen.root, tr('admin.contests.judge.pause'))!.click()
    await until(() => buttonWith(screen.root, tr('admin.contests.judge.resume')) !== null, 'the strip says paused', screen.root)
    assert.deepEqual(asked.find((one) => one.path === '/api/admin/contests/judge/pause')?.body, { paused: true })
    assert.ok(textOf(screen.root).includes('на паузе'), 'the head says so')

    buttonWith(screen.root, 'до 4 одновременно')!.click()
    await until(
      () => screen.root.querySelectorAll('input').some((one) => one.getAttribute('aria-label') === tr('admin.contests.judge.slotsLabel')),
      'the slots editor',
      screen.root,
    )
    assert.ok(asked.some((one) => one.method === 'GET' && one.path === '/api/admin/contests/settings'), 'the saved setting is read first')
    const auto = screen.root.querySelectorAll('input').find((one) => one.getAttribute('type') === 'checkbox')!
    ;(auto as unknown as { checked: boolean }).checked = false
    auto.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    const slots = screen.root.querySelectorAll('input').find((one) => one.getAttribute('aria-label') === tr('admin.contests.judge.slotsLabel'))!
    type(slots, '6')
    await settle()
    asked.length = 0
    const save = screen.root
      .querySelectorAll('button')
      .filter((one) => one.textContent.trim() === tr('admin.contests.save'))
      .at(-1)!
    save.click()
    await until(() => textOf(screen.root).includes('до 6 одновременно'), 'the strip reads the new number', screen.root)
    assert.deepEqual(asked.find((one) => one.method === 'PUT')?.body, { judgeSlots: 6 })
  } finally {
    screen.close()
    judge = { ...judge, paused: false }
  }
})

test('a contest is deleted from its row behind a confirmation that names it', async () => {
  const screen = await mountList()
  try {
    await until(() => textOf(screen.root).includes('Домашняя работа 4'), 'the rows', screen.root)
    const menu = screen.root
      .querySelectorAll('button[aria-haspopup="menu"]')
      .find((one) => (one.getAttribute('aria-label') ?? '').includes('Домашняя работа 4'))!
    menu.click()
    await settle()
    screen.root.querySelectorAll('[role="menuitem"]').find((one) => one.textContent.includes(tr('admin.contests.menu.delete')))!.click()
    await settle()
    const dialog = screen.root.querySelector('[role="dialog"]')
    assert.ok(dialog, 'a confirmation, not a delete at once')
    assert.ok(dialog.textContent.includes('Удалить «Домашняя работа 4: деревья отрезков»?'), 'it names the contest')
    assert.ok(!asked.some((one) => one.method === 'DELETE'), 'nothing is deleted before the press')
    asked.length = 0
    buttonWith(dialog, tr('admin.contests.deleteConfirm'))!.click()
    await until(() => !textOf(screen.root).includes('Домашняя работа 4'), 'the row gone', screen.root)
    assert.ok(asked.some((one) => one.method === 'DELETE' && one.path === '/api/admin/contests/hw4'), 'the door is the contest’s own')
    assert.ok(asked.some((one) => one.method === 'GET' && one.path === '/api/admin/contests'), 'and the list is read again')
    assert.equal(screen.root.querySelector('[role="dialog"]'), null, 'the dialog closed')
  } finally {
    screen.close()
  }
})

test('the search narrows the groups to what matches, the course included', async () => {
  const screen = await mountList()
  try {
    await until(() => textOf(screen.root).includes('Алгоритмы · контрольная 3'), 'the rows', screen.root)
    const search = screen.root.querySelectorAll('input').find((one) => one.getAttribute('type') === 'search')!
    type(search, 'весна')
    await settle()
    const text = textOf(screen.root)
    assert.ok(text.includes('контрольная 2: графы'), 'the contest of the course «Алгоритмы, весна»')
    assert.ok(!text.includes('контрольная 3: строки'), 'and nothing else')
    type(search, 'такого нет')
    await settle()
    assert.ok(textOf(screen.root).includes('По «такого нет» ничего не нашлось'), 'an empty search says so')
  } finally {
    screen.close()
  }
})
