/**
 * The panel's placeholders, screen by screen, with the screens really
 * running: while a screen's first request is on its way it stands under a
 * placeholder named by its own loading words (role=status, aria-busy), and
 * once the server answers the placeholder is gone and the answer is drawn.
 *
 * The owner, 22 Oct 2026: «у списка курсов и окружений и тд нет скелетонов
 * как у занятий например и соревнований, а должно быть в админке везде».
 * Courses said «Курсов пока нет» to an owner with courses while the list was
 * asked; environments, teachers and the audit log drew an empty band; the
 * oracle drew nothing; a course, a class page, a machine and the resources
 * tab printed a sentence in the middle of the page.
 *
 * Each screen is mounted from its source (compiled for the browser into a
 * stand-in document, tests/_admin-dom.mts) against the real server: every
 * request it makes is held at the door until the test lets it through, so
 * "pending" and "answered" are two moments the test chooses, not timings.
 * The rules the screens already followed are held too: a reload under data
 * already drawn does not go grey again, a refusal is said in words rather
 * than under a placeholder, and an empty list is still said to be empty.
 * So are the parts of a screen that land on their own after the screen
 * itself: a section waits under its own placeholder and claims nothing
 * («0 из 0», «Очередь пуста», «Мои 0») before its answer, and what is
 * drawn early is never what a later answer pushes down the page.
 */
import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { Machine, close, code, serve } from './_remote.mts'
import { installDom, type FakeElement } from './_admin-dom.mts'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import { tr } from '../shared/i18n.js'

const STUB = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`
installDom({
  // An icon is raw SVG markup, which the stand-in document does not parse.
  'web/src/components/ui/Icon.svelte': STUB('export default function Icon() {}'),
  // Levelling a row of fields measures layout, which it does not have.
  'web/src/admin/ui/field-rows.ts': STUB('export function levelFields() { return { destroy() {} } }'),
})

/* ------------------------------------------------------------- the door */

const realFetch = globalThis.fetch
let home = ''
let cookie = ''

interface Asked {
  path: string
  release: () => void
  /** Answers it in the test's own words instead of the server's: a refusal, an empty list. */
  answer: (status: number, body: unknown) => void
}

/** The requests the screens made that are still held at the door. */
const asked: Asked[] = []
let holding = true
/** While set, the door holds only the requests it picks, and lets every other one through. */
let holdOnly: ((path: string) => boolean) | null = null
/** Requests let through whose answer has not come back yet. */
let inFlight = 0
/** A refusal as the server words one. */
const refusal = (error: string) => ({ error, reason: 'invalid' })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.startsWith('/')) return realFetch(input, init)
  const forward = async (): Promise<Response> => {
    const headers = { ...(init?.headers as Record<string, string> | undefined), cookie }
    inFlight += 1
    try {
      return await realFetch(`${home}${url}`, { ...init, headers })
    } finally {
      inFlight -= 1
    }
  }
  if (!holding || (holdOnly && !holdOnly(url))) return forward()
  return new Promise<Response>((resolve, reject) => {
    asked.push({
      path: url,
      release: () => void forward().then(resolve, reject),
      answer: (status, body) => resolve(Response.json(body, { status })),
    })
  })
}) as typeof fetch

type Svelte = typeof import('svelte')
let svelte: Svelte

/** Runs what the screens scheduled: answers that arrived, effects they started. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    svelte.flushSync()
  }
}

/** Waits until `ready` holds, while answers keep arriving over the loopback. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    await settle(1)
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`never happened: ${what}; the page reads «${document.body.textContent.replace(/\s+/g, ' ').slice(0, 600)}»`)
}

/** Every request the screen made has been answered, and what it started from the answers has run. */
async function idle(): Promise<void> {
  await until(() => inFlight === 0 && asked.length === 0, 'the screen asks nothing more')
  await settle(8)
}

/** Lets every held request through, and every later one straight away. */
async function answerAll(): Promise<void> {
  holding = false
  holdOnly = null
  while (asked.length > 0) for (const one of asked.splice(0)) one.release()
  await settle()
}

/** Holds only the requests `which` picks: the rest of the screen answers. */
function holdingOnly(which: (path: string) => boolean): void {
  holding = true
  holdOnly = which
}

/** Every request let through has come back and been drawn; the held ones still wait. */
async function landed(): Promise<void> {
  await until(() => inFlight === 0, 'the answers let through have come back')
  await settle(8)
}

/** What the screen shows as "still on the way": the placeholders' names. */
function waiting(root: FakeElement): string[] {
  return root.querySelectorAll('[aria-busy="true"]').map((one) => one.getAttribute('aria-label') ?? '')
}

const textOf = (root: FakeElement): string => root.textContent.replace(/[\s  ]+/g, ' ')

interface Mounted {
  root: FakeElement
  close: () => void
}

async function mountScreen(path: string, props: Record<string, unknown>): Promise<Mounted> {
  const Component = (await import(path)).default
  const root = document.createElement('div') as unknown as FakeElement
  document.body.appendChild(root as never)
  const app = svelte.mount(Component, { target: root as never, props })
  await settle()
  return {
    root,
    close: () => {
      void svelte.unmount(app)
      root.remove()
    },
  }
}

/* ---------------------------------------------------- what is on the server */

let courseId = ''
let courseName = ''
let roomId = ''
let competitionId = ''
let competitionTitle = ''
/** A draft of the course above: its editor names the course once the courses have answered. */
let coursedId = ''
let machineId = ''
let machineName = ''

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const reply = await realFetch(`${home}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  assert.ok(reply.ok, `${method} ${path}: ${reply.status} ${await reply.clone().text()}`)
  return (await reply.json()) as T
}

const navigate = () => {}

before(async () => {
  home = await serve()
  const owner = createTeacher({ name: 'Ада Лавлейс', email: `ada.${Date.now()}@skeleton.test`, role: 'owner' })!
  rotateLinkKey(owner.id)
  issueStaffCookie({ cookie: (_name: string, value: string) => (cookie = `${STAFF_COOKIE}=${value}`) } as unknown as ExpressResponse, owner)

  courseName = 'Машинное обучение · сильная группа'
  courseId = (await api<{ course: { id: string } }>('POST', '/api/admin/courses', { name: courseName })).course.id
  await api('POST', '/api/admin/courses', { name: 'Анализ данных' })
  roomId = (await api<{ id: string }>('POST', '/api/admin/seminars', { name: 'Линейная регрессия' })).id
  await api('POST', '/api/admin/teachers', { name: 'Борис Петров', email: `boris.${Date.now()}@skeleton.test` })
  competitionTitle = 'Прогноз заказов'
  const made = await api<{ competition: { id: string } }>('POST', '/api/admin/competitions', { title: competitionTitle, slug: `orders-${Date.now()}` })
  competitionId = made.competition.id
  coursedId = (await api<{ competition: { id: string } }>('POST', '/api/admin/competitions', {
    title: 'Отток клиентов',
    slug: `churn-${Date.now()}`,
    courseId,
  })).competition.id
  const machine = new Machine(home)
  assert.equal((await machine.join(code())).status, 200)
  machineId = machine.runnerId

  svelte = await import('svelte')
  // Who is signed in: the screens read the role (an owner's pickers, their switches).
  const { adminAuth } = await import('../web/src/admin/auth.svelte.ts')
  holding = false
  await adminAuth.load()
  holding = true
  assert.equal(adminAuth.isOwner, true)
  machineName = (await api<{ name: string }>('GET', `/api/admin/runners/${machineId}`)).name
})

after(() => {
  globalThis.fetch = realFetch
  close()
})

/* --------------------------------------------------------------- screens */

const SCREENS = '../web/src/admin/screens'

interface Case {
  name: string
  path: string
  props: () => Record<string, unknown>
  /** The placeholders' names while the first requests are held: the screen's own loading words. */
  waits: () => string[]
  /** A sentence that used to stand in for the placeholder, or a claim made before the answer. */
  never?: () => string[]
  /** What the answer draws. */
  drawn: (root: FakeElement) => boolean
}

const CASES: Case[] = [
  {
    name: 'the courses list',
    path: `${SCREENS}/Courses.svelte`,
    props: () => ({ open: null, navigate }),
    waits: () => [tr('admin.loading.courses')],
    never: () => [tr('admin.no.courses.yet')],
    drawn: (root) => textOf(root).includes(courseName),
  },
  {
    name: 'one course',
    path: `${SCREENS}/Courses.svelte`,
    props: () => ({ open: courseId, navigate }),
    waits: () => [tr('admin.opening.course')],
    never: () => [tr('admin.could.not.open.course')],
    drawn: (root) => root.querySelector('h1')?.textContent === courseName,
  },
  {
    name: 'environments',
    path: `${SCREENS}/Environments.svelte`,
    props: () => ({}),
    waits: () => [tr('admin.loading.environments')],
    never: () => [tr('admin.no.environments.yet')],
    drawn: (root) => waiting(root).length === 0 && root.querySelectorAll('section.border').length > 0,
  },
  {
    name: 'who can teach',
    path: `${SCREENS}/Teachers.svelte`,
    props: () => ({}),
    waits: () => [tr('admin.loading.teachers')],
    drawn: (root) => textOf(root).includes('Борис Петров'),
  },
  {
    name: 'the audit log',
    path: `${SCREENS}/AuditLog.svelte`,
    props: () => ({}),
    waits: () => [tr('admin.audit.loading')],
    never: () => [tr('admin.audit.empty')],
    drawn: (root) => waiting(root).length === 0 && root.querySelectorAll('.admin-data-row').length > 0,
  },
  {
    name: 'the oracle',
    path: `${SCREENS}/Oracle.svelte`,
    props: () => ({}),
    waits: () => [tr('admin.loading.oracle')],
    drawn: (root) => root.querySelector('#ai-base-url') !== null,
  },
  {
    name: 'a class page',
    path: `${SCREENS}/Publish.svelte`,
    props: () => ({ sessionId: roomId, from: null, focus: null, navigate }),
    waits: () => [tr('admin.page.loading')],
    drawn: (root) => waiting(root).length === 0 && root.querySelectorAll('.pick-row').length > 0,
  },
  {
    name: 'a machine',
    path: `${SCREENS}/RemoteMachine.svelte`,
    props: () => ({ id: machineId, navigate }),
    waits: () => [tr('admin.runners.page.loading')],
    drawn: (root) => root.querySelector('h1')?.textContent === machineName && root.querySelector('#machine-places') !== null,
  },
  {
    name: 'resources',
    path: `${SCREENS}/ResourcesTab.svelte`,
    props: () => ({ navigate }),
    // «Работают сейчас» asks its own door at once, under its own words.
    waits: () => [tr('admin.resourcesTab.loading'), tr('admin.resourcesTab.running.loading')],
    // The placeholder carries the fields' captions; a field itself is the answer.
    drawn: (root) => root.querySelector('#resources-roomMemoryMb') !== null,
  },
  {
    name: 'what runs now',
    path: '../web/src/admin/ui/RunningKernels.svelte',
    props: () => ({ roomIdleMin: null }),
    waits: () => [tr('admin.resourcesTab.running.loading')],
    drawn: (root) => waiting(root).length === 0 && root.querySelector('.rk-body')!.textContent.trim().length > 0,
  },
  {
    name: 'the machines',
    path: '../web/src/admin/ui/Runners.svelte',
    props: () => ({ navigate, reload: 0 }),
    waits: () => [tr('admin.runners.loading')],
    drawn: (root) => textOf(root).includes(machineName),
  },
  {
    name: 'a competition',
    path: `${SCREENS}/Competitions.svelte`,
    props: () => ({ open: competitionId, tab: 'submissions', navigate }),
    waits: () => [tr('competitions.loading')],
    never: () => [tr('admin.competitions.notOpened')],
    drawn: (root) => root.querySelector('h1')?.textContent === competitionTitle,
  },
  {
    name: 'a competition’s packages',
    path: `${SCREENS}/competitions/DependencySettings.svelte`,
    props: () => ({ competitionId }),
    waits: () => [tr('dependencies.loading')],
    drawn: (root) => root.querySelector('input[type="number"]') !== null,
  },
]

for (const one of CASES) {
  test(`${one.name}: a placeholder named by its loading words while asked, the answer once it lands`, async () => {
    holding = true
    const screen = await mountScreen(one.path, one.props())
    try {
      assert.ok(asked.length > 0, 'the screen asked the server')
      const names = waiting(screen.root)
      for (const name of one.waits()) assert.ok(names.includes(name), `«${name}» stands while asked; got ${JSON.stringify(names)}`)
      // The placeholder is the waiting, not a sentence beside it, and not an answer made up before the answer.
      for (const status of screen.root.querySelectorAll('[aria-busy="true"]')) {
        assert.equal(status.getAttribute('role'), 'status', 'a placeholder is a status region')
      }
      for (const claim of one.never?.() ?? []) assert.ok(!textOf(screen.root).includes(claim), `nothing says «${claim}» before the answer`)
      assert.ok(!one.drawn(screen.root), 'the answer is not there yet')

      await answerAll()
      await until(() => one.drawn(screen.root), `${one.name} drawn`)
      await until(() => waiting(screen.root).length === 0, 'the placeholders gone')
    } finally {
      screen.close()
      await answerAll()
    }
  })
}

/* --------------------------------------------------- the pickers it opens */

test('a course’s teacher picker and its rooms picker stand on rows until their lists land', async () => {
  holding = false
  const screen = await mountScreen(`${SCREENS}/Courses.svelte`, { open: courseId, navigate })
  try {
    await until(() => screen.root.querySelector('h1')?.textContent === courseName, 'the course drawn')
    holding = true
    const add = screen.root.querySelectorAll('button').find((one) => one.textContent.includes(tr('admin.course.teachers.add')))
    assert.ok(add, 'the strip offers to add a teacher')
    add.click()
    await settle()
    assert.ok(asked.some((one) => one.path === '/api/admin/teachers'), 'the staff list is asked when the picker opens')
    assert.ok(waiting(screen.root).includes(tr('admin.course.teachers.loading')), 'the picker stands on its rows')
    await answerAll()
    await until(() => waiting(screen.root).length === 0, 'the staff drawn')
    assert.ok(screen.root.querySelectorAll('[role="dialog"] li').length > 0, 'the staff are listed')
  } finally {
    screen.close()
    await answerAll()
  }

  // The rooms behind «Добавить занятие» come after the course: held, the picker waits on rows, not on «нет занятий».
  holding = true
  const again = await mountScreen(`${SCREENS}/Courses.svelte`, { open: courseId, navigate })
  try {
    const course = asked.findIndex((one) => one.path === `/api/admin/courses/${courseId}`)
    assert.notEqual(course, -1, 'the course is asked first')
    asked.splice(course, 1)[0].release()
    await until(() => again.root.querySelector('h1')?.textContent === courseName, 'the course drawn')
    await until(() => asked.some((one) => one.path.startsWith('/api/admin/seminars')), 'the rooms asked')
    const button = again.root.querySelectorAll('button').find((one) => one.textContent.includes(tr('admin.course.addRoom')))
    assert.ok(button, 'the page offers to add a class')
    button.click()
    await settle()
    assert.ok(waiting(again.root).includes(tr('admin.loading.seminars')), 'the rooms picker stands on rows')
    assert.ok(!textOf(again.root).includes(tr('admin.no.seminars.available.to.add')), 'and does not say there are none')
    await answerAll()
    await until(() => waiting(again.root).length === 0, 'the rooms drawn')
    assert.ok(again.root.querySelectorAll('.picker li button').length > 0, 'the room is offered')
  } finally {
    again.close()
    await answerAll()
  }
})

test('who can teach: the «+ курс» picker stands on rows until the courses land', async () => {
  holding = false
  const screen = await mountScreen(`${SCREENS}/Teachers.svelte`, {})
  try {
    await until(() => textOf(screen.root).includes('Борис Петров'), 'the staff drawn')
    await idle()
    holding = true
    const plus = screen.root.querySelectorAll('button').filter((one) => one.textContent.includes(tr('admin.teachers.addCourse')))
    assert.ok(plus.length > 0, 'a row offers «+ курс»')
    plus[0].click()
    await settle()
    const picker = screen.root.querySelector('[role="dialog"]')
    assert.ok(picker, 'the picker opened')
    // An owner's screen read every course on mount: the picker draws them at once, without a placeholder.
    assert.deepEqual(waiting(picker), [], 'courses already read are not asked under grey again')
  } finally {
    screen.close()
    await answerAll()
  }

  holding = true
  const cold = await mountScreen(`${SCREENS}/Teachers.svelte`, {})
  try {
    const list = asked.findIndex((one) => one.path === '/api/admin/teachers')
    asked.splice(list, 1)[0].release()
    await until(() => textOf(cold.root).includes('Борис Петров'), 'the staff drawn')
    const plus = cold.root.querySelectorAll('button').filter((one) => one.textContent.includes(tr('admin.teachers.addCourse')))
    plus[0].click()
    await settle()
    const picker = cold.root.querySelector('[role="dialog"]')
    assert.ok(picker, 'the picker opened')
    assert.ok(waiting(picker).includes(tr('admin.teachers.loadingCourses')), 'the picker stands on rows while the courses are asked')
    await answerAll()
    await until(() => waiting(cold.root).length === 0, 'the courses drawn')
    assert.ok(picker.querySelectorAll('[role="listbox"] button').length > 0, 'the courses are offered')
  } finally {
    cold.close()
    await answerAll()
  }
})

/* --------------------------------------------- the rules the screens keep */

test('a refusal is said in words, not under a placeholder', async () => {
  const refusals: [string, string, string][] = [
    [`${SCREENS}/Environments.svelte`, '/api/admin/environments', 'Докер молчит'],
    [`${SCREENS}/Teachers.svelte`, '/api/admin/teachers', 'Список недоступен'],
    [`${SCREENS}/AuditLog.svelte`, '/api/admin/audit-log', 'Журнал недоступен'],
    ['../web/src/admin/ui/Runners.svelte', '/api/admin/runners', 'Машины недоступны'],
  ]
  for (const [path, door, words] of refusals) {
    holding = true
    const screen = await mountScreen(path, path.endsWith('Runners.svelte') ? { navigate, reload: 0 } : {})
    try {
      const held = asked.findIndex((one) => one.path.startsWith(door))
      assert.notEqual(held, -1, `${door} is asked`)
      asked.splice(held, 1)[0].answer(500, refusal(words))
      await until(() => textOf(screen.root).includes(words), `${door}: the refusal said`)
      assert.deepEqual(waiting(screen.root), [], `${door}: nothing still pretends to load`)
    } finally {
      screen.close()
      await answerAll()
    }
  }

  // The packages: the refusal, its retry link, and no placeholder left above them.
  holding = true
  const packages = await mountScreen(`${SCREENS}/competitions/DependencySettings.svelte`, { competitionId })
  try {
    const held = asked.findIndex((one) => one.path.includes('/dependencies'))
    asked.splice(held, 1)[0].answer(500, refusal('Пакеты недоступны'))
    await until(() => textOf(packages.root).includes('Пакеты недоступны'), 'the refusal said')
    assert.deepEqual(waiting(packages.root), [], 'the placeholder gave way to the refusal')
    // «Загружаем пакеты…» stood on beside the refusal, as if still asking.
    assert.ok(!textOf(packages.root).includes(tr('dependencies.loading')), 'and nothing says it is still loading')
    assert.ok(packages.root.querySelectorAll('button').some((one) => one.textContent.includes(tr('dependencies.reload'))), 'with a way to ask again')
  } finally {
    packages.close()
    await answerAll()
  }
})

test('an empty list is still said to be empty, once it is known to be', async () => {
  holding = true
  const screen = await mountScreen(`${SCREENS}/Courses.svelte`, { open: null, navigate })
  try {
    assert.ok(!textOf(screen.root).includes(tr('admin.no.courses.yet')), 'not before the answer')
    for (const one of asked.splice(0)) {
      if (one.path.startsWith('/api/admin/courses')) one.answer(200, { courses: [] })
      else one.release()
    }
    holding = false
    await until(() => textOf(screen.root).includes(tr('admin.no.courses.yet')), 'the empty state said')
    assert.deepEqual(waiting(screen.root), [])
  } finally {
    screen.close()
    await answerAll()
  }
})

test('a reload under data already drawn does not go grey again', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    for (const [path, props, every] of [
      ['../web/src/admin/ui/RunningKernels.svelte', { roomIdleMin: null }, 15_000],
      [`${SCREENS}/RemoteMachine.svelte`, { id: machineId, navigate }, 5_000],
    ] as const) {
      holding = false
      const screen = await mountScreen(path, props)
      try {
        await until(() => waiting(screen.root).length === 0 && textOf(screen.root).trim().length > 0, `${path} drawn`)
        holding = true
        const before = asked.length
        mock.timers.tick(every)
        await settle()
        assert.ok(asked.length > before, `${path}: the screen asked again`)
        assert.deepEqual(waiting(screen.root), [], `${path}: and stayed drawn while it waited`)
      } finally {
        screen.close()
        await answerAll()
      }
    }
  } finally {
    mock.timers.reset()
  }
})

/* ------------------------------------- the parts that land on their own */

const buttonWith = (root: FakeElement, words: string) =>
  root.querySelectorAll('button').find((one) => one.textContent.includes(words))

test('the courses’ «Мои» counts nothing until the list answers, and a refused list is not «нет курсов»', async () => {
  holding = true
  const screen = await mountScreen(`${SCREENS}/Courses.svelte`, { open: null, navigate })
  try {
    const mine = () => buttonWith(screen.root, tr('admin.course.scope.mine'))!
    assert.ok(mine(), 'an owner has the switch')
    assert.ok(!/\d/.test(mine().textContent), `«Мои» has no count before the answer: «${mine().textContent.trim()}»`)

    for (const one of asked.splice(0)) {
      if (one.path.startsWith('/api/admin/courses')) one.answer(500, refusal('Курсы недоступны'))
      else one.release()
    }
    holding = false
    await until(() => textOf(screen.root).includes('Курсы недоступны'), 'the refusal said')
    assert.ok(!textOf(screen.root).includes(tr('admin.no.courses.yet')), 'a refusal does not say there are no courses')
    assert.ok(!/\d/.test(mine().textContent), 'nor counts them')
    assert.deepEqual(waiting(screen.root), [], 'and does not pretend to be loading')

    buttonWith(screen.root, tr('admin.try.again'))!.click()
    await until(() => textOf(screen.root).includes(courseName), 'asked again, the list drawn')
    assert.ok(!textOf(screen.root).includes('Курсы недоступны'), 'the refusal went with it')
    assert.ok(/\d/.test(mine().textContent), 'and «Мои» counts')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('a course’s rooms picker says a refused room list, not that there are none', async () => {
  holdingOnly((path) => path.startsWith('/api/admin/seminars'))
  const screen = await mountScreen(`${SCREENS}/Courses.svelte`, { open: courseId, navigate })
  try {
    await until(
      () => screen.root.querySelector('h1')?.textContent === courseName && asked.some((one) => one.path.startsWith('/api/admin/seminars')),
      'the course drawn, its rooms asked',
    )
    for (const one of asked.splice(0)) one.answer(500, refusal('Занятия недоступны'))
    await landed()
    buttonWith(screen.root, tr('admin.course.addRoom'))!.click()
    await settle()
    const picker = screen.root.querySelector('.picker')!
    assert.ok(picker, 'the picker opened')
    assert.ok(textOf(picker).includes('Занятия недоступны'), 'the refusal is said where the rooms would be')
    assert.ok(!textOf(picker).includes(tr('admin.no.seminars.available.to.add')), 'not that there are none to add')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('who can teach: a refused course list is said in the «+ курс» picker, not waited on forever', async () => {
  holdingOnly((path) => path.startsWith('/api/admin/courses'))
  const screen = await mountScreen(`${SCREENS}/Teachers.svelte`, {})
  try {
    await until(() => textOf(screen.root).includes('Борис Петров'), 'the staff drawn')
    screen.root.querySelectorAll('button').filter((one) => one.textContent.includes(tr('admin.teachers.addCourse')))[0].click()
    await settle()
    const picker = screen.root.querySelector('[role="dialog"]')!
    assert.ok(picker, 'the picker opened')
    for (const one of asked.splice(0)) one.answer(500, refusal('Курсы недоступны'))
    await until(() => textOf(picker).includes('Курсы недоступны'), 'the refusal said in the picker')
    assert.deepEqual(waiting(picker), [], 'no placeholder under it')
    assert.ok(!textOf(picker).includes(tr('admin.teachers.loadingCourses')), 'and no «Загружаем курсы…» either')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('the competitions list keeps the queue’s strip above its rows while it loads', async () => {
  holding = true
  const screen = await mountScreen(`${SCREENS}/Competitions.svelte`, { open: null, tab: 'submissions', navigate })
  try {
    // The strip came with the list and pushed the table down; its word stands from the start, its state grey.
    assert.ok(textOf(screen.root).includes(tr('admin.competitions.runner')), 'the strip stands while the list is asked')
    assert.ok(!textOf(screen.root).includes(tr('admin.competitions.pauseQueue')), 'and offers no pause before it knows the queue')
    await answerAll()
    await until(() => textOf(screen.root).includes(competitionTitle), 'the list drawn')
    assert.ok(textOf(screen.root).includes(tr('admin.competitions.pauseQueue')), 'the strip is the real one now')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('the audit log says how long it keeps events while its first page loads', async () => {
  holding = true
  const screen = await mountScreen(`${SCREENS}/AuditLog.svelte`, {})
  try {
    // The short subtitle grew a line on a phone when the days came; the long one waits with «…».
    const subtitle = tr('admin.audit.subtitle', { count: 5, days: '…' })
    assert.ok(textOf(screen.root).includes(subtitle), 'the long subtitle stands, the days to come')
    await answerAll()
    await until(() => waiting(screen.root).length === 0, 'the first page drawn')
    assert.ok(!textOf(screen.root).includes(subtitle), 'the days are said once they come')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('«Работают сейчас» keeps its placeholder until the machine’s section above it lands', async () => {
  holdingOnly((path) => path === '/api/admin/resources')
  const screen = await mountScreen(`${SCREENS}/ResourcesTab.svelte`, { navigate })
  try {
    await until(() => asked.some((one) => one.path === '/api/admin/resources'), 'the settings asked')
    await landed()
    // The census has answered by now (an idle server: one line); drawn, it
    // would drop down the page when the taller machine section landed.
    assert.ok(waiting(screen.root).includes(tr('admin.resourcesTab.running.loading')), 'the census stands on its placeholder')
    assert.ok(!textOf(screen.root).includes(tr('admin.resourcesTab.running.empty')), 'its answer waits under it')
    await answerAll()
    await until(() => textOf(screen.root).includes(tr('admin.resourcesTab.running.empty')), 'the census drawn with the page')
    // The blocks mounted with the page (the machines) ask their own doors now.
    await until(() => waiting(screen.root).length === 0, 'nothing left waiting')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('the census waits on one line, not on a table an idle answer would collapse', async () => {
  holding = true
  const screen = await mountScreen('../web/src/admin/ui/RunningKernels.svelte', { roomIdleMin: null })
  try {
    const regions = screen.root.querySelectorAll('[aria-busy="true"]')
    assert.equal(regions.length, 1, 'the census waits under one placeholder')
    assert.equal(regions[0].querySelectorAll('.rk-head, .rk-row, .rk-summary').length, 0, 'with no lanes, rows or summary in it')
    assert.equal(regions[0].querySelectorAll('p').length, 1, 'only the line its answer starts with')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('the machines block draws the queue’s fields with its list, not above its placeholder', async () => {
  holdingOnly((path) => path.startsWith('/api/admin/runners'))
  const screen = await mountScreen(`${SCREENS}/ResourcesTab.svelte`, { navigate })
  try {
    await until(() => asked.some((one) => one.path.startsWith('/api/admin/runners')), 'the machines asked')
    await landed()
    assert.ok(screen.root.querySelector('#resources-roomMemoryMb'), 'the page around the block is drawn')
    assert.ok(waiting(screen.root).includes(tr('admin.runners.loading')), 'the block stands on its placeholder')
    // A list with a machine puts its gauges' row above the fields: drawn
    // before it, they were pushed down the page under the owner's hand.
    assert.equal(screen.root.querySelector('#resources-c-scoreSlots'), null, 'the queue’s fields wait for the list')
    await answerAll()
    await until(() => screen.root.querySelector('#resources-c-scoreSlots') !== null, 'the fields came with the list')
    assert.ok(!waiting(screen.root).includes(tr('admin.runners.loading')), 'and the placeholder went')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('the resources’ competitions section stands on its own placeholder until its half lands', async () => {
  holdingOnly((path) => path === '/api/admin/competitions/settings')
  const screen = await mountScreen(`${SCREENS}/ResourcesTab.svelte`, { navigate })
  try {
    await until(() => asked.some((one) => one.path === '/api/admin/competitions/settings'), 'the queue’s half asked')
    await landed()
    assert.ok(screen.root.querySelector('#resources-roomMemoryMb'), 'the rooms’ half drew the page')
    assert.ok(waiting(screen.root).includes(tr('common.loading')), 'the section waits under its placeholder')
    assert.equal(screen.root.querySelector('#resources-c-wallSeconds'), null, 'its fields are the answer')
    await answerAll()
    await until(() => screen.root.querySelector('#resources-c-wallSeconds') !== null, 'the section drawn')
    assert.deepEqual(waiting(screen.root), [], 'nothing left waiting')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('the oracle’s usage waits under its own placeholder when the form lands first', async () => {
  holdingOnly((path) => path.startsWith('/api/admin/oracle/usage'))
  const screen = await mountScreen(`${SCREENS}/Oracle.svelte`, {})
  try {
    await until(() => screen.root.querySelector('#ai-base-url') !== null, 'the form drawn')
    await landed()
    assert.deepEqual(waiting(screen.root), [tr('admin.loading.usage')], 'only the counts still wait')
    await answerAll()
    await until(() => waiting(screen.root).length === 0, 'the counts drawn')
    assert.ok(textOf(screen.root).includes(tr('admin.questions.asked')))
  } finally {
    screen.close()
    await answerAll()
  }
})

test('a competition’s editor names its course and environment only once they have answered', async () => {
  holdingOnly((path) => path.startsWith('/api/admin/courses') || path.startsWith('/api/admin/environments'))
  const screen = await mountScreen(`${SCREENS}/Competitions.svelte`, { open: coursedId, tab: 'submissions', navigate })
  try {
    await until(() => screen.root.querySelector('h1')?.textContent === 'Отток клиентов', 'the editor drawn')
    await landed()
    const names = waiting(screen.root)
    assert.ok(names.includes(tr('admin.loading.courses')), `the course field waits; got ${JSON.stringify(names)}`)
    assert.ok(names.includes(tr('admin.loading.environments')), 'and so does the environment’s state')
    // Before the courses were read, the chosen one could only be called «не ваш».
    assert.ok(!textOf(screen.root).includes(tr('admin.competitions.courseNotYours')), 'nothing calls the course not yours')

    // An empty description needs no renderer: the preview says so at once.
    buttonWith(screen.root, tr('admin.competitions.tabPreview'))!.click()
    svelte.flushSync()
    assert.ok(textOf(screen.root).includes(tr('admin.competitions.descriptionEmpty')), 'the empty description is said at once')
    assert.ok(!waiting(screen.root).includes(tr('admin.competitions.previewLoading')), 'not waited on')

    await answerAll()
    await until(() => !waiting(screen.root).includes(tr('admin.loading.courses')), 'the courses answered')
    await until(() => !waiting(screen.root).includes(tr('admin.loading.environments')), 'the environments answered')
    const select = screen.root.querySelectorAll('select').find((one) => one.getAttribute('aria-label') === tr('admin.competitions.courseLabel'))
    assert.ok(select && select.textContent.includes(courseName), 'the course is named')
  } finally {
    screen.close()
    await answerAll()
  }
})

test('a class’s «Ведущие» stand on placeholders until the room’s people and the staff list land', async () => {
  holding = false
  const screen = await mountScreen(`${SCREENS}/Seminars.svelte`, { navigate })
  try {
    await until(() => textOf(screen.root).includes('Линейная регрессия'), 'the classes drawn')
    await idle()
    const menu = screen.root
      .querySelectorAll('button[aria-haspopup="menu"]')
      .find((one) => (one.getAttribute('aria-label') ?? '').includes('Линейная регрессия'))
    assert.ok(menu, 'the room’s row has its menu')
    menu.click()
    await settle()
    holdingOnly((path) => /^\/api\/admin\/seminars\/[^/]+\/teachers$/.test(path) || path === '/api/admin/teachers')
    screen.root.querySelectorAll('[role="menuitem"]').find((one) => one.textContent.includes(tr('admin.seminar.settingsMenu')))!.click()
    await settle()
    await landed()
    assert.ok(waiting(screen.root).includes(tr('admin.seminars.list.hosts.loading')), 'the chips wait under their placeholder')
    for (const one of asked.splice(0)) one.release()
    await until(() => !waiting(screen.root).includes(tr('admin.seminars.list.hosts.loading')), 'the room’s people drawn')

    const add = screen.root.querySelectorAll('button').find((one) => one.getAttribute('aria-expanded') !== null && one.textContent.includes(tr('admin.seminars.list.hosts.add')))
    assert.ok(add, 'the strip offers to add someone')
    add.click()
    await settle()
    assert.ok(asked.some((one) => one.path === '/api/admin/teachers'), 'the staff list is asked')
    assert.ok(waiting(screen.root).includes(tr('admin.seminars.list.hosts.loading')), 'the picker stands on rows')
    await answerAll()
    await until(() => !waiting(screen.root).includes(tr('admin.seminars.list.hosts.loading')), 'the staff drawn')
    assert.ok(textOf(screen.root).includes('Борис Петров'), 'someone is offered')
  } finally {
    screen.close()
    await answerAll()
  }
})

/**
 * The console's first state comes by a stream, which the stand-in document
 * has no class for: this one is held in the test's hand, and it says
 * nothing until the test pushes the server's own answer through it.
 */
class HeldStream {
  static open: HeldStream[] = []
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>()
  constructor(readonly url: string) {
    HeldStream.open.push(this)
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close(): void {
    HeldStream.open = HeldStream.open.filter((one) => one !== this)
  }
  push(type: string, body: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(body) })
  }
}

test('a competition’s console claims no executors and no queue before its first state', async () => {
  const view = await api<{ competition: { id: string } }>('GET', `/api/admin/competitions/${competitionId}`)
  ;(globalThis as { EventSource?: unknown }).EventSource = HeldStream
  holding = false
  const screen = await mountScreen(`${SCREENS}/competitions/Live.svelte`, { view, tab: 'submissions', navigate, onview: () => {} })
  try {
    await until(() => HeldStream.open.length === 1, 'the stream opened')
    await idle()
    // The feed has answered; the stream has said nothing yet.
    assert.deepEqual(waiting(screen.root), [tr('competitions.loading')], 'the executors and the queue wait under one placeholder')
    for (const claim of [
      tr('admin.competitions.slotsHead', { busy: 0, count: 0 }),
      tr('admin.competitions.nothingRunning'),
      tr('admin.competitions.waitingHead', { count: 0 }),
      tr('admin.competitions.queueEmpty'),
    ]) assert.ok(!textOf(screen.root).includes(claim), `nothing says «${claim}» before the first state`)

    const state = await api<{ queue: { slots: number }; waiting: unknown[] }>('GET', `/api/admin/competitions/${competitionId}/live`)
    HeldStream.open[0].push('state', state)
    await idle()
    assert.deepEqual(waiting(screen.root), [], 'the placeholder went with the first state')
    assert.ok(
      textOf(screen.root).includes(tr('admin.competitions.waitingHead', { count: state.waiting.length })),
      'and the queue is counted',
    )
  } finally {
    screen.close()
    await answerAll()
    delete (globalThis as { EventSource?: unknown }).EventSource
  }
})
