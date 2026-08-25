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
import { api } from './api'
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
  readonly session: SessionInfo
  readonly me: Participant
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

  #control: WebSocket | null = null
  #controlQueue: ControlClientMessage[] = []
  #reconnectTimer: number | undefined
  #heartbeat: number | undefined
  #retries = 0
  #disposed = false

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
    getTerminal(this.doc)

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
  }

  #onSync = (isSynced: boolean) => {
    // Fallback only: the server seeds a fresh document before anyone can connect.
    if (isSynced) ensureInitialNotebook(this.doc, this.session.name)
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
      for (const queued of this.#controlQueue.splice(0)) socket.send(JSON.stringify(queued))
      this.#heartbeat = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' }))
      }, 25_000)
    }

    socket.onmessage = (event) => {
      let message: ControlServerMessage
      try {
        message = JSON.parse(event.data as string) as ControlServerMessage
      } catch {
        return
      }
      if (message.t === 'files') this.files = message.files
      else if (message.t === 'terminal') this.terminalStatus = message.status
      else if (message.t === 'error') this.lastError = message.message
    }

    socket.onclose = () => {
      window.clearInterval(this.#heartbeat)
      this.#control = null
      if (this.#disposed) return
      this.#retries += 1
      const delay = Math.min(500 * 2 ** Math.min(this.#retries, 5), 8000)
      this.#reconnectTimer = window.setTimeout(() => this.#connectControl(), delay)
    }

    socket.onerror = () => socket.close()
  }

  send(message: ControlClientMessage) {
    if (this.#control?.readyState === WebSocket.OPEN) {
      this.#control.send(JSON.stringify(message))
    } else if (message.t !== 'ping') {
      // A run pressed during a blip should still happen once we are back.
      this.#controlQueue.push(message)
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
      const res = await api.listFiles(this.session.id)
      this.files = res.files
    } catch {
      /* the control socket pushes the list too; a failed poll is not fatal */
    }
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
