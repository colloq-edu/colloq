/**
 * The submission runner: the queue, two steps, outcomes.
 *
 * What is checked is what breaks quietly and expensively. A container command
 * that lost one flag: a submission with internet access or with the right to
 * write to the root is visible only to whoever takes advantage of it. Answers
 * that got into the entrant's container mean a competition solved by reading
 * a file. A queue that after a server restart keeps a submission "running"
 * until the end of the competition. A metric traceback sent to the entrant
 * instead of the teacher. And a row split computed by the browser differently
 * than by the container — the one mistake on this list that nobody would ever
 * notice.
 *
 * There is no real docker here, and there must not be: the commands are
 * checked as pure functions, and everything else with a stand-in runner that
 * does not execute a single line of anyone's code.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { LIMITS, splitRows } from '../shared/competitions.js'
import { setLocaleResolver } from '../shared/i18n.js'
import { getInstanceLanguage } from '../server/src/admin/settings.js'
import {
  acceptSubmission,
  createCompetition,
  createEntrant,
  getSubmission,
  leaderboard,
  leaveQueue,
  listRuns,
  putFile,
  queueRow,
  queueRows,
  setCompetitionState,
  setQueuePaused,
  takeNext,
  updateCompetition,
  updateSubmission,
  waitingCount,
  type QueueRow,
} from '../server/src/competitions/store.js'
import {
  bindSubmission,
  completeBundle,
  createBundle,
  putRevision,
  selectRevision,
  setPolicy,
} from '../server/src/dependencies/store.js'
import {
  openDir,
  putOpenFile,
  putSecretFile,
  putSubmissionNotebook,
  resultDir,
  scoreDir,
  scoreOutDir,
  secretDir,
  SUBMISSION_FILE,
} from '../server/src/competitions/storage.js'
import {
  runArgs,
  useDockerForCompetitions,
  scoreArgs,
  verdictOfRun,
  DEFAULT_ID_COLUMN,
  METRIC_NAME,
  SOLUTION_NAME,
} from '../server/src/competitions/docker-runner.js'
import {
  cellsOf,
  directiveOf,
  FakeCompetitionRunner,
  stableScore,
} from '../server/src/competitions/fake-runner.js'
import {
  competitionBackend,
  competitionRunner,
  forgetCompetitionRunner,
  limitsFor,
  useCompetitionRunner,
  METRIC_WALL_SECONDS,
  type RunOutcome,
} from '../server/src/competitions/runner-port.js'
import { harnessDir, SPLIT_SOURCE } from '../server/src/competitions/harness.js'
import {
  cancelSubmission,
  containerName,
  drainCompetitionQueue,
  enoughMemory,
  metricNote,
  missingModule,
  missingPackageHint,
  notebookNote,
  packageOfModule,
  pumpOnce,
  queueSlots,
  reclaimCompetitionQueue,
  rescoreCompetition,
  rerunSubmission,
  settleCompetitionWork,
  setQueueSlots,
  runnerStatus,
  type PackageSources,
} from '../server/src/competitions/runner.js'
import type { Competition } from '../shared/competitions.js'

/* ------------------------------------------------------------------ setup */

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

/**
 * There is one queue per instance, and that is not a circumstance of the test
 * but the design of the product: the machine has one executor for all
 * competitions. So every check starts from a clean slate.
 */
function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  runner.availableMb = 65_536
}

let seq = 0

/** The entrant key is returned once, on creation; the runner does not need it. */
const mint = (name: string) => createEntrant(name).entrant

function makeCompetition(over: Partial<Parameters<typeof createCompetition>[0]> = {}): Competition {
  seq += 1
  const made = createCompetition({
    slug: `k${seq}`,
    title: `Соревнование ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 0 },
    environment: 'base',
    ...over,
  })
  assert.ok(made, 'the competition must be created')
  // Everything a submission cannot be scored without: the open sample answer
  // and the answers.
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 24, visibility: 'open' })
  return made
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A notebook as a real .ipynb: the stand-in runner reads it as json. */
function notebook(sources: string[]): Uint8Array {
  return enc(
    JSON.stringify({
      cells: sources.map((source) => ({ cell_type: 'code', source, metadata: {}, outputs: [] })),
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  )
}

function send(competition: Competition, entrantId: string, sources: string[], at?: number) {
  const submission = acceptSubmission({
    competitionId: competition.id,
    entrantId,
    fileName: 'solution.ipynb',
    bytes: 100,
    ...(at === undefined ? {} : { at }),
  })
  putSubmissionNotebook(competition.id, submission.id, notebook(sources))
  return submission
}

/* ---------------------------------------------------- container commands */

const LIMITS_SAMPLE = limitsFor(
  { limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition,
  'notebook',
)

test('the notebook command: no network, read-only, with ceilings', () => {
  const args = runArgs({
    container: 'colloq-comp-abc-run',
    image: 'colloq-kernel:base',
    dataDir: '/data/competitions/c1/data',
    inputDir: '/data/competitions/c1/s/s1/in',
    resultDir: '/data/competitions/c1/s/s1/out',
    limits: LIMITS_SAMPLE,
    target: SUBMISSION_FILE,
  })
  const line = args.join(' ')
  assert.ok(line.includes('--network none'), 'the submission has no network at all')
  // joblib's n_jobs=-1 asks loky for the CPU count; the host's 76 cores must not leak in.
  assert.ok(/LOKY_MAX_CPU_COUNT=\d+/.test(line), 'loky is capped like the other thread pools')
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('--user=1000:1000'))
  assert.ok(args.includes('--cap-drop=ALL'))
  assert.ok(args.includes('--security-opt=no-new-privileges'))
  assert.ok(args.includes('--pids-limit=256'))
  assert.ok(args.includes('--memory=4096m'))
  // Swap exactly equal to memory: otherwise a container at its limit does not
  // die but goes to disk.
  assert.ok(args.includes('--memory-swap=4096m'))
  assert.ok(args.includes('--cpus=2'))
  assert.ok(args.includes(`--ulimit=fsize=${64 * 1024 * 1024 * 4}:${64 * 1024 * 1024 * 4}`))
  // /out is tmpfs: the container's disk is not limited by anything, and that
  // is the step's main hole.
  assert.ok(line.includes('--tmpfs=/out:rw,exec,nosuid,nodev,size=512m,mode=1777'))
  assert.ok(line.includes('--tmpfs=/tmp:rw,nosuid,nodev,size=512m'))
  // No `--rm` on purpose: the container is needed dead, to read OOMKilled.
  assert.ok(!args.includes('--rm'))
  assert.ok(args.includes('--restart=no'))
  assert.ok(line.includes('colloq.kind=competition-run'))
  assert.equal(args[args.length - 1], '/harness/run_notebook.py')
})

test("neither the answers nor the metric code get into the entrant's container", () => {
  const args = runArgs({
    container: 'c',
    image: 'colloq-kernel:base',
    dataDir: '/data/competitions/c1/data',
    inputDir: '/data/competitions/c1/s/s1/in',
    resultDir: '/data/competitions/c1/s/s1/out',
    limits: LIMITS_SAMPLE,
    target: SUBMISSION_FILE,
  })
  const mounts = args.filter((arg, i) => args[i - 1] === '-v')
  assert.deepEqual(
    mounts.map((mount) => mount.split(':')[1]),
    ['/data', '/submission', '/harness'],
  )
  for (const mount of mounts) {
    assert.ok(!mount.includes('/secret'), `the closed half is not mounted: ${mount}`)
    assert.ok(!mount.includes(SOLUTION_NAME), `the answers are not mounted: ${mount}`)
    assert.ok(!mount.includes(METRIC_NAME), `the metric code is not mounted: ${mount}`)
  }
  // The data and the notebook are read-only; the submission writes into one
  // directory.
  assert.ok(mounts[0].endsWith(':ro'))
  assert.ok(mounts[1].endsWith(':ro'))
  assert.ok(mounts[2].endsWith(':ro'))
  assert.ok(mounts.every((mount) => mount.endsWith(':ro')))
})

test('the metric command: the secrets inside, the open data and the notebook not', () => {
  const limits = limitsFor(
    { limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition,
    'metric',
  )
  const args = scoreArgs({
    container: 'colloq-comp-abc-score',
    image: 'colloq-kernel:base',
    secretDir: '/data/competitions/c1/secret',
    submissionDir: '/data/competitions/c1/s/s1/score',
    outDir: '/data/competitions/c1/s/s1/score-out',
    limits,
    solutionFile: SOLUTION_NAME,
    metricFile: METRIC_NAME,
    idColumn: 'id',
    publicPercent: 30,
    splitSeed: 'zerno',
  })
  const mounts = args.filter((arg, i) => args[i - 1] === '-v')
  assert.deepEqual(
    mounts.map((mount) => mount.split(':')[1]),
    ['/secret', '/submission', '/harness'],
  )
  for (const mount of mounts) {
    assert.ok(!mount.includes('/data/competitions/c1/data'), 'the metric does not see the open data')
    assert.ok(!mount.includes('/s/s1/out'), "the metric does not see the entrant's executed notebook")
  }
  assert.ok(args.includes('--network none') || args.join(' ').includes('--network none'))
  assert.ok(args.includes('--pids-limit=64'))
  assert.ok(args.includes('--ulimit=fsize=1048576:1048576'))
  assert.ok(args.includes('COMP_PUBLIC_PERCENT=30'))
  assert.ok(args.includes('COMP_SPLIT_SEED=zerno'))
  assert.equal(limits.wallSeconds, METRIC_WALL_SECONDS)
})

test('every -v is translated into a host path', () => {
  const before = process.env.DATA_HOST_DIR
  process.env.DATA_HOST_DIR = '/srv/colloq-data'
  try {
    const args = runArgs({
      container: 'c',
      image: 'i',
      dataDir: path.join(process.env.DATA_DIR as string, 'competitions/c1/data'),
      inputDir: path.join(process.env.DATA_DIR as string, 'competitions/c1/s/s1/in'),
      resultDir: path.join(process.env.DATA_DIR as string, 'competitions/c1/s/s1/out'),
      limits: LIMITS_SAMPLE,
      target: SUBMISSION_FILE,
    })
    const mounts = args.filter((arg, i) => args[i - 1] === '-v')
    // Without translation `make up` would give the submission an empty
    // directory created by the daemon on the fly — silently, without a single
    // line in the log.
    for (const mount of mounts) {
      assert.ok(mount.startsWith('/srv/colloq-data/'), mount)
    }
  } finally {
    if (before === undefined) delete process.env.DATA_HOST_DIR
    else process.env.DATA_HOST_DIR = before
  }
})

test('the harness is laid out by content hash and is not rewritten', () => {
  const dir = harnessDir()
  assert.ok(dir.includes('.harness'), 'the harness directory hides from the competition sweep')
  for (const name of ['run_notebook.py', 'kernel_streams.py', 'score_metric.py', 'colloq_metric.py', 'colloq_split.py']) {
    assert.ok(fs.existsSync(path.join(dir, name)), name)
  }
  assert.equal(harnessDir(), dir, 'a second call does not create a new directory')
})

test("the notebook's working folder opens the data via the relative path data/", () => {
  const script = `
import ast, os, tempfile
from pathlib import Path
source = Path(${JSON.stringify(path.join(harnessDir(), 'run_notebook.py'))}).read_text()
tree = ast.parse(source)
prepare = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'prepare_workspace')
with tempfile.TemporaryDirectory() as root:
    root = Path(root)
    data = root / 'readonly-data'
    data.mkdir()
    (data / 'train.csv').write_text('id,target\\n1,42\\n')
    scope = {'OUT': root / 'out', 'RESULT': root / 'result', 'DATA': data}
    exec(compile(ast.Module(body=[prepare], type_ignores=[]), '<workspace>', 'exec'), scope)
    scope['prepare_workspace']()
    scope['prepare_workspace']()
    os.chdir(scope['OUT'])
    assert Path('data/train.csv').read_text() == 'id,target\\n1,42\\n'
    assert Path('data').resolve() == data.resolve()
    Path('submission.csv').write_text('id,prediction\\n1,41\\n')
    assert scope['RESULT'].is_dir()
    assert not (data / 'submission.csv').exists()
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('progress counts code cells, and an error keeps its cause without ANSI', () => {
  const script = `
import ast, re, time
from pathlib import Path
from types import SimpleNamespace
source = Path(${JSON.stringify(path.join(harnessDir(), 'run_notebook.py'))}).read_text()
tree = ast.parse(source)
nodes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Runner'
         or isinstance(node, ast.FunctionDef) and node.name == 'cell_error_detail']
class Cell(dict):
    __getattr__ = dict.__getitem__
class Client:
    def __init__(self, nb, **kwargs): pass
scope = {'NotebookClient': Client, 'time': time, 're': re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<runner>', 'exec'), scope)
cells = [Cell(cell_type=kind) for kind in ['markdown', 'code', 'markdown', 'code']]
runner = scope['Runner'](SimpleNamespace(cells=cells))
runner.beat = lambda phase: None
runner.on_cell_start(cells[0], 0)
assert runner.cell_index == -1
runner.on_cell_start(cells[1], 1)
assert runner.cell_index == 0
runner.on_cell_start(cells[2], 2)
assert runner.cell_index == 0
runner.on_cell_start(cells[3], 3)
assert runner.cell_index == 1 and runner.cells_total == 2
message = '\\x1b[31m' + 'long frame ' * 1000 + '\\nValueError: missing column\\x1b[0m'
detail = scope['cell_error_detail'](Exception(message))
assert '\\x1b' not in detail
assert len(detail) <= 4000
assert detail.endswith('ValueError: missing column')
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

/* ------------------------------------------------------- reading the traces */

test("parsing order: memory outranks the time limit, the time limit outranks the harness's word", () => {
  assert.equal(
    verdictOfRun({ oom: true, killedBy: 'wall', status: 'cell_error', produced: true }),
    'out-of-memory',
  )
  assert.equal(
    verdictOfRun({ oom: false, killedBy: 'wall', status: 'ok', produced: true }),
    'timeout',
  )
  assert.equal(
    verdictOfRun({ oom: false, killedBy: null, status: 'cell_error', produced: true }),
    'cell_error',
  )
  // The notebook reached the end but there is no file: that is a rejection,
  // not a success.
  assert.equal(verdictOfRun({ oom: false, killedBy: null, status: 'ok', produced: false }), 'no-submission')
  assert.equal(verdictOfRun({ oom: false, killedBy: null, status: 'ok', produced: true }), 'ok')
  // Killed for printing is a notebook failure; killed for writing to disk is a
  // rejection of the answer.
  assert.equal(verdictOfRun({ oom: false, killedBy: 'output', status: 'ok', produced: true }), 'cell_error')
  assert.equal(
    verdictOfRun({ oom: false, killedBy: 'disk', status: 'ok', produced: true }),
    'target_too_large',
  )
  // An unknown word does not slip into the database as a state that no badge
  // has.
  assert.equal(verdictOfRun({ oom: false, killedBy: null, status: 'что-то', produced: true }), 'unknown')
  assert.equal(
    verdictOfRun({ oom: false, killedBy: null, status: 'notebook_unreadable', produced: false }),
    'target_unreadable',
  )
})

test("a step's limits are derived from memory, not out of thin air", () => {
  const small = limitsFor({ limits: { wallSeconds: 60, memoryMb: 512, cpus: 1, perDay: 0 } } as Competition, 'notebook')
  assert.equal(small.tmpfsMb, 128, 'we do not go below 128 MB: no answer would fit there')
  const big = limitsFor({ limits: { wallSeconds: 60, memoryMb: 65_536, cpus: 8, perDay: 0 } } as Competition, 'notebook')
  assert.equal(big.tmpfsMb, 2048, "tmpfs does not grow above two gigabytes: it counts towards the submission's memory")
  const metric = limitsFor({ limits: { wallSeconds: 3600, memoryMb: 16_384, cpus: 4, perDay: 0 } } as Competition, 'metric')
  assert.equal(metric.wallSeconds, METRIC_WALL_SECONDS, "the metric has its own time limit, not the notebook's")
  assert.equal(metric.memoryMb, 2048)
  assert.equal(metric.pids, 64)
})

test('memory: if we do not know, we do not interfere; if we know there is none, we do not take the job', () => {
  assert.equal(enoughMemory(null, 4096), true)
  assert.equal(enoughMemory(8192, 4096), true)
  assert.equal(enoughMemory(4096, 4096), false, 'a cushion above the limit is required')
  assert.equal(enoughMemory(4352, 4096), true)
})

test('the container name does not repeat on a rerun of the same submission', () => {
  const first = containerName('s1', 'notebook', 'aaaa')
  const again = containerName('s1', 'notebook', 'bbbb')
  assert.notEqual(first, again)
  assert.ok(first.startsWith('colloq-comp-s1-'))
  assert.ok(containerName('s1', 'metric', 'cccc').endsWith('-score'))
})

test('the execution path is chosen by a variable, as for kernels', () => {
  assert.equal(competitionBackend({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), 'test')
  assert.equal(competitionBackend({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), 'docker')
  assert.equal(competitionBackend({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), 'broker')
  assert.throws(() => competitionBackend({ NODE_ENV: 'production', COMPETITION_BACKEND: 'docker' } as NodeJS.ProcessEnv))
  assert.throws(() => competitionBackend({ NODE_ENV: 'production', COMPETITION_BACKEND: 'test' } as NodeJS.ProcessEnv))
  assert.equal(competitionBackend({ NODE_ENV: 'test', COMPETITION_BACKEND: 'broker' } as NodeJS.ProcessEnv), 'broker')
})

/* ------------------------------------------------------ stand-in runner */

test('a directive is parsed as data and only as data', () => {
  const asked = directiveOf(Buffer.from(notebook(['# colloq-test: {"status": "timeout", "cell": 3}\nprint(1)'])))
  assert.deepEqual(asked, { status: 'timeout', cell: 3 })
  // Garbage in a directive does not crash the queue: the submission takes the
  // ordinary path.
  assert.deepEqual(directiveOf(Buffer.from(notebook(['# colloq-test: {сломано}']))), {})
  assert.deepEqual(directiveOf(Buffer.from('не json')), {})
  assert.deepEqual(directiveOf(Buffer.from(notebook(['print(1)']))), {})
  assert.equal(cellsOf(Buffer.from(notebook(['a', 'b', 'c']))), 3)
})

test("the stand-in metric's score is stable: the same content gives the same score", () => {
  assert.equal(stableScore('x:public', 0.5, 1), stableScore('x:public', 0.5, 1))
  assert.notEqual(stableScore('x:public', 0.5, 1), stableScore('y:public', 0.5, 1))
  const value = stableScore('z', 0.5, 1)
  assert.ok(value >= 0.5 && value <= 1, String(value))
})

/* -------------------------------------------------- a submission's path */

test('an honest submission gets to two scores', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Аня')
  const submission = send(competition, entrant.id, ['import pandas as pd', 'pd.DataFrame().to_csv("submission.csv")'])

  await drainCompetitionQueue()

  const done = getSubmission(submission.id)
  assert.equal(done?.state, 'scored')
  assert.equal(done?.stage, 'score')
  assert.ok(done?.publicScore !== null && done.privateScore !== null, 'both scores are in place')
  assert.ok((done?.durationMs ?? 0) >= 0)
  assert.equal(done?.participantError, null)
  assert.equal(queueRow(submission.id), null, 'the row left the queue')

  const runs = listRuns(submission.id)
  assert.deepEqual(runs.map((run) => run.kind), ['notebook', 'metric'])
  assert.equal(runs[0].verdict, 'ok')
  assert.equal(runs[1].verdict, 'ok')
  assert.ok(runs[0].container?.endsWith('-run'))
  assert.ok(runs[1].container?.endsWith('-score'))

  // The answer is saved — later the metric is rescored from it without
  // running the notebook.
  assert.ok(fs.existsSync(path.join(resultDir(competition.id, submission.id), SUBMISSION_FILE)))
  // And the second copy of the answer, which lived during scoring, is removed:
  // keeping every answer twice means gigabytes nobody reads.
  assert.equal(fs.existsSync(scoreDir(competition.id, submission.id)), false)
  assert.equal(fs.existsSync(scoreOutDir(competition.id, submission.id)), false)
})

test('every outcome names the culprit correctly', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Боря')

  const cases: Array<{
    directive: string
    state: string
    participant: (text: string | null) => void
    teacher: (text: string | null) => void
  }> = [
    {
      directive: '{"status": "cell_error", "cell": 4, "detail": "ZeroDivisionError: division by zero"}',
      state: 'notebookFailed',
      participant: (text) => {
        assert.ok(text?.includes('5'), 'the cell number is named')
        assert.ok(text?.includes('ZeroDivisionError'), "the entrant's own traceback goes to them verbatim")
      },
      teacher: (text) => assert.ok(text?.includes('cell_error')),
    },
    {
      directive: '{"status": "timeout", "cell": 6}',
      state: 'timedOut',
      participant: (text) => assert.ok(text?.includes('10'), 'the time limit is named in minutes'),
      teacher: (text) => assert.ok(text?.includes('exit 137')),
    },
    {
      directive: '{"status": "out_of_memory", "cell": 2}',
      state: 'outOfMemory',
      participant: (text) => assert.ok(text?.includes('4'), 'the limit is named in gigabytes'),
      teacher: (text) => assert.ok(text?.includes('OOMKilled')),
    },
    {
      directive: '{"status": "kernel_died", "cell": 9}',
      state: 'notebookFailed',
      participant: (text) => assert.ok(text?.includes('os._exit')),
      teacher: (text) => assert.ok(text?.includes('kernel_died')),
    },
    {
      directive: '{"status": "no_submission"}',
      state: 'rejected',
      participant: (text) => assert.ok(text?.includes(SUBMISSION_FILE)),
      teacher: (text) => assert.ok(text?.includes('no-submission')),
    },
    {
      directive: '{"metric": "participant_error"}',
      state: 'rejected',
      participant: (text) => {
        assert.ok(text?.includes('100') && text?.includes('398692'), text ?? '')
        assert.ok(!text?.includes('{'), "the code is replaced by a sentence in the instance's language")
      },
      teacher: (text) => assert.equal(text, null),
    },
    {
      directive: '{"metric": "metric_error"}',
      state: 'metricFailed',
      participant: (text) => assert.equal(text, null, "the entrant does not read the metric's traceback"),
      teacher: (text) => assert.ok(text?.includes('ZeroDivisionError')),
    },
  ]

  for (const item of cases) {
    const submission = send(competition, entrant.id, [`# colloq-test: ${item.directive}`, 'x = 1'])
    await drainCompetitionQueue()
    const done = getSubmission(submission.id)
    assert.equal(done?.state, item.state, item.directive)
    item.participant(done?.participantError ?? null)
    item.teacher(done?.teacherError ?? null)
    if (item.state !== 'scored') assert.equal(done?.publicScore, null)
  }
})

test("a submission that failed before the first cell does not use the day's quota", async () => {
  reset()
  const competition = makeCompetition({ limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 3 } })
  const entrant = mint('Варя')
  const submission = send(competition, entrant.id, ['# colloq-test: {"status": "kernel_died", "cell": -1}'])
  await drainCompetitionQueue()
  const done = getSubmission(submission.id)
  assert.equal(done?.state, 'notebookFailed')
  assert.equal(done?.cellsDone, 0, 'not a single cell started, so the quota is intact')
})

/* ------------------------------------------------------ a missing module */

/*
 * What nbclient hands over for `import lightgbm` after a `!pip install` that
 * failed quietly without network: the rehearsal's notebook, cell 4 of 4. The
 * shape is copied from a real run of run_notebook.py under the image's
 * nbclient 0.11 and IPython 9, after cell_error_detail.
 */
const IMPORT_TRACE = [
  'An error occurred while executing the following cell:',
  '------------------',
  'import lightgbm as lgb',
  '------------------',
  '',
  '',
  '---------------------------------------------------------------------------',
  'ModuleNotFoundError                       Traceback (most recent call last)',
  'Cell In[4], line 1',
  '----> 1 import lightgbm as lgb',
  '',
  "ModuleNotFoundError: No module named 'lightgbm'",
].join('\n')

const HEAD_RU = 'Тетрадь упала на ячейке 4 из 4.'
const ATTACH_RU =
  'Пакета lightgbm нет на сервере. Сети при проверке нет, поэтому `pip install` в тетради не сработает: добавьте lightgbm во вкладке «Пакеты» и прикрепите набор к посылке.'
const NOT_IN_SET_RU =
  'lightgbm нет в прикреплённом наборе пакетов: добавьте его во вкладке «Пакеты» и пришлите тетрадь с новым набором.'
const ASK_TEACHER_RU =
  'Пакета lightgbm нет в окружении соревнования, а сети при проверке нет, поэтому `pip install` в тетради не сработает. Напишите преподавателю.'

function failedCell(detail: string): RunOutcome {
  return {
    status: 'cell_error', cell: 3, cells: 4, wall: 14_000, submission: null, detail, log: '',
    diagnostics: { exit: 1, oomKilled: false, backend: 'test' },
  }
}

const SOME_COMPETITION = { limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition
const sources = (over: Partial<PackageSources> = {}): PackageSources => ({ ownPackages: true, attached: null, base: ['numpy', 'pandas'], ...over })

/** Words in English, then back to the instance's language whatever happens. */
function inEnglish<T>(body: () => T): T {
  setLocaleResolver(() => 'en')
  try {
    return body()
  } finally {
    setLocaleResolver(getInstanceLanguage)
  }
}

test('the missing module is read off the last line of the traceback, and only a top-level one', () => {
  assert.equal(missingModule(IMPORT_TRACE), 'lightgbm')
  assert.equal(missingModule(`${IMPORT_TRACE}\n\n`), 'lightgbm', 'trailing blank lines are not the last line')
  assert.equal(missingModule("Traceback\nImportError: No module named 'catboost'"), 'catboost')
  // A dotted name means the package IS there and a submodule is not: a
  // version mismatch, not something to install.
  assert.equal(missingModule("ModuleNotFoundError: No module named 'sklearn.externals'"), null)
  // The cell died of something else; the words above are the cell's printing.
  assert.equal(missingModule("ModuleNotFoundError: No module named 'lightgbm'\nValueError: bad shape"), null)
  assert.equal(missingModule("ImportError: cannot import name 'foo' from 'bar'"), null)
  assert.equal(missingModule(''), null)

  assert.equal(packageOfModule('sklearn'), 'scikit-learn')
  assert.equal(packageOfModule('PIL'), 'pillow')
  assert.equal(packageOfModule('cv2'), 'opencv-python-headless', 'the image has no libGL for the desktop build')
  assert.equal(packageOfModule('lightgbm'), 'lightgbm')
  // A name that is also an Object.prototype key stays a name, not a function.
  assert.equal(packageOfModule('constructor'), 'constructor')
})

test('after a missing module the platform says there is no network and where packages come from', () => {
  // Own packages allowed, no set attached.
  assert.equal(
    notebookNote(failedCell(IMPORT_TRACE), SOME_COMPETITION, sources()),
    `${HEAD_RU}\n\n${IMPORT_TRACE}\n\n${ATTACH_RU}`,
  )
  // A set is attached, and the package is not in it.
  assert.equal(
    notebookNote(failedCell(IMPORT_TRACE), SOME_COMPETITION, sources({ attached: ['xgboost'] })),
    `${HEAD_RU}\n\n${IMPORT_TRACE}\n\n${NOT_IN_SET_RU}`,
  )
  // Own packages are off.
  assert.equal(
    notebookNote(failedCell(IMPORT_TRACE), SOME_COMPETITION, sources({ ownPackages: false })),
    `${HEAD_RU}\n\n${IMPORT_TRACE}\n\n${ASK_TEACHER_RU}`,
  )
  // Off wins over an attached set: an old set can be attached, a new one cannot be made.
  assert.equal(missingPackageHint(IMPORT_TRACE, sources({ ownPackages: false, attached: ['xgboost'] })), ASK_TEACHER_RU)
  // The name to install, not the name imported.
  assert.match(
    missingPackageHint("ModuleNotFoundError: No module named 'cv2'", sources()) ?? '',
    /^Пакета opencv-python-headless нет на сервере\..*добавьте opencv-python-headless во вкладке «Пакеты»/,
  )

  inEnglish(() => {
    assert.equal(
      notebookNote(failedCell(IMPORT_TRACE), SOME_COMPETITION, sources()),
      `The notebook failed at cell 4 of 4.\n\n${IMPORT_TRACE}\n\nPackage lightgbm is not on the server. The check runs without network, so \`pip install\` in the notebook will not work: add lightgbm on the Packages tab and attach the set to your submission.`,
    )
    assert.equal(
      missingPackageHint(IMPORT_TRACE, sources({ attached: [] })),
      'lightgbm is not in the attached package set: add it on the Packages tab and send the notebook with the new set.',
    )
    assert.equal(
      missingPackageHint(IMPORT_TRACE, sources({ ownPackages: false })),
      'Package lightgbm is not in the competition environment, and the check runs without network, so `pip install` in the notebook will not work. Contact your teacher.',
    )
  })
})

test('no hint when the package is in fact there, when the cell died of something else, or for the sample notebook', () => {
  // Installed after all, under another spelling: the import failed for another reason.
  assert.equal(missingPackageHint(IMPORT_TRACE, sources({ base: ['LightGBM'] })), null)
  assert.equal(missingPackageHint(IMPORT_TRACE, sources({ attached: ['lightgbm'] })), null)
  assert.equal(missingPackageHint("ModuleNotFoundError: No module named 'cv2'", sources({ attached: ['opencv_python_headless'] })), null)
  // Another error: the traceback goes alone, as before.
  const other = 'Traceback (most recent call last)\nZeroDivisionError: division by zero'
  assert.equal(notebookNote(failedCell(other), SOME_COMPETITION, sources()), `${HEAD_RU}\n\n${other}`)
  // No sources (the sample notebook, or they could not be read): no hint.
  assert.equal(notebookNote(failedCell(IMPORT_TRACE), SOME_COMPETITION), `${HEAD_RU}\n\n${IMPORT_TRACE}`)
})

test('a long traceback gives way from its start: the exception and the hint fit the row', () => {
  const frames = Array.from({ length: 60 }, (_, i) => `  File "frame${i}.py", line ${i} ${'x'.repeat(60)}`).join('\n')
  const detail = `${frames}\nModuleNotFoundError: No module named 'lightgbm'`
  assert.ok(detail.length > LIMITS.participantError, 'the case must be longer than the row keeps')

  const note = notebookNote(failedCell(detail), SOME_COMPETITION, sources())!
  assert.ok(note.length <= LIMITS.participantError, String(note.length))
  assert.ok(note.startsWith(`${HEAD_RU}\n\n…\n  File "frame`), 'the cut is marked and falls on a line boundary')
  assert.ok(note.endsWith(`\nModuleNotFoundError: No module named 'lightgbm'\n\n${ATTACH_RU}`))

  // Without a hint the exception line survives too: the store would have cut it.
  const plain = notebookNote(failedCell(`${frames}\nValueError: bad shape`), SOME_COMPETITION, sources())!
  assert.ok(plain.length <= LIMITS.participantError)
  assert.ok(plain.endsWith('\nValueError: bad shape'))
})

test('through the queue: the hint lands in the submission row and follows the competition', async () => {
  reset()
  const competition = makeCompetition()
  setCompetitionState(competition.id, 'live')
  const revision = putRevision({
    environmentName: 'base', imageDigest: `sha256:${'d'.repeat(64)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/arm64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash',
  })
  selectRevision(competition.id, revision.id)
  const entrant = mint('Лёня')
  const failing = [`# colloq-test: ${JSON.stringify({ status: 'cell_error', cell: 3, detail: IMPORT_TRACE })}`, 'x = 1', 'y = 2', 'import lightgbm']
  const run = async (prepare?: (submissionId: string) => void) => {
    const submission = send(competition, entrant.id, failing)
    prepare?.(submission.id)
    await drainCompetitionQueue()
    const done = getSubmission(submission.id)
    assert.equal(done?.state, 'notebookFailed')
    assert.equal(listRuns(submission.id)[0].participantError, done?.participantError, 'the run row reads the same')
    return done?.participantError ?? ''
  }

  // A competition starts with own packages off.
  assert.ok((await run()).endsWith(`\n\n${ASK_TEACHER_RU}`))

  setPolicy(competition.id, { enabled: true })
  assert.ok((await run()).endsWith(`\n\n${ATTACH_RU}`))

  const set = createBundle(competition.id, entrant.id, revision.id, 'xgboost')
  completeBundle(set.id, {
    normalizedRequirements: ['xgboost'], downloadBytes: 1, installedBytes: 1, contentHash: '1'.repeat(64),
    packages: [{ name: 'xgboost', version: '3.0.5', fileName: 'xgboost-3.0.5-py3-none-any.whl', sha256: '2'.repeat(64), bytes: 1 }],
    lock: `xgboost==3.0.5 --hash=sha256:${'2'.repeat(64)}\n`,
  })
  const withSet = await run((id) => bindSubmission(id, revision.id, set.id))
  assert.ok(withSet.startsWith(`${HEAD_RU}\n\n`), withSet)
  assert.ok(withSet.includes("ModuleNotFoundError: No module named 'lightgbm'"), 'the traceback stays verbatim')
  assert.ok(withSet.endsWith(`\n\n${NOT_IN_SET_RU}`))

  // The sample notebook is the teacher's: no sentence for a student.
  const sample = makeCompetition()
  const baseline = send(sample, mint('Базовое решение-2').id, failing)
  updateCompetition(sample.id, { baselineSubmissionId: baseline.id })
  await drainCompetitionQueue()
  assert.equal(getSubmission(baseline.id)?.participantError, `${HEAD_RU}\n\n${IMPORT_TRACE}`)
})

/* --------------------------------------------------------------- queue */

test('the queue is fair per person, not by arrival time', async () => {
  reset()
  const competition = makeCompetition()
  const greedy = mint('Жадный')
  const quiet = mint('Тихий')
  const first = send(competition, greedy.id, ['a'], 1000)
  const second = send(competition, greedy.id, ['b'], 1001)
  const third = send(competition, greedy.id, ['c'], 1002)
  const late = send(competition, quiet.id, ['d'], 1003)

  const order: string[] = []
  for (let i = 0; i < 4; i++) {
    const row = takeNext({ boot: 'test-boot' }) as QueueRow | null
    assert.ok(row, 'a job must be found')
    order.push(row.submissionId)
    leaveQueue(row.submissionId)
  }
  // One's own first goes first; one's own second goes BEHIND someone else's
  // first.
  assert.deepEqual(order, [first.id, late.id, second.id, third.id])
})

test('a pause takes no new jobs and leaves the one already taken alone', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Гена')
  const submission = send(competition, entrant.id, ['a'])
  setQueuePaused(true, 'owner')

  assert.equal(await pumpOnce(), 0, 'while paused the pump takes nothing')
  assert.equal(getSubmission(submission.id)?.state, 'queued')
  assert.equal(waitingCount(), 1)
  assert.equal(runnerStatus().paused, true)

  setQueuePaused(false)
  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'scored')
})

test('no memory: the queue waits and loses nothing', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Дима')
  const submission = send(competition, entrant.id, ['a'])
  runner.availableMb = 512

  assert.equal(await pumpOnce(), 0, 'the submission needs 4 GB, the machine has 512 MB')
  const waiting = queueRow(submission.id)
  assert.equal(waiting?.state, 'waiting')
  // The attempt does not count: otherwise two memory shortages would declare
  // the submission interrupted, and it would be lost after a server restart.
  assert.equal(waiting?.attempts, 0)

  runner.availableMb = 65_536
  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'scored')
})

test('both a waiting and a running one can be cancelled; a late cancellation says so', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Егор')

  const waiting = send(competition, entrant.id, ['a'])
  assert.equal(await cancelSubmission(waiting.id, 'entrant'), true)
  assert.equal(getSubmission(waiting.id)?.state, 'cancelled')
  assert.equal(queueRow(waiting.id), null)

  // The teacher kills a running one: the container is removed, and the
  // submission does not get "time is up" for someone else's press.
  const running = send(competition, entrant.id, ['# colloq-test: {"hold": 5000}'])
  assert.equal(await pumpOnce(), 1)
  assert.ok(queueRow(running.id)?.container, 'the container name is recorded before the first wait')
  assert.equal(await cancelSubmission(running.id, 'teacher'), true)
  await settleCompetitionWork()
  const killed = getSubmission(running.id)
  assert.equal(killed?.state, 'cancelled')
  assert.ok(killed?.teacherError?.length)

  // The cancellation was too late: the job is already gone.
  assert.equal(await cancelSubmission(running.id, 'entrant'), false)
})

test('a server restart revives what was interrupted instead of burying it', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Жора')
  const submission = send(competition, entrant.id, ['a'])

  // A previous process lifetime took the job and died together with the
  // container.
  const row = takeNext({ boot: 'boot-of-a-dead-process' })
  assert.equal(row?.submissionId, submission.id)
  updateSubmission(submission.id, { state: 'running', stage: 'notebook' })

  const first = await reclaimCompetitionQueue()
  assert.equal(first.requeued, 1)
  assert.equal(first.abandoned, 0)
  // The submission row went back into the queue too: otherwise the entrant
  // would watch a timer that does not move until the end of the competition.
  assert.equal(getSubmission(submission.id)?.state, 'queued')
  assert.equal(getSubmission(submission.id)?.stage, 'queue')

  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'scored')
})

test('a second interruption in a row marks the submission instead of spinning it forever', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Зина')
  const submission = send(competition, entrant.id, ['a'])

  takeNext({ boot: 'dead-one' })
  await reclaimCompetitionQueue()
  takeNext({ boot: 'dead-two' })
  const second = await reclaimCompetitionQueue()

  assert.equal(second.abandoned, 1)
  const done = getSubmission(submission.id)
  assert.equal(done?.state, 'metricFailed', 'the entrant is not to blame, and the word says so')
  assert.ok(done?.teacherError?.includes('перезапуск'))
  assert.equal(queueRow(submission.id), null)
})

/* ------------------------------------------------------------ rescoring */

test('a metric rescore does not run notebooks again', async () => {
  reset()
  const competition = makeCompetition()
  const anya = mint('Аня-2')
  const boris = mint('Боря-2')
  const first = send(competition, anya.id, ['import pandas'])
  const second = send(competition, boris.id, ['import numpy'])
  await drainCompetitionQueue()

  const before = [getSubmission(first.id), getSubmission(second.id)]
  assert.ok(before.every((s) => s?.state === 'scored'))
  // Different notebooks, different scores: otherwise there is nothing to check
  // the leaderboard with.
  assert.notEqual(before[0]?.publicScore, before[1]?.publicScore)

  const notebookRunsBefore = listRuns(first.id).filter((run) => run.kind === 'notebook').length
  assert.equal(rescoreCompetition(competition.id), 2)
  await drainCompetitionQueue()

  const after = [getSubmission(first.id), getSubmission(second.id)]
  assert.ok(after.every((s) => s?.state === 'scored'))
  assert.equal(
    listRuns(first.id).filter((run) => run.kind === 'notebook').length,
    notebookRunsBefore,
    'the notebook was not run a second time',
  )
  assert.equal(listRuns(first.id).filter((run) => run.kind === 'metric').length, 2)
  // The score is the same: the answer on disk did not change, and the rescore
  // must show that.
  assert.equal(after[0]?.publicScore, before[0]?.publicScore)

  const board = leaderboard(competition.id, 'public')
  assert.equal(board.length, 2)
  assert.deepEqual(board.map((row) => row.place), [1, 2])
})

test('a rerun executes the notebook again and clears the previous scores', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Игорь')
  const submission = send(competition, entrant.id, ['a'])
  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'scored')

  assert.equal(rerunSubmission(submission.id), true)
  assert.equal(getSubmission(submission.id)?.state, 'queued')
  assert.equal(getSubmission(submission.id)?.publicScore, null)
  await drainCompetitionQueue()
  assert.equal(listRuns(submission.id).filter((run) => run.kind === 'notebook').length, 2)
  assert.equal(getSubmission(submission.id)?.state, 'scored')
})

test('there is nothing to rescore for a submission without an answer', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Клава')
  const submission = send(competition, entrant.id, ['# colloq-test: {"status": "cell_error"}'])
  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'notebookFailed')
  assert.equal(rescoreCompetition(competition.id), 0, 'there is nothing to rescore a failed notebook with')
})

/* -------------------------------------------------------- execution slots */

test('there are as many slots as configured, and no more', async () => {
  reset()
  const competition = makeCompetition()
  const one = mint('Люда')
  const two = mint('Миша')
  send(competition, one.id, ['# colloq-test: {"hold": 300}'])
  send(competition, two.id, ['# colloq-test: {"hold": 300}'])

  assert.equal(queueSlots(), 1)
  assert.equal(await pumpOnce(), 1, 'one slot, one job')
  await settleCompetitionWork()

  setQueueSlots(2)
  assert.equal(queueSlots(), 2)
  await drainCompetitionQueue()
  assert.equal(waitingCount(), 0)
  setQueueSlots(1)
})

/* ---------------------------------------------------- splitting answer rows */

test('the container splits rows exactly the way the page shows it', (t) => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  if (python.status !== 0) {
    t.skip('no python3 on this machine: the split is compared only where it exists')
    return
  }
  const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR as string, 'split-'))
  fs.writeFileSync(path.join(dir, 'colloq_split.py'), SPLIT_SOURCE)

  const cases = [
    { ids: Array.from({ length: 397 }, (_, i) => String(i + 1)), percent: 30, seed: 'rohlik-2026' },
    { ids: Array.from({ length: 9 }, (_, i) => `row-${i}`), percent: 50, seed: '' },
    // Non-Latin text and a character outside the BMP: JS computes the hash over
    // UTF-16 code units.
    { ids: ['ёлка', 'мир', '日本', '👋x', 'a', 'b', 'c'], percent: 40, seed: 'семь' },
    // A space inside an identifier: the seed separator must not be a space.
    { ids: ['a b', 'c'], percent: 50, seed: 'z' },
    { ids: ['only'], percent: 30, seed: 's' },
  ]
  const got = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(dir)})`,
        'from colloq_split import split_rows',
        'cases = json.loads(sys.stdin.read())',
        'print(json.dumps([split_rows(c["ids"], c["percent"], c["seed"]) for c in cases]))',
      ].join('\n'),
    ],
    { input: JSON.stringify(cases), encoding: 'utf8' },
  )
  assert.equal(got.status, 0, got.stderr)
  const fromPython = JSON.parse(got.stdout) as string[][]
  cases.forEach((item, index) => {
    assert.deepEqual(
      fromPython[index],
      splitRows(item.ids, item.percent, item.seed),
      `the split diverged on case ${index}`,
    )
  })
  assert.equal(fromPython[0].filter((part) => part === 'public').length, 119)
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------ blanks in the prediction */

const pandasHere = spawnSync('python3', ['-c', 'import pandas'], { encoding: 'utf8' }).status === 0

test('blank predictions are refused before score(), with the column, the count and a row',
  { skip: pandasHere ? false : 'no python3 with pandas: the scoring program runs only where it can' }, () => {
    const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR as string, 'score-'))
    // A metric that does not look for blanks itself: whatever refuses them
    // below is the platform, before score().
    fs.writeFileSync(path.join(dir, 'metric.py'),
      'def score(solution, submission):\n    return float(submission["target"].fillna(0).astype(float).sum())\n')
    const judge = (solution: string, submission: string) => {
      fs.writeFileSync(path.join(dir, 'solution.csv'), solution)
      fs.writeFileSync(path.join(dir, 'submission.csv'), submission)
      fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true })
      const got = spawnSync('python3', [path.join(harnessDir(), 'score_metric.py')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          COMP_SOLUTION: path.join(dir, 'solution.csv'),
          COMP_SUBMISSION: path.join(dir, 'submission.csv'),
          COMP_METRIC: path.join(dir, 'metric.py'),
          COMP_OUT: path.join(dir, 'out'),
          COMP_ATTEMPT_ID: 'attempt-1',
          COMP_PUBLIC_PERCENT: '50',
          COMP_SPLIT_SEED: 'seed',
        },
      })
      assert.ok(fs.existsSync(path.join(dir, 'out', 'score.json')), got.stderr)
      const { wall: _wall, attemptId: _attempt, ...report } =
        JSON.parse(fs.readFileSync(path.join(dir, 'out', 'score.json'), 'utf8')) as Record<string, unknown>
      return report
    }
    const solution = 'id,target\n100001,1\n100002,2\n100003,3\n100004,4\n100005,5\n100006,6\n'

    // An empty field, a NaN and a blank string, shuffled, plus an extra row the
    // key does not have. The example is the first blank in the KEY's order, and
    // the extra row is not counted: it is never scored.
    assert.deepEqual(
      judge(solution, 'id,target\n100006,6\n100004,NaN\n100005," "\n100001,1\n100003,3\n100002,\n999999,\n'),
      { status: 'participant_error', code: 'emptyPredictions', params: { count: 3, column: 'target', idColumn: 'id', example: '100002' } },
    )
    // Missing rows are named first: that is the bigger hole.
    assert.equal(judge(solution, 'id,target\n100001,\n100002,2\n100003,3\n100004,4\n100005,5\n').code, 'missingRows')
    // A blank the key shares is a gap in the teacher's answers, not a
    // forgotten prediction.
    assert.equal(
      judge('id,target\n100001,1\n100002,\n100003,3\n', 'id,target\n100001,1\n100002,\n100003,3\n').status,
      'ok',
    )
    // Only the key's columns are predictions; Usage is the split, not an answer.
    assert.equal(
      judge(`id,target,Usage\n100001,1,Public\n100002,2,Private\n`, 'id,target,note,Usage\n100001,1,,\n100002,2,,\n').status,
      'ok',
    )
    fs.rmSync(dir, { recursive: true, force: true })
  })

test('blank predictions are named in the instance language, with a count', () => {
  const refused = (count: number) => metricNote({
    status: 'participant_error', public: null, private: null, teacherOnly: null, wall: 1,
    message: JSON.stringify({ code: 'emptyPredictions', params: { count, column: 'target', idColumn: 'id', example: '100002' } }),
    diagnostics: { exit: 1, oomKilled: false, backend: 'test' },
  })
  assert.equal(refused(20), 'В колонке target 20 пустых прогнозов, например id=100002.')
  assert.equal(refused(1), 'В колонке target 1 пустой прогноз, например id=100002.')
  assert.equal(refused(3), 'В колонке target 3 пустых прогноза, например id=100002.')
  inEnglish(() => {
    assert.equal(refused(20), 'Column target has 20 empty predictions, for example id=100002.')
    assert.equal(refused(1), 'Column target has 1 empty prediction, for example id=100002.')
  })
})

/* ----------------------------------------------------------------- summary */

test("the executor's summary answers with what the panel sees", async () => {
  reset()
  const status = runnerStatus()
  assert.equal(status.backend, 'test')
  assert.equal(status.slots, 1)
  assert.equal(status.paused, false)
  assert.equal(status.waiting, 0)
  assert.deepEqual(status.running, [])
  assert.equal(DEFAULT_ID_COLUMN, 'id')
  assert.ok(openDir('x').includes('competitions'))
  assert.ok(secretDir('x').includes('secret'))
})

/* ------------------------------------------------ pinned dependency runtime */

test('dependency bundle is mounted read-only and /out permits venv execution within its quota', () => {
  const args = runArgs({ container: 'deps-run', image: 'sha256:pinned', dataDir: '/data/open', inputDir: '/data/input', resultDir: '/data/result', dependenciesDir: '/data/bundle', limits: LIMITS_SAMPLE, target: SUBMISSION_FILE })
  assert.ok(args.includes('/data/bundle:/deps:ro'))
  assert.ok(args.includes('COMP_DEPENDENCIES=/deps'))
  assert.ok(args.includes('--tmpfs=/out:rw,exec,nosuid,nodev,size=512m,mode=1777'))
  assert.ok(args.includes('--network') && args.includes('none'))
  assert.ok(args.includes('sha256:pinned'))
  assert.equal(verdictOfRun({ oom: false, killedBy: null, status: 'dependency_error', produced: false }), 'dependency_error')
})

test('offline dependency installation uses hashed local wheels and binds the kernel to venv Python', () => {
  const script = `
import ast, hashlib, json, os, re, subprocess, sys, tempfile, venv, zipfile
from pathlib import Path
source = Path(${JSON.stringify(path.join(harnessDir(), 'run_notebook.py'))}).read_text()
tree = ast.parse(source)
names = {'prepare_dependencies', 'dependency_command', 'cell_error_detail'}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert any(node.name == 'prepare_dependencies' for node in nodes), 'dependency runtime missing'
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    out = root / 'out'
    out.mkdir()
    deps = root / 'deps'
    wheels = deps / 'wheels'
    wheels.mkdir(parents=True)
    wheel = wheels / 'colloq_runtime_probe-1.0-py3-none-any.whl'
    with zipfile.ZipFile(wheel, 'w') as archive:
        archive.writestr('colloq_runtime_probe/__init__.py', 'VALUE = 73\\n')
        archive.writestr('colloq_runtime_probe-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: colloq-runtime-probe\\nVersion: 1.0\\n')
        archive.writestr('colloq_runtime_probe-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: colloq-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
        archive.writestr('colloq_runtime_probe-1.0.dist-info/RECORD', '')
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    lock = deps / 'requirements.lock'
    lock.write_text('colloq-runtime-probe==1.0 --hash=sha256:' + digest + '\\n')
    os.environ['COMP_DEPENDENCIES'] = str(deps)
    os.environ['JUPYTER_DATA_DIR'] = str(root / 'jupyter')
    scope = dict(Path=Path, os=os, sys=sys, json=json, subprocess=subprocess, tempfile=tempfile, venv=venv, re=re, OUT=out)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<dependencies>', 'exec'), scope)
    kernel = scope['prepare_dependencies']()
    spec = json.loads((Path(os.environ['JUPYTER_DATA_DIR']) / 'kernels' / kernel / 'kernel.json').read_text())
    interpreter = Path(spec['argv'][0])
    assert interpreter == out / '.colloq-venv' / 'bin' / 'python', spec
    assert spec['argv'][1:] == ['-m', 'ipykernel_launcher', '-f', '{connection_file}']
    probe = subprocess.run([str(interpreter), '-c', 'import colloq_runtime_probe, sys; print(colloq_runtime_probe.VALUE); print(sys.prefix)'], capture_output=True, text=True, check=True)
    assert probe.stdout.splitlines()[0] == '73', probe.stdout
    assert Path(probe.stdout.splitlines()[1]).resolve() == (out / '.colloq-venv').resolve(), probe.stdout
    assert 'include-system-site-packages = true' in (out / '.colloq-venv' / 'pyvenv.cfg').read_text()
    # An altered hash cannot become a runnable environment.
    import shutil
    shutil.rmtree(out / '.colloq-venv')
    lock.write_text('colloq-runtime-probe==1.0 --hash=sha256:' + '0' * 64 + '\\n')
    try:
        scope['prepare_dependencies']()
        raise AssertionError('bad hash was accepted')
    except RuntimeError as error:
        assert 'hash' in str(error).lower(), str(error)
        assert len(str(error)) <= 4000
    del os.environ['COMP_DEPENDENCIES']
    assert scope['prepare_dependencies']() == 'python3'
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})

test('dependency installation failure is reported before constructing or executing a notebook client', () => {
  const script = `
import ast, json, os, re, tempfile, time
from pathlib import Path
from types import SimpleNamespace
source = Path(${JSON.stringify(path.join(harnessDir(), 'run_notebook.py'))}).read_text()
tree = ast.parse(source)
names = {'main', 'write_json', 'cell_error_detail'}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names
         or isinstance(node, ast.ClassDef) and node.name == 'PackagesDoNotFit']
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    for key in ['HOME', 'JUPYTER_RUNTIME_DIR', 'JUPYTER_DATA_DIR', 'MPLCONFIGDIR']:
        os.environ[key] = str(root / key)
    os.environ['COMP_DEPENDENCIES'] = str(root / 'deps')
    def broken():
        raise RuntimeError('bad hash ' + 'x' * 5000)
    def forbidden(*args, **kwargs):
        raise AssertionError('notebook execution must not start')
    scope = dict(Path=Path, os=os, json=json, re=re, time=time, OUT=root, RESULT=root,
                 PROGRESS=root / 'progress.json', RUN_JSON=root / 'run.json',
                 NOTEBOOK=root / 'notebook.ipynb', prepare_workspace=lambda: None,
                 nbformat=SimpleNamespace(read=lambda *args, **kwargs: object()),
                 prepare_dependencies=broken, Runner=forbidden, read_peak=lambda: None)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<main>', 'exec'), scope)
    assert scope['main']() == 1
    beat = json.loads((root / 'progress.json').read_text())
    report = json.loads((root / 'run.json').read_text())
    assert beat['phase'] == 'dependencies' and beat['cell'] == -1
    assert report['status'] == 'dependency_error' and report['cell'] == -1 and report['cells'] == 0
    assert len(report['detail']) <= 4000
    # A broken set is no full disk: no reason is claimed for it.
    assert 'reason' not in report
    assert not (root / 'executed.ipynb').exists()
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('a set that runs out of room is named apart from a broken one, with the room it had', () => {
  const script = `
import ast, json, os, re, subprocess, sys, tempfile, time
from pathlib import Path
from types import SimpleNamespace
source = Path(${JSON.stringify(path.join(harnessDir(), 'run_notebook.py'))}).read_text()
tree = ast.parse(source)
names = {'main', 'write_json', 'cell_error_detail', 'dependency_command', 'room_of'}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names
         or isinstance(node, ast.ClassDef) and node.name == 'PackagesDoNotFit']
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    scope = dict(Path=Path, os=os, json=json, re=re, time=time, subprocess=subprocess, tempfile=tempfile, sys=sys)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<room>', 'exec'), scope)
    DoNotFit = scope['PackagesDoNotFit']
    # pip's own words for a full disk, as the class saw them four times in a row.
    full = [sys.executable, '-c', 'import sys; print("ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device"); sys.exit(1)']
    try:
        scope['dependency_command'](full, root)
        raise AssertionError('a full disk passed for a broken set')
    except DoNotFit as error:
        assert error.room and error.room > 0, error.room
        assert 'No space left on device' in str(error)
    hashes = [sys.executable, '-c', 'import sys; print("ERROR: THESE PACKAGES DO NOT MATCH THE HASHES"); sys.exit(1)']
    try:
        scope['dependency_command'](hashes, root)
        raise AssertionError('a failed install passed')
    except DoNotFit:
        raise AssertionError('a hash failure was read as a full disk')
    except RuntimeError as error:
        assert 'HASHES' in str(error)
    # main() writes the reason and the room into run.json for the host.
    for key in ['HOME', 'JUPYTER_RUNTIME_DIR', 'JUPYTER_DATA_DIR', 'MPLCONFIGDIR']:
        os.environ[key] = str(root / key)
    os.environ['COMP_DEPENDENCIES'] = str(root / 'deps')
    def full_disk():
        raise DoNotFit('ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device', 397410304)
    def forbidden(*args, **kwargs):
        raise AssertionError('notebook execution must not start')
    scope.update(OUT=root, RESULT=root, PROGRESS=root / 'progress.json', RUN_JSON=root / 'run.json',
                 NOTEBOOK=root / 'notebook.ipynb', prepare_workspace=lambda: None,
                 nbformat=SimpleNamespace(read=lambda *args, **kwargs: object()),
                 prepare_dependencies=full_disk, Runner=forbidden, read_peak=lambda: None)
    assert scope['main']() == 1
    report = json.loads((root / 'run.json').read_text())
    assert report['status'] == 'dependency_error', report
    assert report['reason'] == 'no_space' and report['roomBytes'] == 397410304, report
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})

test('a set is installed into the room the host sized for it, not into the working folder', () => {
  const script = `
import ast, errno, hashlib, json, os, re, subprocess, sys, tempfile, venv, zipfile
from pathlib import Path
source = Path(${JSON.stringify(path.join(harnessDir(), 'run_notebook.py'))}).read_text()
tree = ast.parse(source)
names = {'prepare_dependencies', 'dependency_command', 'cell_error_detail', 'room_of'}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names
         or isinstance(node, ast.ClassDef) and node.name == 'PackagesDoNotFit']
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    out = root / 'out'
    packages = root / 'packages'
    out.mkdir()
    packages.mkdir()
    wheels = root / 'deps' / 'wheels'
    wheels.mkdir(parents=True)
    wheel = wheels / 'colloq_room_probe-1.0-py3-none-any.whl'
    with zipfile.ZipFile(wheel, 'w') as archive:
        archive.writestr('colloq_room_probe/__init__.py', 'VALUE = 11\\n')
        archive.writestr('colloq_room_probe-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: colloq-room-probe\\nVersion: 1.0\\n')
        archive.writestr('colloq_room_probe-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: colloq-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
        archive.writestr('colloq_room_probe-1.0.dist-info/RECORD', '')
    (root / 'deps' / 'requirements.lock').write_text('colloq-room-probe==1.0 --hash=sha256:' + hashlib.sha256(wheel.read_bytes()).hexdigest() + '\\n')
    os.environ['COMP_DEPENDENCIES'] = str(root / 'deps')
    os.environ['COMP_PACKAGES'] = str(packages)
    os.environ['JUPYTER_DATA_DIR'] = str(root / 'jupyter')
    scope = dict(Path=Path, os=os, sys=sys, json=json, subprocess=subprocess, tempfile=tempfile, venv=venv, re=re, errno=errno, OUT=out)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<packages>', 'exec'), scope)
    kernel = scope['prepare_dependencies']()
    spec = json.loads((root / 'jupyter' / 'kernels' / kernel / 'kernel.json').read_text())
    assert Path(spec['argv'][0]) == packages / '.colloq-venv' / 'bin' / 'python', spec
    assert not (out / '.colloq-venv').exists(), 'the set took the working folder after all'
    probe = subprocess.run([spec['argv'][0], '-c', 'import colloq_room_probe; print(colloq_room_probe.VALUE)'], capture_output=True, text=True, check=True)
    assert probe.stdout.strip() == '11', probe.stdout
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})

/*
 * The executed notebook through main() itself, with nbformat for real and a
 * stand-in nbclient that plays the cells by a script in their source: the
 * suite has no Jupyter kernel, and the kernel is not what is checked here.
 */
const nbformatHere = spawnSync('python3', ['-c', 'import nbformat'], { encoding: 'utf8' }).status === 0

function playNotebook(cells: Array<{ source: string; stale?: string; markdown?: boolean }>, env: Record<string, string>): {
  status: number | null
  stderr: string
  run: Record<string, any>
  executed: { cells: Array<{ cell_type: string; execution_count?: number | null; outputs?: Array<{ text?: string | string[] }> }> } | null
  record: Record<string, any>
  /** What the harness left in its result folder. */
  files: string[]
} {
  const root = fs.mkdtempSync(path.join(process.env.DATA_DIR as string, 'play-'))
  const fake = path.join(root, 'fake', 'nbclient')
  fs.mkdirSync(fake, { recursive: true })
  fs.writeFileSync(path.join(fake, 'exceptions.py'), [
    'class CellExecutionError(Exception): pass',
    'class CellTimeoutError(TimeoutError): pass',
    'class DeadKernelError(RuntimeError): pass',
  ].join('\n') + '\n')
  fs.writeFileSync(path.join(fake, '__init__.py'), `
import asyncio, json, os
from pathlib import Path
import nbformat
from nbclient.exceptions import CellTimeoutError

class NotebookClient:
    """Plays each code cell by its lines: "print X" prints, "stuck" is a cell that never ends."""

    def __init__(self, nb, **kwargs):
        self.nb = nb
        self.timeout = kwargs.get('timeout')
        self.timeout_func = None
        self.shutdown_kernel = 'graceful'
        self.record = {'budgets': [], 'extraArguments': kwargs.get('extra_arguments')}

    def output(self, outs, msg, display_id, cell_index):
        # Outputs are notebook nodes, as nbclient makes them: nbformat writes nothing else.
        outs.append(nbformat.v4.new_output('stream', name='stdout', text=msg['content']['text']))

    async def _async_handle_timeout(self, timeout, cell=None):
        executed = Path(os.environ['COMP_RESULT']) / 'executed.ipynb'
        self.record['savedAtTimeout'] = executed.read_text() if executed.exists() else ''
        raise CellTimeoutError('A cell timed out while it was being executed, after %s seconds.' % timeout)

    def execute(self):
        try:
            for index, cell in enumerate(self.nb.cells):
                self.on_cell_start(cell=cell, cell_index=index)
                if cell.cell_type != 'code':
                    continue
                budget = self.timeout_func(cell) if self.timeout_func else self.timeout
                self.record['budgets'].append(budget)
                cell.outputs = []
                for line in cell.source.splitlines():
                    if line.startswith('print '):
                        self.output(cell.outputs, {'content': {'text': line[6:] + '\\n'}}, None, index)
                    elif line == 'stuck':
                        asyncio.run(self._async_handle_timeout(budget, cell))
                    elif line == 'unwritable':
                        # An output nbformat cannot write: the copy fails to save.
                        cell.outputs.append({'output_type': 'stream'})
                cell.execution_count = len(self.record['budgets'])
                self.on_cell_executed(cell=cell, cell_index=index)
        finally:
            self.record['shutdown'] = self.shutdown_kernel
            Path(os.environ['FAKE_RECORD']).write_text(json.dumps(self.record))
`)
  const notebook = {
    cells: cells.map((cell) => cell.markdown
      ? { cell_type: 'markdown', source: cell.source, metadata: {} }
      : {
          cell_type: 'code', source: cell.source, metadata: { execution: { 'iopub.status.busy': 'yesterday' } },
          execution_count: cell.stale ? 41 : null,
          outputs: cell.stale ? [{ output_type: 'stream', name: 'stdout', text: cell.stale }] : [],
        }),
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  }
  for (const part of ['in', 'out', 'result', 'data', 'home']) fs.mkdirSync(path.join(root, part))
  fs.writeFileSync(path.join(root, 'in', 'notebook.ipynb'), JSON.stringify(notebook))
  const result = spawnSync('python3', [path.join(harnessDir(), 'run_notebook.py')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH, HOME: path.join(root, 'home'), PYTHONPATH: path.join(root, 'fake'),
      COMP_NOTEBOOK: path.join(root, 'in', 'notebook.ipynb'), COMP_OUT: path.join(root, 'out'),
      COMP_RESULT: path.join(root, 'result'), COMP_DATA: path.join(root, 'data'), COMP_ATTEMPT_ID: 'play',
      FAKE_RECORD: path.join(root, 'record.json'), ...env,
    },
  })
  const read = (file: string) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null)
  return {
    status: result.status,
    stderr: result.stderr,
    run: read(path.join(root, 'result', 'run.json')) ?? {},
    executed: read(path.join(root, 'result', 'executed.ipynb')),
    record: read(path.join(root, 'record.json')) ?? {},
    files: fs.readdirSync(path.join(root, 'result')).sort(),
  }
}

const textOf = (outputs: Array<{ text?: string | string[] }> = []) =>
  outputs.map((output) => (Array.isArray(output.text) ? output.text.join('') : output.text ?? '')).join('')

/** A monotonic reading from python3 itself: the clock the harness compares its mark with. */
const monotonicNow = (): number => Number(spawnSync('python3', ['-c', 'import time; print(time.monotonic())'], { encoding: 'utf8' }).stdout)

test(
  'a late notebook is stopped from inside, before the host would kill it, with every output it made',
  { skip: nbformatHere ? false : 'no python3 with nbformat: the harness cannot read a notebook here' },
  () => {
    // The container started 50 s ago under a 60 s limit: five seconds are left
    // before the harness stops the notebook itself (STOP_EARLY).
    const played = playNotebook([
      { source: '# The task', markdown: true },
      { source: 'print hello', stale: 'OUTPUT FROM THE LAPTOP\n' },
      { source: 'print epoch 0\nprint epoch 1\nstuck' },
      { source: 'print never', stale: 'ALSO FROM THE LAPTOP\n' },
    ], { COMP_WALL_SECONDS: '60', COMP_STARTED_MONOTONIC: String(monotonicNow() - 50) })
    assert.equal(played.status, 1, played.stderr)
    assert.equal(played.run.status, 'cell_timeout', 'the host reads a timeout it did not have to kill for')
    assert.equal(played.run.cell, 1, 'it stopped on the second code cell')
    // Every cell may wait only for what is left of the run.
    for (const budget of played.record.budgets) assert.ok(budget >= 1 && budget <= 5, `budget ${budget}`)
    // The kernel is killed, not asked: a busy kernel takes five seconds to refuse.
    assert.equal(played.record.shutdown, 'immediate')
    // The notebook was on disk, with the stuck cell's lines, before nbclient touched the kernel.
    assert.match(played.record.savedAtTimeout, /epoch 1/)
    const cells = played.executed!.cells.filter((cell) => cell.cell_type === 'code')
    assert.equal(textOf(cells[0].outputs), 'hello\n')
    assert.equal(textOf(cells[1].outputs), 'epoch 0\nepoch 1\n', 'what the stuck cell printed so far is kept')
    // The laptop's outputs are gone: a cell the run never reached shows none.
    assert.equal(textOf(cells[2].outputs), '')
    assert.equal(cells[2].execution_count ?? null, null)
    assert.doesNotMatch(JSON.stringify(played.executed), /LAPTOP|yesterday/)
  },
)

test(
  'the written notebook joins consecutive lines of one stream into one output',
  { skip: nbformatHere ? false : 'no python3 with nbformat: the harness cannot read a notebook here' },
  () => {
    const played = playNotebook([{ source: 'print one\nprint two\nprint three' }], {})
    assert.equal(played.status, 0, played.stderr)
    const cell = played.executed!.cells.find((c) => c.cell_type === 'code')!
    const streams = cell.outputs.filter((o) => o.output_type === 'stream')
    assert.equal(streams.length, 1, 'one block, however many messages carried it')
    assert.equal(textOf(streams), 'one\ntwo\nthree\n')
  },
)

test(
  'a time limit that comes between two cells starts no next cell, and the notebook is still written',
  { skip: nbformatHere ? false : 'no python3 with nbformat: the harness cannot read a notebook here' },
  () => {
    const played = playNotebook([
      { source: 'print first', stale: 'OLD\n' },
      { source: 'print second' },
    ], { COMP_WALL_SECONDS: '60', COMP_STARTED_MONOTONIC: String(monotonicNow() - 100) })
    assert.equal(played.status, 1, played.stderr)
    assert.equal(played.run.status, 'cell_timeout')
    assert.deepEqual(played.record.budgets, [], 'no cell was started past the limit')
    assert.ok(played.executed, 'the executed copy is written on every ending')
    assert.equal(textOf(played.executed!.cells[0].outputs), '')
  },
)

test(
  'without a limit the notebook runs as it did, and its executed copy holds this run only',
  { skip: nbformatHere ? false : 'no python3 with nbformat: the harness cannot read a notebook here' },
  () => {
    const played = playNotebook([{ source: 'print done', stale: 'OLD\n' }], {})
    assert.equal(played.run.status, 'ok', played.stderr)
    assert.deepEqual(played.record.budgets, [null], 'no limit, no per-cell timeout either')
    assert.equal(played.record.shutdown, 'graceful', 'a finished kernel still exits on its own, flushing its files')
    assert.equal(textOf(played.executed!.cells[0].outputs), 'done\n')
    assert.deepEqual(played.files, ['executed.ipynb', 'progress.json', 'run.json'])
  },
)

test(
  'an executed copy that cannot be saved leaves no half-written file for the exporter to refuse',
  { skip: nbformatHere ? false : 'no python3 with nbformat: the harness cannot read a notebook here' },
  () => {
    const played = playNotebook([{ source: 'print first\nunwritable' }], {})
    assert.match(played.run.detail, /executed\.ipynb not written/)
    // The broker's exporter fails the whole result folder on a file it does not know.
    assert.ok(!played.files.some((name) => name.endsWith('.tmp')), played.files.join(', '))
  },
)

/* ------------------------------------------ a line printed right before a kill */

test(
  'the kernel starts with kernel_streams.py run as a file, outside any cell',
  { skip: nbformatHere ? false : 'no python3 with nbformat: the harness cannot read a notebook here' },
  () => {
    const played = playNotebook([{ source: 'print done' }], {})
    assert.equal(played.run.status, 'ok', played.stderr)
    const file = path.join(harnessDir(), 'kernel_streams.py')
    assert.ok(fs.existsSync(file), 'the file travels with the harness')
    // Not exec_lines: IPython runs those as a cell, and a cell puts the
    // stream's own write back when it ends.
    assert.deepEqual(played.record.extraArguments, [`--IPKernelApp.exec_files=${file}`])
  },
)

test('a printed line is handed to the IOPub thread before the cell goes on, within a budget', () => {
  // ipykernel and IPython are stand-ins: what is checked is when the stream
  // is flushed, and the suite has no Jupyter.
  const script = `
import os, sys, threading, time, types
from pathlib import Path
source = Path(${JSON.stringify(path.join(harnessDir(), 'kernel_streams.py'))}).read_text()
calls = []
class OutStream:
    def __init__(self, name):
        self.name = name
    def write(self, text):
        calls.append(('write', self.name, text))
        return len(text)
    def flush(self):
        calls.append(('flush', self.name))
registered = []
class Events:
    def register(self, event, callback):
        registered.append((event, callback))
shell = types.SimpleNamespace(events=Events())
def module(name, **attrs):
    sys.modules[name] = types.ModuleType(name)
    sys.modules[name].__dict__.update(attrs)
module('ipykernel')
module('ipykernel.iostream', OutStream=OutStream)
module('IPython', get_ipython=lambda: shell)
def load(stdout, stderr):
    namespace = {}
    real = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = stdout, stderr
    try:
        exec(compile(source, 'kernel_streams.py', 'exec'), namespace)
    finally:
        sys.stdout, sys.stderr = real
    return namespace
def flushes(stream, text):
    calls.clear()
    assert stream.write(text) == len(text), 'what write returns is passed on'
    return [call for call in calls if call[0] == 'flush']

out, err = OutStream('stdout'), OutStream('stderr')
namespace = load(out, err)
# The participant's namespace is where it runs, and it leaves nothing there.
assert set(namespace) == {'__builtins__'}, sorted(namespace)
assert [event for event, _ in registered] == ['pre_run_cell'], registered
new_cell = registered[0][1]

# Text without a line end waits for ipykernel's timer, as before.
assert flushes(out, 'progress 10%') == []
# A line: flushed twice before write returns, the second waiting for the send.
assert flushes(out, 'about to allocate over 2 GB\\n') == [('flush', 'stdout')] * 2
assert flushes(err, 'UserWarning: careful\\n') == [('flush', 'stderr')] * 2
# Twenty lines a cell go at once, both streams together; the next waits...
for n in range(18):
    assert flushes(out, f'line {n}\\n'), n
assert flushes(out, 'line 21\\n') == []
# ...until 0.2 s have passed since the last one sent at once.
time.sleep(0.25)
assert len(flushes(out, 'after a pause\\n')) == 2
assert flushes(out, 'right after it\\n') == []
# Every cell starts with its twenty.
new_cell(object())
for n in range(20):
    assert flushes(out, f'next cell {n}\\n'), n
assert flushes(out, 'next cell 21\\n') == []
new_cell(object())
# A thread of the notebook keeps ipykernel's batching...
seen = []
thread = threading.Thread(target=lambda: seen.append(flushes(out, 'from a thread\\n')))
thread.start()
thread.join()
assert seen == [[]], seen
# ...and so does a forked child, which inherits the very same stream.
child = os.fork()
if child == 0:
    os._exit(0 if flushes(out, 'from a child\\n') == [] else 1)
assert os.waitstatus_to_exitcode(os.waitpid(child, 0)[1]) == 0, 'a forked child handed a line over'
assert len(flushes(out, 'back in the kernel\\n')) == 2
# A notebook that mocks the clock for its own tests changes nothing here.
for n in range(19):
    assert flushes(out, f'filler {n}\\n'), n
monotonic, time.monotonic = time.monotonic, lambda: 10.0 ** 12
try:
    assert flushes(out, 'with a mocked clock\\n') == []
finally:
    time.monotonic = monotonic

# A stream that is not ipykernel's is left as it was.
class Plain:
    def write(self, text):
        return len(text)
plain = Plain()
load(plain, plain)
assert 'write' not in vars(plain)
# So is a kernel without ipykernel: nothing raised, nothing changed.
sys.modules['ipykernel.iostream'] = None
bare = OutStream('stdout')
assert set(load(bare, bare)) == {'__builtins__'}
assert 'write' not in vars(bare)
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr)
})

/** A python3 with Jupyter: only there does a real kernel run under the harness. */
const jupyterHere = spawnSync('python3', ['-c', 'import nbclient, ipykernel, nbformat'], { encoding: 'utf8' }).status === 0

test(
  'a line printed right before the kernel is killed reaches the executed notebook',
  { skip: jupyterHere ? false : 'no python3 with nbclient and ipykernel: no real kernel to kill here' },
  () => {
    // The kill comes the instant print returns — sooner than the OOM killer
    // ends a cell allocating past its memory. Without kernel_streams.py the
    // line was still in the kernel's buffer: 0 runs of 10 kept it.
    const root = fs.mkdtempSync(path.join(process.env.DATA_DIR as string, 'killed-'))
    for (const part of ['in', 'out', 'result', 'data', 'home']) fs.mkdirSync(path.join(root, part))
    const cell = (source: string) => ({ cell_type: 'code', source, metadata: {}, execution_count: null, outputs: [] })
    fs.writeFileSync(path.join(root, 'in', 'notebook.ipynb'), JSON.stringify({
      cells: [
        cell("print('warming up')"),
        cell('import os, signal\nprint("about to allocate over 2 GB")\nos.kill(os.getpid(), signal.SIGKILL)'),
        cell("print('never')"),
      ],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    }))
    const result = spawnSync('python3', [path.join(harnessDir(), 'run_notebook.py')], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        PATH: process.env.PATH, HOME: path.join(root, 'home'), COMP_ATTEMPT_ID: 'killed',
        COMP_NOTEBOOK: path.join(root, 'in', 'notebook.ipynb'), COMP_OUT: path.join(root, 'out'),
        COMP_RESULT: path.join(root, 'result'), COMP_DATA: path.join(root, 'data'),
      },
    })
    const run = JSON.parse(fs.readFileSync(path.join(root, 'result', 'run.json'), 'utf8'))
    assert.equal(run.status, 'kernel_died', result.stderr)
    assert.equal(run.cell, 1)
    const cells = JSON.parse(fs.readFileSync(path.join(root, 'result', 'executed.ipynb'), 'utf8')).cells
    assert.equal(textOf(cells[0].outputs), 'warming up\n')
    assert.equal(textOf(cells[1].outputs), 'about to allocate over 2 GB\n')
    // The cell's number came out with the line: it did start, as a timed-out one does.
    assert.equal(cells[1].execution_count, 2)
    assert.equal(textOf(cells[2].outputs), '')
  },
)

test('the notebook command gives a package set its own room, and a file cap to match', () => {
  const MiB = 1024 * 1024
  const args = runArgs({ container: 'deps-room', image: 'sha256:pinned', dataDir: '/data/open', inputDir: '/data/input', resultDir: '/data/result', dependenciesDir: '/data/bundle', packagesMb: 379, limits: LIMITS_SAMPLE, target: SUBMISSION_FILE })
  assert.ok(args.includes('--tmpfs=/packages:rw,exec,nosuid,nodev,size=379m,mode=1777'))
  assert.ok(args.includes('COMP_PACKAGES=/packages'))
  // catboost's _catboost.so alone is 264 MB: over four answers' worth of file cap.
  assert.ok(args.includes(`--ulimit=fsize=${379 * MiB}:${379 * MiB}`))
  // The working folder keeps its own eighth of the memory, untouched by the set.
  assert.ok(args.includes('--tmpfs=/out:rw,exec,nosuid,nodev,size=512m,mode=1777'))
  // Still no writable host mount: the room is memory, not a folder of the host.
  assert.ok(args.filter((_, i) => args[i - 1] === '-v').every((mount) => mount.endsWith(':ro')))
  const plain = runArgs({ container: 'no-deps', image: 'sha256:pinned', dataDir: '/data/open', inputDir: '/data/input', resultDir: '/data/result', packagesMb: 379, limits: LIMITS_SAMPLE, target: SUBMISSION_FILE })
  assert.ok(!plain.some((arg) => arg.includes('/packages')), 'no set, no room')
  assert.ok(plain.includes(`--ulimit=fsize=${64 * MiB * 4}:${64 * MiB * 4}`))
})


test('Docker launches both steps with their immutable image binding and excludes bundles from scorer', async () => {
  const before = process.env.COMPETITION_BACKEND
  const commands: string[][] = []
  process.env.COMPETITION_BACKEND = 'docker'
  useCompetitionRunner(null)
  forgetCompetitionRunner()
  useDockerForCompetitions(async (args) => { commands.push(args); return { code: args[0] === 'rm' ? 0 : 1, out: 'launch stopped by test' } })
  try {
    const actual = competitionRunner()
    const competition = { environment: 'mutable-tag', publicPercent: 30, splitSeed: 's' } as Competition
    await actual.run({ competition, imageDigest: 'sha256:notebook-base', dependenciesDir: '/data/bundle', submissionId: 's', container: 'c-run', dataDir: '/data/open', inputDir: '/data/input', resultDir: '/data/result', limits: LIMITS_SAMPLE })
    await actual.score({ competition, imageDigest: 'sha256:scorer-base', submissionId: 's', container: 'c-score', secretDir: '/data/secret', submissionDir: '/data/answer', outDir: '/data/score', limits: LIMITS_SAMPLE })
    const launches = commands.filter((args) => args[0] === 'run')
    assert.ok(launches[0].includes('sha256:notebook-base'))
    assert.ok(launches[0].includes('/data/bundle:/deps:ro'))
    assert.ok(launches[1].includes('sha256:scorer-base'))
    assert.ok(!launches[1].some((arg) => arg.includes('/deps') || arg.includes('COMP_DEPENDENCIES')))
    assert.ok(!commands.flat().some((arg) => arg.includes('mutable-tag')))
  } finally {
    useDockerForCompetitions(null)
    useCompetitionRunner(runner)
    forgetCompetitionRunner()
    if (before === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = before
  }
})

/* ------------------------------------------- the executed notebook, the set's room */

/** The runner behind a stand-in docker for one check, restored after it. */
async function withDocker<T>(fake: Parameters<typeof useDockerForCompetitions>[0], body: () => Promise<T>): Promise<T> {
  const before = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'docker'
  useCompetitionRunner(null)
  forgetCompetitionRunner()
  useDockerForCompetitions(fake)
  try {
    return await body()
  } finally {
    useDockerForCompetitions(null)
    useCompetitionRunner(runner)
    forgetCompetitionRunner()
    if (before === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = before
  }
}

const base64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')

test('a run killed at its limit keeps the notebook the harness had on disk, read before the kill', async () => {
  reset()
  const competition = makeCompetition()
  const submission = send(competition, mint('Долгий').id, ['train()'])
  const out = resultDir(competition.id, submission.id)
  const commands: string[][] = []
  const saved = { cells: [{ cell_type: 'code', source: 'train()', metadata: {}, execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: 'epoch 7\n' }] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }
  const outcome = await withDocker(async (args) => {
    commands.push(args)
    if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 137 false' }
    // A harness that never finished: no completion, however often it is looked at.
    if (args[0] === 'exec' && args[5] === 'status') return { code: 0, out: '{}' }
    if (args[0] === 'exec' && args.at(-1) === 'executed.ipynb') return { code: 0, out: base64(saved) }
    if (args[0] === 'exec') return { code: 1, out: 'no such file' }
    return { code: 0, out: '' }
  }, () => competitionRunner().run({
    competition, submissionId: submission.id, attemptId: 'late', container: 'late-run',
    dataDir: openDir(competition.id), inputDir: '/data/in', resultDir: out, limits: { ...LIMITS_SAMPLE, wallSeconds: 1 },
  }))
  assert.equal(outcome.status, 'timeout')
  const salvage = commands.findIndex((args) => args[0] === 'exec' && args.at(-1) === 'executed.ipynb')
  const kill = commands.findIndex((args) => args[0] === 'kill')
  assert.ok(salvage >= 0 && kill > salvage, 'the notebook is copied out while its tmpfs still exists')
  assert.match(fs.readFileSync(path.join(out, 'executed.ipynb'), 'utf8'), /epoch 7/)
})

test('a set that ran out of room tells the participant so, with the room it had, in both languages', async () => {
  reset()
  const MiB = 1024 * 1024
  const competition = makeCompetition()
  const submission = send(competition, mint('Катя').id, ['import catboost'])
  const report = { status: 'dependency_error', reason: 'no_space', roomBytes: 379 * MiB, cell: -1, cells: 0, attemptId: 'full',
    detail: 'ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device' }
  const outcome = await withDocker(async (args) => {
    if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 1 false' }
    if (args[0] === 'exec' && args[5] === 'status') return { code: 0, out: JSON.stringify({ complete: { attemptId: 'full', exit: 1 } }) }
    if (args[0] === 'exec' && args.at(-1) === 'run.json') return { code: 0, out: base64(report) }
    if (args[0] === 'exec') return { code: 1, out: 'no such file' }
    return { code: 0, out: '' }
  }, () => competitionRunner().run({
    competition, submissionId: submission.id, attemptId: 'full', container: 'full-run', dependenciesDir: '/data/bundle', packagesMb: 379,
    dataDir: openDir(competition.id), inputDir: '/data/in', resultDir: resultDir(competition.id, submission.id), limits: LIMITS_SAMPLE,
  }))
  assert.equal(outcome.status, 'dependency_error')
  assert.deepEqual(outcome.dependencyFailure, { reason: 'no_space', roomBytes: 379 * MiB })
  assert.equal(notebookNote(outcome, competition),
    'Набор пакетов не поместился в посылку: при установке закончилось отведённое под него место — 379 МБ. Уберите из набора тяжёлые пакеты или обратитесь к преподавателю.')
  assert.equal(inEnglish(() => notebookNote(outcome, competition)),
    'The package set did not fit into the submission: the installation ran out of the 379 MB set aside for it. Remove heavy packages from the set or contact your teacher.')
  // Any other install failure keeps the old words: a retry may well help it.
  assert.match(notebookNote({ ...outcome, dependencyFailure: undefined }, competition) ?? '', /^Не удалось установить подготовленный набор/)
})

test('a set that no longer fits the submission memory is refused before any container, with its numbers', async () => {
  reset()
  const MiB = 1024 * 1024
  const competition = makeCompetition({ limits: { wallSeconds: 600, memoryMb: 2048, cpus: 2, perDay: 0 } })
  setCompetitionState(competition.id, 'live')
  const revision = putRevision({
    environmentName: 'base', imageDigest: `sha256:${'e'.repeat(64)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/arm64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash',
  })
  selectRevision(competition.id, revision.id)
  setPolicy(competition.id, { enabled: true })
  const entrant = mint('Гоша')
  // The set of the class that could not install: xgboost-cpu, catboost, lightgbm.
  const set = createBundle(competition.id, entrant.id, revision.id, 'xgboost-cpu\ncatboost\nlightgbm')
  completeBundle(set.id, {
    normalizedRequirements: ['xgboost-cpu', 'catboost', 'lightgbm'], downloadBytes: 1, installedBytes: 315 * MiB, contentHash: '3'.repeat(64),
    packages: [{ name: 'catboost', version: '1.2.10', fileName: 'catboost-1.2.10-py3-none-any.whl', sha256: '4'.repeat(64), bytes: 1 }],
    lock: `catboost==1.2.10 --hash=sha256:${'4'.repeat(64)}\n`,
  })
  const submission = send(competition, entrant.id, ['import catboost'])
  // Its room is 379 MB, under half of 2 GB: it is attached.
  bindSubmission(submission.id, revision.id, set.id)
  // Then the teacher lowers the memory to 512 MB, and the same room is more than half of it.
  updateCompetition(competition.id, { limits: { ...competition.limits, memoryMb: 512 } })
  let started = 0
  const run = runner.run.bind(runner)
  runner.run = async (request) => { started++; return run(request) }
  try {
    await drainCompetitionQueue()
  } finally {
    runner.run = run
  }
  assert.equal(started, 0, 'no container for a set that cannot fit')
  const done = getSubmission(submission.id)
  assert.equal(done?.state, 'rejected')
  assert.equal(done?.stage, 'dependencies')
  assert.equal(done?.participantError,
    'Набор пакетов не поместится в посылку: в памяти он займёт до 379 МБ, а набору можно не больше половины из 512 МБ, отведённых посылке. Уберите из набора тяжёлые пакеты или попросите преподавателя увеличить память.')
  assert.equal(listRuns(submission.id)[0].verdict, 'dependency_error')
})
