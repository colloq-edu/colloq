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
 *
 * GPU WORK. A notebook with a card needs a general slot AND a share of a
 * runner card, and while no share is free the queue passes it over and takes
 * the work behind it (store.ts · selectNext). The simulation does the same
 * (panel.ts · queueEtas), so the place is the order of the simulated starts:
 * a GPU notebook first in the order but waiting for a card is not "first",
 * and the CPU work that will start before it is not behind it. With no GPU
 * work waiting that is exactly the order. Under the cluster the queue keeps
 * no card, but it keeps its GPU notebooks to the number the broker has units
 * for (gpu.ts · clusterGpuSlots), and the simulation counts that number as
 * the cards' places.
 */
import { expectedRunMs, fairOrder, queueEtas, type Eta } from './panel.js'
import { METRIC_WALL_SECONDS } from './runner-port.js'
import { getCompetition, queueRows, recentDurations, recentMetricRuns, type QueueRow } from './store.js'
import { clusterGpuSlots, runnerCardsHere, runnerGpuDevices, runnerGpuPerDevice, runnerGpuState, sliceOverCards } from './gpu.js'
import { gpuCards } from '../kernel/resources.js'

/** A competition's "recent" runs: a competition lives for weeks, and its first runs solved a different task. */
const RECENT_RUNS = 20
/** The instance's recent runs — the fallback for a competition that has barely run. */
const INSTANCE_RUNS = 50

export interface Forecast {
  running: QueueRow[]
  /**
   * Claimable waiting jobs, in the order they will be taken: by place, and
   * after them the GPU work that has no card to start on at all.
   */
  eligible: QueueRow[]
  /** Postponed by a resource retry: visible, but not claimable yet. */
  deferred: QueueRow[]
  /** Per claimable waiting submission: its 1-based place, and when it starts and when its result is expected. */
  at: Map<string, { place: number; startMs: number; etaMs: number }>
}

/**
 * `gpuSlots` — how many runs may hold a card share at once (under the
 * cluster, a place among its units); `null` — no card is counted at all, and
 * GPU work is simulated like any other. By default what the screens show
 * (forecastGpuSlots).
 */
export function queueForecast(slots: number, now = Date.now(), gpuSlots: number | null = forecastGpuSlots(now)): Forecast {
  const rows = queueRows()
  const running = rows.filter((row) => row.state === 'running')
  const waiting = rows.filter((row) => row.state === 'waiting')
  const busy = new Set(running.map((row) => row.entrantId))
  const preferred = fairOrder(waiting.filter((row) => row.notBefore <= now), busy)
  const deferred = fairOrder(waiting.filter((row) => row.notBefore > now), busy)
  const expected = runEstimator()
  const needsCard = cardNeeds()
  // Under the cluster a running GPU notebook holds no card of ours, but it does hold one of the cluster's places.
  const cluster = !runnerCardsHere()
  const etas = queueEtas({
    slots,
    running: running.map((row) => ({
      expectedMs: expected(row),
      elapsedMs: row.startedAt === null ? 0 : Math.max(0, now - row.startedAt),
      gpu: row.gpu !== null || (cluster && needsCard(row)),
    })),
    waiting: preferred.map((row) => ({ expectedMs: expected(row), gpu: needsCard(row) })),
    ...(gpuSlots === null ? {} : { gpuSlots }),
  })
  // Places by start; among jobs starting at one moment, the queue's order.
  const starting = preferred
    .map((row, index) => ({ row, index, eta: etas[index] }))
    .filter((entry): entry is { row: QueueRow; index: number; eta: Eta } => entry.eta !== null)
    .sort((a, b) => a.eta.startMs - b.eta.startMs || a.index - b.index)
  const at = new Map(starting.map((entry, place) => [entry.row.submissionId, { place: place + 1, ...entry.eta }] as const))
  const eligible = [...starting.map((entry) => entry.row), ...preferred.filter((row) => !at.has(row.submissionId))]
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

/**
 * Whether a waiting row needs a card share: a NOTEBOOK run of a competition
 * whose card is on — the rule of store.ts · NEEDS_CARD, read here off the
 * competition, once per competition per forecast.
 */
function cardNeeds(): (row: QueueRow) => boolean {
  const byCompetition = new Map<string, boolean>()
  return (row) => {
    if (row.kind !== 'notebook') return false
    let needs = byCompetition.get(row.competitionId)
    if (needs === undefined) {
      needs = getCompetition(row.competitionId)?.limits.gpu === true
      byCompetition.set(row.competitionId, needs)
    }
    return needs
  }
}

/* ------------------------------------------------- the cards on the screens */

/** The runner cards as both screens show them. */
export interface RunnerGpuPicture {
  /**
   * How many GPU runs may go at once: the cards given to submissions times
   * the runs per card, less the cards a class still holds (and every card
   * while docker cannot say who holds them) — what the queue takes by.
   */
  slots: number
  /** The share every run is promised, MB: the smallest card's; `null` — unknown. */
  sliceMb: number | null
  /**
   * Each card with the runs it may hold now (gpu.ts · runnerGpuState): what
   * the places taken are counted against (gpu.ts · placesTaken). A run shown
   * on a card carries its own share (QueueRow.gpuSliceMb), not one read here.
   */
  cards: ReadonlyArray<{ id: string; capacity: number }>
}

/** How long a count of the cards is drawn from before it is made again. */
const PICTURE_TTL_MS = 2_000

let picture: { key: string; at: number; value: RunnerGpuPicture } | null = null
let picturing: Promise<void> | null = null

/** The cards as configured right now: a count made for other cards is not this one. */
function pictureKey(devices: readonly string[], perDevice: number): string {
  return `${devices.join(',')}|${perDevice}`
}

/**
 * The runner cards for the screens; `null` — no card is given to
 * submissions here, or the cards are the cluster's.
 *
 * Drawn from the last count, and counted again behind the answer once that
 * is two seconds old: the console streams its state every second and a half,
 * every participant's page polls, and an honest count of the slots is a
 * census of the rooms' containers — a docker call per look would be one per
 * student per poll. Until the first count, and for a moment after the owner
 * changes the cards, the picture is the plain product of cards and runs per
 * card, with the share unknown: a number for a second, never a made-up size.
 */
export function runnerGpuPicture(now = Date.now()): RunnerGpuPicture | null {
  if (!runnerCardsHere()) return null
  const devices = runnerGpuDevices()
  if (devices.length === 0) return null
  const perDevice = runnerGpuPerDevice()
  const key = pictureKey(devices, perDevice)
  if (picture === null || picture.key !== key || now - picture.at >= PICTURE_TTL_MS) void startCount()
  if (picture?.key === key) return picture.value
  return { slots: devices.length * perDevice, sliceMb: null, cards: devices.map((id) => ({ id, capacity: perDevice })) }
}

/**
 * How many runs may hold a card share at once, as the forecast counts them:
 * none without runner cards (a GPU notebook there starts nowhere). Under the
 * cluster, the GPU notebooks the queue lets ask it at once (gpu.ts ·
 * clusterGpuSlots): simulated against every slot, as they were, a class of
 * GPU notebooks read "≈ 2 min" for a wait of an hour, and the CPU work behind
 * them read the same lie the other way.
 */
export function forecastGpuSlots(now = Date.now()): number | null {
  if (!runnerCardsHere()) return clusterGpuSlots()
  return runnerGpuPicture(now)?.slots ?? 0
}

/**
 * Count the cards now and keep the count; resolves when it is kept. A count
 * already under way may be for the cards as they were, so it is waited out
 * and a new one made. Never rejects.
 */
export async function refreshRunnerGpuPicture(): Promise<void> {
  while (picturing) await picturing
  await startCount()
}

/** One count at a time, whoever asks. */
function startCount(): Promise<void> {
  picturing ??= countCards()
    .catch(() => undefined)
    .finally(() => {
      picturing = null
    })
  return picturing
}

async function countCards(): Promise<void> {
  const devices = runnerGpuDevices()
  if (devices.length === 0) return
  const perDevice = runnerGpuPerDevice()
  const [state, cards] = await Promise.all([runnerGpuState(), gpuCards(devices)])
  picture = {
    key: pictureKey(devices, perDevice),
    at: Date.now(),
    value: {
      slots: state.slots,
      sliceMb: sliceOverCards(cards, perDevice),
      cards: state.cards.map((card) => ({ id: card.id, capacity: card.capacity })),
    },
  }
}
