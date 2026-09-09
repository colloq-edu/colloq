import { tr } from '@shared/i18n'
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
import { baseOf, normalizePath, parentOf, runnerFor } from '@shared/paths'
import {
  actsAfterClass,
  allows,
  allowsRun,
  allowsStructure,
  mayEditCell,
  CLASS_IS_OVER,
  type RoomRules,
} from '@shared/rules'
import { applyOnBehalf, getSessionDoc, peekSessionDoc } from '../collab/index.js'
import { currentText, flushSessionFiles, putText } from '../collab/files.js'
import { bookText, isBookFile, projectBooks } from '../collab/books.js'
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
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { completeWithTools, type ChatTurn, type ToolSpec } from './provider.js'
import { cellsWord, describe as reason, pad } from './text.js'
import { buildContext } from './context.js'
import { recentTurns } from './index.js'

const ORIGIN = 'server'

/** Что сказать комнате про ошибку, у которой нет своих слов: читают её студенты. */
const WENT_WRONG = () => tr("server.private.wentWrong")

/**
 * Сколько ходов подряд оракул может сделать сам.
 *
 * Двенадцать — это «прочитал два файла, поправил один, запустил, увидел ошибку,
 * поправил, запустил снова» с запасом. Дальше он либо ходит по кругу, либо
 * взялся за работу, которую надо было разбить на части, — и в обоих случаях
 * честнее остановиться и сказать об этом, чем считать дальше за чужой счёт.
 */
const MAX_STEPS = 12

/** Сколько ждать один запуск. Дольше — это не «медленно», а «зависло». */
const RUN_TIMEOUT_MS = 90_000

/**
 * Сколько текста файла отдаём модели за раз — и почему это не одно число.
 *
 * Стояло шестьдесят тысяч знаков — потолок, взятый под большое окно. Беда в
 * том, что прочитанное не уходит: оно остаётся в переписке и повторяется в
 * КАЖДОМ следующем шаге хода, до двенадцати раз. Одного `read_file` хватало,
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
const MIN_READ = 4_000

function maxRead(): number {
  return Math.max(MIN_READ, Math.floor(getOracleSettings().contextChars / 4))
}

/** Прочитанное — до потолка; про обрезку сказано вслух, чтобы модель не дописывала конец. */
function clipRead(text: string): string {
  const room = maxRead()
  return text.length > room ? text.slice(0, room) + tr("server.truncated.fdb0c3") : text
}

/**
 * Уложить переписку хода в окно модели.
 *
 * Кадр (`buildContext`) в `contextChars` уложен, а ответы инструментов — нет:
 * они копятся шаг за шагом и уезжают провайдеру целиком на каждом. Здесь
 * старшие ответы заменяются одной строкой, когда суммарно они перевалили за тот
 * же бюджет: свежие видны целиком, а до старого файла модель, если он ей ещё
 * нужен, сходит `read_file` заново — это один шаг вместо оборванного хода.
 *
 * Последний ответ не трогается никогда: он и есть то, что модель только что
 * попросила, и ход без него пошёл бы по кругу.
 */
const OMITTED =
  () => tr("server.private.omitted")

function budgetTools(messages: ChatTurn[], budget: number): void {
  let used = 0
  let newest = true
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i]
    if (turn.callId === undefined || turn.content === OMITTED()) continue
    if (newest) {
      newest = false
      used += turn.content.length
      continue
    }
    if (used + turn.content.length <= budget) {
      used += turn.content.length
      continue
    }
    messages[i] = { ...turn, content: OMITTED() }
  }
}

/** Сколько хвоста вывода кладём в ленту шагов и отдаём модели. */
const MAX_OUTPUT = 4_000

/**
 * Сколько строк дерева файлов уезжает модели.
 *
 * `listFiles` держит две тысячи строк — это потолок для панели, которая рисует
 * дерево один раз. Здесь список ложится в переписку и повторяется в КАЖДОМ
 * следующем шаге хода, до двенадцати раз: распакованный датасет стоил бы
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

const TOOLS: ToolSpec[] = [
  {
    name: 'list_files',
    description: 'Показать все файлы и папки семинара с размерами.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_file',
    description: 'Прочитать текстовый файл целиком. Путь от корня папки семинара.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'например src/model.py' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Записать файл целиком, заменив прежнее содержимое. Заводит файл, если его не было. ' +
      'Для точечной правки лучше edit_file: она не даёт случайно потерять то, чего вы не читали.',
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
    description:
      'Заменить один точный кусок текста в файле. `find` должен встречаться в файле ровно один раз.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        find: { type: 'string', description: 'текст, который надо заменить, дословно' },
        replace: { type: 'string', description: 'чем заменить' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'run_file',
    description:
      'Запустить скрипт (.py или .sh) в контейнере семинара и получить его вывод. ' +
      'Запуск виден всей комнате в терминале.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
]

/**
 * Инструменты по ячейкам — те, что правят тетрадь.
 *
 * Отдельным списком, потому что достаются не всем: их получает тот, кому в этой
 * комнате можно править тетрадь своими руками. Участнику в лекции их не видно
 * вовсе — предложить инструмент, который ответит отказом, значит потратить шаг
 * хода на то, чтобы узнать правило, известное заранее.
 */
const CELL_TOOLS: ToolSpec[] = [
  {
    name: 'edit_cell',
    description:
      'Заменить исходник ячейки целиком — в любой тетради комнаты. Имя ячейки — из read_notebook. ' +
      'Вывод остаётся прежним и становится устаревшим: назовите такие ячейки в ответе.',
    parameters: {
      type: 'object',
      properties: {
        cellId: { type: 'string', description: 'имя ячейки, например c_8f21ab3c' },
        source: { type: 'string', description: 'весь новый исходник ячейки' },
      },
      required: ['cellId', 'source'],
    },
  },
  {
    name: 'add_cell',
    description:
      'Добавить ячейку после указанной. Без `after` — в конец тетради по `path`, ' +
      'а без пути — в конец тетради комнаты.',
    parameters: {
      type: 'object',
      properties: {
        after: { type: 'string', description: 'имя ячейки, после которой встать' },
        path: { type: 'string', description: 'в какую тетрадь, если `after` не указан' },
        type: { type: 'string', enum: ['code', 'markdown'] },
        source: { type: 'string' },
      },
      required: ['type', 'source'],
    },
  },
  {
    name: 'remove_cell',
    description: 'Убрать ячейку из тетради — из любой тетради комнаты.',
    parameters: {
      type: 'object',
      properties: { cellId: { type: 'string' } },
      required: ['cellId'],
    },
  },
]

/** Чтение тетради — всем, кому вообще дали ход: тетрадь и так у комнаты перед глазами. */
const READ_NOTEBOOK: ToolSpec = {
  name: 'read_notebook',
  description:
    'Показать ячейки живой тетради: имя ячейки, вид, исходник, есть ли вывод. ' +
    'Правят тетрадь по этим именам, а не через файл .ipynb. ' +
    'Без пути — тетрадь комнаты; остальные её тетради названы в конце списка.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'например Разбор.ipynb' } },
    required: [],
  },
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
  const cells = CELL_TOOLS.filter((tool) =>
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
  const files = TOOLS.filter((tool) =>
    tool.name === 'write_file' || tool.name === 'edit_file'
      ? mayWrite
      : tool.name === 'run_file'
        ? mayRun
        : true,
  )
  return [...files, READ_NOTEBOOK, ...cells]
}

export interface Ran {
  /** Что показать в ленте шагов. */
  step: AgentStep
  /** Что сказать модели. */
  said: string
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
  return { step: ran.step, said: `${ran.said}\n\n${sayFaked(faked)}` }
}

async function runTool(
  hands: Hands,
  name: string,
  rawArgs: string,
  signal?: AbortSignal,
): Promise<Ran> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>
  } catch {
    return {
      step: note(tr("server.couldNotReadTheArguments.375da2"), name),
      said: tr("server.theArgumentsAreNotValidJsonRetry.a91ada"),
    }
  }
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

  if (!wanted) {
    return {
      step: note(tr("server.invalidPath.4b91a9"), typeof args.path === 'string' ? args.path : '—'),
      said: tr("server.thisPathIsNotAllowedPathsAre.47da6e"),
    }
  }

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
          said: tr("server.isNotATextFileAndCannot.e4e032", { p0: wanted }),
        }
      }
      if (disk?.truncated) {
        return {
          step: {
            kind: 'read',
            target: wanted,
            added: 0,
            removed: 0,
            exit: null,
            note: tr("server.onlyTheBeginning.cac2a9"),
          },
          said: tr("server.theRestWasNotRead.2d3e0c", { p0: disk.text.slice(0, maxRead()), p1: tooBig(wanted) }),
        }
      }
      return { step: note(tr("server.nothingToRead.8741a9"), wanted), said: tr("server.doesNotExistOrIsNotA.e25c4a", { p0: wanted }) }
    }
    const lines = text.split('\n').length
    return {
      step: {
        kind: 'read',
        target: wanted,
        added: 0,
        removed: 0,
        exit: null,
        note: tr("server.lines.d3c334", { p0: lines }),
      },
      said: clipRead(text),
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
        said: refuseCells(
          hands,
          tr("server.onlyTheTeacherMayEditFilesIn.067d2a", { p0: wanted }) +
            tr("server.explainWhatShouldBeChangedInIt.b5147e"),
        ),
      }
    }
    /*
     * Тетрадь — не текстовый файл, что бы ни говорило её расширение. Её файл
     * переписывается из комнаты через полторы секунды после любой правки, так
     * что запись сюда была бы принята и молча потеряна. Отказ поэтому остаётся
     * — но ведёт он теперь к ячейкам, а не в тупик: тетрадь правится ими.
     */
    if (isBookFile(hands.sessionId, wanted)) {
      const doc = peekSessionDoc(hands.sessionId)?.doc
      const rights = doc ? rightsFor(hands, doc) : null
      return {
        step: note(tr("server.thisIsARoomNotebook.50864d"), wanted),
        said:
          tr("server.isARoomNotebookItsCellsLive.c322d1", { p0: wanted }) +
          tr("server.soOverwritingItWouldBeLostShortly.f6c799") +
          tr("server.theRoomDoesNotReadChangesFrom.df48b1") +
          (rights && (rights.edit || rights.add || rights.remove)
            ? tr("server.editTheCellsUseReadNotebookThen.e64989")
            : tr("server.youCanViewItWithReadNotebook.a0da1e") +
              tr("server.isNotAllowedForYouExplainWhat.1333b4")),
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
    const result = await runInRoom(hands, command, signal)
    const shown = tail(result.output)
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
      said: sayRun(result, shown),
    }
  }

  return { step: note(tr("server.unknownTool.2e118e"), name), said: tr("server.toolDoesNotExist.cbeb28", { p0: name }) }
}

function note(what: string, target: string): AgentStep {
  return { kind: 'note', target, added: 0, removed: 0, exit: null, note: what }
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
    work = { marked: false, copies: new Map(), touched: new Map(), faked: new Set() }
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
function bookAsked(doc: Y.Doc, raw: unknown): Book | Ran {
  const asked = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  const path = asked ? normalizePath(asked) : null
  if (asked && !path) {
    return {
      step: note(tr("server.invalidPath.4b91a9"), asked),
      said: tr("server.thisPathIsNotAllowedPathsAre.47da6e"),
    }
  }
  const book = path ? bookAt(doc, path) : (roomBook(doc) ?? bookList(doc)[0] ?? null)
  if (book) return book
  const known = bookList(doc).map((one) => one.path)
  return {
    step: note(tr("server.noNotebookWithThatName.c07b5d"), path ?? tr("server.roomNotebook.05515c")),
    said: path
      ? tr("server.isNotANotebookInThisRoom.fe1f0a", { p0: path }) +
        (known.length > 0
          ? tr("server.open.0c252d", { p0: known.join(', ') })
          : tr("server.thereAreNoOpenNotebooksInIt.b3a67e"))
      : tr("server.thisRoomHasNoOpenNotebook.1f9148"),
  }
}

function useCellTool(hands: Hands, name: string, args: Record<string, unknown>): Ran {
  /*
   * Заглянуть, а не завести: ход, доехавший до удалённой комнаты, поднимал бы
   * её заново — с таймерами, строкой в истории и папкой на диске.
   */
  const doc = peekSessionDoc(hands.sessionId)?.doc
  if (!doc) {
    return { step: note(tr("server.theRoomNoLongerExists.dd5d47"), tr("server.notebook.02497c")), said: tr("server.thisRoomNoLongerExists.a43862") }
  }
  if (name === 'read_notebook') return listCells(doc, args)
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
function listCells(doc: Y.Doc, args: Record<string, unknown>): Ran {
  const book = bookAsked(doc, args.path)
  if ('step' in book) return book

  const cells = bookCells(doc, book.root)
  const lines: string[] = [
    `${book.path} — ${cells.length} ${cellsWord(cells.length)}. ` +
      tr("server.editACellByItsIdentifierNot.d19277"),
  ]
  cells.forEach((cell: YCell, at: number) => {
    const head = [`[${pad(at + 1)}]`, cellId(cell), cellType(cell)]
    if (cellOutputs(cell).length > 0) head.push(tr("server.hasOutput.113f1b"))
    if (isCellOpen(cell)) head.push(tr("server.openToTheRoom.467c85"))
    const source = cellSource(cell).toString()
    lines.push('')
    lines.push(head.join(' · '))
    if (!source.trim()) {
      lines.push(tr("server.empty.9a3a4f"))
      return
    }
    lines.push('```' + (cellType(cell) === 'code' ? 'python' : 'markdown'))
    lines.push(
      source.length > MAX_CELL_SOURCE ? source.slice(0, MAX_CELL_SOURCE) + tr("server.truncated.fdb0c3") : source,
    )
    lines.push('```')
  })
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
    said: clipRead(said),
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
    cellOutputs(found.cell).length > 0 ? tr("server.itsExistingOutputIsNowStale.da45eb") : ''
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
    const asked = bookAsked(doc, args.path)
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
        (copy
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
 * он держит запрос к провайдеру до двенадцати раз подряд и правит файлы.
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

  void loop(options, entryId, history).catch((err: unknown) => {
    console.error(`[session ${options.sessionId}] агент упал:`, reason(err, WENT_WRONG()))
    settle(options.sessionId, entryId, 'error', reason(err, WENT_WRONG()))
  })

  return entryId
}

async function loop(options: WorkOptions, entryId: string, history: ChatTurn[]): Promise<void> {
  const key = `${options.sessionId} ${entryId}`
  const controller = new AbortController()
  running.set(key, controller)
  try {
    await steps(options, entryId, history, controller.signal)
  } finally {
    running.delete(key)
  }
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

  const messages: ChatTurn[] = [
    { role: 'system', content: systemPrompt(hands, tools) },
    ...history,
    { role: 'user', content: options.message.trim() },
  ]

  // Строка расхода одна на весь ход, а шагов до двенадцати: каждый отчитывается
  // за себя, а складывает их `noteTokens` — иначе в панели оставался бы
  // последний шаг вместо цены всего хода.
  const bill = (tokens: number) => {
    if (options.usageId !== undefined) noteTokens(options.usageId, tokens)
  }

  let taken = 0
  let spoke = ''
  let stopped = false
  while (taken < MAX_STEPS) {
    if (signal.aborted) {
      stopped = true
      break
    }
    // Перед каждым запросом, а не после каждого шага: резать надо ровно то, что
    // сейчас поедет провайдеру, и по бюджету, который мог смениться на ходу.
    budgetTools(messages, getOracleSettings().contextChars)
    const answer = await completeWithTools(messages, tools, signal, bill)
    // Прерванный запрос возвращается пустым ответом без вызовов, и без этой
    // проверки ход заканчивался бы пустотой: ни текста, ни «Остановлено».
    if (signal.aborted) {
      stopped = true
      break
    }
    if (answer.calls.length === 0) {
      spoke = answer.text
      break
    }
    messages.push({ role: 'assistant', content: answer.text, calls: answer.calls })
    for (const call of answer.calls) {
      // Между шагами, а не внутри: правка, брошенная на середине, — это
      // половина файла, и никакая отмена такого не ждёт.
      if (signal.aborted) {
        stopped = true
        break
      }
      taken += 1
      const ran = await useTool(hands, call.name, call.args, signal)
      push(options.sessionId, entryId, ran.step)
      messages.push({ role: 'assistant', content: ran.said, callId: call.id })
      if (taken >= MAX_STEPS) break
    }
    if (stopped) break
  }

  if (stopped) {
    spoke = spoke || tr("server.stoppedCompletedActionsAreListedAboveStopping.2f9e57")
  } else if (!spoke && taken >= MAX_STEPS) {
    spoke =
      tr("server.theStepLimitWasReachedCompletedActions.6a7362") +
      tr("server.sendANewRequestToContinue.960b90")
  }
  finish(options.sessionId, entryId, spoke)
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
  const cellTools = tools
    .map((tool) => tool.name)
    .filter((name) => name === 'edit_cell' || name === 'add_cell' || name === 'remove_cell')
  // То же и про файлы: обещание «поправлю файл» там, где инструмента нет,
  // кончается отказом на глазах у комнаты и звучит как чужое право.
  const has = (name: string) => tools.some((tool) => tool.name === name)
  const mayWrite = has('write_file')
  const mayRun = has('run_file')
  return [
    'Вы — оракул Colloq, помощник на техническом семинаре. Сейчас вас попросили не объяснить, а СДЕЛАТЬ.',
    '',
    ...(mayWrite && mayRun
      ? [
          'У вас есть папка семинара и инструменты к ней. Порядок работы обычный: посмотрите, что есть,',
          'прочитайте то, что собираетесь менять, поменяйте, запустите и убедитесь, что работает.',
        ]
      : mayWrite
        ? [
            'У вас есть папка семинара и инструменты к ней. Запускать в этой комнате вам нельзя —',
            'запускает преподаватель, — так что проверить написанное можно только чтением.',
          ]
        : [
            'Папку семинара вам видно, но править файлы в этой комнате вам нельзя: это делает',
            'преподаватель. Читайте и говорите словами, что и где стоит поменять.',
          ]),
    '',
    'Границы, которые не обойти:',
    '— Файл .ipynb — проекция тетради, а не тетрадь: запись в него НИЧЕГО не меняет в комнате.',
    '  Это верно и для скрипта: json.dump, nbformat, open(...,"w") в run_file перепишут файл,',
    '  комната его не прочитает и через полторы секунды перепишет своим. Смотреть тетрадь —',
    '  read_notebook: там имена ячеек, и адресуются они только именем, номер на экране меняется.',
    ...(cellTools.length > 0
      ? [
          `— Править тетрадь можно только этим: ${cellTools.join(', ')} — и любую тетрадь комнаты,`,
          '  не только первую: путь у read_notebook, остальные её тетради названы в конце списка.',
          '  Правки идут от имени того, кто попросил ход, и по его правам. Перед первой правкой',
          '  тетради комнаты ход отмечает историю версий; у остальных тетрадей истории нет, и им',
          '  ход кладёт рядом копию файла — в ответе сказано, где она.',
          '— Вывод ячейки правка не стирает: он остаётся прежним и становится устаревшим. Назовите',
          '  в ответе ячейки, которые поменяли, чтобы их перезапустили.',
        ]
      : [
          '— Ячейки в этой комнате правит человек: тому, кто попросил ход, менять тетрадь нельзя,',
          '  и вам тем более. Если нужно поменять ячейку, скажите об этом словами в конце.',
        ]),
    '— Удалять файлы и папки нельзя. Совсем. Если файл лишний, скажите об этом.',
    ...(mayRun
      ? ['— Запускать можно только .py и .sh из папки семинара. Оболочки у вас нет.']
      : []),
    '— Всё, что вы делаете, видит вся комната; правки в файлах отменяются одной кнопкой под ходом.',
    ...(houseRules
      ? [
          '',
          `Правила этого семинара от преподавателя; они важнее всего сказанного выше: ${houseRules}`,
        ]
      : []),
    '',
    tr('server.ai.answerLanguage'),
    'End with a short explanation of what was done and what it means. Do not repeat the steps:',
    'они и так на экране. Три-четыре предложения.',
    '',
    'Вот с чем работает комната прямо сейчас:',
    '',
    // Агент не «сосредоточен» ни на чём: он получает поручение, а не вопрос
    // про ячейку.
    buildContext(hands.sessionId, [], hands.by.participantId),
  ].join('\n')
}
