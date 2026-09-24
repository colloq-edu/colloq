import { tr } from '@shared/i18n'
/**
 * Access to a SINGLE notebook — what a person sees of it.
 *
 * The rights are computed by `shared/rules.ts` (`rulesForBook`), and there is
 * no second copy of that decision here, nor should there be. Here are only the
 * words and the form: the mark on the tab, the four menu rows and the patch
 * that leaves by the same route as all the other room rules.
 *
 * A pure module, no Svelte: what decides which word sits on the tab is checked
 * by a test, not by eye on a screenshot.
 */
import type { BookAccess, BookRule, RoomRules } from '@shared/rules'

/** A room notebook together with what the room remembers about it. */
export interface BookTab {
  path: string
  root: string
  /** The entry in the rules, or `null` — "nothing is said about this notebook". */
  rule: BookRule | null
  /**
   * Its kernel is busy right now: a cell is computing or a queue is waiting.
   *
   * Every notebook has its own kernel, and they can compute at the same time.
   * Without this dot a neighbouring tab where training has been running for a
   * minute and a half looks exactly like an idle one — and the person switches
   * over to check whether it is still going.
   */
  busy?: boolean
}

/**
 * A short mark on the tab — and only where access is NOT "as in the room".
 *
 * A mark on every notebook would be noise: most have room access, and an "as
 * in the room" caption on every tab says exactly nothing. It appears when the
 * notebook does not live by the room's rules — that is, when a grey button
 * inside needs explaining.
 *
 * The author sees "mine" on their own, not "personal · <own name>": there is
 * no point telling a person the name on their own notebook, and "mine" is
 * exactly what they need to know in a lecture where everything else is grey.
 */
export interface BookMark {
  text: string
  tone: 'mine' | 'personal' | 'all' | 'host'
}

export function bookMark(rule: BookRule | null, meId: string | null): BookMark | null {
  if (!rule || rule.access === 'room') return null
  if (rule.access === 'all') return { text: tr('room.book.mark.all'), tone: 'all' }
  if (rule.access === 'host') return { text: tr('room.book.mark.host'), tone: 'host' }
  if (rule.owner !== null && meId !== null && rule.owner === meId) {
    return { text: tr('room.book.mark.mine'), tone: 'mine' }
  }
  return {
    text: rule.ownerName
      ? tr('room.book.mark.personal', { name: rule.ownerName })
      : tr('room.book.mark.personalNoName'),
    tone: 'personal',
  }
}

/** A row of the "Access" menu: what is chosen and what will happen then. */
export interface AccessOption {
  access: BookAccess
  label: string
  hint: string
  /**
   * Cannot be chosen — and the menu says why instead of hiding the row.
   *
   * This concerns exactly "Personal": a notebook can be made personal only when
   * it has an author, and the author is recorded the moment a student starts it
   * (server/src/collab/books.ts). A teacher's notebook has no author, and a
   * hidden row would read as "there is no such thing" — whereas there is, just
   * not for this one.
   */
  disabled: boolean
}

export function accessOptions(rule: BookRule | null): AccessOption[] {
  const owner = rule?.ownerName ?? null
  const known = Boolean(rule?.owner)
  return [
    {
      access: 'room',
      label: tr('room.book.access.room'),
      hint: tr('room.book.access.roomHint'),
      disabled: false,
    },
    {
      access: 'owner',
      label: owner
        ? tr('room.book.access.owner', { name: owner })
        : tr('room.book.access.ownerNoAuthor'),
      // The hint on an unavailable row says WHY it cannot be chosen, not what
      // it does: the latter is useless here.
      hint: known ? tr('room.book.access.ownerHint') : tr('room.book.access.ownerNone'),
      disabled: !known,
    },
    {
      access: 'all',
      label: tr('room.book.access.all'),
      hint: tr('room.book.access.allHint'),
      disabled: false,
    },
    {
      access: 'host',
      label: tr('room.book.access.host'),
      hint: tr('room.book.access.hostHint'),
      disabled: false,
    },
  ]
}

/**
 * The rules patch that changes access to one notebook.
 *
 * Room rules change through one route (PATCH /api/sessions/:id/rules), and
 * notebook access is no exception: it lives in the same rules, travels in the
 * same frame and has its role checked on the server the same way. The map is
 * sent whole, because PATCH lays what was sent over what is stored at the TOP
 * level, and `books` is a single key of that level.
 *
 * The author in the entry is kept even when access is set back to the room's:
 * the menu needs the name to offer "Personal — Akim" again next time, and it
 * must not be lost to a single change of mind. The server drops an entry
 * without an author under `room` by itself (shared/rules.ts · readRules), so
 * the map does not bloat.
 */
export function accessPatch(
  rules: RoomRules,
  root: string,
  access: BookAccess,
): Partial<RoomRules> {
  const was = rules.books?.[root] ?? null
  const books: Record<string, BookRule> = { ...(rules.books ?? {}) }
  books[root] = {
    access,
    owner: was?.owner ?? null,
    ownerName: was?.ownerName ?? null,
  }
  return { books }
}
