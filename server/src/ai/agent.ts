import { tr } from '@shared/i18n'
import { appendActivity } from '../activity.js'
import type { ActivityOutcome } from '@shared/activity'
/**
 * Оракул, который не отвечает, а делает.
 *
 * Обычный ход — это вопрос и ответ: модель говорит словами, а руки остаются у
 * человека. Здесь модель сама читает папку семинара, правит файлы и запускает
 * скрипты, а комната смотрит на ленту шагов, пока это происходит.
 *
 * Четыре решения, на которых всё держится.
 *
 * **Правки применяются сразу, а не предлагаются.** В режиме «спросить» оракул
 * предлагает — у патча есть кнопка «принять»; здесь нет, и это не
 * непоследовательность. Агент обязан посмотреть на собственную ошибку: написал,
 * запустил, увидел трейсбек, починил. Режим, где каждая правка ждёт нажатия,
 * этого не умеет — он не агент, а тот же ответ в другой обёртке. Взамен есть
 * возврат, и он у всех разный: файлам — снимок до хода и кнопка отмены под
 * ходом, тетради комнаты — отметка в истории версий, остальным тетрадям —
 * копия файла рядом, потому что истории у них нет вовсе (см. `safety`).
 *
 * **Тетрадь правится ячейками, а не файлом.** Файл .ipynb — проекция: запись в
 * него вернулась бы обратно через полторы секунды и пропала бы молча. Поэтому у
 * тетради свои инструменты, и пишут они в документ комнаты — тем же путём,
 * каким пишет человек, и от имени того, кто попросил ход: по его правам (`edit`,
 * `structure`, замок на ячейке) и с его именем у версии в истории. Оракул здесь
 * руки человека, а не отдельное лицо со своими правами.
 *
 * **Обход не запрещаем, а называем вслух.** `write_file` по тетради откажет, а
 * `run_file` с питоновским скриптом — нет: запускать скрипты этому режиму
 * разрешено, и отнять это значило бы отнять половину работы. Значит, ловим не
 * запретом: отпечаток файла каждой тетради снимается до шага и после, и файл,
 * переписанный мимо комнаты, называется на том же шаге — модели и в ответе
 * хода. Иначе получается то, ради чего это и написано: «в тетради очищены
 * ячейки», а в тетради не изменилось ничего.
 *
 * **Без потока.** Аргументы инструмента приезжают в потоке кусками
 * незавершённого JSON, и собирать их обратно приходится по-разному у разных
 * провайдеров — ровно та зависимость от конкретного эндпоинта, которой этот
 * продукт избегает. Прогресс показывает лента шагов, и «прочитал src/model.py»
 * полезнее половины предложения.
 *
 * **Удалять нельзя.** Ни файл, ни папку. Удаление в этом продукте — право
 * преподавателя при любых правилах, и отдать его модели значило бы отдать ей
 * то, чего нет и у комнаты. Опустошить файл она может — и это отменяется.
 *
 * Ячейка — исключение, и оно оплачено: `remove_cell` спрашивает то же правило
 * `structure`, что и рука человека, а то, что было до хода, лежит либо в
 * истории версий, либо копией файла рядом. Возврат есть у всякой ячейки — вся
 * разница в том, одна это кнопка или руки.
 */
import { createHash } from 'node:crypto'
import type * as Y from 'yjs'
import {
  addStep,
  allBooks,
  allCellArrays,
  bookAt,
  bookCells,
  bookList,
  cellId,
  cellOutputs,
  cellSource,
  cellType,
  CELLS_KEY,
  chatAnswer,
  createCell,
  createChatEntry,
  DEFAULT_BOOK,
  findCell,
  findChatEntry,
  getChat,
  isCellOpen,
  replaceText,
  type AgentStep,
  type Book,
  type CellState,
  type CellType,
  type ChatState,
  type UndoState,
  type YCell,
  type YChatEntry,
} from '@shared/notebook'
import { baseOf, kindOf, normalizePath, parentOf, runnerFor } from '@shared/paths'
import {
  actsAfterClass,
  agentStepsIn,
  allows,
  allowsRun,
  allowsStructure,
  mayEditCell,
  runQueueCap,
  CLASS_IS_OVER,
  type RoomRules,
} from '@shared/rules'
import { applyOnBehalf, getSessionDoc, peekSessionDoc } from '../collab/index.js'
import { currentText, flushSessionFiles, putText } from '../collab/files.js'
import { bookText, createBook, isBookFile, projectBooks } from '../collab/books.js'
import { mark } from '../collab/history.js'
import { rememberDeleted } from '../collab/ops.js'
import { getRules, isFinished } from '../db.js'
import { MAX_TEXT_BYTES, freeName, listFiles, makeFile, readText, statPath } from '../workspace.js'
import {
  interruptTerminal,
  openTerminal,
  runCommand,
  dropPendingOf,
  terminalBusy,
  typedRunningCommand,
} from '../kernel/terminal.js'
import { cancelRun, requestRun } from '../kernel/index.js'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { completeWithTools, type ChatTurn, type ToolSpec } from './provider.js'
import { cellsWord, describe as reason, pad } from './text.js'
import { buildContext, renderOutputs } from './context.js'
import { recentTurns } from './index.js'

const ORIGIN = 'server'

/** Что сказать комнате про ошибку, у которой нет своих слов: читают её студенты. */
const WENT_WRONG = () => tr("server.private.wentWrong")

/** Сколько ждать один запуск. Дольше — это не «медленно», а «зависло». */
const RUN_TIMEOUT_MS = 90_000

/**
 * Сколько текста файла отдаём модели за раз — и почему это не одно число.
 *
 * Стояло шестьдесят тысяч знаков — потолок, взятый под большое окно. Беда в
 * том, что прочитанное не уходит: оно остаётся в переписке и повторяется в
 * КАЖДОМ следующем шаге хода, много раз. Одного `read_file` хватало,
 * чтобы окно на 8k токенов переполнилось на втором шаге, `completeWithTools`
 * бросил 400 и ход оборвался, — а сделанные до этого правки уже лежали в
 * файлах, и объяснить их было некому.
 *
 * Потому потолок считается от `contextChars`: четверть бюджета, который
 * преподаватель поставил под свою модель. Четверть — чтобы в ту же переписку
 * поместились ещё три таких чтения, а дальше их подчищает `budgetTools`. При
 * потолке инстанса в 100 000 это до 25 000 знаков за раз, при умолчании в
 * 20 000 — пять тысяч, то есть сто тридцать строк: столько и читают глазами,
 * когда спрашивают «почему тут падает».
 */
const MIN_READ = 12_000

function maxRead(): number {
  return Math.max(MIN_READ, Math.floor(getOracleSettings().contextChars / 2))
}

/** Прочитанное — до потолка; про обрезку сказано вслух, чтобы модель не дописывала конец. */
function clipRead(text: string): string {
  const room = maxRead()
  return text.length > room ? text.slice(0, room) + tr("server.truncated.fdb0c3") : text
}

/**
 * Сколько знаков переписки ход уносит с собой — отдельно от кадра.
 *
 * `contextChars` — это бюджет КАДРА: тетради, файлы, вывод ячеек, всё, что
 * `buildContext` укладывает в один системный блок. Ответы инструментов
 * считались тем же числом, и получалось, что одно и то же число стоит в двух
 * местах и значит разное: при потолке в 20 000 кадр съедал двадцать тысяч, а
 * ответы инструментов — ещё двадцать, и «уложились в бюджет» было неправдой
 * вдвое. Здесь это названо своим числом: переписка живёт дольше кадра (её
 * читают все шаги хода подряд), поэтому её бюджет вдвое больше, и общая
 * граница хода — три `contextChars`, а не два неизвестно чего.
 */
function toolChars(): number {
  return getOracleSettings().contextChars * 2
}

/**
 * Кусок текста по строкам — и слова о том, что осталось.
 *
 * Потолок чтения был один на файл: «первые N знаков, дальше обрезано», и
 * дальше у модели не было дороги вовсе — она либо дописывала конец файла сама,
 * либо звала `read_file` ещё раз и получала то же начало. Страницы дешевле
 * большого потолка: восемьсот строк лога стоят одного шага по сто строк там,
 * где нужен хвост, а не весь файл.
 */
interface Page {
  /** Что едет модели. */
  text: string
  /** Строка для ленты шагов. */
  note: string
  /** Что показали и как взять остальное; пусто, когда показали всё. */
  rest: string
}

function pageOfLines(text: string, args: Record<string, unknown>, path: string): Page {
  const lines = text.split('\n')
  const total = lines.length
  const room = maxRead()
  const asked = intArg(args.offset, 0)
  const wanted = intArg(args.limit, 0)
  /*
   * Отрицательное смещение — с конца.
   *
   * Так читают ровно одно: хвост лога и хвост трейсбека, то есть то место, где
   * поломка и лежит. Без него модель читала файл с начала страницами до конца —
   * шесть шагов хода ради последних тридцати строк.
   */
  const from = asked < 0 ? Math.max(0, total + asked) : Math.min(Math.max(0, asked), total)
  let to = wanted > 0 ? Math.min(total, from + wanted) : total
  /*
   * Режем по строкам, а не по знакам: половина строки в ответе — это строка,
   * которую модель допишет по догадке и ошибётся, а `find` у `edit_file`
   * промахнётся по ней молча.
   */
  let used = 0
  let kept = 0
  for (let i = from; i < to; i++) {
    used += lines[i].length + 1
    if (used > room && kept > 0) break
    kept += 1
  }
  to = from + kept
  /*
   * И жёсткий потолок по знакам поверх строк.
   *
   * Одна строка всегда остаётся, иначе страница бывает пустой, — а одна строка
   * бывает и в двести килобайт: свёрнутый в строку JSON, датасет одной строкой,
   * минифицированный файл. Без этой обрезки такой файл проезжал бы мимо всякого
   * бюджета и переполнял окно на первом же шаге. Про обрезку сказано вслух —
   * теми же словами, что и раньше.
   */
  const page = lines.slice(from, to).join('\n')
  const shown = page.length > room ? page.slice(0, room) + tr("server.truncated.fdb0c3") : page
  const note = tr('server.agent.linesShown', { p0: from + 1, p1: to, p2: total })
  return {
    text: shown,
    note,
    rest:
      to >= total
        ? from > 0
          ? `\n\n[${note}]`
          : ''
        : `\n\n[${note}; ${tr('server.agent.linesRest', { p0: path, p1: to })}]`,
  }
}

function intArg(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  // Модели присылают числа строкой чаще, чем хотелось бы: отказывать в ответ на
  // "offset": "130" значит потратить шаг хода на разбор кавычек.
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value))
  }
  return fallback
}

/**
 * Уложить переписку хода в окно модели.
 *
 * Кадр (`buildContext`) в `contextChars` уложен, а ответы инструментов — нет:
 * они копятся шаг за шагом и уезжают провайдеру целиком на каждом. Значит,
 * лишнее из переписки надо убирать — вопрос только в том, как именно.
 *
 * Убираются ЦЕЛЫЕ пачки с начала, а не содержимое посередине. Прежний код
 * переписывал i-е сообщение в одну строку «(содержимое опущено)», и это ломало
 * две вещи сразу. Первая — кеш промпта: у всех эндпоинтов, которые его умеют,
 * он считается по префиксу, а правка в середине переписки делает
 * недействительным весь хвост за ней, на каждом шаге в новом месте; ход из
 * двадцати шагов платил полную цену двадцать раз. Вторая — форма запроса:
 * опустошалась реплика инструмента, а вызов, на который она отвечает,
 * оставался, так что модель видела свой вызов без ответа и звала то же самое
 * снова. Пачка уходит вместе со своим вызовом — переписка остаётся связной, а
 * у каждого пережившего сообщения текст ровно тот же, что и был.
 *
 * Последняя пачка не трогается никогда: она и есть то, что модель только что
 * попросила, и ход без неё пошёл бы по кругу. Отказы тоже не трогаются — см.
 * `keep`: правило, узнанное ходом («так нельзя, сделайте иначе»), стоит
 * дороже прочитанного файла, потому что забытый отказ модель нарушает заново.
 */
const OMITTED =
  () => tr("server.private.omitted")

function budgetTools(messages: ChatTurn[], budget: number, keep: ReadonlySet<string>): void {
  const weigh = (): number =>
    messages.reduce(
      (sum, turn) =>
        sum + (turn.callId !== undefined || (turn.calls?.length ?? 0) > 0 ? turn.content.length : 0),
      0,
    )
  let used = weigh()
  if (used <= budget) return
  // Одна метка на всю переписку: две подряд говорят то же самое и стоят места.
  let marked = messages.some(
    (turn) => turn.callId === undefined && !turn.calls && turn.content === OMITTED(),
  )
  let i = 0
  while (i < messages.length && used > budget) {
    const turn = messages[i]
    if (!turn.calls || turn.calls.length === 0) {
      i += 1
      continue
    }
    const ids = new Set(turn.calls.map((call) => call.id))
    let end = i + 1
    while (end < messages.length && messages[end].callId && ids.has(messages[end].callId!)) end += 1
    // Пачка, доходящая до конца переписки, и есть последняя: её не трогаем.
    if (end >= messages.length) break
    if (turn.calls.some((call) => keep.has(call.id))) {
      i = end
      continue
    }
    let freed = turn.content.length
    for (let j = i + 1; j < end; j++) freed += messages[j].content.length
    messages.splice(
      i,
      end - i,
      ...(marked ? [] : [{ role: 'user' as const, content: OMITTED() }]),
    )
    marked = true
    used -= freed
  }
}

/**
 * Сколько записей треда комнаты берёт ход — и почему меньше, чем берёт вопрос.
 *
 * Тред (`recentTurns`) не считался вообще: он клался в переписку целиком и
 * жил в ней все двадцать шагов хода, рядом с ответами инструментов, за которые
 * бюджет уже борется. Ходу он нужен меньше, чем вопросу: вопрос продолжает
 * разговор, а ход получает поручение и работает по тетради, которая у него
 * перед глазами в кадре. Три последних обмена — это «как мы сюда пришли»,
 * дальше — чужой разбор недельной давности.
 */
const THREAD_TURNS_IN_WORK = 3

function threadForWork(history: ChatTurn[]): ChatTurn[] {
  const room = Math.max(500, Math.floor(getOracleSettings().contextChars / 8))
  return history
    .slice(-THREAD_TURNS_IN_WORK * 2)
    .map((turn) =>
      turn.content.length > room
        ? { ...turn, content: turn.content.slice(0, room) + tr("server.truncated.fdb0c3") }
        : turn,
    )
}

/** Сколько хвоста вывода кладём в ленту шагов и отдаём модели. */
const MAX_OUTPUT = 4_000

/**
 * Сколько строк дерева файлов уезжает модели.
 *
 * `listFiles` держит две тысячи строк — это потолок для панели, которая рисует
 * дерево один раз. Здесь список ложится в переписку и повторяется в КАЖДОМ
 * следующем шаге хода, много раз: распакованный датасет стоил бы
 * дороже всей остальной работы и переполнил бы окно небольшой модели на
 * третьем шаге. Из каждой папки едет начало, про остальное сказано числом.
 */
const MAX_TREE_LINES = 200
const MAX_PER_DIR = 20

/* ----------------------------------------------------------------- отмена */

/** Каким файл был до хода и каким его оставил ход. */
interface Snapshot {
  /** Текст до хода. `null` — файла не было вовсе: отмена его опустошит. */
  was: string | null
  /**
   * Текст, которым ход закончил.
   *
   * Ради этого поля отмена перестала быть слепой: если сейчас в файле лежит не
   * он, значит после хода файл правил человек — и «вернуть как было» стёрло бы
   * его работу. `null` — записать не удалось, возвращать нечего.
   */
  left: string | null
}

/**
 * Что было в файлах до хода — чтобы было куда вернуться.
 *
 * В памяти процесса, а не в базе, и это названная цена: перезапуск сервера
 * уносит отменяемость вместе с очередью запуска и общим экраном. Ход, который
 * уже посмотрели и оставили, от этого не страдает; страдает тот, кто ушёл
 * пить чай ровно в момент перезапуска.
 */
const before = new Map<string, Map<string, Snapshot>>()

/** Ходов на комнату, дальше самые старые забываются. */
const MAX_REMEMBERED_TURNS = 20

function remember(sessionId: string, entryId: string, path: string, text: string | null): void {
  const key = `${sessionId}\u0000${entryId}`
  let files = before.get(key)
  if (!files) {
    files = new Map()
    before.set(key, files)
    const mine = [...before.keys()].filter((other) => other.startsWith(`${sessionId}\u0000`))
    while (mine.length > MAX_REMEMBERED_TURNS) before.delete(mine.shift()!)
  }
  // Только первый раз: отменять надо к тому, что было ДО хода, а не до
  // последней из его правок.
  if (!files.has(path)) files.set(path, { was: text, left: null })
}

/** Чем ход закончил этот файл — с этим отмена и сверяется. */
function leftBehind(sessionId: string, entryId: string, path: string, text: string): void {
  const seen = before.get(`${sessionId}\u0000${entryId}`)?.get(path)
  if (seen) seen.left = text
}

/**
 * Вернуть файлы к тому, что было до хода.
 *
 * Возвращает число тронутых файлов, или `null`, если возвращать нечего —
 * например, сервер перезапускали.
 *
 * Возвращаются только те файлы, которых после хода никто не касался. Кнопка
 * живёт в треде до конца пары, и ход часовой давности иначе переписывал бы
 * поверх всего, что человек написал после него, — молча и безвозвратно:
 * истории версий у файлов рабочей папки нет. Рядом, у предложения для ячейки,
 * ровно такая проверка есть и называется тем же словом: с тех пор изменилось.
 */
export function undoTurn(sessionId: string, entryId: string, by: string): number | null {
  const key = `${sessionId}\u0000${entryId}`
  const files = before.get(key)
  const doc = peekSessionDoc(sessionId)?.doc
  const entry = doc ? findChatEntry(doc, entryId) : null
  if (!files || !doc || !entry) return null
  if ((entry.get('undo') as UndoState) !== 'available') return null
  let touched = 0
  const skipped: string[] = []
  for (const [path, snapshot] of files) {
    /*
     * `null` — файла на этом пути больше нет: его переименовали или убрали.
     * Тогда возвращать нечего и незачем: запись завела бы призрак рядом с
     * настоящим файлом, а если на старое имя успели завести новый — стёрла бы
     * его. Чужой текст на месте нашего значит то же самое: файл правили после
     * хода, и отмена стёрла бы эту правку.
     */
    const now = currentText(sessionId, path)
    if (now === null || snapshot.left === null || now !== snapshot.left) {
      skipped.push(path)
      continue
    }
    // Файла до хода не было: оракул его завёл. Убирать его целиком — не наше
    // право (удаление в этой комнате преподавательское и проходит через
    // дерево), поэтому он остаётся пустым — и это видно.
    putText(sessionId, path, snapshot.was ?? '')
    touched += 1
  }
  before.delete(key)
  doc.transact(() => {
    if (skipped.length > 0) {
      // Тред пишет «файлы вернулись к тому, что было»; про те, что не
      // вернулись, надо сказать здесь, иначе подпись под ходом соврёт.
      const answer = chatAnswer(entry)
      answer.insert(
        answer.length,
        tr("server.notRestored.7d302f", { p0: answer.length > 0 ? '\n\n' : '', p1: skipped.join(', ') }) +
          tr("server.theFilesWereChangedOrDeletedAfter.0aad9d"),
      )
    }
    entry.set('undo', 'done' as UndoState)
    entry.set('undoBy', by)
  }, ORIGIN)
  return touched
}

/**
 * Комнаты в памяти больше нет — помнить нечего и работать не для кого.
 *
 * Зовётся из `dropSessionDoc`, где всё про то, чтобы удаление стало
 * окончательным. Идущий ход обрывается здесь же: без этого он ещё десяток
 * шагов писал бы файлы и поднимал контейнер комнаты, которой больше нет.
 *
 * Второй зовущий — `evictRoom` в `collab/index.ts`, и там комнату не удалили,
 * а отпустили из памяти после десяти минут пустоты: снимок «как было до хода»
 * уходит вместе с ней, поэтому кнопка в треде остаётся, а отменять уже нечего —
 * отказ на неё написан словами в `ai:undo` (`control.ts`).
 */
export function forgetUndo(sessionId: string): void {
  for (const key of [...before.keys()]) {
    if (key.startsWith(`${sessionId}\u0000`)) before.delete(key)
  }
  for (const key of [...inBook.keys()]) {
    if (key.startsWith(`${sessionId}\u0000`)) inBook.delete(key)
  }
  stopAll(sessionId)
}

/* ------------------------------------------------------------ инструменты */

/**
 * Инструменты — списком, который строится на каждый ход.
 *
 * Не константой: описания уезжают модели, а язык инстанса меняется на ходу
 * (`tr` читает его при каждом обращении). Константа, посчитанная на импорте,
 * держала бы язык, который стоял в момент запуска сервера, — то самое
 * расхождение, из-за которого английский инстанс получал русские подсказки.
 */
function fileTools(): ToolSpec[] {
  return [
    {
      name: 'list_files',
      description: tr('server.agent.tool.listFiles'),
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'read_file',
      description: tr('server.agent.tool.readFile'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: tr('server.agent.arg.path') },
          offset: { type: 'integer', description: tr('server.agent.arg.offset') },
          limit: { type: 'integer', description: tr('server.agent.arg.limit') },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: tr('server.agent.tool.writeFile'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: tr('server.agent.tool.editFile'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: tr('server.agent.arg.find') },
          replace: { type: 'string', description: tr('server.agent.arg.replace') },
        },
        required: ['path', 'find', 'replace'],
      },
    },
    {
      name: 'run_file',
      description: tr('server.agent.tool.runFile'),
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]
}

/**
 * Инструменты по ячейкам — те, что правят тетрадь.
 *
 * Отдельным списком, потому что достаются не всем: их получает тот, кому в этой
 * комнате можно править тетрадь своими руками. Участнику в лекции их не видно
 * вовсе — предложить инструмент, который ответит отказом, значит потратить шаг
 * хода на то, чтобы узнать правило, известное заранее.
 */
function cellTools(): ToolSpec[] {
  return [
    {
      name: 'edit_cell',
      description: tr('server.agent.tool.editCell'),
      parameters: {
        type: 'object',
        properties: {
          cellId: { type: 'string', description: tr('server.agent.arg.cellId') },
          source: { type: 'string', description: tr('server.agent.arg.source') },
        },
        required: ['cellId', 'source'],
      },
    },
    {
      name: 'add_cell',
      description: tr('server.agent.tool.addCell'),
      parameters: {
        type: 'object',
        properties: {
          after: { type: 'string', description: tr('server.agent.arg.after') },
          path: { type: 'string', description: tr('server.agent.arg.bookPath') },
          type: { type: 'string', enum: ['code', 'markdown'] },
          source: { type: 'string' },
        },
        required: ['type', 'source'],
      },
    },
    {
      name: 'remove_cell',
      description: tr('server.agent.tool.removeCell'),
      parameters: {
        type: 'object',
        properties: { cellId: { type: 'string' } },
        required: ['cellId'],
      },
    },
  ]
}

/**
 * Завести тетрадь.
 *
 * Того, ради чего этот инструмент написан, в режиме не было вовсе: попросили
 * «сделай простейшую тетрадь», а завести её было нечем. Модель делала
 * единственное, что оставалось, — писала .ipynb через `write_file`, получала
 * тихий успех (файл-то записался) и дальше упиралась в `add_cell`, который про
 * этот файл ничего не знает: тетрадь комнаты — это запись в документе, а не
 * JSON на диске. Один вызов закрывает весь этот тупик.
 *
 * Право — не одно, а два, и оба уже есть у человека рядом: `files` (завести
 * файл) и `structure` с мерой `add` (добавить в тетрадь). Заводить тетрадь,
 * в которую потом нельзя добавить ячейку, незачем.
 */
function createNotebookTool(): ToolSpec {
  return {
    name: 'create_notebook',
    description: tr('server.agent.tool.createNotebook'),
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: tr('server.agent.arg.newBookPath') } },
      required: ['path'],
    },
  }
}

/**
 * Запустить одну ячейку и посмотреть, что получилось.
 *
 * Без него у хода не было способа проверить код тетради: `run_file` запускает
 * скрипт, и модель, которой велели «запустите и убедитесь», переписывала код
 * тетради в .py — то есть делала вторую копию того же кода, проверяла её и
 * отчитывалась про тетрадь. Ячейка ставится в ту же очередь и тем же путём,
 * каким её ставит человек кнопкой Run: от имени просящего, по его правилу
 * `run`, с его местом в очереди.
 */
function runCellTool(): ToolSpec {
  return {
    name: 'run_cell',
    description: tr('server.agent.tool.runCell'),
    parameters: {
      type: 'object',
      properties: { cell: { type: 'string', description: tr('server.agent.arg.cellId') } },
      required: ['cell'],
    },
  }
}

/** Чтение тетради — всем, кому вообще дали ход: тетрадь и так у комнаты перед глазами. */
function readNotebookTool(): ToolSpec {
  return {
    name: 'read_notebook',
    description: tr('server.agent.tool.readNotebook'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: tr('server.agent.arg.bookPath') },
        from: { type: 'integer', description: tr('server.agent.arg.from') },
        count: { type: 'integer', description: tr('server.agent.arg.count') },
        outputs: { type: 'boolean', description: tr('server.agent.arg.outputs') },
      },
      required: [],
    },
  }
}

/**
 * Чем этот человек работает в этом ходе.
 *
 * Считается один раз на ход, а не на шаг: правила могут поменяться посреди
 * работы, и на этот случай каждый инструмент спрашивает их ещё раз у себя —
 * список нужен модели, а не для проверки.
 *
 * Экспортируется ради теста: «участнику в лекции инструментов не видно» — это
 * про список, и проверить его иначе, чем спросив, нечем.
 */
export function toolsFor(hands: Hands): ToolSpec[] {
  const doc = peekSessionDoc(hands.sessionId)?.doc
  const rights = doc ? rightsFor(hands, doc) : { edit: false, add: false, remove: false }
  const cells = cellTools().filter((tool) =>
    tool.name === 'edit_cell' ? rights.edit : tool.name === 'add_cell' ? rights.add : rights.remove,
  )
  /*
   * Файлы и запуск — по тем же правилам комнаты, что и у пальцев просящего.
   *
   * Список режется по тому же доводу, что и у ячеек: инструмент, который
   * ответит отказом, стоит шага хода на то, чтобы узнать правило, известное
   * заранее. Смотреть можно всегда — `list_files` и `read_file` не правят
   * ничего, а правило `files` в этом продукте про запись.
   */
  const rules: RoomRules = getRules(hands.sessionId)
  const mayWrite = allows(rules.files, hands.role)
  const mayRun = allowsRun(rules.run, hands.role, 'one')
  const files = fileTools().filter((tool) =>
    tool.name === 'write_file' || tool.name === 'edit_file'
      ? mayWrite
      : tool.name === 'run_file'
        ? mayRun
        : true,
  )
  return [
    ...files,
    // Завести тетрадь — это и файл, и структура: без второго права новая
    // тетрадь осталась бы пустой навсегда.
    ...(mayWrite && rights.add ? [createNotebookTool()] : []),
    readNotebookTool(),
    ...(mayRun ? [runCellTool()] : []),
    ...cells,
  ]
}

export interface Ran {
  /** Что показать в ленте шагов. */
  step: AgentStep
  /** Что сказать модели. */
  said: string
  /**
   * Инструмент отказал или упал.
   *
   * Нужно ровно одному месту — `budgetTools`: отказ из переписки не выбрасывают.
   * Прочитанный файл модель перечитает одним шагом, а забытое правило («тетрадь
   * файлом не правят») она нарушит заново — и потратит на это не шаг, а весь
   * остаток хода, второй раз подряд.
   */
  failed?: boolean
  /**
   * Ещё один шаг в ленту — рядом с первым, а не вместо него.
   *
   * Нужно двум местам, и обоим по одной причине: у шага есть то, что инструмент
   * СДЕЛАЛ, и то, что при этом случилось мимо него. «Запустил train.py, код
   * выхода 0» и «скрипт снёс data.csv» — это две разные строки в ленте, и
   * склеенные в одну они читаются как подробность запуска, а не как то, ради
   * чего эту проверку писали.
   */
  also?: AgentStep
}

export interface Hands {
  sessionId: string
  entryId: string
  by: { name: string; color: string; participantId: string }
  /**
   * Роль того, кто попросил ход, — та же, с которой он сам нажимает кнопки.
   *
   * Приезжает от маршрута, а не спрашивается у базы: в таблице лежит роль, с
   * которой человек вошёл в комнату, а действует он с ЭФФЕКТИВНОЙ (см.
   * `roleFor` в routes/sessions.ts). Преподаватель, открывший свою же лекцию по
   * ссылке из чата, в таблице участник — и его собственная тетрадь оказалась бы
   * для его же оракула чужой.
   */
  role: 'host' | 'participant'
}

/**
 * Выполнить один инструмент — и посмотреть, не переписал ли он тетрадь мимо
 * комнаты.
 *
 * Экспортируется ради теста: здесь живут все границы режима «сделать» — что
 * можно, чего нельзя и что сказать, когда нельзя, — и проверять их через живую
 * модель значило бы проверять модель.
 *
 * `signal` нужен одному инструменту: запуск идёт минутами, и «Стоп» посреди
 * него должен останавливать скрипт, а не только цикл шагов.
 */
export async function useTool(
  hands: Hands,
  name: string,
  rawArgs: string,
  signal?: AbortSignal,
): Promise<Ran> {
  const prints = bookPrints(hands.sessionId)
  const ran = await runTool(hands, name, rawArgs, signal)
  const faked = rewrittenBooks(hands.sessionId, prints)
  if (faked.length === 0) return ran
  const work = bookWork(hands)
  for (const path of faked) work.faked.add(path)
  // К тому, что инструмент уже сказал, а не вместо: скрипт мог и посчитать
  // что-то полезное, и его вывод модели нужен — неправда только про тетрадь.
  return {
    step: ran.step,
    said: `${ran.said}\n\n${sayFaked(faked)}`,
    failed: ran.failed,
    also: ran.also ?? note(tr('server.agent.rewrotePastTheRoom'), faked.join(', ')),
  }
}

async function runTool(
  hands: Hands,
  name: string,
  rawArgs: string,
  signal?: AbortSignal,
): Promise<Ran> {
  const known = toolsFor(hands)
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>
  } catch {
    /*
     * Со схемой, а не просто «повторите».
     *
     * «Аргументы пришли не как JSON» — это тупик: модель не знает, чем именно
     * её JSON плох, и шлёт тот же самый ещё раз. Схема в ответе — то же, что
     * она получила в описании инструмента, но здесь и сейчас, рядом с отказом;
     * небольшие модели с этого места чинятся с первой попытки.
     */
    const spec = known.find((tool) => tool.name === name)
    return {
      step: note(tr("server.couldNotReadTheArguments.375da2"), name),
      failed: true,
      said: spec
        ? tr('server.agent.badJsonArgs', { p0: name, p1: JSON.stringify(spec.parameters) })
        : tr("server.theArgumentsAreNotValidJsonRetry.a91ada"),
    }
  }
  /*
   * Имя инструмента — раньше всего остального.
   *
   * Промах именем (`readNotebook` вместо `read_notebook`) приезжал в проверку
   * пути и получал «такой путь в этой комнате невозможен»: отказ про путь на
   * вызов, у которого пути нет вовсе. Модель чинила путь, промахивалась именем
   * снова и тратила на это шаги хода.
   */
  if (!ALL_TOOLS.has(name)) return unknownTool(name, known)
  const wanted = typeof args.path === 'string' ? normalizePath(args.path) : null

  if (name === 'list_files') {
    return {
      step: { kind: 'read', target: tr("server.seminarFolder.8c9abd"), added: 0, removed: 0, exit: null, note: '' },
      said: describeTree(hands.sessionId),
    }
  }

  // Раньше файловой проверки пути: у тетради адресуют ячейку по имени, а путь
  // если и есть, то необязательный.
  if (
    name === 'read_notebook' ||
    name === 'edit_cell' ||
    name === 'add_cell' ||
    name === 'remove_cell'
  ) {
    return useCellTool(hands, name, args)
  }

  if (name === 'run_cell') return runCell(hands, args, signal)

  if (!wanted) {
    return {
      step: note(tr("server.invalidPath.4b91a9"), typeof args.path === 'string' ? args.path : '—'),
      failed: true,
      said: tr("server.thisPathIsNotAllowedPathsAre.47da6e"),
    }
  }

  if (name === 'create_notebook') return createNotebook(hands, wanted)

  if (name === 'read_file') {
    // У тетради правда в комнате, а файл отстаёт на секунду: читаем комнату.
    const text = bookText(hands.sessionId, wanted) ?? currentText(hands.sessionId, wanted)
    if (text === null) {
      /*
       * `currentText` молчит одинаково про три разных случая, а модели они
       * говорят разное. «Файла нет» на месте шестимегабайтного датасета —
       * приглашение завести его заново, то есть ровно та потеря хвоста, ради
       * которой потолок и поставлен. Поэтому про большой файл говорится
       * отдельно — и начало его всё-таки показывается: по нему видно, что это
       * за файл, а править его всё равно нельзя.
       */
      const disk = readText(hands.sessionId, wanted)
      if (disk?.binary) {
        return {
          step: note(tr("server.notATextFile.51f9b2"), wanted),
          failed: true,
          said: tr("server.isNotATextFileAndCannot.e4e032", { p0: wanted }),
        }
      }
      if (disk?.truncated) {
        const head = pageOfLines(disk.text, args, wanted)
        return {
          step: {
            kind: 'read',
            target: wanted,
            added: 0,
            removed: 0,
            exit: null,
            note: tr("server.onlyTheBeginning.cac2a9"),
          },
          said: tr("server.theRestWasNotRead.2d3e0c", { p0: head.text, p1: tooBig(wanted) }),
        }
      }
      return {
        step: note(tr("server.nothingToRead.8741a9"), wanted),
        failed: true,
        said: tr("server.doesNotExistOrIsNotA.e25c4a", { p0: wanted }),
      }
    }
    const page = pageOfLines(text, args, wanted)
    return {
      step: {
        kind: 'read',
        target: wanted,
        added: 0,
        removed: 0,
        exit: null,
        note: page.note,
      },
      said: page.text + page.rest,
    }
  }

  if (name === 'write_file' || name === 'edit_file') {
    /*
     * Правило `files` — и здесь тоже.
     *
     * Шапка этого файла обещает, что ход правит «по правам того, кто попросил»,
     * и для ячеек это выполнялось (`rightsFor`, `mayEditCell`), а для файлов —
     * нет: вход в режим открывало одно `agent`, и участник в лекции с
     * `files: 'host'` писал через оракула любой файл папки семинара. Правило
     * комнаты, которое обходится одной кнопкой, — не правило.
     */
    if (!allows(getRules(hands.sessionId).files, hands.role)) {
      return {
        step: note(tr("server.onlyTheTeacherMayEditFilesHere.7af6f1"), wanted),
        failed: true,
        said: refuseCells(
          hands,
          tr("server.onlyTheTeacherMayEditFilesIn.067d2a", { p0: wanted }) +
            tr("server.explainWhatShouldBeChangedInIt.b5147e"),
        ),
      }
    }
    /*
     * Тетрадь — не текстовый файл, что бы ни говорило её расширение.
     *
     * Отказ спрашивает РАСШИРЕНИЕ, а не список тетрадей комнаты. Спрашивал он
     * список (`isBookFile`), и это была дыра ровно в том месте, ради которого
     * написан: тетради ЕЩЁ НЕТ в комнате, значит путь не в списке, значит
     * запись разрешена — и `write_file` с готовым .ipynb отвечал «готово».
     * Файл ложился на диск, комната о нём ничего не знала, `add_cell` по нему
     * отказывал «не тетрадь этой комнаты», и ход упирался в стену, которую сам
     * же и построил. Теперь .ipynb не пишется файлом никогда: известная
     * тетрадь правится ячейками, неизвестная заводится `create_notebook`.
     */
    if (kindOf(wanted) === 'notebook') {
      const doc = peekSessionDoc(hands.sessionId)?.doc
      const rights = doc ? rightsFor(hands, doc) : null
      const mine = isBookFile(hands.sessionId, wanted)
      const mayEditCells = Boolean(rights && (rights.edit || rights.add || rights.remove))
      return {
        step: note(tr("server.thisIsARoomNotebook.50864d"), wanted),
        failed: true,
        said: mine
          ? tr("server.isARoomNotebookItsCellsLive.c322d1", { p0: wanted }) +
            tr("server.soOverwritingItWouldBeLostShortly.f6c799") +
            tr("server.theRoomDoesNotReadChangesFrom.df48b1") +
            (mayEditCells
              ? tr("server.editTheCellsUseReadNotebookThen.e64989")
              : tr("server.youCanViewItWithReadNotebook.a0da1e") +
                tr("server.isNotAllowedForYouExplainWhat.1333b4"))
          : tr('server.agent.notebookIsNotAFile', { p0: wanted }) +
            (mayEditCells && allowsStructure(getRules(hands.sessionId).structure, hands.role, 'add')
              ? tr('server.agent.useCreateNotebook', { p0: wanted })
              : tr('server.agent.askTeacherForNotebook')),
      }
    }
    const existed = statPath(hands.sessionId, wanted) !== null
    /*
     * Файл, которого не берёт редактор, не берёт и оракул.
     *
     * `currentText` отдаёт первые полтора мегабайта большого файла как весь его
     * текст, а запись обрезка поверх целого — это потерянный хвост, о котором
     * никто не узнает: ни кода выхода, ни строки в ленте, ни возврата (отмена
     * вернула бы тот же обрезок). Ровно этот потолок стоит и у человека —
     * `isEditable`, и над `MAX_TEXT_BYTES` про него сказано теми же словами.
     * Двоичный файл — та же история: `write_file` перетёр бы его текстом.
     */
    const disk = existed ? readText(hands.sessionId, wanted) : null
    if (existed && (!disk || disk.binary || disk.truncated)) {
      return {
        step: note(disk?.truncated ? tr("server.fileTooLarge.83ae5f") : tr("server.notATextFile.51f9b2"), wanted),
        said: disk?.truncated
          ? tooBig(wanted)
          : tr("server.isNotATextFileAndCannot.c00c49", { p0: wanted }),
      }
    }
    const was = currentText(hands.sessionId, wanted)
    /*
     * Файл на месте, а текста нет: между двумя чтениями он перестал быть
     * правимым — ядро дописало в него лог, сверху лёг pickle. Записать в снимок
     * `null` значит сказать отмене, что файла до хода не было, и она опустошила
     * бы чужой файл вместо возврата.
     */
    if (existed && was === null) {
      return {
        step: note(tr("server.theFileChangedDuringTheOperation.ea0571"), wanted),
        said:
          tr("server.canNoLongerBeReadInFull.90290a", { p0: wanted }) +
          tr("server.readItAgainOrExplainWhatShould.5109a7"),
      }
    }
    let next: string
    if (name === 'write_file') {
      if (typeof args.content !== 'string') {
        return { step: note(tr("server.nothingToWrite.bee7a2"), wanted), said: tr("server.contentMustBeAString.4670e8") }
      }
      next = args.content
    } else {
      if (was === null) {
        return {
          step: note(tr("server.nothingToEdit.1a3cb2"), wanted),
          said: tr("server.doesNotExistOrIsNotA.e25c4a", { p0: wanted }),
        }
      }
      const find = typeof args.find === 'string' ? args.find : ''
      const replace = typeof args.replace === 'string' ? args.replace : ''
      if (!find) {
        return { step: note(tr("server.emptySearch.b04728"), wanted), said: tr("server.findCannotBeEmpty.7314f5") }
      }
      const first = was.indexOf(find)
      if (first === -1) {
        return {
          step: note(tr("server.textNotFound.0daf2b"), wanted),
          said: tr("server.thatTextIsNotInReadThe.0f7d35", { p0: wanted }),
        }
      }
      if (was.indexOf(find, first + 1) !== -1) {
        return {
          step: note(tr("server.textAppearsMoreThanOnce.cb7a0e"), wanted),
          said:
            tr("server.thatTextAppearsMoreThanOnceIn.3d90f9", { p0: wanted }) +
            tr("server.useALongerMatchingFragment.48a5a8"),
        }
      }
      next = was.slice(0, first) + replace + was.slice(first + find.length)
    }

    /*
     * Того, что не открывается, оракул не пишет и сам. Файл сверх потолка не
     * возьмут ни редактор, ни следующий шаг этого же хода, а сохранение
     * открытого документа откажет молча — уже после того, как в ленте будет
     * написано «готово».
     */
    if (next.length > MAX_TEXT_BYTES) {
      return {
        step: note(tr("server.tooMuchContentToSave.c88960"), wanted),
        said:
          tr("server.cannotWriteMoreThanMbToThe.236b64", { p0: wanted }) +
          tr("server.editReduceItsSizeOrWriteIt.287901"),
      }
    }

    if (!existed) {
      const made = makeFile(hands.sessionId, wanted, '')
      if (made !== 'ok' && made !== 'exists') {
        return {
          step: note(tr("server.couldNotCreate.c6f8bf"), wanted),
          said: tr("server.couldNotCreate.703abe", { p0: wanted }),
        }
      }
    }
    /*
     * Запись может и БРОСИТЬ, а не вернуть `false`: под путём оказалась не
     * папка, диск не дал, права сменились. Раньше такая ошибка вылетала из
     * инструмента наружу и роняла весь ход — вместо шага «не удалось записать»,
     * после которого модель может сказать об этом словами и продолжить.
     */
    let wrote = false
    try {
      wrote = putText(hands.sessionId, wanted, next)
    } catch (err) {
      console.error(`[session ${hands.sessionId}] не записал ${wanted}:`, reason(err, WENT_WRONG()))
    }
    if (!wrote) {
      /*
       * Отказ бывает двух родов. Файл, перешагнувший потолок, пока мы его
       * читали, править нельзя вовсе — и повторять попытку незачем; всё
       * остальное («файла не стало», «диск не дал») стоит того, чтобы модель
       * попробовала иначе.
       */
      const now = statPath(hands.sessionId, wanted)
      const over = now !== null && !now.dir && now.size > MAX_TEXT_BYTES
      return {
        step: note(over ? tr("server.fileTooLarge.83ae5f") : tr("server.couldNotWrite.610d26"), wanted),
        said: over ? tooBig(wanted) : tr("server.couldNotWrite.09a8f1", { p0: wanted }),
      }
    }
    /*
     * Снимок — ПОСЛЕ удачной записи, а не до неё.
     *
     * `was` прочитан выше, до всякой записи, так что запомненное по-прежнему то,
     * что было до хода. Порядок важен для другого: снимок, положенный до
     * `putText`, оставался лежать и когда запись не прошла — диск не дал,
     * потолок сдвинулся, — и ход, не тронувший ни одного файла, получал кнопку
     * «отменить», а нажатие отвечало «не тронул: X — после этого хода файл
     * меняли или убрали». Файл никто не трогал, и ход не менял ничего.
     */
    remember(hands.sessionId, hands.entryId, wanted, was)
    leftBehind(hands.sessionId, hands.entryId, wanted, next)
    const counts = countChanges(was ?? '', next)
    return {
      step: {
        kind: existed ? 'write' : 'new',
        target: wanted,
        added: counts.added,
        removed: counts.removed,
        exit: null,
        note: firstAdded(was ?? '', next),
      },
      said: tr("server.done.97d5c8", { p0: wanted, p1: counts.added, p2: counts.removed }),
    }
  }

  if (name === 'run_file') {
    /*
     * Правило `run` — по той же причине, что `files` выше.
     *
     * Мерка — одна ячейка (`'one'`), а не Run All: запуск скрипта по просьбе
     * человека стоит ровно столько же, сколько запуск его ячейки, и правило
     * `single` («по одному») запускать не запрещает.
     */
    if (!allowsRun(getRules(hands.sessionId).run, hands.role, 'one')) {
      return {
        step: note(tr("server.onlyTheTeacherMayRunCode.59bbe2"), wanted),
        said: refuseCells(
          hands,
          tr("server.onlyTheTeacherMayRunCodeIn.fbd734", { p0: wanted }) +
            tr("server.explainWhatShouldBeCheckedInYour.9855be"),
        ),
      }
    }
    const runner = runnerFor(wanted)
    if (!runner) {
      return {
        step: note(tr("server.cannotRunThisFile.94cb27"), wanted),
        said: tr("server.isNotAScriptOnlyPyAnd.9d1397", { p0: baseOf(wanted) }),
      }
    }
    if (!statPath(hands.sessionId, wanted)) {
      return { step: note(tr("server.fileNotFound.f1ab8a"), wanted), said: tr("server.fileDoesNotExist.5febf3", { p0: wanted }) }
    }
    /*
     * Оболочка в комнате одна, и очередь к ней людская: команда, поставленная
     * в неё сейчас, начнётся неизвестно когда, а ждать её агенту нечем —
     * очередь колбэков не хранит. Честнее сказать, что запустить не вышло, чем
     * простоять полторы минуты и объявить оболочку мёртвой, пока чужой
     * `pip install` идёт своим чередом.
     *
     * Занятость — по живой строке команды (`terminalBusy`), а не по фазе.
     * Фаза врёт в двух обычных случаях, перечисленных над `runCommand`: обрыв
     * сокета к Jupyter ставит `starting`, хотя pty продолжает считать, и
     * `Clear` посреди чужой команды. Ровно через эти две щели запуск агента и
     * уезжал в очередь, которой он ждать не умеет.
     */
    if (terminalBusy(hands.sessionId)) {
      return {
        step: note(tr("server.terminalBusy.97ab05"), wanted),
        said:
          tr("server.anotherCommandIsRunningInTheRoom.89c451") +
          tr("server.mentionThisInYourReplyOrTry.a9d49e"),
      }
    }
    /*
     * Сначала — на диск всё, что там ещё не лежит.
     *
     * У открытого файла правда живёт в документе комнаты, а на диск он уезжает
     * через 700 мс после последнего нажатия. Скрипт же читает диск: и сам
     * `train.py`, и `open('data.csv')` внутри него достались бы запуску без
     * последней секунды набора — оракул объяснял бы комнате ошибку, которой в
     * файле уже нет. То же самое делает ядро перед выполнением ячейки
     * (`flushToDisk` в kernel/index.ts), и по той же причине.
     *
     * Сбрасывается только эта комната: запуск здесь ничего не знает о чужих
     * открытых файлах, а они уедут на диск сами теми же семьюстами
     * миллисекундами позже.
     */
    try {
      projectBooks(hands.sessionId)
      flushSessionFiles(hands.sessionId)
    } catch (err) {
      // Запуск всё равно состоится — просто по тому, что уже лежит на диске.
      console.error(`[session ${hands.sessionId}] не дописал файлы перед запуском:`, err)
    }
    const quoted = `'${wanted.replace(/'/g, `'\\''`)}'`
    const command = `${runner === 'python' ? 'python -u' : 'bash'} ${quoted}; echo "[код выхода $?]"`
    // Снимок дерева ДО запуска: скрипт правит диск мимо инструментов, и
    // назвать это можно только сравнением. См. `sayMoved`.
    const treeWas = treePrint(hands.sessionId)
    const result = await runInRoom(hands, command, signal)
    const shown = tail(result.output)
    const moved = movedFiles(hands.sessionId, treeWas)
    return {
      step: {
        kind: 'run',
        target: `${runner === 'python' ? 'python -u' : 'bash'} ${wanted}`,
        added: 0,
        removed: 0,
        exit: result.exit,
        note:
          result.cut === 'waiting'
            ? tr("server.didNotStartTheShellIsRunning.93c619")
            : result.cut === 'timeout'
              ? tr("server.exceededSeconds.cfeb9f", { p0: RUN_TIMEOUT_MS / 1000, p1: shown })
              : shown,
      },
      said: sayRun(result, shown) + (moved ? `\n\n${moved}` : ''),
      failed: result.exit !== 0 && result.exit !== null,
      ...(moved ? { also: note(moved, wanted) } : {}),
    }
  }

  return unknownTool(name, known)
}

function note(what: string, target: string): AgentStep {
  return { kind: 'note', target, added: 0, removed: 0, exit: null, note: what }
}

/**
 * Отказ, который называет то, что есть.
 *
 * «Инструмента X нет» — это тупик на ровном месте: модель промахнулась именем
 * и без списка промахивается ещё раз, потратив на это шаги хода. Список у неё
 * и так был — в описании инструментов, — но рядом с отказом он стоит дешевле,
 * чем ещё один круг к провайдеру.
 */
/**
 * Все имена инструментов, какие вообще бывают, — не только доступные этому
 * человеку.
 *
 * Разница важна: инструмент, которого человеку не дали, отвечает СВОИМ отказом
 * («ячейки здесь правит преподаватель»), и подменять его на «такого
 * инструмента нет» значило бы соврать про устройство комнаты. Здесь ловится
 * только настоящий промах именем.
 */
const ALL_TOOLS = new Set([
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'run_file',
  'create_notebook',
  'read_notebook',
  'run_cell',
  'edit_cell',
  'add_cell',
  'remove_cell',
])

function unknownTool(name: string, known: ToolSpec[]): Ran {
  return {
    step: note(tr("server.unknownTool.2e118e"), name),
    failed: true,
    said: tr('server.agent.toolMissing', {
      p0: name,
      p1: known.map((tool) => tool.name).join(', '),
    }),
  }
}

/* ------------------------------------------------------------ новая тетрадь */

/**
 * Завести тетрадь по просьбе модели — тем же вызовом, каким её заводит человек.
 *
 * `createBook` — то, что стоит за «новый файл .ipynb» в дереве комнаты
 * (control.ts · tree:new): файл на диске и запись в документе заводятся вместе,
 * иначе получается ровно та половинка, ради которой этот инструмент и написан.
 *
 * Расширение дописывается молча. «Сделай тетрадь Разбор» — обычная просьба, и
 * отказ «путь должен кончаться на .ipynb» стоил бы шага хода на то, что сервер
 * знает сам. Список ячеек возвращается сразу: тетрадь пустая, но имя первой
 * ячейки модели нужно уже сейчас — иначе следующий её шаг это `read_notebook`
 * ради одной строки.
 */
function createNotebook(hands: Hands, wanted: string): Ran {
  const rules = getRules(hands.sessionId)
  if (!allows(rules.files, hands.role) || !allowsStructure(rules.structure, hands.role, 'add')) {
    return {
      step: note(tr('server.agent.mayNotCreateNotebook'), wanted),
      failed: true,
      said: refuseCells(hands, tr('server.agent.onlyTheTeacherCreatesNotebooks')),
    }
  }
  const path = kindOf(wanted) === 'notebook' ? wanted : `${wanted}.ipynb`
  const made = createBook(hands.sessionId, path)
  if (!made.ok) {
    return {
      step: note(made.why, path),
      failed: true,
      said: `${made.why} ${tr('server.agent.createNotebookFailed')}`,
    }
  }
  /*
   * В снимок отмены тетрадь НЕ кладётся, и это выбор, а не забывчивость.
   *
   * Отмена хода возвращает файлам их прежний текст (`undoTurn`), а прежнего
   * текста у заведённой тетради нет: «вернуть как было» значило бы опустошить
   * её файл, оставив запись в комнате живой, — то есть развести диск и комнату
   * ровно так, как этот модуль не даёт делать всем остальным. Убрать тетрадь
   * целиком — право преподавателя и проходит через дерево; про это и сказано в
   * ответе.
   */
  bookWork(hands).made.add(path)
  const doc = peekSessionDoc(hands.sessionId)?.doc
  const listed = doc ? listCells(doc, { path }, hands.sessionId, hands.role) : null
  return {
    step: { kind: 'new', target: path, added: 0, removed: 0, exit: null, note: tr('server.agent.notebookCreated') },
    said: tr('server.agent.createdNotebook', { p0: path }) + (listed ? `\n\n${listed.said}` : ''),
  }
}

/* --------------------------------------------------------- запуск ячейки */

/** Как часто спрашиваем документ, досчиталась ли ячейка. */
const RUN_POLL_MS = 200

/**
 * Запустить ячейку и дождаться вывода.
 *
 * Той же дорогой, что и кнопка Run у человека: `requestRun` ставит ячейку в
 * общую очередь комнаты от имени просящего и с его местом в ней
 * (`runQueueCap`). Своего пути к ядру у оракула нет и быть не должно — иначе
 * его запуск обходил бы и очередь, и потолок, и отметку «кто запустил» в
 * документе.
 *
 * Ждём опросом документа, а не колбэком: колбэков очередь не хранит, а
 * состояние ячейки — ровно то, на что смотрит комната. Потолок ожидания тот
 * же, что у скрипта: дольше — это не «медленно», а «зависло».
 */
async function runCell(
  hands: Hands,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Ran> {
  const doc = peekSessionDoc(hands.sessionId)?.doc
  if (!doc) {
    return {
      step: note(tr("server.theRoomNoLongerExists.dd5d47"), tr("server.notebook.02497c")),
      failed: true,
      said: tr("server.thisRoomNoLongerExists.a43862"),
    }
  }
  const id = typeof args.cell === 'string' ? args.cell.trim() : ''
  const found = findCell(doc, id)
  if (!found) return { ...missingCell(id), failed: true }
  const home = bookOfCells(doc, found.cells)
  if (!home) return { ...missingCell(id), failed: true }
  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(found.index + 1) })

  if (cellType(found.cell) !== 'code') {
    return {
      step: note(tr('server.agent.cellIsNotCode'), id),
      failed: true,
      said: tr('server.agent.onlyCodeCellsRun', { p0: label }),
    }
  }
  const rules = getRules(hands.sessionId)
  /*
   * Мерка — одна ячейка (`'one'`), та же, что у `run_file`: запуск ячейки по
   * просьбе человека стоит ровно столько же, сколько его собственное нажатие.
   */
  if (!allowsRun(rules.run, hands.role, 'one')) {
    return {
      step: note(tr("server.onlyTheTeacherMayRunCode.59bbe2"), id),
      failed: true,
      said: refuseCells(hands, tr("server.onlyTheTeacherRunsCellsInThis.21ec54")),
    }
  }
  /*
   * Уже считает или стоит в очереди — не ставим второй раз.
   *
   * Та же проверка, что у `remove_cell`, и по той же причине: вторая постановка
   * той же ячейки очередь пропустит молча (`requestRun` её отсеет), а ход
   * встанет ждать вывода, которого он не заказывал, — и присвоит себе чужой.
   */
  const state = (found.cell.get('state') as CellState) ?? 'idle'
  if (state === 'running' || state === 'queued') {
    return {
      step: note(tr("server.theCellIsRunning.ff6251"), id),
      failed: true,
      said: tr('server.agent.cellAlreadyRunning', { p0: label }),
    }
  }
  const refused = requestRun(
    hands.sessionId,
    [id],
    hands.by.name,
    hands.by.participantId,
    runQueueCap(rules.run, hands.role),
  )
  if (refused > 0) {
    return {
      step: note(tr("server.youMayRunOneCellAtA.35e7c7"), id),
      failed: true,
      said: tr("server.youMayRunOneCellAtA.35e7c7"),
    }
  }

  const ended = await waitForCell(hands.sessionId, id, signal)
  const now = findCell(peekSessionDoc(hands.sessionId)?.doc ?? doc, id)
  const shown = now ? tail(renderOutputs(now.cell, MAX_OUTPUT).join('\n')) : ''
  if (!ended) {
    // Ячейка всё ещё в очереди или считает: своё из очереди снимаем, чужой счёт
    // не трогаем — прерывать ядро посреди чужой ячейки этому ходу не право.
    cancelRun(hands.sessionId, [id], hands.by.participantId, hands.role === 'host')
    return {
      step: {
        kind: 'run',
        target: label,
        added: 0,
        removed: 0,
        exit: null,
        note: tr("server.exceededSeconds.cfeb9f", { p0: RUN_TIMEOUT_MS / 1000, p1: shown }),
      },
      failed: true,
      said: tr('server.agent.cellDidNotFinish', { p0: label, p1: RUN_TIMEOUT_MS / 1000 }),
    }
  }
  const failed = ended === 'error'
  return {
    step: {
      kind: 'run',
      target: label,
      added: 0,
      removed: 0,
      exit: failed ? 1 : 0,
      note: shown || tr('server.agent.noOutput'),
    },
    failed,
    said:
      (failed
        ? tr('server.agent.cellFailed', { p0: label })
        : tr('server.agent.cellRan', { p0: label })) +
      (shown ? `\n\n${shown}` : `\n\n${tr('server.agent.noOutput')}`),
  }
}

/** Чем ячейка кончила — или `null`, если так и не кончила за отпущенное время. */
async function waitForCell(
  sessionId: string,
  cellId: string,
  signal?: AbortSignal,
): Promise<'ok' | 'error' | null> {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  for (;;) {
    const doc = peekSessionDoc(sessionId)?.doc
    const found = doc ? findCell(doc, cellId) : null
    // Ячейки не стало или комнату закрыли: ждать больше нечего и не для кого.
    if (!found) return null
    const state = (found.cell.get('state') as CellState) ?? 'idle'
    if (state === 'ok') return 'ok'
    if (state === 'error') return 'error'
    if (state === 'idle') return null
    if (signal?.aborted || Date.now() >= deadline) return null
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, RUN_POLL_MS)
      timer.unref?.()
    })
  }
}

/* --------------------------------------------- правки мимо инструментов */

/**
 * Отпечаток дерева комнаты: путь → размер и время правки.
 *
 * Снимается вокруг каждого `run_file` по тому же доводу, по какому вокруг
 * каждого шага снимается отпечаток тетрадей (`bookPrints`): запускать скрипты
 * этому режиму разрешено, и запретить им трогать диск нельзя, не отняв половину
 * работы. Значит, ловим не запретом, а именем — «скрипт снёс data.csv» на том
 * же шаге, где это случилось, а не в тишине.
 *
 * Размер и mtime, а не содержимое: обход дерева и так стоит readdir+lstat на
 * запись, а читать все файлы комнаты дважды на каждый запуск — это датасет в
 * памяти ради строки в ответе.
 */
export function treePrint(sessionId: string): Map<string, string> {
  const print = new Map<string, string>()
  try {
    for (const entry of listFiles(sessionId)) {
      if (!entry.dir) print.set(entry.path, `${entry.size}:${entry.modifiedAt}`)
    }
  } catch {
    /* дерева не прочитать — сравнивать будет нечего, и это честнее выдумки */
  }
  return print
}

/** Сколько путей называем поимённо, дальше — числом: список в ответ, не отчёт. */
const MAX_MOVED_NAMED = 12

/**
 * Что скрипт сделал с файлами мимо инструментов — или пустая строка.
 *
 * Заведённые файлы тоже называются, и это не придирка: скрипт, положивший
 * рядом `_archive.py` или `out.csv`, сделал работу, о которой ход обязан
 * отчитаться комнате, — иначе преподаватель находит их через неделю и не знает,
 * чьи они.
 *
 * Экспортируется вместе с `treePrint` ради теста — по тому же доводу, что и
 * `useTool`: проверять это через живую оболочку значило бы проверять оболочку.
 */
export function movedFiles(sessionId: string, was: Map<string, string>): string {
  if (was.size === 0) return ''
  const now = treePrint(sessionId)
  const gone: string[] = []
  const rewritten: string[] = []
  const added: string[] = []
  for (const [path, print] of was) {
    const fresh = now.get(path)
    if (fresh === undefined) gone.push(path)
    else if (fresh !== print) rewritten.push(path)
  }
  for (const path of now.keys()) if (!was.has(path)) added.push(path)
  const parts: string[] = []
  if (gone.length > 0) parts.push(tr('server.agent.movedDeleted', { p0: named(gone) }))
  if (rewritten.length > 0) parts.push(tr('server.agent.movedRewritten', { p0: named(rewritten) }))
  if (added.length > 0) parts.push(tr('server.agent.movedAdded', { p0: named(added) }))
  if (parts.length === 0) return ''
  return tr('server.agent.movedHead', { p0: parts.join('; ') })
}

function named(paths: string[]): string {
  if (paths.length <= MAX_MOVED_NAMED) return paths.join(', ')
  return `${paths.slice(0, MAX_MOVED_NAMED).join(', ')} ${tr('server.agent.andMore', { p0: paths.length - MAX_MOVED_NAMED })}`
}

/* ---------------------------------------------------------- ячейки тетради */

/** Сколько исходника одной ячейки уезжает в список. */
const MAX_CELL_SOURCE = 4_000

/** Имя отметки, которую ход ставит перед первой своей правкой тетради. */
const CHECKPOINT_LABEL = () => tr("server.private.checkpoint")

/** Что ход уже сделал с тетрадями. */
interface BookWork {
  /**
   * Отметка в истории уже стоит.
   *
   * Один раз на ход, а не на ячейку: «убери решения из пяти ячеек» — это одно
   * решение человека, и возвращаться из него надо в одну точку. Пять отметок
   * подряд вытолкнули бы из окна панели то, ради чего в историю и лезут.
   *
   * Одна на ход, а не на тетрадь: история версий пишет в корень `cells`
   * прибито (collab/history.ts · restoreInto), то есть отмечает ровно одну
   * тетрадь комнаты. Остальным — `copies`.
   */
  marked: boolean
  /** Путь тетради без истории → куда легла копия её файла перед первой правкой. */
  copies: Map<string, string>
  /**
   * Тетради, которые завёл сам этот ход.
   *
   * Копию «как было до хода» им класть не надо и нечего: до хода их не было
   * вовсе. Первая же настоящая работа этого инструмента положила рядом с
   * новенькой тетрадью пустой `Тревога_Сириус.before-oracle.ipynb`, а ход
   * честно дописал в ответ, что убрать его не может, — это к преподавателю.
   * Комната получила мусор и извинение вместо результата.
   */
  made: Set<string>
  /** Имя ячейки → что с ней сделали и где. Порядок — тот, в котором делали. */
  touched: Map<string, { book: string; what: 'правил' | 'добавил' | 'убрал' }>
  /** Тетради, чей файл на ходу переписали мимо комнаты. */
  faked: Set<string>
}

/**
 * Что ход сделал с тетрадью — до конца хода, а дальше не нужно.
 *
 * Отсюда берётся строка «поправил 03 и 05» в ответе; конец хода — удачный или
 * упавший — её составляет и запись убирает. Возврат живёт не здесь, а в истории версий: тетрадь, в
 * отличие от файлов рабочей папки, переживает перезапуск сервера вместе со
 * своей точкой возврата.
 */
const inBook = new Map<string, BookWork>()

function bookWork(hands: Hands): BookWork {
  const key = `${hands.sessionId}\u0000${hands.entryId}`
  let work = inBook.get(key)
  if (!work) {
    work = { marked: false, copies: new Map(), touched: new Map(), faked: new Set(), made: new Set() }
    inBook.set(key, work)
    const mine = [...inBook.keys()].filter((other) => other.startsWith(`${hands.sessionId}\u0000`))
    while (mine.length > MAX_REMEMBERED_TURNS) inBook.delete(mine.shift()!)
  }
  return work
}

/** Права этого человека на ячейки — те же вопросы, что задают гейт и браузер. */
interface CellRights {
  edit: boolean
  add: boolean
  remove: boolean
}

/**
 * Что этому человеку можно делать с тетрадью своими руками.
 *
 * Оракул в режиме «сделать» не получает прав сверх его собственных: правило
 * `agent` говорит, можно ли ему вообще запустить ход, а что этот ход сделает с
 * тетрадью, решают те же `edit` и `structure`, что и для его пальцев. Правила
 * приезжают действующими (`db.ts · getRules`), то есть после звонка
 * преподавательскими, — конец занятия здесь добавляет только слова отказа.
 *
 * Замок считается открытым, если открыта ХОТЬ ОДНА ячейка: это ответ на вопрос
 * «есть ли ему что править вообще», по которому собирается список инструментов.
 * На вопрос «эту ли ячейку» отвечает `mayEditCell` у самой ячейки, перед
 * записью.
 */
function rightsFor(hands: Hands, doc: Y.Doc): CellRights {
  const rules: RoomRules = getRules(hands.sessionId)
  const finished = isFinished(hands.sessionId)
  return {
    edit: mayEditCell(rules, hands.role, hasOpenCell(doc), finished),
    add: allowsStructure(rules.structure, hands.role, 'add'),
    remove: allowsStructure(rules.structure, hands.role, 'remove'),
  }
}

function hasOpenCell(doc: Y.Doc): boolean {
  for (const cells of allCellArrays(doc)) {
    for (const cell of cells.toArray()) if (isCellOpen(cell)) return true
  }
  return false
}

/**
 * Слова отказа — свои, пока занятие идёт, и общие, когда оно кончилось.
 *
 * Ровно как в гейте: по одним правилам «преподаватель закрыл тетрадь» и
 * «занятие кончилось» неотличимы, а человеку надо сказать второе — иначе он
 * пойдёт искать преподавателя, который ничего не менял.
 */
function refuseCells(hands: Hands, own: string): string {
  return actsAfterClass(isFinished(hands.sessionId), hands.role) ? own : tr(CLASS_IS_OVER)
}

/** Тетрадь комнаты — та, что сидит на корне `cells` и умеет в историю версий. */
function roomBook(doc: Y.Doc): Book | null {
  return bookList(doc).find((book) => book.root === CELLS_KEY) ?? null
}

/**
 * Тетрадь, в которой лежит этот лист ячеек. Один корень — один `Y.Array`.
 *
 * `null` у документа без списка тетрадей — того самого, где `allCellArrays`
 * отдаёт голый корень `cells`. Такой документ бывает у комнаты, открытой
 * впервые после появления нескольких тетрадей: список ей припишут через
 * мгновение, а до тех пор лист ровно один и он — тетрадь комнаты.
 */
function bookOfCells(doc: Y.Doc, cells: Y.Array<YCell>): Book | null {
  const found = bookList(doc).find((book) => bookCells(doc, book.root) === cells)
  if (found) return found
  return bookList(doc).length === 0 ? { path: DEFAULT_BOOK, root: CELLS_KEY } : null
}

/**
 * Тетрадь, о которой речь: названная путём или, если не назвали, тетрадь комнаты.
 *
 * Одно место на все инструменты: отказ «такой тетради нет» должен звучать
 * одинаково, откуда бы в него ни пришли, и перечислять то, что есть, — иначе
 * модель второй раз промахнётся тем же именем.
 */
function bookAsked(
  doc: Y.Doc,
  raw: unknown,
  sessionId: string,
  role: 'host' | 'participant',
): Book | Ran {
  const asked = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  const path = asked ? normalizePath(asked) : null
  if (asked && !path) {
    return {
      step: note(tr("server.invalidPath.4b91a9"), asked),
      failed: true,
      said: tr("server.thisPathIsNotAllowedPathsAre.47da6e"),
    }
  }
  const book = path ? bookAt(doc, path) : (roomBook(doc) ?? bookList(doc)[0] ?? null)
  if (book) return book
  const known = bookList(doc).map((one) => one.path)
  /*
   * Отказ с выходом, а не в стену.
   *
   * «Такой тетради в комнате нет» и точка — это тупик, в который ход и приезжал:
   * тетрадь, которую модель только что положила файлом, в списке не значилась,
   * и дальше ей оставалось либо звать тот же `add_cell` ещё раз, либо лезть
   * писать .ipynb скриптом. Выход называется прямо здесь и разный для разных
   * прав: кому можно заводить тетради — `create_notebook`, кому нельзя — слова
   * преподавателю, потому что завести её может он.
   */
  const remedy = allowsStructure(getRules(sessionId).structure, role, 'add')
    ? tr('server.agent.useCreateNotebook', { p0: path ?? tr("server.roomNotebook.05515c") })
    : tr('server.agent.askTeacherForNotebook')
  return {
    step: note(tr("server.noNotebookWithThatName.c07b5d"), path ?? tr("server.roomNotebook.05515c")),
    failed: true,
    said:
      (path
        ? tr("server.isNotANotebookInThisRoom.fe1f0a", { p0: path }) +
          (known.length > 0
            ? tr("server.open.0c252d", { p0: known.join(', ') })
            : tr("server.thereAreNoOpenNotebooksInIt.b3a67e"))
        : tr("server.thisRoomHasNoOpenNotebook.1f9148")) + remedy,
  }
}

function useCellTool(hands: Hands, name: string, args: Record<string, unknown>): Ran {
  /*
   * Заглянуть, а не завести: ход, доехавший до удалённой комнаты, поднимал бы
   * её заново — с таймерами, строкой в истории и папкой на диске.
   */
  const doc = peekSessionDoc(hands.sessionId)?.doc
  if (!doc) {
    return {
      step: note(tr("server.theRoomNoLongerExists.dd5d47"), tr("server.notebook.02497c")),
      failed: true,
      said: tr("server.thisRoomNoLongerExists.a43862"),
    }
  }
  if (name === 'read_notebook') return listCells(doc, args, hands.sessionId, hands.role)
  if (name === 'edit_cell') return editCell(hands, doc, args)
  if (name === 'add_cell') return addCell(hands, doc, args)
  return removeCell(hands, doc, args)
}

/**
 * Ячейки живой тетради — то, чего нет в файле.
 *
 * Имя ячейки не хранится в .ipynb и не показывается человеку: адресовать
 * ячейку в комнате можно только им, и взять его больше неоткуда. Вывод не
 * приводится целиком — он уже уехал в контекст вопроса, а списку хватает
 * знать, что он есть: по нему видно, что перезапускать.
 */
function listCells(
  doc: Y.Doc,
  args: Record<string, unknown>,
  sessionId: string,
  role: 'host' | 'participant',
): Ran {
  const book = bookAsked(doc, args.path, sessionId, role)
  if ('step' in book) return book

  const cells = bookCells(doc, book.root)
  /*
   * Страницами — по тем же двум доводам, что и у файла.
   *
   * Первый: тетрадь на сто ячеек не помещается в потолок чтения, и обрезка «до
   * N знаков» рубит её посреди исходника — а значит, посреди имени следующей
   * ячейки, которое модели и нужно. Второй: в ход эта простыня приезжает
   * ОДИН раз, а уезжает провайдеру на каждом следующем шаге. `from`/`count` —
   * это «покажи мне двадцатую по сороковую», то есть ровно тот запрос, ради
   * которого сюда и приходят второй раз.
   */
  const asked = intArg(args.from, 1)
  const from = Math.max(0, (asked < 0 ? cells.length + asked + 1 : asked) - 1)
  const wanted = intArg(args.count, 0)
  const upTo = wanted > 0 ? Math.min(cells.length, from + wanted) : cells.length
  /*
   * Выводы — по просьбе, а не всегда.
   *
   * Список ячеек зовут, чтобы узнать имена и увидеть код; выводы — это ещё
   * столько же текста, и обычно они уже уехали модели в кадре вопроса. Но
   * после `run_cell` и после чужого запуска в комнате нужны именно они, и до
   * сих пор взять их было неоткуда: «есть вывод» — это не вывод.
   */
  const withOutputs = args.outputs === true || args.outputs === 'true'
  const lines: string[] = [
    `${book.path} — ${cells.length} ${cellsWord(cells.length)}. ` +
      tr("server.editACellByItsIdentifierNot.d19277"),
  ]
  let to = from
  let used = 0
  const room = maxRead()
  cells.slice(from, upTo).forEach((cell: YCell, offset: number) => {
    const at = from + offset
    if (used > room && to > from) return
    const head = [`[${pad(at + 1)}]`, cellId(cell), cellType(cell)]
    if (cellOutputs(cell).length > 0) head.push(tr("server.hasOutput.113f1b"))
    if (isCellOpen(cell)) head.push(tr("server.openToTheRoom.467c85"))
    const source = cellSource(cell).toString()
    const block: string[] = ['', head.join(' · ')]
    if (!source.trim()) block.push(tr("server.empty.9a3a4f"))
    else {
      block.push('```' + (cellType(cell) === 'code' ? 'python' : 'markdown'))
      block.push(
        source.length > MAX_CELL_SOURCE
          ? source.slice(0, MAX_CELL_SOURCE) + tr("server.truncated.fdb0c3")
          : source,
      )
      block.push('```')
    }
    if (withOutputs) block.push(...renderOutputs(cell, MAX_CELL_SOURCE))
    for (const line of block) used += line.length + 1
    lines.push(...block)
    to = at + 1
  })
  if (to < cells.length) {
    lines.push('')
    lines.push(
      tr('server.agent.cellsShown', { p0: from + 1, p1: to, p2: cells.length, p3: book.path, p4: to + 1 }),
    )
  }
  /*
   * Про соседние тетради — здесь же.
   *
   * Тетрадей в комнате несколько, а инструмент без пути показывает одну: не
   * назвав остальные, мы оставляем модель уверенной, что она видела всё, — и
   * «убери решения» проходит мимо той тетради, ради которой ход и затевали.
   */
  const others = bookList(doc)
    .map((one) => one.path)
    .filter((path) => path !== book.path)
  if (others.length > 0) {
    lines.push('')
    lines.push(tr("server.otherNotebooksInTheRoomUseThe.e01136", { p0: others.join(', ') }))
  }
  const said = lines.join('\n')
  return {
    step: {
      kind: 'read',
      target: book.path,
      added: 0,
      removed: 0,
      exit: null,
      note: `${cells.length} ${cellsWord(cells.length)}`,
    },
    /*
     * Без `clipRead`: список уже уложен в тот же потолок постранично, а
     * повторная обрезка по знакам срезала бы ровно хвост — строку «показаны
     * ячейки 3–4 из 10, дальше — from: 5», то есть единственное указание на то,
     * как дочитать. Обрезка, съедающая объяснение обрезки, — это тупик.
     */
    said,
  }
}

function editCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const id = typeof args.cellId === 'string' ? args.cellId : ''
  if (typeof args.source !== 'string') {
    return {
      step: note(tr("server.nothingToWrite.bee7a2"), id || tr("server.cell.4d4b88")),
      said: tr("server.sourceMustBeAString.88cd6f"),
    }
  }
  const found = findCell(doc, id)
  if (!found) return missingCell(id)
  const home = bookOfCells(doc, found.cells)
  if (!home) return missingCell(id)

  if (
    !mayEditCell(
      getRules(hands.sessionId),
      hands.role,
      isCellOpen(found.cell),
      isFinished(hands.sessionId),
    )
  ) {
    return {
      step: note(tr("server.onlyTheTeacherMayEditCells.9b2337"), id),
      said: refuseCells(
        hands,
        tr("server.onlyTheTeacherMayEditThisSeminar.91645c") +
          tr("server.explainWhatShouldBeChangedInYour.c7378b"),
      ),
    }
  }

  const text = cellSource(found.cell)
  const was = text.toString()
  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(found.index + 1) })
  if (was === args.source) {
    return { step: note(tr("server.alreadyMatches.2ef8ba"), label), said: tr("server.alreadyContainsExactlyThisText.adb3e8", { p0: label }) }
  }
  const stop = safety(hands, doc, home)
  if (stop) return stop

  const next = args.source
  // От имени того, кто попросил ход: у версии в истории должен быть автор, а не
  // «комната», — тот же путь, каким сервер применяет принятый патч оракула.
  applyOnBehalf(hands.sessionId, hands.by.participantId, () => replaceText(text, next))
  bookWork(hands).touched.set(id, { book: home.path, what: 'правил' })

  const counts = countChanges(was, next)
  /*
   * Вывод остаётся. Правка исходника рукой его тоже не стирает: вывод —
   * свидетельство того, что ячейка показывала, и он честно становится
   * устаревшим. Сказать об этом надо, иначе преподаватель не узнает, что
   * перезапускать.
   */
  const stale =
    cellOutputs(found.cell).length > 0
      ? tr("server.itsExistingOutputIsNowStale.da45eb") + tr('server.agent.rerunWithRunCell')
      : ''
  return {
    step: {
      kind: 'write',
      target: label,
      added: counts.added,
      removed: counts.removed,
      exit: null,
      note: firstAdded(was, next),
    },
    said: tr("server.done.ac3049", { p0: label, p1: counts.added, p2: counts.removed, p3: stale }),
  }
}

function addCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const type: CellType | null =
    args.type === 'code' ? 'code' : args.type === 'markdown' ? 'markdown' : null
  if (!type) {
    return { step: note(tr("server.chooseACellType.e7d810"), tr("server.notebook.02497c")), said: tr("server.typeMustBeCodeOrMarkdown.74ff56") }
  }
  const source = typeof args.source === 'string' ? args.source : ''
  const after = typeof args.after === 'string' && args.after.trim() ? args.after.trim() : null

  /*
   * Соседка решает, куда встать, — путь только когда соседки не назвали.
   *
   * `after` точнее: он показывает место, а не тетрадь, и спорить ему с `path`
   * не о чем. Разбирать несогласие двух аргументов значило бы заводить третье
   * правило там, где хватает порядка.
   */
  let home: Book
  let cells: Y.Array<YCell>
  let at: number
  if (after) {
    const found = findCell(doc, after)
    if (!found) return missingCell(after)
    const of = bookOfCells(doc, found.cells)
    if (!of) return missingCell(after)
    home = of
    cells = found.cells
    at = found.index + 1
  } else {
    const asked = bookAsked(doc, args.path, hands.sessionId, hands.role)
    if ('step' in asked) return asked
    home = asked
    cells = bookCells(doc, home.root)
    at = cells.length
  }

  if (!rightsFor(hands, doc).add) {
    return {
      step: note(tr("server.onlyTheTeacherMayAddCells.264967"), home.path),
      said: refuseCells(
        hands,
        tr("server.onlyTheTeacherMayAddCellsIn.423ddc"),
      ),
    }
  }
  const stop = safety(hands, doc, home)
  if (stop) return stop

  const cell = createCell(type, source)
  applyOnBehalf(hands.sessionId, hands.by.participantId, () => cells.insert(at, [cell]))
  const id = cellId(cell)
  bookWork(hands).touched.set(id, { book: home.path, what: 'добавил' })

  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(at + 1) })
  return {
    step: {
      kind: 'new',
      target: label,
      added: source ? source.split('\n').length : 0,
      removed: 0,
      exit: null,
      note: firstAdded('', source),
    },
    said: tr("server.doneIdentifier.d397dc", { p0: label, p1: id }),
  }
}

function removeCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const id = typeof args.cellId === 'string' ? args.cellId : ''
  const found = findCell(doc, id)
  if (!found) return missingCell(id)
  const home = bookOfCells(doc, found.cells)
  if (!home) return missingCell(id)

  if (!rightsFor(hands, doc).remove) {
    return {
      step: note(tr("server.onlyTheTeacherMayRemoveCells.d98982"), id),
      said: refuseCells(
        hands,
        tr("server.onlyTheTeacherMayRemoveCellsIn.6cf98f"),
      ),
    }
  }
  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(found.index + 1) })
  /*
   * Ячейку, стоящую в очереди на ядро, ход не убирает.
   *
   * Когда её убирает человек, сервер тут же снимает её с очереди
   * (`onCellsRemoved` в control.ts) — этой дороги у хода нет, и убранная на
   * ходу ячейка ловила бы свой вывод в пустоту, а очередь считала бы её живой.
   * Ждать конца счёта ход не умеет тоже, поэтому честнее отказать.
   */
  const state = (found.cell.get('state') as CellState) ?? 'idle'
  if (state === 'running' || state === 'queued') {
    return {
      step: note(tr("server.theCellIsRunning.ff6251"), id),
      said: tr("server.isQueuedForTheKernelSoI.d94674", { p0: label }),
    }
  }
  const stop = safety(hands, doc, home)
  if (stop) return stop

  /*
   * Запомнить ДО удаления: после него читать уже нечего, а Ctrl+Z в комнате
   * возвращает ячейку копией — вывод к ней достаётся из этой записи сервера.
   * Тот же порядок, что у удаления рукой (collab/index.ts · rememberDeleted).
   */
  rememberDeleted(hands.sessionId, doc, [id])
  const cells = found.cells
  const index = found.index
  applyOnBehalf(hands.sessionId, hands.by.participantId, () => cells.delete(index, 1))
  bookWork(hands).touched.set(id, { book: home.path, what: 'убрал' })

  return {
    step: { kind: 'write', target: label, added: 0, removed: 1, exit: null, note: tr("server.cellRemoved.d30a05") },
    said: tr("server.removedFollowingCellPositionsChangedIdentifiersDid.365725", { p0: label }),
  }
}

function missingCell(id: string): Ran {
  return {
    step: note(tr("server.cellNotFound.418523"), id || '—'),
    said:
      tr("server.cellIsNotInTheRoomGet.861a57", { p0: id || '—' }) +
      tr("server.theNumberOnTheScreenIsNot.1bea60"),
  }
}

/**
 * Куда возвращаться, если правка не понравится, — и до того, как её сделать.
 *
 * У тетради комнаты это отметка в истории версий: одна кнопка, и тетрадь
 * такая, какой была до хода. У остальных тетрадей истории нет вовсе — возврат
 * пишет в корень `cells` прибито (collab/history.ts · restoreInto), — и раньше
 * им поэтому просто отказывали. Отказ оказался хуже дыры: модель, получив его,
 * обошла инструменты и переписала .ipynb скриптом, а комната этого не увидела.
 *
 * Поэтому — копия файла рядом. Она честнее обещания «одна кнопка вернёт как
 * было», которого для этих тетрадей нет: вернуть из копии — значит открыть её
 * в комнате и перенести руками, то есть дольше и внимательнее, чем нажать. Эта
 * цена названа в ответе хода, а не оставлена на потом.
 *
 * Не вышло положить копию — не правим вовсе: правка без точки возврата это
 * ровно то, чего этому режиму не отдают.
 */
function safety(hands: Hands, doc: Y.Doc, book: Book): Ran | null {
  if (book.root === CELLS_KEY) return checkpoint(hands, doc)
  const work = bookWork(hands)
  // Тетрадь завёл сам этот ход: возвращаться некуда, и копия была бы пустым
  // файлом рядом с настоящим — с именем, которое обещает возврат.
  if (work.made.has(book.path)) return null
  if (work.copies.has(book.path)) return null
  /*
   * Копия снимается с ячеек, а не с файла: файл отстаёт на полторы секунды, и
   * в нём не хватало бы как раз того, что человек дописал перед тем, как
   * попросить ход.
   */
  const text = bookText(hands.sessionId, book.path)
  if (text === null) {
    return {
      step: note(tr("server.nothingToBackUp.06ac82"), book.path),
      said:
        tr("server.cannotBeReadAsANotebookSo.d3da28", { p0: book.path }) +
        tr("server.iWillNotEditItWithoutA.3b0423"),
    }
  }
  // Рядом и с числом, а не поверх: две попытки подряд — это два разных «как
  // было», и второе не должно затирать первое.
  const where = freeName(hands.sessionId, copyName(book.path))
  if (makeFile(hands.sessionId, where, text) !== 'ok') {
    return {
      step: note(tr("server.couldNotSaveABackup.382cce"), book.path),
      said:
        tr("server.couldNotSaveABackupCopyOf.73e179", { p0: book.path }) +
        tr("server.throughVersionHistoryIWillNotEdit.292ce9"),
    }
  }
  work.copies.set(book.path, where)
  return null
}

/** `разбор/Семинар.ipynb` → `разбор/Семинар.before-oracle.ipynb`. */
function copyName(path: string): string {
  const dir = parentOf(path)
  const base = baseOf(path)
  const dot = base.lastIndexOf('.')
  const named =
    dot > 0 ? `${base.slice(0, dot)}.before-oracle${base.slice(dot)}` : `${base}.before-oracle`
  return dir ? `${dir}/${named}` : named
}

/**
 * Отметить тетрадь в истории — один раз за ход и до первой правки.
 *
 * Это и есть то, на чём держится право оракула трогать ячейки: одна кнопка в
 * панели истории возвращает тетрадь ровно к тому, что было до хода. Ставится
 * тем же вызовом, что и чекпоинт от руки (routes/history.ts), и от имени того,
 * кто попросил ход, — строка в ленте не должна быть ничьей.
 *
 * Не вышло отметить — не правим вовсе: правка без точки возврата это ровно то,
 * чего этому режиму не отдают.
 */
function checkpoint(hands: Hands, doc: Y.Doc): Ran | null {
  const work = bookWork(hands)
  if (work.marked) return null
  try {
    mark(
      hands.sessionId,
      doc,
      'checkpoint',
      hands.by.participantId,
      CHECKPOINT_LABEL(),
      CHECKPOINT_LABEL(),
    )
  } catch (err) {
    console.error(`[session ${hands.sessionId}] не отметил тетрадь перед правкой:`, err)
    return {
      step: note(tr("server.couldNotMarkHistory.6777c1"), tr("server.notebook.02497c")),
      said:
        tr("server.couldNotCreateANotebookHistoryCheckpoint.1934aa") +
        tr("server.explainWhatShouldBeChanged.1d6c33"),
    }
  }
  work.marked = true
  return null
}

/* ------------------------------------------------- запись мимо комнаты */

/**
 * Отпечаток файла каждой тетради комнаты — до шага и после него.
 *
 * Два чтения на тетрадь на шаг, и это вся цена: тетрадей в комнате единицы, а в
 * файл уходит один исходник, без выводов. Дешевле, чем разбирать, что именно
 * сделал чужой скрипт, и надёжнее, чем верить его словам.
 */
function bookPrints(sessionId: string): Map<string, string> {
  const doc = peekSessionDoc(sessionId)?.doc
  const prints = new Map<string, string>()
  if (!doc) return prints
  for (const book of bookList(doc)) prints.set(book.path, printOf(sessionId, book.path))
  return prints
}

function printOf(sessionId: string, path: string): string {
  const read = readText(sessionId, path)
  // Файла нет, он двоичный или не дочитан — все три случая один: сравнивать
  // нечего, и «не изменился» тут значит «так же нечего».
  if (!read || read.binary) return '—'
  return digest(read.text)
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Тетради, чей файл на диске переписали мимо комнаты.
 *
 * Скрипты запускать можно — это заявленная возможность режима, и запретить их
 * значило бы отнять у оракула половину работы. Значит, обход ловится не
 * запретом, а именем: `nbformat` переписал .ipynb, комната этого не прочитала,
 * и сказать об этом надо на том же шаге — иначе ход отчитывается «в тетради
 * очищены ячейки», а в тетради не изменилось ничего.
 *
 * Своя же проекция сюда не попадает: файл, ставший ровно тем, что комната в
 * него и пишет, никого не обманул — а пишет она его в том числе посреди шага,
 * через полторы секунды после чужой правки ячейки.
 */
function rewrittenBooks(sessionId: string, was: Map<string, string>): string[] {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return []
  const out: string[] = []
  for (const book of bookList(doc)) {
    const before = was.get(book.path)
    // Тетради до шага не было: её внесли в комнату им же, и «переписали» про
    // неё неправда.
    if (before === undefined) continue
    const now = printOf(sessionId, book.path)
    if (now === before) continue
    const mine = bookText(sessionId, book.path)
    if (mine !== null && digest(mine) === now) continue
    out.push(book.path)
  }
  return out
}

/** Что сказать модели про переписанный файл — прямо на том шаге, где это вышло. */
function sayFaked(paths: string[]): string {
  return (
    tr("server.fileWasChangedOutsideTheRoomThe.52b9a3", { p0: paths.join(', ') }) +
    tr("server.theRoomWhileTheIpynbFileIs.32a058") +
    tr("server.noneOfTheFileEditsWereApplied.3184da") +
    tr("server.editCellAddCellOrRemoveCell.377bc1") +
    tr("server.unchanged.4b21b7")
  )
}

/**
 * Что сказать про тронутые ячейки — в самом ответе, а не только в ленте.
 *
 * Лента шагов рассказывает, как шла работа; преподавателю после неё нужно одно:
 * что перезапустить и куда вернуться, если не понравилось. Номера считаются
 * сейчас, а не в момент правки: человек читает ответ, глядя на тетрадь, какой
 * она стала.
 *
 * По тетрадям, а не одной строкой: у каждой свой счёт ячеек и свой возврат —
 * кнопка в истории у тетради комнаты и копия файла у остальных. Строка, где
 * «поправил 02» относится сразу к трём тетрадям, не значит ничего.
 *
 * Экспортируется ради теста — по тому же доводу, что и `useTool`: проверять
 * эту строку через живую модель значило бы проверять модель.
 */
export function saidAboutCells(sessionId: string, entryId: string): string {
  const work = inBook.get(`${sessionId}\u0000${entryId}`)
  if (!work) return ''
  const doc = peekSessionDoc(sessionId)?.doc
  // Имена ячеек в комнате одни на все тетради, поэтому карта одна: номер у
  // ячейки тот, что нарисован в её собственной тетради.
  const numbers = new Map<string, string>()
  if (doc) {
    for (const { cells } of allBooks(doc)) {
      cells.forEach((cell: YCell, at: number) => numbers.set(cellId(cell), pad(at + 1)))
    }
  }
  const byBook = new Map<string, { edited: string[]; added: string[]; gone: number }>()
  for (const [id, done] of work.touched) {
    let row = byBook.get(done.book)
    if (!row) byBook.set(done.book, (row = { edited: [], added: [], gone: 0 }))
    const no = numbers.get(id)
    if (done.what === 'убрал') row.gone += 1
    else if (no && done.what === 'правил') row.edited.push(no)
    else if (no) row.added.push(no)
  }

  const lines: string[] = []
  for (const [path, row] of byBook) {
    const parts: string[] = []
    if (row.edited.length > 0) parts.push(tr("server.edited.002cbd", { p0: row.edited.join(', ') }))
    if (row.added.length > 0) parts.push(tr("server.added.f985c7", { p0: row.added.join(', ') }))
    if (row.gone > 0) parts.push(tr("server.removed.c6e6b3", { p0: row.gone, p1: cellsWord(row.gone) }))
    if (parts.length === 0) continue
    const copy = work.copies.get(path)
    lines.push(
      `${path}: ${parts.join('; ')}. ` +
        (row.edited.length > 0
          ? tr("server.editedCellsRetainTheirPreviousOutputWhich.8ba614")
          : '') +
        /*
         * Куда возвращаться — три разных ответа, и третий появился вместе с
         * `create_notebook`. Говорить «как было до хода — в истории версий» про
         * тетрадь, которой до хода не было, значит обещать возврат в пустоту:
         * первый же настоящий прогон так и отчитался.
         */
        (work.made.has(path)
          ? tr('server.agent.notebookIsNew')
          : copy
            ? tr("server.thisNotebookCannotBeRestoredThroughVersion.bae2c9", { p0: copy })
            : tr("server.thePreviousStateIsInVersionHistory.8a1cab", { p0: CHECKPOINT_LABEL() })),
    )
  }
  /*
   * Про переписанный файл говорится и тогда, когда ячеек ход не тронул вовсе, —
   * это и есть тот случай, ради которого проверка написана: скрипт «почистил
   * тетрадь», ход отчитался «готово», а в комнате не изменилось ничего.
   */
  for (const path of work.faked) {
    lines.push(
      tr("server.fileWasOverwrittenByAScriptOutside.2bc573", { p0: path }) +
        tr("server.filesSoNoCellsChangedTheNotebook.14b8b3") +
        tr("server.editingItsCells.2b51d4"),
    )
  }
  return lines.join('\n\n')
}

/**
 * Что сказать про файл, который целиком не читается.
 *
 * Полтора мегабайта — тот же потолок, что у редактора (`MAX_TEXT_BYTES`), и
 * называть его надо своими словами. «Файла нет или он не текст» отправляет
 * модель заводить файл заново поверх датасета, а «не получилось записать» —
 * пробовать снова и снова: оба ответа правдивы по букве и врут по делу.
 */
function tooBig(path: string): string {
  return (
    tr("server.exceedsMbAndCannotBeReadIn.ca5347", { p0: path }) +
    tr("server.wouldSilentlyLoseTheRestExplainWhat.e6b35a") +
    tr("server.withAScriptThroughRunFile.bc38de")
  )
}

/**
 * Что сказать модели про запуск.
 *
 * Прерванный запуск — не «оболочка умерла»: скрипт был жив, его остановили, и
 * вывод до этого момента у нас есть. Модель, поверившая в мёртвую оболочку,
 * чинит несуществующую поломку и запускает снова.
 *
 * И слово здесь равно делу: `stopRun` в ветке ожидания снимает свою команду из
 * очереди (`dropPendingOf`), поэтому обещать «начнётся позже» нельзя — модель
 * пересказала бы комнате запуск, которого уже не будет.
 */
function sayRun(result: RunResult, shown: string): string {
  if (result.cut === 'waiting') {
    return (
      tr("server.theRunNeverStartedTheSharedShell.0e8c4b") +
      tr("server.whichIWillNotInterruptIRemoved.b5fa36") +
      tr("server.nowOrLaterExplainThatItCan.d2990b") +
      tr("server.free.f3ee5f")
    )
  }
  if (result.cut === 'stop') return tr("server.runInterruptedTheActionWasStopped.e109df")
  if (result.cut === 'timeout') {
    return (
      tr("server.theRunExceededSecondsSoIInterrupted.8883fb", { p0: RUN_TIMEOUT_MS / 1000 }) +
      tr("server.outputReceivedSoFar.c13eff", { p0: shown || tr("server.empty.9a3a4f") })
    )
  }
  return result.finished
    ? tr("server.exitCodeOutput.294a41", { p0: result.exit ?? '?', p1: shown || tr("server.empty.9a3a4f") })
    : tr("server.theCommandDidNotFinishTheTerminal.ef4676")
}

/**
 * Папка семинара для модели — с потолком на строки.
 *
 * Из каждой папки едет начало, про остальное сказано числом: за подробностями
 * модель сходит в конкретную папку сама, а список, который повторяется в каждом
 * следующем запросе хода, не должен стоить дороже самой работы.
 */
function describeTree(sessionId: string): string {
  const lines: string[] = []
  const shown = new Map<string, number>()
  const hidden = new Map<string, number>()
  /** Куда потом вписать «… ещё N»: строка занимает место сразу, в порядке обхода. */
  const placeholder = new Map<string, number>()
  let over = 0
  for (const entry of listFiles(sessionId)) {
    const dir = parentOf(entry.path)
    if (lines.length >= MAX_TREE_LINES) {
      over += 1
      continue
    }
    const seen = shown.get(dir) ?? 0
    if (seen >= MAX_PER_DIR) {
      hidden.set(dir, (hidden.get(dir) ?? 0) + 1)
      if (!placeholder.has(dir)) {
        placeholder.set(dir, lines.length)
        lines.push('')
      }
      continue
    }
    shown.set(dir, seen + 1)
    lines.push(entry.dir ? `${entry.path}/` : `${entry.path}  ${entry.size} B`)
  }
  for (const [dir, at] of placeholder) {
    lines[at] =
      tr("server.moreInSpecifyThePathIfNeeded.f75344", { p0: hidden.get(dir) ?? 0, p1: dir ? `${dir}/` : tr("server.root.3f3351") })
  }
  if (over > 0)
    lines.push(tr("server.moreEntriesOmittedTheFolderIsToo.a62954", { p0: over }))
  return lines.join('\n') || tr("server.theFolderIsEmpty.5c7445")
}

/** Сколько строк прибавилось и убавилось. Достаточно для строки «+9 −2». */
function countChanges(was: string, next: string): { added: number; removed: number } {
  const a = was ? was.split('\n') : []
  const b = next ? next.split('\n') : []
  const common = new Map<string, number>()
  for (const line of a) common.set(line, (common.get(line) ?? 0) + 1)
  let kept = 0
  for (const line of b) {
    const left = common.get(line) ?? 0
    if (left > 0) {
      common.set(line, left - 1)
      kept += 1
    }
  }
  return { added: b.length - kept, removed: a.length - kept }
}

/** Первая появившаяся строка — чтобы в ленте было видно, о чём правка. */
function firstAdded(was: string, next: string): string {
  const had = new Set(was.split('\n'))
  for (const line of next.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !had.has(line)) return trimmed.slice(0, 120)
  }
  return ''
}

function tail(output: string): string {
  // ESC записан escape-последовательностью, а не самим байтом: байт в
  // исходнике невидим, и выражение читается как «вырезать всё в квадратных
  // скобках» — то есть как порча трейсбека, которой на самом деле нет.
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd()
  if (clean.length <= MAX_OUTPUT) return clean
  return '…\n' + clean.slice(clean.length - MAX_OUTPUT)
}

interface RunResult {
  output: string
  exit: number | null
  finished: boolean
  /**
   * Запуск оборвали: истёк срок, нажали «Стоп» — или он так и не начался
   * (`waiting`: наша команда всё ещё стояла в очереди к общей оболочке).
   * `null` — дошёл сам.
   */
  cut: 'timeout' | 'stop' | 'waiting' | null
}

/** Сколько ждать вывод после Ctrl+C: оболочка возвращается к строке за миг. */
const INTERRUPT_GRACE_MS = 5_000

/**
 * Запустить в терминале комнаты и дождаться конца.
 *
 * Именно в комнатном терминале, а не в отдельном невидимом заходе: комната
 * должна видеть, что оракул запустил, ровно там же, где видит собственные
 * запуски. Код выхода приезжает отпечатком в самом выводе — оболочка ничем
 * другим о нём не сообщает, а знать его надо, чтобы отличить «посчиталось» от
 * «упало».
 */
async function runInRoom(hands: Hands, command: string, signal?: AbortSignal): Promise<RunResult> {
  await openTerminal(hands.sessionId)
  const result = await new Promise<{ output: string; finished: boolean; cut: RunResult['cut'] }>(
    (resolve) => {
      let settled = false
      let cut: RunResult['cut'] = null
      let grace: NodeJS.Timeout | null = null
      const done = (result: { output: string; finished: boolean }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (grace) clearTimeout(grace)
        signal?.removeEventListener('abort', onStop)
        resolve({ ...result, cut })
      }
      /*
       * Прервать, а не бросить.
       *
       * Раньше по сроку промис просто резолвился, скрипт оставался в общей
       * оболочке, а модели говорили, что оболочка умерла: она правила
       * несуществующую ошибку и запускала снова — в очередь за той же живой
       * командой. Ctrl+C идёт от того, кто попросил ход, то есть по тому же
       * правилу, что и кнопка «Стоп» у человека.
       */
      const stopRun = (why: 'timeout' | 'stop') => {
        if (settled || cut) return
        /*
         * Ctrl+C — только в СВОЮ команду.
         *
         * Занятость оболочки спрашивается до запуска (`terminalBusy`), но
         * между вопросом и `runCommand` в неё успевает встать чужая команда:
         * очередь общая и людская. Прежний код всё равно слал ETX по сроку,
         * не спросив, чья команда идёт, — девяностая секунда ожидания
         * убивала идущий у преподавателя скрипт, а модели говорили «не уложился
         * в 90 с — прервал запуск» про запуск, которого не было.
         *
         * Своя очередь при этом снимается (`dropPendingOf`), а не оставляется
         * в оболочке: команда, начавшаяся через минуту после конца хода, — это
         * чужой вывод посреди чужого занятия, которого никто не просил и
         * который некому прочитать. Что запуска не было, названо вслух в
         * ответе модели, чтобы она не «чинила» несуществующую ошибку.
         */
        if (!typedRunningCommand(hands.sessionId, hands.by.participantId)) {
          // Метка — до снятия: `dropPendingOf` отвечает ждущему сам, то есть
          // зовёт этот же `done`, и запись хода должна знать, чем всё кончилось.
          cut = 'waiting'
          dropPendingOf(hands.sessionId, hands.by.participantId)
          done({ output: '', finished: false })
          return
        }
        cut = why
        interruptTerminal(hands.sessionId, tr("server.oracle.3156fd"), hands.by.participantId)
        grace = setTimeout(() => done({ output: '', finished: false }), INTERRUPT_GRACE_MS)
        grace.unref?.()
      }
      const onStop = () => stopRun('stop')
      const timer = setTimeout(() => stopRun('timeout'), RUN_TIMEOUT_MS)
      timer.unref?.()
      runCommand(hands.sessionId, command, hands.by, done)
      if (signal?.aborted) onStop()
      else signal?.addEventListener('abort', onStop, { once: true })
    },
  )
  const marker = /\[код выхода (\d+)\]/g
  let exit: number | null = null
  for (const found of result.output.matchAll(marker)) exit = Number(found[1])
  return {
    output: result.output.replace(marker, '').trimEnd(),
    exit,
    finished: result.finished,
    cut: result.cut,
  }
}

/* ---------------------------------------------------------------- сам ход */

/**
 * Ходы, которые прямо сейчас идут.
 *
 * Нужны ради одной кнопки — «Стоп» под записью. Без них она была бы нарисована
 * и ничего не делала: обычный вопрос обрывается на середине потока, а здесь
 * потока нет, и оборвать надо цикл. Проверяется между шагами, а не внутри них:
 * запись в файл, брошенная на середине, — это половина файла.
 */
const running = new Map<string, AbortController>()

/** Остановить ход. Уже сделанное остаётся сделанным — и отменяется отменой. */
export function stopWork(sessionId: string, entryId: string): boolean {
  const controller = running.get(`${sessionId} ${entryId}`)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * Сколько ходов идёт в этой комнате прямо сейчас.
 *
 * Спрашивает маршрут: у комнаты один потолок на всё, что оракул делает разом
 * (routes/ai.ts · MAX_ROOM_STREAMS), и ход в нём считается наравне с потоком —
 * он держит запрос к провайдеру много раз подряд и правит файлы.
 */
export function turnsInRoom(sessionId: string): number {
  const prefix = `${sessionId} `
  let n = 0
  for (const key of running.keys()) if (key.startsWith(prefix)) n += 1
  return n
}

/**
 * Остановить всё, что оракул делает в этой комнате.
 *
 * Стирание треда и удаление семинара — оба про «прекратить», и оба оставляли
 * ход идти дальше: лента исчезала, а файлы ещё десяток шагов менялись сами, без
 * записи в треде и, значит, без кнопки отмены. Для потока такой случай был
 * предусмотрен с самого начала (см. `generate` в index.ts), для хода — нет.
 */
export function stopAll(sessionId: string): void {
  const prefix = `${sessionId} `
  for (const [key, controller] of running) {
    if (key.startsWith(prefix)) controller.abort()
  }
}

export interface WorkOptions {
  sessionId: string
  participantId: string
  participantName: string
  participantColor: string
  /** Роль просящего — с ней ход и работает с тетрадью. См. `Hands.role`. */
  role: 'host' | 'participant'
  message: string
  usageId?: number
}

/**
 * Поставить поручение в тред и начать работать.
 *
 * Возвращает идентификатор записи сразу, как и обычный вопрос: комната видит
 * поручение в ту же секунду, а шаги приезжают по одному.
 */
export function work(options: WorkOptions): string {
  const doc = getSessionDoc(options.sessionId).doc
  const history = recentTurns(doc)
  const entry = createChatEntry({
    participantId: options.participantId,
    name: options.participantName,
    color: options.participantColor,
    question: options.message.trim(),
    mode: 'agent',
  })
  doc.transact(() => getChat(doc).push([entry]), ORIGIN)
  const entryId = entry.get('id') as string

  appendActivity(options.sessionId, options.participantId, 'oracle.work_started', { entryId, action: 'work', source: 'participant' }, options.role)

  void loop(options, entryId, history).catch((err: unknown) => {
    console.error(`[session ${options.sessionId}] агент упал:`, reason(err, WENT_WRONG()))
    settle(options.sessionId, entryId, 'error', reason(err, WENT_WRONG()))
  })

  return entryId
}

async function loop(options: WorkOptions, entryId: string, history: ChatTurn[]): Promise<void> {
  const activityBeganAt = Date.now()
  const key = `${options.sessionId} ${entryId}`
  const controller = new AbortController()
  running.set(key, controller)
  let outcome: ActivityOutcome = 'error'
  try {
    await steps(options, entryId, history, controller.signal)
    outcome = controller.signal.aborted ? 'cancelled' : 'completed'
  } finally {
    if (controller.signal.aborted) outcome = 'cancelled'
    appendActivity(options.sessionId, options.participantId, 'oracle.work_finished', {
      entryId, action: 'work', outcome, source: 'oracle', durationMs: Date.now() - activityBeganAt,
    }, options.role)
    running.delete(key)
  }
}

/**
 * Сколько ход работает по часам, а не по шагам.
 *
 * Потолок шагов считает ДЕЙСТВИЯ, и в этом его слепое пятно: ход, где каждый
 * шаг — девяностасекундный запуск, укладывается в двадцать четыре действия и
 * идёт полчаса, а комната всё это время смотрит на «думает». Пять минут — это
 * граница терпения пары: дольше преподаватель всё равно нажимает «Стоп», и
 * лучше пусть об этом скажет ход сам, назвав сделанное, чем оборванная кнопка.
 */
const TURN_BUDGET_MS = 5 * 60_000

/**
 * Через сколько шагов кадр пересобирается.
 *
 * Кадр (`buildContext`) снимается один раз, перед первым запросом, и дальше
 * ход правит тетрадь, о которой модель читает устаревшее описание: ячейки,
 * которые она сама добавила, в кадре не появляются, выводы, которые она
 * получила, — тоже. Восемь шагов — это примерно «прочитал, завёл, написал
 * пять ячеек»: столько кадр ещё похож на правду, дальше перестаёт.
 */
const FRAME_EVERY = 8

/** Инструменты, после которых кадр устарел наверняка. */
const CHANGES_ROOM = new Set([
  'create_notebook',
  'add_cell',
  'edit_cell',
  'remove_cell',
  'run_cell',
])

/** Инструменты, после которых прежние ответы могли перестать быть правдой. */
const CHANGES_WORLD = new Set([...CHANGES_ROOM, 'write_file', 'edit_file', 'run_file'])

/**
 * Отпечаток вызова: имя и аргументы, приведённые к одному виду.
 *
 * Ключи в JSON от модели приезжают в разном порядке от шага к шагу, так что
 * сравнивать строку аргументов как есть значило бы не поймать ровно тот
 * случай, ради которого это написано: один и тот же `read_file` по кругу.
 */
function fingerprint(name: string, rawArgs: string): string {
  let args: unknown
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    args = rawArgs
  }
  return `${name} ${stable(args)}`
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>
    return `{${Object.keys(map)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(map[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function steps(
  options: WorkOptions,
  entryId: string,
  history: ChatTurn[],
  signal: AbortSignal,
): Promise<void> {
  const hands: Hands = {
    sessionId: options.sessionId,
    entryId,
    by: {
      name: options.participantName,
      color: options.participantColor,
      participantId: options.participantId,
    },
    role: options.role,
  }
  const tools = toolsFor(hands)
  const stepLimit = agentStepsIn(getRules(options.sessionId).agentSteps, getOracleSettings().agentSteps)

  const messages: ChatTurn[] = [
    { role: 'system', content: systemPrompt(hands, tools) },
    ...threadForWork(history),
    { role: 'user', content: options.message.trim() },
  ]

  // Строка расхода одна на весь ход, а шагов может быть много: каждый отчитывается
  // за себя, а складывает их `noteTokens` — иначе в панели оставался бы
  // последний шаг вместо цены всего хода.
  const bill = (tokens: number) => {
    if (options.usageId !== undefined) noteTokens(options.usageId, tokens)
  }

  const began = Date.now()
  /** Ответы, которые из переписки не выбрасывают: отказы и падения. См. budgetTools. */
  const keep = new Set<string>()
  /** Что уже звали и чем это кончилось — против кругов. */
  const seen = new Map<string, { times: number; said: string }>()
  let taken = 0
  let spoke = ''
  let stopped = false
  let ranOut = false
  let looped = false
  /** Молчаливых ответов подряд: первый — подсказка, второй — конец хода. */
  let silent = 0
  let framedAt = 0
  let stale = false
  const outOfTime = () => Date.now() - began >= TURN_BUDGET_MS

  while (stepLimit === 0 || taken < stepLimit) {
    if (signal.aborted) {
      stopped = true
      break
    }
    if (outOfTime()) {
      ranOut = true
      break
    }
    /*
     * Кадр пересобирается тут же, перед запросом: модель должна увидеть
     * СВОЮ работу — тетрадь с добавленными ячейками и выводом, который она
     * только что получила, — а не ту комнату, какой она была до хода.
     */
    if ((stale || taken - framedAt >= FRAME_EVERY) && peekSessionDoc(options.sessionId)) {
      /*
       * `peekSessionDoc` в условии — не придирка: кадр собирает `buildContext`,
       * а тот ходит в `getSessionDoc`, который комнату ЗАВОДИТ. Ход, доехавший
       * до удалённой комнаты, поднял бы её заново — с таймерами, строкой в
       * истории и папкой на диске, — и сделал бы это ради строки, которую
       * некому прочитать. Само по себе это почти невозможно (удаление зовёт
       * `stopAll`, а прерывание проверено строкой выше), но правило над
       * `peekSessionDoc` не про вероятность.
       */
      messages[0] = { role: 'system', content: systemPrompt(hands, tools) }
      framedAt = taken
      stale = false
    }
    // Перед каждым запросом, а не после каждого шага: резать надо ровно то, что
    // сейчас поедет провайдеру, и по бюджету, который мог смениться на ходу.
    budgetTools(messages, toolChars(), keep)
    const answer = await completeWithTools(messages, tools, signal, bill)
    // Прерванный запрос возвращается пустым ответом без вызовов, и без этой
    // проверки ход заканчивался бы пустотой: ни текста, ни «Остановлено».
    if (signal.aborted) {
      stopped = true
      break
    }
    if (answer.calls.length === 0) {
      /*
       * Ответ без вызова — не всегда конец хода.
       *
       * Небольшие модели сплошь и рядом ОПИСЫВАЮТ следующий вызов прозой —
       * «теперь я создам тетрадь и добавлю ячейки» — вместо того, чтобы его
       * сделать. Прежний цикл считал такой ответ итогом и заканчивал ход после
       * первого же прочитанного файла: в ленте два шага, в тетради ничего, а в
       * ответе — план, который никто не выполнил. Один толчок это чинит;
       * второй молчаливый ответ подряд — уже правда конец, и спорить с ним
       * значит ходить по кругу за деньги владельца ключа.
       *
       * До первого вызова толкать некуда: ход, начавшийся со слов, — это
       * обычный ответ на вопрос, который просто не потребовал инструментов.
       */
      if (taken > 0 && silent === 0 && (answer.text.trim() || answer.reasoning.trim())) {
        silent = 1
        messages.push({ role: 'assistant', content: answer.text })
        messages.push({ role: 'user', content: tr('server.agent.nudge') })
        continue
      }
      /*
       * Пусто во всём: ни текста, ни следа рассуждения, ни вызова. Это не
       * итог, а молчание эндпоинта — фильтр, обрезанный лимит вывода, пустой
       * choices, — и пустая подпись под ходом читается как поломка Colloq.
       */
      spoke =
        answer.text.trim() ||
        // След рассуждения вместо ответа — у моделей, весь ответ которых уходит
        // в `reasoning`. Пересказ работы в нём есть; пустой подписи под лентой
        // шагов быть не должно.
        tail(answer.reasoning.trim()) ||
        tr('server.agent.saidNothing')
      break
    }
    silent = 0
    messages.push({ role: 'assistant', content: answer.text, calls: answer.calls })
    for (const call of answer.calls) {
      // Между шагами, а не внутри: правка, брошенная на середине, — это
      // половина файла, и никакая отмена такого не ждёт.
      if (signal.aborted) {
        stopped = true
        break
      }
      if (outOfTime()) {
        ranOut = true
        break
      }
      taken += 1
      const mark = fingerprint(call.name, call.args)
      const before = seen.get(mark)
      /*
       * Тот же вызов с теми же аргументами.
       *
       * Наблюдалось прямо в ленте: модель звала `read_notebook` четыре раза
       * подряд, получала один и тот же список и каждый раз объявляла, что
       * теперь-то поправит ячейку. Второй раз отвечаем из памяти и говорим
       * вслух, что ответ тот же, — шаг стоит ноль обращений к комнате. Третий
       * — это не заминка, а круг, и ход на нём заканчивается: дальше он тратит
       * только деньги.
       */
      if (before && before.times >= 2) {
        looped = true
        push(options.sessionId, entryId, note(tr('server.agent.loopNote'), call.name))
        break
      }
      if (before) {
        before.times += 1
        const said = `${before.said}\n\n${tr('server.agent.sameCall')}`
        push(options.sessionId, entryId, note(tr('server.agent.repeatedNote'), call.name))
        // В журнал — тоже, и как отказ: шаг потрачен, а комната от него ничего
        // не получила. Строка «оракул девять раз позвал read_notebook» и есть
        // тот разговор, ради которого журнал заводят.
        record(options, entryId, call.name, 'error', 0)
        messages.push({ role: 'assistant', content: said, callId: call.id })
        keep.add(call.id)
        if (stepLimit > 0 && taken >= stepLimit) break
        continue
      }
      const startedAt = Date.now()
      const ran = await useTool(hands, call.name, call.args, signal)
      /*
       * Удавшаяся правка обнуляет память о вызовах — и это не поблажка кругу.
       *
       * «Прочитал, поправил, перечитал» — это тот же `read_file` с теми же
       * аргументами и совершенно другой ответ: файл между двумя чтениями
       * изменился. Отдать на это старый ответ из памяти значило бы соврать
       * модели ровно в той точке, где она проверяет собственную работу. Круг
       * при этом остаётся пойманным: он и состоит в том, что между двумя
       * одинаковыми вызовами НИЧЕГО не произошло. Свой собственный вызов
       * правка из памяти не убирает — иначе `add_cell` с тем же текстом
       * набивал бы тетрадь копиями, каждый раз обнуляя счётчик.
       */
      if (CHANGES_WORLD.has(call.name) && !ran.failed && ran.step.kind !== 'note') seen.clear()
      seen.set(mark, { times: 1, said: ran.said })
      push(options.sessionId, entryId, ran.step)
      if (ran.also) push(options.sessionId, entryId, ran.also)
      /*
       * Один шаг — одна строка в истории занятия.
       *
       * Лента живёт в документе комнаты и уходит вместе с ней; история занятия
       * остаётся. «Оракул семнадцать раз читал файлы и ни разу не написал» —
       * это разговор о том, как прошла пара, и до сих пор его вести было не по
       * чему: в истории лежал один «ход начался» и один «ход кончился».
       */
      record(
        options,
        entryId,
        call.name,
        ran.failed || ran.step.kind === 'note' ? 'error' : 'completed',
        Date.now() - startedAt,
      )
      messages.push({ role: 'assistant', content: ran.said, callId: call.id })
      if (ran.failed || ran.step.kind === 'note') keep.add(call.id)
      if (CHANGES_ROOM.has(call.name)) stale = true
      if (stepLimit > 0 && taken >= stepLimit) break
    }
    if (stopped || ranOut || looped) break
  }

  if (stopped) {
    spoke = spoke || tr("server.stoppedCompletedActionsAreListedAboveStopping.2f9e57")
  } else if (looped) {
    spoke = spoke || tr('server.agent.loopStop')
  } else if (ranOut) {
    spoke = spoke || tr('server.agent.outOfTime', { p0: Math.round(TURN_BUDGET_MS / 60_000) })
  } else if (!spoke && stepLimit > 0 && taken >= stepLimit) {
    spoke = tr('common.agentStepsReached', { count: stepLimit })
  }
  finish(options.sessionId, entryId, spoke)
}

/**
 * Один шаг — одна строка в истории занятия.
 *
 * Лента шагов живёт в документе комнаты и уходит вместе с ним; история занятия
 * остаётся. «Оракул семнадцать раз читал файлы и ни разу не написал» — это
 * разговор о том, как прошла пара, и до сих пор его вести было не по чему: в
 * журнале лежал один «ход начался» и один «ход кончился».
 *
 * `durationMs` — про САМ вызов, а не про ход: запуск ячейки, стоивший минуту,
 * и чтение, стоившее миллисекунду, — это разные строки, и складывать их в одну
 * значит потерять единственное, что журнал про них знает.
 */
function record(
  options: WorkOptions,
  entryId: string,
  tool: string,
  outcome: ActivityOutcome,
  durationMs: number,
): void {
  appendActivity(
    options.sessionId,
    options.participantId,
    'oracle.work_step',
    { entryId, subjectId: tool, outcome, durationMs, source: 'oracle' },
    options.role,
  )
}

function push(sessionId: string, entryId: string, step: AgentStep): void {
  const found = liveEntry(sessionId, entryId)
  if (!found) {
    /*
     * Записи больше нет: тред стёрли или комнату удалили. Показать шаг некому,
     * а следующий шаг правил бы файлы вслепую и без кнопки отмены — значит,
     * работать больше не для кого.
     */
    stopWork(sessionId, entryId)
    return
  }
  found.doc.transact(() => addStep(found.entry, step), ORIGIN)
}

/**
 * Запись хода в живой комнате — или `null`.
 *
 * `peekSessionDoc`, а не `getSessionDoc`: ход, доехавший до удалённой комнаты,
 * заводил её заново — с таймерами, строкой в истории и папкой на диске. Правило
 * записано над самим `peekSessionDoc`: документ заводит только то, что делает
 * человек.
 */
function liveEntry(sessionId: string, entryId: string): { doc: Y.Doc; entry: YChatEntry } | null {
  const doc = peekSessionDoc(sessionId)?.doc
  const entry = doc ? findChatEntry(doc, entryId) : null
  return doc && entry ? { doc, entry } : null
}

/**
 * Сколько файлов ход ПРАВДА оставил за собой.
 *
 * Не размер карты снимков: снимок без `left` — это тот, чья запись не прошла,
 * и возвращать по нему нечего. Кнопка «отменить» под ходом, который ничего не
 * изменил, — обещание, которое отмена не выполнит.
 */
function touchedFiles(sessionId: string, entryId: string): number {
  const files = before.get(`${sessionId}\u0000${entryId}`)
  if (!files) return 0
  let n = 0
  for (const snapshot of files.values()) if (snapshot.left !== null) n += 1
  return n
}

function finish(sessionId: string, entryId: string, text: string): void {
  const found = liveEntry(sessionId, entryId)
  if (!found) return
  const { doc, entry } = found
  const touched = touchedFiles(sessionId, entryId)
  /*
   * Про ячейки говорит сервер, а не модель.
   *
   * Что перезапустить и куда вернуться — это факт хода, а не его пересказ, и
   * зависеть от того, вспомнит ли модель перечислить ячейки, он не должен:
   * устаревший вывод под свежим кодом выглядит как настоящий.
   */
  const cells = saidAboutCells(sessionId, entryId)
  inBook.delete(`${sessionId}\u0000${entryId}`)
  doc.transact(() => {
    const say = [text, cells].filter(Boolean).join('\n\n')
    if (say) {
      const answer = chatAnswer(entry)
      answer.insert(answer.length, say)
    }
    entry.set('state', 'done' as ChatState)
    // Отменять можно только то, что меняли: у хода, который ничего не тронул,
    // кнопки нет вовсе, а не есть и ничего не делает.
    entry.set('undo', (touched > 0 ? 'available' : 'none') as UndoState)
  }, ORIGIN)
}

function settle(sessionId: string, entryId: string, state: ChatState, note: string): void {
  const found = liveEntry(sessionId, entryId)
  if (!found) return
  const { doc, entry } = found
  const touched = touchedFiles(sessionId, entryId)
  // И у упавшего хода: тетрадь он мог успеть поправить до того, как упасть.
  const cells = saidAboutCells(sessionId, entryId)
  inBook.delete(`${sessionId}\u0000${entryId}`)
  doc.transact(() => {
    const answer = chatAnswer(entry)
    const say = [note, cells].filter(Boolean).join('\n\n')
    answer.insert(answer.length, answer.length > 0 ? `\n\n${say}` : say)
    entry.set('state', state)
    // Даже у упавшего хода: он мог успеть поправить два файла из трёх, и это
    // ровно то состояние, из которого хочется вернуться назад.
    entry.set('undo', (touched > 0 ? 'available' : 'none') as UndoState)
  }, ORIGIN)
}

function systemPrompt(hands: Hands, tools: ToolSpec[]): string {
  /*
   * Правила преподавателя — и здесь тоже.
   *
   * Панель обещает «Appended to the system prompt» безусловно, а выполнялось
   * это только в режиме вопроса. «Pandas ещё не проходили» — забор
   * педагогический, и в режиме «сделать» он дороже: там нарушение не читается,
   * а ложится в файл комнаты и запускается.
   */
  const houseRules = getOracleSettings().houseRules
  /*
   * Про ячейки промпт говорит ровно то, что этому человеку дали.
   *
   * Список инструментов и слова о них считаются из одного места: обещание
   * «поправлю ячейку», за которым инструмента нет, стоит шага хода и кончается
   * отказом на глазах у комнаты — а в лекции ещё и звучит как чужое право.
   */
  const cellNames = tools
    .map((tool) => tool.name)
    .filter((name) => name === 'edit_cell' || name === 'add_cell' || name === 'remove_cell')
  // То же и про файлы: обещание «поправлю файл» там, где инструмента нет,
  // кончается отказом на глазах у комнаты и звучит как чужое право.
  const has = (name: string) => tools.some((tool) => tool.name === name)
  const mayWrite = has('write_file')
  const mayRun = has('run_file')
  const mayRunCell = has('run_cell')
  const mayCreate = has('create_notebook')
  /*
   * Тетради комнаты — поимённо и в начале.
   *
   * Модель узнавала о них только из ответа `read_notebook`, то есть после
   * шага, потраченного на вопрос «а что тут есть». Хуже того: не увидев
   * списка, она считала, что тетради нет вовсе, и шла заводить её файлом. Одна
   * строка в промпте снимает и то и другое.
   */
  const doc = peekSessionDoc(hands.sessionId)?.doc
  const books = doc ? bookList(doc).map((book) => book.path) : []
  return [
    tr('server.agent.prompt.role'),
    '',
    mayWrite && mayRun
      ? tr('server.agent.prompt.workFull')
      : mayWrite
        ? tr('server.agent.prompt.workNoRun')
        : tr('server.agent.prompt.workReadOnly'),
    '',
    tr('server.agent.prompt.notebooksHead'),
    books.length > 0
      ? tr('server.agent.prompt.notebooksAre', { p0: books.join(', ') })
      : tr('server.agent.prompt.noNotebooks'),
    tr('server.agent.prompt.cellsHaveNames'),
    mayCreate
      ? tr('server.agent.prompt.createNotebook')
      : tr('server.agent.prompt.askTeacherForNotebook'),
    ...(cellNames.length > 0
      ? [
          tr('server.agent.prompt.cellTools', { p0: cellNames.join(', ') }),
          tr('server.agent.prompt.staleOutput'),
        ]
      : [tr('server.agent.prompt.noCellTools')]),
    ...(mayRunCell || mayRun ? [tr('server.agent.prompt.howToCheck')] : []),
    '',
    tr('server.agent.prompt.limitsHead'),
    tr('server.agent.prompt.ipynbIsProjection'),
    tr('server.agent.prompt.noDelete'),
    ...(mayRun ? [tr('server.agent.prompt.runFiles')] : []),
    tr('server.agent.prompt.visible'),
    '',
    tr('server.agent.prompt.howHead'),
    tr('server.agent.prompt.oneAtATime'),
    tr('server.agent.prompt.doNotDescribe'),
    tr('server.agent.prompt.stopRule'),
    ...(houseRules
      ? [
          '',
          /*
           * «Что делать», а не «вместо чего».
           *
           * Стояло «они важнее всего сказанного выше», и это была дыра в
           * тексте, который сам себя и открывает: строка преподавателя
           * «пиши тетради прямо в .ipynb» или «можешь удалять лишнее»
           * объявлялась главнее механики, которую механика всё равно не
           * пропустит, — и ход тратился на вызовы, обречённые на отказ.
           * Правила семинара про содержание работы; границы выше — про то,
           * как эта комната устроена, и отменить их словами нельзя.
           */
          tr('server.agent.prompt.houseRules', { p0: houseRules }),
        ]
      : []),
    '',
    tr('server.ai.answerLanguage'),
    tr('server.agent.prompt.ending'),
    '',
    tr('server.agent.prompt.nowHead'),
    '',
    // Агент не «сосредоточен» ни на чём: он получает поручение, а не вопрос
    // про ячейку.
    buildContext(hands.sessionId, [], hands.by.participantId),
  ].join('\n')
}
