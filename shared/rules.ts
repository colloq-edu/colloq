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
 * Кто запускает ячейки — и сколько сразу.
 *
 * `single` — это лаборатория, где считают все, но ядро одно: каждый держит в
 * очереди не больше одной своей ячейки, а Run All и Run Above остаются
 * преподавателю. Без этой середины выбор был между «двадцать человек забивают
 * очередь на сорок ячеек» и «никто, кроме меня».
 */
export type RunWho = "room" | "single" | "host";

/**
 * Кто меняет состав тетради.
 *
 * `add` — заготовленный листок: дописать своё можно, убрать и переставить
 * чужое нельзя. Это самый частый вид семинара, и до сих пор для него не было
 * значения: приходилось выбирать между «правят все» и «структура моя».
 */
export type StructureWho = "room" | "add" | "host";

/**
 * Оболочка комнаты.
 *
 * `off` закрывает ящик у всех, включая преподавателя: «в этой комнате
 * терминала нет» — свойство комнаты, а не чьё-то право. Что это закрывает
 * именно ящик, а не оболочку, сказано в панели вслух: `!pip install` в ячейке
 * идёт в тот же контейнер.
 */

export interface RoomRules {
  /**
   * Who may run cells.
   *
   * Enforced in server/src/control.ts — mayRun() guards run, runAll and
   * runAbove. The kernel is one process shared by everyone, so this is also the
   * only protection a lecture has against twenty people queueing the same cell.
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
  history: "room",
  oracle: "inherit",
  model: null,
};

const WHO = new Set<Who>(["room", "host"]);
const RUN = new Set<RunWho>(["room", "single", "host"]);
const STRUCTURE = new Set<StructureWho>(["room", "add", "host"]);
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
