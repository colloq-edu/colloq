/**
 * Комната, которой на узле нет места, — от ответа брокера до того, что читают люди.
 *
 * 18.09: память комнаты на k3s резервируется целиком, и на занятом узле Pod
 * стоит в Pending с «Insufficient memory». Комната при этом читала «Room
 * startup timed out: pending» — одинаково для студента и преподавателя, и
 * ничего о том, что делать. Теперь брокер отвечает словом и числами
 * (runtime-lifecycle проверяет его против подделки API), а здесь закреплён
 * путь веб-стороны: студентам в ячейке и журнале ядра — короткое и без
 * устройства сервера, преподавателю — слово в meta документа, из которого
 * комната рисует совет с числами.
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
/** Что брокер ответит на подъём: статус и тело. */
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

test('студент читает короткое «преподаватель видит причину», преподаватель получает совет с числом', async () => {
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

  // То, что видит вся комната: ни слова брокера, ни слова Kubernetes.
  const note = lastKernelLine(id)
  assert.equal(
    note,
    'Python в этой комнате сейчас не запускается: на сервере нет для неё места. Преподаватель видит причину и может это исправить.',
  )
  assert.doesNotMatch(JSON.stringify(getTerminal(doc).toJSON()), /allocatable|timed out|Insufficient/)

  // То, что комната рисует ведущему из слова в документе.
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

  // Другая причина отказа снимает совет: «уменьшите память» к ней неправда.
  answer = { status: 503, body: { error: 'Room startup timed out: ErrImagePull' } }
  await assert.rejects(ensureKernel(id))
  assert.equal(meta.has(KERNEL_PROBLEM_KEY), false)
  assert.match(lastKernelLine(id), /ErrImagePull/)
})

test('совет называет ядра, видеокарту или отсылает к администратору — и не верит мусору в документе', () => {
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
