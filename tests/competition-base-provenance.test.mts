import './_env.mts'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { app } from '../server/src/app.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { acceptSubmission, createCompetition, createEntrant, getCompetition, getSubmission, leaveQueue, putFile, queueRows, setQueuePaused, updateCompetition, updateSubmission } from '../server/src/competitions/store.js'
import { putBaseline, putOpenFile, putSecretFile, putSubmissionNotebook } from '../server/src/competitions/storage.js'
import { bindSubmission, competitionRevision, putRevision, selectRevision } from '../server/src/dependencies/store.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { pumpOnce, rerunSubmission, rescoreCompetition, setQueueSlots, settleCompetitionWork } from '../server/src/competitions/runner.js'

let server: http.Server, base = '', cookie = ''
before(async () => {
  const teacher = createTeacher({ name: 'Base reviewer', email: 'base-review@test.local', role: 'owner' })!
  rotateLinkKey(teacher.id)
  issueStaffCookie({ cookie: (_name: string, value: string) => { cookie = `${STAFF_COOKIE}=${value}` } } as ExpressResponse, teacher)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => { server.closeAllConnections(); server.close() })
async function readiness(id: string) {
  const response = await fetch(`${base}/api/admin/competitions/${id}`, { headers: { cookie } })
  assert.equal(response.status, 200)
  return (await response.json() as { ready: string | null }).ready
}

for (const change of ['environment', 'same-alias-digest'] as const) {
  test(`old baseline ${change} replay keeps its pinned image but cannot certify the current base`, async () => {
    for (const row of queueRows()) leaveQueue(row.submissionId)
    setQueuePaused(false); setQueueSlots(1)
    const competition = createCompetition({ slug: `base-${change}`, title: 'Base provenance', environment: 'base', privateRelease: 'manual', metric: { code: 'def score(solution, submission):\n return 1.0' } })!
    const notebook = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source: 'pass', metadata: {}, outputs: [] }] }))
    putBaseline(competition.id, notebook)
    putOpenFile(competition.id, 'sample_submission.csv', Buffer.from('id,target\n1,0\n2,0\n'))
    putSecretFile(competition.id, 'solution.csv', Buffer.from('id,target\n1,1\n2,2\n'))
    putFile({ competitionId: competition.id, name: 'sample_submission.csv', bytes: 23, visibility: 'open' })
    putFile({ competitionId: competition.id, name: 'solution.csv', bytes: 23, visibility: 'hidden' })
    const revision = (environmentName: string, digit: string) => putRevision({ environmentName, imageDigest: `sha256:${digit.repeat(64)}`, pythonVersion: '3.12.1', pythonAbi: 'cp312', platform: 'linux/amd64', packages: [{ name: 'numpy', version: '2.0.0' }], baseConstraintsHash: digit.repeat(64) })
    const oldBase = revision('base', 'a'), newBase = revision(change === 'environment' ? 'newbase' : 'base', 'b')
    selectRevision(competition.id, oldBase.id)
    const entrant = createEntrant('Baseline').entrant
    const accept = (revisionId: string) => {
      const submission = acceptSubmission({ competitionId: competition.id, entrantId: entrant.id, fileName: 'baseline.ipynb', bytes: notebook.length })
      bindSubmission(submission.id, revisionId, null)
      putSubmissionNotebook(competition.id, submission.id, notebook)
      updateCompetition(competition.id, { baselineSubmissionId: submission.id })
      return submission
    }
    const oldSubmission = accept(oldBase.id)
    const runner = new FakeCompetitionRunner(), usedImages: Array<string | undefined> = []
    const run = runner.run.bind(runner)
    runner.run = (request) => { usedImages.push(request.imageDigest); return run(request) }
    useCompetitionRunner(runner)
    try {
      assert.equal(await pumpOnce(), 1); await settleCompetitionWork()
      assert.equal(await readiness(competition.id), null)
      if (change === 'environment') updateCompetition(competition.id, { environment: newBase.environmentName })
      selectRevision(competition.id, newBase.id)
      assert.equal(rerunSubmission(oldSubmission.id), true)
      assert.equal(await pumpOnce(), 1); await settleCompetitionWork()
      const current = getCompetition(competition.id)!, replay = getSubmission(oldSubmission.id)!
      assert.deepEqual(usedImages, [oldBase.imageDigest, oldBase.imageDigest], 'immutable replay must still use its original base')
      assert.equal(competitionRevision(competition.id)?.id, newBase.id)
      assert.equal(replay.state, 'scored', 'a historical replay remains valid history')
      assert.notEqual(replay.notebookInputRevision, current.notebookInputRevision, 'old image cannot certify current notebook inputs')
      assert.notEqual(replay.inputRevision, current.inputRevision, 'old scorer base cannot certify the current inputs')
      assert.equal(await readiness(competition.id), 'baselineNotChecked')
      assert.equal(rescoreCompetition(competition.id), 1)
      await pumpOnce(); await settleCompetitionWork()
      assert.notEqual(getSubmission(oldSubmission.id)?.inputRevision, current.inputRevision)
      // Readiness must also reject rows previously stamped by the old bug.
      updateSubmission(oldSubmission.id, { inputRevision: current.inputRevision, notebookInputRevision: current.notebookInputRevision })
      assert.equal(await readiness(competition.id), 'baselineNotChecked')
      const refused = await fetch(`${base}/api/admin/competitions/${competition.id}/open`, { method: 'POST', headers: { cookie } })
      assert.equal(refused.status, 409)
      const fresh = accept(newBase.id)
      assert.equal(await pumpOnce(), 1); await settleCompetitionWork()
      assert.equal(usedImages.at(-1), newBase.imageDigest)
      assert.equal(getSubmission(fresh.id)?.notebookInputRevision, getCompetition(competition.id)?.notebookInputRevision)
      assert.equal(await readiness(competition.id), null)
    } finally { await settleCompetitionWork(); useCompetitionRunner(null) }
  })
}
