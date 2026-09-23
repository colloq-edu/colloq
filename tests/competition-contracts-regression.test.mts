import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { db } from '../server/src/db.js'
import { acceptSubmission, chooseSubmission, createCompetition, createEntrant, getCompetition, getSubmission, putFile, updateCompetition, updateSubmission } from '../server/src/competitions/store.js'

let seq = 0
function fixture(scoring: 'chosen' | 'bestPublic' | 'last' = 'chosen') {
  const competition = createCompetition({ slug: `contract-${++seq}`, title: 'Contract', scoring })!
  const entrant = createEntrant('Entrant').entrant
  const submission = acceptSubmission({ competitionId: competition.id, entrantId: entrant.id, fileName: 'run.ipynb', bytes: 2 })
  return { competition, entrant, submission }
}

test('live revision advances on terminal failures, equal-count rescores, and selection', () => {
  const { competition: c, entrant, submission: s } = fixture()
  let revision = getCompetition(c.id)!.revision
  assert.equal(typeof revision, 'number')
  for (const patch of [{ state: 'timedOut' }, { state: 'outOfMemory' }, { state: 'cancelled' }, { state: 'scored', publicScore: 1 }, { publicScore: 2 }] as const) {
    updateSubmission(s.id, patch)
    const next = getCompetition(c.id)!.revision!
    assert.ok(next > revision!, JSON.stringify(patch))
    revision = next
  }
  assert.equal(chooseSubmission(c.id, entrant.id, s.id), true)
  assert.ok(getCompetition(c.id)!.revision! > revision!)
})

test('baseline identity survives replacing its checked submission', () => {
  const { competition: c, entrant, submission: s } = fixture()
  updateCompetition(c.id, { baselineSubmissionId: s.id })
  assert.equal(getCompetition(c.id)!.baselineEntrantId, entrant.id)
  updateCompetition(c.id, { baselineSubmissionId: null })
  assert.equal(getCompetition(c.id)!.baselineEntrantId, entrant.id)
})

test('accepted score inputs remain identifiable after metric and artifact changes', () => {
  const { competition: c, submission: s } = fixture()
  const revision = getSubmission(s.id)!.inputRevision
  assert.equal(typeof revision, 'number')
  updateCompetition(c.id, { title: 'Cosmetic' })
  assert.equal(getCompetition(c.id)!.inputRevision, revision)
  updateCompetition(c.id, { metric: { code: 'raise Exception()' } })
  assert.ok(getCompetition(c.id)!.inputRevision! > revision!)
  const metricRevision = getCompetition(c.id)!.inputRevision!
  putFile({ competitionId: c.id, name: 'data.csv', bytes: 2, visibility: 'open' })
  assert.ok(getCompetition(c.id)!.inputRevision! > metricRevision)
  assert.equal(getSubmission(s.id)!.inputRevision, revision)
})

for (const scoring of ['bestPublic', 'last'] as const) test(`manual selection is rejected for ${scoring}`, () => {
  const { competition: c, entrant, submission: s } = fixture(scoring)
  updateSubmission(s.id, { state: 'scored', publicScore: 1 })
  assert.equal(chooseSubmission(c.id, entrant.id, s.id), false)
  assert.equal(getSubmission(s.id)!.chosen, false)
})


test('baseline identity migration recovers the existing checked service entrant on restart', () => {
  const { competition: c, entrant, submission: s } = fixture()
  updateCompetition(c.id, { baselineSubmissionId: s.id })
  db.prepare('UPDATE competitions SET baseline_entrant_id = NULL WHERE id = ?').run(c.id)
  const script = `import ${JSON.stringify(new URL('./_env.mts', import.meta.url).href)};
    process.env.DATA_DIR = process.argv[1];
    const {getCompetition} = await import(${JSON.stringify(new URL('../server/src/competitions/store.ts', import.meta.url).href)});
    process.stdout.write(JSON.stringify(getCompetition(process.argv[2]).baselineEntrantId));`
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, process.env.DATA_DIR!, c.id], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout), entrant.id)
})

test('notebook provenance changes only for notebook-visible inputs', () => {
  const { competition: c, submission: s } = fixture()
  const initial = getCompetition(c.id)!.notebookInputRevision!
  assert.equal(getSubmission(s.id)!.notebookInputRevision, initial)
  for (const patch of [{ metric: { code: 'new score' } }, { publicPercent: 45 }] as const) updateCompetition(c.id, patch)
  putFile({ competitionId: c.id, name: 'solution.csv', bytes: 2, visibility: 'hidden' })
  assert.equal(getCompetition(c.id)!.notebookInputRevision, initial)
  updateCompetition(c.id, { environment: 'another' })
  assert.ok(getCompetition(c.id)!.notebookInputRevision! > initial)
  const base = getCompetition(c.id)!.notebookInputRevision!
  putFile({ competitionId: c.id, name: 'data.csv', bytes: 2, visibility: 'open' })
  assert.ok(getCompetition(c.id)!.notebookInputRevision! > base)
})
