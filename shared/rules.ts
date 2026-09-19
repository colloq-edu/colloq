/**
 * The rules of one room.
 *
 * A seminar is not always the same shape. A lecture wants a notebook the class
 * can read and nobody can rearrange; a lab wants everyone typing at once; an
 * exam wants the oracle switched off and the notebook read-only. Three presets
 * say those shapes in one word — `OPEN_ROOM`, `LECTURE_ROOM`, `COUNCIL_ROOM` —
 * and the room stays adjustable one row at a time after a preset is applied,
 * because a preset is a set of values here and not a mode kept somewhere else.
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

/*
 * Единственный импорт этого файла — линейка потолков оракула, и она та же, что
 * у настроек инстанса: два числа, которые комната ужесточает, обязаны мериться
 * тем же, чем их мерит инстанс, иначе комната сможет попросить то, чего инстанс
 * не умеет. Обратной стрелки нет: shared/admin.ts берёт отсюда только тип.
 */
import { LIMITS } from './admin.js'

/** Who a rule lets act. `room` is everyone in it, `host` is whoever is teaching. */
export type Who = 'room' | 'host'

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
export type RunWho = 'room' | 'single' | 'host'

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
export type StructureWho = 'room' | 'add' | 'host'

/* --------------------------------------------------- доступ к ОДНОЙ тетради */

/**
 * Кто работает в ОТДЕЛЬНОЙ тетради комнаты.
 *
 * Тетрадей в комнате несколько (shared/notebook.ts · Book), и правила до сих
 * пор были одни на все. Это ломалось на самом частом жесте пары: студент
 * заводит себе копию разбора, чтобы попробовать своё, — а комната лекционная, и
 * в своей же тетради он печатать не может. Обратное так же неверно: открыть
 * `edit: 'room'` ради одного человека значит открыть заодно тетрадь, по которой
 * идёт лекция.
 *
 *   room  — как в комнате. Умолчание для тетрадей, заведённых преподавателем,
 *           включая первую, и ровно сегодняшнее поведение: правила комнаты как
 *           были.
 *   owner — личная: печатают, меняют состав и запускают в ней автор и
 *           преподаватель, остальные смотрят. Своя тетрадь студента получает
 *           это сразу, как только её завели (`ownBooks` ниже).
 *   all   — открыта всем: печатает, меняет состав и запускает любой, что бы ни
 *           говорили правила комнаты.
 *   host  — только преподаватель, при любых правилах комнаты.
 *
 * Перекрываются РОВНО три правила — `run`, `edit`, `structure` — и всё, что от
 * них производно (форматирование, «принять» у оракула, очистка вывода своей
 * ячейки, перестановка, Run All и Run Above в этой тетради). Остальные правила
 * общие для комнаты и тетрадью не трогаются: ядро, терминал, доска, файлы,
 * история и оракул в комнате одни, и говорить про них «в этой тетради» нечего.
 */
export type BookAccess = 'room' | 'owner' | 'all' | 'host'

/**
 * Что комната помнит про одну тетрадь.
 *
 * Ключ карты — КОРЕНЬ тетради в документе, а не путь: путь — это адрес, его
 * переименовывают и освобождают, а корень выдаётся один раз и живёт с тетрадью
 * (shared/notebook.ts · rootForNewBook). Поэтому «личная тетрадь Акима»
 * переживает переименование файла и не достаётся новому файлу с тем же именем.
 *
 * `owner` — participantId того, кто завёл тетрадь, если это был не
 * преподаватель; `ownerName` — его имя НА ТОТ МОМЕНТ. Имя лежит рядом, а не
 * ищется в списке участников: тетрадь переживает семестр, а участника из базы
 * могли и убрать, и тогда «личная тетрадь: —» ничего не объясняет.
 *
 * Запись живёт и при `access: 'room'` — и это не мусор, а то, ради чего она
 * пишется сразу: преподаватель, решивший сделать тетрадь личной, должен иметь в
 * меню имя автора, а не выяснять его задним числом.
 */
export interface BookRule {
  access: BookAccess
  /** participantId автора; `null` — тетрадь завёл преподаватель или автор неизвестен. */
  owner: string | null
  /** Имя автора на момент заведения тетради. */
  ownerName: string | null
}

/**
 * Сколько тетрадей комната помнит и сколько знаков хранит в имени автора.
 *
 * Потолок здесь — последняя сетка, а не рабочая граница: правила едут в каждый
 * сокет комнаты кадром `rules` и лежат строкой в базе, и карта, выросшая от
 * ошибки или от руки в базе, не должна стоить комнате мегабайта на каждом
 * входе. Настоящую границу держит `MAX_OWN_BOOKS` ниже — по человеку, с
 * внятным отказом, а не молча.
 *
 * Пятьсот, а не двести: двести упиралось бы в потоке, где полторы сотни человек
 * завели себе по паре тетрадей, — а упирается это МОЛЧА и в дурную сторону,
 * потому что лишняя запись при чтении просто исчезает, и вместе с ней исчезает
 * чья-то личная тетрадь. Восемьдесят знаков — мерка имени участника.
 *
 * Лишнее не отказывается, а отбрасывается при чтении: правила читаются тотально
 * (см. `readRules`), и упасть на них нельзя.
 */
export const MAX_BOOK_RULES = 500
export const MAX_BOOK_OWNER_NAME = 80

/**
 * Сколько СВОИХ тетрадей студент заводит в одной комнате.
 *
 * Три — это «нынешняя, прошлая и черновик», то есть всё, ради чего своя тетрадь
 * нужна на паре. Потолок нужен потому, что тетрадь стоит дорого и навсегда:
 * корень остаётся в документе комнаты, даже когда файл убрали (см. шапку
 * раздела «тетради» в shared/notebook.ts), и двадцать человек по сорок тетрадей
 * — это снимок, который не уменьшается до конца семестра.
 *
 * Считаются только живые: удалил свою — завёл новую.
 */
export const MAX_OWN_BOOKS = 3
/** Корень тетради — `cells` или `nb:<id>`; длиннее ста двадцати восьми он не бывает. */
const MAX_BOOK_ROOT = 128
const MAX_BOOK_OWNER_ID = 128

/**
 * Фразы, которыми отказывает САМА ТЕТРАДЬ, а не комната.
 *
 * Ключами, а не строками, по тому же доводу, что и `CLASS_IS_OVER`: этот файл
 * не знает про i18n и не должен — его зовёт и гейт на каждый кадр, и браузер.
 * Складывает их с именем автора тот, кто говорит с человеком.
 */
export const BOOK_IS_PERSONAL = 'server.bookIsPersonal'
export const BOOK_IS_THE_TEACHERS = 'server.bookIsTheTeachers'

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
  run: RunWho

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
  edit: Who

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
  structure: StructureWho

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
  board: Who

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
  files: Who

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
  wipe: Who

  /**
   * Кто перезапускает ядро — с потерей всех переменных комнаты.
   *
   * Enforced in server/src/control.ts. Сегодня это зашито в код без права
   * сказать иначе; записать зашитое так, чтобы его можно было ОСЛАБИТЬ, — то,
   * чего просит открытая лаборатория, из которой преподаватель уже ушёл, а
   * ядро зависло.
   */
  restart: Who

  /**
   * Кто читает историю комнаты.
   *
   * Enforced in server/src/routes/history.ts. История — это по сути запись
   * набора: решение, вставленное в ячейку и стёртое до пары, читается в ней
   * потом всегда. Восстановление версии и отметка чекпоинта остаются
   * преподавателю при любом значении.
   */
  history: Who

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
  oracle: 'inherit' | 'off' | 'hints' | 'full'

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
  /** Per-request tool actions: null inherits the server; 0 means unlimited. */
  agentSteps: number | null

  /**
   * Сколько вопросов в час на человека — или null, «как на инстансе».
   *
   * Инстанс задаёт умолчание, комната опускается ниже него и не поднимается
   * выше: `oracleLimitsIn` берёт меньшее из двух. Ужесточить, наоборот, нужно
   * часто и на одну пару — контрольная, где оракул один вопрос на человека, —
   * и ходить ради неё в настройки всего инстанса значит менять их всем
   * остальным комнатам заодно.
   *
   * Enforced in server/src/routes/ai.ts. От этого же числа считается потолок на
   * всю комнату, так что комната, опустившая личный предел, опускает и его.
   */
  questionsPerHour: number | null

  /**
   * Промежуток между вопросами одного человека, в секундах — или null.
   *
   * Строже здесь — это БОЛЬШЕ, поэтому `oracleLimitsIn` берёт большее из двух:
   * потолок в час ловит расход, а промежуток — выкрики подряд, и семинар,
   * которому нужен второй, обычно знает об этом за минуту до начала.
   *
   * Enforced in server/src/routes/ai.ts, и там же, что и на инстансе,
   * преподавателя не касается: его вопросы идут подряд потому, что подряд идёт
   * разбор.
   */
  slowModeSeconds: number | null

  /**
   * A model for this room only, or null to use the instance's.
   *
   * NOT ENFORCED YET, and not drawn either: `routes/ai.ts` never reads it and
   * `web/src/lib/rule-rows.ts` has no row for it, so today the field only
   * survives a round trip through the database. It is kept rather than deleted
   * because a seminar that will ask two hundred questions and one that will ask
   * five do not want the same model, and the teacher knows which is which
   * before the class starts.
   *
   * Мерится тем же `LIMITS.model`, что и модель инстанса. Своя цифра здесь
   * была: имя резалось до 80 знаков против 120 на инстансе, и комната, которой
   * это однажды включат, получила бы молча обрезанное имя модели — то есть
   * запрос в никуда с ошибкой провайдера вместо ответа.
   */
  model: string | null
  /**
   * Что значит «открыть ячейку» в этой комнате.
   *
   * `shared` — как всегда: щелчок по замку открывает общий текст, и в него
   * печатает вся комната. `council` — щелчок открывает консилиум: у каждого
   * свой лист, преподаватель листает попытки и показывает классу. Это и есть
   * вся разница между лекцией и консилиумом как режимами при создании; меню
   * замка на самой ячейке по-прежнему даёт выбрать любое из трёх положений.
   *
   * Читает сервер в control.ts (`cell:open`); правом не является — открывает
   * ячейку в любом случае преподаватель.
   */
  opens: 'shared' | 'council'

  /**
   * Перекрытия по отдельным тетрадям: корень → правило (см. `BookRule`).
   *
   * Поля может не быть вовсе, и у всякой комнаты, созданной до этой строки, его
   * нет: пустая карта и отсутствующая — одно и то же, «все тетради как в
   * комнате». `readRules` пустую карту не хранит, чтобы правила не пухли от
   * записей, которые ничего не значат.
   *
   * Enforced in server/src/collab/gate.ts (набор и состав тетради) и
   * server/src/control.ts (запуск, перестановка, форматирование, очистка
   * вывода, «принять» у оракула), через одну общую `rulesForBook` ниже — ту же,
   * которой считает серые кнопки браузер. Второй копии этого правила в продукте
   * нет намеренно: разошедшиеся копии здесь уже стоили одного бага.
   *
   * Меняет её только преподаватель — тем же путём, что и все остальные правила
   * (PATCH /api/sessions/:id/rules, routes/sessions.ts), где роль и проверяется.
   */
  books?: Record<string, BookRule>

  /**
   * Может ли студент завести в этой комнате СВОЮ тетрадь.
   *
   * Не про доступ к уже существующей тетради (это `books` выше), а про право
   * добавить в комнату ещё одну: завести пустую, внести положенный в папку
   * .ipynb, попросить о том же оракула. Своя тетрадь студента всегда ЛИЧНАЯ —
   * правят и запускают в ней автор и преподаватель, остальные смотрят, — так
   * что это право и есть «можно работать отдельно от аудитории».
   *
   * Умолчание `off`, и это принципиально: права в комнате раздаёт
   * преподаватель. Иначе на лекции, где печатает и запускает он, любой участник
   * выписывал бы себе право печатать и запускать одной кнопкой «новая тетрадь»,
   * а преподаватель узнавал бы об этом задним числом.
   *
   * ОТДЕЛЬНО от `files`, и это не дублирование: `files` — про общую папку
   * занятия, куда кладут раздатку и решения, и он ничего не говорит про
   * участника, которому нужна своя тетрадь. Поэтому `files: 'host'` и
   * `ownBooks: 'on'` — рабочая пара (файл тетради пишет сервер, это её
   * проекция), и обратная пара тоже: положить .ipynb в папку можно, а внести
   * его в комнату тетрадью — нет.
   *
   * Enforced in server/src/collab/books.ts — одной дверью на все способы
   * завести тетрадь, включая оракула.
   */
  ownBooks: 'off' | 'on'
  /**
   * Сколько памяти и процессора получают ВСЕ личные тетради занятия вместе.
   *
   * `null` — «как у занятия»: сегодняшнее поведение и умолчание. Числа
   * относятся к контейнеру, в котором живут личные тетради (pool.ts ·
   * KernelRole), а не к одной тетради: ядер в нём десятки, и делят они его
   * память и процессор, как делят их ячейки одной тетради.
   *
   * Зачем отдельные числа, если по умолчанию они те же. Поле «Память» в
   * настройках занятия преподаватель ставит под СВОЮ работу — под датасет,
   * который он грузит на лекции. Отсыпать столько же тридцати черновикам он не
   * подписывался, а на машине это ровно вдвое больше памяти. И наоборот: на
   * потоке, где вся работа идёт в личных тетрадях, им нужно больше, чем
   * лекции. Одно число на двоих обслуживает только тот случай, когда они
   * случайно совпали.
   *
   * Проверяются здесь по общей мерке (целое, в разумных границах), а по
   * границам МАШИНЫ — там же, где проверяется память самого занятия
   * (routes/sessions.ts, routes/admin-instance.ts): этот файл про права и не
   * знает, сколько памяти у докера.
   *
   * `rulesAfterClass` их не трогает: конец занятия — про то, кому что можно, а
   * не про то, сколько железа отдано.
   */
  ownMemoryMb: number | null
  ownCpus: number | null
}

/**
 * Границы, в которых правила принимают числа личных тетрадей.
 *
 * Потолок здесь — последняя сетка, а не рабочая граница: настоящую ставит
 * машина, и ставит её маршрут (см. поле выше). Смысл этих двух чисел в том,
 * чтобы правила, пришедшие из базы или из чужого кадра, не принесли ни
 * `-1`, ни `1e9`, ни `0.5`.
 */
export const MIN_OWN_MEMORY_MB = 256
export const MAX_OWN_MEMORY_MB = 262144
export const MAX_OWN_CPUS = 64

/**
 * What a room is when nobody has said otherwise: exactly what Colloq has always
 * been. Every existing seminar reads as this, and so does every new one whose
 * teacher never opens the settings.
 */
export const OPEN_ROOM: RoomRules = {
  run: 'room',
  edit: 'room',
  structure: 'room',
  files: 'room',
  /*
   * Три новых поля — и два из них по умолчанию строгие, потому что записывают
   * то, что и так было правдой: `term:clear` и очистка треда оракула уже были
   * правом преподавателя, а перезапуск ядра зашит в код без права сказать
   * иначе. Единственное настоящее изменение — `clearOutputs`, у которого не
   * было проверки вовсе; см. комментарий у `wipe`.
   */
  wipe: 'host',
  restart: 'host',
  board: 'host',
  agent: 'host',
  agentSteps: null,
  history: 'room',
  oracle: 'inherit',
  opens: 'shared',
  /*
   * Свои тетради студентам — выключено: права раздаёт преподаватель, см. поле.
   * `books` здесь нет вовсе, а не пустой картой: пустая карта — это объект, а
   * `isOpenRoom` сравнивает значения, и два пустых объекта не равны никогда.
   */
  ownBooks: 'off',
  // «Как у занятия» — и это тоже сегодняшнее поведение: один лимит на оба
  // контейнера, пока преподаватель не решит иначе.
  ownMemoryMb: null,
  ownCpus: null,
  /*
   * Потолки оракула — «как на инстансе», и это ровно сегодняшнее поведение
   * каждой комнаты: до сих пор их не было где взять, кроме настроек инстанса.
   */
  questionsPerHour: null,
  slowModeSeconds: null,
  model: null,
}

/**
 * Лекция: тетрадь преподавательская целиком — кроме того, что он откроет сам.
 *
 * Пресет, а не новое правило: всё, из чего он собран, уже есть в полях выше, и
 * комната остаётся настраиваемой после того, как его применили. Смысл в том,
 * что «лекция» — это девять согласованных значений, и выставлять их по одному,
 * ничего не забыв, преподаватель перед парой не станет.
 *
 * `history`, `oracle`, потолки оракула и `model` берутся у открытой комнаты:
 * лекция — про то, кто печатает и запускает, а не про то, кому смотреть и
 * спрашивать.
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
  agentSteps: OPEN_ROOM.agentSteps,
  history: OPEN_ROOM.history,
  oracle: OPEN_ROOM.oracle,
  questionsPerHour: OPEN_ROOM.questionsPerHour,
  slowModeSeconds: OPEN_ROOM.slowModeSeconds,
  model: OPEN_ROOM.model,
  opens: 'shared',
  /*
   * Перекрытий по тетрадям пресет не заводит и не снимает: они про конкретные
   * тетради конкретной комнаты, а пресет — про то, кто печатает и запускает
   * вообще. Свои тетради лекция не запрещает отдельно — они и так выключены у
   * открытой комнаты, а включает их преподаватель, когда это нужно.
   */
  ownBooks: OPEN_ROOM.ownBooks,
  // Сколько железа отдано — не про формат занятия: пресет его не трогает.
  ownMemoryMb: OPEN_ROOM.ownMemoryMb,
  ownCpus: OPEN_ROOM.ownCpus,
}

/**
 * Консилиум — третья дверь в комнату, и при создании она стоит рядом с двумя
 * первыми своей карточкой.
 *
 * По правам это та же лекция: печатает, запускает и открывает ячейки
 * преподаватель. Разница ровно в одном — что значит «открыть ячейку». В лекции
 * открытая ячейка — общий текст, в который печатает вся комната; в консилиуме
 * у каждого свой лист, а преподаватель листает попытки и показывает классу
 * (см. `opens`). Пресетом, а не отдельным состоянием комнаты: режим — это набор
 * правил разом, и второго источника правды о том, что можно, здесь не заведено
 * намеренно (routes/admin-instance.ts объясняет почему).
 */
export const COUNCIL_ROOM: RoomRules = {
  ...LECTURE_ROOM,
  opens: 'council',
}

const OPENS = new Set<RoomRules['opens']>(['shared', 'council'])
const WHO = new Set<Who>(['room', 'host'])
const RUN = new Set<RunWho>(['room', 'single', 'host'])
const STRUCTURE = new Set<StructureWho>(['room', 'add', 'host'])
const AGENT = new Set<RoomRules['agent']>(['off', 'host', 'room'])
const ORACLE = new Set<RoomRules['oracle']>(['inherit', 'off', 'hints', 'full'])
const BOOK_ACCESS = new Set<BookAccess>(['room', 'owner', 'all', 'host'])
const OWN_BOOKS = new Set<RoomRules['ownBooks']>(['off', 'on'])

/**
 * Карта перекрытий по тетрадям из чего угодно.
 *
 * Тотально, как и всё остальное в `readRules`, и по той же причине: сюда
 * приезжает и строка из базы, записанная прошлой сборкой, и тело PATCH из
 * браузера. Запись, которую не удалось прочитать, ОТБРАСЫВАЕТСЯ, а не роняет
 * чтение: иначе одна кривая строка закрывала бы комнату целиком.
 *
 * Потолки здесь, а не на входе, потому что вход не один: правила пишет и
 * преподаватель из пульта, и сервер, записывающий автора новой тетради. Обрезка
 * в одном месте — единственный способ обещать, что в базе лежит то, что мы
 * умеем прочитать обратно.
 *
 * `undefined` вместо пустой карты — чтобы правила без единого перекрытия
 * читались ровно так же, как правила комнаты, созданной до этой строки.
 */
function readBookRules(raw: unknown): Record<string, BookRule> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, BookRule> = {}
  let kept = 0
  for (const [root, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_BOOK_RULES) break
    if (!root || root.length > MAX_BOOK_ROOT) continue
    if (!value || typeof value !== 'object') continue
    const from = value as Partial<BookRule>
    if (!BOOK_ACCESS.has(from.access as BookAccess)) continue
    const owner =
      typeof from.owner === 'string' && from.owner ? from.owner.slice(0, MAX_BOOK_OWNER_ID) : null
    const ownerName =
      typeof from.ownerName === 'string' && from.ownerName.trim()
        ? from.ownerName.trim().slice(0, MAX_BOOK_OWNER_NAME)
        : null
    /*
     * «Как в комнате» без автора не значит ничего — такую запись не храним.
     *
     * Так карта сама чистится от того, что преподаватель вернул к умолчанию:
     * снятое перекрытие тетради, которую заводил он сам, исчезает, а не
     * остаётся строкой, которую потом некому убрать.
     */
    if (from.access === 'room' && owner === null) continue
    out[root] = { access: from.access as BookAccess, owner, ownerName }
    kept += 1
  }
  return kept > 0 ? out : undefined
}

/**
 * Read rules off whatever was stored, filling in anything absent.
 *
 * Deliberately total: a row written by an older build, a hand-edited database,
 * a field added after this seminar was created. None of those should be able to
 * open a room with no rules at all, so every unreadable field falls back to the
 * permissive default rather than to an error.
 */
export function readRules(raw: unknown): RoomRules {
  const source = (typeof raw === 'string' ? safeParse(raw) : raw) as Partial<RoomRules> | null
  if (!source || typeof source !== 'object') return { ...OPEN_ROOM }
  const who = (value: unknown, fallback: Who): Who =>
    WHO.has(value as Who) ? (value as Who) : fallback
  const one = <T>(set: Set<T>, value: unknown, fallback: T): T =>
    set.has(value as T) ? (value as T) : fallback
  /*
   * Потолок оракула читается так же тотально, как `model` ниже: не число — это
   * null, «как на инстансе», то есть сегодняшнее поведение любой комнаты. Число
   * зажимается той же линейкой, что и настройка инстанса (shared/admin.ts ·
   * LIMITS): комната, которой разрешили бы больше, чем умеет сам инстанс,
   * обещала бы то, чего нет, — а `oracleLimitsIn` всё равно вернёт инстансовое.
   */
  const cap = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(Math.max(Math.round(value), min), max)
      : null
  const books = readBookRules(source.books)
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
    agentSteps: Number.isInteger(source.agentSteps)
      ? cap(source.agentSteps, LIMITS.agentSteps.min, LIMITS.agentSteps.max) : null,
    history: who(source.history, OPEN_ROOM.history),
    oracle: ORACLE.has(source.oracle as RoomRules['oracle'])
      ? (source.oracle as RoomRules['oracle'])
      : OPEN_ROOM.oracle,
    /*
     * Пол — один вопрос, а не ноль, хотя на инстансе ноль есть. Ноль значит
     * «оракул выключен», и у комнаты для этого уже есть `oracle: 'off'`, у
     * которого отказ говорит об этом словами; ноль здесь развернул бы класс
     * фразой «использовано все 0 вопросов».
     */
    questionsPerHour: cap(source.questionsPerHour, 1, LIMITS.questionsPerHour.max),
    slowModeSeconds: cap(
      source.slowModeSeconds,
      LIMITS.slowModeSeconds.min,
      LIMITS.slowModeSeconds.max,
    ),
    // Тем же потолком, что и модель инстанса: своё число здесь означало бы
    // комнату, которая не может попросить модель, инстансу доступную.
    model:
      typeof source.model === 'string' && source.model.trim()
        ? source.model.trim().slice(0, LIMITS.model)
        : null,
    opens: one(OPENS, source.opens, OPEN_ROOM.opens),
    /*
     * Перекрытия по тетрадям. Ключ в объекте появляется только там, где есть
     * что хранить: старая строка из базы приходит без него и без него же
     * уезжает обратно, а комната с одними умолчаниями не носит по сокетам
     * пустую карту.
     */
    ...(books ? { books } : {}),
    ownBooks: readOwnBooks(source.ownBooks),
    ownMemoryMb: readOwnAmount(source.ownMemoryMb, MIN_OWN_MEMORY_MB, MAX_OWN_MEMORY_MB),
    ownCpus: readOwnAmount(source.ownCpus, 1, MAX_OWN_CPUS),
  }
}

/**
 * Число личных тетрадей — или `null`, то есть «как у занятия».
 *
 * Тотально, как и всё в `readRules`: мусор, дробь и число за границами
 * становятся `null`, а не отказом. Упасть на правилах нельзя — их читает
 * каждый кадр синхронизации, и строка из базы, испорченная чьей-то рукой,
 * не должна запирать комнату.
 */
function readOwnAmount(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  return raw >= min && raw <= max ? raw : null
}

/**
 * «Можно ли свои тетради» — из чего угодно, включая вчерашнюю запись.
 *
 * У поля недолго была другая пара значений: `'room' | 'owner'` — «какой доступ
 * достаётся тетради студента». Значение переехало вместе со смыслом:
 * `'owner'` — это и было «пусть заводит себе личные», то есть нынешнее `'on'`.
 * Всё остальное, включая прежнее `'room'`, читается запретом: умолчание здесь
 * строгое, и ошибиться в его сторону можно, в обратную — нет.
 */
function readOwnBooks(raw: unknown): RoomRules['ownBooks'] {
  if (OWN_BOOKS.has(raw as RoomRules['ownBooks'])) return raw as RoomRules['ownBooks']
  return raw === 'owner' ? 'on' : OPEN_ROOM.ownBooks
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** True when this room is the product's own default — nothing to show, nothing to explain. */
export function isOpenRoom(rules: RoomRules): boolean {
  /*
   * Карту тетрадей приходится спрашивать отдельно, и вот почему. `books` в
   * `OPEN_ROOM` нет вовсе (см. там), так что перебор ключей образца до неё не
   * доходит, — а комната, где одну тетрадь сделали личной, продуктовым
   * умолчанием быть перестала.
   */
  if (rules.books && Object.keys(rules.books).length > 0) return false
  return (Object.keys(OPEN_ROOM) as (keyof RoomRules)[]).every(
    (key) => rules[key] === OPEN_ROOM[key],
  )
}

/**
 * Какое правило говорит «кто здесь печатает и запускает», а какое — про всё
 * остальное.
 *
 * Запись по всем ключам сразу, а не список: правило, добавленное завтра,
 * обязано сломать проверку типов здесь и потребовать решения — тот же довод,
 * что у `LECTURE_ROOM` и `rulesAfterClass`, и единственная копия этой границы.
 */
const IS_A_RIGHT: Record<keyof RoomRules, boolean> = {
  run: true,
  edit: true,
  structure: true,
  board: true,
  files: true,
  wipe: true,
  restart: true,
  agent: true,
  agentSteps: false,
  /* Смотреть и спрашивать — не «кто печатает»: лекция их не трогает. */
  history: false,
  oracle: false,
  questionsPerHour: false,
  slowModeSeconds: false,
  model: false,
  /* Что делает замок — не право: открывает ячейку в любом случае преподаватель. */
  opens: false,
  /*
   * Перекрытия по тетрадям — НЕ право комнаты, и это решение, а не недосмотр.
   *
   * Единственный читатель этого списка — полоса «Лекция» над тетрадью
   * (`isLectureRoom`), и она говорит пятистам людям одно: в КОМНАТЕ печатает и
   * запускает преподаватель. Это остаётся правдой и тогда, когда одному
   * студенту открыли его собственную тетрадь: про неё говорит метка на её
   * вкладке, а снятая полоса оставила бы серую лекционную тетрадь вообще без
   * объяснения — ровно та беда, от которой полоса и заведена.
   *
   * `ownBooks` — правом является, но полосы касаться не должен по тому же
   * доводу: «свои тетради разрешены» ничего не говорит о ТЕТРАДИ КОМНАТЫ, про
   * которую полоса и написана. Конец занятия его всё равно закрывает — см.
   * `rulesAfterClass`, там это сделано значением, а не признаком.
   */
  books: false,
  ownBooks: false,
  /*
   * Не права, а железо: полоса «Лекция» говорит о том, кому что можно, и
   * числа памяти к этому вопросу не относятся — как не относятся потолки
   * оракула выше.
   */
  ownMemoryMb: false,
  ownCpus: false,
}

const RIGHTS = (Object.keys(IS_A_RIGHT) as (keyof RoomRules)[]).filter((key) => IS_A_RIGHT[key])

/**
 * Комната идёт по лекционному пресету — по образцу `isOpenRoom`.
 *
 * Совпадение по значениям, а не флажок в базе: пресет — это набор правил, и
 * комната, собранная теми же значениями руками, ничем от лекции не отличается.
 *
 * Сравниваются ТОЛЬКО права (`IS_A_RIGHT`), потому что полоса «Лекция» над
 * тетрадью (Notebook.svelte) говорит пятистам людям ровно одно: печатает и
 * запускает преподаватель. Сравнивать все ключи — значит гасить её от
 * переключателя, который прав не менял: `opens` (консилиум по правам — та же
 * лекция), выключенный на контрольной оракул, закрытая история, свой потолок
 * вопросов, своя модель. Лекция от этого лекцией быть не перестаёт, а серая
 * тетрадь без полосы остаётся без единого объяснения.
 *
 * Образец, с которым сверяются права, — `rulesAfterClass(rules)`, а не
 * `LECTURE_ROOM`: это та же самая «печатает один преподаватель», написанная
 * один раз. Заодно она правильно читает `agent: 'off'` — выключенный агент
 * строже лекционного, а не мягче, и комнату из лекций не выписывает.
 *
 * Одно следствие стоит знать в лицо: права `rulesAfterClass` — неподвижная
 * точка, так что ЗАКОНЧЕННОЕ занятие читается отсюда как лекция. По сути это
 * правда — печатает и запускает один преподаватель, — но спрашивать этим
 * «занятие идёт по-лекционному» нельзя: для конца пары есть свой признак.
 */
export function isLectureRoom(rules: RoomRules): boolean {
  const lecture = rulesAfterClass(rules)
  return RIGHTS.every((key) => rules[key] === lecture[key])
}

/**
 * Комната консилиума: лекция, где замок открывает каждому свой лист.
 *
 * Не третий пресет рядом с двумя, а уточнение лекции — так же, как сам
 * COUNCIL_ROOM собран из LECTURE_ROOM одной строкой. Спрашивать «лекция ли это»
 * про консилиум можно и нужно; спрашивать «консилиум ли» про лекцию — нет.
 */
export function isCouncilRoom(rules: RoomRules): boolean {
  return isLectureRoom(rules) && rules.opens === 'council'
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
export function allows(rule: Who, role: 'host' | 'participant'): boolean {
  return rule === 'room' || role === 'host'
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
  role: 'host' | 'participant',
  kind: 'one' | 'bulk',
): boolean {
  if (role === 'host') return true
  if (rule === 'host') return false
  return kind === 'one' || rule === 'room'
}

/**
 * Сколько своих ячеек человек держит в очереди одновременно.
 *
 * Не право, а потолок: при `single` очередь у каждого своя длиной в одну
 * ячейку, и нажатие на второй ждёт, а не отвергается молча.
 */
export function runQueueCap(rule: RunWho, role: 'host' | 'participant'): number {
  return rule === 'single' && role !== 'host' ? 1 : Number.POSITIVE_INFINITY
}

/**
 * Можно ли менять состав тетради — и что именно менять.
 *
 * Три глагола, потому что `add` разрешает ровно первый: дописать своё в
 * заготовленный листок можно, убрать и переставить чужое нельзя.
 */
export function allowsStructure(
  rule: StructureWho,
  role: 'host' | 'participant',
  verb: 'add' | 'remove' | 'move',
): boolean {
  if (role === 'host') return true
  if (rule === 'room') return true
  return rule === 'add' && verb === 'add'
}

/**
 * Может ли этот человек запустить оракула в режиме «сделать».
 *
 * Отдельная функция, а не `allows`, потому что у правила три значения: `off`
 * закрывает режим у всех, включая преподавателя, — «в этой комнате оракул
 * файлов не трогает» есть свойство комнаты, а не чьё-то право. Тот же довод,
 * что и у оболочки, когда она была.
 */
export function allowsAgent(rule: RoomRules['agent'], role: 'host' | 'participant'): boolean {
  if (rule === 'off') return false
  return rule === 'room' || role === 'host'
}

/* ----------------------------------------------- правила ОДНОЙ тетради */

/**
 * Кто спрашивает: роль в комнате и своё имя в ней.
 *
 * Имя нужно ровно затем, чтобы узнать автора личной тетради, и потому может
 * быть `null`: место, которое себя не назвало, автором заведомо не является —
 * и отказ получит, а не доступ.
 */
export interface Asker {
  role: 'host' | 'participant'
  /** participantId; `null` — спрашивающий себя не назвал, и автором он быть не может. */
  participantId: string | null
}

/** Что комната помнит про эту тетрадь. `null` — ничего, то есть «как в комнате». */
function bookRuleFor(rules: RoomRules, root: string | null): BookRule | null {
  if (!root || !rules.books) return null
  const rule = rules.books[root]
  return rule && rule.access !== 'room' ? rule : null
}

/**
 * Правила комнаты, ПЕРЕСЧИТАННЫЕ для одной тетради и одного человека.
 *
 * Единственное место, где живёт «доступ к тетради», и обе стороны продукта
 * зовут именно его: сервер — прежде чем принять кадр, переставить ячейку или
 * поставить её в очередь; браузер — прежде чем нарисовать кнопку серой. Дальше
 * и тот и другой работают привычными `mayEditCell`, `allowsStructure` и
 * `mayRunCell`, как будто тетрадь в комнате одна. Второй копии этой развилки в
 * продукте нет намеренно: разошедшиеся копии одного правила здесь уже стоили
 * серой кнопки там, где право было.
 *
 * Меняются `run`, `edit` и `structure` — и, только у СВОЕЙ личной тетради,
 * `restart` с `wipe`. Всё остальное — терминал, доска, файлы, история, оракул,
 * потолки — общее для комнаты, и у него нет измерения «в какой тетради».
 *
 * Про `restart`/`wipe` стоит сказать отдельно, потому что раньше их здесь не
 * было вовсе. У личной тетради своё ядро и свой контейнер
 * (`bookHasOwnKernel`), так что «перезапустить» в ней уносит переменные одного
 * человека — его собственные, — а «стереть выводы» стирает его собственный
 * вывод. Требовать на это преподавателя значило бы поднимать руку посреди
 * лекции, чтобы в своём черновике заново объявить `x`. Тетрадь, открытая ВСЕМ
 * (`all`), сюда не попадает намеренно: у неё ядро комнаты, и перезапуск в ней
 * — это перезапуск занятия.
 *
 * Возвращает ТОТ ЖЕ объект, когда менять нечего: это не экономия, а обещание
 * вызывающим, которые сравнивают правила по ссылке (браузерные `$derived` и
 * кэш правил на сервере), что обычная комната не порождает нового объекта на
 * каждый кадр синхронизации.
 *
 * Преподаватель проходит насквозь: `allows`, `allowsRun` и `allowsStructure` и
 * так пропускают роль `host`, а тетрадь, закрытая «только преподавателю»,
 * закрыта не от него.
 *
 * Конец занятия сюда не доезжает и доехать не может: `rulesAfterClass` карту
 * перекрытий не переносит (см. там), так что действующие правила закончившейся
 * пары приходят сюда без `books` и уходят как пришли.
 */
export function rulesForBook(rules: RoomRules, root: string | null, who: Asker): RoomRules {
  if (who.role === 'host') return rules
  const rule = bookRuleFor(rules, root)
  if (!rule) return rules
  const own = rule.access === 'owner' && ownsBook(rule, who)
  const mine = rule.access === 'all' || own
  /*
   * «Моя» тетрадь открывается целиком, а не «как в комнате»: в этом и смысл —
   * студент работает у себя, пока лекция идёт рядом. `run: 'room'`, а не
   * `single`: «по одной» — это потолок очереди, а не право, и считает его
   * отдельная `runQueueCap` по правилам комнаты.
   *
   * Ядро и вывод своей тетради тоже свои — см. заметку выше.
   */
  if (own) {
    return { ...rules, run: 'room', edit: 'room', structure: 'room', restart: 'room', wipe: 'room' }
  }
  if (mine) return { ...rules, run: 'room', edit: 'room', structure: 'room' }
  return { ...rules, run: 'host', edit: 'host', structure: 'host' }
}

function ownsBook(rule: BookRule, who: Asker): boolean {
  return rule.owner !== null && who.participantId !== null && rule.owner === who.participantId
}

/**
 * Считается ли эта тетрадь в ОТДЕЛЬНОМ контейнере — том, где живут личные
 * тетради занятия.
 *
 * Своё ядро есть у каждой тетради комнаты: лекция и семинар — разные ноутбуки,
 * и переменные одного в другом не появляются (server/src/kernel/index.ts).
 * Этот вопрос про другое — про то, в КАКОМ контейнере ядро поднимать, и ответ
 * у него ровно два: контейнер комнаты или контейнер личных тетрадей.
 *
 * Отдельный контейнер личным тетрадям нужен по двум причинам, и обе про
 * границу, которую внутри одного контейнера провести нечем. GPU выдаётся
 * контейнеру целиком: отнять карту у одного процесса внутри нельзя, а
 * `CUDA_VISIBLE_DEVICES` снимается одной строкой из ячейки. И лимит памяти у
 * контейнера общий: OOM-killer выбирает самый тяжёлый процесс — то есть ядро
 * лекции с загруженным датасетом, а не жадного студента.
 *
 * Одно место на весь продукт намеренно: второй копией сравнения
 * `access === 'owner'` и отличается разошедшееся правило от правила.
 *
 * `all` и `host` сюда не попадают: «открыта всем» — это по-прежнему общая
 * тетрадь занятия (своё ядро у неё есть, контейнер — комнатный), а «только
 * преподаватель» — тем более.
 *
 * Спрашивать это надо по ХРАНИМЫМ правилам (db.ts · storedRules), а не по
 * действующим: `rulesAfterClass` карту `books` не переносит, и звонок не
 * должен переселять ядра из контейнера в контейнер.
 */
export function bookHasOwnKernel(rules: RoomRules, root: string | null): boolean {
  if (!root || !rules.books) return false
  return rules.books[root]?.access === 'owner'
}

/**
 * Чем отказывает ТЕТРАДЬ, а не комната, — и `null`, когда тетрадь ни при чём.
 *
 * Отдельно от `rulesForBook`, потому что это разные вопросы: одна отвечает
 * «можно ли», другая — «что сказать человеку». Сказать надо про тетрадь:
 * услышать «в этом семинаре печатает преподаватель», стоя в чужой личной
 * тетради, — значит пойти искать преподавателя, который ничего не запрещал.
 *
 * Ключ фразы, а не сама фраза, по доводу `CLASS_IS_OVER`: этот файл про права,
 * а не про слова, и зовут его на каждый кадр синхронизации.
 */
export function bookRefusal(
  rules: RoomRules,
  root: string | null,
  who: Asker,
): { key: string; name: string } | null {
  if (who.role === 'host') return null
  const rule = bookRuleFor(rules, root)
  if (!rule) return null
  if (rule.access === 'all') return null
  if (rule.access === 'owner') {
    if (ownsBook(rule, who)) return null
    return { key: BOOK_IS_PERSONAL, name: rule.ownerName ?? '' }
  }
  return { key: BOOK_IS_THE_TEACHERS, name: '' }
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
 * `cellOpen` здесь — строго `isCellOpen(cell)`, то есть положение «открыта
 * всем». Консилиум сюда приходит `false` намеренно: в консилиуме у каждого свой
 * лист, а общий текст ячейки закрыт как в закрытой. Права консилиума — ниже,
 * `mayWriteCouncil`/`mayRunCouncil`/`mayLeadCouncil`.
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
 * посчитать её, а не Run All по чужой тетради. Очередь у тетради одна, и лекция —
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

/* --------------------------------------------------------------- консилиум */

/**
 * Пишет ли этот человек свою попытку в консилиуме.
 *
 * Правила комнаты здесь ни при чём — и это не оговорка, а суть положения:
 * консилиум и открывают там, где `edit` преподавательский, чтобы каждый писал
 * СВОЙ лист, не касаясь общего. Останавливает только конец занятия: после
 * звонка попытки не принимаются, а сданные остаются на просмотр.
 *
 * `closed` — консилиум на этой ячейке уже закрыт (замок переведён в другое
 * положение): текст остаётся у студента черновиком, но на сервер не уезжает.
 */
export function mayWriteCouncil(
  role: 'host' | 'participant',
  finished: boolean,
  closed: boolean,
): boolean {
  return !closed && actsAfterClass(finished, role)
}

/**
 * Запускает ли этот человек попытку в консилиуме.
 *
 * Преподаватель запускает любую попытку, в том числе после занятия.
 * Студент — только свою при studentRun === true. Режим request разрешает
 * запрос одобрения, но сам по себе не даёт права на выполнение.
 */
export function mayRunCouncil(
  role: 'host' | 'participant',
  studentRun: boolean | 'request',
  finished: boolean,
): boolean {
  if (!actsAfterClass(finished, role)) return false
  return role === 'host' || studentRun === true
}

/**
 * Ведёт ли консилиум: показать классу, ответить, отметить, убрать, переключить
 * замок и ручки, спросить оракула о решениях.
 *
 * Только преподаватель, и после звонка тоже он: сданные попытки остаются на
 * просмотр до конца занятия, и разобрать их после пары — его право.
 */
export function mayLeadCouncil(role: 'host' | 'participant'): boolean {
  return role === 'host'
}

/**
 * За кем комната может пойти по документу.
 *
 * Только преподаватель: `leaderFor` (web/src/lib/follow.ts) берёт в ведущие
 * ровно роль `host`, и позиция всех остальных не читается никем.
 *
 * Правило здесь, а не двумя копиями, потому что у него две стороны, и они
 * обязаны совпадать: одна выбирает ведущего из присутствия, другая решает,
 * публиковать ли своё место вообще. Пока публиковали все, один шаг
 * преподавателя на лекции разворачивался в N кадров присутствия от N
 * слушателей и N×N доставок — на пятистах это миллионы сообщений за одну
 * прокрученную страницу.
 */
export function mayBeFollowed(role: 'host' | 'participant'): boolean {
  return role === 'host'
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
  instance: 'off' | 'hints' | 'full',
): 'off' | 'hints' | 'full' {
  const wanted = rules.oracle
  if (wanted === 'inherit') return instance
  if (instance === 'off') return 'off'
  if (instance === 'hints' && wanted === 'full') return 'hints'
  return wanted
}

/** Два потолка оракула: сколько вопросов в час на человека и промежуток между ними. */
export interface OracleLimits {
  questionsPerHour: number
  slowModeSeconds: number
  agentSteps?: number
}

/** A room can tighten a server ceiling; zero represents an unlimited ceiling. */
export function agentStepsIn(room: number | null, instance: number): number {
  if (room === null) return instance
  if (instance === 0) return room
  return room === 0 ? instance : Math.min(room, instance)
}

/**
 * Потолки, под которыми комната работает на самом деле.
 *
 * То же правило, что у `oracleModeIn` выше, и по той же причине: комната
 * ужесточает и никогда не ослабляет. Ослаблять нельзя потому, что за модель
 * платит тот, кто держит инстанс, — его число это его счёт, и семинар, который
 * умел бы поднять себе предел, превращал бы настройку инстанса из потолка в
 * совет. Опуститься, наоборот, полезно: контрольная на одну пару не должна
 * стоить похода в настройки, общие для всех остальных комнат.
 *
 * Строже — в разные стороны, поэтому не один `Math.min` на оба поля: вопросов
 * должно быть МЕНЬШЕ, а промежуток между ними — БОЛЬШЕ.
 *
 * `null` — «как на инстансе»: комната ничего не сказала, и отвечает инстанс.
 */
export function oracleLimitsIn(rules: RoomRules, instance: OracleLimits): OracleLimits {
  return {
    questionsPerHour:
      rules.questionsPerHour === null
        ? instance.questionsPerHour
        : Math.min(instance.questionsPerHour, rules.questionsPerHour),
    slowModeSeconds:
      rules.slowModeSeconds === null
        ? instance.slowModeSeconds
        : Math.max(instance.slowModeSeconds, rules.slowModeSeconds),
  }
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
    run: 'host',
    edit: 'host',
    structure: 'host',
    board: 'host',
    files: 'host',
    wipe: 'host',
    restart: 'host',
    /*
     * `off` — свойство комнаты, а не чьё-то право (см. поле `agent`), и
     * закончившееся занятие его не смягчает.
     */
    agent: rules.agent === 'off' ? 'off' : 'host',
    agentSteps: rules.agentSteps,
    /*
     * Остаются как были. `history` — это чтение, а его-то и надо оставить.
     * `oracle` и `model` описывают не право действовать, а модель и её
     * подробность; у `oracle` вообще нет измерения «кто», поэтому «спросить
     * оракула» закончившееся занятие запрещает отдельной проверкой роли
     * (server/src/routes/ai.ts), а не этим полем.
     */
    history: rules.history,
    oracle: rules.oracle,
    // Что значит «открыть ячейку» — свойство комнаты, а после звонка ячеек не
    // открывают вовсе; поле едет как было, чтобы утро после пары помнило режим.
    opens: rules.opens,
    /*
     * Потолки оракула — оттуда же: они про расход, а не про право. После звонка
     * спрашивает один преподаватель, которого промежуток и так не касается.
     */
    questionsPerHour: rules.questionsPerHour,
    slowModeSeconds: rules.slowModeSeconds,
    model: rules.model,
    /*
     * Перекрытий по тетрадям здесь НЕТ, и это самая важная строка в функции.
     *
     * Конец занятия сильнее всего остального, включая доступ к отдельной
     * тетради: «открыта всем» и «личная» — это разрешения, а после звонка
     * действует один преподаватель. Карта не переносится сюда вовсе, и потому
     * `rulesForBook` поверх этих правил не находит ничего и ничего не
     * открывает. Порядок при этом безразличен — а был бы важен, если бы карта
     * сюда доехала: тогда одна личная тетрадь пережила бы звонок молча.
     *
     * ХРАНИМЫЕ правила при этом целы (`db.ts · storedRules`): занятие
     * открывают обратно, и личная тетрадь возвращается тем же, чем была.
     *
     * Свои тетради после звонка не заводят: это такое же действие, как правка и
     * запуск, и закрывается оно здесь, а не отдельной проверкой в `books.ts` —
     * по тому же доводу, что и всё остальное в этой функции. ХРАНИМЫЙ выбор
     * при этом цел (`db.ts · storedRules`), и занятие, открытое обратно,
     * возвращает его.
     */
    ownBooks: 'off',
    /*
     * Числа личных тетрадей звонок не трогает.
     *
     * Конец занятия — про права: он закрывает двери, а не отбирает железо. К
     * тому же дверь к личным тетрадям он и так закрыл строкой выше, а число
     * пригодится в ту же секунду, когда занятие откроют обратно.
     */
    ownMemoryMb: rules.ownMemoryMb,
    ownCpus: rules.ownCpus,
  }
}

/**
 * Одна фраза на все отказы закончившегося занятия — и на сервере, и в подсказках.
 *
 * Отдельно от правил: человеку важно не то, какое правило его остановило, а то,
 * что занятие кончилось. Услышать вместо этого «в этом семинаре запускает
 * преподаватель» — значит пойти искать преподавателя, который ничего не менял.
 */
export const CLASS_IS_OVER = 'server.classOver'

/**
 * Действует ли этот человек в комнате, где занятие закончено.
 *
 * Для того, что правилами не выражается: спросить оракула, открыть ящик
 * терминала, ответить на `input()`. Действия, у которых правило есть, закрывает
 * `rulesAfterClass`; это — та же граница для всего остального.
 */
export function actsAfterClass(finished: boolean, role: 'host' | 'participant'): boolean {
  return !finished || role === 'host'
}
