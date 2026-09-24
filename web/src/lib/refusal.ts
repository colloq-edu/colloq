/**
 * What a browser does when its edit is refused.
 *
 * The gate on the server does not apply a refused frame — and the browser is
 * left with structures at clock ticks the server does not have. Everything the
 * person types after that refers to them, and the server refuses every
 * following frame: one press of a button that should not exist in this room —
 * and the browser is mute until the end of the class, silently.
 *
 * The protocol cannot remove a structure from a client: a CRDT merge is a
 * union, and neither `encodeStateAsUpdate` nor a full step1/step2 round trip
 * will remove refused text from the screen of whoever typed it. So the
 * document must be rebuilt — and with it a new clientID obtained, which is
 * what cures the gap in the clock ticks.
 *
 * A page reload, not an in-place rebuild. An in-place rebuild would have to
 * recreate the `Y.Doc`, all roots, the local store, the provider, awareness,
 * the UndoManager, every `yreactive` observer and every CodeMirror editor —
 * and all this in a situation that happens once a semester and has by
 * definition already gone wrong. A reload does the same thing, whole and
 * surely correct. The price is losing the scroll position and the cursor; it
 * is paid by someone who has to stop and read the message anyway.
 *
 * The refused text is saved until the reload and shown after it: "here is
 * what you wrote". Otherwise a reload is a silent erasure of someone's work,
 * which is no better than a silently mute browser.
 */

/** The collaboration socket's close code that means an edit was refused. */
export const REFUSED_CLOSE = 4403

const KEY = 'colloq.refused'
const TRIES = 'colloq.refused.tries'
/** Set exactly between a refusal `reload()` and the next page load. */
const AUTO = 'colloq.refused.auto'

/**
 * How many times in a row one tab agrees to reload because of a refusal.
 *
 * A reload cures only together with clearing the cache: if `clear()` failed —
 * a private window, storage blocked — `y-indexeddb` replays the refused edit,
 * the server refuses again, and the page starts reloading in a loop. A
 * neighbouring tab of the same seminar does the same: it hands the refused
 * structure back over BroadcastChannel without getting a refusal itself.
 * A mute browser is bad; a browser that reloads forever is worse.
 */
const MAX_RELOADS = 2

/**
 * How long a connection must live to count as healthy.
 *
 * Not "until sync arrives": the server's SyncStep2 arrives in reply to our
 * SyncStep1, that is, SURELY before the server parses our SyncStep2 with the
 * refused structure and closes the socket. Resetting the count on sync wiped
 * the streak on every lap of the loop, and the fuse never tripped once. A
 * refusal arrives within one round trip; a connection that has lived ten
 * seconds has already survived the refusal.
 */
const STABLE_MS = 10_000

/**
 * When the connection first came alive in this page load.
 *
 * A module variable, not storage, and that matters: a reload resets it —
 * exactly what is needed to measure the life of THIS visit.
 */
let aliveSince: number | null = null

/**
 * Agree to one more reload — or refuse and stay put.
 *
 * The streak is broken by time lived, not by sync arriving (see STABLE_MS), so
 * a second refusal half an hour later is a first one again, while a second one
 * a second later is a loop.
 */
export function mayReload(): boolean {
  const healed = aliveSince !== null && Date.now() - aliveSince >= STABLE_MS
  // The connection has just shown itself in a poor light: it can no longer be
  // considered healthy until the next sync.
  aliveSince = null
  let tries = 0
  try {
    tries = healed ? 0 : Number(sessionStorage.getItem(TRIES) ?? '0') || 0
    sessionStorage.setItem(TRIES, String(tries + 1))
  } catch {
    // No storage — then there is nothing to replay either: the reload will work.
    return true
  }
  return tries < MAX_RELOADS
}

/** The connection came up. It becomes healthy once it has held for STABLE_MS. */
export function refusalHealed(): void {
  if (aliveSince === null) aliveSince = Date.now()
}

/** A reload because of a refusal — with a mark, so the next load recognises it. */
export function reloadAfterRefusal(): void {
  try {
    sessionStorage.setItem(AUTO, '1')
  } catch {
    /* no storage — and no streak */
  }
  window.location.reload()
}

/**
 * The page has loaded. If not because of a refusal, the person reloaded it
 * themselves, and the streak starts over.
 *
 * The streak lives in sessionStorage, that is, it survives reloads of the
 * same tab — by design, otherwise the loop could not be noticed. But for the
 * same reason a tab that had once used up its reloads stayed without them for
 * good: the person pressed "reload", the refusal repeated, and instead of
 * reloading the tab stood still again, because the count was still stuck at
 * two. A reload by hand is the person's decision, and it outranks the counter.
 */
export function beginVisit(): void {
  try {
    const auto = sessionStorage.getItem(AUTO)
    sessionStorage.removeItem(AUTO)
    if (!auto) sessionStorage.removeItem(TRIES)
  } catch {
    /* no storage — nothing to count */
  }
}

/** The person decided to reload themselves — with the count started over. */
export function reloadByHand(): void {
  try {
    sessionStorage.removeItem(TRIES)
  } catch {
    /* no storage */
  }
  window.location.reload()
}

/**
 * One cell, as this tab saw it at the moment of the refusal.
 *
 * The gate refuses THE WHOLE FRAME, and a frame after a dropped connection is
 * everything the person typed without the network, in all cells at once: the
 * product allows typing offline on purpose. While a single cell went into the
 * note — the one with the cursor — the others left silently with the cache,
 * that is, exactly the "silent erasure of someone's work" the header of this
 * file is afraid of.
 */
export interface RefusedCell {
  /** The cell, to check it after the reload against what the server accepted. */
  id: string
  /** The text as this tab had it before the cache was cleared. */
  text: string
}

export interface RefusalNote {
  sessionId: string
  /**
   * An edit was refused — or the tab's cache on entry.
   *
   * The server calls the second `stale` in the close frame: it did not get
   * someone's edit, it got the tab's whole cache, and usually it is not the
   * person's fault. After the reload this is not a "this edit was not
   * accepted" window but a line at the bottom — unless typed text was lost
   * along with the cache.
   */
  kind: 'edit' | 'stale'
  /** The server's phrase — why it was not accepted. */
  message: string
  /** What the person wrote in the cell they were editing, if it was an edit. */
  text: string
  /**
   * All the notebook's cells at the moment of the refusal — so that there is
   * something to check against after the reload. May be absent: an old note,
   * or the snapshot did not fit into storage (see `stashRefusal`).
   */
  cells?: RefusedCell[]
  at: number
}

/**
 * What in the note is really lost — by checking against the document the
 * server accepted.
 *
 * The reload rebuilds the tab from the server's copy, and almost everything in
 * the snapshot is already there: showing a person forty cells, thirty-nine of
 * which are in place, hides the one that the whole thing was about. The text
 * differs or the cell is gone — so what was typed in it did not make it.
 *
 * `sourceOf` answers `null` when the cell is not in the document at all. This
 * may be called only AFTER syncing with the server: before that the document
 * is empty, and emptiness means "not read yet", not "the server did not
 * accept this".
 */
export function stillLost(
  note: RefusalNote,
  sourceOf: (cellId: string) => string | null,
): RefusedCell[] {
  const cells = note.cells ?? []
  return cells.filter((cell) => cell.text.trim() !== '' && sourceOf(cell.id) !== cell.text)
}

/**
 * Whether the note has text worth showing in a window.
 *
 * A separate function, because this is asked in two places and the answer must
 * be one: while it was computed as `note.text !== ''`, a cache refusal with the
 * cursor outside the cells showed as a line at the bottom — even when offline
 * edits lay in three other cells.
 */
export function refusalHasText(note: RefusalNote): boolean {
  return note.text !== '' || (note.cells?.length ?? 0) > 0
}

/**
 * Put the note aside until the reload.
 *
 * `sessionStorage`, not `localStorage`: the note is about this tab and this
 * minute, and in another tab of the same seminar it would be a lie.
 */
export function stashRefusal(note: RefusalNote): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(note))
    return
  } catch {
    /* no storage at all, or the notebook snapshot did not fit — see below */
  }
  /*
   * It did not fit — write down at least the cell where the cursor was.
   *
   * A snapshot of all cells is kilobytes, but a notebook of two hundred cells
   * with long code outputs can hit the tab's quota. Losing because of that
   * even the note that used to fit is the worst of outcomes: the person would
   * be left without a single word about what happened.
   */
  try {
    const { cells: _dropped, ...small } = note
    sessionStorage.setItem(KEY, JSON.stringify(small))
  } catch {
    /* a private window or blocked storage: no note, but the reload still happens */
  }
}

/** Take the note — exactly once. */
export function takeRefusal(sessionId: string): RefusalNote | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const note = JSON.parse(raw) as RefusalNote
    if (note.sessionId !== sessionId) return null
    // An old note is from a previous visit to the same tab; showing it now would
    // mean explaining to the person something they no longer remember.
    if (typeof note.at !== 'number' || Date.now() - note.at > 60_000) return null
    return {
      ...note,
      kind: note.kind === 'stale' ? 'stale' : 'edit',
      text: typeof note.text === 'string' ? note.text : '',
      // There may be no snapshot at all — a note from a previous build or one that
      // did not fit into storage; an empty list and its absence mean the same here.
      cells: Array.isArray(note.cells)
        ? note.cells.filter(
            (cell): cell is RefusedCell =>
              typeof cell?.id === 'string' && typeof cell?.text === 'string',
          )
        : [],
    }
  } catch {
    return null
  }
}
