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
  bookRefusal,
  CLASS_IS_OVER,
  mayEditCell,
  mayLeadCouncil,
  mayRunCell,
  mayRunCouncil,
  mayWriteCouncil,
  readRules,
  rulesAfterClass,
  rulesForBook,
  type Asker,
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
  /**
   * Чем отказывает САМА ТЕТРАДЬ, — или `null`, когда тетрадь ни при чём.
   *
   * Нужно двум местам, где иначе заговорила бы комната вместо тетради: полосе
   * «Лекция» над тетрадью и строке под запертой ячейкой. Обе написаны про
   * КОМНАТУ («ячейки редактирует и запускает преподаватель»), и в чужой личной
   * тетради это неправда: правит её автор, а не преподаватель, и человек,
   * прочитавший полосу, пойдёт не туда.
   */
  bookWhy: string | null
  /**
   * У этой тетради свой доступ — какой угодно, кроме «как в комнате».
   *
   * Тем, кто рисует полосу «Лекция»: она говорит про КОМНАТУ, и над тетрадью с
   * собственным доступом её показывать нельзя ни студенту, ни преподавателю —
   * тетрадь живёт не по этому правилу, и про неё говорит метка на вкладке.
   * Отдельно от `bookWhy`, потому что тому, кому тетрадь ничего не запрещает
   * (автору, преподавателю), фразы отказа нет, а полоса всё равно лишняя.
   */
  bookRuled: boolean
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
  /**
   * Завести в комнате СВОЮ тетрадь — пустую или внеся положенный в папку .ipynb.
   *
   * Отдельно от `files`, и это не дублирование: `files` про общую папку
   * занятия, а своя тетрадь — про собственную работу участника, файл которой
   * пишет сервер проекцией. Поэтому «файлы преподавательские, свои тетради
   * разрешены» — обычная пара, и наоборот тоже (shared/rules.ts · ownBooks).
   */
  ownBook: boolean
  ownBookWhy: string
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
 * Какую тетрадь спрашивают — и кто спрашивает.
 *
 * У отдельной тетради бывает свой доступ (shared/rules.ts · RoomRules.books), и
 * тогда `run`, `edit` и `structure` в ней другие. Кто именно спрашивает, здесь
 * нужно ровно одному вопросу: его ли эта личная тетрадь.
 */
export interface InBook {
  /** Корень тетради в документе; `null` — вопрос не про тетрадь. */
  root: string | null
  /** Свой participantId; `null` — спрашивающий себя не назвал. */
  participantId: string | null
}

/**
 * @param finished — закончено ли занятие. Третьим обязательным аргументом, а не
 * полем с умолчанием: забытый аргумент обязан быть ошибкой типов, а не тихо
 * открытой кнопкой в комнате, где пара уже кончилась.
 *
 * @param book — тетрадь, про которую спрашивают. Без неё ответ комнатный, и это
 * правильный ответ для всего, что тетради не касается: терминала, доски, файлов,
 * ядра. Тетрадь и ячейка передают свою (Notebook.svelte, CellView.svelte), и
 * тогда `run`, `edit` и `structure` считаются ЕЮ — той же `rulesForBook`,
 * которой отвечает сервер.
 */
export function permitsIn(
  rules: unknown,
  role: ParticipantRole,
  finished: boolean,
  book: InBook | null = null,
): Permits {
  const stored = readRules(rules)
  const room = finished ? rulesAfterClass(stored) : stored
  const who: Asker = { role, participantId: book?.participantId ?? null }
  /*
   * Конец занятия — ПЕРВЫМ множителем, и это тот же порядок, что на сервере
   * (db.ts · getRules): `rulesAfterClass` карту тетрадей не переносит, так что
   * после звонка `rulesForBook` не находит перекрытий и ничего не открывает.
   */
  const read = rulesForBook(room, book?.root ?? null, who)
  const acts = actsAfterClass(finished, role)
  const refusedByBook = bookRefusal(room, book?.root ?? null, who)
  // Одна фраза вместо всех остальных: правило, которое остановило, человеку
  // сейчас неинтересно — ему важно, что занятие кончилось.
  const why = (own: string): string => (acts ? own : tr(CLASS_IS_OVER))
  /*
   * Когда закрыла ТЕТРАДЬ, говорит она, а не комната.
   *
   * «В этом семинаре печатает преподаватель», сказанное про чужую личную
   * тетрадь, отправляет человека искать преподавателя, который ничего не
   * запрещал: закрылась тетрадь, и закрыл её автор. Те же слова, которыми
   * отказывает сервер (collab/gate.ts · permits).
   */
  const whyHere = (own: string): string =>
    why(refusedByBook ? tr(refusedByBook.key, { p0: refusedByBook.name }) : own)
  const structure = (verb: 'add' | 'remove' | 'move'): boolean =>
    allowsStructure(read.structure, role, verb)
  return {
    rules: read,
    finished,
    role,
    bookWhy: acts && refusedByBook ? tr(refusedByBook.key, { p0: refusedByBook.name }) : null,
    bookRuled: (room.books?.[book?.root ?? '']?.access ?? 'room') !== 'room',
    edit: allows(read.edit, role),
    editWhy: whyHere(tr('room.ui.1092')),
    run: allowsRun(read.run, role, 'one'),
    // Одна фраза на три места — кнопка ячейки, «Запустить» над файлом и строка
    // ввода в терминале, — и те же слова, которыми отказывает сервер
    // (control.ts, term:run): правило одно, значит и объяснение одно.
    runWhy: whyHere(tr('room.ui.1093')),
    bulk: allowsRun(read.run, role, 'bulk'),
    bulkWhy: whyHere(
      read.run === 'single' && role !== 'host'
        ? tr('room.ui.1094')
        : tr('room.ui.1095'),
    ),
    add: structure('add'),
    remove: structure('remove'),
    move: structure('move'),
    structureWhy: whyHere(
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
    /*
     * Правила комнаты, а не тетради: вопрос «можно ли завести ЕЩЁ одну» ни к
     * какой тетради не относится. Потолок своих тетрадей (MAX_OWN_BOOKS)
     * считает сервер — по карте, которой у браузера может не быть целиком; его
     * отказ приезжает строкой и виден там же, где нажали.
     */
    ownBook: role === 'host' || (acts && room.ownBooks === 'on'),
    ownBookWhy: why(tr('room.ui.ownBooksOff')),
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
 * Общая ячейка консилиума — не своя.
 *
 * В ней лежит задание, и правит его преподаватель: переписать её под себя
 * значило бы переписать задание всему классу. Свой лист участника при этом
 * рядом, и он весь его.
 */
export const COUNCIL_SHARED_CELL = 'room.ui.1266'

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
