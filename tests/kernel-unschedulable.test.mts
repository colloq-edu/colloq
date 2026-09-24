/**
 * A room with no space for it on the node — from the broker's answer to what
 * people read.
 *
 * 18 Sep 2026: a room's memory on k3s is reserved in full, and on a busy node
 * the Pod sits in Pending with "Insufficient memory". Meanwhile the room read
 * "Room startup timed out: pending" — the same for a student and a teacher,
 * and nothing about what to do. Now the broker answers with a word and numbers
 * (runtime-lifecycle checks it against a fake API), and this pins down the
 * web side's path: for students in the cell and the kernel log, something
 * short and free of server internals; for the teacher, a word in the
 * document's meta from which the room draws advice with numbers.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { TEST_ROOT } from './_env.mts'
import { setLocaleResolver } from '../shared/i18n.js'
import { getMeta, getTerminal, readTerminalLine } from '../shared/notebook.js'
import { KERNEL_PROBLEM_KEY, kernelProblemAdvice, readKernelProblem } from '../shared/kernel-problem.js'
import { createSession, setSessionMemoryMb } from '../server/src/db.js'
import { ensureKernel } from '../server/src/kernel/index.js'
import { getSessionDoc } from '../server/src/collab/index.js'

const digest = 'a'.repeat(64)
const catalog = {
  schemaVersion: 1,
  release: 'v1',
  defaultEnvironment: 'base',
  environments: [{ name: 'base', image: `registry.example/base@sha256:${digest}`, gpu: false }],
}
/** What the broker will answer to a start: status and body. */
let answer: { status: number; body: unknown } = { status: 503, body: {} }
let broker: http.Server
const saved = { ...process.env }

before(async () => {
  broker = http.createServer(async (req, res) => {
    for await (const _ of req) void _
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST') {
      res.statusCode = answer.status
      return res.end(JSON.stringify(answer.body))
    }
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((r) => broker.listen(0, '127.0.0.1', r))
  const token = path.join(TEST_ROOT, 'broker-unschedulable-token')
  fs.writeFileSync(token, 'k'.repeat(64))
  const catalogFile = path.join(TEST_ROOT, 'broker-unschedulable-catalog.json')
  fs.writeFileSync(catalogFile, JSON.stringify(catalog))
  Object.assign(process.env, {
    KERNEL_BACKEND: 'broker',
    KERNEL_ISOLATION: 'required',
    KERNEL_RUNTIME_URL: `http://127.0.0.1:${(broker.address() as { port: number }).port}`,
    KERNEL_RUNTIME_TOKEN_FILE: token,
    KERNEL_CATALOG_FILE: catalogFile,
  })
})

after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  setLocaleResolver(() => 'ru')
  broker?.closeAllConnections()
  await new Promise<void>((r) => broker.close(() => r()))
})

function lastKernelLine(id: string): string {
  const lines = getTerminal(getSessionDoc(id).doc).toArray()
  return readTerminalLine(lines[lines.length - 1]!).text
}

test('a student reads a short "the teacher can see why", the teacher gets advice with a number', async () => {
  setLocaleResolver(() => 'ru')
  const id = 'unschedulable-room'
  createSession(id, 'Занятие на полном узле', 'base')
  setSessionMemoryMb(id, 6144)
  answer = {
    status: 503,
    body: {
      error: 'Room Pod cannot be scheduled: node lacks allocatable memory',
      unschedulable: 'memory',
      memoryMb: 6144,
      cpus: 2,
    },
  }
  await assert.rejects(ensureKernel(id))
  const doc = getSessionDoc(id).doc
  const meta = getMeta(doc)
  assert.equal(meta.get('kernelStatus'), 'dead')
  assert.deepEqual(meta.get(KERNEL_PROBLEM_KEY), { unschedulable: 'memory', memoryMb: 6144, cpus: 2 })

  // What the whole room sees: no broker wording and no Kubernetes wording.
  const note = lastKernelLine(id)
  assert.equal(
    note,
    'Python в этой комнате сейчас не запускается: на сервере нет для неё места. Преподаватель видит причину и может это исправить.',
  )
  assert.doesNotMatch(JSON.stringify(getTerminal(doc).toJSON()), /allocatable|timed out|Insufficient/)

  // What the room draws for the host from the word in the document.
  const problem = readKernelProblem(meta.get(KERNEL_PROBLEM_KEY))
  assert.ok(problem)
  assert.equal(
    kernelProblemAdvice(problem),
    'Сервер не может выделить комнате 6 ГБ: память узла занята другими комнатами — уменьшите память этой или других комнат или закройте ненужные.',
  )
  setLocaleResolver(() => 'en')
  assert.equal(
    kernelProblemAdvice(problem),
    'The server can’t give this room 6 GB: the node’s memory is taken by other rooms — lower the memory of this room or of others, or close rooms you don’t need.',
  )
  setLocaleResolver(() => 'ru')

  // A different refusal reason removes the advice: "reduce the memory" would
  // be untrue for it.
  answer = { status: 503, body: { error: 'Room startup timed out: ErrImagePull' } }
  await assert.rejects(ensureKernel(id))
  assert.equal(meta.has(KERNEL_PROBLEM_KEY), false)
  assert.match(lastKernelLine(id), /ErrImagePull/)
})

test('the advice names cores or the GPU, or refers to the administrator — and does not trust junk in the document', () => {
  setLocaleResolver(() => 'ru')
  assert.match(kernelProblemAdvice({ unschedulable: 'cpu', cpus: 2 }), /^Сервер не может выделить комнате 2 ядра:/)
  assert.match(kernelProblemAdvice({ unschedulable: 'cpu', cpus: 5 }), /5 ядер/)
  assert.match(kernelProblemAdvice({ unschedulable: 'memory', memoryMb: 2560 }), /2,5 ГБ/)
  assert.match(kernelProblemAdvice({ unschedulable: 'gpu' }), /видеокарту/)
  assert.match(kernelProblemAdvice({ unschedulable: 'other' }), /администратору/)
  setLocaleResolver(() => 'en')
  assert.match(kernelProblemAdvice({ unschedulable: 'cpu', cpus: 1 }), /1 CPU core:/)
  setLocaleResolver(() => 'ru')
  for (const garbage of [null, 'memory', { unschedulable: 'disk' }, ['memory']])
    assert.equal(readKernelProblem(garbage), null)
  assert.deepEqual(readKernelProblem({ unschedulable: 'memory', memoryMb: '6Gi' }), { unschedulable: 'memory' })
})
