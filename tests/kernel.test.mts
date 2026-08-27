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
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'

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
/**
 * Requests the fake is sitting on. A real kernel answers an interrupted request
 * with an aborted reply and an idle status; without that the caller waits for
 * ever, which is a property of this fake and not of the thing being tested.
 */
let held: Array<{ socket: WebSocket; parent: unknown }> = []

function reply(socket: WebSocket, parent: unknown, msgType: string, content: unknown): void {
  socket.send(
    JSON.stringify({
      header: { msg_id: `m_${Math.random().toString(36).slice(2)}`, msg_type: msgType },
      parent_header: parent,
      metadata: {},
      content,
      channel: msgType === 'status' ? 'iopub' : 'iopub',
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
      res.end(JSON.stringify({ id: kernelMatch[1], execution_state: kernel.busy ? 'busy' : 'idle' }))
      return
    }
    if (req.method === 'POST' && /\/interrupt$/.test(url.pathname)) {
      const id = /^\/api\/kernels\/([^/]+)\/interrupt$/.exec(url.pathname)?.[1]
      const kernel = id ? kernels.get(id) : undefined
      if (kernel) kernel.busy = false
      for (const { socket, parent } of held.splice(0)) {
        reply(socket, parent, 'error', { ename: 'KeyboardInterrupt', evalue: '', traceback: [] })
        reply(socket, parent, 'execute_reply', { status: 'error', execution_count: 1 })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
      res.writeHead(204).end()
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
        const msg = JSON.parse(String(raw)) as { header: { msg_type: string }; content: { code: string } }
        if (msg.header.msg_type !== 'execute_request') return
        if (swallowExecutes) {
          reply(ws, msg.header, 'status', { execution_state: 'busy' })
          held.push({ socket: ws, parent: msg.header })
          return
        }
        reply(ws, msg.header, 'status', { execution_state: 'busy' })
        // A cell whose source says so fails, so a suite can build a notebook
        // that breaks in the middle without needing a real Python.
        if (/RAISE/.test(msg.content.code)) {
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
         * `имя?` — справка, и приходит она не по iopub.
         *
         * IPython отвечает на неё полем `payload` в самом execute_reply, тем
         * самым куском, который в настоящем ноутбуке открывается «страницей»
         * внизу окна. Ни stream, ни display_data при этом нет вовсе — поэтому
         * ячейка и оставалась пустой, пока сервер читал из этого сообщения
         * один только status. Подделка повторяет ту же форму.
         */
        if (/\?$/.test(msg.content.code.trim())) {
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
        reply(ws, msg.header, 'stream', { name: 'stdout', text: `${msg.content.code}\n` })
        reply(ws, msg.header, 'execute_reply', { status: 'ok', execution_count: 1 })
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
  if (first) reply(first.socket, first.parent, 'stream', { name: 'stdout', text })
}

/** Let the held request finish, the way a kernel does when the cell ends. */
function shellFinish(): void {
  for (const { socket, parent } of held.splice(0)) {
    reply(socket, parent, 'execute_reply', { status: 'ok', execution_count: 1 })
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
    notes.some((note) => /kernel kept running/i.test(note)),
    `the room was not told: ${JSON.stringify(notes)}`,
  )
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
  requestRun(room.id, [room.cellId, extra[0].get('id') as string, extra[1].get('id') as string], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'the first cell never started')
  assert.ok(await until(() => extra.every((c) => c.get('state') === 'queued')), 'the tail was never queued')

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

test('секундомер заводится при старте и гаснет в конце', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')

  const before = Date.now()
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'running' || room.state() === 'ok'), 'ячейка не пошла')
  if (room.state() === 'running') {
    const at = room.startedAt()
    assert.ok(at !== null, 'работающая ячейка без отметки начала')
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, `отметка не похожа на сейчас: ${at}`)
  }

  assert.ok(await until(() => room.state() === 'ok'), `ячейка кончилась как ${String(room.state())}`)
  // Погашен — иначе полоса дышала бы и часы шли бы на успокоившейся ячейке.
  assert.equal(room.startedAt(), null, 'секундомер остался идти после завершения')
  const took = room.ranMs()
  assert.ok(typeof took === 'number' && took >= 0, `длительность не записана: ${String(took)}`)
})

test('стоящая в очереди ячейка секундомера не заводит', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const second = createCell('code', 'print("two")')
  room.doc.transact(() => cells.push([second]))
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(room.id, [room.cellId, second.get('id') as string], 'Maria', 'p_maria')
  assert.ok(await until(() => second.get('state') === 'queued'), 'вторая не встала в очередь')
  assert.equal(second.get('startedAt'), null, 'очередь завела секундомер')

  const { interruptSession } = await import('../server/src/kernel/index.js')
  await interruptSession(room.id)
  swallowExecutes = false
})

test('прерванное выполнение не получает времени завершения', async () => {
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')
  await interruptSession(room.id)
  swallowExecutes = false

  assert.ok(await until(() => room.state() !== 'running'), 'ячейка не остановилась')
  assert.equal(room.startedAt(), null, 'секундомер остался идти после остановки')

  /*
   * Правило: длительность получают только те исходы, которые чем-то кончились.
   *
   * Прерывание при живом ядре кладёт ячейку в 'idle' — выполнения не было, и
   * времени завершения у него нет: напечатать его рядом с Out [n] значило бы
   * объявить результат, которого не появилось. Если же ядро при этом умерло,
   * ячейка кончается 'error' — это настоящий конец, пусть и плохой, и время у
   * него есть.
   */
  if (room.state() === 'idle') {
    assert.equal(room.ranMs(), null, 'прерванная ячейка обзавелась длительностью')
  } else {
    assert.equal(room.state(), 'error', `неожиданный исход прерывания: ${String(room.state())}`)
    assert.ok(typeof room.ranMs() === 'number', 'упавшая ячейка осталась без длительности')
  }
})

test('промахнувшийся «стоп» останавливает работу, но не разбирает очередь', async () => {
  /*
   * Кнопка на ячейке нарисована по документу, а документ отстаёт от сервера на
   * круг: к моменту, когда нажатие доедет, выполняться может уже следующая
   * ячейка того же Run All. Опасна тут была только вторая ветка
   * `interruptSession` — `dropQueue` выносит очередь всей комнаты, включая
   * чужие батчи. Останавливать текущую работу промахнувшимся нажатием не
   * опасно: `stopBatchOf` ограничен батчем той ячейки, которая выполняется, а
   * попади нажатие точно в цель — сняло бы ровно тот же батч.
   *
   * Сначала проверка цели стояла над всей функцией, и промах не делал вообще
   * ничего: человек жал «стоп», тетрадь продолжала считать, кнопка молчала.
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
  assert.ok(await until(() => room.state() === 'running'), 'первая не пошла')
  assert.ok(await until(() => tail.every((c) => c.get('state') === 'queued')), 'хвост не встал в очередь')

  // Целимся в ячейку, которой в комнате нет вовсе — крайний случай промаха.
  await interruptSession(room.id, 'no-such-cell')
  swallowExecutes = false

  assert.ok(await until(() => room.state() !== 'running'), 'промах не остановил работу')
  assert.ok(
    await until(() => tail.every((c) => c.get('state') === 'idle')),
    'хвост своего батча остался стоять',
  )
})

test('призрачная работающая ячейка убирается проходом, а живая — нет', async () => {
  /*
   * Вкладка, открытая в момент падения сервера, сливает свои обновления
   * обратно как есть, и 'running' из умершего процесса может пережить сброс.
   * До появления анимации такая ячейка тихо стояла; теперь она дышала бы и
   * считала секунды до конца пары.
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

  // А по-настоящему работающую ячейку проход не трогает.
  const { requestRun } = await import('../server/src/kernel/index.js')
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')
  assert.equal(sweepOrphanRuns(room.id), 0, 'проход снял работающую ячейку')
  assert.equal(room.state(), 'running')

  const { interruptSession } = await import('../server/src/kernel/index.js')
  await interruptSession(room.id)
  swallowExecutes = false
})


test('справка по вопросительному знаку доезжает до ячейки', async () => {
  /*
   * `print?` печатал пустоту. Ответ на такой вопрос IPython кладёт в payload
   * самого execute_reply — «страницей», которую настоящий ноутбук открывает
   * внизу окна, — и по iopub не присылает ничего. Сервер читал из этого
   * сообщения только status, так что вся справка уходила в никуда: ячейка
   * отрабатывала за миллисекунды и оставалась пустой, будто вопросительный
   * знак ничего не значит.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { readNotebook } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('print?')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'), `ячейка кончилась как ${String(room.state())}`)

  const outputs = readNotebook(room.doc)[1].outputs
  assert.equal(outputs.length, 1, `выводов ${outputs.length}, а справка должна быть одна`)
  assert.match(JSON.stringify(outputs), /Docstring/, 'справка не доехала до ячейки')
})

test('обычная ячейка от этого ничего не теряет', async () => {
  // Полезная проверка ровно потому, что справка ходит по тому же сообщению,
  // что и статус: сломать обычный путь тут проще всего.
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { readNotebook } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))
  assert.match(JSON.stringify(readNotebook(room.doc)[1].outputs), /print\(1\)/)
})


test('проход чистит и зеркало в meta, а не только ячейки', async () => {
  /*
   * Тот же умерший процесс оставляет за собой не только состояние ячеек, но и
   * своё зеркало в meta: runningCell, queue и kernelStatus. По ним считают чип
   * «2 queued» в панели, строку «Maria — running cell 05» в списке людей и то,
   * рисовать ли комнатный Interrupt включённым. Починить ячейки и оставить
   * зеркало значило починить видимое и оставить то, по чему считают.
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
  // Форма ввода, за которой уже никого нет, — это поле, чей «Send» уходит в пустоту.
  assert.equal(room.cell.get('stdin'), null, 'вопрос ядра остался на экране')
  assert.equal(meta.get('runningCell'), null, 'зеркало всё ещё называет работающую ячейку')
  assert.notEqual(meta.get('kernelStatus'), 'busy', 'ядро всё ещё числится занятым')
})

test('длительность считается по записи сервера, а не по полю документа', async () => {
  /*
   * `startedAt` лежит в общем документе, а его пишет кто угодно в комнате — это
   * устройство продукта. Считать по нему длительность значило дать любому
   * студенту дописать преподавателю «выполнялось три часа».
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')

  // Пока считается — подделываем отметку в документе, как это может сделать
  // любая вкладка в комнате.
  await until(() => room.state() === 'running' || room.state() === 'ok')
  room.doc.transact(() => room.cell.set('startedAt', Date.now() - 3 * 60 * 60 * 1000))

  assert.ok(await until(() => room.state() === 'ok'), `ячейка кончилась как ${String(room.state())}`)
  const took = room.ranMs()
  assert.ok(typeof took === 'number', 'длительность не записана')
  assert.ok(took < 60_000, `подделка попала в длительность: ${took} мс`)
})
