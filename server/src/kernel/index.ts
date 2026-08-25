import * as Y from 'yjs'
import {
  cellId as idOf,
  cellOutputs,
  cellSource,
  cellType,
  findCell,
  getCells,
  getMeta,
  type CellState,
  type KernelStatus,
} from '@shared/notebook'
import { getSessionDoc } from '../collab/index.js'
import { JupyterKernel, type KernelPhase } from './jupyter.js'
import { OutputWriter } from './outputs.js'
import { closeTerminal } from './terminal.js'

/**
 * The per-session Python runtime.
 *
 * One seminar means one kernel and one queue: everybody shares the same
 * variables, and cells run strictly one at a time so `df` means the same thing
 * to the room as it does to the person who pressed Run. Runtime state is
 * mirrored into the document's `meta` map rather than pushed over a side
 * channel, so a browser that just finished syncing already knows what is
 * queued, what is running, and who asked for it.
 */

/** Marks every write this module makes to a session document. */
const ORIGIN = 'kernel'

interface QueueItem {
  cellId: string
  runBy: string
}

interface Runtime {
  sessionId: string
  kernel: JupyterKernel | null
  /** In-flight connect, shared by concurrent ensureKernel callers. */
  starting: Promise<void> | null
  queue: QueueItem[]
  pumping: boolean
  currentCell: string | null
  writer: OutputWriter | null
}

const runtimes = new Map<string, Runtime>()
const workspaceListeners: Array<(sessionId: string) => void> = []

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function getRuntime(sessionId: string): Runtime {
  let runtime = runtimes.get(sessionId)
  if (!runtime) {
    runtime = {
      sessionId,
      kernel: null,
      starting: null,
      queue: [],
      pumping: false,
      currentCell: null,
      writer: null,
    }
    runtimes.set(sessionId, runtime)
  }
  return runtime
}

/* --------------------------------------------------------- document mirror */

function setStatus(runtime: Runtime, status: KernelStatus): void {
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  if (meta.get('kernelStatus') === status) return
  doc.transact(() => meta.set('kernelStatus', status), ORIGIN)
}

function syncQueue(runtime: Runtime): void {
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  const ids = runtime.queue.map((item) => item.cellId)
  const running = runtime.currentCell ?? null

  const existing = meta.get('queue')
  const current = existing instanceof Y.Array ? (existing.toArray() as string[]) : null
  const queueUnchanged =
    current !== null && current.length === ids.length && current.every((id, i) => id === ids[i])
  if (queueUnchanged && meta.get('runningCell') === running) return

  doc.transact(() => {
    let list = meta.get('queue') as Y.Array<string> | undefined
    if (!(list instanceof Y.Array)) {
      list = new Y.Array<string>()
      meta.set('queue', list)
    }
    if (list.length > 0) list.delete(0, list.length)
    if (ids.length > 0) list.push(ids)
    meta.set('runningCell', running)
  }, ORIGIN)
}

function setCellState(sessionId: string, cellId: string, state: CellState): void {
  const { doc } = getSessionDoc(sessionId)
  const found = findCell(doc, cellId)
  if (!found) return
  doc.transact(() => found.cell.set('state', state), ORIGIN)
}

/** Queued work the kernel will never get to; put those cells back to rest. */
function dropQueue(runtime: Runtime): void {
  if (runtime.queue.length === 0) {
    syncQueue(runtime)
    return
  }
  const dropped = runtime.queue.splice(0, runtime.queue.length)
  const { doc } = getSessionDoc(runtime.sessionId)
  doc.transact(() => {
    for (const item of dropped) {
      const found = findCell(doc, item.cellId)
      if (found && found.cell.get('state') === 'queued') found.cell.set('state', 'idle' as CellState)
    }
  }, ORIGIN)
  syncQueue(runtime)
}

function onPhase(runtime: Runtime, phase: KernelPhase): void {
  if (phase === 'dead') {
    dropQueue(runtime)
    setStatus(runtime, 'dead')
    return
  }
  // A cell mid-run keeps the room's status honest even between kernel messages.
  setStatus(runtime, runtime.currentCell ? 'busy' : phase)
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Idempotent and concurrency-safe: five students hitting Run at once share one
 * connect. A kernel that has died counts as absent, so the next Run quietly
 * brings a fresh one up instead of demanding a manual restart.
 */
export function ensureKernel(sessionId: string): Promise<void> {
  const runtime = getRuntime(sessionId)
  if (runtime.kernel && runtime.kernel.phase !== 'dead') return Promise.resolve()
  if (runtime.starting) return runtime.starting

  const dead = runtime.kernel
  runtime.kernel = null

  runtime.starting = (async () => {
    setStatus(runtime, 'starting')
    if (dead) {
      try {
        await dead.dispose()
      } catch {
        /* it was already gone */
      }
    }
    try {
      const kernel = await JupyterKernel.connect(sessionId)
      runtime.kernel = kernel
      kernel.onPhaseChange((phase) => onPhase(runtime, phase))
      setStatus(runtime, runtime.currentCell ? 'busy' : (kernel.phase as KernelStatus))
    } catch (err) {
      setStatus(runtime, 'dead')
      throw err
    } finally {
      runtime.starting = null
    }
  })()

  return runtime.starting
}

export async function restartSession(sessionId: string): Promise<void> {
  const runtime = getRuntime(sessionId)
  dropQueue(runtime)
  setStatus(runtime, 'restarting')
  try {
    if (runtime.kernel && runtime.kernel.phase !== 'dead') await runtime.kernel.restart()
    else await ensureKernel(sessionId)
    resetAllCells(sessionId)
    setStatus(runtime, 'idle')
  } catch (err) {
    // Never a rejection: the person clicked a button, the document carries the news.
    console.error(`[kernel] restart failed for ${sessionId}:`, errText(err))
    setStatus(runtime, 'dead')
  }
}

export async function interruptSession(sessionId: string): Promise<void> {
  const runtime = getRuntime(sessionId)
  // Drop the tail first: interrupting cell 3 of 10 must not start cell 4.
  dropQueue(runtime)
  if (!runtime.kernel || runtime.kernel.phase === 'dead') return
  try {
    await runtime.kernel.interrupt()
  } catch (err) {
    console.error(`[kernel] interrupt failed for ${sessionId}:`, errText(err))
  }
}

/**
 * Stop one session's kernel and its shell, and forget both. A deleted seminar
 * must not leave a process running in the container writing output into a
 * document that is on its way out — and because every writer here reaches for
 * the document through getSessionDoc(), which creates one on demand, this has
 * to finish before the document is evicted or it simply builds another.
 * Every other caller wants restartSession, which keeps the room.
 */
export async function shutdownSession(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId)
  if (runtime) {
    runtimes.delete(sessionId)
    runtime.queue.length = 0
    runtime.writer?.dispose()
    runtime.writer = null
    try {
      await runtime.kernel?.dispose()
    } catch (err) {
      console.error(`[kernel] could not stop ${sessionId}:`, errText(err))
    }
  }
  try {
    await closeTerminal(sessionId)
  } catch (err) {
    console.error(`[kernel] could not stop the terminal for ${sessionId}:`, errText(err))
  }
}

export async function shutdownKernels(): Promise<void> {
  const all = [...runtimes.values()]
  runtimes.clear()
  await Promise.allSettled(
    all.map(async (runtime) => {
      runtime.queue.length = 0
      runtime.writer?.dispose()
      runtime.writer = null
      await runtime.kernel?.dispose()
    }),
  )
}

/* -------------------------------------------------------------- run queue */

export function requestRun(sessionId: string, cellIds: string[], runBy: string): void {
  const runtime = getRuntime(sessionId)
  const { doc } = getSessionDoc(sessionId)

  doc.transact(() => {
    for (const cellId of cellIds) {
      const found = findCell(doc, cellId)
      // Markdown cells arrive in every runAll list; skipping them is not an error.
      if (!found || cellType(found.cell) !== 'code') continue
      if (runtime.currentCell === cellId) continue
      if (runtime.queue.some((item) => item.cellId === cellId)) continue
      runtime.queue.push({ cellId, runBy })
      found.cell.set('state', 'queued' as CellState)
      found.cell.set('runBy', runBy)
    }
  }, ORIGIN)

  syncQueue(runtime)
  void pump(runtime)
}

async function pump(runtime: Runtime): Promise<void> {
  if (runtime.pumping) return
  runtime.pumping = true
  try {
    while (runtime.queue.length > 0) {
      try {
        await ensureKernel(runtime.sessionId)
      } catch (err) {
        reportDeadKernel(runtime, errText(err))
        return
      }
      const item = runtime.queue.shift()
      if (!item) break
      await runOne(runtime, item)
      if (runtime.kernel && runtime.kernel.phase === 'dead') {
        dropQueue(runtime)
        return
      }
    }
  } catch (err) {
    // The queue must not die silently with cells stuck on "running".
    console.error(`[kernel] run queue failed for ${runtime.sessionId}:`, errText(err))
    reportDeadKernel(runtime, errText(err))
  } finally {
    runtime.pumping = false
    runtime.currentCell = null
    syncQueue(runtime)
    const phase = runtime.kernel?.phase ?? 'dead'
    setStatus(runtime, phase === 'busy' ? 'idle' : (phase as KernelStatus))
  }
}

async function runOne(runtime: Runtime, item: QueueItem): Promise<void> {
  const { doc } = getSessionDoc(runtime.sessionId)
  const found = findCell(doc, item.cellId)
  // Someone deleted the cell while it sat in the queue.
  if (!found || cellType(found.cell) !== 'code') return

  const cell = found.cell
  const source = cellSource(cell).toString()
  const writer = new OutputWriter(doc, item.cellId)
  runtime.currentCell = item.cellId
  runtime.writer = writer
  syncQueue(runtime)
  setStatus(runtime, 'busy')

  doc.transact(() => {
    cell.set('state', 'running' as CellState)
    cell.set('runBy', item.runBy)
    cell.set('execCount', null)
  }, ORIGIN)
  // Stale output is cleared at the start of the run, not when queued: until a
  // cell actually starts, the last result is still the truth on screen.
  writer.clear()

  if (source.trim().length === 0) {
    runtime.currentCell = null
    runtime.writer = null
    writer.dispose()
    setCellState(runtime.sessionId, item.cellId, 'ok')
    return
  }

  let state: CellState = 'idle'
  try {
    const status = await runtime.kernel!.execute(source, {
      onExecuteInput: (execCount) => {
        const target = findCell(doc, item.cellId)
        if (target) doc.transact(() => target.cell.set('execCount', execCount), ORIGIN)
      },
      onStream: (name, text) => writer.stream(name, text),
      onData: (mimebundle, execCount) => writer.data(mimebundle, execCount),
      onError: (ename, evalue, traceback) => writer.error(ename, evalue, traceback),
      onClear: () => writer.clear(),
    })
    state = status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'idle'
    if (status === 'abort' && runtime.kernel?.phase === 'dead') {
      writer.error('KernelDied', deadMessage(), [])
      state = 'error'
    }
  } catch (err) {
    writer.error('KernelError', errText(err), [])
    state = 'error'
  } finally {
    writer.dispose()
    runtime.writer = null
    runtime.currentCell = null
  }

  setCellState(runtime.sessionId, item.cellId, state)
  syncQueue(runtime)
  // The cell may have written a CSV; the Files panel should not need a refresh.
  notifyWorkspaceChanged(runtime.sessionId)
}

/** A kernel that will not come up is an output on the cell, never a crash. */
function reportDeadKernel(runtime: Runtime, message: string): void {
  const { doc } = getSessionDoc(runtime.sessionId)
  const stuck = runtime.currentCell ?? runtime.queue[0]?.cellId ?? null
  if (stuck) {
    const writer = runtime.writer ?? new OutputWriter(doc, stuck)
    writer.error('KernelError', message, [])
    writer.dispose()
    runtime.writer = null
    runtime.currentCell = null
    if (runtime.queue[0]?.cellId === stuck) runtime.queue.shift()
    setCellState(runtime.sessionId, stuck, 'error')
  }
  dropQueue(runtime)
  setStatus(runtime, 'dead')
}

function deadMessage(): string {
  return 'The Python kernel stopped responding — restart it to keep going. (A cell that allocates all the memory will do this.)'
}

/* ------------------------------------------------------------------ outputs */

export function clearOutputs(sessionId: string, cellId?: string): void {
  const { doc } = getSessionDoc(sessionId)
  const cells = getCells(doc)
  doc.transact(() => {
    cells.forEach((cell) => {
      if (cellId && idOf(cell) !== cellId) return
      const outputs = cellOutputs(cell)
      if (outputs.length > 0) outputs.delete(0, outputs.length)
      const state = cell.get('state') as CellState | undefined
      // Leave queued and running cells alone; their state belongs to the queue.
      if (state === 'ok' || state === 'error') cell.set('state', 'idle' as CellState)
    })
  }, ORIGIN)
}

function resetAllCells(sessionId: string): void {
  const { doc } = getSessionDoc(sessionId)
  const cells = getCells(doc)
  doc.transact(() => {
    cells.forEach((cell) => {
      // In [3] after a restart would be a lie: the counter starts over.
      cell.set('execCount', null)
      cell.set('state', 'idle' as CellState)
    })
  }, ORIGIN)
}

/* -------------------------------------------------------------- workspace */

export function onWorkspaceChanged(cb: (sessionId: string) => void): void {
  workspaceListeners.push(cb)
}

function notifyWorkspaceChanged(sessionId: string): void {
  for (const cb of [...workspaceListeners]) {
    try {
      cb(sessionId)
    } catch (err) {
      console.error(`[kernel] workspace listener failed for ${sessionId}:`, errText(err))
    }
  }
}
