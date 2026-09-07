/**
 * load.mts — выдержит ли ОДИН процесс пятьсот студентов в одной комнате.
 *
 * perf.mts отвечает на вопрос «быстро ли», когда в комнате двое, и меряет вес
 * бандла. Здесь вопрос другой: что делается с единственным процессом Node,
 * когда по ссылке приходит поток. Стенд заводит СВОЙ семинар, приводит в него N
 * поддельных вкладок — вход через `/join`, оба сокета, начальная синхронизация
 * Yjs, присутствие с именем и цветом, — держит их и меряет:
 *
 *   1 ВХОД      сколько прошло и сколько отказано, по кодам, и за сколько
 *   2 ПОКОЙ     кадров в секунду и байт на клиента, /api/health и loopLag оттуда
 *   3 ШТОРМ     k печатают по m нажатий в секунду: за сколько правка доезжает
 *   4 ДЕРЕВО    преподаватель заводит файлы: сколько это стоит всем остальным
 *   5 КОНСИЛИУМ N студентов пишут в свой лист при одном пульте: цена стопки
 *   6 ЛЕКЦИЯ    ведущий ведёт пером и указкой: цена кадра всему залу
 *
 * Разделы 4–6 добровольные (по умолчанию их нет) и меряют три РАЗНЫЕ формы
 * рассылки, которых в шторме нет вовсе: дерево — всем на каждое изменение,
 * консилиум — одному пульту от каждого из N, лекция — от одного всем N.
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
 *   LOAD_TREE         файлов в секунду в разделе 4 (0 — не гонять) default 0
 *   LOAD_TREE_SEC     сколько длится раздел 4  default 10
 *   LOAD_COUNCIL      сколько студентов пишут в свой лист (0 — не гонять) default 0
 *   LOAD_COUNCIL_EVERY  секунд между снимками одного студента default 2
 *   LOAD_COUNCIL_SEC  сколько длится раздел 5  default 10
 *   LOAD_INK          кадров пера в секунду в разделе 6 (0 — не гонять) default 0
 *   LOAD_INK_SEC      сколько длится раздел 6  default 10
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
// Потолок попытки — общий с сервером и с клиентом: снимок длиннее возвращается
// отказом, и стенд, который мерил бы такими, мерил бы отказы, а не стопку.
import { MAX_ATTEMPT_CHARS } from '@shared/notebook'
// И числительное — оттуда же: «1 штрихов» в отчёте стенда читается как опечатка
// в самом стенде, а копия правила тернарником уже однажды разошлась (shared/plural.ts).
import { plural } from '@shared/plural'

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
/*
 * Дерево файлов — вторая по величине рассылка после присутствия, и до сих пор
 * стенд её не трогал вовсе: он мерил комнату, в которой никто не кладёт
 * файлов. Один `tree:new` — это `broadcastFiles`, то есть ВЕСЬ список файлов
 * комнаты каждому пульту, и стоит он тем дороже, чем больше в комнате файлов.
 * По умолчанию 0: раздел добровольный, потому что он оставляет в комнате
 * файлы, а не только сокеты.
 */
const TREE_PER_SEC = num('LOAD_TREE', 0)
const TREE_SEC = num('LOAD_TREE_SEC', 10)
/*
 * Консилиум — единственная рассылка комнаты, которая идёт не всем, а ОДНОМУ.
 *
 * Снимок каждого пишущего ложится в стопку преподавателя, и платит за неё один
 * сокет: при пятистах пишущих «байт на клиента» останется покойным, а пульт
 * ведущего захлебнётся. Поэтому раздел меряет отдельно входящее пульта, а не
 * среднее по залу. По умолчанию 0 — он, как и дерево, оставляет в комнате
 * ячейку и попытки, а не только сокеты.
 */
const COUNCIL = Math.round(num('LOAD_COUNCIL', 0))
const COUNCIL_EVERY = Math.max(0.1, num('LOAD_COUNCIL_EVERY', 2))
const COUNCIL_SEC = num('LOAD_COUNCIL_SEC', 10)
/*
 * Лекция — та же рассылка наоборот: один ведущий, и каждый кадр пера уходит
 * всему залу целиком. Указка при этом склеивается сервером по такту
 * (@shared/lecture · LASER_EVERY_MS), а перо — нет, и раздел показывает
 * разницу: сколько кадров ушло с пульта и сколько байт из-за них получил зал.
 */
const INK_PER_SEC = num('LOAD_INK', 0)
const INK_SEC = num('LOAD_INK_SEC', 10)
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
/**
 * Вкладка преподавателя — одна на все добровольные разделы и НЕ в `students`.
 *
 * Не в списке потому, что окна считают байты на клиента по нему, а вкладка,
 * которая сама же создаёт нагрузку, портила бы среднее; одна потому, что
 * второй вход тем же штатом — это второй ведущий, а лекцию ведёт один
 * (control.ts · handOver), и разделы отбирали бы пульт друг у друга.
 */
let teacher: Student | null = null
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

/**
 * Оба сокета — как у вкладки: тетрадь и пульт. Присутствие объявляется на open.
 *
 * `cookie` — только для преподавателя, и без него его пульт бесправен.
 * Роль решается НА КАЖДОМ запросе (`roleFor`, routes/sessions.ts), а токен,
 * выданный под кукой штата, ведущим намеренно не записан (`tokenHost: role ===
 * 'host' && !staff`): право держится кукой, чтобы уход из штата снимал его
 * тут же. Вкладка эту куку несёт и в upgrade — стенд, который её не нёс,
 * получал по проводу `participant` при `host` в ответе на `/join` и молча
 * упирался в «Открывает ячейки преподаватель».
 */
function connect(s: Student, sessionId: string, cookie?: string): void {
  const opts = cookie ? { headers: { cookie } } : undefined
  const collab = new WS(`${WSB}/collab/${sessionId}?token=${encodeURIComponent(s.token)}`, opts)
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

  const control = new WS(`${WSB}/control/${sessionId}?token=${encodeURIComponent(s.token)}`, opts)
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
  // Вкладка преподавателя — вместе со всеми: она не в `students`, и без этой
  // строки её два сокета уходили бы только вместе с процессом.
  for (const s of teacher ? [...students, teacher] : students) {
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

/* ------------------------------------------------------------- дерево файлов */

interface Tree {
  made: number
  refused: number
  seconds: number
}

/**
 * Что пульт преподавателя услышал в ответ.
 *
 * Слушатель ОДИН на все разделы и вешается при входе. Вешать его в каждом
 * разделе значило бы складывать обработчики на одном сокете: третий раздел
 * считал бы каждый кадр трижды, а `ws` на одиннадцатом ругался бы утечкой.
 * Отказы копятся числом, а типы кадров — множеством: по нему разделы узнают,
 * что сервер принял лекцию или собрал стопку, не разбирая поток целиком.
 */
let teacherRefusals = 0
const teacherHeard = new Set<string>()

/**
 * Вход преподавателя: обычный `/join`, но кукой штата и с ролью на проводе.
 *
 * Заводить файлы, открывать консилиум и вести лекцию может только ведущий
 * (control.ts), а студенты стенда входят по ссылке. Почему эта вкладка не в
 * `students` — у самого объявления `teacher`.
 */
async function joinTeacher(): Promise<Student | null> {
  if (!staffCookie) return null
  let body: { participant: { id: string; name: string; color: string; role: ParticipantRole }; token: string }
  try {
    const res = await fetch(`${BASE}/api/sessions/${SID}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: staffCookie },
      body: JSON.stringify({ name: 'Преподаватель' }),
    })
    if (!res.ok) return null
    body = (await res.json()) as typeof body
  } catch {
    return null
  }
  const p = body.participant
  if (p.role !== 'host') return null
  const host = makeStudent(0, p.id, p.name, p.color, p.role, body.token)
  // С кукой: роль на проводе спрашивают у неё, а не у токена (см. `connect`).
  connect(host, SID, staffCookie)
  host.control?.on('message', (data: RawData) => {
    try {
      const msg = JSON.parse(String(data)) as { t?: string }
      if (typeof msg.t !== 'string') return
      teacherHeard.add(msg.t)
      if (msg.t === 'error' || msg.t === 'refused') teacherRefusals++
    } catch {
      /* пульт шлёт только JSON; всё прочее нас тут не касается */
    }
  })
  const ready = await until(
    'пульт преподавателя открылся',
    // И тетрадь: раздел консилиума заводит ячейку в документе, а до step2
    // отправлять её некуда — сервер такого документа ещё не видел.
    () => host.control?.readyState === WS.OPEN && host.synced,
    15_000,
  )
  return ready ? host : null
}

/** Один вход на все добровольные разделы: второй отобрал бы пульт у первого. */
async function theTeacher(): Promise<Student | null> {
  teacher ??= await joinTeacher()
  return teacher
}

/** Что сказал пульт за время работы: столько-то отказов. */
const refusalsSince = (was: number) => teacherRefusals - was

/**
 * Преподаватель заводит файлы, а комната получает дерево целиком — на каждый.
 *
 * Меряется не время создания (оно на диске и никого не ждёт), а цена рассылки:
 * байты и кадры в окне считаются по студентам, которые в это время не делают
 * ничего. Список растёт по ходу раздела нарочно — так видно, что рассылка
 * дорожает вместе с папкой.
 */
async function runTree(host: Student, seconds: number): Promise<Tree> {
  let made = 0
  const was = teacherRefusals
  const every = 1000 / Math.max(TREE_PER_SEC, 0.001)
  const at = performance.now()
  const making = setInterval(() => {
    // Плоская папка нарочно: дерево комнаты рассылается целиком, и стоимость
    // растёт от числа записей, а не от глубины.
    host.control?.send(JSON.stringify({ t: 'tree:new', path: `load-tree/f${++made}.txt` }))
  }, every)
  await sleep(seconds * 1000)
  clearInterval(making)
  // Папку за собой убираем сразу: семинар удаляется в finally, но раздел
  // могут гонять и по нескольку раз за прогон.
  host.control?.send(JSON.stringify({ t: 'tree:remove', path: 'load-tree' }))
  return { made, refused: refusalsSince(was), seconds: (performance.now() - at) / 1000 }
}

/* ---------------------------------------------------------------- консилиум */

interface Council {
  writers: number
  drafts: number
  submits: number
  seconds: number
  /** Входящее ОДНОГО пульта: стопка идёт ему, а не залу. */
  hostFrames: number
  hostBytes: number
  refused: number
}

/**
 * Преподаватель заводит ячейку и открывает в ней консилиум.
 *
 * Порядок важен и проверяется ожиданием, а не паузой: ячейка едет документом
 * (CRDT), замок — управляющим проводом, и снимок в ячейку, которой сервер ещё
 * не видел, вернулся бы отказом «ячейка закрыта» — стенд намерил бы отказы
 * вместо стопки.
 */
async function openCouncilCell(host: Student, writers: Student[]): Promise<string | null> {
  const { cell, id } = newCell('# решение\n')
  host.doc.transact(() => cellsOf(host.doc).push([cell]))
  const arrived = await until(
    'ячейка консилиума доехала до пишущих',
    () => writers.every((s) => Boolean(findCell(s.doc, id))),
    30_000,
  )
  if (!arrived) return null
  host.control?.send(JSON.stringify({ t: 'cell:lock', cellId: id, state: 'council' }))
  // Замок сервер пишет в саму ячейку (`open: 'council'`), и ждать надо именно
  // его: пульт подтверждения не шлёт, а без замка права на свой лист нет.
  const open = await until(
    'замок консилиума открылся у пишущих',
    () => writers.every((s) => findCell(s.doc, id)?.get('open') === 'council'),
    15_000,
  )
  return open ? id : null
}

/** Попытка примерно того размера, что пишут на паре: снимок едет ЦЕЛИКОМ. */
function attemptText(s: Student, round: number): string {
  const body =
    `import numpy as np\n\n# ${s.name}\ndef solve(df):\n` +
    '    x = df["value"].to_numpy()\n    x = x[x > 0]\n'.repeat(4) +
    `    return x.mean()  # правка ${round}\n`
  return body.length > MAX_ATTEMPT_CHARS ? body.slice(0, MAX_ATTEMPT_CHARS) : body
}

/**
 * N студентов пишут в свой лист, один пульт собирает стопку.
 *
 * Снимок уходит на паузу в наборе (~1 с у настоящей вкладки), и цена его не в
 * зале, а у преподавателя: `council:mine` автору и стопка — ведущему. Комната
 * при этом молчит: счётчик сданных едет всем, только когда он СМЕНИЛСЯ, — и
 * ровно поэтому раздел кончается сдачей разом, той самой минутой, когда
 * преподаватель говорит «сдавайте» и счётчик двигается N раз подряд.
 */
async function runCouncil(
  host: Student,
  writers: Student[],
  cellId: string,
  seconds: number,
): Promise<Council> {
  const was = teacherRefusals
  host.frames = 0
  host.bytesIn = 0
  let drafts = 0
  const rounds = new Map<number, number>()
  const perSecond = writers.length / COUNCIL_EVERY
  // Один таймер по кругу — как в шторме: пятьсот таймеров стенду ни к чему, а
  // залпом раз в две секунды настоящая аудитория не печатает.
  const batch = Math.max(1, Math.ceil(perSecond / 200))
  const every = (1000 * batch) / perSecond
  let cursor = 0
  const at = performance.now()
  const writing = setInterval(() => {
    for (let i = 0; i < batch; i++) {
      const s = writers[cursor++ % writers.length]
      const round = (rounds.get(s.n) ?? 0) + 1
      rounds.set(s.n, round)
      drafts++
      s.control?.send(
        JSON.stringify({ t: 'council:draft', cellId, text: attemptText(s, round) }),
      )
    }
  }, every)
  await sleep(seconds * 1000)
  clearInterval(writing)
  return {
    writers: writers.length,
    drafts,
    submits: 0,
    seconds: (performance.now() - at) / 1000,
    hostFrames: host.frames,
    hostBytes: host.bytesIn,
    refused: refusalsSince(was),
  }
}

/**
 * «Сдавайте» — и класс сдаёт разом.
 *
 * Отдельным замером, а не хвостом снимков: сдача двигает счётчик, а счётчик
 * идёт ВСЕЙ комнате, то есть это единственный кадр консилиума, за который
 * платят все пятьсот. Растянуто на пару секунд — столько занимает нажатие у
 * класса, которому только что сказали.
 */
async function runCouncilRush(host: Student, writers: Student[], cellId: string): Promise<Council> {
  const was = teacherRefusals
  host.frames = 0
  host.bytesIn = 0
  const at = performance.now()
  let sent = 0
  const every = Math.max(1, 2000 / Math.max(writers.length, 1))
  await new Promise<void>((done) => {
    const rushing = setInterval(() => {
      // Индекс проверяется ДО счётчика: иначе последний тик, на котором сдавать
      // уже некому, всё равно прибавлял бы себя, и раздел печатал бы на одно
      // нажатие больше, чем сделал.
      const s = writers[sent]
      if (!s) {
        clearInterval(rushing)
        done()
        return
      }
      sent++
      s.control?.send(JSON.stringify({ t: 'council:submit', cellId }))
    }, every)
  })
  // Хвост: счётчики и стопка идут дребезгом (BOARD_EVERY_MS), и окно, закрытое
  // на последнем нажатии, не увидело бы того, за что комната и платит.
  await sleep(1_500)
  return {
    writers: writers.length,
    drafts: 0,
    submits: sent,
    seconds: (performance.now() - at) / 1000,
    hostFrames: host.frames,
    hostBytes: host.bytesIn,
    refused: refusalsSince(was),
  }
}

/* ------------------------------------------------------------------- лекция */

interface Lecture {
  ink: number
  laser: number
  strokes: number
  seconds: number
  refused: number
}

/**
 * Лекция на N зрителей: перо и указка с одного пульта.
 *
 * Документ заводится пустым файлом с расширением .pdf и не открывается никем:
 * страницу здесь никто не рисует, а серверу для лекции нужен файл, а не его
 * содержимое (control.ts · lecture:start смотрит только `kindOf` и `statPath`).
 * То, что меряется, — цена КАДРА: `ink` уходит залу на каждый, `laser` сервер
 * склеивает по такту, и разница между «послано» и «получено» и есть ответ.
 */
async function runLecture(host: Student, seconds: number): Promise<Lecture | null> {
  const was = teacherRefusals
  const file = 'load-lecture.pdf'
  teacherHeard.delete('lecture')
  host.control?.send(JSON.stringify({ t: 'tree:new', path: file }))
  host.control?.send(JSON.stringify({ t: 'lecture:start', file }))
  const started = await until('лекция началась', () => teacherHeard.has('lecture'), 15_000)
  if (!started) return null

  let ink = 0
  let laser = 0
  let strokes = 1
  let points = 0
  let id = 'load_ink_1'
  const every = 1000 / Math.max(INK_PER_SEC, 0.001)
  const at = performance.now()
  const drawing = setInterval(() => {
    /*
     * Один штрих ведётся точками, а не отправляется целиком: так пишет пульт
     * (InkLayer · SEND_EVERY_MS) и так его видит зал — линией, пока её ведут.
     * Штрих меняется, не дойдя до потолка точек (shared/lecture.ts), чтобы
     * раздел мерил рассылку, а не отказ «штрих полон».
     */
    if (points >= 200) {
      id = `load_ink_${++strokes}`
      points = 0
    }
    const phase = (ink % 100) / 100
    const x = 0.1 + phase * 0.8
    const y = 0.5 + Math.sin(phase * Math.PI * 4) * 0.2
    host.control?.send(
      JSON.stringify({
        t: 'ink',
        page: 1,
        id,
        color: '#ef6ba8',
        width: 0.004,
        points: [x, y, x + 0.008, y],
      }),
    )
    ink++
    points += 2
    // Указка идёт тем же движением руки — и тем же тактом с пульта; склеивает
    // её сервер, и разницу видно в «получено залом».
    host.control?.send(JSON.stringify({ t: 'laser', page: 1, x, y, shape: 'line' }))
    laser++
  }, every)
  await sleep(seconds * 1000)
  clearInterval(drawing)
  host.control?.send(JSON.stringify({ t: 'laser:off' }))
  host.control?.send(JSON.stringify({ t: 'lecture:stop' }))
  host.control?.send(JSON.stringify({ t: 'tree:remove', path: file }))
  return { ink, laser, strokes, seconds: (performance.now() - at) / 1000, refused: refusalsSince(was) }
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
      (TREE_PER_SEC > 0 ? ` · дерево ${TREE_PER_SEC}/с` : '') +
      (COUNCIL > 0 ? ` · консилиум ${COUNCIL} раз в ${COUNCIL_EVERY}с` : '') +
      (INK_PER_SEC > 0 ? ` · лекция ${INK_PER_SEC} кадров/с` : '') +
      (STAFF_JOIN ? ' · вход кукой штата' : '') +
      (ECHO ? '' : ' · без эха присутствия'),
  ),
)
say()

let idleWin: Window | null = null
let stormWin: Window | null = null
let stormOut: Storm | null = null
let treeWin: Window | null = null
let treeOut: Tree | null = null
let councilWin: Window | null = null
let councilOut: Council | null = null
let lectureWin: Window | null = null
let lectureOut: Lecture | null = null
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

    /* 4. ДЕРЕВО ФАЙЛОВ */
    if (TREE_PER_SEC > 0) {
      say(
        bold('  4. ДЕРЕВО') +
          dim(`  — преподаватель заводит ${TREE_PER_SEC} файлов в секунду, ${TREE_SEC}с`),
      )
      const host = await theTeacher()
      if (!host) {
        say(red('    не состоялся: войти в комнату ведущим не вышло (нужна кука штата)'))
      } else {
        const win = beginWindow()
        const tree = await runTree(host, TREE_SEC)
        treeWin = endWindow(win)
        treeOut = tree
        row(
          'заведено файлов',
          `${tree.made}`,
          `${(tree.made / tree.seconds).toFixed(1)}/с · столько же рассылок дерева всей комнате` +
            (tree.refused > 0 ? red(` · ${tree.refused} отказов от пульта`) : ''),
        )
        printWindow(treeWin)
        say(
          dim(
            '    сравните «входящий» с покоем: это цена одного файла, помноженная на комнату',
          ),
        )
      }
      say()
    }

    /* 5. КОНСИЛИУМ */
    if (COUNCIL > 0) {
      say(
        bold('  5. КОНСИЛИУМ') +
          dim(
            `  — ${COUNCIL} пишут в свой лист раз в ${COUNCIL_EVERY}с, ${COUNCIL_SEC}с, ` +
              'потом сдают разом',
          ),
      )
      const host = await theTeacher()
      const writers = students
        .filter((s) => s.control?.readyState === WS.OPEN && s.synced)
        .slice(0, COUNCIL)
      if (!host) {
        say(red('    не состоялся: войти в комнату ведущим не вышло (нужна кука штата)'))
      } else if (writers.length === 0) {
        say(red('    не состоялся: некому писать — ни одного синхронизированного студента'))
      } else {
        const cellId = await openCouncilCell(host, writers)
        if (!cellId) {
          say(red('    не состоялся: консилиум в ячейке не открылся'))
        } else {
          const win = beginWindow()
          const council = await runCouncil(host, writers, cellId, COUNCIL_SEC)
          councilWin = endWindow(win)
          councilOut = council
          row(
            'снимков',
            `${council.drafts}`,
            `${(council.drafts / council.seconds).toFixed(1)}/с от ${council.writers} ` +
              `${plural(council.writers, 'пишущего', 'пишущих', 'пишущих')}` +
              (council.refused > 0 ? red(` · ${council.refused} отказов пульту`) : ''),
          )
          row(
            'пульту ведущего',
            `${size(council.hostBytes / council.seconds)}/с · ` +
              `${(council.hostFrames / council.seconds).toFixed(1)} кадров/с`,
            `${size(council.hostBytes / Math.max(council.drafts, 1))} на снимок: стопка идёт ему одному`,
          )
          printWindow(councilWin)
          say(dim('    зал в это время молчит: счётчик едет всем, только когда он сменился'))

          const rushWin = beginWindow()
          const rush = await runCouncilRush(host, writers, cellId)
          const closed = endWindow(rushWin)
          say()
          say(
            bold('     сдача разом') +
              dim(
                `  — ${rush.submits} ${plural(rush.submits, 'нажатие', 'нажатия', 'нажатий')} ` +
                  '«Сдать» подряд',
              ),
          )
          row(
            'пульту ведущего',
            `${size(rush.hostBytes)} за ${rush.seconds.toFixed(1)}с`,
            `${rush.hostFrames} ${plural(rush.hostFrames, 'кадр', 'кадра', 'кадров')}` +
              (rush.refused > 0 ? red(` · ${rush.refused} отказов`) : ''),
          )
          row(
            'залу',
            `${size(closed.bytesIn / Math.max(closed.clients, 1))} на клиента`,
            'счётчик сданных двигается на каждое нажатие — и едет всем',
          )
        }
      }
      say()
    }

    /* 6. ЛЕКЦИЯ */
    if (INK_PER_SEC > 0) {
      say(
        bold('  6. ЛЕКЦИЯ') +
          dim(`  — ведущий ведёт пером ${INK_PER_SEC} кадров/с и указкой, ${INK_SEC}с`),
      )
      const host = await theTeacher()
      if (!host) {
        say(red('    не состоялся: войти в комнату ведущим не вышло (нужна кука штата)'))
      } else {
        const win = beginWindow()
        const lecture = await runLecture(host, INK_SEC)
        const closed = endWindow(win)
        if (!lecture) {
          say(red('    не состоялся: лекция не началась (документ или право `board`)'))
        } else {
          lectureWin = closed
          lectureOut = lecture
          row(
            'кадров с пульта',
            `${lecture.ink} пером · ${lecture.laser} указкой`,
            `${lecture.strokes} ${plural(lecture.strokes, 'штрих', 'штриха', 'штрихов')}` +
              (lecture.refused > 0 ? red(` · ${lecture.refused} отказов пульту`) : ''),
          )
          row(
            'цена кадра залу',
            `${size(closed.bytesIn / Math.max(lecture.ink + lecture.laser, 1))} на кадр`,
            `${closed.clients} ${plural(closed.clients, 'зритель', 'зрителя', 'зрителей')} · ` +
              'перо уходит каждому, указка склеена тактом сервера',
          )
          printWindow(closed)
        }
      }
      say()
    }
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
    [
      /*
       * Один файл — один список файлов каждому пульту, и список этот растёт.
       * Мегабайт на один заведённый файл означает, что папка комнаты уже
       * дороже, чем всё присутствие вместе взятое.
       */
      treeWin !== null && treeOut !== null && treeOut.made > 0 &&
        treeWin.bytesIn / treeOut.made > 1024 * 1024,
      `дерево файлов — один заведённый файл стоил комнате ` +
        `${size((treeWin?.bytesIn ?? 0) / Math.max(treeOut?.made ?? 1, 1))} рассылки: ` +
        `список уходит целиком и каждому (broadcastFiles, server/src/control.ts).`,
    ],
    [
      /*
       * Стопка идёт ОДНОМУ сокету, и упирается в него не канал комнаты, а
       * пульт преподавателя: мегабит на снимок при сотне пишущих — это уже
       * десятки мегабит в один провод, и первым перестанет листать тот, кто
       * ведёт занятие.
       */
      councilOut !== null && councilOut.drafts > 0 &&
        councilOut.hostBytes / councilOut.seconds > 1.5 * 1024 * 1024,
      `стопка консилиума — пульту ведущего шло ` +
        `${size((councilOut?.hostBytes ?? 0) / Math.max(councilOut?.seconds ?? 1, 0.001))}/с ` +
        `от ${councilOut?.writers ?? 0} пишущих: она собирается на каждый снимок и едет ему одному ` +
        `(boardOut, server/src/control.ts).`,
    ],
    [
      /*
       * Кадр пера — самый частый кадр лекции, и он уходит всем: перо на
       * двадцати пяти кадрах в секунду при пятистах зрителях — это
       * двенадцать с половиной тысяч отправок в секунду из одного цикла.
       */
      lectureWin !== null && lectureOut !== null && lectureOut.ink > 0 &&
        lectureWin.bytesIn / lectureWin.seconds > 12 * 1024 * 1024,
      `лекция — ${size((lectureWin?.bytesIn ?? 0) / Math.max(lectureWin?.seconds ?? 1, 0.001))}/с ` +
        `в зал при ${lectureOut?.ink ?? 0} кадрах пера: чернила рассылаются на каждый кадр, ` +
        `без такта (control.ts · case 'ink').`,
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
