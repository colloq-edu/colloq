/**
 * Who holds the lecture's console, in words — and the take-over that moves it.
 *
 * One module for the room (LectureView), the console (ConsoleView) and the
 * tests, because the three questions here are the ones a teacher asks out
 * loud in the middle of a class, and two screens answering them differently
 * is how "the iPad says I lead, the laptop says Ada does" happens:
 *
 *  • who leads, and is it me on another device or a colleague;
 *  • are they still there (connected, acting), or is the lock stale;
 *  • did I just lose the console, to whom, from where, when.
 */
import { tr } from '@shared/i18n'
import type { LectureDevice, LectureState } from '@shared/lecture'
import type { ControlClientMessage } from '@shared/protocol'

/** How the room speaks about the holder of a lecture it does not hold itself. */
export interface Holder {
  /**
   * The same teacher on another device: the same staff account behind a
   * different participant (a second browser). The words change ("from
   * another device"), and the take-over asks nothing: nobody is interrupted.
   */
  self: boolean
  /** Since when (server clock) the holder has had no connection, or `null`. */
  awaySince: number | null
  device: LectureDevice | null
}

export function holderOf(lecture: LectureState, person: string | null): Holder {
  return {
    self: person !== null && (lecture.byPerson ?? null) === person,
    awaySince: lecture.awaySince ?? null,
    device: lecture.device ?? null,
  }
}

/** A tablet or a phone, drawn as one; a laptop or anything unknown is drawn as a laptop. */
export function handheld(device: LectureDevice | null | undefined): boolean {
  const kind = device?.kind
  return kind === 'ipad' || kind === 'iphone' || kind === 'android' || kind === 'android-tablet'
}

/** "iPad", "Mac", "Windows PC" — or `null` when the device never said. */
export function deviceWord(device: LectureDevice | null | undefined): string | null {
  return device ? tr(`room.device.${device.kind}`) : null
}

/** "on the iPad", "on the Windows PC", "on the other device": for "the console … stops". */
export function deviceOn(device: LectureDevice | null | undefined): string {
  return device ? tr(`room.device.${device.kind}.on`) : tr('room.device.unknown.on')
}

/** "iPad, console" for the banner's brackets; just the device in the room. */
export function deviceLong(device: LectureDevice | null | undefined): string | null {
  const word = deviceWord(device)
  if (word === null) return null
  return device?.console ? tr('room.takeover.onConsole', { device: word }) : word
}

/**
 * The take-over message for what this tab sees now.
 *
 * It names the lecture and the holder it was pressed against, so the server
 * refuses it in words when the room has moved on instead of restarting an
 * ended lecture or taking the console from someone who took it meanwhile.
 */
export function takeMessage(lecture: LectureState, device: LectureDevice): ControlClientMessage {
  return {
    t: 'lecture:take',
    file: lecture.file,
    from: lecture.by,
    startedAt: lecture.startedAt,
    device,
  }
}

/**
 * Whether a take-over asks a second time.
 *
 * Only when it interrupts somebody: a colleague who is connected. Oneself on
 * another device, or a holder who is gone, is taken in one press. That is
 * the case the press exists for (the laptop died mid-class), and making it
 * wait for a confirmation nobody can give is the stuck lock in other words.
 */
export function takeAsks(holder: Holder): boolean {
  return !holder.self && holder.awaySince === null
}

/**
 * How long ago the holder last did something the hall saw, in milliseconds,
 * or `null` when nothing is known.
 *
 * Two sources, the later wins: the server's mark (which a tab opened just
 * now receives in the lecture state) and the frames this tab heard itself
 * (pages, strokes, the pointer), which arrive between state broadcasts.
 * `heardAt` is this browser's clock, `skewMs` the room's correction from it
 * to the server's (session.svelte.ts · clockSkewMs).
 */
export function actedAgo(
  lecture: LectureState,
  heardAt: number,
  skewMs: number,
  now: number,
): number | null {
  const server = lecture.actedAt !== undefined ? lecture.actedAt + skewMs : 0
  const last = Math.max(server, heardAt)
  return last > 0 ? Math.max(0, now - last) : null
}

/** "12 s", "4 min", "2 h": how stale a holder is, in the words of a glance. */
export function agoWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return tr('room.takeover.seconds', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return tr('room.takeover.minutes', { n: minutes })
  return tr('room.takeover.hours', { n: Math.floor(minutes / 60) })
}

/**
 * The console this tab held and lost: to whom, from where, when.
 *
 * Read from two consecutive states rather than a message of its own: the
 * state is what every tab already receives (and receives again on
 * reconnect), so a console that was asleep during the take-over still says
 * so when it wakes, instead of silently showing someone else's lecture with
 * its pen gone. The same lecture (same start) leaving this participant is a
 * take-over; the lecture ending is not, and has its own words.
 */
export interface Lost {
  name: string
  device: LectureDevice | null
  /** Server clock: when the new hands took it. */
  at: number
  /** Taken by the same teacher's other device. */
  self: boolean
  /** Whom to name in "give it back". */
  by: string
}

export function lostHands(
  before: LectureState | null,
  after: LectureState | null,
  me: string,
  person: string | null,
): Lost | null {
  if (!before || !after || before.by !== me || after.by === me) return null
  if (after.startedAt !== before.startedAt || after.file !== before.file) return null
  return {
    name: after.byName,
    device: after.device ?? null,
    at: after.since ?? Date.now(),
    self: person !== null && (after.byPerson ?? null) === person,
    by: after.by,
  }
}

/** "21:14" in the room's language, from a server-clock moment. */
export function clockOf(serverAt: number, skewMs: number, locale: string): string {
  return new Date(serverAt + skewMs).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  })
}
