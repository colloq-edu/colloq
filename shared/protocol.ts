import type { RoomRules } from './rules.js'

/**
 * Wire contracts between browser and server: the control WebSocket, the REST
 * surface, and the AI streaming endpoint.
 *
 * Notebook *content* never travels through here — that is Yjs's job. This
 * channel carries intent ("run this cell") and side-band state (kernel health,
 * file listing) only.
 */
import type {
  CellLock,
  CellOutput,
  CellSnapshot,
  CellState,
  CouncilSettings,
  KernelStatus,
} from './notebook'
export type { CellLock, CouncilSettings } from './notebook'
import type { InkStroke, LectureState } from './lecture'

export type ParticipantRole = 'host' | 'participant'

export interface Participant {
  id: string
  name: string
  avatar: string | null
  color: string
  role: ParticipantRole
}

export interface SessionInfo {
  id: string
  name: string
  createdAt: number
  /**
   * What this room lets people do.
   *
   * Sent to every client so the interface can be honest about itself: a Run
   * button that a student may not press should look unpressable rather than
   * fail when pressed. The server enforces the same rules independently — this
   * copy decides what is drawn, never what is allowed.
   */
  rules: RoomRules
  /**
   * Когда преподаватель закончил занятие — или null, пока оно идёт.
   *
   * Комната от этого не закрывается и не исчезает: тетрадь, файлы, лента
   * терминала и ответы оракула остаются открытыми на чтение, потому что после
   * пары в них и ходят. Закрываются действия — всё, что меняет комнату или
   * будит ядро, остаётся преподавателю (shared/rules.ts · rulesAfterClass).
   *
   * Время, а не флаг: «закончено в 15:40» — это то, что показывают комната и
   * панель, а флагу пришлось бы дописывать вторым полем то же самое.
   */
  finishedAt: number | null
  /**
   * Опубликованная страница этого семинара и курс, в котором он состоит.
   *
   * Нужно экрану входа, и это чинит единственный адрес, который у студента
   * действительно есть. Ссылка в чате — `/s/`; без этой подсказки студент
   * через неделю вводит имя в закончившееся занятие, заводит ещё одну строку
   * участника, будит ядро и оказывается один в живой тетради, где ничто не
   * говорит, что есть опубликованная версия.
   */
  published: { id: string; steps: number } | null
  course: { id: string; name: string } | null
  /**
   * Организация, развернувшая инстанс, — строка рядом с логотипом.
   *
   * Свойство ИНСТАНСА, а не семинара: она одна на все комнаты сразу и меняется
   * только правкой `INSTITUTION` в окружении. В контракте семинара она живёт
   * ровно потому, что этот контракт и так приезжает на каждый экран, где
   * рисуется логотип, — комнату, проекцию, пульт и экран входа. Отдельный
   * запрос за одной строкой стоил бы либо лишнего круга до сервера на первом
   * кадре, либо линейки, всплывающей под уже нарисованным словом.
   *
   * Пусто — и строки нет вовсе; это умолчание. Продукт разворачивают разные
   * организации, и ничьё имя здесь не зашито.
   */
  institution: string
}

export interface FileEntry {
  /** Имя без папок — то, что видно в строке дерева. */
  name: string
  /**
   * Путь от корня папки семинара: `src/model.py`.
   *
   * Отдельно от `name`, а не вместо него, и это выбор в пользу тех, кто уже
   * написан: у файла в корне `path === name`, так что всё, что читало `name`
   * до появления папок, читает его и дальше и видит ровно то же самое. Адресуют
   * файл — по `path`; показывают — `name`.
   */
  path: string
  /** Папка. У неё `size` нулевой и смысла не имеет. */
  dir: boolean
  size: number
  modifiedAt: number
}

/* ------------------------------------------------------------------ REST */

export interface CreateSessionRequest {
  name: string
}

export interface CreateSessionResponse {
  session: SessionInfo
  /** Signed host credential; the browser keeps it in localStorage. */
  hostToken: string
}

/**
 * Ключ, которым преподаватель отдаёт свой пульт планшету.
 *
 * Не токен: по нему нельзя ни открыть сокет, ни скачать файл — только один раз
 * обменять его на обычный вход, и только пока он жив. Срок приезжает вместе с
 * ключом, чтобы экран мог сказать «ссылка живёт десять минут» и не врать, если
 * срок однажды поменяется.
 */
export interface HandoffResponse {
  key: string
  livesMs: number
  /**
   * Адрес, по которому комнату видно снаружи, — `PUBLIC_URL` инстанса.
   *
   * Ссылку на пульт строили от `location.origin`, а комнату преподаватель чаще
   * всего открывает на `http://localhost:3000`: такая ссылка на планшете не
   * откроется вовсе, хотя семинар выставлен наружу. Выбирает из двух адресов
   * по-прежнему клиент (то же правило, что в панели, — seminar-link.ts), но
   * настройку в комнате взять больше неоткуда.
   */
  origin: string
}

export interface JoinRequest {
  name: string
  avatar?: string | null
  /** Sent on a repeat visit so the same person keeps their identity. */
  participantId?: string | null
  /**
   * The token minted for that participant, proving the claim above.
   *
   * Every participant id in a room is broadcast to the room — awareness carries
   * it so a caret can be attributed to a face — so "I am p_xyz" is a sentence
   * any student can say about anybody. Only the browser that joined as them has
   * the token, so that is what the claim is checked against.
   */
  token?: string | null
  /** Proves "I created this seminar" across a page refresh. */
  hostToken?: string | null
}

export interface JoinResponse {
  session: SessionInfo
  participant: Participant
  /** Signed credential for the control socket and AI endpoint. */
  token: string
}

/**
 * Бан: кого преподаватель закрыл из комнаты и до какого времени.
 *
 * То, что видит преподаватель в списке, — и ничего сверх того. Ни
 * идентификатора участника, ни метки устройства, ни адреса: по этим полям бан
 * проверяется, но в списке они не нужны, а метка браузера — единственное в
 * комнате, чего про человека не знает никто, включая его самого.
 *
 * `until` — момент конца, а не «сколько осталось»: часы рисует тот, кто
 * смотрит. Сервер в контейнере живёт по UTC, и собранная им строка «до 15:40»
 * в аудитории UTC+3 указывала бы не на то время.
 */
export interface Ban {
  id: string
  /** Имя, под которым человека забанили: комната могла его уже забыть. */
  name: string
  until: number
  createdAt: number
  /** Кто забанил — или null, если банил ведущий без учётной записи штата. */
  byTeacher: string | null
  /**
   * Это ваше собственное устройство.
   *
   * Промахнуться легко: список участников — это имена, а не лица, и
   * преподаватель, забанивший себя, иначе увидел бы обычную строку и не понял,
   * почему комната перестала пускать его вторую вкладку.
   */
  mine: boolean
}

/* -------------------------------------------------------- control socket */

export type ControlClientMessage =
  | { t: 'run'; cellId: string }
  /**
   * Take a cell out of the run queue. Not the same as interrupting: the cell
   * that is *running* is Interrupt's business, and cancelling never reaches it.
   * A student who pressed Run All behind somebody else's forty-second cell
   * otherwise had nothing to press — Interrupt belongs to the person whose cell
   * holds the kernel, and the queue was a one-way door.
   */
  | { t: 'cancel'; cellId: string }
  | { t: 'term:open' }
  | { t: 'term:run'; command: string }
  | { t: 'term:interrupt' }
  | { t: 'term:clear' }
  | { t: 'term:close' }
  /**
   * Весь лист — и `book` называет, ЧЕЙ лист.
   *
   * Тетрадей в комнате несколько, и «запустить всё» в одной не означает
   * «запустить всё в комнате»: ядро общее, а листы разные. Отсутствие поля —
   * тетрадь комнаты, то есть первая: так читаются сообщения вкладок, открытых
   * до появления нескольких тетрадей.
   */
  | { t: 'runAll'; book?: string }
  | { t: 'runAbove'; cellId: string; book?: string }
  /**
   * Остановить выполнение.
   *
   * `cellId` — та ячейка, ради которой нарисовали кнопку. Кнопка на самой
   * ячейке его называет, комнатная в верхней панели нет, и разница
   * существенная: нажатие, промахнувшееся мимо своей ячейки, всё равно
   * останавливает то, что считается — ядро одно, — но чужую очередь не
   * разбирает: пачка снимается только та, из которой названная ячейка. А
   * безымянное нажатие остаётся единственным способом разобрать скопившуюся
   * очередь, когда не выполняется ничего. Право проверяется по среде
   * исполнения на сервере; имя цели ничего не разрешает.
   */
  | { t: 'interrupt'; cellId?: string }
  | { t: 'restart' }
  | { t: 'clearOutputs'; cellId?: string; book?: string }
  /**
   * Put every code cell through black. A cell the formatter refuses — a magic,
   * a shell line, a line somebody is still typing — is left exactly as it was,
   * and the rest are still formatted.
   */
  | { t: 'format'; book?: string }
  /**
   * Ответ ячейке, остановившейся внутри `input()`.
   *
   * Отвечает тот, чья ячейка спрашивает, — или преподаватель. Приглашение живёт
   * в документе, потому что его должна видеть комната; видеть и отвечать — не
   * одно и то же, а `input()` под паролем тем более.
   *
   * `cellId` называет ту ячейку, которой форма была нарисована. Без него ответ
   * уходил тому, на чём ядро оказалось заблокировано в этот момент: ячейка
   * сменилась между отрисовкой и нажатием Enter — и набранный пароль ушёл в
   * чужую.
   */
  | { t: 'input'; value: string; cellId?: string }
  /**
   * Решение по предложению оракула — принять или отклонить.
   *
   * Через сервер, а не в своём документе. Проверка «предложение ещё открыто»
   * внутри транзакции спасает от двух нажатий в одной вкладке и не спасает от
   * двух браузеров: каждый читает в своей копии `'open'`, каждый пишет, и Yjs
   * добросовестно сливает обе правки — ячейка получает патч дважды.
   *
   * У сервера копия одна, и сообщения он разбирает по очереди: второе видит
   * состояние, которое поставило первое, и не делает ничего.
   */
  | { t: 'ai:decide'; entryId: string; accept: boolean }
  /**
   * Отменить ход оракула целиком: вернуть файлы к тому, что было до него.
   *
   * Через сервер, потому что возвращать надо файлы, а не документ: их прежний
   * текст помнит он один. Проходит по тому же правилу, что и сам режим
   * «сделать» — кто мог его запустить, тот может и отменить.
   */
  | { t: 'ai:undo'; entryId: string }
  /**
   * Поменять ячейку местами с соседом.
   *
   * Через сервер, а не в своём документе, и это вынужденно. У Y.Array нет
   * перемещения: одну из двух ячеек приходится пересоздать клоном, а клон несёт
   * её вывод. Переупорядочить тетрадь — не повод выбрасывать вывод, а писать
   * вывод из браузера нельзя ни в какой комнате. Единственная смешанная
   * клиентская транзакция в продукте, и она уезжает на сервер целиком.
   */
  | { t: 'cells:move'; cellId: string; direction: -1 | 1 }
  /**
   * Открыть ячейку комнате — или закрыть её обратно.
   *
   * Замок на ячейке: в лекционной комнате печатает и запускает преподаватель, а
   * открытая ячейка — та одна, где это делает зал. Поэтому поле `open` пишет
   * сервер, а не браузер: клиентская запись в CRDT была бы правом, которого
   * сервер не выдавал, — «мне здесь можно» объявлял бы себе сам тот, у кого
   * спрашивают. Гейт закрывает клиенту серверные ключи ячейки ровно за этим, и
   * этот ключ из их числа.
   */
  | { t: 'cell:open'; cellId: string; open: boolean }
  /**
   * Замок ячейки в одно из трёх положений: закрыта / открыта всем / консилиум.
   *
   * Одно сообщение на все три положения, и `cell:open` над ним — его частный
   * случай на два положения, оставленный ради тех, кто его уже шлёт: сервер
   * читает оба одинаково (control.ts). Только преподаватель, только пока
   * занятие идёт — по тем же доводам, что у `cell:open`.
   *
   * `settings` — ручки консилиума; имеют смысл только при `state: 'council'`.
   * Не приложены — остаются как были, а у ячейки, которая консилиумом ещё не
   * была, ставятся умолчания (notebook.ts · DEFAULT_COUNCIL). Повторное
   * `cell:lock` с тем же `state` и новыми `settings` — это и есть «переключить
   * ручку»: отдельного сообщения для ручек нет.
   *
   * Замок → не консилиум: попытки остаются в базе на просмотр до конца
   * занятия, студенту уходит `council:mine` с `closed: true`, его текст
   * остаётся у него черновиком.
   */
  | { t: 'cell:lock'; cellId: string; state: CellLock; settings?: Partial<CouncilSettings> }
  /**
   * Консилиум: свой лист студента.
   *
   * `council:draft` — снимок текста при паузе в наборе (~1 с). Целиком, не
   * дельтой: попытка не живёт в CRDT, и одному человеку на одну ячейку хватает
   * последнего снимка. Сервер принимает его от любого, кто действует в комнате
   * (rules.ts · mayWriteCouncil), только в ячейку, где сейчас консилиум, и
   * рассылает ТОЛЬКО преподавателю (`council:board`) и самому автору
   * (`council:mine`). Снимок сданной попытки её не «рассдаёт»: для этого есть
   * `council:withdraw` — иначе автоснимок при случайном нажатии снимал бы
   * «сдано» молча.
   *
   * `council:submit` — «Сдать»: ставит submittedAt; `council:withdraw` —
   * «Изменить»: снимает его, текст остаётся.
   */
  | { t: 'council:draft'; cellId: string; text: string }
  | { t: 'council:submit'; cellId: string }
  | { t: 'council:withdraw'; cellId: string }
  /**
   * Консилиум: то, что делает ведущий (rules.ts · mayLeadCouncil — только host).
   *
   * `council:show` — «Показать классу»: текст попытки ложится в общую ячейку
   * обычной правкой от имени преподавателя (collab · applyOnBehalf), попытке
   * ставится `shown`, автору уходит `council:mine`. Снять с экрана нечем
   * намеренно: показанное — уже текст общей ячейки, и правится оно как текст.
   *
   * `council:run` — запустить попытку в ядре комнаты; вывод ложится к попытке,
   * не в общую ячейку. Без `participantId` — своя попытка: так запускает
   * студент, и это проходит только при включённой ручке `studentRun`
   * (rules.ts · mayRunCouncil); отказ — `error` словами, с номером в очереди,
   * если очередь есть.
   *
   * `council:reply` — ответ автору или всей группе одинаковых решений: у
   * каждого адресата в `council:mine.reply` появляется строка с подписью
   * преподавателя. Черновик оракула (CouncilOracle.drafts) сюда попадает уже
   * правленым текстом — модель на этих проводах не говорит.
   *
   * `council:mark` — ✓ Верно / снять отметку: `correct: true | false | null`.
   */
  | { t: 'council:show'; cellId: string; participantId: string }
  | { t: 'council:run'; cellId: string; participantId?: string }
  | {
      t: 'council:reply'
      cellId: string
      to: { participantId: string } | { groupKey: string }
      text: string
    }
  | { t: 'council:mark'; cellId: string; participantId: string; correct: boolean | null }
  /**
   * Поставить документ комнаты на общий экран — или убрать его.
   *
   * Через сервер, а не через присутствие: присутствие исчезает вместе с
   * вкладкой, и закрытый ноутбук преподавателя убрал бы материал у всех разом,
   * а опоздавший не увидел бы ничего, пока преподаватель не пошевелится.
   * Комната помнит это сама и рассказывает каждому, кто подключился.
   */
  | { t: 'board:open'; name: string }
  | { t: 'board:close' }
  /**
   * Закончить занятие — и открыть его обратно.
   *
   * Преподавательское, и проверяется сервером: с этой минуты участник в
   * комнате только читает. Обратное движение здесь же и намеренно — пара
   * заканчивается раньше, чем понадобилось дописать одну ячейку, и цена
   * ошибки должна быть одним нажатием, а не «заводите новый семинар».
   */
  | { t: 'class:finish' }
  | { t: 'class:resume' }
  /**
   * Правка дерева: завести, переименовать, убрать.
   *
   * Через управляющий сокет, а не REST, ровно по той причине, по которой через
   * него ходит `cells:move`: результат должен увидеть не тот, кто нажал, а вся
   * комната, и сообщение `files` уже рассылается всем. Ответ на отказ приходит
   * тому же одному человеку строкой `refused`.
   */
  | { t: 'tree:mkdir'; path: string }
  | { t: 'tree:new'; path: string }
  /**
   * Внести .ipynb в комнату — то есть открыть его тетрадью.
   *
   * Отдельное сообщение, а не побочный эффект открытия вкладки: ячейки
   * переезжают из файла в документ комнаты, и это должен сделать сервер один
   * раз, а не двадцать браузеров наперегонки.
   */
  | { t: 'book:open'; path: string }
  | { t: 'tree:move'; from: string; to: string }
  | { t: 'tree:remove'; path: string }
  /**
   * Запустить файл — скриптом, а не ячейкой.
   *
   * Уезжает в тот же терминал, в котором живёт `term:run`: у комнаты один
   * контейнер, одна лента вывода и одна кнопка «прервать», и заводить скриптам
   * вторую значит показывать два разных ответа на вопрос «что сейчас
   * считается».
   */
  | { t: 'file:run'; path: string }
  /* ---------------------------------------------------------- лекция */
  /**
   * Начать лекцию: одна страница на проекторе и один человек за пультом.
   *
   * Отдельно от общего экрана (`board:open`), потому что это другое занятие. У
   * общего экрана каждый смотрит документ у себя и волен уйти вперёд; у лекции
   * есть ОДНА проекция, которую видит зал, и её страницу двигает ведущий.
   */
  | { t: 'lecture:start'; file: string }
  | { t: 'lecture:stop' }
  | { t: 'lecture:page'; page: number }
  /** Чёрный экран: гасит проекцию, оставляя страницу у ведущего на пульте. */
  | { t: 'lecture:blank'; on: boolean }
  /**
   * Дописать штрих карандашом.
   *
   * Точками, а не целым штрихом в конце: зал должен видеть линию, пока её
   * ведут. Координаты — доли страницы: пиксель планшета не значит ничего ни на
   * проекторе, ни у студента.
   */
  | {
      t: 'ink'
      page: number
      id: string
      color: string
      width: number
      /** Пары долей: x0, y0, x1, y1 … */
      points: number[]
    }
  | { t: 'ink:undo'; page: number }
  /**
   * Стереть один штрих — тот, до которого дотронулись ластиком.
   *
   * По имени штриха, а не по пикселям: в проводе есть только целые штрихи, и
   * пиксельное стирание потребовало бы нового формата и переписывания всей
   * истории лекции ради ластика. Отдельно от `ink:undo` не для симметрии:
   * отмена снимает ПОСЛЕДНИЙ, а ластик — тот, на который легла рука, и посреди
   * лекции это два разных жеста, а не один с двумя кнопками.
   */
  | { t: 'ink:erase'; page: number; id: string }
  | { t: 'ink:clear'; page?: number }
  /**
   * Спросить заметки спикера к документу.
   *
   * Спросить, а не получить в приветственной пачке, и это не экономия. Заметки
   * приходят ТОЛЬКО хостам, а роль сокета выясняется при подключении — класть
   * их в общую пачку значило бы держать «кому это можно» в двух местах, из
   * которых одно однажды забудут поправить.
   */
  | { t: 'notes:open'; file: string }
  /**
   * Записать заметку к одной странице. Пустая — это её отсутствие.
   *
   * Весь текст страницы, а не разница: очередь клиента при обрыве держит
   * шестнадцать сообщений и выбрасывает СТАРЫЕ, так что при полном тексте
   * единственное уцелевшее сообщение и есть верное, а при разнице уцелел бы
   * бессмысленный хвост.
   */
  | { t: 'notes:set'; file: string; page: number; text: string }
  /**
   * Указка. Эфемерна намеренно: где она была секунду назад — не факт о лекции,
   * а движение руки, и хранить его негде и незачем.
   */
  /*
   * Указка. `shape` — точкой показывают или линией обводят; едет вместе с
   * точкой, потому что зал обязан видеть ТО ЖЕ, что ведущий. Форма живёт в
   * каждом кадре, а не в отдельном сообщении о смене режима: кадр указки и так
   * идёт двадцать пять раз в секунду, лишний байт в нём дешевле, чем ещё одно
   * состояние, которое можно пропустить и разъехаться.
   */
  | { t: 'laser'; page: number; x: number; y: number; shape?: 'dot' | 'line' }
  | { t: 'laser:off' }
  | { t: 'ping' }

export type TerminalStatus = 'closed' | 'starting' | 'idle' | 'busy' | 'dead'

export type ControlServerMessage =
  | { t: 'ready'; kernel: KernelStatus }
  /*
   * The role the SERVER will act on, sent as soon as the socket opens. A
   * participant token carries the role it was minted with, which goes stale:
   * a teacher who joined a seminar before signing in holds a 'participant'
   * token for a room they run, and the client would grey out interrupt and
   * restart for its own owner. Presence of a staff cookie decides it, and this
   * is how the browser is told.
   */
  | { t: 'role'; role: ParticipantRole }
  | { t: 'terminal'; status: TerminalStatus }
  | { t: 'kernel'; status: KernelStatus }
  /**
   * Дерево комнаты. `truncated` — список неполон: обход упёрся в потолок, и
   * часть папок осталась нераскрытой.
   *
   * Признак, а не молчание: «файла нет в списке» и «файла нет» — разные вещи, и
   * тот, кто их путает, либо ищет глазами файл, который лежит на диске, либо
   * (хуже) убирает по неполному списку живую тетрадь.
   */
  | { t: 'files'; files: FileEntry[]; truncated?: boolean }
  /*
   * The room's rules changed. They can be edited after a seminar is made, and
   * the server reads them fresh on every request — so a room told nothing
   * would keep drawing a Run button that had just started refusing, which
   * reads as a broken product rather than a rule.
   */
  | { t: 'rules'; rules: RoomRules }
  /**
   * Занятие закончилось или снова идёт.
   *
   * Отдельным кадром, а не полем в `rules`: хранимые правила при этом не
   * меняются, и комната обязана увидеть разницу между «преподаватель ужесточил
   * правило» и «занятие кончилось» — фразы в подсказках у них разные.
   */
  | { t: 'class'; finishedAt: number | null }
  /**
   * Вас забанили — прямо сейчас, посреди занятия.
   *
   * Приходит одному человеку, и сразу после этого сокет закрывается. Без кадра
   * забаненный увидел бы ровно то же, что видит комната при обрыве сети:
   * соединение молча пропало и не возвращается, — то есть решил бы, что
   * сломался Colloq, и пошёл бы жаловаться на него вместо того, чтобы понять,
   * что произошло.
   *
   * `until` — момент конца бана; словами его показывает браузер по своим часам.
   */
  | { t: 'banned'; until: number }
  /**
   * Правку не приняли — и почему.
   *
   * Приходит одному человеку, а не комнате. Предотвращение — обычный путь:
   * комната, где правило запрещает править, рисует редакторы только для
   * чтения, и это сообщение — подстраховка для двух случаев: подделанный или
   * скриптовый клиент и те доли секунды после ужесточения правила, пока кадр
   * был в пути.
   *
   * Правильность на нём не держится: управляющий сокет — отдельное соединение,
   * которое переподключается само по себе, и если бы возврат документа в
   * согласованное состояние зависел от этой строки, обрыв оставил бы человека
   * навсегда немым, и ни одна из сторон не смогла бы это заметить.
   */
  /**
   * Документ на общем экране комнаты, или `null`, если его нет.
   *
   * Приходит и в приветственной пачке, и при каждой смене: иначе человек,
   * зашедший в середине занятия, не узнает, что комната что-то смотрит.
   */
  | { t: 'board'; open: string | null }
  /**
   * Лекция комнаты, или `null`, если её нет.
   *
   * Приходит и в приветственной пачке, и при каждой смене: опоздавший должен
   * увидеть ту же страницу, что и зал, не дожидаясь, пока ведущий перелистнёт.
   */
  | { t: 'lecture'; state: LectureState | null }
  /** Все чернила лекции — при подключении и после «стереть». */
  | { t: 'ink'; strokes: InkStroke[] }
  /** Новые точки. Штрих с известным именем дополняется, незнакомый — заводится. */
  | { t: 'ink:add'; stroke: InkStroke }
  | { t: 'ink:drop'; page: number; id: string }
  | { t: 'ink:clear'; page: number | null }
  /**
   * Заметки спикера к документу: страница → текст.
   *
   * Приходит ТОЛЬКО хостам и только в ответ на `notes:open`. Единственное в
   * этом продукте, чего комнате видеть не полагается: заметка «здесь спросить,
   * кто помнит формулу Байеса; если молчат — вывести на доске» — это речь
   * преподавателя самому себе, и приехав всем, она приезжает вместе с ответом
   * на вопрос, который ещё не задан.
   */
  | { t: 'notes'; file: string; notes: Record<number, string> }
  /**
   * Эхо одной правки — тоже только хостам.
   *
   * Одна страница, а не свежая карта целиком: правка уезжает по дебаунсу в
   * четыреста миллисекунд, то есть несколько раз за фразу, а карта к
   * двухсотстраничной методичке — сотни килобайт. Это ровно та расточительность,
   * от которой чернила защищены нарезкой на новые точки.
   */
  | { t: 'notes:one'; file: string; page: number; text: string }
  /** Где указка прямо сейчас, или `null` — её убрали. */
  /*
   * Указка. Без цвета: она красная у всех и всегда — это единственное, что
   * зал узнаёт мгновенно и ни с чем не путает. Цвет ведущего сюда приезжал
   * из общей привычки красить всё по автору, и на лекции второго
   * преподавателя указка оказывалась синей — то есть неотличимой от чернил.
   */
  | { t: 'laser'; at: { page: number; x: number; y: number; shape: 'dot' | 'line' } | null }
  /**
   * Консилиум: своя попытка — одному человеку.
   *
   * Приходит автору при подключении (по каждой ячейке, где у него есть
   * попытка или где консилиум открыт) и после каждого своего действия и
   * каждого действия преподавателя над его попыткой: сдал, показали, ответили,
   * запустили, отметили, закрыли консилиум. Чужих попыток в нём нет никогда.
   */
  | { t: 'council:mine'; cellId: string; state: CouncilMine }
  /**
   * Консилиум: вся стопка — ТОЛЬКО преподавателю.
   *
   * Целиком — в приветственной пачке хоста по каждой ячейке, где консилиум
   * открыт или где есть попытки, и на смену замка или ручек; перемены между
   * ними едут `council:patch`. Группы и порядок стопки клиент считает сам по
   * полному списку. Сервер вправе слить частые пересылки в одну (дребезг).
   */
  | { t: 'council:board'; cellId: string; board: CouncilBoard }
  /**
   * Консилиум: перемена в стопке — ТОЛЬКО преподавателю, и только то, что
   * сменилось.
   *
   * Стопка целиком едет в приветственной пачке и на смену замка; всё
   * остальное — снимок при паузе в наборе, запуск, ответ, отметка, бан — едет
   * попытками, которых это коснулось. Иначе каждый кадр вёз хосту вывод
   * каждой попытки (до мегабайт на карточку) из-за одной буквы у одного
   * студента — по три раза в секунду, пока класс печатает. `attempts` —
   * попытки целиком (заменить по participantId), `removed` — кого в стопке
   * больше нет (бан); `counts`, `lock` и `settings` — свежие, как в стопке.
   * Группы и порядок клиент считает сам по полному списку, как и раньше.
   * Кадр по ячейке, стопки которой у клиента нет, — пропускается: полная
   * стопка по ней уже в пути или уже была.
   */
  | {
      t: 'council:patch'
      cellId: string
      attempts: CouncilAttempt[]
      removed: string[]
      counts: CouncilBoard['counts']
      lock: CellLock
      settings: CouncilSettings
    }
  /** Консилиум: оракул о решениях сменил состояние — тоже только преподавателю. */
  | { t: 'council:oracle'; cellId: string; oracle: CouncilOracle }
  /**
   * Консилиум: «N сдали из M» — всей комнате, без текстов.
   *
   * Это для проектора и для чипа над ячейкой у студентов. Живой стены здесь
   * нет намеренно: счётчик говорит, что класс работает, и ничего о том, что он
   * написал. `total` — сколько людей завели попытку (сдали или пишут).
   */
  | { t: 'council:count'; cellId: string; submitted: number; total: number }
  | { t: 'refused'; rule: 'structure' | 'edit' | 'title' | 'files'; message: string }
  | { t: 'error'; message: string }
  /**
   * Ответ на пульс, и заодно часы сервера.
   *
   * `startedAt` на ячейке — серверное время, а секундомер тикает в браузере.
   * Вычесть одно из другого без поправки значит показать «40.0s» на только что
   * запущенной ячейке у того, чьи часы спешат, и застывший «0.0s» у того, чьи
   * отстают, — секундомер, который стоит на работающей ячейке. Одно поле на
   * сообщении, которое и так ходит туда-обратно, снимает оба случая.
   */
  | { t: 'pong'; now: number }

import type { OracleMode } from './admin.js'

/* ---------------------------------------------------------------- консилиум */

/**
 * Что известно о попытке после запуска.
 *
 * Отдельная запись, а не поля общей ячейки: вывод попытки ложится К ПОПЫТКЕ, а
 * общая ячейка остаётся тем, что показал преподаватель. `by` — кто нажал:
 * преподаватель (обычный путь) или сам автор (при включённой ручке).
 */
export interface CouncilRun {
  state: Extract<CellState, 'queued' | 'running' | 'ok' | 'error'>
  outputs: CellOutput[]
  execCount: number | null
  /** Сколько шёл настоящий запуск; `null`, пока идёт или если прервали. */
  ranMs: number | null
  /** Серверные часы начала — для строки «запускал преподаватель · 14:36». */
  startedAt: number
  by: 'host' | 'author'
}

/** Ответ преподавателя автору или группе. Подпись — всегда преподавателя. */
export interface CouncilReply {
  text: string
  at: number
  /** Имя того, кто отвечал: в комнате может быть два преподавателя. */
  by: string
}

/**
 * Состояние попытки одним словом — чип на карточке и цвет черты под сегментом.
 *
 *   unrun   — не запускали и не отмечали (серая черта, «не запускали»)
 *   ran     — запуск прошёл без исключения, отметки нет
 *   failed  — запуск упал (красная черта; в чипе — имя исключения)
 *   correct — преподаватель отметил «верно» (зелёная)
 *   wrong   — преподаватель отметил «неверно» (охра)
 *
 * Отметка преподавателя сильнее запуска: `correct`/`wrong` стоят и над упавшим
 * запуском, потому что решение о верности — его, а не ядра.
 */
export type CouncilStatus = 'unrun' | 'ran' | 'failed' | 'correct' | 'wrong'

/**
 * Состояние группы по состояниям её членов — одно место на пульт, сервер и
 * оракула. По одному представителю нельзя: преподаватель стрелкой попадает на
 * любого члена группы, и «Верно» или TypeError на его карточке иначе не
 * доходили бы ни до черты под сегментом, ни до чипа в сводке, а оракул считал
 * бы группу иначе, чем пульт.
 *
 * Отметка преподавателя сильнее запуска (correct, потом wrong); из запусков
 * громче падение: у одного и того же текста в общем ядре исход зависит от
 * состояния, и красная черта честнее серой.
 */
export function groupStatus(statuses: readonly CouncilStatus[]): CouncilStatus {
  for (const wanted of ['correct', 'wrong', 'failed', 'ran'] as const) {
    if (statuses.includes(wanted)) return wanted
  }
  return 'unrun'
}

/** Своя попытка — то, что видит студент. */
export interface CouncilMine {
  text: string
  /** Когда нажал «Сдать»; `null` — ещё пишет (или нажал «Изменить»). */
  submittedAt: number | null
  updatedAt: number
  /** Преподаватель показал этот вариант классу. */
  shown: boolean
  correct: boolean | null
  reply: CouncilReply | null
  run: CouncilRun | null
  /**
   * Место в очереди на запуск, если запуск студентам включён и запуск ждёт:
   * «вы 37-й». `null` — не в очереди.
   */
  queue: number | null
  /** Консилиум на этой ячейке закрыт: текст остаётся черновиком, на сервер не идёт. */
  closed: boolean
}

/** Одна попытка глазами преподавателя. */
export interface CouncilAttempt {
  participantId: string
  name: string
  color: string
  avatar: string | null
  text: string
  submittedAt: number | null
  updatedAt: number
  status: CouncilStatus
  run: CouncilRun | null
  reply: CouncilReply | null
  correct: boolean | null
  shown: boolean
  /** Ключ группы одинаковых решений (council-board.ts · groupAttempts). */
  groupKey: string
}

/**
 * Группа одинаковых решений: тот же текст после нормализации (без пробелов,
 * пустых строк и комментариев). Считает клиент по полному списку попыток
 * (web/src/lib/council-board.ts) и сервер — для оракула, той же функцией.
 */
export interface CouncilGroup {
  key: string
  count: number
  /** Имя группы одной строкой — от оракула; пока его нет, `null` (рисуют первую строку кода). */
  label: string | null
  /** Код представителя — то, что показывают в сводке. */
  sample: string
  /** По всем членам, не по представителю — `groupStatus`. */
  status: CouncilStatus
  /** Кто-то из группы сейчас на экране: этот текст уже лежит в общей ячейке. */
  shown: boolean
  /** Представитель: самый ранний сдавший в группе. */
  representative: string
  members: string[]
}

/**
 * Оракул о решениях — состояние, которое хранит сервер и рисует сводка.
 *
 * Обновляется ТОЛЬКО рукой: `stale` — с момента `askedAt` сдали ещё
 * `staleBy` человек, кнопка «Обновить». Модель видела тексты по группам с
 * числами, задание и эталон, имён не видела: `groupLabels`/`drafts` идут по
 * ключу группы, а к людям их привязывает клиент.
 */
export interface CouncilOracle {
  state: 'idle' | 'reading' | 'ready' | 'stale'
  askedAt: number | null
  /** Сколько попыток модель читала. */
  basedOn: number
  /** Сколько сдали с тех пор — для «с тех пор сдали ещё N». */
  staleBy: number
  /** Три абзаца: что верно, типичная ошибка, что показать. Пусто, пока не готов. */
  summary: string[]
  groupLabels: Record<string, string>
  /** Черновики ответов группам с ошибкой — правятся и отправляются преподавателем. */
  drafts: Record<string, string>
  notable: { participantId: string; why: string }[]
  /** Почему не получилось, если `state` вернулся в `idle` после ошибки. */
  error: string | null
}

/** Стопка целиком — то, что приезжает преподавателю. */
export interface CouncilBoard {
  lock: CellLock
  settings: CouncilSettings
  counts: {
    /** Завели попытку: сдали или пишут. */
    attempts: number
    submitted: number
    writing: number
    groups: number
  }
  attempts: CouncilAttempt[]
  /**
   * Группы на момент полного кадра — для теста и для взгляда снаружи; пульт
   * считает их сам по `attempts` (council-board.ts · groupAttempts), поэтому
   * `council:patch` их не везёт и после дельты это поле устаревает.
   */
  groups: CouncilGroup[]
  oracle: CouncilOracle | null
}

/* ------------------------------------------------------------------- AI */

export type AiAction = 'explain' | 'fix' | 'debug' | 'improve' | 'hint' | 'ask' | 'edit'

/**
 * Which actions an oracle in this mode will accept.
 *
 * One definition, two callers: the route that refuses and the panel that
 * decides whether to draw the button. They were separate, and the panel drew
 * FIX and DEBUG in hints mode and let the student press them to be told no —
 * which is the rule leaking out as an error message instead of as a design.
 *
 * 'ask' is a typed question with no instruction of its own, so it survives
 * hints mode; the mode shapes the answer, not the right to ask.
 */
export function actionAllowedIn(mode: OracleMode, action: AiAction): boolean {
  if (mode === 'off') return false
  if (mode === 'full') return true
  /*
   * 'edit' is deliberately not in the hints list. It does not describe a fix,
   * it writes one — a diff the room can accept with one press — and a mode
   * whose whole point is that the student reaches the answer themselves cannot
   * also hand them the answer as a patch.
   */
  return action === 'hint' || action === 'ask'
}

export interface AiAskRequest {
  /** Free-form prompt. Optional when `action` carries the whole intent. */
  message: string
  action?: AiAction
  /**
   * Ячейка, к которой ход ПРИВЯЗАН: та, куда ляжет предложенная правка.
   *
   * Одна, и это не пережиток: предложение переписывает один текст, у него одна
   * база и одно решение на всех. Ход про несколько ячеек называет их в
   * `cellIds`, а править предлагает по-прежнему одной.
   */
  cellId?: string | null
  /**
   * Ячейки, на которых просят сосредоточиться, — выделение спрашивающего.
   *
   * Оракул и без них видит тетради целиком; это не «что ему показать», а «на
   * что смотреть в первую очередь». Пусто — смотрит на всё сразу, и это
   * обычный случай.
   */
  cellIds?: string[]
  /**
   * Спросить или сделать.
   *
   * `agent` — это не «тот же вопрос, но подробнее»: оракул сам читает папку,
   * правит файлы и запускает скрипты. Отдельное правило комнаты, отдельная
   * лента шагов и отдельная кнопка отмены — см. `RoomRules.agent`.
   */
  mode?: 'ask' | 'agent'
}

/**
 * Asking is fire-and-forget: the server appends the question to the shared
 * document and streams the answer into it, so every browser in the room sees
 * the same thread arrive without a per-client response stream.
 */
export interface AiAskResponse {
  entryId: string
}

/** Snapshot the server assembles for the model. Exported for tests/debugging. */
export interface AiContext {
  sessionName: string
  cells: CellSnapshot[]
  selectedCellId: string | null
  files: string[]
}

/* ---------------------------------------------------------------- misc */

export const PARTICIPANT_COLORS = [
  '#f97362', // coral
  '#f2a33c', // amber
  '#8ac44a', // lime
  '#3ec9a7', // teal
  '#4aa8f0', // sky
  // Nudged from #7c7cf0, which left initials at 4.48:1 — a hair under AA, and
  // the one colour in the palette where they were not readable. Six units of
  // RGB buys 4.74 and keeps it plainly indigo, and plainly not the sky or the
  // purple either side of it.
  '#7e82f0', // indigo
  '#c273e6', // violet
  '#ef6ba8', // pink
] as const

export function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length]
}

/** Shape stored in Yjs Awareness under the `user` field. */
export interface AwarenessUser {
  id: string
  name: string
  avatar: string | null
  color: string
  role: ParticipantRole
  /** Cell the person is currently focused on, for the "editing here" badge. */
  activeCellId?: string | null
  /** True while they are typing into the oracle composer. */
  composing?: boolean
  /** True while their cursor is in the terminal. */
  inTerminal?: boolean
  /**
   * Какой файл человек правит прямо сейчас — путь, или null, если тетрадь.
   *
   * В присутствии, как и `viewing`, и по той же причине: место работы
   * эфемерно, оно ничего не значит после ухода вкладки и не должно попадать ни
   * в историю версий, ни под Ctrl+Z. Панель файлов рисует по нему точки «кто
   * здесь», а редактор — строку «Ада правит здесь».
   *
   * Курсоры внутри самого файла сюда не входят: они живут в присутствии ТОГО
   * документа, который открыт, и до комнаты не доходят вовсе.
   */
  editing?: string | null
  /**
   * Какой документ человек смотрит и где он в нём.
   *
   * В присутствии, а не в общем документе, и это выбор, а не удобство. Место в
   * PDF ровно так же эфемерно, как курсор в ячейке: оно ничего не значит после
   * того, как человек ушёл, его незачем возвращать по Ctrl+Z и незачем
   * записывать в историю версий — иначе лента заполнится строками «преподаватель
   * пролистал». Присутствие уже рассылается всей комнате и уже чинится сервером
   * (см. `pinRole`, `ownAwareness`), так что новых путей записи не появляется.
   *
   * Цена честная: при перезагрузке страницы место теряется, и если
   * преподаватель вышел — идти не за кем. И то и другое верно по существу.
   */
  viewing?: {
    file: string
    page: number
    /**
     * Место на странице долей её высоты, а не пикселями.
     *
     * У смотрящего своя ширина колонки и свой зум: пиксель преподавателя
     * приходится на другую строку. Доля переносится.
     */
    y: number
  } | null
}

/** Per-viewer preference, never shared with the room. */
export type ThemeName = 'light' | 'dark'
