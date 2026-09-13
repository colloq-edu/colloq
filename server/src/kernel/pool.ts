import { tr } from '@shared/i18n'
import { kernelBackend, requireKernelIsolation, kernelRuntimeClient, runtimeEnvironment, imageRevision } from './runtime-client.js'
import { sessionCpus, sessionEnvironment, sessionKernelRevision, pinSessionKernelRevision, sessionMemoryMb, sessionRowExists } from '../db.js'
import { blockKernelStarts, kernelRetirementInProgress } from './retirement.js'
/** Production starts fixed, isolated Pods through the private runtime broker.
 * The direct Docker adapter is retained only for explicit local development.
 * Neither backend falls back to a shared Jupyter server. */
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { activeName, needsGpu } from '../environments.js'
import { sessionDir } from '../workspace.js'
import { defaultEndpoint, type KernelEndpoint } from './jupyter.js'

const IMAGE_PREFIX = 'colloq-kernel'
const ROOM_PREFIX = 'colloq-room'

interface RunResult {
  code: number
  out: string
}

function run(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: code ?? -1, out: out.trim() })
    })
  })
}

/**
 * Токен Jupyter для одной комнаты.
 *
 * Выводится из секрета инстанса, а не выдаётся случайно: контейнер переживает
 * перезапуск сервера, и случайный токен пришлось бы где-то хранить — либо
 * терять вместе с доступом к живому ядру посреди пары. Разный у разных комнат,
 * так что ячейка, прочитавшая свой `JUPYTER_TOKEN`, не открывает соседние.
 */
function roomToken(sessionId: string): string {
  return createHmac('sha256', config.sessionSecret)
    .update(`jupyter:${sessionId}`)
    .digest('hex')
    .slice(0, 40)
}

const containerFor = (sessionId: string) => `${ROOM_PREFIX}-${sessionId}`

/**
 * Кому сказать, что контейнер комнаты пришлось пересоздать.
 *
 * Пересоздание — это новый Python: переменные семинара, открытый терминал и
 * всё, что ядро успело посчитать, остаются в снесённом контейнере. Молча этого
 * делать нельзя, а звать `kernelNote` отсюда некому: kernel/index.ts зависит от
 * пула, не наоборот. Поэтому пул объявляет, а слушателя ставит тот, у кого есть
 * документ комнаты.
 */
type RecreateListener = (sessionId: string, why: string) => void
const recreateListeners: RecreateListener[] = []

export function onRoomKernelRecreated(cb: RecreateListener): void {
  recreateListeners.push(cb)
}

function announceRecreate(sessionId: string, why: string): void {
  for (const cb of [...recreateListeners]) {
    try {
      cb(sessionId, why)
    } catch (err) {
      console.error(`[kernel] слушатель пересоздания упал для ${sessionId}:`, err)
    }
  }
}

/** The host port Docker gave a container, read back after it started. */
async function publishedPort(container: string): Promise<number | null> {
  const res = await run(['port', container, '8888/tcp'])
  if (res.code !== 0) return null
  // "0.0.0.0:54321" or "[::]:54321\n0.0.0.0:54321"
  const match = res.out.match(/:(\d+)\s*$/m)
  const port = match ? Number(match[1]) : NaN
  return Number.isFinite(port) ? port : null
}

/**
 * Состояние контейнера комнаты — тремя ответами, а не двумя.
 *
 * «Не running» — это ещё не «остановлен»: `dead` (docker не смог его добить,
 * обычно из-за места на диске), `paused` и `restarting` командой `docker start`
 * не поднимаются. Считая их остановленными, сервер звал `start`, не смотрел на
 * результат, не находил порт — и отвечал «could not read the published port» на
 * каждый Run до конца пары. Такой контейнер надо пересоздавать, а не будить.
 */
async function stateOf(container: string): Promise<'running' | 'stopped' | 'broken' | 'missing'> {
  const res = await run(['inspect', container, '--format', '{{.State.Status}}'])
  if (res.code !== 0) return 'missing'
  const status = res.out.trim()
  if (status === 'running') return 'running'
  return status === 'created' || status === 'exited' ? 'stopped' : 'broken'
}

async function imageExists(image: string): Promise<boolean> {
  const res = await run(['image', 'inspect', image, '--format', '{{.Id}}'])
  return res.code === 0
}

/** Whether a container was created from the image this environment now has. */
async function sameImage(container: string, image: string): Promise<boolean> {
  const [running, current] = await Promise.all([
    run(['inspect', container, '--format', '{{.Image}}']),
    run(['image', 'inspect', image, '--format', '{{.Id}}']),
  ])
  if (running.code !== 0 || current.code !== 0) return true
  return running.out.trim() === current.out.trim()
}

/**
 * Имена, которыми docker зовёт «сеть по умолчанию», когда `--network` не давали.
 *
 * Их не одно. Docker 20 писал в `HostConfig.NetworkMode` слово `default`, а
 * Docker 24+ пишет настоящее имя сети — `bridge`. Сравнение с одним только
 * `default` на современном демоне не сходилось НИКОГДА: каждый первый Run
 * после перезапуска сервера в хостовом режиме объявлял «сервер сменил сеть»,
 * сносил контейнер комнаты со всеми её переменными и поднимал пустой — молча,
 * посреди пары, ровно вопреки тому, ради чего написан `shutdownKernels`.
 */
const BARE_NETWORKS = new Set(['default', 'bridge'])

/**
 * Сходится ли строка режима сети с той, в которой мы теперь ищем контейнер.
 *
 * Чистая функция, потому что доказывать надо именно это правило, а настоящего
 * docker в тестах нет.
 */
export function networkMatches(mode: string, network: string): boolean {
  const actual = mode.trim()
  if (!network) return BARE_NETWORKS.has(actual)
  return actual === network
}

/**
 * В той ли сети контейнер, в которой мы теперь его ищем.
 *
 * Инстанс, переехавший с `make run` на `make up` (или обратно), находит по
 * имени контейнер прошлого режима: с опубликованным портом и без нашей сети —
 * или наоборот. Дороги до него в новом режиме нет, и комната ждала бы ответа
 * девяносто секунд на каждый Run; пересоздать дешевле.
 *
 * Строка режима — только первый, дешёвый вопрос. Не сошлась — спрашиваем то,
 * что нас на самом деле волнует: есть ли до контейнера дорога в НАШЕМ режиме.
 * В хостовом это опубликованный порт, в сетевом — членство в нашей сети. Так
 * очередное имя, которое придумает следующая версия docker, будет стоить один
 * лишний вызов, а не потерянные переменные семинара.
 */
async function sameNetwork(container: string, network: string): Promise<boolean> {
  const res = await run(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}'])
  if (res.code !== 0) return true
  if (networkMatches(res.out.trim(), network)) return true
  if (!network) return (await publishedPort(container)) !== null
  const joined = await run([
    'inspect',
    container,
    '--format',
    '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}',
  ])
  if (joined.code !== 0) return false
  return joined.out.trim().split(/\s+/).includes(network)
}

/**
 * Есть ли вообще docker у этого процесса.
 *
 * Считается один раз: под `make up` сервер сам живёт в контейнере без сокета, и
 * шелл-аут на каждую комнату был бы двадцатью бесполезными процессами за пару.
 */
let dockerReady: Promise<boolean> | null = null

function haveDocker(): Promise<boolean> {
  if (kernelBackend() !== 'docker') return Promise.resolve(false)
  dockerReady ??= run(['version', '--format', '{{.Server.Version}}'], 5_000).then((res) => {
    const ok = res.code === 0
    if (!ok) {
      console.warn('[kernel] Docker is unavailable. Isolated room execution is disabled until the development runtime is restored.')
    }
    return ok
  })
  return dockerReady
}

/** Сказано один раз: повторять это на каждый Run незачем. */
let networkWarned = false

function warnOnce(text: string): void {
  if (networkWarned) return
  networkWarned = true
  console.warn(text)
}

/** Есть ли названная сеть; спрашивается один раз, за пару она не появляется. */
let networkReady: Promise<boolean> | null = null

function networkExists(network: string): Promise<boolean> {
  networkReady ??= run(['network', 'inspect', network, '--format', '{{.Id}}'], 5_000).then(
    (res) => res.code === 0,
  )
  return networkReady
}

/** Check the selected runtime; an unavailable backend disables execution. */
async function canIsolate(): Promise<boolean> {
  try { requireKernelIsolation() } catch { return false }
  if (kernelBackend() === 'broker') return (await kernelRuntimeClient().health()).ok
  if (kernelBackend() === 'test') return false
  if (!(await haveDocker())) return false
  if (!inContainer()) return true

  const network = roomNetwork()
  if (!network) {
    warnOnce(
      '[kernel] KERNEL_NETWORK is missing. Isolated room execution is disabled.',
    )
    return false
  }
  if (!(await networkExists(network))) {
    warnOnce(`[kernel] Network ${network} is unavailable. Isolated room execution is disabled.`)
    return false
  }
  return true
}

/** Правда ли у этой комнаты свой контейнер — панели, чтобы не обещать лишнего. */
export function isolationAvailable(): Promise<boolean> {
  return canIsolate()
}

/**
 * Комнаты, чьи контейнеры сейчас живут на этой машине, — по метке docker.
 *
 * Не то же самое, что `runningRoomKernels()`: та карта заполняется только
 * подъёмами ЭТОГО процесса, так что после перезапуска сервера контейнеры
 * вчерашних семинаров переставали существовать для уборки простоя и жили до
 * `make down`. Метку ставит `docker run` ниже, и она переживает нас.
 */
export async function listRoomKernels(): Promise<Array<{ session: string; running: boolean }>> {
  if (kernelBackend() === 'broker') return (await kernelRuntimeClient().rooms()).map(room => ({session:room.sessionId,running:room.phase === 'ready' || room.phase === 'pending'}))
  if (kernelBackend() === 'test') return []
  const rooms = await roomContainers()
  return rooms
    .filter((room) => room.session.length > 0)
    .map((room) => ({ session: room.session, running: room.running }))
}

/** Комната и срез, который держит её контейнер; срез пустой — комната без GPU. */
interface RoomContainer {
  session: string
  gpu: string
  /**
   * Живой ли контейнер прямо сейчас.
   *
   * Уборке простоя это нужно знать, а не только «есть ли он»: остановленный
   * контейнер (`--restart=no` плюс перезагрузка машины — и таких все) для
   * `docker ps` без `-a` не существует вовсе, так что до сих пор он не попадал
   * в уборку никогда и держал свой срез GPU до `make down`.
   */
  running: boolean
}

/**
 * Контейнеры комнат вместе с их метками — и живые, и остановленные.
 *
 * `docker ps -a`, всегда. Для раздачи срезов только так и правильно:
 * остановленный контейнер свой срез держит, его поднимут обратно `docker start`
 * с теми же переменными и тем же устройством. Уборка простоя раньше спрашивала
 * без `-a` и ровно поэтому не видела ни одного остановленного контейнера: после
 * перезагрузки машины (`--restart=no`) такими становятся ВСЕ, срезы GPU
 * оставались за комнатами, которых больше никто не откроет, и новый семинар
 * слышал «свободных срезов нет». Кто живой, а кто нет, сказано полем `running`.
 */
async function roomContainers(): Promise<RoomContainer[]> {
  if (!(await canIsolate())) return []
  const res = await run([
    'ps',
    '-a',
    '--filter',
    'label=colloq.kind=room-kernel',
    '--format',
    '{{.Label "colloq.session"}}\t{{.Label "colloq.gpu"}}\t{{.State}}',
  ])
  if (res.code !== 0) return []
  return res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [session, gpu, state] = line.split('\t')
      return {
        session: (session ?? '').trim(),
        gpu: (gpu ?? '').trim(),
        running: (state ?? '').trim() === 'running',
      }
    })
}

/**
 * Путь к папке комнаты ГЛАЗАМИ docker-демона.
 *
 * `-v` разбирает демон на хосте, а не мы, и путь он понимает по-своему. Под
 * `make run` (сервер на хосте) это тот же путь, и переменная не нужна. Под
 * `make up` сервер живёт в контейнере, где папка комнаты лежит по
 * `/app/workspace/<id>`, — демон создал бы на хосте пустую папку с этим именем и
 * смонтировал её: ядро видит пустоту, а файлы комнаты остаются там, где их
 * пишет сервер и показывает панель. `WORKSPACE_HOST_DIR` называет ту же папку
 * так, как её видит хост, и только это делает изоляцию под `make up` возможной.
 */
function hostMount(sessionId: string): string {
  const inside = sessionDir(sessionId)
  const root = hostRoot()
  if (!root) return inside
  return path.join(root, path.relative(config.workspaceDir, inside))
}

/** Корень воркспейса глазами хоста; пусто — сервер на хосте, и пути совпадают. */
function hostRoot(): string {
  return (process.env.WORKSPACE_HOST_DIR ?? '').trim()
}

/**
 * Сам ли сервер сидит в контейнере — вопрос, от которого зависит и путь
 * монтирования, и адрес ядра.
 *
 * Спрашивается у системы, а не выводится из непустого WORKSPACE_HOST_DIR, как
 * было: переменная, забытая в .env от прошлой формы запуска, молча уводила
 * ядро в сеть compose, и на машине, где сервер работает от systemd, ломался
 * КАЖДЫЙ запуск ячейки. Признак docker — файл `/.dockerenv`, он есть в любом
 * контейнере и не зависит от того, что кто-то положил в окружение.
 */
function inContainer(): boolean {
  return fs.existsSync('/.dockerenv')
}

/**
 * Сеть, в которую ставить контейнер комнаты, — и она же признак того, как его
 * потом звать.
 *
 * Под `make run` сервер на хосте, порт публикуется на хостовой петле, и
 * `127.0.0.1:<порт>` — верный адрес. Под `make up` сервер сам в контейнере, и
 * та же строка указывает на него самого: до петли хоста ему хода нет, а
 * host-gateway не спасает — порт привязан к 127.0.0.1, а не к мосту. Дорога
 * там одна: общая сеть compose и обращение по имени контейнера. Тогда порт не
 * публикуется вовсе — и Jupyter комнаты не виден с хоста никому, что строго
 * лучше прежнего. Имя сети знает только тот, кто нас запустил: `KERNEL_NETWORK`.
 *
 * Признак «сервер в контейнере» — тот же, по которому берётся путь монтирования.
 */
function roomNetwork(): string {
  return inContainer() ? (process.env.KERNEL_NETWORK ?? '').trim() : ''
}

/* --------------------------------------------------------------- срезы GPU */

/**
 * Устройства, отданные Colloq: `KERNEL_GPUS`, через запятую, в том виде, в
 * каком их понимает docker (`MIG-GPU-…`, `0`, `1`).
 *
 * Пусто или переменной нет — GPU не просит никто, и всё работает ровно как
 * раньше: на машине без карты ни одна комната не должна споткнуться о срез.
 */
export function gpuDevices(): string[] {
  return (process.env.KERNEL_GPUS ?? '')
    .split(',')
    .map((device) => device.trim())
    .filter((device) => device.length > 0)
}

/**
 * Срезы, выданные в этом процессе, но ещё не ставшие меткой на контейнере.
 *
 * Между «прочитали занятые» и «docker run поставил метку» проходит секунда, и
 * две комнаты, открытые разом, успевали выбрать один и тот же срез: docker на
 * это не жалуется, память MIG-среза делится пополам, и первое же обучение
 * падает по нехватке видеопамяти у обоих. Источник правды — по-прежнему метка,
 * это только окно между.
 */
const reserved = new Map<string, string>()

/**
 * Какой срез отдать комнате: тот же, если он у неё уже есть, иначе первый
 * свободный, иначе никакой.
 *
 * «Тот же» — не вежливость: срез привязан к контейнеру, и другой срез означает
 * пересоздание контейнера, то есть потерю всех переменных семинара на пустом
 * месте. А вот срез, которого больше нет в `KERNEL_GPUS` (оператор переписал
 * список), своим не считается: устройства может уже не быть на машине.
 *
 * Чистая функция, потому что доказывать надо именно это правило, а настоящего
 * docker в тестах нет.
 */
export function pickGpu(
  devices: string[],
  taken: Array<Pick<RoomContainer, 'session' | 'gpu'>>,
  sessionId: string,
): string | null {
  const mine = taken.find((held) => held.session === sessionId && devices.includes(held.gpu))
  if (mine) return mine.gpu
  const busy = new Set(taken.map((held) => held.gpu).filter((gpu) => gpu.length > 0))
  return devices.find((device) => !busy.has(device)) ?? null
}

/**
 * Срезов не хватило — теми же словами, что и отказ «окружение ни разу не
 * собиралось»: что случилось и что человеку в комнате делать дальше.
 *
 * Отказ, а не молчаливый запуск на процессоре: колёса torch в таком окружении
 * собраны под CUDA, `import torch` пройдёт, а первый `.cuda()` посреди пары
 * скажет что-то про драйвер — и никто не свяжет это с тем, что срез был занят.
 */
export function gpuRefusal(env: string, devices: string[]): string {
  if (devices.length === 0) {
    return tr("server.environmentRequiresAGpuButNoneIs.53af19", { p0: env })
  }
  return tr("server.environmentRequiresAGpuButAllAvailable.f3d4d9", { p0: env, p1: devices.length })
}

/**
 * Кто какой срез держит прямо сейчас — по меткам живых И остановленных
 * контейнеров, плюс брони этого процесса. Нужно панели и раздаче.
 */
export async function gpuAssignments(): Promise<Array<Pick<RoomContainer, 'session' | 'gpu'>>> {
  const held: Array<Pick<RoomContainer, 'session' | 'gpu'>> = (await roomContainers())
    .filter((room) => room.gpu.length > 0)
    .map((room) => ({ session: room.session, gpu: room.gpu }))
  const known = new Set(held.map((room) => room.session))
  for (const [session, gpu] of reserved) if (!known.has(session)) held.push({ session, gpu })
  return held
}

/** Занятые срезы — панели, чтобы она не обещала свободных. */
export async function gpuBusy(): Promise<string[]> {
  return [...new Set((await gpuAssignments()).map((room) => room.gpu))]
}

/** Срез для комнаты или отказ. Бронь ставится сразу — см. `reserved`. */
async function takeGpu(sessionId: string, env: string): Promise<string> {
  const devices = gpuDevices()
  const gpu = pickGpu(devices, await gpuAssignments(), sessionId)
  if (!gpu) throw new Error(gpuRefusal(env, devices))
  reserved.set(sessionId, gpu)
  return gpu
}

/**
 * Тот ли срез у уже существующего контейнера — третья проверка рядом с
 * `sameImage` и `sameNetwork`.
 *
 * Контейнер, поднятый до того, как окружению понадобился GPU, метки не несёт
 * вовсе, и устройства внутри у него нет: переиспользовать такой — значит
 * отдать комнате ядро, которое узнает о своей беде только на первом `.cuda()`.
 */
async function sameGpu(container: string, gpu: string | null): Promise<boolean> {
  const res = await run(['inspect', container, '--format', '{{index .Config.Labels "colloq.gpu"}}'])
  if (res.code !== 0) return true
  // Метки нет: docker печатает пустую строку, а версии постарше — `<no value>`.
  const label = res.out.trim() === '<no value>' ? '' : res.out.trim()
  return label === (gpu ?? '')
}

/**
 * Сколько потоков разрешить численным библиотекам.
 *
 * `os.cpu_count()` внутри контейнера показывает ядра ХОСТА, а не выданные
 * `--cpus`: numpy и torch поднимают по тридцать потоков на два выделенных ядра
 * и дерутся за них, считая медленнее, чем в один. Дробные `--cpus` docker
 * понимает, а число потоков — целое, и вниз, а не вверх: просить больше
 * потоков, чем есть ядер, — ровно та беда, от которой это ставится.
 */
function threadLimit(own?: number | null): string {
  const cpus = own ?? Number(process.env.KERNEL_CPUS ?? '2')
  if (!Number.isFinite(cpus) || cpus <= 0) return '2'
  return String(Math.max(1, Math.floor(cpus)))
}

/**
 * Сколько ядер получает комната, которой ничего не задали, — числом.
 *
 * `KERNEL_CPUS` — строка из окружения, и она может быть дробной («1.5»):
 * docker так умеет. Наружу отдаётся то же самое число, потому что форма
 * занятия подписывает им поле «Процессор» — и подписывать обязана тем, что
 * комната действительно получит.
 */
export function defaultCpus(): number {
  const cpus = Number(process.env.KERNEL_CPUS ?? '2')
  return Number.isFinite(cpus) && cpus > 0 ? cpus : 2
}

/**
 * Сколько памяти выдать контейнеру комнаты — и почему это не одно число на всю
 * машину.
 *
 * Две гигабайты на комнату — честное умолчание для ноутбука, на котором
 * поднимают колло́к посмотреть, и приговор для семинара по компьютерному
 * зрению: `resnet18` на батче из 250 картинок 224×224 занимает под два
 * гигабайта одними активациями, и это ПОВЕРХ торча, CUDA-контекста и уже
 * загруженной языковой модели. Дальше cgroup убивает python, Jupyter молча
 * поднимает новый, и преподаватель видит «ядро перезапустилось» на одной и той
 * же ячейке пятнадцать раз подряд.
 *
 * Поэтому лимит спрашивается у окружения, а не зашит: `KERNEL_MEM` — общий, а
 * `KERNEL_MEM_<ОКРУЖЕНИЕ>` перебивает его для одного. Имя окружения приводится
 * к виду переменной среды: `base-gpu` → `KERNEL_MEM_BASE_GPU`. Так тяжёлое
 * окружение получает своё, а лёгкие комнаты рядом не съедают машину впустую.
 */
export function memoryLimit(env: string): string {
  const named = process.env[`KERNEL_MEM_${env.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`]
  return named || process.env.KERNEL_MEM || (needsGpu(env) ? DEFAULT_MEM_GPU : DEFAULT_MEM)
}

/*
 * Умолчания подняты 13.09.2026 после дня, когда 2g убивали ядро на каждом
 * запуске одной ячейки. Четыре гигабайта — обычная тетрадь с pandas и
 * картинками на ноутбуке ещё терпит; окружение с GPU без шестнадцати не имеет
 * смысла: арендуемая машина — 3090 с 24 ГБ видеопамяти и 72 ГБ оперативной,
 * и торч с CUDA-контекстом и моделью кладёт в оперативную не меньше, чем в
 * видео. Это про RAM: видеопамять cgroup не ограничивает, карту комнаты делят
 * целиком.
 */
const DEFAULT_MEM = '4g'
const DEFAULT_MEM_GPU = '16g'

/**
 * Строка docker («4g», «512m», «2048») — в мегабайтах, и обратно.
 *
 * Нужна ровно потому, что лимит перестал быть делом одного `.env`: его теперь
 * видно в панели и можно задать комнате числом. Панель говорит гигабайтами,
 * строка семинара хранит мегабайты, docker понимает суффиксы — и без одной
 * общей мерки посередине эти трое расходятся молча, а расплачивается за это
 * ядро, которому выдали вдвое меньше, чем нарисовано на экране.
 *
 * Округление вниз намеренное: дробного мегабайта docker не выдаст, а лишний,
 * приписанный при чтении, вернулся бы в `--memory` числом больше того, что
 * стояло в переменной окружения.
 */
export function parseMemMb(spec: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([bkmg])?b?\s*$/i.exec(spec)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (match[2] ?? 'b').toLowerCase()
  const bytes = value * (unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1)
  const mb = Math.floor(bytes / 1024 ** 2)
  return mb > 0 ? mb : null
}

/** Обратно — тем же языком, которым `--memory` и задают. */
export function memSpec(mb: number): string {
  return `${Math.floor(mb)}m`
}

/**
 * На что ложатся окружения: общее умолчание и умолчание окружения с GPU.
 *
 * Отдельно от `memoryLimitMb(env)` потому, что форма семинара показывает и то
 * и другое ДО выбора окружения: «по умолчанию 4 ГБ, на GPU — 16».
 */
export function defaultMemoryMb(gpu = false): number {
  const fallback = gpu ? DEFAULT_MEM_GPU : DEFAULT_MEM
  return parseMemMb(process.env.KERNEL_MEM || fallback) ?? (parseMemMb(fallback) as number)
}

/** Умолчание окружения числом — его показывает форма семинара. */
export function memoryLimitMb(env: string): number {
  const named = parseMemMb(memoryLimit(env))
  if (named !== null) return named
  // Переменную окружения написали как попало («4 гига»): своё умолчание
  // разобрать заведомо получится, и комната поднимется, а не упадёт на NaN.
  return parseMemMb(needsGpu(env) ? DEFAULT_MEM_GPU : DEFAULT_MEM) as number
}

/**
 * Позвать docker чужими руками — для postmortem.ts, который выясняет, почему
 * ядро умерло.
 *
 * Отдельным экспортом, а не «вынести `run` наружу»: наружу отдаётся ровно
 * чтение, с коротким сроком, и зависимость идёт в одну сторону — пул ничего не
 * знает о том, кто и зачем читает состояние его контейнеров.
 */
export function dockerRead(args: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  return run(args, timeoutMs)
}

/** Имя контейнера комнаты — тем, кто спрашивает docker о нём напрямую. */
export function roomContainer(sessionId: string): string {
  return containerFor(sessionId)
}

/**
 * Аргументы `docker run` для контейнера комнаты.
 *
 * Отдельной функцией, потому что настоящего docker в тестах нет, а собрать эту
 * строку правильно важнее, чем её позвать: лишний пробел или потерянный флаг
 * здесь — это семинар без GPU или без изоляции, и заметить это можно только на
 * паре. Кавычек нет намеренно: `run()` зовёт spawn массивом, без шелла.
 */
export function runArgs(opts: {
  sessionId: string
  env: string
  mount: string
  network: string
  gpu: string | null
  /**
   * Лимит памяти именно ЭТОЙ комнаты, если преподаватель его задал.
   *
   * Перебивает умолчание окружения, а не дополняет его: семинар по зрению и
   * семинар по статистике живут на одном образе, и вся разница между ними —
   * сколько памяти им надо. `null` (и отсутствие поля) — прежнее поведение,
   * то есть `KERNEL_MEM` и умолчание окружения.
   */
  memoryMb?: number | null
  /**
   * Сколько ядер выдать именно ЭТОЙ комнате.
   *
   * Тем же правилом, что и память: `null` — прежнее поведение, то есть
   * `KERNEL_CPUS` на весь инстанс. Число здесь решает не только `--cpus`, но и
   * потоки численных библиотек ниже: `os.cpu_count()` внутри контейнера видит
   * ядра ХОСТА, и комната с двумя выданными ядрами поднимала бы тридцать
   * потоков на них — ровно то, от чего эти переменные и стоят.
   */
  cpus?: number | null
}): string[] {
  const { sessionId, env, mount, network, gpu } = opts
  const memory = opts.memoryMb ? memSpec(opts.memoryMb) : memoryLimit(env)
  const cpus = opts.cpus && opts.cpus > 0 ? opts.cpus : defaultCpus()
  const threads = threadLimit(cpus)
  return [
    'run',
    '-d',
    '--name',
    containerFor(sessionId),
    /*
     * Либо общая сеть compose и адрес по имени контейнера (сервер сам в
     * контейнере), либо порт на петле хоста. Петля тут не украшение: без
     * неё Jupyter комнаты открыт на всех интерфейсах, а Wi-Fi семинара —
     * один из них. В сетевом режиме порт не публикуется вовсе.
     */
    ...(network ? ['--network', network] : ['-p', '127.0.0.1:0:8888']),
    // Один срез, названный так, как его зовёт docker. Комната на обычном
    // окружении сюда не попадает и устройства не занимает.
    ...(gpu ? ['--gpus', `device=${gpu}`] : []),
    '-e',
    `JUPYTER_TOKEN=${roomToken(sessionId)}`,
    // Ядер у комнаты столько, сколько ей выдали, — и потоков столько же.
    '-e',
    `OMP_NUM_THREADS=${threads}`,
    '-e',
    `MKL_NUM_THREADS=${threads}`,
    '-e',
    `OPENBLAS_NUM_THREADS=${threads}`,
    // numexpr считает своё число по ядрам ХОСТА так же, как остальные три, и
    // молча ругается в журнал ядра, не найдя своей переменной.
    '-e',
    `NUMEXPR_NUM_THREADS=${threads}`,
    '-v',
    `${mount}:/workspace/${sessionId}`,
    // Student code is arbitrary, exactly as in compose. A runaway cell in
    // one room must not be able to take the host down either.
    `--memory=${memory}`,
    /*
     * Swap ровно по памяти, и потому же, почему он стоит в `docker update`
     * ниже: без этого флага docker выдаёт контейнеру столько же swap сверху, и
     * упёршееся в лимит ядро не умирает, а уходит на диск — комната стоит
     * минутами там, где честнее сразу сказать «не хватило памяти».
     */
    `--memory-swap=${memory}`,
    `--cpus=${cpus}`,
    '--pids-limit=512',
    /*
     * Разделяемая память нужна только там, где есть GPU: умолчание docker —
     * 64 МБ, и `DataLoader(num_workers=4)` падает на нём «bus error», не
     * назвав причины. Обычным комнатам этого не надо, и лишняя память,
     * отданная всем, — это память, отнятая у соседних семинаров.
     */
    ...(gpu ? [`--shm-size=${process.env.KERNEL_SHM ?? '1g'}`] : []),
    /*
     * `no`, а не `unless-stopped`: контейнеров теперь по одному на семинар,
     * и перезагрузка машины поднимала бы разом весь прошлый семестр. Пока
     * сервер жив, упавший контейнер он поднимет сам при следующем открытии
     * комнаты.
     */
    '--restart=no',
    '--label',
    'colloq.kind=room-kernel',
    '--label',
    `colloq.session=${sessionId}`,
    '--label',
    `colloq.environment=${env}`,
    // Метка — источник правды о том, кто держит срез: она переживает
    // перезапуск сервера, а карта в памяти нет.
    ...(gpu ? ['--label', `colloq.gpu=${gpu}`] : []),
    `${IMAGE_PREFIX}:${env}`,
  ]
}

/* ------------------------------------------------ лимит памяти на живой комнате */

type DockerRun = (args: string[], timeoutMs?: number) => Promise<RunResult>
let limitsDocker: DockerRun = run

/**
 * Подменить docker — тестам.
 *
 * Ровно как в postmortem.ts и ровно по той же причине: настоящего docker в
 * сюите нет, а проверять надо то, что бывает только с ним. Подмена действует
 * ТОЛЬКО на изменение лимита: жизненный цикл контейнеров она не трогает, и
 * тест, забывший её снять, не может поднять на машине ни одного контейнера.
 */
export function useDockerForLimits(fake: DockerRun | null): void {
  limitsDocker = fake ?? run
  limitsInjected = fake !== null
}
let limitsInjected = false

/** Что стало с лимитом: применён на живом контейнере, ждёт следующего пуска, не вышло. */
export type LimitOutcome = 'applied' | 'pending' | 'failed'

/**
 * Поднять (или опустить) память живой комнате, не убивая её Python.
 *
 * `docker update` умеет менять cgroup работающего контейнера — а значит,
 * преподаватель, чьё ядро только что убили по памяти, добавляет гигабайты и
 * запускает ту же ячейку заново, не потеряв ни переменных семинара, ни
 * открытого терминала. Пересоздание контейнера здесь было бы ровно тем, от
 * чего страдали: чистый Python посреди пары.
 *
 * Оба флага вместе, и это не перестраховка: `--memory` без `--memory-swap`
 * docker отвергает всякий раз, когда новая память больше СТАРОГО swap
 * («Memory limit should be smaller than already set memoryswap limit»), то
 * есть ровно в том случае, ради которого сюда и пришли. Swap равен памяти —
 * тот же расклад, что и при `docker run` выше.
 *
 * Контейнера нет — не беда и не ошибка: число уже лежит в строке семинара, и
 * следующий пуск возьмёт его оттуда.
 */
export async function applyMemoryLimit(sessionId: string, mb: number): Promise<LimitOutcome> {
  const container = containerFor(sessionId)
  if (!limitsInjected) {
    // Под брокером контейнерами распоряжаемся не мы, а под тестовым бэкендом
    // их нет вовсе. И там и там число ждёт следующего пуска.
    if (kernelBackend() !== 'docker') return 'pending'
    if (!(await canIsolate())) return 'pending'
  }
  const spec = memSpec(mb)
  const res = await limitsDocker(['update', `--memory=${spec}`, `--memory-swap=${spec}`, container], 30_000)
  if (res.code === 0) {
    console.log(`[kernel] комнате ${sessionId} выдано ${spec} памяти на живом контейнере`)
    return 'applied'
  }
  // «No such container» — обычное дело: комнату ещё не открывали сегодня.
  if (/no such container/i.test(res.out)) {
    console.log(`[kernel] комнате ${sessionId} записано ${spec} памяти; контейнера нет, возьмёт при пуске`)
    return 'pending'
  }
  console.error(`[kernel] docker update для ${sessionId} не удался: ${res.out.slice(-200)}`)
  return 'failed'
}

/**
 * Поднять (или опустить) число ядер живой комнате.
 *
 * `docker update --cpus` меняет cgroup работающего контейнера, и ядру от этого
 * становится просторнее в ту же секунду. Оговорка одна, и она честная: потоки
 * numpy и torch считаются ОДИН раз, при старте интерпретатора, по переменным
 * окружения контейнера — так что уже запущенное ядро будет считать прежним
 * числом потоков, пока его не перезапустят. Об этом сказано в подсказке под
 * полем, а не только здесь.
 *
 * Swap-подобной пары флагов тут нет: `--cpus` самодостаточен.
 */
export async function applyCpuLimit(sessionId: string, cpus: number): Promise<LimitOutcome> {
  const container = containerFor(sessionId)
  if (!limitsInjected) {
    if (kernelBackend() !== 'docker') return 'pending'
    if (!(await canIsolate())) return 'pending'
  }
  const res = await limitsDocker(['update', `--cpus=${cpus}`, container], 30_000)
  if (res.code === 0) {
    console.log(`[kernel] комнате ${sessionId} выдано ${cpus} ядер на живом контейнере`)
    return 'applied'
  }
  if (/no such container/i.test(res.out)) {
    console.log(`[kernel] комнате ${sessionId} записано ${cpus} ядер; контейнера нет, возьмёт при пуске`)
    return 'pending'
  }
  console.error(`[kernel] docker update --cpus для ${sessionId} не удался: ${res.out.slice(-200)}`)
  return 'failed'
}

/**
 * Что docker реально выдал контейнеру комнаты — память и ядра одним вопросом.
 *
 * Спрашивается у docker, а не берётся из строки семинара: разойтись они могут
 * ровно тогда, когда это важно — лимит подняли, а комната с утра работает на
 * старом. Ноль в ответе docker значит «без лимита», и это `null`, а не 0. Один
 * `inspect` на оба числа, потому что список комнат зовёт его на каждую живую.
 */
export async function containerLimits(
  sessionId: string,
): Promise<{ memoryMb: number | null; cpus: number | null }> {
  const res = await limitsDocker(
    ['inspect', containerFor(sessionId), '--format', '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'],
    10_000,
  )
  if (res.code !== 0) return { memoryMb: null, cpus: null }
  const [rawBytes, rawNano] = res.out.trim().split(/\s+/)
  const bytes = Number(rawBytes)
  const nano = Number(rawNano)
  return {
    memoryMb: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / 1024 ** 2) : null,
    // NanoCpus — миллиардные доли ядра: 2,5 ядра приезжают как 2500000000.
    cpus: Number.isFinite(nano) && nano > 0 ? Math.round(nano / 1e8) / 10 : null,
  }
}

async function startContainer(
  sessionId: string,
  env: string,
  retried = false,
): Promise<KernelEndpoint> {
  const container = containerFor(sessionId)
  const image = `${IMAGE_PREFIX}:${env}`
  const network = roomNetwork()
  /*
   * Срез спрашивается до того, как мы решим переиспользовать контейнер: у
   * комнаты со своим контейнером это тот же срез, что и был, а у новой — либо
   * свободный, либо отказ, и отказать надо раньше, чем `docker start` поднимет
   * ядро без устройства.
   */
  const gpu = needsGpu(env) ? await takeGpu(sessionId, env) : null
  const state = await stateOf(container)

  /*
   * Пересоздать контейнер и попробовать ещё раз — ровно один раз.
   *
   * Второй попытки нет намеренно: если и свежесозданный контейнер не отвечает,
   * дело не в нём, и бесконечный круг `rm` + `run` посреди пары хуже честной
   * ошибки на ячейке.
   */
  const recreate = async (why: string): Promise<KernelEndpoint> => {
    if (retried) throw new Error(tr("server.couldNotStartTheRoomContainer.cf7398", { p0: why }))
    /*
     * Сказать вслух, если сносится живой (или замерший) контейнер.
     *
     * Пересоздание — это чистый Python: все переменные семинара, всё
     * посчитанное и pty терминала уходят вместе с ним. Молчаливая потеря
     * посреди пары выглядит как «ядро сошло с ума»: `x` был и вдруг NameError,
     * и ни одной строки об этом нигде. `missing` не считается — там терять
     * нечего, контейнера и не было.
     */
    if (state === 'running' || state === 'broken') announceRecreate(sessionId, why)
    await run(['rm', '-f', container], 60_000)
    endpoints.delete(sessionId)
    return startContainer(sessionId, env, true)
  }

  if (state === 'broken') {
    // `dead`, `paused`, `restarting`: `docker start` такому не поможет.
    return recreate(tr("server.theContainerIsInAStateThat.d95d79"))
  }
  if (state === 'stopped' || state === 'running') {
    /*
     * Контейнер, собранный из старого образа, — уже не это окружение. Он
     * переиспользовался по одному имени, так что пересборка списка пакетов
     * оставляла комнату на прежнем образе, а панель показывала новый: у
     * студента падал `import transformers`, и ничто на экране с ним не спорило.
     */
    if (!(await sameImage(container, image))) return recreate(tr("server.theEnvironmentImageWasRebuilt.229a9d"))
    // Контейнер прошлого режима: адреса, по которому мы теперь его зовём, у
    // него нет — ни имени в нашей сети, ни опубликованного порта.
    if (!(await sameNetwork(container, network))) return recreate(tr("server.theServerChangedNetworks.08933e"))
    // Контейнер без среза (или с чужим) для GPU-окружения не годится: устройства
    // внутрь него не пробросить иначе как заново.
    if (!(await sameGpu(container, gpu))) return recreate(tr("server.theContainerWasStartedWithADifferent.bc4d7d"))
    if (state === 'stopped') {
      const started = await run(['start', container], 60_000)
      // Результат читается: не поднявшийся контейнер дальше отвечал бы «could
      // not read the published port» на каждый Run, и так до ручного docker rm.
      if (started.code !== 0) return recreate(tr("server.dockerStart.e0ac13", { p0: started.out.slice(-200) }))
    }
  } else if (state === 'missing') {
    if (!(await imageExists(image))) {
      throw new Error(
        tr("server.environmentHasNotBeenBuiltBuildIt.cf54f5", { p0: env, p1: env }),
      )
    }
    /*
     * Монтируется ТОЛЬКО папка этой комнаты, и по тому же пути, что и раньше:
     * рабочий каталог ядра задаётся путём сессии Jupyter `<id>/session.ipynb`,
     * так что `/workspace/<id>` обязано существовать внутри — а всё остальное
     * содержимое `/workspace` внутрь больше не попадает вовсе.
     */
    const mount = hostMount(sessionId)
    const created = await run(
      runArgs({
        sessionId,
        env,
        mount,
        network,
        gpu,
        memoryMb: sessionMemoryMb(sessionId),
        cpus: sessionCpus(sessionId),
      }),
      120_000,
    )
    if (created.code !== 0) {
      /*
       * Самая частая беда GPU-комнаты — не в нас: на хосте не поставлен
       * nvidia-container-toolkit, и docker отвечает «could not select device
       * driver», из чего человеку в комнате не следует ничего. Подсказка
       * добавляется, только если docker сказал именно это.
       */
      const noDriver = gpu !== null && /device driver|nvidia/i.test(created.out)
      const hint = noDriver
        ? tr("server.theHostMayBeMissingNvidiaContainer.f5c0df")
        : ''
      throw new Error(tr("server.dockerRunFailed.0f4300", { p0: created.out.slice(-300), p1: hint }))
    }
  }

  let url: string
  if (network) {
    // Внутри сети слушают тот же 8888, публиковать нечего.
    url = `http://${container}:8888`
  } else {
    const port = await publishedPort(container)
    if (port === null) throw new Error(tr("server.couldNotReadThePublishedPortOf.07ca0a", { p0: container }))
    url = `http://127.0.0.1:${port}`
  }

  const endpoint: KernelEndpoint = { url, token: roomToken(sessionId) }

  // Wait for Jupyter inside it to answer. `docker run` returns as soon as the
  // process is spawned, and connecting a second later fails with a bare
  // "fetch failed" that says nothing about why.
  const deadline = Date.now() + 90_000
  let lastError = tr("server.noResponse.187241")
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint.url}/api/status?token=${endpoint.token}`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) return endpoint
      /*
       * 401/403 — это не «ещё не поднялся», а «токен другой».
       *
       * Токен контейнера зафиксирован при `docker run` и выведен из секрета
       * инстанса: после ротации SESSION_SECRET (README прямо её советует) все
       * старые контейнеры отвечают 403, и комната ждала девяносто секунд на
       * каждый Run, читая про таймаут. Токен детерминированный — пересозданный
       * контейнер получит правильный.
       */
      if (res.status === 401 || res.status === 403) {
        return recreate(tr("server.theRoomKernelRejectedItsTokenHttp.c7ea0c", { p0: res.status }))
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(tr("server.theRoomKernelDidNotRespondWithin.1324d5", { p0: lastError }))
}

/** Адреса, которые уже разрешили, чтобы занятая комната не звала docker на ячейку. */
const endpoints = new Map<string, KernelEndpoint>()
/** Один запуск за раз на комнату, общий для одновременных вызовов. */
const starting = new Map<string, Promise<KernelEndpoint>>()
/**
 * Комнаты, которые закрыли, пока их контейнер ещё поднимался.
 *
 * `docker rm -f` посреди `docker run` не догоняет: подъём доработает и оставит
 * контейнер удалённого семинара жить с его лимитом памяти — уборка простоя его
 * не найдёт (комнаты в картах уже нет), и он доживёт до `make down`. Ждать
 * подъёма в `dropRoomKernel` нельзя, это до полутора минут на запросе удаления,
 * — поэтому помечаем, а убирает за собой сам подъём.
 */
const abandoned = new Set<string>()
const brokerStarts = new Map<string, Set<Promise<KernelEndpoint>>>()

/**
 * Адрес Python, с которым должна разговаривать эта комната.
 *
 * Production image selection comes from the persisted room pin and release catalog.
 */
export async function endpointForSession(
  sessionId: string,
  env: string | null,
): Promise<KernelEndpoint> {
  requireKernelIsolation()
  if (kernelRetirementInProgress(sessionId)) throw new Error(tr("server.cannotStartKernelSeminarIsStopping.9820e1"))
  const backend = kernelBackend()
  if (backend === 'test') return defaultEndpoint()
  if (backend === 'broker') {
    if (!sessionRowExists(sessionId)) throw new Error(tr("server.cannotStartKernelSeminarDoesNotExist.4f72c5"))
    sessionDir(sessionId)
    const previous = sessionKernelRevision(sessionId)
    const selected = runtimeEnvironment(sessionEnvironment(sessionId), previous)
    const revision = pinSessionKernelRevision(sessionId, selected.name, imageRevision(selected.image))
    const pinned = runtimeEnvironment(sessionEnvironment(sessionId), revision)
    const starts = brokerStarts.get(sessionId) ?? new Set<Promise<KernelEndpoint>>()
    brokerStarts.set(sessionId, starts)
    const attempt = kernelRuntimeClient().ensure(sessionId, pinned.name, revision)
    starts.add(attempt)
    try {
      const endpoint = await attempt
      if (kernelRetirementInProgress(sessionId) || !sessionRowExists(sessionId)) {
        throw new Error(tr("server.cannotStartKernelSeminarIsStopping.9820e1"))
      }
      return endpoint
    } finally {
      starts.delete(attempt)
      if (starts.size === 0) brokerStarts.delete(sessionId)
    }
  }
  if (!(await canIsolate())) throw new Error('Room isolation is unavailable. Execution is disabled; shared Jupyter fallback is not permitted')

  const cached = endpoints.get(sessionId)
  if (cached) return cached

  const inFlight = starting.get(sessionId)
  if (inFlight) return inFlight

  const name = (env ?? '').trim() || activeName()
  const attempt = startContainer(sessionId, name)
    .then((endpoint) => {
      endpoints.set(sessionId, endpoint)
      return endpoint
    })
    .finally(() => {
      starting.delete(sessionId)
      // Бронь свою работу сделала: либо контейнер уже несёт метку со срезом,
      // либо контейнера нет и срез свободен. Пережить подъём она не должна —
      // иначе неудачная сборка окружения забирает срез у следующего семинара
      // насовсем.
      reserved.delete(sessionId)
      // Комнату закрыли, пока это поднималось: контейнер (успешный или
      // недоделанный) убираем сами — за него больше некому.
      if (abandoned.delete(sessionId)) void discardRoom(sessionId)
    })
  starting.set(sessionId, attempt)
  return attempt
}

async function discardRoom(sessionId: string): Promise<void> {
  endpoints.delete(sessionId)
  try {
    await run(['rm', '-f', containerFor(sessionId)], 60_000)
  } catch (err) {
    console.error(`[kernel] не удалось убрать контейнер ${containerFor(sessionId)}:`, err)
  }
}

/**
 * Убрать контейнер комнаты насовсем.
 *
 * Зовётся при удалении семинара и при уборке простоя. Файлы лежат на хосте, в
 * папке комнаты, и переживают это — уходит только Python со всеми переменными.
 */
export async function dropRoomKernel(sessionId: string, permanent = false): Promise<void> {
  if (kernelBackend() === 'broker') {
    const release = blockKernelStarts(sessionId)
    try {
      // An already-issued ensure must settle before DELETE; otherwise its late
      // request can recreate the Pod after a successful stop response.
      await Promise.allSettled([...(brokerStarts.get(sessionId) ?? [])])
      await kernelRuntimeClient().stop(sessionId, permanent)
    } finally { release() }
    return
  }
  if (kernelBackend() === 'test') return
  endpoints.delete(sessionId)
  if (!(await canIsolate())) return
  // Подъём, идущий прямо сейчас, положил бы контейнер обратно секундой позже:
  // помечаем комнату, и подъём, закончившись, снесёт его сам.
  if (starting.has(sessionId)) abandoned.add(sessionId)
  await run(['rm', '-f', containerFor(sessionId)], 60_000)
}

/** Забыть разрешённый адрес, чтобы следующее открытие перепроверило контейнер. */
export function forgetSessionKernel(sessionId: string): void {
  endpoints.delete(sessionId)
}

/** Комнаты, для которых этот процесс поднял контейнер. Нужно панели. */
export function runningRoomKernels(): string[] {
  return [...endpoints.keys()]
}
