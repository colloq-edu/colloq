import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { getContext, setContext } from 'svelte'
import { ensureInitialNotebook, getCells, getChat, getMeta, getTerminal } from '@shared/notebook'
import type {
  AwarenessUser,
  ControlClientMessage,
  ControlServerMessage,
  FileEntry,
  Participant,
  SessionInfo,
  TerminalStatus,
} from '@shared/protocol'
import { api, ApiError } from './api'
import { enqueueControl, OFFLINE_REASON } from './controls'
import { countsAsUnread } from './notes'
import type { StoredIdentity } from './identity'
import { bindLocalStore, type LocalStore } from './persistence.svelte'

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
export class SessionState {
  /** Not readonly: the room's rules can change while the seminar is running. */
  session: SessionInfo = $state.raw({} as SessionInfo)
  /** True once the server has said the seminar is gone; stops the reconnect loop. */
  gone = $state(false)
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
  connected = $state(false)
  /**
   * The on-disk copy has been replayed. Until then an empty notebook means
   * "not read yet", not "there is nothing here" — the difference between a
   * skeleton and a wrong empty state.
   */
  hydrated = $state(false)
  peers = $state<Peer[]>([])
  files = $state<FileEntry[]>([])
  /** Cell the local user is working in — drives AI context and the run target. */
  selectedCellId = $state<string | null>(null)
  lastError = $state<string | null>(null)
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

  #control: WebSocket | null = null
  #controlQueue: ControlClientMessage[] = []
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
    })
    this.awareness = this.provider.awareness
    this.undoManager = new Y.UndoManager(getCells(this.doc), {
      // Only undo what this person typed; never yank a peer's work away.
      trackedOrigins: new Set([null, 'local']),
      captureTimeout: 400,
    })

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
    this.connected = status === 'connected'
    // The offline notice is about right now. Leaving it up once the room is back
    // would contradict the header, which has already stopped saying RECONNECTING.
    if (this.connected && this.lastError === OFFLINE_REASON) this.lastError = null
  }

  #onSync = (isSynced: boolean) => {
    if (!isSynced) return
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
      // Новое соединение — новая сеть: прошлый лучший круг про неё ничего не знает.
      this.#bestRtt = Number.POSITIVE_INFINITY
      for (const queued of this.#controlQueue.splice(0)) socket.send(JSON.stringify(queued))
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
        const first = this.session.rules === undefined
        const changed = JSON.stringify(this.session.rules) !== JSON.stringify(message.rules)
        this.session = { ...this.session, rules: message.rules }
        /*
         * И сказать словами — один раз, не на приветственной пачке.
         *
         * Двадцать человек, у которых редакторы вдруг стали «только чтение» без
         * единой фразы, решат, что сломались их ноутбуки. А та же фраза при
         * каждом переподключении — это шум, который перестают читать.
         */
        if (!first && changed) this.rulesChangedAt = Date.now()
        return
      }
      if (message.t === 'refused') {
        // Отказ адресован одному человеку и объясняет, где именно его правка
        // не прошла. Обычный путь — предотвращение; сюда попадают гонка и
        // подделанный клиент.
        this.lastError = message.message
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
      }
      else if (message.t === 'pong') {
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
      }
      else if (message.t === 'files') this.files = message.files
      else if (message.t === 'terminal') this.terminalStatus = message.status
      else if (message.t === 'error') this.lastError = message.message
    }

    socket.onclose = (event: CloseEvent) => {
      window.clearInterval(this.#heartbeat)
      this.#control = null
      if (this.#disposed) return
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
        this.gone = true
        this.lastError = 'This seminar was deleted. Nothing here can be saved or reopened.'
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
       */
      if (this.#retries === 4) void this.#diagnose()
      const delay = Math.min(500 * 2 ** Math.min(this.#retries, 5), 8000)
      this.#reconnectTimer = window.setTimeout(() => this.#connectControl(), delay)
    }

    socket.onerror = () => socket.close()
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
      if (err instanceof ApiError && err.status === 404) {
        this.gone = true
        this.lastError = 'This seminar was deleted. Nothing here can be saved or reopened.'
      }
      // Всё остальное — сеть; молчим и продолжаем отступать.
      return
    }

    /*
     * Комната есть, а нас не пускают: дело в ключе. Он лежит в этом браузере
     * и в комнате больше не действует — второй раз назваться тем же именем
     * можно, а вот молча починиться нельзя, потому что имя выбирает человек.
     */
    this.lastError =
      'Your place in this seminar has expired. Reload the page and type your name again — the notebook is unchanged.'
  }

  send(message: ControlClientMessage) {
    if (this.#control?.readyState === WebSocket.OPEN) {
      this.#control.send(JSON.stringify(message))
    } else if (message.t !== 'ping') {
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

  /* --------------------------------------------------------------- state */

  selectCell(id: string | null) {
    this.selectedCellId = id
    this.#patchUser({ activeCellId: id })
  }

  /** Drives the "Sofia is typing a question…" line in the shared thread. */
  setComposing(composing: boolean) {
    this.#patchUser({ composing })
  }

  setInTerminal(inTerminal: boolean) {
    this.#patchUser({ inTerminal })
  }

  #patchUser(patch: Partial<AwarenessUser>) {
    const user = this.awareness.getLocalState()?.user as AwarenessUser | undefined
    if (user) this.awareness.setLocalStateField('user', { ...user, ...patch })
  }

  async refreshFiles() {
    try {
      const res = await api.listFiles(this.session.id, this.token)
      this.files = res.files
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
    this.#control?.close()
    this.provider.off('status', this.#onStatus)
    this.provider.off('sync', this.#onSync)
    this.awareness.off('change', this.#readPeers)
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
