/**
 * A watchdog on a stream that went quiet — one for every road to the model.
 *
 * The SDK timeout is lifted by the first response headers, not by the last
 * frame: a provider that opened the stream and went silent mid-sentence counts
 * as neither failed nor slow — the connection just stands there. In the room
 * this looks like endless "thinking", and only the person who asked can cancel
 * it, if it occurs to them.
 *
 * This watchdog lived in ai/index.ts and guarded exactly one road — the
 * notebook. The council did not have one at all, and on 20 Sep 2026, in a live
 * class, that cost the whole class: "Refresh summary" on thirty submissions
 * hung forever, with no answer, no error and not a single line in the log, and
 * the entry in the `reading` map kept the cell locked until the server was
 * restarted. The logic here is the same, word for word; the only new thing is
 * that it is called from three places.
 *
 * Two deadlines, and they differ on purpose.
 *
 * The deadline BETWEEN frames counts from the FIRST frame, not from sending the
 * request. A single deadline for both cases fired ahead of the SDK timeout on
 * any slow first letter — Ollama on the teacher's laptop, a prompt of twenty
 * thousand characters whose processing on the CPU takes longer than two
 * minutes — and told the room "the endpoint opened the response and went
 * silent", advising to ask again. The endpoint had opened nothing, asking again
 * was useless, and the cure is to reduce contextChars — which is exactly what
 * the SDK's "took too long" phrase says (provider.ts · friendly), a phrase that
 * was never reached.
 *
 * So the deadline BEFORE the first frame is separate and deliberately longer
 * than the SDK's. Having no watchdog at all before the opening is not an
 * option: a stream whose headers arrived but not a single byte of body has
 * already happened as far as the SDK is concerned, and it would hang until the
 * end of the class. But the deadlines must not be equal either — then the
 * watchdog gets ahead of the SDK and replaces its diagnosis with its own,
 * wrong one.
 *
 * And a ceiling on the whole request is a third deadline, an optional one. It
 * is not about silence: a stream that trickles one letter a second forever
 * duly resets every silence deadline, and meanwhile the class is running out.
 * Where the answer is awaited standing at the whiteboard, the ceiling is
 * mandatory; in the notebook, where the answer is read as it is being written,
 * it is absent on purpose.
 */

/** Why WE cut it off. `null` in `why` means a person cut it off, or nobody did. */
export type QuietReason =
  /** The stream did not open: we never got as far as the first frame. */
  | 'opening'
  /** It opened and went silent in the middle of the answer. */
  | 'silence'
  /** Hit the ceiling for the whole request. */
  | 'cap'

export interface WatchTimes {
  /** How long we wait for the FIRST frame. */
  openingMs: number
  /** How long we wait for the next frame after the first one. */
  silenceMs: number
  /** Ceiling for the whole request; without it, only the silence deadlines. */
  capMs?: number
}

export interface Watch {
  /** A frame arrived: the silence deadline is armed again. */
  heard(): void
  /** Clear all timers. Called in `finally`, always and unconditionally. */
  stop(): void
  /** Why we cut it off; `null` means it was not us (a person pressed "Stop"). */
  readonly why: QuietReason | null
  /** Was there any frame at all: before the first, "went silent" means something else. */
  readonly spoke: boolean
}

/**
 * Set a watchdog over `controller`. Returns a handle: `heard()` on every frame,
 * `stop()` in `finally`, `why`/`spoke` to tell the outcomes apart in words.
 */
export function watchSilence(controller: AbortController, times: WatchTimes): Watch {
  let quiet: NodeJS.Timeout | null = null
  let cap: NodeJS.Timeout | null = null
  let why: QuietReason | null = null
  let spoke = false

  const giveUp = (reason: QuietReason) => {
    // The first reason stays the reason: a ceiling that fires a millisecond
    // after the silence must not rewrite the diagnosis.
    if (why === null) why = reason
    controller.abort()
  }

  const arm = (ms: number, reason: QuietReason) => {
    if (quiet) clearTimeout(quiet)
    quiet = setTimeout(() => {
      quiet = null
      giveUp(reason)
    }, ms)
    quiet.unref?.()
  }

  arm(times.openingMs, 'opening')
  if (times.capMs !== undefined) {
    cap = setTimeout(() => {
      cap = null
      giveUp('cap')
    }, times.capMs)
    cap.unref?.()
  }

  return {
    heard(): void {
      spoke = true
      arm(times.silenceMs, 'silence')
    },
    stop(): void {
      if (quiet) clearTimeout(quiet)
      if (cap) clearTimeout(cap)
      quiet = null
      cap = null
    },
    get why(): QuietReason | null {
      return why
    },
    get spoke(): boolean {
      return spoke
    },
  }
}

/**
 * Notebook: the answer is read as it is being written, and it has no ceiling.
 *
 * Five minutes until the opening — the SDK with its own two always gets there
 * first; this is the last safety net. Two minutes between frames is certainly
 * longer than any real pause: even a reasoning model gives out its trace in
 * portions, not in one piece at the end.
 */
export const NOTEBOOK_WATCH: WatchTimes = { openingMs: 300_000, silenceMs: 120_000 }

/**
 * Council: the teacher stands at the whiteboard and watches "Reading".
 *
 * The deadlines are shorter than the notebook's, and that is not a matter of
 * taste. Here the answer is awaited while doing nothing else, and the answer
 * itself arrives in ONE piece at the end — nobody reads it along the way, so a
 * slow stream gives nothing.
 *
 * A minute and a half until the first frame: a big model gets through thirty
 * submissions of twenty thousand characters in ten to twenty seconds, a local
 * one on a CPU in up to a minute; a minute and a half leaves a margin and is
 * still shorter than a class will put up with. Forty-five seconds between
 * frames: an opened stream that stays silent longer is no longer writing.
 * Three minutes as the ceiling for everything — the teacher will not wait
 * longer; having got a refusal, they will ask something shorter or simpler.
 */
export const COUNCIL_WATCH: WatchTimes = {
  openingMs: 90_000,
  silenceMs: 45_000,
  capMs: 180_000,
}
