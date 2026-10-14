/**
 * The running agent's door for its own commands: `runner drain` and `runner
 * leave` (deploy/vast/colloq-host · drain_runner, runner_leave), which reach
 * it through `docker exec` as another process in the same container.
 *
 * A UNIX SOCKET IN THE TREE (agent.sock, 0600, uid 1000 like the agent): a
 * command connects, says one line of JSON, and reads lines back until the
 * answer it waits for. The socket also says whether an agent runs at all,
 * which a status file cannot: a dead agent's socket file refuses the
 * connection, and `runner leave` in a one-off container (the machine's
 * container stopped) knows to revoke the machine itself rather than wait for
 * an agent that is not there. `runner status` does not come here: the health
 * check asks every 30 s, and reads the status file the agent keeps.
 *
 * A dropped connection is an answer too: an agent that restarted under a
 * drain has forgotten it (draining does not survive a restart), and the
 * command says so and fails, which colloq-host reads as "stop it; its runs go
 * back to the queue".
 */
import fs from 'node:fs'
import net from 'node:net'
import type { Agent } from './sync.js'

export type ControlCommand = 'drain' | 'leave'

/** What the agent says back, one JSON object a line. */
export type ControlMessage =
  | { held: number; state: string }
  | { drained: true }
  | { left: true; revoked?: true }
  | { error: string }

/**
 * Whether an agent answers on this socket. A refused connection (a file left
 * by a dead agent) or no file at all is no agent.
 */
export function agentListening(socket: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket)
    const timer = setTimeout(() => {
      connection.destroy()
      resolve(false)
    }, timeoutMs)
    connection.once('connect', () => {
      clearTimeout(timer)
      connection.end()
      resolve(true)
    })
    connection.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Serve the agent's commands on `socket`. Refuses to start beside another
 * agent on the same tree: two agents on one tree would sweep each other's
 * containers and settle each other's leases.
 */
export async function serveControl(agent: Agent, socket: string): Promise<net.Server> {
  if (await agentListening(socket)) throw new Error(`another agent already runs on ${socket}`)
  fs.rmSync(socket, { force: true })
  const server = net.createServer((connection) => handle(agent, connection))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => {
      server.off('error', reject)
      resolve()
    })
  })
  try {
    fs.chmodSync(socket, 0o600)
  } catch { /* the tree is 0700 anyway */ }
  return server
}

function handle(agent: Agent, connection: net.Socket): void {
  let buffer = ''
  let answered = false
  const say = (message: ControlMessage): void => {
    if (!connection.destroyed) connection.write(`${JSON.stringify(message)}\n`)
  }
  const done = (message: ControlMessage): void => {
    say(message)
    connection.end()
  }
  connection.setEncoding('utf8')
  connection.on('error', () => undefined)
  connection.on('data', (chunk: string) => {
    if (answered) return
    buffer += chunk
    if (buffer.length > 4096) return done({ error: 'that is not a command' })
    const line = buffer.indexOf('\n')
    if (line < 0) return
    answered = true
    let command: unknown
    try {
      command = (JSON.parse(buffer.slice(0, line)) as { command?: unknown }).command
    } catch {
      return done({ error: 'that is not a command' })
    }
    if (command === 'drain') return drain(agent, connection, say, done)
    if (command === 'leave') return leave(agent, connection, say, done)
    done({ error: 'unknown command' })
  })
}

type Say = (message: ControlMessage) => void

/** Drain, then say how many runs are still held each time that changes, until none is. */
function drain(agent: Agent, connection: net.Socket, say: Say, done: Say): void {
  agent.requestDrain()
  let last = -1
  const watch = (): void => {
    const status = agent.status()
    if (status.state === 'stopped' || status.state === 'revoked' || status.state === 'left') {
      agent.off('change', watch)
      return done({ error: `the agent is ${status.state}` })
    }
    if (status.held === 0) {
      agent.off('change', watch)
      return done({ drained: true })
    }
    if (status.held !== last) {
      last = status.held
      say({ held: status.held, state: status.state })
    }
  }
  agent.on('change', watch)
  connection.once('close', () => agent.off('change', watch))
  watch()
}

/** Leave: progress while the runs finish, then the word that the machine has left — after which the agent may go. */
function leave(agent: Agent, connection: net.Socket, say: Say, done: Say): void {
  let last = -1
  const watch = (): void => {
    const status = agent.status()
    if (status.held !== last && status.state !== 'left') {
      last = status.held
      say({ held: status.held, state: status.state })
    }
  }
  agent.on('change', watch)
  watch()
  void agent.requestLeave().then((how) => {
    agent.off('change', watch)
    if (how === 'stopped') return done({ error: 'the agent stopped before it left' })
    // Heard by the one who asked before the agent's process, and its container, go.
    connection.once('close', () => agent.leaveAcknowledged())
    done(how === 'revoked' ? { left: true, revoked: true } : { left: true })
  })
  connection.once('close', () => agent.off('change', watch))
}

/**
 * Send a command to the running agent and pass each line it says to
 * `onMessage` until it ends the connection. `no-agent`: nothing answers on
 * the socket; `lost`: the connection dropped before the answer.
 */
export function askAgent(socket: string, command: ControlCommand, onMessage: (message: ControlMessage) => void): Promise<'answered' | 'no-agent' | 'lost'> {
  return new Promise((resolve) => {
    const connection = net.connect(socket)
    let connected = false
    let answered = false
    let buffer = ''
    connection.setEncoding('utf8')
    connection.once('connect', () => {
      connected = true
      connection.write(`${JSON.stringify({ command })}\n`)
    })
    connection.on('data', (chunk: string) => {
      buffer += chunk
      for (let line = buffer.indexOf('\n'); line >= 0; line = buffer.indexOf('\n')) {
        const text = buffer.slice(0, line)
        buffer = buffer.slice(line + 1)
        try {
          const message = JSON.parse(text) as ControlMessage
          if ('drained' in message || 'left' in message || 'error' in message) answered = true
          onMessage(message)
        } catch { /* not ours */ }
      }
    })
    connection.once('error', () => resolve(connected ? (answered ? 'answered' : 'lost') : 'no-agent'))
    connection.once('close', () => resolve(connected ? (answered ? 'answered' : 'lost') : 'no-agent'))
  })
}
