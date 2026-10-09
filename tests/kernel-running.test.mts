/**
 * «Работают сейчас»: what holds the machine's memory, and the owner's stop.
 *
 * On 9 Oct 2026 a fifteen-gigabyte machine refused every new kernel for an
 * evening with a raw English sentence: three classes nobody was in held four
 * gigabytes of reservation each, and nothing in the panel said so or could
 * free them. Pinned down here: the list (what each class container reserves
 * and really uses, read with ONE `docker stats`, kept for ten seconds), who
 * sees what (another course's class is numbers only, its name nowhere in the
 * answer), who stops (the owner), what a stop refuses (work running, unless
 * forced; a stop already in flight) and what it does (the containers go,
 * every notebook is put to rest with one line in the room, the audit log
 * says so), the batch stop of idle classes, the localized refusal, and that
 * the resources payload stopped leaking room names to teachers.
 *
 * Two fakes: docker at the process boundary (tests/_fake-docker.mts) for the
 * containers, and a small Jupyter for the kernels a cell can keep busy (the
 * test backend, which has no containers, lists those).
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import { guardAnswer } from './_guard.mts'
import { fakeDocker } from './_fake-docker.mts'
import type {
  AdminAuditEvent,
  ResourceSettingsResponse,
  RunningKernels,
  StopIdleKernelsResponse,
  StopKernelBusy,
  StopKernelResponse,
} from '../shared/admin.js'

/* ------------------------------------------------------------ fake Jupyter */

/*
 * Only what a kernel needs to come up, run a cell and hold one: sessions,
 * the alive check, the channels. A cell whose code says HOLD does not finish
 * until the test (or an interrupt, or the stop) lets it go.
 */
let held: Array<{ ws: WebSocket; parent: unknown }> = []
let minted = 0

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
    req.resume()
    req.on('end', () => {
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
  if (req.method === 'POST' && /\/interrupt$/.test(url.pathname)) {
    for (const { ws, parent } of held.splice(0)) {
      reply(ws, parent, 'execute_reply', { status: 'abort', execution_count: 1 })
      reply(ws, parent, 'status', { execution_state: 'idle' })
    }
    res.writeHead(204).end()
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
      const msg = JSON.parse(String(raw)) as {
        header: { msg_type: string }
        content: { code: string; silent?: boolean }
      }
      if (msg.header.msg_type !== 'execute_request') return
      reply(ws, msg.header, 'status', { execution_state: 'busy' })
      const guard = guardAnswer(msg.content.code)
      if (!guard && /HOLD/.test(msg.content.code)) {
        held.push({ ws, parent: msg.header })
        return
      }
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
// Before any server module: config reads the address at import.
process.env.JUPYTER_URL = `http://127.0.0.1:${(jupyter.address() as { port: number }).port}`
process.env.JUPYTER_TOKEN = 'fake'

const { call, staffMember, startApp } = await import('./_scoping.mts')
const { setLocaleResolver, tr } = await import('../shared/i18n.js')
const { addRoomTeacher } = await import('../server/src/admin/access.js')
const { listAdminEvents } = await import('../server/src/admin/audit-log.js')
const { updateResourceSettings } = await import('../server/src/admin/resource-settings.js')
const { getInstanceLanguage, setInstanceLanguage } = await import('../server/src/admin/settings.js')
const { createSession, upsertParticipant } = await import('../server/src/db.js')
const { getSessionDoc, handleCollabSocket, shutdownCollab } = await import('../server/src/collab/index.js')
const { bookList, cellSource, createCell, getCells, getTerminal, kernelsMap, readOutputs, KERNEL_STATUS_FIELD } = await import('../shared/notebook.js')
const { isKernelMemoryOutput } = await import('../shared/kernel-problem.js')
const kernel = await import('../server/src/kernel/index.js')
const { endpointForSession, KernelMemoryRefusal, roomIdleMinutes } = await import('../server/src/kernel/pool.js')
const { kernelRetirementInProgress } = await import('../server/src/kernel/retirement.js')
const { forgetResources, useDockerInfo } = await import('../server/src/kernel/resources.js')
const { forgetContainerUsage, parseDockerSize } = await import('../server/src/kernel/usage.js')
const { reserveWork } = await import('../server/src/ops/work-budget.js')

const app = await startApp()
const owner = staffMember('Владелец', 'owner')
const teacher = staffMember('Мария Преподаватель')

let restoreDocker: (() => void) | null = null

/** Docker for one test, with a daemon of 15 GB and eight cores. */
function docker() {
  const fake = fakeDocker()
  useDockerInfo(async () => ({ code: 0, out: `${15 * 1024 ** 3} 8` }))
  forgetResources()
  forgetContainerUsage()
  restoreDocker = () => {
    fake.restore()
    useDockerInfo(null)
    forgetResources()
    forgetContainerUsage()
  }
  return fake
}

afterEach(() => {
  restoreDocker?.()
  restoreDocker = null
  setLocaleResolver(getInstanceLanguage)
  for (const { ws, parent } of held.splice(0)) {
    reply(ws, parent, 'execute_reply', { status: 'ok', execution_count: 1 })
    reply(ws, parent, 'status', { execution_state: 'idle' })
  }
})

after(async () => {
  app.close()
  await kernel.shutdownKernels()
  shutdownCollab()
  channels.close()
  jupyter.close()
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) return true
    await wait(20)
  }
  return false
}

async function running(cookie: string): Promise<RunningKernels> {
  const res = await call(app.base, 'GET', '/api/admin/resources/running', { cookie })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  return (await res.json()) as RunningKernels
}

function lastEvent(action: string): AdminAuditEvent {
  const found = listAdminEvents({ limit: 200 }).events.find((event) => event.action === action)
  assert.ok(found, `no "${action}" event was recorded`)
  return found
}

function notes(id: string): string[] {
  return getTerminal(getSessionDoc(id).doc)
    .toArray()
    .filter((line) => line.get('kind') === 'system')
    .map((line) => String(line.get('text')))
}

/** A socket in the room, the way a browser tab holds one. */
function present(id: string): () => void {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const ws = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(_frame: unknown, ...rest: unknown[]) {
      ;(rest.find((it) => typeof it === 'function') as (() => void) | undefined)?.()
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      ws.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  handleCollabSocket(ws as unknown as WebSocket, id, 'participant', `p_present_${id}`)
  return () => ws.close()
}

/* ------------------------------------------------------------- the list */

test('staff read the list, another class is numbers only, and only the owner stops', async () => {
  const fake = docker()
  createSession('run-mine', 'Семинар Марии', 'base')
  createSession('run-other', 'Чужой семинар 7', 'base')
  addRoomTeacher('run-mine', teacher.teacher.id, null)
  fake.add('run-mine', 'room', { usedMb: 120 })
  fake.add('run-mine', 'own', { memoryMb: 2048, usedMb: 30 })
  fake.add('run-other', 'room', { memoryMb: 4096, usedMb: 90 })

  assert.equal((await call(app.base, 'GET', '/api/admin/resources/running')).status, 401)

  const seen = await running(teacher.cookie)
  assert.equal(seen.backend, 'docker')
  assert.equal(seen.complete, true)
  assert.equal(seen.usage, 'live')
  // The sums are the whole machine's, whoever reads them.
  assert.equal(seen.reservedMb, 4096 + 2048 + 4096)
  assert.equal(seen.usedMb, 120 + 30 + 90)
  assert.equal(seen.classes.length, 2)
  const mine = seen.classes.find((row) => row.id === 'run-mine')
  assert.ok(mine, JSON.stringify(seen.classes))
  assert.equal(mine.name, 'Семинар Марии')
  assert.equal(mine.hidden, false)
  assert.equal(mine.environment, 'base')
  assert.deepEqual(
    [mine.room?.reservedMb, mine.room?.usedMb, mine.room?.cpus, mine.room?.cpuPercent, mine.room?.state],
    [4096, 120, 2, 3.5, 'running'],
  )
  assert.equal(mine.room?.startedAt, '2026-10-09T18:00:00.000Z')
  assert.equal(mine.own?.reservedMb, 2048)
  assert.equal(mine.online, 0)
  assert.equal(mine.busy, null)
  assert.equal(mine.idle, true)
  assert.ok(mine.stopsAt, 'an empty room shows when the sweep will take it')
  assert.equal(mine.canStop, false, 'a teacher does not stop kernels')
  const other = seen.classes.find((row) => row.id !== 'run-mine')!
  assert.deepEqual(
    [other.id, other.hidden, other.name, other.course, other.environment, other.books, other.canStop],
    [null, true, null, null, null, [], false],
  )
  assert.equal(other.room?.reservedMb, 4096, 'the numbers of another class stay: the machine is shared')
  assert.equal(JSON.stringify(seen).includes('Чужой семинар'), false, "another course's room name reached a teacher")
  assert.equal(JSON.stringify(seen).includes('run-other'), false, "another course's room id reached a teacher")

  // One `docker stats` for every container, and none again within ten seconds.
  const stats = () => fake.calls.filter((args) => args[0] === 'stats')
  assert.equal(stats().length, 1)
  assert.deepEqual(stats()[0]!.slice(4).sort(), ['colloq-room-run-mine', 'colloq-room-run-mine-own', 'colloq-room-run-other'])
  const again = await running(owner.cookie)
  assert.equal(stats().length, 1, 'the sample is kept for ten seconds')
  assert.equal(again.classes.find((row) => row.id === 'run-other')?.name, 'Чужой семинар 7')
  assert.ok(again.classes.every((row) => row.canStop), 'the owner may stop every class')

  // The teacher's press is refused at the door, and nothing is removed.
  const refused = await call(app.base, 'POST', '/api/admin/resources/running/run-mine/stop', {
    cookie: teacher.cookie,
    body: { what: 'class' },
  })
  assert.equal(refused.status, 403)
  assert.equal(((await refused.json()) as { reason: string }).reason, 'forbidden')
  assert.equal(fake.containers.size, 3)
  assert.equal(
    (await call(app.base, 'POST', '/api/admin/resources/running/stop-idle', { cookie: teacher.cookie })).status,
    403,
  )
})

test("the owner's stop: the personal notebooks alone, then the class, said in the room and in the log", async () => {
  const fake = docker()
  createSession('run-stop', 'Остановка', 'base')
  fake.add('run-stop', 'room')
  fake.add('run-stop', 'own', { memoryMb: 2048 })

  const bad = await call(app.base, 'POST', '/api/admin/resources/running/run-stop/stop', {
    cookie: owner.cookie,
    body: { what: 'everything' },
  })
  assert.equal(bad.status, 400)

  const own = await call(app.base, 'POST', '/api/admin/resources/running/run-stop/stop', {
    cookie: owner.cookie,
    body: { what: 'own' },
  })
  assert.equal(own.status, 200)
  assert.deepEqual((await own.json()) as StopKernelResponse, { stopped: true, freedMb: 2048 })
  assert.deepEqual([...fake.containers.keys()], ['colloq-room-run-stop'], 'only the personal-notebook container goes')
  assert.deepEqual(notes('run-stop').at(-1), tr('server.kernel.ownStoppedByOwner'))
  // The list shows it at once, not after the ten-second sample.
  const after = (await running(owner.cookie)).classes.find((row) => row.id === 'run-stop')
  assert.ok(after)
  assert.equal(after.own, null)

  const whole = await call(app.base, 'POST', '/api/admin/resources/running/run-stop/stop', {
    cookie: owner.cookie,
    body: { what: 'class' },
  })
  assert.equal(whole.status, 200)
  assert.deepEqual((await whole.json()) as StopKernelResponse, { stopped: true, freedMb: 4096 })
  assert.equal(fake.containers.size, 0)
  assert.ok(fake.calls.some((args) => args.join(' ') === 'rm -f colloq-room-run-stop'))
  assert.equal(notes('run-stop').at(-1), tr('server.kernel.stoppedByOwner'))
  assert.equal((await running(owner.cookie)).classes.length, 0)

  const event = lastEvent('room.kernel_stopped')
  assert.deepEqual(event.target, { type: 'room', id: 'run-stop', label: 'Остановка' })
  assert.deepEqual(event.detail, { what: 'class', freedMb: 4096, forced: false, online: 0 })
  assert.equal(event.actor?.id, owner.teacher.id)

  // Nothing is left to stop.
  const gone = await call(app.base, 'POST', '/api/admin/resources/running/run-stop/stop', {
    cookie: owner.cookie,
    body: { what: 'class' },
  })
  assert.equal(gone.status, 404)
  assert.equal(((await gone.json()) as { reason: string }).reason, 'not_found')
})

test('stopping the idle ones takes only the empty, quiet classes, each re-checked', async () => {
  const fake = docker()
  createSession('run-idle', 'Пустая', 'base')
  createSession('run-busy', 'Занятая', 'base')
  fake.add('run-idle', 'room')
  fake.add('run-idle', 'own', { memoryMb: 1024 })
  fake.add('run-busy', 'room')
  const leave = present('run-busy')
  try {
    const list = await running(owner.cookie)
    assert.deepEqual(
      list.classes.map((row) => [row.id, row.idle, row.online]).sort(),
      [['run-busy', false, 1], ['run-idle', true, 0]],
    )
    assert.equal(list.classes.find((row) => row.id === 'run-busy')?.stopsAt, null, 'an occupied room has no countdown')
    // The panel sends what its dialog listed; a class in session is not
    // among them, and the answer must not report it as "skipped".
    const res = await call(app.base, 'POST', '/api/admin/resources/running/stop-idle', {
      cookie: owner.cookie,
      body: { ids: ['run-idle'] },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as StopIdleKernelsResponse
    assert.deepEqual(body.stopped, [{ id: 'run-idle', freedMb: 4096 + 1024 }])
    assert.deepEqual(body.skipped, [])
    assert.equal(body.freedMb, 4096 + 1024)
    assert.deepEqual([...fake.containers.keys()], ['colloq-room-run-busy'])
    // People in a room are a warning for the single stop, not a refusal.
    assert.deepEqual(lastEvent('room.kernel_stopped').detail, { what: 'class', freedMb: 5120, forced: false, online: 0, idle: true })

    // Without ids (a script), every class the census shows is considered, and the occupied one is skipped.
    const all = (await (await call(app.base, 'POST', '/api/admin/resources/running/stop-idle', { cookie: owner.cookie })).json()) as StopIdleKernelsResponse
    assert.deepEqual(all, { stopped: [], skipped: [{ id: 'run-busy', reason: 'online' }], freedMb: 0 })
    const bad = await call(app.base, 'POST', '/api/admin/resources/running/stop-idle', { cookie: owner.cookie, body: { ids: 'run-idle' } })
    assert.equal(bad.status, 400)
  } finally {
    leave()
  }
})

test('the batch stops only the classes the owner confirmed, and re-checks each one at the moment of its stop', async () => {
  const fake = docker()
  for (const id of ['race-a', 'race-b', 'race-later']) {
    createSession(id, `Гонка ${id}`, 'base')
    fake.add(id, 'room')
  }
  // The dialog listed A and B; «race-later» went idle after it opened.
  await running(owner.cookie)
  const stats = () => fake.calls.filter((args) => args[0] === 'stats').length
  const before = stats()
  // Someone walks into B while A is being removed.
  let leave: (() => void) | null = null
  fake.intercept = (args) => {
    if (args[0] === 'rm' && args.at(-1) === 'colloq-room-race-a' && !leave) leave = present('race-b')
  }
  try {
    const res = await call(app.base, 'POST', '/api/admin/resources/running/stop-idle', {
      cookie: owner.cookie,
      body: { ids: ['race-a', 'race-b', 'race-gone'] },
    })
    const body = (await res.json()) as StopIdleKernelsResponse
    assert.deepEqual(body.stopped.map((one) => one.id), ['race-a'])
    assert.deepEqual(body.skipped, [
      { id: 'race-b', reason: 'online' },
      { id: 'race-gone', reason: 'gone' },
    ])
    assert.deepEqual([...fake.containers.keys()].sort(), ['colloq-room-race-b', 'colloq-room-race-later'])
    // One census for the whole batch: no fresh `docker stats` per class, the
    // seconds in which someone could walk in unseen.
    assert.ok(stats() - before <= 1, `the batch sampled docker stats ${stats() - before} times`)
  } finally {
    ;(leave as (() => void) | null)?.()
  }

  // And the check is the stop's own, in the same tick as its gate: nothing awaits between them.
  const back = present('race-later')
  try {
    await assert.rejects(
      kernel.stopKernelsByOwner('race-later', 'class', { idleOnly: true }),
      (err: unknown) => err instanceof kernel.KernelStopRefusal && err.reason === 'online',
    )
    assert.equal(fake.containers.has('colloq-room-race-later'), true)
  } finally {
    back()
  }
})

test('a docker rm that fails is a failed stop: no memory is said to be freed', async () => {
  const fake = docker()
  createSession('run-stuck', 'Застряло', 'base')
  fake.add('run-stuck', 'room')
  fake.add('run-stuck', 'own', { memoryMb: 2048 })
  const events = () => listAdminEvents({ limit: 200 }).events.filter((event) => event.target?.id === 'run-stuck').length
  fake.intercept = (args) => (args[0] === 'rm' ? { code: 1, out: 'Error response from daemon: timeout' } : undefined)
  for (const what of ['own', 'class'] as const) {
    const res = await call(app.base, 'POST', '/api/admin/resources/running/run-stuck/stop', {
      cookie: owner.cookie,
      body: { what },
    })
    assert.equal(res.status, 503, what)
    const body = (await res.json()) as { reason: string; error: string }
    assert.equal(body.reason, 'failed')
    assert.match(body.error, /timeout/)
  }
  assert.equal(fake.containers.size, 2, 'the containers are still there')
  assert.equal(events(), 0, 'a stop that freed nothing was recorded as freeing memory')
  // The daemon answers again: the same press goes through.
  fake.intercept = null
  const res = await call(app.base, 'POST', '/api/admin/resources/running/run-stuck/stop', { cookie: owner.cookie, body: { what: 'class' } })
  assert.equal(res.status, 200)
  assert.equal(fake.containers.size, 0)
})

/* ----------------------------------------------- work in progress (busy) */

test('a computing class refuses the stop and names the work; forced, it is put to rest with one line', async () => {
  // The test backend: no containers, the kernels this process holds are the rows.
  const id = 'run-cell'
  createSession(id, 'Считает', 'base')
  upsertParticipant({ id: 'p_maria', sessionId: id, name: 'Мария', avatar: null, role: 'participant', tokenHost: false })
  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(1)
  const source = cell.get('source')
  source.delete(0, source.length)
  source.insert(0, 'HOLD = train()')
  kernel.requestRun(id, [cell.get('id') as string], 'Мария', 'p_maria')
  assert.ok(await until(() => held.length === 1), 'the cell never reached the kernel')

  const row = (await running(owner.cookie)).classes.find((one) => one.id === id)
  assert.ok(row, 'a class with a live kernel is listed even without a container')
  assert.equal(row.busy?.kind, 'cell')
  assert.equal(row.busy?.who, 'Мария')
  const path = bookList(doc).find((book) => book.root === 'cells')!.path
  assert.equal(row.busy?.book, path)
  assert.ok(row.busy?.since)
  assert.equal(row.idle, false)
  assert.equal(row.stopsAt, null)
  assert.deepEqual(
    row.books.map((book) => [book.root, book.role, book.phase]),
    [['cells', 'room', 'busy']],
  )
  // A teacher of another course sees that something computes, not who or where.
  const hidden = (await running(teacher.cookie)).classes.find((one) => one.hidden && one.busy?.kind === 'cell')
  assert.ok(hidden)
  assert.deepEqual([hidden.busy?.who, hidden.busy?.book, hidden.books], [null, null, []])

  const refused = await call(app.base, 'POST', `/api/admin/resources/running/${id}/stop`, {
    cookie: owner.cookie,
    body: { what: 'class' },
  })
  assert.equal(refused.status, 409)
  const why = (await refused.json()) as StopKernelBusy
  assert.equal(why.reason, 'busy')
  assert.deepEqual([why.busy.kind, why.busy.who, why.busy.book], ['cell', 'Мария', path])
  assert.equal(cell.get('state'), 'running', 'a refused stop touched the work')
  // Personal notebooks hold nothing here: that stop has nothing to cut, and nothing to stop.
  const ownOnly = await call(app.base, 'POST', `/api/admin/resources/running/${id}/stop`, {
    cookie: owner.cookie,
    body: { what: 'own' },
  })
  assert.equal(ownOnly.status, 404)
  // The batch never takes it.
  const batch = (await (await call(app.base, 'POST', '/api/admin/resources/running/stop-idle', { cookie: owner.cookie })).json()) as StopIdleKernelsResponse
  assert.deepEqual(batch.stopped.filter((one) => one.id === id), [])
  assert.deepEqual(batch.skipped.filter((one) => one.id === id), [{ id, reason: 'busy' }])

  const forced = await call(app.base, 'POST', `/api/admin/resources/running/${id}/stop`, {
    cookie: owner.cookie,
    body: { what: 'class', force: true },
  })
  assert.equal(forced.status, 200)
  assert.deepEqual((await forced.json()) as StopKernelResponse, { stopped: true, freedMb: 0 })
  // The room reads «не запущено», the cell is at rest, one line says why.
  assert.equal(kernelsMap(doc)?.get('cells')?.get(KERNEL_STATUS_FIELD), 'off')
  assert.equal(cell.get('state'), 'idle')
  assert.deepEqual(notes(id).filter((text) => text === tr('server.kernel.stoppedByOwner')).length, 1)
  assert.equal(kernel.kernelClasses().includes(id), false)
  assert.deepEqual(kernel.classActivity(id).scopes, [])
  assert.equal(lastEvent('room.kernel_stopped').detail?.forced, true)

  // The kernel comes back by itself at the next Run.
  source.delete(0, source.length)
  source.insert(0, 'print(1)')
  kernel.requestRun(id, [cell.get('id') as string], 'Мария', 'p_maria')
  assert.ok(await until(() => cell.get('state') === 'ok'), 'the kernel did not come back after the stop')
})

test('a stop already under way refuses a second one, and pauses starts without closing the door', async () => {
  const id = 'run-twice'
  createSession(id, 'Дважды', 'base')
  await kernel.ensureKernel(id)
  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(1)
  const source = cell.get('source')
  source.delete(0, source.length)
  source.insert(0, 'HOLD')
  kernel.requestRun(id, [cell.get('id') as string], 'Мария', 'p_maria')
  assert.ok(await until(() => held.length === 1))
  // Forced: the first stop waits on the pump for up to a second, the window the second press lands in.
  const first = kernel.stopKernelsByOwner(id, 'class', { force: true })
  await assert.rejects(
    kernel.stopKernelsByOwner(id, 'class', { force: true }),
    (err: unknown) => err instanceof kernel.KernelStopRefusal && err.reason === 'stopping',
  )
  assert.equal(kernel.classActivity(id).stopping, true)
  await assert.rejects(endpointForSession(id, 'base'), new RegExp(tr('server.kernel.startsPaused')))
  // The door stays open: that gate is a deletion's, and nobody is thrown out of a stopped kernel.
  assert.equal(kernelRetirementInProgress(id), false)
  await first
  assert.equal(kernel.classActivity(id).stopping, false)
  await endpointForSession(id, 'base')
})

test("stopping only the personal notebooks leaves the lecture's kernel and the shell free to start", async () => {
  const id = 'run-own-pause'
  createSession(id, 'Только личные', 'base')
  await endpointForSession(id, 'base')
  const stopping = kernel.stopKernelsByOwner(id, 'own', { force: true })
  // The same tick the gate went up in: the personal container is paused, the class's is not.
  await assert.rejects(endpointForSession(id, 'base', 'own'), new RegExp(tr('server.kernel.startsPaused')))
  await endpointForSession(id, 'base', 'room')
  await stopping
  await endpointForSession(id, 'base', 'own')
  // The whole class's stop pauses both.
  const whole = kernel.stopKernelsByOwner(id, 'class', { force: true })
  await assert.rejects(endpointForSession(id, 'base', 'room'), new RegExp(tr('server.kernel.startsPaused')))
  await assert.rejects(endpointForSession(id, 'base', 'own'), new RegExp(tr('server.kernel.startsPaused')))
  await whole
})

/* ------------------------------------------------------ the idle setting */

test('the sweep honours the room setting: five minutes take an empty room, two hours keep it', async () => {
  const fake = docker()
  createSession('run-sweep', 'Сквозняк', 'base')
  fake.add('run-sweep', 'room')
  const start = Date.now()
  try {
    updateResourceSettings({ roomIdleMin: 5 }, { memory: { min: 512, max: 14336 }, cpus: { min: 1, max: 8 } })
    assert.equal(roomIdleMinutes(), 5)
    await kernel.sweepIdleKernels(start)
    assert.equal(fake.containers.size, 1, 'the first look only starts the clock')
    const row = (await running(owner.cookie)).classes[0]!
    assert.equal(row.idleSince, new Date(start).toISOString())
    assert.ok(row.stopsAt && Date.parse(row.stopsAt) >= start + 5 * 60_000)
    await kernel.sweepIdleKernels(start + 4 * 60_000)
    assert.equal(fake.containers.size, 1)

    updateResourceSettings({ roomIdleMin: 120 }, { memory: { min: 512, max: 14336 }, cpus: { min: 1, max: 8 } })
    await kernel.sweepIdleKernels(start + 6 * 60_000)
    assert.equal(fake.containers.size, 1, 'two hours keep a room six minutes empty')
    updateResourceSettings({ roomIdleMin: 0 }, { memory: { min: 512, max: 14336 }, cpus: { min: 1, max: 8 } })
    assert.equal((await running(owner.cookie)).classes[0]?.stopsAt, null, '0 means it never goes by itself')
    await kernel.sweepIdleKernels(start + 24 * 60 * 60_000)
    assert.equal(fake.containers.size, 1, '0 means never')

    updateResourceSettings({ roomIdleMin: 5 }, { memory: { min: 512, max: 14336 }, cpus: { min: 1, max: 8 } })
    await kernel.sweepIdleKernels(start + 6 * 60_000)
    assert.equal(fake.containers.size, 0, 'five minutes of an empty room take its container')
  } finally {
    updateResourceSettings({ roomIdleMin: null }, { memory: { min: 512, max: 14336 }, cpus: { min: 1, max: 8 } })
  }
})

test('the countdown starts when the sweep first finds the room empty, not at the last look that saw it busy', async () => {
  const fake = docker()
  createSession('run-left', 'Ушли', 'base')
  fake.add('run-left', 'room')
  const start = Date.now()
  const MINUTE = 60_000
  const row = async () => (await running(owner.cookie)).classes.find((one) => one.id === 'run-left')!
  let leave: (() => void) | null = present('run-left')
  try {
    updateResourceSettings({ roomIdleMin: 5 }, { memory: { min: 512, max: 14336 }, cpus: { min: 1, max: 8 } })
    // A pass with the class in the room: busy, no clock.
    await kernel.sweepIdleKernels(start)
    leave()
    leave = null
    assert.equal((await row()).idleSince, null, 'nobody has seen the room empty yet')
    // The class left just before the next pass (two and a half minutes on a five-minute setting).
    await kernel.sweepIdleKernels(start + 2.5 * MINUTE)
    assert.equal((await row()).idleSince, new Date(start + 2.5 * MINUTE).toISOString())
    // Five minutes after the busy look is two and a half of emptiness: kept.
    await kernel.sweepIdleKernels(start + 5 * MINUTE)
    assert.equal(fake.containers.size, 1, 'the room went after half the wait it was promised')
    await kernel.sweepIdleKernels(start + 7.5 * MINUTE)
    assert.equal(fake.containers.size, 0, 'five minutes of an empty room take its container')
  } finally {
    leave?.()
    updateResourceSettings({ roomIdleMin: null }, { memory: { min: 512, max: 14336 }, cpus: { min: 1, max: 8 } })
  }
})

/* -------------------------------------------------- the memory refusal */

test('the memory refusal is a sentence in the instance language, with a stable code', async () => {
  for (const [locale, words] of [['ru', /Не хватает памяти на сервере.*«Ресурсы»/], ['en', /out of memory.*Resources tab/]] as const) {
    setLocaleResolver(() => locale)
    const full = new KernelMemoryRefusal('full')
    assert.match(full.message, words)
    assert.equal(full.code, 'kernel_memory')
    assert.equal(full.reason, 'full')
    assert.doesNotMatch(full.message, /Not enough available memory/)
    assert.match(new KernelMemoryRefusal('unverified').message, locale === 'ru' ? /памят/ : /memory/)
  }
  setLocaleResolver(getInstanceLanguage)

  // Where people read it: the kernel log of the room whose start was refused.
  const fake = docker()
  const id = 'run-refused'
  createSession(id, 'Без памяти', 'base')
  fake.add('run-other-holder', 'room', { memoryMb: 12_288 })
  const hold = reserveWork({ id: 'refusal-background', kind: 'competition', memoryMb: 8000, diskBytes: 0 }, {})!
  const before = getInstanceLanguage()
  try {
    for (const language of ['ru', 'en'] as const) {
      setInstanceLanguage(language)
      await assert.rejects(endpointForSession(id, 'base'), (err: unknown) => err instanceof KernelMemoryRefusal && err.code === 'kernel_memory')
      await assert.rejects(kernel.ensureKernel(id))
      assert.equal(notes(id).at(-1), tr('server.kernel.memoryFull'))
      assert.match(notes(id).at(-1)!, language === 'ru' ? /^Не хватает памяти/ : /^The server is out of memory/)
    }
    assert.equal(fake.calls.filter((args) => args[0] === 'run' && args.includes('--name')).length, 0)
  } finally {
    hold()
    setInstanceLanguage(before)
  }
})

test('the memory notices go from every cell once the kernel comes up through another one', async () => {
  const fake = docker()
  const id = 'run-notices'
  createSession(id, 'Записки', 'base')
  const cells = getCells(getSessionDoc(id).doc)
  const made = ['a = 1', 'b = 2', 'c = 3'].map((code) => {
    const cell = createCell('code', '')
    cellSource(cell).insert(0, code)
    cells.push([cell])
    return cell
  })
  const ids = made.map((cell) => cell.get('id') as string)
  const notices = (i: number) => readOutputs(made[i]!).filter(isKernelMemoryOutput).length
  // A full machine: twelve of the daemon's fifteen gigabytes held by another
  // class, eight more promised to a run. Two students' cells are refused.
  fake.add('run-notices-holder', 'room', { memoryMb: 12_288 })
  const hold = reserveWork({ id: 'notices-background', kind: 'competition', memoryMb: 8000, diskBytes: 0 }, {})!
  try {
    for (const i of [0, 1]) {
      kernel.requestRun(id, [ids[i]!], 'Мария', 'p_maria')
      assert.ok(await until(() => notices(i) === 1), `the refusal never reached cell ${i}`)
    }
  } finally {
    hold()
  }
  // Memory is free again (back on the test backend, which admits anything): the teacher runs a third cell.
  restoreDocker?.()
  restoreDocker = null
  kernel.requestRun(id, [ids[2]!], 'Учитель', 'p_teacher')
  assert.ok(await until(() => made[2]!.get('state') === 'ok'), 'the kernel did not come up')
  assert.deepEqual([notices(0), notices(1)], [0, 0], 'a notice outlived the kernel coming up')
})

/* ---------------------------------------------------- the payload leak */

test("the resources payload names only the rooms a teacher teaches, and counts every one", async () => {
  const fake = docker()
  createSession('leak-mine', 'Свой зал', 'base')
  createSession('leak-other', 'Секретный зал', 'base')
  addRoomTeacher('leak-mine', teacher.teacher.id, null)
  fake.add('leak-mine', 'room')
  fake.add('leak-other', 'room')
  const read = async (cookie: string) => {
    const res = await call(app.base, 'GET', '/api/admin/resources', { cookie })
    assert.equal(res.status, 200)
    return (await res.json()) as ResourceSettingsResponse
  }
  const teacherView = await read(teacher.cookie)
  assert.deepEqual(teacherView.machine.rooms.map((room) => room.id), ['leak-mine'])
  assert.equal(JSON.stringify(teacherView).includes('Секретный зал'), false)
  assert.equal(teacherView.budget.rooms.count, 2, 'the budget still counts the room the teacher does not see')
  const ownerView = await read(owner.cookie)
  assert.deepEqual(ownerView.machine.rooms.map((room) => room.id).sort(), ['leak-mine', 'leak-other'])
})

/* ------------------------------------------------------------- parsing */

test("docker's sizes read in megabytes", () => {
  assert.equal(parseDockerSize('100MiB'), 100)
  assert.equal(parseDockerSize('1.5GiB'), 1536)
  assert.equal(parseDockerSize('512KiB'), 0.5)
  assert.equal(Math.round(parseDockerSize('1GB')!), 954)
  assert.equal(parseDockerSize('0B'), 0)
  assert.equal(parseDockerSize('--'), null)
})
