/**
 * A timestamp on every log line.
 *
 * The log used to be written without it, and `make run` also overwrote the
 * file on every start. As a result "something broke on Thursday afternoon"
 * could not be matched with anything: the lines are there, the order is
 * there, but when is unknown, and last week is erased. It costs one wrapper
 * for the whole process.
 *
 * console itself is patched rather than introducing a logger of our own: it
 * is written to from a couple of dozen places, dependencies included, and
 * half the lines would stay without a time. The format is ISO 8601: it sorts
 * as text and does not depend on the machine's time zone.
 */
import { format } from 'node:util'
import { logWith, takeLogFields, type LogFields } from './log-fields.js'

const wrapped = ['log', 'info', 'warn', 'error', 'debug'] as const
type Method = (typeof wrapped)[number]

/** The level a JSON line names; console.log is the ordinary line, so it is info. */
const LEVEL: Record<Method, 'info' | 'warn' | 'error' | 'debug'> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
}

/**
 * LOG_FORMAT=json: one JSON object per line, for a platform that collects
 * stdout into Loki or ELK.
 *
 * Such a collector cuts the stream at line breaks, and the text log does not
 * survive that: a stack trace arrives as a dozen unrelated entries, and the
 * level can only be guessed from which stream a line came out of. As JSON,
 * every call is one line whatever it printed, and the level is a key.
 *
 * Asked on every line rather than once: this module loads before config.ts
 * has read .env, so a LOG_FORMAT written there takes effect from the moment
 * dotenv has run instead of never. In a container the variable comes from
 * the environment and holds from the very first line. A line costs one
 * environment lookup, and the log is a few lines a second at its busiest.
 */
export function jsonLogs(): boolean {
  return process.env.LOG_FORMAT?.trim().toLowerCase() === 'json'
}

/*
 * A side effect at module load, not a call from index.ts.
 *
 * `import` is hoisted: a call written between imports runs after all of them
 * have loaded, and everything the modules printed while loading stays without
 * a time. The first import in index.ts is the only place from which this can
 * be done before everything else.
 *
 * Text stays exactly what it was: the time, then the arguments as console
 * prints them. JSON goes out through the same console method, so each line
 * keeps its stream (log and info to stdout, warn and error to stderr) and
 * nothing that watches those streams has to learn a second rule.
 */
for (const method of wrapped) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => {
    const fields = takeLogFields()
    const time = new Date().toISOString()
    if (!jsonLogs()) {
      original(time, ...args)
      return
    }
    original(jsonLine(time, LEVEL[method], args, fields))
  }
}

/**
 * One JSON log line: `{time, level, msg, component?, ...fields}`.
 *
 * `msg` is the text line without its time, character for character. It is
 * formatted the way the text log formats it, with the time as the first
 * argument, where `%s` and friends in a message are never interpreted: had
 * JSON used the message as a format string, `50%d` in some line would read
 * differently in the two logs, and a search copied from one would miss in the
 * other.
 *
 * `component` is the word in the leading brackets (`[kernel ...]`, `[db]`,
 * `[minute]`), the one every subsystem here already starts its lines with: a
 * label with a dozen values, which is what a Loki stream wants and a room id
 * is not. Nothing else is parsed out of the text. The first-run banner in
 * particular stays one message: the link in it carries the setup token, and
 * a token lifted into a key of its own is a token some pipeline indexes.
 *
 * Fields never override the three keys every line has.
 */
export function jsonLine(time: string, level: string, args: unknown[], fields?: LogFields | null): string {
  const msg = format('', ...args).slice(1)
  const entry: Record<string, unknown> = { time, level, msg }
  const component = /^\[([a-z][a-z0-9-]*)[\] ]/.exec(msg)?.[1]
  if (component) entry.component = component
  if (fields) {
    for (const [key, value] of Object.entries(fields)) if (!(key in entry)) entry[key] = value
  }
  try {
    return JSON.stringify(entry)
  } catch {
    // A field JSON cannot say (a BigInt somebody passed) costs the fields, not the line.
    return JSON.stringify({ time, level, msg })
  }
}

/* -------------------------------------------------------------- lesson log */

/**
 * What happened during the lesson, sparingly, but so that it can be read.
 *
 * A whole day of the service log added up to ninety lines, and from them one
 * could tell neither how many rooms were alive nor when a kernel died: only
 * breakages were written. A line per event does not work either: with a
 * cohort of five hundred there are tens of thousands of sync frames a minute,
 * and what matters drowns in them just as surely as in emptiness.
 *
 * So two different things. What is frequent is counted and comes out once a
 * minute as one summary line. What is rare and real (a room opened, a kernel
 * died, the gate refused) is printed as is, with the same `console` as
 * everything else here: the project has no second logging mechanism and no
 * reason to start one.
 *
 * Nothing personal: the summary and the events carry numbers and room ids.
 * Participants' names and cell text never get into the log at all.
 */

/** Frequent things that are counted per minute rather than written as lines. */
export type Tally =
  /** Accepted sync frames: a measure of whether anyone is working in the room at all. */
  | 'frames'
  /** Frames refused by the gate. */
  | 'gate'
  /** Requests aborted by the client: the student left the page. */
  | 'aborted'
  /** Joins refused by the limit on new participants. */
  | 'joins'
  /** Oracle failures of any kind, including the safety filter. */
  | 'oracle'

const minute: Record<Tally, number> = { frames: 0, gate: 0, aborted: 0, joins: 0, oracle: 0 }

/*
 * The same counts since the process started, never reset.
 *
 * The minute summary needs "how many in this minute"; /metrics needs the
 * running total, because Prometheus computes rates itself and a counter that
 * went back to zero every minute reads there as sixty restarts an hour. One
 * `tally` call feeds both, so the two can never disagree about what counts.
 */
const total: Record<Tally, number> = { frames: 0, gate: 0, aborted: 0, joins: 0, oracle: 0 }

export function tally(what: Tally, n = 1): void {
  minute[what] += n
  total[what] += n
}

/** Everything tallied since the process started (ops/metrics.ts). */
export function tallyTotals(): Readonly<Record<Tally, number>> {
  return { ...total }
}

/**
 * The same event no more than once a minute per key.
 *
 * A gate refusal and a join that hit the limit can be rare, and can come as
 * an avalanche: a load test instance with five hundred students gave 378 join
 * refusals in a row. A line for each is the very flood we are curing the log
 * of, so the first such refusal is spelled out in words, and the rest within
 * the same minute go into the counter.
 */
const said = new Map<string, number>()

export function seldom(key: string, quiet = 60_000): boolean {
  const now = Date.now()
  const last = said.get(key)
  if (last !== undefined && now - last < quiet) return false
  // The map lives as long as the process, with a key per room for each
  // reason. Expired entries are swept out right here, so that a semester of
  // opened rooms does not stay in memory forever.
  for (const [old, at] of said) if (now - at >= quiet) said.delete(old)
  said.set(key, now)
  return true
}

/** The instance's state right now; it is asked for once a minute. */
export interface Census {
  /** Rooms with someone in them. */
  rooms: number
  /** People in them, counted by participant, not socket: a second tab is not a person. */
  people: number
  /** Room kernels: live ones, the busy ones among them, and dead ones. */
  kernels: { live: number; busy: number; dead: number }
}

const SUMMARY_MS = 60_000

let census: (() => Census) | null = null
let ticker: ReturnType<typeof setInterval> | null = null

/**
 * Turn the summary on. `index.ts` calls it once the server is up: the census
 * of rooms and kernels lives in `collab` and `kernel`, and they cannot be
 * imported here, since this module loads first in the process, before
 * everything else.
 */
export function startJournal(read: () => Census): void {
  census = read
  if (ticker) return
  ticker = setInterval(journalMinute, SUMMARY_MS)
  // The summary is no reason to keep the process from exiting: tests and
  // `make backup` start the server for seconds, and an open timer would hold
  // them to the end.
  ticker.unref?.()
}

/** Stop the summary, at shutdown, so the last line does not land in the noise. */
export function stopJournal(): void {
  if (!ticker) return
  clearInterval(ticker)
  ticker = null
}

/**
 * Sum up the minute and reset the counters. The timer calls it, and so do the
 * tests: a person reads this line's format, and it can only be checked by
 * reading the whole line.
 */
export function journalMinute(): void {
  let now: Census | null = null
  try {
    now = census?.() ?? null
  } catch {
    // The lesson matters more than the summary: a census that failed stays silent and does not bring the process down.
  }
  // A snapshot BEFORE the reset: the minute ends here whether or not there
  // will be a line, otherwise a quiet minute would carry off the next one's
  // count.
  const was = { ...minute }
  reset()
  const counted = was.frames + was.gate + was.aborted + was.joins + was.oracle
  // At night nothing happens on the machine, and 1440 lines about it are the
  // same lie as an empty log: what matters cannot be found in them either.
  if (!now || (now.rooms === 0 && now.kernels.live === 0 && counted === 0)) return

  const parts = [`rooms ${now.rooms}`, `people ${now.people}`]
  const { live, busy, dead } = now.kernels
  if (live > 0 || dead > 0) {
    const working = busy > 0 ? ` (${busy} busy)` : ''
    const gone = dead > 0 ? `, ${dead} dead` : ''
    parts.push(`kernels ${live} live${working}${gone}`)
  }
  // Zeros are not printed: on a calm minute the line is short, and whatever
  // appears in it is exactly what people dig into the log for.
  if (was.frames > 0) parts.push(`frames ${was.frames}`)
  if (was.gate > 0) parts.push(`gate refused ${was.gate}`)
  if (was.joins > 0) parts.push(`joins refused ${was.joins}`)
  if (was.oracle > 0) parts.push(`oracle failed ${was.oracle}`)
  if (was.aborted > 0) parts.push(`aborted ${was.aborted}`)
  // The JSON log gets the numbers as keys as well, zeros included: a query
  // over them should not have to tell "none" from "missing".
  logWith(
    'log',
    {
      rooms: now.rooms,
      people: now.people,
      kernelsLive: live,
      kernelsBusy: busy,
      kernelsDead: dead,
      frames: was.frames,
      gateRefused: was.gate,
      joinsRefused: was.joins,
      oracleFailed: was.oracle,
      aborted: was.aborted,
    },
    `[minute] ${parts.join(' · ')}`,
  )
}

function reset(): void {
  minute.frames = 0
  minute.gate = 0
  minute.aborted = 0
  minute.joins = 0
  minute.oracle = 0
}
