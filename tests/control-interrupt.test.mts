/**
 * Ctrl+C from the control channel: whose command it stops and whose queue it
 * leaves alone.
 *
 * There is one shell per room, and the "stop" button means different things
 * for the teacher and for a student. For the teacher it is "stop everything in
 * this room"; for a student it is "stop my stuck command", and it used to mean
 * the same as for the teacher: a student who interrupted their own
 * `pip install` silently took away everything the teacher had managed to
 * queue. The fork that keeps this apart is one line in the control code
 * (`role === 'host' ? undefined : participantId`), and no test went through it
 * via `dispatch`: the refusal to someone with no running command of their own
 * is checked (control-dispatch), but the ALLOWING half — the very one where
 * someone else's queue got lost — was not. Replacing that line with a bare
 * `undefined` still left the suite green.
 *
 * So here everything goes the real path of a press: `term:run` and
 * `term:interrupt` through `dispatch`, not `interruptTerminal` by hand. A fake
 * terminado stands in for a real shell: what is checked is the order of
 * commands and what goes to stdin, and a real shell does not reproduce this
 * race reliably.
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
// Not a single static import of server modules: config reads JUPYTER_URL on
// import, while the fake starts in before(). terminal.test is built the same
// way.

/* -------------------------------------------------------------- fake terminado */

let http: Server
let wss: WebSocketServer
/** What the shell received on stdin. */
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
      // The prompt: seeing it, the server considers the shell settled.
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

/* -------------------------------------------------------------------- helpers */

const ROOM = 'interrupt-room'
/** The very byte that Ctrl+C sends. */
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

/** Exactly what `send` reads: the state and taking in a frame. */
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

/** What the control said in reply to a message; `null` if it said nothing. */
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

/* ------------------------------------------------------------------ the test */

test("a student stops their own command, the teacher's queue stays", async () => {
  const { createSession, setRules, upsertParticipant } = await import('../server/src/db.js')
  const { openTerminal } = await import('../server/src/kernel/terminal.js')
  createSession(ROOM, 'Оболочка', null)
  setRules(ROOM, { ...OPEN_ROOM })
  upsertParticipant({ id: PETYA, sessionId: ROOM, name: 'Петя', avatar: null, role: 'participant' })
  upsertParticipant({ id: ADA, sessionId: ROOM, name: 'Ада', avatar: null, role: 'host' })
  await openTerminal(ROOM)
  await wait(500) // warm-up: the server waits for the first prompt
  typed = []

  // Petya runs his own command, with his own button, not around the control
  // path.
  assert.equal(await say('participant', { t: 'term:run', command: 'sleep 30' }), null)
  assert.ok(
    await until(() => typed.some((line) => line.includes('sleep 30'))),
    "the student's command did not reach the shell",
  )
  // The teacher sends theirs right after: the shell is busy, so it is queued.
  assert.equal(await say('host', { t: 'term:run', command: 'pytest -q' }), null)
  assert.ok(
    await until(async () => (await transcript()).some((l) => /ждёт свободной оболочки/.test(l.text))),
    "the teacher's command was not queued",
  )
  typed = []

  // And Petya presses "stop".
  assert.equal(await say('participant', { t: 'term:interrupt' }), null)

  assert.ok(
    await until(() => typed.some((line) => line.includes(ETX))),
    'Ctrl+C did not reach the shell: his own running command is still going',
  )
  const said = await transcript()
  assert.ok(
    said.some((l) => l.kind === 'system' && /Ctrl\+C — команду останавливает Петя/.test(l.text)),
    'the room was not told who stopped the command',
  )
  /*
   * Here is the fork: with a bare `undefined` instead of `participantId`, the
   * teacher's queue would have gone along with the student's command — and it
   * would have been said out loud, with the line "команда снята из очереди"
   * (command removed from the queue).
   */
  assert.ok(
    !said.some((l) => l.kind === 'system' && /снята из очереди|из очереди снято/.test(l.text)),
    "the student took someone else's command out of the queue",
  )
  // And this is not the code keeping quiet but a live queue: once the shell is
  // free, whatever was waiting in it runs.
  live?.send(JSON.stringify(['stdout', '^C\r\n$ ']))
  assert.ok(
    await until(() => typed.some((line) => line.includes('pytest -q'))),
    "the teacher's command never got its turn",
  )
})
