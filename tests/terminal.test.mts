/**
 * One shell, and a room full of people who can all type into it.
 *
 * A command sent while another is running used to be pushed straight at the
 * shell, which buffers what it cannot run and echoes it back in its own time.
 * The transcript that came out was unreadable: the first person's last line of
 * output printed *underneath* the second person's command, and the second
 * command appeared twice — once as we wrote it, once as the shell echoed it.
 *
 * A fake terminado rather than a real one, because what is under test is the
 * order things are written in, and a real shell will not reliably hand you the
 * race that caused the problem.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'
import { getTerminal } from '../shared/notebook.js'
// Every server module reaches config on import, and config reads JUPYTER_URL at
// module scope — so nothing that touches it may be imported before before()
// points it at the fake. An earlier version imported db.js at the top and the
// suite quietly drove a real Jupyter instead.

/* ---------------------------------------------------------- fake terminado */

let http: Server
let wss: WebSocketServer
/** The shell's stdin, as the fake received it. */
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
      // A prompt, so the server's priming sees a settled shell.
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

/* ------------------------------------------------------------------ helpers */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) return true
    await wait(25)
  }
  return false
}
/** What the fake shell says back when it runs something. */
function shellSays(text: string): void {
  live?.send(JSON.stringify(['stdout', text]))
}

let seq = 0
async function shell() {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { openTerminal } = await import('../server/src/kernel/terminal.js')
  const { createSession } = await import('../server/src/db.js')
  const id = `term${seq++}`
  createSession(id, `Terminal ${id}`)
  const { doc } = getSessionDoc(id)
  typed = []
  await openTerminal(id)
  await wait(500) // priming
  typed = []
  const lines = () =>
    getTerminal(doc)
      .toArray()
      .map((line) => ({
        kind: String(line.get('kind')),
        name: (line.get('name') as string) ?? null,
        text: String((line.get('text') as { toString(): string })?.toString() ?? ''),
      }))
  return { id, doc, lines }
}

const who = (name: string) => ({ name, color: '#7e82f0', participantId: `p_${name}` })

/* -------------------------------------------------------------------- tests */

test('one person, one command, one line in the transcript', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'echo hello', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('echo hello'))), 'the shell was never told')
  const commands = lines().filter((l) => l.kind === 'command')
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'Maria')
})

test('a second command waits instead of being pushed at a busy shell', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  typed = []

  runCommand(id, 'echo mine', who('John'))
  await wait(300)
  assert.deepEqual(typed, [], "John's command was sent to a shell that was still busy")

  // The room is told, and told whose it is.
  const notice = lines().find((l) => l.kind === 'system' && /waiting for the shell/.test(l.text))
  assert.ok(notice, `no notice: ${JSON.stringify(lines())}`)
  assert.match(notice.text, /John/)

  // No command line for it yet: the transcript is the order things ran.
  assert.deepEqual(
    lines().filter((l) => l.kind === 'command').map((l) => l.name),
    ['Maria'],
  )
})

test('the waiting command runs, in order, once the shell is free', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo second', who('John'))
  runCommand(id, 'echo third', who('Ana'))
  typed = []

  // The shell finishes and offers a prompt.
  shellSays('done\r\n$ ')
  assert.ok(
    await until(() => typed.some((t) => t.includes('echo second'))),
    'the queue never moved',
  )
  shellSays('second\r\n$ ')
  assert.ok(await until(() => typed.some((t) => t.includes('echo third'))), 'only one moved')

  assert.deepEqual(
    lines().filter((l) => l.kind === 'command').map((l) => l.text.trim()),
    ['sleep 30', 'echo second', 'echo third'],
  )
})

test('interrupting drops what was waiting, and says so', async () => {
  const { id, lines } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo never', who('John'))
  typed = []

  interruptTerminal(id)
  await wait(200)
  shellSays('^C\r\n$ ')
  await wait(400)

  assert.ok(
    !typed.some((t) => t.includes('echo never')),
    'a command the room had cancelled ran anyway',
  )
  assert.ok(
    lines().some((l) => l.kind === 'system' && /dropped/.test(l.text)),
    'the room was not told its command had gone',
  )
})

test('a room cannot stack commands without limit', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  for (let i = 0; i < 12; i++) runCommand(id, `echo q${i}`, who('John'))
  await wait(300)

  const waiting = lines().filter((l) => l.kind === 'system' && /waiting for the shell/.test(l.text))
  assert.ok(waiting.length <= 8, `${waiting.length} commands were allowed to stack up`)
  assert.ok(
    lines().some((l) => /too many commands/.test(l.text)),
    'the room was not told the queue was full',
  )
})
