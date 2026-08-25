/**
 * Renders the live notebook as plain text for the model.
 *
 * The browser sends nothing but a cell id: everything the assistant knows comes
 * from the server's own copy of the CRDT, read at the moment of the question.
 * That is the whole point of the feature — "why is this broken?" is meaningless
 * without the traceback a classmate produced ten seconds ago, and nobody should
 * have to paste code into another tab.
 *
 * Budget order, when the notebook is bigger than the window: the selected cell
 * and the newest traceback survive intact, distant cells are elided first.
 */
import { getMeta, readNotebook, type CellOutput, type CellSnapshot, type DataOutput, type KernelStatus } from '@shared/notebook'
import { getAssistantSettings } from '../admin/settings.js'
import { getSessionDoc } from '../collab/index.js'
import { getSession } from '../db.js'
import { listFiles } from '../workspace.js'

const MAX_SOURCE = 1_500
const MAX_OUTPUT = 800
const MAX_FILES = 40

export function buildContext(sessionId: string, selectedCellId: string | null): string {
  // Read per question, not per boot: a teacher who lowers the budget mid-class
  // to fit a smaller model must see the next question honour it.
  const maxTotal = getAssistantSettings().contextChars
  const { doc } = getSessionDoc(sessionId)
  const cells = readNotebook(doc)
  const meta = getMeta(doc)

  const sessionName =
    getSession(sessionId)?.name ?? (meta.get('title') as string | undefined) ?? 'Untitled seminar'
  const kernel = (meta.get('kernelStatus') as KernelStatus | undefined) ?? 'idle'

  const selectedIndex = selectedCellId ? cells.findIndex((c) => c.id === selectedCellId) : -1
  const errorIndex = newestErrorIndex(cells)
  const pinned = new Set<number>()
  if (selectedIndex >= 0) pinned.add(selectedIndex)
  if (errorIndex >= 0) pinned.add(errorIndex)

  const header = [
    `SESSION: ${sessionName}`,
    `KERNEL: ${kernel}`,
    `FILES IN WORKSPACE: ${describeFiles(sessionId)}`,
    selectedIndex >= 0
      ? `SELECTED CELL: ${selectedIndex} (id ${cells[selectedIndex].id})`
      : 'SELECTED CELL: none',
    `NOTEBOOK (${cells.length} cell${cells.length === 1 ? '' : 's'}, top to bottom; trimmed regions are marked "… truncated …"):`,
  ].join('\n')

  const blocks = cells.map((cell, i) => renderCell(cell, i, pinned.has(i), i === selectedIndex))
  const assemble = () => [header, ...blocks].join('\n\n')

  // Attention follows the student: drop the cells furthest from what they are
  // looking at, never the cell they asked about or the failure they hit.
  const anchor = selectedIndex >= 0 ? selectedIndex : errorIndex >= 0 ? errorIndex : cells.length - 1
  const droppable = cells
    .map((_, i) => i)
    .filter((i) => !pinned.has(i))
    .sort((a, b) => Math.abs(b - anchor) - Math.abs(a - anchor))

  let text = assemble()
  for (const i of droppable) {
    if (text.length <= maxTotal) break
    blocks[i] = elide(cells[i], i)
    text = assemble()
  }
  return text.length > maxTotal ? clip(text, maxTotal) : text
}

/**
 * "Newest" means most recently executed, not lowest on the page: seminars run
 * cells out of order constantly.
 */
function newestErrorIndex(cells: CellSnapshot[]): number {
  let best = -1
  let bestCount = -1
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].outputs.some((o) => o.kind === 'error')) continue
    const count = cells[i].execCount ?? 0
    if (count >= bestCount) {
      best = i
      bestCount = count
    }
  }
  return best
}

function renderCell(cell: CellSnapshot, index: number, full: boolean, selected: boolean): string {
  const head = [`[cell ${index}]`, cell.type, cell.state]
  if (cell.execCount !== null) head.push(`In[${cell.execCount}]`)
  if (cell.runBy) head.push(`run by ${cell.runBy}`)

  const lines = [head.join(' · ') + (selected ? '   <-- the student has this cell selected' : '')]

  const source = cell.source.trim()
  if (!source) lines.push('(empty)')
  else {
    lines.push('```' + (cell.type === 'code' ? 'python' : 'markdown'))
    lines.push(full ? source : clip(source, MAX_SOURCE))
    lines.push('```')
  }

  for (const output of cell.outputs) lines.push(renderOutput(output, full))
  return lines.join('\n')
}

function renderOutput(output: CellOutput, full: boolean): string {
  const limit = full ? MAX_OUTPUT * 2 : MAX_OUTPUT

  if (output.kind === 'stream') {
    return `out[${output.name}]:\n${clip(output.text.trimEnd(), limit)}`
  }
  if (output.kind === 'error') {
    const label = `out[error]: ${output.ename}: ${output.evalue}`
    const traceback = stripAnsi(output.traceback.join('\n')).trim()
    if (!traceback) return label
    return `${label}\n${full ? traceback : clip(traceback, limit)}`
  }
  return `out[result]:\n${renderData(output, limit)}`
}

function renderData(output: DataOutput, limit: number): string {
  const plain = output.data['text/plain']
  const parts: string[] = []
  if (plain !== undefined) parts.push(clip(plain, limit))

  for (const [mime, value] of Object.entries(output.data)) {
    if (mime === 'text/plain') continue
    if (mime.startsWith('image/')) {
      // Base64 pixels are pure noise to the model and would eat the whole budget.
      parts.push(`[${mime}, ~${Math.max(1, Math.round((value.length * 0.75) / 1024))} KB image]`)
    } else if (parts.length === 0) {
      parts.push(clip(value, limit))
    } else {
      parts.push(`[${mime}, ${value.length} chars]`)
    }
  }
  return parts.length ? parts.join('\n') : '(no data)'
}

function elide(cell: CellSnapshot, index: number): string {
  const source = cell.source.trim()
  const lineCount = source ? source.split('\n').length : 0
  const first = source.split('\n').find((line) => line.trim().length > 0) ?? ''
  const head = [`[cell ${index}]`, cell.type, cell.state]
  if (cell.execCount !== null) head.push(`In[${cell.execCount}]`)
  const preview = first ? ` starting "${clipLine(first.trim(), 60)}"` : ''
  return `${head.join(' · ')} — … ${lineCount} line${lineCount === 1 ? '' : 's'} elided …${preview}`
}

/**
 * Keeps both ends of a long region: the head says what it is, and the tail of a
 * traceback is where the actual error lives.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, Math.ceil(limit * 0.65)).trimEnd()
  const tail = text.slice(text.length - Math.floor(limit * 0.35)).trimStart()
  return `${head}\n… truncated ${text.length - limit} chars …\n${tail}`
}

function clipLine(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

function describeFiles(sessionId: string): string {
  const names = listFiles(sessionId).map((f) => f.name)
  if (names.length === 0) return '(none)'
  if (names.length <= MAX_FILES) return names.join(', ')
  return `${names.slice(0, MAX_FILES).join(', ')} … and ${names.length - MAX_FILES} more`
}

/** IPython colours its tracebacks; the escape codes are just tokens to a model. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}
