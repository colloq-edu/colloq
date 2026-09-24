
/**
 * A queue at the door.
 *
 * A room grows only from NEW people, and the server counts them one by one:
 * too many entries in a minute — and the next one gets a 429
 * (`tooManyArrivals` in routes/sessions.ts). The limit is high, but it exists,
 * and the inflow is uneven: a class starts at 18:10, and the whole group opens
 * the link in the same minute — so the first to be refused are exactly those
 * who came on time.
 *
 * There is nothing to tell the person at that moment: they did nothing wrong
 * and can do nothing better except press the same button again. So the tab
 * must press it — once, out loud and with an end: an endless retry turns a
 * crowded room into one that "does not let you in at all", and does it
 * silently.
 */
import { ApiError } from './api'
import { saysSessionMissing } from '@shared/protocol'

/**
 * The pause before a retry.
 *
 * Seconds, not milliseconds: the server's counting window is a minute, and an
 * instant retry would hit the same counter, only faster. Four seconds is still
 * waiting rather than a frozen page, and it is enough for the burst at the
 * entrance to disperse.
 */
export const CROWD_WAIT_MS = 4000

/** The line the person reads while the tab waits. */
export const CROWD_NOTICE = "В комнату сейчас заходит много людей — пробую ещё раз…"

/**
 * How many times the tab knocks at the door by itself.
 *
 * Two: the first entry and one retry. After that — the usual refusal in the
 * server's words and a button, because the decision to keep waiting is made
 * by a person, not by the program.
 */
const KNOCKS = 2

/**
 * Whether to wait before the next attempt to enter — and how long.
 *
 * `null` means "show the refusal": either it is the wrong kind of refusal (the
 * name is taken, there is no room, there is no connection), or the retry has
 * already happened. Kept apart from the screen, because "once more" and
 * "enough" is the only decision in this whole story.
 *
 * @param cause — what `api.join` answered with.
 * @param tried — how many attempts have been made, including the one that just failed.
 */
export function retryJoinIn(cause: unknown, tried: number): number | null {
  if (!(cause instanceof ApiError) || tried >= KNOCKS) return null
  if (cause.status === 429) return CROWD_WAIT_MS
  // The relay can briefly answer with its own 404 before a request reaches
  // Colloq. This is different from the application's definitive missing room.
  // Do not retry ambiguous network/5xx failures: a join may already have created
  // a participant before its response was lost.
  if (cause.status === 404 && !saysSessionMissing(cause)) return 500
  return null
}
