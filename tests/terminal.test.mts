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
/** Open sockets by pty name: a second one to the same shell is a defect. */
const socketsByName = new Map<string, Set<WebSocket>>()
const socketsTo = (name: string) => socketsByName.get(name)?.size ?? 0
/** Handshake delay: it opens the "reconnect in flight" window. */
let upgradeDelayMs = 0

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
    const name = /\/terminals\/websocket\/([^/?]+)/.exec(req.url ?? '')?.[1] ?? ''
    const accept = () =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        live = ws
        const open = socketsByName.get(name) ?? new Set<WebSocket>()
        open.add(ws)
        socketsByName.set(name, open)
        ws.on('close', () => open.delete(ws))
        ws.send(JSON.stringify(['setup', {}]))
        // A prompt, so the server's priming sees a settled shell.
        ws.send(JSON.stringify(['stdout', '$ ']))
        ws.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as [string, string]
          if (frame[0] !== 'stdin') return
          typed.push(frame[1])
        })
      })
    if (upgradeDelayMs > 0) setTimeout(accept, upgradeDelayMs)
    else accept()
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

/** The very byte Ctrl+C sends. */
const ETX = '\u0003'

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
  const notice = lines().find((l) => l.kind === 'system' && /ждёт свободной оболочки/.test(l.text))
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
    lines().some((l) => l.kind === 'system' && /снята из очереди|из очереди снято/.test(l.text)),
    'the room was not told its command had gone',
  )
})

test('Ctrl+C from someone whose command is not running leaves the running one alone', async () => {
  /*
   * There is one shell in the room, and people come here not only through the
   * button. The Oracle's wait deadline in "do" mode came exactly when its own
   * command was still in the queue — and the ninetieth second of someone
   * else's `pip install` ended with a Ctrl+C into it, while the model was told
   * "did not fit in 90 s — interrupted the run" about a run that never
   * happened.
   *
   * One's own queued commands are still removed: only someone else's running
   * command is left alone.
   */
  const { id, lines } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo mine', who('John'))
  typed = []

  interruptTerminal(id, 'John', 'p_John')
  await wait(300)

  assert.ok(
    !typed.some((t) => t.includes(ETX)),
    'Ctrl+C went into a command this person did not start',
  )
  assert.ok(
    !lines().some((l) => l.kind === 'system' && /Ctrl\+C — команду останавливает/.test(l.text)),
    'the room read that the command was stopped — but it was not',
  )
  assert.ok(
    lines().some((l) => l.kind === 'system' && /снята из очереди|из очереди снято/.test(l.text)),
    'their own waiting command stayed in the queue',
  )
})

test('the host interrupts a command started by someone else: for the host the button means "stop everything"', async () => {
  const { id } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  typed = []

  // Without participantId — this is how the teacher comes in (control.ts ·
  // term:interrupt).
  interruptTerminal(id, 'Ада')
  assert.ok(await until(() => typed.some((t) => t.includes(ETX))), 'Ctrl+C did not go into the shell')
})

test('the Oracle turn is over — its waiting command will not start later on its own', async () => {
  /*
   * A command put in the queue and left there starts a minute later — with no
   * audience, with no one waiting for it and in the middle of a completely
   * different activity. `dropPendingOf` removes one's own, without touching
   * someone else's running one.
   */
  const { id } = await shell()
  const { runCommand, dropPendingOf, terminalBusy } = await import(
    '../server/src/kernel/terminal.js'
  )
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  assert.equal(terminalBusy(id), true, 'busyness is measured by a live command line')

  const seen: { output: string; finished: boolean }[] = []
  runCommand(id, 'python train.py', who('Oracle'), (result) => seen.push(result))
  typed = []

  assert.equal(dropPendingOf(id, 'p_Oracle'), 1)
  // The one waiting is answered right away, not left guessing.
  assert.deepEqual(seen, [{ output: '', finished: false }])

  // The other person's command is intact: neither Ctrl+C nor removal.
  assert.ok(!typed.some((t) => t.includes(ETX)))
  assert.equal(terminalBusy(id), true)

  // And when the shell is free, the removed command will not surface.
  shellSays('done\r\n$ ')
  await wait(400)
  assert.ok(!typed.some((t) => t.includes('train.py')), 'the removed command ran after all')
})

test('a kernel note in the transcript does not release the terminal queue', async () => {
  /*
   * `kernelNote` writes into the same Y.Array bypassing the terminal's
   * bookkeeping, so the next write sees a length mismatch and rebuilds the
   * bookkeeping. Previously the rebuild put out `running` on the live command
   * and zeroed `commandLine` — the "one command at a time" guard stopped
   * holding, and the next command went into the busy shell, and its output was
   * printed under someone else's line.
   */
  const { id, doc, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  const { kernelNote } = await import('../server/src/kernel/index.js')
  runCommand(id, 'python train.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('python train.py'))))
  typed = []

  kernelNote(id, 'A cell failed, so the 3 cells queued behind it were not run.')
  runCommand(id, 'echo ivan', who('Ivan'))
  runCommand(id, 'echo ana', who('Ana'))
  await wait(300)

  assert.deepEqual(typed, [], 'a command went into a shell busy with another command')
  const running = getTerminal(doc)
    .toArray()
    .filter((line) => line.get('kind') === 'command' && line.get('running') === true)
  assert.equal(running.length, 1, 'the live command was declared finished')
  assert.deepEqual(
    lines().filter((l) => l.kind === 'command').map((l) => l.text.trim()),
    ['python train.py'],
    'the queue broke through after all',
  )
})

test('the first command into an unopened terminal keeps the shell busy', async () => {
  /*
   * The "Run file" path with a drawer that was never opened: `dispatch` writes
   * the command line, and `openTerminal` immediately adopts the transcript and
   * puts it out. The phase became `idle` while the script was running, and the
   * next command went into the busy shell without any queue.
   */
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { createSession } = await import('../server/src/db.js')
  const { runCommand, terminalPhase } = await import('../server/src/kernel/terminal.js')
  const id = `term${seq++}`
  createSession(id, `Terminal ${id}`)
  const { doc } = getSessionDoc(id)
  typed = []

  runCommand(id, "python -u 'train.py'", who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('train.py'))), 'the script was not started')
  await wait(200)

  assert.equal(terminalPhase(id), 'busy', 'the shell was declared free while the script was running')
  const running = getTerminal(doc)
    .toArray()
    .filter((line) => line.get('kind') === 'command' && line.get('running') === true)
  assert.equal(running.length, 1, 'the command line stopped counting as running')

  typed = []
  runCommand(id, 'ls', who('Ivan'))
  await wait(300)
  assert.deepEqual(typed, [], 'the second command went into the busy shell')
})

test('Clear in the middle of a running command does not release the shell', async () => {
  /*
   * `Clear` erases the transcript, but not the shell: `pip install` inside
   * keeps running. Previously the command line was lost along with the
   * entries, and the next person to type `ls` sent it straight into the stdin
   * of the running one.
   */
  const { id, lines } = await shell()
  const { runCommand, clearTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'python train.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('python train.py'))))
  clearTerminal(id)
  typed = []

  runCommand(id, 'ls', who('Ivan'))
  await wait(300)
  assert.deepEqual(typed, [], 'the command went into the stdin of the running one')
  const commands = lines().filter((l) => l.kind === 'command')
  assert.equal(commands.length, 1, `the cleared transcript has ${commands.length} commands`)
  assert.match(commands[0].text, /train\.py/, 'the room does not see what exactly is still running')
})

test('a queued command answers whoever is waiting for it', async () => {
  /*
   * The Oracle in "do" mode waits for the `done` callback. Previously
   * `runCommand` put `{ text, by }` in the queue without it: the Oracle waited
   * ninety seconds, then reported that the command did not finish, while it
   * ran on its own a minute later, and the Oracle never saw its output.
   */
  const { id } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  const seen: Array<{ output: string; finished: boolean }> = []
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo oracle', who('Oracle'), (result) => seen.push(result))
  await wait(200)
  assert.equal(seen.length, 0, 'answered before the command started')

  shellSays('done\r\n$ ')
  assert.ok(await until(() => typed.some((t) => t.includes('echo oracle'))), 'the queue did not move')
  shellSays('oracle\r\n$ ')

  assert.ok(await until(() => seen.length === 1), 'the waiting party never got an answer')
  assert.equal(seen[0].finished, true)
  assert.match(seen[0].output, /oracle/)
})

test('the queue does not survive the death of the shell and does not surface in the next one', async () => {
  const { id, lines } = await shell()
  const { runCommand, openTerminal } = await import('../server/src/kernel/terminal.js')
  const seen: Array<{ output: string; finished: boolean }> = []
  runCommand(id, 'python server.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('python server.py'))))
  runCommand(id, 'pip install x', who('Ivan'), (result) => seen.push(result))
  await wait(200)

  // The shell died: `docker restart`, `exit`, Ctrl-D — from outside it is all
  // the same.
  live?.send(JSON.stringify(['disconnect', 1]))
  assert.ok(await until(() => seen.length === 1), 'the waiting party was left hanging on a dead shell')
  assert.equal(seen[0].finished, false)
  assert.ok(
    lines().some((l) => l.kind === 'system' && /снята из очереди|из очереди снято/.test(l.text)),
    `the room was not told whose command was lost: ${JSON.stringify(lines())}`,
  )

  typed = []
  await openTerminal(id)
  await wait(500)
  runCommand(id, 'echo now', who('Ana'))
  assert.ok(await until(() => typed.some((t) => t.includes('echo now'))))
  shellSays('now\r\n$ ')
  await wait(400)
  assert.ok(
    !typed.some((t) => t.includes('pip install x')),
    'a command from the previous shell ran on its own',
  )
})

test('a student removes only their own commands from the queue', async () => {
  /*
   * The `byId` branch is the very one that closed the finding about "a student
   * carries off the teacher's queue". It must be checked separately: the
   * `mine`/`keep` filters can be mixed up, and the host test above will not
   * notice.
   */
  const { id, lines } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo ivan', who('Ivan'))
  runCommand(id, 'echo ana', who('Ana'))
  typed = []

  interruptTerminal(id, 'Ivan', 'p_Ivan')
  await wait(200)
  shellSays('^C\r\n$ ')

  assert.ok(
    await until(() => typed.some((t) => t.includes('echo ana'))),
    'the command from Ana disappeared together with the other one',
  )
  assert.ok(!typed.some((t) => t.includes('echo ivan')), 'the removed command ran after all')
  assert.ok(
    lines().some((l) => l.kind === 'system' && /Ivan — команда снята из очереди/.test(l.text)),
    `the transcript does not say whose command was removed: ${JSON.stringify(lines())}`,
  )
})

test('an output stream does not go into the document megabytes at a time in one window', async () => {
  /*
   * `cat` of a big file produces megabytes in one coalescing window, and every
   * one of them goes out to all thirty tabs — together with the notebook,
   * which lives in the same document. We keep the tail of the window: what is
   * needed is almost always in the last lines.
   */
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'cat big.csv', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('cat big.csv'))))

  const flood = Array.from({ length: 3000 }, (_, i) => `строка ${i} ${'x'.repeat(900)}`)
  shellSays(flood.join('\r\n') + '\r\n')
  await wait(600)

  const text = lines().map((l) => l.text).join('\n')
  assert.ok(text.length < 300_000, `${text.length} characters went into the document`)
  assert.match(text, /строка 2999/, 'the tail of the output was lost — and it is the result')
  assert.doesNotMatch(text, /строка 0 /, 'the start of the stream was kept instead of the tail')
  assert.ok(
    lines().some((l) => l.kind === 'system' && /Превышена скорость обновления вывода/.test(l.text)),
    'nothing was said about the lost output',
  )
})

test('opening the terminal during a reconnect does not create a second socket', async () => {
  /*
   * While `connect` is in flight, `term.socket` is already null, the reconnect
   * timer is cleared, and `opening` was not set — all of `openTerminal`'s
   * guards are empty. A second entry (the Oracle's hands, a command that
   * arrived at exactly that moment) opened a second socket to the same shell:
   * `cd … && clear` into the stdin of a running `pip`, output in the
   * transcript twice and the `idle` phase with a live command.
   */
  const { id } = await shell()
  const { runCommand, openTerminal, terminalPhase } = await import(
    '../server/src/kernel/terminal.js'
  )
  // This room's pty name: the fake hands them out in order, and the last one
  // is this room's.
  const name = String(minted)
  runCommand(id, 'pip install torch', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('pip install torch'))))
  assert.equal(socketsTo(name), 1, 'the fake did not start with a single socket')

  try {
    // The handshake drags on — this is exactly the window in which it broke.
    upgradeDelayMs = 600
    live?.terminate()
    // 500 ms before the reconnect attempt plus the late handshake.
    await wait(700)
    await openTerminal(id)
    await wait(900)
  } finally {
    upgradeDelayMs = 0
  }

  assert.equal(socketsTo(name), 1, `sockets open to one shell: ${socketsTo(name)}`)
  assert.equal(terminalPhase(id), 'busy', 'the running command was declared finished')
})

test('a room cannot stack commands without limit', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  for (let i = 0; i < 12; i++) runCommand(id, `echo q${i}`, who('John'))
  await wait(300)

  const waiting = lines().filter((l) => l.kind === 'system' && /ждёт свободной оболочки/.test(l.text))
  assert.ok(waiting.length <= 8, `${waiting.length} commands were allowed to stack up`)
  assert.ok(
    lines().some((l) => /слишком много команд/.test(l.text)),
    'the room was not told the queue was full',
  )
})
