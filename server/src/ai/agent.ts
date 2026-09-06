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
import { interruptTerminal, openTerminal, runCommand, terminalPhase } from '../kernel/terminal.js'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { completeWithTools, type ChatTurn, type ToolSpec } from './provider.js'
import { buildContext } from './context.js'
import { recentTurns } from './index.js'

const ORIGIN = 'server'

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

/** Сколько текста файла отдаём модели за раз. */
const MAX_READ = 60_000

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
        `${answer.length > 0 ? '\n\n' : ''}Не тронул: ${skipped.join(', ')} — ` +
          'после этого хода файл меняли или убрали, и возврат стёр бы чужую работу.',
      )
    }
    entry.set('undo', 'done' as UndoState)
    entry.set('undoBy', by)
  }, ORIGIN)
  return touched
}

/**
 * Комнату удалили — помнить нечего и работать не для кого.
 *
 * Зовётся из `dropSessionDoc`, где всё про то, чтобы удаление стало
 * окончательным. Идущий ход обрывается здесь же: без этого он ещё десяток
 * шагов писал бы файлы и поднимал контейнер комнаты, которой больше нет.
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
  return [...TOOLS, READ_NOTEBOOK, ...cells]
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
      step: note('не разобрал аргументы', name),
      said: 'Аргументы пришли не как JSON. Повторите вызов.',
    }
  }
  const wanted = typeof args.path === 'string' ? normalizePath(args.path) : null

  if (name === 'list_files') {
    return {
      step: { kind: 'read', target: 'папка семинара', added: 0, removed: 0, exit: null, note: '' },
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
      step: note('путь не годится', typeof args.path === 'string' ? args.path : '—'),
      said: 'Такой путь в этой комнате невозможен. Пути идут от корня папки семинара, без «..».',
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
          step: note('это не текстовый файл', wanted),
          said: `${wanted} — не текстовый файл, прочитать его нельзя.`,
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
            note: 'только начало',
          },
          said: `${disk.text.slice(0, MAX_READ)}\n…(дальше не читал)\n\n${tooBig(wanted)}`,
        }
      }
      return { step: note('нечего читать', wanted), said: `Файла ${wanted} нет или он не текст.` }
    }
    const lines = text.split('\n').length
    return {
      step: {
        kind: 'read',
        target: wanted,
        added: 0,
        removed: 0,
        exit: null,
        note: `${lines} строк`,
      },
      said: text.length > MAX_READ ? text.slice(0, MAX_READ) + '\n…(обрезано)' : text,
    }
  }

  if (name === 'write_file' || name === 'edit_file') {
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
        step: note('это тетрадь комнаты', wanted),
        said:
          `${wanted} — тетрадь комнаты: её ячейки живут в комнате, а файл только их отпечаток, ` +
          'и запись поверх него пропала бы через полторы секунды. Скриптом — ровно то же самое: ' +
          'комната файлы тетрадей не читает. ' +
          (rights && (rights.edit || rights.add || rights.remove)
            ? 'Правьте ячейки: read_notebook, дальше edit_cell, add_cell, remove_cell.'
            : 'Посмотреть её можно через read_notebook; править ячейки в этой комнате ' +
              'вам нельзя — скажите словами, что в ней поменять.'),
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
        step: note(disk?.truncated ? 'файл слишком большой' : 'это не текстовый файл', wanted),
        said: disk?.truncated
          ? tooBig(wanted)
          : `${wanted} — не текстовый файл, править его нельзя.`,
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
        step: note('файл изменился под руками', wanted),
        said:
          `${wanted} только что перестал читаться целиком — похоже, в него пишет кто-то ещё. ` +
          'Посмотрите его заново или скажите словами, что в нём поменять.',
      }
    }
    let next: string
    if (name === 'write_file') {
      if (typeof args.content !== 'string') {
        return { step: note('нечего записывать', wanted), said: '`content` должен быть строкой.' }
      }
      next = args.content
    } else {
      if (was === null) {
        return {
          step: note('нечего править', wanted),
          said: `Файла ${wanted} нет или он не текст.`,
        }
      }
      const find = typeof args.find === 'string' ? args.find : ''
      const replace = typeof args.replace === 'string' ? args.replace : ''
      if (!find) {
        return { step: note('пустой поиск', wanted), said: '`find` не может быть пустым.' }
      }
      const first = was.indexOf(find)
      if (first === -1) {
        return {
          step: note('не нашёл этот кусок', wanted),
          said: `В ${wanted} нет такого текста. Прочитайте файл и повторите с точным куском.`,
        }
      }
      if (was.indexOf(find, first + 1) !== -1) {
        return {
          step: note('кусок встречается дважды', wanted),
          said:
            `Такой текст встречается в ${wanted} больше одного раза — непонятно, какой менять. ` +
            'Возьмите кусок подлиннее.',
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
        step: note('столько не сохранится', wanted),
        said:
          `В ${wanted} нельзя записать больше полутора мегабайт: такой файл ни открыть, ни ` +
          'поправить. Оставьте в нём меньше — или пусть его пишет скрипт.',
      }
    }

    remember(hands.sessionId, hands.entryId, wanted, was)
    if (!existed) {
      const made = makeFile(hands.sessionId, wanted, '')
      if (made !== 'ok' && made !== 'exists') {
        return {
          step: note('не удалось завести', wanted),
          said: `Не получилось создать ${wanted}.`,
        }
      }
    }
    if (!putText(hands.sessionId, wanted, next)) {
      /*
       * Отказ бывает двух родов. Файл, перешагнувший потолок, пока мы его
       * читали, править нельзя вовсе — и повторять попытку незачем; всё
       * остальное («файла не стало», «диск не дал») стоит того, чтобы модель
       * попробовала иначе.
       */
      const now = statPath(hands.sessionId, wanted)
      const over = now !== null && !now.dir && now.size > MAX_TEXT_BYTES
      return {
        step: note(over ? 'файл слишком большой' : 'не удалось записать', wanted),
        said: over ? tooBig(wanted) : `Не получилось записать ${wanted}.`,
      }
    }
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
      said: `Готово: ${wanted}, +${counts.added} −${counts.removed}.`,
    }
  }

  if (name === 'run_file') {
    const runner = runnerFor(wanted)
    if (!runner) {
      return {
        step: note('нечем запускать', wanted),
        said: `${baseOf(wanted)} — не скрипт. Запускаются .py и .sh.`,
      }
    }
    if (!statPath(hands.sessionId, wanted)) {
      return { step: note('нет такого файла', wanted), said: `Файла ${wanted} нет.` }
    }
    /*
     * Оболочка в комнате одна, и очередь к ней людская: команда, поставленная
     * в неё сейчас, начнётся неизвестно когда, а ждать её агенту нечем —
     * очередь колбэков не хранит. Честнее сказать, что запустить не вышло, чем
     * простоять полторы минуты и объявить оболочку мёртвой, пока чужой
     * `pip install` идёт своим чередом.
     */
    if (terminalPhase(hands.sessionId) === 'busy') {
      return {
        step: note('терминал занят', wanted),
        said:
          'В терминале комнаты сейчас идёт другая команда — свой запуск я в очередь не ставлю. ' +
          'Скажите об этом в ответе или попробуйте ещё раз позже.',
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
          result.cut === 'timeout' ? `не уложился в ${RUN_TIMEOUT_MS / 1000} с; ${shown}` : shown,
      },
      said: sayRun(result, shown),
    }
  }

  return { step: note('неизвестный инструмент', name), said: `Инструмента ${name} нет.` }
}

function note(what: string, target: string): AgentStep {
  return { kind: 'note', target, added: 0, removed: 0, exit: null, note: what }
}

/* ---------------------------------------------------------- ячейки тетради */

/** Сколько исходника одной ячейки уезжает в список. */
const MAX_CELL_SOURCE = 4_000

/** Имя отметки, которую ход ставит перед первой своей правкой тетради. */
const CHECKPOINT_LABEL = 'до правки оракула'

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
  return actsAfterClass(isFinished(hands.sessionId), hands.role) ? own : CLASS_IS_OVER
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
      step: note('путь не годится', asked),
      said: 'Такой путь в этой комнате невозможен. Пути идут от корня папки семинара, без «..».',
    }
  }
  const book = path ? bookAt(doc, path) : (roomBook(doc) ?? bookList(doc)[0] ?? null)
  if (book) return book
  const known = bookList(doc).map((one) => one.path)
  return {
    step: note('тетради с таким именем нет', path ?? 'тетрадь комнаты'),
    said: path
      ? `${path} — не тетрадь этой комнаты.` +
        (known.length > 0
          ? ` Открыты: ${known.join(', ')}.`
          : ' Открытых тетрадей в ней нет вовсе.')
      : 'В этой комнате нет открытой тетради.',
  }
}

/** 01, 02, 03 — тот же номер, который нарисован у ячейки в поле слева. */
function pad(no: number): string {
  return String(no).padStart(2, '0')
}

/** «1 ячейка», «3 ячейки», «5 ячеек»: счёт, который не режет глаз. */
function cellsWord(n: number): string {
  const teen = n % 100
  const last = n % 10
  if (teen >= 11 && teen <= 14) return 'ячеек'
  if (last === 1) return 'ячейка'
  if (last >= 2 && last <= 4) return 'ячейки'
  return 'ячеек'
}

function useCellTool(hands: Hands, name: string, args: Record<string, unknown>): Ran {
  /*
   * Заглянуть, а не завести: ход, доехавший до удалённой комнаты, поднимал бы
   * её заново — с таймерами, строкой в истории и папкой на диске.
   */
  const doc = peekSessionDoc(hands.sessionId)?.doc
  if (!doc) {
    return { step: note('комнаты больше нет', 'тетрадь'), said: 'Этой комнаты больше нет.' }
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
      'Ячейку правят по её имени, а не по номеру: номер меняется, имя нет.',
  ]
  cells.forEach((cell: YCell, at: number) => {
    const head = [`[${pad(at + 1)}]`, cellId(cell), cellType(cell)]
    if (cellOutputs(cell).length > 0) head.push('вывод есть')
    if (isCellOpen(cell)) head.push('открыта комнате')
    const source = cellSource(cell).toString()
    lines.push('')
    lines.push(head.join(' · '))
    if (!source.trim()) {
      lines.push('(пусто)')
      return
    }
    lines.push('```' + (cellType(cell) === 'code' ? 'python' : 'markdown'))
    lines.push(
      source.length > MAX_CELL_SOURCE ? source.slice(0, MAX_CELL_SOURCE) + '\n…(обрезано)' : source,
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
    lines.push(`Ещё тетради в комнате: ${others.join(', ')} — тот же инструмент, с путём.`)
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
    said: said.length > MAX_READ ? said.slice(0, MAX_READ) + '\n…(обрезано)' : said,
  }
}

function editCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const id = typeof args.cellId === 'string' ? args.cellId : ''
  if (typeof args.source !== 'string') {
    return {
      step: note('нечего записывать', id || 'ячейка'),
      said: '`source` должен быть строкой.',
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
      step: note('ячейки правит преподаватель', id),
      said: refuseCells(
        hands,
        'В этом семинаре тетрадь принадлежит преподавателю — ячейки правит он. ' +
          'Скажите в ответе, что в ней поменять.',
      ),
    }
  }

  const text = cellSource(found.cell)
  const was = text.toString()
  const label = `${home.path} · ячейка ${pad(found.index + 1)}`
  if (was === args.source) {
    return { step: note('и так уже так', label), said: `В ${label} уже ровно этот текст.` }
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
    cellOutputs(found.cell).length > 0 ? ' Вывод у неё прежний — теперь устаревший.' : ''
  return {
    step: {
      kind: 'write',
      target: label,
      added: counts.added,
      removed: counts.removed,
      exit: null,
      note: firstAdded(was, next),
    },
    said: `Готово: ${label}, +${counts.added} −${counts.removed}.${stale}`,
  }
}

function addCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const type: CellType | null =
    args.type === 'code' ? 'code' : args.type === 'markdown' ? 'markdown' : null
  if (!type) {
    return { step: note('какой вид ячейки', 'тетрадь'), said: '`type` — «code» или «markdown».' }
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
      step: note('ячейки добавляет преподаватель', home.path),
      said: refuseCells(
        hands,
        'В этом семинаре ячейки добавляет преподаватель. Скажите в ответе, что дописать.',
      ),
    }
  }
  const stop = safety(hands, doc, home)
  if (stop) return stop

  const cell = createCell(type, source)
  applyOnBehalf(hands.sessionId, hands.by.participantId, () => cells.insert(at, [cell]))
  const id = cellId(cell)
  bookWork(hands).touched.set(id, { book: home.path, what: 'добавил' })

  const label = `${home.path} · ячейка ${pad(at + 1)}`
  return {
    step: {
      kind: 'new',
      target: label,
      added: source ? source.split('\n').length : 0,
      removed: 0,
      exit: null,
      note: firstAdded('', source),
    },
    said: `Готово: ${label}, имя ${id}.`,
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
      step: note('ячейки убирает преподаватель', id),
      said: refuseCells(
        hands,
        'В этом семинаре ячейки убирает преподаватель. Скажите в ответе, какая лишняя.',
      ),
    }
  }
  const label = `${home.path} · ячейка ${pad(found.index + 1)}`
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
      step: note('ячейка сейчас считается', id),
      said: `${label} сейчас в очереди на ядро — на ходу я её не убираю. Скажите об этом в ответе.`,
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
    step: { kind: 'write', target: label, added: 0, removed: 1, exit: null, note: 'ячейка убрана' },
    said: `Убрал ${label}. Номера ячеек ниже сдвинулись — имена нет.`,
  }
}

function missingCell(id: string): Ran {
  return {
    step: note('нет такой ячейки', id || '—'),
    said:
      `Ячейки ${id || '—'} в комнате нет. Имена ячеек показывает read_notebook — ` +
      'возьмите оттуда, номер на экране именем не является.',
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
      step: note('нечего отложить', book.path),
      said:
        `${book.path} не читается как тетрадь — отложить копию до правки не с чего, ` +
        'а без точки возврата я её не трогаю.',
    }
  }
  // Рядом и с числом, а не поверх: две попытки подряд — это два разных «как
  // было», и второе не должно затирать первое.
  const where = freeName(hands.sessionId, copyName(book.path))
  if (makeFile(hands.sessionId, where, text) !== 'ok') {
    return {
      step: note('не отложил копию', book.path),
      said:
        `Не удалось положить рядом копию ${book.path}, а историей версий эта тетрадь не ` +
        'возвращается — без точки возврата я её не правлю. Скажите словами, что в ней поменять.',
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
      CHECKPOINT_LABEL,
      CHECKPOINT_LABEL,
    )
  } catch (err) {
    console.error(`[session ${hands.sessionId}] не отметил тетрадь перед правкой:`, err)
    return {
      step: note('не отметил историю', 'тетрадь'),
      said:
        'Не удалось отметить тетрадь в истории версий, а без точки возврата я её не правлю. ' +
        'Скажите словами, что в ней поменять.',
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
    `Файл ${paths.join(', ')} переписан мимо комнаты, и комната его не читает: ячейки живут в ` +
    'ней, а .ipynb — только их проекция, которую она перепишет своим через полторы секунды. ' +
    'Ничего из записанного в файл не применилось. Применяется это единственным способом — ' +
    'edit_cell, add_cell, remove_cell; если ими нельзя, скажите в ответе, что тетрадь осталась ' +
    'прежней.'
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
    if (row.edited.length > 0) parts.push(`поправил ${row.edited.join(', ')}`)
    if (row.added.length > 0) parts.push(`добавил ${row.added.join(', ')}`)
    if (row.gone > 0) parts.push(`убрал ${row.gone} ${cellsWord(row.gone)}`)
    if (parts.length === 0) continue
    const copy = work.copies.get(path)
    lines.push(
      `${path}: ${parts.join('; ')}. ` +
        (row.edited.length > 0
          ? 'Вывод у поправленных прежний и теперь устарел — перезапустите их. '
          : '') +
        (copy
          ? `Историей версий эта тетрадь не возвращается — как было до хода, лежит рядом: ${copy}.`
          : `Как было до хода — в истории версий, отметка «${CHECKPOINT_LABEL}».`),
    )
  }
  /*
   * Про переписанный файл говорится и тогда, когда ячеек ход не тронул вовсе, —
   * это и есть тот случай, ради которого проверка написана: скрипт «почистил
   * тетрадь», ход отчитался «готово», а в комнате не изменилось ничего.
   */
  for (const path of work.faked) {
    lines.push(
      `Файл ${path} на ходу переписали мимо комнаты — скриптом. Комната файлы тетрадей не ` +
        'читает, и в ячейках от этой записи не изменилось ничего: тетрадь меняется только ' +
        'правкой ячеек.',
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
    `${path} больше полутора мегабайт: целиком он не читается, и переписывать его началом ` +
    'нельзя — хвост пропал бы молча. Скажите словами, что с ним сделать, или обработайте его ' +
    'скриптом через run_file.'
  )
}

/**
 * Что сказать модели про запуск.
 *
 * Прерванный запуск — не «оболочка умерла»: скрипт был жив, его остановили, и
 * вывод до этого момента у нас есть. Модель, поверившая в мёртвую оболочку,
 * чинит несуществующую поломку и запускает снова.
 */
function sayRun(result: RunResult, shown: string): string {
  if (result.cut === 'stop') return 'Запуск прерван: ход остановили.'
  if (result.cut === 'timeout') {
    return (
      `Не уложился в ${RUN_TIMEOUT_MS / 1000} с — я прервал запуск (Ctrl+C). ` +
      `Вывод до этого момента:\n${shown || '(пусто)'}`
    )
  }
  return result.finished
    ? `Код выхода ${result.exit ?? '?'}. Вывод:\n${shown || '(пусто)'}`
    : 'Команда не доработала — терминал закрыли или оболочка умерла.'
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
      `… ещё ${hidden.get(dir) ?? 0} в ${dir ? `${dir}/` : 'корне'} — скажите путь, если нужно`
  }
  if (over > 0)
    lines.push(`… и ещё ${over} записей ниже: папка слишком велика, чтобы показать её целиком`)
  return lines.join('\n') || 'Папка пуста.'
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
  /** Запуск оборвали: истёк срок или нажали «Стоп». `null` — дошёл сам. */
  cut: 'timeout' | 'stop' | null
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
        cut = why
        interruptTerminal(hands.sessionId, 'оракул', hands.by.participantId)
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
    console.error(`[session ${options.sessionId}] агент упал:`, describe(err))
    settle(options.sessionId, entryId, 'error', describe(err))
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
    spoke = spoke || 'Остановлено. Всё, что успело случиться, — в списке выше, и это отменяется.'
  } else if (!spoke && taken >= MAX_STEPS) {
    spoke =
      'Остановился: слишком много шагов подряд. Что успел — в списке выше; ' +
      'скажите, что делать дальше, и я продолжу.'
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

function finish(sessionId: string, entryId: string, text: string): void {
  const found = liveEntry(sessionId, entryId)
  if (!found) return
  const { doc, entry } = found
  const touched = before.get(`${sessionId}\u0000${entryId}`)?.size ?? 0
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
  const touched = before.get(`${sessionId}\u0000${entryId}`)?.size ?? 0
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
  return [
    'Вы — оракул Colloq, помощник на техническом семинаре. Сейчас вас попросили не объяснить, а СДЕЛАТЬ.',
    '',
    'У вас есть папка семинара и инструменты к ней. Порядок работы обычный: посмотрите, что есть,',
    'прочитайте то, что собираетесь менять, поменяйте, запустите и убедитесь, что работает.',
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
    '— Запускать можно только .py и .sh из папки семинара. Оболочки у вас нет.',
    '— Всё, что вы делаете, видит вся комната; правки в файлах отменяются одной кнопкой под ходом.',
    ...(houseRules
      ? [
          '',
          `Правила этого семинара от преподавателя; они важнее всего сказанного выше: ${houseRules}`,
        ]
      : []),
    '',
    'В конце — короткий ответ по-русски: что сделано и что из этого следует. Без пересказа шагов:',
    'они и так на экране. Три-четыре предложения.',
    '',
    'Вот с чем работает комната прямо сейчас:',
    '',
    // Агент не «сосредоточен» ни на чём: он получает поручение, а не вопрос
    // про ячейку.
    buildContext(hands.sessionId, [], hands.by.participantId),
  ].join('\n')
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Что-то пошло не так.'
}
