/**
 * The transcript is a tail, and it is trimmed from the head. One entry is not
 * subject to trimming: the line of the command that is producing output right
 * now.
 *
 * By it — and only by it — `runCommand` decides whether the shell is busy.
 * Output rolls over into a new entry every 32 KB, so the command line quickly
 * becomes the oldest and was the first to go: `forgetEntry` zeroed
 * `commandLine` along with it, the "one command at a time" guard stopped
 * holding, and the next person to type `ls` sent it straight into the stdin of
 * the busy shell. Their bytes went to someone else's `train.py`, the rest of
 * someone else's output was printed under their line, and "X: the command is
 * waiting for the shell" did not appear. Eight hundred lines of output were
 * enough — that is, a single `find /`.
 *
 * Here too is the second half of the same promise: "Ctrl+C: X is stopping
 * the command" is not written until the ETX has actually gone out. Previously
 * the line appeared with a broken channel, while the command in the pty kept
 * running, and the person pressed "stop" into the void.
 *
 * A fake terminado, not a real shell: under test are the order of entries and
 * the guard, and a real shell will not produce the needed race on demand.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'
import { getTerminal } from '../shared/notebook.js'

let http: Server
let wss: WebSocketServer
/** What the fake received in the shell's stdin. */
let typed: string[] = []
let live: WebSocket | null = null
let minted = 0
/** Which ptys the fake was asked to delete: a server restart must not ask for any. */
let deleted: string[] = []

before(async () => {
  http = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/terminals') {
      minted += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: String(minted) }))
      return
    }
    if (req.method === 'DELETE') {
      deleted.push(req.url ?? '')
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
      // A prompt, so that the prime on the other side sees a shell that has
      // settled.
      ws.send(JSON.stringify(['stdout', '$ ']))
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as [string, string]
        if (frame[0] !== 'stdin') return
        typed.push(frame[1])
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
  await shutdownTerminals()
  shutdownCollab()
  live?.terminate()
  wss?.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) return true
    await wait(25)
  }
  return false
}
function shellSays(text: string): void {
  live?.send(JSON.stringify(['stdout', text]))
}

let seq = 0
async function shell() {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { openTerminal } = await import('../server/src/kernel/terminal.js')
  const { createSession } = await import('../server/src/db.js')
  const id = `trim${seq++}`
  createSession(id, `Terminal ${id}`)
  const { doc } = getSessionDoc(id)
  typed = []
  await openTerminal(id)
  await wait(500) // prime
  typed = []
  const lines = () =>
    getTerminal(doc)
      .toArray()
      .map((line) => ({
        kind: String(line.get('kind')),
        name: (line.get('name') as string) ?? null,
        running: line.get('running') === true,
        text: String((line.get('text') as { toString(): string })?.toString() ?? ''),
      }))
  return { id, doc, lines }
}

const who = (name: string) => ({ name, color: '#7e82f0', participantId: `p_${name}` })

test('trimming the transcript does not throw out the line of the running command', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')

  runCommand(id, 'find / -name "*.py"', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('find /'))), 'the command was not sent')
  typed = []

  /*
   * Six coalescing windows of ~39 KB: each fits in MAX_FLUSH_CHARS, together
   * they go past both 200 KB and 800 lines, and they roll out into 32 KB
   * entries — exactly the case where trimming started eating the head.
   */
  const burst = Array.from({ length: 300 }, (_, i) => `/usr/lib/python3/${'x'.repeat(110)}/${i}`).join('\n') + '\n'
  for (let i = 0; i < 6; i++) {
    shellSays(burst)
    await wait(120)
  }
  await wait(200)

  const kept = lines()
  assert.ok(kept.length < 40, `the transcript was not trimmed at all: ${kept.length} entries`)
  const command = kept.find((l) => l.kind === 'command')
  assert.ok(command, `trimming threw out the line of the running command:\n${JSON.stringify(kept.slice(0, 3))}`)
  assert.equal(command.name, 'Maria')
  assert.equal(command.running, true, 'the running command stopped counting as running')

  // And, most importantly, the consequence: someone else's command gets queued
  // instead of going into the busy shell.
  runCommand(id, 'ls', who('John'))
  await wait(300)
  assert.deepEqual(typed, [], 'the command from John was sent to a shell that is still busy')
  const notice = lines().find((l) => l.kind === 'system' && /ждёт свободной оболочки/.test(l.text))
  assert.ok(notice, 'the room did not learn that the command is waiting')
  assert.match(notice.text, /John/)
})

test('Ctrl+C over a broken channel is not announced as sent', async () => {
  const { id, lines } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')

  runCommand(id, 'sleep 300', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 300'))))
  typed = []

  // The channel to Jupyter breaks — the pty inside the container keeps
  // running.
  live?.terminate()
  await wait(150)

  interruptTerminal(id, 'Maria', 'p_Maria')
  const said = lines().filter((l) => l.kind === 'system')
  assert.ok(
    said.some((l) => /Ctrl\+C до неё ещё не дошёл/.test(l.text)),
    `the room was not told that Ctrl+C did not go out:\n${JSON.stringify(said)}`,
  )

  // And the promise is kept: the ETX goes out as soon as the channel is back.
  assert.ok(
    await until(() => typed.some((t) => t.includes('\u0003'))),
    'the ETX never reached the shell after the reconnect',
  )
})

test('a server restart does not kill the shell — and comes back into it', async () => {
  const { id, lines } = await shell()
  const { runCommand, openTerminal, shutdownTerminals } = await import(
    '../server/src/kernel/terminal.js'
  )

  runCommand(id, 'python train.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('train.py'))), 'the command was not sent')

  /*
   * `make run` after an edit — what the Makefile advises doing all the time.
   * The kernel survives it on purpose (shutdownKernels), while the terminal
   * used to send DELETE and kill the pty together with a three-hour training
   * run inside.
   */
  const pty = minted
  deleted = []
  typed = []
  await shutdownTerminals()
  assert.deepEqual(deleted, [], 'the shell was deleted together with the server — the training inside died')

  await openTerminal(id)
  await wait(900) // prime + polling the shell
  assert.equal(minted, pty, 'after the restart a new shell was created instead of the old one')

  const command = lines().find((l) => l.kind === 'command' && /train\.py/.test(l.text))
  assert.ok(command, 'the command line disappeared from the transcript')
  assert.equal(
    command.running,
    true,
    'a command running in a pty that survived the restart was declared finished — ' +
      'the "one command at a time" guard does not hold after a restart',
  )

  // And the next command honestly waits instead of going into the busy shell.
  typed = []
  runCommand(id, 'ls', who('John'))
  await wait(300)
  assert.deepEqual(typed, [], 'the command from John was sent into a shell where another participant is training')
})
