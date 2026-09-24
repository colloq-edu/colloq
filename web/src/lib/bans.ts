import { tr } from '@shared/i18n'
/**
 * A ban in a class — what of it can be seen from the browser.
 *
 * The server does the keeping out: it has the table, the device cookie and the
 * socket handshake. Here is only what markup gets wrong silently — until what
 * hour the person is kept out, whom the teacher may remove, how they confirm it
 * and what the marks in the people list mean.
 *
 * Marks are guesses, not a verdict. A device mark does not survive incognito,
 * and a matching address is the whole lecture hall behind one Wi-Fi. So every
 * hint has a second line that says exactly that, and so none of them forbids
 * anything: only a ban forbids, and a person sets it.
 *
 * No Svelte and no browser — like `lib/room.ts` and for the same reason: words
 * that a teacher will read once and remove someone by must be checked by a
 * test, not by eye during a live class.
 */
import type { Ban, CouncilAttempt, ParticipantRole } from '@shared/protocol'

/* ----------------------------------------------------------------- terms */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Midnight of the day the timestamp falls on. */
function midnight(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

/**
 * Until what hour the person is kept out — in words checked against the clock
 * on the wall.
 *
 * No `toLocaleTimeString`: the browser locale in a lecture hall can be
 * anything, and "6:40 PM" in the middle of a Russian line reads as a foreign
 * insert — exactly what `stampOf` on the sign-in screen avoids. "Tomorrow"
 * instead of a date because a ban lasts a day: it is almost always tomorrow,
 * and the date adds nothing here.
 */
export function untilWords(until: number, now: number = Date.now()): string {
  const at = new Date(until)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const days = Math.round((midnight(at) - midnight(new Date(now))) / 86_400_000)
  if (days === 0) return tr('room.ui.1029', { p0: time })
  if (days === 1) return tr('room.ui.1030', { p0: time })
  return tr('room.ui.1031', { p0: pad(at.getDate()), p1: pad(at.getMonth() + 1), p2: time })
}

/**
 * The ones in force now, newest first.
 *
 * The server returns the active ones, but the teacher's tab stays open until
 * evening, and a ban ends by itself: a line "until 18:40" still hanging at
 * seven is an offer to lift what has already lifted. Ordered by decision time:
 * the ban usually lifted is the one just put on the wrong person.
 */
export function activeBans(bans: readonly Ban[], now: number = Date.now()): Ban[] {
  return bans.filter((ban) => ban.until > now).sort((a, b) => b.createdAt - a.createdAt)
}

/* ------------------------------------------------------------- permission */

/**
 * Whom the teacher may remove from the class.
 *
 * Staff are never banned — the server answers the same. A button that would
 * get a refusal promises the teacher power over a colleague that they do not
 * have; and this also excludes the teacher themselves: the one asking is
 * always the host.
 */
export function mayBan(viewer: ParticipantRole, target: ParticipantRole): boolean {
  return viewer === 'host' && target !== 'host'
}

/* ---------------------------------------------------------- confirmation */

/**
 * What happens if you press it — one thought per line.
 *
 * Here and not in the markup, because this is the only place in the whole
 * product where the interface explains a punishment, and it can lie in three
 * ways at once: keep quiet about the erased questions, promise that they come
 * back, and promise an airtightness that does not exist. The name is not
 * declined in any of the lines: only a human puts both "Ivan" and "Kseniya"
 * into the genitive correctly.
 *
 * About restoring, this used to say "restoring a version brings the questions
 * back" — and that was untrue: a version restore takes `cellsAt(seq) →
 * cellsOf(doc)` (server/src/collab/history.ts) and puts back ONLY THE CELLS;
 * the word `chat` appears nowhere on the restore path. A promise in a dialog
 * that the code does not keep is worse than silence: the teacher presses
 * "remove" more boldly than they would knowing the truth. The impossibility
 * is pinned by tests/panels-ban-promise.test.mts.
 */
export function banConsequences(name: string): string[] {
  return [
    tr('room.ui.1032', { p0: name }),
    tr('room.ui.1033'),
    tr('room.ban.councilConsequences'),
    tr('room.ui.1034'),
  ]
}

/* -------------------------------------------------- marks in the people list */

/**
 * What the room knows about a person's browser — and only for the teacher.
 *
 * A tab cannot learn any of the three fields by itself: the device cookie is
 * httpOnly, the address is visible only to the server, and "first time here"
 * is known to the participants table. They arrive next to the bans, in the
 * same request and to the same person — there is no reason to set up a
 * separate right for this.
 *
 * All three are optional: a server that does not know about them yet leaves
 * the people list exactly as it was, rather than drawing a mark on a guess.
 */
export interface PersonMark {
  /** When the person first entered this room, ms. */
  firstSeenAt?: number
  /** Whether their tab accepted the device mark. */
  device?: boolean
  /** The address matched that of someone under an active ban. */
  sameIp?: boolean
}

/** A mark: a short word in the row and an explanation under the pointer. */
export interface PersonNote {
  text: string
  why: string
}

/**
 * How long "just now" lasts.
 *
 * Five minutes: for that long a person has "just come in" rather than "been
 * sitting here". After that the mark becomes untrue — and goes away by itself,
 * without anyone pressing anything.
 */
export const FRESH_MS = 5 * 60_000

/**
 * Marks for a person's row, in order of importance.
 *
 * "Possibly returned" displaces "browser without a mark": the person is
 * without a mark in that case anyway, and saying it a second time fills the
 * row with what was already said. But "recently joined" stands next to either
 * of them — together they add up to the person the teacher is looking for.
 *
 * The guess is not shown while nobody in the room has been removed: a
 * matching address means nothing by itself — behind one Wi-Fi the whole
 * lecture hall is on one network.
 */
export function personNotes(
  mark: PersonMark | undefined,
  options: { bansActive: boolean; now?: number },
): PersonNote[] {
  if (!mark) return []
  const now = options.now ?? Date.now()
  const notes: PersonNote[] = []

  if (mark.device === false && mark.sameIp === true && options.bansActive) {
    notes.push({
      get text() { return tr('room.ui.1035') },
      why:
        tr('room.ui.1036') +
        tr('room.ui.1037') +
        tr('room.ui.1038'),
    })
  } else if (mark.device === false) {
    notes.push({
      get text() { return tr('room.ui.1039') },
      get why() { return tr('room.ui.1040') },
    })
  }

  if (mark.firstSeenAt !== undefined && now - mark.firstSeenAt < FRESH_MS) {
    notes.push({
      get text() { return tr('room.ui.1041') },
      get why() { return tr('room.ui.1042') },
    })
  }

  return notes
}

/* ------------------------------------------------------------- one menu */

/**
 * The ban menu lives in one place for the whole room.
 *
 * It is opened from two — from the people list with a right click and from the
 * oracle thread by clicking an author — but it is drawn once, at the very top
 * of the screen. It would have to be done this way even without talk of
 * consistency: both panels scroll and clip everything that sticks out past
 * their edge, and a popup menu inside a 240-pixel rail would be clipped exactly
 * when it was opened at the bottom row.
 *
 * An event, not a prop through four layers — like `lib/reveal.ts`.
 */
export const BAN_MENU_EVENT = 'colloq:ban-menu'

/** The ban list changed: whoever shows it will re-read it. */
export const BANS_CHANGED_EVENT = 'colloq:bans-changed'

/** Whom to remove and where the click was — in window coordinates. */
export interface BanTarget {
  id: string
  name: string
  color: string
  avatar: string | null
  x: number
  y: number
}

/**
 * The real target of the button in the console.
 *
 * The name on screen may be replaced by an "Answer N" or an "Anonymous work",
 * but the ban is placed on a person. So both the id and the name are taken
 * from the attempt itself, not from what is currently drawn for the teacher.
 */
export function banTargetOf(
  attempt: Pick<CouncilAttempt, 'participantId' | 'name' | 'color' | 'avatar'>,
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
): BanTarget {
  return {
    id: attempt.participantId,
    name: attempt.name,
    color: attempt.color,
    avatar: attempt.avatar,
    x: point.clientX,
    y: point.clientY,
  }
}

export function askToBan(target: BanTarget): void {
  window.dispatchEvent(new CustomEvent<BanTarget>(BAN_MENU_EVENT, { detail: target }))
}

export function bansChanged(): void {
  window.dispatchEvent(new Event(BANS_CHANGED_EVENT))
}
