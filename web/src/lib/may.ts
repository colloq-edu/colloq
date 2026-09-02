/**
 * Что этому человеку можно в этой комнате — в одном месте.
 *
 * Правило, которое останавливает, обязано сказать, что это правило, и сказать
 * там, где нажимают, и до нажатия. Разложить `allows(rules.edit, role)` по
 * двадцати компонентам — верный способ получить комнату, где половина кнопок
 * гаснет, а половина молча ничего не делает; вторые читаются как поломка и
 * приходят обратно баг-репортом.
 *
 * Фразы живут здесь же, рядом с правом: `controls.ts` уже умеет складывать их
 * с «нет связи» и знает, что связь важнее правила.
 */
import {
  actsAfterClass,
  allows,
  allowsAgent,
  allowsRun,
  allowsStructure,
  CLASS_IS_OVER,
  readRules,
  rulesAfterClass,
  type RoomRules,
} from '@shared/rules'
import type { ParticipantRole } from '@shared/protocol'

export interface Permits {
  /**
   * Правила, по которым комната живёт сейчас, — с наложенным концом занятия.
   *
   * Не то, что выбрано в настройках: их берут прямо из `session.session.rules`
   * там, где рисуют сами настройки. Здесь — то, по чему гаснут кнопки.
   */
  rules: RoomRules
  /** Занятие закончено: участник читает, действует преподаватель. */
  finished: boolean
  /** Печатать в ячейках. */
  edit: boolean
  editWhy: string
  /** Запустить: ячейку, файл над редактором, команду в общей оболочке. */
  run: boolean
  runWhy: string
  /** Запустить весь лист: Run All, Run Above, форматирование. */
  bulk: boolean
  bulkWhy: string
  /** Добавить ячейку. */
  add: boolean
  /** Убрать ячейку. */
  remove: boolean
  /** Переставить или продублировать. */
  move: boolean
  structureWhy: string
  /** Стереть всё разом: доска, терминал, лента оракула. */
  wipe: boolean
  wipeWhy: string
  /** Перезапустить ядро. */
  restart: boolean
  restartWhy: string
  /** Видеть ленту версий. */
  history: boolean
  /** Заводить и править файлы семинара. */
  files: boolean
  filesWhy: string
  /** Просить оракула не ответить, а сделать: править файлы самому. */
  agent: boolean
  agentWhy: string
  /** Ставить документ на общий экран комнаты. Смотреть себе может любой. */
  board: boolean
  boardWhy: string
  /**
   * Спрашивать оракула.
   *
   * Правила такого поля не знают: `oracle` описывает подробность ответа для
   * всей комнаты, включая преподавателя. Право спрашивать отнимает только конец
   * занятия — и та же граница стоит на сервере (routes/ai.ts).
   */
  ask: boolean
  askWhy: string
}

const HOSTS = 'В этом семинаре это делает преподаватель'

/**
 * @param finished — закончено ли занятие. Третьим обязательным аргументом, а не
 * полем с умолчанием: забытый аргумент обязан быть ошибкой типов, а не тихо
 * открытой кнопкой в комнате, где пара уже кончилась.
 */
export function permitsIn(rules: unknown, role: ParticipantRole, finished: boolean): Permits {
  const stored = readRules(rules)
  const read = finished ? rulesAfterClass(stored) : stored
  const acts = actsAfterClass(finished, role)
  // Одна фраза вместо всех остальных: правило, которое остановило, человеку
  // сейчас неинтересно — ему важно, что занятие кончилось.
  const why = (own: string): string => (acts ? own : CLASS_IS_OVER)
  const structure = (verb: 'add' | 'remove' | 'move'): boolean =>
    allowsStructure(read.structure, role, verb)
  return {
    rules: read,
    finished,
    edit: allows(read.edit, role),
    editWhy: why('Тетрадь в этом семинаре принадлежит преподавателю'),
    run: allowsRun(read.run, role, 'one'),
    // Одна фраза на три места — кнопка ячейки, «Запустить» над файлом и строка
    // ввода в терминале, — и те же слова, которыми отказывает сервер
    // (control.ts, term:run): правило одно, значит и объяснение одно.
    runWhy: why('В этом семинаре запускает преподаватель — и ячейки, и команды оболочки'),
    bulk: allowsRun(read.run, role, 'bulk'),
    bulkWhy: why(
      read.run === 'single' && role !== 'host'
        ? 'Здесь считают по одной ячейке'
        : 'Весь лист в этом семинаре запускает преподаватель',
    ),
    add: structure('add'),
    remove: structure('remove'),
    move: structure('move'),
    structureWhy: why(
      read.structure === 'add' && role !== 'host'
        ? 'Здесь можно добавлять свои ячейки, но не убирать и не переставлять'
        : 'Состав тетради в этом семинаре — преподавательский',
    ),
    wipe: allows(read.wipe, role),
    wipeWhy: why('Стирать общее здесь может преподаватель'),
    restart: allows(read.restart, role),
    restartWhy: why('Перезапускает ядро преподаватель'),
    history: allows(read.history, role),
    files: allows(read.files, role),
    // Одна фраза на два места — панель файлов и полосу над редактором:
    // «добавляет» не годится там, где речь про правку, а «правит» — там, где
    // про перетаскивание.
    filesWhy: why('Файлы в этой комнате — преподавательские'),
    agent: allowsAgent(read.agent, role),
    agentWhy: why(
      read.agent === 'off'
        ? 'В этом семинаре оракул файлы не трогает'
        : 'Просить оракула править файлы здесь может преподаватель',
    ),
    board: allows(read.board, role),
    boardWhy: why('Показывать документ всей комнате здесь может преподаватель'),
    ask: acts,
    askWhy: CLASS_IS_OVER,
  }
}

export { HOSTS }
