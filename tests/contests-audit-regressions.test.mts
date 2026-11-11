import './_env.mts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, beforeEach, mock, test } from 'node:test'
import { db } from '../server/src/db.js'
import { createEntrant, rotateEntrantKey } from '../server/src/competitions/store.js'
import {
  addProblem, createContest, deleteProblemRows, enqueueTeacherRun, getContest, getProblem,
  getSubmission, joinContest, listEntrantSubmissions, replaceGroups, setContestState,
  submitSolution, updateContest, updateProblem,
} from '../server/src/contests/store.js'
import { changeTests } from '../server/src/contests/revisions.js'
import { useContestJudge } from '../server/src/contests/judge/port.js'
import { DockerContestJudge, useDockerForContests } from '../server/src/contests/judge/docker-judge.js'
import { drainContestJudge, environmentImage, forgetLanguageProbes, pauseContestJudge, pumpContestJudge, stopContestJudge } from '../server/src/contests/pump.js'
import { contestReadiness, referenceStatus } from '../server/src/contests/readiness.js'
import { entrantCookie, stubJudge, type StubJudge } from './_contests.mts'
import { buildRequest, harnessRunnable, runHarnessNoSandbox } from './_contest-judge.mts'
import { call, startApp, type Running } from './_scoping.mts'

let judge: StubJudge
let app: Running
let serial = 0
before(async () => { app = await startApp() })
beforeEach(async () => {
  await drainContestJudge()
  judge = stubJudge()
  useContestJudge(judge)
  pauseContestJudge(false)
})
after(async () => { await stopContestJudge(); useContestJudge(null); app?.close() })

function fixture(rules: 'icpc' | 'ioi' = 'icpc') {
  const contest = createContest({ slug: `audit-regression-${++serial}`, title: 'Audit regression', rules })!
  setContestState(contest.id, 'live')
  const made = addProblem(contest.id, { title: 'Copy except 2', referenceSource: 'ok', points: 'tests' })
  assert.notEqual(made, 'full')
  if (made === 'full') throw new Error('full')
  changeTests(made, [1, 2, 3].map((n) => ({ sample: n === 1, group: 0, input: { bytes: Buffer.from(`${n}\n`) }, answer: { bytes: Buffer.from(`${n}\n`) }, answerFrom: 'upload' as const })))
  const entrant = createEntrant(`@audit_reg_${serial}`).entrant
  joinContest(contest.id, entrant.id, entrant.name)
  return { contest: getContest(contest.id)!, problem: getProblem(made.id)!, entrant }
}
function send(f: ReturnType<typeof fixture>, source = 'ok') {
  return submitSolution({ contestId: f.contest.id, problemId: f.problem.id, entrantId: f.entrant.id, language: 'python3', source, late: false, attemptsPerProblem: 0 })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

for (const mode of ['tests', 'groups'] as const) {
  test(`IOI ${mode}: real Python harness respects effective groups after a hidden failure`, { skip: !harnessRunnable().ok }, async () => {
    const f = fixture('ioi')
    updateProblem(f.problem.id, { points: mode })
    if (mode === 'groups') replaceGroups(f.problem.id, [{ group: 0, points: 100 }])
    judge.judge = async (request) => {
      const built = buildRequest({ source: request.source, language: request.language, mode: request.mode, tests: request.tests.map((t) => ({ ...t, input: fs.readFileSync(path.join(request.testsDir, `${t.ordinal}.in`), 'utf8'), answer: t.answer!.toString() })) })
      try { return runHarnessNoSandbox(built).outcome } finally { built.cleanup() }
    }
    const sent = send(f, 'n = int(input())\nprint(0 if n == 2 else n)\n')
    assert.ok('submission' in sent)
    await drainContestJudge()
    const result = getSubmission(sent.submission.id)!
    assert.deepEqual(result.report!.tests.map((t) => t.verdict), mode === 'tests' ? ['OK', 'WA', 'OK'] : ['OK', 'WA', 'skipped'])
    assert.equal(result.score, mode === 'tests' ? 50 : 0)
  })
}

test('submission transaction rejects a deleted or foreign problem without writing a row', () => {
  const f = fixture()
  deleteProblemRows(f.problem.id)
  assert.deepEqual(send(f), { refusal: 'problem' })
  const other = fixture()
  assert.deepEqual(send({ ...f, problem: other.problem }), { refusal: 'problem' })
  assert.deepEqual(listEntrantSubmissions(f.contest.id, f.entrant.id), [])
})

test('an orphan queue head is settled without consuming a start or blocking another contest', async () => {
  const broken = fixture()
  const sent = send(broken)
  assert.ok('submission' in sent)
  // A legacy bad row left by the old intake race, before this transaction existed.
  db.prepare('DELETE FROM contest_problems WHERE id = ?').run(broken.problem.id)
  const healthy = fixture()
  const accepted = send(healthy)
  assert.ok('submission' in accepted)
  assert.equal(pumpContestJudge(), 1)
  await drainContestJudge()
  assert.equal(getSubmission(sent.submission.id)!.state, 'failed')
  assert.equal(getSubmission(sent.submission.id)!.verdict, 'SE')
  assert.equal(getSubmission(sent.submission.id)!.starts, 0)
  assert.equal(getSubmission(accepted.submission.id)!.verdict, 'OK')
  assert.deepEqual([pumpContestJudge(), pumpContestJudge()], [0, 0])
})

for (const change of ['delete', 'language', 'environment', 'image'] as const) {
  test(`intake revalidates ${change} after a held language probe`, async () => {
    const f = fixture()
    let image = 'sha256:intake-before'
    judge.resolveImage = async () => image
    const entered = deferred()
    const release = deferred()
    judge.probe = async () => { entered.resolve(); await release.promise; return { python: '3.11', gpp: '12', gcc: null } }
    forgetLanguageProbes()
    const pending = call(app.base, 'POST', `/api/k/contests/${f.contest.slug}/submissions`, { cookie: entrantCookie(f.entrant), body: { problemId: f.problem.id, language: 'python3', source: 'ok' } })
    await entered.promise
    if (change === 'delete') deleteProblemRows(f.problem.id)
    if (change === 'language') updateContest(f.contest.id, { languages: ['cpp20'] })
    if (change === 'environment') updateContest(f.contest.id, { environment: 'changed' })
    if (change === 'image') image = 'sha256:intake-after'
    release.resolve()
    const response = await pending
    assert.equal(response.status, change === 'environment' || change === 'image' ? 503 : 400)
    assert.equal(listEntrantSubmissions(f.contest.id, f.entrant.id).length, 0)
  })
}

test('reference freshness includes the environment and same-name image rebuild', async () => {
  const f = fixture()
  let image = 'sha256:first'
  Object.assign(judge, { resolveImage: async () => image })
  enqueueTeacherRun(f.problem, 'reference')
  await drainContestJudge()
  assert.equal((await referenceStatus(f.problem)).state, 'passes')
  updateContest(f.contest.id, { environment: 'changed' })
  assert.equal((await referenceStatus(f.problem)).state, 'unchecked')
  updateContest(f.contest.id, { environment: f.contest.environment })
  image = 'sha256:rebuilt'
  const reasons = await contestReadiness(getContest(f.contest.id)!)
  assert.ok(reasons.length > 0, 'opening must refresh the image even inside the passive status cache lifetime')
  assert.equal((await referenceStatus(f.problem)).state, 'unchecked')
})

test('an image change while the reference runs cannot bless the replacement', async () => {
  const f = fixture()
  let image = 'sha256:started'
  Object.assign(judge, { resolveImage: async () => image })
  const entered = deferred()
  const release = deferred()
  const original = judge.judge.bind(judge)
  judge.judge = async (request) => { entered.resolve(); await release.promise; return original(request) }
  enqueueTeacherRun(f.problem, 'reference')
  pumpContestJudge()
  await entered.promise
  image = 'sha256:replacement'
  release.resolve()
  await drainContestJudge()
  assert.equal(judge.requests.at(-1)!.image, 'sha256:started', 'execution uses the immutable resolved image')
  assert.equal((await referenceStatus(f.problem)).state, 'unchecked', 'completion refreshes the image identity before claiming a pass')
  assert.ok((await contestReadiness(getContest(f.contest.id)!)).length > 0)
  assert.equal((await referenceStatus(f.problem)).state, 'unchecked')
})

test('opening readiness checks the current reference after its language probe completes', async () => {
  const f = fixture()
  enqueueTeacherRun(f.problem, 'reference')
  await drainContestJudge()
  forgetLanguageProbes()
  const entered = deferred()
  const release = deferred()
  judge.probe = async () => { entered.resolve(); await release.promise; return { python: '3.11', gpp: '12', gcc: null } }
  const pending = contestReadiness(getContest(f.contest.id)!)
  await entered.promise
  updateProblem(f.problem.id, { referenceSource: 'changed while checking readiness' })
  release.resolve()
  assert.ok((await pending).length > 0)
})

test('legacy reference reports without image metadata remain readable but require a new check', async () => {
  const f = fixture()
  const run = enqueueTeacherRun(f.problem, 'reference')
  await drainContestJudge()
  const report = getSubmission(run.id)!.report!
  delete report.environment
  db.prepare('UPDATE contest_submissions SET report = ? WHERE id = ?').run(JSON.stringify(report), run.id)
  assert.equal((await referenceStatus(f.problem)).state, 'unchecked')
  enqueueTeacherRun(f.problem, 'reference', Date.now() + 1)
  await drainContestJudge()
  assert.equal((await referenceStatus(f.problem)).state, 'passes')
})

test('passive image lookups coalesce and cache while explicit admission resolves again', async () => {
  let calls = 0
  judge.resolveImage = async () => `sha256:${++calls}`
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => environmentImage('base'))), Array(10).fill('sha256:1'))
  assert.equal(await environmentImage('base'), 'sha256:1')
  assert.equal(calls, 1)
  assert.equal(await environmentImage('base', true), 'sha256:2')
  assert.equal(calls, 2)
  judge.resolveImage = async () => { throw new Error('image disappeared') }
  assert.equal(await environmentImage('base', true), null)
  assert.equal(await environmentImage('base'), null, 'a failed refresh cannot reuse the old image')
})

test('Docker image resolution pins a validated immutable ID and rejects failed or malformed inspect output', async () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const docker = new DockerContestJudge()
  try {
    useDockerForContests(async (args) => {
      assert.deepEqual(args, ['image', 'inspect', 'colloq-kernel:base', '--format', '{{.Id}}'])
      return { code: 0, out: digest }
    })
    assert.equal(await docker.resolveImage('colloq-kernel:base'), digest)
    useDockerForContests(async () => ({ code: 0, out: 'colloq-kernel:base' }))
    await assert.rejects(docker.resolveImage('colloq-kernel:base'), /Cannot resolve/)
    useDockerForContests(async () => ({ code: 1, out: digest }))
    await assert.rejects(docker.resolveImage('colloq-kernel:base'), /Cannot resolve/)
  } finally { useDockerForContests(null) }
})

test('SSE version matches the submissions response without parsing any reports', async () => {
  const f = fixture()
  const sent = send(f)
  assert.ok('submission' in sent)
  await drainContestJudge()
  const report = JSON.stringify({ tests: [], marker: 'report-must-not-be-parsed-for-version', padding: 'x'.repeat(100_000) })
  db.prepare('UPDATE contest_submissions SET report = ? WHERE id = ?').run(report, sent.submission.id)
  const cookie = entrantCookie(f.entrant)
  const full = await call(app.base, 'GET', `/api/k/contests/${f.contest.slug}/submissions`, { cookie })
  const version = (await full.json()).version
  let parsedReports = 0
  const parse = JSON.parse
  const spy = mock.method(JSON, 'parse', (raw, ...rest) => {
    if (typeof raw === 'string' && raw.includes('report-must-not-be-parsed-for-version')) parsedReports++
    return parse(raw, ...rest)
  })
  const control = new AbortController()
  try {
    const stream = await fetch(`${app.base}/api/k/contests/${f.contest.slug}/stream`, { headers: { cookie }, signal: control.signal })
    const chunk = await stream.body!.getReader().read()
    const frame = new TextDecoder().decode(chunk.value)
    assert.equal(JSON.parse(frame.split('data: ')[1].split('\n')[0]).mine, version)
    assert.equal(parsedReports, 0)
  } finally { control.abort(); spy.mock.restore() }
})

test('a contest stream ends before private updates after an ordinary key rotation', async () => {
  const f = fixture()
  const control = new AbortController()
  try {
    const stream = await fetch(`${app.base}/api/k/contests/${f.contest.slug}/stream`, { headers: { cookie: entrantCookie(f.entrant) }, signal: control.signal })
    const reader = stream.body!.getReader()
    assert.equal((await reader.read()).done, false)
    rotateEntrantKey(f.entrant.id)
    updateContest(f.contest.id, { title: 'Changed after revocation' })
    const next = await reader.read()
    assert.equal(next.done, true)
  } finally { control.abort() }
})
