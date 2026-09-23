/** Runs only in the smoke fixture Pod, on its private PVC as uid 1000. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

assert.equal(fs.readFileSync('/data/.colloq-k3s-smoke-fixture', 'utf8'), 'colloq-k3s-smoke-v1')
assert.equal(process.env.KERNEL_BACKEND, 'broker')
const { RuntimeClient } = await import('../server/src/kernel/runtime-client.js')
const { BrokerCompetitionRunner } = await import('../server/src/competitions/broker-runner.js')
const { limitsFor } = await import('../server/src/competitions/runner-port.js')
const competitions = await import('../server/src/competitions/store.js')
const storage = await import('../server/src/competitions/storage.js')
const { closeDatabase } = await import('../server/src/db.js')

const catalog = JSON.parse(fs.readFileSync('/etc/colloq/catalog.json', 'utf8'))
const base = catalog.environments.find((item: { name: string }) => item.name === 'base')
assert.ok(base?.image?.includes('@sha256:'))
const client = new RuntimeClient({ url: 'http://colloq-runtime:8787', tokenFile: '/run/secrets/runtime-token' })
const runner = new BrokerCompetitionRunner(client, { catalog: () => catalog, pollMs: 250 })
const metricCode = `def score(solution, submission):
    from pathlib import Path
    import time
    assert Path('/secret/solution.csv').exists()
    assert not Path('/data').exists()
    assert not Path('/deps').exists()
    time.sleep(5)
    return float((solution['target'] - submission['target']).abs().mean())
`
try {
  const competition = competitions.createCompetition({ slug: `k3s-${randomUUID().slice(0, 8)}`, title: 'Disposable k3s smoke', blurb: '', description: '',
    environment: 'base', publicPercent: 50, metric: { name: 'MAE', direction: 'lower', code: metricCode },
    limits: { wallSeconds: 120, memoryMb: 1024, cpus: 1, perDay: 0 } })!
  competitions.setCompetitionState(competition.id, 'live')
  const entrant = competitions.createEntrant('Smoke fixture').entrant
  const notebook = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [
      'from pathlib import Path\n', 'import socket, time\n',
      'assert not Path("/secret").exists()\n', 'assert not Path("/result").exists()\n',
      'try:\n', '    socket.create_connection(("1.1.1.1", 443), 1)\n',
      'except OSError:\n', '    pass\n', 'else:\n', '    raise AssertionError("competition egress is open")\n',
      'time.sleep(5)\n', 'Path("submission.csv").write_text("id,target\\n1,0\\n2,0\\n3,0\\n4,0\\n")\n',
    ] }] }))
  const submission = competitions.acceptSubmission({ competitionId: competition.id, entrantId: entrant.id,
    fileName: 'smoke.ipynb', bytes: notebook.length })
  storage.putSubmissionNotebook(competition.id, submission.id, notebook)
  storage.putOpenFile(competition.id, 'sample_submission.csv', Buffer.from('id,target\n1,0\n2,0\n3,0\n4,0\n'))
  storage.putSecretFile(competition.id, 'solution.csv', Buffer.from('id,target,Usage\n1,0,Public\n2,0,Public\n3,0,Private\n4,0,Private\n'))
  const attemptId = randomUUID().replaceAll('-', '')
  const resultDir = storage.attemptDir(competition.id, submission.id, attemptId)
  const run = await runner.run({ attemptId, competition, submissionId: submission.id, container: `smoke-${attemptId}`,
    imageDigest: base.image, dataDir: storage.openDir(competition.id), inputDir: storage.inputDir(competition.id, submission.id),
    resultDir, limits: limitsFor(competition, 'notebook'), signal: AbortSignal.timeout(180_000) })
  assert.equal(run.status, 'ok', JSON.stringify(run))
  assert.ok(run.submission)
  const answer = fs.readFileSync(run.submission)
  const secret = storage.attemptDir(competition.id, submission.id, attemptId, 'secret')
  storage.competitionsFs.writeFileSync(path.join(secret, 'solution.csv'), Buffer.from('id,target,Usage\n1,0,Public\n2,0,Public\n3,0,Private\n4,0,Private\n'), { mode: 0o600 })
  storage.competitionsFs.writeFileSync(path.join(secret, 'metric.py'), Buffer.from(metricCode), { mode: 0o600 })
  const scoreInput = storage.attemptDir(competition.id, submission.id, attemptId, 'score')
  storage.competitionsFs.writeFileSync(path.join(scoreInput, 'submission.csv'), answer, { mode: 0o600 })
  const score = await runner.score({ attemptId, competition, submissionId: submission.id, container: `smoke-score-${attemptId}`,
    imageDigest: base.image, secretDir: secret, submissionDir: scoreInput,
    outDir: storage.attemptDir(competition.id, submission.id, attemptId, 'score-out'),
    limits: limitsFor(competition, 'metric'), signal: AbortSignal.timeout(120_000) })
  assert.equal(score.status, 'ok', JSON.stringify(score))
  assert.equal(score.public, 0)
  assert.equal(score.private, 0)
  let preparation: unknown = null
  if (process.env.COLLOQ_K3S_SMOKE_PREPARE === '1') {
    const { ensureCompetitionRevision } = await import('../server/src/dependencies/revisions.js')
    const { prepareBrokerDependencies } = await import('../server/src/dependencies/broker-preparation.js')
    const revision = await ensureCompetitionRevision(competition)
    const preparationId = randomUUID().replaceAll('-', '')
    const prepared = await prepareBrokerDependencies({ id: preparationId, imageDigest: base.image,
      requirementsText: 'python-slugify==8.0.4', basePackages: revision.packages,
      workDir: path.join('/data/dependencies/staging', preparationId), maxDownloadBytes: 8 * 1024 * 1024,
      maxInstalledBytes: 32 * 1024 * 1024, wallSeconds: 120, signal: AbortSignal.timeout(180_000) }, client)
    assert.ok(prepared.packages.some((item: { name: string }) => item.name === 'python-slugify'))
    preparation = { packages: prepared.packages.length, contentHash: prepared.contentHash }
  }
  console.log('COLLOQ_K3S_SMOKE_RESULT=' + JSON.stringify({ competitionId: competition.id, submissionId: submission.id,
    attemptId, notebook: run.status, metric: score.status, public: score.public, private: score.private,
    preparation }))
} finally { closeDatabase() }
