/**
 * load.mts: will ONE process survive five hundred students in one room.
 *
 * perf.mts answers the question "is it fast" when there are two people in the
 * room, and measures the bundle weight. Here the question is different: what
 * happens to the single Node process when a stream of people comes in by the
 * link. The harness creates ITS OWN seminar, brings N fake tabs into it (join
 * through `/join`, both sockets, the initial Yjs sync, presence with a name
 * and a color), holds them and measures:
 *
 *   1 JOIN      how many got in and how many were refused, by code, and how fast
 *   2 IDLE      frames per second and bytes per client, /api/health and loopLag from it
 *   3 STORM     k type m keystrokes per second: how fast an edit arrives
 *   4 TREE      the teacher creates files: what that costs everyone else
 *   5 COUNCIL   N students write into their own sheet with one console: the cost of the stack
 *   6 LECTURE   the host draws with the pen and the pointer: the cost of a frame for the whole room
 *
 * Sections 4–6 are optional (off by default) and measure three DIFFERENT forms
 * of broadcast that the storm does not have at all: the tree goes to everyone
 * on every change, the council to one console from each of N, the lecture from
 * one to all N.
 *
 * Next to every window stand the CPU and RSS of the server process, if the
 * harness runs on the same machine and the pid is given as a parameter.
 *
 * What it does NOT measure: it does not draw the page, does not compute cells,
 * does not start a kernel and knows nothing about browser memory. This is load
 * on the sockets and on the event loop, and a real tab adds a cost of its own
 * on top of these numbers.
 *
 * It must not be run against someone else's seminar, and it has no way to: it
 * creates the room itself and deletes it in finally, including on Ctrl+C. Five
 * hundred participant rows left in someone else's database never leave it,
 * and there may be people sitting in the room.
 *
 * Usage: make load   (or npx tsx scripts/load.mts)
 *   LOAD_BASE_URL     where to connect           default http://localhost:3000
 *   LOAD_STUDENTS     how many students          default 500
 *   LOAD_RAMP_SEC     how long they take to join default 60
 *   LOAD_IDLE_SEC     the idle window            default 15
 *   LOAD_TYPISTS      k, how many type           default 20
 *   LOAD_KEYS         m, keystrokes per second   default 5
 *   LOAD_STORM_SEC    how long the storm lasts   default 20
 *   LOAD_TREE         files per second in section 4 (0: skip it) default 0
 *   LOAD_TREE_SEC     how long section 4 lasts   default 10
 *   LOAD_COUNCIL      how many students write into their sheet (0: skip it) default 0
 *   LOAD_COUNCIL_EVERY  seconds between one student's snapshots default 2
 *   LOAD_COUNCIL_SEC  how long section 5 lasts   default 10
 *   LOAD_INK          pen frames per second in section 6 (0: skip it) default 0
 *   LOAD_INK_SEC      how long section 6 lasts   default 10
 *   LOAD_SERVER_PID   pid of the server process (systemctl show -p MainPID colloq)
 *   LOAD_SETUP_TOKEN  the setup token, if there is no file nearby (a remote instance)
 *   LOAD_STAFF_COOKIE a ready `colloq_staff=...` cookie, if there is no token at all
 *   LOAD_STAFF_JOIN   1: join with the staff cookie, past the new-participant limit
 *   LOAD_ECHO         1: repeat other people's presence to the server, as tabs
 *                     did before presence.ts · ownChanges (see below) default 0
 *   DATA_DIR          where setup-token lies     default <repo>/data
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
// The attempt ceiling is shared with the server and the client: a longer
// snapshot comes back as a refusal, and a harness that measured with such
// snapshots would measure refusals, not the stack.
import { MAX_ATTEMPT_CHARS } from '@shared/notebook'

/**
 * English plural for the report: "1 stroke", "21 strokes". The report used to
 * be Russian and borrowed the Russian rule from shared/plural.ts; with English
 * words that rule prints "21 stroke". "1 strokes" would read as a typo in the
 * harness itself.
 */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/* --------------------------------------------------------------- settings */

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
 * The file tree is the second largest broadcast after presence, and until now
 * the harness did not touch it at all: it measured a room where nobody puts
 * files. One `tree:new` is `broadcastFiles`, that is, the WHOLE file list of
 * the room to every console, and it costs more the more files the room has.
 * 0 by default: the section is optional because it leaves files in the room,
 * not just sockets.
 */
const TREE_PER_SEC = num('LOAD_TREE', 0)
const TREE_SEC = num('LOAD_TREE_SEC', 10)
/*
 * The council is the only broadcast of the room that goes not to everyone but
 * to ONE.
 *
 * Every writer's snapshot lands in the teacher's stack, and one socket pays
 * for it: with five hundred writers "bytes per client" stays calm, while the
 * host's console chokes. So the section measures the console's incoming
 * traffic separately, not the average across the room. 0 by default: like the
 * tree, it leaves a cell and attempts in the room, not just sockets.
 */
const COUNCIL = Math.round(num('LOAD_COUNCIL', 0))
const COUNCIL_EVERY = Math.max(0.1, num('LOAD_COUNCIL_EVERY', 2))
const COUNCIL_SEC = num('LOAD_COUNCIL_SEC', 10)
/*
 * The lecture is the same broadcast in reverse: one host, and every pen frame
 * goes to the whole room. The pointer is merged by the server per tick
 * (@shared/lecture · LASER_EVERY_MS), the pen is not, and the section shows
 * the difference: how many frames left the console and how many bytes the
 * room got because of them.
 */
const INK_PER_SEC = num('LOAD_INK', 0)
const INK_SEC = num('LOAD_INK_SEC', 10)
const SERVER_PID = (process.env.LOAD_SERVER_PID ?? '').trim()
const STAFF_JOIN = process.env.LOAD_STAFF_JOIN === '1'
/*
 * A real tab NO LONGER repeats other people's presence to the server.
 *
 * It used to: `_awarenessUpdateHandler` in y-websocket sends every changed
 * clientID into the socket, not telling its own from the ones that arrived,
 * and every frame came back to the server as many times as there were tabs in
 * the room. This is gone on both sides: web/src/lib/presence.ts · ownChanges
 * filters out foreign clientIDs before sending, and the provider comes up with
 * disableBc (session.svelte.ts), so neighbouring tabs do not retell each other
 * that as well.
 *
 * Hence the default is 0. With 1 the harness loaded the server with work that
 * does not exist in a real room at all: the server's idle CPU was overstated
 * 2.7 times, and the harness answered "will it survive the stream" about
 * someone else's room. The 1 remains for one question: what bringing back the
 * old behaviour would cost.
 */
const ECHO = process.env.LOAD_ECHO === '1'

/** y-websocket frame tags. The numbers are the protocol, not a choice. */
const MSG_SYNC = 0
const MSG_AWARENESS = 1

const HEALTH_EVERY_MS = 500
/** The timer step with which the harness watches ITS OWN event loop. */
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

/** A percentile over unsorted samples, nearest rank, as in perf.mts. */
function pct(samples: number[], p: number): number {
  if (samples.length === 0) return NaN
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
/** Math.max(...xs, NaN) is always NaN, so the worst is computed separately. */
const worst = (xs: number[]) => (xs.length === 0 ? NaN : Math.max(...xs))

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - plain(s).length))

const say = (s = '') => console.log(s)
const row = (label: string, value: string, note = '') =>
  say('    ' + pad(label, 22) + pad(value, 45) + (note ? dim(note) : ''))

/* ------------------------------------------------------ signing in to the panel */

/**
 * The same door as in e2e.mts and perf.mts: the setup token from disk, spent
 * on its second job of its own, signing in as the founder. An unclaimed
 * instance is not claimed: a harness that became the owner of someone else's
 * installation takes the first screen away from the teacher.
 *
 * If there is no token nearby (the harness is run against a machine over the
 * network), it can be named as a parameter, LOAD_SETUP_TOKEN, and if there is
 * none of that either, a ready LOAD_STAFF_COOKIE cookie. There is nothing to
 * guess here: without staff a seminar cannot be created, and without its own
 * seminar the harness has nothing to work with.
 */
let staffCookie = ''

async function signInAsStaff(): Promise<string | null> {
  const given = (process.env.LOAD_STAFF_COOKIE ?? '').trim()
  if (given) {
    staffCookie = given.split(';')[0]
    return staffCookie.startsWith('colloq_staff=') ? null : 'LOAD_STAFF_COOKIE is not a colloq_staff= cookie'
  }
  const tokenFile = resolve(process.env.DATA_DIR ?? join(ROOT, 'data'), 'setup-token')
  let token = (process.env.LOAD_SETUP_TOKEN ?? '').trim()
  if (!token) {
    try {
      token = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      return `no setup token in ${tokenFile} or in LOAD_SETUP_TOKEN, and no cookie in LOAD_STAFF_COOKIE`
    }
  }
  try {
    const state = (await (await fetch(`${BASE}/api/admin/state`)).json()) as { claimed?: boolean }
    if (!state?.claimed) return 'nobody has claimed this instance yet — claim it in /admin and run again'
    const res = await fetch(`${BASE}/api/admin/signin/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) return `sign-in refused (${res.status})`
    staffCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    return staffCookie.startsWith('colloq_staff=') ? null : 'no staff cookie was issued'
  } catch (err) {
    return err instanceof Error ? err.message : 'sign-in failed'
  }
}

/* ------------------------------------------------- fake tab (client) */

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
  /** Window counters: reset at the start of every measurement. */
  frames: number
  bytesIn: number
  echoes: number
  cell: { id: string; text: Y.Text } | null
}

const students: Student[] = []
/**
 * The teacher's tab: one for all the optional sections and NOT in `students`.
 *
 * Not in the list because the windows compute bytes per client from it, and a
 * tab that creates the load itself would spoil the average; one because a
 * second sign-in as the same staff member is a second host, while a lecture
 * has one host (control.ts · handOver), and the sections would take the
 * console from each other.
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
    /* the socket is already closed: the frame simply did not go out, close and error keep the count */
  }
}

/** A cell of exactly the shape the gate accepts: the same keys as in e2e.mts. */
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
  // The root types are declared BEFORE the first foreign update, otherwise Yjs
  // does not know their shape; SessionState and both neighbouring scripts do
  // the same.
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
   * The local presence state is NOT reset. `Awareness` creates it as an empty
   * object in the constructor, and `setLocalStateField` silently does nothing
   * on `null`: a harness that reset it "like the server" would hold five
   * hundred sockets the room does not know about: no roster, no cursors, no
   * presence broadcast, that is, exactly the load the whole thing was started
   * for would not be created at all. This is checked below, by `online` from
   * the server.
   */

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    // What arrived over the wire is not sent back: readSyncMessage sets origin.
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
      // Our own presence comes with origin 'local'; everything else is echo (see ECHO).
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
        // step2 is the server's answer to our step1: from it the tab is synced.
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
 * Both sockets, like a tab's: the notebook and the console. Presence is
 * announced on open.
 *
 * `cookie` is only for the teacher, and without it the teacher's console has
 * no rights. The role is decided ON EVERY request (`roleFor`,
 * routes/sessions.ts), and a token issued under a staff cookie is deliberately
 * not recorded as host (`tokenHost: role === 'host' && !staff`): the right is
 * held by the cookie, so that leaving the staff removes it at once. A tab
 * carries this cookie into the upgrade as well; a harness that did not carry
 * it got `participant` over the wire with `host` in the `/join` answer, and
 * silently ran into "Only the teacher may open cells."
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
     * Name, color and role: what the room draws the roster and cursors from,
     * and exactly the frame the server broadcasts to everyone else. The color
     * is the one the server issued (colorForId), not our own: the browser also
     * takes it from the /join answer.
     */
    const user: AwarenessUser = {
      id: s.id,
      name: s.name,
      avatar: null,
      color: s.color,
      // The role is our own too: under LOAD_STAFF_JOIN the server hands out a
      // host, and a tab that announced itself a participant would be corrected
      // by the server on every frame.
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

/* --------------------------------------------------------------- meters */

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
 * CPU and RSS of the server process, through `ps`, by the named pid.
 *
 * Not `%cpu`: it is averaged over the whole life of the process, and a server
 * started an hour ago shows calm under any storm. We take the accumulated CPU
 * time at the window's edges and divide by real seconds: that is the load
 * DURING the window.
 *
 * Works only if the harness runs on the same machine. The pid is given as a
 * parameter: there is nothing to guess it by (under systemd it is MainPID,
 * under `make run` a child of tsx), and mixing up processes means printing
 * someone else's numbers.
 */
function procSample(): Proc | null {
  if (!SERVER_PID) return null
  try {
    const out = execFileSync('ps', ['-o', 'time=,rss=', '-p', SERVER_PID], { encoding: 'utf8' }).trim()
    const [time, rss] = out.split(/\s+/)
    if (!time || !rss) return null
    // `[[dd-]hh:]mm:ss[.ff]`: Linux and macOS print it differently, we read both.
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
     * The delay of OUR OWN loop. Five hundred Yjs documents in one process are
     * load too, and if the harness chokes, all the numbers below become a
     * lower bound. Saying so is more honest than printing them silently.
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
  row('frames per second', `${(w.frames / each / w.seconds).toFixed(1)} per client`,
    `${Math.round(w.frames / w.seconds)} in total`)
  row('incoming', `${size(w.bytesIn / each / w.seconds)}/s per client`,
    `${size(w.bytesIn / w.seconds)}/s in total, after decompression`)
  row('/api/health',
    `p50 ${ms(pct(w.health.ms, 50))} · p95 ${ms(pct(w.health.ms, 95))} · worst ${ms(worst(w.health.ms))}`,
    w.health.failed > 0 ? red(`${w.health.failed} probes unanswered`) : `n=${w.health.ms.length}`)
  row('server loopLag',
    `p50 ${ms(pct(w.health.lag, 50))} · p95 ${ms(pct(w.health.lag, 95))} · worst ${ms(worst(w.health.lag))}`,
    'the next keystroke would wait this long')
  if (w.cpuPct !== null && w.rssMb !== null) {
    row('server', `CPU ${w.cpuPct.toFixed(0)}% · RSS ${w.rssMb.toFixed(0)}M`, `pid ${SERVER_PID}`)
  } else {
    row('server', dim('—'), 'CPU and RSS: name LOAD_SERVER_PID, with the harness on the same machine')
  }
  if (ECHO && w.echoes > 0) {
    row('presence echo', `${w.echoes} frames back`,
      `${Math.round(w.echoes / w.seconds)}/s of foreign ones — how tabs behaved BEFORE ownChanges`)
  }
  if (w.selfLagP95 > 50) {
    say(red(`    the harness waited for ITS OWN loop p95 ${ms(w.selfLagP95)} — the numbers above are a lower bound`))
  }
}

/* ------------------------------------------------------------------ seminar */

const problem = await signInAsStaff()
if (problem) {
  console.error(red(`could not sign in as staff: ${problem}`))
  console.error(dim('only staff can create a seminar, and the harness must not be run against another room — nothing to go on with'))
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
  console.error(red('the seminar was not created — and the harness can only work with a room of its own'))
  process.exit(1)
}

/** Everything the harness opened and created, it closes and deletes, whatever the outcome. */
let cleaned = false
async function cleanup(): Promise<void> {
  if (cleaned) return
  cleaned = true
  stopping = true
  // The teacher's tab goes together with everyone: it is not in `students`,
  // and without this line its two sockets would leave only with the process.
  for (const s of teacher ? [...students, teacher] : students) {
    try {
      s.aw.destroy()
      s.collab?.terminate()
      s.control?.terminate()
      s.doc.destroy()
    } catch {
      /* already closed: the cleanup does not care */
    }
  }
  try {
    const gone = await fetch(`${BASE}/api/admin/seminars/${SID}`, {
      method: 'DELETE',
      headers: { cookie: staffCookie },
    })
    say(gone.ok ? dim(`  cleaned up: seminar ${SID} deleted`) : red(`  could not delete ${SID} (HTTP ${gone.status})`))
  } catch (err) {
    say(red(`  could not delete ${SID}: ${err instanceof Error ? err.message : String(err)}`))
  }
}

/*
 * Ctrl+C is an outcome too. Without this an interrupted run would leave five
 * hundred participant rows in someone else's database and a room that nobody
 * created by hand.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(130))
  })
}

/* -------------------------------------------------------------------- the run */

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
        // Staff is not counted against the new-participant limit: the server
        // lets it through without queueing. The default is the student's path,
        // the one with the ceiling.
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
     * A refusal is the fastest answer the door has, and measuring join time by
     * it means measuring emptiness. The same lesson as recorded in perf.mts.
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
 * How many people the room sees by presence, not how many sockets are open.
 *
 * This checks that the harness really behaves like a tab: `online` is counted
 * by the `user.id` field in awareness (collab/index.ts ·
 * onlineParticipantIds), so the number matches only if the name and color
 * arrived. A silent connection gives zero here with five hundred sockets open.
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
  say(dim(`    (gave up waiting: ${label})`))
  return false
}

/* ---------------------------------------------------------------- typing storm */

interface Armed {
  typists: Student[]
  observer: Student
  hops: number[]
  pending: Map<string, Array<{ seq: number; at: number }>>
}

/**
 * The storm is prepared BEFORE the measurement starts: k typists create a cell
 * each, and the observer (the one who does not type) hangs observers on them.
 * Doing this inside the window would put the burst from creating cells into
 * the idle frames.
 */
async function armStorm(): Promise<Armed | null> {
  const live = students.filter((s) => s.collab?.readyState === WS.OPEN && s.synced)
  if (live.length < 2) return null
  const typists = live.slice(0, Math.min(TYPISTS, live.length - 1))
  const observer = live[live.length - 1]

  for (const t of typists) {
    const { cell, id } = newCell(`# ${t.name}\n`)
    t.doc.transact(() => cellsOf(t.doc).push([cell]))
    // .get() works only on an integrated cell: the text is taken after push.
    t.cell = { id, text: cell.get('source') as Y.Text }
  }
  const arrived = await until(
    'the observer received the cells of the typists',
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
      // The marks of one cell arrive in order: the first in the queue is the oldest.
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
 * The storm: every typist writes `#seq#` into their own cell m times a second,
 * and an observer on a neighbouring socket waits for exactly that mark. Both
 * ends are in one process, so there is one clock and nothing to subtract.
 *
 * The tail (the last marks still on the way) is deliberately left outside:
 * while it runs, nobody types, and including it in the window would smear the
 * frames, the bytes and the typing pace over seconds in which nothing
 * happened.
 */
async function runStorm(armed: Armed, seconds: number): Promise<Storm> {
  const { typists, pending } = armed
  let seq = 0
  const perSecond = typists.length * KEYS
  /*
   * One timer for everyone, round robin. A real audience types unevenly, not
   * in a volley every two hundred milliseconds; and the harness has no use for
   * five hundred timers.
   */
  const batch = Math.max(1, Math.ceil(perSecond / 200))
  const every = (1000 * batch) / perSecond
  let cursor = 0
  const typing = setInterval(() => {
    for (let i = 0; i < batch; i++) {
      const t = typists[cursor++ % typists.length]
      const mark = ++seq
      // Into the queue BEFORE the insert: otherwise delivery could overtake its own start.
      pending.get(t.cell!.id)!.push({ seq: mark, at: performance.now() })
      t.doc.transact(() => t.cell!.text.insert(t.cell!.text.length, `#${mark}#`))
    }
  }, every)

  const at = performance.now()
  await sleep(seconds * 1000)
  clearInterval(typing)
  return { typists: typists.length, keysSent: seq, seconds: (performance.now() - at) / 1000 }
}

/* ------------------------------------------------------------- file tree */

interface Tree {
  made: number
  refused: number
  seconds: number
}

/**
 * What the teacher's console heard in reply.
 *
 * There is ONE listener for all the sections, attached at sign-in. Attaching
 * one in every section would stack handlers on one socket: the third section
 * would count every frame three times, and `ws` would complain about a leak at
 * the eleventh. Refusals accumulate as a number, and frame types as a set: by
 * it the sections learn that the server accepted the lecture or built the
 * stack, without parsing the whole stream.
 */
let teacherRefusals = 0
const teacherHeard = new Set<string>()

/**
 * The teacher's sign-in: an ordinary `/join`, but with the staff cookie and
 * with the role on the wire.
 *
 * Only the host can create files, open the council and run a lecture
 * (control.ts), while the harness's students join by the link. Why this tab is
 * not in `students` is explained at the `teacher` declaration itself.
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
  // With the cookie: the role on the wire is asked of it, not of the token (see `connect`).
  connect(host, SID, staffCookie)
  host.control?.on('message', (data: RawData) => {
    try {
      const msg = JSON.parse(String(data)) as { t?: string }
      if (typeof msg.t !== 'string') return
      teacherHeard.add(msg.t)
      if (msg.t === 'error' || msg.t === 'refused') teacherRefusals++
    } catch {
      /* the console sends only JSON; anything else is none of our business here */
    }
  })
  const ready = await until(
    'the teacher console opened',
    // And the notebook: the council section creates a cell in the document,
    // and before step2 there is nowhere to send it: the server has not seen
    // such a document yet.
    () => host.control?.readyState === WS.OPEN && host.synced,
    15_000,
  )
  return ready ? host : null
}

/** One sign-in for all the optional sections: a second would take the console from the first. */
async function theTeacher(): Promise<Student | null> {
  teacher ??= await joinTeacher()
  return teacher
}

/** What the console said during the work: so many refusals. */
const refusalsSince = (was: number) => teacherRefusals - was

/**
 * The teacher creates files, and the room gets the whole tree for each one.
 *
 * What is measured is not the creation time (it is on disk and waits for
 * nobody) but the cost of the broadcast: bytes and frames in the window are
 * counted over the students, who are doing nothing at that time. The list
 * grows during the section on purpose: that shows the broadcast getting more
 * expensive along with the folder.
 */
async function runTree(host: Student, seconds: number): Promise<Tree> {
  let made = 0
  const was = teacherRefusals
  const every = 1000 / Math.max(TREE_PER_SEC, 0.001)
  const at = performance.now()
  const making = setInterval(() => {
    // A flat folder on purpose: the room's tree is broadcast whole, and the
    // cost grows with the number of entries, not with the depth.
    host.control?.send(JSON.stringify({ t: 'tree:new', path: `load-tree/f${++made}.txt` }))
  }, every)
  await sleep(seconds * 1000)
  clearInterval(making)
  // The folder is cleaned up right away: the seminar is deleted in finally,
  // but the section may be run several times in one run.
  host.control?.send(JSON.stringify({ t: 'tree:remove', path: 'load-tree' }))
  return { made, refused: refusalsSince(was), seconds: (performance.now() - at) / 1000 }
}

/* ---------------------------------------------------------------- council */

interface Council {
  writers: number
  drafts: number
  submits: number
  seconds: number
  /** The incoming traffic of ONE console: the stack goes to it, not to the room. */
  hostFrames: number
  hostBytes: number
  refused: number
}

/**
 * The teacher creates a cell and opens the council in it.
 *
 * The order matters and is checked by waiting, not by a pause: the cell
 * travels with the document (CRDT), the lock over the control wire, and a
 * snapshot into a cell the server has not seen yet would come back with the
 * refusal "the cell is closed": the harness would measure refusals instead of
 * the stack.
 */
async function openCouncilCell(host: Student, writers: Student[]): Promise<string | null> {
  const { cell, id } = newCell('# решение\n')
  host.doc.transact(() => cellsOf(host.doc).push([cell]))
  const arrived = await until(
    'the council cell reached the writers',
    () => writers.every((s) => Boolean(findCell(s.doc, id))),
    30_000,
  )
  if (!arrived) return null
  host.control?.send(JSON.stringify({ t: 'cell:lock', cellId: id, state: 'council' }))
  // The server writes the lock into the cell itself (`open: 'council'`), and
  // that is what has to be awaited: the console sends no confirmation, and
  // without the lock there is no right to one's own sheet.
  const open = await until(
    'the council lock opened for the writers',
    () => writers.every((s) => findCell(s.doc, id)?.get('open') === 'council'),
    15_000,
  )
  return open ? id : null
}

/** An attempt of roughly the size people write in class: the snapshot travels WHOLE. */
function attemptText(s: Student, round: number): string {
  const body =
    `import numpy as np\n\n# ${s.name}\ndef solve(df):\n` +
    '    x = df["value"].to_numpy()\n    x = x[x > 0]\n'.repeat(4) +
    `    return x.mean()  # правка ${round}\n`
  return body.length > MAX_ATTEMPT_CHARS ? body.slice(0, MAX_ATTEMPT_CHARS) : body
}

/**
 * N students write into their own sheet, one console collects the stack.
 *
 * A snapshot goes out on a pause in typing (~1 s in a real tab), and its cost
 * is not in the room but at the teacher's: `council:mine` to the author and
 * the stack to the host. The room stays silent meanwhile: the submitted
 * counter goes to everyone only when it CHANGED, and that is exactly why the
 * section ends with everyone submitting at once, that very minute when the
 * teacher says "hand it in" and the counter moves N times in a row.
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
  // One timer round robin, as in the storm: the harness has no use for five
  // hundred timers, and a real audience does not type in a volley every two
  // seconds.
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
 * "Hand it in", and the class submits all at once.
 *
 * A separate measurement, not the tail of the snapshots: a submission moves
 * the counter, and the counter goes to the WHOLE room, that is, it is the only
 * council frame all five hundred pay for. Stretched over a couple of seconds:
 * that is how long the press takes for a class that has just been told.
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
      // The index is checked BEFORE the counter: otherwise the last tick, when
      // there is nobody left to submit, would still add itself, and the section
      // would print one press more than it made.
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
  // The tail: the counters and the stack go out debounced (BOARD_EVERY_MS),
  // and a window closed at the last press would not see what the room pays for.
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

/* ------------------------------------------------------------------- lecture */

interface Lecture {
  ink: number
  laser: number
  strokes: number
  seconds: number
  refused: number
}

/**
 * A lecture for N viewers: the pen and the pointer from one console.
 *
 * The document is created as an empty file with a .pdf extension and opened
 * by nobody: nobody draws the page here, and for a lecture the server needs
 * the file, not its content (control.ts · lecture:start looks only at `kindOf`
 * and `statPath`). What is measured is the cost of a FRAME: `ink` goes to the
 * room on every frame, `laser` is merged by the server per tick, and the
 * difference between "sent" and "received" is the answer.
 */
async function runLecture(host: Student, seconds: number): Promise<Lecture | null> {
  const was = teacherRefusals
  const file = 'load-lecture.pdf'
  teacherHeard.delete('lecture')
  host.control?.send(JSON.stringify({ t: 'tree:new', path: file }))
  host.control?.send(JSON.stringify({ t: 'lecture:start', file }))
  const started = await until('the lecture started', () => teacherHeard.has('lecture'), 15_000)
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
     * One stroke is drawn point by point, not sent whole: that is how the
     * console writes (InkLayer · SEND_EVERY_MS) and how the room sees it, as a
     * line while it is being drawn. The stroke changes before reaching the
     * point ceiling (shared/lecture.ts), so that the section measures the
     * broadcast, not the "stroke is full" refusal.
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
    // The pointer follows the same hand movement, at the same tick from the
    // console; the server merges it, and the difference shows in "received by
    // the room".
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

/** How many marks did not arrive: after a pause, otherwise the last ones would count as losses. */
async function drain(armed: Armed): Promise<number> {
  await sleep(2_000)
  let lost = 0
  for (const queue of armed.pending.values()) lost += queue.length
  return lost
}

/* ------------------------------------------------------------------- table */

say()
say(bold('  colloq load') + dim(`  ${new Date().toISOString()}  ·  ${BASE}  ·  own seminar ${SID}`))
say(
  dim(
    `  ${STUDENTS} students over ${RAMP_SEC}s · idle ${IDLE_SEC}s · storm ${STORM_SEC}s (${TYPISTS}×${KEYS}/s)` +
      (TREE_PER_SEC > 0 ? ` · tree ${TREE_PER_SEC}/s` : '') +
      (COUNCIL > 0 ? ` · council ${COUNCIL} writers every ${COUNCIL_EVERY}s` : '') +
      (INK_PER_SEC > 0 ? ` · lecture ${INK_PER_SEC} frames/s` : '') +
      (STAFF_JOIN ? ' · join with the staff cookie' : '') +
      (ECHO ? '' : ' · no presence echo'),
  ),
)
say()

let idleWin: Window | null = null
let stormWin: Window | null = null
let stormOut: Storm | null = null
let treeWin: Window | null = null
let treeOut: Tree | null = null
/*
 * The cost of one file is what the tree window received ABOVE idle, divided by
 * the number of files. Without subtracting idle the harness charged the tree
 * with all of the room's presence: with 500 tabs that is 2.2 MB/s regardless
 * of files, and "bottleneck: tree" was printed even when the deltas cost the
 * room 100 KB per file.
 */
function treeCost(win: Window, out: Tree): number {
  const idleRate = idleWin && idleWin.seconds > 0 ? idleWin.bytesIn / idleWin.seconds : 0
  return Math.max(0, win.bytesIn - idleRate * win.seconds) / Math.max(out.made, 1)
}
let councilWin: Window | null = null
let councilOut: Council | null = null
let lectureWin: Window | null = null
let lectureOut: Lecture | null = null
let hopSamples: number[] = []
let synced = 0
let exitCode = 0

try {
  /* 1. JOIN */
  const pace = STUDENTS > 1 ? (RAMP_SEC * 1000) / STUDENTS : 0
  const inFlight: Array<Promise<void>> = []
  const rampAt = performance.now()
  for (let n = 1; n <= STUDENTS; n++) {
    inFlight.push(joinAndConnect(n))
    if (pace > 0 && n < STUDENTS) await sleep(pace)
  }
  await Promise.all(inFlight)
  const rampSec = (performance.now() - rampAt) / 1000
  await until('everyone who joined has synced', () => students.every((s) => s.synced), 60_000)
  synced = students.filter((s) => s.synced).length

  say(bold('  1. JOIN') + dim('  — POST /api/sessions/:id/join, at the ramp pace'))
  row('joined', `${students.length} of ${STUDENTS}`, `${synced} passed the initial Yjs sync`)
  const seen = await onlineNow()
  row(
    'the room sees',
    seen === null ? dim('—') : seen >= synced ? green(`${seen}`) : red(`${seen} of ${synced}`),
    'by presence: the name and color reached the roster',
  )
  const refusals = [...refused.entries()].sort((a, b) => b[1] - a[1])
  row(
    'refused',
    refusals.length === 0 ? green('0') : red(refusals.map(([code, n]) => `${n}×${code}`).join(' · ')),
    refused.has(429) ? 'the limit of new participants per room per minute' : '',
  )
  if (joinErrors > 0) row('request did not arrive', red(String(joinErrors)), 'the network or the socket queue of this machine')
  row('response time', `p50 ${ms(pct(okJoinMs, 50))} · worst ${ms(worst(okJoinMs))}`,
    `n=${okJoinMs.length}, accepted only`)
  row('pace', `${((students.length / Math.max(rampSec, 0.001)) * 60).toFixed(0)} joins per minute`,
    `the ramp took ${rampSec.toFixed(1)}s`)
  if (socketErrors > 0 || closedWith.size > 0) {
    row('sockets', red(`${socketErrors} errors · closed ${[...closedWith].map(([c, n]) => `${n}×${c}`).join(' ') || '—'}`), '')
  }
  say()

  if (students.length === 0) {
    say(red('  nobody joined — nothing to measure'))
    exitCode = 1
  } else {
    /* 2. IDLE */
    say(bold('  2. IDLE') + dim(`  — ${IDLE_SEC}s, nobody types, ${students.length} tabs hold sockets`))
    const idle = beginWindow()
    await sleep(IDLE_SEC * 1000)
    idleWin = endWindow(idle)
    printWindow(idleWin)
    say()

    /* 3. STORM */
    const armed = await armStorm()
    say(bold('  3. STORM') + dim(`  — ${armed?.typists.length ?? 0} type ${KEYS}/s into their own cell, ${STORM_SEC}s`))
    if (!armed) {
      say(red('    did not happen: at least two synced clients are needed'))
    } else {
      const win = beginWindow()
      stormOut = await runStorm(armed, STORM_SEC)
      stormWin = endWindow(win)
      const lost = await drain(armed)
      hopSamples = armed.hops
      row('keystrokes', `${stormOut.keysSent}`,
        `${(stormOut.keysSent / stormOut.seconds).toFixed(0)}/s into the room of ${armed.typists.length * KEYS} requested`)
      row(
        'edit delivery',
        `p50 ${ms(pct(hopSamples, 50))} · p95 ${ms(pct(hopSamples, 95))} · worst ${ms(worst(hopSamples))}`,
        `n=${hopSamples.length}` + (lost > 0 ? ` · ${lost} marks did not arrive` : ''),
      )
      printWindow(stormWin)
    }
    say()

    /* 4. FILE TREE */
    if (TREE_PER_SEC > 0) {
      say(
        bold('  4. TREE') +
          dim(`  — the teacher creates ${TREE_PER_SEC} files per second, ${TREE_SEC}s`),
      )
      const host = await theTeacher()
      if (!host) {
        say(red('    did not happen: could not join the room as the host (a staff cookie is needed)'))
      } else {
        const win = beginWindow()
        const tree = await runTree(host, TREE_SEC)
        treeWin = endWindow(win)
        treeOut = tree
        row(
          'files created',
          `${tree.made}`,
          `${(tree.made / tree.seconds).toFixed(1)}/s · as many tree broadcasts to the whole room` +
            (tree.refused > 0 ? red(` · ${tree.refused} refusals from the console`) : ''),
        )
        printWindow(treeWin)
        say(
          dim(
            '    compare "incoming" with idle: that is the cost of one file, multiplied by the room',
          ),
        )
      }
      say()
    }

    /* 5. COUNCIL */
    if (COUNCIL > 0) {
      say(
        bold('  5. COUNCIL') +
          dim(
            `  — ${COUNCIL} write into their own sheet every ${COUNCIL_EVERY}s, ${COUNCIL_SEC}s, ` +
              'then submit all at once',
          ),
      )
      const host = await theTeacher()
      const writers = students
        .filter((s) => s.control?.readyState === WS.OPEN && s.synced)
        .slice(0, COUNCIL)
      if (!host) {
        say(red('    did not happen: could not join the room as the host (a staff cookie is needed)'))
      } else if (writers.length === 0) {
        say(red('    did not happen: nobody to write — not a single synced student'))
      } else {
        const cellId = await openCouncilCell(host, writers)
        if (!cellId) {
          say(red('    did not happen: the council did not open in the cell'))
        } else {
          const win = beginWindow()
          const council = await runCouncil(host, writers, cellId, COUNCIL_SEC)
          councilWin = endWindow(win)
          councilOut = council
          row(
            'snapshots',
            `${council.drafts}`,
            `${(council.drafts / council.seconds).toFixed(1)}/s from ${council.writers} ` +
              `${plural(council.writers, 'writer', 'writers')}` +
              (council.refused > 0 ? red(` · ${council.refused} refusals to the console`) : ''),
          )
          row(
            'to the host console',
            `${size(council.hostBytes / council.seconds)}/s · ` +
              `${(council.hostFrames / council.seconds).toFixed(1)} frames/s`,
            `${size(council.hostBytes / Math.max(council.drafts, 1))} per snapshot: the stack goes to it alone`,
          )
          printWindow(councilWin)
          say(dim('    the room is silent meanwhile: the counter goes to everyone only when it changed'))

          const rushWin = beginWindow()
          const rush = await runCouncilRush(host, writers, cellId)
          const closed = endWindow(rushWin)
          say()
          say(
            bold('     submitting at once') +
              dim(
                `  — ${rush.submits} ${plural(rush.submits, 'press', 'presses')} ` +
                  'of "Submit" in a row',
              ),
          )
          row(
            'to the host console',
            `${size(rush.hostBytes)} in ${rush.seconds.toFixed(1)}s`,
            `${rush.hostFrames} ${plural(rush.hostFrames, 'frame', 'frames')}` +
              (rush.refused > 0 ? red(` · ${rush.refused} refusals`) : ''),
          )
          row(
            'to the room',
            `${size(closed.bytesIn / Math.max(closed.clients, 1))} per client`,
            'the submitted counter moves on every press — and goes to everyone',
          )
        }
      }
      say()
    }

    /* 6. LECTURE */
    if (INK_PER_SEC > 0) {
      say(
        bold('  6. LECTURE') +
          dim(`  — the host draws with the pen at ${INK_PER_SEC} frames/s and with the pointer, ${INK_SEC}s`),
      )
      const host = await theTeacher()
      if (!host) {
        say(red('    did not happen: could not join the room as the host (a staff cookie is needed)'))
      } else {
        const win = beginWindow()
        const lecture = await runLecture(host, INK_SEC)
        const closed = endWindow(win)
        if (!lecture) {
          say(red('    did not happen: the lecture did not start (the document or the `board` right)'))
        } else {
          lectureWin = closed
          lectureOut = lecture
          row(
            'frames from the console',
            `${lecture.ink} pen · ${lecture.laser} pointer`,
            `${lecture.strokes} ${plural(lecture.strokes, 'stroke', 'strokes')}` +
              (lecture.refused > 0 ? red(` · ${lecture.refused} refusals to the console`) : ''),
          )
          row(
            'frame cost to the room',
            `${size(closed.bytesIn / Math.max(lecture.ink + lecture.laser, 1))} per frame`,
            `${closed.clients} ${plural(closed.clients, 'viewer', 'viewers')} · ` +
              'the pen goes to everyone, the pointer is merged by the server tick',
          )
          printWindow(closed)
        }
      }
      say()
    }
  }

  /* ------------------------------------------------------- where the bottleneck is */

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
  /** The first one that fired, not a list of suspicions: one line, one conclusion. */
  const walls: Array<[boolean, string]> = [
    [
      (refused.get(429) ?? 0) > 0,
      `the new-participant limit — ${refused.get(429)} of ${STUDENTS} got 429 ` +
        `(MAX_NEW_PARTICIPANTS, server/src/routes/sessions.ts). Stretch the ramp with LOAD_RAMP_SEC ` +
        `or get past the limit with the staff cookie: LOAD_STAFF_JOIN=1.`,
    ],
    [
      selfP95 > 100,
      `the harness itself — it waited for its own loop p95 ${ms(selfP95)}, that is, it measured itself. ` +
        `Run it from another machine or lower LOAD_STUDENTS.`,
    ],
    [
      socketErrors > 0 || closedWith.size > 0,
      `sockets — ${socketErrors} errors, closes ${[...closedWith].map(([c, n]) => `${n}×${c}`).join(' ')}. ` +
        `Check ulimit -n on this machine and the server log.`,
    ],
    [
      Number.isFinite(lagP95) && lagP95 > 100,
      `the server event loop — loopLag p95 ${ms(lagP95)} under the storm: the next keystroke waits just as long.`,
    ],
    [
      cpu !== null && cpu > 85,
      `CPU of the server process — ${(cpu ?? 0).toFixed(0)}% under the storm. There is no cluster, it will not take a second core.`,
    ],
    [
      stormWin !== null && (stormWin.health.failed > 0 || pct(stormWin.health.ms, 95) > 250),
      `room HTTP — /api/health p95 ${ms(stormWin ? pct(stormWin.health.ms, 95) : NaN)}` +
        `${stormWin && stormWin.health.failed > 0 ? ` and ${stormWin.health.failed} probes unanswered` : ''}: ` +
        `a latecomer's join screen waits just as long.`,
    ],
    [
      /*
       * A hundred megabits is the usual uplink of a rented machine, and it can
       * be hit on presence alone: the server broadcasts every update to
       * everyone, and traffic grows as the square of the number of tabs.
       */
      outPerSec > 12 * 1024 * 1024,
      `the server's outgoing channel — ${size(outPerSec)}/s with ${synced} tabs, ` +
        `that is already about a hundred megabits for one broadcast.`,
    ],
    [
      hops.length > 0 && pct(hops, 95) > 250,
      `edit delivery — p95 ${ms(pct(hops, 95))}: typing no longer feels local.`,
    ],
    [
      /*
       * One file means one file list to every console, and that list grows. A
       * megabyte per created file means the room's folder already costs more
       * than all the presence put together.
       */
      treeWin !== null && treeOut !== null && treeOut.made > 0 &&
        treeCost(treeWin, treeOut) > 1024 * 1024,
      `file tree — one created file cost the room ` +
        `${size(treeWin && treeOut ? treeCost(treeWin, treeOut) : 0)} of broadcast above idle: ` +
        `the list goes out whole and to everyone (broadcastFiles, server/src/control.ts).`,
    ],
    [
      /*
       * The stack goes to ONE socket, and what hits the wall there is not the
       * room's channel but the teacher's console: a megabit per snapshot with a
       * hundred writers is already tens of megabits into one wire, and the
       * first to stop turning pages will be the one running the class.
       */
      councilOut !== null && councilOut.drafts > 0 &&
        councilOut.hostBytes / councilOut.seconds > 1.5 * 1024 * 1024,
      `council stack — the host console got ` +
        `${size((councilOut?.hostBytes ?? 0) / Math.max(councilOut?.seconds ?? 1, 0.001))}/s ` +
        `from ${councilOut?.writers ?? 0} writers: it is assembled on every snapshot and goes to it alone ` +
        `(boardOut, server/src/control.ts).`,
    ],
    [
      /*
       * A pen frame is the most frequent frame of a lecture, and it goes to
       * everyone: the pen at twenty-five frames per second with five hundred
       * viewers is twelve and a half thousand sends per second from one loop.
       */
      lectureWin !== null && lectureOut !== null && lectureOut.ink > 0 &&
        lectureWin.bytesIn / lectureWin.seconds > 12 * 1024 * 1024,
      `lecture — ${size((lectureWin?.bytesIn ?? 0) / Math.max(lectureWin?.seconds ?? 1, 0.001))}/s ` +
        `into the room at ${lectureOut?.ink ?? 0} pen frames: ink is broadcast on every frame, ` +
        `without a tick (control.ts · case 'ink').`,
    ],
  ]
  const wall = walls.find(([hit]) => hit)
  say(
    wall
      ? red('  Bottleneck: ') + wall[1]
      : green(
          `  No bottleneck: ${synced} clients held, at idle ${size(idlePerClient)}/s per client, ` +
            `loopLag p95 ${ms(lagP95)}, delivery p95 ${ms(pct(hops, 95))}.`,
        ),
  )
  if (badFrames > 0) say(dim(`  ${badFrames} frames the harness could not parse — its problem, not the server's`))
  say(dim('  The harness measures sockets and the event loop: it does not draw the page or compute cells.'))
  say()
} catch (err) {
  say(red(`  the run stopped: ${err instanceof Error ? err.message : String(err)}`))
  exitCode = 1
} finally {
  await cleanup()
}

// Otherwise live sockets and timers would keep the loop open.
process.exit(exitCode)
