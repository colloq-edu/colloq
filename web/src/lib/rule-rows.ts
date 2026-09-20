import { tr } from '@shared/i18n'
/**
 * Строки, которыми описывается комната, — по одной на правило.
 *
 * Одно место на панель и на пульт в самой комнате — иначе две поверхности
 * спрашивают одно и то же разными словами, и преподаватель, поставивший
 * «только чтение» из панели, ищет в комнате переключатель, который называется
 * иначе.
 *
 * Порядок не алфавитный и не по важности, а по ходу занятия: сначала то, что
 * человек делает руками в тетради, потом ядро, потом всё общее.
 *
 * Строки двух видов. У большинства ответ выбирается из двух-трёх слов; у двух
 * потолков оракула ответ — число, и переключателем его не задать. Общего у них
 * ровно столько, сколько рисует RoomRulesRows.svelte: название, подпись и одна
 * ручка справа.
 *
 * Числа строк здесь намеренно не названо: оно уже дважды успело разойтись с
 * массивом ниже. Что каждое правило комнаты названо ровно один раз и что каждый
 * вариант доживает до `readRules` — проверяет tests/weblib-rule-rows.test.mts;
 * `oracle` и `model` спрашивают не здесь, и это записано там же.
 *
 * ЯЗЫК этих строк — язык комнаты, а не панели, которая тем же списком
 * пользуется. Панель преподавателя местами английская, и напрашивается
 * перевести подписи заодно с ней. Нельзя: тот же список рисует пульт правил
 * внутри комнаты, а комната по-русски вся — от «Сдать» до «Занятие
 * закончено», — и перевод ради панели дал бы одной настройке два имени, ровно
 * то, от чего второй абзац. Целиком решение записано в шапке
 * components/RoomRulesRows.svelte, здесь важно следствие: переводить эти строки
 * отдельно нельзя, а если язык панели однажды выберут английским, они поедут в
 * него только вместе с текстами комнаты и одним куском — половина оставила бы
 * правило с двумя именами. Что подписи остались в языке комнаты, проверяет тот
 * же тест.
 */
import { LIMITS } from '@shared/admin'
import { MAX_CELL_LIMIT_SEC, type RoomRules } from '@shared/rules'

export interface RuleOption {
  value: string
  label: string
}

/** Строка-переключатель: одно правило, два-три значения, одно горит. */
export interface ChoiceRow {
  kind: 'choice'
  key: keyof RoomRules &
    (
      | 'run'
      | 'edit'
      | 'structure'
      | 'board'
      | 'files'
      | 'agent'
      | 'wipe'
      | 'restart'
      | 'history'
      | 'opens'
      | 'ownBooks'
      | 'danger'
    )
  title: string
  note: string
  options: RuleOption[]
}

/**
 * Строка-число: потолок оракула, который комната опускает под себя.
 *
 * Пусто — «как на инстансе»: это умолчание и сегодняшнее поведение любой
 * комнаты. Границы — те же, что у настройки инстанса (shared/admin.ts ·
 * LIMITS), чтобы комната не просила того, чего инстанс не умеет.
 */
export interface LimitRow {
  kind: 'limit'
  key: keyof RoomRules &
    ('questionsPerHour' | 'slowModeSeconds' | 'agentSteps' | 'cellLimitSec')
  title: string
  note: string
  /** Подпись у поля — чтобы число не осталось голым. */
  unit: string
  min: number
  max: number
  /**
   * Как назвать действующее значение инстанса — и `undefined`, когда его нет.
   *
   * Функция, а не шаблон: у потолков оракула ноль значит не «ноль», а особое
   * состояние, и «0 в час» рядом с полем ввода — это загадка, а не подсказка.
   *
   * Необязательная с тех пор, как числовой строкой стал не только потолок
   * оракула: у предела ячейки инстансового значения нет вовсе, и пустое поле
   * там значит «без предела», а не «как на сервере». Выдуманная строка «как на
   * сервере: —» отвечала бы на вопрос, которого никто не задавал.
   */
  atInstance?: (value: number) => string
}

export type RuleRow = ChoiceRow | LimitRow

const EVERYONE = { value: 'room', get label() { return tr('room.ui.1127') } }
const TEACHER = { value: 'host', get label() { return tr('room.ui.675') } }

/** Слова здесь — комнатные; про язык и про то, почему его не правят отсюда, — шапка файла. */
export const RULE_ROWS: RuleRow[] = [
  {
    kind: 'choice',
    key: 'opens',
    get title() { return tr('room.ui.1128') },
    // Это и есть вся разница между лекцией и консилиумом как режимами: права
    // у них одни, а «открыть ячейку» значит разное.
    get note() { return tr('room.ui.1129') },
    options: [
      { value: 'shared', get label() { return tr('room.ui.1130') } },
      { value: 'council', get label() { return tr('room.ui.1131') } },
    ],
  },
  {
    kind: 'choice',
    key: 'edit',
    get title() { return tr('room.ui.1132') },
    get note() { return tr('room.ui.1133') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'run',
    // Не только ячейки: под этим же правилом «Запустить» над файлом и команда
    // в общей оболочке (control.ts, file:run и term:run). Строка, обещавшая
    // одни ячейки, читалась как «терминал остаётся открытым» — а `python
    // train.py` там тот же контейнер и то же процессорное время.
    get title() { return tr('room.ui.1134') },
    get note() { return tr('room.ui.1135') },
    options: [EVERYONE, { value: 'single', get label() { return tr('room.ui.1136') } }, TEACHER],
  },
  {
    /*
     * Сразу ПОСЛЕ «кто запускает», и место выбрано так же, как у личных
     * тетрадей под файлами: два правила читаются вместе. Первое — кому можно
     * нажать, второе — сколько нажатому дано считать. Ядро у тетради одно, и
     * второе правило есть единственное, что мешает одному запуску занять его
     * до конца пары — включая очередь попыток консилиума, у которой свой предел
     * есть, а толку от него нет, пока впереди стоит обычная ячейка без предела.
     */
    kind: 'limit',
    key: 'cellLimitSec',
    get title() { return tr('room.rules.cellLimit.title') },
    // Подсказка называет и умолчание («пусто — никогда»), и то, что предел
    // касается преподавательских ячеек тоже: без второго он читается как
    // ограничение для студентов, а это не так.
    get note() { return tr('room.rules.cellLimit.note') },
    get unit() { return tr('room.rules.cellLimit.unit') },
    min: 1,
    max: MAX_CELL_LIMIT_SEC,
  },
  {
    /*
     * Третьей строкой про ядро, сразу за «кто запускает» и «сколько ему дано
     * считать»: все три про одно — ядро у тетради одно на всех. Первая про то,
     * кому можно нажать, вторая про то, когда запуск обрывается, эта — про
     * строки, после которых обрывается не запуск, а занятие.
     */
    kind: 'choice',
    key: 'danger',
    get title() { return tr('room.rules.danger.title') },
    /*
     * Подпись обязана сказать четыре вещи, и каждая из них — ответ на вопрос,
     * с которым сюда приходят: ЧТО именно не исполнится, ПОЧЕМУ (одна строка
     * гасит ядро или стирает переменные всему классу), КОМУ это выключают
     * (курс по самому Python) и ЧЕГО здесь не обещают — это лежачий
     * полицейский, а не песочница, и терминал он не закрывает.
     */
    get note() { return tr('room.rules.danger.note') },
    options: [
      { value: 'block', get label() { return tr('room.rules.danger.block') } },
      { value: 'allow', get label() { return tr('room.rules.danger.allow') } },
    ],
  },
  {
    kind: 'choice',
    key: 'structure',
    get title() { return tr('room.ui.1137') },
    // «Чужую» здесь было неправдой по умолчанию: правило не знает автора, и
    // при «только дописывать» участник не уберёт и свою только что заведённую
    // ячейку тоже. Слова — те же, что комната показывает в отказе (may.ts).
    get note() { return tr('room.ui.1138') },
    options: [EVERYONE, { value: 'add', get label() { return tr('room.ui.1139') } }, TEACHER],
  },
  {
    kind: 'choice',
    key: 'board',
    get title() { return tr('room.ui.1140') },
    get note() { return tr('room.ui.1141') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'files',
    get title() { return tr('room.ui.1142') },
    get note() { return tr('room.ui.1143') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'ownBooks',
    /*
     * Сразу ПОСЛЕ файлов, и это место выбрано: два правила стоят рядом именно
     * затем, чтобы разница между ними читалась с одного взгляда. Строка выше —
     * про общую папку занятия; эта — про собственную тетрадь участника, файл
     * которой пишет сервер проекцией. Их и путают: «я же разрешил файлы».
     */
    get title() { return tr('room.rules.ownBooks.title') },
    // Подсказка называет и умолчание: «по умолчанию выключено» — это половина
    // ответа на вопрос, с которым сюда приходят («а почему у него нельзя?»), и
    // без неё переключатель читается как испорченный.
    get note() { return tr('room.rules.ownBooks.note') },
    options: [
      { value: 'off', get label() { return tr('room.rules.ownBooks.off') } },
      { value: 'on', get label() { return tr('room.rules.ownBooks.on') } },
    ],
  },
  {
    kind: 'choice',
    key: 'agent',
    get title() { return tr('room.ui.1144') },
    get note() { return tr('room.ui.1145') },
    options: [EVERYONE, TEACHER, { value: 'off', get label() { return tr('room.ui.1146') } }],
  },
  /*
   * Два потолка оракула стоят здесь, а не в настройках инстанса, потому что
   * решение про них принимают за минуту до пары: контрольная — это «один
   * вопрос на человека сегодня», а не новая настройка для всех комнат разом.
   * Инстанс при этом остаётся потолком: опуститься под него можно, подняться
   * над ним — нет, за модель платит он.
   */
  {
    kind: 'limit',
    key: 'agentSteps',
    get title() { return tr('common.agentSteps') },
    get note() { return tr('common.agentStepsNote') + ' ' + tr('common.agentStepsRoomNote') },
    get unit() { return tr('common.agentStepsUnit') },
    min: LIMITS.agentSteps.min,
    max: LIMITS.agentSteps.max,
    atInstance: (value) => value === 0 ? tr('common.unlimitedActions') : tr('common.actionCount', { count: value }),
  },
  {
    kind: 'limit',
    key: 'questionsPerHour',
    get title() { return tr('room.ui.1147') },
    get note() { return tr('room.ui.1148') },
    get unit() { return tr('room.ui.1149') },
    /*
     * Пол — один вопрос, а не ноль: «оракула сегодня нет» — это строка выше,
     * и она говорит об этом словами, а ноль здесь развернул бы класс отказом
     * «использовано все 0 вопросов».
     */
    min: 1,
    max: LIMITS.questionsPerHour.max,
    atInstance: (value) => (value === 0 ? tr('room.ui.1150') : tr('room.ui.1151', { p0: value })),
  },
  {
    kind: 'limit',
    key: 'slowModeSeconds',
    get title() { return tr('room.ui.1152') },
    get note() { return tr('room.ui.1153') },
    get unit() { return tr('room.ui.1154') },
    min: LIMITS.slowModeSeconds.min,
    max: LIMITS.slowModeSeconds.max,
    atInstance: (value) => (value === 0 ? tr('room.ui.1155') : tr('room.ui.1156', { p0: value })),
  },
  {
    kind: 'choice',
    key: 'history',
    get title() { return tr('room.ui.1157') },
    get note() { return tr('room.ui.1158') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'restart',
    get title() { return tr('room.ui.1159') },
    get note() { return tr('room.ui.1160') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'wipe',
    get title() { return tr('room.ui.1161') },
    // «Чистит всегда» обещало кнопку, которой не было вовсе. Своя ячейка — это
    // отдельное действие в её тулбаре, и правило у него другое: печатать.
    get note() { return tr('room.ui.1162') },
    options: [EVERYONE, TEACHER],
  },
]
