/**
 * Video cards for competition submissions: which cards are given to them, how
 * many runs share one, how much video memory each run is promised, and which
 * card the next GPU run takes.
 *
 * WHY WHOLE CARDS, TAKEN OUT OF THE ROOMS' POOL. Until 13 Oct 2026 a
 * competition on `base-gpu` ran its CUDA torch on the CPU without a word to
 * anyone: the submission container had no device at all. Giving it one is the
 * easy half; the hard half is that docker does not refuse a second container
 * on a card, and a card shared by a lecture and a submission has no wall
 * between their video memory: a participant's runaway training kills the
 * lecture's. So the owner gives whole cards (entries of KERNEL_GPUS) to
 * submissions, and such a card leaves the rooms' pool (kernel/pool.ts ·
 * roomGpuDevices). Rooms and submissions never meet on a card.
 *
 * WHY A SHARE, AND WHY IT IS ENFORCED. Several submissions may time-share one
 * card (`perDevice`, 1 by default). Each is then promised the card's memory
 * divided among them, and the panel may promise it only because it is held
 * (the honesty rule of web/src/admin/ui/Resources.svelte): torch's allocator is
 * capped a little below the share (GPU_CONTEXT_MB: the CUDA context lives
 * outside it), and the docker runner kills a container that holds more than
 * the share plus a tolerance on two samples in a row (GPU_TOLERANCE_MB). With
 * one run per card the run has the whole card, and nothing is capped. A card
 * that cannot say its memory gets no share at all — no cap, no watchdog — and
 * the panel says the size is unknown instead of making one up.
 *
 * WHAT IS NOT HERE: the setting itself (competitions/settings.ts, which the
 * pool can import without a cycle), and the queue: which job waits for a card
 * is decided where the job is taken (store.ts · takeNext), with
 * `runnerGpuState`, `cardsInUse` and `pickRunnerGpu` below as its numbers and
 * its rule. Under Kubernetes none of this applies: the cluster defines the
 * card share (RUNTIME_COMPETITION_GPU_RESOURCE), and the panel neither lists
 * nor gives cards there; the queue only keeps the number of GPU notebooks the
 * broker says it has units for (`clusterGpuSlots`).
 */
import { gpuAssignments, gpuDevices, submissionGpuCards, submissionsUseLocalCards } from '../kernel/pool.js'
import { gpuCards } from '../kernel/resources.js'
import { kernelBackend } from '../kernel/runtime-client.js'
import { needsGpu } from '../environments.js'
import { gpuPerDeviceSetting, resolveGpuPerDevice, resolveRunnerGpus, runnerGpuSetting } from './settings.js'
import { SETTINGS_LIMITS, type CompetitionGpuSettings } from '@shared/competitions-settings'
import { COMPETITION_GPU_SLOTS_MAX } from '@shared/competition-runtime'

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
 * How long an answer waits for a card nobody has asked about yet; after that
 * the size is unknown on this answer, and known on the next. A card asked
 * about before is answered from memory at once (kernel/resources.ts ·
 * gpuCards), so this is the wait of a card never asked about, and nothing else.
 *
 * The same short wait for the owner's settings form. It used to wait eight
 * seconds, being where the sizes are read, and on the first open after a
 * restart that was the whole Resources tab blank for the probe. The server
 * now asks every card from its start (kernel/resources.ts · watchGpuCards),
 * so a card is never asked about only in the seconds before that first
 * answer — a form opened then joins the probe for this long, and asks again
 * by itself while a size is unknown (web/src/admin/runner-cards.ts ·
 * sizesUnknown).
 */
const CARD_WAIT_MS = 1_500

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

/* ------------------------------------------------------------ the cards */

/**
 * Whether submissions run on the cards of this machine at all: the docker
 * runner and its test stand-in do; under the broker the cluster has them.
 * The pool's own rule (kernel/pool.ts · submissionsUseLocalCards), so that the
 * cards it withholds from rooms and the cards given here never disagree.
 */
export function runnerCardsHere(): boolean {
  return submissionsUseLocalCards()
}

/**
 * How many GPU notebooks of this instance may run at once under the cluster:
 * what the broker reports as competition.gpuSlots (its units of the GPU
 * resource for submissions), noted by the pump on every pass (runner.ts ·
 * pumpOnce) and read by the forecast between passes.
 *
 * One until the broker says, and whenever it says nothing usable (a broker
 * from before the number, or no GPU resource at all): the queue then lets one
 * GPU notebook ask the cluster at a time, which is the most a cluster that
 * did not say can be trusted with. Without a number the queue sent every GPU
 * notebook in its turn, each held a general slot while its Pod waited for a
 * unit, and the CPU work behind them waited for hours.
 */
let clusterSlots = 1

export function noteClusterGpuSlots(reported: unknown): number {
  clusterSlots = typeof reported === 'number' && Number.isSafeInteger(reported) && reported > 0
    ? Math.min(COMPETITION_GPU_SLOTS_MAX, reported)
    : 1
  return clusterSlots
}

export function clusterGpuSlots(): number {
  return clusterSlots
}

/**
 * The cards given to submissions in effect: the chosen ones that KERNEL_GPUS
 * still lists, in KERNEL_GPUS order. A card the operator removed from
 * KERNEL_GPUS may not be on the machine any more; it is dropped here, not
 * handed to `docker run`.
 */
export function runnerGpuDevices(): string[] {
  if (!runnerCardsHere()) return []
  const chosen = new Set(runnerGpuSetting().devices)
  // Each card once, even if KERNEL_GPUS names it twice: twice would double its runs.
  return [...new Set(gpuDevices())].filter((device) => chosen.has(device))
}

/** How many runs share one runner card at a time. */
export function runnerGpuPerDevice(): number {
  return gpuPerDeviceSetting().value
}

/**
 * The share every GPU run is promised now, MB (`sliceOverCards` over the
 * runner cards); `null` — no card, a card of unknown size, or the cluster's
 * business. `waitMs` bounds the wait for a card asked about for the first time.
 */
export async function runnerSliceMb(options: { waitMs?: number } = {}): Promise<number | null> {
  const devices = runnerGpuDevices()
  if (devices.length === 0) return null
  return sliceOverCards(await gpuCards(devices, options), runnerGpuPerDevice())
}

/**
 * The share of a run on THIS card, MB — what the run itself is capped to
 * (RunRequest.gpu.sliceMb). Per card, not the smallest: the panel promises "at
 * least", and a run on the bigger card gets its bigger share. `perDevice` —
 * the runs per card the run was taken at (QueueRow.gpuPerDevice); without it,
 * the number in force.
 */
export async function gpuSliceFor(device: string, options: { waitMs?: number; perDevice?: number } = {}): Promise<number | null> {
  const [card] = await gpuCards([device], { waitMs: options.waitMs })
  return gpuSliceMb(card?.memoryMb ?? null, options.perDevice ?? runnerGpuPerDevice())
}

/**
 * What a competition's page says next to its limits: the share a run gets,
 * or `null` for a competition on the CPU and for a size nobody knows.
 */
export async function competitionGpuSliceMb(competition: { limits: { gpu?: boolean } }): Promise<number | null> {
  if (competition.limits.gpu !== true) return null
  return runnerSliceMb({ waitMs: CARD_WAIT_MS })
}

/**
 * Whether an environment needs a GPU, and "no" instead of an exception: under
 * the broker an environment missing from the catalog throws, and a form's
 * refusal must name the problem, not fail on it.
 */
export function environmentNeedsGpu(name: string): boolean {
  try {
    return needsGpu(name)
  } catch {
    return false
  }
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
 * The cards rooms' containers hold right now, by their `colloq.gpu` labels,
 * stopped containers included (they come back with the same card); `null` —
 * docker did not answer. Without docker rooms there are no room containers at
 * all, so nothing is held.
 */
export async function roomHeldCards(): Promise<Set<string> | null> {
  if (kernelBackend() !== 'docker') return new Set()
  try {
    return new Set((await gpuAssignments({ strict: true })).map((held) => held.gpu).filter((gpu) => gpu.length > 0))
  } catch {
    return null
  }
}

/**
 * The runner cards now: each card's capacity (`perDevice`, or 0 while a room
 * holds it) and how many runs hold it. `busy` is the queue's count per card
 * (its running rows); `held` replaces the census, for tests.
 */
export async function runnerGpuState(options: {
  busy?: ReadonlyMap<string, number>
  held?: () => Promise<Set<string> | null>
} = {}): Promise<RunnerGpuState> {
  const devices = runnerGpuDevices()
  const perDevice = runnerGpuPerDevice()
  const heldByRooms = devices.length === 0 ? new Set<string>() : await (options.held ?? roomHeldCards)()
  const cards = runnerGpuCards({ devices, perDevice, heldByRooms, busy: options.busy })
  return {
    cards,
    perDevice,
    slots: cards.reduce((sum, card) => sum + card.capacity, 0),
    busy: cards.reduce((sum, card) => sum + card.busy, 0),
    census: heldByRooms !== null,
  }
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

/* ---------------------------------------------------------- the owner's form */

/**
 * The «Видеокарты для посылок» block of the Resources tab: every card of
 * KERNEL_GPUS with its name, size and holder, the chosen ones, runs per card
 * and the share that makes. Under the broker an empty, managed block: the
 * cluster has the cards.
 */
export async function gpuSettingsView(options: { waitMs?: number } = {}): Promise<CompetitionGpuSettings> {
  const setting = runnerGpuSetting()
  const perDevice = gpuPerDeviceSetting()
  const bounds = { perDevice: { min: SETTINGS_LIMITS.gpuPerDevice.min, max: SETTINGS_LIMITS.gpuPerDevice.max } }
  const source = { devices: setting.source, perDevice: perDevice.source }
  if (!runnerCardsHere()) {
    return { cards: [], devices: [], perDevice: perDevice.value, sliceMb: null, source, bounds, managed: true }
  }
  const all = [...new Set(gpuDevices())]
  const chosen = new Set(setting.devices)
  const [cards, held, running] = await Promise.all([
    gpuCards(all, { waitMs: options.waitMs ?? CARD_WAIT_MS }),
    // For the picture only: an unread census shows every card as nobody's.
    all.length === 0 ? Promise.resolve([]) : gpuAssignments().catch(() => []),
    /*
     * And the submissions' containers, by the same label: a card the owner
     * gave back to classes while a submission still ran on it read «свободна»
     * here, while the bar above counted it as the submissions' and a class
     * starting on it was refused until the run ended.
     */
    all.length === 0 ? Promise.resolve([] as string[]) : submissionGpuCards().catch(() => [] as string[]),
  ])
  const heldByRoom = new Set(held.map((room) => room.gpu))
  const heldBySubmission = new Set(running)
  return {
    cards: cards.map((card) => ({
      id: card.id,
      name: card.name,
      memoryMb: card.memoryMb,
      holder: chosen.has(card.id) ? 'runners' : heldByRoom.has(card.id) ? 'rooms' : heldBySubmission.has(card.id) ? 'runners' : 'free',
      heldByRoom: heldByRoom.has(card.id),
      heldBySubmission: heldBySubmission.has(card.id),
    })),
    devices: all.filter((device) => chosen.has(device)),
    perDevice: perDevice.value,
    sliceMb: sliceOverCards(cards.filter((card) => chosen.has(card.id)), perDevice.value),
    source,
    bounds,
    managed: false,
    fallback: runnerGpuFallback(all),
  }
}

/**
 * What the owner's «вернуть …» falls back to: the same rule as the setting
 * with nothing saved (settings.ts · resolveRunnerGpus, resolveGpuPerDevice),
 * so the form can show the cards and the share Save will leave, and name
 * .env when that is where they come from. Only the cards `all` (KERNEL_GPUS)
 * lists, as for the chosen ones.
 */
function runnerGpuFallback(all: readonly string[]): NonNullable<CompetitionGpuSettings['fallback']> {
  const devices = resolveRunnerGpus({ saved: null, env: process.env.COMPETITION_GPUS })
  const perDevice = resolveGpuPerDevice({ saved: null, env: process.env.COMPETITION_GPU_PER_DEVICE })
  const named = new Set(devices.devices)
  return {
    devices: all.filter((device) => named.has(device)),
    perDevice: perDevice.value,
    source: { devices: devices.source === 'env' ? 'env' : 'default', perDevice: perDevice.source === 'env' ? 'env' : 'default' },
  }
}
