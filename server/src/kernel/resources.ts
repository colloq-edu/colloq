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
import { containerLimits, defaultCpus, defaultMemoryMb, listRoomKernels, memoryLimitMb } from './pool.js'
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
 * Сколько памяти на машине свободно — по мнению ядра Linux, а не по `freemem`.
 *
 * `os.freemem()` — это память, не занятая НИЧЕМ, включая кеш страниц: на
 * работающем сервере она всегда близка к нулю, и подсказка «свободно 0,4 ГБ»
 * из 72 честно напугала бы преподавателя на пустой машине. MemAvailable —
 * оценка самого ядра «сколько можно занять, не уходя в swap», и это ровно тот
 * вопрос, который задаёт форма семинара. Своего /proc у macOS нет, там
 * остаётся `freemem`.
 */
function availableMb(): number {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)
    if (match) return Math.floor(Number(match[1]) / 1024)
  } catch {
    /* не Linux, или /proc не смонтирован — ниже честный запасной ответ */
  }
  return Math.floor(os.freemem() / MB)
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
  try {
    alive = runtimeRooms
      ? new Set(runtimeRooms.filter((room) => room.phase === 'ready' || room.phase === 'pending').map((room) => room.sessionId))
      : new Set((await listRoomKernels()).filter((r) => r.running).map((r) => r.session))
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
      const real = alive.has(row.id) && kernelBackend() === 'docker'
        ? await containerLimits(row.id).catch(() => ({ memoryMb: null, cpus: null }))
        : { memoryMb: null, cpus: runtimeRooms?.find((room) => room.sessionId === row.id)?.cpus ?? null }
      return {
        id: row.id,
        name: row.name,
        memoryMb: real.memoryMb ?? settledMb,
        cpus: real.cpus ?? settledCpus,
        environment: row.environment,
        alive: alive.has(row.id),
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
      runtimeRooms = census
    } catch { /* Broker unavailable: retain the last configured estimates. */ }
  }
  const perEnvironment: Record<string, { memoryMb: number; gpu: boolean }> = {}
  for (const name of safeNames()) {
    perEnvironment[name] = { memoryMb: envDefaultMb(name), gpu: safeGpu(name) }
  }
  return {
    memory: fake
      ? { totalMb: 73_728, availableMb: 51_200 }
      : { totalMb: Math.floor(os.totalmem() / MB), availableMb: availableMb() },
    cpus: fake ? 16 : os.cpus().length,
    gpus: fake ? [{ index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMb: 24_576 }] : await readGpus(),
    kernel: {
      defaultMemoryMb: defaultMemoryMb(false),
      gpuDefaultMemoryMb: defaultMemoryMb(true),
      // Ядра одним числом на инстанс: окружение на них не влияет, в отличие
      // от памяти, где окружение с GPU просит вчетверо больше.
      defaultCpus: instanceCpus,
      perEnvironment,
    },
    rooms: await rooms(instanceCpus, runtimeRooms),
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

/** Забыть собранное — после того, как комнате поменяли лимит. */
export function forgetResources(): void {
  cached = null
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
 */
export function memoryBounds(): MemoryBounds {
  const totalMb = kernelBackend() === 'test' ? 73_728 : Math.floor(os.totalmem() / MB)
  return { min: MIN_ROOM_MB, max: Math.max(MIN_ROOM_MB, totalMb - HOST_RESERVE_MB) }
}

/**
 * Сколько ядер на машине — по тому же правилу, что и память.
 *
 * Под тестовым бэкендом число выдуманное и то же самое, что в ответе двери:
 * граница, не совпадающая с подписью под полем, — это отказ, который человеку
 * не объяснить.
 */
export function machineCpus(): number {
  return kernelBackend() === 'test' ? 16 : Math.max(1, os.cpus().length)
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
