/**
 * Several executions in one batch (server/src/kernel/jupyter.ts ·
 * executeBatch, docs/architecture/remote-classes.md §9.6): a council
 * worker's entry, attempt and exit cross a machine's tunnel once, where one
 * execute after another costs a trip each. And `execute` itself unchanged:
 * its frame is what it always was, byte for byte.
 *
 * Against the fake Jupyter holding every execute it takes
 * (`swallowExecutes`), so what reached the kernel before it answered
 * anything is counted, never timed; its raw frames (`keepFrames`) are what
 * went on the client's socket.
 */
import './_env.mts'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { guardAnswer } from './_guard.mts'
import { startFakeJupyter } from './_fake-jupyter.mjs'
import type { ExecuteHandlers, JupyterKernel } from '../server/src/kernel/jupyter.js'

let fake: Awaited<ReturnType<typeof startFakeJupyter>>
let jupyter: typeof import('../server/src/kernel/jupyter.js')

before(async () => {
  fake = await startFakeJupyter({ guardAnswer, keepAlive: false })
  jupyter = await import('../server/src/kernel/jupyter.js')
  jupyter.useDefaultEndpointForTest({ url: fake.url, token: 'fake' })
})

afterEach(() => fake.reset())

after(async () => {
  jupyter.useDefaultEndpointForTest(null)
  await fake.close()
})

async function until(what: () => boolean, polls = 400): Promise<boolean> {
  for (let poll = 0; poll < polls; poll++) {
    if (what()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return what()
}

const quiet = (): ExecuteHandlers => ({ onExecuteInput() {}, onStream() {}, onData() {}, onError() {}, onClear() {} })

let seq = 0
async function kernelFor(t: { after(fn: () => Promise<void> | void): void }): Promise<JupyterKernel> {
  const kernel = await jupyter.JupyterKernel.connect(`batch${seq++}`, jupyter.defaultEndpoint())
  t.after(() => kernel.dispose())
  return kernel
}

/** The execute requests the fake took, as they came: what went on the socket, in order. */
const executes = (): Array<{ header: Record<string, unknown>; metadata: unknown; content: Record<string, unknown> }> =>
  fake.frames.map((text) => JSON.parse(text)).filter((frame) => frame.header?.msg_type === 'execute_request')

test('a batch puts every frame on the socket before the kernel answers any, in order, each with its stop_on_error and metadata as asked; each ends in its own time', async (t) => {
  const kernel = await kernelFor(t)
  fake.keepFrames = true
  fake.swallowExecutes = true
  const ends = await kernel.executeBatch([
    { code: 'ENTRY', handlers: quiet(), opts: { silent: true, storeHistory: false, userExpressions: { colloq: 'report' } } },
    { code: 'attempt', handlers: quiet(), opts: { storeHistory: false, stopOnError: false, metadata: { colloqRun: 'r1' } } },
    { code: 'EXIT', handlers: quiet(), opts: { silent: true, storeHistory: false } },
  ])
  assert.equal(ends.length, 3)
  // All three reached the kernel while it had answered none of them: one trip.
  assert.ok(await until(() => fake.held.length === 3), `${fake.held.length} held`)
  const sent = executes()
  assert.deepEqual(sent.map((frame) => frame.content.code), ['ENTRY', 'attempt', 'EXIT'])
  assert.deepEqual(sent.map((frame) => frame.content.silent), [true, false, true])
  assert.deepEqual(sent.map((frame) => frame.content.store_history), [false, false, false])
  assert.deepEqual(sent.map((frame) => frame.content.stop_on_error), [true, false, true])
  assert.deepEqual(sent.map((frame) => frame.metadata), [{}, { colloqRun: 'r1' }, {}])
  assert.deepEqual(sent[0]!.content.user_expressions, { colloq: 'report' })
  // Each ends when its own reply and idle come.
  const settled: string[] = []
  ends.forEach((end, i) => void end.then((status) => settled.push(`${i}:${status}`)))
  assert.equal(fake.finishHeld(/^ENTRY$/), 1)
  assert.ok(await until(() => settled.length === 1))
  assert.deepEqual(settled, ['0:ok'])
  fake.shellFinish()
  assert.deepEqual(await Promise.all(ends), ['ok', 'ok', 'ok'])
})

test('one execute after another waits for each reply: the next frame goes only once the one before has ended', async (t) => {
  const kernel = await kernelFor(t)
  fake.keepFrames = true
  fake.swallowExecutes = true
  const first = kernel.execute('one', quiet())
  assert.ok(await until(() => fake.held.length === 1))
  const second = first.then(() => kernel.execute('two', quiet()))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(executes().map((frame) => frame.content.code), ['one'])
  fake.shellFinish()
  assert.ok(await until(() => fake.held.length === 1 && executes().length === 2))
  fake.shellFinish()
  assert.equal(await second, 'ok')
})

test('execute\'s frame is today\'s, byte for byte: no metadata, stop_on_error on, whatever a batch may ask', async (t) => {
  const kernel = await kernelFor(t)
  fake.keepFrames = true
  await kernel.execute('print(1)', quiet())
  await kernel.execute('', quiet(), { silent: true, storeHistory: false, quiet: true, userExpressions: { k: 'v' } })
  const raw = fake.frames.filter((text) => JSON.parse(text).header.msg_type === 'execute_request')
  const contents = [
    { code: 'print(1)', silent: false, store_history: true, user_expressions: {}, allow_stdin: true, stop_on_error: true },
    { code: '', silent: true, store_history: false, user_expressions: { k: 'v' }, allow_stdin: true, stop_on_error: true },
  ]
  assert.equal(raw.length, 2)
  raw.forEach((text, i) => {
    const { header } = JSON.parse(text) as { header: Record<string, unknown> }
    assert.equal(text, JSON.stringify({ header, parent_header: {}, metadata: {}, content: contents[i], channel: 'shell' }))
  })
})

test('a send that throws mid-batch: the frames after it never go and their ends reject with its error, the one before it ends as usual, and no rejection is left unhandled', async (t) => {
  const kernel = await kernelFor(t)
  fake.keepFrames = true
  fake.swallowExecutes = true
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    process.off('unhandledRejection', onUnhandled)
  })
  // The kernel's own socket, its second send refused as a closing socket's would be.
  const socket = (kernel as unknown as { socket: { send(frame: string): void } }).socket
  const send = socket.send.bind(socket)
  let sends = 0
  socket.send = (frame: string) => {
    if (++sends === 2) throw new Error('the socket is closing')
    send(frame)
  }
  const ends = await kernel.executeBatch([
    { code: 'one', handlers: quiet() },
    { code: 'two', handlers: quiet() },
    { code: 'three', handlers: quiet() },
  ])
  socket.send = send
  // The rejections lie unread for a while, as a caller awaiting the first end leaves them: none surfaces unhandled.
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  const [second, third] = await Promise.allSettled([ends[1]!, ends[2]!])
  assert.equal(second?.status, 'rejected')
  assert.equal(third?.status, 'rejected')
  const reason = (second as PromiseRejectedResult).reason as Error
  assert.match(reason.message, /the socket is closing/)
  assert.equal((third as PromiseRejectedResult).reason, reason, 'one error for every frame that never went')
  assert.deepEqual(executes().map((frame) => frame.content.code), ['one'], 'a frame after the failed send went')
  fake.shellFinish()
  assert.equal(await ends[0], 'ok')
})

test('a batch that cannot go at all throws as execute does, and sends nothing', async (t) => {
  const kernel = await kernelFor(t)
  fake.keepFrames = true
  await kernel.dispose()
  await assert.rejects(kernel.executeBatch([{ code: 'one', handlers: quiet() }]))
  await assert.rejects(kernel.execute('one', quiet()))
  assert.deepEqual(executes(), [])
})
