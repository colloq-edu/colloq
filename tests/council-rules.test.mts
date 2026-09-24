/**
 * Council rules: the limit on a single run and the pause between one's own
 * runs.
 *
 * Both controls exist against one and the same trouble, and the trouble is
 * not hypothetical: a room has one kernel, the queue to it is shared, and in a
 * cohort of five hundred people one person's `while True` means "Queued: 37"
 * for everyone else until the end of the class, until the teacher notices and
 * presses "Interrupt". A queue of people pressing "Run" after every edit is
 * the same thing, only without ill intent.
 *
 * What is checked here is exactly what breaks silently:
 *
 *   — the limit signal goes to THE attempt that exceeded it, and the next one
 *     in the queue runs as if nothing had happened. This is the main danger:
 *     `interrupt` goes to Jupyter over HTTP and does not answer instantly,
 *     and meanwhile the queue manages to pick up the next job;
 *   — a stopped attempt is explained in words, not with a `KeyboardInterrupt`
 *     traceback: a student reads that as "the teacher pressed stop" or as
 *     their own mistake;
 *   — the output BEFORE the stop is kept: it usually shows the piece that
 *     looped;
 *   — a limit changed in the middle of a run applies to that same run;
 *   — the pause is counted from the end of one's OWN run, does not concern
 *     the teacher, and reaches the student as a number
 *     (`CouncilMine.nextRunAt`), not as a lone refusal.
 *
 * A fake Jupyter instead of a real kernel: we need a run that does not end
 * until it is interrupted — a live kernel does not do that on demand. The
 * limit's scale is shifted by a test seam (`setCouncilLimitTick`), otherwise
 * every check would cost five seconds of waiting.
 */
import './_env.mts'
import { guardAnswer } from './_guard.mts'
import { createServer, type Server } from 'node:http'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { ControlClientMessage, ControlServerMessage, CouncilMine } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
// Not a single static import of server modules: config reads JUPYTER_URL at
// import time, and the fake is brought up in before(). kernel.test and
// control-interrupt.test are built the same way.

/* -------------------------------------------------------------- fake Jupyter */

const kernels = new Map<string, { alive: boolean }>()
const byPath = new Map<string, string>()
let minted = 0
let http: Server
let wss: WebSocketServer
let sockets: WebSocket[] = []
/** Requests the fake sits on: "running until interrupted". */
let held: Array<{ socket: WebSocket; parent: unknown }> = []
/** How many times the room was asked to interrupt — it shows that the signal does not storm. */
let interrupts = 0
/** The kernel does not answer an interrupt: the signal arrives, the job keeps running. */
let deaf = false
/**
 * What the fake answers to the isolation entry (kernel/council-isolation.ts).
 *
 * `null` means "the kernel said nothing": `user_expressions` is empty, and
 * the server must NOT run the attempt. By default it is an ordinary
 * confirmation with nothing skipped, otherwise not a single rules check would
 * get as far as a run.
 */
let councilReport: Record<string, unknown> | null = {
  ok: true, copied: 2, skipped: [], failed: [], bytes: 0, memory: null, ms: 1,
}
/** How many times the fake was asked to leave isolation — the exit must always happen. */
let isolationExits = 0
/**
 * The EXIT report: what there was no way to restore after the attempt.
 *
 * `null` is the usual case, nothing left behind. It differs from the entry
 * report in that its absence decides nothing: the attempt has already run,
 * it is only about a note.
 */
let councilLeftovers: Record<string, unknown> | null = null
/** Everything that reached the kernel: it shows whether the attempt was run or not. */
let seen: string[] = []

function reply(socket: WebSocket, parent: unknown, msgType: string, content: unknown): void {
  socket.send(
    JSON.stringify({
      header: { msg_id: `m_${Math.random().toString(36).slice(2)}`, msg_type: msgType },
      parent_header: parent,
      metadata: {},
      content,
      channel: msgType.endsWith('_reply') ? 'shell' : 'iopub',
    }),
  )
}

before(async () => {
  http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const kernelMatch = /^\/api\/kernels\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const path = (JSON.parse(body || '{}') as { path?: string }).path ?? ''
        let id = byPath.get(path)
        if (!id || !kernels.get(id)?.alive) {
          id = `k_${++minted}`
          byPath.set(path, id)
          kernels.set(id, { alive: true })
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `s_${id}`, kernel: { id } }))
      })
      return
    }
    if (req.method === 'GET' && kernelMatch) {
      if (!kernels.get(kernelMatch[1])?.alive) return void res.writeHead(404).end('{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: kernelMatch[1], execution_state: 'idle' }))
      return
    }
    if (req.method === 'POST' && /\/interrupt$/.test(url.pathname)) {
      interrupts += 1
      /*
       * A kernel deaf to the signal is not the fake's invention.
       *
       * Python gone into C (`np.linalg.inv` on a matrix of the wrong size)
       * does not see SIGINT until it returns to the interpreter. The server
       * sends two signals and falls silent; until now silence set in right
       * there — the attempt "runs" forever, the pump stands, the queue
       * freezes, and nobody found out. Here the fake simply does not release
       * the waiting request, and answers the POST itself as usual: exactly
       * what the server sees.
       */
      if (deaf) {
        setTimeout(() => res.writeHead(204).end(), 120)
        return
      }
      /*
       * Exactly what a real kernel does: the waiting request fails with a
       * `KeyboardInterrupt` and a traceback. It is exactly this traceback that
       * must not reach the student's card.
       */
      for (const { socket, parent } of held.splice(0)) {
        reply(socket, parent, 'error', {
          ename: 'KeyboardInterrupt',
          evalue: '',
          traceback: [
            'Traceback (most recent call last)',
            'Cell In[1], line 2',
            'KeyboardInterrupt: ',
          ],
        })
        reply(socket, parent, 'execute_reply', { status: 'error', execution_count: 1 })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
      /*
       * The answer to the POST itself comes with a delay, and that is not a
       * decoration of the fake.
       *
       * The queue boundary rests exactly on it: the server puts this promise
       * into `beforeNext`, and the next job does not start until the
       * interrupt has settled (kernel/index.ts · stopRunningJob). Answering
       * instantly would mean testing code from which the boundary could be
       * removed without anyone noticing.
       */
      setTimeout(() => res.writeHead(204).end(), 120)
      return
    }
    res.writeHead(404).end('{}')
  })

  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const id = /^\/api\/kernels\/([^/]+)\/channels/.exec(req.url ?? '')?.[1]
    if (!id || !kernels.has(id)) return void socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws)
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(String(raw)) as {
          header: { msg_type: string }
          content: { code: string }
        }
        if (msg.header.msg_type !== 'execute_request') return
        const code = msg.content.code
        seen.push(code)
        /*
         * Markers are looked for only in cell code: a service request
         * (`silent`) is the isolation source, and any words occur in its
         * comments. A neighbouring suite has already been caught by this:
         * the fake read "OOM-killer" in a comment as "the cell killed the
         * kernel".
         */
        const service = (msg.content as { silent?: boolean }).silent === true
        reply(ws, msg.header, 'status', { execution_state: 'busy' })
        reply(ws, msg.header, 'execute_input', { code, execution_count: 1 })
        /*
         * HANG is an attempt that does not end by itself. It prints a line and
         * sits waiting: without that line there would be nothing to check
         * "the output before the stop is kept" with. Everything else,
         * including the isolation entry and exit around the attempt
         * (council-isolation.ts), answers at once — otherwise the queue would
         * stall before the run.
         */
        if (!service && code.includes('HANG')) {
          reply(ws, msg.header, 'stream', { name: 'stdout', text: 'считаю…\n' })
          held.push({ socket: ws, parent: msg.header })
          return
        }
        if (!service && code.includes('PRINT')) {
          reply(ws, msg.header, 'stream', { name: 'stdout', text: 'готово\n' })
        }
        /*
         * REFUSE and STARVE are two outcomes that a real kernel produces from
         * the isolation itself: a refusal on `exit()` (it would shut down the
         * kernel for the whole room) and a `MemoryError` from under the memory
         * ceiling set by the entry.
         */
        if (!service && code.includes('REFUSE')) {
          reply(ws, msg.header, 'error', {
            ename: 'ColloqRefused',
            evalue: 'В попытке нельзя завершать ядро: оно общее для всей комнаты.',
            traceback: ['Traceback (most recent call last)', 'File "<colloq-council>", line 1'],
          })
        }
        if (!service && code.includes('STARVE')) {
          reply(ws, msg.header, 'error', {
            ename: 'MemoryError',
            evalue: 'Unable to allocate 11.9 GiB',
            traceback: ['Traceback (most recent call last)', 'MemoryError'],
          })
        }
        /*
         * The isolation entry and exit report through `user_expressions` — a
         * real kernel answers with them even to a silent request, and without
         * this branch the server would rightly refuse to run a single
         * attempt.
         */
        const expressions = (msg.content as { user_expressions?: Record<string, string> })
          .user_expressions
        const wantsReport = expressions !== undefined && Object.keys(expressions).length > 0
        const leaving = code.includes('.leave(globals())')
        if (leaving) isolationExits += 1
        /*
         * Installing the guard against dangerous commands comes the same way
         * and with the same key, and without a confirmation the server runs
         * no cell at all (kernel/index.ts · ensureGuard). The answer is shared
         * by all kernel fakes — tests/_guard.mts.
         */
        const guard = guardAnswer(code)
        const answer = guard ?? (leaving ? councilLeftovers : councilReport)
        reply(ws, msg.header, 'execute_reply', {
          status: !service && (code.includes('REFUSE') || code.includes('STARVE')) ? 'error' : 'ok',
          execution_count: 1,
          ...(wantsReport
            ? {
                user_expressions: answer
                  ? {
                      colloq: {
                        status: 'ok',
                        data: { 'text/plain': JSON.stringify(answer) },
                        metadata: {},
                      },
                    }
                  : {},
              }
            : {}),
        })
        reply(ws, msg.header, 'status', { execution_state: 'idle' })
      })
    })
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  process.env.JUPYTER_URL = `http://127.0.0.1:${port}`
  process.env.JUPYTER_TOKEN = 'fake'
  const { setCouncilLimitTick } = await import('../server/src/kernel/index.js')
  // A second of limit is fifty milliseconds: the suite tests behaviour, not
  // patience. The signal retry speeds up too, see LIMIT_RETRY_TICKS.
  setCouncilLimitTick(50)
})

afterEach(() => {
  // A hung request does not outlive its test: each test has its own room,
  // and there is nobody to sit it out — a failed assertion would otherwise
  // bring down the whole tail.
  for (const { socket, parent } of held.splice(0)) {
    reply(socket, parent, 'execute_reply', { status: 'ok', execution_count: 1 })
    reply(socket, parent, 'status', { execution_state: 'idle' })
  }
  interrupts = 0
  deaf = false
  isolationExits = 0
  seen = []
  councilLeftovers = null
  councilReport = { ok: true, copied: 2, skipped: [], failed: [], bytes: 0, memory: null, ms: 1 }
})

after(async () => {
  held = []
  const { setCouncilLimitTick, shutdownKernels } = await import('../server/src/kernel/index.js')
  const { shutdownCollab } = await import('../server/src/collab/index.js')
  setCouncilLimitTick(1000)
  await shutdownKernels()
  shutdownCollab()
  for (const socket of sockets) socket.terminate()
  wss?.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

/* --------------------------------------------------------------------- room */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await what()) return true
    await wait(10)
  }
  return await what()
}

interface Person {
  payload: TokenPayload
  heard: ControlServerMessage[]
  ws: WebSocket
}

interface Room {
  id: string
  cell: string
  teacher: Person
  petya: Person
  masha: Person
}

let seq = 0

/** Exactly what `send` and `handleControlSocket` read: the state, receiving, subscriptions. */
async function join(
  sessionId: string,
  participantId: string,
  name: string,
  role: 'host' | 'participant',
): Promise<Person> {
  const { upsertParticipant } = await import('../server/src/db.js')
  const { handleControlSocket } = await import('../server/src/control.js')
  upsertParticipant({ id: participantId, sessionId, name, avatar: null, role })
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
    },
  }
  const ws = fake as unknown as WebSocket
  const payload: TokenPayload = { sessionId, participantId, role }
  handleControlSocket(ws, sessionId, payload)
  return { payload, heard, ws }
}

async function room(): Promise<Room> {
  const { createSession, setRules } = await import('../server/src/db.js')
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { cellId, createCell, getCells } = await import('../shared/notebook.js')
  const { LECTURE_ROOM } = await import('../shared/rules.js')
  const id = `council-rules-${++seq}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const task = createCell('code', '# задание')
  doc.transact(() => getCells(doc).push([task]))
  return {
    id,
    cell: cellId(task),
    teacher: await join(id, `${id}_t`, 'Ада', 'host'),
    petya: await join(id, `${id}_p`, 'Петя', 'participant'),
    masha: await join(id, `${id}_m`, 'Маша', 'participant'),
  }
}

/** Say something into the wire and return the refusal text, if there was one. */
async function say(at: Room, who: Person, message: ControlClientMessage): Promise<string | null> {
  const { dispatch } = await import('../server/src/control.js')
  const before = who.heard.length
  dispatch(who.ws, at.id, who.payload, message)
  const error = who.heard.slice(before).find((m) => m.t === 'error')
  return error && error.t === 'error' ? error.message : null
}

function lastMine(who: Person, cellId: string): CouncilMine | null {
  for (let i = who.heard.length - 1; i >= 0; i--) {
    const m = who.heard[i]
    if (m.t === 'council:mine' && m.cellId === cellId) return m.state
  }
  return null
}

async function council(
  at: Room,
  settings: Record<string, unknown> = {},
): Promise<string | null> {
  return say(at, at.teacher, {
    t: 'cell:lock',
    cellId: at.cell,
    state: 'council',
    settings: settings as never,
  })
}

async function knobs(at: Room) {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { councilSettingsOf, findCell } = await import('../shared/notebook.js')
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  return councilSettingsOf(found!.cell)
}

async function runOf(at: Room, who: Person) {
  const { attemptOf } = await import('../server/src/council.js')
  return attemptOf(at.id, at.cell, who.payload.participantId)?.run ?? null
}

/* ---------------------------------------------------------------- sanitizer */

test('garbage in the rules controls does not reach the document', async () => {
  const { DEFAULT_COUNCIL, readCouncilSettings } = await import('../shared/notebook.js')

  // The pure half: reading a cell that already holds anything at all.
  assert.deepEqual(readCouncilSettings({ runLimitSec: 'долго', rerunPauseSec: [] }), DEFAULT_COUNCIL)
  assert.equal(readCouncilSettings({ runLimitSec: 1.5 }).runLimitSec, DEFAULT_COUNCIL.runLimitSec)
  assert.equal(readCouncilSettings({ runLimitSec: 0 }).runLimitSec, DEFAULT_COUNCIL.runLimitSec)
  assert.equal(readCouncilSettings({ runLimitSec: 99999 }).runLimitSec, DEFAULT_COUNCIL.runLimitSec)
  // `null` is not "no field" but a deliberate choice of the teacher.
  assert.equal(readCouncilSettings({ runLimitSec: null }).runLimitSec, null)
  assert.equal(readCouncilSettings({ rerunPauseSec: 0 }).rerunPauseSec, 0)
  assert.equal(readCouncilSettings({ rerunPauseSec: -5 }).rerunPauseSec, 0)

  // And the second half: the same over the wire. An invalid value is dropped
  // — the previous control stays, instead of being replaced by the default.
  const at = await room()
  assert.equal(await council(at, { runLimitSec: 5, rerunPauseSec: 15 }), null)
  assert.deepEqual(await knobs(at), {
    studentRun: false,
    namesOnProjector: true,
    runLimitSec: 5,
    rerunPauseSec: 15,
  })
  assert.equal(await council(at, { runLimitSec: 99999, rerunPauseSec: 'чуть-чуть' }), null)
  assert.equal((await knobs(at))!.runLimitSec, 5, 'a limit out of bounds reset the control')
  assert.equal((await knobs(at))!.rerunPauseSec, 15, 'garbage reset the pause')
  assert.equal(await council(at, { runLimitSec: null }), null)
  assert.equal((await knobs(at))!.runLimitSec, null, '"uncapped" did not arrive')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/* ----------------------------------------------------------------- run limit */

test('a run over the limit is stopped by the server — and the next one in the queue does not notice', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: 1 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(
    await say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  // The second attempt queues up BEHIND the first — exactly the arrangement
  // in which a late SIGINT used to hit someone else's job.
  assert.equal(await say(at, at.masha, { t: 'council:run', cellId: at.cell }), null)

  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'the limit did not fire',
  )

  const stopped = await runOf(at, at.petya)
  assert.equal(stopped?.timedOut, 1, 'the attempt does not record that the limit fired')
  assert.equal(stopped?.state, 'error')
  const outputs = stopped?.outputs ?? []
  assert.equal(outputs[0]?.kind, 'stream', 'the output before the stop is lost')
  assert.match(String((outputs[0] as { text: string }).text), /считаю/)
  const failure = outputs.find((o) => o.kind === 'error') as
    | { ename: string; evalue: string; traceback: string[] }
    | undefined
  assert.equal(failure?.ename, '', 'the English exception name is back in front of the Russian phrase')
  assert.match(failure!.evalue, /Остановлено/)
  assert.deepEqual(failure!.traceback, [], 'the interrupt traceback stayed on the card')
  assert.equal(
    JSON.stringify(outputs).includes('KeyboardInterrupt'),
    false,
    'the student reads about a keyboard nobody pressed',
  )

  /*
   * The mark reaches both people the attempt is visible to, and survives a
   * restart.
   *
   * The author gets it with the sheet (`council:mine`), the console with a
   * stack delta; in the database it lies inside `run_json`, so a frame from
   * the server's previous life cannot lose it. The work list and the console
   * queue read exactly it instead of parsing the output: often there is no
   * output in the stack at all (`outputsOmitted`).
   */
  assert.equal(lastMine(at.petya, at.cell)?.run?.timedOut, 1, 'the author did not learn the reason for the stop')
  assert.ok(
    await until(
      () =>
        at.teacher.heard.some(
          (m) =>
            (m.t === 'council:patch' || m.t === 'council:board') &&
            (m.t === 'council:patch' ? m.attempts : m.board.attempts).some(
              (a) => a.run?.timedOut === 1,
            ),
        ),
      2000,
    ),
    'the reason for the stop did not reach the teacher\'s stack',
  )
  const { resetCouncilCache } = await import('../server/src/council.js')
  resetCouncilCache(at.id)
  assert.equal((await runOf(at, at.petya))?.timedOut, 1, 'the mark did not survive reading from the database')

  // And the main thing: the neighbouring attempt ran to completion by itself
  // instead of receiving someone else's signal.
  assert.ok(
    await until(async () => ((await runOf(at, at.masha))?.state ?? '') === 'ok', 4000),
    'the next attempt in the queue did not complete',
  )
  const next = await runOf(at, at.masha)
  assert.equal(next?.timedOut, undefined, 'the limit signal went to the next job')
  assert.equal(next?.outputs.some((o) => o.kind === 'error'), false)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('a run within the limit is not touched, and no alarm is left behind it', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: 2 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))
  const done = await runOf(at, at.petya)
  assert.equal(done?.timedOut, undefined)
  /*
   * An alarm that outlived its attempt is a signal into the next job in the
   * queue. It is checked in the only honest way: wait longer than the limit
   * and make sure nobody interrupted the kernel.
   */
  await wait(2 * 50 + 120)
  assert.equal(interrupts, 0, 'the alarm fired after the run had already ended')
  assert.equal((await runOf(at, at.petya))?.state, 'ok')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('"uncapped" never interrupts', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'running', 4000))
  // Longer than the default (30 "seconds" by the sped-up clock): silence here
  // means "there is no limit", not "the limit has not come yet".
  await wait(30 * 50 + 150)
  assert.equal(interrupts, 0, 'the attempt was interrupted where there is no limit')
  assert.equal((await runOf(at, at.petya))?.state, 'running')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('the limit applies to the teacher running someone else\'s attempt too', async () => {
  const at = await room()
  assert.equal(await council(at, { runLimitSec: 1 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  // The students' run control is off: the teacher presses, and this is the
  // very case in which "the limit is not about me" would cost the whole room.
  assert.equal(
    await say(at, at.teacher, {
      t: 'council:run',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }),
    null,
  )
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'the teacher\'s run did not stop at the limit',
  )
  assert.equal((await runOf(at, at.petya))?.timedOut, 1)
  assert.equal((await runOf(at, at.petya))?.by, 'host')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('a limit changed in the middle of a run applies to that same run', async () => {
  const at = await room()
  // Started without a limit: the attempt hangs and would hang until the end
  // of the class.
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'running', 4000))
  await wait(200)
  assert.equal(interrupts, 0)

  /*
   * The teacher sets the limit WHILE LOOKING at the hung loop. It is counted
   * from the start of this attempt, which has been going on longer already —
   * so it fires at once, not a second after the press.
   */
  assert.equal(await council(at, { runLimitSec: 1 }), null)
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'the new limit did not reach the running attempt',
  )
  assert.equal((await runOf(at, at.petya))?.timedOut, 1)
  assert.equal(interrupts, 1, 'the signal went out more than once')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('a new limit also reaches those already standing in the queue', async () => {
  const at = await room()
  /*
   * The limit is written into the job when it is queued: the kernel does not
   * read the document. The teacher removes "uncapped" while looking at the
   * stalled queue — and if only the running attempt got the new number, the
   * one after it hangs with no limit at all, and the queue stands again, now
   * under rules that forbid it.
   */
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  for (const who of [at.petya, at.masha]) {
    assert.equal(await say(at, who, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
    assert.equal(await say(at, who, { t: 'council:run', cellId: at.cell }), null)
  }
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'running', 4000))
  assert.equal((await runOf(at, at.masha))?.state, 'queued')

  assert.equal(await council(at, { runLimitSec: 1 }), null)
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'the new limit did not reach the running attempt',
  )
  assert.ok(
    await until(async () => ((await runOf(at, at.masha))?.state ?? '') === 'error', 4000),
    'the attempt waiting in the queue went without a limit',
  )
  assert.equal((await runOf(at, at.masha))?.timedOut, 1)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/* ----------------------------------------------- pause between one's own runs */

test('the pause does not let a student back into the queue — and does not concern the teacher', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null, rerunPauseSec: 30 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  // The countdown reached the author together with the end of their run: it
  // must stand in the button's place, not a button that answers with a
  // refusal.
  const mine = lastMine(at.petya, at.cell)
  assert.ok(mine, 'the sheet did not reach the author')
  assert.ok(typeof mine!.nextRunAt === 'number', 'the sheet has no countdown to the next run')
  assert.ok(mine!.nextRunAt! > Date.now(), 'the countdown is already in the past')
  assert.ok(mine!.nextRunAt! <= Date.now() + 30_000)

  // Their own press — a refusal in words and with a number.
  const refused = await say(at, at.petya, { t: 'council:run', cellId: at.cell })
  assert.match(refused ?? '', /Следующий запуск/)
  assert.match(refused ?? '', /\d+ с|мин/)

  // While the teacher runs the same attempt right away: the pause is about
  // the author.
  assert.equal(
    await say(at, at.teacher, {
      t: 'council:run',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }),
    null,
    'the author\'s pause stopped the teacher',
  )

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('the pause is checked on the request, not on the approval', async () => {
  const at = await room()
  assert.equal(
    await council(at, { studentRun: 'request', runLimitSec: null, rerunPauseSec: 30 }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run:request', cellId: at.cell }), null)

  const { attemptOf } = await import('../server/src/council.js')
  const request = attemptOf(at.id, at.cell, at.petya.payload.participantId)?.runRequest
  assert.equal(request?.status, 'pending')
  assert.equal(
    await say(at, at.teacher, {
      t: 'council:run:approve',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
      requestId: request!.id,
    }),
    null,
  )
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  /*
   * An approved request is one's own run too: kernel time was spent on this
   * person, and the teacher pressed "approve" only because they were asked
   * to. Without this, the "on request" mode would be the only one with no
   * pause at all.
   */
  const refused = await say(at, at.petya, { t: 'council:run:request', cellId: at.cell })
  assert.match(refused ?? '', /Следующий запуск/)
  const again = attemptOf(at.id, at.cell, at.petya.payload.participantId)?.runRequest
  assert.equal(again ?? null, null, 'the request got into the queue through the pause')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('pause 0 refuses nobody and puts no countdown into the sheet', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))
  assert.equal(lastMine(at.petya, at.cell)?.nextRunAt ?? null, null, 'a countdown where there is no pause')

  // Edit the text — and a new run right away: no worse than the first.
  assert.equal(
    await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT  # ещё' }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  /*
   * And the reverse: the control was turned on after the run had already
   * ended — and it applies to that run too. The deadline is not stored; it is
   * computed from the end of the previous run and the CURRENT pause.
   */
  const { nextRunAtFor } = await import('../server/src/council.js')
  const who = at.petya.payload.participantId
  assert.equal(nextRunAtFor(at.id, at.cell, who, 0), null)
  assert.ok((nextRunAtFor(at.id, at.cell, who, 60) ?? 0) > Date.now())
  // And a control removed by the teacher is outlived by nobody.
  assert.equal(nextRunAtFor(at.id, at.cell, who, 0), null)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/* -------------------------------------------------- personal copies of data */

/**
 * The entry was not confirmed — the attempt does not run at all.
 *
 * This is not caution but the only honest outcome. The entry report
 * (kernel/council-isolation.ts) is the only thing by which the server knows
 * whose data is in the kernel right now; silence means "unknown", and a run
 * on shared objects would cost the class exactly here: the student would get
 * a correct-looking answer while corrupting `data` for the whole group. So
 * instead of a run there is one line without a traceback, and the exit runs
 * anyway: the entry may have managed to swap bindings and fail after that.
 */
test('an entry without confirmation does not let the attempt into the kernel and says so in one line', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  councilReport = null
  const exitsBefore = isolationExits
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'the attempt did not end with a refusal',
  )
  const run = await runOf(at, at.petya)
  const outputs = run?.outputs ?? []
  assert.equal(outputs.length, 1, 'someone else\'s output got attached to the refusal')
  const failure = outputs[0] as { kind: string; ename: string; evalue: string; traceback: string[] }
  assert.equal(failure.kind, 'error')
  assert.match(failure.evalue, /Не удалось подготовить личные копии/)
  // No traceback: `<colloq-council>` frames are not the student's code and
  // will not help them.
  assert.deepEqual(failure.traceback, [])
  assert.doesNotMatch(failure.evalue, /\n/, 'the refusal is no longer a single line')

  // The attempt's text did not reach the kernel — but the exit ran.
  assert.ok(!seen.some((code) => code.includes('PRINT')), 'the attempt was executed after all')
  assert.ok(isolationExits > exitsBefore, 'the exit was not run after a failed entry')

  // And the queue is not broken by this: the next attempt runs when the entry
  // is alive.
  councilReport = { ok: true, copied: 1, skipped: [], failed: [], bytes: 0, ms: 1 }
  assert.equal(
    await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT # снова' }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000),
    'the queue stalled after one entry refusal',
  )

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/**
 * What stayed shared is named at the start of the output — before the first
 * line of the attempt itself.
 *
 * Silent half-isolation is worse than the old hole: a student used to their
 * data being their own would corrupt it for everyone on a big table and never
 * find out. The line comes first because it is read together with the
 * answer, and it says right away what to do.
 */
test('a variable that did not fit the copy budget is named in a line before the attempt\'s output', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  councilReport = {
    ok: true,
    copied: 2,
    bytes: 10,
    ms: 3,
    skipped: [{ name: 'big', bytes: 1288490188 }],
    failed: [{ name: 'conn', error: 'TypeError: cannot pickle' }],
  }
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  const outputs = (await runOf(at, at.petya))?.outputs ?? []
  const first = outputs[0] as { kind: string; name: string; text: string }
  assert.equal(first.kind, 'stream')
  assert.equal(first.name, 'stderr', 'the warning went to stdout, next to the answer')
  assert.match(first.text, /Переменная `big` \(1,2 ГБ\)/)
  assert.match(first.text, /big = big\.copy\(\)/)
  // A failed copy is the same warning, only without the size.
  assert.match(first.text, /Переменную `conn`/)
  // And the attempt's own output follows and is not lost.
  assert.ok(
    outputs.some((o) => o.kind === 'stream' && /готово/.test((o as { text: string }).text)),
    'the attempt\'s output disappeared behind the warning',
  )

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/**
 * `exit()` in an attempt would shut down the kernel for the WHOLE room — and
 * this is said in words.
 *
 * In ipykernel `exit`/`quit` go to `shell.ask_exit()`, that is, to the end of
 * the process; reproduced on a live kernel — after such an attempt nobody has
 * `data`. The isolation replaces `ask_exit` with a refusal, and it must land
 * on the card as one human line: `<colloq-council>` frames are not the
 * student's code.
 */
test('an isolation refusal lands on the card as one line, without a traceback', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'REFUSE' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000))

  const outputs = (await runOf(at, at.petya))?.outputs ?? []
  const failure = outputs.find((o) => o.kind === 'error') as
    | { ename: string; evalue: string; traceback: string[] }
    | undefined
  assert.equal(failure?.ename, '', 'the exception name is still in front of the phrase about the shared kernel')
  assert.match(failure!.evalue, /нельзя завершать ядро/)
  assert.deepEqual(failure!.traceback, [], 'frames of the service module reached the student')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/**
 * A MemoryError under the ceiling is a class saved, and it has to be said
 * with a number: the student must understand that it was THEY who fell over,
 * not the room.
 */
test('running out of memory is explained by a line with the amount that was allotted', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'STARVE' }), null)
  councilReport = {
    ok: true, copied: 1, skipped: [], failed: [], bytes: 0, ms: 1,
    memory: 2 * 1024 * 1024 * 1024,
  }
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000))

  const outputs = (await runOf(at, at.petya))?.outputs ?? []
  // The real error's traceback stays: it has the line on which memory ran
  // out.
  const failure = outputs.find((o) => o.kind === 'error') as { ename: string } | undefined
  assert.equal(failure?.ename, 'MemoryError')
  const note = outputs.at(-1) as { kind: string; name: string; text: string }
  assert.equal(note.kind, 'stream')
  assert.equal(note.name, 'stderr')
  assert.match(note.text, /не хватило памяти/)
  assert.match(note.text, /2 ГБ/)
  assert.match(note.text, /Ядро и данные остальных целы/)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/**
 * A thread left by an attempt outlives it and keeps running in the shared
 * kernel. There is no way to stop it in Python — so it has to be named.
 */
test('threads left by the attempt are named at the end of its output', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  councilLeftovers = { threads: 2, processes: 2 }
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  const outputs = (await runOf(at, at.petya))?.outputs ?? []
  const text = outputs.map((o) => (o.kind === 'stream' ? (o as { text: string }).text : '')).join('')
  assert.match(text, /готово/, 'the attempt\'s output disappeared behind the notes')
  assert.match(text, /остались работать 2 потока/)
  assert.match(text, /Дочерние процессы/)
  // The notes are at the tail, after the attempt's own output.
  const first = outputs[0] as { text: string }
  assert.match(first.text, /готово/)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/* ------------------------------- the queue belongs to the NOTEBOOK, not to the cell */

/**
 * A notebook has ONE queue, and it is shared: plain cells and attempts from
 * all council cells stand in it mixed together. The rules limit guarded only
 * attempts — and a single `while True` in a plain cell held the whole council
 * until the end of the class. A teacher who had set "everyone in turn" and a
 * 30 s limit read this as "the limit does not work", and was right: a rule
 * that cuts off one queue out of two cuts off nothing.
 *
 * What is checked here is what came out of it:
 *   — a plain cell has a limit of its own, a room rule, and it frees the
 *     attempts queue;
 *   — the console sees WHOSE job holds the queue, and interrupts exactly it;
 *   — one person holds one run in the notebook's queue, not one per council
 *     cell;
 *   — a dropped run is explained to its author in words;
 *   — a kernel deaf to two signals stops being silent.
 */

/** One more cell in the room's notebook — that very "plain" one that holds the queue. */
async function cellWith(at: Room, text: string): Promise<string> {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { cellId, createCell, getCells } = await import('../shared/notebook.js')
  const { doc } = getSessionDoc(at.id)
  const cell = createCell('code', text)
  doc.transact(() => getCells(doc).push([cell]))
  return cellId(cell)
}

/** A plain cell's output — the same way the room reads it. */
async function cellText(at: Room, id: string): Promise<{ ename: string; evalue: string; traceback: string[] }[]> {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { findCell, readCell } = await import('../shared/notebook.js')
  const found = findCell(getSessionDoc(at.id).doc, id)
  if (!found) return []
  return readCell(found.cell).outputs.filter((o) => o.kind === 'error') as never
}

/** The room rule "a cell stops by itself after N" — on a live room. */
async function roomLimit(at: Room, seconds: number | null): Promise<void> {
  const { setRules, storedRules } = await import('../server/src/db.js')
  setRules(at.id, { ...storedRules(at.id), cellLimitSec: seconds })
}

/** The last "what the notebook's kernel is busy with" frame that reached the console. */
function lastKernel(who: Person, cellId: string) {
  for (let i = who.heard.length - 1; i >= 0; i--) {
    const m = who.heard[i]
    if (m.t === 'council:kernel' && m.cellId === cellId) return m.kernel
  }
  return null
}

test('a plain cell stops by the room rule — and the attempts queue moves on', async () => {
  const at = await room()
  await roomLimit(at, 1)
  const hang = await cellWith(at, 'HANG')
  assert.equal(await council(at, { studentRun: true, runLimitSec: 1 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)

  // Exactly the arrangement from the complaint: in front, a plain cell with
  // no end, behind it an attempt whose limit until now meant nothing.
  assert.equal(await say(at, at.teacher, { t: 'run', cellId: hang }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 6000),
    'the attempts queue is still standing behind the plain cell',
  )

  /*
   * And the cell itself is explained in one line, without a traceback about
   * the keyboard: it gets read as "someone pressed stop", while it was the
   * rules that pressed it.
   */
  const errors = await cellText(at, hang)
  assert.equal(errors.length, 1, 'the cell was left without an explanation (or has two)')
  assert.equal(errors[0].ename, '', 'the English exception name is in front of the Russian phrase')
  assert.match(errors[0].evalue, /Остановлено/)
  assert.deepEqual(errors[0].traceback, [], 'the interrupt traceback stayed in the cell')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('without the room rule a plain cell is not touched — and that is the old behaviour', async () => {
  const at = await room()
  await roomLimit(at, null)
  const hang = await cellWith(at, 'HANG')
  assert.equal(await say(at, at.teacher, { t: 'run', cellId: hang }), null)
  // Longer than any limit in this suite: there must be no alarm at all.
  await wait(12 * 50)
  assert.equal(interrupts, 0, 'the cell was interrupted in a room where the limit was not turned on')
  assert.deepEqual(await cellText(at, hang), [])

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('the console sees whose job holds the queue and interrupts exactly it', async () => {
  const at = await room()
  await roomLimit(at, null)
  const hang = await cellWith(at, 'HANG')
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.teacher, { t: 'run', cellId: hang }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  /*
   * The console is open on a council cell, while the kernel is held by
   * SOMEONE ELSE's plain cell. It used to honestly write "no code is running
   * in this cell" next to "Queued: 1" and hid the "Interrupt" button — in the
   * one minute when it is needed.
   */
  assert.ok(
    await until(() => lastKernel(at.teacher, at.cell)?.busy?.kind === 'cell', 4000),
    'the console did not learn that the kernel is busy with a plain cell',
  )
  const seen = lastKernel(at.teacher, at.cell)!
  assert.equal(seen.busy?.here, false, 'someone else\'s job was passed off as this cell\'s attempt')
  assert.equal(seen.busy?.name, 'Ада', 'it is not said who started it')
  assert.ok(seen.busy!.index !== null, 'the cell number is not named')
  assert.ok(seen.queued >= 1, 'the notebook queue was counted for one cell')

  // The console's "Interrupt" button names ITS OWN cell — and must stop what
  // actually holds the queue.
  assert.equal(await say(at, at.teacher, { t: 'interrupt', cellId: at.cell }), null)
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 6000),
    'pressing "Interrupt" did not reach someone else\'s job',
  )

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('one run per person in the notebook queue — a second press names the position', async () => {
  const at = await room()
  await roomLimit(at, null)
  const second = await cellWith(at, '# второй консилиум')
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(
    await say(at, at.teacher, { t: 'cell:lock', cellId: second, state: 'council', settings: { studentRun: true, runLimitSec: null } as never }),
    null,
  )
  // The kernel is occupied by someone else's endless attempt: the queue
  // stands, and people pile up in it.
  assert.equal(await say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(await say(at, at.masha, { t: 'council:run', cellId: at.cell }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: second, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  // A second cell, the same person, the same notebook — and the same shared
  // kernel.
  const refused = await say(at, at.petya, { t: 'council:run', cellId: second })
  assert.ok(refused, 'the person took the shared kernel\'s queue twice')
  assert.match(refused!, /уже стоит в очереди этой тетради/)
  assert.match(refused!, /\d/, 'the refusal did not name the queue position')

  const { councilQueuePositions } = await import('../server/src/kernel/index.js')
  const mine = councilQueuePositions(at.id).filter((q) => q.participantId === at.petya.payload.participantId)
  assert.equal(mine.length, 1, 'more than one of their jobs is left in the notebook queue')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('"take the run out of the queue" removes the job from the queue and tells the author', async () => {
  const at = await room()
  await roomLimit(at, null)
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(await say(at, at.masha, { t: 'council:run', cellId: at.cell }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  const { councilQueuePosition } = await import('../server/src/kernel/index.js')
  assert.ok(
    await until(() => councilQueuePosition(at.id, at.cell, at.petya.payload.participantId) !== null, 3000),
    'the run did not get into the queue',
  )

  // It takes off the job, not the person: until now the only button on
  // someone else's entry was "remove from class".
  const said = await say(at, at.teacher, {
    t: 'council:run:drop',
    cellId: at.cell,
    participantId: at.petya.payload.participantId,
  })
  assert.equal(said, null, 'the teacher was refused dropping someone else\'s run')
  assert.equal(councilQueuePosition(at.id, at.cell, at.petya.payload.participantId), null)
  assert.equal(lastMine(at.petya, at.cell)?.run, null, 'the run stayed on the author\'s card')

  // And the author heard about it in words: a run that vanished silently is a
  // breakage.
  const heard = at.petya.heard.filter((m) => m.t === 'error').at(-1)
  assert.ok(heard && heard.t === 'error', 'the author was not told a word')
  assert.match(heard.message, /снял ваш запуск/)

  // The person is still in the class meanwhile and can run again.
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('the kernel did not answer two signals — the queue does not freeze silently', async () => {
  const at = await room()
  await roomLimit(at, null)
  assert.equal(await council(at, { studentRun: true, runLimitSec: 1 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  deaf = true
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  assert.ok(
    await until(() => lastKernel(at.teacher, at.cell)?.busy?.stuck === true, 6000),
    'the teacher never learned that the kernel is deaf to interrupts',
  )
  const seen = lastKernel(at.teacher, at.cell)!
  assert.equal(seen.busy?.kind, 'attempt')
  assert.equal(seen.busy?.here, true, 'their own attempt was passed off as someone else\'s job')

  /*
   * And there are exactly two signals: SIGINT in a tight loop once a second
   * is a storm of requests to Jupyter until the end of the class, which would
   * not help anyway.
   */
  await wait(8 * 50)
  assert.equal(interrupts, 2, 'the server storms the kernel with signals')

  // A line about the same in the kernel log, where the room reads about its
  // kernel.
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { getTerminal } = await import('../shared/notebook.js')
  const log = getTerminal(getSessionDoc(at.id).doc)
    .toArray()
    .map((line) => JSON.stringify(line.toJSON()))
    .join('\n')
  assert.match(log, /не отвечает на прерывание/)

  deaf = false
  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})
