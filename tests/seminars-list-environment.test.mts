/**
 * A class's environment on the classes list (0.25): seen in its row, and
 * changed from its settings window.
 *
 * The owner's words: «видеть хотя бы окружение занятия какое в списке
 * занятий, в идеале изменять». The list carries the environment the class
 * is set to (and whether it asks for a GPU); the PATCH moves it, with
 * creation's check and two more the creation form makes by itself — the
 * image is built, and a GPU environment has a card on this machine — and
 * writes it to the audit log.
 *
 * And only while no kernel of the class runs. The pool keeps no running
 * container on an image other than its row's: the next time it resolves the
 * class's address (a server restart, a failed start, a failed shell) it
 * removes the container with every notebook's variables, and under the
 * broker a new revision replaces the pod just the same. So the move is
 * refused while anything of the class is up — by this process's scopes and
 * by what actually runs (`docker ps`, the broker's rooms), which is what
 * outlives a server restart — and the class's next start comes up on the
 * new environment. Pinned here on the test backend (which records the
 * environment a start asked for), on Docker (the image `docker run` is
 * given, and that a running container is never removed), and under the
 * runtime broker (the pin follows the environment; a pod left up by a
 * restart still counts).
 *
 * Three fakes: Jupyter for the kernels, docker for which environments are
 * built (environments.ts asks it) and for the class's containers, and a
 * broker. The environments are this file's own, in a state directory of its
 * own: a checkout's shipped lists carry build stamps and a `.env` of whoever
 * runs the suite, and neither may decide what is "built" or "the default"
 * here.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import cp from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import { guardAnswer } from './_guard.mts'
import { TEST_ROOT } from './_env.mts'
import { translate } from '../shared/i18n.js'
import type { AdminErrorBody, AdminSeminar, EnvironmentsState, SeminarKernelState } from '../shared/admin.js'

/* ------------------------------------------------------- the environments */

/*
 * Before any server module: the state directory decides where environments
 * are read from (environments.ts · stateHome), and dotenv, loaded with the
 * config, would fill KERNEL_ENV and the card lists from the checkout's .env
 * — it leaves a variable alone once it is set.
 */
const HOME = path.join(TEST_ROOT, 'env-home')
fs.mkdirSync(path.join(HOME, 'environments'), { recursive: true })
const LISTS: Record<string, string> = {
  'xb-plain': '# A plain class environment.\nrich\n',
  'xb-data': '# Another one, for a class that moves.\npolars\n',
  'xb-gpu': '# colloq: gpu\ntorch\n',
  'xb-unbuilt': '# Written down, never built.\nduckdb\n',
}
for (const [name, list] of Object.entries(LISTS)) {
  fs.writeFileSync(path.join(HOME, 'environments', `${name}.txt`), list)
}
Object.assign(process.env, { COLLOQ_HOME: HOME, KERNEL_ENV: 'xb-plain', KERNEL_GPUS: '', COMPETITION_GPUS: '' })
/** After the lists were written, so none of them reads as edited since its build. */
const BUILT_AT = new Date(Date.now() + 60_000).toISOString()

/* ------------------------------------------------------------ fake Jupyter */

/* Only what a kernel needs to come up and take its guard: sessions, the alive check, the channels. */
let minted = 0
/** Classes whose kernel sessions this Jupyter refuses: a 403 fails a start at once (jupyter.ts · connect). */
const refusing = new Set<string>()

function reply(ws: WebSocket, parent: unknown, msgType: string, content: unknown): void {
  ws.send(
    JSON.stringify({
      header: { msg_id: `m_${Math.random().toString(36).slice(2)}`, msg_type: msgType },
      parent_header: parent,
      metadata: {},
      content,
      channel: msgType.endsWith('_reply') ? 'shell' : 'iopub',
    }),
  )
}

const jupyter: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if ([...refusing].some((id) => raw.includes(id))) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end('{"message":"refused"}')
        return
      }
      const id = `k_${++minted}`
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `s_${id}`, kernel: { id } }))
    })
    return
  }
  if (req.method === 'GET' && /^\/api\/kernels\/[^/]+$/.test(url.pathname)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ execution_state: 'idle' }))
    return
  }
  if (req.method === 'DELETE') {
    res.writeHead(204).end()
    return
  }
  res.writeHead(404).end('{}')
})
const channels = new WebSocketServer({ noServer: true })
jupyter.on('upgrade', (req, socket, head) => {
  channels.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { header: { msg_type: string }; content: { code: string } }
      if (msg.header.msg_type !== 'execute_request') return
      reply(ws, msg.header, 'status', { execution_state: 'busy' })
      const guard = guardAnswer(msg.content.code)
      reply(ws, msg.header, 'execute_reply', {
        status: 'ok',
        execution_count: 1,
        ...(guard
          ? { user_expressions: { colloq: { status: 'ok', data: { 'text/plain': JSON.stringify(guard) }, metadata: {} } } }
          : {}),
      })
      reply(ws, msg.header, 'status', { execution_state: 'idle' })
    })
  })
})
await new Promise<void>((resolve) => jupyter.listen(0, '127.0.0.1', resolve))
const JUPYTER = `http://127.0.0.1:${(jupyter.address() as { port: number }).port}`
// Before any server module: config reads the address at import.
process.env.JUPYTER_URL = JUPYTER
process.env.JUPYTER_TOKEN = 'fake'

const { call, staffMember, startApp } = await import('./_scoping.mts')
const kernel = await import('../server/src/kernel/index.js')
const { createSession, sessionEnvironment, sessionKernelRevision } = await import('../server/src/db.js')
const { listAdminEvents } = await import('../server/src/admin/audit-log.js')
const { shutdownCollab } = await import('../server/src/collab/index.js')
const { dropRoomKernel, endpointForSession, forgetSessionKernel } = await import('../server/src/kernel/pool.js')
const { forgetPerimeter, roomProfile } = await import('../server/src/kernel/perimeter.js')
const { forgetResources, useDockerInfo } = await import('../server/src/kernel/resources.js')
const { fakeDocker } = await import('./_fake-docker.mts')
const { chosenEnvironment, chosenNote, environmentBar, gpuBar } = await import('../web/src/admin/seminar-environment.js')

const app = await startApp()
const owner = staffMember('Владелец', 'owner')
const teacher = staffMember('Мария Преподаватель')
const stranger = staffMember('Олег Другой')

after(async () => {
  app.close()
  // Every kernel a failed test left up, too: its socket would hold the fake open.
  await kernel.shutdownKernels()
  shutdownCollab()
  for (const socket of channels.clients) socket.terminate()
  channels.close()
  jupyter.close()
})

/* ------------------------------------------------ which images are built */

const factsOf = (image: string, names: readonly string[]): string | null =>
  names.includes(image.replace(/^colloq-kernel:/, '')) ? `1500000000\n${BUILT_AT}\n` : null

let restoreImages: (() => void) | null = null

/**
 * Docker for environments.ts alone: `image inspect` names a built image for
 * the environments given and nothing else. Every other docker call fails, as
 * on a machine without a daemon: the test backend has no containers to ask.
 */
function built(...names: string[]): void {
  restoreImages?.()
  const real = cp.spawn
  cp.spawn = ((command: string, args: readonly string[], options?: object) => {
    if (command !== 'docker') return real(command, args as string[], options as never)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const facts = args[0] === 'image' && args[1] === 'inspect' ? factsOf(String(args[2]), names) : null
    process.nextTick(() => {
      if (facts) child.stdout.emit('data', Buffer.from(facts))
      child.emit('close', facts ? 0 : 1)
    })
    return child
  }) as unknown as typeof cp.spawn
  syncBuiltinESMExports()
  restoreImages = () => {
    cp.spawn = real
    syncBuiltinESMExports()
    restoreImages = null
  }
}

afterEach(() => {
  restoreImages?.()
  refusing.clear()
  process.env.KERNEL_GPUS = ''
})

/* ---------------------------------------------------------------- doors */

async function room(cookie: string, name: string, environment?: string): Promise<AdminSeminar> {
  const res = await call(app.base, 'POST', '/api/admin/seminars', {
    cookie,
    body: { name, ...(environment ? { environment } : {}) },
  })
  assert.equal(res.status, 201)
  return (await res.json()) as AdminSeminar
}

function move(cookie: string, id: string, environment: unknown): Promise<globalThis.Response> {
  return call(app.base, 'PATCH', `/api/admin/seminars/${id}`, { cookie, body: { environment } })
}

async function kernelOf(cookie: string, id: string): Promise<SeminarKernelState> {
  const res = await call(app.base, 'GET', `/api/admin/seminars/${id}/kernel`, { cookie })
  assert.equal(res.status, 200)
  return (await res.json()) as SeminarKernelState
}

async function rowOf(cookie: string, id: string, scope: 'mine' | 'all' = 'mine'): Promise<AdminSeminar> {
  const res = await call(app.base, 'GET', scope === 'all' ? '/api/admin/seminars?scope=all' : '/api/admin/seminars', { cookie })
  assert.equal(res.status, 200)
  const found = ((await res.json()) as AdminSeminar[]).find((row) => row.id === id)
  assert.ok(found, `${id} is on the list`)
  return found
}

const moves = (id: string) =>
  listAdminEvents({ limit: 500 }).events.filter(
    (event) => event.action === 'room.environment_changed' && event.target?.id === id,
  )

/** Whether a refusal is the words of `key`, in whichever of the two languages the server speaks. */
const said = (error: string, key: string, params?: Record<string, string>): boolean =>
  error === translate('ru', key, params) || error === translate('en', key, params)

/** A refusal of a move because the class's kernel runs: the reason the window locks on. */
async function lockedOut(res: globalThis.Response, key: string): Promise<void> {
  assert.equal(res.status, 409)
  const body = (await res.json()) as AdminErrorBody
  assert.equal(body.reason, 'kernel_running')
  assert.ok(said(body.error, key), body.error)
}

/* ---------------------------------------------------------------- list */

test('the list names each class’s environment, as the class is set, with its GPU flag', async () => {
  const plain = await room(owner.cookie, 'Линейные модели', 'xb-data')
  const gpu = await room(owner.cookie, 'Нейросети', 'xb-gpu')
  // A room made before environments existed: no name in its row. It starts
  // on the instance's default, and the list says which that is.
  createSession('env-legacy-room', 'Старое занятие', null)

  const rows = await Promise.all([
    rowOf(owner.cookie, plain.id),
    rowOf(owner.cookie, gpu.id),
    // Nobody teaches it: the owner's «Все» lists it.
    rowOf(owner.cookie, 'env-legacy-room', 'all'),
  ])
  assert.deepEqual(
    rows.map((row) => [row.chosenEnvironment, row.chosenEnvironmentGpu]),
    [
      ['xb-data', false],
      ['xb-gpu', true],
      ['xb-plain', false],
    ],
  )
  // No kernel has started: what the room is set to is all there is.
  assert.equal(rows[0]!.environment, 'xb-data')
  assert.equal(chosenEnvironment(rows[1]!), 'xb-gpu')
})

/* ---------------------------------------------------------------- move */

test('a class whose kernel runs is not moved; once it stops, the move goes through and the next start is on the new one', async () => {
  const made = await room(owner.cookie, 'Факультатив', 'xb-plain')
  await kernel.ensureKernel(made.id)
  assert.equal(kernel.environmentOf(made.id), 'xb-plain')
  built('xb-plain', 'xb-data')
  assert.deepEqual(await kernelOf(owner.cookie, made.id), { running: true })

  await lockedOut(await move(owner.cookie, made.id, 'xb-data'), 'server.seminar.environmentKernelRunning')
  assert.equal(sessionEnvironment(made.id), 'xb-plain')
  assert.equal(moves(made.id).length, 0)
  // The kernel is the one it was, with its variables.
  await kernel.ensureKernel(made.id)
  assert.equal(kernel.environmentOf(made.id), 'xb-plain')

  // The class stops (the idle sweep does exactly this), and the move goes through.
  await kernel.shutdownSession(made.id)
  assert.deepEqual(await kernelOf(owner.cookie, made.id), { running: false })
  const res = await move(owner.cookie, made.id, 'xb-data')
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as AdminSeminar).chosenEnvironment, 'xb-data')
  assert.equal(sessionEnvironment(made.id), 'xb-data')

  await kernel.ensureKernel(made.id)
  assert.equal(kernel.environmentOf(made.id), 'xb-data')
  const row = await rowOf(owner.cookie, made.id)
  assert.deepEqual([row.environment, row.chosenEnvironment], ['xb-data', 'xb-data'])
  await kernel.shutdownSession(made.id)
})

test('the refusal says who can stop the kernel: the owner is told of the Resources tab, a teacher to ask the owner', async () => {
  const made = await room(teacher.cookie, 'Консультация по SQL', 'xb-plain')
  await kernel.ensureKernel(made.id)
  built('xb-plain', 'xb-data')
  try {
    await lockedOut(await move(teacher.cookie, made.id, 'xb-data'), 'server.seminar.environmentKernelRunningAsk')
    await lockedOut(await move(owner.cookie, made.id, 'xb-data'), 'server.seminar.environmentKernelRunning')
  } finally {
    await kernel.shutdownSession(made.id)
  }
})

test('a start that failed holds nothing: the class is not locked, and its next start comes up on the new one', async () => {
  const made = await room(teacher.cookie, 'Не запустилось', 'xb-plain')
  refusing.add(made.id)
  await assert.rejects(kernel.ensureKernel(made.id))
  // The scope stays, with the environment it asked for, and runs nothing.
  assert.equal(kernel.kernelClasses().includes(made.id), false)
  built('xb-plain', 'xb-data')
  assert.deepEqual(await kernelOf(teacher.cookie, made.id), { running: false })

  const res = await move(teacher.cookie, made.id, 'xb-data')
  assert.equal(res.status, 200)
  assert.equal(sessionEnvironment(made.id), 'xb-data')
  refusing.clear()
  await kernel.ensureKernel(made.id)
  assert.equal(kernel.environmentOf(made.id), 'xb-data')
  await kernel.shutdownSession(made.id)
})

test('the move is in the audit log: who, which class, from and to', async () => {
  const made = await room(teacher.cookie, 'Консультация', 'xb-plain')
  built('xb-plain', 'xb-data')
  assert.equal((await move(teacher.cookie, made.id, 'xb-data')).status, 200)
  const [event, ...more] = moves(made.id)
  assert.equal(more.length, 0)
  assert.equal(event!.actor?.id, teacher.teacher.id)
  assert.deepEqual(event!.target, { type: 'room', id: made.id, label: 'Консультация' })
  assert.deepEqual(event!.detail, { from: 'xb-plain', to: 'xb-data' })

  // The same name again is no move: no row, no check — even with nothing built.
  built()
  const again = await move(teacher.cookie, made.id, 'xb-data')
  assert.equal(again.status, 200)
  assert.equal(moves(made.id).length, 1)
})

/* ------------------------------------------------------------ refusals */

test('an unknown name, an unbuilt environment and a GPU one with no card for classes are refused, and nothing moves', async () => {
  const made = await room(owner.cookie, 'Отказы', 'xb-plain')
  built('xb-plain', 'xb-gpu')
  const refused = async (environment: unknown, status: number, words: RegExp): Promise<void> => {
    const res = await move(owner.cookie, made.id, environment)
    assert.equal(res.status, status, JSON.stringify(environment))
    const body = (await res.json()) as AdminErrorBody
    assert.match(body.error, words, JSON.stringify(environment))
    assert.equal(sessionEnvironment(made.id), 'xb-plain')
  }
  await refused('no-such-env', 400, /no-such-env/)
  await refused('../xb-data', 400, /\.\.\/xb-data/)
  await refused(42, 400, /./)
  await refused('', 400, /./)
  // Written down, not built: a room on it would have no kernel at all.
  await refused('xb-unbuilt', 409, /xb-unbuilt/)
  // Built, but asks for a GPU, and KERNEL_GPUS gives classes none.
  await refused('xb-gpu', 409, /KERNEL_GPUS/)
  assert.equal(moves(made.id).length, 0)

  // Building is the owner's: a teacher is told to choose another or ask.
  const hers = await room(teacher.cookie, 'Отказ преподавателю', 'xb-plain')
  const res = await move(teacher.cookie, hers.id, 'xb-unbuilt')
  assert.equal(res.status, 409)
  const body = (await res.json()) as AdminErrorBody
  assert.ok(said(body.error, 'server.seminar.environmentNotBuiltAsk', { p0: 'xb-unbuilt' }), body.error)

  // With a card for classes the same move goes through.
  process.env.KERNEL_GPUS = '0'
  const gpu = await move(owner.cookie, made.id, 'xb-gpu')
  assert.equal(gpu.status, 200)
  const moved = (await gpu.json()) as AdminSeminar
  assert.deepEqual([moved.chosenEnvironment, moved.chosenEnvironmentGpu], ['xb-gpu', true])
})

test('a teacher without the class is refused as for a class that does not exist', async () => {
  const made = await room(teacher.cookie, 'Чужое для Олега', 'xb-plain')
  built('xb-plain', 'xb-data')
  const res = await move(stranger.cookie, made.id, 'xb-data')
  assert.equal(res.status, 404)
  assert.equal(sessionEnvironment(made.id), 'xb-plain')
  assert.equal(moves(made.id).length, 0)
  // Nor is she told whether its kernel runs.
  const asked = await call(app.base, 'GET', `/api/admin/seminars/${made.id}/kernel`, { cookie: stranger.cookie })
  assert.equal(asked.status, 404)
})

test('a refused move leaves the rest of the request unwritten too', async () => {
  const made = await room(owner.cookie, 'Название до', 'xb-plain')
  built('xb-plain')
  const res = await call(app.base, 'PATCH', `/api/admin/seminars/${made.id}`, {
    cookie: owner.cookie,
    body: { name: 'Название после', environment: 'xb-unbuilt' },
  })
  assert.equal(res.status, 409)
  assert.equal((await rowOf(owner.cookie, made.id)).name, 'Название до')
})

/* -------------------------------------------------------------- Docker */

interface DockerClass {
  fake: ReturnType<typeof fakeDocker>
  /** Whether a container was removed while it ran: the loss the rule exists to prevent. */
  removedRunning: () => boolean
  /** The images `docker run` was given for the class's own container. */
  runs: (id: string) => string[]
  done: () => void
}

/**
 * Docker with enough of a daemon for the pool to keep or replace a class's
 * container by its image: the image id of each built tag, the image each
 * container was started from, its profile, network and slice. The class's
 * `/api/status` answers, and its session is refused (a 403 ends a start at
 * once), so a kernel start made here settles fast.
 */
function dockerClass(): DockerClass {
  const fake = fakeDocker()
  const imageOf = new Map<string, string>()
  const networkOf = new Map<string, string>()
  const builtNames = ['xb-plain', 'xb-data']
  let removedRunning = false
  fake.intercept = (args) => {
    // environments.ts: which images are built (state 'ready').
    if (args[0] === 'image' && args[1] === 'inspect' && args.at(-1)?.includes('.Size')) {
      const facts = factsOf(args[2]!, builtNames)
      return facts ? { code: 0, out: facts } : { code: 1, out: 'Error: No such image' }
    }
    // pool.ts · imageExists, sameImage: the tag's image id.
    if (args[0] === 'image' && args[1] === 'inspect' && args.at(-1) === '{{.Id}}') {
      const name = args[2]!.replace(/^colloq-kernel:/, '')
      return builtNames.includes(name) ? { code: 0, out: `sha256:${name}` } : { code: 1, out: 'Error: No such image' }
    }
    if (args[0] === 'run' && args.includes('--name')) {
      const name = args[args.indexOf('--name') + 1]!
      const image = args.find((arg) => arg.startsWith('colloq-kernel:'))!
      imageOf.set(name, `sha256:${image.replace(/^colloq-kernel:/, '')}`)
      networkOf.set(name, args.includes('--network') ? args[args.indexOf('--network') + 1]! : '')
      return undefined
    }
    if (args[0] === 'inspect' && args[1]?.startsWith('colloq-room-') && args[2] === '--format') {
      const name = args[1]!
      const format = args[3]!
      if (!fake.containers.has(name)) return undefined
      if (format === '{{.Image}}') return { code: 0, out: imageOf.get(name) ?? '' }
      if (format.includes('colloq.profile')) return { code: 0, out: roomProfile() }
      if (format.includes('colloq.gpu')) return { code: 0, out: '' }
      if (format === '{{.HostConfig.NetworkMode}}') return { code: 0, out: networkOf.get(name) ?? '' }
      return undefined
    }
    if (args[0] === 'rm' && fake.containers.get(args.at(-1)!)?.running) removedRunning = true
    return undefined
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith('http://colloq-room-')) return realFetch(input, init)
    const refused = new URL(url).pathname === '/api/sessions'
    return Promise.resolve(new Response('{}', { status: refused ? 403 : 200 }))
  }) as typeof fetch
  useDockerInfo(async () => ({ code: 0, out: `${64 * 1024 ** 3} 16` }))
  forgetResources()
  forgetPerimeter()
  return {
    fake,
    removedRunning: () => removedRunning,
    runs: (id) =>
      fake.calls
        .filter((args) => args[0] === 'run' && args[args.indexOf('--name') + 1] === `colloq-room-${id}`)
        .map((args) => args.find((arg) => arg.startsWith('colloq-kernel:'))!),
    done: () => {
      globalThis.fetch = realFetch
      fake.restore()
      useDockerInfo(null)
      forgetResources()
      forgetPerimeter()
    },
  }
}

test('on Docker a class whose container runs is not moved, though this process holds no kernel of it', async () => {
  const docker = dockerClass()
  const made = await room(owner.cookie, 'В контейнере', 'xb-plain')
  try {
    // Brought up by the pool alone: exactly what a server restart leaves —
    // the container and its kernels running, no scope in this process.
    await endpointForSession(made.id, sessionEnvironment(made.id))
    assert.deepEqual(docker.runs(made.id), ['colloq-kernel:xb-plain'])
    assert.deepEqual(kernel.kernelClasses(), [])
    assert.deepEqual(await kernelOf(owner.cookie, made.id), { running: true })

    await lockedOut(await move(owner.cookie, made.id, 'xb-data'), 'server.seminar.environmentKernelRunning')
    assert.equal(sessionEnvironment(made.id), 'xb-plain')

    // The pool resolves the class again, as after any failed start or shell:
    // the running container is the class's still, and nobody loses a thing.
    forgetSessionKernel(made.id)
    await endpointForSession(made.id, sessionEnvironment(made.id))
    assert.deepEqual(docker.runs(made.id), ['colloq-kernel:xb-plain'])
    assert.equal(docker.removedRunning(), false)

    // The container stops (a machine reboot leaves it exited, and the pool's
    // address of it goes with the first refused call): now the class moves,
    // and its next start replaces the stopped container from the new image.
    docker.fake.containers.get(`colloq-room-${made.id}`)!.running = false
    forgetSessionKernel(made.id)
    assert.deepEqual(await kernelOf(owner.cookie, made.id), { running: false })
    assert.equal((await move(owner.cookie, made.id, 'xb-data')).status, 200)
    await endpointForSession(made.id, sessionEnvironment(made.id))
    assert.deepEqual(docker.runs(made.id), ['colloq-kernel:xb-plain', 'colloq-kernel:xb-data'])
    assert.equal(docker.removedRunning(), false)
  } finally {
    await dropRoomKernel(made.id).catch(() => {})
    docker.done()
  }
})

test('on Docker a class whose personal notebooks run is not moved either', async () => {
  const docker = dockerClass()
  const made = await room(owner.cookie, 'Личные тетради', 'xb-plain')
  try {
    await endpointForSession(made.id, sessionEnvironment(made.id), 'own')
    await lockedOut(await move(owner.cookie, made.id, 'xb-data'), 'server.seminar.environmentKernelRunning')
    assert.equal(sessionEnvironment(made.id), 'xb-plain')
  } finally {
    await dropRoomKernel(made.id).catch(() => {})
    docker.done()
  }
})

test('a census docker does not answer is not «nothing runs»: the move is refused in words, and nothing moves', async () => {
  const docker = dockerClass()
  const made = await room(owner.cookie, 'Без ответа', 'xb-plain')
  const intercept = docker.fake.intercept!
  docker.fake.intercept = (args) =>
    args[0] === 'ps' ? { code: 1, out: 'Cannot connect to the Docker daemon' } : intercept(args)
  try {
    const res = await move(owner.cookie, made.id, 'xb-data')
    assert.equal(res.status, 503)
    assert.ok(said(((await res.json()) as AdminErrorBody).error, 'server.seminar.environmentKernelUnknown'))
    assert.equal(sessionEnvironment(made.id), 'xb-plain')
    assert.deepEqual(await kernelOf(owner.cookie, made.id), { running: null })
  } finally {
    docker.done()
  }
})

test('a kernel start that begins while the census is read is caught before the write', async () => {
  const docker = dockerClass()
  const made = await room(owner.cookie, 'Гонка', 'xb-plain')
  const intercept = docker.fake.intercept!
  let started: Promise<void> | null = null
  docker.fake.intercept = (args) => {
    // A student presses Run at the very moment the census asks docker: the
    // start reads the row as it still is, the old environment. It fails
    // later on its own (the fake refuses the session), which is no matter.
    if (args[0] === 'ps' && !started) {
      started = kernel.ensureKernel(made.id)
      started.catch(() => {})
    }
    return intercept(args)
  }
  try {
    await lockedOut(await move(owner.cookie, made.id, 'xb-data'), 'server.seminar.environmentKernelRunning')
    assert.ok(started, 'the census was read')
    assert.equal(sessionEnvironment(made.id), 'xb-plain')
  } finally {
    await (started as Promise<void> | null)?.catch(() => {})
    await kernel.shutdownSession(made.id).catch(() => {})
    docker.done()
  }
})

/* ----------------------------------------------------- the runtime broker */

test('under the broker the pin follows the environment, and a pod still up after a restart keeps the class where it is', async () => {
  const digest = (c: string) => c.repeat(64)
  const catalog = {
    schemaVersion: 1,
    release: 'v1',
    defaultEnvironment: 'base',
    environments: [
      { name: 'base', image: `registry.example/base@sha256:${digest('a')}`, gpu: false },
      { name: 'kaggle-base', image: `registry.example/kaggle-base@sha256:${digest('b')}`, gpu: false },
    ],
  }
  const heard: Array<{ method: string; url: string; body: any }> = []
  /** The pods the broker holds, by class: what it was last ensured with. */
  const pods = new Map<string, { environment: string; revision: string }>()
  const broker = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    heard.push({ method: req.method ?? '', url: req.url ?? '', body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/health') {
      return res.end(JSON.stringify({ ok: true, reason: null, defaultCpus: 2, defaultMemoryMb: 2048, maxMemoryMb: 8192 }))
    }
    if (req.url === '/v1/rooms') {
      const rooms = [...pods].map(([sessionId, pod]) => ({ sessionId, instanceId: `pod-${sessionId}`, phase: 'ready', ...pod }))
      return res.end(JSON.stringify({ rooms }))
    }
    const id = decodeURIComponent((req.url ?? '').split('/').pop()?.split('?')[0] ?? '')
    if (req.method === 'POST') {
      pods.set(id, { environment: body.environment, revision: body.revision })
      // The room's pod is the fake Jupyter: the kernel comes up for real.
      return res.end(
        JSON.stringify({ url: JUPYTER, token: 't'.repeat(64), instanceId: `pod-${id}`, environment: body.environment, revision: body.revision }),
      )
    }
    if (req.method === 'DELETE') pods.delete(id)
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
  const saved = { ...process.env }
  const tokenFile = path.join(TEST_ROOT, 'env-broker-token')
  fs.writeFileSync(tokenFile, 'k'.repeat(64))
  const catalogFile = path.join(TEST_ROOT, 'env-broker-catalog.json')
  fs.writeFileSync(catalogFile, JSON.stringify(catalog))
  Object.assign(process.env, {
    KERNEL_BACKEND: 'broker',
    KERNEL_ISOLATION: 'required',
    KERNEL_RUNTIME_URL: `http://127.0.0.1:${(broker.address() as { port: number }).port}`,
    KERNEL_RUNTIME_TOKEN_FILE: tokenFile,
    KERNEL_CATALOG_FILE: catalogFile,
  })
  let id = ''
  try {
    id = (await room(owner.cookie, 'В кластере', 'base')).id
    assert.equal(sessionKernelRevision(id), `sha256:${digest('a')}`)

    // No kernel yet: the room moves, and its pin with it.
    assert.equal((await move(owner.cookie, id, 'kaggle-base')).status, 200)
    assert.equal(sessionEnvironment(id), 'kaggle-base')
    assert.equal(sessionKernelRevision(id), `sha256:${digest('b')}`)

    // The start asks the broker for the new environment at its own revision.
    await kernel.ensureKernel(id)
    const ensures = () => heard.filter((call) => call.method === 'POST' && call.url.endsWith(`/${id}`))
    assert.deepEqual([ensures().at(-1)?.body.environment, ensures().at(-1)?.body.revision], ['kaggle-base', `sha256:${digest('b')}`])

    // A kernel is up: a new pod would replace it with the class's variables.
    await lockedOut(await move(owner.cookie, id, 'base'), 'server.seminar.environmentKernelRunning')
    assert.equal(sessionEnvironment(id), 'kaggle-base')

    // The app restarts (a Helm upgrade): this process forgets its scopes, the
    // pod and its kernels stay. The broker's rooms still name the class.
    await kernel.shutdownKernels()
    assert.deepEqual(kernel.kernelClasses(), [])
    assert.deepEqual(await kernelOf(owner.cookie, id), { running: true })
    await lockedOut(await move(owner.cookie, id, 'base'), 'server.seminar.environmentKernelRunning')
    assert.equal(sessionKernelRevision(id), `sha256:${digest('b')}`)
    // The student who comes back is on the same pod, at the same revision.
    const before = ensures().length
    await kernel.ensureKernel(id)
    assert.equal(ensures().at(before)?.body.revision, `sha256:${digest('b')}`)

    // The class stops, and the move goes through.
    await kernel.shutdownSession(id)
    assert.equal(pods.has(id), false)
    assert.equal((await move(owner.cookie, id, 'base')).status, 200)
    assert.equal(sessionKernelRevision(id), `sha256:${digest('a')}`)
  } finally {
    if (id) await kernel.shutdownSession(id).catch(() => {})
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    broker.closeAllConnections()
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  }
})

/* ------------------------------------------------------------ the window */

test('the window offers a built environment, and says why it cannot offer the rest', () => {
  const gpus = (total: number, runners = 0): Pick<EnvironmentsState, 'gpus' | 'gpuCapacityKnown'> => ({
    gpus: { total, free: total, runners },
    gpuCapacityKnown: true,
  })
  assert.equal(environmentBar({ state: 'ready', gpu: false }, gpus(0)), null)
  assert.equal(environmentBar({ state: 'unbuilt', gpu: false }, gpus(0)), 'unbuilt')
  assert.equal(environmentBar({ state: 'building', gpu: false }, gpus(0)), 'unbuilt')
  assert.equal(environmentBar({ state: 'failed', gpu: true }, gpus(2)), 'unbuilt')
  assert.equal(environmentBar({ state: 'ready', gpu: true }, gpus(0)), 'noGpu')
  assert.equal(environmentBar({ state: 'ready', gpu: true }, gpus(0, 2)), 'gpuToSubmissions')
  // Busy slices may free up by the class: not a bar, as at creation.
  assert.equal(environmentBar({ state: 'ready', gpu: true }, { gpus: { total: 2, free: 0 }, gpuCapacityKnown: true }), null)
  // The cluster's scheduler knows its cards; the panel does not pretend to.
  assert.equal(environmentBar({ state: 'ready', gpu: true }, { gpus: { total: 0, free: 0 }, gpuCapacityKnown: false }), null)

  // The class's own GPU environment is read for its card whatever its build:
  // an unbuilt one with no card for classes is two things to say, not one.
  assert.equal(gpuBar({ gpu: true }, gpus(0)), 'noGpu')
  assert.equal(gpuBar({ gpu: true }, gpus(0, 1)), 'gpuToSubmissions')
  assert.equal(gpuBar({ gpu: false }, gpus(0)), null)

  // What the class is set to; an older server sends only the kernel's.
  assert.equal(chosenEnvironment({ chosenEnvironment: 'xb-data', environment: 'xb-plain' }), 'xb-data')
  assert.equal(chosenEnvironment({ environment: 'xb-plain' }), 'xb-plain')
})

test('the class’s own environment says what its kernel will do when it is not ready', () => {
  const none = { builtAt: null, imageBytes: null }
  const image = { builtAt: Date.UTC(2026, 9, 1), imageBytes: 1_500_000_000 }
  assert.equal(chosenNote({ state: 'ready', ...image }), null)
  // No image at all: the kernel does not start until it is built.
  assert.equal(chosenNote({ state: 'unbuilt', ...none }), 'missing')
  assert.equal(chosenNote({ state: 'failed', ...none }), 'missing')
  assert.equal(chosenNote({ state: 'building', ...none }), 'building')
  // A build exists: the kernel starts on it while another is due.
  assert.equal(chosenNote({ state: 'unbuilt', ...image }), 'stale')
  assert.equal(chosenNote({ state: 'building', ...image }), 'stale')
  assert.equal(chosenNote({ state: 'failed', ...image }), 'stale')
})
