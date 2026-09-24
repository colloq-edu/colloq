/**
 * The pause between one student's runs — countdown arithmetic, without runes.
 *
 * The server holds the right: it refuses without even looking at the client
 * (the cell's rules, shared/notebook.ts · CouncilSettings.rerunPauseSec). The
 * `nextRunAt` field goes to the author not for the right's sake but so that a
 * COUNTDOWN stands where the button was, instead of a button that answers
 * every press with a refusal.
 *
 * It is computed here because such a countdown lies quietly: `nextRunAt` is
 * measured by the server's clock while the browser does the ticking, and
 * "Run in 8:03" on a laptop whose clock has drifted looks not like a breakage
 * but like the teacher's rule. Hence two safeguards in a row — a clock
 * correction and a cap at the rule itself — and both err in the same
 * direction: the button comes back early, not late. An early return costs one
 * server refusal; a late one costs a minute the person sits in front of the
 * cell waiting for a permission they in fact already have.
 *
 * No browser and no Svelte — tests/council-pause.test.mts.
 */

/**
 * How much longer to wait until one's next run, ms; 0 — allowed now.
 *
 *   nextRunAt — from `CouncilMine`, SERVER ms; `null`/`undefined` — no pause
 *   now       — this browser's `Date.now()`
 *   skewMs    — browser clock minus server clock (SessionState.clockSkewMs)
 *   pauseSec  — the cell's rule itself: a pause is never longer than it
 *
 * The `skewMs` correction is the best ping/pong sample, and until the first
 * pong it is zero: a tab opened on a machine whose clock is a quarter of a day
 * ahead counts by its own clock for the first seconds. So the remainder is
 * also clamped to the rule: whatever a stray clock shows, the countdown will
 * never ask to wait longer than the teacher said.
 *
 * The cap also makes a zero pause instant: the teacher lifted the rule —
 * `pauseSec` arrives as zero over the CRDT, and the countdown goes out in the
 * same second, without waiting for a fresh `council:mine`. The price is the
 * opposite case: until the cell lock has arrived, the cap comes from the
 * previous rules and may be smaller than the real one. Then the button comes
 * back early and the server refuses in words — that is, exactly the error
 * chosen here.
 */
export function pauseLeftMs(
  nextRunAt: number | null | undefined,
  now: number,
  skewMs: number,
  pauseSec: number,
): number {
  // Comparisons, not `!`: NaN in any of the numbers must mean "no pause", not
  // "a pause forever" — a countdown from NaN would draw "Run in NaN:aN".
  if (nextRunAt == null || !(pauseSec > 0)) return 0
  const left = nextRunAt - (now - skewMs)
  if (!(left > 0)) return 0
  return Math.min(left, pauseSec * 1000)
}

/** The pause is still on — the run button has no place on screen. */
export function pausePending(
  nextRunAt: number | null | undefined,
  now: number,
  skewMs: number,
  pauseSec: number,
): boolean {
  return pauseLeftMs(nextRunAt, now, skewMs, pauseSec) > 0
}

/**
 * "0:12" — the remainder in the chip's words, m:ss.
 *
 * Rounding UP: with floor the last second would show "0:00" for a whole
 * second, and a countdown frozen at zero reads as hung — while at that moment
 * it is working. Rounding up, "0:00" never appears at all: zero is no longer a
 * pause, and there is no chip on screen.
 *
 * Minutes without a leading zero and without hours: the pause ceiling is an
 * hour (COUNCIL_RERUN_PAUSE_MAX), and "60:00" is more honest than "1:00:00" in
 * a chip two words wide.
 */
export function pauseClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
