/**
 * The collaborative notebook document schema.
 *
 * This module is the single contract shared by the browser and the server.
 * Both sides mutate the SAME Y.Doc shape; the server participates as a regular
 * Yjs client, which is how execution outputs reach every participant (including
 * people who join after a cell has already run).
 *
 * Layout of a session Y.Doc:
 *
 *   doc.getArray('cells')  -> Y.Array<Y.Map>   ordered notebook cells
 *   doc.getMap('meta')     -> Y.Map            title, kernel status, run queue
 *
 * A cell Y.Map holds:
 *   id        string                  stable cell identity
 *   type      'code' | 'markdown'
 *   source    Y.Text                  the text everybody types into
 *   outputs   Y.Array<Y.Map>          see OutputCell below
 *   state     CellState               idle | queued | running | ok | error
 *   execCount number | null           In [n]
 *   runBy     string | null           display name of whoever pressed Run
 *
 * An output Y.Map holds:
 *   kind      'stream' | 'data' | 'error'
 *   name      'stdout' | 'stderr'     (stream only)
 *   text      Y.Text                  (stream only) appended to while running
 *   json      string                  (data/error only) JSON payload
 */
import * as Y from 'yjs'

export const CELLS_KEY = 'cells'
export const META_KEY = 'meta'
export const CHAT_KEY = 'chat'
export const TERMINAL_KEY = 'terminal'

export type CellType = 'code' | 'markdown'
export type CellState = 'idle' | 'queued' | 'running' | 'ok' | 'error'
export type KernelStatus = 'starting' | 'idle' | 'busy' | 'restarting' | 'dead'
export type StreamName = 'stdout' | 'stderr'

export interface StreamOutput {
  kind: 'stream'
  name: StreamName
  text: string
}

/** execute_result / display_data: a mimebundle of `mime -> string`. */
export interface DataOutput {
  kind: 'data'
  data: Record<string, string>
  execCount: number | null
}

export interface ErrorOutput {
  kind: 'error'
  ename: string
  evalue: string
  traceback: string[]
}

export type CellOutput = StreamOutput | DataOutput | ErrorOutput

/** Plain-JS snapshot of a cell, for AI context and serialization. */
export interface CellSnapshot {
  id: string
  type: CellType
  source: string
  outputs: CellOutput[]
  state: CellState
  execCount: number | null
  runBy: string | null
}

export type YCell = Y.Map<any>
export type YOutput = Y.Map<any>

/* ------------------------------------------------------------------ chat */

/**
 * The assistant thread lives in the document, not in a per-person inbox.
 *
 * A seminar loses something when questions go into a private tab: the answer
 * helps one student instead of the room, and the teacher never learns what was
 * unclear. Putting the thread in the CRDT makes every question attributable and
 * every answer visible, and streaming lands in everyone's panel at once for
 * free — the same mechanism that carries cell outputs.
 *
 * A chat entry Y.Map holds:
 *   id, participantId, name, color   who asked
 *   question   string
 *   action     AiAction | null
 *   cellId     string | null         cell the question was anchored to
 *   createdAt  number
 *   answer     Y.Text                appended to while the model streams
 *   state      'streaming' | 'done' | 'error'
 */
export type ChatState = 'streaming' | 'done' | 'error'

export interface ChatSnapshot {
  id: string
  participantId: string
  name: string
  color: string
  question: string
  action: string | null
  cellId: string | null
  createdAt: number
  answer: string
  state: ChatState
}

export type YChatEntry = Y.Map<any>

export function getChat(doc: Y.Doc): Y.Array<YChatEntry> {
  return doc.getArray<YChatEntry>(CHAT_KEY)
}

export function createChatEntry(input: {
  participantId: string
  name: string
  color: string
  question: string
  action?: string | null
  cellId?: string | null
}): YChatEntry {
  const entry = new Y.Map<any>()
  entry.set('id', newId('q'))
  entry.set('participantId', input.participantId)
  entry.set('name', input.name)
  entry.set('color', input.color)
  entry.set('question', input.question)
  entry.set('action', input.action ?? null)
  entry.set('cellId', input.cellId ?? null)
  entry.set('createdAt', Date.now())
  entry.set('answer', new Y.Text())
  entry.set('state', 'streaming' as ChatState)
  return entry
}

export function chatAnswer(entry: YChatEntry): Y.Text {
  let text = entry.get('answer') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    entry.set('answer', text)
  }
  return text
}

export function readChatEntry(entry: YChatEntry): ChatSnapshot {
  return {
    id: entry.get('id') as string,
    participantId: (entry.get('participantId') as string) ?? '',
    name: (entry.get('name') as string) ?? 'Someone',
    color: (entry.get('color') as string) ?? '#939598',
    question: (entry.get('question') as string) ?? '',
    action: (entry.get('action') as string | null) ?? null,
    cellId: (entry.get('cellId') as string | null) ?? null,
    createdAt: (entry.get('createdAt') as number) ?? 0,
    answer: chatAnswer(entry).toString(),
    state: (entry.get('state') as ChatState) ?? 'done',
  }
}

export function findChatEntry(doc: Y.Doc, id: string): YChatEntry | null {
  const chat = getChat(doc)
  for (let i = 0; i < chat.length; i++) {
    const entry = chat.get(i)
    if ((entry.get('id') as string) === id) return entry
  }
  return null
}

/* -------------------------------------------------------------- terminal */

/**
 * The terminal is shared for the same reason the kernel is: an install that
 * only one person can see would be a lie, since it changes the environment for
 * every cell in the room. Commands carry the name of whoever typed them.
 *
 * A terminal line Y.Map holds:
 *   id, kind ('command' | 'output' | 'system')
 *   participantId, name, color   (command only)
 *   text     Y.Text              appended to while output streams
 *   createdAt number
 *   running  boolean             (command only) still producing output
 */
export type TerminalLineKind = 'command' | 'output' | 'system'

export interface TerminalLineSnapshot {
  id: string
  kind: TerminalLineKind
  name: string | null
  color: string | null
  text: string
  createdAt: number
  running: boolean
}

export type YTerminalLine = Y.Map<any>

export function getTerminal(doc: Y.Doc): Y.Array<YTerminalLine> {
  return doc.getArray<YTerminalLine>(TERMINAL_KEY)
}

export function createTerminalLine(input: {
  kind: TerminalLineKind
  text?: string
  name?: string | null
  color?: string | null
  participantId?: string | null
}): YTerminalLine {
  const line = new Y.Map<any>()
  line.set('id', newId('t'))
  line.set('kind', input.kind)
  line.set('participantId', input.participantId ?? null)
  line.set('name', input.name ?? null)
  line.set('color', input.color ?? null)
  const text = new Y.Text()
  if (input.text) text.insert(0, input.text)
  line.set('text', text)
  line.set('createdAt', Date.now())
  line.set('running', input.kind === 'command')
  return line
}

export function terminalText(line: YTerminalLine): Y.Text {
  let text = line.get('text') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    line.set('text', text)
  }
  return text
}

export function readTerminalLine(line: YTerminalLine): TerminalLineSnapshot {
  return {
    id: line.get('id') as string,
    kind: (line.get('kind') as TerminalLineKind) ?? 'output',
    name: (line.get('name') as string | null) ?? null,
    color: (line.get('color') as string | null) ?? null,
    text: terminalText(line).toString(),
    createdAt: (line.get('createdAt') as number) ?? 0,
    running: Boolean(line.get('running')),
  }
}

/* ----------------------------------------------------------------- cells */

export function getCells(doc: Y.Doc): Y.Array<YCell> {
  return doc.getArray<YCell>(CELLS_KEY)
}

export function getMeta(doc: Y.Doc): Y.Map<any> {
  return doc.getMap<any>(META_KEY)
}

/** Non-cryptographic id, good enough to distinguish cells. */
export function newId(prefix = 'c'): string {
  return (
    prefix +
    '_' +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  )
}

export function createCell(type: CellType, source = ''): YCell {
  const cell = new Y.Map<any>()
  cell.set('id', newId())
  cell.set('type', type)
  const text = new Y.Text()
  if (source) text.insert(0, source)
  cell.set('source', text)
  cell.set('outputs', new Y.Array<YOutput>())
  cell.set('state', 'idle' as CellState)
  cell.set('execCount', null)
  cell.set('runBy', null)
  return cell
}

export function cellId(cell: YCell): string {
  return cell.get('id') as string
}

export function cellType(cell: YCell): CellType {
  return (cell.get('type') as CellType) ?? 'code'
}

export function cellSource(cell: YCell): Y.Text {
  let text = cell.get('source') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    cell.set('source', text)
  }
  return text
}

export function cellOutputs(cell: YCell): Y.Array<YOutput> {
  let outputs = cell.get('outputs') as Y.Array<YOutput> | undefined
  if (!outputs) {
    outputs = new Y.Array<YOutput>()
    cell.set('outputs', outputs)
  }
  return outputs
}

export function findCell(doc: Y.Doc, id: string): { cell: YCell; index: number } | null {
  const cells = getCells(doc)
  for (let i = 0; i < cells.length; i++) {
    const cell = cells.get(i)
    if (cellId(cell) === id) return { cell, index: i }
  }
  return null
}

/** Convert one output Y.Map into a plain object for rendering. */
export function readOutput(output: YOutput): CellOutput | null {
  const kind = output.get('kind')
  if (kind === 'stream') {
    const text = output.get('text')
    return {
      kind: 'stream',
      name: (output.get('name') as StreamName) ?? 'stdout',
      text: text instanceof Y.Text ? text.toString() : String(text ?? ''),
    }
  }
  if (kind === 'data' || kind === 'error') {
    try {
      const parsed = JSON.parse((output.get('json') as string) ?? '{}')
      return { kind, ...parsed } as CellOutput
    } catch {
      return null
    }
  }
  return null
}

export function readOutputs(cell: YCell): CellOutput[] {
  const out: CellOutput[] = []
  cellOutputs(cell).forEach((o: YOutput) => {
    const parsed = readOutput(o)
    if (parsed) out.push(parsed)
  })
  return out
}

export function readCell(cell: YCell): CellSnapshot {
  return {
    id: cellId(cell),
    type: cellType(cell),
    source: cellSource(cell).toString(),
    outputs: readOutputs(cell),
    state: (cell.get('state') as CellState) ?? 'idle',
    execCount: (cell.get('execCount') as number | null) ?? null,
    runBy: (cell.get('runBy') as string | null) ?? null,
  }
}

export function readNotebook(doc: Y.Doc): CellSnapshot[] {
  return getCells(doc).map(readCell)
}

/**
 * Give a fresh document something to look at. Safe to call on every load:
 * it only writes when the document is genuinely empty.
 */
export function ensureInitialNotebook(doc: Y.Doc, title?: string): void {
  const cells = getCells(doc)
  const meta = getMeta(doc)
  doc.transact(() => {
    if (title && !meta.get('title')) meta.set('title', title)
    if (!meta.has('kernelStatus')) meta.set('kernelStatus', 'starting' as KernelStatus)
    if (cells.length === 0) {
      cells.push([
        createCell(
          'markdown',
          '# Welcome\n\nEveryone in this session edits the same notebook. Type here, run code below.',
        ),
        createCell('code', 'print("hello, seminar")'),
      ])
    }
  }, 'init')
}
