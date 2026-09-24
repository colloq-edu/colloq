/**
 * What is open in the middle of the screen.
 *
 * Everything is a file, notebooks included: the notebook stopped being a
 * special tab nailed down in first place and became what it really is — a
 * file that opens as cells. The room's first notebook opens by itself on the
 * first visit; after that it is closed and opened like any other file.
 *
 * Three rules make up this whole model.
 *
 * **Nothing open is a state, not a breakage.** Having closed the last tab,
 * the person sees an empty center and a hint on the left. This state did not
 * exist before, because the notebook could not be closed.
 *
 * **The shared document is a tab for everyone.** It comes from the server and
 * appears for everyone, including those who joined in the middle of a class.
 * Whoever the rule allows can close it for the room; the rest can only move
 * away from it, and the tab stays where it is.
 *
 * **Your own tabs survive a reload — together with the one that was open.**
 * The list of paths AND the shown tab live in localStorage next to the panel
 * state. Remembering just the list was exactly half the job: after F5 the tab
 * row was drawn in full, but the center of the screen was empty, and a person
 * in the middle of a class went looking for their notebook in the file panel
 * all over again. The file may no longer exist — then the tab quietly
 * disappears at the very first file list; that is exactly what should happen,
 * which is why it is checked not when reading from storage but against the
 * list (`settle`).
 */

/** Tab key: a file path, or `null` — nothing is open. */
export type TabKey = string | null

/** What the person left in the room last time. */
export interface Remembered {
  /** Their own tabs, in the order they were opened. */
  open: string[]
  /** Which of them was shown. */
  active: TabKey
}

/** The room as the tabs see it: what it has and what it is looking at. */
export interface Room {
  /** Paths that really exist in the room: files plus notebooks. */
  alive: ReadonlySet<string>
  /** The room's notebook: it is opened for someone who is here for the first time. */
  firstBook: string | null
  /**
   * The document on the shared screen — `null` if the room is not looking at
   * anything.
   *
   * The lecture is the same thing: `lecture:start` on the server puts the
   * document on the board BEFORE starting (the rule "the board is gone — the
   * lecture is over" rests precisely on the file being one and the same).
   */
  board: string | null
  /**
   * The `alive` list is not complete: the folder walk hit the cap.
   *
   * The difference is costly: "this file is not in the room" and "this file
   * did not fit in the list" look the same here — a missing entry — but mean
   * opposite things. Weeding happens only against the FULL list: otherwise a
   * student who unpacked a three-thousand-file dataset would close tabs for
   * the whole room (server/src/workspace.ts · MAX_ENTRIES).
   *
   * Optional: a caller that does not know about the cap behaves as before —
   * it treats the list as complete.
   */
  truncated?: boolean
}

const STORE_PREFIX = 'colloq.tabs.'
/**
 * A cap on the saved tab list — a safety fuse, not a rule.
 *
 * It used to be twelve, and that cut silently: in a live room all thirteen
 * files were open, and after F5 the thirteenth was gone — and it looked not
 * like a rule but like a loss. Meanwhile nothing limited opening via
 * `open()`, so the limit acted in exactly one place — the one where it cannot
 * be told to anyone.
 *
 * Two hundred is not "this many tabs happen" but "this many paths are cheap
 * to keep": records do get corrupted and bloated, and reading an endless
 * list from storage is not an option. No one will reach this number under
 * any circumstances, and the tab row becomes unreadable long before it.
 */
const MAX_REMEMBERED = 200

/**
 * Where a person lands on returning to the room.
 *
 * Pulled out of the class and touches neither storage nor runes: there are
 * three rules here that break silently and in different ways, and all of
 * them must be checked — without a browser.
 *
 *   • We remember — we return them to the same place. That is the whole
 *     point of the record.
 *   • The room is watching a document — that beats memory. Someone late for
 *     a lecture lands in the lecture, not in their notebook: the hall is
 *     already looking at a slide, and showing them cells would leave them
 *     without the thing being talked about.
 *   • The file is gone — the tab is gone. The notebook may have been removed
 *     while the person was away, and there is no point resurrecting it as an
 *     empty area without explanation; we move to the leftmost survivor, not
 *     to an empty center.
 *
 * `saved === null` — the person is here for the first time: the room's
 * notebook is opened for them. "Closed everything" differs from this by an
 * empty list in storage, and reopening the notebook for them would cancel
 * their own decision on every visit.
 */
export function restore(saved: Remembered | null, room: Room): Remembered {
  // Weeding only against the full list: a truncated one is no evidence of a
  // loss (see `Room.truncated`), and the decision about where the person
  // landed is made once and for all.
  const gone = (path: string) => !room.truncated && !room.alive.has(path)
  const open = saved
    ? [...new Set(saved.open)].filter((path) => !gone(path)).slice(0, MAX_REMEMBERED)
    : room.firstBook
      ? [room.firstBook]
      : []
  /*
   * The board comes from the server and stands in the row pinned: it does not
   * become one of the person's OWN tabs — it is not in `open`, and it cannot
   * be closed locally.
   *
   * It is still recorded as the shown tab, like any other (`#remember` writes
   * `active` as is): someone returning to a room that is still watching the
   * same document lands on it — and if the room is no longer watching
   * anything, the remembered path simply will not be found among their own
   * tabs, and the person goes to the leftmost one.
   */
  if (room.board) return { open, active: room.board }
  const wanted = saved ? saved.active : room.firstBook
  return { open, active: wanted && open.includes(wanted) ? wanted : (open[0] ?? null) }
}

/**
 * The row of one's own tabs after a drag.
 *
 * A pure function, because it decides one thing: WHERE the tab landed — and
 * that is the only thing worth checking. The same technique as dragging files
 * in the tree (lib/tree-move.ts): the decision separately, the mouse
 * separately.
 *
 * The insertion rule is "the side it came from". Dragged left — the tab goes
 * BEFORE the target, right — AFTER it. Otherwise the gesture half fails: the
 * tab is dragged onto its right neighbor, but lands before it, i.e. back in
 * its own place, and the person drags again.
 *
 * `onto === null` — dropped into the empty space right of the row: that is
 * "to the end". A target that is not among one's own tabs is pinned by the
 * room (shared screen, lecture): their order is not ours, and taking "its
 * place" means going first among one's own, right after the pinned ones.
 */
export function reordered(
  mine: readonly string[],
  dragged: string,
  onto: string | null,
): string[] {
  const from = mine.indexOf(dragged)
  if (from === -1 || dragged === onto) return [...mine]
  const rest = mine.filter((path) => path !== dragged)
  if (onto === null) return [...rest, dragged]
  const to = mine.indexOf(onto)
  if (to === -1) return [dragged, ...rest]
  const at = rest.indexOf(onto)
  return from > to
    ? [...rest.slice(0, at), dragged, ...rest.slice(at)]
    : [...rest.slice(0, at + 1), dragged, ...rest.slice(at + 1)]
}

export class Tabs {
  /** Paths this person opened, in the order they were opened. */
  mine = $state<string[]>([])
  /** What is shown now. `null` — nothing is open. */
  active = $state<TabKey>(null)

  readonly #key: string
  /** What was in storage on entry. `null` — the person is in this room for the first time. */
  readonly #saved: Remembered | null
  /** The decision about where the person landed has already been made. */
  #settled = false

  constructor(sessionId: string) {
    this.#key = STORE_PREFIX + sessionId
    this.#saved = read(this.#key)
    /*
     * Tabs appear on the very first frame, without waiting for the server: the
     * file list takes a network round trip, while the tab row and the center
     * of the screen are needed right away — that is what the record exists
     * for. Anything no longer in the room will be removed by `settle`.
     */
    this.mine = this.#saved?.open ?? []
    this.active = this.#saved?.active ?? null
  }

  /**
   * The full tab row: the ones pinned by the room, then one's own.
   *
   * The notebook is not singled out here — it stopped being a special tab (see
   * the module header) and comes in `mine` like any other file. The pinned
   * ones are the shared screen and the lecture; the caller names them.
   */
  row(...pinned: (string | null)[]): string[] {
    /*
     * Pinned are the ones the room opened for everyone: the shared screen and
     * the lecture. They come first and are not duplicated by someone who
     * opened the same file for themselves: one tab per file, whoever created
     * it.
     */
    const first = pinned.filter((path): path is string => typeof path === 'string' && path !== '')
    const seen = new Set(first)
    return [...new Set(first), ...this.mine.filter((path) => !seen.has(path))]
  }

  /** Open a file and switch to it. One that is already open just becomes current. */
  open(path: string): void {
    if (!this.mine.includes(path)) this.mine = [...this.mine, path]
    this.#goto(path)
  }

  /** Show a tab without opening anything new. */
  show(key: TabKey): void {
    this.#goto(key)
  }

  /**
   * Remove a tab for oneself.
   *
   * Returns whether it stayed in the row: the shared document cannot be closed
   * just for oneself — it can only be closed for the whole room, and that is
   * a separate action with a separate permission. Moving away from it to the
   * notebook is still possible, and that is what happens here.
   */
  close(path: string, board: string | null, lecture: string | null = null): boolean {
    const wasActive = this.active === path
    /*
     * The place in the row is computed BEFORE the removal.
     *
     * After it the tab being closed is no longer in the row, `indexOf` gives
     * -1, and "the neighbor on the left" turned into "the leftmost tab":
     * closing the third of four files, the person ended up in the first.
     */
    const at = this.row(board, lecture).indexOf(path)
    if (this.mine.includes(path)) this.mine = this.mine.filter((open) => open !== path)
    const stays = board === path
    if (wasActive) this.#goto(stays ? null : this.#neighbour(at, board, lecture))
    else this.#remember()
    return stays
  }

  /**
   * The room answered: fit the tabs to what really exists in it.
   *
   * The first call is the return after a reload (or the first visit here at
   * all), after that it is weeding: the file may have been removed by the
   * teacher, or by an `os.remove` in a cell, and a tab for a vanished file is
   * an empty area without explanation.
   *
   * The first visit waits for the room's notebook and decides nothing until
   * then: notebooks arrive from the document, while the file list comes from
   * the control socket, and recording "the person closed everything" in that
   * gap would cancel a decision they never made — forever, because "the first
   * time" happens only once.
   */
  settle(room: Room): void {
    if (this.#settled) {
      this.#keepOnly(room)
      return
    }
    if (this.#saved === null && room.firstBook === null) return
    this.#settled = true
    const next = restore(this.#saved, room)
    this.mine = next.open
    this.active = next.active
    this.#remember()
  }

  /**
   * Move one of one's own tabs.
   *
   * The ones pinned by the room do not move and cannot be dragged: their
   * order is set by the room, not by whoever is looking at them. The whole
   * decision is in `reordered`; here there is only the record, and `active`
   * is deliberately left alone: the person is rearranging tabs, not switching
   * between them.
   */
  reorder(dragged: string, onto: string | null): void {
    if (!this.mine.includes(dragged)) return
    const next = reordered(this.mine, dragged, onto)
    if (next.length === this.mine.length && next.every((path, i) => path === this.mine[i])) return
    this.mine = next
    this.#remember()
  }

  /** A renamed file stays open — under its new name. */
  rename(from: string, to: string): void {
    if (!this.mine.includes(from)) return
    this.mine = this.mine.map((path) => (path === from ? to : path))
    if (this.active === from) this.#goto(to)
    else this.#remember()
  }

  /**
   * Files that no longer exist go away together with their tabs.
   *
   * Except the shared screen: the server sets it, and it may be a round ahead
   * of the file list — a board just shown to the hall looks like a deleted
   * file in a slightly stale list. Killing the lecture over that is not
   * allowed; if the document really disappears, the room will learn it from a
   * `board` message, not from a missing entry in the list.
   */
  #keepOnly(room: Room): void {
    // A truncated list is no evidence of a loss — see `Room.truncated`.
    if (room.truncated) return
    const kept = this.mine.filter((path) => room.alive.has(path))
    if (kept.length === this.mine.length) return
    this.mine = kept
    const gone =
      typeof this.active === 'string' && !room.alive.has(this.active) && this.active !== room.board
    if (gone) this.#goto(null)
    else this.#remember()
  }

  /**
   * Where to go after closing a tab.
   *
   * To the neighbor on the left, not to the notebook: closing the third of
   * four open files, the person is busy with files, and throwing them out of
   * those means an extra trip back.
   *
   * `at` is the closed tab's place in the row that was drawn; the row with it
   * no longer exists here, and the neighbor on the left stands where it
   * stood. The row is built with the same pinned tabs, otherwise the count
   * would diverge from the screen.
   */
  #neighbour(at: number, board: string | null, lecture: string | null): TabKey {
    const row = this.row(board, lecture)
    if (row.length === 0) return null
    return row[Math.max(0, at - 1)] ?? null
  }

  /** Switch to a tab and remember it: people come back to where they left. */
  #goto(key: TabKey): void {
    this.active = key
    this.#remember()
  }

  #remember(): void {
    const box: Remembered = { open: this.mine.slice(0, MAX_REMEMBERED), active: this.active }
    try {
      localStorage.setItem(this.#key, JSON.stringify(box))
    } catch {
      /* private mode or a full disk — the tabs simply will not survive the visit */
    }
  }
}

/**
 * What is recorded for this room. `null` — nothing is recorded.
 *
 * Garbage in storage reads as "we remember nothing", not as "the person
 * closed everything": the difference shows at once — the first gets the
 * room's notebook opened, the second is left with an empty center, and a
 * corrupted record must not drop a person into an empty room.
 */
function read(key: string): Remembered | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    /* no storage at all — nothing to remember with */
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    /*
     * A bare array is a record from the previous version, when only the tab
     * list was remembered. It already sits in the browsers of running courses:
     * it reads as "the same tabs, the leftmost one shown" — the same thing a
     * returning person gets when their open tab was deleted in the meantime.
     */
    const box: unknown = Array.isArray(parsed) ? { open: parsed, active: null } : parsed
    if (typeof box !== 'object' || box === null) return null
    const { open, active } = box as { open?: unknown; active?: unknown }
    if (!Array.isArray(open)) return null
    return {
      open: open
        .filter((path): path is string => typeof path === 'string' && path !== '')
        .slice(0, MAX_REMEMBERED),
      active: typeof active === 'string' && active !== '' ? active : null,
    }
  } catch {
    return null
  }
}
