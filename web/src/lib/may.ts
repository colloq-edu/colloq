import { tr } from '@shared/i18n'
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
  mayEditCell,
  mayLeadCouncil,
  mayRunCell,
  mayRunCouncil,
  mayWriteCouncil,
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
  /**
   * Кто это спрашивает.
   *
   * Все поля ниже — уже готовые ответы, и роль в них вплавлена. Она остаётся
   * здесь ради прав, которые нельзя посчитать заранее, потому что они зависят
   * ещё и от ячейки: см. `mayEditThisCell` в конце файла.
   */
  role: ParticipantRole
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
  /**
   * Вести консилиум: переключать замок и ручки, листать стопку, показывать
   * классу, отвечать, отмечать, убирать, спрашивать оракула о решениях.
   *
   * Правила такого поля не знают: консилиум и есть способ дать классу писать
   * там, где `edit` преподавательский. Ведёт его преподаватель — и после
   * звонка тоже: сданное остаётся на просмотр (shared/rules.ts · mayLeadCouncil).
   */
  council: boolean
  councilWhy: string
  /**
   * Писать свою попытку в консилиуме — своя, а не общая тетрадь, поэтому
   * `edit` здесь ни при чём. Отнимает только конец занятия; «консилиум на этой
   * ячейке закрыт» — второй множитель, и он зависит от ячейки: см.
   * `mayWriteThisCouncil` внизу.
   */
  attempt: boolean
  attemptWhy: string
}

const HOSTS = "В этом семинаре это делает преподаватель"

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
  const why = (own: string): string => (acts ? own : tr(CLASS_IS_OVER))
  const structure = (verb: 'add' | 'remove' | 'move'): boolean =>
    allowsStructure(read.structure, role, verb)
  return {
    rules: read,
    finished,
    role,
    edit: allows(read.edit, role),
    editWhy: why(tr('room.ui.1092')),
    run: allowsRun(read.run, role, 'one'),
    // Одна фраза на три места — кнопка ячейки, «Запустить» над файлом и строка
    // ввода в терминале, — и те же слова, которыми отказывает сервер
    // (control.ts, term:run): правило одно, значит и объяснение одно.
    runWhy: why(tr('room.ui.1093')),
    bulk: allowsRun(read.run, role, 'bulk'),
    bulkWhy: why(
      read.run === 'single' && role !== 'host'
        ? tr('room.ui.1094')
        : tr('room.ui.1095'),
    ),
    add: structure('add'),
    remove: structure('remove'),
    move: structure('move'),
    structureWhy: why(
      read.structure === 'add' && role !== 'host'
        ? tr('room.ui.1096')
        : tr('room.ui.1097'),
    ),
    wipe: allows(read.wipe, role),
    wipeWhy: why(tr('room.ui.1098')),
    restart: allows(read.restart, role),
    restartWhy: why(tr('room.ui.1099')),
    history: allows(read.history, role),
    files: allows(read.files, role),
    // Одна фраза на два места — панель файлов и полосу над редактором:
    // «добавляет» не годится там, где речь про правку, а «правит» — там, где
    // про перетаскивание.
    filesWhy: why(tr('room.ui.1100')),
    agent: allowsAgent(read.agent, role),
    agentWhy: why(
      read.agent === 'off'
        ? tr('room.ui.1101')
        : tr('room.ui.1102'),
    ),
    board: allows(read.board, role),
    boardWhy: why(tr('room.ui.1103')),
    ask: acts,
    askWhy: tr(CLASS_IS_OVER),
    council: mayLeadCouncil(role),
    get councilWhy() { return tr('room.ui.1104') },
    attempt: mayWriteCouncil(role, finished, false),
    attemptWhy: tr(CLASS_IS_OVER),
  }
}

/* ------------------------------------------------------- замок на ячейке */

/**
 * Одна фраза на всё, что говорит закрытая ячейка: строка под кодом, подсказка
 * на погашенной кнопке, отказ на Cmd+Enter.
 *
 * Написана про занятие, а не про право: человеку, который только что нажал,
 * важно не какое поле в правилах его остановило, а что тетрадь сейчас ведут.
 * Тот же довод, что у `CLASS_IS_OVER`.
 */
export const LECTURE_CELL = "Эту ячейку редактирует и запускает только преподаватель"

/**
 * Права, которые нельзя посчитать без ячейки.
 *
 * Тонкие обёртки над `mayEditCell`/`mayRunCell` из shared/rules.ts — теми
 * самыми, которыми отвечает сервер (gate.ts и control.ts). Компонент не
 * складывает правило с замком сам: сложенное дважды рано или поздно сложится
 * по-разному, и разойдутся не кнопки, а кнопка с сервером.
 *
 * `may.rules` здесь — уже с наложенным концом занятия, и `finished` передаётся
 * ещё раз намеренно: помощник накладывает то же самое повторно, что ничего не
 * меняет, зато вызов читается одинаково и здесь, и на сервере.
 */
export function mayEditThisCell(may: Permits, open: boolean): boolean {
  return mayEditCell(may.rules, may.role, open, may.finished)
}

/** То же для запуска: закрытую ячейку в лекции считает преподаватель. */
export function mayRunThisCell(may: Permits, open: boolean): boolean {
  return mayRunCell(may.rules, may.role, open, may.finished)
}

/**
 * Одна фраза на закрытый консилиум: строка под попыткой и подсказка на
 * погашенной «Сдать». Текст у студента остаётся черновиком, и фраза обязана
 * это сказать — иначе она читается как «ваша работа пропала».
 */
export const COUNCIL_CLOSED = "Консилиум закрыт. Ваш текст доступен в черновике"

/**
 * Права консилиума, которые нельзя посчитать без ячейки, — тонкие обёртки над
 * shared/rules.ts, теми же, которыми отвечает сервер (control.ts · council:*).
 *
 * `closed` — консилиум на ЭТОЙ ячейке не идёт (`cellLock(cell) !== 'council'`).
 */
export function mayWriteThisCouncil(may: Permits, closed: boolean): boolean {
  return mayWriteCouncil(may.role, may.finished, closed)
}

/** Запустить попытку: преподаватель — любую, студент — свою и только при ручке. */
export function mayRunThisCouncil(may: Permits, studentRun: boolean | 'request'): boolean {
  return mayRunCouncil(may.role, studentRun, may.finished)
}

/**
 * Значит ли замок в этой комнате хоть что-нибудь.
 *
 * Вопрос задаётся про УЧАСТНИКА, а не про того, кто смотрит: преподавателю
 * можно всё при любом замке, и «мне это ничего не меняет» — неверный ответ на
 * «стоит ли рисовать замок», ведь открывает ячейку как раз он.
 *
 * Комната, где участник и так печатает и запускает, замка не показывает вовсе:
 * значок, который ничего не решает, — украшение, а украшение рядом с правилом
 * читается как правило. По той же причине замок исчезает после звонка: там уже
 * ничего не открыть, и говорить об этом должен `CLASS_IS_OVER`.
 */
export function cellLockMatters(may: Permits): boolean {
  const swings = (
    ask: (rules: RoomRules, role: ParticipantRole, open: boolean, finished: boolean) => boolean,
  ): boolean =>
    ask(may.rules, 'participant', true, may.finished) !==
    ask(may.rules, 'participant', false, may.finished)
  return swings(mayEditCell) || swings(mayRunCell)
}

export { HOSTS }
