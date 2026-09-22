/**
 * Настоящий прогонщик: два одноразовых контейнера на одну посылку.
 *
 * Родство с комнатами намеренное. `runArgs()` ниже — это `runArgs()` из
 * kernel/pool.ts, у которого отняли всё, что делает контейнер живым (имя
 * комнаты, публикацию порта, том занятия, GPU, токен Jupyter), и добавили то,
 * что делает его одноразовым: сеть отнята целиком, корень только на чтение,
 * потолок на размер файла. `hardeningArgs()` — дословно `roomHardeningArgs()`
 * из kernel/perimeter.ts, с одним изменением: потолок процессов ниже.
 *
 * ОТЛИЧИЯ ОТ КОМНАТЫ, каждое куплено опытом прототипа, а не рассуждением.
 *
 * 1. `--network none` вместо сети комнат. Комнате нужен pip и датасеты,
 *    посылке — нет, и запрет сетью дешевле и надёжнее правил iptables. Цена
 *    названа участнику на странице соревнования: пакетов, которых нет в
 *    образе, взять неоткуда, а `pip install` без сети уходит в отказ за
 *    пятнадцать секунд его же срока.
 *
 * 2. `--read-only`. Комнате так нельзя — она живёт парами и ставит пакеты
 *    `%pip install` в свой слой (об этом прямо сказано в perimeter.ts).
 *    Посылка живёт минуту и писать должна только в `/out` и `/tmp`.
 *
 * 3. `/out` — tmpfs с жёстким потолком, а не папка хоста. Диск контейнера не
 *    ограничен ничем, и это главная дыра первого шага: тетрадь на десять строк
 *    пишет терабайт. tmpfs решает её ядром — запись сверх потолка даёт ENOSPC
 *    прямо в ячейке, и на диск хоста не попадает ни байта. Цена честная и
 *    названная: tmpfs считается в `--memory` посылки.
 *
 * 4. `/result` — крошечная папка хоста рядом. Нужна потому, что tmpfs умирает
 *    вместе с контейнером: `docker cp` из остановленного его уже не видит
 *    (проверено). Туда ложатся маячок, `run.json`, исполненная тетрадь и копия
 *    ответа, которую обвязка кладёт сама, проверив размер.
 *
 * 5. `--ulimit fsize`. Потолок на ОДИН файл, ядром. Нужен сверх tmpfs как
 *    стенка для того, кто пишет прямо в `/result`.
 *
 * 6. Нет `--rm`. Контейнер нужен мёртвым ещё десяток миллисекунд — прочитать
 *    `State.OOMKilled`. У ОДНОРАЗОВОГО контейнера этот флаг честен, в отличие
 *    от комнаты, где он залипает навсегда и postmortem.ts вынужден считать
 *    убийства счётчиком cgroup: контейнер живёт один раз.
 *
 * И одно правило, купленное дороже всех: монтируются ТОЛЬКО каталоги и только
 * по путям, которых до этой посылки не существовало (см. шапку storage.ts).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { competitionsFs, hostPathOf } from './storage.js'
import { harnessDir } from './harness.js'
import {
  METRIC_WALL_SECONDS,
  registerCompetitionRunner,
  type Capacity,
  type CompetitionRunner,
  type RunDiagnostics,
  type RunOutcome,
  type RunProgress,
  type RunRequest,
  type ScoreOutcome,
  type ScoreRequest,
  type StepLimits,
} from './runner-port.js'
import { machineResources } from '../kernel/resources.js'
import type { RunVerdict } from '@shared/competitions'

/** Метка на обоих контейнерах: по ней их находит уборка, и только их. */
export const RUN_LABEL = 'colloq.kind=competition-run'
export const SCORE_LABEL = 'colloq.kind=competition-score'

/** Образ — тот же, в котором идёт занятие: одно окружение у задачи и у решения. */
const IMAGE_PREFIX = 'colloq-kernel'

/** Как часто смотреть на идущий контейнер. Четверть секунды — как в прототипе. */
const POLL_MS = 250

/** Имена файлов, которые обвязка кладёт в `/result`. */
const PROGRESS_FILE = 'progress.json'
const RUN_FILE = 'run.json'
const SCORE_FILE = 'score.json'

interface Shell {
  (args: string[], timeoutMs?: number): Promise<{ code: number; out: string }>
}

/**
 * Позвать docker.
 *
 * Своя копия, а не `dockerRead` из pool.ts, ровно по одной причине: у той
 * короткий срок на чтение, а здесь бывает `docker run` тяжёлого образа. Форма
 * та же — spawn массивом, без шелла, без кавычек.
 */
const shell: Shell = (args, timeoutMs = 60_000) =>
  new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', (err) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: code ?? -1, out: out.trim() })
    })
  })

let docker: Shell = shell

/**
 * Подменить docker — тестам аргументов и вскрытия.
 *
 * Тот же приём, что `useDockerForLimits` (pool.ts) и `useDockerForPostmortem`:
 * настоящего docker в сюите нет, а проверять надо ровно то, что бывает только
 * с ним. Этим подменяется ВЫЗОВ, а не прогонщик целиком: тест сборки команды
 * не должен зависеть от того, есть ли на машине образ.
 */
export function useDockerForCompetitions(fake: Shell | null): void {
  docker = fake ?? shell
}

/* ------------------------------------------------------- сборка аргументов */

/**
 * Укреплённый профиль — дословно `roomHardeningArgs`, с одной правкой.
 *
 * 256 процессов вместо комнатных 512: в посылке живёт один python и его
 * потоки, а не Jupyter с терминалом и `DataLoader(num_workers=8)` разом.
 * Форк-бомба упирается в стенку вдвое раньше, а `DataLoader` этого не
 * замечает (замер прототипа: 88 потомков, пик 829 МБ, контейнер выжил).
 */
function hardeningArgs(pids: number): string[] {
  return [
    '--user=1000:1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--pids-limit=${pids}`,
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
  ]
}

/**
 * Сколько потоков разрешить численным библиотекам.
 *
 * То же правило, что в pool.ts · threadLimit, и по той же причине:
 * `os.cpu_count()` внутри контейнера показывает ядра ХОСТА, и numpy поднимет
 * тридцать потоков на два выданных ядра.
 */
function threads(cpus: number): string {
  return String(Math.max(1, Math.floor(Number.isFinite(cpus) && cpus > 0 ? cpus : 2)))
}

/**
 * Каждый `-v` проходит через `hostPathOf` — обязательно и без исключений.
 *
 * Под `make run` это тождество. Под `make up` сервер сам в контейнере, и путь,
 * по которому файл видит он, демону docker не известен: тот заведёт по нему
 * пустой каталог на лету, и посылка МОЛЧА не увидит ни данных, ни своей
 * тетради — ни ошибки, ни строки в журнале.
 */
function mount(inside: string, at: string, readOnly = false): string[] {
  return ['-v', `${hostPathOf(inside)}:${at}${readOnly ? ':ro' : ''}`]
}

/**
 * Аргументы `docker run` для контейнера ТЕТРАДИ.
 *
 * Отдельной чистой функцией, потому что настоящего docker в тестах нет, а
 * собрать эту строку правильно важнее, чем её позвать: потерянный `--network
 * none` здесь — это посылка с интернетом, и заметить это можно только тогда,
 * когда кто-то им воспользуется.
 */
export function runArgs(opts: {
  container: string
  image: string
  dataDir: string
  inputDir: string
  resultDir: string
  dependenciesDir?: string
  limits: StepLimits
  target: string
}): string[] {
  const { container, limits } = opts
  const t = threads(limits.cpus)
  const memory = `${limits.memoryMb}m`
  return [
    'run',
    '-d',
    '--name',
    container,
    // Сети нет вовсе: ни DNS, ни петли, ни моста. Соревнование — это обучение
    // на выданных данных, а не поход за ответами наружу.
    '--network',
    'none',
    ...hardeningArgs(limits.pids),
    '--read-only',
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.tmpfsMb}m,mode=1777`,
    // Рабочая папка тетради — tmpfs с жёстким потолком: диска хоста в ней нет
    // ни байта.
    `--tmpfs=/out:rw,exec,nosuid,nodev,size=${limits.tmpfsMb}m,mode=1777`,
    // HOME внутри tmpfs, и папки в нём заводит обвязка: `--tmpfs` создаёт
    // только точку монтирования, а IPython, не найдя HOME, печатает
    // предупреждение в КАЖДУЮ посылку.
    '-e',
    'HOME=/tmp/home',
    '-e',
    'JUPYTER_RUNTIME_DIR=/tmp/home/runtime',
    '-e',
    'JUPYTER_DATA_DIR=/tmp/home/data',
    '-e',
    'MPLCONFIGDIR=/tmp/home/mpl',
    '-e',
    'MPLBACKEND=Agg',
    '-e',
    `OMP_NUM_THREADS=${t}`,
    '-e',
    `MKL_NUM_THREADS=${t}`,
    '-e',
    `OPENBLAS_NUM_THREADS=${t}`,
    '-e',
    `NUMEXPR_NUM_THREADS=${t}`,
    '-e',
    'PYTHONUNBUFFERED=1',
    '-e',
    'PYTHONDONTWRITEBYTECODE=1',
    '-e',
    `COMP_TARGET=${opts.target}`,
    '-e',
    `COMP_MAX_OUTPUT_BYTES=${limits.outputBytes}`,
    '-e',
    `COMP_MAX_TARGET_BYTES=${limits.targetBytes}`,
    /*
     * Потолок ОДНОЙ ячейки — ради понятного текста, а не ради гарантии.
     * Прототип показал, что он крепче ожидаемого (срабатывает и на `while
     * True`, и на SVD в си, и на ячейке, игнорирующей SIGINT), но про ОБЩИЙ
     * срок он не знает: тетрадь из пятидесяти ячеек по три секунды проходит
     * мимо него насквозь. Поэтому он равен общему сроку, а настоящий убийца —
     * снаружи.
     */
    '-e',
    `COMP_CELL_TIMEOUT_SEC=${limits.wallSeconds}`,
    // Открытая половина данных. solution.csv здесь не появляется никогда — он
    // лежит в закрытом каталоге, который этому контейнеру не смонтирован.
    ...mount(opts.dataDir, '/data', true),
    // Каталог, а не файл: внутри одна тетрадь и больше ничего.
    ...mount(opts.inputDir, '/submission', true),
    ...mount(harnessDir(), '/harness', true),
    // Единственное место, где посылка касается диска хоста.
    ...mount(opts.resultDir, '/result'),
    ...(opts.dependenciesDir ? [...mount(opts.dependenciesDir, '/deps', true), '-e', 'COMP_DEPENDENCIES=/deps'] : []),
    `--memory=${memory}`,
    // Swap ровно по памяти — иначе упёршийся контейнер не умирает, а уходит на
    // диск и стоит минутами (та же причина, что в pool.ts).
    `--memory-swap=${memory}`,
    `--cpus=${limits.cpus}`,
    `--ulimit=fsize=${limits.fsizeBytes}:${limits.fsizeBytes}`,
    '--restart=no',
    '--label',
    RUN_LABEL,
    '-w',
    '/out',
    '--entrypoint',
    'python',
    opts.image,
    '/harness/run_notebook.py',
  ]
}

/**
 * Аргументы `docker run` для контейнера МЕТРИКИ.
 *
 * Участника в нём нет: приезжает один его файл, только на чтение. Открытые
 * данные и исполненная тетрадь сюда не попадают — код преподавателя
 * исполняется рядом с ответами, и всё, что туда положено, может уехать в текст
 * его ошибки.
 */
export function scoreArgs(opts: {
  container: string
  image: string
  secretDir: string
  submissionDir: string
  outDir: string
  limits: StepLimits
  solutionFile: string
  metricFile: string
  idColumn: string
  publicPercent: number
  splitSeed: string
}): string[] {
  const { container, limits } = opts
  const t = threads(limits.cpus)
  const memory = `${limits.memoryMb}m`
  return [
    'run',
    '-d',
    '--name',
    container,
    '--network',
    'none',
    ...hardeningArgs(limits.pids),
    '--read-only',
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.tmpfsMb}m,mode=1777`,
    '-e',
    'HOME=/tmp/home',
    '-e',
    'MPLCONFIGDIR=/tmp/home/mpl',
    '-e',
    `OMP_NUM_THREADS=${t}`,
    '-e',
    `MKL_NUM_THREADS=${t}`,
    '-e',
    `OPENBLAS_NUM_THREADS=${t}`,
    '-e',
    `NUMEXPR_NUM_THREADS=${t}`,
    '-e',
    'PYTHONUNBUFFERED=1',
    '-e',
    'PYTHONDONTWRITEBYTECODE=1',
    '-e',
    `COMP_SOLUTION=/secret/${opts.solutionFile}`,
    '-e',
    `COMP_METRIC=/secret/${opts.metricFile}`,
    '-e',
    `COMP_ID_COLUMN=${opts.idColumn}`,
    '-e',
    `COMP_PUBLIC_PERCENT=${opts.publicPercent}`,
    '-e',
    `COMP_SPLIT_SEED=${opts.splitSeed}`,
    // Закрытая половина соревнования и один файл участника. Ни один из них не
    // был и не будет виден контейнеру тетради.
    ...mount(opts.secretDir, '/secret', true),
    ...mount(opts.submissionDir, '/submission', true),
    ...mount(harnessDir(), '/harness', true),
    ...mount(opts.outDir, '/out'),
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    `--cpus=${limits.cpus}`,
    `--ulimit=fsize=${limits.fsizeBytes}:${limits.fsizeBytes}`,
    '--restart=no',
    '--label',
    SCORE_LABEL,
    '-w',
    '/out',
    '--entrypoint',
    'python',
    opts.image,
    '/harness/score_metric.py',
  ]
}

/* ---------------------------------------------------------------- присмотр */

/** Что вернул присмотр за идущим контейнером. */
interface Watched {
  killedBy: 'wall' | 'output' | 'disk' | null
  progress: RunProgress | null
}

const INSPECT = '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}'

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = competitionsFs.readFileSync(file) as Buffer
    const value: unknown = JSON.parse(raw.toString('utf8'))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Присмотр за идущим контейнером: срок, печать и то, что он пишет на диск.
 *
 * Внутренний таймер на это не годится вовсе. Ячейка, ушедшая в сишный цикл,
 * держит GIL, и ни один питоновский будильник внутри не сработает; `--ulimit
 * fsize` ловит один файл, а не сотню файлов по гигабайту. Снаружи от
 * контейнера не спрячешься: `docker kill` — это SIGKILL от ядра хоста.
 *
 * Сторож по размеру каталога — ЗАПАСНАЯ стенка, а не основная. Прототип
 * намерил перелёт втрое: при опросе раз в четверть секунды тетрадь успела
 * написать 360 МБ при потолке в 128. Основная стенка — tmpfs и `--ulimit`,
 * которые держит ядро.
 */
async function watch(
  container: string,
  resultDir: string,
  limits: StepLimits,
  onProgress?: (progress: RunProgress) => void,
): Promise<Watched> {
  const deadline = Date.now() + limits.wallSeconds * 1000
  const diskCeiling = limits.targetBytes * 2
  let last: RunProgress | null = null
  for (;;) {
    const alive = await docker(['inspect', container, '--format', '{{.State.Running}}'], 20_000)
    if (alive.code !== 0 || alive.out.trim() !== 'true') return { killedBy: null, progress: last }

    const beat = readJson(path.join(resultDir, PROGRESS_FILE))
    if (beat) {
      const progress: RunProgress = {
        phase: beat.phase === 'dependencies' ? 'dependencies' : 'notebook',
        cell: num(beat.cell) ?? -1,
        cells: num(beat.cells) ?? 0,
        outputBytes: num(beat.outputBytes) ?? 0,
      }
      if (
        !last ||
        last.phase !== progress.phase ||
        last.cell !== progress.cell ||
        last.cells !== progress.cells ||
        last.outputBytes !== progress.outputBytes
      ) {
        last = progress
        onProgress?.(progress)
      }
    }

    if (Date.now() > deadline) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'wall', progress: last }
    }
    /*
     * Печать читается из маячка, а не из контейнера: подрезанные выводы в
     * память не попадают, но время и процессор тетрадь на них тратит, и восемь
     * гигабайт печати — это тридцать секунд чужой очереди.
     */
    if (limits.outputKillBytes > 0 && (last?.outputBytes ?? 0) > limits.outputKillBytes) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'output', progress: last }
    }
    if (dirBytes(resultDir) > diskCeiling) {
      await docker(['kill', '--signal=KILL', container], 30_000)
      return { killedBy: 'disk', progress: last }
    }
    await sleep(POLL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Сколько весит то, что контейнер написал в смонтированный каталог хоста. */
function dirBytes(dir: string): number {
  let total = 0
  let names: string[]
  try {
    names = competitionsFs.readdirSync(dir) as string[]
  } catch {
    return 0
  }
  for (const name of names) {
    try {
      total += competitionsFs.statSync(path.join(dir, name)).size
    } catch {
      /* исчез между readdir и stat — значит, не весит ничего */
    }
  }
  return total
}

/** Вскрытие остановленного контейнера — ДО того, как его снимут. */
async function postmortem(container: string): Promise<{ exit: number | null; oom: boolean; tail: string }> {
  const state = await docker(['inspect', container, '--format', INSPECT], 20_000)
  let exit: number | null = null
  let oom = false
  if (state.code === 0) {
    const parts = state.out.trim().split(/\s+/)
    const code = Number(parts[1])
    exit = Number.isFinite(code) ? code : null
    oom = parts[2] === 'true'
  }
  const logs = await docker(['logs', '--tail', '40', container], 20_000)
  return { exit, oom, tail: logs.out.slice(-4000) }
}

/**
 * Во что превращается всё увиденное.
 *
 * Порядок здесь и есть ответ, и он тот же, что у прототипа (`drive.py`
 * · verdict_of). Убийство по памяти и по сроку старше всего, что успела
 * записать обвязка: её `run.json` мог остаться от предыдущей ячейки. «Тетрадь
 * исполнилась, а файла нет» идёт ПЕРЕД её статусом — иначе посылка с пустыми
 * руками считалась бы удавшейся и уходила бы в метрику ни с чем.
 *
 * Два убийства снаружи названы словами участника, а не нашими. Печать сверх
 * потолка — это падение его тетради (`cell_error`, «ОШИБКА В ТЕТРАДИ»), и
 * рядом лежит фраза о том, сколько она напечатала. Запись сверх потолка в
 * каталог хоста — это «ответ не принят» (`target_too_large`), потому что
 * ровно это и случилось.
 */
export function verdictOfRun(input: {
  oom: boolean
  killedBy: 'wall' | 'output' | 'disk' | null
  status: string | null
  produced: boolean
}): RunVerdict {
  if (input.oom) return 'out-of-memory'
  if (input.killedBy === 'wall') return 'timeout'
  if (input.killedBy === 'output') return 'cell_error'
  if (input.killedBy === 'disk') return 'target_too_large'
  const status = input.status
  if (status && status !== 'ok') return asVerdict(status)
  if (!input.produced) return 'no-submission'
  return status ? asVerdict(status) : 'unknown'
}

/**
 * Слово обвязки — только если оно нам известно.
 *
 * Обвязка и типы правятся в разных файлах, и чужое слово, пропущенное дальше
 * как есть, легло бы в базу состоянием, которого нет ни в одной плашке.
 */
const VERDICTS = new Set<string>([
  'ok',
  'cell_error',
  'cell_timeout',
  'kernel_died',
  'exit',
  'target_too_large',
  'target_unreadable',
  'harness_error',
  'dependency_error',
  'no-submission',
  'out-of-memory',
  'timeout',
  'participant_error',
  'metric_error',
])

function asVerdict(status: string): RunVerdict {
  // Тетрадь, которую не прочёл nbformat, — отказ участнику, а не падение
  // обвязки: файл прислал он.
  if (status === 'notebook_unreadable') return 'target_unreadable'
  return VERDICTS.has(status) ? (status as RunVerdict) : 'unknown'
}

/* ---------------------------------------------------------------- прогонщик */

class DockerCompetitionRunner implements CompetitionRunner {
  readonly backend = 'docker' as const

  async run(request: RunRequest): Promise<RunOutcome> {
    const started = Date.now()
    const image = request.imageDigest ?? `${IMAGE_PREFIX}:${request.competition.environment || 'base'}`
    const args = runArgs({
      container: request.container,
      image,
      dataDir: request.dataDir,
      inputDir: request.inputDir,
      resultDir: request.resultDir,
      dependenciesDir: request.dependenciesDir,
      limits: request.limits,
      target: SUBMISSION_NAME,
    })
    const started_ = await docker(args, 120_000)
    if (started_.code !== 0) {
      return {
        status: 'harness_error',
        cell: -1,
        cells: 0,
        wall: Date.now() - started,
        submission: null,
        detail: '',
        log: started_.out,
        diagnostics: { exit: null, oomKilled: false, backend: this.backend },
      }
    }
    let watched: Watched = { killedBy: null, progress: null }
    let dead = { exit: null as number | null, oom: false, tail: '' }
    try {
      watched = await watch(request.container, request.resultDir, request.limits, request.onProgress)
      dead = await postmortem(request.container)
    } finally {
      // Контейнер снимается ВСЕГДА и только после вскрытия: `--rm` отнял бы у
      // нас флаг OOM, а забытый контейнер — это гигабайты на машине, где идёт
      // занятие.
      await docker(['rm', '-f', request.container], 60_000)
    }
    const report = readJson(path.join(request.resultDir, RUN_FILE))
    const answer = path.join(request.resultDir, SUBMISSION_NAME)
    const produced = competitionsFs.existsSync(answer)
    const status = typeof report?.status === 'string' ? report.status : null
    const verdict = verdictOfRun({ oom: dead.oom, killedBy: watched.killedBy, status, produced })
    const beat = watched.progress
    return {
      status: verdict,
      cell: num(report?.cell) ?? beat?.cell ?? -1,
      cells: num(report?.cells) ?? beat?.cells ?? 0,
      wall: Date.now() - started,
      submission: verdict === 'ok' && produced ? answer : null,
      detail: typeof report?.detail === 'string' ? report.detail : '',
      log: dead.tail,
      diagnostics: {
        exit: dead.exit,
        oomKilled: dead.oom,
        backend: this.backend,
        killedBy: watched.killedBy ?? undefined,
        peakBytes: num(report?.peakBytes),
      },
    }
  }

  async score(request: ScoreRequest): Promise<ScoreOutcome> {
    const started = Date.now()
    const image = request.imageDigest ?? `${IMAGE_PREFIX}:${request.competition.environment || 'base'}`
    const args = scoreArgs({
      container: request.container,
      image,
      secretDir: request.secretDir,
      submissionDir: request.submissionDir,
      outDir: request.outDir,
      limits: request.limits,
      solutionFile: SOLUTION_NAME,
      metricFile: METRIC_NAME,
      idColumn: DEFAULT_ID_COLUMN,
      publicPercent: request.competition.publicPercent,
      splitSeed: request.competition.splitSeed,
    })
    const launched = await docker(args, 120_000)
    if (launched.code !== 0) {
      return metricFailure(this.backend, launched.out, Date.now() - started, null, false)
    }
    let watched: Watched = { killedBy: null, progress: null }
    let dead = { exit: null as number | null, oom: false, tail: '' }
    try {
      watched = await watch(request.container, request.outDir, request.limits)
      dead = await postmortem(request.container)
    } finally {
      await docker(['rm', '-f', request.container], 60_000)
    }
    const wall = Date.now() - started
    /*
     * Метрику убили снаружи или по памяти — это упавший код ПРЕПОДАВАТЕЛЯ, а
     * не участника, и назвать это «вышло время» значило бы поставить ему
     * плашку за чужую ошибку: `stateOfVerdict` разбирает `timeout` и
     * `out-of-memory` раньше, чем вид прогона.
     */
    if (dead.oom) {
      return metricFailure(this.backend, `metric container out of memory\n${dead.tail}`, wall, dead.exit, true)
    }
    if (watched.killedBy !== null) {
      return metricFailure(
        this.backend,
        `metric container killed after ${METRIC_WALL_SECONDS}s (${watched.killedBy})\n${dead.tail}`,
        wall,
        dead.exit,
        false,
      )
    }
    const report = readJson(path.join(request.outDir, SCORE_FILE))
    if (!report) {
      return metricFailure(this.backend, `no ${SCORE_FILE}\n${dead.tail}`, wall, dead.exit, false)
    }
    const status = typeof report.status === 'string' ? asVerdict(report.status) : 'metric_error'
    return {
      status,
      public: num(report.public),
      private: num(report.private),
      message: participantText(report),
      teacherOnly: typeof report.teacherOnly === 'string' ? report.teacherOnly : null,
      wall,
      diagnostics: { exit: dead.exit, oomKilled: dead.oom, backend: this.backend },
    }
  }

  async kill(container: string): Promise<void> {
    await docker(['kill', '--signal=KILL', container], 30_000)
  }

  /**
   * Подмести за прошлой жизнью процесса.
   *
   * Только по СВОИМ меткам: на машине преподавателя рядом стоят контейнеры
   * комнат и личных тетрадей, и снести чужое здесь значило бы погасить идущее
   * занятие. Помеченные `competition-run`/`competition-score` контейнеры
   * заведены только этим модулем и живут только на время одной посылки, так
   * что любой найденный после старта — уже осиротевший.
   */
  async sweep(): Promise<number> {
    let dropped = 0
    for (const label of [RUN_LABEL, SCORE_LABEL]) {
      const found = await docker(['ps', '-aq', '--filter', `label=${label}`], 20_000)
      if (found.code !== 0) continue
      for (const id of found.out.split('\n').map((line) => line.trim()).filter(Boolean)) {
        const gone = await docker(['rm', '-f', id], 60_000)
        if (gone.code === 0) dropped++
      }
    }
    return dropped
  }

  /**
   * Сколько памяти на машине ещё можно раздать.
   *
   * Спрашивается у того же модуля, что и форма семинара (kernel/resources.ts):
   * потолок держит ВИРТУАЛКА докера, а не Мак, и на colima это двенадцать
   * гигабайт при тридцати шести у машины. Считать по хосту значило бы брать в
   * работу посылку, которой `docker run` откажет посреди пары.
   */
  async capacity(): Promise<Capacity> {
    try {
      const machine = await machineResources()
      return { availableMb: machine.memory.availableMb }
    } catch {
      return { availableMb: null }
    }
  }
}

/** Текст, который участник читает дословно, — и только он. */
function participantText(report: Record<string, unknown>): string | null {
  if (typeof report.message === 'string' && report.message) return report.message
  // Наша собственная проверка приезжает кодом: перевод живёт в shared/locales,
  // а контейнер о языке инстанса не знает (см. harness.ts · align).
  if (typeof report.code === 'string' && report.code) {
    return JSON.stringify({ code: report.code, params: report.params ?? {} })
  }
  return null
}

function metricFailure(
  backend: 'docker',
  teacherOnly: string,
  wall: number,
  exit: number | null,
  oom: boolean,
): ScoreOutcome {
  return {
    status: 'metric_error',
    public: null,
    private: null,
    message: null,
    teacherOnly,
    wall,
    diagnostics: { exit, oomKilled: oom, backend },
  }
}

/** Имена внутри закрытого каталога и в `/result` — одни на прогонщик и хранилище. */
export const SUBMISSION_NAME = 'submission.csv'
export const SOLUTION_NAME = 'solution.csv'
export const METRIC_NAME = 'metric.py'

/**
 * Какая колонка склеивает ответ с ответами.
 *
 * Поля в редакторе соревнования (A2) для неё пока нет, и умолчание здесь —
 * то же, что у Kaggle и у прототипа. Когда поле появится, оно придёт сюда
 * через `Competition`, а не через вторую переменную окружения.
 */
export const DEFAULT_ID_COLUMN = 'id'

registerCompetitionRunner('docker', () => new DockerCompetitionRunner())
