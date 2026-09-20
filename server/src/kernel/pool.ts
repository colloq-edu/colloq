import { tr } from '@shared/i18n'
import { kernelBackend, requireKernelIsolation, kernelRuntimeClient, runtimeEnvironment, imageRevision } from './runtime-client.js'
import { sessionCpus, sessionEnvironment, sessionKernelRevision, pinSessionKernelRevision, sessionMemoryMb, sessionRowExists, storedRules } from '../db.js'
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
import {
  ROOM_NETWORK,
  ROOM_PROFILE,
  ensureRoomPerimeter,
  perimeterStale,
  roomHardeningArgs,
  warmPerimeter,
  type RoomNetworkTarget,
} from './perimeter.js'

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
 * Чей это контейнер: занятия — или личных тетрадей его студентов.
 *
 * Контейнеров у комнаты два, и второй заводится лениво, при первом запуске в
 * личной тетради. Зачем он нужен отдельно, а не вторым процессом внутри
 * первого, сказано в shared/rules.ts · bookHasOwnKernel: GPU выдаётся
 * контейнеру целиком, а OOM-killer в общем лимите выбирает самый тяжёлый
 * процесс — то есть ядро лекции, а не жадного студента.
 *
 * Отсутствие метки `colloq.role` на живом контейнере читается как `room`: так
 * выглядят ВСЕ контейнеры, поднятые до этой правки, и переживать выкатку они
 * обязаны без пересоздания.
 */
export type KernelRole = 'room' | 'own'

/**
 * На этом инстансе личной тетради своего ядра не дать — и это честный отказ,
 * а не сбой.
 *
 * Бывает ровно на брокере (k3s): Pod он заводит один на занятие, и второй,
 * без карты, — это правка его протокола, его контроллера и его прав в
 * кластере. Посчитать личную тетрадь в ядре лекции вместо отказа нельзя: это
 * и есть та самая беда, ради которой второй контейнер заводится, — GPU
 * занятия в руках студента и OOM-killer, выбирающий ядро преподавателя.
 *
 * Своим классом, а не строкой: `ensureKernel` ловит его отдельно от сетевых
 * неудач — «не вышло, попробуйте ещё» здесь было бы неправдой, пробовать
 * нечего.
 */
export class OwnKernelUnavailable extends Error {
  constructor() {
    super(tr('server.kernel.ownUnavailable'))
    this.name = 'OwnKernelUnavailable'
  }
}

/**
 * Токен Jupyter для одного контейнера.
 *
 * Выводится из секрета инстанса, а не выдаётся случайно: контейнер переживает
 * перезапуск сервера, и случайный токен пришлось бы где-то хранить — либо
 * терять вместе с доступом к живому ядру посреди пары. Разный у разных комнат,
 * так что ячейка, прочитавшая свой `JUPYTER_TOKEN`, не открывает соседние.
 *
 * И разный у двух контейнеров ОДНОЙ комнаты: иначе строка из личной тетради
 * студента открывала бы Jupyter лекции — то есть чужие ядра, чужие переменные
 * и чужой `execute` — ровно тем токеном, который лежит у неё в окружении.
 * Прежняя строка (`jupyter:<id>`) остаётся за комнатой, чтобы живые контейнеры
 * после выкатки отвечали на свой токен, а не пересоздавались все разом.
 */
function roomToken(sessionId: string, role: KernelRole = 'room'): string {
  return createHmac('sha256', config.sessionSecret)
    .update(role === 'own' ? `jupyter:own:${sessionId}` : `jupyter:${sessionId}`)
    .digest('hex')
    .slice(0, 40)
}

const containerFor = (sessionId: string, role: KernelRole = 'room') =>
  role === 'own' ? `${ROOM_PREFIX}-${sessionId}-own` : `${ROOM_PREFIX}-${sessionId}`

/**
 * Ключ, под которым пул помнит один контейнер: адрес, идущий подъём, брошенность.
 *
 * У комнатного — сам идентификатор занятия, буква в букву как раньше: карты
 * `endpoints`/`starting` пережили десяток правок с этим ключом, и менять его
 * значило бы переписывать каждую из них ради одного суффикса. У контейнера
 * личных тетрадей — `<id>#own`; `#` в идентификаторе занятия не бывает
 * (shared/runtime.ts · RUNTIME_SESSION_ID), так что разобрать ключ обратно
 * можно точно.
 */
const slotFor = (sessionId: string, role: KernelRole): string =>
  role === 'own' ? `${sessionId}#own` : sessionId

/** Занятие, которому принадлежит слот. */
const sessionOfSlot = (slot: string): string => {
  const cut = slot.indexOf('#')
  return cut < 0 ? slot : slot.slice(0, cut)
}

/**
 * Сколько памяти и процессора получает контейнер личных тетрадей.
 *
 * Своё число занятия, если преподаватель его назвал (правило
 * `ownMemoryMb`/`ownCpus`), иначе — ровно столько же, сколько у комнаты. Одно
 * место на весь пул: этот вопрос задают и подъём контейнера, и смена лимита на
 * живом занятии, и разошедшись, они дали бы контейнер, поднятый с одним
 * числом и обновлённый другим.
 *
 * Строки занятия в базе нет (тест, удалённая комната) — числа комнаты: это
 * прежнее поведение и единственный ответ, который точно не врёт.
 */
export function ownLimits(sessionId: string): { memoryMb: number | null; cpus: number | null } {
  const room = { memoryMb: sessionMemoryMb(sessionId), cpus: sessionCpus(sessionId) }
  try {
    const rules = storedRules(sessionId)
    return {
      memoryMb: rules.ownMemoryMb ?? room.memoryMb,
      cpus: rules.ownCpus ?? room.cpus,
    }
  } catch {
    return room
  }
}

/**
 * Потолок ЖИВЫХ личных ядер в одном занятии.
 *
 * Ядер в контейнере личных тетрадей десятки, и каждое — это питон с
 * ipykernel: полтора десятка потоков и сотня мегабайт вхолостую. Без потолка
 * поток в пятьсот человек, у каждого по три черновика, кладёт контейнер (а
 * вместе с ним и работу всех) на `--pids-limit` или на лимите памяти — молча и
 * посреди пары. С потолком лишний запуск получает фразу, а занятие идёт.
 *
 * Сорок — это «вся группа работает у себя одновременно» с запасом; поток
 * столько личных тетрадей разом не открывает, а если открывает, преподаватель
 * узнаёт об этом из отказа, а не из мёртвого контейнера.
 */
export function ownKernelMax(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number((env.KERNEL_OWN_MAX ?? '').trim())
  return Number.isInteger(value) && value >= 1 ? value : 40
}

/**
 * Через сколько минут простоя гасится ядро ЛИЧНОЙ тетради; `0` — не гасить.
 *
 * У ядер занятия простой считается по комнате: пусто два часа — уходит весь
 * контейнер (kernel/index.ts · IDLE_KERNEL_MS). Личным тетрадям этого мало, и
 * счёт у них другой. Занятие, открытое на весь день, держит по ядру на каждый
 * черновик, который кто-то когда-то запустил: сорок питонов по сотне мегабайт
 * вхолостую, и ни один из них никому не нужен — работают в двух-трёх. Потолок
 * `KERNEL_OWN_MAX` от этого не спасает, он только отказывает СОРОК ПЕРВОМУ.
 *
 * Полчаса — это «отошли на перерыв и вернулись», а не «закрыли черновик»: на
 * паре в полтора часа ядро, которое полчаса ничего не считало, переменных уже
 * почти наверняка не хранит нужных. Цена ошибки мала и названа вслух: заметка
 * в тетради и один Run, чтобы поднять ядро заново.
 *
 * `0` — выключатель для того, у кого пара устроена иначе.
 */
export function ownIdleMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.KERNEL_OWN_IDLE_MIN ?? '').trim()
  if (raw === '0') return 0
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 ? value : 30
}

/**
 * Кому сказать, что контейнер комнаты пришлось пересоздать.
 *
 * Пересоздание — это новый Python: переменные семинара, открытый терминал и
 * всё, что ядро успело посчитать, остаются в снесённом контейнере. Молча этого
 * делать нельзя, а звать `kernelNote` отсюда некому: kernel/index.ts зависит от
 * пула, не наоборот. Поэтому пул объявляет, а слушателя ставит тот, у кого есть
 * документ комнаты.
 */
type RecreateListener = (sessionId: string, why: string, role: KernelRole) => void
const recreateListeners: RecreateListener[] = []

export function onRoomKernelRecreated(cb: RecreateListener): void {
  recreateListeners.push(cb)
}

function announceRecreate(sessionId: string, why: string, role: KernelRole): void {
  for (const cb of [...recreateListeners]) {
    try {
      cb(sessionId, why, role)
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

/** Версия укреплённого профиля, с которой поднят контейнер; пусто — поднят до него. */
async function profileOf(container: string): Promise<string> {
  const res = await run(['inspect', container, '--format', '{{index .Config.Labels "colloq.profile"}}'])
  if (res.code !== 0) return ''
  const label = res.out.trim()
  return label === '<no value>' ? '' : label
}

/**
 * Есть ли дорога до живого контейнера, поднятого до профиля, — той, по
 * которой его звали тогда.
 *
 * На хосте он стоит в `bridge` с опубликованным портом, и порт этот работает и
 * сейчас: сеть `colloq-rooms` ему не нужна, чтобы дожить пару. В контейнерной
 * форме сеть не менялась вовсе — хватает членства в ней.
 */
async function legacyReachable(container: string, network: string): Promise<boolean> {
  if (publishes()) return (await publishedPort(container)) !== null
  return sameNetwork(container, network)
}

/** Сказано один раз на комнату: живой контейнер без профиля — дыра до его остановки. */
const legacyWarned = new Set<string>()

function warnLegacy(sessionId: string): void {
  if (legacyWarned.has(sessionId)) return
  legacyWarned.add(sessionId)
  console.warn(
    `[kernel] room ${sessionId} keeps its pre-hardening container (default privileges, open network) until it stops; the next start recreates it hardened`,
  )
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
 * Сеть комнат и запрет на локальные адреса — на старте сервера, заранее.
 *
 * Правила iptables переживают перезапуск сервера, но не перезагрузку VM colima
 * или Docker Desktop; заодно так отказ виден в журнале до пары, а не на первом
 * Run. Ошибка здесь не роняет сервер: комнаты откажут сами, со своим текстом.
 */
export async function warmRoomPerimeter(): Promise<void> {
  if (kernelBackend() !== 'docker') return
  if (!(await canIsolate())) return
  await warmPerimeter(run, perimeterTarget(), `${IMAGE_PREFIX}:${activeName()}`)
}

/**
 * Комнаты, чьи контейнеры сейчас живут на этой машине, — по метке docker.
 *
 * Не то же самое, что `runningRoomKernels()`: та карта заполняется только
 * подъёмами ЭТОГО процесса, так что после перезапуска сервера контейнеры
 * вчерашних семинаров переставали существовать для уборки простоя и жили до
 * `make down`. Метку ставит `docker run` ниже, и она переживает нас.
 */
export async function listRoomKernels(): Promise<Array<{ session: string; running: boolean; own: boolean }>> {
  if (kernelBackend() === 'broker') return (await kernelRuntimeClient().rooms()).map(room => ({session:room.sessionId,running:room.phase === 'ready' || room.phase === 'pending',own:false}))
  if (kernelBackend() === 'test') return []
  /*
   * По ЗАНЯТИЯМ, а не по контейнерам: их у комнаты два.
   *
   * Строка на контейнер означала бы, что уборка простоя разбирает одну и ту же
   * комнату дважды, а панель считает её живой дважды. Живая — если жив хотя бы
   * один из двух: контейнер личных тетрадей стоит, а лекция считает — это
   * работающее занятие, и отсчёт двух часов ему ещё рано.
   */
  const rooms = new Map<string, { running: boolean; own: boolean }>()
  for (const room of await roomContainers()) {
    if (room.session.length === 0) continue
    const seen = rooms.get(room.session) ?? { running: false, own: false }
    seen.running ||= room.running
    // Есть ли у занятия второй контейнер — спрашивается ЗДЕСЬ, одним и тем же
    // `docker ps`. Панель ресурсов иначе звала бы `inspect` на каждую живую
    // комнату вслепую, чтобы в половине случаев узнать «такого контейнера нет».
    seen.own ||= room.role === 'own'
    rooms.set(room.session, seen)
  }
  return [...rooms].map(([session, seen]) => ({ session, ...seen }))
}

/** Комната и срез, который держит её контейнер; срез пустой — комната без GPU. */
interface RoomContainer {
  session: string
  gpu: string
  /** Контейнер занятия или его личных тетрадей; метки нет — значит занятия. */
  role: KernelRole
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
    '{{.Label "colloq.session"}}\t{{.Label "colloq.gpu"}}\t{{.State}}\t{{.Label "colloq.role"}}',
  ])
  if (res.code !== 0) return []
  return res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [session, gpu, state, role] = line.split('\t')
      return {
        session: (session ?? '').trim(),
        gpu: (gpu ?? '').trim(),
        running: (state ?? '').trim() === 'running',
        // Пусто или `<no value>` — контейнер, поднятый до появления метки, то
        // есть комнатный. Молчание здесь и есть обратная совместимость.
        role: (role ?? '').trim() === 'own' ? 'own' : 'room',
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
 * Сеть, в которую ставить контейнер комнаты.
 *
 * Под `make run` сервер на хосте, порт публикуется на хостовой петле, и
 * `127.0.0.1:<порт>` — верный адрес. Под `make up` сервер сам в контейнере, и
 * та же строка указывает на него самого: до петли хоста ему хода нет, а
 * host-gateway не спасает — порт привязан к 127.0.0.1, а не к мосту. Дорога
 * там одна: общая сеть compose и обращение по имени контейнера. Тогда порт не
 * публикуется вовсе — и Jupyter комнаты не виден с хоста никому, что строго
 * лучше прежнего. Имя сети знает только тот, кто нас запустил: `KERNEL_NETWORK`.
 *
 * На хосте комнаты больше не стоят в `bridge` по умолчанию, а живут в своей
 * сети `colloq-rooms` (18.09.2026): у неё известная подсеть, и запрет на
 * локальные адреса пишется ровно по ней, не задевая чужие контейнеры машины
 * (perimeter.ts). В контейнерной форме сеть остаётся общей с сервером — иначе
 * до ядра не дойти по имени; подсеть её perimeter.ts читает у docker.
 *
 * Признак «сервер в контейнере» — тот же, по которому берётся путь монтирования.
 */
function roomNetwork(): string {
  return inContainer() ? (process.env.KERNEL_NETWORK ?? '').trim() : ROOM_NETWORK
}

/** Как сервер доходит до Jupyter комнаты: портом на своей петле (true) или по имени в общей сети. */
function publishes(): boolean {
  return !inContainer()
}

/** Сеть комнат для perimeter.ts: свою заводим сами, общую — тот, кто нас запустил. */
function perimeterTarget(): RoomNetworkTarget {
  return { network: roomNetwork(), create: publishes() }
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
    /*
     * Контейнер личных тетрадей в раздаче срезов не участвует ВОВСЕ.
     *
     * Метки среза у него нет и быть не может (`runArgs` его вычёркивает), так
     * что фильтр по `gpu` его и так не пропустил бы. Проверка на роль стоит
     * рядом потому, что важно не «сегодня он без метки», а «ему карта не
     * положена»: `pickGpu` считает своим ЛЮБОЙ срез своей комнаты, и метка,
     * попавшая сюда по ошибке, отдала бы карту занятия его черновикам.
     */
    .filter((room) => room.role !== 'own' && room.gpu.length > 0)
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

/** Имя контейнера — тем, кто спрашивает docker о нём напрямую. */
export function roomContainer(sessionId: string, role: KernelRole = 'room'): string {
  return containerFor(sessionId, role)
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
  /**
   * Контейнер занятия или контейнер его личных тетрадей.
   *
   * У второго нет и не может быть ни `--gpus`, ни метки среза, ни `--shm-size`:
   * карта занятия личным тетрадям не даётся, и это не настройка, а устройство —
   * см. shared/rules.ts · bookHasOwnKernel. Всё остальное то же самое: тот же
   * образ, та же сеть, тот же укреплённый профиль, та же папка занятия и те же
   * числа памяти и ядер — но свой cgroup и свой токен.
   */
  role?: KernelRole
  /** Сеть комнаты: `colloq-rooms` на хосте, KERNEL_NETWORK в контейнерной форме. */
  network: string
  /**
   * Публиковать ли Jupyter на петле хоста — так до него доходит сервер,
   * живущий на хосте. В контейнерной форме сервер ходит по имени в общей сети,
   * и порт не публикуется вовсе.
   */
  publish: boolean
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
  const { sessionId, env, mount, network, publish } = opts
  const role = opts.role ?? 'room'
  // Срез — только у контейнера занятия. Не «если передали», а «если можно»:
  // ошибка вызывающего не должна уметь отдать карту личным тетрадям.
  const gpu = role === 'own' ? null : opts.gpu
  const memory = opts.memoryMb ? memSpec(opts.memoryMb) : memoryLimit(env)
  const cpus = opts.cpus && opts.cpus > 0 ? opts.cpus : defaultCpus()
  const threads = threadLimit(cpus)
  return [
    'run',
    '-d',
    '--name',
    containerFor(sessionId, role),
    /*
     * Своя сеть комнат (на хосте) или общая сеть compose (сервер сам в
     * контейнере) — и в любой из них действует запрет на локальные адреса
     * (perimeter.ts).
     */
    ...(network ? ['--network', network] : []),
    /*
     * Порт на петле хоста — только когда сервер на хосте. Петля тут не
     * украшение: без неё Jupyter комнаты открыт на всех интерфейсах, а Wi-Fi
     * аудитории — один из них. В контейнерной форме порт не публикуется вовсе.
     */
    ...(publish ? ['-p', '127.0.0.1:0:8888'] : []),
    /*
     * Укреплённый профиль — всегда, а не только когда занятие открыто наружу:
     * uid 1000, никаких capabilities, no-new-privileges, потолок процессов,
     * без IPv6, метка версии профиля (perimeter.ts · roomHardeningArgs).
     */
    ...roomHardeningArgs(process.env, role),
    // Один срез, названный так, как его зовёт docker. Комната на обычном
    // окружении сюда не попадает и устройства не занимает.
    ...(gpu ? ['--gpus', `device=${gpu}`] : []),
    '-e',
    `JUPYTER_TOKEN=${roomToken(sessionId, role)}`,
    // Ядер у комнаты столько, сколько ей выдали, — и потоков столько же. Но
    // только на момент `docker run`: `docker update --cpus` меняет квоту живому
    // контейнеру, а его переменные окружения — нет (см. applyCpuLimit).
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
    /*
     * Каким представлением plotly отдаёт фигуру — и почему это решается здесь,
     * а не в образе.
     *
     * Без переменной plotly выбирает рендерер сам, по окружению, и выбирает
     * по-разному в разных версиях: 7.x в ipykernel отдаёт один
     * `application/vnd.plotly.v1+json` (это то, что нужно), а 5.x — ещё и
     * `text/html`, причём первым кадром высылает ВЕСЬ бандл plotly.js, пять
     * мегабайт скрипта, который мы всё равно не исполняем. Разница не наша и
     * меняется от образа к образу.
     *
     * Переменная процесса ядра — самый ненавязчивый способ навести здесь
     * порядок: она действует на ЧУЖОЕ окружение, собранное кем угодно и когда
     * угодно, не требуя ни пересборки образа, ни импорта plotly, ни единой
     * строки, выполненной в ядре до кода студента. И перебить её студент может
     * одной строкой (`pio.renderers.default = …`) — то есть это умолчание, а
     * не запрет.
     *
     * В образе (kernel/Dockerfile) она стоит тоже: контейнер поднимает не
     * только этот код — есть ещё compose и арендованные машины.
     */
    '-e',
    'PLOTLY_RENDERER=plotly_mimetype',
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
    /*
     * Чей это контейнер — занятия или его личных тетрадей.
     *
     * Ставится ОБОИМ, в том числе комнатному, где значение и так подразумевалось
     * бы: метка нужна уборке, раздаче срезов и `colloq status`, а читают они
     * `docker ps` — то есть и вчерашние контейнеры, поднятые процессом, которого
     * больше нет. Отсутствие метки читается как `room` (см. `KernelRole`), так
     * что живые контейнеры выкатку переживают без пересоздания.
     */
    '--label',
    `colloq.role=${role}`,
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
 *
 * Под брокером (k3s) — то же самое руками Kubernetes: брокер меняет память
 * живого Pod через подресурс `pods/resize`, Pod и его Python остаются. До 18.09
 * здесь стоял ранний `pending`, и поле памяти на k3s не делало ничего вовсе:
 * ни живой комнате, ни следующему Pod — брокер числа не принимал.
 *
 * `null` — «как у окружения». Docker его здесь не трогает (прежнее поведение:
 * умолчание возьмёт следующий `docker run`), а брокер возвращает Pod к своему
 * умолчанию сразу — ровно как сброс ядер.
 */
export async function applyMemoryLimit(sessionId: string, mb: number | null): Promise<LimitOutcome> {
  if (!limitsInjected && kernelBackend() === 'broker') return resizeRoomPod(sessionId, { memoryMb: mb })
  // Сброс docker ждёт следующего `docker run` — и без похода к демону: до
  // брокерной правки маршрут с `null` сюда не звал вовсе.
  if (mb === null) return 'pending'
  if (!limitsInjected) {
    // Под тестовым бэкендом контейнеров нет вовсе — число ждёт следующего пуска.
    if (kernelBackend() !== 'docker') return 'pending'
    if (!(await canIsolate())) return 'pending'
  }
  const spec = memSpec(mb)
  /*
   * Комнате — её число, личным тетрадям — их (`ownLimits`).
   *
   * Пока у личных тетрадей своего числа нет, им достаётся то же самое; как
   * только преподаватель его назвал, поле «Память» занятия их не касается
   * вовсе — иначе одно нажатие в настройках занятия молча отменяло бы то, что
   * он выбрал им отдельно.
   */
  const own = ownLimits(sessionId).memoryMb
  const ownSpec = own === null ? spec : memSpec(own)
  return bothContainers(sessionId, `${spec} памяти`, (container, role) => {
    const use = role === 'own' ? ownSpec : spec
    return limitsDocker(['update', `--memory=${use}`, `--memory-swap=${use}`, container], 30_000)
  })
}

/**
 * Числа личных тетрадей — их контейнеру, и только ему.
 *
 * Зовётся там, где меняется правило (routes/sessions.ts, routes/admin-instance.ts):
 * преподаватель выбрал, сколько отсыпать студентам, и ждёт, что это подействует
 * сейчас, а не после того, как занятие однажды закроют. Контейнер комнаты эта
 * дорога не трогает НИКОГДА: его число — поле «Память» занятия, и менять его
 * отсюда значило бы отдать студентам память преподавателя тем самым нажатием,
 * которым он ограничивал их.
 *
 * `null` в правиле — «как у занятия», и тогда контейнеру достаётся число
 * комнаты; так он возвращается к общему лимиту без второго поля-выключателя.
 */
export async function applyOwnLimits(sessionId: string): Promise<LimitOutcome> {
  if (!limitsInjected && kernelBackend() !== 'docker') return 'pending'
  if (!limitsInjected && !(await canIsolate())) return 'pending'
  const { memoryMb, cpus } = ownLimits(sessionId)
  const spec = memSpec(memoryMb ?? defaultMemoryMb(false))
  const cores = cpus ?? defaultCpus()
  return bothContainers(
    sessionId,
    `${spec} памяти и ${cores} ядер личным тетрадям`,
    (container) =>
      limitsDocker(
        ['update', `--memory=${spec}`, `--memory-swap=${spec}`, `--cpus=${cores}`, container],
        30_000,
      ),
    ['own'],
  )
}

/**
 * Выданное число — ОБОИМ контейнерам комнаты, каждому своё, и одним исходом.
 *
 * Поле в форме занятия называется «Память» и говорит про комнату. Пока
 * личным тетрадям не назначили своего числа, им достаётся то же самое:
 * преподаватель, поднявший семинару восемь гигабайт, вправе ожидать, что
 * черновики его студентов не продолжат умирать на четырёх. Назначили — второй
 * контейнер живёт по своему числу и на изменение комнатного не отзывается
 * (`ownLimits`). cgroup у них раздельные в любом случае: в том и смысл
 * второго контейнера.
 *
 * «Контейнера нет» — обычное дело и не отказ: личных тетрадей в занятии может
 * не быть вовсе, комнату могли ещё не открывать сегодня. Исход считается по
 * тому, что удалось: хоть один живой контейнер принял — `applied`; не нашлось
 * ни одного — `pending`, то есть «возьмёт при пуске»; ответил ошибкой — `failed`,
 * и она же уходит в журнал.
 */
async function bothContainers(
  sessionId: string,
  shown: string,
  update: (container: string, role: KernelRole) => Promise<RunResult>,
  roles: readonly KernelRole[] = ['room', 'own'],
): Promise<LimitOutcome> {
  let applied = false
  let failed = false
  for (const role of roles) {
    const container = containerFor(sessionId, role)
    const res = await update(container, role)
    if (res.code === 0) {
      applied = true
      continue
    }
    if (/no such container/i.test(res.out)) continue
    failed = true
    console.error(`[kernel] docker update для ${container} не удался: ${res.out.slice(-200)}`)
  }
  if (applied) {
    console.log(`[kernel] комнате ${sessionId} выдано ${shown} на живых контейнерах`)
    return 'applied'
  }
  if (failed) return 'failed'
  console.log(`[kernel] комнате ${sessionId} записано ${shown}; контейнера нет, возьмёт при пуске`)
  return 'pending'
}

/** Память или ядра живого Pod комнаты через брокер — ответ брокера в словах пула. */
async function resizeRoomPod(
  sessionId: string,
  change: { memoryMb: number | null } | { cpus: number | null },
): Promise<LimitOutcome> {
  const [value] = Object.values(change)
  const shown =
    'memoryMb' in change
      ? value === null ? 'умолчание брокера памяти' : `${value} МБ памяти`
      : value === null ? 'умолчание брокера ядер' : `${value} ядер`
  try {
    const result = await kernelRuntimeClient().resize(sessionId, change)
    if (result.outcome === 'applied') {
      console.log(`[kernel] комнате ${sessionId} выдано ${shown} на живом Pod`)
      return 'applied'
    }
    // absent — Pod нет, возьмёт следующий подъём; pending — узлу сейчас нечем
    // (Deferred), kubelet применит сам, когда соседняя комната освободит своё.
    console.log(`[kernel] комнате ${sessionId} записано ${shown}; Pod: ${result.outcome}`)
    return 'pending'
  } catch (err) {
    console.error(`[kernel] брокер не выдал комнате ${sessionId} ${shown}: ${err instanceof Error ? err.message.slice(0, 300) : err}`)
    return 'failed'
  }
}

/**
 * Поднять (или опустить) число ядер живой комнате — на обоих бэкендах сразу.
 *
 * `docker update --cpus` меняет cgroup работающего контейнера, и ядру от этого
 * становится просторнее в ту же секунду. Под брокером (k3s) то же самое делает
 * подресурс `pods/resize`: Pod, его UID и Python остаются. До 18.09 здесь под
 * брокером стоял ранний `pending`, подсказка обещала «после перезапуска ядра»,
 * а на деле ядра доезжали, только когда следующий подъём сносил Pod целиком —
 * вместе со всеми переменными семинара.
 *
 * Оговорка одна, и она честная: потоки numpy и torch (OMP_NUM_THREADS и
 * соседи) задаются при СОЗДАНИИ контейнера — `docker run` или новый Pod — и
 * живому контейнеру их не поменять. Перезапуск ядра Jupyter тут не помогает:
 * новый Python наследует окружение сервера в том же контейнере. Новое число
 * потоков получит следующий контейнер комнаты. Об этом сказано в подсказке
 * под полем, а не только здесь.
 *
 * `null` — «как у инстанса»: docker берёт KERNEL_CPUS, брокер — своё
 * умолчание. Swap-подобной пары флагов тут нет: `--cpus` самодостаточен.
 */
export async function applyCpuLimit(sessionId: string, own: number | null): Promise<LimitOutcome> {
  if (!limitsInjected && kernelBackend() === 'broker') return resizeRoomPod(sessionId, { cpus: own })
  const cpus = own ?? defaultCpus()
  if (!limitsInjected) {
    if (kernelBackend() !== 'docker') return 'pending'
    if (!(await canIsolate())) return 'pending'
  }
  // Комнате — её число, личным тетрадям — их; довод у памяти выше.
  const ownCores = ownLimits(sessionId).cpus ?? cpus
  return bothContainers(sessionId, `${cpus} ядер`, (container, role) =>
    limitsDocker(['update', `--cpus=${role === 'own' ? ownCores : cpus}`, container], 30_000),
  )
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
  /** По умолчанию — контейнер занятия: панель показывает комнату, а не черновики. */
  role: KernelRole = 'room',
): Promise<{ memoryMb: number | null; cpus: number | null }> {
  const res = await limitsDocker(
    ['inspect', containerFor(sessionId, role), '--format', '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'],
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

const locallyStoppedRooms = new Set<string>()
function assertLocalRoomRunning(sessionId: string): void {
  if (locallyStoppedRooms.has(sessionId)) throw new Error('Local session is stopping')
}

async function startContainer(
  sessionId: string,
  env: string,
  role: KernelRole = 'room',
  retried = false,
): Promise<KernelEndpoint> {
  assertLocalRoomRunning(sessionId)
  const container = containerFor(sessionId, role)
  const image = `${IMAGE_PREFIX}:${env}`
  const network = roomNetwork()
  /*
   * Срез спрашивается до того, как мы решим переиспользовать контейнер: у
   * комнаты со своим контейнером это тот же срез, что и был, а у новой — либо
   * свободный, либо отказ, и отказать надо раньше, чем `docker start` поднимет
   * ядро без устройства.
   *
   * Контейнер личных тетрадей срезов не спрашивает и не занимает: карта
   * занятия его студентам не даётся (shared/rules.ts · bookHasOwnKernel), и
   * GPU-окружение он поднимает так же, как обычное, — на процессоре.
   */
  const gpu = role !== 'own' && needsGpu(env) ? await takeGpu(sessionId, env) : null
  const state = await stateOf(container)
  assertLocalRoomRunning(sessionId)

  /*
   * Пересоздать контейнер и попробовать ещё раз — ровно один раз.
   *
   * Второй попытки нет намеренно: если и свежесозданный контейнер не отвечает,
   * дело не в нём, и бесконечный круг `rm` + `run` посреди пары хуже честной
   * ошибки на ячейке.
   */
  const recreate = async (why: string): Promise<KernelEndpoint> => {
    assertLocalRoomRunning(sessionId)
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
    if (state === 'running' || state === 'broken') announceRecreate(sessionId, why, role)
    await run(['rm', '-f', container], 60_000)
    endpoints.delete(slotFor(sessionId, role))
    return startContainer(sessionId, env, role, true)
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
    /*
     * Контейнер, поднятый до укреплённого профиля (без метки colloq.profile):
     * с привилегиями docker по умолчанию и в сети без запрета.
     *
     * Остановленный пересоздаётся — терять в нём нечего, кроме пакетов,
     * поставленных в слой (так же, как при пересборке образа), а поднять его
     * `docker start` значило бы снова выпустить ядро со старыми правами.
     * Живой доживает до остановки: снести его — значит отнять у пары все
     * переменные посреди занятия; решение владельца — «до перезапуска».
     */
    const legacy = (await profileOf(container)) !== ROOM_PROFILE
    if (legacy && state === 'stopped') return recreate(tr('server.roomPerimeter.migrated'))
    if (legacy) {
      // Дорога до него прежняя: опубликованный порт на хосте или имя в общей
      // сети. Нет и её — это уже не профиль, а сменившийся режим сервера.
      if (!(await legacyReachable(container, network))) return recreate(tr("server.theServerChangedNetworks.08933e"))
      warnLegacy(sessionId)
    } else if (!(await sameNetwork(container, network))) {
      // Контейнер прошлого режима: адреса, по которому мы теперь его зовём, у
      // него нет — ни имени в нашей сети, ни опубликованного порта.
      return recreate(tr("server.theServerChangedNetworks.08933e"))
    }
    // Контейнер без среза (или с чужим) для GPU-окружения не годится: устройства
    // внутрь него не пробросить иначе как заново.
    if (!(await sameGpu(container, gpu))) return recreate(tr("server.theContainerWasStartedWithADifferent.bc4d7d"))
    if (state === 'stopped') {
      // Запрет на локальные адреса — до того, как ядро проснётся, а не после:
      // не встал он — комната не поднимается (perimeter.ts · RoomPerimeterError).
      await ensureRoomPerimeter(run, perimeterTarget(), image)
      assertLocalRoomRunning(sessionId)
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
    // Сеть комнат заводится здесь же, если её нет, и запрет встаёт раньше
    // первого пакета ядра; не встал — отказ, а не открытая сеть.
    await ensureRoomPerimeter(run, perimeterTarget(), image)
    assertLocalRoomRunning(sessionId)
    const created = await run(
      runArgs({
        sessionId,
        env,
        role,
        mount,
        network,
        publish: publishes(),
        gpu,
        // Те же числа, что у комнаты, — но свой cgroup: «Память» в форме
        // занятия обещает столько каждому его Python, а не столько на двоих.
        // Контейнеру личных тетрадей — его собственные числа: занятие может
        // отсыпать студентам не столько же, сколько взяло себе.
        ...(role === 'own' ? ownLimits(sessionId) : { memoryMb: sessionMemoryMb(sessionId), cpus: sessionCpus(sessionId) }),
      }),
      120_000,
    )
    if (created.code !== 0) {
      // Сеть могли снести между проверкой и запуском: следующая попытка
      // спросит заново, а не поверит запомненному минуту назад.
      if (/network .* not found/i.test(created.out)) perimeterStale()
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

  assertLocalRoomRunning(sessionId)
  let url: string
  if (!publishes()) {
    // Внутри сети слушают тот же 8888, публиковать нечего.
    url = `http://${container}:8888`
  } else {
    const port = await publishedPort(container)
    if (port === null) throw new Error(tr("server.couldNotReadThePublishedPortOf.07ca0a", { p0: container }))
    url = `http://127.0.0.1:${port}`
  }

  const endpoint: KernelEndpoint = { url, token: roomToken(sessionId, role) }

  // Wait for Jupyter inside it to answer. `docker run` returns as soon as the
  // process is spawned, and connecting a second later fails with a bare
  // "fetch failed" that says nothing about why.
  const deadline = Date.now() + 90_000
  let lastError = tr("server.noResponse.187241")
  while (Date.now() < deadline) {
    assertLocalRoomRunning(sessionId)
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

/**
 * Адреса, которые уже разрешили, чтобы занятая комната не звала docker на ячейку.
 *
 * Ключ — слот (`slotFor`), а не занятие: контейнеров у комнаты два, и адрес у
 * каждого свой, с разным портом и разным токеном.
 */
const endpoints = new Map<string, KernelEndpoint>()
/** Один запуск за раз на СЛОТ, общий для одновременных вызовов. */
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
  /**
   * Контейнер занятия или контейнер его личных тетрадей.
   *
   * Под брокером второго нет: Pod он заводит один на занятие, и завести рядом
   * второй — это правка его протокола, его контроллера и его прав в кластере.
   * Отказ честнее подмены: личная тетрадь, тихо посчитанная в ядре лекции,
   * означала бы ровно то, ради чего второй контейнер и заводится, — чужую
   * карту и чужой OOM. Отказ читается в kernel/index.ts.
   */
  role: KernelRole = 'room',
): Promise<KernelEndpoint> {
  requireKernelIsolation()
  assertLocalRoomRunning(sessionId)
  if (kernelRetirementInProgress(sessionId)) throw new Error(tr("server.cannotStartKernelSeminarIsStopping.9820e1"))
  const backend = kernelBackend()
  if (backend === 'test') return defaultEndpoint()
  if (role === 'own' && backend !== 'docker') throw new OwnKernelUnavailable()
  if (backend === 'broker') {
    if (!sessionRowExists(sessionId)) throw new Error(tr("server.cannotStartKernelSeminarDoesNotExist.4f72c5"))
    sessionDir(sessionId)
    const previous = sessionKernelRevision(sessionId)
    const selected = runtimeEnvironment(sessionEnvironment(sessionId), previous)
    const revision = pinSessionKernelRevision(sessionId, selected.name, imageRevision(selected.image))
    const pinned = runtimeEnvironment(sessionEnvironment(sessionId), revision)
    const starts = brokerStarts.get(sessionId) ?? new Set<Promise<KernelEndpoint>>()
    brokerStarts.set(sessionId, starts)
    const attempt = kernelRuntimeClient().ensure(
      sessionId, pinned.name, revision, sessionCpus(sessionId), sessionMemoryMb(sessionId),
    )
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

  assertLocalRoomRunning(sessionId)
  const slot = slotFor(sessionId, role)
  const cached = endpoints.get(slot)
  if (cached) return cached

  const inFlight = starting.get(slot)
  if (inFlight) return inFlight

  const name = (env ?? '').trim() || activeName()
  const attempt = startContainer(sessionId, name, role)
    .then((endpoint) => {
      endpoints.set(slot, endpoint)
      return endpoint
    })
    .finally(() => {
      starting.delete(slot)
      // Бронь свою работу сделала: либо контейнер уже несёт метку со срезом,
      // либо контейнера нет и срез свободен. Пережить подъём она не должна —
      // иначе неудачная сборка окружения забирает срез у следующего семинара
      // насовсем.
      reserved.delete(sessionId)
      // Комнату закрыли, пока это поднималось: контейнер (успешный или
      // недоделанный) убираем сами — за него больше некому.
      if (abandoned.delete(slot)) void discardSlot(slot)
    })
  starting.set(slot, attempt)
  return attempt
}

async function discardSlot(slot: string): Promise<void> {
  endpoints.delete(slot)
  const container = containerOfSlot(slot)
  try {
    await run(['rm', '-f', container], 60_000)
  } catch (err) {
    console.error(`[kernel] не удалось убрать контейнер ${container}:`, err)
  }
}

/** Имя контейнера по слоту — одной строкой, чтобы разбор ключа жил в одном месте. */
const containerOfSlot = (slot: string): string =>
  containerFor(sessionOfSlot(slot), slot.endsWith('#own') ? 'own' : 'room')

/** Оба слота комнаты, в порядке «сначала занятие»: порядок виден в журнале. */
const slotsOf = (sessionId: string): string[] => [
  slotFor(sessionId, 'room'),
  slotFor(sessionId, 'own'),
]

/**
 * Убрать контейнеры комнаты насовсем — ОБА.
 *
 * Зовётся при удалении семинара и при уборке простоя. Файлы лежат на хосте, в
 * папке комнаты, и переживают это — уходит только Python со всеми переменными.
 *
 * Контейнер личных тетрадей уходит вместе с комнатным, и по той же причине:
 * занятие кончилось. Отдельно его убирает `dropOwnKernel` — когда в нём не
 * осталось ни одного живого ядра, а само занятие продолжается.
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
  for (const slot of slotsOf(sessionId)) endpoints.delete(slot)
  if (!(await canIsolate())) return
  for (const slot of slotsOf(sessionId)) {
    // Подъём, идущий прямо сейчас, положил бы контейнер обратно секундой позже:
    // помечаем слот, и подъём, закончившись, снесёт его сам.
    if (starting.has(slot)) abandoned.add(slot)
    await run(['rm', '-f', containerOfSlot(slot)], 60_000)
  }
}

/**
 * Убрать ТОЛЬКО контейнер личных тетрадей — занятие при этом продолжается.
 *
 * Зовётся, когда в нём погасло последнее ядро: держать пустой контейнер на
 * каждое занятие, где кто-то однажды открыл черновик, значит копить их ровно
 * так же, как копились комнатные до появления уборки простоя. Комнатный
 * контейнер эта дорога не трогает НИКОГДА — ни его Python, ни его терминал.
 */
export async function dropOwnKernel(sessionId: string): Promise<void> {
  if (kernelBackend() !== 'docker') return
  const slot = slotFor(sessionId, 'own')
  endpoints.delete(slot)
  if (!(await canIsolate())) return
  if (starting.has(slot)) abandoned.add(slot)
  await run(['rm', '-f', containerFor(sessionId, 'own')], 60_000)
}

/** Забыть разрешённый адрес, чтобы следующее открытие перепроверило контейнер. */
export function forgetSessionKernel(sessionId: string, role: KernelRole = 'room'): void {
  endpoints.delete(slotFor(sessionId, role))
}

/**
 * Комнаты, для которых этот процесс поднял хоть один контейнер. Нужно панели и
 * уборке — и обе считают ЗАНЯТИЯ, а не контейнеры.
 */
export function runningRoomKernels(): string[] {
  return [...new Set([...endpoints.keys()].map(sessionOfSlot))]
}

/** Local supervisor shutdown; independent of network readiness and never deletes files. */
export async function dropLocalRoomKernel(sessionId: string): Promise<void> {
  if (kernelBackend() === 'test') return
  if (kernelBackend() !== 'docker') throw new Error('Local cleanup requires KERNEL_BACKEND=docker')
  locallyStoppedRooms.add(sessionId)
  const release = blockKernelStarts(sessionId)
  try {
    // A Docker create already sent to the daemon must settle before rm; checks
    // throughout startup prevent any later create or readiness retry.
    await Promise.allSettled(slotsOf(sessionId).map((slot) => starting.get(slot)))
    for (const slot of slotsOf(sessionId)) {
      endpoints.delete(slot)
      const result = await run(['rm', '-f', containerOfSlot(slot)], 60_000)
      if (result.code !== 0 && !/No such container/i.test(result.out)) throw new Error(result.out)
    }
  } finally { release() }
}
