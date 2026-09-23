/**
 * Прогонщик посылок: очередь, два шага, исходы.
 *
 * Проверяется то, что ломается тихо и дорого. Команда контейнера, из которой
 * пропал один флаг: посылка с интернетом или с правом писать в корень видна
 * только тому, кто ею воспользуется. Ответы, попавшие в контейнер участника, —
 * это соревнование, решённое чтением файла. Очередь, которая после
 * перезапуска сервера держит посылку «выполняется» до конца соревнования.
 * Трассировка метрики, уехавшая участнику вместо преподавателя. И деление
 * строк, посчитанное браузером иначе, чем контейнером, — единственная ошибка
 * из этого списка, которую вообще некому заметить.
 *
 * Настоящего docker здесь нет и быть не должно: команды проверяются чистыми
 * функциями, а всё остальное — подставным прогонщиком, который не исполняет ни
 * строки чужого кода.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { splitRows } from '../shared/competitions.js'
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
  setQueuePaused,
  takeNext,
  updateSubmission,
  waitingCount,
  type QueueRow,
} from '../server/src/competitions/store.js'
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
} from '../server/src/competitions/runner-port.js'
import { harnessDir, SPLIT_SOURCE } from '../server/src/competitions/harness.js'
import {
  cancelSubmission,
  containerName,
  drainCompetitionQueue,
  enoughMemory,
  pumpOnce,
  queueSlots,
  reclaimCompetitionQueue,
  rescoreCompetition,
  rerunSubmission,
  settleCompetitionWork,
  setQueueSlots,
  runnerStatus,
} from '../server/src/competitions/runner.js'
import type { Competition } from '../shared/competitions.js'

/* ------------------------------------------------------------- обстановка */

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

/**
 * Очередь одна на инстанс, и это не обстоятельство теста, а устройство
 * продукта: исполнитель у машины один на все соревнования. Поэтому каждая
 * проверка начинает с чистого листа.
 */
function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
  runner.availableMb = 65_536
}

let seq = 0

/** Ключ участника возвращается один раз, при заведении; прогонщику он не нужен. */
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
  assert.ok(made, 'соревнование должно завестись')
  // Всё, без чего посылку считать нечем: открытый образец ответа и ответы.
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 24, visibility: 'open' })
  return made
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Тетрадь из настоящего .ipynb: подставной прогонщик читает её как json. */
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

/* --------------------------------------------------- команды контейнеров */

const LIMITS_SAMPLE = limitsFor(
  { limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition,
  'notebook',
)

test('команда тетради: без сети, только на чтение, с потолками', () => {
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
  assert.ok(line.includes('--network none'), 'сети у посылки нет вовсе')
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('--user=1000:1000'))
  assert.ok(args.includes('--cap-drop=ALL'))
  assert.ok(args.includes('--security-opt=no-new-privileges'))
  assert.ok(args.includes('--pids-limit=256'))
  assert.ok(args.includes('--memory=4096m'))
  // Swap ровно по памяти: иначе упёршийся контейнер не умирает, а уходит на диск.
  assert.ok(args.includes('--memory-swap=4096m'))
  assert.ok(args.includes('--cpus=2'))
  assert.ok(args.includes(`--ulimit=fsize=${64 * 1024 * 1024 * 4}:${64 * 1024 * 1024 * 4}`))
  // /out — tmpfs: диск контейнера не ограничен ничем, и это главная дыра шага.
  assert.ok(line.includes('--tmpfs=/out:rw,exec,nosuid,nodev,size=512m,mode=1777'))
  assert.ok(line.includes('--tmpfs=/tmp:rw,nosuid,nodev,size=512m'))
  // `--rm` нет намеренно: контейнер нужен мёртвым — прочитать OOMKilled.
  assert.ok(!args.includes('--rm'))
  assert.ok(args.includes('--restart=no'))
  assert.ok(line.includes('colloq.kind=competition-run'))
  assert.equal(args[args.length - 1], '/harness/run_notebook.py')
})

test('в контейнер участника не попадает ни ответов, ни кода метрики', () => {
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
    assert.ok(!mount.includes('/secret'), `закрытая половина не монтируется: ${mount}`)
    assert.ok(!mount.includes(SOLUTION_NAME), `ответы не монтируются: ${mount}`)
    assert.ok(!mount.includes(METRIC_NAME), `код метрики не монтируется: ${mount}`)
  }
  // Данные и тетрадь — только на чтение; пишет посылка в один каталог.
  assert.ok(mounts[0].endsWith(':ro'))
  assert.ok(mounts[1].endsWith(':ro'))
  assert.ok(mounts[2].endsWith(':ro'))
  assert.ok(mounts.every((mount) => mount.endsWith(':ro')))
})

test('команда метрики: секреты внутри, открытые данные и тетрадь — нет', () => {
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
    assert.ok(!mount.includes('/data/competitions/c1/data'), 'открытых данных метрика не видит')
    assert.ok(!mount.includes('/s/s1/out'), 'исполненной тетради участника метрика не видит')
  }
  assert.ok(args.includes('--network none') || args.join(' ').includes('--network none'))
  assert.ok(args.includes('--pids-limit=64'))
  assert.ok(args.includes('--ulimit=fsize=1048576:1048576'))
  assert.ok(args.includes('COMP_PUBLIC_PERCENT=30'))
  assert.ok(args.includes('COMP_SPLIT_SEED=zerno'))
  assert.equal(limits.wallSeconds, METRIC_WALL_SECONDS)
})

test('каждый -v переводится в путь хоста', () => {
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
    // Без перевода `make up` отдал бы посылке пустой каталог, заведённый
    // демоном на лету, — молча, без единой строки в журнале.
    for (const mount of mounts) {
      assert.ok(mount.startsWith('/srv/colloq-data/'), mount)
    }
  } finally {
    if (before === undefined) delete process.env.DATA_HOST_DIR
    else process.env.DATA_HOST_DIR = before
  }
})

test('обвязка раскладывается по хэшу содержимого и не переписывается', () => {
  const dir = harnessDir()
  assert.ok(dir.includes('.harness'), 'каталог обвязки прячется от уборки соревнований')
  for (const name of ['run_notebook.py', 'score_metric.py', 'colloq_metric.py', 'colloq_split.py']) {
    assert.ok(fs.existsSync(path.join(dir, name)), name)
  }
  assert.equal(harnessDir(), dir, 'второй вызов не заводит новый каталог')
})

test('рабочая папка тетради открывает данные по относительному пути data/', () => {
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

test('прогресс считает кодовые ячейки, а ошибка сохраняет причину без ANSI', () => {
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

/* ------------------------------------------------------------ разбор следов */

test('порядок разбора: память старше срока, срок старше слова обвязки', () => {
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
  // Тетрадь дошла до конца, а файла нет: это отказ, а не успех.
  assert.equal(verdictOfRun({ oom: false, killedBy: null, status: 'ok', produced: false }), 'no-submission')
  assert.equal(verdictOfRun({ oom: false, killedBy: null, status: 'ok', produced: true }), 'ok')
  // Убитый за печать — падение тетради; убитый за запись на диск — отказ ответу.
  assert.equal(verdictOfRun({ oom: false, killedBy: 'output', status: 'ok', produced: true }), 'cell_error')
  assert.equal(
    verdictOfRun({ oom: false, killedBy: 'disk', status: 'ok', produced: true }),
    'target_too_large',
  )
  // Чужое слово не пролезает в базу состоянием, которого нет ни в одной плашке.
  assert.equal(verdictOfRun({ oom: false, killedBy: null, status: 'что-то', produced: true }), 'unknown')
  assert.equal(
    verdictOfRun({ oom: false, killedBy: null, status: 'notebook_unreadable', produced: false }),
    'target_unreadable',
  )
})

test('пределы шага считаются от памяти, а не из воздуха', () => {
  const small = limitsFor({ limits: { wallSeconds: 60, memoryMb: 512, cpus: 1, perDay: 0 } } as Competition, 'notebook')
  assert.equal(small.tmpfsMb, 128, 'ниже 128 МБ не опускаемся: туда не влезет ни один ответ')
  const big = limitsFor({ limits: { wallSeconds: 60, memoryMb: 65_536, cpus: 8, perDay: 0 } } as Competition, 'notebook')
  assert.equal(big.tmpfsMb, 2048, 'выше двух гигабайт tmpfs не растёт: он считается в память посылки')
  const metric = limitsFor({ limits: { wallSeconds: 3600, memoryMb: 16_384, cpus: 4, perDay: 0 } } as Competition, 'metric')
  assert.equal(metric.wallSeconds, METRIC_WALL_SECONDS, 'у метрики свой срок, а не срок тетради')
  assert.equal(metric.memoryMb, 2048)
  assert.equal(metric.pids, 64)
})

test('память: не знаем — не мешаем, знаем что нет — не берём', () => {
  assert.equal(enoughMemory(null, 4096), true)
  assert.equal(enoughMemory(8192, 4096), true)
  assert.equal(enoughMemory(4096, 4096), false, 'подушка сверх лимита обязательна')
  assert.equal(enoughMemory(4352, 4096), true)
})

test('имя контейнера не повторяется у повтора той же посылки', () => {
  const first = containerName('s1', 'notebook', 'aaaa')
  const again = containerName('s1', 'notebook', 'bbbb')
  assert.notEqual(first, again)
  assert.ok(first.startsWith('colloq-comp-s1-'))
  assert.ok(containerName('s1', 'metric', 'cccc').endsWith('-score'))
})

test('путь исполнения выбирается переменной, как у ядер', () => {
  assert.equal(competitionBackend({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), 'test')
  assert.equal(competitionBackend({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), 'docker')
  assert.equal(
    competitionBackend({ NODE_ENV: 'production', COMPETITION_BACKEND: 'docker' } as NodeJS.ProcessEnv),
    'docker',
  )
  assert.throws(() => competitionBackend({ NODE_ENV: 'production', COMPETITION_BACKEND: 'test' } as NodeJS.ProcessEnv))
  assert.throws(() => competitionBackend({ NODE_ENV: 'test', COMPETITION_BACKEND: 'broker' } as NodeJS.ProcessEnv))
})

/* ------------------------------------------------- подставной прогонщик */

test('директива разбирается как данные и только как данные', () => {
  const asked = directiveOf(Buffer.from(notebook(['# colloq-test: {"status": "timeout", "cell": 3}\nprint(1)'])))
  assert.deepEqual(asked, { status: 'timeout', cell: 3 })
  // Мусор в директиве не роняет очередь: посылка пойдёт обычным путём.
  assert.deepEqual(directiveOf(Buffer.from(notebook(['# colloq-test: {сломано}']))), {})
  assert.deepEqual(directiveOf(Buffer.from('не json')), {})
  assert.deepEqual(directiveOf(Buffer.from(notebook(['print(1)']))), {})
  assert.equal(cellsOf(Buffer.from(notebook(['a', 'b', 'c']))), 3)
})

test('число подставной метрики устойчиво: одно и то же содержимое — одно число', () => {
  assert.equal(stableScore('x:public', 0.5, 1), stableScore('x:public', 0.5, 1))
  assert.notEqual(stableScore('x:public', 0.5, 1), stableScore('y:public', 0.5, 1))
  const value = stableScore('z', 0.5, 1)
  assert.ok(value >= 0.5 && value <= 1, String(value))
})

/* --------------------------------------------------------- путь посылки */

test('добросовестная посылка доходит до двух чисел', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Аня')
  const submission = send(competition, entrant.id, ['import pandas as pd', 'pd.DataFrame().to_csv("submission.csv")'])

  await drainCompetitionQueue()

  const done = getSubmission(submission.id)
  assert.equal(done?.state, 'scored')
  assert.equal(done?.stage, 'score')
  assert.ok(done?.publicScore !== null && done.privateScore !== null, 'оба числа на месте')
  assert.ok((done?.durationMs ?? 0) >= 0)
  assert.equal(done?.participantError, null)
  assert.equal(queueRow(submission.id), null, 'строка ушла из очереди')

  const runs = listRuns(submission.id)
  assert.deepEqual(runs.map((run) => run.kind), ['notebook', 'metric'])
  assert.equal(runs[0].verdict, 'ok')
  assert.equal(runs[1].verdict, 'ok')
  assert.ok(runs[0].container?.endsWith('-run'))
  assert.ok(runs[1].container?.endsWith('-score'))

  // Ответ сохранён — по нему потом пересчитывают метрику, не запуская тетрадь.
  assert.ok(fs.existsSync(path.join(resultDir(competition.id, submission.id), SUBMISSION_FILE)))
  // А вторая копия ответа, которая жила на время подсчёта, убрана: держать
  // каждый ответ дважды — это гигабайты, которых никто не читает.
  assert.equal(fs.existsSync(scoreDir(competition.id, submission.id)), false)
  assert.equal(fs.existsSync(scoreOutDir(competition.id, submission.id)), false)
})

test('каждый исход называет виноватого правильно', async () => {
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
        assert.ok(text?.includes('5'), 'номер ячейки назван')
        assert.ok(text?.includes('ZeroDivisionError'), 'своя трассировка уезжает участнику дословно')
      },
      teacher: (text) => assert.ok(text?.includes('cell_error')),
    },
    {
      directive: '{"status": "timeout", "cell": 6}',
      state: 'timedOut',
      participant: (text) => assert.ok(text?.includes('10'), 'срок назван числом минут'),
      teacher: (text) => assert.ok(text?.includes('exit 137')),
    },
    {
      directive: '{"status": "out_of_memory", "cell": 2}',
      state: 'outOfMemory',
      participant: (text) => assert.ok(text?.includes('4'), 'предел назван в гигабайтах'),
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
        assert.ok(!text?.includes('{'), 'код заменён фразой на языке инстанса')
      },
      teacher: (text) => assert.equal(text, null),
    },
    {
      directive: '{"metric": "metric_error"}',
      state: 'metricFailed',
      participant: (text) => assert.equal(text, null, 'участник не читает трассировку метрики'),
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

test('упавшая до первой ячейки посылка не тратит норму дня', async () => {
  reset()
  const competition = makeCompetition({ limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 3 } })
  const entrant = mint('Варя')
  const submission = send(competition, entrant.id, ['# colloq-test: {"status": "kernel_died", "cell": -1}'])
  await drainCompetitionQueue()
  const done = getSubmission(submission.id)
  assert.equal(done?.state, 'notebookFailed')
  assert.equal(done?.cellsDone, 0, 'ни одной ячейки не начато — норма цела')
})

/* ------------------------------------------------------------- очередь */

test('очередь честна по людям, а не по времени прихода', async () => {
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
    assert.ok(row, 'работа должна найтись')
    order.push(row.submissionId)
    leaveQueue(row.submissionId)
  }
  // Первая своя — первой; вторая своя встаёт ЗА чужой первой.
  assert.deepEqual(order, [first.id, late.id, second.id, third.id])
})

test('пауза не берёт новых работ и не трогает уже взятую', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Гена')
  const submission = send(competition, entrant.id, ['a'])
  setQueuePaused(true, 'owner')

  assert.equal(await pumpOnce(), 0, 'на паузе насос не берёт ничего')
  assert.equal(getSubmission(submission.id)?.state, 'queued')
  assert.equal(waitingCount(), 1)
  assert.equal(runnerStatus().paused, true)

  setQueuePaused(false)
  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'scored')
})

test('нет памяти — очередь ждёт и ничего не теряет', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Дима')
  const submission = send(competition, entrant.id, ['a'])
  runner.availableMb = 512

  assert.equal(await pumpOnce(), 0, 'посылке нужно 4 ГБ, на машине 512 МБ')
  const waiting = queueRow(submission.id)
  assert.equal(waiting?.state, 'waiting')
  // Попытка не считается: иначе две нехватки памяти объявили бы посылку
  // оборванной, и она пропала бы после перезапуска сервера.
  assert.equal(waiting?.attempts, 0)

  runner.availableMb = 65_536
  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'scored')
})

test('снять можно и ждущую, и идущую; опоздавшая отмена говорит об этом', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Егор')

  const waiting = send(competition, entrant.id, ['a'])
  assert.equal(await cancelSubmission(waiting.id, 'entrant'), true)
  assert.equal(getSubmission(waiting.id)?.state, 'cancelled')
  assert.equal(queueRow(waiting.id), null)

  // Идущую убивает преподаватель: контейнер снимается, посылка не получает
  // «вышло время» за чужое нажатие.
  const running = send(competition, entrant.id, ['# colloq-test: {"hold": 5000}'])
  assert.equal(await pumpOnce(), 1)
  assert.ok(queueRow(running.id)?.container, 'имя контейнера записано до первого ожидания')
  assert.equal(await cancelSubmission(running.id, 'teacher'), true)
  await settleCompetitionWork()
  const killed = getSubmission(running.id)
  assert.equal(killed?.state, 'cancelled')
  assert.ok(killed?.teacherError?.length)

  // Отмена не успела: работы уже нет.
  assert.equal(await cancelSubmission(running.id, 'entrant'), false)
})

test('перезапуск сервера поднимает оборванное, а не хоронит его', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Жора')
  const submission = send(competition, entrant.id, ['a'])

  // Прошлая жизнь процесса взяла работу и умерла вместе с контейнером.
  const row = takeNext({ boot: 'boot-of-a-dead-process' })
  assert.equal(row?.submissionId, submission.id)
  updateSubmission(submission.id, { state: 'running', stage: 'notebook' })

  const first = await reclaimCompetitionQueue()
  assert.equal(first.requeued, 1)
  assert.equal(first.abandoned, 0)
  // Строка посылки тоже вернулась в очередь: иначе участник до конца
  // соревнования смотрел бы на таймер, который не движется.
  assert.equal(getSubmission(submission.id)?.state, 'queued')
  assert.equal(getSubmission(submission.id)?.stage, 'queue')

  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'scored')
})

test('второй обрыв подряд помечает посылку, а не крутит её вечно', async () => {
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
  assert.equal(done?.state, 'metricFailed', 'виноват не участник, и слово называет это')
  assert.ok(done?.teacherError?.includes('перезапуск'))
  assert.equal(queueRow(submission.id), null)
})

/* ------------------------------------------------------------- пересчёт */

test('пересчёт метрики не запускает тетради заново', async () => {
  reset()
  const competition = makeCompetition()
  const anya = mint('Аня-2')
  const boris = mint('Боря-2')
  const first = send(competition, anya.id, ['import pandas'])
  const second = send(competition, boris.id, ['import numpy'])
  await drainCompetitionQueue()

  const before = [getSubmission(first.id), getSubmission(second.id)]
  assert.ok(before.every((s) => s?.state === 'scored'))
  // Разные тетради — разные числа: иначе лидерборд нечем проверять.
  assert.notEqual(before[0]?.publicScore, before[1]?.publicScore)

  const notebookRunsBefore = listRuns(first.id).filter((run) => run.kind === 'notebook').length
  assert.equal(rescoreCompetition(competition.id), 2)
  await drainCompetitionQueue()

  const after = [getSubmission(first.id), getSubmission(second.id)]
  assert.ok(after.every((s) => s?.state === 'scored'))
  assert.equal(
    listRuns(first.id).filter((run) => run.kind === 'notebook').length,
    notebookRunsBefore,
    'тетрадь второй раз не запускалась',
  )
  assert.equal(listRuns(first.id).filter((run) => run.kind === 'metric').length, 2)
  // Число то же: ответ на диске не менялся, и пересчёт обязан это показать.
  assert.equal(after[0]?.publicScore, before[0]?.publicScore)

  const board = leaderboard(competition.id, 'public')
  assert.equal(board.length, 2)
  assert.deepEqual(board.map((row) => row.place), [1, 2])
})

test('повтор исполняет тетрадь заново и снимает прежние числа', async () => {
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

test('пересчитывать нечего у посылки без ответа', async () => {
  reset()
  const competition = makeCompetition()
  const entrant = mint('Клава')
  const submission = send(competition, entrant.id, ['# colloq-test: {"status": "cell_error"}'])
  await drainCompetitionQueue()
  assert.equal(getSubmission(submission.id)?.state, 'notebookFailed')
  assert.equal(rescoreCompetition(competition.id), 0, 'упавшую тетрадь пересчитывать нечем')
})

/* ------------------------------------------------------- места исполнения */

test('мест столько, сколько задано, и не больше', async () => {
  reset()
  const competition = makeCompetition()
  const one = mint('Люда')
  const two = mint('Миша')
  send(competition, one.id, ['# colloq-test: {"hold": 300}'])
  send(competition, two.id, ['# colloq-test: {"hold": 300}'])

  assert.equal(queueSlots(), 1)
  assert.equal(await pumpOnce(), 1, 'одно место — одна работа')
  await settleCompetitionWork()

  setQueueSlots(2)
  assert.equal(queueSlots(), 2)
  await drainCompetitionQueue()
  assert.equal(waitingCount(), 0)
  setQueueSlots(1)
})

/* ---------------------------------------------------- деление строк ответов */

test('контейнер делит строки ровно так же, как это показывает страница', (t) => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  if (python.status !== 0) {
    t.skip('на машине нет python3: деление сверяется только там, где он есть')
    return
  }
  const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR as string, 'split-'))
  fs.writeFileSync(path.join(dir, 'colloq_split.py'), SPLIT_SOURCE)

  const cases = [
    { ids: Array.from({ length: 397 }, (_, i) => String(i + 1)), percent: 30, seed: 'rohlik-2026' },
    { ids: Array.from({ length: 9 }, (_, i) => `row-${i}`), percent: 50, seed: '' },
    // Не латиница и символ вне BMP: JS считает хэш по кодовым единицам UTF-16.
    { ids: ['ёлка', 'мир', '日本', '👋x', 'a', 'b', 'c'], percent: 40, seed: 'семь' },
    // Пробел внутри идентификатора: разделитель зерна обязан быть не пробелом.
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
      `деление разошлось на случае ${index}`,
    )
  })
  assert.equal(fromPython[0].filter((part) => part === 'public').length, 119)
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ сводка */

test('сводка исполнителя отвечает тем, что видит панель', async () => {
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
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
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
    assert not (root / 'executed.ipynb').exists()
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
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
