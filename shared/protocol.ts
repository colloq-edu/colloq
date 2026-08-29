import type { RoomRules } from './rules.js'

/**
 * Wire contracts between browser and server: the control WebSocket, the REST
 * surface, and the AI streaming endpoint.
 *
 * Notebook *content* never travels through here — that is Yjs's job. This
 * channel carries intent ("run this cell") and side-band state (kernel health,
 * file listing) only.
 */
import type { CellSnapshot, KernelStatus } from './notebook'

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
   * существенная: сервер отказывает нажатию, чья цель успела смениться, а
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
  | { t: 'files'; files: FileEntry[] }
  /*
   * The room's rules changed. They can be edited after a seminar is made, and
   * the server reads them fresh on every request — so a room told nothing
   * would keep drawing a Run button that had just started refusing, which
   * reads as a broken product rather than a rule.
   */
  | { t: 'rules'; rules: RoomRules }
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
