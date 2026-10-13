/**
 * The numbers of a submission's share of a video card, and the rule for which
 * card the next GPU run takes: arithmetic, with nothing behind it.
 *
 * WHY A MODULE OF ITS OWN. competitions/gpu.ts answers these questions for
 * THIS server: its cards are entries of KERNEL_GPUS, its runs per card are the
 * owner's setting, and its rooms may hold a card. A machine that runs
 * submissions for a home instance (docs/architecture/remote-runners.md,
 * «машины для посылок») owns its cards instead: it probes them itself
 * (kernel/card-probe.ts), home pins the runs per card on each lease, and the
 * machine picks the device and cuts the share with the very rule home uses,
 * so that a run is capped and watched alike wherever it lands. Its agent
 * (dist/runner.js) must load that rule without the room pool, the database
 * and the settings behind gpu.ts, so the rule lives here, pure, and gpu.ts
 * re-exports every name: nothing that imports it from there changes.
 *
 * Where a number needs a card's size, the caller says where sizes come from
 * (`CardSizes`): home's inventory of KERNEL_GPUS (kernel/resources.ts ·
 * gpuCards) or the machine's own probe. Why whole cards, why a share and why
 * it is held is the header of gpu.ts; the numbers below are those reasons in
 * figures.
 */
import { SETTINGS_LIMITS } from '@shared/competitions-settings'

/* ---------------------------------------------------------------- numbers */

/**
 * What the CUDA context takes outside torch's allocator, MB: measured at
 * ~458 MB on an RTX 4090 with torch 2.14 / CUDA 13.0, rounded up. The
 * allocator's cap is the share minus this, so that the context and the
 * allocations together stay inside the share.
 */
export const GPU_CONTEXT_MB = 512

/**
 * How far past its share a run may be seen before it is killed, MB: the
 * context is not the same size on every card and driver, and a watchdog that
 * kills an honest run for 30 MB of driver bookkeeping is worse than none.
 */
export const GPU_TOLERANCE_MB = 256

/** The allocator never gets less than this, however small the share: a run must be able to start. */
export const GPU_ALLOCATOR_FLOOR_MB = 256

/**
 * A run's share of a card, MB: the card's memory over the runs sharing it,
 * rounded down. `null` when the card's memory is unknown: nothing is promised
 * then, and nothing enforced.
 */
export function gpuSliceMb(cardMb: number | null, perDevice: number): number | null {
  if (cardMb === null || !Number.isFinite(cardMb) || cardMb <= 0) return null
  return Math.floor(cardMb / Math.max(1, Math.floor(perDevice)))
}

/** The cap given to torch's allocator for a share (COLLOQ_GPU_MEMORY_MB): the share less the context, never below the floor. */
export function gpuAllocatorMb(sliceMb: number): number {
  return Math.max(GPU_ALLOCATOR_FLOOR_MB, sliceMb - GPU_CONTEXT_MB)
}

/** Above this many MB, seen twice in a row, the docker runner kills the run from outside. */
export function gpuKillAboveMb(sliceMb: number): number {
  return sliceMb + GPU_TOLERANCE_MB
}

/**
 * The smallest share over these cards — what every run is promised whichever
 * card it lands on. `null` when there is no card, or when any of them did not
 * say its size: a promise that holds on some cards only is not one.
 */
export function sliceOverCards(cards: ReadonlyArray<{ memoryMb: number | null }>, perDevice: number): number | null {
  let least: number | null = null
  for (const card of cards) {
    const slice = gpuSliceMb(card.memoryMb, perDevice)
    if (slice === null) return null
    least = least === null ? slice : Math.min(least, slice)
  }
  return least
}

/**
 * Where a card's size comes from: the cards behind these ids, in the same
 * order, each with its memory (`null` — it did not say). Home answers from its
 * inventory of KERNEL_GPUS (kernel/resources.ts · gpuCards), a machine for
 * submissions from its own probe. `waitMs` bounds the wait for a card never
 * asked about before; past it the card is unknown on this answer.
 */
export type CardSizes = (
  devices: readonly string[],
  options: { waitMs?: number },
) => Promise<ReadonlyArray<{ memoryMb: number | null }>>

/**
 * The share of a run on THIS card, MB — what the run itself is capped to
 * (RunRequest.gpu.sliceMb). Per card, not the smallest: the panel promises "at
 * least", and a run on the bigger card gets its bigger share. `perDevice` —
 * the runs per card the run was taken at (QueueRow.gpuPerDevice at home, the
 * lease's pin on a machine); `cards` — where the card's size comes from.
 * Home's own call, with its inventory and its setting filled in, is gpu.ts ·
 * gpuSliceFor.
 */
export async function gpuSliceFor(
  device: string,
  options: { cards: CardSizes; perDevice: number; waitMs?: number },
): Promise<number | null> {
  const [card] = await options.cards([device], { waitMs: options.waitMs })
  return gpuSliceMb(card?.memoryMb ?? null, options.perDevice)
}

/* -------------------------------------------------------- the queue's numbers */

/** One runner card as the queue sees it. */
export interface RunnerGpuCard {
  id: string
  /**
   * How many runs it may hold at once: `perDevice`, or 0 while a room's
   * container still holds it (a card given to submissions stays with the class
   * that had it until its container ends — kernel/pool.ts · roomGpuDevices).
   */
  capacity: number
  /** Runs holding it now, by the queue's own count. */
  busy: number
}

export interface RunnerGpuState {
  cards: RunnerGpuCard[]
  perDevice: number
  /** How many GPU runs may go at once: the sum of the capacities. */
  slots: number
  /** How many hold a card now. */
  busy: number
  /**
   * Whether docker answered which cards the rooms' containers hold. When it
   * did not, every card counts as held (capacity 0): a GPU run waits for an
   * answer rather than landing on a lecture's card.
   */
  census: boolean
}

/** Pure: the cards with their capacities, from the rooms' hold on them (`null` — unknown, so all held). */
export function runnerGpuCards(input: {
  devices: readonly string[]
  perDevice: number
  heldByRooms: ReadonlySet<string> | null
  busy?: ReadonlyMap<string, number>
}): RunnerGpuCard[] {
  return input.devices.map((id) => ({
    id,
    capacity: input.heldByRooms === null || input.heldByRooms.has(id) ? 0 : Math.max(1, Math.floor(input.perDevice)),
    busy: input.busy?.get(id) ?? 0,
  }))
}

/**
 * A card counted in parts: 840 divides by every runs-per-card the setting
 * allows (1–8, SETTINGS_LIMITS.gpuPerDevice), so shares taken under different
 * settings add up exactly, with no rounding to decide whether a card is full.
 */
const CARD_PARTS = 840

/** What a run taken at `perDevice` runs per card holds of its card, in CARD_PARTS. */
function partsOf(perDevice: number): number {
  const range = SETTINGS_LIMITS.gpuPerDevice
  return CARD_PARTS / Math.min(range.max, Math.max(range.min, Math.floor(perDevice) || range.min))
}

/**
 * How many runs each card holds now, in the share a new run would take there
 * (its `capacity`, the runs per card in force): what pickRunnerGpu compares
 * with the capacity. Pure, so the queue can call it inside its transaction.
 *
 * Weighed by the share each run was given (QueueRow.gpuPerDevice), not
 * counted by heads. A run taken at one run per card holds the whole card —
 * uncapped and unwatched (docker-runner.ts · heldShareMb) — and a run taken
 * at two holds half of it, whatever the owner has set since: counted by
 * heads, a raise from one to two put a capped run next to an uncapped one,
 * and from two to four put 12 + 12 + 6 + 6 GB on a 24 GB card. A run with no
 * number pinned (a row from before the pin) and a container still awaiting
 * removal (`held`) count as one share at the number in force, as both did
 * before. The answer is the places taken: the capacity less the whole
 * shares still left, so a card is full exactly when a new share no longer
 * fits — the same answer as a head count while every run has the share in
 * force.
 */
export function cardsInUse(
  cards: ReadonlyArray<{ id: string; capacity: number }>,
  runs: ReadonlyArray<{ device: string; perDevice: number | null }>,
  held: Readonly<Record<string, number>> = {},
): Map<string, number> {
  const capacity = new Map(cards.map((card) => [card.id, card.capacity]))
  const parts = new Map<string, number>()
  const add = (device: string, value: number) => parts.set(device, (parts.get(device) ?? 0) + value)
  // A card that takes no run now (a class holds it) has no number in force: what is on it counts whole.
  const inForce = (device: string) => partsOf(capacity.get(device) || 1)
  for (const run of runs) add(run.device, run.perDevice === null ? inForce(run.device) : partsOf(run.perDevice))
  for (const [device, count] of Object.entries(held)) {
    if (Number.isFinite(count) && count > 0) add(device, Math.floor(count) * inForce(device))
  }
  const used = new Map<string, number>()
  for (const [device, load] of parts) {
    const places = capacity.get(device) ?? 0
    used.set(device, places > 0 ? places - Math.max(0, Math.floor((CARD_PARTS - load) / partsOf(places))) : Math.ceil(load / CARD_PARTS))
  }
  return used
}

/**
 * How many of the runner cards' places are taken, for the console
 * (QueueSnapshot.gpu.busy): the places taken on each card that takes runs
 * (cardsInUse), and one for each run on a card that takes none now — given
 * back to classes, or held by one — which is still a run.
 */
export function placesTaken(
  cards: ReadonlyArray<{ id: string; capacity: number }>,
  runs: ReadonlyArray<{ device: string; perDevice: number | null }>,
): number {
  const used = cardsInUse(cards, runs)
  const taking = new Map(cards.filter((card) => card.capacity > 0).map((card) => [card.id, card.capacity]))
  let taken = runs.filter((run) => !taking.has(run.device)).length
  for (const [device, capacity] of taking) taken += Math.min(capacity, used.get(device) ?? 0)
  return taken
}

/**
 * Which card the next GPU run takes: the least loaded card that still has
 * room, the first in the list on a tie (the list is in KERNEL_GPUS order);
 * `null` — every card is full or held by a class, and the run waits. `busy`
 * is what each card holds in places (cardsInUse): runs, while every run
 * there has the share in force.
 *
 * Least loaded rather than "the first with room": two runs time-sharing one
 * card while the second card idles is half the speed for nothing. Pure, so
 * the queue can call it inside its transaction with the counts it reads there.
 */
export function pickRunnerGpu(
  capacity: ReadonlyArray<{ id: string; capacity: number }>,
  busy: ReadonlyMap<string, number>,
): string | null {
  let best: { id: string; load: number } | null = null
  for (const card of capacity) {
    const load = busy.get(card.id) ?? 0
    if (load >= card.capacity) continue
    if (best === null || load < best.load) best = { id: card.id, load }
  }
  return best?.id ?? null
}
