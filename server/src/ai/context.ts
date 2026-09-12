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
 *
 * Выводы здесь НЕ лежат, и это главное различие с `readCell`. Разбор вывода —
 * это `JSON.parse` каждой записи data/error, включая base64 картинки на сотни
 * килобайт, и делался он для ВСЕХ ячеек всех тетрадей на каждый вопрос — при
 * том, что до кадра доезжают единицы: остальные бюджет сворачивает в одну
 * строку, где выводов нет вовсе. Здесь выводы читаются ровно у тех ячеек,
 * которые правда поедут модели (`outputsOf`), а «есть ли тут падение» узнаётся
 * по виду записи, без разбора её содержимого.
 */
interface Entry {
  raw: YCell
  id: string
  type: CellType
  source: string
  state: CellState
  execCount: number | null
  runBy: string | null
  /** Среди выводов есть ошибка — по виду записи, без разбора JSON. */
  failed: boolean
  book: string
  /** 1-based, как в поле у края и как в панели. */
  no: number
  /** Первая ячейка своей тетради — над ней ставится её заголовок. */
  first: boolean
}

/** Список выводов ячейки, не заводя его, если его нет: чтение не правит документ. */
function outputArray(cell: YCell): Y.Array<YOutput> | null {
  const outputs = cell.get('outputs') as Y.Array<YOutput> | undefined
  return outputs ?? null
}

/** Выводы ячейки — только когда она правда едет в кадре. */
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

/** Шапка ячейки — всё, кроме выводов: строки, а не мегабайты. */
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
  /** Ближние — первыми: дальние отсюда и начнут сворачиваться. */
  const nearest = entries
    .map((_, i) => i)
    .filter((i) => !pinned.has(i))
    .sort((a, b) => strangeness(a) - strangeness(b))

  /*
   * Кто помещается — считается длинами, а не пересборкой всего текста.
   *
   * Прежний цикл на каждую выброшенную ячейку склеивал ВЕСЬ кадр заново: на
   * тетради в двести ячеек это две сотни склеек текста в десятки килобайт,
   * O(ячеек × длины) на каждый вопрос. Порядок решения тот же — сначала
   * сворачивается самое далёкое, — но здесь он записан наоборот: закреплённое и
   * ближние блоки берутся целиком, пока хватает бюджета, а как только очередной
   * не поместился, всё, что за ним, сворачивается в строку. Разделители между
   * блоками считаются отдельно: их число не меняется.
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
  // Закреплённое едет целиком всегда, даже если бюджет уже перебран: ради него
  // запрос и отправляли.
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

  for (const output of outputsOf(entry))
    lines.push(renderOutput(output, full ? MAX_OUTPUT * 2 : MAX_OUTPUT, full))
  return lines.join('\n')
}

/**
 * Выводы одной ячейки — теми же словами, какими их видит кадр вопроса.
 *
 * Экспортируется ради `run_cell` в agent.ts: ход, запустивший ячейку, должен
 * увидеть её вывод, и увидеть его ТАК ЖЕ — с тем же «out[error]», той же
 * снятой раскраской трейсбека и той же строкой вместо картинки. Второй
 * отрисовщик рядом с этим разошёлся бы с ним на первой правке, а разошедшись,
 * научил бы модель двум разным форматам одного и того же.
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
 * `whole` — про трейсбек, и только про него.
 *
 * У закреплённой ячейки — той, о которой спросили, и той, что упала последней, —
 * трейсбек едет целиком: обрезанный посередине, он теряет как раз ту строку, где
 * названа поломка. Остальное режется потолком, как и прежде.
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
    if (mime.startsWith('image/')) {
      // Base64 pixels are pure noise to the model and would eat the whole budget.
      parts.push(`[${mime}, ~${Math.max(1, Math.round((value.length * 0.75) / 1024))} KB image]`)
    } else if (parts.length === 0) {
      parts.push(clip(value, limit))
    } else {
      parts.push(`[${mime}, ${value.length} chars]`)
    }
  }
  /*
   * Крупные картинки в документе не лежат — там ссылка (shared/notebook.ts ·
   * OutputBlob). Пиксели модели не нужны и не отправлялись никогда, а вот
   * «здесь был график» — нужно: без этой строки ячейка с одним `plt.show()`
   * выглядит для оракула как ячейка, которая ничего не вывела.
   */
  for (const blob of output.blobs ?? []) {
    parts.push(`[${blob.mime}, ~${Math.max(1, Math.round(blob.bytes / 1024))} KB image]`)
  }
  return parts.length ? parts.join('\n') : '(no data)'
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
