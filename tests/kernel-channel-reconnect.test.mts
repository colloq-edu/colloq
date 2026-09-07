/**
 * Канал к ядру — один. Второй означает, что комната видит каждый вывод дважды.
 *
 * Jupyter рассылает iopub во ВСЕ подключения к ядру, поэтому два открытых
 * сокета — это не запас прочности, а удвоение: каждый `print`, каждая картинка
 * и каждый трейсбек обрабатываются дважды и дважды ложатся в ячейку, до конца
 * жизни ядра.
 *
 * Открывались они так: пока `reconnect()` ждёт рукопожатия (до двадцати секунд),
 * `socket` уже null, таймер уже снят — оба сторожа пусты, и `waitForSocket`,
 * который опрашивает состояние каждые сто миллисекунд из каждого `execute`,
 * заводил ещё одно переподключение. Обработчик `open` просто присваивал новый
 * сокет поверх старого, не закрывая его, а `close` старого планировал третье.
 * В terminal.ts этот же класс бед закрыт полем `opening`; здесь он был открыт.
 *
 * Подделка Jupyter с медленным рукопожатием: настоящее ядро эту гонку по
 * требованию не отдаст.
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
/** Открытые сокеты по id ядра: второй к тому же ядру — и есть дефект. */
const open = new Map<string, Set<WebSocket>>()
/** Задержка рукопожатия: ею открывается окно «переподключение в полёте». */
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
          // Ячейка, остановившаяся в input(): ответа ждём, реплая не шлём.
          if (/INPUT/.test(msg.content.code)) {
            send(ws, msg.header, 'input_request', { prompt: 'сколько? ', password: false })
            return
          }
          // Настоящий Jupyter рассылает iopub каждому подключению — ровно это и
          // превращает второй сокет в удвоенный вывод.
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

test('переподключение посреди ожидания не открывает второй канал', async () => {
  const { JupyterKernel } = await import('../server/src/kernel/jupyter.js')
  const endpoint = { url: `http://127.0.0.1:${port}`, token: 'fake' }
  const kernel = await JupyterKernel.connect('reconnect-room', endpoint)
  const id = [...kernels][kernels.size - 1]
  assert.equal(liveSockets(id).length, 1, 'подделка отдала не один канал на старте')

  /*
   * Рукопожатие теперь долгое — это и есть окно, в которое `waitForSocket`
   * успевал завести второе переподключение поверх идущего.
   */
  upgradeDelayMs = 1200
  for (const ws of liveSockets(id)) ws.terminate()
  await wait(150)

  // Ровно то, что делает комната: кто-то жмёт Run, пока канал ещё не вернулся.
  const first: string[] = []
  assert.equal(await kernel.execute('hello', handlers(first)), 'ok')
  assert.deepEqual(first, ['hello\n'])

  /*
   * Лишние рукопожатия доезжают ПОЗЖЕ первого, и в этом всё дело: комната к
   * этому моменту уже увидела нормальный вывод и ничего не заподозрила, а
   * второй канал открылся и остался. Ждём, пока всё, что успело уйти,
   * доедет, — и только потом спрашиваем.
   */
  await wait(2000)
  assert.equal(
    liveSockets(id).length,
    1,
    `к одному ядру открыто каналов: ${liveSockets(id).length} — весь iopub поедет столько же раз`,
  )

  const second: string[] = []
  assert.equal(await kernel.execute('second', handlers(second)), 'ok')
  assert.deepEqual(second, ['second\n'], `вывод пришёл ${second.length} раз(а)`)

  upgradeDelayMs = 0
  kernel.detach()
})

test('ответ на input() при упавшем канале не гасит ожидание', async () => {
  /*
   * `answerInput` снимал `awaitingInput` ДО того, как ответ уходил в сокет, —
   * а между этими двумя строками стоит ожидание канала, которое умеет бросить.
   * Ядро после такого всё ещё стоит в `input()`, а сервер считает, что уже нет:
   * приглашение висит у всей комнаты, каждое следующее «Send» молча получает
   * `false`, очередь стоит, и выход один — «остановить».
   *
   * Канал здесь роняется `detach()`, а не медленным переподключением: путь
   * внутри тот же самый (`waitForSocket` бросает), только без сорока пяти
   * секунд ожидания в сюите.
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
  assert.ok(asked, 'подделка не спросила ввода')

  kernel.detach()
  await assert.rejects(
    () => kernel.answerInput('42'),
    'ответ ушёл в закрытый канал и объявлен доставленным',
  )
  assert.equal(
    kernel.waitingForInput,
    true,
    'ожидание ввода сняли, хотя ответ так и не отправили — форма останется у всей комнаты',
  )
})
