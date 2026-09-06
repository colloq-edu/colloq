/**
 * The rules of one room.
 *
 * A seminar is not always the same shape. A lecture wants a notebook the class
 * can read and nobody can rearrange; a lab wants everyone typing at once; an
 * exam wants the oracle switched off and the notebook read-only. Today the product
 * has one shape — everybody can do everything — and the teacher's only recourse
 * is asking the room nicely.
 *
 * Two things this file is careful about.
 *
 * **A rule is a promise, so it has to be kept by the server.** The client uses
 * these to decide what to grey out, but greying out is decoration: the document
 * is a CRDT and the control channel is a socket, and anything not checked on
 * the server is a request away from being ignored. Every rule here says, in its
 * own comment, where it is enforced — and the ones that are not enforced yet
 * say so, because a rule the product cannot keep must not be presented as one.
 *
 * **Defaults are what the product is today.** Every field defaults to the
 * permissive value, so a seminar created before rules existed, or by somebody
 * who never opened the settings, behaves exactly as it always has.
 */

/** Who a rule lets act. `room` is everyone in it, `host` is whoever is teaching. */
export type Who = "room" | "host";

/**
 * Кто запускает — и сколько сразу.
 *
 * `single` — это лаборатория, где считают все, но ядро одно: каждый держит в
 * очереди не больше одной своей ячейки, а Run All и Run Above остаются
 * преподавателю. Без этой середины выбор был между «двадцать человек забивают
 * очередь на сорок ячеек» и «никто, кроме меня».
 *
 * Запускают не только ячейки: тем же правилом закрыты скрипт из дерева
 * (`file:run`) и команда в общей оболочке (`term:run`) — оба по мерке одной
 * ячейки, так что `host` их закрывает, а `single` пускает. Почему у терминала
 * нет своего правила — у поля RoomRules.run ниже.
 */
export type RunWho = "room" | "single" | "host";

/**
 * Кто меняет состав тетради.
 *
 * `add` — заготовленный листок: дописать своё можно, а убирать и переставлять
 * может только преподаватель. Именно так, а не «чужое нельзя»: правило автора
 * не знает, и участник не уберёт даже ту ячейку, которую сам только что завёл.
 * Слова те же, что в панели (web/src/lib/rule-rows.ts) и в отказе. Это самый
 * частый вид семинара, и до сих пор для него не было значения: приходилось
 * выбирать между «правят все» и «структура моя».
 */
export type StructureWho = "room" | "add" | "host";

export interface RoomRules {
  /**
   * Who may run cells.
   *
   * Enforced in server/src/control.ts — mayRun() guards run, runAll and
   * runAbove. The kernel is one process shared by everyone, so this is also the
   * only protection a lecture has against twenty people queueing the same cell.
   *
   * И не только ячейки: этим же правилом закрыты `file:run` — запустить скрипт
   * из дерева — и `term:run` — команда в общей оболочке. Иначе «запускать может
   * преподаватель» было бы не границей, а подсказкой: тот же контейнер, та же
   * папка, только вход другой. Отдельного правила у терминала нет намеренно —
   * ящик открывает не право на него, а право запускать.
   *
   * Одна связка, о которой стоит помнить и которая напечатана в панели:
   * `run: 'host'` без `edit: 'host'` — не граница. Ядро читает исходник ячейки
   * в тот момент, когда до неё доходит очередь, а не когда нажали Run, так что
   * студент, которому запускать нельзя, всё равно пишет тот Python, который
   * выполнит преподавательский Run — в том же контейнере.
   */
  run: RunWho;

  /**
   * Who may change what the cells say — their text, and whether a cell is code
   * or a note.
   *
   * Enforced in server/src/collab/gate.ts, called from collab/index.ts before
   * the update is applied. Обещание здесь такое же, как у `run`: «этого не
   * произошло», а не «произошло и мы отменили». Отменять в CRDT нельзя:
   * откат удаления не воскрешает ячейку, а создаёт новую, и все, у кого старая
   * открыта, печатают в надгробие — без ошибки и без единого события.
   *
   * Сюда же входят две кнопки, которые переписывают ячейки, надев другое лицо:
   * форматирование и «принять» у предложения оракула.
   */
  edit: Who;

  /**
   * Who may add, delete and reorder cells.
   *
   * Enforced in server/src/collab/gate.ts for add and delete, and in
   * control.ts for the move — перестановка уехала на сервер, потому что она
   * пересоздаёт ячейку вместе с выводом, а вывод клиент писать не вправе.
   *
   * Отдельно от `edit`, потому что в семинаре это разные вещи: класс, который
   * заполняет заготовленный листок, но не перекраивает его, — самый частый
   * случай, и у него теперь есть своё значение `add`.
   */
  structure: StructureWho;

  /**
   * Кто может поставить документ на общий экран комнаты.
   *
   * Enforced in server/src/control.ts — `board:open` и `board:close`.
   *
   * Смотреть и листать самому может любой всегда: файл комнаты и так
   * скачивается кем угодно из неё. Правило про другое — про общий экран, и
   * потому стоит рядом с `wipe` и `restart`, а не с `files`.
   *
   * Умолчание `host`, но не гвоздь: семинар, где студенты по очереди
   * показывают свои материалы, — не выдумка, а гвоздь закрыл бы его навсегда.
   */
  board: Who;

  /**
   * Who may put files into the room's folder.
   *
   * Enforced in server/src/routes/files.ts. Забрать файл — уже право
   * преподавателя, и было им раньше.
   *
   * Сильно ровно настолько, насколько разрешает `run`: контейнер ядра
   * монтирует ту же папку, так что `os.listdir()` — это список,
   * `open(...)` — скачивание, а `os.remove(...)` — удаление. Это про порядок в
   * папке, а не про тайну, и в панели так и написано.
   */
  files: Who;

  /**
   * Кто стирает общую работу: все выводы в тетради, ленту терминала, тред
   * оракула.
   *
   * Enforced in server/src/control.ts (clearOutputs, term:clear) и
   * routes/ai.ts (DELETE /ai/thread).
   *
   * Три стирания, у которых до сих пор было три разных ответа. Два из них уже
   * были правом преподавателя, а у третьего — `clearOutputs` без имени ячейки —
   * не было никакой проверки: любой участник сносил результаты, которые класс
   * только что посчитал, и вернуть их нельзя ничем, кроме преподавательского
   * восстановления версии: вывод пишет ядро, и клиентская отмена до него не
   * достаёт. Значение по умолчанию `host` — это починка, а не новое
   * ограничение.
   */
  wipe: Who;

  /**
   * Кто перезапускает ядро — с потерей всех переменных комнаты.
   *
   * Enforced in server/src/control.ts. Сегодня это зашито в код без права
   * сказать иначе; записать зашитое так, чтобы его можно было ОСЛАБИТЬ, — то,
   * чего просит открытая лаборатория, из которой преподаватель уже ушёл, а
   * ядро зависло.
   */
  restart: Who;

  /**
   * Кто читает историю комнаты.
   *
   * Enforced in server/src/routes/history.ts. История — это по сути запись
   * набора: решение, вставленное в ячейку и стёртое до пары, читается в ней
   * потом всегда. Восстановление версии и отметка чекпоинта остаются
   * преподавателю при любом значении.
   */
  history: Who;

  /**
   * Whether the room's oracle answers at all, and how much it gives away.
   *
   * `inherit` means the instance decides, which is what every seminar does
   * today. The other three override it for this room only — one class is an
   * exercise and the next is a demonstration, and they should not have to share
   * a setting.
   *
   * Enforced in server/src/routes/ai.ts — oracleModeFor(). A room may tighten
   * and may not loosen: an instance that is off cannot be talked back on here,
   * because that decision belongs to whoever pays for the model.
   */
  oracle: "inherit" | "off" | "hints" | "full";

  /**
   * Кто может дать оракулу писать в файлы семинара — «сделать», а не «спросить».
   *
   * Enforced in server/src/routes/ai.ts.
   *
   * Отдельно от `oracle`, потому что это другой вопрос. `oracle` — сколько
   * подсказывать; `agent` — можно ли ему брать в руки папку комнаты. Режим
   * «сделать» правит файлы сам, без нажатия «принять» на каждую правку: иначе
   * он не может посмотреть на свою же ошибку и починить её, а без этого он не
   * агент, а тот же ответ в другой обёртке. Плата — правки видны всем сразу; в
   * обмен весь ход отменяется одной кнопкой.
   *
   * Умолчание `host`, а не `room`, и это единственное новое ограничение: в
   * лаборатории на двадцать человек двадцать одновременных «сделать» в одной
   * папке — это не помощь, а перезапись друг друга. Комната, где это уместно,
   * включается одним переключателем.
   *
   * Тетрадь это правило не открывает и не закрывает: она правится по правам
   * ТОГО, КТО ПОПРОСИЛ ход, — теми же `edit` и `structure`, с тем же замком на
   * ячейке (`mayEditCell`), как если бы он печатал сам. Оракул здесь руки
   * человека, а не отдельное лицо: правка идёт в документ комнаты от его
   * имени, и у версии в истории есть автор. Участник в лекции ячеек не
   * трогает, даже когда `agent` пускает его в режим «сделать».
   *
   * Плата названа отдельно, потому что без неё этого давать нельзя: перед
   * первой правкой ячейки ход отмечает историю версий («до правки оракула»),
   * и одна кнопка возвращает тетрадь как была. Вывод ячейки при этом не
   * стирается — он честно устаревает, ровно как от правки рукой.
   *
   * Enforced in server/src/ai/agent.ts.
   */
  agent: 'off' | 'host' | 'room'

  /**
   * A model for this room only, or null to use the instance's.
   *
   * NOT ENFORCED YET. Worth having because a seminar that will ask two hundred
   * questions and one that will ask five do not want the same model, and the
   * teacher knows which is which before the class starts.
   */
  model: string | null;
}

/**
 * What a room is when nobody has said otherwise: exactly what Colloq has always
 * been. Every existing seminar reads as this, and so does every new one whose
 * teacher never opens the settings.
 */
export const OPEN_ROOM: RoomRules = {
  run: "room",
  edit: "room",
  structure: "room",
  files: "room",
  /*
   * Три новых поля — и два из них по умолчанию строгие, потому что записывают
   * то, что и так было правдой: `term:clear` и очистка треда оракула уже были
   * правом преподавателя, а перезапуск ядра зашит в код без права сказать
   * иначе. Единственное настоящее изменение — `clearOutputs`, у которого не
   * было проверки вовсе; см. комментарий у `wipe`.
   */
  wipe: "host",
  restart: "host",
  board: "host",
  agent: "host",
  history: "room",
  oracle: "inherit",
  model: null,
};

/**
 * Лекция: тетрадь преподавательская целиком — кроме того, что он откроет сам.
 *
 * Пресет, а не новое правило: всё, из чего он собран, уже есть в полях выше, и
 * комната остаётся настраиваемой после того, как его применили. Смысл в том,
 * что «лекция» — это девять согласованных значений, и выставлять их по одному,
 * ничего не забыв, преподаватель перед парой не станет.
 *
 * `history`, `oracle` и `model` берутся у открытой комнаты: лекция — про то,
 * кто печатает и запускает, а не про то, кому смотреть и спрашивать.
 *
 * Одна лекция без замка на ячейках была бы просто тетрадью на экране. Работает
 * это в паре: преподаватель открывает отдельные ячейки, и в них комната
 * печатает и запускает при этих самых правилах — см. `mayEditCell` ниже.
 *
 * Поля перечислены все до одного и без `...OPEN_ROOM`, по тому же доводу, что и
 * в `rulesAfterClass`: правило, добавленное завтра, обязано сломать проверку
 * типов здесь и потребовать решения, а не проехать молча.
 */
export const LECTURE_ROOM: RoomRules = {
  run: 'host',
  edit: 'host',
  structure: 'host',
  board: 'host',
  files: 'host',
  wipe: 'host',
  restart: 'host',
  agent: 'host',
  history: OPEN_ROOM.history,
  oracle: OPEN_ROOM.oracle,
  model: OPEN_ROOM.model,
}

const WHO = new Set<Who>(["room", "host"]);
const RUN = new Set<RunWho>(["room", "single", "host"]);
const STRUCTURE = new Set<StructureWho>(["room", "add", "host"]);
const AGENT = new Set<RoomRules["agent"]>(["off", "host", "room"]);
const ORACLE = new Set<RoomRules["oracle"]>([
  "inherit",
  "off",
  "hints",
  "full",
]);

/**
 * Read rules off whatever was stored, filling in anything absent.
 *
 * Deliberately total: a row written by an older build, a hand-edited database,
 * a field added after this seminar was created. None of those should be able to
 * open a room with no rules at all, so every unreadable field falls back to the
 * permissive default rather than to an error.
 */
export function readRules(raw: unknown): RoomRules {
  const source = (
    typeof raw === "string" ? safeParse(raw) : raw
  ) as Partial<RoomRules> | null;
  if (!source || typeof source !== "object") return { ...OPEN_ROOM };
  const who = (value: unknown, fallback: Who): Who =>
    WHO.has(value as Who) ? (value as Who) : fallback;
  const one = <T>(set: Set<T>, value: unknown, fallback: T): T =>
    set.has(value as T) ? (value as T) : fallback;
  return {
    /*
     * Каждое поле падает на своё умолчание отдельно от других — это и есть
     * миграция. Строка, записанная старой сборкой, держит 'room' или 'host' в
     * трёх полях, у которых теперь по три значения: оба переживают чтение
     * нетронутыми, а третьего значения там просто нет. Новые три поля в старых
     * строках отсутствуют вовсе и читаются своими умолчаниями.
     */
    run: one(RUN, source.run, OPEN_ROOM.run),
    edit: who(source.edit, OPEN_ROOM.edit),
    structure: one(STRUCTURE, source.structure, OPEN_ROOM.structure),
    files: who(source.files, OPEN_ROOM.files),
    wipe: who(source.wipe, OPEN_ROOM.wipe),
    restart: who(source.restart, OPEN_ROOM.restart),
    board: who(source.board, OPEN_ROOM.board),
    agent: one(AGENT, source.agent, OPEN_ROOM.agent),
    history: who(source.history, OPEN_ROOM.history),
    oracle: ORACLE.has(source.oracle as RoomRules["oracle"])
      ? (source.oracle as RoomRules["oracle"])
      : OPEN_ROOM.oracle,
    model:
      typeof source.model === "string" && source.model.trim()
        ? source.model.trim().slice(0, 80)
        : null,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when this room is the product's own default — nothing to show, nothing to explain. */
export function isOpenRoom(rules: RoomRules): boolean {
  return (Object.keys(OPEN_ROOM) as (keyof RoomRules)[]).every(
    (key) => rules[key] === OPEN_ROOM[key],
  );
}

/**
 * Комната идёт по лекционному пресету — по образцу `isOpenRoom`.
 *
 * Совпадение по значениям, а не флажок в базе: пресет — это набор правил, и
 * комната, собранная теми же значениями руками, ничем от лекции не отличается.
 *
 * Одно следствие стоит знать в лицо: `rulesAfterClass` любой комнаты даёт ровно
 * эти значения, так что ЗАКОНЧЕННОЕ занятие читается отсюда как лекция. По сути
 * это правда — печатает и запускает один преподаватель, — но спрашивать этим
 * «занятие идёт по-лекционному» нельзя: для конца пары есть свой признак.
 */
export function isLectureRoom(rules: RoomRules): boolean {
  return (Object.keys(LECTURE_ROOM) as (keyof RoomRules)[]).every(
    (key) => rules[key] === LECTURE_ROOM[key],
  )
}

/**
 * May somebody with this role do the thing this rule governs?
 *
 * A function rather than a comparison written out at each call site, because
 * the host exception is the part that is easy to forget: a rule set to `host`
 * has to keep letting the host through, and a rule set to `room` has to let
 * everybody through including the host. Written twice, the second copy is where
 * the bug goes.
 */
export function allows(rule: Who, role: "host" | "participant"): boolean {
  return rule === "room" || role === "host";
}

/**
 * Можно ли запускать — и одну ячейку или весь лист.
 *
 * `single` разрешает нажатие на ячейке и запрещает Run All и Run Above: ядро
 * одно, и разница между «двадцать человек считают» и «двадцать человек забили
 * очередь на восемьсот ячеек» — ровно в этом.
 */
export function allowsRun(
  rule: RunWho,
  role: "host" | "participant",
  kind: "one" | "bulk",
): boolean {
  if (role === "host") return true;
  if (rule === "host") return false;
  return kind === "one" || rule === "room";
}

/**
 * Сколько своих ячеек человек держит в очереди одновременно.
 *
 * Не право, а потолок: при `single` очередь у каждого своя длиной в одну
 * ячейку, и нажатие на второй ждёт, а не отвергается молча.
 */
export function runQueueCap(
  rule: RunWho,
  role: "host" | "participant",
): number {
  return rule === "single" && role !== "host" ? 1 : Number.POSITIVE_INFINITY;
}

/**
 * Можно ли менять состав тетради — и что именно менять.
 *
 * Три глагола, потому что `add` разрешает ровно первый: дописать своё в
 * заготовленный листок можно, убрать и переставить чужое нельзя.
 */
export function allowsStructure(
  rule: StructureWho,
  role: "host" | "participant",
  verb: "add" | "remove" | "move",
): boolean {
  if (role === "host") return true;
  if (rule === "room") return true;
  return rule === "add" && verb === "add";
}

/**
 * Может ли этот человек запустить оракула в режиме «сделать».
 *
 * Отдельная функция, а не `allows`, потому что у правила три значения: `off`
 * закрывает режим у всех, включая преподавателя, — «в этой комнате оракул
 * файлов не трогает» есть свойство комнаты, а не чьё-то право. Тот же довод,
 * что и у оболочки, когда она была.
 */
export function allowsAgent(
  rule: RoomRules["agent"],
  role: "host" | "participant",
): boolean {
  if (rule === "off") return false;
  return rule === "room" || role === "host";
}

/**
 * Замок на ячейке: можно ли ЭТОМУ человеку писать в ЭТУ ячейку.
 *
 * Лекция закрывает тетрадь целиком, и тогда единственный способ дать классу
 * что-то напечатать — открыть ему отдельную ячейку. Открытая ячейка — право
 * поверх правил: `edit: 'host'` остаётся в силе для всей остальной тетради, и
 * ослабляет его не настройка комнаты, а преподаватель, вручную и на время.
 *
 * Функция, а не проверка на месте, ровно по доводу `allows`: отвечать на этот
 * вопрос обязаны одинаково сервер (collab/gate.ts) и браузер (web/src/lib/may.ts).
 * Разойдясь, они дают либо кнопку, которая нажимается и приносит отказ, либо —
 * что хуже — серую кнопку там, где право есть.
 *
 * Открытая ячейка даёт РОВНО текст. Ни убрать её, ни переставить, ни сменить ей
 * вид она не позволяет: состав тетради в лекции преподавательский, и ячейка,
 * открытая для работы, не должна открывать способ её же удалить.
 *
 * Конец занятия сильнее замка, поэтому `actsAfterClass` стоит первым
 * множителем: иначе «Закончить занятие» оставляло бы комнате столько дверей,
 * сколько преподаватель успел открыть за пару, — и закрывать их пришлось бы по
 * одной, вспоминая, какие открывал.
 */
export function mayEditCell(
  rules: RoomRules,
  role: 'host' | 'participant',
  cellOpen: boolean,
  finished: boolean,
): boolean {
  return actsAfterClass(finished, role) && (allows(rules.edit, role) || cellOpen)
}

/**
 * То же для запуска — и по мерке ОДНОЙ ячейки.
 *
 * `allowsRun(..., 'one')`, а не `'bulk'`: открытая ячейка — это разрешение
 * посчитать её, а не Run All по чужой тетради. Ядро в комнате одно, и лекция —
 * последнее место, где двадцать человек ставят в очередь весь лист.
 */
export function mayRunCell(
  rules: RoomRules,
  role: 'host' | 'participant',
  cellOpen: boolean,
  finished: boolean,
): boolean {
  return actsAfterClass(finished, role) && (allowsRun(rules.run, role, 'one') || cellOpen)
}

/**
 * The oracle mode a room actually runs under.
 *
 * Two settings meet here: what the instance allows and what the seminar asked
 * for. A room may tighten and may never loosen — an instance that is off
 * cannot be talked back on, because that decision belongs to whoever pays for
 * the model.
 *
 * Exported from shared because the server enforces it and the panel draws
 * from it, and those two were computing different answers: the panel asked
 * `/api/ai/status`, which knows nothing about a seminar, so a room set to
 * hints still showed Explain, Fix and Debug — and every press came back 403.
 */
export function oracleModeIn(
  rules: RoomRules,
  instance: "off" | "hints" | "full",
): "off" | "hints" | "full" {
  const wanted = rules.oracle;
  if (wanted === "inherit") return instance;
  if (instance === "off") return "off";
  if (instance === "hints" && wanted === "full") return "hints";
  return wanted;
}

/**
 * Занятие закончено.
 *
 * Не значение правила, а состояние комнаты поверх правил: преподаватель нажал
 * «Закончить занятие», и с этой минуты участник читает и смотрит, а действует
 * один преподаватель. Комната при этом остаётся живой — тетрадь, файлы, лента
 * терминала и ответы оракула на месте, — потому что после пары в них и ходят.
 *
 * Хранимые правила не трогаются: закончить занятие и открыть его снова можно
 * сколько угодно раз, и комната каждый раз возвращается ровно в ту настройку,
 * из которой её закончили. Поэтому здесь функция, а не запись в базу.
 *
 * Поля перечислены все до одного и без `...rules` намеренно: правило,
 * добавленное завтра, обязано сломать проверку типов здесь и потребовать
 * решения, а не проехать молча открытым.
 */
export function rulesAfterClass(rules: RoomRules): RoomRules {
  return {
    run: "host",
    edit: "host",
    structure: "host",
    board: "host",
    files: "host",
    wipe: "host",
    restart: "host",
    /*
     * `off` — свойство комнаты, а не чьё-то право (см. поле `agent`), и
     * закончившееся занятие его не смягчает.
     */
    agent: rules.agent === "off" ? "off" : "host",
    /*
     * Остаются как были. `history` — это чтение, а его-то и надо оставить.
     * `oracle` и `model` описывают не право действовать, а модель и её
     * подробность; у `oracle` вообще нет измерения «кто», поэтому «спросить
     * оракула» закончившееся занятие запрещает отдельной проверкой роли
     * (server/src/routes/ai.ts), а не этим полем.
     */
    history: rules.history,
    oracle: rules.oracle,
    model: rules.model,
  };
}

/**
 * Одна фраза на все отказы закончившегося занятия — и на сервере, и в подсказках.
 *
 * Отдельно от правил: человеку важно не то, какое правило его остановило, а то,
 * что занятие кончилось. Услышать вместо этого «в этом семинаре запускает
 * преподаватель» — значит пойти искать преподавателя, который ничего не менял.
 */
export const CLASS_IS_OVER = "Занятие закончено — здесь теперь только читают";

/**
 * Действует ли этот человек в комнате, где занятие закончено.
 *
 * Для того, что правилами не выражается: спросить оракула, открыть ящик
 * терминала, ответить на `input()`. Действия, у которых правило есть, закрывает
 * `rulesAfterClass`; это — та же граница для всего остального.
 */
export function actsAfterClass(
  finished: boolean,
  role: "host" | "participant",
): boolean {
  return !finished || role === "host";
}
