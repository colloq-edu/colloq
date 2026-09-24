/**
 * Presence of ONE cell — for an editor that does not look beyond it.
 *
 * `yCollab` gets the whole of presence, and its remote-caret plugin works like
 * this: on ANY remote frame it dispatches a transaction into its editor, and in
 * `update()` it walks all of `awareness.getStates()` and resolves two relative
 * positions for every remote `cursor`. A notebook has ten to twenty-five
 * editors mounted (EAGER plus a 1200 px margin), and a single remote cursor
 * cost the room "editors × states" resolutions. With five hundred people that
 * is seconds of CPU per second for everyone — even though a remote caret is
 * visible in exactly one cell, the one where that person is.
 *
 * Here the editor is given not the shared presence but a view of it: the local
 * state (the cursor is still written into the real presence, and the room sees
 * it) plus those whose `user.activeCellId` is this cell. `PeerIndex` in
 * lib/yreactive groups avatars by the same field, and it is announced by
 * whoever is EDITING the cell (lib/presence.ts · cellToAnnounce) — that is,
 * exactly by whoever has a caret.
 *
 * The walk over the states is then one per room, not one per editor: the
 * grouping is done by a shared `Room` per presence, which also coalesces frames
 * to one per render. It wakes only the cells where something really changed —
 * the cursor, colour or name of whoever stands in them. The editor gets its
 * frame as a real diff, with the departed in `removed`: otherwise there would
 * be nothing to remove a remote caret with — see `announce`.
 */
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

type State = Record<string, unknown>

/** A frame as the `change` listener of the real presence expects it. */
export interface AwarenessDiff {
  added: number[]
  updated: number[]
  removed: number[]
}

type ChangeHandler = (diff: AwarenessDiff, origin: unknown) => void

/** One person standing in the cell. */
interface Standing {
  clientId: number
  state: State
}

/**
 * Exactly the presence surface that y-codemirror.next uses: `doc.clientID`,
 * `on`/`off('change')`, `getLocalState`, `setLocalStateField`, `getStates`. It
 * asks for nothing else — checked against the plugin's source.
 */
export interface CellAwareness {
  readonly doc: Y.Doc
  readonly clientID: number
  getStates(): Map<number, State>
  getLocalState(): State | null
  setLocalStateField(field: string, value: unknown): void
  on(name: string, handler: ChangeHandler): void
  off(name: string, handler: ChangeHandler): void
  destroy(): void
}

/** Defer work until the next render; returns a cancel function. */
export type Schedule = (run: () => void) => () => void

const NOBODY: Standing[] = []

function browserSchedule(run: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(run, 0)
    return () => clearTimeout(timer)
  }
  const frame = requestAnimationFrame(run)
  return () => cancelAnimationFrame(frame)
}

/**
 * The signature of whoever is standing: everything the plugin draws a caret
 * from.
 *
 * States cannot be compared by reference — presence decodes them anew on every
 * tick, and the object is always new. So by value, and only by the fields that
 * the drawing depends on: position, colour and name.
 *
 * The separators are `\u0000`/`\u0001` as escapes, not as the bytes themselves:
 * people choose their names themselves, and with a space "Pyotr Ilyich" would
 * have merged with the neighbour. The bytes cannot be put into the source as
 * they are — the file becomes binary to `grep` and silently stops turning up
 * when searched for a name.
 */
function markOf(state: State): string {
  const user = state.user as { color?: unknown; name?: unknown } | undefined
  return `${JSON.stringify(state.cursor ?? null)}\u0000${String(user?.color ?? '')}\u0000${String(
    user?.name ?? '',
  )}`
}

function signatureOf(standing: readonly Standing[]): string {
  let out = ''
  for (const person of standing) out += `${person.clientId}\u0000${markOf(person.state)}\u0001`
  return out
}

/** The same snapshot, but per client: the frame's diff is computed from it. */
function marksOf(standing: readonly Standing[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const person of standing) out.set(person.clientId, markOf(person.state))
  return out
}

/**
 * Bookkeeping shared per presence: one walk over the states per frame, and
 * after that only the cells where something changed.
 */
class Room {
  readonly #source: Awareness
  readonly #schedule: Schedule
  /** Cell → listeners of its view. An empty map means "we are unsubscribed". */
  readonly #watchers = new Map<string, Set<() => void>>()
  readonly #standing = new Map<string, Standing[]>()
  readonly #signature = new Map<string, string>()
  #cancel: (() => void) | null = null

  constructor(source: Awareness, schedule: Schedule) {
    this.#source = source
    this.#schedule = schedule
  }

  get empty(): boolean {
    return this.#watchers.size === 0
  }

  watch(cellId: string, onChange: () => void): () => void {
    let set = this.#watchers.get(cellId)
    if (!set) {
      set = new Set()
      this.#watchers.set(cellId, set)
      if (this.#watchers.size === 1) this.#source.on('change', this.#onChange)
      /*
       * The first view is computed immediately and silently: the editor is
       * built and asks for the states in the same frame, and a "changed" frame
       * out of nowhere would make the plugin dispatch a transaction for no
       * reason on every mount.
       */
      const seeded = this.#group().get(cellId) ?? NOBODY
      this.#standing.set(cellId, seeded)
      this.#signature.set(cellId, signatureOf(seeded))
    }
    set.add(onChange)
    return () => {
      const alive = this.#watchers.get(cellId)
      if (!alive) return
      alive.delete(onChange)
      if (alive.size > 0) return
      this.#watchers.delete(cellId)
      this.#standing.delete(cellId)
      this.#signature.delete(cellId)
      if (this.#watchers.size > 0) return
      this.#source.off('change', this.#onChange)
      this.#cancel?.()
      this.#cancel = null
    }
  }

  standing(cellId: string): Standing[] {
    // While nobody is subscribed to the cell there is no snapshot — compute it
    // on the spot: it will be asked for once at most, when the editor is built.
    return this.#standing.get(cellId) ?? this.#group().get(cellId) ?? NOBODY
  }

  #onChange = () => {
    if (this.#cancel) return
    this.#cancel = this.#schedule(() => {
      this.#cancel = null
      this.#regroup()
    })
  }

  /** One pass over all states, notifying only cells where something changed. */
  #regroup(): void {
    const byCell = this.#group()
    for (const [cellId, listeners] of this.#watchers) {
      const next = byCell.get(cellId) ?? NOBODY
      const signature = signatureOf(next)
      if (signature === this.#signature.get(cellId)) continue
      this.#signature.set(cellId, signature)
      this.#standing.set(cellId, next)
      for (const listener of listeners) listener()
    }
  }

  #group(): Map<string, Standing[]> {
    const byCell = new Map<string, Standing[]>()
    const self = this.#source.clientID
    this.#source.getStates().forEach((state, clientId) => {
      if (clientId === self) return
      const user = (state as State).user as { activeCellId?: unknown } | undefined
      const at = user?.activeCellId
      if (typeof at !== 'string' || at === '') return
      const list = byCell.get(at)
      if (list) list.push({ clientId, state: state as State })
      else byCell.set(at, [{ clientId, state: state as State }])
    })
    // The order in which frames arrive is not stable, and the signature is
    // compared as a string: without sorting, a reconnected tab would "change"
    // every cell.
    for (const list of byCell.values()) {
      if (list.length > 1) list.sort((a, b) => a.clientId - b.clientId)
    }
    return byCell
  }
}

const rooms = new WeakMap<Awareness, Room>()

function roomFor(source: Awareness, schedule: Schedule): Room {
  let room = rooms.get(source)
  if (!room) {
    room = new Room(source, schedule)
    rooms.set(source, room)
  }
  return room
}

/**
 * A view of presence through the eyes of one cell.
 *
 * @param schedule — how to defer the coalescing of frames; a render by default.
 * A parameter rather than a constant, for the sake of tests: animation frames
 * never arrive in node.
 */
export function cellAwareness(
  source: Awareness,
  cellId: string,
  schedule: Schedule = browserSchedule,
): CellAwareness {
  const room = roomFor(source, schedule)
  const handlers = new Set<ChangeHandler>()
  let unwatch: (() => void) | null = null
  /**
   * Who was drawn in this cell on the previous frame — and how.
   *
   * The frame has to be a DIFF, not a list of those standing there now. The
   * remote-caret plugin dispatches a transaction only if
   * `added ∪ updated ∪ removed` contains at least one remote client
   * (y-codemirror.next · y-remote-selections), and whoever has left is no
   * longer in the list of those standing: the "who is here" frame arrived EMPTY
   * on their departure, there was no transaction, `update()` did not recompute
   * the decorations — and a caret with someone else's name stayed hanging in
   * the abandoned cell until some unrelated edit in this editor. And one's own
   * typing usually does not happen there at all: that is the whole point of ten
   * to twenty-five mounted editors.
   */
  let seen = new Map<number, string>()

  const announce = () => {
    if (handlers.size === 0) return
    const next = marksOf(room.standing(cellId))
    const added: number[] = []
    const updated: number[] = []
    const removed: number[] = []
    for (const [clientId, mark] of next) {
      const before = seen.get(clientId)
      if (before === undefined) added.push(clientId)
      else if (before !== mark) updated.push(clientId)
    }
    for (const clientId of seen.keys()) if (!next.has(clientId)) removed.push(clientId)
    seen = next
    // Nothing changed — nothing to wake: `Room` never gets here with such a
    // frame, but an empty frame still must not get out.
    if (added.length === 0 && updated.length === 0 && removed.length === 0) return
    const diff: AwarenessDiff = { added, updated, removed }
    for (const handler of [...handlers]) handler(diff, 'cell-awareness')
  }

  return {
    get doc() {
      return source.doc
    },
    get clientID() {
      return source.clientID
    },
    getStates() {
      const out = new Map<number, State>()
      const local = source.getLocalState()
      if (local) out.set(source.clientID, local as State)
      for (const person of room.standing(cellId)) out.set(person.clientId, person.state)
      return out
    },
    getLocalState: () => source.getLocalState() as State | null,
    setLocalStateField: (field, value) => source.setLocalStateField(field, value),
    on(name, handler) {
      if (name !== 'change') return
      handlers.add(handler)
      if (unwatch) return
      unwatch = room.watch(cellId, announce)
      // The plugin builds decorations from `getStates()` right after
      // subscribing, so those standing now are already drawn: the diff is
      // computed from them, not from emptiness.
      seen = marksOf(room.standing(cellId))
    },
    off(name, handler) {
      if (name !== 'change') return
      handlers.delete(handler)
      if (handlers.size > 0) return
      unwatch?.()
      unwatch = null
      seen = new Map()
    },
    destroy() {
      handlers.clear()
      unwatch?.()
      unwatch = null
      seen = new Map()
    },
  }
}
