/**
 * Оракул, который не отвечает, а делает.
 *
 * Обычный ход — это вопрос и ответ: модель говорит словами, а руки остаются у
 * человека. Здесь модель сама читает папку семинара, правит файлы и запускает
 * скрипты, а комната смотрит на ленту шагов, пока это происходит.
 *
 * Три решения, на которых всё держится.
 *
 * **Правки применяются сразу, а не предлагаются.** Ячейкам оракул по-прежнему
 * предлагает — там есть кнопка «принять», — а файлам нет, и это не
 * непоследовательность. Агент обязан посмотреть на собственную ошибку: написал,
 * запустил, увидел трейсбек, починил. Режим, где каждая правка ждёт нажатия,
 * этого не умеет — он не агент, а тот же ответ в другой обёртке. Взамен весь ход
 * отменяется одной кнопкой: перед первой записью в файл его прежний текст
 * запоминается целиком.
 *
 * **Без потока.** Аргументы инструмента приезжают в потоке кусками
 * незавершённого JSON, и собирать их обратно приходится по-разному у разных
 * провайдеров — ровно та зависимость от конкретного эндпоинта, которой этот
 * продукт избегает. Прогресс показывает лента шагов, и «прочитал src/model.py»
 * полезнее половины предложения.
 *
 * **Удалять нельзя.** Ни файл, ни папку, ни ячейку. Удаление в этом продукте —
 * право преподавателя при любых правилах, и отдать его модели значило бы отдать
 * ей то, чего нет и у комнаты. Опустошить файл она может — и это отменяется.
 */
import type * as Y from 'yjs'
import {
  addStep,
  chatAnswer,
  createChatEntry,
  findChatEntry,
  getChat,
  type AgentStep,
  type ChatState,
  type UndoState,
  type YChatEntry,
} from '@shared/notebook'
import { baseOf, normalizePath, parentOf, runnerFor } from '@shared/paths'
import { getSessionDoc, peekSessionDoc } from '../collab/index.js'
import { currentText, flushSessionFiles, putText } from '../collab/files.js'
import { bookText, isBookFile, projectBooks } from '../collab/books.js'
import { MAX_TEXT_BYTES, listFiles, makeFile, readText, statPath } from '../workspace.js'
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
}

/**
 * Выполнить один инструмент.
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
     * переписывается из комнаты через секунду после любой правки, так что
     * запись сюда была бы принята и молча потеряна. Ячейки оракул предлагает,
     * а не переписывает, — и об этом сказано ему в правилах.
     */
    if (isBookFile(hands.sessionId, wanted)) {
      return {
        step: note('это тетрадь комнаты', wanted),
        said:
          `${wanted} — тетрадь комнаты, её ячейки правит человек. ` +
          'Скажите словами, что в ней поменять.',
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
  }

  const messages: ChatTurn[] = [
    { role: 'system', content: systemPrompt(options.sessionId, options.participantId) },
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
    const answer = await completeWithTools(messages, TOOLS, signal, bill)
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
  doc.transact(() => {
    if (text) {
      const answer = chatAnswer(entry)
      answer.insert(answer.length, text)
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
  doc.transact(() => {
    const answer = chatAnswer(entry)
    answer.insert(answer.length, answer.length > 0 ? `\n\n${note}` : note)
    entry.set('state', state)
    // Даже у упавшего хода: он мог успеть поправить два файла из трёх, и это
    // ровно то состояние, из которого хочется вернуться назад.
    entry.set('undo', (touched > 0 ? 'available' : 'none') as UndoState)
  }, ORIGIN)
}

function systemPrompt(sessionId: string, askedBy: string): string {
  /*
   * Правила преподавателя — и здесь тоже.
   *
   * Панель обещает «Appended to the system prompt» безусловно, а выполнялось
   * это только в режиме вопроса. «Pandas ещё не проходили» — забор
   * педагогический, и в режиме «сделать» он дороже: там нарушение не читается,
   * а ложится в файл комнаты и запускается.
   */
  const houseRules = getOracleSettings().houseRules
  return [
    'Вы — оракул Colloq, помощник на техническом семинаре. Сейчас вас попросили не объяснить, а СДЕЛАТЬ.',
    '',
    'У вас есть папка семинара и инструменты к ней. Порядок работы обычный: посмотрите, что есть,',
    'прочитайте то, что собираетесь менять, поменяйте, запустите и убедитесь, что работает.',
    '',
    'Границы, которые не обойти:',
    '— Тетрадь комнаты вам не принадлежит. Ячейки правит человек; если нужно поменять ячейку,',
    '  скажите об этом словами в конце.',
    '— Удалять файлы и папки нельзя. Совсем. Если файл лишний, скажите об этом.',
    '— Запускать можно только .py и .sh из папки семинара. Оболочки у вас нет.',
    '— Всё, что вы делаете, видит вся комната, и любой ход отменяется одной кнопкой.',
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
    buildContext(sessionId, [], askedBy),
  ].join('\n')
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Что-то пошло не так.'
}
