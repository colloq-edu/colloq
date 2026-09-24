import { tr } from './i18n.js'
/**
 * A name someone typed, held to one standard at every door.
 *
 * A seminar name, a person's name and a teacher's name come from four places
 * (room, panel, staff, import) and are drawn in the same rows: the hall
 * header, the cell caption, a list row. The cleaning rule was copied word for
 * word into three files, while the fourth door, import, made do with
 * `trim()`, and a seminar name from GitHub carried into the list the line
 * breaks and tabs from which the other three protect the layout.
 *
 * A control character is replaced with a space rather than dropped: a line
 * break in the middle of a name is a word boundary, and gluing the words
 * together would mean silently correcting the person.
 */
export function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Duration in words: "30 s", "1 min", "2 min 30 s".
 *
 * The council rules are stored in seconds but read as a sentence, and both
 * phrases about them, "the run took longer than 5 min" on the server and
 * "next run in 1 min" under the student's button, take the same number.
 * "300 s" in such a line reads as a typo: a person recognizes five minutes
 * only after counting them in their head, and the countdown under the button
 * is read on the fly.
 *
 * Seconds are not rounded to zero: the limit is picked from a list of round
 * numbers, but the countdown runs on the live clock and lands in any gap;
 * "in 1 min" a minute and a half before the button would be a promise the
 * server does not keep.
 */
export function durationWords(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return tr('server.duration.seconds', { p0: total })
  if (seconds === 0) return tr('server.duration.minutes', { p0: minutes })
  return tr('server.duration.minutesSeconds', { p0: minutes, p1: seconds })
}
