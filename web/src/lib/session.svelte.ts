import { setLanguage } from './i18n.svelte'
import { tr } from '@shared/i18n'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { getContext, setContext } from 'svelte'
import {
  cellId,
  cellSource,
  allCellArrays,
  ensureInitialNotebook,
  findCell,
  getCells,
  getChat,
  getMeta,
  getTerminal,
  rootOfCell,
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
import { inkedPages, noteInkedPages, replaceInkPage } from '@/components/lecture/ink'
import { api } from './api'
import { boardGone } from './board'
import { collabBackoff, enqueueControl, OFFLINE_REASON, reconnectDelay } from './controls'
import { applyFilesDelta } from './files-delta'
import { withQueuePosition } from './council-queue'
import { CouncilState } from './council.svelte'
import { reopenRefusedFiles } from './filedoc.svelte'
import { countsAsUnread } from './notes'
import { forgetHelp } from './signature-help'
import {
  forgetIdentity,
  verdictOf,
  verdictOnFailure,
  type EntryVerdict,
  type StoredIdentity,
} from './identity'
import { permitsIn } from './may'
import { cellToAnnounce, ownChanges, type AwarenessChanges } from './presence'
import { nextPeers, peersById, PRESENCE_TICK_MS, type Peer } from './peers'
import { bindLocalStore, forgetSessionInfo, type LocalStore } from './persistence.svelte'
import { syncLocalReplay } from './local-replay-sync'
import {
  mayReload,
  REFUSED_CLOSE,
  refusalHealed,
  reloadAfterRefusal,
  stashRefusal,
  type RefusedCell,
} from './refusal'

export type { Peer }

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
 * Whether these are the same rules — by meaning, not by bytes.
 *
 * The server and the page cache may hold the same thing with a different key
 * order or with a field the old string did not have yet: `readRules` brings
 * both sides to the full set with defaults, and those are what is compared.
 */
function sameRules(a: unknown, b: unknown): boolean {
  const left = readRules(a)
  const right = readRules(b)
  return (Object.keys(left) as (keyof RoomRules)[]).every((key) => left[key] === right[key])
}

/**
 * What is thrown away on a closed socket instead of being queued.
 *
 * The queue is short (16, see controls.ts) and holds presses: a cell run, a
 * kernel restart, a command to the terminal. Lecture frames do not belong in
 * it at all. Ink points live in the wet stroke and are delivered by
 * themselves when the connection returns, and the laser pointer is the hand's
 * position a second ago, with nowhere to deliver it to. Yet a finger produces
 * a dozen of them a second: they filled the queue to the brim and threw out
 * the real presses it exists for.
 *
 * The question about a page's ink (`ink:page`) goes here too, for the same
 * reason: the page is asked for on every redraw, and nobody needs the answer
 * to a question asked while offline — the reconnect brings a fresh inventory,
 * and the question is asked anew against it (components/lecture/ink.ts ·
 * `askInkPage`).
 */
const DISCARDED_OFFLINE = new Set<ControlClientMessage['t']>([
  'ping',
  'ink',
  'ink:page',
  'laser',
  /*
   * Completion and help go here too, for the same reason.
   *
   * The editor asks for them on a keystroke: a sixteen-slot queue would be
   * filled with them within a second and a half of typing, pushing out the
   * cell run it exists for. And there is nowhere to deliver a question about a
   * word finished a minute ago: the promise on this side resolved empty long
   * ago.
   */
  'complete',
  'inspect',
  /*
   * Go-to-definition goes here too, although it has its own argument.
   *
   * It is invoked deliberately and one at a time, it would not fill the queue.
   * But its answer is a screen jump: a question delivered on reconnect would
   * arrive as an answer a minute later and drag the person away from wherever
   * they are working by then. And there is nobody waiting for that answer any
   * more — `#dropAsked` closed the promise back at the disconnect. Like its
   * neighbours, it bypasses `send` over the live socket (`#ask`), and this
   * entry is the place where the rule is put into words: the route has changed
   * twice already, and the rule has not changed once.
   */
  'define',
])

/** The kernel's answer to a completion question — exactly what the editor shows. */
export type CompleteReply = Extract<ControlServerMessage, { t: 'complete:reply' }>
export type InspectReply = Extract<ControlServerMessage, { t: 'inspect:reply' }>
/**
 * The answer to "where is this defined" — the only one of the three computed
 * not by the kernel but by the server itself: parsing Python and walking the
 * seminar folder (protocol.ts · `define`). Hence what arrives in it: a place,
 * not text.
 */
export type DefineReply = Extract<ControlServerMessage, { t: 'define:reply' }>

/**
 * How long we wait for the answer to a completion question.
 *
 * As long as the server waits for the kernel (kernel/jupyter.ts ·
 * SHELL_REQUEST_MS): its timeout refusal must manage to arrive here before
 * ours, otherwise for every question to a busy kernel an entry would be left
 * hanging here, to be closed later by an answer that by then belongs to
 * nobody. Half a second on top — for the trip.
 *
 * Go-to-definition does not need that long: the server itself computes it
 * from the files, and three seconds for it is not a deadline but a fuse — the
 * promise must resolve even when there is no answer at all.
 */
const ASK_TIMEOUT_MS = 3000

/**
 * Help gets a deadline of its own, and a longer one.
 *
 * It has two roads: the live kernel (the same 2.5 s) and a static jedi parse
 * INSIDE the kernel, which since 20 Sep 2026 is given 2.5 s plus the trip
 * (server/src/kernel/index.ts · STATIC_INSPECT_WAIT_MS = 3.5 s). The former
 * three seconds here meant the client hung up before the server could answer:
 * the first hover over pandas showed NOTHING — neither help nor a reason —
 * because the answer arrived at a closed door. Half a second over the server's
 * ceiling — for the trip.
 */
const INSPECT_TIMEOUT_MS = 4000

/** The same ceiling as the server's (control.ts · MAX_COMPLETE_CHARS). */
const MAX_ASK_CHARS = 24 * 1024

/**
 * Twenty-four kilobytes ENDING at the caret.
 *
 * Completion and help work on what precedes it — the bottom of the cell is
 * not needed for that at all, so the beginning is cut: in a long cell the hint
 * is computed from the nearest lines anyway.
 */
function headBeforeCursor(code: string, at: number): { code: string; cursor: number; from: number } {
  const head = code.slice(0, at)
  const sent = head.length > MAX_ASK_CHARS ? head.slice(head.length - MAX_ASK_CHARS) : head
  // `from` is always 0 here: completion and help need no line numbers at all,
  // and the field exists only so that both cuts have the same shape.
  return { code: sent, cursor: sent.length, from: 0 }
}

/**
 * A window AROUND the caret — and this is not nitpicking but the difference
 * between a working jump and a silently broken one.
 *
 * Cutting off the tail, as for completion, is not allowed here: the
 * definition almost always stands BELOW the place it was clicked from.
 * `helper()` on line three with `def helper()` on line thirty is an ordinary
 * cell; the reverse order is rare. On text cut at the caret the server would
 * honestly answer "could not find where it is defined", and the jump would
 * stop working exactly where it is needed most — in a long file.
 *
 * So the code travels whole, and the ceiling triggers only on what does not
 * fit into a frame (control.ts · MAX_FRAME_BYTES — thirty-two kilobytes for
 * the whole message). Then a window around the caret is taken, and the cursor
 * moves by exactly as much as was cut off on the left: off by one character,
 * the server would parse a DIFFERENT name — and lead confidently to the wrong
 * place.
 */
function windowAroundCursor(
  code: string,
  at: number,
): { code: string; cursor: number; from: number } {
  if (code.length <= MAX_ASK_CHARS) return { code, cursor: at, from: 0 }
  // The caret sits mid-window, but at the text's edges the window presses
  // against the edge: moving it past the boundary would send less than fits.
  const half = Math.floor(MAX_ASK_CHARS / 2)
  const start = Math.max(0, Math.min(at - half, code.length - MAX_ASK_CHARS))
  /*
   * `from` travels with the window, and without it the jump lied.
   *
   * The server counts lines from the start of the text it received, while the
   * person sees them from the start of the file: in the live course's
   * `case_cian.py` (886 KB) the window is the rule, and the landing went
   * hundreds of lines off. By this same number the server learns that it does
   * not see the whole source, and fetches the whole thing — it has it.
   */
  return { code: code.slice(start, start + MAX_ASK_CHARS), cursor: at - start, from: start }
}

export class SessionState {
  /** Not readonly: the room's rules can change while the seminar is running. */
  session: SessionInfo = $state.raw({} as SessionInfo)
  /**
   * The class is over: the room is open for reading, the teacher acts.
   *
   * A getter over `session.finishedAt`, because the time interests only those
   * who show it, while everyone else needs a "yes or no" answer — which is
   * exactly what `permitsIn` expects as its third argument.
   */
  get finished(): boolean {
    return this.session.finishedAt !== null
  }
  /** True once the server has said the seminar is gone; stops the reconnect loop. */
  gone = $state(false)
  /**
   * The tab has diverged from the server and no longer retries by itself: in
   * words — why.
   *
   * A refusal is cured by a reload with a cache wipe, and two reloads are
   * allowed (see lib/refusal.ts). After that the tab stands still and stays
   * quiet — it used to stand still and knock: the provider reconnected by
   * itself on its own backoff and offered the server the same document every
   * three seconds, until the tab was closed. Measured on a live room: one tab,
   * twelve refusals a minute, ten minutes, and "Reconnecting" in the header
   * all that time.
   */
  stuck = $state<string | null>(null)
  /**
   * The room exists, but it no longer recognises this browser's key.
   *
   * On seeing this, the screen hands the person over to the name form: such a
   * room does not fix itself — the person chooses the name, not the program.
   * The record of the former identity has already been erased by then (see
   * `#diagnose`).
   */
  expired = $state(false)
  /**
   * We were removed from the class: the moment the ban ends, or null.
   *
   * Separate from `gone` and from `expired`, because this is a third distinct
   * case, and mixing them up is costly. No room — nowhere to work; the key went
   * stale — introduce yourself again; a ban — the room is in place and expects
   * you tomorrow, and right now a person has closed the entrance. Each of the
   * three needs its own words, and `expired` would in addition lead a banned
   * person to the name form — that is, offer to dodge the ban by renaming.
   */
  banned = $state<number | null>(null)
  /**
   * This browser's clock minus the server's clock, in milliseconds.
   *
   * Zero until the first pong answers. Subtracted from the local `Date.now()`
   * wherever things are counted from a server timestamp — currently the
   * stopwatch of a running cell.
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
   * The control socket is open — that is, Run, restart and the terminal will
   * get through.
   *
   * Separate from `collabConnected`, because there are two wires and they come
   * up separately: y-websocket backs off by 2.5 s at most, our own by up to
   * 8 s.
   */
  controlConnected = $state(false)
  /**
   * The room is connected — over BOTH wires.
   *
   * By this field all control buttons (Run, Restart, the terminal) go dark and
   * "Reconnecting" lights up, and it used to hold only the collaboration
   * socket. After a server restart that one comes up first: the label went
   * out, the buttons lit up, presses silently went into the queue and executed
   * a few seconds later — a Run All the person had already decided did not
   * work. Typing works without a connection meanwhile, but typing is the CRDT,
   * and nobody turns that off.
   */
  readonly connected = $derived(this.collabConnected && this.controlConnected)
  /**
   * The on-disk copy has been replayed. Until then an empty notebook means
   * "not read yet", not "there is nothing here" — the difference between a
   * skeleton and a wrong empty state.
   */
  hydrated = $state(false)
  /**
   * The room's file list has arrived at least once.
   *
   * "Not asked yet" and "there are no files" are different things, and mixing
   * them up is costly: the tabs live by this list, and an empty one on the
   * first frame wiped them all.
   */
  filesArrived = $state(false)
  /**
   * The list is not shown in full: the folder walk hit the ceiling.
   *
   * The flag travels next to the list and is replaced with every frame — the
   * server sends `false` explicitly, so "no longer truncated" arrives just as
   * honestly as "truncated". The files panel says so in a line at the bottom
   * of the tree: a person who did not find their file looks for it again and
   * does not guess about the ceiling.
   */
  filesTruncated = $state(false)
  /**
   * The number of the file list we have on hand. Zero — no list at all.
   *
   * A change in the tree travels as a delta (`files:delta`), and a delta lands
   * only on the list it was computed from. The number is the only way to check
   * that: no match — nothing to splice, and the whole tree is asked for. No
   * rune needed here, nobody draws the number.
   */
  #filesRev = 0
  /**
   * Who is in the room — as a snapshot replaced whole, and only when it
   * changed.
   *
   * `$state.raw`, not a deep rune: the list is rebuilt whole, and wrapping five
   * hundred presence objects in proxies on every frame means paying for
   * reactivity nobody uses. What counts as a change and why a frame without
   * changes must reach nobody — see lib/peers.ts.
   */
  peers = $state.raw<readonly Peer[]>([])
  /**
   * A person's face by their participant id — for those who ask "who is this".
   *
   * A map, not a search through the list: every cell with output asks "who ran
   * it", and a scan over five hundred tabs in two hundred cells is work that
   * grows as a product. Recomputed together with `peers`, that is, no more than
   * once per presence tick.
   */
  readonly peersById = $derived(peersById(this.peers))
  files = $state<FileEntry[]>([])
  /**
   * The cell the keyboard and the cursor work with — the selection's anchor.
   *
   * It is always part of `selection` while the selection is not empty. The
   * room sees exactly this one: presence answers the question "where is the
   * person", and a person is in one place at a time.
   */
  selectedCellId = $state<string | null>(null)
  /**
   * All selected cells, in document order.
   *
   * A list, not one: a question to the oracle about two cells is common, and
   * until now it could only be asked in words. The order is kept by whoever
   * selects: each notebook has its own.
   */
  selection = $state<string[]>([])
  /**
   * The file this person has open right now — or `null`.
   *
   * The same path that goes into presence. It is also kept here because the
   * oracle panel must name it in the "especially" line: people almost always
   * ask about what they are looking at.
   */
  editingPath = $state<string | null>(null)
  /**
   * Show the tab that holds this cell.
   *
   * Set by the room screen — only it knows about tabs. A link to a cell comes
   * from the people panel and from the oracle thread, that is, bypassing the
   * notebook, and without this it led into a hidden one: `scrollIntoView`
   * inside `display:none` does nothing, and the jump looked like a broken
   * button.
   */
  showCell: ((cellId: string) => void) | null = null
  lastError = $state<string | null>(null)
  /**
   * The gate's last refusal — with its time, so an old one is not passed off
   * as new.
   *
   * Not `$state`: only the note put aside before a reload reads it, and
   * nothing in the interface depends on it.
   */
  #refusal: { message: string; at: number } | null = null
  /** Shared terminal lifecycle; 'closed' until somebody opens the drawer. */
  terminalStatus = $state<TerminalStatus>('closed')
  /**
   * Whether this instance can give a personal notebook its own kernel.
   *
   * Arrives with the socket's first frame (`ready`). `true` by default — that
   * is what a server that does not know about this field yet would answer, and
   * that is how docker works, that is, everything except the broker. The
   * "Students' personal notebooks" rule row reads it: promising what the
   * instance cannot do means handing a student a refusal in the middle of a
   * class instead of warning the teacher before it.
   */
  ownKernels = $state(true)
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
   * The document the room is watching together, or `null`.
   *
   * Comes from the server — both in the welcome batch and on every change. It
   * lives in the room, not in presence: presence disappears with the tab, and
   * the teacher's closed laptop would take the material away from everyone at
   * once, while a latecomer would see nothing until the teacher moved.
   */
  board = $state<string | null>(null)

  /**
   * The room's lecture: one page on the projector and one person at the
   * console.
   *
   * `null` — no lecture. Comes from the server in the welcome batch and on
   * every change, like the shared screen: a latecomer must see the same page
   * as the hall.
   */
  lecture = $state<LectureState | null>(null)
  /**
   * The lecture's ink, all pages at once.
   *
   * `$state.raw`, not a deeply reactive array: points are appended in batches
   * twenty times a second, and wrapping each in a proxy means paying for
   * reactivity nobody uses — a canvas draws them, not markup. `inkRevision`
   * orders the redraw.
   */
  ink = $state.raw<InkStroke[]>([])
  /** The ink edit counter: the canvas redraws by it, not by the array. */
  inkRevision = $state(0)
  /**
   * The leader's laser pointer, or `null`.
   *
   * Stored nowhere: where it was a second ago is a hand movement, not a fact
   * about the lecture. It goes out by itself when the leader stops moving it.
   */
  laser = $state<{ page: number; x: number; y: number; shape: 'dot' | 'line' } | null>(null)

  /**
   * Speaker notes for `notesFile`: page number → text.
   *
   * `$state.raw` and only whole assignment, as with ink and for the same
   * reason: the notes feed reads the map, not markup by key, and a deep proxy
   * over two hundred pages of speech is a fee for reactivity nobody uses. Only
   * hosts receive it; in the hall this map is always empty.
   */
  notes = $state.raw<Record<number, string>>({})
  /**
   * Whose notes lie in `notes`. `null` — they have not arrived yet.
   *
   * A separate field, not an empty map, and the difference is costly here:
   * "there are no notes for this page" and "the notes have not arrived yet"
   * look the same on screen — empty — but mean opposite things. A teacher who
   * sees emptiness where they wrote twenty lines yesterday will decide they
   * lost them, and will decide it in the middle of a class.
   */
  notesFile = $state<string | null>(null)

  /**
   * The council: one's own attempt, the teacher's stack, the counters — per
   * cell.
   *
   * A separate object, not fields here: the council has as many messages as
   * the whole lecture, and parsing them in one `onmessage` with the ink would
   * make it twice as big again. It sends through the same `send` as the
   * buttons — with the same queue and the same words about a missing
   * connection.
   */
  readonly council: CouncilState

  #control: WebSocket | null = null
  #controlQueue: ControlClientMessage[] = []
  /**
   * The document whose notes we asked for. A latch and also the memory of the
   * subscription.
   *
   * The memory is needed because of reconnects: the server sends notes ONLY in
   * reply to `notes:open`, they are not in the welcome batch — and without
   * re-asking, the very first disconnect would leave the teacher without their
   * speech until the end of the class, showing not an error but emptiness.
   */
  #notesWanted: string | null = null
  #reconnectTimer: number | undefined
  #heartbeat: number | undefined
  #retries = 0
  #disposed = false
  #pingSentAt: number | null = null
  /** The fastest round trip on this connection: the clock correction is taken from it. */
  #bestRtt = Number.POSITIVE_INFINITY
  /**
   * Completion questions to the kernel that have not resolved yet.
   *
   * Each has its own number, and it is also the key: answers arrive in a
   * different order than they were asked, and a late one must be recognised by
   * its number, not by "the last question was this one". The promise ALWAYS
   * resolves — with an answer, a timer or a socket drop — because CodeMirror's
   * autocompletion waits for it on the other side: an unresolved one would
   * mean a list that neither appears nor closes.
   */
  #asked = new Map<number, { settle: (reply: ControlServerMessage | null) => void; timer: number }>()
  #askId = 0

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

    // Attach disk first, but do not assume it resolves before localhost.
    // syncLocalReplay below keeps a late cache replay on the reconciliation
    // path, with the same validation as the initial websocket handshake.
    this.localStore = bindLocalStore(session.id, this.doc)
    void this.localStore.whenSynced.then(() => {
      if (!this.#disposed) this.hydrated = true
    })

    this.provider = new WebsocketProvider(`${wsBase()}/collab`, session.id, this.doc, {
      params: { token: identity.token },
      connect: true,
      /*
       * No BroadcastChannel: neighbouring tabs of one seminar converge through
       * the server, like any two browsers. A direct channel between tabs is a
       * second path by which the document receives what the server did not
       * accept: a tab freshly rebuilt from scratch after a refusal asked its
       * neighbour and got back from it exactly the structures it was rebuilt
       * because of. The presence echo, which the server defended against
       * separately (collab/index.ts · ownAwareness), disappears along with it.
       */
      disableBc: true,
      /*
       * The backoff ceiling is different in every tab (lib/controls.ts ·
       * collabBackoff). By default it is the same for everyone (2500 ms), and
       * five hundred tabs come back in the same millisecond after a server
       * restart — again and again, because their backoff is shared and counted
       * from a shared event.
       */
      maxBackoffTime: collabBackoff(),
    })
    syncLocalReplay(this.provider, this.localStore)
    this.awareness = this.provider.awareness
    /*
     * Only one's own presence goes to the server.
     *
     * The provider's `_awarenessUpdateHandler` sends ALL changed clientIDs in a
     * row: it applies someone else's state itself (`applyAwarenessUpdate` with
     * itself as the origin), awareness reports the change — and the same
     * handler sends it back into the socket it came from. The server rejects
     * this echo (`ownAwareness`), but to reject it, it has to parse it: on a
     * test bench with 500 tabs it was exactly half of sixteen thousand presence
     * frames per second.
     *
     * The provider's handler is removed, ours takes its place and calls the
     * removed one — but with a frame where only our clientID is left (see
     * lib/presence.ts). Encoding, the socket and BroadcastChannel remain the
     * provider's: a filter is no reason to rewrite the protocol.
     *
     * This costs neighbouring tabs nothing — each has its own socket and its
     * own presence from the server, and relaying others' states between tabs
     * of one browser only duplicated what would arrive anyway. Along with it,
     * neighbours leaving on a disconnect stopped being broadcast:
     * `removeAwarenessStates` inside the provider is local cleanup, not news
     * about the room.
     */
    this.awareness.off('update', this.provider._awarenessUpdateHandler)
    this.awareness.on('update', this.#announceSelf)
    this.undoManager = new Y.UndoManager(getCells(this.doc), {
      // Only undo what this person typed; never yank a peer's work away.
      trackedOrigins: new Set([null, 'local']),
      captureTimeout: 400,
    })
    /*
     * Undo reaches all the room's notebooks, not only the first.
     *
     * Notebooks are opened on the fly, and the UndoManager's scope has to be
     * extended as they appear: without this Ctrl+Z in the second notebook would
     * silently do nothing — the worst kind of refusal, because the key did
     * work.
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
    this.awareness.on('change', this.#schedulePeers)
    this.#readPeers()

    // The title is deliberately NOT seeded here. `session.name` is the name the
    // room was created with — the router may be replaying it from cache — while
    // the live title lives in the document and the host may have renamed it.
    // Writing it into a doc that has not replayed yet starts a conflict with a
    // rename this client has never seen, and roughly one merge in two hundred
    // resolves it the wrong way: the seminar silently reverts to its old name
    // for everybody. The header falls back to `session.name` for display, and
    // #onSync seeds the document only once the server confirms it is empty.
    /*
     * And no second request for the file tree.
     *
     * There used to be `refreshFiles()` here — an HTTP request for the same
     * list the control socket sends by itself right after connecting
     * (control.ts · the welcome batch, now from the room's cache). On entry
     * this meant two folder walks instead of one, and with five hundred tabs
     * after a server restart — five hundred extra walks in the same two
     * seconds, exactly when everyone is waiting to get back. An empty list
     * before the first frame is not "there are no files": `filesArrived` says
     * that.
     */
    this.#connectControl()
  }

  #onStatus = ({ status }: { status: string }) => {
    this.collabConnected = status === 'connected'
    this.#backOnline()
  }

  /**
   * The connection is back — remove the line about its absence.
   *
   * Called from both wires: the line hangs while either one is silent, and it
   * must be removed by whichever recovered last. The offline notice is about
   * right now; leaving it up once the room is back would contradict the
   * header, which has already stopped saying RECONNECTING.
   */
  #backOnline() {
    if (this.connected && this.lastError === OFFLINE_REASON) this.lastError = null
  }

  #onSync = (isSynced: boolean) => {
    if (!isSynced) return
    // The server accepted this document — so past refusals no longer mean
    // anything, and the next one, if it comes, gets the right to a reload again.
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
   * An outgoing presence frame — only about oneself. See the constructor.
   *
   * A wrapper around the provider's handler, not a replacement for it:
   * everything beyond encoding remains the `y-websocket` protocol.
   */
  #announceSelf = (changes: AwarenessChanges, origin: unknown) => {
    const own = ownChanges(changes, this.doc.clientID)
    if (own) this.provider._awarenessUpdateHandler(own, origin)
  }

  /** The people-list rebuild is deferred to the end of the tick. See `#schedulePeers`. */
  #peersTimer: number | undefined

  /**
   * A presence frame has arrived — rebuild the people, but no more than once
   * per tick.
   *
   * The cursor is published on every keystroke by each of five hundred, and
   * without coalescing the rebuild ran hundreds of times a second: a walk over
   * all states, a sort of names and a new array that woke all readers of
   * `peers` — the counter in the header, the people panel, the oracle avatars
   * and the "who ran it" lookup in every mounted cell. A hundred-millisecond
   * tick leaves ten rebuilds a second of that, and `nextPeers` lets through
   * only those where what is drawn really changed.
   */
  #schedulePeers = () => {
    if (this.#peersTimer !== undefined || this.#disposed) return
    this.#peersTimer = window.setTimeout(() => {
      this.#peersTimer = undefined
      this.#readPeers()
    }, PRESENCE_TICK_MS)
  }

  #readPeers = () => {
    // `nextPeers` returns THE PREVIOUS array if nothing drawn has changed:
    // assigning the same value to a rune wakes nobody.
    this.peers = nextPeers(this.awareness.getStates(), this.awareness.clientID, this.peers)
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
      // A new connection is a new network: the previous best round trip knows
      // nothing about it.
      this.#bestRtt = Number.POSITIVE_INFINITY
      for (const queued of this.#controlQueue.splice(0)) socket.send(JSON.stringify(queued))
      /*
       * And re-ask for the notes — here, next to draining the queue.
       *
       * The subscription does not survive the connection: notes arrive only in
       * reply to `notes:open`, and a new socket knows nothing about the past
       * question. Our own map is not cleared meanwhile: it has already arrived,
       * a fresh one will overwrite it within a round trip, and resetting it on
       * every Wi-Fi blink means putting "Notes are loading" under the nose of a
       * person who is reading their next sentence off the screen at that
       * moment.
       */
      this.#askNotes()
      const beat = () => {
        if (socket.readyState !== WebSocket.OPEN) return
        this.#pingSentAt = Date.now()
        socket.send(JSON.stringify({ t: 'ping' }))
      }
      // At once, not in twenty-five seconds: the first clock sample is needed
      // before the first cell run, and the first run at a seminar is the very
      // one the whole room is watching.
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
      if (message.t === 'instance:language') {
        setLanguage(message.language)
        return
      }
      if (message.t === 'rules') {
        // Rules change on the fly, and the room must learn at once: a button
        // that has just started refusing reads, without explanation, as a
        // breakage rather than the teacher's decision.
        /*
         * "The first frame" is the first ON THE SOCKET, not "there were no
         * rules yet".
         *
         * The first frame used to be the one with `session.rules === undefined`,
         * and that never happens: the page has rules from the first frame —
         * from the cache or from the OPEN_ROOM default — and the socket's
         * welcome batch in any room with non-open rules differed from them. So
         * every page reload said "the teacher changed what can be done",
         * although nobody changed anything. On top of that the comparison went
         * through JSON.stringify, which cares about key order.
         */
        const first = !this.#rulesArrived
        this.#rulesArrived = true
        const changed = !sameRules(this.session.rules, message.rules)
        this.session = { ...this.session, rules: message.rules }
        /*
         * And say it in words — once, not on the welcome batch.
         *
         * Twenty people whose editors suddenly became "read-only" without a
         * single phrase will decide their laptops broke. And the same phrase on
         * every reconnect is noise people stop reading. On a reconnect the
         * frame is a welcome one too, but by then the rules are already real:
         * if they really changed while there was no connection, it has to be
         * said.
         */
        if (!first && changed) this.rulesChangedAt = Date.now()
        // Along with the rules, what the person may do in the cell they stand in
        // changes too: the "editing this" mark leaves presence at once rather
        // than waiting until they click somewhere else.
        if (changed) this.#announceAnchor()
        return
      }
      if (message.t === 'class') {
        /*
         * The class has ended — or is on again.
         *
         * Separate from the rules and next to them: the stored rules do not
         * change, but the buttons all go dark at once, and without words that
         * reads as a broken laptop rather than the teacher's decision.
         *
         * The "first frame" latch is the same as for the rules, and for the
         * same reason. Until the server answers, the room card guesses "the
         * class is on" (App.svelte · knownRoom): guessing more strictly means
         * dimming live buttons. So in a room whose class ended yesterday, the
         * very first frame differs from the guess, and someone opening the
         * link for the first time heard "the class is over" as if the bell had
         * rung in front of them.
         *
         * There is one latch per room, not per socket — and a reconnect
         * remains an event: a bell that rang while there was no connection the
         * room will still announce.
         *
         * The comparison is by "present or not", not by the time itself: the
         * same timestamp re-sent is not news.
         */
        const first = !this.#classArrived
        this.#classArrived = true
        const wasFinished = this.finished
        this.session = { ...this.session, finishedAt: message.finishedAt }
        const changed = wasFinished !== this.finished
        if (!first && changed) this.classChangedAt = Date.now()
        // And the same about the bell: after it nobody edits, and the mark is
        // about editing.
        if (changed) this.#announceAnchor()
        /*
         * But files come back to life on the first frame too: the latch above
         * is about words said once, while this is a repair, and it has no
         * reason to stay quiet. A file tab closed by a refusal because the
         * class ended does not reconnect by itself (lib/filedoc.svelte.ts) and
         * without this would stay dead until a page reload.
         */
        if (changed && !this.finished) reopenRefusedFiles(this.session.id)
        return
      }
      if (
        message.t === 'council:mine' ||
        message.t === 'council:board' ||
        message.t === 'council:patch' ||
        message.t === 'council:oracle' ||
        message.t === 'council:count' ||
        message.t === 'council:shown' ||
        message.t === 'council:hint:state' ||
        message.t === 'council:kernel' ||
        message.t === 'council:ready'
      ) {
        // Eight council frames — to one parser: it knows whom each is addressed
        // to, and keeps them per cell.
        this.council.receive(message)
        return
      }
      if (message.t === 'council:queue') {
        /*
         * The queue position — as a number, not a whole sheet. With five
         * hundred waiting, one finished run moved everyone's number and cost
         * five hundred sheets with attempt texts (server/src/control.ts ·
         * tellQueued).
         */
        this.council.mine = withQueuePosition(this.council.mine, message.cellId, message.at)
        return
      }
      if (message.t === 'banned') {
        /*
         * We were removed in the middle of a class. The server will close the
         * socket as its next step — the room will not work after that, and
         * pretending it will is not allowed: here and not into a toast,
         * because the person ran into a decision, not an error.
         */
        this.#youAreBanned(message.until)
        return
      }
      if (message.t === 'refused') {
        // A refusal is addressed to one person and explains where exactly their
        // edit did not get through. The usual path is prevention; a race and a
        // forged client end up here.
        this.lastError = message.message
        // And separately — for the note the person will read after the reload:
        // `lastError` holds ANY last error and does not go out by itself (the
        // toast is closed with a cross), so a refusal from ten minutes ago would
        // explain to the person something other than what they just ran into.
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
         * A correction to the browser's clock, taken from the round trip.
         *
         * `startedAt` on a cell is server time, and the stopwatch ticks here.
         * Without a correction, for someone whose clock is forty seconds fast a
         * just-started cell shows "40.0s", and for someone whose clock is slow
         * — a frozen "0.0s" on a running cell.
         *
         * Half the round trip is the usual estimate: we assume the answer took
         * as long as the question. Without averaging and without picking the
         * minimal sample: the error is bounded by half the round trip, which is
         * noticeably less than the tenth of a second the counter shows.
         */
        const sent = this.#pingSentAt
        if (sent !== null) {
          const rtt = Date.now() - sent
          /*
           * The best sample wins, not the latest.
           *
           * The "half the round trip" estimate is right exactly as far as the
           * way there resembles the way back. On a mobile network the round
           * trip wanders from a hundred milliseconds to a second, and taking
           * every new sample means jerking the correction by half a second in
           * both directions — and the stopwatch shown to the room at that
           * moment grows out of it. It would run backwards.
           *
           * The shorter the round trip, the less room it has for skew, so the
           * best sample is the fastest. The minimum is reset on every new
           * connection: the network may have become a different one meanwhile.
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
        this.#filesRev = message.rev ?? 0
        /*
         * A file may be deleted or rewritten right during the class: the
         * teacher deletes, and any cell can rewrite — `df.to_csv` goes into the
         * same folder. A reader left on a document that does not exist is an
         * empty area without explanation. What the file list proves about this
         * and what it does not is in lib/board.ts: a truncated one used to
         * throw the hall out of the lecture.
         */
        if (boardGone(this.board, message.files, this.filesTruncated)) this.board = null
      } else if (message.t === 'files:delta') {
        /*
         * A change in the tree — instead of the whole tree.
         *
         * The full list cost a room of five hundred people 3.0 MB per new file
         * (measured), and everything edits the folder: the editor's autosave,
         * `df.to_csv` in a cell, `pip install` in the terminal.
         *
         * A delta is spliced only onto the list of the number it was computed
         * from. No match — nothing to splice, and instead of a guess a question
         * is asked: a gap happens when someone entering recomputed the tree for
         * an empty room, and it is cured by one full frame, not by a spoiled
         * panel.
         */
        if (this.#filesRev !== message.from) {
          this.send({ t: 'files:ask' })
          return
        }
        this.files = applyFilesDelta(this.files, message)
        this.#filesRev = message.rev
        this.filesArrived = true
        // Only an untruncated tree is described by deltas (control.ts ·
        // deltaFrame), so the truncation is lifted here along with it.
        this.filesTruncated = false
        if (boardGone(this.board, this.files, false)) this.board = null
      } else if (message.t === 'board') this.board = message.open
      else if (message.t === 'lecture') {
        const before = this.lecture
        this.lecture = message.state
        // The lecture has ended — and its ink with it: the server has already
        // forgotten it.
        if (!message.state) {
          this.ink = []
          this.inkRevision += 1
          this.laser = null
        }
        /*
         * And the inventory too — together with the ink and together with a
         * NEW lecture.
         *
         * The inventory lives longer than an `ink` frame: it speaks of pages
         * the tab does not have on hand. The lecture ended or another one
         * began — the previous inventory knows nothing about its pages, while
         * the console counts sheets by it: two sheets of the previous lecture
         * would stand empty in the new one's strip, and the arrows would lead
         * through them until a reconnect. The sign of a new one is its start
         * time: re-entering the same lecture comes with the same one.
         */
        if (!message.state || message.state.startedAt !== before?.startedAt) {
          noteInkedPages(this, [])
        }
        /*
         * But the notes are not cleared. They live in the database and are tied
         * to the FILE, not to the lecture: the same speech fits a second
         * lecture on the same document a week later, and preparation when
         * there is no lecture at all.
         */
      } else if (message.t === 'notes') {
        /*
         * The answer to our question — and only to the last one. While the map
         * was on its way, the console may have moved to another document, and
         * an old one arriving would silently overwrite the new one.
         */
        if (message.file === this.#notesWanted) {
          this.notes = message.notes
          this.notesFile = message.file
        }
      } else if (message.t === 'notes:one') {
        /*
         * The echo of a single edit — one's own or a second teacher's. It also
         * comes to whoever made it: the console on a tablet and the laptop in
         * the department are two different sockets of one person, and the
         * second learns about the edit only this way.
         *
         * The echo is not applied before the map: without it, it is unclear
         * what to attribute the page to, and the map will arrive next with this
         * edit already inside.
         */
        if (message.file === this.notesFile) {
          const next = { ...this.notes }
          // An empty note is its absence, just as in the database: a string of
          // spaces left in the map draws the feed as non-empty.
          if (message.text) next[message.page] = message.text
          else delete next[message.page]
          this.notes = next
        }
      } else if (message.t === 'ink') {
        /*
         * A FULL replacement — however many pages ride in the frame.
         *
         * The server decides how many: the welcome batch carries the current
         * page, names the rest in an inventory (`ink:pages`) and hands them out
         * on request. The tab does not guess how this frame differs from the
         * inventory — "everything has arrived" cannot be concluded from it
         * alone, and that is exactly why the inventory travels separately.
         */
        this.ink = message.strokes
        this.inkRevision += 1
      } else if (message.t === 'ink:page') {
        /*
         * The ink of ONE page: a replacement of that page's strokes, and only
         * those.
         *
         * An empty list is a legitimate answer "the page is clean", not a lost
         * frame: without it a tab that asked about a clean sheet would wait for
         * ink until the end of the lecture. The replacement rule itself is a
         * single copy, in the same place as the question and the inventory
         * (lecture/ink.ts · `replaceInkPage`).
         */
        this.ink = replaceInkPage(this.ink, message.page, message.strokes)
        this.inkRevision += 1
      } else if (message.t === 'ink:pages') {
        /*
         * The INVENTORY of inked pages — what the ink itself no longer holds.
         *
         * lecture/ink.ts keeps it: the question about a missing page and the
         * memory of asked ones live there too. The edit counter moves together
         * with it because the thumbnail strip and the count of clean sheets are
         * redrawn by it, and the inventory changes exactly those.
         */
        noteInkedPages(this, message.pages)
        this.inkRevision += 1
      } else if (message.t === 'ink:add') {
        /*
         * Append the points to the stroke with the same name — or start a new
         * one.
         *
         * The server sends only NEW points: a thousand-point stroke re-sent on
         * every twentieth point is gigabytes of traffic per lecture.
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
        const had = this.ink.some((stroke) => stroke.page === message.page)
        this.ink = this.ink.filter((stroke) => stroke.id !== message.id)
        /*
         * The page's last stroke was erased — it is no longer inked.
         *
         * Only if we had its ink: a page not on hand is still unknown after
         * this frame, and striking it from the inventory would mean declaring
         * someone else's markup clean.
         */
        if (had && !this.ink.some((stroke) => stroke.page === message.page)) {
          this.#forgetInkedPage(message.page)
        }
        this.inkRevision += 1
      } else if (message.t === 'ink:clear') {
        const page = message.page
        this.ink = page === null ? [] : this.ink.filter((stroke) => stroke.page !== page)
        // "Erase" is about everyone, not about what we have on hand: the page is
        // clean for the hall, and it has no place in the inventory. Otherwise
        // the console would count sheets by it until the end of the lecture,
        // and the strip would draw an empty thumbnail.
        if (page === null) noteInkedPages(this, [])
        else this.#forgetInkedPage(page)
        this.inkRevision += 1
      } else if (
        message.t === 'complete:reply' ||
        message.t === 'inspect:reply' ||
        message.t === 'define:reply'
      ) {
        /*
         * The answer finds whoever asked by the number — and only them.
         *
         * While a person types, there can be three questions on the wire at
         * once, and answers arrive in any order: a kernel busy with a cell
         * stays silent on the second and answers the fourth. Without a number
         * the editor would show a list for text no longer in the cell.
         *
         * Go-to-definition is handled by the same table. It needs the number no
         * less: a click on a second name before the answer about the first
         * arrived would take the person somewhere they no longer asked for. And
         * exactly one of three things must resolve its promise — this answer,
         * the timer or a drop (`#dropAsked`): otherwise the wait on the other
         * side never ends, and the next click on the same name does nothing at
         * all.
         */
        const waiting = this.#asked.get(message.id)
        if (waiting) {
          this.#asked.delete(message.id)
          window.clearTimeout(waiting.timer)
          waiting.settle(message)
        }
      } else if (message.t === 'laser') this.laser = message.at
      else if (message.t === 'terminal') this.terminalStatus = message.status
      else if (message.t === 'error') this.lastError = message.message
      /*
       * Whether this instance can give a personal notebook its own kernel.
       *
       * By this word the "Students' personal notebooks" rule row tells the
       * truth: on the broker (k3s) a personal notebook has no kernel of its
       * own yet at all, and promising otherwise means letting the teacher turn
       * on something that does not work and learn about it from a student in
       * the middle of a class. A missing field means an old server, and then
       * the former silence.
       */
      else if (message.t === 'ready' && message.ownKernels !== undefined) {
        this.ownKernels = message.ownKernels
      }
    }

    socket.onclose = (event: CloseEvent) => {
      window.clearInterval(this.#heartbeat)
      this.#control = null
      this.controlConnected = false
      this.#dropAsked()
      /*
       * The laser pointer does not survive a disconnect.
       *
       * It is the hand's position right now, and it is held up exactly by the
       * frames flowing. The connection dropped — no frames, and the red dot
       * would stay hanging on the slide until the end of the lecture, pointing
       * where the leader was a minute ago. It goes out here, not by a timeout:
       * a motionless pointer sends no frames at all, and a timeout would put
       * out a normal showing.
       */
      this.laser = null
      if (this.#disposed) return
      /*
       * A banned person has nowhere to come back to: the handshake will be
       * refused, and "Reconnecting" under the "you were removed from the
       * class" screen is two labels arguing with each other, plus a knock on
       * the door every eight seconds until the end of the day.
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
       * A stale key looks like a dropped connection and does not go away by
       * itself.
       *
       * The server refuses the handshake with no code and no words — there is
       * nowhere to say them, there is no connection yet. The browser backs off
       * and tries again, forever: "RECONNECTING" in front of a person whose key
       * has expired, and no way to understand it. After a few failures we ask
       * the server with an ordinary request — it has something to answer with.
       *
       * And we ask more than once: a server being restarted is unreachable
       * over HTTP too, and `#retries` is reset only by a successful connection
       * — a single probe on the fourth failure landed exactly in the seconds
       * when there was nobody to answer, and after that "Reconnecting" spun
       * silently until the end of the day. Every fourth failure means a probe
       * roughly once every half minute.
       */
      if (this.#retries % 4 === 0) void this.#diagnose()
      // A backoff with jitter: why five hundred tabs come back in the same
      // milliseconds without it is in lib/controls.ts · reconnectDelay.
      const delay = reconnectDelay(this.#retries)
      this.#reconnectTimer = window.setTimeout(() => this.#connectControl(), delay)
    }

    socket.onerror = () => socket.close()
  }

  /**
   * We were removed from the class — close both wires behind us.
   *
   * The server will close the control socket, but the collaboration socket
   * knows nothing about the ban and would keep asking for an upgrade every
   * 2.5 s until the tab closed: the handshake is refused, and that is exactly
   * the knocking on the door that `#roomIsGone` below was written to silence.
   *
   * The local copy is NOT erased, and that is the difference from a deleted
   * room: the seminar has not gone anywhere, the person is expected tomorrow,
   * and their notebook is the room's shared work, not evidence.
   */
  #youAreBanned(until: number): void {
    if (this.banned !== null) return
    this.banned = until
    this.provider.disconnect()
    /*
     * And cancel the control socket's already scheduled attempt.
     *
     * We learn about a ban in two ways: the `banned` frame over a live socket
     * and the answer to `api.me` — and the second arrives AFTER onclose has
     * scheduled the next attempt. Without this line the tab would knock once
     * more on the door just closed to it and get a 403 on the handshake.
     */
    window.clearTimeout(this.#reconnectTimer)
  }

  /**
   * The room no longer exists: close behind us everything that knocks on it.
   *
   * The control socket stops by itself (`return` before counting attempts),
   * but the collaboration socket does not know this and keeps asking for an
   * upgrade every 2.5 s until the tab closes — a class's thirty tabs left open
   * give the server a dozen refusals a second for an empty "This seminar was
   * deleted" screen. The local copy goes too: the room is deleted, and a
   * cache from which it could be mounted again is a lie on disk.
   */
  #roomIsGone(): void {
    if (this.gone) return
    this.gone = true
    this.lastError = tr('room.ui.1172')
    this.provider.disconnect()
    forgetSessionInfo(this.session.id)
    void this.localStore.clear()
  }

  /**
   * Why we are not let in — ask over HTTP, since the socket is silent.
   *
   * FOUR cases, and all four must be told apart: the room does not exist (it
   * was deleted while we were backing off), the teacher closed the entrance,
   * the key is no good (expired, or signed with another secret — the server
   * was restarted with a new one), the server is simply unreachable. The last
   * is an ordinary drop, and reconnecting is right; the first three will not
   * pass by themselves.
   *
   * We ask WITH THE KEY (`api.me`), not with an anonymous `getSession`. An
   * anonymous answer knows nothing about the key, and all that was left was to
   * count any upgrade refusal with HTTP alive as a stale key. Because of that
   * a banned person read "the seat has expired" after a reload, their identity
   * was erased for good, and the next day they entered the room as a new
   * participant: council attempts, authorship in the oracle feed and the row
   * in the people list stayed with a person who no longer existed, and the
   * teacher's list got a duplicate name.
   */
  async #diagnose(): Promise<void> {
    let verdict: EntryVerdict
    try {
      verdict = verdictOf(await api.me(this.session.id, this.token))
    } catch (err) {
      verdict = verdictOnFailure(err)
    }

    // "I don't know" is a drop: stay quiet and keep backing off. The breakdown
    // of all four outcomes and the cost of mixing them up is in
    // lib/identity.ts · EntryVerdict.
    if (verdict.why === 'unknown') return
    if (verdict.why === 'gone') return this.#roomIsGone()
    if (verdict.why === 'banned') {
      /*
       * A person has closed the entrance. There is a screen for this, and it
       * erases nothing: the seminar is in place, the person is expected
       * tomorrow — and tomorrow they must enter as themselves, not as a new
       * participant.
       */
      return this.#youAreBanned(verdict.until)
    }

    /*
     * The room exists but we are not let in: it is the key. It lies in this
     * browser and no longer works in the room — it cannot be fixed silently,
     * because the person chooses the name.
     *
     * So the record of who we were here is erased, and the screen reports it
     * upwards: the room gives way to the name form. There used to be a line
     * here "reload the page and introduce yourself again" — advice that did
     * not work: the identity stayed in storage, and the reload led into the
     * same room with the same bad key, and so on until the browser was cleaned
     * by hand.
     */
    forgetIdentity(this.session.id)
    this.expired = true
  }

  send(message: ControlClientMessage) {
    /*
     * Anything about to be computed wipes the help memory.
     *
     * The kernel's answer about a name is remembered for a minute
     * (lib/signature-help.ts), and that is right exactly until the moment
     * something is executed in the kernel: `df` became different, a function
     * was redefined, an import finally went through. One place is chosen, and
     * the narrowest: a cell run, a council run and a kernel restart leave from
     * here, whoever pressed them — a cell, a notebook, a console or command
     * mode.
     */
    if (message.t === 'run' || message.t === 'restart' || message.t === 'council:run') forgetHelp()
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
   * Ask the room's kernel what to complete at this place in the code.
   *
   * `null` — "there will be no hint": the socket is closed, the right is not
   * given, the kernel is silent or there is none at all. There is deliberately
   * no separate word about the reason here — there would be nowhere and no
   * reason to show it, and on such an answer the editor substitutes words
   * from the cell itself (CodeEditor.svelte · localWords).
   *
   * Bypassing the `send` queue: it has sixteen slots and holds PRESSES. A
   * completion question goes only over a live socket — see `#askNotes`, the
   * same fork and the same arguments are there.
   */
  complete(code: string, cursor: number, cellId?: string): Promise<CompleteReply | null> {
    return this.#ask('complete', code, cursor, cellId) as Promise<CompleteReply | null>
  }

  /** Help about what is under the caret — by the same rules as above. */
  inspect(code: string, cursor: number, cellId?: string): Promise<InspectReply | null> {
    return this.#ask('inspect', code, cursor, cellId) as Promise<InspectReply | null>
  }

  /**
   * One line about a value: the type and size of what is under the pointer.
   *
   * The same frame as for help, with the `brief` flag — and the same road
   * bypassing the queue. The difference is in the answer: the kernel is not
   * started for it, nothing is guessed statically, and `null` simply means
   * "there will be no line".
   */
  brief(code: string, cursor: number, cellId?: string): Promise<InspectReply | null> {
    return this.#ask('inspect', code, cursor, cellId, undefined, true) as Promise<InspectReply | null>
  }

  /**
   * Where the name under the caret is defined — the third question of the
   * same shape and on the same road, but it is answered by the server, not
   * the kernel.
   *
   * It parses Python itself (shared/python-defs.ts) and searches the room's
   * notebooks and the .py files of the seminar folder. Hence two things the
   * neighbours do not have: the jump works without a running kernel — for
   * someone who has just opened the notebook — and the right here is not "the
   * right to run" but the right to read.
   *
   * `path` — the file clicked in, if it is not a cell: the server counts
   * relative imports (`from . import util`) from it. The neighbours do not need
   * this field at all — they ask the kernel, and the kernel has its own
   * current directory.
   *
   * `null` — there will be no answer: the socket is closed or the three
   * seconds ran out. Unlike completion, silence here is visible to the person
   * — they made the gesture deliberately — and what to tell them is decided by
   * lib/goto.svelte.ts, not the editor.
   */
  define(
    code: string,
    cursor: number,
    cellId?: string,
    path?: string,
  ): Promise<DefineReply | null> {
    return this.#ask('define', code, cursor, cellId, path) as Promise<DefineReply | null>
  }

  /**
   * The shared half of all three questions: the number, the text ceiling, the
   * timer, the send.
   *
   * The twenty-four-kilobyte ceiling stands both here and on the server. Here
   * — because a console frame is cut at thirty-two (control.ts ·
   * MAX_FRAME_BYTES), and a cell someone thought to fill with a novel would
   * otherwise get, on every letter, not a hint but a "message too long" toast.
   *
   * But HOW it is cut differs for the jump: completion is satisfied with the
   * text up to the caret, the jump needs all of it — see `headBeforeCursor`
   * and `windowAroundCursor`. This is the only fork on the whole road, and for
   * its sake there is one `kind === 'define'` further on rather than a second
   * identical method: the number, the timer, the `#asked` entry and the
   * handling of a drop must be the same for all three — diverging, they give a
   * hung promise, not a visible error.
   */
  #ask(
    kind: 'complete' | 'inspect' | 'define',
    code: string,
    cursor: number,
    /**
     * Where the question comes from — and this is about the RIGHT, not about
     * parsing.
     *
     * One's own council sheet is the only cell where a student has the right
     * to complete even in a lecture room (control.ts · mayComplete). Without
     * the cell name the server does not know about it and refuses silently:
     * names in the sheet came from the cell's own words, but the columns of the
     * real `df` did not.
     */
    cellId?: string,
    /**
     * The file the question comes from — and only `define` has this field.
     *
     * The neighbours ask the KERNEL, and it has its own current directory; the
     * server looks for a definition in the seminar folder, and
     * `from . import util` means "next to THIS file" — without a path the dot
     * has nothing to count from.
     */
    path?: string,
    /** We ask not for help but for a line about the value — see `brief`. */
    brief?: boolean,
  ): Promise<ControlServerMessage | null> {
    const socket = this.#control
    if (socket?.readyState !== WebSocket.OPEN) return Promise.resolve(null)
    const at = Math.max(0, Math.min(cursor, code.length))
    const sent = kind === 'define' ? windowAroundCursor(code, at) : headBeforeCursor(code, at)
    const id = ++this.#askId
    return new Promise<ControlServerMessage | null>((resolve) => {
      const timer = window.setTimeout(
        () => {
          this.#asked.delete(id)
          resolve(null)
        },
        kind === 'inspect' ? INSPECT_TIMEOUT_MS : ASK_TIMEOUT_MS,
      )
      this.#asked.set(id, { settle: resolve, timer })
      try {
        /*
         * One literal instead of a branch per optional field: `cellId` and
         * `path` come separately, and there would be four branches.
         * `JSON.stringify` does not write a property whose value is undefined
         * at all, so the wire carries exactly the former frame — without a cell
         * name for whoever did not give one.
         */
        socket.send(
          JSON.stringify({
            t: kind,
            id,
            code: sent.code,
            cursor: sent.cursor,
            cellId,
            path,
            brief,
            // Only for the jump and only when the window really cut: the
            // neighbours have no such field, and `undefined` does not get into
            // the frame.
            from: kind === 'define' && sent.from > 0 ? sent.from : undefined,
          }),
        )
      } catch {
        // The socket closed between the check and the send — the usual race of
        // a tab going to the background. The promise must resolve anyway.
        this.#asked.delete(id)
        window.clearTimeout(timer)
        resolve(null)
      }
    })
  }

  /**
   * The connection dropped — resolve everything we were waiting for from the
   * kernel.
   *
   * There will never be an answer over a dead socket, and the timer would
   * resolve the question in three seconds: all that time the cell's
   * autocompletion would stand open and empty. It is cheaper to say "no" at
   * once.
   */
  #dropAsked(): void {
    const waiting = [...this.#asked.values()]
    this.#asked.clear()
    for (const { settle, timer } of waiting) {
      window.clearTimeout(timer)
      settle(null)
    }
  }

  /**
   * Ask for the speaker notes of a document. May be called as often as you
   * like.
   *
   * A latch on the file name, not on "have we asked already": the notes feed
   * is drawn by an `$effect` that reruns on every occasion, and question after
   * question about the same document means a two-hundred-page map arriving
   * ten times a minute. Another file always passes the latch.
   */
  openNotes(file: string): void {
    if (!file || this.#notesWanted === file) return
    this.#notesWanted = file
    /*
     * The previous map leaves with the previous file: someone else's speech
     * under someone else's pages is worse than none, and `notesFile = null` is
     * exactly the "not arrived yet" by which the feed shows the wait.
     */
    this.notes = {}
    this.notesFile = null
    this.#askNotes()
  }

  /**
   * Send the question itself — only over a live socket, bypassing the queue.
   *
   * It must not go into the queue for two reasons. The queue holds sixteen
   * messages and throws out old ones — the question would push out someone's
   * edit; and it also lights up "no connection", while a subscription gone to
   * the background is not a press the person needs to be told about. A drop is
   * covered here anyway: `onopen` re-asks by itself.
   */
  #askNotes(): void {
    const file = this.#notesWanted
    if (file === null || this.#control?.readyState !== WebSocket.OPEN) return
    const ask: ControlClientMessage = { t: 'notes:open', file }
    this.#control.send(JSON.stringify(ask))
  }

  /**
   * Strike a page from the inventory: there is no ink on it any more.
   *
   * Through `inkedPages`, not by editing the list: the server's inventory and
   * the pages on hand are two sources, and neither is complete (see
   * lecture/ink.ts). We take their union without the struck page — that is
   * all the tab knows about inked pages after "erase".
   */
  #forgetInkedPage(page: number): void {
    noteInkedPages(this, [...inkedPages(this)].filter((known) => known !== page))
  }

  /* --------------------------------------------------------------- state */

  /**
   * Select one cell — and clear the selection from all the others.
   *
   * `null` clears the selection entirely: until now the product had not a
   * single such call, and the "selected" state could not be left until a page
   * reload. A click outside a cell and Escape call exactly this.
   */
  selectCell(id: string | null) {
    this.selection = id ? [id] : []
    this.#setAnchor(id)
  }

  /**
   * Add a cell to the selection or remove it from there — Cmd (Ctrl) with a
   * click.
   *
   * A question to the oracle about two cells is common at a seminar ("why does
   * this break that"), and until now it could only be asked in words.
   */
  toggleCell(id: string) {
    if (this.selection.includes(id)) {
      const rest = this.selection.filter((other) => other !== id)
      this.selection = rest
      // The anchor moves to the last remaining one: the keyboard needs a place
      // to step from.
      if (this.selectedCellId === id) this.#setAnchor(rest.at(-1) ?? null)
      return
    }
    this.selection = [...this.selection, id]
    this.#setAnchor(id)
  }

  /**
   * Extend the selection up to this cell — Shift with a click or Shift with an
   * arrow.
   *
   * The order comes from outside: each notebook has its own, and there is
   * nowhere to learn it here. The anchor does not move — the range is measured
   * from it until Shift is released.
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
   * Which cell to show the room as "editing cell 04".
   *
   * One, not a list: presence answers the question "where is the person", and
   * a person is in one place at any one moment. No frame is sent if nothing
   * changed — the neighbouring `setViewing` and `setEditing` do the same, and
   * `selectCell` used to send one on every repeated click on the same cell.
   */
  #setAnchor(id: string | null) {
    if (this.selectedCellId === id) return
    this.selectedCellId = id
    this.#watchAnchor()
    this.#announceAnchor()
  }

  /** The unsubscribe from the cell the person is standing in now. */
  #anchorWatch: (() => void) | null = null

  /**
   * Watch the lock of the cell being stood in.
   *
   * Shallow (`observe`, not `observeDeep`) and on exactly one: the letters live
   * in a nested Y.Text, and a deep observer on the notebook would wake on
   * every keystroke in the room. Here the events are few — the execution state
   * and the lock — and only one of them is needed: `open`.
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
   * Tell the room which cell the person is standing in — if they are editing
   * it.
   *
   * Selecting and editing parted ways the day the lock appeared: a click on a
   * closed cell is reading, yet the room learned from it that the person was
   * typing there. What is allowed is asked in the same place as for all the
   * other buttons — `mayEditThisCell` over the server's rules; the selection
   * itself stays, it is local and does not go into presence (see
   * lib/presence.ts).
   *
   * Called not only when the anchor changes: the right to the very same cell
   * changes under the person when the teacher clicks the lock or the class
   * ends — and the mark must leave with it rather than waiting for the next
   * click.
   */
  #announceAnchor = () => {
    /*
     * The rights are asked of this cell's NOTEBOOK: in their own notebook a
     * student types even in the middle of a lecture, and they should have the
     * "editing here" mark — while in someone else's personal notebook they
     * must not have it even with an open room.
     */
    const id = this.selectedCellId
    const may = permitsIn(this.session.rules, this.me.role, this.finished, {
      root: id ? rootOfCell(this.doc, id) : null,
      participantId: this.me.id,
    })
    const next = cellToAnnounce(this.doc, id, may)
    // No frame is sent if nothing changed: the neighbouring `setViewing` and
    // `setEditing` do the same, and here it matters even more — observers that
    // do not care about presence call this too.
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
   * Where this person is in the document they are viewing.
   *
   * Written on every page turn, and that costs more than it seems: presence is
   * the chattiest wire in the product, and scrolling with a mouse gives dozens
   * of events a second. So what arrives here is already a page, not a pixel,
   * and the caller must call this only when the page HAS CHANGED.
   */
  setViewing(viewing: { file: string; page: number; y: number } | null) {
    const current = (this.awareness.getLocalState()?.user as AwarenessUser | undefined)?.viewing
    if (
      current?.file === viewing?.file &&
      current?.page === viewing?.page &&
      // The height share is fractional: comparing exactly means sending a frame
      // on every pixel of scrolling, and presence is the chattiest wire in the product.
      Math.abs((current?.y ?? 0) - (viewing?.y ?? 0)) < 0.02
    ) {
      return
    }
    this.#patchUser({ viewing })
  }

  /**
   * Which file this person is editing right now.
   *
   * The files panel draws the "who is here" dots by it. Cursors inside the file
   * itself are not included at all: they live in the presence of the document
   * that is open and do not reach the room — otherwise every keystroke in the
   * file would cost the whole room a presence frame.
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

  /**
   * When the teacher last changed the room's rules.
   *
   * A mark, not text: the room draws the line, and draws it once — by this
   * mark it decides by itself when to remove it.
   */
  rulesChangedAt = $state(0)
  /** Whether rules arrived over the socket in this state's lifetime. See the `rules` branch. */
  #rulesArrived = false
  /** The same for the end of class: the first frame is no event. See the `class` branch. */
  #classArrived = false

  /**
   * When the class was ended or reopened.
   *
   * The same kind of mark as for the rules, and for the same reason: the room
   * draws the line — it needs the moment, and it chooses the words itself by
   * `finished`.
   */
  classChangedAt = $state(0)

  /**
   * The server refused an edit and closed the connection.
   *
   * From here on, without rebuilding the document, this browser is mute: it
   * is left with structures at clock ticks the server does not have, and every
   * following frame refers to them. Details, and why this is a reload rather
   * than an in-place rebuild, are in `lib/refusal.ts`.
   *
   * It does not depend on the control socket: that one reconnects on its own,
   * and if the return to a consistent state hinged on its message, one drop
   * would leave the person mute forever, with nobody to notice.
   */
  /**
   * A snapshot of all cells of all notebooks — id and text, as this tab sees
   * them.
   *
   * Only for the refusal note: there it is the only way not to silently lose
   * what was typed without a connection. Expensive — a walk over the notebook
   * and joining every Y.Text — and it is called exactly once, before the cache
   * is cleared.
   */
  #allCells(): RefusedCell[] {
    const snapshot: RefusedCell[] = []
    for (const cells of allCellArrays(this.doc)) {
      for (const cell of cells) {
        const id = cellId(cell)
        if (typeof id !== 'string' || !id) continue
        snapshot.push({ id, text: cellSource(cell).toString() })
      }
    }
    return snapshot
  }

  #onCollabClose = (event: CloseEvent | null): void => {
    if (this.#disposed || event?.code !== REFUSED_CLOSE) return
    this.#disposed = true
    /*
     * First of all — go quiet. After a close the provider reconnects by
     * itself, and every reconnect offers the server the same document with the
     * same refusal; while the cache is being wiped that is two or three extra
     * refusals, and if no reloads are left — a refusal every three seconds
     * until the tab is closed. It does not come back here: a voluntary close
     * arrives without a code.
     */
    this.provider.disconnect()
    // The word in the close frame is the server's, and it is more reliable than
    // text over the second wire: that may arrive after the close. See RefusalNote.kind.
    const stale = event.reason === 'stale'
    const cell = this.selectedCellId ? findCell(this.doc, this.selectedCellId) : null
    const fresh = this.#refusal && Date.now() - this.#refusal.at < 15_000
    stashRefusal({
      sessionId: this.session.id,
      kind: stale ? 'stale' : 'edit',
      // A fresh refusal is the one that closed the connection; anything older than
      // a few seconds came for another reason and would explain the wrong thing.
      message: fresh
        ? this.#refusal!.message
        : stale
          ? tr('room.ui.940')
          : tr('room.ui.1173'),
      text: cell ? cellSource(cell.cell).toString() : '',
      /*
       * And all the typed text next to it — of all the room's notebooks.
       *
       * The gate's refusal applies to the FRAME, and a frame after a drop is
       * everything the person typed without the network: the product allows
       * typing offline on purpose. While the note held a single cell (the one
       * with the cursor), edits in the others left with the cache one line
       * below — silently. A notebook is kilobytes, and checking them against
       * the server's copy after the reload is cheaper than guessing what
       * exactly did not make it (`stillLost`).
       */
      cells: this.#allCells(),
      at: Date.now(),
    })
    /*
     * The cache is wiped before the reload: otherwise `y-indexeddb` would
     * replay the refused edit on the next open, and it would all start again.
     */
    void this.localStore
      .clear()
      .catch(() => {
        /* storage is unavailable — a reload is needed anyway */
      })
      .then(() => {
        /*
         * And only if this does not turn into a loop. A reload cures together
         * with the cache wipe; if the wipe failed, the refused edit is replayed
         * and it all starts again. A mute browser is bad, one that reloads
         * forever is worse, so after two attempts we stay put, disconnected,
         * and say so in words. After that — by the person's hand:
         * `reloadByHand`.
         */
        if (mayReload()) {
          reloadAfterRefusal()
          return
        }
        this.stuck = stale
          ? tr('room.ui.1174')
          : tr('room.ui.1175')
      })
  }

  /** Report what broke on this side the same way the server does. */
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
    // A held draft is not delivered: the socket closes on the next line, and the
    // text stays in the author's editor — which is the draft anyway.
    this.council.destroy()
    this.#control?.close()
    this.provider.off('status', this.#onStatus)
    this.provider.off('sync', this.#onSync)
    this.provider.off('connection-close', this.#onCollabClose)
    this.awareness.off('change', this.#schedulePeers)
    window.clearTimeout(this.#peersTimer)
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
