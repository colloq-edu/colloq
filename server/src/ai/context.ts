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
  getMeta,
  readCell,
  type CellOutput,
  type CellSnapshot,
  type DataOutput,
  type KernelStatus,
} from '@shared/notebook'
import { getOracleSettings } from '../admin/settings.js'
import { getSessionDoc } from '../collab/index.js'
import { getSession } from '../db.js'
import { listFiles } from '../workspace.js'
import { currentText } from '../collab/files.js'
import { kindOf } from '@shared/paths'

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
 * Сколько текста открытого файла едет вместе с вопросом.
 *
 * Восемь тысяч знаков — это примерно двести строк: столько человек держит перед
 * глазами, когда спрашивает «почему тут падает». Файл длиннее едет началом, и
 * про обрезку сказано вслух — модель, дописывающая конец файла, которого не
 * видела, хуже модели, которая переспросила.
 */
const MAX_OPEN_FILE = 8_000

/**
 * Одна ячейка в кадре: сама ячейка, её тетрадь и номер внутри этой тетради.
 *
 * Тетрадей в комнате несколько, и номер у ячейки свой в каждой — тот самый,
 * который нарисован у неё в поле слева. Пока список был плоским и одним,
 * номером служил индекс в нём; с двумя тетрадями это разошлось бы молча.
 */
interface Entry {
  cell: CellSnapshot
  book: string
  /** 1-based, как в поле у края и как в панели. */
  no: number
  /** Первая ячейка своей тетради — над ней ставится её заголовок. */
  first: boolean
}

export function buildContext(
  sessionId: string,
  /**
   * На чём просят сосредоточиться — выделение спрашивающего.
   *
   * Не «что показать»: тетради едут целиком в любом случае. Это про порядок
   * внимания — что закрепить в кадре и о чём сказать модели прямо.
   */
  focus: readonly string[],
  /**
   * Кто спрашивает.
   *
   * Нужно ради одной вещи: какой файл у этого человека сейчас открыт в
   * редакторе. Спрашивают почти всегда про то, на что смотрят, а до сих пор в
   * контекст ехали только имена файлов — модель отвечала про `train.py`, ни
   * строчки из него не видев. Берётся из присутствия комнаты, а не из запроса:
   * там это уже есть и уже чинится сервером.
   */
  askedBy?: string | null,
): string {
  // Read per question, not per boot: a teacher who lowers the budget mid-class
  // to fit a smaller model must see the next question honour it.
  const maxTotal = getOracleSettings().contextChars
  const { doc } = getSessionDoc(sessionId)
  const meta = getMeta(doc)

  /*
   * ВСЕ тетради комнаты, а не первая.
   *
   * Пока тетрадь была одна, «ячейки комнаты» и «ячейки тетради» значили одно и
   * то же. С несколькими вопрос про ячейку во второй уходил с заголовком
   * «SELECTED CELL: none» и без самой ячейки — а панель при этом честно
   * показывала её номер, и ответ приходил уверенный и про чужой код.
   */
  const entries: Entry[] = allBooks(doc).flatMap(({ book, cells }) =>
    cells.toArray().map((cell, at) => ({
      cell: readCell(cell),
      book: book.path,
      no: at + 1,
      first: at === 0,
    })),
  )

  const sessionName =
    getSession(sessionId)?.name ?? (meta.get('title') as string | undefined) ?? 'Untitled seminar'
  const kernel = (meta.get('kernelStatus') as KernelStatus | undefined) ?? 'idle'

  const wanted = new Set(focus)
  const focused = entries
    .map((entry, i) => (wanted.has(entry.cell.id) ? i : -1))
    .filter((i) => i >= 0)
  const errorIndex = newestErrorIndex(entries.map((entry) => entry.cell))
  const pinned = new Set<number>(focused)
  if (errorIndex >= 0) pinned.add(errorIndex)

  /*
   * Заголовок собирается дважды: с открытым файлом и без него.
   *
   * Блок открытого файла — единственная часть заголовка, которая может быть
   * длиной с весь бюджет, а режут все три ступени экономии только ячейки. При
   * маленьком contextChars (модель на машине преподавателя) он вытеснял и
   * выбранную ячейку, и строку «ASKING ABOUT» — то есть сам вопрос. Теперь он
   * и урезан по бюджету, и уходит первым, когда закреплённым блокам тесно.
   */
  const headerWith = (open: readonly string[]): string =>
    [
      `SESSION: ${sessionName}`,
      `KERNEL: ${kernel}`,
      `FILES IN WORKSPACE: ${describeFiles(sessionId)}`,
      ...open,
      /*
       * «Смотри сюда в первую очередь», а не «вот всё, что есть».
       *
       * Формулировка важна: тетради в кадре целиком, и модель, прочитавшая
       * «SELECTED CELL: none», раньше вела себя так, будто ей ничего не дали.
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

  const blocks = entries.map(
    (entry, i) => bookHead(entry) + renderCell(entry, pinned.has(i), wanted.has(entry.cell.id)),
  )
  const assemble = () => [header, ...blocks].join('\n\n')

  /*
   * Что выбрасывать первым.
   *
   * Сначала — чужие тетради: если спросили про ячейку в одной, содержимое
   * другой стоит в кадре дешевле всего. Потом — то, что дальше от места, куда
   * человек смотрит. Закреплённое не выбрасывается никогда.
   */
  const anchor = focused[0] ?? (errorIndex >= 0 ? errorIndex : entries.length - 1)
  const homeBooks = new Set(focused.map((i) => entries[i].book))
  const strangeness = (i: number) =>
    (homeBooks.size > 0 && !homeBooks.has(entries[i].book) ? 1_000_000 : 0) + Math.abs(i - anchor)
  const droppable = entries
    .map((_, i) => i)
    .filter((i) => !pinned.has(i))
    .sort((a, b) => strangeness(b) - strangeness(a))

  let text = assemble()
  for (const i of droppable) {
    if (text.length <= maxTotal) break
    blocks[i] = bookHead(entries[i]) + elide(entries[i])
    text = assemble()
  }

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
   * Даже свёрнутое не помещается — значит, дело в самих закреплённых блоках.
   *
   * `clip` режет середину, а середина — это и есть ячейка, о которой спросили:
   * вопрос про 118-ю уходил без 118-й, пока чип в панели горел «Sees cell 118».
   * Свёртка это почти всегда лечит, но не всегда: ячейка с гигантским выводом
   * или два закреплённых блока подряд переберут бюджет и сами по себе.
   *
   * Тогда лучше выбросить обзор и оставить то, ради чего запрос отправляли:
   * заголовок и закреплённые блоки, подрезанные каждый по отдельности. Хуже,
   * чем полная тетрадь, и несравнимо лучше, чем полная тетрадь без той
   * единственной ячейки, о которой речь.
   */
  const kept = blocks.filter((_, i) => pinned.has(i))
  if (kept.length > 0) {
    // Со вторым заходом — уже без открытого файла: он контекст, а закреплённая
    // ячейка — сам вопрос, и уступать место должен он.
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

/** Заголовок тетради — над первой её ячейкой, и только над ней. */
function bookHead(entry: Entry): string {
  return entry.first ? `### notebook ${entry.book}\n` : ''
}

function bookCount(doc: Y.Doc): string {
  const n = allBooks(doc).length
  return `${n} notebook${n === 1 ? '' : 's'}`
}

/** 01, 02, 03 — тот же номер, который нарисован у ячейки в поле слева. */
function pad(no: number): string {
  return String(no).padStart(2, '0')
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
        : // Номера — те же, что у человека на экране, и с именем тетради:
          // «03–07» без него неотличимо в двух тетрадях сразу.
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

function renderCell(entry: Entry, full: boolean, selected: boolean): string {
  const cell = entry.cell
  /*
   * Номер — тот же, что видит человек: 1-based, с ведущим нулём.
   *
   * Был индекс с нуля, и это расходилось молча: студент пишет «в 03-й падает»,
   * модель читает «[cell 3]» — то есть четвёртую, — и виноватой выглядит модель.
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

function elide(entry: Entry): string {
  const cell = entry.cell
  const source = cell.source.trim()
  const lineCount = source ? source.split('\n').length : 0
  const first = source.split('\n').find((line) => line.trim().length > 0) ?? ''
  const head = [`[cell ${pad(entry.no)}]`, cell.type, cell.state]
  if (cell.execCount !== null) head.push(`In[${cell.execCount}]`)
  const preview = first ? ` starting "${clipLine(first.trim(), 60)}"` : ''
  return `${head.join(' · ')} — … ${lineCount} line${lineCount === 1 ? '' : 's'} elided …${preview}`
}

/**
 * Keeps both ends of a long region: the head says what it is, and the tail of a
 * traceback is where the actual error lives.
 */
/**
 * Keep the opening and the ending, say what went missing in between.
 *
 * The marker counts against the limit rather than being added on top of it: a
 * budget that the sentence explaining the budget pushes you over is not a
 * budget, and a teacher who sets contextChars to fit a small model's window
 * means the number they typed. Two passes because the marker's own length
 * depends on the figure it carries.
 *
 * The figure stays what was actually dropped. It was already right before —
 * the head and tail came to exactly `limit` — but it stops being right the
 * moment the marker is taken out of the budget, so it is now derived from the
 * lengths actually kept rather than from the limit.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const mark = (dropped: number) => `\n… truncated ${dropped} chars …\n`

  let room = Math.max(0, limit - mark(text.length).length)
  let head = Math.ceil(room * 0.65)
  let dropped = text.length - room
  room = Math.max(0, limit - mark(dropped).length)
  head = Math.ceil(room * 0.65)
  const tail = room - head
  dropped = text.length - head - tail

  const out = `${text.slice(0, head).trimEnd()}${mark(dropped)}${text.slice(text.length - tail).trimStart()}`
  // trimEnd/trimStart only ever shorten it; the guard is for a limit so small
  // that the marker alone does not fit.
  return out.length <= limit ? out : out.slice(0, limit)
}

function clipLine(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/**
 * Файл, открытый у спрашивающего, — целиком или началом.
 *
 * Пустой массив, если файл не открыт: заголовок «OPEN FILE: none» стоил бы
 * места на каждом вопросе ради строки, которая ничего не говорит.
 */
function openFileBlock(sessionId: string, askedBy: string | null, maxTotal: number): string[] {
  if (!askedBy) return []
  const path = editingPath(sessionId, askedBy)
  if (!path) return []
  /*
   * Тетрадь сюда не попадает, хотя она тоже «открытый файл».
   *
   * Её содержимое уже в кадре — ячейками, с выводами и состояниями. Файл же
   * тетради это её проекция на диск: JSON без выводов, отстающий на полторы
   * секунды. До восьми тысяч знаков того же самого, но хуже и вторым голосом —
   * и вытесняющих собой настоящие ячейки, потому что заголовок бюджет не режет.
   */
  if (kindOf(path) === 'notebook') return []
  const text = currentText(sessionId, path)
  if (text === null) return []
  /*
   * Четверть бюджета — потолок для файла.
   *
   * Восемь тысяч знаков — это про большое окно. При маленьком contextChars файл
   * съедал заголовок целиком, а вместе с ним и ячейку, о которой спросили:
   * ступени экономии режут только ячейки, до заголовка они не доходят.
   */
  const room = Math.min(MAX_OPEN_FILE, Math.floor(maxTotal / 4))
  const shown = text.length > room ? text.slice(0, room) : text
  const cut = text.length > room ? '\n… truncated …' : ''
  return [`OPEN FILE (${path}), what they are looking at right now:`, shown + cut]
}

/** Какой файл правит этот участник — из присутствия комнаты. */
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
