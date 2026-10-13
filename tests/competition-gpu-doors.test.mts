/**
 * Which doors of a GPU competition need a runner card, and which never do.
 *
 * A card is asked for by the work that runs the notebook: the upload, the
 * baseline check, a rerun. The metric never gets one (it holds the hidden
 * answers), and preparing a participant's packages runs no notebook at all.
 * A door that asked for a card it would never use refused real work in the
 * wrong words: after the owner gave the cards back to classes, a teacher who
 * fixed score() could not rescore, being told "this competition needs a GPU";
 * and a participant was offered package preparation the server then refused
 * the same way.
 *
 * No docker and no card: no KERNEL_GPUS and no COMPETITION_GPUS, so no card
 * is given to submissions here, and the pump is not running — what a door
 * enqueues stays in the queue for the test to see.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { tr } from '../shared/i18n.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { Competition, Submission } from '../shared/competitions.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  joinCompetition,
  leaveQueue,
  queueRow,
  queueRows,
  setCompetitionState,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { putSubmissionNotebook, resultDir, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { issueEntrantCookie } from '../server/src/competitions/identity.js'
import { putRevision, selectRevision, setPolicy } from '../server/src/dependencies/store.js'
import { app } from '../server/src/app.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'

/** No card setting from the developer's shell: no card is given to submissions here. */
for (const key of ['KERNEL_GPUS', 'COMPETITION_GPUS', 'COMPETITION_GPU_PER_DEVICE', 'COMPETITION_BACKEND']) delete process.env[key]

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.closeAllConnections?.()
  server?.close()
})

function ownerCookie(email: string): string {
  const teacher = createTeacher({ name: 'Хозяйка дверей', email, role: 'owner' })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function call(url: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${url}`, { ...init, headers, signal: AbortSignal.timeout(10_000) })
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

let seq = 0

/** A competition with its card on, on the GPU environment, as a teacher made it. */
function gpuCompetition(): Competition {
  seq += 1
  const made = createCompetition({
    slug: `gpu-door-${seq}`,
    title: `GPU door ${seq}`,
    environment: 'base-gpu',
    limits: { wallSeconds: 600, memoryMb: 2048, cpus: 2, perDay: 0, gpu: true },
  })
  assert.ok(made)
  assert.equal(made.limits.gpu, true)
  return made
}

/** A submission that was scored, with its answer still on disk: what a rescore reads. */
function scored(competition: Competition, name: string): Submission {
  const entrant = createEntrant(name).entrant
  const submission = acceptSubmission({ competitionId: competition.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100 })
  leaveQueue(submission.id)
  putSubmissionNotebook(competition.id, submission.id, enc('{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}'))
  fs.writeFileSync(path.join(resultDir(competition.id, submission.id), SUBMISSION_FILE), 'id,target\n1,1\n')
  return updateSubmission(submission.id, { state: 'scored', publicScore: 0.5, privateScore: 0.5 })!
}

test('the metric-only doors of a GPU competition work with no card given; the doors that run the notebook are refused in words', async () => {
  const owner = ownerCookie('owner.gpu.doors@example.edu')
  const competition = gpuCompetition()
  const baseline = scored(competition, 'Сэмпл')
  updateCompetition(competition.id, { baselineSubmissionId: baseline.id })
  const student = scored(competition, 'Студент')
  const doors = `/api/admin/competitions/${competition.id}`
  try {
    // The metric never gets a card: checking it, rescoring one and rescoring everyone go to the queue.
    const one = await call(`${doors}/submissions/${student.id}/rescore`, { method: 'POST', cookie: owner })
    assert.equal(one.status, 202, await one.clone().text())
    assert.deepEqual([queueRow(student.id)?.state, queueRow(student.id)?.kind], ['waiting', 'metric'])
    const all = await call(`${doors}/rescore`, { method: 'POST', cookie: owner })
    assert.equal(all.status, 202, await all.clone().text())
    assert.equal(((await all.json()) as { queued: number }).queued, 2)
    // The rescore took the sample's answer too; put it back as scored, the way the check expects it.
    leaveQueue(baseline.id)
    updateSubmission(baseline.id, { state: 'scored' })
    const check = await call(`${doors}/metric/check`, { method: 'POST', cookie: owner })
    assert.equal(check.status, 202, await check.clone().text())
    assert.equal(queueRow(baseline.id)?.kind, 'metric')

    // The notebook needs the card nobody gave: refused at the door, in the same words as the upload.
    for (const door of ['baseline/check', `submissions/${student.id}/rerun`, 'open']) {
      leaveQueue(student.id)
      updateSubmission(student.id, { state: 'scored' })
      const refused = await call(`${doors}/${door}`, { method: 'POST', cookie: owner })
      assert.equal(refused.status, 503, door)
      assert.equal(((await refused.json()) as { error: string }).error, tr('runtime.gpuUnavailable'), door)
    }
  } finally {
    for (const row of queueRows()) if (row.competitionId === competition.id) leaveQueue(row.submissionId)
  }
})

test('a participant of a GPU competition prepares packages and saves a draft with no card given; the upload is refused', async () => {
  const competition = gpuCompetition()
  setCompetitionState(competition.id, 'live')
  const revision = putRevision({
    environmentName: 'base-gpu',
    imageDigest: `sha256:${'c'.repeat(64)}`,
    pythonVersion: '3.11.16',
    pythonAbi: 'cp311',
    platform: 'linux/amd64',
    packages: [{ name: 'torch', version: '2.14.1' }],
    baseConstraintsHash: 'hash',
  })
  selectRevision(competition.id, revision.id)
  setPolicy(competition.id, { enabled: true })
  const person = createEntrant('Участник с пакетами').entrant
  joinCompetition(competition.id, person.id, person.name)
  let cookie = ''
  issueEntrantCookie({ cookie(name: string, value: string) { cookie = `${name}=${value}` } } as unknown as ExpressResponse, person)
  const packages = `/api/k/competitions/${competition.slug}/dependencies`

  // The panel offers preparation and has a base to prepare on: the card is the notebook's business, not the packages'.
  const overview = (await (await call(packages, { cookie })).json()) as { capabilities: { execution: { code: string }; preparation: { available: boolean } }; revision: { id: string } | null }
  assert.equal(overview.capabilities.execution.code, 'gpu_unavailable')
  assert.equal(overview.capabilities.preparation.available, true)
  assert.equal(overview.revision?.id, revision.id)
  const draft = await call(`${packages}/draft`, { method: 'PUT', cookie, body: JSON.stringify({ requirementsText: 'timm' }) })
  assert.equal(draft.status, 200, await draft.clone().text())
  const prepared = await call(`${packages}/prepare`, { method: 'POST', cookie, body: JSON.stringify({ requirementsText: 'timm' }) })
  assert.equal(prepared.status, 202, await prepared.clone().text())

  // The notebook itself still needs the card, and is refused at the door.
  const form = new FormData()
  form.append('file', new Blob([JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source: 'import timm', metadata: {}, outputs: [], execution_count: null }] })]), 'mine.ipynb')
  const upload = await call(`/api/k/competitions/${competition.slug}/submissions`, { method: 'POST', body: form, cookie })
  assert.equal(upload.status, 503)
  assert.equal(((await upload.json()) as { error: string }).error, tr('runtime.gpuUnavailable'))
})
