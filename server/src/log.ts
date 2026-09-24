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
const wrapped = ['log', 'info', 'warn', 'error', 'debug'] as const

/*
 * A side effect at module load, not a call from index.ts.
 *
 * `import` is hoisted: a call written between imports runs after all of them
 * have loaded, and everything the modules printed while loading stays without
 * a time. The first import in index.ts is the only place from which this can
 * be done before everything else.
 */
for (const level of wrapped) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    original(new Date().toISOString(), ...args)
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

export function tally(what: Tally, n = 1): void {
  minute[what] += n
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
  console.log(`[minute] ${parts.join(' · ')}`)
}

function reset(): void {
  minute.frames = 0
  minute.gate = 0
  minute.aborted = 0
  minute.joins = 0
  minute.oracle = 0
}
