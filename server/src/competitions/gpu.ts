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
 * `runnerGpuState` below and `cardsInUse` and `pickRunnerGpu` as its numbers
 * and its rule. Those numbers and that rule — the share, the allocator's cap,
 * the kill line, the places a card holds, the card the next run takes — are
 * arithmetic, and live in gpu-math.ts, which a machine that runs submissions
 * for this server imports without the room pool and the database behind this
 * module (docs/architecture/remote-runners.md); every name is re-exported
 * here, so nothing that imports it from this module changes. Under Kubernetes
 * none of this applies: the cluster defines the card share
 * (RUNTIME_COMPETITION_GPU_RESOURCE), and the panel neither lists nor gives
 * cards there; the queue only keeps the number of GPU notebooks the broker
 * says it has units for (`clusterGpuSlots`).
 */
import { gpuAssignments, gpuDevices, submissionGpuCards, submissionsUseLocalCards } from '../kernel/pool.js'
import { gpuCards } from '../kernel/resources.js'
import { kernelBackend } from '../kernel/runtime-client.js'
import { needsGpu } from '../environments.js'
import { gpuPerDeviceSetting, resolveGpuPerDevice, resolveRunnerGpus, runnerGpuSetting } from './settings.js'
import { gpuSliceFor as sliceOnCard, gpuSliceMb, runnerGpuCards, sliceOverCards, type RunnerGpuState } from './gpu-math.js'
import { SETTINGS_LIMITS, type CompetitionGpuSettings } from '@shared/competitions-settings'
import { COMPETITION_GPU_SLOTS_MAX } from '@shared/competition-runtime'
import { REMOTE_PER_DEVICE_MAX } from '@shared/remote-runner'
import { remoteCardsSeen, runnerCards } from './remote/heard.js'

/*
 * The arithmetic of a share and of a card's places (gpu-math.ts), under the
 * names everything has always imported from here. `gpuSliceFor` is the one
 * exception: this module's own is home's call of it, below.
 */
export {
  GPU_ALLOCATOR_FLOOR_MB,
  GPU_CONTEXT_MB,
  GPU_TOLERANCE_MB,
  cardsInUse,
  gpuAllocatorMb,
  gpuKillAboveMb,
  gpuSliceMb,
  pickRunnerGpu,
  placesTaken,
  runnerGpuCards,
  sliceOverCards,
  type CardSizes,
  type RunnerGpuCard,
  type RunnerGpuState,
} from './gpu-math.js'

/* ------------------------------------------------------- waiting for a card */

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
 * (RunRequest.gpu.sliceMb): gpu-math.ts · gpuSliceFor, with this server's
 * sizes, those of the inventory of KERNEL_GPUS. `perDevice` — the runs per
 * card the run was taken at (QueueRow.gpuPerDevice); without it, the number
 * in force.
 */
export async function gpuSliceFor(device: string, options: { waitMs?: number; perDevice?: number } = {}): Promise<number | null> {
  return sliceOnCard(device, { cards: gpuCards, perDevice: options.perDevice ?? runnerGpuPerDevice(), waitMs: options.waitMs })
}

/**
 * What a competition's page says next to its limits: the share a run gets,
 * or `null` for a competition on the CPU and for a size nobody knows.
 */
export async function competitionGpuSliceMb(competition: { limits: { gpu?: boolean } }): Promise<number | null> {
  if (competition.limits.gpu !== true) return null
  /*
   * The promise is the smallest share a run may get anywhere it may run:
   * this server's cards, and the cards of the machines heard within the
   * hour (decision 8, §5.8 "The promised share is the one on the smallest
   * advertised card") — each card's memory over the runs per card that
   * machine is held to. A card that did not say its size makes the promise
   * unknown, as it does here.
   */
  const remote = remoteSliceMb()
  if (runnerGpuDevices().length === 0) return remote === undefined ? null : remote
  const here = await runnerSliceMb({ waitMs: CARD_WAIT_MS })
  if (remote === undefined) return here
  return here === null || remote === null ? null : Math.min(here, remote)
}

/** The smallest share on the machines' cards heard within the hour; `undefined` — none has cards; `null` — a size unknown. */
function remoteSliceMb(): number | null | undefined {
  const seen = remoteCardsSeen()
  let least: number | null | undefined
  for (const runner of seen.runners) {
    const perDevice = Math.min(REMOTE_PER_DEVICE_MAX, Math.max(1, runner.perDevice ?? runnerGpuPerDevice()))
    for (const card of runnerCards(runner)) {
      const slice = gpuSliceMb(card.memoryMb, perDevice)
      if (slice === null) return null
      least = least === undefined || least === null ? slice : Math.min(least, slice)
    }
  }
  return least
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
