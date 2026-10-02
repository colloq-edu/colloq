/**
 * The instance's time zone: where its days begin and in which zone its pages
 * print times.
 *
 * ONE PLACE, because two answers to "what day is it" were already live at
 * once: the daily submission limit reset at UTC midnight (three in the
 * morning in Moscow, in the middle of night work) while the teacher's panel
 * counted "run today" by the zone of the server process, and a published page
 * captioned its times in yet another way. Every "today" and every printed
 * clock on the server asks here.
 *
 * The zone is `TZ`, and without it Moscow — the default the published pages
 * already used. Not the process's own zone: a container or a VPS with no TZ
 * runs in UTC, and a class held in Moscow is not held in UTC. `TZ` is read on
 * every call rather than once at load: it arrives from `.env` through dotenv
 * in config.ts, and modules that ask here load before that.
 */
import { DEFAULT_TIME_ZONE, dayStartIn, isTimeZone, nextDayStartIn } from '@shared/time-zone'
import { dayOf } from '@shared/class-day'

let warned = ''

/**
 * The IANA name of the instance's zone. A value the zone database does not
 * know (`TZ=MSK`, a POSIX rule like `UTC0`) falls back to the default out
 * loud, once: a typo in `.env` must not stop the limit from counting, and it
 * must not go unnoticed either. POSIX allows a leading colon (`:Europe/Moscow`),
 * and that one is simply read past.
 */
export function instanceTimeZone(): string {
  const raw = (process.env.TZ ?? '').trim().replace(/^:/, '')
  if (!raw) return DEFAULT_TIME_ZONE
  if (isTimeZone(raw)) return raw
  if (warned !== raw) {
    warned = raw
    console.warn(`[time] TZ=${raw} is not a time zone name this runtime knows; days and times use ${DEFAULT_TIME_ZONE}`)
  }
  return DEFAULT_TIME_ZONE
}

/** The first moment of the instance's day that contains `at`. */
export function instanceDayStart(at = Date.now()): number {
  return dayStartIn(at, instanceTimeZone())
}

/** The first moment of the instance's next day: when a daily limit starts over. */
export function instanceNextDayStart(at = Date.now()): number {
  return nextDayStartIn(at, instanceTimeZone())
}

/**
 * Today in the instance's zone, as 'YYYY-MM-DD': the day course pages call
 * «сегодня» and a finished class is stamped with. Never the browser's day: a
 * phone set to another zone must not move a class to yesterday.
 */
export function instanceToday(at = Date.now()): string {
  return dayOf(at, instanceTimeZone())
}
