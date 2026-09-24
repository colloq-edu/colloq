/**
 * There is one channel to the kernel. A second one means the room sees every
 * output twice.
 *
 * Jupyter broadcasts iopub to ALL connections to the kernel, so two open
 * sockets are not a safety margin but a doubling: every `print`, every image
 * and every traceback is handled twice and lands in the cell twice, for the
 * rest of the kernel's life.
 *
 * This is how they got opened: while `reconnect()` waits for the handshake
 * (up to twenty seconds), `socket` is already null and the timer already
 * cleared — both guards are empty, and `waitForSocket`, which polls the state
 * every hundred milliseconds from every `execute`, started one more
 * reconnection. The `open` handler simply assigned the new socket over the
 * old one without closing it, and the old one's `close` scheduled a third.
 * In terminal.ts the same class of trouble is closed by the `opening` field;
 * here it was open.
 *
 * A fake Jupyter with a slow handshake: a real kernel will not produce this
 * race on demand.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'

let http: Server
let wss: WebSocketServer
let port = 0
let minted = 0
const kernels = new Set<string>()
/** Open sockets by kernel id: a second one to the same kernel is the defect. */
const open = new Map<string, Set<WebSocket>>()
/** Handshake delay: it opens the "reconnect in flight" window. */
let upgradeDelayMs = 0

const liveSockets = (id: string) =>
  [...(open.get(id) ?? [])].filter((ws) => ws.readyState === ws.OPEN)

function send(socket: WebSocket, parent: unknown, msgType: string, content: unknown): void {
  socket.send(
    JSON.stringify({
      header: { msg_id: `m_${Math.random().toString(36).slice(2)}`, msg_type: msgType },
      parent_header: parent,
      metadata: {},
      content,
      channel: 'iopub',
    }),
  )
}

before(async () => {
  http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const id = `k_${++minted}`
      kernels.add(id)
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `s_${id}`, kernel: { id } }))
      return
    }
    if (req.method === 'GET' && /^\/api\/kernels\/[^/]+$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'k', execution_state: 'idle' }))
      return
    }
    res.writeHead(404).end('{}')
  })

  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const id = /^\/api\/kernels\/([^/]+)\/channels/.exec(req.url ?? '')?.[1]
    if (!id || !kernels.has(id)) return socket.destroy()
    const accept = () =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        const set = open.get(id) ?? new Set<WebSocket>()
        set.add(ws)
        open.set(id, set)
        ws.on('close', () => set.delete(ws))
        ws.on('message', (raw) => {
          const msg = JSON.parse(String(raw)) as {
            header: { msg_type: string }
            content: { code: string }
          }
          if (msg.header.msg_type !== 'execute_request') return
          // A cell stopped at input(): we wait for an answer and send no reply.
          if (/INPUT/.test(msg.content.code)) {
            send(ws, msg.header, 'input_request', { prompt: 'сколько? ', password: false })
            return
          }
          // Real Jupyter broadcasts iopub to every connection — exactly what
          // turns a second socket into doubled output.
          for (const peer of liveSockets(id)) {
            send(peer, msg.header, 'status', { execution_state: 'busy' })
            send(peer, msg.header, 'stream', { name: 'stdout', text: `${msg.content.code}\n` })
            send(peer, msg.header, 'status', { execution_state: 'idle' })
          }
          send(ws, msg.header, 'execute_reply', { status: 'ok', execution_count: 1 })
        })
      })
    if (upgradeDelayMs > 0) setTimeout(accept, upgradeDelayMs)
    else accept()
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  port = (http.address() as { port: number }).port
})

after(async () => {
  for (const set of open.values()) for (const ws of set) ws.terminate()
  wss?.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const handlers = (seen: string[]) => ({
  onExecuteInput: () => {},
  onStream: (_name: 'stdout' | 'stderr', text: string) => seen.push(text),
  onData: () => {},
  onError: () => {},
  onClear: () => {},
})

test('a reconnect in the middle of a wait does not open a second channel', async () => {
  const { JupyterKernel } = await import('../server/src/kernel/jupyter.js')
  const endpoint = { url: `http://127.0.0.1:${port}`, token: 'fake' }
  const kernel = await JupyterKernel.connect('reconnect-room', endpoint)
  const id = [...kernels][kernels.size - 1]
  assert.equal(liveSockets(id).length, 1, 'the fake gave more than one channel at the start')

  /*
   * The handshake is now slow — that is exactly the window in which
   * `waitForSocket` managed to start a second reconnection on top of the one
   * in progress.
   */
  upgradeDelayMs = 1200
  for (const ws of liveSockets(id)) ws.terminate()
  await wait(150)

  // Exactly what the room does: someone presses Run while the channel has not
  // come back yet.
  const first: string[] = []
  assert.equal(await kernel.execute('hello', handlers(first)), 'ok')
  assert.deepEqual(first, ['hello\n'])

  /*
   * The extra handshakes arrive LATER than the first one, and that is the
   * whole point: by then the room has already seen normal output and
   * suspected nothing, while the second channel opened and stayed. We wait
   * until everything that went out has arrived — and only then ask.
   */
  await wait(2000)
  assert.equal(
    liveSockets(id).length,
    1,
    `channels open to one kernel: ${liveSockets(id).length} — all of iopub will travel that many times`,
  )

  const second: string[] = []
  assert.equal(await kernel.execute('second', handlers(second)), 'ok')
  assert.deepEqual(second, ['second\n'], `the output arrived ${second.length} time(s)`)

  upgradeDelayMs = 0
  kernel.detach()
})

test('an answer to input() over a dropped channel does not clear the wait', async () => {
  /*
   * `answerInput` cleared `awaitingInput` BEFORE the answer went into the
   * socket — and between those two lines sits a wait for the channel, which
   * can throw. After that the kernel is still sitting in `input()`, while the
   * server thinks it no longer is: the prompt hangs for the whole room, every
   * following "Send" silently gets `false`, the queue is stuck, and the only
   * way out is "stop".
   *
   * The channel is dropped here with `detach()`, not with a slow reconnect:
   * the path inside is the same (`waitForSocket` throws), just without
   * forty-five seconds of waiting in the suite.
   */
  const { JupyterKernel } = await import('../server/src/kernel/jupyter.js')
  const endpoint = { url: `http://127.0.0.1:${port}`, token: 'fake' }
  const kernel = await JupyterKernel.connect('input-room', endpoint)

  const seen: string[] = []
  void kernel.execute('INPUT', handlers(seen)).catch(() => {})
  const asked = await (async () => {
    for (let i = 0; i < 80; i++) {
      if (kernel.waitingForInput) return true
      await wait(25)
    }
    return false
  })()
  assert.ok(asked, 'the fake did not ask for input')

  kernel.detach()
  await assert.rejects(
    () => kernel.answerInput('42'),
    'the answer went into a closed channel and was declared delivered',
  )
  assert.equal(
    kernel.waitingForInput,
    true,
    'the input wait was cleared although the answer was never sent — the form will stay up for the whole room',
  )
})
