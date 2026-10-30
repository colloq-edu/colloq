/**
 * The contests' doors end to end, on the real app (server/src/app.ts): the
 * panel's (routes/admin-contests.ts) and the participant's
 * (routes/contests.ts), with a judge that runs nothing (_contests.mts).
 *
 * What is checked is what breaks quietly. A participant door one field wider
 * than it should be hands the class the reference solution or a hidden test's
 * answer, and the page looks exactly the same. A board that freezes for the
 * wrong viewer, or masks the wrong name, is a ranking people argue about. A
 * teacher of another course reading a contest by its id is a scope rule that
 * only the list obeyed. Each of those has its test here.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { call, staffMember, startApp, type Running } from './_scoping.mts'
import { createCourse } from '../server/src/publish/store.js'
import { addCourseTeacher } from '../server/src/admin/access.js'
import { db } from '../server/src/db.js'
import { useContestJudge } from '../server/src/contests/judge/port.js'
import { drainContestJudge, forgetLanguageProbes } from '../server/src/contests/pump.js'
import { createEntrant, getEntrant } from '../server/src/competitions/store.js'
import {
  getContest,
  getProblem,
  getSubmission,
  joinContest,
  listProblems,
  submitSolution,
  updateContest,
} from '../server/src/contests/store.js'
import { ADMIN_AUDIT_ACTIONS } from '../shared/admin.js'
import type { Contest, ContestLanguage } from '../shared/contests.js'
import type {
  AdminQuestions,
  AdminStandings,
  AdminSubmissionDetail,
  AdminSubmissions,
  ArchiveImport,
  ContestList,
  ContestSettings,
  ContestView,
  JudgeStatus,
  ProblemView,
} from '../shared/contests-api.js'
import type {
  ContestQuestion,
  ContestStreamState,
  EntrantContestList,
  EntrantContestSubmissions,
  EntrantContestView,
  EntrantQuestions,
  EntrantStandings,
  EntrantSubmissionDetail,
  SubmitAccepted,
} from '../shared/contests-entrant.js'
import type { EntrantMe } from '../shared/competitions-entrant.js'
import { entrantCookie, makeZip, setCookieOf, stubJudge, type StubJudge } from './_contests.mts'

let app: Running
const owner = staffMember('Ольга Владелица', 'owner')
const teacher = staffMember('Тимур Учитель')
const coTeacher = staffMember('Вера Соведущая')
const stranger = staffMember('Сергей Чужой')
let judge: StubJudge
let courseId = ''

before(async () => {
  judge = stubJudge()
  useContestJudge(judge)
  app = await startApp()
  courseId = createCourse('Алгоритмы', null, teacher.teacher.name).id
  addCourseTeacher(courseId, teacher.teacher.id, null)
  addCourseTeacher(courseId, coTeacher.teacher.id, null)
})

after(() => {
  app?.close()
  useContestJudge(null)
})

const json = async <T,>(res: globalThis.Response): Promise<T> => (await res.json()) as T
const reason = async (res: globalThis.Response): Promise<string> => ((await res.json()) as { reason: string }).reason
const panel = (method: string, path: string, body?: unknown, cookie = teacher.cookie) => call(app.base, method, `/api/admin/contests${path}`, { cookie, body })
const door = (method: string, path: string, cookie?: string, body?: unknown) => call(app.base, method, `/api/k/contests${path}`, { cookie, body })

function upload(path: string, file: Buffer, cookie = teacher.cookie): Promise<globalThis.Response> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(file)]), 'archive.zip')
  return fetch(`${app.base}/api/admin/contests${path}`, { method: 'POST', headers: { cookie }, body: form })
}

/** A participant made in the store and signed in by their cookie (the join door has its own tests and limits). */
function participant(contestId: string, handle: string): { id: string; cookie: string } {
  const minted = createEntrant(handle)
  assert.equal(joinContest(contestId, minted.entrant.id, handle), 'ok')
  return { id: minted.entrant.id, cookie: entrantCookie(getEntrant(minted.entrant.id)!) }
}

/** A submission sent at a chosen moment, past the door's five-second rule. */
function sendAt(contestId: string, problemId: string, entrantId: string, source: string, at: number, language: ContestLanguage = 'cpp20') {
  const sent = submitSolution({ contestId, problemId, entrantId, language, source, late: false, attemptsPerProblem: 0 }, at)
  assert.ok('submission' in sent)
  return sent.submission
}

const TESTS_ZIP = makeZip([
  { name: 'tests/01', data: '1 2\n' },
  { name: 'tests/01.a', data: '3\n' },
  { name: 'tests/02', data: '10 20\n' },
  { name: 'tests/02.a', data: '30\n' },
  // No answer: the reference writes it.
  { name: 'tests/03', data: '5 5\n' },
  { name: 'statement.pdf', data: 'not a test' },
])

let made = 0

/** A contest built and opened through the panel, the way a teacher does it. */
async function openContest(options: Partial<Pick<Contest, 'rules' | 'freezeMinutes' | 'startsAt' | 'endsAt' | 'boardVisibility' | 'upsolving' | 'attemptsPerProblem'>> = {}) {
  made++
  const created = await panel('POST', '', { title: `Контест ${made}`, slug: `api-contest-${made}`, rules: options.rules ?? 'icpc' })
  assert.equal(created.status, 201, await created.clone().text())
  const id = (await json<ContestView>(created)).contest.id
  const { rules: _rules, ...rest } = options
  if (Object.keys(rest).length > 0) assert.equal((await panel('PATCH', `/${id}`, rest)).status, 200)
  const problem = await json<ProblemView>(await panel('POST', `/${id}/problems`, {
    title: 'Сумма',
    statement: 'Сложите $a$ и $b$.',
    referenceSource: 'ok',
    referenceLanguage: 'cpp20',
    checker: 'custom',
    checkerCode: 'def check(i, o, a):\n    return o.split() == a.split()\n',
  }))
  assert.equal((await upload(`/${id}/problems/${problem.id}/tests/archive`, TESTS_ZIP)).status, 200)
  assert.equal((await panel('PATCH', `/${id}/problems/${problem.id}/tests/1`, { sample: true })).status, 200)
  assert.equal((await panel('POST', `/${id}/problems/${problem.id}/reference/answers`)).status, 200)
  await drainContestJudge()
  const opened = await panel('POST', `/${id}/open`)
  assert.equal(opened.status, 200, await opened.clone().text())
  return { contest: getContest(id)!, problem: getProblem(problem.id)! }
}

/* ------------------------------------------------------------- the panel */

test('without a staff cookie the panel answers nothing', async () => {
  for (const [method, path] of [['GET', ''], ['POST', ''], ['GET', '/settings'], ['POST', '/judge/pause']] as const) {
    const res = await call(app.base, method, `/api/admin/contests${path}`, { body: method === 'POST' ? {} : undefined })
    assert.equal(res.status, 401, `${method} ${path}`)
  }
})

test('a contest is born a draft with its readiness, and its address is its own', async () => {
  const res = await panel('POST', '', { title: 'Первый контест', slug: 'first-contest' })
  assert.equal(res.status, 201)
  const view = await json<ContestView>(res)
  assert.equal(view.contest.state, 'draft')
  assert.equal(view.contest.createdBy, teacher.teacher.id)
  assert.equal(view.phase, 'draft')
  assert.equal(typeof view.timeZone, 'string')
  assert.ok(view.timeZone.length > 0)
  assert.ok(view.readiness.length > 0, 'nothing to open yet')
  assert.deepEqual(view.languages.map((l) => [l.id, l.available]), [['python3', true], ['cpp20', true], ['c17', false]])
  assert.equal(view.judge.backend, 'test')
  const again = await panel('POST', '', { title: 'Второй', slug: 'first-contest' })
  assert.equal(again.status, 409)
  assert.equal(await reason(again), 'exists')
  assert.equal((await panel('POST', '', { title: 'Плохой', slug: 'Плохой адрес' })).status, 400)
  const reserved = await panel('POST', '', { title: 'Занят', slug: 'new' })
  assert.equal(reserved.status, 400)
  assert.match(((await reserved.json()) as { error: string }).error, /Colloq/)
  assert.equal((await panel('POST', '', { title: '   ', slug: 'no-title' })).status, 400)
})

test('the scope rule: a teacher of another course reads nothing, a course\'s teacher runs it, only the author or an owner deletes', async () => {
  const res = await panel('POST', '', { title: 'Курсовой', slug: 'course-contest', courseId })
  assert.equal(res.status, 201)
  const id = (await json<ContestView>(res)).contest.id
  for (const [method, path] of [['GET', ''], ['PATCH', ''], ['GET', '/standings'], ['GET', '/submissions'], ['POST', '/problems'], ['DELETE', '']] as const) {
    const refused = await panel(method, `/${id}${path}`, method === 'GET' || method === 'DELETE' ? undefined : {}, stranger.cookie)
    assert.equal(refused.status, 404, `${method} ${path}`)
  }
  const list = await json<ContestList>(await panel('GET', '', undefined, stranger.cookie))
  assert.equal(list.contests.some((row) => row.contest.id === id), false)
  // The course's other teacher runs it…
  assert.equal((await panel('GET', `/${id}`, undefined, coTeacher.cookie)).status, 200)
  assert.equal((await panel('PATCH', `/${id}`, { blurb: 'Для второй группы' }, coTeacher.cookie)).status, 200)
  // …but does not delete it.
  const notYours = await panel('DELETE', `/${id}`, undefined, coTeacher.cookie)
  assert.equal(notYours.status, 403)
  assert.equal(await reason(notYours), 'forbidden')
  // A move that would hide it from the mover is refused.
  const hide = await panel('PATCH', `/${id}`, { courseId: null }, coTeacher.cookie)
  assert.equal(hide.status, 409)
  // The author deletes it; an owner deletes anyone's.
  assert.equal((await panel('DELETE', `/${id}`)).status, 204)
  assert.equal(getContest(id), null)
  const another = await json<ContestView>(await panel('POST', '', { title: 'Чужой', slug: 'owners-delete' }))
  assert.equal((await panel('DELETE', `/${another.contest.id}`, undefined, owner.cookie)).status, 204)
})

test('the editor\'s PATCH is held to the limits, field by field', async () => {
  const id = (await json<ContestView>(await panel('POST', '', { title: 'Поля', slug: 'patch-limits' }))).contest.id
  const refused = async (body: unknown) => {
    const res = await panel('PATCH', `/${id}`, body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  await refused({ penaltyMinutes: 500 })
  await refused({ penaltyMinutes: 1.5 })
  await refused({ freezeMinutes: -1 })
  await refused({ attemptsPerProblem: 'two' })
  await refused({ languages: [] })
  await refused({ languages: ['java'] })
  await refused({ environment: 'Bad Env' })
  await refused({ rules: 'acm' })
  await refused({ boardVisibility: 'friends' })
  await refused({ startsAt: Date.now(), endsAt: Date.now() - 1000 })
  await refused({ title: 'x'.repeat(200) })
  assert.equal((await panel('PATCH', `/${id}`, { courseId: 'no-such-course' })).status, 404)
  const ok = await json<ContestView>(await panel('PATCH', `/${id}`, { languages: ['cpp20', 'python3', 'cpp20'], penaltyMinutes: 10, upsolving: true }))
  assert.deepEqual(ok.contest.languages, ['cpp20', 'python3'])
  assert.equal(ok.contest.penaltyMinutes, 10)
  assert.equal(ok.contest.upsolving, true)
})

test('problems and tests through the panel: typed in, uploaded, marked, moved, downloaded', async () => {
  const id = (await json<ContestView>(await panel('POST', '', { title: 'Тесты', slug: 'tests-doors' }))).contest.id
  const made = await panel('POST', `/${id}/problems`, { title: 'Разность' })
  assert.equal(made.status, 201)
  let problem = await json<ProblemView>(made)
  assert.equal(problem.letter, 'A')
  assert.equal(problem.reference.state, 'missing')
  // One test typed in, without an answer.
  problem = await json<ProblemView>(await panel('POST', `/${id}/problems/${problem.id}/tests`, { input: '7 3\n', sample: true }))
  assert.deepEqual(problem.tests.map((t) => [t.ordinal, t.sample, t.inputPreview, t.answerPreview]), [[1, true, '7 3\n', null]])
  assert.equal(problem.missingAnswers, 1)
  // An archive appended: three more, one of them without an answer, the pdf named as skipped.
  const appended = await upload(`/${id}/problems/${problem.id}/tests/archive?mode=append`, TESTS_ZIP)
  assert.equal(appended.status, 200)
  const imported = await json<ArchiveImport>(appended)
  assert.equal(imported.added, 3)
  assert.equal(imported.withoutAnswers, 1)
  assert.deepEqual(imported.skipped, ['statement.pdf'])
  assert.deepEqual(imported.problem.tests.map((t) => [t.ordinal, t.inputBytes, t.answerBytes]), [[1, 4, null], [2, 4, 2], [3, 6, 3], [4, 4, null]])
  assert.equal(imported.problem.tests[2].answerPreview, '30\n')
  // The previews are the first bytes only.
  const long = await json<ProblemView>(await panel('POST', `/${id}/problems/${problem.id}/tests`, { input: 'x'.repeat(500), answer: 'y' }))
  assert.equal(long.tests.at(-1)!.inputPreview.length, 120)
  // Move test 3 to the front; delete the last.
  let view = await json<ProblemView>(await panel('PATCH', `/${id}/problems/${problem.id}/tests/3`, { ordinal: 1 }))
  assert.equal(view.tests[0].inputPreview, '10 20\n')
  view = await json<ProblemView>(await panel('DELETE', `/${id}/problems/${problem.id}/tests/5`))
  assert.equal(view.tests.length, 4)
  // A download is the file, as text, kept by no cache.
  const input = await call(app.base, 'GET', `/api/admin/contests/${id}/problems/${problem.id}/tests/1/input`, { cookie: teacher.cookie })
  assert.equal(input.status, 200)
  assert.match(input.headers.get('content-type') ?? '', /text\/plain/)
  assert.match(input.headers.get('content-disposition') ?? '', /attachment/)
  assert.equal(input.headers.get('cache-control'), 'private, no-store')
  assert.equal(await input.text(), '10 20\n')
  const answer = await call(app.base, 'GET', `/api/admin/contests/${id}/problems/${problem.id}/tests/1/answer`, { cookie: teacher.cookie })
  assert.equal(await answer.text(), '30\n')
  assert.equal((await call(app.base, 'GET', `/api/admin/contests/${id}/problems/${problem.id}/tests/2/answer`, { cookie: teacher.cookie })).status, 404, 'no answer yet')
  assert.equal((await call(app.base, 'GET', `/api/admin/contests/${id}/problems/${problem.id}/tests/1/input`, { cookie: stranger.cookie })).status, 404)
  // A broken archive is refused in words, and nothing changes.
  const broken = await upload(`/${id}/problems/${problem.id}/tests/archive`, Buffer.from('this is not a zip'))
  assert.equal(broken.status, 400)
  assert.match(((await broken.json()) as { error: string }).error, /zip/)
  assert.equal(getProblem(problem.id)!.testsRevision, view.testsRevision)
  // Groups, and every test gone.
  view = await json<ProblemView>(await panel('PUT', `/${id}/problems/${problem.id}/groups`, { groups: [{ group: 0, points: 40 }, { group: 1, points: 60 }] }))
  assert.deepEqual(view.groups, [{ group: 0, points: 40 }, { group: 1, points: 60 }])
  assert.equal((await panel('PUT', `/${id}/problems/${problem.id}/groups`, { groups: [{ group: 1, points: 1 }, { group: 1, points: 2 }] })).status, 400)
  view = await json<ProblemView>(await panel('DELETE', `/${id}/problems/${problem.id}/tests`))
  assert.deepEqual(view.tests, [])
})

test('the reference: checked, writing the answers, and nothing queued that cannot run', async () => {
  const id = (await json<ContestView>(await panel('POST', '', { title: 'Эталон', slug: 'reference-doors' }))).contest.id
  const problem = await json<ProblemView>(await panel('POST', `/${id}/problems`, { title: 'A' }))
  const base = `/${id}/problems/${problem.id}`
  assert.equal((await panel('POST', `${base}/reference/check`)).status, 409, 'no source')
  assert.equal((await panel('PATCH', base, { referenceSource: 'ok', referenceLanguage: 'python3' })).status, 200)
  assert.equal((await panel('POST', `${base}/reference/check`)).status, 409, 'no tests')
  await upload(`${base}/tests/archive`, TESTS_ZIP)
  const early = await panel('POST', `${base}/reference/check`)
  assert.equal(early.status, 409, 'test 3 has no answer to compare with')
  const writing = await json<ProblemView>(await panel('POST', `${base}/reference/answers`))
  assert.equal(writing.answersRunning, true)
  await drainContestJudge()
  const done = await json<ContestView>(await panel('GET', `/${id}`))
  const after = done.problems[0]
  assert.equal(after.missingAnswers, 0)
  assert.equal(after.tests[2].answerFrom, 'reference')
  assert.equal(after.reference.state, 'passes', 'written, then checked by itself')
  // The reference's report opens in the drawer: the teacher's run, every test with data.
  const report = await json<AdminSubmissionDetail>(await panel('GET', `/${id}/submissions/${after.reference.submissionId}`))
  assert.equal(report.kind, 'reference')
  assert.equal(report.entrant, null)
  assert.equal(report.tests.length, 3)
  assert.equal(report.tests[1].input, '10 20\n')
  assert.equal(report.tests[1].answer, '30\n')
  assert.equal(report.tests[1].output, 'right')
  // The feed is the class's by default; the teacher's runs on request.
  assert.equal((await json<AdminSubmissions>(await panel('GET', `/${id}/submissions`))).total, 0)
  assert.ok((await json<AdminSubmissions>(await panel('GET', `/${id}/submissions?kind=all`))).total >= 2)
})

test('a whole problem from one archive, a copy of one, the order, a deletion', async () => {
  const id = (await json<ContestView>(await panel('POST', '', { title: 'Импорт', slug: 'import-doors' }))).contest.id
  const zip = makeZip([
    { name: 'gcd/problem.json', data: JSON.stringify({ timeLimitMs: 2000, memoryMb: 128, samples: [1] }) },
    { name: 'gcd/statement.md', data: '# НОД\n\nНайдите $\\gcd(a, b)$.' },
    { name: 'gcd/solution.cpp', data: 'ok' },
    { name: 'gcd/1.in', data: '4 6\n' },
    { name: 'gcd/1.out', data: '2\n' },
    { name: 'gcd/2.in', data: '9 3\n' },
  ])
  const res = await upload(`/${id}/problems/import`, zip)
  assert.equal(res.status, 201, await res.clone().text())
  const imported = await json<ProblemView>(res)
  assert.equal(imported.title, 'НОД')
  assert.equal(imported.timeLimitMs, 2000)
  assert.equal(imported.memoryMb, 128)
  assert.equal(imported.referenceLanguage, 'cpp20')
  assert.deepEqual(imported.tests.map((t) => [t.ordinal, t.sample, t.answerBytes]), [[1, true, 2], [2, false, null]])
  const bad = await upload(`/${id}/problems/import`, makeZip([{ name: 'problem.json', data: '{"memoryMb": 1}' }]))
  assert.equal(bad.status, 400)
  assert.equal(listProblems(id).length, 1, 'a refused import made no problem')
  const copy = await panel('POST', `/${id}/problems/copy`, { fromProblemId: imported.id })
  assert.equal(copy.status, 201)
  const copied = await json<ProblemView>(copy)
  assert.equal(copied.letter, 'B')
  assert.equal(copied.tests.length, 2)
  assert.equal(copied.reference.state, 'unchecked', 'a check belongs to the problem it ran for')
  // A teacher cannot copy from a contest they do not run.
  const foreign = await panel('POST', `/${id}/problems/copy`, { fromProblemId: imported.id }, stranger.cookie)
  assert.equal(foreign.status, 404)
  const order = await json<ContestView>(await panel('PUT', `/${id}/problems/order`, { ids: [copied.id, imported.id] }))
  assert.deepEqual(order.problems.map((p) => [p.letter, p.id]), [['A', copied.id], ['B', imported.id]])
  assert.equal((await panel('PUT', `/${id}/problems/order`, { ids: [copied.id] })).status, 400)
  const left = await json<ContestView>(await panel('DELETE', `/${id}/problems/${copied.id}`))
  assert.deepEqual(left.problems.map((p) => p.letter), ['A'])
})

test('a contest opens only when it is ready, and says why not', async () => {
  const id = (await json<ContestView>(await panel('POST', '', { title: 'Не готов', slug: 'not-ready' }))).contest.id
  const refused = await panel('POST', `/${id}/open`)
  assert.equal(refused.status, 409)
  const body = (await refused.json()) as { reason: string; readiness: string[] }
  assert.equal(body.reason, 'not_ready')
  assert.ok(body.readiness.length > 0)
  const { contest } = await openContest()
  assert.equal(contest.state, 'live')
  assert.ok(contest.startsAt !== null, 'opened without a start, it starts now: the ICPC clock needs one')
  assert.equal((await panel('POST', `/${contest.id}/open`)).status, 409, 'not a draft any more')
})

/* ----------------------------------------------------- the participant */

test('the /k list and the page: drafts and hidden contests do not exist; problems wait for the start', async () => {
  const { contest } = await openContest({ startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000 })
  const draft = await json<ContestView>(await panel('POST', '', { title: 'Черновик', slug: 'draft-hidden' }))
  const list = await json<EntrantContestList>(await door('GET', ''))
  assert.ok(list.contests.some((row) => row.contest.id === contest.id))
  assert.equal(list.contests.some((row) => row.contest.id === draft.contest.id), false)
  assert.equal((await door('GET', '/draft-hidden')).status, 404)
  // A not-started contest: the page, with no problems.
  const view = await json<EntrantContestView>(await door('GET', `/${contest.slug}`))
  assert.equal(view.accepting, 'not_open')
  assert.deepEqual(view.problems, [])
  assert.equal(view.mine, null)
  assert.ok(Math.abs(view.now - Date.now()) < 5000)
  for (const field of ['createdBy', 'courseId', 'hiddenAt']) assert.equal(field in view.contest, false, field)
  // Staff preview their draft read-only, problems included.
  const preview = await json<EntrantContestView>(await door('GET', '/draft-hidden', teacher.cookie))
  assert.equal(preview.contest.id, draft.contest.id)
  const early = await json<EntrantContestView>(await door('GET', `/${contest.slug}`, teacher.cookie))
  assert.equal(early.problems.length, 1, 'the author previews the problems before the start')
  // Taken off publication: gone for everyone but the projector's class view.
  assert.equal((await panel('POST', `/${contest.id}/hide`)).status, 200)
  assert.equal((await door('GET', `/${contest.slug}`)).status, 404)
  assert.equal((await door('GET', `/${contest.slug}`, teacher.cookie)).status, 404)
  assert.equal((await door('GET', `/${contest.slug}?audience=class`, teacher.cookie)).status, 200)
  assert.equal((await json<EntrantContestList>(await door('GET', ''))).contests.some((row) => row.contest.id === contest.id), false)
  assert.equal((await panel('POST', `/${contest.id}/show`)).status, 200)
  assert.equal((await door('GET', `/${contest.slug}`)).status, 200)
})

test('joining: a handle, a key for a newcomer, a namesake refused, a returning person renamed', async () => {
  const { contest } = await openContest({ startsAt: Date.now() + 3_600_000 })
  // Before the start a class registers.
  const bad = await door('POST', `/${contest.slug}/join`, undefined, { name: 'Анна Ким' })
  assert.equal(bad.status, 400)
  const joined = await door('POST', `/${contest.slug}/join`, undefined, { name: '@Anna_Kim' })
  assert.equal(joined.status, 200)
  const me = await json<EntrantMe>(joined)
  assert.equal(me.entrant?.name, '@anna_kim')
  assert.match(me.key ?? '', /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/)
  assert.match(me.link ?? '', /\/k\/t\//)
  const cookie = setCookieOf(joined)
  assert.ok(cookie)
  const twin = await door('POST', `/${contest.slug}/join`, undefined, { name: 'anna_kim' })
  assert.equal(twin.status, 409)
  assert.equal(await reason(twin), 'name_taken')
  // Signed in, joining again keeps the key out of the answer.
  const back = await json<EntrantMe>(await door('POST', `/${contest.slug}/join`, cookie, { name: '' }))
  assert.equal(back.key, null)
  const view = await json<EntrantContestView>(await door('GET', `/${contest.slug}`, cookie))
  assert.equal(view.mine?.joined, true)
  // A contest over, without upsolving: closed.
  const over = await openContest()
  updateContest(over.contest.id, { endsAt: Date.now() - 1000 })
  const late = await door('POST', `/${over.contest.slug}/join`, cookie, { name: '' })
  assert.equal(late.status, 403)
  assert.equal(await reason(late), 'closed')
})

test('sending: every refusal by its word, in the order a person understands them', async () => {
  const { contest, problem } = await openContest({ attemptsPerProblem: 2 })
  const path = `/${contest.slug}/submissions`
  const body = (over: Record<string, unknown> = {}) => ({ problemId: problem.id, language: 'cpp20', source: 'ok', ...over })
  assert.equal((await door('POST', path, undefined, body())).status, 401)
  const outsider = createEntrant('@not_joined_one')
  const notJoined = await door('POST', path, entrantCookie(outsider.entrant), body())
  assert.equal(notJoined.status, 403)
  assert.equal(await reason(notJoined), 'not_joined')
  const p = participant(contest.id, '@sender_one')
  const expect = async (over: Record<string, unknown>, status: number, word: string, cookie = p.cookie) => {
    const res = await door('POST', path, cookie, body(over))
    assert.equal(res.status, status, `${JSON.stringify(over)}: ${await res.clone().text()}`)
    assert.equal(await reason(res), word)
  }
  await expect({ problemId: 'nope' }, 400, 'invalid')
  await expect({ language: 'java' }, 400, 'language')
  await expect({ language: 'c17' }, 400, 'language')
  await expect({ source: '   ' }, 400, 'invalid')
  await expect({ source: 'x'.repeat(70_000) }, 413, 'too_big')
  // The language taken by the contest but missing in the image.
  updateContest(contest.id, { languages: ['cpp20', 'c17'] })
  await expect({ language: 'c17' }, 400, 'language')
  // Accepted.
  const sent = await door('POST', path, p.cookie, body())
  assert.equal(sent.status, 201)
  const accepted = await json<SubmitAccepted>(sent)
  assert.equal(accepted.submission.number >= 1, true)
  assert.equal(accepted.submission.letter, 'A')
  assert.equal(accepted.submission.state, 'queued')
  // At once again: one per five seconds.
  await expect({}, 429, 'too_often')
  // Two pending: the third waits for a verdict.
  const q = participant(contest.id, '@sender_two')
  sendAt(contest.id, problem.id, q.id, 'ok', Date.now() - 20_000)
  sendAt(contest.id, problem.id, q.id, 'ok', Date.now() - 10_000)
  await expect({}, 409, 'in_flight', q.cookie)
  await drainContestJudge()
  // Two attempts spent (both judged OK, which spends too): the limit.
  await expect({}, 409, 'attempts', q.cookie)
  // Not started, and over: the contest's own words.
  updateContest(contest.id, { startsAt: Date.now() + 60_000 })
  await expect({}, 403, 'not_open', participant(contest.id, '@sender_three').cookie)
  updateContest(contest.id, { startsAt: Date.now() - 60_000, endsAt: Date.now() - 1000 })
  await expect({}, 403, 'closed', participant(contest.id, '@sender_four').cookie)
})

test('a participant reads their own submissions only, and of a hidden test nothing but its verdict', async () => {
  const { contest, problem } = await openContest()
  const p = participant(contest.id, '@reader_one')
  const other = participant(contest.id, '@reader_two')
  const hidden = sendAt(contest.id, problem.id, p.id, 'wa 2', Date.now() - 2000)
  const sample = sendAt(contest.id, problem.id, p.id, 'wa 1', Date.now() - 1000)
  const theirs = sendAt(contest.id, problem.id, other.id, 'ok', Date.now() - 500)
  await drainContestJudge()
  const mine = await json<EntrantContestSubmissions>(await door('GET', `/${contest.slug}/submissions`, p.cookie))
  assert.deepEqual(mine.submissions.map((s) => s.id), [sample.id, hidden.id], 'newest first, mine only')
  assert.equal(typeof mine.version, 'string')
  const row = mine.submissions[1]
  assert.equal(row.verdict, 'WA')
  assert.equal(row.failedTest, 2)
  assert.deepEqual(row.strip, ['OK', 'WA', 'skipped'])
  const detail = await json<EntrantSubmissionDetail>(await door('GET', `/${contest.slug}/submissions/${hidden.id}`, p.cookie))
  assert.equal(detail.source, 'wa 2')
  const failed = detail.tests.find((t) => t.ordinal === 2)!
  assert.deepEqual(Object.keys(failed).sort(), ['memoryKb', 'ordinal', 'sample', 'timeMs', 'verdict'])
  const onSample = await json<EntrantSubmissionDetail>(await door('GET', `/${contest.slug}/submissions/${sample.id}`, p.cookie))
  const first = onSample.tests.find((t) => t.ordinal === 1)!
  assert.equal(first.input, '1 2\n')
  assert.equal(first.answer, '3\n')
  assert.equal(first.output, 'wrong')
  assert.equal(first.note, 'token 1: expected 5, got 4')
  assert.equal(first.exit, undefined, 'the exit code is staff\'s')
  assert.equal(first.stderr, undefined, 'stderr is staff\'s')
  // Someone else's submission is a missing one.
  assert.equal((await door('GET', `/${contest.slug}/submissions/${theirs.id}`, p.cookie)).status, 404)
  // Signed in but not joined: an empty list, not a refusal.
  const outsider = createEntrant('@reader_outsider')
  const empty = await json<EntrantContestSubmissions>(await door('GET', `/${contest.slug}/submissions`, entrantCookie(outsider.entrant)))
  assert.deepEqual(empty.submissions, [])
  assert.equal((await door('GET', `/${contest.slug}/submissions`)).status, 401)
})

test('the page never carries the reference, the checker\'s code or a hidden test\'s data', async () => {
  const { contest } = await openContest()
  const p = participant(contest.id, '@privacy_one')
  const raw = await (await door('GET', `/${contest.slug}`, p.cookie)).text()
  const view = JSON.parse(raw) as EntrantContestView
  const problem = view.problems[0]
  assert.equal('referenceSource' in problem, false)
  assert.equal('checkerCode' in problem, false)
  assert.equal(problem.checker, 'custom')
  assert.doesNotMatch(raw, /def check/)
  assert.deepEqual(problem.samples, [{ ordinal: 1, input: '1 2\n', answer: '3\n', truncated: false }])
  assert.equal(problem.tests, 3)
  // Test 2's answer is hidden: it appears nowhere in the page.
  assert.doesNotMatch(raw, /"30\\n"/)
  assert.deepEqual(view.languages.map((l) => l.id), ['python3', 'cpp20'])
  assert.equal(problem.mine?.attemptsLeft, null)
})

test('a running ICPC judging grows its strip with the tests it finished', async () => {
  const { contest, problem } = await openContest()
  const p = participant(contest.id, '@strip_one')
  const sent = sendAt(contest.id, problem.id, p.id, 'ok', Date.now() - 1000)
  judge.holding = true
  const original = judge.judge.bind(judge)
  judge.judge = async (request) => {
    request.onProgress?.({ phase: 'test', test: 3, done: 2, total: 3 })
    return original(request)
  }
  try {
    const { pumpContestJudge } = await import('../server/src/contests/pump.js')
    pumpContestJudge()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const mine = await json<EntrantContestSubmissions>(await door('GET', `/${contest.slug}/submissions`, p.cookie))
    const row = mine.submissions.find((s) => s.id === sent.id)!
    assert.equal(row.state, 'running')
    assert.deepEqual(row.strip, ['OK', 'OK'])
    const view = await json<EntrantContestView>(await door('GET', `/${contest.slug}`, p.cookie))
    assert.equal(view.problems[0].mine?.pending, true)
    assert.equal(view.problems[0].mine?.pendingTest, 3)
  } finally {
    judge.judge = original
    judge.holding = false
    judge.release()
    await drainContestJudge()
  }
})

/* ------------------------------------------------------------ the board */

test('the freeze is per viewer: everyone sees their own attempts, nobody else\'s after the freeze; staff see all', async () => {
  const now = Date.now()
  const { contest, problem } = await openContest({ startsAt: now - 60 * 60_000, endsAt: now + 30 * 60_000, freezeMinutes: 60 })
  // The freeze began half an hour ago.
  const early = participant(contest.id, 'early.bird@hse.ru')
  const late = participant(contest.id, '@late_bird')
  sendAt(contest.id, problem.id, early.id, 'ok', now - 45 * 60_000)
  sendAt(contest.id, problem.id, late.id, 'wa 2', now - 50 * 60_000)
  sendAt(contest.id, problem.id, late.id, 'ok', now - 10 * 60_000)
  await drainContestJudge()
  const board = (cookie?: string, query = '') => door('GET', `/${contest.slug}/standings${query}`, cookie)
  // The late bird sees their own solve, the early bird's whole name masked.
  const theirs = await json<EntrantStandings>(await board(late.cookie))
  assert.equal(theirs.frozen, true)
  assert.equal(theirs.me, late.id)
  const lateRow = theirs.rows.find((r) => r.entrantId === late.id)!
  assert.equal(lateRow.cells[0].solved, true)
  assert.equal(lateRow.cells[0].attempts, 1)
  assert.equal(lateRow.name, '@late_bird')
  assert.equal(theirs.rows.find((r) => r.entrantId === early.id)!.name, 'ear…@hse.ru')
  // The early bird sees the late bird's last attempt as frozen, not solved.
  const earlyView = await json<EntrantStandings>(await board(early.cookie))
  const seenLate = earlyView.rows.find((r) => r.entrantId === late.id)!
  assert.equal(seenLate.cells[0].solved, false)
  assert.equal(seenLate.cells[0].frozen, 1)
  assert.equal(earlyView.rows.find((r) => r.entrantId === early.id)!.name, 'early.bird@hse.ru', 'their own name whole')
  assert.equal(earlyView.rows[0].entrantId, early.id)
  // A stranger: the frozen board, every email masked.
  const anyone = await json<EntrantStandings>(await board())
  assert.equal(anyone.me, null)
  assert.equal(anyone.rows.find((r) => r.entrantId === late.id)!.cells[0].frozen, 1)
  // Staff: everything, every name whole — and the projector's class view, with no «me».
  const staff = await json<AdminStandings>(await panel('GET', `/${contest.id}/standings`))
  assert.equal(staff.rows.find((r) => r.entrantId === late.id)!.cells[0].solved, true)
  assert.equal(staff.rows.find((r) => r.entrantId === early.id)!.name, 'early.bird@hse.ru')
  const projector = await json<EntrantStandings>(await board(`${teacher.cookie}; ${late.cookie}`, '?audience=class'))
  assert.equal(projector.me, null)
  assert.equal(projector.rows.find((r) => r.entrantId === late.id)!.cells[0].frozen, 1)
  assert.equal(projector.rows.find((r) => r.entrantId === early.id)!.name, 'ear…@hse.ru')
  // The reveal is the teacher's moment.
  assert.equal((await panel('POST', `/${contest.id}/unfreeze`)).status, 200)
  const revealed = await json<EntrantStandings>(await board(early.cookie))
  assert.equal(revealed.frozen, false)
  assert.equal(revealed.rows.find((r) => r.entrantId === late.id)!.cells[0].solved, true)
  assert.equal((await panel('POST', `/${contest.id}/unfreeze`)).status, 409, 'nothing frozen any more')
  // The final table for grading: unfrozen, whole names, a BOM, a header.
  const csv = await call(app.base, 'GET', `/api/admin/contests/${contest.id}/standings.csv`, { cookie: teacher.cookie })
  assert.equal(csv.status, 200)
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/)
  // The bytes, not text(): a decoder takes the byte order mark off, and Excel needs it there.
  const bytes = Buffer.from(await csv.arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const lines = bytes.subarray(3).toString('utf8').trim().split('\r\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /"A"/)
  assert.match(lines[1], /"early\.bird@hse\.ru"/)
  // A handle starting with «@» is led by an apostrophe: a spreadsheet must not take it for a formula.
  assert.match(lines[2], /"'@late_bird"/)
  assert.match(lines[2], /"'\+1 0:50"/)
})

test('a board for participants only answers a stranger with its refusal', async () => {
  const { contest } = await openContest({ boardVisibility: 'entrants' })
  const anonymous = await door('GET', `/${contest.slug}/standings`)
  assert.equal(anonymous.status, 401)
  assert.equal(await reason(anonymous), 'board_closed')
  const outsider = createEntrant('@board_outsider')
  const signedIn = await door('GET', `/${contest.slug}/standings`, entrantCookie(outsider.entrant))
  assert.equal(signedIn.status, 403)
  const p = participant(contest.id, '@board_insider')
  assert.equal((await door('GET', `/${contest.slug}/standings`, p.cookie)).status, 200)
  assert.equal((await door('GET', `/${contest.slug}/standings`, teacher.cookie)).status, 200)
})

test('upsolving: after the end a submission is taken as late, and never reaches the board', async () => {
  const { contest, problem } = await openContest({ upsolving: true })
  updateContest(contest.id, { endsAt: Date.now() - 1000 })
  const p = participant(contest.id, '@upsolver_one')
  const sent = await door('POST', `/${contest.slug}/submissions`, p.cookie, { problemId: problem.id, language: 'python3', source: 'ok' })
  assert.equal(sent.status, 201)
  const accepted = await json<SubmitAccepted>(sent)
  assert.equal(accepted.submission.late, true)
  await drainContestJudge()
  assert.equal(getSubmission(accepted.submission.id)!.verdict, 'OK')
  const board = await json<EntrantStandings>(await door('GET', `/${contest.slug}/standings`, p.cookie))
  assert.equal(board.rows.find((r) => r.entrantId === p.id)!.solved, 0)
  const view = await json<EntrantContestView>(await door('GET', `/${contest.slug}`, p.cookie))
  assert.equal(view.accepting, 'late')
  assert.equal(view.problems[0].mine?.solved, true, 'the rail is the person\'s, upsolving included')
})

/* --------------------------------------------------------- questions */

test('questions: one\'s own and the public ones; an answer to everyone becomes an announcement', async () => {
  const { contest, problem } = await openContest()
  const asker = participant(contest.id, '@asker_one')
  const neighbour = participant(contest.id, '@asker_two')
  assert.equal((await door('POST', `/${contest.slug}/questions`, undefined, { question: 'Можно?' })).status, 401)
  assert.equal((await door('POST', `/${contest.slug}/questions`, asker.cookie, { question: '   ' })).status, 400)
  const asked = await door('POST', `/${contest.slug}/questions`, asker.cookie, { problemId: problem.id, question: 'Числа целые?' })
  assert.equal(asked.status, 201)
  const question = await json<ContestQuestion>(asked)
  assert.equal(question.letter, 'A')
  assert.equal(question.mine, true)
  const again = await door('POST', `/${contest.slug}/questions`, asker.cookie, { question: 'И ещё?' })
  assert.equal(again.status, 429)
  assert.deepEqual((await json<EntrantQuestions>(await door('GET', `/${contest.slug}/questions`, neighbour.cookie))).questions, [])
  const inbox = await json<AdminQuestions>(await panel('GET', `/${contest.id}/questions`))
  assert.equal(inbox.unanswered, 1)
  assert.equal(inbox.questions[0].entrant?.name, '@asker_one')
  assert.equal((await panel('POST', `/${contest.id}/questions/${question.id}/answer`, { answer: 'Да, целые.', public: true })).status, 200)
  const seen = await json<EntrantQuestions>(await door('GET', `/${contest.slug}/questions`, neighbour.cookie))
  assert.equal(seen.questions.length, 1)
  assert.equal(seen.questions[0].public, true)
  assert.equal(seen.questions[0].mine, false)
  assert.equal(seen.questions[0].answer, 'Да, целые.')
  const announced = await panel('POST', `/${contest.id}/announcements`, { text: 'Тест 3 исправлен.' })
  assert.equal(announced.status, 201)
  const anonymous = await json<EntrantQuestions>(await door('GET', `/${contest.slug}/questions`))
  const announcement = anonymous.questions.find((q) => q.question === '')!
  assert.equal(announcement.answer, 'Тест 3 исправлен.')
  assert.equal(announcement.public, true)
  const before = await json<EntrantContestView>(await door('GET', `/${contest.slug}`, neighbour.cookie))
  assert.equal(before.mine?.unreadAnswers, 2)
  assert.equal((await door('POST', `/${contest.slug}/questions/seen`, neighbour.cookie)).status, 200)
  const after = await json<EntrantContestView>(await door('GET', `/${contest.slug}`, neighbour.cookie))
  assert.equal(after.mine?.unreadAnswers, 0)
  const removed = await json<AdminQuestions>(await panel('DELETE', `/${contest.id}/questions/${question.id}`))
  assert.equal(removed.questions.some((q) => q.id === question.id), false)
})

/* -------------------------------------------------------------- streams */

/** The `state` events of a stream, read as they come. */
async function readStream(path: string, cookie?: string) {
  const controller = new AbortController()
  const res = await fetch(`${app.base}${path}`, { headers: cookie ? { cookie } : {}, signal: controller.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next<T>(): Promise<T> {
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = frame.split('\n').find((line) => line.startsWith('data: '))
          if (frame.startsWith('event: state') && data) return JSON.parse(data.slice(6)) as T
          continue
        }
        const chunk = await reader.read()
        if (chunk.done) throw new Error('the stream ended')
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    },
    close: () => controller.abort(),
  }
}

test('the participant\'s stream: the versions at once, and a push when a verdict lands', async () => {
  const { contest, problem } = await openContest()
  const p = participant(contest.id, '@streamer_one')
  const stream = await readStream(`/api/k/contests/${contest.slug}/stream`, p.cookie)
  try {
    const first = await stream.next<ContestStreamState>()
    assert.equal(first.revision, getContest(contest.id)!.revision)
    const mine = await json<EntrantContestSubmissions>(await door('GET', `/${contest.slug}/submissions`, p.cookie))
    assert.equal(first.mine, mine.version, 'the stream\'s «mine» is the list\'s version')
    assert.ok(first.board)
    assert.ok(first.questions)
    sendAt(contest.id, problem.id, p.id, 'ok', Date.now() - 1000)
    await drainContestJudge()
    let next = await stream.next<ContestStreamState>()
    while (next.mine !== (await json<EntrantContestSubmissions>(await door('GET', `/${contest.slug}/submissions`, p.cookie))).version) {
      next = await stream.next<ContestStreamState>()
    }
    assert.notEqual(next.mine, first.mine)
    assert.notEqual(next.board, first.board)
  } finally {
    stream.close()
  }
})

test('the console\'s stream carries this contest\'s queue and the judge', async () => {
  const { contest } = await openContest()
  const stream = await readStream(`/api/admin/contests/${contest.id}/stream`, teacher.cookie)
  try {
    const state = await stream.next<{ revision: number; queued: number; running: number; submissions: string; questions: string; judge: JudgeStatus; now: number }>()
    assert.equal(state.revision, getContest(contest.id)!.revision)
    assert.equal(state.queued, 0)
    assert.equal(state.running, 0)
    assert.equal(state.judge.backend, 'test')
    assert.equal(typeof state.submissions, 'string')
  } finally {
    stream.close()
  }
  assert.equal((await call(app.base, 'GET', `/api/admin/contests/${contest.id}/stream`, { cookie: stranger.cookie })).status, 404)
})

/* ----------------------------------------------- the console's actions */

test('rejudge one, a problem\'s, the stale ones; finish, reopen; the feed\'s filters', async () => {
  const { contest, problem } = await openContest()
  const p = participant(contest.id, '@rejudged_one')
  const sent = sendAt(contest.id, problem.id, p.id, 'wa 2', Date.now() - 1000)
  await drainContestJudge()
  const byVerdict = await json<AdminSubmissions>(await panel('GET', `/${contest.id}/submissions?verdict=WA&problem=A`))
  assert.deepEqual(byVerdict.submissions.map((s) => s.id), [sent.id])
  assert.equal(byVerdict.submissions[0].entrant?.name, '@rejudged_one')
  assert.equal((await json<AdminSubmissions>(await panel('GET', `/${contest.id}/submissions?verdict=OK`))).total, 0)
  assert.equal((await json<AdminSubmissions>(await panel('GET', `/${contest.id}/submissions?q=rejudged`))).total, 1)
  assert.equal((await json<AdminSubmissions>(await panel('GET', `/${contest.id}/submissions?q=%23${sent.number}`))).total, 1)
  assert.equal((await panel('GET', `/${contest.id}/submissions?verdict=XX`)).status, 400)
  const detail = await json<AdminSubmissionDetail>(await panel('GET', `/${contest.id}/submissions/${sent.id}`))
  assert.equal(detail.tests.find((t) => t.ordinal === 2)!.answer, '30\n', 'staff read the hidden test\'s data')
  assert.equal(detail.tests.find((t) => t.ordinal === 2)!.stderr, 'some stderr')
  const one = await panel('POST', `/${contest.id}/submissions/${sent.id}/rejudge`)
  assert.equal(one.status, 200)
  assert.equal((await json<{ state: string }>(one)).state, 'queued')
  await drainContestJudge()
  assert.deepEqual(await json<{ queued: number }>(await panel('POST', `/${contest.id}/problems/${problem.id}/rejudge`, { stale: true })), { queued: 0 })
  assert.deepEqual(await json<{ queued: number }>(await panel('POST', `/${contest.id}/problems/${problem.id}/rejudge`)), { queued: 1 })
  await drainContestJudge()
  assert.equal((await panel('POST', `/${contest.id}/finish`)).status, 200)
  assert.equal(getContest(contest.id)!.state, 'finished')
  assert.equal((await panel('POST', `/${contest.id}/finish`)).status, 409)
  assert.equal((await panel('POST', `/${contest.id}/reopen`)).status, 200)
  assert.equal(getContest(contest.id)!.state, 'live')
})

test('removing a participant: their rows go, the key goes only when nothing else holds them', async () => {
  const { contest, problem } = await openContest()
  const p = participant(contest.id, '@removed_one')
  const stays = participant(contest.id, '@stays_one')
  const theirs = sendAt(contest.id, problem.id, p.id, 'ok', Date.now() - 2000)
  const kept = sendAt(contest.id, problem.id, stays.id, 'ok', Date.now() - 1000)
  await drainContestJudge()
  assert.equal((await panel('DELETE', `/${contest.id}/entrants/${p.id}`, undefined, stranger.cookie)).status, 404)
  const res = await panel('DELETE', `/${contest.id}/entrants/${p.id}`)
  assert.equal(res.status, 200)
  const left = await json<{ entrants: { id: string }[] }>(res)
  assert.deepEqual(left.entrants.map((e) => e.id), [stays.id])
  assert.equal(getSubmission(theirs.id), null)
  assert.ok(getSubmission(kept.id))
  assert.equal(getEntrant(p.id), null, 'in nothing else: the identity went with them')
  assert.equal((await panel('DELETE', `/${contest.id}/entrants/${p.id}`)).status, 404)
})

test('the instance\'s doors: the judge\'s slots and pause are an owner\'s', async () => {
  const settings = await json<ContestSettings>(await panel('GET', '/settings'))
  assert.ok(settings.autoSlots >= 1)
  assert.equal((await panel('PUT', '/settings', { judgeSlots: 3 })).status, 403)
  const saved = await json<ContestSettings>(await panel('PUT', '/settings', { judgeSlots: 3 }, owner.cookie))
  assert.equal(saved.judgeSlots, 3)
  assert.equal((await panel('PUT', '/settings', { judgeSlots: 100 }, owner.cookie)).status, 400)
  assert.equal((await json<ContestSettings>(await panel('PUT', '/settings', { judgeSlots: null }, owner.cookie))).judgeSlots, null)
  assert.equal((await panel('POST', '/judge/pause', { paused: true })).status, 403)
  assert.equal((await json<JudgeStatus>(await panel('POST', '/judge/pause', { paused: true }, owner.cookie))).paused, true)
  assert.equal((await json<JudgeStatus>(await panel('POST', '/judge/pause', { paused: false }, owner.cookie))).paused, false)
})

test('without a judge here a submission is refused, and the contest cannot open', async () => {
  const { contest, problem } = await openContest()
  const p = participant(contest.id, '@no_judge_one')
  useContestJudge(null)
  const saved = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'broker'
  try {
    const res = await door('POST', `/${contest.slug}/submissions`, p.cookie, { problemId: problem.id, language: 'python3', source: 'ok' })
    assert.equal(res.status, 503)
    assert.equal(await reason(res), 'unavailable')
    const draft = await json<ContestView>(await panel('POST', '', { title: 'Без проверки', slug: 'no-judge-open' }))
    assert.equal(draft.judge.backend, 'none')
    assert.ok(draft.readiness.length >= 2)
  } finally {
    if (saved === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = saved
    useContestJudge(judge)
    forgetLanguageProbes()
  }
})

test('every contest action of the panel is in the audit log, by its own name', async () => {
  // Every one of them was driven through its door above.
  const recorded = new Set((db.prepare("SELECT DISTINCT action FROM admin_audit_log WHERE action LIKE 'contest.%'").all() as { action: string }[]).map((row) => row.action))
  const contestActions = ADMIN_AUDIT_ACTIONS.filter((action) => action.startsWith('contest.'))
  assert.equal(contestActions.length, 11)
  assert.deepEqual(contestActions.filter((action) => !recorded.has(action)), [])
  // A person removed is named by id only: this log is the staff's, not a copy of the class.
  const removal = db.prepare("SELECT target_type, target_id, target_label FROM admin_audit_log WHERE action = 'contest.entrant.removed'").get() as {
    target_type: string
    target_id: string
    target_label: string | null
  }
  assert.equal(removal.target_type, 'entrant')
  assert.equal(removal.target_label, null)
})
