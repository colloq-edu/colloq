/**
 * Fields that ride along with one log line, for LOG_FORMAT=json.
 *
 * A line in the JSON log is `{time, level, msg, ...}`, and some lines carry
 * numbers worth querying as numbers: the minute summary's rooms and people, a
 * database snapshot's size and duration. The words stay the message, exactly
 * as the text log prints them; the numbers go next to it as keys.
 *
 * A module of its own, with no side effects, rather than part of log.ts:
 * log.ts patches console the moment it loads, and a module that merely wants
 * to attach a field (db-snapshots.ts, loaded by every process that opens the
 * database, the CLI's cleanup helper and half the tests among them) must not
 * switch that patch on in a process that never asked for it. Here nothing
 * happens on import; without log.ts the fields are simply never read, and the
 * line prints as it always did.
 */
export type LogFields = Record<string, string | number | boolean | null>

let pending: LogFields | null = null

/**
 * Print a line through console, with fields for the JSON log.
 *
 * Through console and not around it, so that the text log, the tests that
 * listen on console and every wrapper stacked on it see the same call as
 * before. The slot is taken back in `finally`: a console replaced by a test
 * never reads it, and the fields must not stick to the next line printed.
 */
export function logWith(method: 'log' | 'warn' | 'error', fields: LogFields, ...args: unknown[]): void {
  pending = fields
  try {
    console[method](...args)
  } finally {
    pending = null
  }
}

/** The fields of the line being printed right now, once: log.ts asks for them. */
export function takeLogFields(): LogFields | null {
  const fields = pending
  pending = null
  return fields
}
