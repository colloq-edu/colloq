/**
 * A kernel refused for memory, as the room reads it (K5).
 *
 * On 9 Oct 2026 three idle classes held twelve gigabytes of reservations on
 * a fifteen-gigabyte machine, and the next room read the refusal raw: a red
 * "KernelError: Not enough available memory for this kernel allocation"
 * under a cell whose code was fine, «ЯДРО ОСТАНОВЛЕНО» in the header, and
 * «не удалось открыть общую оболочку — Not enough…» in the shell. Pinned
 * down here, from the refused start to what travels to the browser:
 *
 *  • the cell that was run gets the error under a stable name
 *    (KERNEL_MEMORY_ENAME), not a match on its text; it stays `idle` with no
 *    number, since its code never ran; a second press replaces the notice;
 *  • the notebook's kernel is `off` («НЕ ЗАПУЩЕНО»), not `dead`;
 *  • the kernel log gets one coded line however many entries and presses
 *    repeat the refusal;
 *  • the shell's line is one short sentence in the instance language, coded,
 *    without the English and without the `[colloq]` marker;
 *  • the kernel's and the shell's coded lines take turns without repeating,
 *    and a refusal older than a few minutes is written again;
 *  • the owner's socket is told it is the owner, nobody else's is, and a
 *    handed-off tablet stops being told so when the grant is revoked;
 *  • the words the room draws, by role, in both languages.
 *
 * Docker is faked at the process boundary (tests/_fake-docker.mts) on a
 * daemon of 15 GB: another class holds twelve of them, so a 4 GB start is
 * refused by admission before any container is asked for.
 */
import './_env.mts'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { fakeDocker } from './_fake-docker.mts'
import type { ControlServerMessage } from '../shared/protocol.js'

const { staffMember } = await import('./_scoping.mts')
const { setLocaleResolver, tr } = await import('../shared/i18n.js')
const { getInstanceLanguage, setInstanceLanguage } = await import('../server/src/admin/settings.js')
const { rotateLinkKey, staffAuthorizationVersion } = await import('../server/src/admin/store.js')
const { createSession } = await import('../server/src/db.js')
const { getSessionDoc } = await import('../server/src/collab/index.js')
const { closeControlRoom, handleControlSocket } = await import('../server/src/control.js')
const notebook = await import('../shared/notebook.js')
const { isKernelMemoryOutput, KERNEL_MEMORY_ENAME, kernelMemoryNotice } = await import('../shared/kernel-problem.js')
const kernel = await import('../server/src/kernel/index.js')
const { openTerminal } = await import('../server/src/kernel/terminal.js')
const { forgetResources, useDockerInfo } = await import('../server/src/kernel/resources.js')
const { reserveWork } = await import('../server/src/ops/work-budget.js')

let restore: (() => void) | null = null

/** A full machine: 15 GB, twelve of them held by another class, eight more promised to a run. */
function fullMachine(): void {
  const fake = fakeDocker()
  useDockerInfo(async () => ({ code: 0, out: `${15 * 1024 ** 3} 8` }))
  forgetResources()
  fake.add('memory-room-holder', 'room', { memoryMb: 12_288 })
  const hold = reserveWork({ id: 'memory-room-background', kind: 'competition', memoryMb: 8000, diskBytes: 0 }, {})
  restore = () => {
    hold?.()
    fake.restore()
    useDockerInfo(null)
    forgetResources()
  }
}

const language = getInstanceLanguage()
afterEach(() => {
  restore?.()
  restore = null
  setInstanceLanguage(language)
  setLocaleResolver(getInstanceLanguage)
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

function lines(id: string) {
  return notebook.getTerminal(getSessionDoc(id).doc).toArray().map(notebook.readTerminalLine)
}

/** The room notebook's kernel state, as the header chip reads it. */
function status(id: string): unknown {
  const entry = notebook.kernelsMap(getSessionDoc(id).doc)?.get(notebook.CELLS_KEY)
  return entry instanceof Y.Map ? entry.get(notebook.KERNEL_STATUS_FIELD) : undefined
}

function firstCodeCell(id: string) {
  const cells = notebook.getCells(getSessionDoc(id).doc)
  for (let i = 0; i < cells.length; i++) {
    if (notebook.cellType(cells.get(i)) === 'code') return cells.get(i)
  }
  throw new Error('the welcome notebook has no code cell')
}

/* --------------------------------------------------------------- the cell */

test('the cell that was run carries the refusal under a stable name, stays unrun, and the chip says not running', async () => {
  fullMachine()
  setInstanceLanguage('ru')
  const id = 'memory-room-cell'
  createSession(id, 'Без памяти', 'base')
  const cell = firstCodeCell(id)
  const cellId = cell.get('id') as string

  kernel.requestRun(id, [cellId], 'Мария', 'p_maria')
  assert.ok(
    await until(() => notebook.readOutputs(cell).some(isKernelMemoryOutput)),
    'the refusal never reached the cell',
  )
  const refusal = notebook.readOutputs(cell).find(isKernelMemoryOutput)!
  assert.equal(refusal.kind, 'error')
  assert.equal(refusal.kind === 'error' && refusal.ename, KERNEL_MEMORY_ENAME)
  // The text is the server's sentence, for a tab that does not know the name yet.
  assert.equal(refusal.kind === 'error' && refusal.evalue, tr('server.kernel.memoryFull'))
  assert.doesNotMatch(JSON.stringify(notebook.readOutputs(cell)), /Not enough available memory|KernelError/)
  // Its code never ran: no failure, no number.
  await until(() => cell.get('state') !== 'queued')
  assert.equal(cell.get('state'), 'idle')
  assert.equal(cell.get('execCount') ?? null, null)
  // «НЕ ЗАПУЩЕНО», not «ЯДРО ОСТАНОВЛЕНО».
  assert.ok(await until(() => status(id) === 'off'), `kernel status is ${String(status(id))}`)

  // The kernel log: one coded line.
  const coded = lines(id).filter((line) => line.code === 'kernel_memory')
  assert.equal(coded.length, 1)
  assert.equal(coded[0]!.kind, 'system')
  assert.equal(coded[0]!.text, tr('server.kernel.memoryFull'))

  // A second press on a full machine: still one notice on the cell, still one line in the log.
  kernel.requestRun(id, [cellId], 'Мария', 'p_maria')
  assert.equal(cell.get('state'), 'queued')
  assert.ok(await until(() => cell.get('state') === 'idle'), 'the second press never came back')
  await wait(100)
  assert.equal(notebook.readOutputs(cell).filter(isKernelMemoryOutput).length, 1, 'the notices stacked')
  assert.equal(lines(id).filter((line) => line.code === 'kernel_memory').length, 1, 'the log repeated itself')
  assert.equal(status(id), 'off')
})

/* ------------------------------------------------------- warm-up on entry */

test('entries that warm a refused kernel leave one coded line, not one per person', async () => {
  fullMachine()
  setInstanceLanguage('en')
  const id = 'memory-room-warm'
  createSession(id, 'Warm-up', 'base')
  for (let i = 0; i < 3; i++) await assert.rejects(kernel.ensureKernel(id))
  const coded = lines(id).filter((line) => line.code === 'kernel_memory')
  assert.equal(coded.length, 1)
  assert.match(coded[0]!.text, /^The server is out of memory/)
  assert.equal(status(id), 'off')
  // Something else said in between: the next refusal is news again.
  kernel.kernelNote(id, 'Kernel restarted by Anna.')
  await assert.rejects(kernel.ensureKernel(id))
  assert.equal(lines(id).filter((line) => line.code === 'kernel_memory').length, 2)
})

test("the kernel's refusal and the shell's take turns without either repeating, and every drawer opened says it once", async () => {
  fullMachine()
  setInstanceLanguage('ru')
  const id = 'memory-room-turns'
  createSession(id, 'По очереди', 'base')
  // Students arrive (the join warm-up) and open the drawer, which asks for the shell.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(kernel.ensureKernel(id))
    await assert.rejects(openTerminal(id))
  }
  for (let i = 0; i < 3; i++) await assert.rejects(openTerminal(id))
  const coded = lines(id).filter((line) => line.code === 'kernel_memory')
  assert.deepEqual(
    coded.map((line) => line.text),
    [tr('server.kernel.memoryFull'), tr('server.terminal.memoryFull')],
    'the log repeated a refusal it already shows',
  )
})

test('a refusal from long ago is not today\'s: the same sentence is written again with a fresh time', async () => {
  fullMachine()
  setInstanceLanguage('en')
  const id = 'memory-room-yesterday'
  createSession(id, 'Yesterday', 'base')
  await assert.rejects(kernel.ensureKernel(id))
  const terminal = notebook.getTerminal(getSessionDoc(id).doc)
  // Yesterday's class: the kernel came up later and the sweep took it, and neither writes a line.
  const old = terminal.get(terminal.length - 1)
  old.set('createdAt', Date.now() - 24 * 60 * 60_000)
  await assert.rejects(kernel.ensureKernel(id))
  const coded = lines(id).filter((line) => line.code === 'kernel_memory')
  assert.equal(coded.length, 2, 'the machine is full again and the log says nothing new')
  assert.ok(Date.now() - coded[1]!.createdAt < 60_000)
  // Within minutes it is still the same news.
  await assert.rejects(kernel.ensureKernel(id))
  assert.equal(lines(id).filter((line) => line.code === 'kernel_memory').length, 2)
})

/* -------------------------------------------------------------- the shell */

test('the shared shell says so in one short sentence of the instance language, coded for the drawer', async () => {
  fullMachine()
  for (const [locale, words] of [
    ['ru', 'Не удалось открыть общую оболочку: не хватает памяти на сервере'],
    ['en', 'Could not open the shared shell: the server is out of memory'],
  ] as const) {
    setInstanceLanguage(locale)
    const id = `memory-room-shell-${locale}`
    createSession(id, 'Оболочка', 'base')
    await assert.rejects(openTerminal(id), (err: unknown) => err instanceof Error && err.message === words)
    const last = lines(id).at(-1)!
    assert.equal(last.kind, 'system')
    assert.equal(last.code, 'kernel_memory')
    assert.equal(last.text, words)
    assert.doesNotMatch(JSON.stringify(lines(id)), /Not enough available memory|\[colloq\] /)
  }
})

/* ---------------------------------------------------- who is the owner */

function socket() {
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) heard.push(JSON.parse(String(frame)) as ControlServerMessage)
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
    },
  }
  return { ws: fake as unknown as WebSocket, heard }
}

test("the owner's socket is told it is the owner; a teacher's and a student's are not", () => {
  const id = 'memory-room-role'
  createSession(id, 'Роли', 'base')
  const owner = staffMember('Владелец памяти', 'owner')
  const teacher = staffMember('Учитель памяти')
  const roleOf = (cookie: string | undefined, role: 'host' | 'participant', participantId: string) => {
    const sock = socket()
    const payload = { sessionId: id, participantId, role }
    handleControlSocket(sock.ws, id, payload, { cookieHeader: cookie, payload })
    const frame = sock.heard.find((message) => message.t === 'role')
    assert.ok(frame && frame.t === 'role')
    return frame
  }
  assert.equal(roleOf(owner.cookie, 'host', 'p_owner').owner, true)
  assert.equal(roleOf(teacher.cookie, 'participant', 'p_teacher').owner, undefined)
  assert.equal(roleOf(undefined, 'participant', 'p_student').owner, undefined)
  // A tablet handed off by the owner carries the owner's staff id, and the grant's version, in its token.
  const tablet = (staffVersion: number | null) => {
    const sock = socket()
    handleControlSocket(sock.ws, id, {
      sessionId: id,
      participantId: 'p_tablet',
      role: 'host',
      staff: owner.teacher.id,
      ...(staffVersion === null ? {} : { staffVersion }),
    })
    const frame = sock.heard.find((message) => message.t === 'role')
    assert.ok(frame && frame.t === 'role')
    return frame
  }
  const version = staffAuthorizationVersion(owner.teacher.id)!
  assert.equal(tablet(version).owner, true)
  // The tablet is lost and the owner rotates their link: the grant is revoked
  // at once, the owner flag with it, not when the token expires.
  rotateLinkKey(owner.teacher.id)
  assert.equal(tablet(version).owner, undefined, 'a revoked tablet is still told it is the owner')
  assert.equal(tablet(staffAuthorizationVersion(owner.teacher.id)!).owner, true)
  closeControlRoom(id)
})

/* ------------------------------------------------- what the room draws */

test('the notice names the cause for everyone, sends the owner to Resources, and tells the rest whom to ask', () => {
  setLocaleResolver(() => 'ru')
  const student = kernelMemoryNotice(false)
  assert.equal(student.title, 'Не хватает памяти на сервере')
  assert.equal(
    student.body,
    'Другие занятия заняли память под свои ядра. Попробуйте через пару минут — или попросите владельца сервера остановить простаивающие.',
  )
  assert.equal(student.link, null)
  const owner = kernelMemoryNotice(true)
  assert.match(owner.body, /— или остановите простаивающие во вкладке «Ресурсы»\.$/)
  assert.equal(owner.link, 'Открыть «Ресурсы»')

  setLocaleResolver(() => 'en')
  for (const words of [kernelMemoryNotice(false), kernelMemoryNotice(true)]) {
    for (const text of [words.title, words.body, words.link ?? '']) assert.doesNotMatch(text, /[А-Яа-яЁё]/)
  }
  assert.match(kernelMemoryNotice(true).body, /Resources tab/)
  assert.match(kernelMemoryNotice(false).body, /ask the server owner/)

  // The name, not the words, decides; anything else is an ordinary error.
  assert.equal(isKernelMemoryOutput({ kind: 'error', ename: KERNEL_MEMORY_ENAME, evalue: 'любой текст', traceback: [] }), true)
  assert.equal(isKernelMemoryOutput({ kind: 'error', ename: 'KernelError', evalue: 'Не хватает памяти на сервере', traceback: [] }), false)
  assert.equal(isKernelMemoryOutput({ kind: 'stream', name: 'stderr', text: KERNEL_MEMORY_ENAME }), false)
})

test('a terminal line reads its code only when it is one the room knows', () => {
  const doc = new Y.Doc()
  const terminal = notebook.getTerminal(doc)
  terminal.push([
    notebook.createTerminalLine({ kind: 'system', text: 'plain' }),
    notebook.createTerminalLine({ kind: 'system', text: 'coded', code: 'kernel_memory' }),
  ])
  const junk = notebook.createTerminalLine({ kind: 'system', text: 'junk' })
  junk.set('code', 'rm -rf')
  terminal.push([junk])
  assert.deepEqual(terminal.toArray().map((line) => notebook.readTerminalLine(line).code), [null, 'kernel_memory', null])
  // A line without a code keeps exactly the keys it always had.
  assert.equal(terminal.get(0).has('code'), false)
})
