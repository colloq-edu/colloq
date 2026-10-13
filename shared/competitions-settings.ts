/**
 * The instance's competition settings: how many submissions run at once, how
 * often one participant may upload, and what a NEW competition starts with.
 *
 * A file of its own rather than more fields in `competitions-api.ts`: these
 * are settings of the MACHINE, not of one competition, and they travel through
 * their own pair of doors (`/api/admin/competitions/settings`). The bounds for
 * the defaults are the competition editor's own (`LIMITS`): a default the
 * editor would refuse to save is not a default.
 */
import { LIMITS, type CompetitionLimits } from './competitions.js'
import { REMOTE_BLOB_MBPS, REMOTE_UPLOADS } from './remote-runner.js'

export const SETTINGS_LIMITS = {
  /** Parallel executors when the owner fixes the number by hand. */
  slots: { min: 1, max: 64 },
  /** Uploads per minute per participant — the parsing budget, not the day's quota. */
  uploadsPerMinute: { min: 1, max: 120, default: 12 },
  wallSeconds: LIMITS.wallSeconds,
  memoryMb: LIMITS.memoryMb,
  cpus: LIMITS.cpus,
  perDay: LIMITS.perDay,
  /**
   * Submissions that share one runner card at a time. One by default: a card
   * time-shared by two notebooks is two notebooks each running at half speed
   * with half the video memory, and that is a choice the owner makes, not a
   * default. Eight is where a 24 GB card leaves each run less than its CUDA
   * context and a model worth training.
   */
  gpuPerDevice: { min: 1, max: 8, default: 1 },
  /**
   * «Тетради на этом сервере»: whether this server runs notebooks at all, or
   * only scores what machines that run submissions sent back
   * (docs/architecture/remote-runners.md §5.3). On by default, and that is
   * every server from before the machines: without one, a server that ran no
   * notebooks would run nothing.
   */
  homeNotebooks: { default: true },
  /**
   * The metric lane's places: metric-only work this server runs at once — a
   * rescore, or the metric of a notebook a machine ran (runner.ts · pumpOnce).
   * Two by default: a metric holds two gigabytes at most for a few seconds,
   * and with the class on the same machine the lane is a tail to keep short,
   * not a queue to make wide (§5.7, Q5). Eight is where a burst of results
   * would take the class's memory instead.
   */
  scoreSlots: { min: 1, max: 8, default: 2 },
  /**
   * «Скорость раздачи», MB/s for every blob the machines fetch, all together
   * (shared/remote-runner.ts · REMOTE_BLOB_MBPS); the default is a placeholder
   * until the relay is measured (§4.5, P0).
   */
  runnerBlobMBps: REMOTE_BLOB_MBPS,
  /** Results the machines upload that this server stores at once (REMOTE_UPLOADS); past them 503 with Retry-After. */
  runnerUploads: REMOTE_UPLOADS,
} as const

/** Where a number came from: the owner's choice, the environment, or our default. */
export type SettingSource = 'saved' | 'env' | 'default'

/**
 * How many submissions the queue runs at once.
 *
 * `value` is what the setting names (the fixed number, or what `auto` works
 * out for this machine), `effective` is what the pump uses right now after
 * clamping — the two differ only for a stored number the bounds no longer
 * allow.
 */
export interface SlotsResolution {
  mode: 'auto' | 'fixed'
  value: number
  effective: number
  source: SettingSource
}

/**
 * The limits a new competition starts with, field by field.
 *
 * Without the card: a new competition is born on the `base` environment, which
 * has no use for one, and whether a competition gets a card is the teacher's
 * switch on an environment that needs it (CompetitionLimits.gpu), never a
 * machine-wide default that would hand cards to competitions nobody looked at.
 */
export type CompetitionDefaults = Omit<CompetitionLimits, 'gpu'>

/**
 * One entry of `KERNEL_GPUS` as the owner's form shows it.
 *
 * `holder` is who the card is for: `runners` — given to competition
 * submissions, or given back to classes while a submission still runs on it;
 * `rooms` — in the rooms' pool and held by a room's container right now;
 * `free` — in the rooms' pool and held by nobody. `heldByRoom` says the
 * room's container is on it whatever the holder: a card given to submissions
 * while a class still had it stays with that class until its container ends,
 * and submissions wait for it until then. `heldBySubmission` is the mirror:
 * a submission's container is on it (by the `colloq.gpu` label), so a card
 * given back to classes mid-run stays the submission's until the run ends,
 * and no class can start on it meanwhile (kernel/pool.ts · takeGpu).
 *
 * `name` and `memoryMb` are what the card says about itself (nvidia-smi, from
 * the server or from a throwaway container); `null` — it could not be asked,
 * and the form then says the size is unknown rather than guessing.
 */
export interface CompetitionGpuCard {
  id: string
  name: string | null
  memoryMb: number | null
  holder: 'runners' | 'rooms' | 'free'
  heldByRoom: boolean
  heldBySubmission: boolean
}

/**
 * The cards competition submissions run on — the «Видеокарты для посылок»
 * block of the Resources tab.
 */
export interface CompetitionGpuSettings {
  /** Every card of `KERNEL_GPUS`, in its order; empty under Kubernetes, where the cluster has them. */
  cards: CompetitionGpuCard[]
  /** The cards given to submissions in effect: the chosen ones that are in `KERNEL_GPUS`. */
  devices: string[]
  /** Submissions sharing one card at a time. */
  perDevice: number
  /**
   * The video memory every GPU run is promised, MB: a card's memory divided
   * by `perDevice`, the smallest over the given cards — whichever card a run
   * lands on, it gets at least this. With one run per card it is the whole
   * card. `null` — no card is given, or one of them could not say its size;
   * then nothing is promised and nothing is enforced.
   */
  sliceMb: number | null
  source: { devices: SettingSource; perDevice: SettingSource }
  bounds: { perDevice: { min: number; max: number } }
  /**
   * Set by the cluster, not by this form: under Kubernetes the submissions'
   * card is a resource of the cluster (RUNTIME_COMPETITION_GPU_RESOURCE), and
   * the panel neither lists nor gives cards.
   */
  managed: boolean
  /**
   * What answers once a saved choice is forgotten (`gpuDevices: null`,
   * `gpuPerDevice: null`): the cards COMPETITION_GPUS names that
   * `KERNEL_GPUS` lists, and COMPETITION_GPU_PER_DEVICE — or, unset, the
   * defaults: no card, one run per card. The owner's «вернуть …» shows it at
   * once and names its source. Absent under the cluster, and from a server
   * from before it.
   */
  fallback?: {
    devices: string[]
    perDevice: number
    source: { devices: Exclude<SettingSource, 'saved'>; perDevice: Exclude<SettingSource, 'saved'> }
  }
}

export interface CompetitionSettings {
  slots: SlotsResolution & {
    /** What `auto` would give on this machine — shown next to a fixed number. */
    auto: number
    /**
     * What one automatic slot is sized for: the default CPUs, and the default
     * memory plus the container's 256 MB cushion.
     */
    perSlot: { cpus: number; memoryMb: number }
  }
  uploadsPerMinute: { value: number; source: Exclude<SettingSource, 'env'> }
  defaults: CompetitionDefaults
  defaultSources: Record<keyof CompetitionDefaults, Exclude<SettingSource, 'env'>>
  /** The machine the numbers are checked against: `docker info` or the host. */
  machine: { cpus: number; memoryMb: number }
  /** What the form may send; memory and CPUs are capped by the machine. */
  bounds: {
    slots: { min: number; max: number }
    uploadsPerMinute: { min: number; max: number }
    wallSeconds: { min: number; max: number }
    memoryMb: { min: number; max: number }
    cpus: { min: number; max: number }
    perDay: { min: number; max: number }
  }
  /** The cards given to competition submissions. */
  gpu: CompetitionGpuSettings
}

/**
 * What the owner's form sends. Every field is optional; `null` (or an empty
 * string) removes the stored value, and the number falls back to the
 * environment or the default.
 */
export interface CompetitionSettingsInput {
  slots?: 'auto' | number | null
  uploadsPerMinute?: number | null
  wallSeconds?: number | null
  memoryMb?: number | null
  cpus?: number | null
  perDay?: number | null
}

/**
 * The runner cards' half of the same form, on the same door.
 *
 * Its own interface, not two more fields above: everything above is a number
 * the form reads from a text field, and a list of cards is not one — a form
 * that walks the fields above as numbers stays right without learning about
 * lists. The door takes both halves in one body
 * (`CompetitionSettingsInput & CompetitionGpuSettingsInput`).
 *
 * `gpuDevices` — the `KERNEL_GPUS` entries given to submissions, `[]` to give
 * none; `gpuPerDevice` — submissions per card. `null` forgets the saved value,
 * and COMPETITION_GPUS / COMPETITION_GPU_PER_DEVICE or the default answer
 * again.
 */
export interface CompetitionGpuSettingsInput {
  gpuDevices?: string[] | null
  gpuPerDevice?: number | null
}

/**
 * The settings of machines that run submissions (Resources → «Машины для
 * посылок», docs/architecture/remote-runners.md §5.1), as read: each value
 * with where it came from. Machine-wide, like everything in this file; the
 * same box and the same pair of doors.
 *
 * `homeNotebooks` — this server runs notebooks too (off: it only scores what
 * the machines send back). `scoreSlots` — the metric lane's places.
 * `runnerBlobMBps` — the rate of every blob the machines fetch, together.
 * `runnerUploads` — results stored at once.
 */
export interface CompetitionRunnerSettings {
  homeNotebooks: { value: boolean; source: Exclude<SettingSource, 'env'> }
  scoreSlots: { value: number; source: Exclude<SettingSource, 'env'> }
  runnerBlobMBps: { value: number; source: Exclude<SettingSource, 'env'> }
  runnerUploads: { value: number; source: Exclude<SettingSource, 'env'> }
}

/**
 * What the owner's form sends for them, on the same door as the halves above
 * (`CompetitionSettingsInput & CompetitionGpuSettingsInput &
 * CompetitionRunnerSettingsInput`). An interface of its own for the same
 * reason the cards have one: a switch is not a number from a text field.
 * `null` forgets the saved value, and the default answers again.
 */
export interface CompetitionRunnerSettingsInput {
  homeNotebooks?: boolean | null
  scoreSlots?: number | null
  runnerBlobMBps?: number | null
  runnerUploads?: number | null
}
