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
 *   runById   string | null           and their participant id — names are not
 *                                     unique in a seminar, so this is what says
 *                                     whether a run is YOURS
 *   stdin     {prompt,password}|null  set while the cell is stopped in input()
 *   startedAt number | null           server clock at the instant this run
 *                                     began; the cell's live timer counts from
 *                                     it. Written by the kernel, never read
 *                                     unless state is 'running'
 *   ranMs     number | null           how long the last SETTLED run took. Also
 *                                     the kernel's; an interrupted run leaves
 *                                     it null, because it has no finish time
 *
 * The last three are written only by the server and are display-only: nothing
 * in this product may gate a control on them. The list above was short by one
 * for months — `stdin` was written by the kernel and documented nowhere, which
 * is exactly how it came to be missing from cloneCell and to vanish whenever a
 * neighbouring cell moved.
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
  runById: string | null
  /** Server clock when this run began. Meaningful only while state is 'running'. */
  startedAt: number | null
  /** How long the last settled run took. Null after an interrupt: it never finished. */
  ranMs: number | null
  /**
   * Set while the cell is stopped inside input(). The kernel is blocked until
   * somebody answers, and in a shared room that somebody is not necessarily
   * whoever pressed Run — so the ask lives in the document, where everybody
   * can see it.
   */
  stdin: { prompt: string; password: boolean } | null
}

export type YCell = Y.Map<any>
export type YOutput = Y.Map<any>

/* ------------------------------------------------------------------ chat */

/**
 * The oracle thread lives in the document, not in a per-person inbox.
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
 *   reasoning  Y.Text                the model's own trace, when it sends one
 *   thoughtMs  number | null         how long the trace took
 *   state      'streaming' | 'done' | 'error'
 */
export type ChatState = 'streaming' | 'done' | 'error'

/**
 * What happened to a proposed edit.
 *
 * `open` is a patch nobody has decided about yet — that is the state the cell
 * draws a diff for. It lives in the document rather than in the asker's browser
 * on purpose: a proposal the room can see is a proposal the room can discuss,
 * and whoever accepts it is doing it in front of everyone rather than quietly.
 */
export type PatchState = 'open' | 'accepted' | 'rejected'

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
  /** The complete proposed source of `cellId`, or null when the turn proposed none. */
  patch: string | null
  /**
   * What the cell held when the oracle was asked.
   *
   * A proposal is a rewrite of a particular text, and in a room of twenty
   * people that text moves while the model is still writing. Kept so the cell
   * can say "this was written against an older version" instead of silently
   * overwriting somebody's work with an answer to a question about a cell that
   * no longer exists.
   */
  patchBase: string | null
  patchState: PatchState
  /** Who accepted or rejected it, for the line the thread shows afterwards. */
  patchBy: string | null
  /**
   * What the model said to itself before answering, verbatim.
   *
   * Empty for most turns: only some endpoints send a trace at all, and asking
   * for one is limited to the single provider with a documented switch (see
   * ai/provider.ts). Empty is therefore a normal state and not a fault — the
   * interface simply has no strip to draw.
   *
   * Kept apart from `answer` rather than prefixed into it, because the two are
   * read differently. The answer is what the room is told; the trace is how it
   * was arrived at, and a reader who wants it goes looking for it.
   */
  reasoning: string
  /**
   * Milliseconds between the question and the first word of the answer.
   *
   * Measured, not reported: it is the wait a person actually sat through,
   * which is the number the strip claims. Null while the answer has not
   * started, and on every turn recorded before this existed.
   */
  thoughtMs: number | null
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
  /** The cell's text at the moment of asking; see ChatSnapshot.patchBase. */
  patchBase?: string | null
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
  entry.set('reasoning', new Y.Text())
  entry.set('thoughtMs', null)
  entry.set('state', 'streaming' as ChatState)
  entry.set('patch', null)
  entry.set('patchBase', input.patchBase ?? null)
  entry.set('patchState', 'open' as PatchState)
  entry.set('patchBy', null)
  return entry
}

/**
 * Accept a proposal: the cell becomes what the oracle wrote.
 *
 * The write is an ordinary edit, so it merges like any other, everyone watches
 * it land at once, and it becomes a version in the room's history under the
 * name of whoever pressed Accept — not under the oracle's. A person decided;
 * the model only offered.
 *
 * Returns false when there is nothing to apply, which covers the two races that
 * matter: somebody else accepted it a second earlier, and the cell was deleted
 * while the answer was being written.
 */
/**
 * Заменить текст, не переписывая его целиком.
 *
 * `delete(0, length)` с последующим `insert(0, next)` — это «весь текст исчез,
 * появился другой». Для CRDT так и есть: у всех, кто стоял в этой ячейке,
 * курсор уезжает в начало, выделение пропадает, а сосед, печатавший в конце
 * файла, обнаруживает свою строку посреди чужой. Между тем «принять правку» и
 * «вернуть версию» меняют обычно несколько строк из сорока.
 *
 * Общее начало и общий конец остаются нетронутыми, переписывается середина.
 * Это не полноценный diff — вставка в начало файла, повторяющая его конец, всё
 * ещё перепишет много лишнего, — но там, где текст правят, а не сочиняют
 * заново, курсоры стоят на месте.
 */
export function replaceText(text: Y.Text, next: string): void {
  const before = text.toString()
  if (before === next) return

  let head = 0
  const max = Math.min(before.length, next.length)
  while (head < max && before[head] === next[head]) head++

  let tail = 0
  while (
    tail < max - head &&
    before[before.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++
  }

  const removed = before.length - head - tail
  if (removed > 0) text.delete(head, removed)
  const added = next.slice(head, next.length - tail)
  if (added) text.insert(head, added)
}

export function acceptPatch(doc: Y.Doc, entry: YChatEntry, byName: string): boolean {
  const patch = entry.get('patch')
  const cellId = entry.get('cellId')
  if (typeof patch !== 'string' || typeof cellId !== 'string') return false
  if (entry.get('patchState') !== 'open') return false

  const cells = getCells(doc)
  let target: YCell | null = null
  for (const cell of cells.toArray()) {
    if (cell.get('id') === cellId) {
      target = cell
      break
    }
  }
  if (!target) return false

  const source = target.get('source') as Y.Text | undefined
  if (!source) return false

  /*
   * Claim first, write second, both in one transaction.
   *
   * The check above reads a value that may be seconds old: the panel and the
   * cell both show Accept, and a teacher pressing one while a student presses
   * the other produced two writes and a cell holding the patch twice. Yjs will
   * merge both — that is what it is for — so the guard has to be inside the
   * transaction, where re-reading the state is the last thing that happens
   * before the write.
   */
  let applied = false
  doc.transact(() => {
    if (entry.get('patchState') !== 'open') return
    entry.set('patchState', 'accepted' as PatchState)
    entry.set('patchBy', byName)
    replaceText(source, patch)
    applied = true
  })
  return applied
}

/** Turn a proposal down. Nothing is written to the cell; the thread keeps both. */
export function rejectPatch(doc: Y.Doc, entry: YChatEntry, byName: string): void {
  if (entry.get('patchState') !== 'open') return
  doc.transact(() => {
    entry.set('patchState', 'rejected' as PatchState)
    entry.set('patchBy', byName)
  })
}

/**
 * Has the cell moved since this proposal was written?
 *
 * Not a refusal — the room may well want the rewrite anyway — but it has to be
 * said out loud before somebody presses Accept, because what they are accepting
 * is the deletion of whatever arrived in between.
 */
export function patchIsStale(doc: Y.Doc, entry: YChatEntry): boolean {
  const base = entry.get('patchBase')
  const cellId = entry.get('cellId')
  if (typeof base !== 'string' || typeof cellId !== 'string') return false
  for (const cell of getCells(doc).toArray()) {
    if (cell.get('id') !== cellId) continue
    const source = cell.get('source')
    const now = source instanceof Y.Text ? source.toString() : String(source ?? '')
    return now !== base
  }
  return false
}

/** The proposal on a chat turn, if it made one and nobody has decided yet. */
export function openPatchFor(doc: Y.Doc, cellId: string): YChatEntry | null {
  const chat = getChat(doc)
  for (let i = chat.length - 1; i >= 0; i--) {
    const entry = chat.get(i)
    if (entry.get('cellId') !== cellId) continue
    if (entry.get('patchState') !== 'open') continue
    const patch = entry.get('patch')
    if (typeof patch !== 'string' || patch.length === 0) continue
    return entry
  }
  return null
}

export function chatAnswer(entry: YChatEntry): Y.Text {
  let text = entry.get('answer') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    entry.set('answer', text)
  }
  return text
}

/**
 * The entry's reasoning text, created on first use.
 *
 * Lazy for the same reason chatAnswer is: a turn written by an older build has
 * no such key, and every reader of a nine-week-old thread would otherwise have
 * to guard for it. Creating it on read is safe here because the server is a
 * Yjs client like any other — the empty text merges with itself.
 */
export function chatReasoning(entry: YChatEntry): Y.Text {
  let text = entry.get('reasoning') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    entry.set('reasoning', text)
  }
  return text
}

/** A Y.Text as a string, and anything else as nothing. */
function readText(value: unknown): string {
  return value instanceof Y.Text ? value.toString() : ''
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
    answer: readText(entry.get('answer')),
    state: (entry.get('state') as ChatState) ?? 'done',
    // Absent on every turn written before proposals existed, which is most of
    // them: a thread from last week must still read.
    patch: (entry.get('patch') as string | null) ?? null,
    patchBase: (entry.get('patchBase') as string | null) ?? null,
    patchState: (entry.get('patchState') as PatchState) ?? 'open',
    patchBy: (entry.get('patchBy') as string | null) ?? null,
    /*
     * Read without creating. chatReasoning() makes the text when it is missing,
     * which is right for the server about to write into it and wrong here: this
     * runs in every browser on every observer pass, so a thread of turns from
     * before reasoning existed would have had each of them written to — a read
     * that mutates the document, inside the callback that fires on mutations.
     */
    reasoning: readText(entry.get('reasoning')),
    thoughtMs: (entry.get('thoughtMs') as number | null) ?? null,
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

export function createCell(type: CellType, source = '', id?: string): YCell {
  const cell = new Y.Map<any>()
  // An id may be supplied: restoring a deleted cell has to bring back the one
  // it had, or a second restore cannot tell it is already there and makes
  // another copy.
  cell.set('id', id ?? newId())
  cell.set('type', type)
  const text = new Y.Text()
  if (source) text.insert(0, source)
  cell.set('source', text)
  cell.set('outputs', new Y.Array<YOutput>())
  cell.set('state', 'idle' as CellState)
  cell.set('execCount', null)
  cell.set('runBy', null)
  cell.set('runById', null)
  cell.set('startedAt', null)
  cell.set('ranMs', null)
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

/**
 * A copy of a cell, id and all.
 *
 * Y.Array has no move, so reordering means rebuilding — and a rebuilt sheet
 * has to hold the same cells, not new ones with the same text: every caret,
 * every open proposal and every history row names a cell by its id.
 */
export function cloneCell(cell: YCell): YCell {
  const copy = new Y.Map<any>()
  copy.set('id', cell.get('id'))
  copy.set('type', cell.get('type'))
  const text = new Y.Text()
  const source = cell.get('source')
  const was = source instanceof Y.Text ? source.toString() : String(source ?? '')
  if (was) text.insert(0, was)
  copy.set('source', text)
  const outputs = new Y.Array<YOutput>()
  const had = cell.get('outputs')
  if (had instanceof Y.Array) {
    for (const out of had.toArray()) outputs.push([cloneOutput(out)])
  }
  copy.set('outputs', outputs)
  copy.set('state', cell.get('state') ?? ('idle' as CellState))
  copy.set('execCount', cell.get('execCount') ?? null)
  copy.set('runBy', cell.get('runBy') ?? null)
  copy.set('runById', cell.get('runById') ?? null)
  /*
   * Всё, что ключ забыл здесь, пропадает при перестановке соседа.
   *
   * `moveCell` пересоздаёт клоном не ту ячейку, которую двигают, а соседнюю —
   * так что подвинуть ячейку 5, пока считается ячейка 6, значит пересобрать
   * шестую целиком. Ключ, не переписанный сюда, исчезает у неё посреди
   * выполнения: с `startedAt` это остановившийся секундомер на работающей
   * ячейке, а с `stdin` — форма ввода, пропавшая у всей комнаты, пока ядро
   * ждёт ответа. Второе лежало здесь ненайденным ровно потому, что список
   * ключей в шапке файла его не называл.
   */
  copy.set('stdin', cell.get('stdin') ?? null)
  copy.set('startedAt', cell.get('startedAt') ?? null)
  copy.set('ranMs', cell.get('ranMs') ?? null)
  return copy
}

function cloneOutput(output: YOutput): YOutput {
  const copy = new Y.Map<any>()
  for (const [key, value] of output.entries()) {
    if (value instanceof Y.Text) {
      const text = new Y.Text()
      const was = value.toString()
      if (was) text.insert(0, was)
      copy.set(key, text)
    } else {
      copy.set(key, value)
    }
  }
  return copy as YOutput
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
    runById: (cell.get('runById') as string | null) ?? null,
    stdin: (cell.get('stdin') as CellSnapshot['stdin']) ?? null,
    // `?? null`, not a cast: a notebook written before these keys existed
    // returns undefined, and the view compares against null.
    startedAt: (cell.get('startedAt') as number | null) ?? null,
    ranMs: (cell.get('ranMs') as number | null) ?? null,
  }
}

export function readNotebook(doc: Y.Doc): CellSnapshot[] {
  return getCells(doc).map(readCell)
}

/**
 * Execution belonging to a process that is gone.
 *
 * `kernelStatus`, `runningCell`, the queue and every cell's `state` live in the
 * document, which means they are in the snapshot too. A server that dies with a
 * cell running comes back, loads all of that, and hands the room a notebook
 * where one cell spins forever and a queue waits on a run that no longer
 * exists — against a runtime that has never heard of any of it.
 *
 * The truth at hydration is simple: nothing is running, because nothing has
 * been started yet. Outputs are left exactly as they are — a cell that printed
 * three lines before the crash really did print them, and deleting them would
 * hide the only evidence of how far it got.
 *
 * Returns how many cells had to be put back to rest, so the caller can decide
 * whether the room deserves an explanation.
 */
export function clearStaleExecution(doc: Y.Doc): number {
  const meta = getMeta(doc)
  const cells = getCells(doc)
  let cleared = 0

  doc.transact(() => {
    // The queue is emptied but not counted: every id in it belongs to a cell
    // that is counted below, and counting both reports each one twice.
    const queue = meta.get('queue')
    if (queue instanceof Y.Array && queue.length > 0) queue.delete(0, queue.length)
    if (meta.get('runningCell') != null) meta.set('runningCell', null)

    const status = meta.get('kernelStatus')
    if (status === 'busy' || status === 'restarting') meta.set('kernelStatus', 'idle' as KernelStatus)

    for (const cell of cells) {
      const state = cell.get('state')
      if (state === 'running' || state === 'queued') {
        cell.set('state', 'idle' as CellState)
        cleared++
      }
      /*
       * Секундомер гасится у каждой ячейки, и это не считается за сброс.
       *
       * `cleared` уходит в строку, которую комната читает в журнале ядра —
       * «Cells that were running or queued were put back to rest». Прибавить
       * сюда ячейку, у которой только протухшая отметка времени, значит
       * сказать классу, что их работу отменили, когда ничего не отменяли.
       *
       * Нестрогое `!= null`: в тетради, записанной до появления этого ключа,
       * он `undefined`, и строгая проверка переписывала бы каждую ячейку при
       * каждом открытии комнаты — то есть открывала бы всплеск истории и
       * будила запись на диск на ровном месте.
       */
      if (cell.get('startedAt') != null) cell.set('startedAt', null)
      // И вопрос ядра: форма ответа, за которой уже никого нет, — это поле
      // ввода, чей «Send» уходит в пустоту, и убрать его с экрана нечем.
      if (cell.get('stdin') != null) cell.set('stdin', null)
      // `ranMs` не трогаем: это измеренный факт с одних серверных часов, и
      // перезапуск не делает его неправдой. Стереть — значит убрать «· 4s»
      // из всей тетради при каждом обновлении сервера.
    }

    /*
     * A turn left mid-answer is in the same position as a cell left mid-run:
     * the process that was writing it is gone, and nothing will ever finish
     * it. Without this the thread kept a "thinking" spinner turning for the
     * rest of the seminar — and, because the newest turn is the one the panel
     * follows, it turned at the bottom of everybody's screen.
     */
    for (const entry of getChat(doc)) {
      if (entry.get('state') !== 'streaming') continue
      const answer = entry.get('answer')
      const said = answer instanceof Y.Text ? answer.toString() : ''
      if (!said.trim()) {
        const text = answer instanceof Y.Text ? answer : null
        text?.insert(text.length, 'The answer stopped when the server restarted.')
      }
      entry.set('state', 'error' as ChatState)
      cleared++
    }
  }, 'init')

  return cleared
}

/**
 * Give a fresh document something to look at. Safe to call on every load: it
 * only writes when the document is genuinely empty, and says whether it did.
 */
export function ensureInitialNotebook(doc: Y.Doc, title?: string): boolean {
  const cells = getCells(doc)
  const meta = getMeta(doc)
  let seeded = false
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
      seeded = true
    }
  }, 'init')
  // The caller needs to know, because a seed that never reaches disk is a seed
  // that happens twice — see getSessionDoc().
  return seeded
}
