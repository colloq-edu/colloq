/**
 * load.mts — выдержит ли ОДИН процесс пятьсот студентов в одной комнате.
 *
 * perf.mts отвечает на вопрос «быстро ли», когда в комнате двое, и меряет вес
 * бандла. Здесь вопрос другой: что делается с единственным процессом Node,
 * когда по ссылке приходит поток. Стенд заводит СВОЙ семинар, приводит в него N
 * поддельных вкладок — вход через `/join`, оба сокета, начальная синхронизация
 * Yjs, присутствие с именем и цветом, — держит их и меряет:
 *
 *   1 ВХОД     сколько прошло и сколько отказано, по кодам, и за сколько
 *   2 ПОКОЙ    кадров в секунду и байт на клиента, /api/health и loopLag оттуда
 *   3 ШТОРМ    k печатают по m нажатий в секунду: за сколько правка доезжает
 *
 * В каждом окне рядом стоят CPU и RSS серверного процесса — если стенд запущен
 * на той же машине и его pid назван параметром.
 *
 * Чего он НЕ меряет: он не рисует страницу, не считает ячейки, не запускает
 * ядро и ничего не знает про память браузера. Это нагрузка на сокеты и на цикл
 * событий, и настоящая вкладка поверх этих чисел добавит свою цену.
 *
 * По чужому семинару его гонять нельзя — и нечем: комнату он заводит сам и
 * удаляет её в finally, в том числе по Ctrl+C. Пятьсот строк участников,
 * оставленных в чужой базе, оттуда уже не уходят, а в комнате могут сидеть люди.
 *
 * Usage: make load   (или npx tsx scripts/load.mts)
 *   LOAD_BASE_URL     куда стучаться           default http://localhost:3000
 *   LOAD_STUDENTS     сколько студентов        default 500
 *   LOAD_RAMP_SEC     за сколько они входят    default 60
 *   LOAD_IDLE_SEC     окно покоя               default 15
 *   LOAD_TYPISTS      k — сколько печатают     default 20
 *   LOAD_KEYS         m — нажатий в секунду    default 5
 *   LOAD_STORM_SEC    сколько длится шторм     default 20
 *   LOAD_SERVER_PID   pid серверного процесса (systemctl show -p MainPID colloq)
 *   LOAD_SETUP_TOKEN  ключ установки, если файла рядом нет (удалённый инстанс)
 *   LOAD_STAFF_COOKIE готовая кука `colloq_staff=...`, если ключа нет вовсе
 *   LOAD_STAFF_JOIN   1 — входить с кукой штата, мимо предела новых участников
 *   LOAD_ECHO         0 — не повторять серверу чужое присутствие (см. ниже)
 *   DATA_DIR          где лежит setup-token    default <repo>/data
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import WS, { type RawData } from 'ws'
import type { AwarenessUser, ParticipantRole } from '@shared/protocol'

/* --------------------------------------------------------------- настройки */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = (process.env.LOAD_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const WSB = BASE.replace(/^http/, 'ws')

const num = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

const STUDENTS = Math.max(1, Math.round(num('LOAD_STUDENTS', 500)))
const RAMP_SEC = num('LOAD_RAMP_SEC', 60)
const IDLE_SEC = num('LOAD_IDLE_SEC', 15)
const TYPISTS = Math.max(1, Math.round(num('LOAD_TYPISTS', 20)))
const KEYS = Math.max(1, num('LOAD_KEYS', 5))
const STORM_SEC = num('LOAD_STORM_SEC', 20)
const SERVER_PID = (process.env.LOAD_SERVER_PID ?? '').trim()
const STAFF_JOIN = process.env.LOAD_STAFF_JOIN === '1'
/*
 * Настоящая вкладка повторяет серверу ЧУЖОЕ присутствие.
 *
 * Не выдумка стенда: `_awarenessUpdateHandler` в y-websocket — а это ровно тот
 * провайдер, которым живёт web/src/lib/session.svelte.ts — шлёт в сокет все
 * изменившиеся clientID, не разбирая, свои они или приехавшие. То есть каждый
 * кадр присутствия возвращается серверу столько раз, сколько в комнате
 * вкладок; сервер их отвергает (`ownAwareness`), но разбирает. При пятистах
 * это и есть главный источник трафика, и стенд, который так не делает, меряет
 * не ту комнату. Выключается тем, кому важнее не захлебнуться самому.
 */
const ECHO = process.env.LOAD_ECHO !== '0'

/** y-websocket'овские метки кадров. Числа — протокол, а не выбор. */
const MSG_SYNC = 0
const MSG_AWARENESS = 1

const HEALTH_EVERY_MS = 500
/** Шаг таймера, которым стенд следит за СВОИМ циклом событий. */
const SELF_TICK_MS = 200

const sleep = (msec: number) => new Promise((r) => setTimeout(r, msec))

const isTTY = Boolean(process.stdout.isTTY)
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s)
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s)
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s)

const ms = (v: number) => (Number.isFinite(v) ? `${v.toFixed(v < 10 ? 2 : 1)}ms` : '—')
const size = (v: number) =>
  !Number.isFinite(v)
    ? '—'
    : v >= 1024 * 1024
      ? `${(v / 1024 / 1024).toFixed(1)}M`
      : v >= 1024
        ? `${(v / 1024).toFixed(1)}K`
        : `${Math.round(v)}B`

/** Перцентиль по несортированному, ближайший ранг — как в perf.mts. */
function pct(samples: number[], p: number): number {
  if (samples.length === 0) return NaN
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
/** Math.max(...xs, NaN) — это всегда NaN, поэтому худшее считается отдельно. */
const worst = (xs: number[]) => (xs.length === 0 ? NaN : Math.max(...xs))

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - plain(s).length))

const say = (s = '') => console.log(s)
const row = (label: string, value: string, note = '') =>
  say('    ' + pad(label, 22) + pad(value, 45) + (note ? dim(note) : ''))

/* ------------------------------------------------------------- вход в панель */

/**
 * Та же дверь, что у e2e.mts и perf.mts: ключ установки с диска, потраченный на
 * вторую свою работу — вход основателем. Незанятый инстанс не занимаем: стенд,
 * ставший владельцем чужой установки, отбирает у преподавателя первый экран.
 *
 * Если ключа рядом нет (стенд гонят по машине через сеть), его можно назвать
 * параметром — LOAD_SETUP_TOKEN, — а если и его нет, то готовую куку
 * LOAD_STAFF_COOKIE. Гадать тут нечего: без штата семинара не завести, а без
 * своего семинара стенду работать не по чему.
 */
let staffCookie = ''

async function signInAsStaff(): Promise<string | null> {
  const given = (process.env.LOAD_STAFF_COOKIE ?? '').trim()
  if (given) {
    staffCookie = given.split(';')[0]
    return staffCookie.startsWith('colloq_staff=') ? null : 'LOAD_STAFF_COOKIE — это не кука colloq_staff='
  }
  const tokenFile = resolve(process.env.DATA_DIR ?? join(ROOT, 'data'), 'setup-token')
  let token = (process.env.LOAD_SETUP_TOKEN ?? '').trim()
  if (!token) {
    try {
      token = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      return `ключа установки нет ни в ${tokenFile}, ни в LOAD_SETUP_TOKEN, ни куки в LOAD_STAFF_COOKIE`
    }
  }
  try {
    const state = (await (await fetch(`${BASE}/api/admin/state`)).json()) as { claimed?: boolean }
    if (!state?.claimed) return 'этот инстанс ещё никем не занят — займите его в /admin и запустите снова'
    const res = await fetch(`${BASE}/api/admin/signin/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) return `вход отклонён (${res.status})`
    staffCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    return staffCookie.startsWith('colloq_staff=') ? null : 'куки штата не выдали'
  } catch (err) {
    return err instanceof Error ? err.message : 'вход не удался'
  }
}

/* ------------------------------------------------- поддельная вкладка (клиент) */

interface Student {
  n: number
  name: string
  id: string
  token: string
  color: string
  role: ParticipantRole
  doc: Y.Doc
  aw: awarenessProtocol.Awareness
  collab: WS | null
  control: WS | null
  synced: boolean
  /** Счётчики окна: обнуляются в начале каждого замера. */
  frames: number
  bytesIn: number
  echoes: number
  cell: { id: string; text: Y.Text } | null
}

const students: Student[] = []
let socketErrors = 0
let badFrames = 0
let stopping = false
const closedWith = new Map<number, number>()

const cellsOf = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>('cells')
const findCell = (doc: Y.Doc, id: string) =>
  cellsOf(doc)
    .toArray()
    .find((c) => c.get('id') === id)

function sizeOf(d: RawData): number {
  if (d instanceof ArrayBuffer) return d.byteLength
  if (Array.isArray(d)) return d.reduce((n, b) => n + b.length, 0)
  return d.length
}

function toBytes(d: RawData): Uint8Array {
  if (d instanceof ArrayBuffer) return new Uint8Array(d)
  if (Array.isArray(d)) {
    const joined = Buffer.concat(d)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  }
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
}

function raw(ws: WS | null, payload: Uint8Array): void {
  if (!ws || ws.readyState !== WS.OPEN) return
  try {
    ws.send(payload)
  } catch {
    /* сокет уже закрыт — кадр просто не уехал, счёт ведут close и error */
  }
}

/** Ячейка ровно того вида, который принимает гейт: те же ключи, что в e2e.mts. */
function newCell(source: string): { cell: Y.Map<unknown>; id: string } {
  const id = 'load_' + Math.random().toString(36).slice(2, 12)
  const cell = new Y.Map<unknown>()
  cell.set('id', id)
  cell.set('type', 'code')
  const text = new Y.Text()
  text.insert(0, source)
  cell.set('source', text)
  cell.set('outputs', new Y.Array())
  cell.set('state', 'idle')
  cell.set('execCount', null)
  cell.set('runBy', null)
  return { cell, id }
}

function makeStudent(
  n: number,
  id: string,
  name: string,
  color: string,
  role: ParticipantRole,
  token: string,
): Student {
  const doc = new Y.Doc()
  // Корневые типы объявляются ДО первого чужого обновления, иначе Yjs не знает
  // их формы — то же самое делают SessionState и оба соседних скрипта.
  doc.getArray('cells')
  doc.getMap('meta')
  const s: Student = {
    n,
    id,
    name,
    color,
    role,
    token,
    doc,
    aw: new awarenessProtocol.Awareness(doc),
    collab: null,
    control: null,
    synced: false,
    frames: 0,
    bytesIn: 0,
    echoes: 0,
    cell: null,
  }
  /*
   * Локальное состояние присутствия НЕ обнуляется. `Awareness` заводит его
   * пустым объектом в конструкторе, а `setLocalStateField` при `null` молча не
   * делает ничего — стенд, обнуливший его «как сервер», держал бы пятьсот
   * сокетов, о которых комната не знает: ни ростера, ни курсоров, ни рассылки
   * присутствия, то есть ровно та нагрузка, ради которой всё и затевалось,
   * не создавалась бы вовсе. Проверяется это ниже, по `online` от сервера.
   */

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    // Приехавшее по проводу назад не отправляем: origin выставляет readSyncMessage.
    if (origin === s) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    raw(s.collab, encoding.toUint8Array(enc))
  })

  s.aw.on(
    'update',
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = changes.added.concat(changes.updated, changes.removed)
      if (changed.length === 0) return
      // Своё присутствие приходит с origin 'local'; всё прочее — эхо (см. ECHO).
      const mine = origin === 'local'
      if (!mine) {
        if (!ECHO) return
        s.echoes++
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(s.aw, changed))
      raw(s.collab, encoding.toUint8Array(enc))
    },
  )

  return s
}

function onCollabFrame(s: Student, data: RawData): void {
  s.frames++
  s.bytesIn += sizeOf(data)
  try {
    const dec = decoding.createDecoder(toBytes(data))
    const enc = encoding.createEncoder()
    switch (decoding.readVarUint(dec)) {
      case MSG_SYNC: {
        encoding.writeVarUint(enc, MSG_SYNC)
        const kind = syncProtocol.readSyncMessage(dec, enc, s.doc, s)
        // step2 — ответ сервера на наш step1: с него вкладка синхронизирована.
        if (kind === syncProtocol.messageYjsSyncStep2) s.synced = true
        if (encoding.length(enc) > 1) raw(s.collab, encoding.toUint8Array(enc))
        break
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(s.aw, decoding.readVarUint8Array(dec), s)
        break
    }
  } catch {
    badFrames++
  }
}

/** Оба сокета — как у вкладки: тетрадь и пульт. Присутствие объявляется на open. */
function connect(s: Student, sessionId: string): void {
  const collab = new WS(`${WSB}/collab/${sessionId}?token=${encodeURIComponent(s.token)}`)
  collab.binaryType = 'arraybuffer'
  s.collab = collab
  collab.on('message', (data: RawData) => onCollabFrame(s, data))
  collab.on('error', () => socketErrors++)
  collab.on('close', (code: number) => {
    if (!stopping) closedWith.set(code, (closedWith.get(code) ?? 0) + 1)
  })
  collab.on('open', () => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, s.doc)
    raw(collab, encoding.toUint8Array(enc))
    /*
     * Имя, цвет и роль — то, из чего комната рисует ростер и курсоры, и именно
     * этот кадр сервер рассылает всем остальным. Цвет берём выданный сервером
     * (colorForId), а не свой: браузер тоже берёт его из ответа на /join.
     */
    const user: AwarenessUser = {
      id: s.id,
      name: s.name,
      avatar: null,
      color: s.color,
      // Роль тоже своя: под LOAD_STAFF_JOIN сервер выдаёт ведущего, и вкладка,
      // объявившая себя участником, была бы поправлена сервером на каждом кадре.
      role: s.role,
      activeCellId: null,
    }
    s.aw.setLocalStateField('user', user)
  })

  const control = new WS(`${WSB}/control/${sessionId}?token=${encodeURIComponent(s.token)}`)
  s.control = control
  control.on('message', (data: RawData) => {
    s.frames++
    s.bytesIn += sizeOf(data)
  })
  control.on('error', () => socketErrors++)
  control.on('close', (code: number) => {
    if (!stopping) closedWith.set(code, (closedWith.get(code) ?? 0) + 1)
  })
}

/* --------------------------------------------------------------- измерители */

interface Health {
  ms: number[]
  lag: number[]
  failed: number
}

async function probeHealth(into: Health): Promise<void> {
  const t0 = performance.now()
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5_000) })
    const body = (await res.json()) as { loopLagMs?: number }
    into.ms.push(performance.now() - t0)
    if (typeof body?.loopLagMs === 'number') into.lag.push(body.loopLagMs)
  } catch {
    into.failed++
  }
}

interface Proc {
  cpuSec: number
  rssKb: number
}

/**
 * CPU и RSS серверного процесса — через `ps`, по названному pid.
 *
 * Не `%cpu`: он усреднён по всей жизни процесса, и сервер, поднятый час назад,
 * покажет тишину под любым штормом. Берём накопленное процессорное время на
 * границах окна и делим на настоящие секунды — это и есть загрузка ЗА окно.
 *
 * Работает, только если стенд запущен на той же машине. Pid называют
 * параметром: угадать его нечем — под systemd это MainPID, под `make run` это
 * ребёнок tsx, — а перепутать процессы значит напечатать чужие числа.
 */
function procSample(): Proc | null {
  if (!SERVER_PID) return null
  try {
    const out = execFileSync('ps', ['-o', 'time=,rss=', '-p', SERVER_PID], { encoding: 'utf8' }).trim()
    const [time, rss] = out.split(/\s+/)
    if (!time || !rss) return null
    // `[[dd-]hh:]mm:ss[.ff]` — Linux и macOS печатают по-разному, читаем оба.
    const [days, rest] = time.includes('-') ? time.split('-') : ['0', time]
    let cpuSec = 0
    for (const part of rest.split(':')) cpuSec = cpuSec * 60 + Number(part)
    return { cpuSec: Number(days) * 86_400 + cpuSec, rssKb: Number(rss) }
  } catch {
    return null
  }
}

interface Window {
  seconds: number
  clients: number
  frames: number
  bytesIn: number
  echoes: number
  health: Health
  selfLagP95: number
  cpuPct: number | null
  rssMb: number | null
}

interface OpenWindow {
  at: number
  clients: Student[]
  health: Health
  cpu0: Proc | null
  selfLag: number[]
  timer: NodeJS.Timeout
  selfTimer: NodeJS.Timeout
}

function beginWindow(): OpenWindow {
  const clients = students.filter((s) => s.collab?.readyState === WS.OPEN)
  for (const s of clients) {
    s.frames = 0
    s.bytesIn = 0
    s.echoes = 0
  }
  const health: Health = { ms: [], lag: [], failed: 0 }
  const selfLag: number[] = []
  let last = performance.now()
  let busy = false
  return {
    at: performance.now(),
    clients,
    health,
    cpu0: procSample(),
    selfLag,
    /*
     * Задержка СВОЕГО цикла. Пятьсот документов Yjs в одном процессе — это тоже
     * нагрузка, и если захлебнулся стенд, все числа ниже становятся оценкой
     * снизу. Сказать об этом честнее, чем напечатать их молча.
     */
    selfTimer: setInterval(() => {
      const now = performance.now()
      selfLag.push(Math.max(0, now - last - SELF_TICK_MS))
      last = now
    }, SELF_TICK_MS),
    timer: setInterval(() => {
      if (busy) return
      busy = true
      void probeHealth(health).finally(() => {
        busy = false
      })
    }, HEALTH_EVERY_MS),
  }
}

function endWindow(w: OpenWindow): Window {
  clearInterval(w.timer)
  clearInterval(w.selfTimer)
  const seconds = (performance.now() - w.at) / 1000
  const cpu1 = procSample()
  return {
    seconds,
    clients: w.clients.length,
    frames: w.clients.reduce((n, s) => n + s.frames, 0),
    bytesIn: w.clients.reduce((n, s) => n + s.bytesIn, 0),
    echoes: w.clients.reduce((n, s) => n + s.echoes, 0),
    health: w.health,
    selfLagP95: pct(w.selfLag, 95),
    cpuPct: w.cpu0 && cpu1 ? ((cpu1.cpuSec - w.cpu0.cpuSec) / seconds) * 100 : null,
    rssMb: cpu1 ? cpu1.rssKb / 1024 : null,
  }
}

function printWindow(w: Window): void {
  const each = Math.max(w.clients, 1)
  row('кадров в секунду', `${(w.frames / each / w.seconds).toFixed(1)} на клиента`,
    `${Math.round(w.frames / w.seconds)} всего`)
  row('входящий', `${size(w.bytesIn / each / w.seconds)}/с на клиента`,
    `${size(w.bytesIn / w.seconds)}/с всего, после распаковки`)
  row('/api/health',
    `p50 ${ms(pct(w.health.ms, 50))} · p95 ${ms(pct(w.health.ms, 95))} · худшее ${ms(worst(w.health.ms))}`,
    w.health.failed > 0 ? red(`${w.health.failed} проб без ответа`) : `n=${w.health.ms.length}`)
  row('loopLag сервера',
    `p50 ${ms(pct(w.health.lag, 50))} · p95 ${ms(pct(w.health.lag, 95))} · худший ${ms(worst(w.health.lag))}`,
    'столько ждало бы следующее нажатие')
  if (w.cpuPct !== null && w.rssMb !== null) {
    row('сервер', `CPU ${w.cpuPct.toFixed(0)}% · RSS ${w.rssMb.toFixed(0)}M`, `pid ${SERVER_PID}`)
  } else {
    row('сервер', dim('—'), 'CPU и RSS: назовите LOAD_SERVER_PID, и стенд на той же машине')
  }
  if (ECHO && w.echoes > 0) {
    row('эхо присутствия', `${w.echoes} кадров назад`,
      `${Math.round(w.echoes / w.seconds)}/с: столько раз вкладки повторили серверу чужое`)
  }
  if (w.selfLagP95 > 50) {
    say(red(`    стенд ждал СВОЕГО цикла p95 ${ms(w.selfLagP95)} — числа выше это оценка снизу`))
  }
}

/* ------------------------------------------------------------------ семинар */

const problem = await signInAsStaff()
if (problem) {
  console.error(red(`не удалось войти штатом: ${problem}`))
  console.error(dim('семинар заводит только штат, а по чужой комнате стенд гонять нельзя — идти дальше не с чем'))
  process.exit(1)
}

const created = (await (
  await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: staffCookie },
    body: JSON.stringify({ name: `load ${new Date().toISOString().slice(0, 16)}` }),
  })
).json()) as { session?: { id?: string } }
const SID: string = created?.session?.id ?? ''
if (!SID) {
  console.error(red('семинар не завёлся — а работать стенд умеет только со своей комнатой'))
  process.exit(1)
}

/** Всё, что стенд открыл и завёл, он закрывает и удаляет — в любом исходе. */
let cleaned = false
async function cleanup(): Promise<void> {
  if (cleaned) return
  cleaned = true
  stopping = true
  for (const s of students) {
    try {
      s.aw.destroy()
      s.collab?.terminate()
      s.control?.terminate()
      s.doc.destroy()
    } catch {
      /* уже закрыт — уборке всё равно */
    }
  }
  try {
    const gone = await fetch(`${BASE}/api/admin/seminars/${SID}`, {
      method: 'DELETE',
      headers: { cookie: staffCookie },
    })
    say(gone.ok ? dim(`  убрано: семинар ${SID} удалён`) : red(`  не удалось удалить ${SID} (HTTP ${gone.status})`))
  } catch (err) {
    say(red(`  не удалось удалить ${SID}: ${err instanceof Error ? err.message : String(err)}`))
  }
}

/*
 * Ctrl+C — это тоже исход. Без этого прерванный прогон оставлял бы в чужой базе
 * пятьсот строк участников и комнату, которую никто не заводил руками.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(130))
  })
}

/* -------------------------------------------------------------------- прогон */

const okJoinMs: number[] = []
const refused = new Map<number, number>()
let joinErrors = 0

async function joinAndConnect(n: number): Promise<void> {
  const t0 = performance.now()
  let res: Response
  try {
    res = await fetch(`${BASE}/api/sessions/${SID}/join`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Штат мимо предела новых участников не считается: сервер пропускает
        // его без очереди. Умолчание — путь студента, тот, у которого потолок.
        ...(STAFF_JOIN ? { cookie: staffCookie } : {}),
      },
      body: JSON.stringify({ name: `Студент ${n}` }),
    })
  } catch {
    joinErrors++
    return
  }
  const text = await res.text()
  if (!res.ok) {
    /*
     * Отказ — самый быстрый ответ, который есть у двери, и мерить им время
     * входа значит мерить пустоту. Тот же урок, что записан в perf.mts.
     */
    refused.set(res.status, (refused.get(res.status) ?? 0) + 1)
    return
  }
  okJoinMs.push(performance.now() - t0)
  const body = JSON.parse(text) as {
    participant: { id: string; name: string; color: string; role: ParticipantRole }
    token: string
  }
  const p = body.participant
  const s = makeStudent(n, p.id, p.name, p.color, p.role, body.token)
  students.push(s)
  connect(s, SID)
}

/**
 * Сколько человек комната видит присутствием — не сколько сокетов открыто.
 *
 * Это проверка того, что стенд действительно ведёт себя как вкладка: `online`
 * считается по полю `user.id` в awareness (collab/index.ts · onlineParticipantIds),
 * так что число сходится только если имя и цвет доехали. Молчащее соединение
 * даст здесь ноль при пятистах открытых сокетах.
 */
async function onlineNow(): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/api/sessions/${SID}/participants`)
    const body = (await res.json()) as { online?: string[] }
    return Array.isArray(body?.online) ? body.online.length : null
  } catch {
    return null
  }
}

async function until(label: string, fn: () => boolean, limitMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    if (fn()) return true
    await sleep(100)
  }
  say(dim(`    (не дождались: ${label})`))
  return false
}

/* ---------------------------------------------------------------- шторм набора */

interface Armed {
  typists: Student[]
  observer: Student
  hops: number[]
  pending: Map<string, Array<{ seq: number; at: number }>>
}

/**
 * Готовим шторм ДО начала замера: k печатающих заводят по своей ячейке, а
 * наблюдатель — тот, кто не печатает, — вешает на них наблюдателей. Если делать
 * это внутри окна, всплеск от создания ячеек попадёт в кадры покоя.
 */
async function armStorm(): Promise<Armed | null> {
  const live = students.filter((s) => s.collab?.readyState === WS.OPEN && s.synced)
  if (live.length < 2) return null
  const typists = live.slice(0, Math.min(TYPISTS, live.length - 1))
  const observer = live[live.length - 1]

  for (const t of typists) {
    const { cell, id } = newCell(`# ${t.name}\n`)
    t.doc.transact(() => cellsOf(t.doc).push([cell]))
    // .get() работает только у встроенной ячейки — текст берём после push.
    t.cell = { id, text: cell.get('source') as Y.Text }
  }
  const arrived = await until(
    'наблюдатель получил ячейки печатающих',
    () => typists.every((t) => Boolean(findCell(observer.doc, t.cell!.id))),
    30_000,
  )
  if (!arrived) return null

  const hops: number[] = []
  const pending = new Map<string, Array<{ seq: number; at: number }>>()
  for (const t of typists) {
    const id = t.cell!.id
    const text = findCell(observer.doc, id)!.get('source') as Y.Text
    const queue: Array<{ seq: number; at: number }> = []
    pending.set(id, queue)
    text.observe(() => {
      const str = text.toString()
      // Метки одной ячейки приходят по порядку — первая в очереди и есть старшая.
      while (queue.length > 0 && str.includes(`#${queue[0].seq}#`)) {
        hops.push(performance.now() - queue.shift()!.at)
      }
    })
  }
  return { typists, observer, hops, pending }
}

interface Storm {
  typists: number
  keysSent: number
  seconds: number
}

/**
 * Шторм: каждый печатающий вписывает в свою ячейку `#seq#` m раз в секунду, а
 * на соседнем сокете сидит наблюдатель и ждёт ровно эту метку. Оба конца в
 * одном процессе, поэтому часы одни и вычитать нечего.
 *
 * Хвост (последние метки ещё в пути) намеренно остался снаружи: пока он идёт,
 * никто не печатает, и включить его в окно значило бы размазать и кадры, и
 * байты, и темп набора по секундам, в которые ничего не происходило.
 */
async function runStorm(armed: Armed, seconds: number): Promise<Storm> {
  const { typists, pending } = armed
  let seq = 0
  const perSecond = typists.length * KEYS
  /*
   * Один таймер на всех, по кругу. Настоящая аудитория печатает вразнобой, а не
   * залпом раз в двести миллисекунд; и пятьсот таймеров стенду ни к чему.
   */
  const batch = Math.max(1, Math.ceil(perSecond / 200))
  const every = (1000 * batch) / perSecond
  let cursor = 0
  const typing = setInterval(() => {
    for (let i = 0; i < batch; i++) {
      const t = typists[cursor++ % typists.length]
      const mark = ++seq
      // В очередь ДО вставки: иначе доставка могла бы обогнать собственный старт.
      pending.get(t.cell!.id)!.push({ seq: mark, at: performance.now() })
      t.doc.transact(() => t.cell!.text.insert(t.cell!.text.length, `#${mark}#`))
    }
  }, every)

  const at = performance.now()
  await sleep(seconds * 1000)
  clearInterval(typing)
  return { typists: typists.length, keysSent: seq, seconds: (performance.now() - at) / 1000 }
}

/** Сколько меток не доехало — после паузы, иначе последние сочтутся потерями. */
async function drain(armed: Armed): Promise<number> {
  await sleep(2_000)
  let lost = 0
  for (const queue of armed.pending.values()) lost += queue.length
  return lost
}

/* ------------------------------------------------------------------- таблица */

say()
say(bold('  colloq load') + dim(`  ${new Date().toISOString()}  ·  ${BASE}  ·  свой семинар ${SID}`))
say(
  dim(
    `  ${STUDENTS} студентов за ${RAMP_SEC}с · покой ${IDLE_SEC}с · шторм ${STORM_SEC}с (${TYPISTS}×${KEYS}/с)` +
      (STAFF_JOIN ? ' · вход кукой штата' : '') +
      (ECHO ? '' : ' · без эха присутствия'),
  ),
)
say()

let idleWin: Window | null = null
let stormWin: Window | null = null
let stormOut: Storm | null = null
let hopSamples: number[] = []
let synced = 0
let exitCode = 0

try {
  /* 1. ВХОД */
  const pace = STUDENTS > 1 ? (RAMP_SEC * 1000) / STUDENTS : 0
  const inFlight: Array<Promise<void>> = []
  const rampAt = performance.now()
  for (let n = 1; n <= STUDENTS; n++) {
    inFlight.push(joinAndConnect(n))
    if (pace > 0 && n < STUDENTS) await sleep(pace)
  }
  await Promise.all(inFlight)
  const rampSec = (performance.now() - rampAt) / 1000
  await until('все вошедшие синхронизировались', () => students.every((s) => s.synced), 60_000)
  synced = students.filter((s) => s.synced).length

  say(bold('  1. ВХОД') + dim('  — POST /api/sessions/:id/join, темпом ramp'))
  row('вошло', `${students.length} из ${STUDENTS}`, `${synced} прошли начальную синхронизацию Yjs`)
  const seen = await onlineNow()
  row(
    'видит комната',
    seen === null ? dim('—') : seen >= synced ? green(`${seen}`) : red(`${seen} из ${synced}`),
    'по присутствию: имя и цвет доехали до ростера',
  )
  const refusals = [...refused.entries()].sort((a, b) => b[1] - a[1])
  row(
    'отказано',
    refusals.length === 0 ? green('0') : red(refusals.map(([code, n]) => `${n}×${code}`).join(' · ')),
    refused.has(429) ? 'предел новых участников на комнату за минуту' : '',
  )
  if (joinErrors > 0) row('запрос не дошёл', red(String(joinErrors)), 'сеть или очередь сокетов этой машины')
  row('время ответа', `p50 ${ms(pct(okJoinMs, 50))} · худшее ${ms(worst(okJoinMs))}`,
    `n=${okJoinMs.length}, только принятые`)
  row('темп', `${((students.length / Math.max(rampSec, 0.001)) * 60).toFixed(0)} входов в минуту`,
    `рампа заняла ${rampSec.toFixed(1)}с`)
  if (socketErrors > 0 || closedWith.size > 0) {
    row('сокеты', red(`${socketErrors} ошибок · закрыты ${[...closedWith].map(([c, n]) => `${n}×${c}`).join(' ') || '—'}`), '')
  }
  say()

  if (students.length === 0) {
    say(red('  никто не вошёл — мерить нечего'))
    exitCode = 1
  } else {
    /* 2. ПОКОЙ */
    say(bold('  2. ПОКОЙ') + dim(`  — ${IDLE_SEC}с, никто не печатает, ${students.length} вкладок держат сокеты`))
    const idle = beginWindow()
    await sleep(IDLE_SEC * 1000)
    idleWin = endWindow(idle)
    printWindow(idleWin)
    say()

    /* 3. ШТОРМ */
    const armed = await armStorm()
    say(bold('  3. ШТОРМ') + dim(`  — ${armed?.typists.length ?? 0} печатают по ${KEYS}/с в свою ячейку, ${STORM_SEC}с`))
    if (!armed) {
      say(red('    не состоялся: нужно хотя бы два синхронизированных клиента'))
    } else {
      const win = beginWindow()
      stormOut = await runStorm(armed, STORM_SEC)
      stormWin = endWindow(win)
      const lost = await drain(armed)
      hopSamples = armed.hops
      row('нажатий', `${stormOut.keysSent}`,
        `${(stormOut.keysSent / stormOut.seconds).toFixed(0)}/с в комнату из ${armed.typists.length * KEYS} заданных`)
      row(
        'доставка правки',
        `p50 ${ms(pct(hopSamples, 50))} · p95 ${ms(pct(hopSamples, 95))} · худшее ${ms(worst(hopSamples))}`,
        `n=${hopSamples.length}` + (lost > 0 ? ` · ${lost} меток не доехало` : ''),
      )
      printWindow(stormWin)
    }
    say()
  }

  /* ------------------------------------------------------- где упёрлось */

  const hops = hopSamples
  const selfP95 = Math.max(idleWin?.selfLagP95 ?? 0, stormWin?.selfLagP95 ?? 0)
  const lagP95 = stormWin ? pct(stormWin.health.lag, 95) : NaN
  const cpu = stormWin?.cpuPct ?? null
  const outPerSec = Math.max(
    idleWin ? idleWin.bytesIn / idleWin.seconds : 0,
    stormWin ? stormWin.bytesIn / stormWin.seconds : 0,
  )
  const idlePerClient =
    idleWin && idleWin.clients > 0 ? idleWin.bytesIn / idleWin.clients / idleWin.seconds : NaN
  /** Первое сработавшее, а не список подозрений: одна строка — один вывод. */
  const walls: Array<[boolean, string]> = [
    [
      (refused.get(429) ?? 0) > 0,
      `предел новых участников — ${refused.get(429)} из ${STUDENTS} получили 429 ` +
        `(MAX_NEW_PARTICIPANTS, server/src/routes/sessions.ts). Растяните рампу LOAD_RAMP_SEC ` +
        `или пройдите мимо предела кукой штата: LOAD_STAFF_JOIN=1.`,
    ],
    [
      selfP95 > 100,
      `сам стенд — он ждал своего цикла p95 ${ms(selfP95)}, то есть мерил себя. ` +
        `Запускайте его с другой машины или убавьте LOAD_STUDENTS.`,
    ],
    [
      socketErrors > 0 || closedWith.size > 0,
      `сокеты — ${socketErrors} ошибок, закрытия ${[...closedWith].map(([c, n]) => `${n}×${c}`).join(' ')}. ` +
        `Смотрите ulimit -n на этой машине и журнал сервера.`,
    ],
    [
      Number.isFinite(lagP95) && lagP95 > 100,
      `цикл событий сервера — loopLag p95 ${ms(lagP95)} под штормом: столько же ждёт следующее нажатие.`,
    ],
    [
      cpu !== null && cpu > 85,
      `CPU серверного процесса — ${(cpu ?? 0).toFixed(0)}% под штормом. Кластера нет, второго ядра он не займёт.`,
    ],
    [
      stormWin !== null && (stormWin.health.failed > 0 || pct(stormWin.health.ms, 95) > 250),
      `HTTP комнаты — /api/health p95 ${ms(stormWin ? pct(stormWin.health.ms, 95) : NaN)}` +
        `${stormWin && stormWin.health.failed > 0 ? ` и ${stormWin.health.failed} проб без ответа` : ''}: ` +
        `столько же ждёт экран входа опоздавшего.`,
    ],
    [
      /*
       * Сто мегабит — обычный аплинк арендованной машины, и упереться в него
       * можно на одном присутствии: сервер рассылает каждое обновление всем, и
       * трафик растёт как квадрат числа вкладок.
       */
      outPerSec > 12 * 1024 * 1024,
      `исходящий канал сервера — ${size(outPerSec)}/с при ${synced} вкладках, ` +
        `это уже около ста мегабит на одну рассылку.`,
    ],
    [
      hops.length > 0 && pct(hops, 95) > 250,
      `доставка правки — p95 ${ms(pct(hops, 95))}: набор перестал ощущаться местным.`,
    ],
  ]
  const wall = walls.find(([hit]) => hit)
  say(
    wall
      ? red('  Упёрлось: ') + wall[1]
      : green(
          `  Не упёрлось: ${synced} клиентов держались, в покое ${size(idlePerClient)}/с на клиента, ` +
            `loopLag p95 ${ms(lagP95)}, доставка p95 ${ms(pct(hops, 95))}.`,
        ),
  )
  if (badFrames > 0) say(dim(`  ${badFrames} кадров стенд не разобрал — это его беда, а не сервера`))
  say(dim('  Стенд меряет сокеты и цикл событий: страницу он не рисует и ячейки не считает.'))
  say()
} catch (err) {
  say(red(`  прогон остановился: ${err instanceof Error ? err.message : String(err)}`))
  exitCode = 1
} finally {
  await cleanup()
}

// Живые сокеты и таймеры иначе держали бы цикл открытым.
process.exit(exitCode)
