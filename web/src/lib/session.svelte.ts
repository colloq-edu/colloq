import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { getContext, setContext } from 'svelte'
import {
  cellSource,
  allCellArrays,
  ensureInitialNotebook,
  findCell,
  getCells,
  getChat,
  getMeta,
  getTerminal,
} from '@shared/notebook'
import type {
  AwarenessUser,
  ControlClientMessage,
  ControlServerMessage,
  FileEntry,
  Participant,
  SessionInfo,
  TerminalStatus,
} from '@shared/protocol'
import type { InkStroke, LectureState } from '@shared/lecture'
import { readRules, type RoomRules } from '@shared/rules'
import { api, ApiError } from './api'
import { enqueueControl, OFFLINE_REASON } from './controls'
import { CouncilState } from './council.svelte'
import { reopenRefusedFiles } from './filedoc.svelte'
import { countsAsUnread } from './notes'
import { forgetIdentity, type StoredIdentity } from './identity'
import { permitsIn } from './may'
import { cellToAnnounce, ownChanges, type AwarenessChanges } from './presence'
import { bindLocalStore, forgetSessionInfo, type LocalStore } from './persistence.svelte'
import {
  mayReload,
  REFUSED_CLOSE,
  refusalHealed,
  reloadAfterRefusal,
  stashRefusal,
} from './refusal'

export interface Peer {
  clientId: number
  user: AwarenessUser
  isSelf: boolean
}

function wsBase(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}`
}

/**
 * Everything a mounted seminar needs: the shared document, presence, the run
 * control socket and the workspace file list.
 *
 * Constructed once when the student enters the room and torn down on leave —
 * deliberately not reactive to its own inputs, because rebuilding it would drop
 * the local CRDT state and every unsynced keystroke with it.
 */
/**
 * Одни ли это правила — по смыслу, а не по байтам.
 *
 * Сервер и кэш страницы могут держать одно и то же с разным порядком ключей
 * или с полем, которого в старой строке ещё не было: `readRules` приводит обе
 * стороны к полному набору с умолчаниями, и сравниваются уже они.
 */
function sameRules(a: unknown, b: unknown): boolean {
  const left = readRules(a)
  const right = readRules(b)
  return (Object.keys(left) as (keyof RoomRules)[]).every((key) => left[key] === right[key])
}

/**
 * Что на закрытом сокете выбрасывается, а не встаёт в очередь.
 *
 * Очередь короткая (16, см. controls.ts) и хранит нажатия: запуск ячейки,
 * перезапуск ядра, команду терминалу. Кадры лекции туда не годятся вовсе.
 * Точки чернил живут в мокром штрихе и досылаются сами, когда связь вернётся,
 * а указка — это положение руки секунду назад, и досылать его некуда. Зато
 * пальцем их набирается по десятку в секунду: очередь переполнялась ими
 * досуха и выбрасывала настоящие нажатия, ради которых заведена.
 */
const DISCARDED_OFFLINE = new Set<ControlClientMessage['t']>(['ping', 'ink', 'laser'])

export class SessionState {
  /** Not readonly: the room's rules can change while the seminar is running. */
  session: SessionInfo = $state.raw({} as SessionInfo)
  /**
   * Занятие закончено: комната открыта на чтение, действует преподаватель.
   *
   * Геттер поверх `session.finishedAt`, потому что время интересно только тем,
   * кто его показывает, а всем остальным нужен ответ «да или нет» — его и ждёт
   * `permitsIn` третьим аргументом.
   */
  get finished(): boolean {
    return this.session.finishedAt !== null
  }
  /** True once the server has said the seminar is gone; stops the reconnect loop. */
  gone = $state(false)
  /**
   * Вкладка разошлась с сервером и больше не пробует сама: словами — почему.
   *
   * Отказ лечится перезагрузкой с очисткой кэша, и перезагрузок даётся две (см.
   * lib/refusal.ts). Дальше вкладка стоит на месте и молчит — раньше она
   * стояла на месте и стучалась: провайдер переподключался сам по своему
   * отступу и предлагал серверу тот же документ каждые три секунды, до
   * закрытия вкладки. Измерено на живой комнате: одна вкладка, двенадцать
   * отказов в минуту, десять минут, а в шапке всё это время — «Reconnecting».
   */
  stuck = $state<string | null>(null)
  /**
   * Комната есть, а ключ этого браузера она больше не признаёт.
   *
   * Экран, увидев это, отдаёт человека форме имени: сама себя такая комната не
   * чинит — имя выбирает человек, а не программа. Запись о прошлой личности к
   * этому моменту уже стёрта (см. `#diagnose`).
   */
  expired = $state(false)
  /**
   * Нас удалили с занятия: момент конца бана, или null.
   *
   * Отдельно от `gone` и от `expired`, потому что это третий разный случай, и
   * путать их дорого. Комнаты нет — работать негде; ключ протух — назовитесь
   * заново; бан — комната на месте и ждёт вас завтра, а сейчас вход закрыт
   * человеком. Каждому из трёх нужны свои слова, и `expired` вдобавок увёл бы
   * забаненного на форму имени — то есть предложил бы обойти бан переименованием.
   */
  banned = $state<number | null>(null)
  /**
   * Часы этого браузера минус часы сервера, в миллисекундах.
   *
   * Ноль, пока не ответил первый pong. Отнимается от локального `Date.now()`
   * везде, где считают от серверной отметки времени — сейчас это секундомер
   * работающей ячейки.
   */
  clockSkewMs = $state(0)
  /*
   * Reactive, because the role in it can be corrected after the fact: the
   * control socket reports the role the SERVER will act on, which is not
   * necessarily the one this browser's token was minted with.
   */
  me = $state<Participant>({ id: '', name: '', avatar: null, color: '', role: 'participant' })
  readonly token: string
  readonly doc: Y.Doc
  readonly provider: WebsocketProvider
  readonly awareness: Awareness
  readonly undoManager: Y.UndoManager
  readonly localStore: LocalStore

  /** Collab socket health. Editing keeps working while false; the CRDT catches up. */
  collabConnected = $state(false)
  /**
   * Управляющий сокет открыт — то есть Run, перезапуск и терминал дойдут.
   *
   * Отдельно от `collabConnected`, потому что провода два и поднимаются они
   * порознь: y-websocket отступает максимум на 2,5 с, наш собственный — до 8 с.
   */
  controlConnected = $state(false)
  /**
   * Комната на связи — по ОБОИМ проводам.
   *
   * По этому полю гаснут все кнопки управляющего (Run, Restart, терминал) и
   * зажигается «Reconnecting», а раньше в нём стоял один только сокет
   * совместной работы. После рестарта сервера он поднимается первым: надпись
   * гасла, кнопки загорались, нажатия молча уходили в очередь и выполнялись
   * через несколько секунд — Run All, про который человек уже решил, что он не
   * сработал. Печатать при этом можно и без связи, но печатанье — это CRDT, и
   * его никто не гасит.
   */
  readonly connected = $derived(this.collabConnected && this.controlConnected)
  /**
   * The on-disk copy has been replayed. Until then an empty notebook means
   * "not read yet", not "there is nothing here" — the difference between a
   * skeleton and a wrong empty state.
   */
  hydrated = $state(false)
  /**
   * Список файлов комнаты хоть раз приезжал.
   *
   * «Не спрашивали ещё» и «файлов нет» — разные вещи, и путать их дорого:
   * вкладки живут по этому списку, и пустой на первом кадре стирал их все.
   */
  filesArrived = $state(false)
  /**
   * Список показан не целиком: обход папок упёрся в потолок.
   *
   * Признак едет рядом со списком и заменяется каждым кадром — сервер шлёт
   * `false` явно, так что «уже не обрезано» доезжает так же честно, как
   * «обрезано». Панель файлов говорит об этом строкой внизу дерева: человек,
   * не нашедший свой файл, ищет его заново, а про потолок не догадывается.
   */
  filesTruncated = $state(false)
  peers = $state<Peer[]>([])
  files = $state<FileEntry[]>([])
  /**
   * Ячейка, с которой работают клавиатура и курсор, — якорь выделения.
   *
   * Всегда входит в `selection`, пока выделение не пусто. Комната видит именно
   * её: присутствие отвечает на вопрос «где человек», а он в один момент в
   * одном месте.
   */
  selectedCellId = $state<string | null>(null)
  /**
   * Все выделенные ячейки, в порядке документа.
   *
   * Список, а не одна: вопрос оракулу про две ячейки — обычное дело, и до сих
   * пор его нельзя было задать иначе как словами. Порядок держат те, кто
   * выделяет: он свой у каждой тетради.
   */
  selection = $state<string[]>([])
  /**
   * Файл, открытый у этого человека прямо сейчас, — или `null`.
   *
   * Тот же путь, что уезжает в присутствие. Хранится ещё и здесь, потому что
   * панель оракула должна назвать его в строке «особенно»: спрашивают почти
   * всегда про то, на что смотрят.
   */
  editingPath = $state<string | null>(null)
  /**
   * Показать вкладку, в которой лежит эта ячейка.
   *
   * Ставит экран комнаты — только он знает про вкладки. Ссылка на ячейку
   * приходит из панели людей и из треда оракула, то есть мимо тетради, и без
   * этого вела в спрятанную: `scrollIntoView` внутри `display:none` не делает
   * ничего, и переход выглядел как сломанная кнопка.
   */
  showCell: ((cellId: string) => void) | null = null
  lastError = $state<string | null>(null)
  /**
   * Последний отказ гейта — со временем, чтобы не выдать старый за новый.
   *
   * Не `$state`: его читает только записка, которую кладут перед перезагрузкой,
   * и ничего в интерфейсе от него не зависит.
   */
  #refusal: { message: string; at: number } | null = null
  /** Shared terminal lifecycle; 'closed' until somebody opens the drawer. */
  terminalStatus = $state<TerminalStatus>('closed')
  /**
   * Kernel notes nobody has read yet.
   *
   * The runtime's out-of-band news — "a cell failed, so the 12 cells queued
   * behind it were not run", "kernel restarted by Maria, every variable is
   * gone" — is written into the shared transcript, and the transcript lives in
   * a drawer that starts closed. A room that pressed Run All and watched it
   * stop at cell 5 had the reason on file and no way to know it was there.
   *
   * Only `system` lines count. A classmate's `pip install` is news to nobody:
   * the person who typed it is watching, and the dot is worth something only
   * while it stays rare.
   */
  terminalUnread = $state(0)

  /**
   * Документ, который комната смотрит вместе, или `null`.
   *
   * Приходит с сервера — и в приветственной пачке, и при каждой смене. Живёт в
   * комнате, а не в присутствии: присутствие исчезает вместе с вкладкой, и
   * закрытый ноутбук преподавателя убрал бы материал у всех сразу, а
   * опоздавший не увидел бы ничего, пока преподаватель не пошевелится.
   */
  board = $state<string | null>(null)

  /**
   * Лекция комнаты: одна страница на проекторе и один человек за пультом.
   *
   * `null` — лекции нет. Приходит с сервера в приветственной пачке и при каждой
   * смене, как и общий экран: опоздавший должен увидеть ту же страницу, что и
   * зал.
   */
  lecture = $state<LectureState | null>(null)
  /**
   * Чернила лекции, все страницы разом.
   *
   * `$state.raw`, а не глубоко реактивный массив: точки дописываются пачками по
   * двадцать раз в секунду, и оборачивать каждую в прокси значит платить за
   * реактивность, которой никто не пользуется — рисует их холст, а не разметка.
   * Перерисовку заказывает `inkRevision`.
   */
  ink = $state.raw<InkStroke[]>([])
  /** Счётчик правок чернил: холст перерисовывается по нему, а не по массиву. */
  inkRevision = $state(0)
  /**
   * Указка ведущего или `null`.
   *
   * Не хранится нигде: где она была секунду назад — движение руки, а не факт о
   * лекции. Гаснет сама, когда ведущий перестаёт её двигать.
   */
  laser = $state<{ page: number; x: number; y: number; shape: 'dot' | 'line' } | null>(null)

  /**
   * Заметки спикера к `notesFile`: номер страницы → текст.
   *
   * `$state.raw` и только присваивание целиком, как у чернил и по той же
   * причине: карту читает лента заметок, а не разметка по ключам, и глубокий
   * прокси на двухстах страницах речи — плата за реактивность, которой никто не
   * пользуется. Приходит только хостам; в зале эта карта пуста всегда.
   */
  notes = $state.raw<Record<number, string>>({})
  /**
   * Чьи заметки лежат в `notes`. `null` — ещё не приехали.
   *
   * Отдельное поле, а не пустая карта, и разница тут дорогая: «заметок к этой
   * странице нет» и «заметки ещё не приехали» выглядят на экране одинаково —
   * пустотой, — а значат противоположное. Преподаватель, увидевший пустоту там,
   * где вчера написал двадцать строк, решит, что потерял их, и решит это
   * посреди пары.
   */
  notesFile = $state<string | null>(null)

  /**
   * Консилиум: своя попытка, стопка преподавателя, счётчики — по ячейкам.
   *
   * Отдельным объектом, а не полями здесь: сообщений у консилиума столько же,
   * сколько у всей лекции, и разбирать их в одном `onmessage` с чернилами
   * значило бы вырастить его ещё вдвое. Шлёт он через тот же `send`, что и
   * кнопки, — с той же очередью и теми же словами про отсутствие связи.
   */
  readonly council: CouncilState

  #control: WebSocket | null = null
  #controlQueue: ControlClientMessage[] = []
  /**
   * Документ, чьи заметки мы спросили. Защёлка и заодно память о подписке.
   *
   * Память нужна из-за переподключения: сервер шлёт заметки ТОЛЬКО в ответ на
   * `notes:open`, в приветственной пачке их нет, — и без переспроса первый же
   * обрыв оставил бы преподавателя без речи до конца пары, показывая при этом
   * не ошибку, а пустоту.
   */
  #notesWanted: string | null = null
  #reconnectTimer: number | undefined
  #heartbeat: number | undefined
  #retries = 0
  #disposed = false
  #pingSentAt: number | null = null
  /** Самый быстрый круг на этом соединении: по нему и берут поправку часов. */
  #bestRtt = Number.POSITIVE_INFINITY

  constructor(session: SessionInfo, identity: StoredIdentity) {
    this.session = session
    this.token = identity.token
    this.me = {
      id: identity.participantId,
      name: identity.name,
      avatar: identity.avatar,
      color: identity.color,
      role: identity.role,
    }

    this.doc = new Y.Doc()
    this.council = new CouncilState((message) => this.send(message))

    // Declare every root before a single update can land — the local replay is
    // queued one task from here. An update that reaches an undeclared root
    // creates it untyped, and the later getArray()/getMap() then swaps in a
    // *different instance*, silently orphaning any observer already on it.
    getCells(this.doc)
    getMeta(this.doc)
    getChat(this.doc)
    getTerminal(this.doc).observe(this.#onTerminalLines)

    // Disk before network, in this order deliberately: IndexedDB answers in
    // single-digit milliseconds and a websocket in hundreds, so the notebook
    // paints from the local copy and the server merges into what is on screen.
    this.localStore = bindLocalStore(session.id, this.doc)
    void this.localStore.whenSynced.then(() => {
      if (!this.#disposed) this.hydrated = true
    })

    this.provider = new WebsocketProvider(`${wsBase()}/collab`, session.id, this.doc, {
      params: { token: identity.token },
      connect: true,
      /*
       * Без BroadcastChannel: соседние вкладки одного семинара сходятся через
       * сервер, как и любые два браузера. Прямой канал между вкладками — это
       * второй путь, по которому в документ попадает то, что сервер не
       * принимал: вкладка, только что пересобранная начисто после отказа,
       * спрашивала соседку и получала от неё обратно ровно те структуры, из-за
       * которых пересобиралась. Заодно исчезает эхо присутствия, от которого
       * сервер защищался отдельно (collab/index.ts · ownAwareness).
       */
      disableBc: true,
    })
    this.awareness = this.provider.awareness
    /*
     * Серверу — только своё присутствие.
     *
     * Провайдер в `_awarenessUpdateHandler` отсылает ВСЕ изменившиеся clientID
     * подряд: чужое состояние он применяет сам (`applyAwarenessUpdate` с собой
     * в origin), awareness сообщает об изменении — и тот же обработчик
     * отправляет его обратно в сокет, из которого оно приехало. Сервер это эхо
     * отвергает (`ownAwareness`), но чтобы отвергнуть, разбирает: на стенде с
     * 500 вкладками им была ровно половина из шестнадцати тысяч кадров
     * присутствия в секунду.
     *
     * Обработчик провайдера снимается, свой встаёт на его место и зовёт
     * снятый — но с кадром, где остался только наш clientID (см.
     * lib/presence.ts). Кодирование, сокет и BroadcastChannel остаются
     * провайдерскими: фильтр не повод переписывать протокол.
     *
     * Соседним вкладкам это ничего не стоит — у каждой свой сокет и своё
     * присутствие от сервера, а ретрансляция чужих состояний между вкладками
     * одного браузера только дублировала то, что и так придёт. Заодно перестал
     * рассылаться уход соседей на обрыве: `removeAwarenessStates` внутри
     * провайдера — это местная уборка, а не новость о комнате.
     */
    this.awareness.off('update', this.provider._awarenessUpdateHandler)
    this.awareness.on('update', this.#announceSelf)
    this.undoManager = new Y.UndoManager(getCells(this.doc), {
      // Only undo what this person typed; never yank a peer's work away.
      trackedOrigins: new Set([null, 'local']),
      captureTimeout: 400,
    })
    /*
     * Отмена достаёт до всех тетрадей комнаты, а не только до первой.
     *
     * Тетради открывают на ходу, и область действия UndoManager приходится
     * дописывать по мере их появления: без этого Ctrl+Z во второй тетради молча
     * не делал бы ничего — худший вид отказа, потому что клавиша сработала.
     */
    const widen = () => {
      for (const cells of allCellArrays(this.doc)) this.undoManager.addToScope([cells])
    }
    widen()
    getMeta(this.doc).observeDeep(widen)

    const user: AwarenessUser = {
      id: identity.participantId,
      name: identity.name,
      avatar: identity.avatar,
      color: identity.color,
      role: identity.role,
      activeCellId: null,
    }
    this.awareness.setLocalStateField('user', user)

    this.provider.on('status', this.#onStatus)
    this.provider.on('sync', this.#onSync)
    this.provider.on('connection-close', this.#onCollabClose)
    this.awareness.on('change', this.#readPeers)
    this.#readPeers()

    // The title is deliberately NOT seeded here. `session.name` is the name the
    // room was created with — the router may be replaying it from cache — while
    // the live title lives in the document and the host may have renamed it.
    // Writing it into a doc that has not replayed yet starts a conflict with a
    // rename this client has never seen, and roughly one merge in two hundred
    // resolves it the wrong way: the seminar silently reverts to its old name
    // for everybody. The header falls back to `session.name` for display, and
    // #onSync seeds the document only once the server confirms it is empty.
    this.#connectControl()
    this.refreshFiles()
  }

  #onStatus = ({ status }: { status: string }) => {
    this.collabConnected = status === 'connected'
    this.#backOnline()
  }

  /**
   * Связь вернулась — снять строку про её отсутствие.
   *
   * Зовётся с обоих проводов: строка висит, пока молчит хоть один, и убирать
   * её должен тот, кто починился последним. The offline notice is about right
   * now; leaving it up once the room is back would contradict the header, which
   * has already stopped saying RECONNECTING.
   */
  #backOnline() {
    if (this.connected && this.lastError === OFFLINE_REASON) this.lastError = null
  }

  #onSync = (isSynced: boolean) => {
    if (!isSynced) return
    // Сервер принял этот документ — значит прошлые отказы больше ни о чём не
    // говорят, и следующий, если он будет, снова получит право на перезагрузку.
    refusalHealed()
    // Fallback only: the server seeds a fresh document before anyone can connect.
    ensureInitialNotebook(this.doc, this.session.name)
    this.#countUnread = true
  }

  /**
   * False until the server has handed over what it already had.
   *
   * Without it, walking into a room replayed every note the kernel had ever
   * written as unread: a student arriving on Tuesday was told there were nine
   * things to read, all of them from last week's seminar. Unread means arrived
   * while I was here.
   */
  #countUnread = false

  #onTerminalLines = (event: Y.YArrayEvent<Y.Map<unknown>>) => {
    for (const delta of event.changes.delta) {
      for (const line of delta.insert ?? []) {
        const kind = (line as Y.Map<unknown>).get?.('kind')
        if (countsAsUnread({ kind }, { open: this.#terminalOpen, synced: this.#countUnread })) {
          this.terminalUnread += 1
        }
      }
    }
  }

  /**
   * Told by the screen that owns the drawer. While it is open the room is
   * reading the transcript, so nothing arriving is unread.
   */
  #terminalOpen = false
  setTerminalOpen(open: boolean) {
    this.#terminalOpen = open
    if (open) this.terminalUnread = 0
  }

  /**
   * Кадр присутствия наружу — только про себя. Разбор в конструкторе.
   *
   * Обёртка вокруг провайдерского обработчика, а не замена ему: всё, что
   * дальше кодирования, остаётся протоколом `y-websocket`.
   */
  #announceSelf = (changes: AwarenessChanges, origin: unknown) => {
    const own = ownChanges(changes, this.doc.clientID)
    if (own) this.provider._awarenessUpdateHandler(own, origin)
  }

  #readPeers = () => {
    const next: Peer[] = []
    this.awareness.getStates().forEach((state, clientId) => {
      const user = state?.user as AwarenessUser | undefined
      if (!user?.id) return
      next.push({ clientId, user, isSelf: clientId === this.awareness.clientID })
    })
    next.sort(
      (a, b) => Number(b.isSelf) - Number(a.isSelf) || a.user.name.localeCompare(b.user.name),
    )
    this.peers = next
  }

  /* ------------------------------------------------------ control socket */

  #connectControl() {
    if (this.#disposed) return
    const socket = new WebSocket(
      `${wsBase()}/control/${this.session.id}?token=${encodeURIComponent(this.token)}`,
    )
    this.#control = socket

    socket.onopen = () => {
      this.#retries = 0
      this.controlConnected = true
      this.#backOnline()
      // Новое соединение — новая сеть: прошлый лучший круг про неё ничего не знает.
      this.#bestRtt = Number.POSITIVE_INFINITY
      for (const queued of this.#controlQueue.splice(0)) socket.send(JSON.stringify(queued))
      /*
       * И переспросить заметки — здесь, рядом со сливом очереди.
       *
       * Подписка не переживает соединение: заметки приходят только в ответ на
       * `notes:open`, и новый сокет о прошлом вопросе не знает ничего. Своя же
       * карта при этом не гасится: она уже приезжала, свежая перезапишет её
       * через круг, а обнулять на каждый моргнувший вайфай значит подставлять
       * «Заметки загружаются» под нос человеку, который в этот момент читает с
       * экрана свою следующую фразу.
       */
      this.#askNotes()
      const beat = () => {
        if (socket.readyState !== WebSocket.OPEN) return
        this.#pingSentAt = Date.now()
        socket.send(JSON.stringify({ t: 'ping' }))
      }
      // Сразу, а не через двадцать пять секунд: первая проба часов нужна до
      // первого запуска ячейки, а первый запуск на семинаре — это тот самый,
      // который смотрит вся комната.
      beat()
      this.#heartbeat = window.setInterval(beat, 25_000)
    }

    socket.onmessage = (event) => {
      let message: ControlServerMessage
      try {
        message = JSON.parse(event.data as string) as ControlServerMessage
      } catch {
        return
      }
      if (message.t === 'rules') {
        // Правила меняются на ходу, и комната обязана узнать сразу: кнопка,
        // которая только что начала отказывать, без объяснения читается как
        // поломка, а не как решение преподавателя.
        /*
         * «Первый кадр» — первый ПО СОКЕТУ, а не «правил ещё не было».
         *
         * Раньше первым считался кадр при `session.rules === undefined`, а
         * такого не бывает: правила у страницы есть с первого кадра — из кэша
         * или из умолчания OPEN_ROOM, — и приветственная пачка сокета в любой
         * комнате с неоткрытыми правилами отличалась от них. То есть каждая
         * перезагрузка страницы говорила «преподаватель изменил, что можно
         * делать», хотя никто ничего не менял. Сравнение к тому же шло по
         * JSON.stringify, которому важен порядок ключей.
         */
        const first = !this.#rulesArrived
        this.#rulesArrived = true
        const changed = !sameRules(this.session.rules, message.rules)
        this.session = { ...this.session, rules: message.rules }
        /*
         * И сказать словами — один раз, не на приветственной пачке.
         *
         * Двадцать человек, у которых редакторы вдруг стали «только чтение» без
         * единой фразы, решат, что сломались их ноутбуки. А та же фраза при
         * каждом переподключении — это шум, который перестают читать. На
         * переподключении кадр тоже приветственный, но правила к тому моменту
         * уже настоящие: если они правда сменились, пока связи не было, сказать
         * об этом надо.
         */
        if (!first && changed) this.rulesChangedAt = Date.now()
        // Вместе с правилами меняется и то, что человек вправе делать в ячейке,
        // где он стоит: метка «правит эту» уходит из присутствия сразу, а не
        // ждёт, пока он щёлкнет куда-нибудь ещё.
        if (changed) this.#announceAnchor()
        return
      }
      if (message.t === 'class') {
        /*
         * Занятие закончилось — или снова идёт.
         *
         * Отдельно от правил и рядом с ними: хранимые правила при этом не
         * меняются, а кнопки гаснут все разом, и без слов это читается как
         * поломка ноутбука, а не как решение преподавателя.
         *
         * Защёлка «первый кадр» — та же, что у правил, и по той же причине.
         * Пока сервер не ответил, карточка комнаты угадывает «занятие идёт»
         * (App.svelte · knownRoom): угадать строже значит погасить живые
         * кнопки. Значит в комнате, где пара кончилась вчера, первый же кадр
         * расходится с угаданным, и открывший ссылку впервые слышал «занятие
         * закончено» так, будто звонок прозвенел при нём.
         *
         * Защёлка одна на комнату, а не на сокет, — и переподключение остаётся
         * событием: звонок, прозвеневший, пока связи не было, комната всё-таки
         * объявит.
         *
         * Сравнение по «есть или нет», а не по самому времени: переприсланная
         * та же отметка — не новость.
         */
        const first = !this.#classArrived
        this.#classArrived = true
        const wasFinished = this.finished
        this.session = { ...this.session, finishedAt: message.finishedAt }
        const changed = wasFinished !== this.finished
        if (!first && changed) this.classChangedAt = Date.now()
        // И то же самое про звонок: после него не правит никто, а метка — про правку.
        if (changed) this.#announceAnchor()
        /*
         * А файлы оживают и на первом кадре: метка выше — про слова, которые
         * говорят один раз, а это починка, и молчать ей незачем. Вкладка файла,
         * закрытая отказом из-за конца занятия, сама не переподключается
         * (lib/filedoc.svelte.ts) и без этого осталась бы мёртвой до
         * перезагрузки страницы.
         */
        if (changed && !this.finished) reopenRefusedFiles(this.session.id)
        return
      }
      if (
        message.t === 'council:mine' ||
        message.t === 'council:board' ||
        message.t === 'council:patch' ||
        message.t === 'council:oracle' ||
        message.t === 'council:count'
      ) {
        // Пять кадров консилиума — одному разборщику: он знает, кому какой
        // адресован, и хранит их по ячейкам.
        this.council.receive(message)
        return
      }
      if (message.t === 'banned') {
        /*
         * Нас удалили посреди занятия. Сервер закроет сокет следующим шагом —
         * дальше комната работать не будет, и делать вид, что будет, нельзя:
         * сюда, а не в тост, потому что человек упёрся не в ошибку, а в решение.
         */
        this.#youAreBanned(message.until)
        return
      }
      if (message.t === 'refused') {
        // Отказ адресован одному человеку и объясняет, где именно его правка
        // не прошла. Обычный путь — предотвращение; сюда попадают гонка и
        // подделанный клиент.
        this.lastError = message.message
        // И отдельно — для записки, которую человек прочитает уже после
        // перезагрузки: `lastError` держит ЛЮБУЮ последнюю ошибку и сам не
        // гаснет (тост закрывают крестиком), так что отказ десятиминутной
        // давности объяснял бы человеку не то, во что он упёрся сейчас.
        this.#refusal = { message: message.message, at: Date.now() }
        return
      }
      if (message.t === 'role') {
        /*
         * The server's answer outranks the stored one, and the room has to
         * hear it too: the role travels in awareness, and awareness is what
         * draws the Host badge on everyone else's screen. Setting the field
         * alone left a stale badge sitting there for the whole seminar.
         */
        if (this.me.role !== message.role) {
          this.me.role = message.role
          const current = this.awareness.getLocalState()?.user as AwarenessUser | undefined
          if (current) this.awareness.setLocalStateField('user', { ...current, role: message.role })
        }
      } else if (message.t === 'pong') {
        /*
         * Поправка к часам браузера, снятая по кругу.
         *
         * `startedAt` на ячейке — серверное время, секундомер тикает здесь.
         * Без поправки у того, чьи часы спешат на сорок секунд, только что
         * запущенная ячейка показывает «40.0s», а у того, чьи отстают, —
         * застывший «0.0s» на работающей ячейке.
         *
         * Половина круга — обычная оценка: считаем, что ответ шёл столько же,
         * сколько вопрос. Без усреднения и без выбора минимальной пробы:
         * ошибка ограничена половиной круга, а это заметно меньше десятой
         * доли секунды, которую показывает счётчик.
         */
        const sent = this.#pingSentAt
        if (sent !== null) {
          const rtt = Date.now() - sent
          /*
           * Побеждает лучшая проба, а не последняя.
           *
           * Оценка «половина круга» верна ровно настолько, насколько дорога
           * туда похожа на дорогу обратно. На мобильной сети круг гуляет от
           * сотни миллисекунд до секунды, и брать каждую новую пробу значит
           * дёргать поправку на полсекунды в обе стороны — а из неё растёт
           * секундомер, который в этот момент показывают комнате. Он бы шёл
           * назад.
           *
           * Чем короче круг, тем меньше в нём места для перекоса, так что
           * лучшая проба — самая быстрая. Минимум сбрасывается на каждом новом
           * соединении: сеть за это время могла стать другой.
           */
          if (rtt <= this.#bestRtt) {
            this.#bestRtt = rtt
            this.clockSkewMs = sent + rtt / 2 - message.now
          }
          this.#pingSentAt = null
        }
      } else if (message.t === 'files') {
        this.files = message.files
        this.filesArrived = true
        this.filesTruncated = message.truncated === true
        /*
         * Файл могли удалить или переписать прямо на занятии: удаляет
         * преподаватель, а переписать может любая ячейка — `df.to_csv` идёт в
         * ту же папку. Читалка, оставшаяся на документе, которого нет, — это
         * пустая область без объяснения.
         */
        if (this.board && !message.files.some((file) => !file.dir && file.path === this.board)) {
          this.board = null
        }
      } else if (message.t === 'board') this.board = message.open
      else if (message.t === 'lecture') {
        this.lecture = message.state
        // Лекция кончилась — чернила с ней: сервер их уже забыл.
        if (!message.state) {
          this.ink = []
          this.inkRevision += 1
          this.laser = null
        }
        /*
         * А заметки — не гасим. Они живут в базе и привязаны к ФАЙЛУ, а не к
         * лекции: та же речь годится и на второй лекции по тому же документу
         * через неделю, и на подготовке, когда лекции нет вовсе.
         */
      } else if (message.t === 'notes') {
        /*
         * Ответ на наш вопрос — и только на последний. Пока карта была в пути,
         * пульт мог уйти на другой документ, и приехавшая старая перезаписала
         * бы новую молча.
         */
        if (message.file === this.#notesWanted) {
          this.notes = message.notes
          this.notesFile = message.file
        }
      } else if (message.t === 'notes:one') {
        /*
         * Эхо одной правки — своей же или второго преподавателя. Приходит и
         * тому, кто её сделал: пульт на планшете и ноутбук на кафедре — два
         * разных сокета одного человека, и второй узнаёт о правке только так.
         *
         * До карты эхо не применяем: без неё непонятно, к чему приписывать
         * страницу, а карта приедет следом и уже с этой правкой внутри.
         */
        if (message.file === this.notesFile) {
          const next = { ...this.notes }
          // Пустая заметка — это её отсутствие, ровно как в базе: строка из
          // пробелов, оставшаяся в карте, рисует ленту непустой.
          if (message.text) next[message.page] = message.text
          else delete next[message.page]
          this.notes = next
        }
      } else if (message.t === 'ink') {
        this.ink = message.strokes
        this.inkRevision += 1
      } else if (message.t === 'ink:add') {
        /*
         * Дописать точки к штриху с тем же именем — или завести новый.
         *
         * Сервер шлёт только НОВЫЕ точки: штрих в тысячу точек, пересылаемый на
         * каждую двадцатую, — это гигабайты трафика на лекцию.
         */
        const stroke = message.stroke
        const at = this.ink.findIndex((known) => known.id === stroke.id)
        if (at === -1) this.ink = [...this.ink, stroke]
        else {
          const grown = { ...this.ink[at], points: [...this.ink[at].points, ...stroke.points] }
          this.ink = [...this.ink.slice(0, at), grown, ...this.ink.slice(at + 1)]
        }
        this.inkRevision += 1
      } else if (message.t === 'ink:drop') {
        this.ink = this.ink.filter((stroke) => stroke.id !== message.id)
        this.inkRevision += 1
      } else if (message.t === 'ink:clear') {
        const page = message.page
        this.ink = page === null ? [] : this.ink.filter((stroke) => stroke.page !== page)
        this.inkRevision += 1
      } else if (message.t === 'laser') this.laser = message.at
      else if (message.t === 'terminal') this.terminalStatus = message.status
      else if (message.t === 'error') this.lastError = message.message
    }

    socket.onclose = (event: CloseEvent) => {
      window.clearInterval(this.#heartbeat)
      this.#control = null
      this.controlConnected = false
      /*
       * Указка не переживает разрыв.
       *
       * Она — положение руки прямо сейчас, и держится ровно тем, что кадры
       * идут. Оборвалась связь — кадров нет, а красное пятно осталось бы висеть
       * на слайде до конца лекции, показывая туда, где ведущий был минуту
       * назад. Гаснет здесь, а не по таймауту: неподвижная указка кадров не
       * шлёт вовсе, и таймаут погасил бы штатный показ.
       */
      this.laser = null
      if (this.#disposed) return
      /*
       * Забаненному возвращаться некуда: рукопожатие ему откажут, и «Reconnecting»
       * под экраном «вас удалили с занятия» — это две надписи, спорящие друг с
       * другом, плюс стук в дверь раз в восемь секунд до конца дня.
       */
      if (this.banned !== null) return
      /*
       * The server says why when it closes on purpose.
       *
       * A deleted seminar closes with 1001 and a reason, and nobody read
       * either: the browser simply reconnected, was refused, backed off, and
       * spun "RECONNECTING" for the rest of the day in front of a person whose
       * room no longer existed. Reconnecting is right for a network blip and
       * wrong for a room that is gone, and the difference is in this event.
       */
      if (event.code === 1001 && /deleted/i.test(event.reason ?? '')) {
        this.#roomIsGone()
        return
      }
      this.#retries += 1
      /*
       * Протухший ключ выглядит как обрыв связи и не проходит сам.
       *
       * Сервер отказывает в рукопожатии без кода и без слов — сказать их
       * некуда, соединения ещё нет. Браузер отступает и пробует снова, вечно:
       * «RECONNECTING» перед человеком, чей ключ просрочен, и никакого способа
       * это понять. После нескольких неудач спрашиваем сервер обычным
       * запросом — у него есть, чем ответить.
       *
       * И спрашиваем не один раз: сервер, которого перезапускают, недоступен и
       * по HTTP тоже, а `#retries` обнуляется только удачным соединением —
       * одна проба на четвёртой неудаче попадала ровно в те секунды, когда
       * ответить некому, и «Reconnecting» после этого крутился молча до конца
       * дня. Каждая четвёртая — это проба примерно раз в полминуты.
       */
      if (this.#retries % 4 === 0) void this.#diagnose()
      const delay = Math.min(500 * 2 ** Math.min(this.#retries, 5), 8000)
      this.#reconnectTimer = window.setTimeout(() => this.#connectControl(), delay)
    }

    socket.onerror = () => socket.close()
  }

  /**
   * Нас удалили с занятия — закрыть за собой оба провода.
   *
   * Управляющий сокет закроет сервер, а сокет совместной работы про бан не
   * знает и продолжал бы проситься на апгрейд каждые 2,5 с до закрытия вкладки:
   * рукопожатию отказывают, и это ровно тот стук в дверь, ради тишины которого
   * написан `#roomIsGone` ниже.
   *
   * Местная копия НЕ стирается, и это разница с удалённой комнатой: семинар
   * никуда не делся, человека ждут завтра, и его тетрадь — общая работа
   * комнаты, а не улика.
   */
  #youAreBanned(until: number): void {
    if (this.banned !== null) return
    this.banned = until
    this.provider.disconnect()
  }

  /**
   * Комнаты больше нет: закрыть за собой всё, что в неё стучится.
   *
   * Управляющий сокет останавливает сам себя (`return` до отсчёта попыток), а
   * вот сокет совместной работы этого не знает и продолжает проситься на
   * апгрейд каждые 2,5 с до закрытия вкладки — тридцать оставленных открытыми
   * вкладок класса дают серверу дюжину отказов в секунду за пустой экран
   * «Этот семинар удалён». Заодно уходит и местная копия: комната удалена, и
   * кэш, из которого её можно снова смонтировать, — это ложь на диске.
   */
  #roomIsGone(): void {
    if (this.gone) return
    this.gone = true
    this.lastError = 'This seminar was deleted. Nothing here can be saved or reopened.'
    this.provider.disconnect()
    forgetSessionInfo(this.session.id)
    void this.localStore.clear()
  }

  /**
   * Почему нас не пускают — спросить по HTTP, раз сокет молчит.
   *
   * Три случая, и все три надо разделить: комнаты нет (её удалили, пока мы
   * отступали), ключ не годится (истёк или подписан другим секретом — сервер
   * перезапустили с новым), сервер просто недоступен. Последнее — обычный
   * обрыв, и переподключаться правильно; первые два не пройдут никогда.
   */
  async #diagnose(): Promise<void> {
    try {
      await api.getSession(this.session.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) this.#roomIsGone()
      // Всё остальное — сеть; молчим и продолжаем отступать.
      return
    }

    /*
     * Комната есть, а нас не пускают: дело в ключе. Он лежит в этом браузере
     * и в комнате больше не действует — молча починиться нельзя, потому что
     * имя выбирает человек.
     *
     * Поэтому запись о том, кем мы здесь были, стирается, и экран говорит об
     * этом наверх: комната уступает место форме имени. Раньше здесь стояла
     * строка «перезагрузите страницу и назовитесь заново» — совет, который не
     * работал: личность оставалась в хранилище, и перезагрузка приводила в ту
     * же комнату с тем же негодным ключом, и так до ручной чистки браузера.
     */
    forgetIdentity(this.session.id)
    this.expired = true
  }

  send(message: ControlClientMessage) {
    if (this.#control?.readyState === WebSocket.OPEN) {
      this.#control.send(JSON.stringify(message))
    } else if (!DISCARDED_OFFLINE.has(message.t)) {
      // A press already in flight when the socket closed under it. The controls
      // disable themselves the moment `connected` turns false, so this window is
      // about a frame wide — see lib/controls.ts for what it keeps and drops.
      enqueueControl(this.#controlQueue, message)
      // Buttons can be greyed out; a keyboard shortcut cannot. Once the room
      // knows it is disconnected, a Shift+Enter that goes nowhere gets the same
      // sentence the buttons carry instead of silence.
      if (!this.connected) this.lastError = OFFLINE_REASON
    }
  }

  /**
   * Спросить заметки спикера к документу. Звать можно сколько угодно.
   *
   * Защёлка по имени файла, а не по «спрашивали ли уже»: ленту заметок рисует
   * `$effect`, который перезапускается на каждый повод, а вопрос за вопросом на
   * один и тот же документ — это карта на двести страниц, приезжающая по
   * десять раз за минуту. Другой файл проходит защёлку всегда.
   */
  openNotes(file: string): void {
    if (!file || this.#notesWanted === file) return
    this.#notesWanted = file
    /*
     * Прежняя карта уходит вместе с прежним файлом: чужая речь под чужими
     * страницами хуже, чем её отсутствие, а `notesFile = null` — это и есть
     * «ещё не приехали», по которому лента показывает ожидание.
     */
    this.notes = {}
    this.notesFile = null
    this.#askNotes()
  }

  /**
   * Отправить сам вопрос — только по живому сокету, мимо очереди.
   *
   * В очередь его класть нельзя по двум причинам. Она держит шестнадцать
   * сообщений и выбрасывает старые — вопрос вытеснил бы чью-то правку; и она
   * заодно зажигает «нет связи», а подписка, ушедшая в фон, — не то нажатие, о
   * котором человеку надо рассказывать. Обрыв здесь и так закрыт: `onopen`
   * переспрашивает сам.
   */
  #askNotes(): void {
    const file = this.#notesWanted
    if (file === null || this.#control?.readyState !== WebSocket.OPEN) return
    const ask: ControlClientMessage = { t: 'notes:open', file }
    this.#control.send(JSON.stringify(ask))
  }

  /* --------------------------------------------------------------- state */

  /**
   * Выделить одну ячейку — и снять выделение со всех остальных.
   *
   * `null` снимает выделение совсем: до сих пор такого вызова в продукте не
   * было ни одного, и выйти из состояния «выбрано» было нельзя до
   * перезагрузки страницы. Клик мимо ячейки и Escape зовут именно его.
   */
  selectCell(id: string | null) {
    this.selection = id ? [id] : []
    this.#setAnchor(id)
  }

  /**
   * Добавить ячейку к выделению или убрать её оттуда — Cmd (Ctrl) с кликом.
   *
   * Вопрос оракулу про две ячейки — обычное дело на семинаре («почему вот это
   * ломает вот то»), и до сих пор его нельзя было задать иначе как словами.
   */
  toggleCell(id: string) {
    if (this.selection.includes(id)) {
      const rest = this.selection.filter((other) => other !== id)
      this.selection = rest
      // Якорь уходит на последнюю оставшуюся: клавиатуре нужно, откуда шагать.
      if (this.selectedCellId === id) this.#setAnchor(rest.at(-1) ?? null)
      return
    }
    this.selection = [...this.selection, id]
    this.#setAnchor(id)
  }

  /**
   * Растянуть выделение до этой ячейки — Shift с кликом или Shift со стрелкой.
   *
   * Порядок приходит снаружи: он свой у каждой тетради, и знать его здесь
   * неоткуда. Якорь не двигается — от него и меряется диапазон, пока Shift не
   * отпустили.
   */
  extendTo(id: string, order: readonly string[]) {
    const from = this.selectedCellId ? order.indexOf(this.selectedCellId) : -1
    const to = order.indexOf(id)
    if (to === -1) return
    if (from === -1) return this.selectCell(id)
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    this.selection = order.slice(lo, hi + 1)
  }

  /**
   * Кого показывать комнате как «правит ячейку 04».
   *
   * Одну, а не список: присутствие отвечает на вопрос «где человек», а он в
   * один момент времени в одном месте. Кадр не шлётся, если ничего не
   * изменилось, — соседние `setViewing` и `setEditing` делают так же, а
   * `selectCell` до сих пор слал его на каждый повторный клик по той же ячейке.
   */
  #setAnchor(id: string | null) {
    if (this.selectedCellId === id) return
    this.selectedCellId = id
    this.#watchAnchor()
    this.#announceAnchor()
  }

  /** Отписка от ячейки, в которой человек стоит сейчас. */
  #anchorWatch: (() => void) | null = null

  /**
   * Следить за замком той ячейки, в которой стоят.
   *
   * Мелко (`observe`, а не `observeDeep`) и ровно за одной: буквы живут во
   * вложенном Y.Text, и глубокий наблюдатель на тетради просыпался бы на каждое
   * нажатие в комнате. Здесь же события считанные — состояние выполнения да
   * замок, — а нужен из них один: `open`.
   */
  #watchAnchor() {
    this.#anchorWatch?.()
    this.#anchorWatch = null
    const id = this.selectedCellId
    const found = id ? findCell(this.doc, id) : null
    if (!found) return
    const cell = found.cell
    cell.observe(this.#announceAnchor)
    this.#anchorWatch = () => cell.unobserve(this.#announceAnchor)
  }

  /**
   * Сказать комнате, в какой ячейке стоит человек, — если он в ней правит.
   *
   * Выделение и правка разошлись в тот день, когда появился замок: щелчок по
   * закрытой ячейке — это чтение, а комната узнавала из него, что человек её
   * печатает. Что можно, спрашивают там же, где и все остальные кнопки, —
   * `mayEditThisCell` поверх правил сервера; сам выбор при этом остаётся, он
   * местный и в присутствие не едет (см. lib/presence.ts).
   *
   * Зовётся не только на смену якоря: право на ту же самую ячейку меняется под
   * человеком, когда преподаватель щёлкает замком или кончается занятие, — и
   * метка обязана уйти вместе с ним, а не дожидаться следующего щелчка.
   */
  #announceAnchor = () => {
    const may = permitsIn(this.session.rules, this.me.role, this.finished)
    const next = cellToAnnounce(this.doc, this.selectedCellId, may)
    // Кадр не шлётся, если ничего не изменилось: так же делают соседние
    // `setViewing` и `setEditing`, и здесь это ещё важнее — зовут отсюда и
    // наблюдатели, которым до присутствия дела нет.
    const user = this.awareness.getLocalState()?.user as AwarenessUser | undefined
    if ((user?.activeCellId ?? null) === next) return
    this.#patchUser({ activeCellId: next })
  }

  /** Drives the "Sofia is typing a question…" line in the shared thread. */
  setComposing(composing: boolean) {
    this.#patchUser({ composing })
  }

  setInTerminal(inTerminal: boolean) {
    this.#patchUser({ inTerminal })
  }

  /**
   * Где этот человек в документе, который смотрит.
   *
   * Пишется на каждое перелистывание, и это дороже, чем кажется: присутствие —
   * самый болтливый провод в продукте, а прокрутка мышью даёт десятки событий в
   * секунду. Поэтому сюда приходит уже страница, а не пиксель, и вызывающий
   * обязан звать это только когда страница СМЕНИЛАСЬ.
   */
  setViewing(viewing: { file: string; page: number; y: number } | null) {
    const current = (this.awareness.getLocalState()?.user as AwarenessUser | undefined)?.viewing
    if (
      current?.file === viewing?.file &&
      current?.page === viewing?.page &&
      // Доля высоты — дробная: сравнивать точно значит слать кадр на каждый
      // пиксель прокрутки, а присутствие — самый болтливый провод в продукте.
      Math.abs((current?.y ?? 0) - (viewing?.y ?? 0)) < 0.02
    ) {
      return
    }
    this.#patchUser({ viewing })
  }

  /**
   * Какой файл этот человек правит прямо сейчас.
   *
   * Панель файлов рисует по нему точки «кто здесь». Курсоры внутри самого файла
   * сюда не входят вовсе: они живут в присутствии того документа, который
   * открыт, и до комнаты не доходят — иначе каждое нажатие в файле стоило бы
   * кадра присутствия всей комнате.
   */
  setEditing(path: string | null) {
    this.editingPath = path
    const current = (this.awareness.getLocalState()?.user as AwarenessUser | undefined)?.editing
    if ((current ?? null) === path) return
    this.#patchUser({ editing: path })
  }

  #patchUser(patch: Partial<AwarenessUser>) {
    const user = this.awareness.getLocalState()?.user as AwarenessUser | undefined
    if (user) this.awareness.setLocalStateField('user', { ...user, ...patch })
  }

  async refreshFiles() {
    try {
      const res = await api.listFiles(this.session.id, this.token)
      this.files = res.files
      this.filesArrived = true
      this.filesTruncated = res.truncated === true
    } catch {
      /* the control socket pushes the list too; a failed poll is not fatal */
    }
  }

  /**
   * Когда преподаватель в последний раз менял правила комнаты.
   *
   * Метка, а не текст: строку рисует комната, и рисует один раз — по этой
   * метке она сама решает, когда её убрать.
   */
  rulesChangedAt = $state(0)
  /** Приходили ли правила по сокету за жизнь этого состояния. См. разбор `rules`. */
  #rulesArrived = false
  /** То же про конец занятия: первый кадр — не событие. См. разбор `class`. */
  #classArrived = false

  /**
   * Когда занятие закончили или открыли обратно.
   *
   * Такая же метка, как у правил, и по той же причине: строку рисует комната —
   * ей нужен момент, а слова она выберет сама по `finished`.
   */
  classChangedAt = $state(0)

  /**
   * Сервер отказал в правке и закрыл соединение.
   *
   * Дальше без пересборки документа этот браузер нем: у него остались структуры
   * на тактах, которых у сервера нет, и каждый следующий кадр ссылается на них.
   * Подробности и почему это перезагрузка, а не пересборка на месте, — в
   * `lib/refusal.ts`.
   *
   * Не зависит от управляющего сокета: тот переподключается сам по себе, и если
   * бы возврат в согласованное состояние держался на его сообщении, один обрыв
   * оставил бы человека немым навсегда, а заметить это было бы некому.
   */
  #onCollabClose = (event: CloseEvent | null): void => {
    if (this.#disposed || event?.code !== REFUSED_CLOSE) return
    this.#disposed = true
    /*
     * Первым делом — замолчать. Провайдер после закрытия переподключается сам,
     * и каждое переподключение предлагает серверу тот же документ с тем же
     * отказом; пока стирается кэш, это два-три лишних отказа, а если
     * перезагрузок больше нет — отказ каждые три секунды до закрытия вкладки.
     * Сюда же не приходит: закрытие по собственной воле приходит без кода.
     */
    this.provider.disconnect()
    // Слово в кадре закрытия — сервера, и оно надёжнее текста по второму
    // проводу: тот может приехать позже закрытия. См. RefusalNote.kind.
    const stale = event.reason === 'stale'
    const cell = this.selectedCellId ? findCell(this.doc, this.selectedCellId) : null
    const fresh = this.#refusal && Date.now() - this.#refusal.at < 15_000
    stashRefusal({
      sessionId: this.session.id,
      kind: stale ? 'stale' : 'edit',
      // Свежий отказ — тот, что и закрыл соединение; всё, что старше нескольких
      // секунд, пришло по другому поводу и объясняло бы не то.
      message: fresh
        ? this.#refusal!.message
        : stale
          ? 'Кэш этой вкладки разошёлся с сервером — она собрана заново.'
          : 'Эту правку не приняли.',
      text: cell ? cellSource(cell.cell).toString() : '',
      at: Date.now(),
    })
    /*
     * Кэш стирается до перезагрузки: иначе `y-indexeddb` переиграет отказанное
     * при следующем открытии, и всё начнётся заново.
     */
    void this.localStore
      .clear()
      .catch(() => {
        /* хранилище недоступно — перезагрузка всё равно нужна */
      })
      .then(() => {
        /*
         * И только если это не превращается в круг. Перезагрузка лечит вместе с
         * очисткой кэша; если очистка не удалась, отказанное переиграется и всё
         * начнётся заново. Немой браузер плох, вечно перезагружающийся — хуже,
         * поэтому после двух попыток остаёмся на месте, отключёнными, и
         * говорим об этом словами. Дальше — рукой человека: `reloadByHand`.
         */
        if (mayReload()) {
          reloadAfterRefusal()
          return
        }
        this.stuck = stale
          ? 'Кэш этой вкладки разошёлся с сервером, и собрать её заново дважды не вышло. Закройте другие вкладки этой комнаты и перезагрузите страницу.'
          : 'Сервер дважды подряд не принял то, что лежит в этой вкладке. Закройте другие вкладки этой комнаты и перезагрузите страницу.'
      })
  }

  /** Сообщить о том, что сломалось на этой стороне, тем же способом, что и сервер. */
  showError(message: string) {
    this.lastError = message
  }

  dismissError() {
    this.lastError = null
  }

  destroy() {
    this.#disposed = true
    window.clearInterval(this.#heartbeat)
    window.clearTimeout(this.#reconnectTimer)
    // Придержанный черновик не досылается: сокет закрывается следующей строкой,
    // а текст остаётся в редакторе автора — он же черновик и есть.
    this.council.destroy()
    this.#control?.close()
    this.provider.off('status', this.#onStatus)
    this.provider.off('sync', this.#onSync)
    this.provider.off('connection-close', this.#onCollabClose)
    this.awareness.off('change', this.#readPeers)
    this.awareness.off('update', this.#announceSelf)
    this.#anchorWatch?.()
    getTerminal(this.doc).unobserve(this.#onTerminalLines)
    this.undoManager.destroy()
    this.provider.destroy()
    this.localStore.destroy()
    this.doc.destroy()
  }
}

const SESSION_KEY = Symbol('colloq.session')

export function setSessionState(state: SessionState): SessionState {
  return setContext(SESSION_KEY, state)
}

export function getSessionState(): SessionState {
  const state = getContext<SessionState | undefined>(SESSION_KEY)
  if (!state) throw new Error('getSessionState() used outside a mounted session')
  return state
}
