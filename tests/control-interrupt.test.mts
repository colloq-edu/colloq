/**
 * Ctrl+C из пульта: чью команду он снимает и чью очередь оставляет.
 *
 * Оболочка в комнате одна, и кнопка «стоп» у преподавателя и у студента значит
 * разное. У преподавателя — «прекратить в этой комнате всё»; у студента —
 * «останови мою зависшую команду», и раньше она значила то же, что у
 * преподавателя: студент, прервав свой `pip install`, молча уносил всё, что
 * успел поставить в очередь преподаватель. Развилка, которая это держит, стоит
 * одной строкой в пульте (`role === 'host' ? undefined : participantId`), и
 * через `dispatch` её не проходил ни один тест: отказ тому, у кого своей
 * бегущей команды нет, проверен (control-dispatch), а РАЗРЕШАЮЩАЯ половина —
 * та самая, где пропадала чужая очередь, — нет. Замена этой строки на голое
 * `undefined` до сих пор оставляла сюиту зелёной.
 *
 * Поэтому здесь всё идёт настоящим путём нажатия: `term:run` и `term:interrupt`
 * через `dispatch`, а не `interruptTerminal` руками. Подделка терминадо вместо
 * настоящей оболочки — под проверкой порядок команд и то, что уходит в stdin, а
 * настоящий shell эту гонку надёжно не отдаёт.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { getTerminal } from '../shared/notebook.js'
import { OPEN_ROOM } from '../shared/rules.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
// Ни одного статического импорта серверных модулей: config читает JUPYTER_URL
// на импорте, а подделка поднимается в before(). Так же устроен terminal.test.

/* ---------------------------------------------------------- подделка терминадо */

let http: Server
let wss: WebSocketServer
/** Что оболочка получила в stdin. */
let typed: string[] = []
let live: WebSocket | null = null
let minted = 0

before(async () => {
  http = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/terminals') {
      minted += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: String(minted) }))
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end('{}')
  })
  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    if (!/\/terminals\/websocket\//.test(req.url ?? '')) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      live = ws
      ws.send(JSON.stringify(['setup', {}]))
      // Приглашение: сервер по нему считает оболочку устоявшейся.
      ws.send(JSON.stringify(['stdout', '$ ']))
      ws.on('message', (raw: RawData) => {
        const frame = JSON.parse(String(raw)) as [string, string]
        if (frame[0] === 'stdin') typed.push(frame[1])
      })
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  process.env.JUPYTER_URL = `http://127.0.0.1:${port}`
  process.env.JUPYTER_TOKEN = 'fake'
})

after(async () => {
  const { shutdownTerminals } = await import('../server/src/kernel/terminal.js')
  const { shutdownCollab } = await import('../server/src/collab/index.js')
  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(ROOM)
  await shutdownTerminals()
  shutdownCollab()
  live?.terminate()
  wss?.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

/* ------------------------------------------------------------------ помощники */

const ROOM = 'interrupt-room'
/** Тот самый байт, который шлёт Ctrl+C. */
const ETX = '\u0003'
const PETYA = 'p_petya'
const ADA = 'p_ada'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await what()) return true
    await wait(25)
  }
  return false
}

/** Ровно то, что читает `send`: состояние и приём кадра. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string | Buffer) => {
      const message = JSON.parse(String(frame)) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

function who(role: 'host' | 'participant'): TokenPayload {
  return { sessionId: ROOM, participantId: role === 'host' ? ADA : PETYA, role }
}

/** Что сказал пульт в ответ на сообщение. `null` — не сказал ничего. */
async function say(
  role: 'host' | 'participant',
  message: ControlClientMessage,
): Promise<string | null> {
  const { dispatch } = await import('../server/src/control.js')
  const { ws, said } = socket()
  dispatch(ws, ROOM, who(role), message)
  return said[0] ?? null
}

async function transcript(): Promise<{ kind: string; text: string }[]> {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  return getTerminal(getSessionDoc(ROOM).doc)
    .toArray()
    .map((line) => ({
      kind: String(line.get('kind')),
      text: String((line.get('text') as { toString(): string })?.toString() ?? ''),
    }))
}

/* ---------------------------------------------------------------------- тест */

test('студент снимает свою команду, очередь преподавателя остаётся', async () => {
  const { createSession, setRules, upsertParticipant } = await import('../server/src/db.js')
  const { openTerminal } = await import('../server/src/kernel/terminal.js')
  createSession(ROOM, 'Оболочка', null)
  setRules(ROOM, { ...OPEN_ROOM })
  upsertParticipant({ id: PETYA, sessionId: ROOM, name: 'Петя', avatar: null, role: 'participant' })
  upsertParticipant({ id: ADA, sessionId: ROOM, name: 'Ада', avatar: null, role: 'host' })
  await openTerminal(ROOM)
  await wait(500) // прогрев: сервер ждёт первого приглашения
  typed = []

  // Петя запускает своё — своей кнопкой, а не мимо пульта.
  assert.equal(await say('participant', { t: 'term:run', command: 'sleep 30' }), null)
  assert.ok(
    await until(() => typed.some((line) => line.includes('sleep 30'))),
    'команда студента не дошла до оболочки',
  )
  // Преподаватель ставит свою следом — оболочка занята, значит в очередь.
  assert.equal(await say('host', { t: 'term:run', command: 'pytest -q' }), null)
  assert.ok(
    await until(async () => (await transcript()).some((l) => /ждёт свободной оболочки/.test(l.text))),
    'команда преподавателя не встала в очередь',
  )
  typed = []

  // И Петя жмёт «стоп».
  assert.equal(await say('participant', { t: 'term:interrupt' }), null)

  assert.ok(
    await until(() => typed.some((line) => line.includes(ETX))),
    'Ctrl+C не ушёл в оболочку: своя бегущая команда так и идёт',
  )
  const said = await transcript()
  assert.ok(
    said.some((l) => l.kind === 'system' && /Ctrl\+C — команду останавливает Петя/.test(l.text)),
    'комната не узнала, кто остановил команду',
  )
  /*
   * Вот она, развилка: с голым `undefined` вместо `participantId` очередь
   * преподавателя ушла бы вместе со студенческой командой — и сказано об этом
   * было бы вслух, строкой «команда снята из очереди».
   */
  assert.ok(
    !said.some((l) => l.kind === 'system' && /снята из очереди|из очереди снято/.test(l.text)),
    'студент унёс из очереди чужую команду',
  )
  // И это не молчание кода, а живая очередь: оболочка освободилась — пошло то,
  // что в ней стояло.
  live?.send(JSON.stringify(['stdout', '^C\r\n$ ']))
  assert.ok(
    await until(() => typed.some((line) => line.includes('pytest -q'))),
    'команда преподавателя не дождалась своей очереди',
  )
})
