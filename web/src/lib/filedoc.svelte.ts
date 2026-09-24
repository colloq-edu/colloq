/**
 * An open file in the browser: a Yjs document, a socket to it and a tab count.
 *
 * Every file is its own document and its own connection, set up the moment it
 * was opened and closed when the last tab on it closed. The room does not pay
 * for this: a seminar with no open files holds exactly the two sockets it
 * always held.
 *
 * **There is no local cache here, and that is an important difference from
 * the notebook.** The notebook is stored in IndexedDB because its only copy
 * is in the room, and what was typed offline must not be lost. A file always
 * has a copy: it lies on the seminar's disk, and the kernel and the terminal
 * write to it bypassing any browser. Yesterday's cached text merged into
 * today's file when a tab opens is not saving work but spoiling it: it brings
 * back lines a script rewrote, and does so silently.
 *
 * Hence the rule about refusal too: a socket closed with 4403 no longer
 * reconnects. A CRDT merge is a union, and nothing in the protocol can take
 * back from a client a text the server did not accept; the only honest move
 * is to stop talking and tell the person so.
 *
 * The silence is held by a REASON, though, not forever: the end of a class
 * passes, and a tab that fell silent because of it comes back to life
 * (`reopen`) — otherwise the student sits with a dead file until a page
 * reload, and nobody suggests the reload to them.
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import type { AwarenessUser } from '@shared/protocol'
import { ownChanges, type AwarenessChanges } from './presence'

/** The text inside the file document. There is only one — as in the server module. */
const TEXT_KEY = 'text'

/** The edit was not accepted: a room rule or a forged client. */
const REFUSED = 4403
/** The file is gone, or it does not open as text. */
const MISSING = 4404
/**
 * The file exists, but it is too big to edit.
 *
 * Separate from 4404, because these are different answers to the person: "the
 * file is gone" — close the tab, "the file is a hundred megabytes" — offer to
 * download it or read it from a cell. Both used to arrive as code 4404, and a
 * tab on a live file closed silently.
 */
const TOO_BIG = 4413

/**
 * The room name for one file: the path in base64url.
 *
 * `btoa` works with bytes, not characters — hence TextEncoder: without it
 * `данные/треть.csv` breaks the encoding entirely.
 */
function roomFor(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function wsBase(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}`
}

export class FileDoc {
  readonly path: string
  readonly doc: Y.Doc
  readonly text: Y.Text
  readonly provider: WebsocketProvider
  readonly awareness: Awareness
  readonly undoManager: Y.UndoManager

  /** The socket is open. Typing works without it too — it will catch up. */
  connected = $state(false)
  /**
   * The server has sent what it has.
   *
   * Before that an empty document means "not read yet", not "the file is
   * empty" — and the difference between a placeholder and an untruth is right
   * here: an editor showing emptiness invites typing into it.
   */
  ready = $state(false)
  /** The edit was not accepted — from now on the document is read-only. */
  refused = $state(false)
  /**
   * Why it was not accepted — in the server's words, or `null`.
   *
   * The file socket has no control channel through which the room delivers
   * the refusal phrase, and the only place it fits is the `reason` field of
   * the close frame (server/src/collab/files.ts · refuse). The reasons vary: a
   * room rule, the end of a class, a file that outgrew the ceiling — and for a
   * person whose tab suddenly became "read-only", exactly that difference
   * matters.
   *
   * `null` — the server closed silently (an old one next to a new page): then
   * the tab speaks itself, with its own phrase.
   */
  refusedWhy = $state<string | null>(null)
  /** The file is gone. The tab must be closed, not show emptiness. */
  missing = $state(false)
  /** The file is too big for the editor. The tab stays — with an explanation. */
  tooBig = $state(false)

  #tabs = 0
  #closed = false

  constructor(sessionId: string, path: string, token: string) {
    this.path = path
    this.doc = new Y.Doc()
    this.text = this.doc.getText(TEXT_KEY)
    /*
     * The path goes into the ROOM NAME, not the parameters, and this is not
     * cosmetic.
     *
     * The room name is both the socket address (`/file/<session>/<name>`, by
     * which the server finds the file) and the BroadcastChannel key:
     * `serverUrl + '/' + roomname`, parameters are not part of it. Leave the
     * path as a parameter — and two DIFFERENT files of one seminar, open in two
     * browser tabs, ended up in one channel: edits to `utils.py` were applied
     * to the `train.py` document in the neighbouring tab. Not a refusal and not
     * an error — just someone else's text arriving in the file, and Yjs
     * diligently saved it to disk. The channel is now switched off entirely
     * (see `disableBc` below), but the socket address remains, and files must
     * not be mixed up in it just the same.
     *
     * base64url, because the room name travels in the socket address, and a
     * path can contain both slashes and Cyrillic.
     */
    this.provider = new WebsocketProvider(
      `${wsBase()}/file/${sessionId}`,
      roomFor(path),
      this.doc,
      {
        params: { token },
        connect: true,
        /*
         * No BroadcastChannel — the same argument as for the room
         * (lib/session.svelte.ts). A direct channel between tabs of one browser
         * is a second path by which the document receives what the server did
         * not accept: a tab silenced after 4403 would hand the refused text to
         * its neighbour, and that one would fall silent too. Tabs have a way to
         * converge — through the server, like any two browsers.
         */
        disableBc: true,
      },
    )
    this.awareness = this.provider.awareness
    /*
     * And only one's own presence goes to the server, as in the room.
     *
     * `y-websocket` in its handler sends ALL changed clientIDs in a row: it
     * applies someone else's state itself, awareness reports the change — and
     * the same handler sends it back into the socket it came from. The server
     * rejects this echo (`ownAwareness` in collab/files.ts), but to reject it,
     * it has to parse it: on a shared `utils.py` open across the lecture hall
     * that is the same measured noise as in the room, only on a second wire.
     */
    this.awareness.off('update', this.provider._awarenessUpdateHandler)
    this.awareness.on('update', this.#announceSelf)
    this.undoManager = new Y.UndoManager(this.text, {
      // Only one's own edits are undone: Ctrl+Z does not take away others' work.
      trackedOrigins: new Set([null, 'local']),
      captureTimeout: 400,
    })

    this.provider.on('status', this.#onStatus)
    this.provider.on('sync', this.#onSync)
    this.provider.on('connection-close', this.#onClose)
  }

  /**
   * An outgoing presence frame — only about oneself. See the constructor.
   *
   * A wrapper around the provider's handler, not a replacement for it:
   * everything beyond encoding remains the `y-websocket` protocol.
   */
  #announceSelf = (changes: AwarenessChanges, origin: unknown) => {
    const own = ownChanges(changes, this.doc.clientID)
    if (own) this.provider._awarenessUpdateHandler(own, origin)
  }

  #onStatus = ({ status }: { status: string }) => {
    this.connected = status === 'connected'
  }

  #onSync = (synced: boolean) => {
    if (synced) this.ready = true
  }

  #onClose = (event: CloseEvent | null) => {
    if (event?.code === REFUSED) {
      this.refused = true
      // An empty string means "the server did not say", not a reason: an empty
      // bubble on screen is worse than the tab's own phrase.
      this.refusedWhy = event.reason || null
      this.#hangUp()
    } else if (event?.code === MISSING) {
      this.missing = true
      this.#hangUp()
    } else if (event?.code === TOO_BIG) {
      this.tooBig = true
      this.#hangUp()
    }
  }

  /**
   * Stop reconnecting.
   *
   * `shouldConnect` is what the provider itself looks at when deciding whether
   * to come back up: without it `disconnect()` holds only until its own next
   * timer.
   */
  #hangUp(): void {
    this.provider.shouldConnect = false
    this.provider.disconnect()
  }

  /**
   * The reason is gone — talk to the server again.
   *
   * The same document, not a rebuilt one: a rebuild would mean a new `Y.Doc`
   * under an editor already bound to this one, while the text the server did
   * not accept lies here — and it will go to the server with the very first
   * sync frame, because now it is allowed. If it is not allowed (the silence
   * came not from the class but from a room rule), the server will refuse
   * again, and the tab will return exactly to where it left from — now with
   * the reason that applies at present.
   *
   * `connect()` itself sets `shouldConnect` back — the very field that holds
   * the silence (see `#hangUp`).
   */
  reopen(): void {
    if (this.#closed || !this.refused) return
    this.refused = false
    this.refusedWhy = null
    this.provider.connect()
  }

  /** Who to show the cursor as in this file. */
  setUser(user: AwarenessUser): void {
    this.awareness.setLocalStateField('user', user)
  }

  /** This many tabs are open on this file right now. */
  hold(): void {
    this.#tabs += 1
  }

  release(): boolean {
    this.#tabs -= 1
    return this.#tabs <= 0
  }

  destroy(): void {
    if (this.#closed) return
    this.#closed = true
    this.awareness.off('update', this.#announceSelf)
    this.undoManager.destroy()
    this.provider.destroy()
    this.doc.destroy()
  }
}

/*
 * The open documents of this browser tab. The key is the room and the path:
 * one person is never in two rooms at once, but the tab does not reload when
 * moving between them, and `train.py` in two seminars is two files.
 */
const live = new Map<string, FileDoc>()

function keyOf(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`
}

/**
 * Open a file — or take the one already open.
 *
 * Counts the holders: two tabs on one file (a notebook and an editor side by
 * side, should that ever appear) do not set up two connections and do not
 * tear down the one when closing.
 */
export function holdFile(sessionId: string, path: string, token: string): FileDoc {
  const key = keyOf(sessionId, path)
  const existing = live.get(key)
  if (existing) {
    existing.hold()
    return existing
  }
  const made = new FileDoc(sessionId, path, token)
  made.hold()
  live.set(key, made)
  return made
}

/** Release. The last one closes the connection. */
export function releaseFile(sessionId: string, path: string): void {
  const key = keyOf(sessionId, path)
  const existing = live.get(key)
  if (!existing) return
  if (!existing.release()) return
  live.delete(key)
  existing.destroy()
}

/**
 * Bring back to life the room's files that fell silent after a refusal.
 *
 * Lives here, by the map of open documents, not by the screen with the tabs:
 * the screen knows only what is open right now, while a file whose tab was
 * closed a minute ago could have fallen silent too — it is still alive in
 * this map if a second tab holds it. The room calls this when the server says
 * the class has been resumed (lib/session.svelte.ts, the `class` frame): the
 * cue arrives by itself, and there is no need to poll anything on a timer.
 */
export function reopenRefusedFiles(sessionId: string): void {
  const prefix = keyOf(sessionId, '')
  for (const [key, doc] of live) if (key.startsWith(prefix)) doc.reopen()
}

/** Close everything: the person has left the room. */
export function releaseAllFiles(): void {
  for (const doc of live.values()) doc.destroy()
  live.clear()
}
