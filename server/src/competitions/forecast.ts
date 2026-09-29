/**
 * The queue's future as both screens show it: places and "≈ 3 min".
 *
 * ONE ESTIMATE FOR EVERYONE. The participant's list (routes/competitions.ts)
 * and the teacher's queue block (routes/admin-competitions.ts) used to compute
 * the wait each in its own way — with different averages, one of them over
 * the OLDEST twenty runs — and a person comparing their phone with the
 * projector saw two numbers for one queue. Both read this now.
 *
 * The place is over the WHOLE instance queue and in the order the runner takes
 * work (panel.ts · fairOrder): "third" must mean the same on both screens.
 * Jobs postponed by a resource retry keep their row but get neither a place
 * nor an estimate: they cannot take a slot yet.
 */
import { expectedRunMs, fairOrder, queueEtas } from './panel.js'
import { METRIC_WALL_SECONDS } from './runner-port.js'
import { getCompetition, queueRows, recentDurations, recentMetricRuns, type QueueRow } from './store.js'

/** A competition's "recent" runs: a competition lives for weeks, and its first runs solved a different task. */
const RECENT_RUNS = 20
/** The instance's recent runs — the fallback for a competition that has barely run. */
const INSTANCE_RUNS = 50

export interface Forecast {
  running: QueueRow[]
  /** Claimable waiting jobs, in the order they will be taken. */
  eligible: QueueRow[]
  /** Postponed by a resource retry: visible, but not claimable yet. */
  deferred: QueueRow[]
  /** Per claimable waiting submission: its 1-based place, and when it starts and when its result is expected. */
  at: Map<string, { place: number; startMs: number; etaMs: number }>
}

export function queueForecast(slots: number, now = Date.now()): Forecast {
  const rows = queueRows()
  const running = rows.filter((row) => row.state === 'running')
  const waiting = rows.filter((row) => row.state === 'waiting')
  const busy = new Set(running.map((row) => row.entrantId))
  const eligible = fairOrder(waiting.filter((row) => row.notBefore <= now), busy)
  const deferred = fairOrder(waiting.filter((row) => row.notBefore > now), busy)
  const expected = runEstimator()
  const etas = queueEtas({
    slots,
    running: running.map((row) => ({
      expectedMs: expected(row),
      elapsedMs: row.startedAt === null ? 0 : Math.max(0, now - row.startedAt),
    })),
    waiting: eligible.map((row) => ({ expectedMs: expected(row) })),
  })
  const at = new Map(eligible.map((row, index) => [row.submissionId, { place: index + 1, ...etas[index] }] as const))
  return { running, eligible, deferred, at }
}

/**
 * Expected run time per queue row, each competition's numbers read once per
 * forecast.
 *
 * A rescore runs only the metric, so it is measured by the instance's recent
 * metric runs (or half the metric's own limit); a notebook run by its
 * competition's recent runs (panel.ts · expectedRunMs).
 */
function runEstimator(): (row: QueueRow) => number {
  const byCompetition = new Map<string, number>()
  let instance: number[] | null = null
  let metric: number | null = null
  return (row) => {
    if (row.kind === 'metric') {
      metric ??= expectedRunMs({ recent: recentMetricRuns(RECENT_RUNS), instance: [], wallSeconds: METRIC_WALL_SECONDS })
      return metric
    }
    let known = byCompetition.get(row.competitionId)
    if (known === undefined) {
      const recent = recentDurations(row.competitionId, RECENT_RUNS)
      if (recent.length < 3) instance ??= recentDurations(null, INSTANCE_RUNS)
      known = expectedRunMs({
        recent,
        instance: instance ?? [],
        wallSeconds: getCompetition(row.competitionId)?.limits.wallSeconds ?? 600,
      })
      byCompetition.set(row.competitionId, known)
    }
    return known
  }
}
