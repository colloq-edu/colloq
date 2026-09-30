/**
 * The socket doors obey the same Origin rule as every write under /api.
 *
 * The upgrade handler lives in server/src/index.ts, which starts the server
 * on import, so the real process is started here, with the stand-in kernel
 * backend and its own port, and knocked on with a real WebSocket client. A
 * copy of the handler in the test would only prove that the copy works.
 *
 * The role on a socket comes from the teacher's cookie, and a browser sends
 * that cookie with a socket opened by any page of the same site. So a page
 * from another origin is refused on all three paths before the upgrade, even
 * with a valid room token; the page of this server, the dev server on this
 * machine and a client without Origin (curl, tests, the load scripts) get in.
 *
 * The same start also shows the [net] line: what is believed, and the entry
 * that was dropped.
 */
import './_env.mts'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOM = 'ws-origin-room'
const token = signToken({ sessionId: ROOM, participantId: 'p_ws', role: 'participant' })
const filePath = Buffer.from('notes.txt', 'utf8').toString('base64url')
const doors = [`/collab/${ROOM}`, `/control/${ROOM}`, `/file/${ROOM}/${filePath}`]

let port = 0
let child: ChildProcess | null = null
let output = ''

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(chosen))
    })
  })
}

before(async () => {
  // The rows go in before the server starts: it shares this test's data directory (_env.mts).
  createSession(ROOM, 'Origin', null)
  upsertParticipant({ id: 'p_ws', sessionId: ROOM, name: 'Студент', avatar: null, role: 'participant' })
  port = await freePort()
  child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      BIND_ADDR: '127.0.0.1',
      TRUSTED_PROXIES: 'loopback, 10.0.0.300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += chunk))
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/livez`)).ok) break
    } catch {
      /* not listening yet */
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`the server did not come up:\n${output.slice(-4000)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

after(async () => {
  const running = child
  if (!running || running.exitCode !== null) return
  const exited = new Promise<void>((resolve) => running.once('exit', () => resolve()))
  running.kill('SIGTERM')
  const killer = setTimeout(() => running.kill('SIGKILL'), 15_000)
  await exited
  clearTimeout(killer)
})

interface Knock {
  opened: boolean
  status: number | null
  body: string
}

function knock(door: string, origin?: string): Promise<Knock> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${door}?token=${token}`, origin ? { origin } : {})
    const timer = setTimeout(() => {
      ws.terminate()
      resolve({ opened: false, status: null, body: 'no answer' })
    }, 10_000)
    ws.on('open', () => {
      clearTimeout(timer)
      ws.terminate()
      resolve({ opened: true, status: 101, body: '' })
    })
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ opened: false, status: res.statusCode ?? null, body }))
      res.on('error', () => resolve({ opened: false, status: res.statusCode ?? null, body }))
    })
    ws.on('error', () => {
      /* the refusal above already answered */
    })
  })
}

test('a page from another origin is refused on every socket door, before the upgrade', async () => {
  for (const door of doors) {
    for (const origin of ['https://evil.example', `https://other.127.0.0.1.nip.io:${port}`, 'null']) {
      const seen = await knock(door, origin)
      assert.equal(seen.opened, false, `${door} opened for ${origin}`)
      assert.equal(seen.status, 403, `${door} from ${origin}: ${seen.body}`)
      if (origin !== 'null') assert.equal((JSON.parse(seen.body) as { reason: string }).reason, 'forbidden')
    }
  }
})

test('the server\'s own page, the dev server on this machine and a client without Origin get in', async () => {
  for (const door of doors) {
    assert.equal((await knock(door, `http://127.0.0.1:${port}`)).opened, true, `${door} from its own page`)
    assert.equal((await knock(door, 'http://localhost:5173')).opened, true, `${door} from the dev server`)
    assert.equal((await knock(door)).opened, true, `${door} without Origin`)
  }
})

test('the start names what is believed about client addresses, and the entry it dropped', () => {
  assert.match(output, /\[net\] TRUSTED_PROXIES: "10\.0\.0\.300" is not an IP address/)
  assert.match(output, /\[net\] X-Forwarded-For is believed from loopback; CF-Connecting-IP is ignored/)
})
