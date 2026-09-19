/**
 * Почему ядро умерло — словами, а не «ядро умерло».
 *
 * Смерть ядра комната видела всегда: очередь сброшена, переменных нет, в
 * журнале строка «Ядро неожиданно перезапустилось». Причины не видел никто.
 * 13.09 семинар пятнадцать раз подряд упирался в одну ячейку, и выяснить, что
 * контейнеру комнаты выдано два гигабайта, а `resnet18` на батче 224×224 просит
 * больше, можно было только по `dmesg` на машине — то есть никак, если ты
 * преподаватель посреди пары.
 *
 * Здесь собирается то, что об этом знает docker и ядро Linux:
 *
 *   - `docker inspect` — код выхода контейнера и флаг `OOMKilled`, если лёг
 *     весь контейнер;
 *   - cgroup контейнера — лимит, пик, текущее потребление и СЧЁТЧИК убийств
 *     `memory.events:oom_kill`;
 *   - хвост журнала контейнера — что успел сказать Jupyter.
 *
 * Счётчик, а не флаг, — главное здесь. Когда cgroup убивает python внутри
 * живого контейнера (а именно так это и выглядит: PID 1 — сам Jupyter, он
 * переживает и поднимает ядро заново), `docker inspect` показывает
 * `OOMKilled: true` ровно один раз и потом залипает на этом значении навсегда.
 * По нему нельзя отличить «убит только что» от «убит утром». Счётчик из
 * `memory.events` растёт на каждое убийство, и разница с прошлым замером —
 * честный ответ на вопрос «эта ли ячейка».
 */

import { formatNumber, getLocale, tr } from '@shared/i18n'
import { dockerRead, roomContainer, type KernelRole } from './pool.js'
import { kernelBackend } from './runtime-client.js'

/** Что docker и cgroup рассказали о контейнере комнаты. */
export interface MemoryReading {
  /** Лимит памяти контейнера в байтах; `null`, если прочитать не удалось. */
  limit: number | null
  /** Пик потребления за жизнь контейнера. */
  peak: number | null
  /** Сколько занято сейчас — уже после перезапуска ядра, поэтому мало. */
  current: number | null
  /** Сколько раз cgroup убивал процесс в этом контейнере с его рождения. */
  kills: number | null
  /** Флаг docker: по памяти лёг весь контейнер, а не процесс внутри. */
  containerOomKilled: boolean
  /** Статус контейнера: `running`, `exited`, … */
  status: string
  /** Код выхода — осмыслен только у остановленного контейнера. */
  exit: number | null
  /** Хвост журнала контейнера, без болтовни Jupyter про шифрование. */
  tail: string[]
}

/** Разбор причины: что случилось и что об этом сказать. */
export interface Postmortem {
  reading: MemoryReading
  /** Убила ли память — и убила ли ИМЕННО СЕЙЧАС, а не когда-то раньше. */
  oom: boolean
  /** Готовая строка для журнала ядра и для `journalctl`. */
  text: string
}

type Docker = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>

let docker: Docker = dockerRead
let injected = false

/**
 * Подменить docker — тестам.
 *
 * Настоящего docker в тестах нет, а проверять надо ровно то, что случается
 * только с ним: убитое по памяти ядро и строка, которую после этого читает
 * комната. `null` возвращает всё как было.
 *
 * Подделка заодно отменяет проверку бэкенда. Иначе её пришлось бы ставить
 * вместе с `KERNEL_BACKEND=docker`, а это переключает на настоящий docker весь
 * остальной сервер — и сюита, проверяющая одну строку в журнале, начала бы
 * поднимать контейнеры на машине разработчика.
 */
export function useDockerForPostmortem(fake: Docker | null): void {
  docker = fake ?? dockerRead
  injected = fake !== null
}

/** Есть ли кого спрашивать: свой docker под рукой или подделка от теста. */
function available(): boolean {
  return injected || kernelBackend() === 'docker'
}

/**
 * Последний известный счётчик убийств по каждой комнате.
 *
 * Живёт в памяти сервера и умирает вместе с ним — и это правильно: после
 * перезапуска сервера «сколько раз убивали ДО того, как мы начали смотреть»
 * неизвестно, и притворяться, что известно, значит объявить нехваткой памяти
 * первую же смерть ядра от любой другой причины. Без базы решает пик: он
 * упёрся в лимит — значит, упёрся.
 */
const killsSeen = new Map<string, number>()

/**
 * Счётчик убийств считается ПО КОНТЕЙНЕРУ, и контейнеров у занятия два.
 *
 * Второй — тот, где живут личные тетради студентов (pool.ts · KernelRole): у
 * него свой cgroup, свой лимит и свой счётчик. Считать их одним числом значило
 * бы объявить смерть ядра студента нехваткой памяти у преподавателя — или
 * наоборот промолчать о настоящей.
 */
const seenKey = (sessionId: string, role: KernelRole) => `${role}:${sessionId}`

/** Забыть счётчики ОБОИХ контейнеров занятия: их сносят вместе. */
export function forgetKills(sessionId: string): void {
  for (const role of ['room', 'own'] as const) killsSeen.delete(seenKey(sessionId, role))
}

/**
 * Запомнить счётчик, пока ничего не случилось.
 *
 * Зовётся, когда ядро поднялось: с этого момента у нас есть точка отсчёта, и
 * следующая смерть будет отличима от вчерашней. Ошибки глотает молча — это
 * подготовка к диагностике, а не диагностика; сорвать из-за неё старт ядра
 * было бы обменом плохим.
 */
export async function sampleKills(sessionId: string, role: KernelRole = 'room'): Promise<void> {
  if (!available()) return
  try {
    const reading = await readCgroup(roomContainer(sessionId, role))
    if (reading.kills !== null) killsSeen.set(seenKey(sessionId, role), reading.kills)
  } catch {
    /* Диагностика не имеет права мешать. */
  }
}

const NUMBER = /^\d+$/

/** `max` в cgroup v2 — это «без лимита», а не число. */
function bytes(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = raw.trim()
  if (value === '' || value === 'max') return null
  if (!NUMBER.test(value)) return null
  const parsed = Number(value)
  // Docker без `--memory` пишет в cgroup v1 гигантское число вместо «нет
  // лимита»: считать его лимитом — значит сказать «занято 2 ГБ из 8 эксабайт».
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= Number.MAX_SAFE_INTEGER) return null
  return parsed
}

/*
 * Одна команда на все четыре числа, и обе версии cgroup сразу.
 *
 * v2 (всё, что новее Ubuntu 22.04) держит их в корне пространства имён
 * контейнера, v1 — в подкаталоге `memory/` и под другими именами. Спрашивать
 * версию отдельным запросом значит платить вторым `docker exec` за знание,
 * которое и так приезжает: файла просто нет, и `cat` молчит.
 *
 * `memory.peak` появился в ядре 5.19; там, где его нет, пиком считается
 * текущее потребление — заведомо заниженное, но не выдуманное.
 */
const CGROUP_SCRIPT = [
  'r=/sys/fs/cgroup',
  'v1=$r/memory',
  'p() { printf "%s %s\\n" "$1" "$(cat "$2" 2>/dev/null)"; }',
  'p limit $r/memory.max; p limit $v1/memory.limit_in_bytes',
  'p peak $r/memory.peak; p peak $v1/memory.max_usage_in_bytes',
  'p current $r/memory.current; p current $v1/memory.usage_in_bytes',
  'cat $r/memory.events 2>/dev/null | sed -n "s/^oom_kill /kills /p"',
  'p kills $v1/memory.failcnt',
].join('; ')

async function readCgroup(container: string): Promise<Pick<MemoryReading, 'limit' | 'peak' | 'current' | 'kills'>> {
  const res = await docker(['exec', container, 'sh', '-c', CGROUP_SCRIPT])
  const found: Record<string, number | null> = { limit: null, peak: null, current: null, kills: null }
  if (res.code !== 0) return found as Pick<MemoryReading, 'limit' | 'peak' | 'current' | 'kills'>
  for (const line of res.out.split('\n')) {
    const [key, raw] = line.trim().split(/\s+/, 2)
    if (!(key in found)) continue
    // Первый непустой ответ выигрывает: v1 и v2 в одном контейнере не бывают.
    if (found[key] === null) found[key] = bytes(raw)
  }
  return found as Pick<MemoryReading, 'limit' | 'peak' | 'current' | 'kills'>
}

/** Строки, которые Jupyter печатает всегда и которые ничего не объясняют. */
const NOISE = /running over TCP without encryption|Jupyter Server .* is running|http:\/\/127\.0\.0\.1/i

async function readTail(container: string): Promise<string[]> {
  const res = await docker(['logs', '--tail', '40', container])
  if (res.code !== 0) return []
  return res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !NOISE.test(line))
    .slice(-3)
}

const INSPECT = '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.HostConfig.Memory}}'

/**
 * Спросить docker и cgroup обо всём сразу.
 *
 * Три чтения параллельно, с коротким сроком: это происходит на смерти ядра,
 * когда комната уже ждёт объяснения, и лишняя секунда здесь — секунда чужого
 * семинара. Ни одно из трёх не обязано получиться: контейнера может уже не
 * быть, `exec` в остановленный не заходит, журнала может не быть вовсе.
 */
export async function readContainer(sessionId: string, role: KernelRole = 'room'): Promise<MemoryReading> {
  const container = roomContainer(sessionId, role)
  const [state, cgroup, tail] = await Promise.all([
    docker(['inspect', container, '--format', INSPECT]),
    readCgroup(container),
    readTail(container),
  ])
  const [status = '', exit = '', oomKilled = '', hostMemory = ''] = state.code === 0 ? state.out.trim().split(/\s+/) : []
  return {
    limit: cgroup.limit ?? bytes(hostMemory),
    peak: cgroup.peak,
    current: cgroup.current,
    kills: cgroup.kills,
    containerOomKilled: oomKilled === 'true',
    status,
    exit: NUMBER.test(exit) ? Number(exit) : null,
    tail,
  }
}

/**
 * Убила ли память — с оглядкой на то, что мы про эту комнату уже знали.
 *
 * Счётчик вырос с прошлого замера — да, и спорить не о чем. Замера не было
 * (сервер перезапустили, комнату подобрали чужую) — судим по пику: он в
 * пределах трёх процентов от лимита у того, кого только что убили, и заметно
 * ниже у того, кто умер по любой другой причине. Три процента, а не «равно»:
 * cgroup успевает дописать в `memory.peak` часть последней аллокации, и пик
 * бывает чуть БОЛЬШЕ лимита.
 */
export function killedByMemory(reading: MemoryReading, seen: number | undefined): boolean {
  if (reading.kills !== null && seen !== undefined) return reading.kills > seen
  if (reading.containerOomKilled) return true
  if (reading.kills !== null && reading.kills > 0 && reading.limit !== null && reading.peak !== null) {
    return reading.peak >= reading.limit * 0.97
  }
  return false
}

function humanBytes(value: number | null): string {
  if (value === null) return '—'
  const english = getLocale() === 'en'
  const gib = value / 1024 ** 3
  if (gib >= 1) return `${formatNumber(Math.round(gib * 10) / 10)} ${english ? 'GB' : 'ГБ'}`
  return `${formatNumber(Math.round(value / 1024 ** 2))} ${english ? 'MB' : 'МБ'}`
}

/**
 * Фраза, ради которой всё это и собиралось.
 *
 * «Контейнер убит по памяти: лимит 2 ГБ, занято 2 ГБ на ячейке 21» — этого
 * хватает, чтобы понять, что делать дальше, не заходя на машину. Номер ячейки
 * тот же, что нарисован в комнате слева от неё, поэтому ходить искать её не
 * надо.
 */
export function describe(reading: MemoryReading, oom: boolean, cell: number | null): string {
  const limit = humanBytes(reading.limit)
  const used = humanBytes(reading.peak ?? reading.current)
  if (oom) {
    return cell === null
      ? tr('server.theContainerWasKilledByMemoryLimit.6ab1f2', { p0: limit, p1: used })
      : tr('server.theContainerWasKilledByMemoryOnCell.0d3c74', { p0: limit, p1: used, p2: cell })
  }
  const last = reading.tail.at(-1) ?? ''
  if (reading.status !== '' && reading.status !== 'running') {
    return tr('server.theRoomContainerStoppedWithCode.b72e19', { p0: String(reading.exit ?? '?'), p1: last })
  }
  // Память ни при чём, контейнер жив: остаётся то, что сказал сам Python.
  return tr('server.theKernelProcessEndedWithoutRunningOut.4fd8a1', { p0: used, p1: limit, p2: last })
}

/**
 * Всё вместе: прочитать, решить, сказать.
 *
 * `null` — когда сказать нечего: не docker-бэкенд (у брокера свои контейнеры и
 * своя диагностика), docker не ответил, чисел нет. Молчание лучше уверенной
 * выдумки: комната уже получила честное «ядро перезапустилось», и дописывать к
 * нему угаданную причину — ровно тот способ потерять полдня, от которого это
 * всё и делается.
 */
export async function explain(
  sessionId: string,
  cell: number | null,
  /** Где жило умершее ядро: в контейнере занятия или его личных тетрадей. */
  role: KernelRole = 'room',
): Promise<Postmortem | null> {
  if (!available()) return null
  let reading: MemoryReading
  try {
    reading = await readContainer(sessionId, role)
  } catch {
    return null
  }
  const key = seenKey(sessionId, role)
  const oom = killedByMemory(reading, killsSeen.get(key))
  if (reading.kills !== null) killsSeen.set(key, reading.kills)
  // Ни одного числа и ни строчки журнала — значит, docker промолчал целиком.
  if (!oom && reading.limit === null && reading.status === '' && reading.tail.length === 0) return null
  return { reading, oom, text: describe(reading, oom, cell) }
}
