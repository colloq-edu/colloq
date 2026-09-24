/**
 * What the room is told when the kernel dies.
 *
 * This is the failure that hides: Jupyter deletes a kernel and leaves the
 * channels websocket **open** — no close frame, no error, measured against a
 * real container. So a seminar whose kernel had been OOM-killed looked healthy,
 * every Run afterwards vanished into a socket connected to nothing, and cells
 * sat "running" until somebody guessed that Restart was the answer.
 *
 * A fake Jupyter rather than a real one, because the whole point is a kernel
 * that dies without saying so, and a real kernel will not do that on request.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, afterEach, before, beforeEach, test } from 'node:test'
// Import settings only after the fake Jupyter URL is prepared by before().
beforeEach(async () => {
  const { setInstanceLanguage } = await import('../server/src/admin/settings.js')
  setInstanceLanguage('en')
})
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'
import type * as Y from 'yjs'
import { guardAnswer } from './_guard.mts'

/* ------------------------------------------------------------ fake Jupyter */

const kernels = new Map<string, { alive: boolean; busy: boolean }>()
const byPath = new Map<string, string>()
let minted = 0
let sockets: WebSocket[] = []
let http: Server
let wss: WebSocketServer
let port = 0
/** Set to hang instead of answering, the way a kernel that is thinking does. */
let swallowExecutes = false
/** Delay the HTTP interrupt response to exercise the queue/interrupt race. */
let holdInterrupts = false
let pendingInterrupts: Array<() => void> = []
/**
 * The same for service requests over shell — completions and help.
 *
 * A separate flag, because this is a separate case from real life: a kernel
 * computing someone else's cell does not answer `complete_request` at all —
 * ipykernel handles shell one message at a time. `swallowExecutes` cannot
 * check this: execution and completion now travel by different roads.
 */
let swallowShell = false
/** The fake's execution counter — the same as In [n] in a real kernel. */
let executions = 0
/** What was asked to run and how: `store_history` is whether IPython puts the source into In/_ih. */
const requests: { code: string; store_history: boolean; silent: boolean }[] = []
/**
 * Requests the fake is sitting on. A real kernel answers an interrupted request
 * with an aborted reply and an idle status; without that the caller waits for
 * ever, which is a property of this fake and not of the thing being tested.
 */
let held: Array<{ socket: WebSocket; parent: unknown; asked?: boolean; code?: string }> = []

/**
 * The report of the council isolation entry (kernel/council-isolation.ts).
 *
 * A real kernel answers `user_expressions` even when silent, and the server
 * reads that as "the personal data copies are ready". Without an answer it
 * must NOT start the attempt — so a fake without this branch would check
 * only the refusal.
 */
function councilExpressions(asked: boolean, code = ''): Record<string, unknown> {
  if (!asked) return {}
  /*
   * Installing the guard against dangerous commands comes by the same road
   * and with the same key, and without confirmation the server does not run
   * the cell at all (kernel/index.ts · ensureGuard). The answer is shared by
   * all fakes — tests/_guard.mts.
   */
  const guard = guardAnswer(code)
  if (guard) {
    return {
      user_expressions: {
        colloq: { status: 'ok', data: { 'text/plain': JSON.stringify(guard) }, metadata: {} },
      },
    }
  }
  /*
   * The `colloq` key is shared by two service runs — the council entry and
   * the static help parse (kernel/inspect-static.ts) — and they must be
   * answered DIFFERENTLY. We tell them apart by the code: help arrives with its
   * own hidden module on the very first line. Otherwise the help parse would
   * read the council report and always answer "not found".
   */
  const text = code.includes('.brief(globals()')
    ? JSON.stringify({ found: true, brief: { type: 'DataFrame', dims: '1460 × 81' } })
    : code.includes('.facts(globals()')
    ? JSON.stringify({
        found: true,
        text: 'Module: seaborn\nType: module\nPackage: seaborn 0.13.2\nSummary: Statistical data visualization\nDocs: http://seaborn.pydata.org',
      })
    : code.includes('_colloq_inspect')
      ? JSON.stringify({ found: true, text: 'Signature:\nsns.lmplot(data)\nType: function' })
      : JSON.stringify({ ok: true, copied: 1, skipped: [], failed: [], bytes: 0, ms: 1 })
  return {
    user_expressions: {
      colloq: { status: 'ok', data: { 'text/plain': text }, metadata: {} },
    },
  }
}

function reply(socket: WebSocket, parent: unknown, msgType: string, content: unknown): void {
  socket.send(
    JSON.stringify({
      header: { msg_id: `m_${Math.random().toString(36).slice(2)}`, msg_type: msgType },
      parent_header: parent,
      metadata: {},
      content,
      /*
       * The channel is the real one, not "iopub, whatever it is".
       *
       * Here stood `msgType === 'status' ? 'iopub' : 'iopub'` — a dead
       * ternary, both branches the same. The server does not read the
       * `channel` field today, so the fake stayed green with any value; but a
       * real Jupyter sends `execute_reply` over shell and `input_request` over
       * stdin, and the very first routing of incoming messages by channel
       * would silently diverge from the fake — tests green, live kernel broken.
       */
      channel: msgType.endsWith('_reply')
        ? 'shell'
        : msgType === 'input_request'
          ? 'stdin'
          : 'iopub',
    }),
  )
}

before(async () => {
  http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const kernelMatch = /^\/api\/kernels\/([^/]+)$/.exec(url.pathname)

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      // Idempotent by path, exactly as Jupyter is — which is what lets a
      // restarted server re-attach to a live kernel instead of orphaning it.
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const path = (JSON.parse(body || '{}') as { path?: string }).path ?? ''
        let id = byPath.get(path)
        if (!id || !kernels.get(id)?.alive) {
          id = `k_${++minted}`
          byPath.set(path, id)
          kernels.set(id, { alive: true, busy: false })
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `s_${id}`, kernel: { id } }))
      })
      return
    }
    if (req.method === 'GET' && kernelMatch) {
      const kernel = kernels.get(kernelMatch[1])
      // The one question this whole mechanism rests on.
      if (!kernel?.alive) {
        res.writeHead(404).end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ id: kernelMatch[1], execution_state: kernel.busy ? 'busy' : 'idle' }),
      )
      return
    }
    if (req.method === 'POST' && /\/restart$/.test(url.pathname)) {
      /*
       * A restart the way a real Jupyter does it: the same kernel id, the same
       * socket, a new process behind them. The fake could not do this at all
       * and answered 404, so `restartSession` went into catch and never got to
       * resetting the cells — and a test for that reset would therefore have
       * to run against a live container. Once it did: green as long as a
       * kernel happened to be running nearby.
       */
      const id = /^\/api\/kernels\/([^/]+)\/restart$/.exec(url.pathname)?.[1]
      const kernel = id ? kernels.get(id) : undefined
      if (kernel) kernel.busy = false
      // Pending executions die together with the process.
      for (const { socket, parent } of held.splice(0)) {
        reply(socket, parent, 'execute_reply', { status: 'abort', execution_count: 1 })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, name: 'python3' }))
      return
    }
    if (req.method === 'POST' && /\/interrupt$/.test(url.pathname)) {
      const finish = () => {
        const id = /^\/api\/kernels\/([^/]+)\/interrupt$/.exec(url.pathname)?.[1]
        const kernel = id ? kernels.get(id) : undefined
        if (kernel) kernel.busy = false
        for (const { socket, parent } of held.splice(0)) {
          reply(socket, parent, 'error', { ename: 'KeyboardInterrupt', evalue: '', traceback: [] })
          reply(socket, parent, 'execute_reply', { status: 'error', execution_count: 1 })
          reply(socket, parent, 'status', { execution_state: 'idle' })
        }
        res.writeHead(204).end()
      }
      if (holdInterrupts) pendingInterrupts.push(finish)
      else finish()
      return
    }
    res.writeHead(404).end('{}')
  })

  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const id = /^\/api\/kernels\/([^/]+)\/channels/.exec(req.url ?? '')?.[1]
    if (!id || !kernels.has(id)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws)
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as {
          header: { msg_type: string }
          content: { code: string; store_history: boolean; silent: boolean }
        }
        /*
         * Completion and help: the same socket, the same shell, no output —
         * but there are `busy` and `idle` around the answer, as with a real
         * ipykernel: it publishes a status around ANY request over shell. The
         * fake used to not send them, and so did not see the kernel indicator
         * blinking for the whole room on every completion keystroke.
         */
        if (msg.header.msg_type === 'complete_request') {
          if (swallowShell) return
          reply(ws, msg.header, 'status', { execution_state: 'busy' })
          reply(ws, msg.header, 'complete_reply', {
            status: 'ok',
            matches: ['df.head', 'df.describe'],
            cursor_start: 3,
            cursor_end: 3,
            // The field is experimental and not every kernel has it — hence
            // the check that the list is built even without it.
            metadata: {
              _jupyter_types_experimental: [{ type: 'function' }, { type: 'function' }],
            },
          })
          reply(ws, msg.header, 'status', { execution_state: 'idle' })
          return
        }
        if (msg.header.msg_type === 'inspect_request') {
          if (swallowShell) return
          reply(ws, msg.header, 'status', { execution_state: 'busy' })
          reply(ws, msg.header, 'inspect_reply', {
            status: 'ok',
            /*
             * `NOTFOUND` in the code is a name that is not in the namespace.
             * A real kernel answers like this whenever the cell with the
             * import has not been run yet, and exactly here the second help
             * path begins — jedi's static parse.
             */
            found: !msg.content.code.includes('NOTFOUND'),
            /*
             * About a MODULE a real IPython answers exactly this: the kind, the
             * object's memory address and `<no docstring>` — seaborn has no
             * docstring at all. The package addition (kernel/inspect-static.ts
             * · facts) exists for this kind of answer.
             */
            data: {
              'text/plain': msg.content.code.includes('MODULE')
                ? "\u001b[0;31mType:\u001b[0m        module\nString form: <module 'seaborn' from '/x/seaborn/__init__.py'>\nFile:        /x/seaborn/__init__.py\nDocstring:   <no docstring>"
                : '\u001b[0;31mSignature:\u001b[0m df.head(n=5)',
            },
          })
          reply(ws, msg.header, 'status', { execution_state: 'idle' })
          return
        }
        if (msg.header.msg_type !== 'execute_request') return
        requests.push({
          code: msg.content.code,
          store_history: msg.content.store_history,
          silent: msg.content.silent,
        })
        const asked =
          Object.keys((msg.content as { user_expressions?: object }).user_expressions ?? {}).length >
          0
        /*
         * Markers are looked for only in CELL CODE, not in service requests.
         *
         * The service kernel runs silently (`silent: true`), and the council
         * isolation source goes there — a hundred lines with comments that
         * honestly say "OOM-killer". The fake read that as "the cell killed
         * the kernel for memory" and answered `restarting`: the attempt never
         * started, and the test failed after five seconds of waiting.
         */
        const service = msg.content.silent === true
        /*
         * `HOLD` is a cell that does not finish until it is released BY NAME.
         *
         * `swallowExecutes` is a flag for the whole fake, and for one kernel
         * that was enough. There are now as many kernels as notebooks, and the
         * main thing about them is that they compute IN PARALLEL: this can be
         * checked only by holding one while the other answers. The marker is
         * in the cell code, so exactly the kernel it was sent to is held.
         */
        /*
         * The guard installation is NEVER held, whatever the flags say.
         *
         * A real kernel answers it in the very first millisecond after coming
         * up — it is one `apply()` line in a fresh process, and there is
         * nothing to hold it with. A fake that held it together with the cell
         * would be checking not the queue but a five-second wait for a
         * confirmation nobody was going to send.
         */
        const guarding = guardAnswer(msg.content.code) !== null
        if (!guarding && (swallowExecutes || (!service && /HOLD/.test(msg.content.code)))) {
          reply(ws, msg.header, 'status', { execution_state: 'busy' })
          held.push({ socket: ws, parent: msg.header, asked, code: msg.content.code })
          return
        }
        reply(ws, msg.header, 'status', { execution_state: 'busy' })
        /*
         * The execution number arrives in execute_input, and a real kernel
         * always sends it — while the fake never did, so execCount in tests
         * silently stayed null and any check about the number was pointless.
         */
        reply(ws, msg.header, 'execute_input', {
          code: msg.content.code,
          execution_count: ++executions,
        })
        /*
         * A cell that kills the kernel for memory.
         *
         * In this case a real Jupyter does not answer the request at all: it
         * sends `status: restarting` — the same kernel id, the same socket, a
         * new process behind them. The fake could not do this, and the whole
         * auto-restart path was covered by nothing.
         */
        if (!service && /OOM/.test(msg.content.code)) {
          reply(ws, msg.header, 'status', { execution_state: 'restarting' })
          return
        }
        // A cell whose source says so fails, so a suite can build a notebook
        // that breaks in the middle without needing a real Python.
        if (!service && /RAISE/.test(msg.content.code)) {
          reply(ws, msg.header, 'error', {
            ename: 'ValueError',
            evalue: 'the exercise stops here',
            traceback: ['ValueError: the exercise stops here'],
          })
          reply(ws, msg.header, 'execute_reply', { status: 'error', execution_count: 1 })
          reply(ws, msg.header, 'status', { execution_state: 'idle' })
          return
        }
        /*
         * `name?` is help, and it does not arrive over iopub.
         *
         * IPython answers it with the `payload` field in the execute_reply
         * itself, the very piece that in a real notebook opens as a "page" at
         * the bottom of the window. There is no stream and no display_data at
         * all — which is why the cell stayed empty while the server read only
         * the status from this message. The fake repeats the same shape.
         */
        if (!service && /\?$/.test(msg.content.code.trim())) {
          reply(ws, msg.header, 'execute_reply', {
            status: 'ok',
            execution_count: 1,
            payload: [
              {
                source: 'page',
                data: { 'text/plain': 'Signature: print(*args)\nDocstring: Prints the values.' },
                start: 0,
              },
            ],
          })
          reply(ws, msg.header, 'status', { execution_state: 'idle' })
          return
        }
        // A cell that prints nothing: `x = 1`, a function definition, an
        // import. A real kernel answers such a cell with exactly this — a reply
        // and idle, without a single iopub output.
        if (!service && /SILENT/.test(msg.content.code)) {
          reply(ws, msg.header, 'execute_reply', { status: 'ok', execution_count: 1 })
          reply(ws, msg.header, 'status', { execution_state: 'idle' })
          return
        }
        // A silent request shows no output — but the isolation entry expects
        // `user_expressions` from it, and that is the only answer it will hear.
        if (!msg.content.silent) {
          reply(ws, msg.header, 'stream', { name: 'stdout', text: `${msg.content.code}\n` })
        }
        reply(ws, msg.header, 'execute_reply', {
          status: 'ok',
          execution_count: 1,
          ...councilExpressions(asked, msg.content.code),
        })
        reply(ws, msg.header, 'status', { execution_state: 'idle' })
      })
    })
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  port = (http.address() as { port: number }).port
  process.env.JUPYTER_URL = `http://127.0.0.1:${port}`
  process.env.JUPYTER_TOKEN = 'fake'
  // Reacting in milliseconds rather than the ten seconds a real room can afford.
  process.env.KERNEL_QUIET_MS = '150'
  process.env.KERNEL_WATCHDOG_MS = '50'
})

/*
 * The fake stops swallowing executions after EVERY test, whatever happened in
 * it.
 *
 * The flag was set at the start of a test and cleared by its last line — so an
 * assertion failing in the middle left the fake swallowing, and the whole tail
 * of the file failed with "the cell never started": the real failure drowned
 * in two dozen false ones, and there was nothing to find it by in the output.
 * Held requests go away together with the flag — each test has its own room,
 * and nobody is left to sit them out.
 */
afterEach(() => {
  swallowExecutes = false
  swallowShell = false
  holdInterrupts = false
  for (const finish of pendingInterrupts.splice(0)) finish()
  held = []
})

after(async () => {
  held = []
  for (const socket of sockets) socket.terminate()
  wss?.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
  const { shutdownKernels } = await import('../server/src/kernel/index.js')
  const { shutdownCollab } = await import('../server/src/collab/index.js')
  await shutdownKernels()
  shutdownCollab()
})

/* ------------------------------------------------------------------ helpers */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) return true
    await wait(25)
  }
  return false
}

/** Push one stdout chunk into whatever request the fake is sitting on. */
function say(text: string): void {
  const [first] = held
  assert.ok(first, 'wait for the fake to receive execute_request before injecting output')
  reply(first.socket, first.parent, 'stream', { name: 'stdout', text })
}

/** Release only the held requests whose code matches the pattern. */
function finishHeld(match: RegExp): number {
  const mine = held.filter((one) => match.test(one.code ?? ''))
  held = held.filter((one) => !match.test(one.code ?? ''))
  for (const { socket, parent, asked } of mine) {
    reply(socket, parent, 'execute_reply', {
      status: 'ok',
      execution_count: 1,
      ...councilExpressions(asked === true),
    })
    reply(socket, parent, 'status', { execution_state: 'idle' })
  }
  return mine.length
}

/** Let the held request finish, the way a kernel does when the cell ends. */
function shellFinish(): void {
  for (const { socket, parent, asked } of held.splice(0)) {
    reply(socket, parent, 'execute_reply', {
      status: 'ok',
      execution_count: 1,
      ...councilExpressions(asked === true),
    })
    reply(socket, parent, 'status', { execution_state: 'idle' })
  }
}

let seq = 0

async function seminar() {
  const { createSession } = await import('../server/src/db.js')
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { getCells, getMeta, getTerminal, cellSource } = await import('../shared/notebook.js')
  const id = `kern${seq++}`
  createSession(id, `Kernel ${id}`)
  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(1)
  return {
    id,
    doc,
    cellId: cell.get('id') as string,
    type: (source: string) => {
      const text = cellSource(cell)
      text.delete(0, text.length)
      text.insert(0, source)
    },
    state: () => cell.get('state'),
    startedAt: () => cell.get('startedAt') as number | null,
    ranMs: () => cell.get('ranMs') as number | null,
    cell,
    status: () => getMeta(doc).get('kernelStatus'),
    notes: () =>
      getTerminal(doc)
        .toArray()
        .filter((line) => line.get('kind') === 'system')
        .map((line) => String(line.get('text'))),
  }
}

test('activity records accepted execution once with correlated start and result', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { listActivity } = await import('../server/src/activity.js')
  const { getCells } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('print(1)')
  const markdown = getCells(room.doc).get(0).get('id') as string
  requestRun(room.id, [markdown, room.cellId, room.cellId, 'missing'], 'Student', 'p_student', 1)
  assert.ok(await until(() => room.state() === 'ok'))
  const events = listActivity(room.id, { level: 'detailed', category: 'runtime' }).events.reverse()
  assert.deepEqual(events.map(event => event.kind), ['execution.queued', 'execution.started', 'execution.finished'])
  assert.equal(events[0].details.count, 1)
  assert.equal(events[1].details.requestSeq, events[0].seq)
  assert.equal(events[2].details.requestSeq, events[0].seq)
  assert.equal(events[2].details.outcome, 'completed')
  assert.ok(events[2].details.durationMs! >= 0)
  assert.ok(events.every(event => event.actor?.id === 'p_student' && event.details.cellId === room.cellId))
})

test('activity keeps unsuccessful attempts separate from successful runs', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { listActivity } = await import('../server/src/activity.js')
  const room = await seminar()
  room.type('RAISE')
  requestRun(room.id, [room.cellId], 'Student', 'p_student')
  assert.ok(await until(() => room.state() === 'error'))
  const events = listActivity(room.id, { level: 'detailed', category: 'runtime' }).events
  assert.equal(events.filter(event => event.kind === 'execution.finished').length, 1)
  assert.equal(events[0].details.outcome, 'error')
  assert.equal(JSON.stringify(events).includes('RAISE'), false, 'activity must not copy code')
})

test('activity identifies a council draft owner separately from the teacher running it', async () => {
  const { requestCouncilRun } = await import('../server/src/kernel/index.js')
  const { listActivity } = await import('../server/src/activity.js')
  const room = await seminar()
  let done = false
  requestCouncilRun(room.id, {
    cellId: room.cellId, participantId: 'p_student', source: 'print("attempt")', by: 'host', limitSec: null,
    onChange: run => { done = run?.state === 'ok' },
  }, 'Teacher', 'p_teacher')
  assert.ok(await until(() => done))
  const events = listActivity(room.id, { level: 'detailed', category: 'runtime' }).events.reverse()
  assert.deepEqual(events.map(event => event.kind), ['execution.queued', 'execution.started', 'execution.finished'])
  assert.ok(events.every(event => event.actor?.id === 'p_teacher' && event.details.subjectId === 'p_student'))
  assert.equal(events[2].details.requestSeq, events[0].seq)
  assert.equal(events[2].details.outcome, 'completed')
})

test('activity records a cancelled queued cell without inventing an execution', async () => {
  const { requestRun, cancelRun } = await import('../server/src/kernel/index.js')
  const { listActivity } = await import('../server/src/activity.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('print(1)')
  const second = createCell('code', 'print(2)')
  getCells(room.doc).push([second])
  const secondId = second.get('id') as string
  requestRun(room.id, [room.cellId, secondId], 'Student', 'p_student')
  assert.equal(cancelRun(room.id, [secondId], 'p_student', false), 1)
  assert.ok(await until(() => room.state() === 'ok'))
  const events = listActivity(room.id, { level: 'detailed', category: 'runtime' }).events
    .filter(event => event.details.cellId === secondId).reverse()
  assert.deepEqual(events.map(event => event.kind), ['execution.queued', 'execution.finished'])
  assert.equal(events[1].details.outcome, 'cancelled')
  assert.equal(events[1].details.requestSeq, events[0].seq)
  assert.equal(events[1].details.durationMs, 0)
})

test('activity treats explicit KeyboardInterrupt as cancellation for cells and council attempts', async () => {
  const { requestRun, requestCouncilRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { listActivity } = await import('../server/src/activity.js')
  for (const council of [false, true]) {
    const room = await seminar()
    room.type('print("long")')
    swallowExecutes = true
    try {
      if (council) requestCouncilRun(room.id, {
        cellId: room.cellId, participantId: 'p_student', source: 'print("long")', by: 'host', limitSec: null, onChange() {},
      }, 'Teacher', 'p_teacher')
      else requestRun(room.id, [room.cellId], 'Student', 'p_student')
      assert.ok(await until(() => held.length > 0))
      if (council) {
        // Allow the namespace snapshot to finish, then interrupt the student's
        // actual request; teardown must be allowed to finish normally as well.
        shellFinish()
        assert.ok(await until(() => held.length > 0 && requests.at(-1)?.silent === false))
      }
      swallowExecutes = false
      await interruptSession(room.id)
      assert.ok(await until(() => listActivity(room.id, { level: 'detailed', category: 'runtime' }).events
        .some(event => event.kind === 'execution.finished')))
      const finished = listActivity(room.id, { level: 'detailed', category: 'runtime' }).events
        .filter(event => event.kind === 'execution.finished')
      assert.equal(finished.length, 1)
      assert.equal(finished[0].details.outcome, 'cancelled', council ? 'council' : 'cell')
    } finally { swallowExecutes = false; shellFinish() }
  }
})

/* -------------------------------------------------------------------- tests */

test('a cell runs and the room sees its output', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { readNotebook } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'), `cell ended as ${String(room.state())}`)
  const outputs = readNotebook(room.doc)[1].outputs
  assert.match(JSON.stringify(outputs), /print\(1\)/)
})

test('a council attempt runs without kernel history — In/_ih does not give away other attempts', async () => {
  const { requestRun, requestCouncilRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print("cell")')
  requestRun(room.id, [room.cellId], 'Ада', 'p_t')
  assert.ok(await until(() => room.state() === 'ok'), 'the cell did not finish computing')

  let last: { state: string } | null = null
  requestCouncilRun(
    room.id,
    {
      cellId: room.cellId,
      participantId: 'p_student',
      source: 'print("attempt")',
      by: 'host',
      limitSec: null,
      onChange: (run) => {
        last = run
      },
    },
    'Ада',
    'p_t',
  )
  assert.ok(
    await until(() => last !== null && (last as { state: string }).state === 'ok'),
    'the attempt did not finish computing',
  )
  const cell = requests.find((r) => r.code === 'print("cell")')
  const attempt = requests.find((r) => r.code === 'print("attempt")')
  assert.ok(cell && attempt, 'the fake did not see the requests')
  assert.equal(cell.store_history, true, 'the cell is an ordinary one, it has In[n]')
  // The kernel is shared: with history, anyone the cell is opened to later
  // could read the attempt's text.
  assert.equal(attempt.store_history, false)
  // But not silent: the attempt needs the expression output (execute_result).
  assert.equal(attempt.silent, false)
})

test('a kernel that dies mid-run stops the room within seconds, and says why', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_2')
  assert.ok(await until(() => room.state() === 'running'), 'the cell never started')

  // The kernel goes. The socket, as in the real thing, stays open.
  for (const kernel of kernels.values()) kernel.alive = false

  assert.ok(await until(() => room.state() === 'error'), 'the cell span forever')
  assert.equal(room.status(), 'dead')
  assert.ok(
    room.notes().some((note) => /kernel stopped/i.test(note)),
    `the room was told nothing: ${JSON.stringify(room.notes())}`,
  )
  swallowExecutes = false
})

test('a kernel that died while nobody was looking is replaced on the next Run', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print("first")')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_3')
  assert.ok(await until(() => room.state() === 'ok'), 'the first run never finished')

  // Killed between two cells, in silence.
  for (const kernel of kernels.values()) kernel.alive = false
  await wait(250)

  room.type('print("second")')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_3')
  assert.ok(
    await until(() => room.state() === 'ok'),
    `the run after a silent death ended as ${String(room.state())}`,
  )
  const notes = room.notes()
  assert.ok(
    notes.some((note) => /starting a fresh one/i.test(note)),
    `no explanation for the lost variables: ${JSON.stringify(notes)}`,
  )
  assert.ok(
    !notes.some((note) => /while a cell was running/i.test(note)),
    `the room was told a cell died when none had: ${JSON.stringify(notes)}`,
  )
})

test('work left over from a dead server is let go of, not waited on', async () => {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { createSession } = await import('../server/src/db.js')
  const { ensureKernel } = await import('../server/src/kernel/index.js')
  const { getTerminal } = await import('../shared/notebook.js')

  // A kernel that is already busy when this server first reaches it belongs to
  // a process that is gone; its output has nowhere to go and everything anyone
  // runs from now on would queue behind it.
  const id = `orphan${seq++}`
  createSession(id, 'Orphan')
  const { doc } = getSessionDoc(id)
  const before = kernels.size
  await ensureKernel(id)
  const [newest] = [...kernels.entries()].slice(before)
  assert.ok(newest, 'no kernel was created')
  newest[1].busy = true

  // Reconnecting to it is what a server restart does.
  const { shutdownKernels } = await import('../server/src/kernel/index.js')
  await shutdownKernels()
  await ensureKernel(id)

  assert.equal(newest[1].busy, false, 'the orphaned run was left to block the room')
  const notes = getTerminal(doc)
    .toArray()
    .filter((line) => line.get('kind') === 'system')
    .map((line) => String(line.get('text')))
  assert.ok(
    notes.some((note) => /Reconnected to the existing kernel/i.test(note)),
    `the room was not told: ${JSON.stringify(notes)}`,
  )
})

test('Run All on a kernel that died quietly carries the whole batch through to the end', async () => {
  /*
   * The kernel dies during the break: the socket stays open, and this is
   * found out only by polling before a cell is sent. At that moment
   * `dropQueue` used to clear the queue ENTIRELY — before the "expected death"
   * check — so Run All on thirty cells executed the first, and the rest
   * silently went back to rest without a single word about why. And it took
   * other people's batches along too, against the promise "a failure stops
   * only your own".
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const tail = [createCell('code', 'print("two")'), createCell('code', 'print("three")')]
  room.doc.transact(() => cells.push(tail))
  room.type('print("one")')

  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'ok'), 'the first run did not go through')

  for (const kernel of kernels.values()) kernel.alive = false
  // Longer than KERNEL_QUIET_MS: the next send will first ask whether the
  // kernel is alive.
  await wait(250)

  const ids = [room.cellId, tail[0].get('id') as string, tail[1].get('id') as string]
  requestRun(room.id, ids, 'Maria', 'p_maria')

  const states = () => [room.state(), ...tail.map((c) => c.get('state'))]
  assert.ok(
    await until(() => states().every((state) => state === 'ok')),
    `the batch ended as ${JSON.stringify(states())}`,
  )
})

test('a cell that killed the kernel for memory ends with an error, not a quiet "Out [n]"', async () => {
  /*
   * On an auto-restart the kernel phase is `restarting`, not `dead`, and the
   * check in runOne missed it: the execution ended with `abort`, the cell
   * settled into `idle` with an execution number and partial output — on
   * screen indistinguishable from a successful one. The next cell failed with
   * NameError, and nobody saw the link to this one.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { readNotebook } = await import('../shared/notebook.js')
  const { useDockerForPostmortem } = await import('../server/src/kernel/postmortem.js')
  /*
   * The docker fake carries the numbers of the live machine on 13 Sep 2026: a
   * two-gigabyte limit, a peak that hit the limit, and the cgroup kill
   * counter. Real docker is not available to the suite (see `_env.mts`), and
   * what is checked here is exactly what does not happen without it.
   */
  let kills = 16
  useDockerForPostmortem(async (args) => {
    // The counter grows between readings — exactly how it looks on the
    // machine: the kernel start remembers one number, the death brings the
    // next.
    if (args[0] === 'exec') return { code: 0, out: `limit 2147483648\npeak 2149163008\ncurrent 122683392\nkills ${kills++}` }
    if (args[0] === 'logs') return { code: 0, out: '' }
    return { code: 0, out: 'running 0 true 2147483648' }
  })
  try {
    const room = await seminar()
    room.type('OOM: x = np.zeros((10**6, 10**4))')
    requestRun(room.id, [room.cellId], 'Maria', 'p_maria')

    assert.ok(
      await until(() => room.state() === 'error'),
      `the cell ended as ${String(room.state())}`,
    )
    const outputs = readNotebook(room.doc)[1].outputs
    assert.match(JSON.stringify(outputs), /KernelDied/, 'the cell said nothing about the kernel death')
    assert.equal(room.cell.get('execCount'), null, 'the execution number was left from the killed process')
    assert.ok(
      room.notes().some((note) => /memory|restart/i.test(note)),
      `the room was not told about the restart: ${JSON.stringify(room.notes())}`,
    )
    /*
     * And, on a second line — WHY. The whole trouble on 13 Sep 2026 was that
     * the log went no further than "the kernel restarted": fifteen identical
     * entries and not a single number. The limit, the usage and the cell
     * number are what one can do something with without logging into the
     * machine.
     */
    assert.ok(
      await until(() => room.notes().some((note) => /2 ГБ|2 GB/.test(note))),
      `the room never learned the cause of death: ${JSON.stringify(room.notes())}`,
    )
    const why = room.notes().find((note) => /2 ГБ|2 GB/.test(note)) ?? ''
    // The number is the ordinal in the notebook, counting markdown: the same
    // one drawn to the left of the cell. The notebook here is markdown and
    // code, and the cell is the second.
    assert.match(why, /(ячейке|cell) 2\b/, `the cell number in the cause is wrong: ${why}`)
  } finally {
    useDockerForPostmortem(null)
  }
})

/*
 * --------------------------------------------------------------------------
 * 20 Sep 2026. A room of thirty people lost its kernel nine times in eleven
 * minutes. Nine times the log said "restarted itself — oom", and the
 * postmortem ONE LINE BELOW objected: "did not exit because of memory, 5.2 GB
 * of 16 in use". The killer was `os._exit(0)` in a council attempt; the cgroup
 * was untouched (`oom_kill 0`), dmesg was clean. The word "oom" was a guess by
 * our code — and it sent people looking for a greedy cell that did not exist.
 *
 * Below are the three things that were missing that day: an honest word in
 * the log, the name of what was executing, and a count of crashes instead of
 * nine identical notes.
 * -------------------------------------------------------------------------- */

/** The numbers of that very container: a 16 GB limit, a 5.2 GB peak, the cgroup killed nobody. */
function notMemoryDocker() {
  return async (args: string[]) => {
    if (args[0] === 'exec') {
      return { code: 0, out: 'limit 17179869184\npeak 5559595008\ncurrent 5559595008\nkills 0' }
    }
    if (args[0] === 'logs') return { code: 0, out: 'kernel 24c0b107 restarted\n' }
    return { code: 0, out: 'running 0 false 17179869184' }
  }
}

/** Capture the machine log for the duration of one run. */
async function withWarnings<T>(body: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    return await body(lines)
  } finally {
    console.warn = original
  }
}

test('the log does not say "oom" when the kernel did not die of memory', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { useDockerForPostmortem } = await import('../server/src/kernel/postmortem.js')
  useDockerForPostmortem(notMemoryDocker())
  try {
    const room = await seminar()
    const warned = await withWarnings(async (lines) => {
      room.type('OOM: import os; os._exit(0)')
      requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
      assert.ok(await until(() => room.state() === 'error'), `the cell ended as ${String(room.state())}`)
      // The postmortem arrives second, via docker: we wait for exactly its line.
      assert.ok(await until(() => lines.some((line) => /] (oom|died):/.test(line))), `the postmortem was not printed: ${JSON.stringify(lines)}`)
      return lines
    })
    const said = warned.filter((line) => line.includes(room.id))
    const restart = said.find((line) => /restarted itself/.test(line)) ?? ''
    assert.ok(restart, `there is no line about the restart: ${JSON.stringify(said)}`)
    /*
     * Here it is, that very lie. The line is printed BEFORE going to docker,
     * that is, when nothing is known about memory yet — and it has nothing to
     * say "oom" with.
     */
    assert.doesNotMatch(restart, /oom/i, `the log is guessing the cause again: ${restart}`)
    assert.match(restart, /cause unknown/, `the log did not say the cause is unknown: ${restart}`)
    // And a postmortem that has something to say says `died:`, not `oom:`.
    const why = said.find((line) => /] (oom|died):/.test(line)) ?? ''
    assert.match(why, /] died:/, `the postmortem called this a memory shortage: ${why}`)
    assert.doesNotMatch(why, /] oom:/, `the postmortem called this a memory shortage: ${why}`)
  } finally {
    useDockerForPostmortem(null)
  }
})

test('the note to the room names the cell and whoever ran it', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { upsertParticipant } = await import('../server/src/db.js')
  const { useDockerForPostmortem } = await import('../server/src/kernel/postmortem.js')
  useDockerForPostmortem(notMemoryDocker())
  try {
    const room = await seminar()
    upsertParticipant({ sessionId: room.id, id: 'p_maria', name: 'Мария', role: 'participant', avatar: null })
    room.type('OOM: x = 1')
    requestRun(room.id, [room.cellId], 'Мария', 'p_maria')
    assert.ok(await until(() => room.state() === 'error'), `the cell ended as ${String(room.state())}`)
    /*
     * The notebook here is markdown and code, so the number of the executing
     * cell is 2: the same one drawn to the left of it in the room.
     */
    assert.ok(
      await until(() => room.notes().some((note) => /(ячейка|Cell) 2\b/.test(note))),
      `the room did not learn what was executing: ${JSON.stringify(room.notes())}`,
    )
    const said = room.notes().find((note) => /(ячейка|Cell) 2\b/.test(note)) ?? ''
    assert.match(said, /Мария/, `the note does not have the name of whoever ran it: ${said}`)
  } finally {
    useDockerForPostmortem(null)
  }
})

test('when a council attempt dies, the room learns WHOSE it was', async () => {
  const { requestCouncilRun } = await import('../server/src/kernel/index.js')
  const { upsertParticipant } = await import('../server/src/db.js')
  const { useDockerForPostmortem } = await import('../server/src/kernel/postmortem.js')
  useDockerForPostmortem(notMemoryDocker())
  try {
    const room = await seminar()
    upsertParticipant({ sessionId: room.id, id: 'p_chel', name: 'Чел', role: 'participant', avatar: null })
    upsertParticipant({ sessionId: room.id, id: 'p_host', name: 'Aleksandr K.', role: 'host', avatar: null })
    /*
     * That is exactly how it was: the TEACHER runs the attempt, going through
     * the council with the console, while a student wrote it. Without both
     * names the note sends people to sort it out with the wrong person.
     */
    requestCouncilRun(
      room.id,
      {
        cellId: room.cellId,
        participantId: 'p_chel',
        source: 'OOM: import os; os._exit(0)',
        by: 'host',
        limitSec: null,
        onChange() {},
      },
      'Aleksandr K.',
      'p_host',
    )
    assert.ok(
      await until(() => room.notes().some((note) => /Чел/.test(note))),
      `the room did not learn whose attempt killed the kernel: ${JSON.stringify(room.notes())}`,
    )
    const said = room.notes().find((note) => /Чел/.test(note)) ?? ''
    assert.match(said, /(консилиум|Council)/i, `the note did not say it was an attempt: ${said}`)
    assert.match(said, /(ячейк|cell) 2\b/i, `the note did not name the council cell: ${said}`)
  } finally {
    useDockerForPostmortem(null)
  }
})

test('crashes in a row are counted instead of being repeated nine times the same way', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { useDockerForPostmortem } = await import('../server/src/kernel/postmortem.js')
  useDockerForPostmortem(notMemoryDocker())
  try {
    const room = await seminar()
    room.type('OOM: x = 1')
    requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
    assert.ok(await until(() => room.state() === 'error'), 'the first death did not arrive')
    const first = room.notes().length
    // The first time the count is not mentioned: "1st time in ten minutes"
    // is not news.
    assert.ok(
      room.notes().every((note) => !/десять минут|ten minutes/.test(note)),
      `the count was mentioned already on the first death: ${JSON.stringify(room.notes())}`,
    )
    requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
    assert.ok(
      await until(() => room.notes().length > first && room.notes().some((note) => /десять минут|ten minutes/.test(note))),
      `the second death did not say it is the second: ${JSON.stringify(room.notes())}`,
    )
    const said = room.notes().find((note) => /десять минут|ten minutes/.test(note)) ?? ''
    assert.match(said, /2/, `the note has no count: ${said}`)
    // And a suggestion that can be carried out without logging into the
    // machine.
    assert.match(said, /(очеред|queue)/i, `the note did not suggest stopping the queue: ${said}`)
  } finally {
    useDockerForPostmortem(null)
  }
})

/* ------------------------------------------------- who may stop the kernel */

/**
 * The host can always interrupt; so can whoever started the cell that is
 * running, because a seminar with no teacher in the room otherwise has no way
 * to end a loop that will not end itself. Nobody else can.
 *
 * The answer comes from the server's own record of the run. It has to: the
 * document is shared, and a student with a console can write any `runById` they
 * like into any cell.
 */
test('only the person whose cell is running may stop it', async () => {
  const { requestRun, startedTheRunningCell } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  assert.equal(startedTheRunningCell(room.id, 'p_maria'), false, 'nothing is running yet')

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the cell never started')

  assert.equal(startedTheRunningCell(room.id, 'p_maria'), true)
  assert.equal(startedTheRunningCell(room.id, 'p_john'), false, 'a bystander could stop it')
  swallowExecutes = false
})

test('a forged runById in the document does not buy the right to interrupt', async () => {
  const { requestRun, startedTheRunningCell } = await import('../server/src/kernel/index.js')
  const { getCells } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the cell never started')

  // Mallory, with a console open, claims the run.
  const cell = getCells(room.doc).get(1)
  room.doc.transact(() => {
    cell.set('runById', 'p_mallory')
    cell.set('runBy', 'Mallory')
  })

  assert.equal(startedTheRunningCell(room.id, 'p_mallory'), false, 'the document was believed')
  assert.equal(startedTheRunningCell(room.id, 'p_maria'), true, 'the real runner lost the right')
  swallowExecutes = false
})

test('interrupting stops the tail as well as the cell', async () => {
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { getCells, createCell, cellSource } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const extra = [createCell('code', 'print("two")'), createCell('code', 'print("three")')]
  room.doc.transact(() => cells.push(extra))
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(
    room.id,
    [room.cellId, extra[0].get('id') as string, extra[1].get('id') as string],
    'Maria',
    'p_maria',
  )
  assert.ok(await until(() => room.state() === 'running'), 'the first cell never started')
  assert.ok(
    await until(() => extra.every((c) => c.get('state') === 'queued')),
    'the tail was never queued',
  )

  // Interrupting cell 1 of 3 must not start cell 2.
  await interruptSession(room.id)
  swallowExecutes = false

  assert.ok(
    await until(() => extra.every((c) => c.get('state') === 'idle')),
    `the tail kept its place: ${extra.map((c) => String(c.get('state'))).join(',')}`,
  )
  await wait(300)
  assert.ok(
    extra.every((c) => (c.get('outputs') as { length: number }).length === 0),
    'a cell the room had cancelled ran anyway',
  )
  assert.ok(cellSource(extra[0]).toString().length > 0)
})

test("a miss on someone else's cell does not clear their queue", async () => {
  /*
   * The button is drawn from the document, and the document lags a round trip
   * behind: a "stop" on one's own cell arrives when it has already finished,
   * and the kernel has taken the first cell of someone else's Run All.
   * `stopBatchOf` for the current cell fell back to `currentBatch` — that is,
   * to SOMEONE ELSE'S batch, and a student's twelve cells were switched off by
   * the teacher's press, with a note explaining the wrong thing.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const theirs = [createCell('code', 'while True: pass'), createCell('code', 'print("theirs")')]
  room.doc.transact(() => cells.push(theirs))

  // The teacher's cell has done its work.
  room.type('print("mine")')
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'ok'), "the teacher's cell did not run")

  // The student's Run All: the first one computes, the second one waits.
  swallowExecutes = true
  requestRun(
    room.id,
    theirs.map((c) => c.get('id') as string),
    'Ivan',
    'p_ivan',
  )
  assert.ok(await until(() => theirs[0].get('state') === 'running'), "the other person's cell did not start")
  assert.ok(await until(() => theirs[1].get('state') === 'queued'), "the other person's tail did not queue")

  // The teacher presses "stop" on their own cell — one that has already
  // finished.
  await interruptSession(room.id, room.cellId)
  swallowExecutes = false

  /*
   * The SIGINT goes to whatever is computing: there is one kernel, and it has
   * nothing to choose from — so the other person's cell fails anyway, and its
   * own tail is then removed by its own failure. What is checked here is
   * something else: the press itself does not clear someone else's batch, and
   * the room is not told it was removed "by the interrupt".
   */
  assert.ok(
    !room.notes().some((note) => /interrupt also dropped/i.test(note)),
    `the press reported on someone else's queue: ${JSON.stringify(room.notes())}`,
  )
})

test('a seminar closed while the kernel was starting does not come back into memory', async () => {
  /*
   * `shutdownSession` removes the runtime, but the kernel start lives out its
   * minute on the captured object — and everything it writes goes through
   * `getSessionDoc`, which creates the document anew. A deleted room came back
   * into memory together with its folder and a history row.
   */
  const { createSession } = await import('../server/src/db.js')
  const { ensureKernel, shutdownSession } = await import('../server/src/kernel/index.js')
  const { dropSessionDoc, getSessionDoc, peekSessionDoc } = await import(
    '../server/src/collab/index.js'
  )
  const id = `gone${seq++}`
  createSession(id, 'Gone')
  getSessionDoc(id)

  const starting = ensureKernel(id)
  // Exactly in this window the owner deletes the seminar.
  await shutdownSession(id)
  dropSessionDoc(id)
  await starting.catch(() => {})
  await wait(400)

  assert.equal(peekSessionDoc(id), null, 'the room came back to life from the start of its own kernel')
})

/* ---------------------------------------------------- taking a run back */

test('a person can take their own cell out of the queue', async () => {
  const { requestRun, cancelRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const mine = createCell('code', 'print("mine")')
  room.doc.transact(() => cells.push([mine]))
  const mineId = mine.get('id') as string

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the kernel never took the first cell')
  requestRun(room.id, [mineId], 'John', 'p_john')
  assert.ok(await until(() => mine.get('state') === 'queued'), 'the second cell never queued')

  assert.equal(cancelRun(room.id, [mineId], 'p_john', false), 1)
  assert.equal(mine.get('state'), 'idle')
  assert.equal(mine.get('runBy'), null, 'a cancelled cell still carried a name')
  swallowExecutes = false
})

test('cancelling never reaches the cell that is running', async () => {
  const { requestRun, cancelRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the cell never started')

  // Her own cell, and she is the host: still not this control's business.
  assert.equal(cancelRun(room.id, [room.cellId], 'p_maria', true), 0)
  assert.equal(room.state(), 'running', 'a run was stopped by the back door')
  swallowExecutes = false
})

test("one student cannot cancel another student's queued cell", async () => {
  const { requestRun, cancelRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const hers = createCell('code', 'print("hers")')
  room.doc.transact(() => cells.push([hers]))
  const hersId = hers.get('id') as string

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the first cell never started')
  requestRun(room.id, [hersId], 'Vera', 'p_vera')
  assert.ok(await until(() => hers.get('state') === 'queued'), 'the second cell never queued')

  assert.equal(cancelRun(room.id, [hersId], 'p_mallory', false), 0, 'a bystander cancelled it')
  assert.equal(hers.get('state'), 'queued')
  // The host can, because somebody has to be able to clear a room's queue.
  assert.equal(cancelRun(room.id, [hersId], 'p_teacher', true), 1)
  assert.equal(hers.get('state'), 'idle')
  swallowExecutes = false
})

test('a cancelled cell does not run when the kernel is free again', async () => {
  const { requestRun, cancelRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const cancelled = createCell('code', 'print("should never run")')
  room.doc.transact(() => cells.push([cancelled]))
  const cancelledId = cancelled.get('id') as string

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the first cell never started')
  requestRun(room.id, [cancelledId], 'John', 'p_john')
  assert.ok(await until(() => cancelled.get('state') === 'queued'), 'never queued')
  cancelRun(room.id, [cancelledId], 'p_john', false)

  swallowExecutes = false
  await interruptSession(room.id)
  await wait(400)
  assert.equal(
    (cancelled.get('outputs') as { length: number }).length,
    0,
    'the cancelled cell ran once the kernel was free',
  )
})

test('a cell deleted while it waited does not stall the ones behind it', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const doomed = createCell('code', 'print("deleted before its turn")')
  const after = createCell('code', 'print("still expects to run")')
  room.doc.transact(() => cells.push([doomed, after]))

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(
    room.id,
    [room.cellId, doomed.get('id') as string, after.get('id') as string],
    'Maria',
    'p_maria',
  )
  assert.ok(await until(() => room.state() === 'running'), 'the first cell never started')
  assert.ok(await until(() => after.get('state') === 'queued'), 'the tail never queued')

  // A student tidies up mid-queue.
  room.doc.transact(() => {
    const index = cells.toArray().findIndex((c) => c.get('id') === doomed.get('id'))
    if (index >= 0) cells.delete(index, 1)
  })

  swallowExecutes = false
  const { interruptSession } = await import('../server/src/kernel/index.js')
  await interruptSession(room.id)
  // Interrupt drops the tail, so ask for the survivor again — the point is that
  // the queue still moves at all, not that it survives an interrupt.
  requestRun(room.id, [after.get('id') as string], 'Maria', 'p_maria')
  assert.ok(
    await until(() => after.get('state') === 'ok', 8000),
    `the cell behind the deleted one ended as ${String(after.get('state'))}`,
  )
})

/* -------------------------------------------------- a run that goes wrong */

/**
 * Run All stops at the first traceback.
 *
 * Thirty cells that each need the one before produce thirty tracebacks, and
 * only the first one says anything. The execute request this server sends has
 * always carried `stop_on_error: true`; the queue in front of it did not, so
 * the room got the wall of red anyway.
 */
async function notebookOf(sources: string[]) {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { createSession } = await import('../server/src/db.js')
  const { getCells, createCell, cellSource } = await import('../shared/notebook.js')
  const id = `batch${seq++}`
  createSession(id, `Batch ${id}`)
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  doc.transact(() => {
    cells.delete(0, cells.length)
    cells.push(sources.map((source) => createCell('code', source)))
  })
  return {
    id,
    doc,
    ids: cells.toArray().map((c) => c.get('id') as string),
    states: () => cells.toArray().map((c) => String(c.get('state'))),
    sources: () => cells.toArray().map((c) => cellSource(c).toString()),
    notes: async () => {
      const { getTerminal } = await import('../shared/notebook.js')
      return getTerminal(doc)
        .toArray()
        .filter((l) => l.get('kind') === 'system')
        .map((l) => String(l.get('text')))
    },
  }
}

test('the cells after a failure are left alone, not run and not marked failed', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await notebookOf(['print("one")', 'RAISE', 'print("three")', 'print("four")'])
  requestRun(room.id, room.ids, 'Maria', 'p_maria')

  assert.ok(await until(() => room.states()[1] === 'error'), `states: ${room.states()}`)
  await wait(500)
  assert.deepEqual(room.states(), ['ok', 'error', 'idle', 'idle'])
})

test('the room is told why the rest did not run', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await notebookOf(['print("one")', 'RAISE', 'print("three")'])
  requestRun(room.id, room.ids, 'Maria', 'p_maria')
  assert.ok(await until(() => room.states()[1] === 'error'))
  await wait(400)
  const notes = await room.notes()
  const said = notes.filter((n) => /did not run|were not run|was not run/.test(n))
  assert.equal(said.length, 1, `expected one explanation, got ${JSON.stringify(notes)}`)
})

test('a failure in the last cell of a run says nothing, because nothing was dropped', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await notebookOf(['print("one")', 'RAISE'])
  requestRun(room.id, room.ids, 'Maria', 'p_maria')
  assert.ok(await until(() => room.states()[1] === 'error'))
  await wait(400)
  const notes = await room.notes()
  assert.deepEqual(
    notes.filter((n) => /not run/.test(n)),
    [],
    'the room was told cells had been dropped when none had',
  )
})

test("somebody else's cell is not dropped by your failure", async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await notebookOf(['RAISE', 'print("johns own")'])
  // Two presses, two people: Maria's run fails, John's has nothing to do with it.
  requestRun(room.id, [room.ids[0]], 'Maria', 'p_maria')
  requestRun(room.id, [room.ids[1]], 'John', 'p_john')

  assert.ok(await until(() => room.states()[1] === 'ok', 8000), `states: ${room.states()}`)
  assert.equal(room.states()[0], 'error')
})

/* ------------------------------- the document, while output is arriving */

/**
 * The room edits the notebook while the kernel writes into it. None of these
 * are exotic: somebody tidies up a cell that is still printing, two people
 * press Clear at the same moment, a student retypes a cell without noticing it
 * is running. What must not happen is a stalled queue or a half-written cell.
 */
test('deleting a cell mid-run does not stall the queue behind it', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const next = createCell('code', 'print("after")')
  room.doc.transact(() => cells.push([next]))

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId, next.get('id') as string], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the first cell never started')

  // Somebody removes the cell that is producing output.
  room.doc.transact(() => {
    const index = cells.toArray().findIndex((c) => (c.get('id') as string) === room.cellId)
    if (index >= 0) cells.delete(index, 1)
  })
  swallowExecutes = false
  shellFinish()

  assert.ok(
    await until(() => next.get('state') === 'ok', 8000),
    `the queue stalled: the next cell is ${String(next.get('state'))}`,
  )
})

test('a deleted cell does not leave the kernel spinning its loop', async () => {
  /*
   * Deletion was in no way tied to execution: the cell disappeared from the
   * document, while `while True` kept spinning until the end of class. There
   * was nothing to stop it with — the "stop" button is drawn on the cell, and
   * the cell is gone — and `meta.runningCell` kept naming its id, that is, the
   * room believed the work was going on.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, getMeta } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the cell did not start')

  room.doc.transact(() => {
    const index = cells.toArray().findIndex((c) => (c.get('id') as string) === room.cellId)
    if (index >= 0) cells.delete(index, 1)
  })
  swallowExecutes = false

  assert.ok(
    await until(() => getMeta(room.doc).get('runningCell') == null),
    'the room still believes the deleted cell is executing',
  )
  assert.ok(
    room.notes().some((note) => /deleted/i.test(note)),
    `nothing was said about the stop: ${JSON.stringify(room.notes())}`,
  )
})

test('clearing keeps what arrives after it, and drops what came before', async () => {
  const { requestRun, clearOutputs } = await import('../server/src/kernel/index.js')
  const { getCells } = await import('../shared/notebook.js')
  const room = await seminar()
  const cell = getCells(room.doc).get(1)
  const text = () =>
    ((cell.get('outputs') as Y.Array<Y.Map<unknown>>).toArray() as Y.Map<unknown>[])
      .map((o) => String((o.get('text') as { toString(): string })?.toString() ?? ''))
      .join('')

  room.type('print("before")')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'))
  // The room marks the cell running before execute() finishes its asynchronous
  // liveness/socket checks. Injecting before the fake receives the request used
  // to silently discard this chunk; a longer output timeout cannot recover it.
  assert.ok(await until(() => held.length > 0), 'the fake did not receive execute_request')
  say('before the clear\n')
  assert.ok(await until(() => /before the clear/.test(text())), 'nothing was written at all')

  clearOutputs(room.id)
  await wait(200)
  assert.equal(text(), '', 'the clear left something behind')

  say('after the clear\n')
  assert.ok(await until(() => /after the clear/.test(text())), 'the run stopped writing')
  assert.ok(!/before the clear/.test(text()), 'the cleared output came back')
  swallowExecutes = false
  shellFinish()
})

test('two clears in the same moment are one clear', async () => {
  const { requestRun, clearOutputs } = await import('../server/src/kernel/index.js')
  const { getCells } = await import('../shared/notebook.js')
  const room = await seminar()
  const cell = getCells(room.doc).get(1)
  room.type('print("hello")')
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'ok'), 'the cell never ran')

  clearOutputs(room.id)
  clearOutputs(room.id)
  await wait(200)
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 0)
  assert.equal(getCells(room.doc).length, 2, 'clearing removed a cell')
})

/* ------------------------------------------------------- the run's clock */

test('the stopwatch starts at the start and stops at the end', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')

  /*
   * The cell is held on purpose, and that is half the point of the test.
   *
   * The fake answers in the same tick, so `running` was almost never seen,
   * and the "starts at the start" check stood under `if (state === 'running')`
   * — that is, it almost never ran: the `startedAt` write in kernel/index.ts
   * could be removed without failing a single assertion. Now the kernel stays
   * silent until the stopwatch has been checked.
   */
  const before = Date.now()
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'running'), 'the cell did not start')
  const at = room.startedAt()
  assert.ok(at !== null, 'a running cell without a start mark')
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, `the mark does not look like now: ${at}`)
  assert.equal(room.ranMs(), null, 'a duration was announced for a cell that is still computing')

  swallowExecutes = false
  shellFinish()
  assert.ok(
    await until(() => room.state() === 'ok'),
    `the cell ended as ${String(room.state())}`,
  )
  // Stopped — otherwise the bar would breathe and the clock would run on a
  // cell that has settled.
  assert.equal(room.startedAt(), null, 'the stopwatch kept running after completion')
  const took = room.ranMs()
  assert.ok(typeof took === 'number' && took >= 0, `the duration was not recorded: ${String(took)}`)
})

test('a queued cell does not start the stopwatch', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const second = createCell('code', 'print("two")')
  room.doc.transact(() => cells.push([second]))
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(room.id, [room.cellId, second.get('id') as string], 'Maria', 'p_maria')
  assert.ok(await until(() => second.get('state') === 'queued'), 'the second one did not join the queue')
  assert.equal(second.get('startedAt'), null, 'the queue started the stopwatch')

  const { interruptSession } = await import('../server/src/kernel/index.js')
  await interruptSession(room.id)
  swallowExecutes = false
})

test('an interrupted cell ends with an error, and it has a time', async () => {
  /*
   * The rule: only outcomes that ended in something get a duration.
   *
   * A live kernel answers SIGINT the same way as any exception: a
   * KeyboardInterrupt in the cell, an `execute_reply` with status error. That
   * is an end, if a bad one — and it has a time. There is one outcome here,
   * and it is checked without an `if`: the old "idle or error" fork accepted
   * both, so a regression in either branch was invisible.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the cell did not start')
  await interruptSession(room.id)
  swallowExecutes = false

  assert.ok(await until(() => room.state() !== 'running'), 'the cell did not stop')
  assert.equal(room.state(), 'error', `interrupt outcome: ${String(room.state())}`)
  assert.equal(room.startedAt(), null, 'the stopwatch kept running after the stop')
  assert.ok(
    typeof room.ranMs() === 'number',
    `the interrupted cell was left without a duration: ${String(room.ranMs())}`,
  )
})

test('a cell removed from the queue does not get a completion time', async () => {
  /*
   * The second half of the same rule, and here is an outcome that must not
   * have a time: a cell the interrupt took out of the queue did not execute
   * for a single millisecond. Printing a duration for it next to an empty
   * `Out [ ]` would announce a result that never appeared.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const second = createCell('code', 'print("two")')
  room.doc.transact(() => cells.push([second]))
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(room.id, [room.cellId, second.get('id') as string], 'Maria', 'p_maria')
  assert.ok(await until(() => second.get('state') === 'queued'), 'the second one did not join the queue')
  await interruptSession(room.id)
  swallowExecutes = false

  assert.ok(await until(() => second.get('state') === 'idle'), 'the second one stayed in the queue')
  assert.equal(second.get('startedAt'), null, 'a cell that never started got a stopwatch')
  assert.equal(second.get('ranMs'), null, 'a cell that never executed acquired a duration')
})

test('a "stop" that misses still stops the work but does not clear the queue', async () => {
  /*
   * The button on a cell is drawn from the document, and the document lags the
   * server by a round trip: by the time the press arrives, the next cell of
   * the same Run All may already be executing. The only dangerous part here
   * was the second branch of `interruptSession` — `dropQueue` clears the queue
   * of the whole room, including other people's batches. Stopping the current
   * work with a press that missed is not dangerous: `stopBatchOf` is limited
   * to the batch of the cell that is executing, and had the press hit its
   * target, it would have removed exactly the same batch.
   *
   * At first the target check stood over the whole function, and a miss did
   * nothing at all: a person pressed "stop", the notebook kept computing, the
   * button stayed silent.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const tail = [createCell('code', 'print("two")'), createCell('code', 'print("three")')]
  room.doc.transact(() => cells.push(tail))
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(
    room.id,
    [room.cellId, tail[0].get('id') as string, tail[1].get('id') as string],
    'Maria',
    'p_maria',
  )
  assert.ok(await until(() => room.state() === 'running'), 'the first one did not start')
  assert.ok(
    await until(() => tail.every((c) => c.get('state') === 'queued')),
    'the tail did not join the queue',
  )

  // Aim at a cell that does not exist in the room at all — the extreme case
  // of a miss.
  await interruptSession(room.id, 'no-such-cell')
  swallowExecutes = false

  assert.ok(await until(() => room.state() !== 'running'), 'the miss did not stop the work')
  assert.ok(
    await until(() => tail.every((c) => c.get('state') === 'idle')),
    'the tail of its own batch was left standing',
  )
})

test('a ghost running cell is cleared by the pass, but a live one is not', async () => {
  /*
   * A tab that was open when the server crashed merges its updates back as
   * they are, and a 'running' from the dead process can survive the reset.
   * Before the animation existed such a cell just stood there quietly; now it
   * would breathe and count seconds until the end of class.
   */
  const { sweepOrphanRuns } = await import('../server/src/kernel/index.js')
  const room = await seminar()

  room.doc.transact(() => {
    room.cell.set('state', 'running')
    room.cell.set('startedAt', Date.now() - 60_000)
  })

  assert.equal(sweepOrphanRuns(room.id), 1)
  assert.equal(room.state(), 'idle')
  assert.equal(room.startedAt(), null)

  // But the pass does not touch a cell that is really running.
  const { requestRun } = await import('../server/src/kernel/index.js')
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the cell did not start')
  // The caller's clock is one window ahead: otherwise the pass would refuse
  // because of the window (ORPHAN_SWEEP_EVERY_MS), not because the cell is
  // really running, and the assertion would become a tautology.
  assert.equal(sweepOrphanRuns(room.id, Date.now() + 3000), 0, 'the pass cleared a running cell')
  assert.equal(room.state(), 'running')

  const { interruptSession } = await import('../server/src/kernel/index.js')
  await interruptSession(room.id)
  swallowExecutes = false
})

test('help from a question mark reaches the cell', async () => {
  /*
   * `print?` printed nothing. IPython puts the answer to such a question into
   * the payload of the execute_reply itself — as a "page" that the real
   * notebook opens at the bottom of the window — and sends nothing over iopub.
   * The server read only the status from this message, so all the help went
   * nowhere: the cell finished in milliseconds and stayed empty, as if the
   * question mark meant nothing.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { readNotebook } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('print?')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(
    await until(() => room.state() === 'ok'),
    `the cell ended as ${String(room.state())}`,
  )

  const outputs = readNotebook(room.doc)[1].outputs
  assert.equal(outputs.length, 1, `outputs: ${outputs.length}, but there should be a single help output`)
  assert.match(JSON.stringify(outputs), /Docstring/, 'the help did not reach the cell')
})

test('an ordinary cell loses nothing from this', async () => {
  // A useful check precisely because help travels in the same message as the
  // status: this is where the ordinary path is easiest to break.
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { readNotebook } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))
  assert.match(JSON.stringify(readNotebook(room.doc)[1].outputs), /print\(1\)/)
})

test('the pass cleans the mirror in meta too, not only the cells', async () => {
  /*
   * The same dead process leaves behind not only the cell state but also its
   * mirror in meta: runningCell, queue and kernelStatus. From them come the
   * "2 queued" chip in the panel, the "Maria — running cell 05" line in the
   * people list and whether the room's Interrupt is drawn enabled. Fixing the
   * cells and leaving the mirror would mean fixing what is visible and
   * leaving what things are computed from.
   */
  const { sweepOrphanRuns } = await import('../server/src/kernel/index.js')
  const { getMeta } = await import('../shared/notebook.js')
  const room = await seminar()
  const meta = getMeta(room.doc)

  room.doc.transact(() => {
    room.cell.set('state', 'running')
    room.cell.set('startedAt', Date.now() - 60_000)
    room.cell.set('stdin', { prompt: 'Имя: ', password: false })
    meta.set('runningCell', room.cellId)
    meta.set('kernelStatus', 'busy')
  })

  assert.equal(sweepOrphanRuns(room.id), 1)
  assert.equal(room.state(), 'idle')
  assert.equal(room.startedAt(), null)
  // An input form with nobody behind it anymore is a field whose "Send" goes
  // into the void.
  assert.equal(room.cell.get('stdin'), null, "the kernel's question stayed on screen")
  assert.equal(meta.get('runningCell'), null, 'the mirror still names a running cell')
  assert.notEqual(meta.get('kernelStatus'), 'busy', 'the kernel is still listed as busy')
})

test("the duration is computed from the server's record, not from the document field", async () => {
  /*
   * `startedAt` lies in the shared document, and anyone in the room writes it —
   * that is how the product works. Computing the duration from it would let
   * any student write "ran for three hours" for the teacher.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')

  // While it computes, we fake the mark in the document, as any tab in the
  // room can.
  await until(() => room.state() === 'running' || room.state() === 'ok')
  room.doc.transact(() => room.cell.set('startedAt', Date.now() - 3 * 60 * 60 * 1000))

  assert.ok(
    await until(() => room.state() === 'ok'),
    `the cell ended as ${String(room.state())}`,
  )
  const took = room.ranMs()
  assert.ok(typeof took === 'number', 'the duration was not recorded')
  assert.ok(took < 60_000, `the fake got into the duration: ${took} ms`)
})

test('a run opens with a single transaction', async () => {
  /*
   * The start of an execution used to be two writes in a row: first the cell
   * fields, then clearing the output. The client got two events — on the first
   * the field observer woke up and the "Out [n]" line disappeared, on the
   * second the body disappeared. Between these frames the area managed to be
   * measured twenty-four pixels shorter, that is, the space for the new output
   * was reserved wrong.
   *
   * The check is silent by nature: split the transactions apart again, and
   * everything keeps working — it just jerks a little more visibly.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))

  const marks: Array<{ outs: number; state: string; exec: unknown }> = []
  const on = () => {
    marks.push({
      outs: (room.cell.get('outputs') as { length: number }).length,
      state: String(room.cell.get('state')),
      exec: room.cell.get('execCount'),
    })
  }
  room.doc.on('afterTransaction', on)
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))
  room.doc.off('afterTransaction', on)

  // Exactly one transaction empties the output, and the same one declares the
  // cell running and removes the number.
  const emptied = marks.filter((m, i) => m.outs === 0 && (i === 0 || marks[i - 1].outs > 0))
  assert.equal(emptied.length, 1, `the output was emptied ${emptied.length} time(s)`)
  assert.equal(emptied[0].state, 'running', 'the clearing and the announcement ended up in different transactions')
  assert.equal(emptied[0].exec, null, 'the number was removed in a different transaction')
})

test('an execution that prints nothing does not keep the previous output', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))
  assert.ok(
    (room.cell.get('outputs') as { length: number }).length > 0,
    'the first run printed nothing',
  )

  // The Jupyter fake answers any code with a stream, except this marker.
  room.type('SILENT')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))
  await wait(150)
  assert.equal(
    (room.cell.get('outputs') as { length: number }).length,
    0,
    'the cell holds the result of an execution that no longer exists',
  )
  assert.notEqual(room.cell.get('execCount'), null, 'the completed execution has no number')
})

test('a restart removes the execution number from all results', async () => {
  /*
   * The exception for the cell the pump is processing covered the number too:
   * after a restart forty results stayed on screen, while the only verifiable
   * fact about them disappeared from all but one — and the freshest cell
   * looked like the only real one.
   *
   * It lives here, not in restart.test.mts: `restartSession` brings a kernel
   * up, and there is none there. The first version of this test went through
   * it, stayed green exactly as long as a container happened to be running
   * nearby, and failed with a sixty-second timeout once it was gone.
   */
  const { requestRun, restartSession } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()

  const second = createCell('code', 'print("two")')
  room.doc.transact(() => getCells(room.doc).push([second]))

  room.type('print(1)')
  requestRun(room.id, [room.cellId, second.get('id') as string], 'Alexander', 'p_1')
  assert.ok(
    await until(() => room.state() === 'ok'),
    `the cell ended as ${String(room.state())}`,
  )
  assert.ok(await until(() => second.get('state') === 'ok'), 'the second one did not run')
  assert.notEqual(room.cell.get('execCount'), null, 'there was no number even before the restart')

  await restartSession(room.id, 'Alexander')

  for (const cell of [room.cell, second]) {
    assert.equal(cell.get('execCount'), null, 'the number survived the kernel restart')
    assert.equal(cell.get('state'), 'idle')
    assert.equal(cell.get('startedAt'), null)
  }
})

test('the ghost pass does not repeat more often than the window', async () => {
  /*
   * There are three reasons for a pass — the heartbeat, a press, a control
   * socket connecting — and after a server restart they come in a batch: five
   * hundred tabs in two seconds, that is, five hundred transactions over all
   * cells of all notebooks of one room exactly when the whole hall is waiting
   * for sync. What the pass needs to fix is what the dead process left behind
   * — it will not go anywhere in two seconds.
   */
  const { sweepOrphanRuns } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  const ghost = () =>
    room.doc.transact(() => {
      room.cell.set('state', 'running')
      room.cell.set('startedAt', Date.now() - 60_000)
    })

  const at = Date.now()
  ghost()
  assert.equal(sweepOrphanRuns(room.id, at), 1)
  assert.equal(room.state(), 'idle')

  // A second socket in the same second does not read the document at all.
  ghost()
  assert.equal(sweepOrphanRuns(room.id, at + 1_999), 0, 'the pass went over the document a second time')
  assert.equal(room.state(), 'running', 'and since it did not, the ghost is still there')

  // The window is over — the ghost is removed.
  assert.equal(sweepOrphanRuns(room.id, at + 2_001), 1)
  assert.equal(room.state(), 'idle')
})

test('editing the sheet restarts the attempt instead of hitting "already in the queue"', async () => {
  /*
   * In a lecture there is one queue, waiting a minute is normal, and an edit
   * in that time is normal too. The waiting record used to be untouchable: a
   * student who fixed the sheet got "this attempt is already in the queue —
   * 37th" and could not run the NEW version until the kernel finished the old
   * one — and by then its output was thrown away as late anyway (council.ts ·
   * recordRun). What should be computed is what the person sees on the
   * screen.
   *
   * The place in the queue stays the same: nobody is sent to the tail for
   * fixing a typo.
   */
  const { requestRun, requestCouncilRun, councilQueuePositions, cancelCouncilRun, interruptSession } =
    await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Ада', 'p_t')
  assert.ok(await until(() => room.state() === 'running'), 'the cell did not start')

  const first: (string | null)[] = []
  const second: (string | null)[] = []
  const press = (source: string, seen: (string | null)[]) =>
    requestCouncilRun(
      room.id,
      {
        cellId: room.cellId,
        participantId: 'p_1',
        source,
        by: 'author',
        limitSec: null,
        onChange: (run) => seen.push(run?.state ?? null),
      },
      'Ада',
      'p_1',
    )

  assert.deepEqual(press('print(1)', first), { queued: true, position: 2 })
  assert.deepEqual(first, ['queued'])

  // The same thing a second time is a second press, not a different run.
  assert.deepEqual(press('print(1)', second), { queued: false, position: 2 })
  assert.deepEqual(second, [], 'a frame went out on the second press after all')

  // Different text is a different run: the record is replaced in place.
  assert.deepEqual(press('print(2)', second), { queued: true, position: 2 })
  assert.deepEqual(second, ['queued'], 'the new text was not told it is in the queue')
  assert.deepEqual(first, ['queued'], 'the previous task got an extra word')
  assert.deepEqual(
    councilQueuePositions(room.id),
    [{ cellId: room.cellId, participantId: 'p_1', position: 2 }],
    'the substitution created a second record instead of replacing',
  )

  // A removed attempt tells its own task "there was no run" — and only that
  // task.
  assert.ok(cancelCouncilRun(room.id, room.cellId, 'p_1'))
  assert.deepEqual(second, ['queued', null])
  assert.deepEqual(first, ['queued'])
  assert.deepEqual(councilQueuePositions(room.id), [])

  swallowExecutes = false
  await interruptSession(room.id)
  assert.ok(await until(() => room.state() !== 'running'), 'the cell did not stop')
})

test('council queue numbers are computed in one pass and match the one-by-one count', async () => {
  /*
   * `tellQueued` sends a new number to everyone waiting on every shift of the
   * queue, and the number used to be computed by searching the whole queue —
   * with five hundred attempts that is a quarter of a million comparisons per
   * completion. The bulk count must give exactly the same as the one-by-one
   * count, otherwise a student sees one number and their neighbour another.
   */
  const {
    requestRun,
    requestCouncilRun,
    councilQueuePosition,
    councilQueuePositions,
    cancelCouncilRun,
    interruptSession,
  } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Ада', 'p_t')
  assert.ok(await until(() => room.state() === 'running'), 'the cell did not start')

  const attempt = (participantId: string) =>
    requestCouncilRun(
      room.id,
      {
        cellId: room.cellId,
        participantId,
        source: `print("${participantId}")`,
        by: 'host',
        limitSec: null,
        onChange: () => {},
      },
      'Ада',
      'p_t',
    )

  // Counting the one occupying the kernel right now.
  assert.equal(attempt('p_1').position, 2)
  assert.equal(attempt('p_2').position, 3)

  const bulk = councilQueuePositions(room.id)
  assert.deepEqual(bulk, [
    { cellId: room.cellId, participantId: 'p_1', position: 2 },
    { cellId: room.cellId, participantId: 'p_2', position: 3 },
  ])
  for (const one of bulk) {
    assert.equal(
      councilQueuePosition(room.id, one.cellId, one.participantId),
      one.position,
      `the bulk count disagreed with the one-by-one count for ${one.participantId}`,
    )
  }

  // An attempt leaving from the middle of the queue moves those behind it.
  assert.ok(cancelCouncilRun(room.id, room.cellId, 'p_1'), 'the attempt was not removed')
  assert.deepEqual(
    councilQueuePositions(room.id),
    [{ cellId: room.cellId, participantId: 'p_2', position: 2 }],
    "the neighbour's number did not move",
  )

  cancelCouncilRun(room.id, room.cellId, 'p_2')
  swallowExecutes = false
  await interruptSession(room.id)
  assert.ok(await until(() => room.state() !== 'running'), 'the cell did not stop')
})

test("banning a participant stops their current attempt and keeps everyone else's queue", async () => {
  const { requestCouncilRun } = await import('../server/src/kernel/index.js')
  const { purgeCouncilOf } = await import('../server/src/control.js')
  const { saveDraft } = await import('../server/src/council.js')
  const room = await seminar()
  swallowExecutes = true
  const offender: (string | null)[] = []
  const neighbour: (string | null)[] = []
  saveDraft(room.id, room.cellId, 'offender', 'while True: pass', Date.now())

  requestCouncilRun(room.id, {
    cellId: room.cellId,
    participantId: 'offender',
    source: 'while True: pass',
    by: 'author',
    limitSec: null,
    onChange: (run) => offender.push(run?.state ?? null),
  }, 'Нарушитель', 'offender')
  requestCouncilRun(room.id, {
    cellId: room.cellId,
    participantId: 'neighbour',
    source: 'print(2)',
    by: 'author',
    limitSec: null,
    onChange: (run) => neighbour.push(run?.state ?? null),
  }, 'Сосед', 'neighbour')
  assert.ok(await until(() => offender.includes('running')), "the offender's attempt did not start")
  assert.ok(
    await until(() => held.length > 0 && requests.at(-1)?.silent === true),
    'the service namespace snapshot did not start',
  )
  shellFinish()
  assert.ok(
    await until(() => held.length > 0 && requests.at(-1)?.silent === false),
    "the offender's code did not reach the kernel",
  )

  swallowExecutes = false
  assert.equal(purgeCouncilOf(room.id, 'offender'), 1)
  assert.ok(await until(() => neighbour.includes('ok')), 'the queue of the others did not continue after the stop')
  assert.deepEqual(offender.slice(0, 2), ['queued', 'running'])
  assert.equal(offender.at(-1), 'error')
  assert.deepEqual(neighbour, ['queued', 'running', 'ok'])
})

test('banning another participant removes only their queue and does not interrupt the current attempt', async () => {
  const { councilQueuePositions, requestCouncilRun } =
    await import('../server/src/kernel/index.js')
  const { purgeCouncilOf } = await import('../server/src/control.js')
  const { saveDraft } = await import('../server/src/council.js')
  const room = await seminar()
  swallowExecutes = true
  const running: (string | null)[] = []
  const removed: (string | null)[] = []
  saveDraft(room.id, room.cellId, 'offline-offender', 'print(1)', Date.now())

  requestCouncilRun(room.id, {
    cellId: room.cellId,
    participantId: 'running-neighbour',
    source: 'while True: pass',
    by: 'author',
    limitSec: null,
    onChange: (run) => running.push(run?.state ?? null),
  }, 'Сосед', 'running-neighbour')
  requestCouncilRun(room.id, {
    cellId: room.cellId,
    participantId: 'offline-offender',
    source: 'print(1)',
    by: 'author',
    limitSec: null,
    onChange: (run) => removed.push(run?.state ?? null),
  }, 'Ушедший', 'offline-offender')
  assert.ok(await until(() => running.includes('running')), 'the other attempt did not start')
  assert.ok(
    await until(() => held.length > 0 && requests.at(-1)?.silent === true),
    'the service namespace snapshot did not start',
  )
  shellFinish()
  assert.ok(
    await until(() => held.length > 0 && requests.at(-1)?.silent === false),
    'the code of the current attempt did not reach the kernel',
  )

  assert.equal(purgeCouncilOf(room.id, 'offline-offender'), 1)
  assert.deepEqual(removed, ['queued', null])
  assert.deepEqual(running, ['queued', 'running'], "the current attempt got the interrupt of someone else's ban")
  assert.deepEqual(councilQueuePositions(room.id), [])

  swallowExecutes = false
  await (await import('../server/src/kernel/index.js')).interruptSession(room.id)
  assert.ok(await until(() => running.at(-1) === 'error'), 'the test attempt did not finish')
})

test('a late ban interrupt does not hit the next author', async () => {
  const { requestCouncilRun } = await import('../server/src/kernel/index.js')
  const { purgeCouncilOf } = await import('../server/src/control.js')
  const { saveDraft } = await import('../server/src/council.js')
  const room = await seminar()
  swallowExecutes = true
  const offender: (string | null)[] = []
  const neighbour: (string | null)[] = []
  saveDraft(room.id, room.cellId, 'late-offender', 'while True: pass', Date.now())

  requestCouncilRun(room.id, {
    cellId: room.cellId,
    participantId: 'late-offender',
    source: 'while True: pass',
    by: 'author',
    limitSec: null,
    onChange: (run) => offender.push(run?.state ?? null),
  }, 'Нарушитель', 'late-offender')
  requestCouncilRun(room.id, {
    cellId: room.cellId,
    participantId: 'next-author',
    source: 'print(2)',
    by: 'author',
    limitSec: null,
    onChange: (run) => neighbour.push(run?.state ?? null),
  }, 'Следующий', 'next-author')
  assert.ok(await until(() => offender.includes('running')))
  assert.ok(await until(() => held.length > 0 && requests.at(-1)?.silent === true))
  shellFinish()
  assert.ok(await until(() => held.length > 0 && requests.at(-1)?.silent === false))

  holdInterrupts = true
  assert.equal(purgeCouncilOf(room.id, 'late-offender'), 1)
  assert.ok(await until(() => pendingInterrupts.length === 1), 'the interrupt did not reach the server')

  // The offender manages to finish on their own while the HTTP answer to the
  // interrupt is held back.
  shellFinish()
  assert.ok(await until(() => held.length > 0 && requests.at(-1)?.silent === true))
  shellFinish()
  await wait(50)
  assert.deepEqual(neighbour, ['queued'], 'the queue let the next one in under the late SIGINT')

  swallowExecutes = false
  holdInterrupts = false
  for (const finish of pendingInterrupts.splice(0)) finish()
  assert.ok(await until(() => neighbour.at(-1) === 'ok'), 'the next attempt did not continue')
})

/*
 * Completion goes to the kernel past the execution queue — and that is the
 * main thing to know about it. The room's queue is shared: a hint standing in
 * it behind someone else's cell would arrive a minute later, that is, not at
 * all.
 */
test('the kernel answers complete and inspect by a separate path, without the execution queue', async () => {
  const { JupyterKernel, defaultEndpoint } = await import('../server/src/kernel/jupyter.js')
  const kernel = await JupyterKernel.connect('complete-ok', defaultEndpoint())
  try {
    const done = await kernel.complete('df.', 3)
    assert.deepEqual(done.matches, [
      { text: 'df.head', type: 'function' },
      { text: 'df.describe', type: 'function' },
    ])
    assert.equal(done.cursorStart, 3)
    assert.equal(done.cursorEnd, 3)

    const help = await kernel.inspect('df.head', 7)
    assert.equal(help.found, true)
    // The colouring is stripped: in a hint above the caret ANSI reads as junk.
    assert.equal(help.text, 'Signature: df.head(n=5)')
  } finally {
    await kernel.dispose()
  }
})

test('a hint does not make the kernel busy: its busy/idle is not the room phase', async () => {
  const { JupyterKernel, defaultEndpoint } = await import('../server/src/kernel/jupyter.js')
  const kernel = await JupyterKernel.connect('complete-quiet', defaultEndpoint())
  try {
    // First an ordinary cell: after it the phase is an honest idle.
    await kernel.execute('1 + 1', {
      onExecuteInput: () => {}, onStream: () => {}, onData: () => {}, onError: () => {}, onClear: () => {},
    })
    assert.equal(kernel.phase, 'idle')
    const seen: string[] = []
    kernel.onPhaseChange((phase) => seen.push(phase))
    await kernel.complete('df.', 3)
    await kernel.inspect('df.head', 7)
    // The fake sends the statuses right after the answer; let them arrive.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(seen, [], `the indicator blinked on a hint: ${seen.join(' → ')}`)
    assert.equal(kernel.phase, 'idle')
  } finally {
    await kernel.dispose()
  }
})

test('a busy kernel does not answer a completion — and the promise rejects on timeout', async () => {
  const { JupyterKernel, defaultEndpoint } = await import('../server/src/kernel/jupyter.js')
  const kernel = await JupyterKernel.connect('complete-timeout', defaultEndpoint())
  swallowShell = true
  try {
    const started = Date.now()
    await assert.rejects(kernel.complete('df.', 3), /timed out/)
    /*
     * Not instantly and not "until we get bored": two and a half seconds is
     * the ceiling written in SHELL_REQUEST_MS. The lower bound allows for node
     * timers waking up no earlier, but also not exactly on time.
     */
    const spent = Date.now() - started
    assert.ok(spent >= 2000 && spent < 6000, `the refusal came after ${spent} ms`)
  } finally {
    swallowShell = false
    await kernel.dispose()
  }
})

/*
 * Help about what is under the caret — and its second path.
 *
 * A live kernel knows only what was EXECUTED in it: until the
 * `import seaborn as sns` cell has been run, `inspect_request` honestly
 * answers "not found". In class this read as "help appears every other
 * time", and half of the complaints were about exactly that. The second path
 * asks jedi from the sources — with a real `execute_request`, silently and
 * with an alarm inside Python.
 *
 * What is checked here breaks quietly: a refusal reason instead of silence,
 * the order of the two paths and — most importantly — that the service run is
 * not visible to the room.
 */
test('help about a name that was not executed comes from static parsing', async () => {
  const { ensureKernel, inspectIn } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  await ensureKernel(room.id)
  assert.ok(await until(() => room.status() === 'idle'), 'the kernel did not come up')

  // A name the kernel knows: it answers itself, and the second path is not
  // needed at all.
  const known = await inspectIn(room.id, 'df.head', 7)
  assert.equal(known.found, true)
  assert.equal(known.text, 'Signature: df.head(n=5)')
  assert.equal(known.reason, null)

  const before = requests.length
  // But this name the kernel does not know (the fake answers found: false),
  // and then jedi is asked — together with the import header of the same
  // notebook.
  const missing = await inspectIn(room.id, 'NOTFOUND.lmplot', 15, CELLS_KEY, {
    header: 'import seaborn as sns',
  })
  assert.equal(missing.found, true, `the second path did not answer: ${missing.reason}`)
  assert.match(missing.text ?? '', /^Signature:\nsns\.lmplot\(data\)/)

  const service = requests.slice(before)
  assert.equal(service.length, 1, 'static parsing went out as more than one request')
  // Silently and without a trace: no output to the room, no line in `In`/`Out`.
  assert.equal(service[0].silent, true)
  assert.equal(service[0].store_history, false)
  assert.match(service[0].code, /_colloq_inspect/)
  assert.match(service[0].code, /import seaborn as sns/, 'the import header did not arrive')
})

test('the service help request does not move the kernel phase: the indicator does not blink', async () => {
  const { ensureKernel, inspectIn } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  await ensureKernel(room.id)
  assert.ok(await until(() => room.status() === 'idle'))

  /*
   * ipykernel publishes `busy`/`idle` statuses around ANY request, including
   * our service `execute_request`. While they were taken for the phase, the
   * kernel indicator would blink for the whole room on every mouse hover — the
   * same trouble commit 37fce13 closed for `complete_request`.
   */
  const { getMeta } = await import('../shared/notebook.js')
  const meta = getMeta(room.doc)
  const seen: string[] = []
  // An observer, not polling: a blink lasts milliseconds, and polling would
  // not catch it — that is, the test would be green with a broken indicator.
  const watch = () => seen.push(String(meta.get('kernelStatus')))
  meta.observe(watch)
  try {
    const answer = await inspectIn(room.id, 'NOTFOUND.lmplot', 15)
    assert.equal(answer.found, true)
    await wait(80)
    assert.deepEqual(seen, [], `the indicator blinked on help: ${seen.join(' → ')}`)
    assert.equal(room.status(), 'idle')
  } finally {
    meta.unobserve(watch)
  }
})

test('a busy kernel is not asked for help at all — the refusal comes at once', async () => {
  const { ensureKernel, inspectIn, requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  await ensureKernel(room.id)
  assert.ok(await until(() => room.status() === 'idle'))
  room.type('print(1)')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Student', 'p_student')
  try {
    assert.ok(await until(() => room.state() === 'running'), 'the cell did not start computing')
    const started = Date.now()
    const answer = await inspectIn(room.id, 'df.head', 7)
    const spent = Date.now() - started
    assert.equal(answer.found, false)
    assert.equal(answer.reason, 'busy')
    /*
     * At once means under a second. There is no point waiting for its two and
     * a half (SHELL_REQUEST_MS): the server already knows a cell is computing
     * in this notebook, and silence on a mouse hover reads as breakage.
     */
    assert.ok(spent < 1000, `the "busy" refusal waited ${spent} ms`)
  } finally {
    swallowExecutes = false
    shellFinish()
  }
})

/*
 * The kernel badge must go through "not started → starting → ready" WITHOUT a
 * single Run — on one hover for help.
 *
 * From the class of 20 Sep 2026: "I hover — it says the kernel is starting,
 * the help appears, but the kernel status is still starting". The kernel did
 * come up and answer meanwhile; it was the badge that lied. This pins down the
 * server half: a start by hover brings the SCOPE's state to idle. (The other
 * half was on the client — state boxes created inside a derived value; it is
 * pinned down by reading in kernel-books-craft.)
 */
test('help brings the kernel up and takes its state to "ready" without Run', async () => {
  const { inspectIn } = await import('../server/src/kernel/index.js')
  const { bookKernel, CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  const state = () => bookKernel(room.doc, CELLS_KEY).status

  // The room has just been opened: there is no kernel and nobody brings it up.
  assert.equal(state(), 'off', `a fresh room shows ${state()}`)

  // The first hover brings the kernel up and honestly says there is no answer
  // yet.
  const first = await inspectIn(room.id, 'df.head', 7, CELLS_KEY, { mayWake: true })
  assert.equal(first.found, false)
  assert.equal(first.reason, 'starting')

  // And it takes the state all the way — by itself, without a single cell run.
  assert.ok(await until(() => state() === 'idle'), `the state got stuck at ${state()}`)
  const second = await inspectIn(room.id, 'df.head', 7, CELLS_KEY, { mayWake: true })
  assert.equal(second.found, true, `the second question got no answer: ${second.reason}`)
  assert.equal(room.state(), 'idle', 'the cell computed something although Run was not pressed')
})

test('without the right to run, help does not bring the kernel up', async () => {
  const { inspectIn } = await import('../server/src/kernel/index.js')
  const { bookKernel, CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  /*
   * The right to wake is the right to press Run, and it has already been
   * checked at the door (control.ts · mayWake): a ready "yes" or "no" arrives
   * here. This pins down the consequence: on "no" no kernel appears.
   * control-complete answers for the words about it — where the right is
   * computed.
   */
  await inspectIn(room.id, 'df.head', 7, CELLS_KEY, { mayWake: false })
  await wait(300)
  assert.equal(bookKernel(room.doc, CELLS_KEY).status, 'off', 'the kernel was brought up without the right')
})

test('the value line does not wake the kernel and stays silent when there is none', async () => {
  const { briefIn } = await import('../server/src/kernel/index.js')
  const { bookKernel, CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  /*
   * About a variable there is either an instant answer or silence. Bringing a
   * kernel up for it is pointless: before the first run the variable does not
   * exist, and a fresh kernel would answer the same — nothing.
   */
  assert.equal(await briefIn(room.id, 'apartments', CELLS_KEY), null)
  await wait(300)
  assert.equal(bookKernel(room.doc, CELLS_KEY).status, 'off', 'the value line brought the kernel up')
})

test('the value line goes quietly and does not move the kernel indicator', async () => {
  const { briefIn, ensureKernel } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY, getMeta } = await import('../shared/notebook.js')
  const room = await seminar()
  await ensureKernel(room.id, CELLS_KEY)
  assert.ok(await until(() => room.status() === 'idle'))

  const before = requests.length
  const meta = getMeta(room.doc)
  const seen: string[] = []
  const watch = () => seen.push(String(meta.get('kernelStatus')))
  meta.observe(watch)
  try {
    const said = await briefIn(room.id, 'apartments', CELLS_KEY)
    assert.deepEqual(said, { type: 'DataFrame', dims: '1460 × 81' })
    await wait(80)
    assert.deepEqual(seen, [], `the indicator blinked on the value line: ${seen.join(' → ')}`)
  } finally {
    meta.unobserve(watch)
  }
  const service = requests.slice(before)
  assert.equal(service.length, 1, 'the value question went out as more than one request')
  assert.equal(service[0].silent, true)
  assert.equal(service[0].store_history, false)
  assert.match(service[0].code, /\.brief\(globals\(\)/)
})

test('a busy kernel is not asked about a value at all', async () => {
  const { briefIn, ensureKernel, requestRun } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  await ensureKernel(room.id, CELLS_KEY)
  assert.ok(await until(() => room.status() === 'idle'))
  room.type('HOLD long')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  assert.ok(await until(() => room.state() === 'running'))
  try {
    const before = requests.length
    const started = Date.now()
    assert.equal(await briefIn(room.id, 'apartments', CELLS_KEY), null)
    // No frame and no waiting: there will be no answer, and there is no reason
    // to wait for it.
    assert.equal(requests.length, before, 'the busy kernel was asked a question after all')
    assert.ok(Date.now() - started < 200, 'the busy kernel was waited for')
  } finally {
    assert.equal(finishHeld(/HOLD/), 1)
    assert.ok(await until(() => room.state() === 'ok'))
  }
})

test('a live kernel answer about a module is extended with the package name and a link', async () => {
  const { ensureKernel, inspectIn } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  await ensureKernel(room.id, CELLS_KEY)
  assert.ok(await until(() => room.status() === 'idle'))

  const before = requests.length
  const answer = await inspectIn(room.id, 'MODULE sns', 10, CELLS_KEY)
  assert.equal(answer.found, true)
  /*
   * `Type: module` from IPython is the kind, the object's memory address and
   * "no documentation": seaborn really has none. Everything about the PACKAGE
   * is written next to it on disk, and one quiet question is enough for the
   * help to stop being useless.
   */
  assert.match(answer.text ?? '', /^Module: seaborn\n/)
  assert.match(answer.text ?? '', /Package: seaborn 0\.13\.2/)
  assert.match(answer.text ?? '', /Docs: http:\/\/seaborn\.pydata\.org/)
  // The memory address and the path inside the container do not reach the room.
  assert.doesNotMatch(answer.text ?? '', /String form:/)
  assert.doesNotMatch(answer.text ?? '', /__init__\.py/)

  const service = requests.slice(before)
  assert.equal(service.length, 1, 'the addition went out as more than one request')
  assert.equal(service[0].silent, true)
  assert.equal(service[0].store_history, false)
  assert.match(service[0].code, /\.facts\(globals\(\)/)
})

test('help in the second notebook goes to ITS kernel and does not wait for the busy first one', async () => {
  const { ensureKernel, inspectIn, requestRun } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room, 'Справка.ipynb')
  await ensureKernel(room.id, CELLS_KEY)
  await ensureKernel(room.id, other.root)
  assert.ok(await until(() => room.status() === 'idle'), 'the lecture kernel did not come up')

  // The lecture computes and does not finish until it is released by name.
  room.type('HOLD lecture')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  assert.ok(await until(() => room.state() === 'running'), 'the lecture did not start working')
  try {
    /*
     * The main assertion: the NEIGHBOURING notebook being busy does not get in
     * the way of help.
     *
     * The notebooks have different kernels and different queues, and "busy"
     * must be computed from the scope of the notebook the mouse is hovering
     * in. While busyness was asked of the class, help in a student's personal
     * notebook stayed silent for the whole lecture — and it looked exactly
     * like "it does not always appear", which is what this whole change was
     * made for.
     */
    const here = await inspectIn(room.id, 'df.head', 7, other.root)
    assert.equal(here.found, true, `the second notebook got a refusal: ${here.reason}`)
    assert.equal(here.reason, null)
    assert.equal(here.text, 'Signature: df.head(n=5)')

    // And in the notebook that is computing — an honest "busy".
    const busy = await inspectIn(room.id, 'df.head', 7, CELLS_KEY)
    assert.equal(busy.found, false)
    assert.equal(busy.reason, 'busy')
  } finally {
    assert.equal(finishHeld(/HOLD/), 1)
    assert.ok(await until(() => room.state() === 'ok'))
  }
})

test('a kernel restart drops a pending completion too, not only an execution', async () => {
  const { JupyterKernel, defaultEndpoint } = await import('../server/src/kernel/jupyter.js')
  const kernel = await JupyterKernel.connect('complete-restart', defaultEndpoint())
  swallowShell = true
  try {
    /*
     * The rejection expectation is set up BEFORE the restart: `restart` drops
     * what is pending in the same move it announces the phase with, that is,
     * in the same event loop task — and a promise nobody is attached to yet
     * would manage to become an unhandled rejection and bring down the whole
     * file.
     */
    const asking = assert.rejects(kernel.complete('df.', 3), /kernel/i)
    /*
     * The process behind the socket changes, and a question asked of the old
     * one will never be answered. Without this the promise would sit out its
     * two and a half seconds for nothing — and `dispose` would leave it
     * hanging forever.
     */
    await kernel.restart()
    await asking
  } finally {
    swallowShell = false
    await kernel.dispose()
  }
})

test('while a cell is writing output, the room is not evicted from memory', async () => {
  /*
   * An empty room is evicted after ten minutes, and eviction destroys the
   * `Y.Doc`. `OutputWriter` takes the document in its constructor and writes
   * into THIS object until the end of the execution — nobody sees writes into
   * a destroyed one, silently. While the writer is alive, the room is held
   * (kernel/index.ts · dropWriter → holdRoom).
   *
   * Last in the file: the pass evicts ALL empty rooms, including the ones the
   * tests above created.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { sweepIdleRooms } = await import('../server/src/collab/index.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_2')
  assert.ok(await until(() => room.state() === 'running'), 'the cell did not start')

  // Everyone closed their laptops an hour ago, and the cell is still computing.
  const hour = Date.now() + 60 * 60 * 1000
  assert.ok(!sweepIdleRooms(hour).includes(room.id), 'the room was evicted from under the writer')

  swallowExecutes = false
  await interruptSession(room.id)
  assert.ok(await until(() => room.state() !== 'running'), 'the cell did not stop')

  // The writer let go — and the room became an ordinary empty room.
  assert.ok(sweepIdleRooms(hour).includes(room.id), 'the room stayed held forever')
})

/* ------------------------------------------------------ notebook = kernel */

/**
 * A second notebook in the same room — with a cell of its own.
 *
 * Its root is `nb:…`, not `cells`: `cells` goes only to the first one and only
 * while the room has created none (shared/notebook.ts · rootForNewBook), and
 * `seminar()` above has already opened the room, that is, a notebook is
 * already assigned to it.
 */
async function secondBook(room: Awaited<ReturnType<typeof seminar>>, path = 'Семинар.ipynb') {
  const { addBook, bookCells, cellSource, createCell } = await import('../shared/notebook.js')
  const book = addBook(room.doc, path)
  const cell = createCell('code', '')
  bookCells(room.doc, book.root).push([cell])
  return {
    path,
    root: book.root,
    cell,
    id: cell.get('id') as string,
    type: (source: string) => {
      const text = cellSource(cell)
      text.delete(0, text.length)
      text.insert(0, source)
    },
    state: () => cell.get('state'),
    execCount: () => cell.get('execCount') as number | null,
  }
}

test('two notebooks — two kernels: their variables and queues are separate', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { jupyterSessionPath } = await import('../server/src/kernel/jupyter.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room)

  room.type('HOLD lecture')
  other.type('print("seminar")')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  assert.ok(await until(() => room.state() === 'running'), 'the lecture did not start working')

  /*
   * The main assertion of the whole change: while the lecture computes, the
   * seminar IS COMPUTED instead of standing in the queue behind it. Before
   * this step there was one kernel and one pump per room, and the second
   * notebook would have waited for the first one to finish.
   */
  requestRun(room.id, [other.id], 'Student', 'p_student', undefined, other.root)
  assert.ok(await until(() => other.state() === 'ok'), 'the seminar did not finish computing while the lecture was busy')
  assert.equal(room.state(), 'running', 'another kernel released the lecture')

  // Two kernels are two Jupyter SESSIONS, one per path; the path is the key.
  assert.ok(byPath.has(jupyterSessionPath(room.id, CELLS_KEY)), [...byPath.keys()].join(', '))
  assert.ok(byPath.has(jupyterSessionPath(room.id, other.root)), [...byPath.keys()].join(', '))
  assert.notEqual(
    byPath.get(jupyterSessionPath(room.id, CELLS_KEY)),
    byPath.get(jupyterSessionPath(room.id, other.root)),
    'both notebooks ended up in one kernel',
  )

  assert.equal(finishHeld(/HOLD/), 1)
  assert.ok(await until(() => room.state() === 'ok'))
})

test('the session path of the room notebook is unchanged, and a rollout does not start a second kernel for it', async () => {
  const { jupyterSessionPath, jupyterSessionName } = await import('../server/src/kernel/jupyter.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  /*
   * A room that is running right now must find ITS OWN live kernel after the
   * server is updated. Jupyter sessions are identified by path, so the path of
   * the `cells` notebook is the whole of backward compatibility, in one line.
   */
  assert.equal(jupyterSessionPath('r1', CELLS_KEY), 'r1/session.ipynb')
  assert.equal(jupyterSessionName('r1', CELLS_KEY), 'r1')
  // The others have their own path — without the colon the `nb:` root brings.
  assert.equal(jupyterSessionPath('r1', 'nb:b_abc12345'), 'r1/session-nb-b_abc12345.ipynb')
  assert.equal(jupyterSessionName('r1', 'nb:b_abc12345'), 'r1#nb:b_abc12345')
})

test('restarting one notebook does not touch the neighbouring one', async () => {
  const { requestRun, restartSession } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room)
  room.type('print("lecture")')
  other.type('print("seminar")')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  assert.ok(await until(() => room.state() === 'ok'))
  requestRun(room.id, [other.id], 'Student', 'p_student', undefined, other.root)
  assert.ok(await until(() => other.state() === 'ok'))
  const lectureRun = room.cell.get('execCount') as number | null
  assert.ok(lectureRun !== null, 'the execution number of the lecture was not recorded')

  await restartSession(room.id, 'Аким', other.root)
  /*
   * A restart takes away the execution numbers of ITS OWN notebook — it has
   * no variables anymore, and `Out [7]` over the old output would lie. The
   * neighbouring notebook was not touched: its process is alive, and there is
   * no reason to declare its results invalid.
   */
  assert.equal(other.execCount(), null, 'the execution number stayed in the restarted notebook')
  assert.equal(room.cell.get('execCount'), lectureRun, 'the restart reset the neighbouring notebook')
  assert.equal(room.state(), 'ok')
})

test('kernel state is kept per notebook, and the room notebook is also mirrored into the old keys', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { bookKernel, CELLS_KEY, getMeta } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room)
  room.type('print("lecture")')
  other.type('HOLD seminar')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  assert.ok(await until(() => room.state() === 'ok'))
  requestRun(room.id, [other.id], 'Student', 'p_student', undefined, other.root)
  assert.ok(await until(() => bookKernel(room.doc, other.root).runningCell === other.id))

  const meta = getMeta(room.doc)
  // The mirror is exactly the room notebook: it is free, and an old tab sees
  // that.
  assert.equal(meta.get('runningCell'), null, "the mirror showed another notebook's running cell")
  assert.equal(bookKernel(room.doc, CELLS_KEY).runningCell, null)
  assert.equal(meta.get('kernelStatus'), bookKernel(room.doc, CELLS_KEY).status)
  assert.equal(bookKernel(room.doc, other.root).status, 'busy')

  assert.equal(finishHeld(/HOLD/), 1)
  assert.ok(await until(() => other.state() === 'ok'))

  /*
   * And the queue: cells waiting in the SEMINAR do not get into the mirror.
   *
   * The mirror is read by a tab opened before the rollout, and the "2 in the
   * queue" chip is counted from it too. Showing another notebook's queue in it
   * would mean telling the lecture its kernel is busy when it is free.
   */
  other.type('HOLD again')
  requestRun(room.id, [other.id], 'Student', 'p_student', undefined, other.root)
  assert.ok(await until(() => bookKernel(room.doc, other.root).runningCell === other.id))
  const second = await secondBook(room, 'Ещё.ipynb')
  second.type('HOLD queued')
  requestRun(room.id, [second.id], 'Student', 'p_student', undefined, second.root)
  assert.ok(await until(() => second.state() === 'running'), 'the third notebook did not start working')
  assert.deepEqual(bookKernel(room.doc, CELLS_KEY).queue, [], "another notebook's queue got into the mirror")
  const legacy = meta.get('queue')
  assert.equal(legacy === undefined || (legacy as { length: number }).length, 0)
  assert.equal(finishHeld(/HOLD/), 2)
})

test('shutdownSession stops the KERNELS OF ALL the class notebooks, not one', async () => {
  const { requestRun, shutdownSession, kernelCensus } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room)
  room.type('print("lecture")')
  other.type('print("seminar")')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  requestRun(room.id, [other.id], 'Student', 'p_student', undefined, other.root)
  assert.ok(await until(() => room.state() === 'ok' && other.state() === 'ok'))
  const before = kernelCensus().live
  assert.ok(before >= 2, `the census did not see both kernels: ${before}`)

  await shutdownSession(room.id)
  /*
   * Leaving even one would mean leaving a process that writes output into the
   * document of a room that no longer exists — and that `getSessionDoc` would
   * recreate together with the folder and a history row.
   */
  assert.equal(kernelCensus().live, before - 2, 'a live kernel remained after the class ended')
})

test('the personal kernel ceiling refuses in words, not with silence', async () => {
  const { ensureKernel } = await import('../server/src/kernel/index.js')
  const { setRules, storedRules } = await import('../server/src/db.js')
  const room = await seminar()
  const first = await secondBook(room, 'Аким.ipynb')
  const second = await secondBook(room, 'Борис.ipynb')
  setRules(room.id, {
    ...storedRules(room.id),
    books: {
      [first.root]: { access: 'owner', owner: 'p_akim', ownerName: 'Аким' },
      [second.root]: { access: 'owner', owner: 'p_boris', ownerName: 'Борис' },
    },
  })
  const previous = process.env.KERNEL_OWN_MAX
  process.env.KERNEL_OWN_MAX = '1'
  try {
    await ensureKernel(room.id, first.root)
    /*
     * A second personal kernel over the ceiling is a refusal with a number and
     * advice, not a container that fell over at the process limit in the
     * middle of class together with everyone else's work.
     */
    await assert.rejects(
      ensureKernel(room.id, second.root),
      /1|закройте|close/,
      'the personal kernel ceiling did not kick in',
    )
  } finally {
    if (previous === undefined) delete process.env.KERNEL_OWN_MAX
    else process.env.KERNEL_OWN_MAX = previous
  }
})

test('changing access to a notebook stops its kernel — and says so', async () => {
  const { requestRun, syncBookKernels } = await import('../server/src/kernel/index.js')
  const { setRules, storedRules } = await import('../server/src/db.js')
  const { bookKernel } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room, 'Черновик.ipynb')
  other.type('HOLD draft')
  requestRun(room.id, [other.id], 'Аким', 'p_akim', undefined, other.root)
  assert.ok(await until(() => other.state() === 'running'))

  // The teacher makes the notebook personal: its kernel moves to another
  // container, and a live process cannot move — so it is stopped, out loud.
  setRules(room.id, {
    ...storedRules(room.id),
    books: { [other.root]: { access: 'owner', owner: 'p_akim', ownerName: 'Аким' } },
  })
  syncBookKernels(room.id)

  assert.ok(
    await until(() => other.state() === 'idle'),
    `the cell that was computing did not return to rest: ${String(other.state())}`,
  )
  assert.equal(bookKernel(room.doc, other.root).runningCell, null)
  assert.ok(
    room.notes().some((line) => /Черновик\.ipynb/.test(line) && /(Доступ|access)/.test(line)),
    room.notes().join(' | '),
  )
})

test('a removed notebook takes its kernel along and leaves the neighbouring one alone', async () => {
  const { requestRun, syncBookKernels } = await import('../server/src/kernel/index.js')
  const { bookKernel, CELLS_KEY, removeBook } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room, 'Разбор.ipynb')
  room.type('print("lecture")')
  other.type('print("seminar")')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  requestRun(room.id, [other.id], 'Student', 'p_student', undefined, other.root)
  assert.ok(await until(() => room.state() === 'ok' && other.state() === 'ok'))

  removeBook(room.doc, other.path)
  syncBookKernels(room.id)
  // The notebook is gone — and so is its kernel: `off` (see the argument at
  // the idle sweep).
  assert.ok(await until(() => bookKernel(room.doc, other.root).status === 'off'))
  // The neighbouring notebook lives its own life: nobody touched its kernel.
  assert.equal(bookKernel(room.doc, CELLS_KEY).status, 'idle')
})

test('council in the second notebook is computed in ITS kernel', async () => {
  const { requestCouncilRun, councilQueuePosition } = await import('../server/src/kernel/index.js')
  const { jupyterSessionPath } = await import('../server/src/kernel/jupyter.js')
  const room = await seminar()
  const other = await secondBook(room, 'Консилиум.ipynb')
  other.type('# задание')

  let last: unknown = null
  requestCouncilRun(
    room.id,
    {
      cellId: other.id,
      participantId: 'p_akim',
      source: 'print(2 + 2)',
      limitSec: null,
      onChange: (run) => (last = run),
    },
    'Аким',
    'p_akim',
  )
  assert.ok(await until(() => (last as { state?: string } | null)?.state === 'ok'), JSON.stringify(last))
  // The attempt's kernel is its notebook's kernel: the session path exists,
  // and it is not the room's.
  assert.ok(byPath.has(jupyterSessionPath(room.id, other.root)), [...byPath.keys()].join(', '))
  assert.equal(councilQueuePosition(room.id, other.id, 'p_akim'), null)
})

test('a cell from another notebook does not join this queue', async () => {
  /*
   * The frame comes over the wire, and a cell in it can be named from any
   * notebook. Computing it in another notebook's kernel would give it someone
   * else's variables — exactly the boundary there are several kernels for.
   * Silently and without a single word on screen: the cell name in the
   * document is real, and it would look like "the run for some reason does
   * the wrong thing".
   *
   * The same case is guarded by control.ts · rootOfCells: the cell list and
   * the permissions are computed there by DIFFERENT paths, and if they drifted
   * apart they would give a Run All that does nothing.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  const other = await secondBook(room, 'Чужая.ipynb')
  other.type('print("не должно посчитаться")')
  requestRun(room.id, [other.id], 'Teacher', 'p_host', undefined, CELLS_KEY)
  await wait(400)
  assert.ok(
    other.state() === undefined || other.state() === 'idle',
    `a seminar cell was computed in the lecture kernel: ${String(other.state())}`,
  )
  assert.equal(other.execCount(), null, 'a cell from another notebook got an execution number')
  /*
   * And the notebook is not declared dead in the process.
   *
   * A run that was filtered out creates a scope, and the pump in `finally`
   * announces the kernel phase — a kernel that never came up has none, and it
   * reads as "stopped". A "KERNEL STOPPED" badge over a notebook in which
   * nobody ran anything is breakage out of nothing.
   */
  const { bookKernel: readKernel } = await import('../shared/notebook.js')
  assert.notEqual(readKernel(room.doc, other.root).status, 'dead')

  // And in its own notebook it is computed — the same frame with the same
  // name.
  requestRun(room.id, [other.id], 'Teacher', 'p_host', undefined, other.root)
  assert.ok(await until(() => other.state() === 'ok'))
})

/* ------------------------------------------ personal kernels idle */

/** A room with a personal notebook: `owner` access, that is, a separate container. */
async function personalBook(room: Awaited<ReturnType<typeof seminar>>, path = 'Аким.ipynb') {
  const { setRules, storedRules } = await import('../server/src/db.js')
  const book = await secondBook(room, path)
  const stored = storedRules(room.id)
  setRules(room.id, {
    ...stored,
    books: {
      ...(stored.books ?? {}),
      [book.root]: { access: 'owner', owner: 'p_akim', ownerName: 'Аким' },
    },
  })
  return book
}

const LATER = (minutes: number) => Date.now() + minutes * 60_000

test('a personal kernel is stopped when idle, but the class kernel is not', async () => {
  const { requestRun, sweepIdleKernels } = await import('../server/src/kernel/index.js')
  const { bookKernel, CELLS_KEY } = await import('../shared/notebook.js')
  const room = await seminar()
  const mine = await personalBook(room)
  room.type('print("lecture")')
  mine.type('print("draft")')
  requestRun(room.id, [room.cellId], 'Teacher', 'p_host', undefined, CELLS_KEY)
  requestRun(room.id, [mine.id], 'Аким', 'p_akim', undefined, mine.root)
  assert.ok(await until(() => room.state() === 'ok' && mine.state() === 'ok'))

  // Half an hour has not passed yet — nothing is touched.
  await sweepIdleKernels(LATER(29))
  assert.equal(bookKernel(room.doc, mine.root).status, 'idle')

  /*
   * It has passed — ONE kernel is stopped, the personal one. The class goes
   * on: its own kernel lives by a different count (two hours of an empty
   * room), and mixing the two up means stopping the lecture in the middle of
   * class.
   */
  await sweepIdleKernels(LATER(31))
  /*
   * `off`, not `starting` and not `dead`. An idle sweep is a normal falling
   * asleep: there is no kernel and nobody brings it up until Run is pressed.
   * Until 20 Sep 2026 the notebook's entry was simply deleted here, and the
   * room read the emptiness as "starting" — the badge promised a start that
   * was not happening (and the room notebook slid to "READY", promising a
   * live Python). A red "KERNEL STOPPED" would also be a false alarm here: it
   * is about an OOM or a crash.
   */
  assert.equal(bookKernel(room.doc, mine.root).status, 'off', 'the personal kernel was not stopped')
  assert.equal(bookKernel(room.doc, CELLS_KEY).status, 'idle', 'the class kernel was stopped along with the personal one')
  assert.ok(
    room.notes().some((line) => /Аким\.ipynb/.test(line) && /30/.test(line)),
    room.notes().join(' | '),
  )

  // And the next run brings it up the usual way.
  requestRun(room.id, [mine.id], 'Аким', 'p_akim', undefined, mine.root)
  assert.ok(await until(() => mine.state() === 'ok'), 'the kernel did not come up after the sweep')
})

test('the idle sweep does not touch a personal kernel that is computing and waiting', async () => {
  const { requestRun, sweepIdleKernels } = await import('../server/src/kernel/index.js')
  const { bookKernel } = await import('../shared/notebook.js')
  const room = await seminar()
  const mine = await personalBook(room, 'Борис.ipynb')
  mine.type('HOLD draft')
  requestRun(room.id, [mine.id], 'Борис', 'p_boris', undefined, mine.root)
  assert.ok(await until(() => mine.state() === 'running'))

  /*
   * A cell is running — the work has an owner who will come back for the
   * result. To this pass, long training in a personal notebook looks exactly
   * like idleness: nothing happened for half an hour — and without this check
   * the sweep would kill precisely what the notebook was opened for.
   */
  await sweepIdleKernels(LATER(120))
  assert.equal(mine.state(), 'running', 'the idle sweep took away a cell that was computing')
  assert.equal(bookKernel(room.doc, mine.root).status, 'busy')
  assert.equal(finishHeld(/HOLD/), 1)
  assert.ok(await until(() => mine.state() === 'ok'))
})

test('KERNEL_OWN_IDLE_MIN=0 turns off the sweep of personal kernels', async () => {
  const { requestRun, sweepIdleKernels } = await import('../server/src/kernel/index.js')
  const { bookKernel } = await import('../shared/notebook.js')
  const room = await seminar()
  const mine = await personalBook(room, 'Вера.ipynb')
  mine.type('print("draft")')
  requestRun(room.id, [mine.id], 'Вера', 'p_vera', undefined, mine.root)
  assert.ok(await until(() => mine.state() === 'ok'))

  const previous = process.env.KERNEL_OWN_IDLE_MIN
  process.env.KERNEL_OWN_IDLE_MIN = '0'
  try {
    await sweepIdleKernels(LATER(600))
    assert.equal(bookKernel(room.doc, mine.root).status, 'idle', 'zero did not turn off the sweep')
  } finally {
    if (previous === undefined) delete process.env.KERNEL_OWN_IDLE_MIN
    else process.env.KERNEL_OWN_IDLE_MIN = previous
  }
})
