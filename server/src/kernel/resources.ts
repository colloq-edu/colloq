/**
 * Что за машина под инстансом — и кому из комнат сколько на ней отдано.
 *
 * 13.09 семинар шестнадцать раз подряд потерял ядро по памяти, и узнать об
 * этом можно было только по `dmesg`: лимит был один на все комнаты, жил в
 * переменной окружения и нигде в продукте не показывался. Поднять его одной
 * комнате было нечем, а поднять всем — значило отдать шестнадцать гигабайт
 * десяти семинарам, которым хватает двух.
 *
 * Отсюда этот модуль: он отвечает на три вопроса, без которых поле «сколько
 * памяти» — гадание. Сколько её на машине вообще, сколько свободно прямо
 * сейчас, и что уже роздано живым комнатам. Плюс карта, потому что окружение с
 * GPU просит памяти втрое больше обычного, и преподаватель должен видеть, на
 * чём именно он ставит семинар.
 *
 * Ничего здесь не бросает. Все три источника — /proc, `nvidia-smi`, docker —
 * на чужой машине могут отсутствовать, отвечать мусором или висеть; тогда
 * форма семинара просто не покажет подсказку, а не сломается целиком.
 */
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { db, sessionMemoryMb } from '../db.js'
import { listNames, needsGpu } from '../environments.js'
import { containerLimits, defaultCpus, defaultMemoryMb, dockerRead, listRoomKernels, memoryLimitMb } from './pool.js'
import { kernelBackend, kernelRuntimeClient } from './runtime-client.js'
import type { GpuCard, InstanceResources, RoomResource } from '@shared/admin'
import type { RuntimeRoom } from '@shared/runtime'

const MB = 1024 * 1024

/*
 * Форма ответа живёт в shared/admin.ts вместе с остальным, что панель читает:
 * один описанный контракт на сервер и браузер, а не два похожих.
 */
export type { GpuCard, InstanceResources, RoomResource } from '@shared/admin'
type Collected = Omit<InstanceResources, 'limits'>

/* --------------------------------------------------------------- память */

/**
 * Сколько памяти свободно у САМОЙ машины — по мнению её ядра, а не `freemem`.
 *
 * `os.freemem()` не годится ни на одной из двух систем. На Linux это память,
 * не занятая НИЧЕМ, включая кеш страниц: на работающем сервере она всегда
 * близка к нулю, и подсказка «свободно 0,4 ГБ» из 72 честно напугала бы
 * преподавателя на пустой машине. MemAvailable — оценка самого ядра «сколько
 * можно занять, не уходя в swap», и это ровно тот вопрос, который задаёт форма
 * семинара. На macOS `freemem` врёт грубее: система считает свободными только
 * страницы, не занятые ничем, а inactive и purgeable — те, что она отдаёт по
 * первому требованию, — в это число не входят. На Маке с 36 ГБ, где занято
 * хорошо если половина, форма показывала «свободно 0,5 ГБ» и красила поле
 * предупреждением на любом лимите.
 *
 * Поэтому там, где своего /proc нет, ответ — `null`, «не знаю»: форма про
 * свободное тогда молчит. Молчание честнее числа, которое пугает зря.
 */
function hostAvailableMb(): number | null {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)
    if (match) return Math.floor(Number(match[1]) / 1024)
  } catch {
    /* не Linux, или /proc не смонтирован — ниже честное «не знаю» */
  }
  return null
}

/* ----------------------------------------------------------- демон docker */

/**
 * Машина, на которой ядра комнат живут НА САМОМ ДЕЛЕ.
 *
 * На Linux демон docker — то же самое ядро, и его числа совпадают с `os.*`. На
 * Маке и на Windows между ними стоит виртуалка: `colima start --memory 12` —
 * это двенадцать гигабайт на все контейнеры разом, сколько бы их ни было у
 * Мака. Потолок комнаты ставит тот, кто её запускает, поэтому спрашивать надо
 * его: шестнадцатого гигабайта контейнеру в такой виртуалке взять неоткуда,
 * а форма занятия по памяти Мака предлагала бы тридцать пять и принимала их —
 * то есть обещала бы ядро, которое убьют по памяти на первой тяжёлой ячейке.
 */
interface Daemon {
  totalMb: number
  /** `NCPU` демона: у виртуалки это её доля ядер, а не все ядра Мака. */
  cpus: number
}

/** «12514811904 10» — байты памяти демона и его ядра. */
export function parseDaemonInfo(out: string): Daemon | null {
  const [bytes, cores] = out.trim().split(/\s+/)
  const totalMb = Math.floor(Number(bytes) / MB)
  const cpus = Math.floor(Number(cores))
  // Ноль и мусор — это «не знаю», а не «нисколько»: нисколько уехало бы в
  // границы поля и не дало бы задать комнате ничего.
  if (!Number.isFinite(totalMb) || totalMb <= 0) return null
  return { totalMb, cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 0 }
}

/*
 * Спрашивается раз в минуту, а не на каждый запрос.
 *
 * `docker info` — это раунд к демону: тридцать миллисекунд на здоровой машине
 * и вечность на повисшей. Меняется ответ ровно тогда, когда колиму
 * перезапустили с другой памятью, — минуты хватает, чтобы это доехало до формы,
 * и хватает, чтобы панель нескольких преподавателей не превратилась в поток
 * процессов docker. Отказ помнится наравне с успехом: демон лежит — значит,
 * минуту отвечаем числами машины, а не зовём его снова на каждый PATCH.
 */
const DAEMON_TTL_MS = 60_000
let seenDaemon: Daemon | null = null
let seenAt = 0
let daemonInflight: Promise<Daemon | null> | null = null

type DockerRead = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>
let askDocker: DockerRead = dockerRead
let dockerInjected = false

/**
 * Подменить docker — тестам.
 *
 * Ровно как `useDockerForLimits` в pool.ts и по той же причине: настоящего
 * docker в сюите нет, а проверять надо то, что бывает только с ним.
 */
export function useDockerInfo(fake: DockerRead | null): void {
  askDocker = fake ?? dockerRead
  dockerInjected = fake !== null
}

/** Что говорит о себе демон — с кешем и без единого исключения наружу. */
export function readDaemon(): Promise<Daemon | null> {
  // Под брокером контейнерами распоряжаемся не мы, под тестовым бэкендом их
  // нет вовсе: спрашивать некого, и числа остаются машинные.
  if (kernelBackend() !== 'docker' && !dockerInjected) return Promise.resolve(null)
  if (seenAt && Date.now() - seenAt < DAEMON_TTL_MS) return Promise.resolve(seenDaemon)
  daemonInflight ??= askDocker(['info', '--format', '{{.MemTotal}} {{.NCPU}}'], 3_000)
    .then((res) => (res.code === 0 ? parseDaemonInfo(res.out) : null))
    .catch(() => null)
    .then((value) => {
      seenDaemon = value
      seenAt = Date.now()
      return value
    })
    .finally(() => {
      daemonInflight = null
    })
  return daemonInflight
}

/**
 * Последнее, что сказал демон, — для границ, которые считаются синхронно.
 *
 * Дверь `/api/instance/resources` считает границы ПОСЛЕ сбора, так что там
 * число всегда свежее. А PATCH лимита комнаты приходит и на холодный сервер;
 * ждать в нём docker незачем — проверка в этот раз пройдёт по числам машины,
 * то есть мягче, чем надо, зато запрос не встанет на секунды из-за
 * неотвечающего демона. Заодно греется кеш к следующему такому запросу.
 */
function lastDaemon(): Daemon | null {
  void readDaemon()
  return seenDaemon
}

/* ---------------------------------------------------------------- брокер */

/**
 * Память комнаты на k3s — число брокера, а не переменных окружения веба.
 *
 * Под брокером Pod комнаты собирает он, и умолчание у него своё
 * (RUNTIME_KERNEL_MEMORY, 2Gi из коробки), одно на все окружения. Форма же
 * подписывала поле умолчаниями docker-пути — «4 ГБ, на GPU 16», — которых Pod
 * не получал никогда. И потолок у брокера свой: узел минус гигабайт или
 * RUNTIME_KERNEL_MEMORY_MAX оператора. Оба числа он отдаёт в /v1/health.
 */
interface BrokerMemory {
  defaultMb: number | null
  maxMb: number | null
}
/*
 * Если брокер ещё ни разу не ответил — его заводское умолчание. Врать тут
 * нечем лучше: оператор, поменявший RUNTIME_KERNEL_MEMORY, увидит своё число,
 * как только брокер ответит, а до того форма хотя бы не обещает 4 ГБ там, где
 * Pod получит два.
 */
const BROKER_FACTORY_DEFAULT_MB = 2048
const BROKER_TTL_MS = 60_000
let seenBroker: BrokerMemory = { defaultMb: null, maxMb: null }
let brokerAt = 0
let brokerInflight: Promise<void> | null = null

/** Запомнить, что сказал брокер о памяти; молчание о поле не стирает прошлое. */
function rememberBroker(health: { defaultMemoryMb?: number; maxMemoryMb?: number }): void {
  seenBroker = {
    defaultMb: health.defaultMemoryMb ?? seenBroker.defaultMb,
    maxMb: health.maxMemoryMb ?? seenBroker.maxMb,
  }
  brokerAt = Date.now()
}

/**
 * Последнее, что брокер сказал о памяти, — для синхронных границ.
 *
 * Тем же устройством, что `lastDaemon`: PATCH лимита не ждёт брокера, а греет
 * кеш к следующему разу. Форма и так спрашивает /api/instance/resources при
 * открытии, так что к моменту, когда в поле что-то набрали, число свежее.
 */
function lastBroker(): BrokerMemory {
  if (kernelBackend() === 'broker' && (!brokerAt || Date.now() - brokerAt >= BROKER_TTL_MS)) {
    brokerInflight ??= (async () => {
      try {
        rememberBroker(await kernelRuntimeClient().health())
      } catch {
        /* брокер не настроен или лежит — остаёмся на прошлом */
      }
    })().finally(() => {
      brokerInflight = null
    })
  }
  return seenBroker
}

/** Умолчание комнаты под брокером — одно на все окружения, как у него самого. */
function brokerDefaultMb(): number {
  return lastBroker().defaultMb ?? BROKER_FACTORY_DEFAULT_MB
}

export interface MemoryPicture {
  totalMb: number
  /** Сколько ещё можно раздать; `null` — «честно не знаем». */
  availableMb: number | null
  /** Чьи это числа: машины сервера или демона docker. */
  source: 'host' | 'docker'
}

/**
 * Два числа формы — из того источника, который про них знает.
 *
 * «Тот же ли это компьютер» решается числом, а не платформой: у нативного
 * демона памяти ровно столько же, сколько у машины, у виртуалки колимы — своя,
 * а DOCKER_HOST может смотреть и вовсе на соседний сервер. Шестнадцатая доля
 * допуска — на расхождение в том, что каждая сторона считает «всей памятью».
 */
export function memoryPicture(input: {
  daemonTotalMb: number | null
  hostTotalMb: number
  hostAvailableMb: number | null
  takenMb: number
}): MemoryPicture {
  const { daemonTotalMb, hostTotalMb, hostAvailableMb, takenMb } = input
  const sameMachine =
    daemonTotalMb !== null && Math.abs(daemonTotalMb - hostTotalMb) <= hostTotalMb / 16
  if (daemonTotalMb === null || sameMachine) {
    return { totalMb: hostTotalMb, availableMb: hostAvailableMb, source: 'host' }
  }
  /*
   * Свободное у виртуалки не спросить: /proc у неё свой, внутрь мы не ходим, а
   * MemAvailable Мака к её двенадцати гигабайтам отношения не имеет. Зато
   * известно ровно то, что нужно преподавателю: сколько ещё можно РАЗДАТЬ —
   * потолок демона минус гигабайт ему самому (тот же, что в границах ниже)
   * минус то, что уже обещано живым комнатам.
   */
  return {
    totalMb: daemonTotalMb,
    availableMb: Math.max(0, daemonTotalMb - HOST_RESERVE_MB - takenMb),
    source: 'docker',
  }
}

/* ------------------------------------------------------------------ GPU */

/**
 * Карты машины — у `nvidia-smi`, если он на ней есть.
 *
 * Ни ошибки, ни отсутствия бинарника наружу не выходит: пустой список значит
 * «карт не видно», и форма семинара про GPU тогда молчит. Таймаут короткий и
 * настоящий (kill, а не только reject): `nvidia-smi` на машине с повисшим
 * драйвером не возвращается никогда, а это чтение висит на запросе панели.
 */
function readGpus(): Promise<GpuCard[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('nvidia-smi', [
        '--query-gpu=index,name,memory.total',
        '--format=csv,noheader,nounits',
      ])
    } catch {
      resolve([])
      return
    }
    let out = ''
    let done = false
    const finish = (cards: GpuCard[]): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(cards)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish([])
    }, 3_000)
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', () => finish([]))
    child.on('close', (code) => finish(code === 0 ? parseGpus(out) : []))
  })
}

/** «0, NVIDIA GeForce RTX 3090, 24576» — по строке на карту. */
export function parseGpus(out: string): GpuCard[] {
  const cards: GpuCard[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 3) continue
    const index = Number(parts[0])
    const memoryMb = Number(parts[2].replace(/[^\d]/g, ''))
    if (!Number.isFinite(index) || !parts[1]) continue
    cards.push({ index, name: parts[1], memoryMb: Number.isFinite(memoryMb) ? memoryMb : 0 })
  }
  return cards
}

/* ---------------------------------------------------------------- комнаты */

interface RoomRow {
  id: string
  name: string
  environment: string | null
  memory_mb: number | null
  cpus: number | null
}

/**
 * Комнаты, о которых стоит говорить: живые и те, кому память задали руками.
 *
 * Не все подряд: на семестре их шестьдесят, и список «кто держит машину» из
 * шестидесяти строк, пятьдесят девять из которых спят, отвечает не на тот
 * вопрос. Потолок стоит на всякий случай — панель этот список рисует.
 */
const selectRooms = db.prepare(
  'SELECT id, name, environment, memory_mb, cpus FROM sessions ORDER BY created_at DESC LIMIT 200',
)

async function rooms(instanceCpus: number, runtimeRooms?: RuntimeRoom[]): Promise<RoomResource[]> {
  let alive: Set<string>
  /*
   * У кого из занятий есть ВТОРОЙ контейнер — тот, где живут личные тетради.
   *
   * Спрашивается тем же `docker ps`, что и список живых: иначе панель звала бы
   * `inspect` на каждую живую комнату вслепую, чтобы у половины узнать «такого
   * контейнера нет». Под брокером второго контейнера не бывает вовсе.
   */
  let withOwn = new Set<string>()
  try {
    if (runtimeRooms) {
      alive = new Set(runtimeRooms.filter((room) => room.phase === 'ready' || room.phase === 'pending').map((room) => room.sessionId))
    } else {
      const census = await listRoomKernels()
      alive = new Set(census.filter((r) => r.running).map((r) => r.session))
      withOwn = new Set(census.filter((r) => r.own).map((r) => r.session))
    }
  } catch {
    alive = new Set()
  }
  const rows = selectRooms.all() as RoomRow[]
  const interesting = rows
    .filter((row) => alive.has(row.id) || row.memory_mb !== null || row.cpus !== null)
    .slice(0, 50)
  return Promise.all(
    interesting.map(async (row) => {
      const settledMb = row.memory_mb ?? envDefaultMb(row.environment)
      const settledCpus = row.cpus ?? instanceCpus
      /*
       * У живой комнаты спрашивается docker, а не строка семинара: разойтись
       * они могут ровно тогда, когда это важно — лимит подняли между парами, а
       * контейнер с утра работает на старом. Показывать надо то, что у неё
       * есть, а не то, что ей записали. Оба числа одним `inspect`: список
       * зовёт его на каждую живую комнату.
       */
      // Под брокером то же правило: перепись комнат отдаёт память из status
      // Pod — то, что kubelet выставил, а не то, что записано в spec.
      const census = runtimeRooms?.find((room) => room.sessionId === row.id)
      const real = alive.has(row.id) && kernelBackend() === 'docker'
        ? await containerLimits(row.id).catch(() => ({ memoryMb: null, cpus: null }))
        : { memoryMb: census?.memoryMb ?? null, cpus: census?.cpus ?? null }
      /*
       * И то же самое у контейнера личных тетрадей — но только когда он есть.
       *
       * Числа у него те же, что у комнаты (pool.ts · startContainer), однако
       * спрашивается всё равно docker: разойтись они могут ровно тогда, когда
       * это важно — лимит подняли между парами, а один из контейнеров с утра
       * работает на старом.
       */
      const own = withOwn.has(row.id)
        ? await containerLimits(row.id, 'own').catch(() => ({ memoryMb: null, cpus: null }))
        : null
      return {
        id: row.id,
        name: row.name,
        memoryMb: real.memoryMb ?? settledMb,
        cpus: real.cpus ?? settledCpus,
        environment: row.environment,
        alive: alive.has(row.id),
        ...(own ? { own: { memoryMb: own.memoryMb ?? settledMb, cpus: own.cpus ?? settledCpus } } : {}),
      }
    }),
  )
}

/* ------------------------------------------------------------------ сбор */

/**
 * Машина, какой её видит сервер прямо сейчас.
 *
 * Под тестовым бэкендом числа выдуманные, и выдуманы они правдоподобно —
 * ровно та машина, которую колло́к арендует: 3090, 72 ГБ памяти. Без этого
 * форму семинара нельзя было бы ни посмотреть, ни проверить на ноутбуке
 * разработчика: `nvidia-smi` там нет, и «Ресурсы» рисовались бы наполовину.
 */
async function collect(): Promise<Collected> {
  const fake = kernelBackend() === 'test'
  let instanceCpus = defaultCpus()
  let runtimeRooms: RuntimeRoom[] | undefined
  if (kernelBackend() === 'broker') {
    try {
      const client = kernelRuntimeClient()
      const [health, census] = await Promise.all([client.health(), client.rooms().catch(() => [])])
      instanceCpus = health.defaultCpus ?? instanceCpus
      if (health.ok) rememberBroker(health)
      runtimeRooms = census
    } catch { /* Broker unavailable: retain the last configured estimates. */ }
  }
  const perEnvironment: Record<string, { memoryMb: number; gpu: boolean }> = {}
  for (const name of safeNames()) {
    perEnvironment[name] = { memoryMb: envDefaultMb(name), gpu: safeGpu(name) }
  }
  const roomList = await rooms(instanceCpus, runtimeRooms)
  // Живая комната свою память уже держит — раздать её второй раз нельзя.
  const takenMb = roomList.reduce((sum, room) => (room.alive ? sum + room.memoryMb : sum), 0)
  const daemon = await readDaemon()
  const picture = memoryPicture({
    daemonTotalMb: daemon?.totalMb ?? null,
    hostTotalMb: Math.floor(os.totalmem() / MB),
    hostAvailableMb: hostAvailableMb(),
    takenMb,
  })
  /*
   * Под брокером «свободно» — это не MemAvailable, а то, что ещё не обещано.
   *
   * У Pod комнаты requests равны limits, и планировщик считает занятой всю
   * обещанную память, сколько бы Python её ни трогал. Узел с тремя пустыми
   * комнатами по 16 ГБ по MemAvailable «почти свободен», а четвёртая комната
   * не встанет — ровно то, о чём должно предупредить поле. Меньшее из двух:
   * обещанное мимо нас (сам кластер, приложение) MemAvailable тоже заметит.
   */
  if (kernelBackend() === 'broker') {
    const unpromised = Math.max(0, picture.totalMb - HOST_RESERVE_MB - takenMb)
    picture.availableMb = Math.min(picture.availableMb ?? unpromised, unpromised)
  }
  const brokerMb = kernelBackend() === 'broker' ? brokerDefaultMb() : null
  return {
    memory: fake ? { totalMb: 73_728, availableMb: 51_200, source: 'host' as const } : picture,
    cpus: fake ? 16 : machineCpus(),
    gpus: fake ? [{ index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMb: 24_576 }] : await readGpus(),
    kernel: {
      defaultMemoryMb: brokerMb ?? defaultMemoryMb(false),
      // У брокера нет отдельного умолчания для GPU: Pod с картой получает то же.
      gpuDefaultMemoryMb: brokerMb ?? defaultMemoryMb(true),
      // Ядра одним числом на инстанс: окружение на них не влияет, в отличие
      // от памяти, где окружение с GPU просит вчетверо больше.
      defaultCpus: instanceCpus,
      perEnvironment,
    },
    rooms: roomList,
  }
}

/** Список окружений читается с диска; пустой каталог — не повод отказать в ответе. */
function safeNames(): string[] {
  try {
    return listNames()
  } catch {
    return []
  }
}

/**
 * Умолчание окружения — и «не знаю» вместо исключения.
 *
 * Имя окружения приезжает из строки семинара, а окружение с тех пор могли
 * удалить или переименовать. Разбор его цепочки бросает, и на этом падал бы
 * весь ответ — ради одной строки в списке комнат.
 */
function envDefaultMb(name: string | null): number {
  // KERNEL_MEM_<ОКРУЖЕНИЕ> и 4g/16g — это `docker run`; Pod брокера их не видит.
  if (kernelBackend() === 'broker') return brokerDefaultMb()
  try {
    return memoryLimitMb(name ?? '')
  } catch {
    return defaultMemoryMb(false)
  }
}

function safeGpu(name: string): boolean {
  try {
    return needsGpu(name)
  } catch {
    return false
  }
}

/*
 * Десять секунд — и почему они вообще нужны.
 *
 * Ответ стоит чтения /proc, запуска `nvidia-smi` и `docker inspect` на каждую
 * живую комнату. Форма семинара спрашивает его на открытии и на каждой смене
 * окружения, а панель открыта у нескольких преподавателей сразу — без памяти
 * это десятки процессов в секунду на машине, которая в это время считает
 * чью-то нейросеть. Свежее десяти секунд тут никому не нужно: столько не
 * меняется ни объём машины, ни список карт.
 */
const TTL_MS = 10_000
let cached: { at: number; value: Collected } | null = null
let inflight: Promise<Collected> | null = null

export function machineResources(): Promise<Collected> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value)
  // Один сбор на всех, кто спросил, пока он идёт: иначе десять вкладок панели
  // запускают десять `nvidia-smi` в одну секунду — ровно то, от чего кеш.
  inflight ??= collect()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Забыть собранное — после того, как комнате поменяли лимит. Вместе с демоном:
 *  его перенастраивают реже, но помнить о нём дольше, чем о комнатах, незачем. */
export function forgetResources(): void {
  cached = null
  seenDaemon = null
  seenAt = 0
  // Числа брокера не стираются, а только устаревают: без них границы PATCH
  // до следующего ответа откатились бы к памяти узла.
  brokerAt = 0
}

/* ------------------------------------------------------------- проверка */

/** Меньше этого ядру не поднять: сам Jupyter с импортами занимает сотни мегабайт. */
export const MIN_ROOM_MB = 512
/** Машине надо чем-то жить и после того, как комната возьмёт своё. */
export const HOST_RESERVE_MB = 1024

export interface MemoryBounds {
  min: number
  max: number
}

/**
 * Границы, в которых лимит вообще имеет смысл.
 *
 * Верхняя — память машины минус гигабайт на саму машину: комната, которой
 * выдали всё, убивает не себя, а сервер под собой. Проверять её надо на
 * сервере, а не в форме: панель числа знает, но браузер — не то место, где
 * решают, сколько можно взять у машины.
 *
 * Машина здесь — та, что запускает контейнеры. Под колимой это её виртуалка, и
 * граница по памяти Мака пропускала бы «шестнадцать гигабайт» в двенадцати
 * гигабайтах докера: `docker run` отвечал бы на это отказом посреди пары.
 */
export function memoryBounds(): MemoryBounds {
  const totalMb =
    kernelBackend() === 'test' ? 73_728 : (lastDaemon()?.totalMb ?? Math.floor(os.totalmem() / MB))
  let max = Math.max(MIN_ROOM_MB, totalMb - HOST_RESERVE_MB)
  /*
   * Под брокером последнее слово за ним: его потолок строже, если оператор
   * задал RUNTIME_KERNEL_MEMORY_MAX. Принять здесь больше значило бы записать
   * комнате число, которое брокер живой комнате не выставит, а новому Pod
   * урежет до потолка.
   */
  const brokerMax = kernelBackend() === 'broker' ? lastBroker().maxMb : null
  if (brokerMax !== null) max = Math.max(MIN_ROOM_MB, Math.min(max, brokerMax))
  return { min: MIN_ROOM_MB, max }
}

/**
 * Сколько ядер на машине — по тому же правилу, что и память.
 *
 * Под тестовым бэкендом число выдуманное и то же самое, что в ответе двери:
 * граница, не совпадающая с подписью под полем, — это отказ, который человеку
 * не объяснить.
 */
export function machineCpus(): number {
  if (kernelBackend() === 'test') return 16
  // И по той же причине, что у памяти: `--cpus 12` докер, которому колима
  // выдала десять, отвергает целиком — комната просто не поднимется.
  return Math.max(1, lastDaemon()?.cpus || os.cpus().length)
}

/**
 * Границы для ядер: от одного до всех, что есть на машине.
 *
 * Запаса «оставь машине ядро», как у памяти, здесь нет намеренно: `--cpus` —
 * это доля времени, а не отобранное железо. Комната с восемью ядрами из восьми
 * не оставляет сервер без процессора, она просто конкурирует с ним за него;
 * комната с памятью машины минус ничего — оставляет его без памяти совсем.
 */
export function cpuBounds(): MemoryBounds {
  return { min: 1, max: Math.min(machineCpus(), kernelBackend() === 'broker' ? 64 : Infinity) }
}

export type CpuInput = { ok: true; cpus: number | null } | { ok: false; error: 'type' | 'range' }

/** Та же мерка, что и у памяти: целое, в границах, и null — «как у инстанса». */
export function readCpuInput(value: unknown): CpuInput {
  if (value === null || value === undefined) return { ok: true, cpus: null }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: 'type' }
  const { min, max } = cpuBounds()
  if (value < min || value > max) return { ok: false, error: 'range' }
  return { ok: true, cpus: value }
}

export type MemoryInput = { ok: true; mb: number | null } | { ok: false; error: 'type' | 'range' }

/**
 * Разобрать присланное «сколько памяти» — одной меркой на все двери.
 *
 * `null` — законный ответ и значит «как у окружения»: так комнату возвращают к
 * умолчанию, не выдумывая для этого второго поля. Дробное отвергается, а не
 * округляется: форма шлёт мегабайты целыми, и дробь здесь — признак того, что
 * прислал её не она.
 */
export function readMemoryInput(value: unknown): MemoryInput {
  if (value === null || value === undefined) return { ok: true, mb: null }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: 'type' }
  const { min, max } = memoryBounds()
  if (value < min || value > max) return { ok: false, error: 'range' }
  return { ok: true, mb: value }
}

/** Действующий лимит комнаты — своё число или умолчание её окружения. */
export function roomMemoryMb(sessionId: string, environment: string | null): number {
  return sessionMemoryMb(sessionId) ?? envDefaultMb(environment)
}
