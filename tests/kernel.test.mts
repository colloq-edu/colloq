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
/** Счётчик выполнений подделки — то же, что In [n] у настоящего ядра. */
let executions = 0
/** Что просили выполнить и как: `store_history` — кладёт ли IPython исходник в In/_ih. */
const requests: { code: string; store_history: boolean; silent: boolean }[] = []
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
      /*
       * Канал — настоящий, а не «iopub, что бы ни было».
       *
       * Здесь стоял `msgType === 'status' ? 'iopub' : 'iopub'` — мёртвый
       * тернарник, обе ветки одинаковы. Сервер поле `channel` сегодня не
       * читает, так что подделка оставалась зелёной при любом значении; но
       * настоящий Jupyter шлёт `execute_reply` по shell, а `input_request` по
       * stdin, и первая же маршрутизация входящих по каналу разошлась бы с
       * подделкой молча — тесты зелёные, живое ядро сломано.
       */
      channel:
        msgType === 'execute_reply'
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
       * Перезапуск, какой его делает настоящий Jupyter: тот же id ядра, тот же
       * сокет, процесс за ними — новый. Подделка этого не умела вовсе и
       * отвечала 404, так что `restartSession` уходил в catch и до сброса
       * ячеек не доходил никогда — а тест на этот сброс поэтому пришлось бы
       * гонять против живого контейнера. Один раз так и вышло: зелёный, пока
       * рядом случайно работало ядро.
       */
      const id = /^\/api\/kernels\/([^/]+)\/restart$/.exec(url.pathname)?.[1]
      const kernel = id ? kernels.get(id) : undefined
      if (kernel) kernel.busy = false
      // Ожидающие выполнения умирают вместе с процессом.
      for (const { socket, parent } of held.splice(0)) {
        reply(socket, parent, 'execute_reply', { status: 'abort', execution_count: 1 })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, name: 'python3' }))
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
        const msg = JSON.parse(String(raw)) as {
          header: { msg_type: string }
          content: { code: string; store_history: boolean; silent: boolean }
        }
        if (msg.header.msg_type !== 'execute_request') return
        requests.push({
          code: msg.content.code,
          store_history: msg.content.store_history,
          silent: msg.content.silent,
        })
        if (swallowExecutes) {
          reply(ws, msg.header, 'status', { execution_state: 'busy' })
          held.push({ socket: ws, parent: msg.header })
          return
        }
        reply(ws, msg.header, 'status', { execution_state: 'busy' })
        /*
         * Номер выполнения приезжает в execute_input, и настоящее ядро шлёт
         * его всегда — а подделка не слала никогда, так что execCount в тестах
         * молча оставался null и любая проверка про номер была бессмысленной.
         */
        reply(ws, msg.header, 'execute_input', {
          code: msg.content.code,
          execution_count: ++executions,
        })
        /*
         * Ячейка, которая убивает ядро по памяти.
         *
         * Настоящий Jupyter в этом случае не отвечает на запрос вовсе: он
         * присылает `status: restarting` — тот же id ядра, тот же сокет, новый
         * процесс за ними. Подделка этого не умела, и весь путь автоперезапуска
         * не был покрыт ничем.
         */
        if (/OOM/.test(msg.content.code)) {
          reply(ws, msg.header, 'status', { execution_state: 'restarting' })
          return
        }
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
        // Ячейка, которая ничего не печатает: `x = 1`, определение функции,
        // импорт. Настоящее ядро на такую отвечает ровно этим — реплаем и
        // idle, без единого iopub-вывода.
        if (/SILENT/.test(msg.content.code)) {
          reply(ws, msg.header, 'execute_reply', { status: 'ok', execution_count: 1 })
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

/*
 * Подделка перестаёт глотать выполнения после КАЖДОГО теста, что бы в нём ни
 * случилось.
 *
 * Флаг выставлялся в начале теста и снимался его последней строкой — то есть
 * упавшее посередине утверждение оставляло подделку глотающей, и весь хвост
 * файла падал с «the cell never started»: настоящий сбой тонул в двух десятках
 * ложных, и найти его в выводе было нечем. Задержанные запросы уходят вместе с
 * флагом — комната у каждого теста своя, и досиживать их некому.
 */
afterEach(() => {
  swallowExecutes = false
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

test('попытка консилиума считается без истории ядра — In/_ih чужих попыток не выдаёт', async () => {
  const { requestRun, requestCouncilRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print("cell")')
  requestRun(room.id, [room.cellId], 'Ада', 'p_t')
  assert.ok(await until(() => room.state() === 'ok'), 'ячейка не досчиталась')

  let last: { state: string } | null = null
  requestCouncilRun(
    room.id,
    {
      cellId: room.cellId,
      participantId: 'p_student',
      source: 'print("attempt")',
      by: 'host',
      onChange: (run) => {
        last = run
      },
    },
    'Ада',
    'p_t',
  )
  assert.ok(
    await until(() => last !== null && (last as { state: string }).state === 'ok'),
    'попытка не досчиталась',
  )
  const cell = requests.find((r) => r.code === 'print("cell")')
  const attempt = requests.find((r) => r.code === 'print("attempt")')
  assert.ok(cell && attempt, 'подделка не увидела запросов')
  assert.equal(cell.store_history, true, 'ячейка — обычная, In[n] у неё есть')
  // Ядро общее: с историей текст попытки читал бы любой, кому потом откроют ячейку.
  assert.equal(attempt.store_history, false)
  // Но не silent: вывод выражения (execute_result) попытке нужен.
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

test('Run All на тихо умершем ядре доводит до конца всю пачку', async () => {
  /*
   * Ядро умирает на перемене: сокет остаётся открытым, и узнаётся это только
   * опросом перед отправкой ячейки. Раньше в этот момент `dropQueue` выносил
   * очередь ЦЕЛИКОМ — до проверки «смерть ожидаемая», — так что Run All на
   * тридцати ячейках выполнял первую, а остальные молча возвращались в покой,
   * без единого слова о том, почему. И заодно уносил чужие пачки, вопреки
   * обещанию «сбой останавливает только свою».
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const tail = [createCell('code', 'print("two")'), createCell('code', 'print("three")')]
  room.doc.transact(() => cells.push(tail))
  room.type('print("one")')

  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'ok'), 'первый запуск не прошёл')

  for (const kernel of kernels.values()) kernel.alive = false
  // Дольше KERNEL_QUIET_MS: следующая отправка сначала спросит, живо ли ядро.
  await wait(250)

  const ids = [room.cellId, tail[0].get('id') as string, tail[1].get('id') as string]
  requestRun(room.id, ids, 'Maria', 'p_maria')

  const states = () => [room.state(), ...tail.map((c) => c.get('state'))]
  assert.ok(
    await until(() => states().every((state) => state === 'ok')),
    `пачка кончилась как ${JSON.stringify(states())}`,
  )
})

test('ячейка, убившая ядро по памяти, кончается ошибкой, а не тихим «Out [n]»', async () => {
  /*
   * При автоперезапуске фаза ядра — `restarting`, а не `dead`, и проверка в
   * runOne мимо неё промахивалась: выполнение завершалось `abort`, ячейка
   * садилась в `idle` с номером выполнения и частичным выводом — на экране
   * неотличимо от успешной. Следующая ячейка падала с NameError, и связи с
   * этой не видел никто.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { readNotebook } = await import('../shared/notebook.js')
  const room = await seminar()
  room.type('OOM: x = np.zeros((10**6, 10**4))')
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')

  assert.ok(
    await until(() => room.state() === 'error'),
    `ячейка кончилась как ${String(room.state())}`,
  )
  const outputs = readNotebook(room.doc)[1].outputs
  assert.match(JSON.stringify(outputs), /KernelDied/, 'ячейка ничего не сказала про смерть ядра')
  assert.equal(room.cell.get('execCount'), null, 'номер выполнения остался от убитого процесса')
  assert.ok(
    room.notes().some((note) => /memory|restart/i.test(note)),
    `комнате не сказали про перезапуск: ${JSON.stringify(room.notes())}`,
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

test('промах по чужой ячейке не разбирает чужую очередь', async () => {
  /*
   * Кнопка нарисована по документу, а документ отстаёт на круг: «стоп» по своей
   * ячейке доезжает в тот момент, когда она уже кончилась, а ядро взяло первую
   * ячейку из чужого Run All. `stopBatchOf` по текущей ячейке падал на
   * `currentBatch` — то есть на ЧУЖУЮ пачку, и двенадцать ячеек студента гасли
   * от нажатия преподавателя, с примечанием, объясняющим не то.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { getCells, createCell } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)
  const theirs = [createCell('code', 'while True: pass'), createCell('code', 'print("theirs")')]
  room.doc.transact(() => cells.push(theirs))

  // Ячейка преподавателя своё отработала.
  room.type('print("mine")')
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'ok'), 'ячейка преподавателя не прошла')

  // Run All студента: первая считает, вторая ждёт.
  swallowExecutes = true
  requestRun(
    room.id,
    theirs.map((c) => c.get('id') as string),
    'Ivan',
    'p_ivan',
  )
  assert.ok(await until(() => theirs[0].get('state') === 'running'), 'чужая ячейка не пошла')
  assert.ok(await until(() => theirs[1].get('state') === 'queued'), 'чужой хвост не встал')

  // Преподаватель жмёт «стоп» на своей — уже закончившейся.
  await interruptSession(room.id, room.cellId)
  swallowExecutes = false

  /*
   * SIGINT достаётся тому, что считается: ядро одно, и выбирать ему не из чего,
   * — так что чужая ячейка всё равно упадёт, а её собственный хвост снимет уже
   * её собственный провал. Проверяется здесь другое: чужую пачку не разбирает
   * само нажатие, и комнате не рассказывают, будто её сняли «прерыванием».
   */
  assert.ok(
    !room.notes().some((note) => /interrupt also dropped/i.test(note)),
    `нажатие отчиталось о чужой очереди: ${JSON.stringify(room.notes())}`,
  )
})

test('семинар, закрытый во время подъёма ядра, не возвращается в память', async () => {
  /*
   * `shutdownSession` снимает среду исполнения, но подъём ядра доживает свою
   * минуту на захваченном объекте — и всё, что он пишет, идёт через
   * `getSessionDoc`, который заводит документ заново. Удалённая комната
   * возвращалась в память вместе с папкой и строкой в истории.
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
  // Ровно в это окно владелец удаляет семинар.
  await shutdownSession(id)
  dropSessionDoc(id)
  await starting.catch(() => {})
  await wait(400)

  assert.equal(peekSessionDoc(id), null, 'комната воскресла из подъёма собственного ядра')
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

test('удалённая ячейка не оставляет ядро крутить свой цикл', async () => {
  /*
   * Удаление ничем не связано с выполнением: ячейка исчезала из документа, а
   * `while True` крутился до конца пары. Остановить это было нечем — кнопка
   * «стоп» нарисована на ячейке, а ячейки нет, — и `meta.runningCell` при этом
   * продолжал называть её id, то есть комната считала, что работа идёт.
   */
  const { requestRun } = await import('../server/src/kernel/index.js')
  const { getCells, getMeta } = await import('../shared/notebook.js')
  const room = await seminar()
  const cells = getCells(room.doc)

  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')

  room.doc.transact(() => {
    const index = cells.toArray().findIndex((c) => (c.get('id') as string) === room.cellId)
    if (index >= 0) cells.delete(index, 1)
  })
  swallowExecutes = false

  assert.ok(
    await until(() => getMeta(room.doc).get('runningCell') == null),
    'комната всё ещё считает, что удалённая ячейка выполняется',
  )
  assert.ok(
    room.notes().some((note) => /deleted/i.test(note)),
    `про остановку ничего не сказали: ${JSON.stringify(room.notes())}`,
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

test('секундомер заводится при старте и гаснет в конце', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')

  /*
   * Ячейку держат нарочно, и это половина смысла теста.
   *
   * Подделка отвечает в тот же тик, так что `running` почти никогда не
   * попадалось на глаза, а проверка «заводится при старте» стояла под
   * `if (state === 'running')` — то есть не выполнялась почти никогда: снять
   * запись `startedAt` в kernel/index.ts можно было, не уронив ни одного
   * утверждения. Теперь ядро молчит, пока секундомер не проверят.
   */
  const before = Date.now()
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')
  const at = room.startedAt()
  assert.ok(at !== null, 'работающая ячейка без отметки начала')
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, `отметка не похожа на сейчас: ${at}`)
  assert.equal(room.ranMs(), null, 'длительность объявлена у ячейки, которая ещё считает')

  swallowExecutes = false
  shellFinish()
  assert.ok(
    await until(() => room.state() === 'ok'),
    `ячейка кончилась как ${String(room.state())}`,
  )
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

test('прерванная ячейка кончается ошибкой, и время у неё есть', async () => {
  /*
   * Правило: длительность получают только те исходы, которые чем-то кончились.
   *
   * Живое ядро отвечает на SIGINT так же, как на всякое исключение:
   * KeyboardInterrupt в ячейке, `execute_reply` со статусом error. Это конец,
   * пусть и плохой, — и время у него есть. Исход здесь один и проверяется без
   * `if`: прежняя развилка «idle или error» принимала оба, так что регрессия
   * любой из веток была невидима.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')

  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_maria')
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')
  await interruptSession(room.id)
  swallowExecutes = false

  assert.ok(await until(() => room.state() !== 'running'), 'ячейка не остановилась')
  assert.equal(room.state(), 'error', `исход прерывания: ${String(room.state())}`)
  assert.equal(room.startedAt(), null, 'секундомер остался идти после остановки')
  assert.ok(
    typeof room.ranMs() === 'number',
    `прерванная ячейка осталась без длительности: ${String(room.ranMs())}`,
  )
})

test('снятая с очереди ячейка времени завершения не получает', async () => {
  /*
   * Вторая половина того же правила, и вот исход, у которого времени быть не
   * должно: ячейка, которую прерывание вынесло из очереди, не выполнялась ни
   * миллисекунды. Напечатать ей длительность рядом с пустым `Out [ ]` значило
   * бы объявить результат, которого не появилось.
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
  assert.ok(await until(() => second.get('state') === 'queued'), 'вторая не встала в очередь')
  await interruptSession(room.id)
  swallowExecutes = false

  assert.ok(await until(() => second.get('state') === 'idle'), 'вторая осталась в очереди')
  assert.equal(second.get('startedAt'), null, 'у не начинавшейся ячейки завёлся секундомер')
  assert.equal(second.get('ranMs'), null, 'не выполнявшаяся ячейка обзавелась длительностью')
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
  assert.ok(
    await until(() => tail.every((c) => c.get('state') === 'queued')),
    'хвост не встал в очередь',
  )

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
  // Часы вызывающего — на окно вперёд: иначе проход отказал бы по окну
  // (ORPHAN_SWEEP_EVERY_MS), а не потому, что ячейка работает по-настоящему, и
  // утверждение стало бы тавтологией.
  assert.equal(sweepOrphanRuns(room.id, Date.now() + 3000), 0, 'проход снял работающую ячейку')
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
  assert.ok(
    await until(() => room.state() === 'ok'),
    `ячейка кончилась как ${String(room.state())}`,
  )

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

  assert.ok(
    await until(() => room.state() === 'ok'),
    `ячейка кончилась как ${String(room.state())}`,
  )
  const took = room.ranMs()
  assert.ok(typeof took === 'number', 'длительность не записана')
  assert.ok(took < 60_000, `подделка попала в длительность: ${took} мс`)
})

test('запуск открывается одной транзакцией', async () => {
  /*
   * Раньше старт выполнения был двумя записями подряд: сначала поля ячейки,
   * потом стирание вывода. Клиент получал два события — на первом просыпался
   * наблюдатель полей и пропадала строка «Out [n]», на втором пропадало тело.
   * Между этими кадрами область успевала обмериться на двадцать четыре
   * пикселя короче, то есть место под новый вывод резервировалось неверным.
   *
   * Проверка молчаливая по своей природе: разъедини транзакции обратно, и всё
   * продолжит работать — просто чуть заметнее дёргаться.
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

  // Ровно одна транзакция обнуляет вывод, и она же объявляет ячейку
  // работающей и снимает номер.
  const emptied = marks.filter((m, i) => m.outs === 0 && (i === 0 || marks[i - 1].outs > 0))
  assert.equal(emptied.length, 1, `вывод обнулялся ${emptied.length} раз(а)`)
  assert.equal(emptied[0].state, 'running', 'стирание и объявление разошлись по разным транзакциям')
  assert.equal(emptied[0].exec, null, 'номер снялся не в той же транзакции')
})

test('выполнение, которое ничего не печатает, не оставляет прошлого вывода', async () => {
  const { requestRun } = await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('print(1)')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))
  assert.ok(
    (room.cell.get('outputs') as { length: number }).length > 0,
    'первый запуск ничего не напечатал',
  )

  // Подделка Jupyter отвечает потоком на любой код, кроме этого маркера.
  room.type('SILENT')
  requestRun(room.id, [room.cellId], 'Alexander', 'p_1')
  assert.ok(await until(() => room.state() === 'ok'))
  await wait(150)
  assert.equal(
    (room.cell.get('outputs') as { length: number }).length,
    0,
    'ячейка держит результат выполнения, которого больше нет',
  )
  assert.notEqual(room.cell.get('execCount'), null, 'у прошедшего выполнения нет номера')
})

test('перезапуск снимает номер выполнения со всех результатов', async () => {
  /*
   * Исключение для ячейки, которую разбирает насос, накрывало и номер: после
   * перезапуска сорок результатов оставались на экране, а единственный
   * проверяемый факт о них исчезал у всех, кроме одной — и самая свежая
   * ячейка выглядела единственной настоящей.
   *
   * Живёт здесь, а не в restart.test.mts: `restartSession` поднимает ядро, и
   * там его нет. Первая версия этого теста шла через него, зелёной была ровно
   * до тех пор, пока рядом случайно работал контейнер, и падала шестьюдесятью
   * секундами таймаута, когда его не стало.
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
    `ячейка кончилась как ${String(room.state())}`,
  )
  assert.ok(await until(() => second.get('state') === 'ok'), 'вторая не отработала')
  assert.notEqual(room.cell.get('execCount'), null, 'номера не было и до перезапуска')

  await restartSession(room.id, 'Alexander')

  for (const cell of [room.cell, second]) {
    assert.equal(cell.get('execCount'), null, 'номер пережил перезапуск ядра')
    assert.equal(cell.get('state'), 'idle')
    assert.equal(cell.get('startedAt'), null)
  }
})

test('проход по призракам не повторяется чаще окна', async () => {
  /*
   * Поводов пройти три — пульс, нажатие, подключение управляющего сокета, — и
   * после перезапуска сервера они приходят пачкой: пятьсот вкладок за две
   * секунды, то есть пятьсот транзакций по всем ячейкам всех тетрадей одной
   * комнаты ровно тогда, когда весь зал ждёт синхронизации. Чинить проходу
   * нужно то, что осталось от умершего процесса, — оно никуда не денется за
   * две секунды.
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

  // Второй сокет той же секунды документ не читает вовсе.
  ghost()
  assert.equal(sweepOrphanRuns(room.id, at + 1_999), 0, 'проход пошёл по документу второй раз')
  assert.equal(room.state(), 'running', 'а раз не пошёл — призрак ещё стоит')

  // Окно кончилось — призрака снимают.
  assert.equal(sweepOrphanRuns(room.id, at + 2_001), 1)
  assert.equal(room.state(), 'idle')
})

test('правка листа перезапускает попытку, а не упирается в «уже в очереди»', async () => {
  /*
   * Очередь на потоке одна, ждать минуту — обычное дело, и правка за это время
   * тоже обычна. Прежде ждущая запись была неприкасаемой: студент, поправивший
   * лист, получал «эта попытка уже в очереди — 37-я» и не мог запустить НОВУЮ
   * версию, пока ядро не досчитает старую, — а её вывод к тому времени всё
   * равно выбрасывался как опоздавший (council.ts · recordRun). Считаться
   * должно то, что человек видит на экране.
   *
   * Место в очереди при этом остаётся прежним: за исправленную опечатку не
   * отправляют в хвост.
   */
  const { requestRun, requestCouncilRun, councilQueuePositions, cancelCouncilRun, interruptSession } =
    await import('../server/src/kernel/index.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Ада', 'p_t')
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')

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
        onChange: (run) => seen.push(run?.state ?? null),
      },
      'Ада',
      'p_1',
    )

  assert.deepEqual(press('print(1)', first), { queued: true, position: 2 })
  assert.deepEqual(first, ['queued'])

  // То же самое второй раз — это второе нажатие, а не другой запуск.
  assert.deepEqual(press('print(1)', second), { queued: false, position: 2 })
  assert.deepEqual(second, [], 'по второму нажатию кадр всё-таки уехал')

  // Другой текст — другой запуск: запись подменяется на месте.
  assert.deepEqual(press('print(2)', second), { queued: true, position: 2 })
  assert.deepEqual(second, ['queued'], 'новому тексту не сказали, что он в очереди')
  assert.deepEqual(first, ['queued'], 'прежнему заданию досталось лишнее слово')
  assert.deepEqual(
    councilQueuePositions(room.id),
    [{ cellId: room.cellId, participantId: 'p_1', position: 2 }],
    'подмена завела вторую запись вместо замены',
  )

  // Снятая попытка говорит своему заданию «запуска не было» — и только ему.
  assert.ok(cancelCouncilRun(room.id, room.cellId, 'p_1'))
  assert.deepEqual(second, ['queued', null])
  assert.deepEqual(first, ['queued'])
  assert.deepEqual(councilQueuePositions(room.id), [])

  swallowExecutes = false
  await interruptSession(room.id)
  assert.ok(await until(() => room.state() !== 'running'), 'ячейка не остановилась')
})

test('номера очереди консилиума считаются одним проходом и совпадают с поштучным счётом', async () => {
  /*
   * `tellQueued` шлёт новый номер каждому ждущему на каждый сдвиг очереди, а
   * номер считался поиском по всей очереди — на пятистах попытках это
   * четверть миллиона сравнений на одно завершение. Массовый счёт обязан
   * давать ровно то же, что поштучный, иначе студент увидит один номер, а его
   * сосед — другой.
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
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')

  const attempt = (participantId: string) =>
    requestCouncilRun(
      room.id,
      {
        cellId: room.cellId,
        participantId,
        source: `print("${participantId}")`,
        by: 'host',
        onChange: () => {},
      },
      'Ада',
      'p_t',
    )

  // Считая ту, что занимает ядро прямо сейчас.
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
      `массовый счёт разошёлся с поштучным у ${one.participantId}`,
    )
  }

  // Ушедшая из середины очереди попытка двигает тех, кто за ней.
  assert.ok(cancelCouncilRun(room.id, room.cellId, 'p_1'), 'попытка не снялась')
  assert.deepEqual(
    councilQueuePositions(room.id),
    [{ cellId: room.cellId, participantId: 'p_2', position: 2 }],
    'номер соседа не сдвинулся',
  )

  cancelCouncilRun(room.id, room.cellId, 'p_2')
  swallowExecutes = false
  await interruptSession(room.id)
  assert.ok(await until(() => room.state() !== 'running'), 'ячейка не остановилась')
})

test('пока ячейка пишет вывод, комнату из памяти не выселяют', async () => {
  /*
   * Пустая комната выселяется через десять минут, и выселение уничтожает
   * `Y.Doc`. `OutputWriter` берёт документ в конструкторе и пишет в ЭТОТ объект
   * до конца выполнения — запись в уничтоженный не видит никто и молча. Пока
   * писатель жив, комната держится (kernel/index.ts · dropWriter → holdRoom).
   *
   * Последним в файле: проход выселяет ВСЕ пустые комнаты, в том числе те, что
   * завели тесты выше.
   */
  const { requestRun, interruptSession } = await import('../server/src/kernel/index.js')
  const { sweepIdleRooms } = await import('../server/src/collab/index.js')
  const room = await seminar()
  room.type('while True: pass')
  swallowExecutes = true
  requestRun(room.id, [room.cellId], 'Maria', 'p_2')
  assert.ok(await until(() => room.state() === 'running'), 'ячейка не пошла')

  // Все закрыли ноутбуки час назад, а ячейка всё считает.
  const hour = Date.now() + 60 * 60 * 1000
  assert.ok(!sweepIdleRooms(hour).includes(room.id), 'комнату выселили из-под писателя')

  swallowExecutes = false
  await interruptSession(room.id)
  assert.ok(await until(() => room.state() !== 'running'), 'ячейка не остановилась')

  // Писатель отпустил — и комната стала обычной пустой комнатой.
  assert.ok(sweepIdleRooms(hour).includes(room.id), 'комната осталась удержанной навсегда')
})
