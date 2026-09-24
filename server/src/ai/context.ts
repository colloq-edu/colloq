import { tr } from '@shared/i18n'
/**
 * Renders the live notebook as plain text for the model.
 *
 * The browser sends nothing but a cell id: everything the oracle knows comes
 * from the server's own copy of the CRDT, read at the moment of the question.
 * That is the whole point of the feature — "why is this broken?" is meaningless
 * without the traceback a classmate produced ten seconds ago, and nobody should
 * have to paste code into another tab.
 *
 * Budget order, when the notebook is bigger than the window: the selected cell
 * and the newest traceback survive intact, distant cells are elided first.
 */
import type * as Y from 'yjs'
import {
  allBooks,
  cellId,
  cellSource,
  cellType,
  getMeta,
  readOutput,
  type CellOutput,
  type CellState,
  type CellType,
  type DataOutput,
  type KernelStatus,
  type YCell,
  type YOutput,
} from '@shared/notebook'
import { PLOTLY_MIME, figureShape, normalizeFigure, type PlotlyFigure } from '@shared/plotly'
import { getOracleSettings } from '../admin/settings.js'
import { getSessionDoc } from '../collab/index.js'
import { getSession } from '../db.js'
import { listFiles } from '../workspace.js'
import { currentText } from '../collab/files.js'
import { kindOf } from '@shared/paths'
import { clip, clipLine, pad } from './text.js'

/*
 * How much of a cell travels, per cell.
 *
 * These are not the budget — buildContext() has one of those and honours it.
 * They are what a cell is worth *before* the budget starts dropping whole
 * cells: about forty lines of code and twenty of output, which is a cell a
 * person would read on screen. The cell being asked about, and the newest
 * failure, are rendered `full` and get twice the output; everything else is a
 * reminder that it exists.
 */
const MAX_SOURCE = 1_500
const MAX_OUTPUT = 800
/** Names only, so a room that uploaded a folder does not spend the budget on it. */
const MAX_FILES = 40

/**
 * How much of the open file's text travels with the question.
 *
 * Eight thousand characters is about two hundred lines: that is how much a
 * person keeps before their eyes when asking "why does it fail here". A longer
 * file travels as its beginning, and the clipping is stated out loud — a model
 * finishing the end of a file it has not seen is worse than a model that asks
 * back.
 */
const MAX_OPEN_FILE = 8_000

/**
 * One cell in the frame: the cell itself, its notebook and its number within
 * that notebook.
 *
 * A room has several notebooks, and a cell's number is its own in each — the
 * very one drawn next to it in the left margin. While the list was flat and
 * single, the index in it served as the number; with two notebooks that would
 * have silently diverged.
 *
 * Outputs are NOT kept here, and that is the main difference from `readCell`.
 * Parsing an output is a `JSON.parse` of every data/error entry, including
 * base64 images of hundreds of kilobytes, and it was done for ALL cells of all
 * notebooks on every question — while only a handful make it into the frame:
 * the budget folds the rest into one line with no outputs at all. Here outputs
 * are read only for the cells that will really go to the model (`outputsOf`),
 * and "is there a failure here" is learned from the kind of the entry, without
 * parsing its contents.
 */
interface Entry {
  raw: YCell
  id: string
  type: CellType
  source: string
  state: CellState
  execCount: number | null
  runBy: string | null
  /** There is an error among the outputs — by the entry's kind, without parsing JSON. */
  failed: boolean
  book: string
  /** 1-based, as in the margin at the edge and as in the panel. */
  no: number
  /** The first cell of its notebook — the notebook's header goes above it. */
  first: boolean
}

/** The cell's outputs list, without creating it if absent: a read does not edit the doc. */
function outputArray(cell: YCell): Y.Array<YOutput> | null {
  const outputs = cell.get('outputs') as Y.Array<YOutput> | undefined
  return outputs ?? null
}

/** A cell's outputs — only when it really travels in the frame. */
function outputsOf(entry: Entry): CellOutput[] {
  const outputs = outputArray(entry.raw)
  if (!outputs) return []
  const out: CellOutput[] = []
  outputs.forEach((one: YOutput) => {
    const parsed = readOutput(one)
    if (parsed) out.push(parsed)
  })
  return out
}

/** A cell's head — everything except the outputs: strings, not megabytes. */
function headOf(cell: YCell, book: string, no: number, first: boolean): Entry {
  const outputs = outputArray(cell)
  let failed = false
  if (outputs) {
    outputs.forEach((one: YOutput) => {
      if (one.get('kind') === 'error') failed = true
    })
  }
  return {
    raw: cell,
    id: cellId(cell),
    type: cellType(cell),
    source: cellSource(cell).toString(),
    state: (cell.get('state') as CellState) ?? 'idle',
    execCount: (cell.get('execCount') as number | null) ?? null,
    runBy: (cell.get('runBy') as string | null) ?? null,
    failed,
    book,
    no,
    first,
  }
}

export function buildContext(
  sessionId: string,
  /**
   * What the asker wants the focus on — the asker's selection.
   *
   * Not "what to show": the notebooks travel whole in any case. This is about
   * the order of attention — what to pin in the frame and what to tell the
   * model directly.
   */
  focus: readonly string[],
  /**
   * Who is asking.
   *
   * Needed for one thing: which file this person has open in the editor right
   * now. People almost always ask about what they are looking at, and until
   * now only file names went into the context — the model answered about
   * `train.py` without having seen a line of it. Taken from the room's
   * presence, not from the request: it is already there and already corrected
   * by the server.
   */
  askedBy?: string | null,
): string {
  // Read per question, not per boot: a teacher who lowers the budget mid-class
  // to fit a smaller model must see the next question honour it.
  const maxTotal = getOracleSettings().contextChars
  const { doc } = getSessionDoc(sessionId)
  const meta = getMeta(doc)

  /*
   * ALL notebooks of the room, not the first one.
   *
   * While there was one notebook, "the room's cells" and "the notebook's cells"
   * meant the same thing. With several, a question about a cell in the second
   * went out with the header "SELECTED CELL: none" and without the cell itself —
   * while the panel honestly showed its number, and the answer came back
   * confident and about someone else's code.
   */
  const entries: Entry[] = allBooks(doc).flatMap(({ book, cells }) =>
    cells.toArray().map((cell, at) => headOf(cell, book.path, at + 1, at === 0)),
  )

  const sessionName =
    getSession(sessionId)?.name ?? (meta.get('title') as string | undefined) ?? tr("server.untitledSeminar.08a8f2")
  const kernel = (meta.get('kernelStatus') as KernelStatus | undefined) ?? 'idle'

  const wanted = new Set(focus)
  const focused = entries.map((entry, i) => (wanted.has(entry.id) ? i : -1)).filter((i) => i >= 0)
  const errorIndex = newestErrorIndex(entries)
  const pinned = new Set<number>(focused)
  if (errorIndex >= 0) pinned.add(errorIndex)

  /*
   * The header is assembled twice: with the open file and without it.
   *
   * The open file block is the only part of the header that can be as long as
   * the whole budget, while all three saving steps cut only cells. With a small
   * contextChars (a model on the teacher's machine) it pushed out both the
   * selected cell and the "ASKING ABOUT" line — that is, the question itself.
   * Now it is both trimmed to the budget and the first to go when the pinned
   * blocks are short of room.
   */
  const headerWith = (open: readonly string[]): string =>
    [
      `SESSION: ${sessionName}`,
      `KERNEL: ${kernel}`,
      `FILES IN WORKSPACE: ${describeFiles(sessionId)}`,
      ...open,
      /*
       * "Look here first", not "here is everything there is".
       *
       * The wording matters: the notebooks are in the frame in full, and a
       * model that read "SELECTED CELL: none" used to behave as if it had
       * been given nothing.
       */
      focused.length > 0
        ? `THE STUDENT IS ASKING ABOUT: ${focused
            .map((i) => `cell ${pad(entries[i].no)} of ${entries[i].book}`)
            .join(', ')} — answer about these first; everything else below is context.`
        : 'THE STUDENT IS ASKING ABOUT: nothing in particular — they have selected no cells.',
      `NOTEBOOKS (${entries.length} cell${entries.length === 1 ? '' : 's'} across ${bookCount(doc)}; trimmed regions are marked "… truncated …"):`,
    ].join('\n')

  const openFile = openFileBlock(sessionId, askedBy ?? null, maxTotal)
  const header = headerWith(openFile)

  /*
   * What to throw out first.
   *
   * Other notebooks first: if the question is about a cell in one, the contents
   * of another are worth the least in the frame. Then whatever is farther from
   * where the person is looking. What is pinned is never thrown out.
   */
  const anchor = focused[0] ?? (errorIndex >= 0 ? errorIndex : entries.length - 1)
  const homeBooks = new Set(focused.map((i) => entries[i].book))
  const strangeness = (i: number) =>
    (homeBooks.size > 0 && !homeBooks.has(entries[i].book) ? 1_000_000 : 0) + Math.abs(i - anchor)
  /** Nearest first: so folding starts from the far end. */
  const nearest = entries
    .map((_, i) => i)
    .filter((i) => !pinned.has(i))
    .sort((a, b) => strangeness(a) - strangeness(b))

  /*
   * Who fits is counted by lengths, not by reassembling the whole text.
   *
   * The old loop glued the WHOLE frame together again for every dropped cell:
   * on a notebook of two hundred cells that is two hundred concatenations of
   * text tens of kilobytes long, O(cells × length) on every question. The order
   * of decisions is the same — the farthest folds first — but here it is
   * written the other way round: pinned and near blocks are taken whole while
   * the budget lasts, and as soon as the next one does not fit, everything
   * after it folds into a line. The separators between blocks are counted
   * separately: their number does not change.
   */
  const gaps = 2 * entries.length
  const stubs = entries.map((entry) => bookHead(entry) + elide(entry))
  const full = new Map<number, string>()
  const render = (i: number): string => {
    const made = full.get(i)
    if (made !== undefined) return made
    const one =
      bookHead(entries[i]) + renderCell(entries[i], pinned.has(i), wanted.has(entries[i].id))
    full.set(i, one)
    return one
  }

  const blocks = [...stubs]
  let used = header.length + gaps + stubs.reduce((n, one) => n + one.length, 0)
  // The pinned part always travels whole, even if the budget is already
  // exceeded: it is what the request was sent for.
  for (const i of pinned) {
    blocks[i] = render(i)
    used += blocks[i].length - stubs[i].length
  }
  for (const i of nearest) {
    const one = render(i)
    const cost = one.length - stubs[i].length
    if (used + cost > maxTotal) break
    blocks[i] = one
    used += cost
  }
  let text = [header, ...blocks].join('\n\n')

  /*
   * Still over budget with every droppable cell already elided.
   *
   * On a notebook of two hundred cells the one-line stubs alone are thousands
   * of characters, and the final clip cut the text in the middle — which is
   * exactly where the anchor sits. The result was a question about cell 118
   * sent without cell 118, while the panel's "Sees cell 118" chip was lit.
   *
   * So the stubs collapse into ranges instead: one line for a run of elided
   * cells, and the pinned blocks stay whole. Only if even that overflows does
   * the old clip run, and by then the notebook is not the reason.
   */
  if (text.length > maxTotal) {
    text = [header, ...collapse(blocks, pinned, entries)].join('\n\n')
  }
  if (text.length <= maxTotal) return text

  /*
   * Even the folded version does not fit — so the problem is the pinned blocks
   * themselves.
   *
   * `clip` cuts the middle, and the middle is exactly the cell that was asked
   * about: a question about cell 118 went out without cell 118, while the chip
   * in the panel was lit with "Sees cell 118". Folding almost always cures it,
   * but not always: a cell with a gigantic output, or two pinned blocks in a
   * row, exceed the budget on their own.
   *
   * Then it is better to drop the overview and keep what the request was sent
   * for: the header and the pinned blocks, each trimmed separately. Worse than
   * the full notebook, and incomparably better than the full notebook without
   * the one cell it is all about.
   */
  const kept = blocks.filter((_, i) => pinned.has(i))
  if (kept.length > 0) {
    // The second pass goes without the open file: it is context, while the
    // pinned cell is the question itself, and the file is what must give way.
    for (const head of openFile.length > 0 ? [header, headerWith([])] : [header]) {
      const room = Math.max(200, Math.floor((maxTotal - head.length - 40) / kept.length))
      const trimmed = kept.map((block) => (block.length > room ? clip(block, room) : block))
      const focusedText = [
        head,
        '[the rest of the notebook was too long to include]',
        ...trimmed,
      ].join('\n\n')
      if (focusedText.length <= maxTotal) return focusedText
    }
  }
  return clip(text, maxTotal)
}

/** The notebook header — above its first cell, and only above it. */
function bookHead(entry: Entry): string {
  return entry.first ? `### notebook ${entry.book}\n` : ''
}

function bookCount(doc: Y.Doc): string {
  const n = allBooks(doc).length
  return `${n} notebook${n === 1 ? '' : 's'}`
}

/**
 * Fold consecutive elided cells into one line each run.
 *
 * "[cells 10–118] 109 cells elided" costs a line where 109 stubs cost a page,
 * and says the same thing: there is a notebook here, and this is not the part
 * you were asked about.
 */
function collapse(blocks: string[], pinned: Set<number>, entries: Entry[]): string[] {
  const out: string[] = []
  let runFrom = -1
  const flush = (to: number) => {
    if (runFrom < 0) return
    const n = to - runFrom + 1
    out.push(
      n === 1
        ? blocks[runFrom]
        : // The numbers are the same as on the person's screen, and with the
          // notebook name: "03–07" without it is ambiguous across two notebooks.
          `[${entries[runFrom].book} cells ${pad(entries[runFrom].no)}–${pad(entries[to].no)}]` +
            ` — … ${n} cells elided …`,
    )
    runFrom = -1
  }
  for (let i = 0; i < blocks.length; i++) {
    if (pinned.has(i)) {
      flush(i - 1)
      out.push(blocks[i])
      continue
    }
    if (runFrom < 0) runFrom = i
  }
  flush(blocks.length - 1)
  return out
}

/**
 * "Newest" means most recently executed, not lowest on the page: seminars run
 * cells out of order constantly.
 */
function newestErrorIndex(entries: Entry[]): number {
  let best = -1
  let bestCount = -1
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].failed) continue
    const count = entries[i].execCount ?? 0
    if (count >= bestCount) {
      best = i
      bestCount = count
    }
  }
  return best
}

function renderCell(entry: Entry, full: boolean, selected: boolean): string {
  const cell = entry
  /*
   * The number is the one the person sees: 1-based, with a leading zero.
   *
   * It used to be a zero-based index, and that diverged silently: a student
   * writes "it fails in 03", the model reads "[cell 3]" — that is, the fourth —
   * and the model looks like the culprit.
   */
  const head = [`[cell ${pad(entry.no)}]`, cell.type, cell.state]
  if (cell.execCount !== null) head.push(`In[${cell.execCount}]`)
  if (cell.runBy) head.push(`run by ${cell.runBy}`)

  const lines = [head.join(' · ') + (selected ? '   <-- ASKED ABOUT' : '')]

  const source = cell.source.trim()
  if (!source) lines.push('(empty)')
  else {
    lines.push('```' + (cell.type === 'code' ? 'python' : 'markdown'))
    lines.push(full ? source : clip(source, MAX_SOURCE))
    lines.push('```')
  }

  for (const output of outputsOf(entry))
    lines.push(renderOutput(output, full ? MAX_OUTPUT * 2 : MAX_OUTPUT, full))
  return lines.join('\n')
}

/**
 * The outputs of one cell — in the same words the question frame uses.
 *
 * Exported for `run_cell` in agent.ts: a turn that ran a cell must see its
 * output, and see it THE SAME WAY — with the same "out[error]", the same
 * traceback colouring stripped and the same line in place of an image. A
 * second renderer next to this one would drift from it on the first edit, and
 * once drifted, it would teach the model two different formats for the same
 * thing.
 */
export function renderOutputs(cell: YCell, limit: number, whole = false): string[] {
  const outputs = outputArray(cell)
  if (!outputs) return []
  const out: string[] = []
  outputs.forEach((one: YOutput) => {
    const parsed = readOutput(one)
    if (parsed) out.push(renderOutput(parsed, limit, whole))
  })
  return out
}

/**
 * `whole` is about the traceback, and only about it.
 *
 * For a pinned cell — the one asked about and the one that failed last — the
 * traceback travels whole: cut in the middle, it loses exactly the line where
 * the breakage is named. The rest is cut to the ceiling, as before.
 */
function renderOutput(output: CellOutput, limit: number, whole: boolean): string {
  if (output.kind === 'stream') {
    return `out[${output.name}]:\n${clip(output.text.trimEnd(), limit)}`
  }
  if (output.kind === 'error') {
    const label = `out[error]: ${output.ename}: ${output.evalue}`
    const traceback = stripAnsi(output.traceback.join('\n')).trim()
    if (!traceback) return label
    return `${label}\n${whole ? traceback : clip(traceback, limit)}`
  }
  return `out[result]:\n${renderData(output, limit)}`
}

function renderData(output: DataOutput, limit: number): string {
  const plain = output.data['text/plain']
  const parts: string[] = []
  if (plain !== undefined) parts.push(clip(plain, limit))

  for (const [mime, value] of Object.entries(output.data)) {
    if (mime === 'text/plain') continue
    if (mime === PLOTLY_MIME) {
      // The model does not need the coordinates, and they would not fit:
      // `px.scatter` of a hundred thousand points is two megabytes of JSON,
      // that is, the whole context budget for one cell. But "there was a chart
      // here, and this kind" is needed: otherwise a cell with a single
      // `px.histogram(...)` looks like a cell that printed nothing. The same
      // argument as for the images on the line above.
      parts.push(figureNote(value))
    } else if (mime.startsWith('image/')) {
      // Base64 pixels are pure noise to the model and would eat the whole budget.
      parts.push(`[${mime}, ~${Math.max(1, Math.round((value.length * 0.75) / 1024))} KB image]`)
    } else if (parts.length === 0) {
      parts.push(clip(value, limit))
    } else {
      parts.push(`[${mime}, ${value.length} chars]`)
    }
  }
  /*
   * Large images are not stored in the document — there is a link there
   * (shared/notebook.ts · OutputBlob). The model does not need the pixels and
   * they were never sent, but "there was a chart here" is needed: without this
   * line a cell with a single `plt.show()` looks to the oracle like a cell that
   * printed nothing.
   */
  for (const blob of output.blobs ?? []) {
    const kilobytes = Math.max(1, Math.round(blob.bytes / 1024))
    // An offloaded figure is still a chart, and it must not be called an image:
    // the oracle then suggests `plt.savefig` where the question is about plotly.
    parts.push(
      blob.mime === PLOTLY_MIME
        ? `[plotly figure, ~${kilobytes} KB]`
        : `[${blob.mime}, ~${kilobytes} KB image]`,
    )
  }
  return parts.length ? parts.join('\n') : '(no data)'
}

/**
 * A retelling of the figure for the model: what it is, without its contents.
 *
 * Broken or unfamiliar JSON is no reason to stay silent: "there was a chart
 * here" stays true even if it could not be parsed.
 */
function figureNote(json: string): string {
  let figure: PlotlyFigure | null = null
  try {
    figure = normalizeFigure(JSON.parse(json))
  } catch {
    figure = null
  }
  if (!figure) return '[plotly figure]'
  const shape = figureShape(figure)
  const traces = `${shape.traces} trace${shape.traces === 1 ? '' : 's'}`
  const points = shape.points > 0 ? `, ${shape.points} points` : ''
  return `[plotly figure: ${shape.kind}, ${traces}${points}]`
}

function elide(entry: Entry): string {
  const cell = entry
  const source = cell.source.trim()
  const lineCount = source ? source.split('\n').length : 0
  const first = source.split('\n').find((line) => line.trim().length > 0) ?? ''
  const head = [`[cell ${pad(entry.no)}]`, cell.type, cell.state]
  if (cell.execCount !== null) head.push(`In[${cell.execCount}]`)
  const preview = first ? ` starting "${clipLine(first.trim(), 60)}"` : ''
  return `${head.join(' · ')} — … ${lineCount} line${lineCount === 1 ? '' : 's'} elided …${preview}`
}

/**
 * The file the asker has open — in full or its beginning.
 *
 * An empty array if no file is open: an "OPEN FILE: none" header would cost
 * space on every question for a line that says nothing.
 */
function openFileBlock(sessionId: string, askedBy: string | null, maxTotal: number): string[] {
  if (!askedBy) return []
  const path = editingPath(sessionId, askedBy)
  if (!path) return []
  /*
   * The notebook does not get in here, although it is an "open file" too.
   *
   * Its contents are already in the frame — as cells, with outputs and states.
   * The notebook file, on the other hand, is its projection onto disk: JSON
   * without outputs, lagging a second and a half behind. Up to eight thousand
   * characters of the same thing, only worse and in a second voice — and
   * pushing out the real cells, because the budget does not cut the header.
   */
  if (kindOf(path) === 'notebook') return []
  const text = currentText(sessionId, path)
  if (text === null) return []
  /*
   * A quarter of the budget is the ceiling for the file.
   *
   * Eight thousand characters is about a large window. With a small
   * contextChars the file ate the whole header, and with it the cell that was
   * asked about: the saving steps cut only cells, they never reach the header.
   */
  const room = Math.min(MAX_OPEN_FILE, Math.floor(maxTotal / 4))
  const shown = text.length > room ? text.slice(0, room) : text
  const cut = text.length > room ? '\n… truncated …' : ''
  return [`OPEN FILE (${path}), what they are looking at right now:`, shown + cut]
}

/** Which file this participant is editing — from the room's presence. */
function editingPath(sessionId: string, participantId: string): string | null {
  const { awareness } = getSessionDoc(sessionId)
  for (const state of awareness.getStates().values()) {
    const user = (state as { user?: { id?: string; editing?: string | null } } | undefined)?.user
    if (user?.id !== participantId) continue
    if (typeof user.editing === 'string' && user.editing) return user.editing
  }
  return null
}

function describeFiles(sessionId: string): string {
  const names = listFiles(sessionId)
    .filter((f) => !f.dir)
    .map((f) => f.path)
  if (names.length === 0) return '(none)'
  if (names.length <= MAX_FILES) return names.join(', ')
  return `${names.slice(0, MAX_FILES).join(', ')} … and ${names.length - MAX_FILES} more`
}

/** IPython colours its tracebacks; the escape codes are just tokens to a model. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}
