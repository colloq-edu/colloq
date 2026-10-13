/**
 * The owner's view of «Машины для посылок» (docs/architecture/remote-runners.md
 * §7, Paper page «16 · Машины для посылок», M1–M7): the block in «Ресурсы»,
 * the «Подключить машину» dialog, a machine's page, and what the competition
 * console and «Работают сейчас» add for runs that happen on machines.
 *
 * Home builds all of it from remote_runners, remote_runner_codes,
 * remote_leases and remote_events (server/src/competitions/remote/); the panel
 * only renders it. None of these types travel to a machine: the wire between
 * home and a machine is shared/remote-runner.ts, and a machine never learns a
 * participant's name, which these types carry.
 *
 * Owner-only. A machine sees rivals' notebooks and, when trusted, the hidden
 * test, so who may connect one, trust one or read its log is the instance's
 * business, not a course's: every door that serves these is requireOwner.
 */
import type { RemoteAttemptPhase, RemoteProblemCode } from './remote-runner.js'

/* ------------------------------------------------------------- machines */

/**
 * What the list shows for a machine, decided on home's clock.
 *
 * `online`: heard within REMOTE_SILENCE_MS, its build equals home's, and it
 * takes work. `silent`: not heard for longer (`silentSince` says since when);
 * once home has path evidence its leases are lost and requeued. `outdated`:
 * heard, but its build differs from home's — it finishes what it holds and
 * takes nothing new (decision 5). `draining`: asked to finish and stop taking
 * work, by the owner or by `colloq-host runner leave`. `quarantined`: drained
 * by home itself after REMOTE_QUARANTINE_LOSSES losses or
 * REMOTE_QUARANTINE_DECLINES declines within the window. `revoked`:
 * disconnected by the owner; kept for its history, its secret refused.
 * `left`: the machine revoked itself on `leave`.
 */
export type RemoteMachineState = 'online' | 'silent' | 'outdated' | 'draining' | 'quarantined' | 'revoked' | 'left'

/** One of a machine's cards as its last sync described it, with the share a run gets there. */
export interface RemoteMachineCard {
  device: string
  /** What the card calls itself; null — it did not say. */
  name: string | null
  memoryMb: number | null
  /** Runs per card in force on the machine now. */
  perDevice: number
  /** Shares the machine's runs hold now. */
  busyShares: number
  /** memoryMb / perDevice; null — the card did not say its size, so no share is promised. */
  sliceMb: number | null
}

/**
 * One thing a machine needs for one competition: the image of its
 * environment, its open data, or its hidden test.
 *
 * `ready`: in place and verified. `fetching`: downloading, `percent` says how
 * far. `waiting`: wanted, not started yet (the machine fetches one stream at a
 * time, competitions with waiting submissions first). `problem`: it failed,
 * and `problem` says how, in the machine's words. `not_needed`: the
 * competition has none (no hidden test), or the machine may not hold it (an
 * untrusted machine and a hidden test).
 */
export interface RemoteReadinessItem {
  state: 'ready' | 'fetching' | 'waiting' | 'problem' | 'not_needed'
  percent: number | null
  /** Its size when known: the image's compressed bytes, the data's total. */
  bytes: number | null
  problem: { code: RemoteProblemCode; detail: string } | null
}

/**
 * Whether a machine takes a competition's submissions, and if not, the one
 * reason that matters most (the console and the editor say the same words).
 *
 * `taking`: everything is in place. `preparing`: something still downloads.
 * `problem`: a problem keeps it out (see the items). `home_only`: the
 * competition's environment has no registry image (built or edited on this
 * server), so only this server runs it. `needs_trusted`: the competition has
 * a hidden test and the machine is not trusted (decision 1). `needs_card`: a
 * GPU competition and the machine has no card. `outdated`: the machine's
 * build differs from home's.
 */
export type RemoteReadinessVerdict = 'taking' | 'preparing' | 'problem' | 'home_only' | 'needs_trusted' | 'needs_card' | 'outdated'

/** A machine against one competition that is open, opens within a day, or has waiting submissions. */
export interface RemoteReadiness {
  competitionId: string
  title: string
  environment: string
  gpu: boolean
  sealed: boolean
  verdict: RemoteReadinessVerdict
  image: RemoteReadinessItem
  data: RemoteReadinessItem
  /** The hidden test: `not_needed` without one, and on a machine that is not trusted. */
  sealedData: RemoteReadinessItem
  /** This competition's runs on the machine now. */
  running: number
}

/** What a machine said about itself when it joined and since (shared/remote-runner.ts · RemoteFacts). */
export interface RemoteMachineFacts {
  hostname: string | null
  platform: string | null
  cpus: number | null
  memoryMb: number | null
  diskMb: number | null
  docker: string | null
  storage: string | null
  /** The NVIDIA driver, e.g. `580.95.05`; null on a machine without cards. */
  driver: string | null
}

/** A row of the M1 list. */
export interface RemoteMachine {
  id: string
  name: string
  state: RemoteMachineState
  /** May receive the hidden test (decision 1). */
  trusted: boolean
  /** When it was last heard, ms; null — it joined and never synced. */
  lastSeenAt: number | null
  /** Since when it is silent, ms; null unless `state` is `silent`. */
  silentSince: number | null
  /** The address its last call came from, as the relay forwarded it. */
  address: string | null
  /** The colloq version it runs; null — never said. */
  version: string | null
  /** Its build (the sha256 of dist/runner.js) equals home's (decision 5). */
  compatible: boolean
  facts: RemoteMachineFacts
  cards: RemoteMachineCard[]
  places: {
    /** The owner's cap; null — whatever the machine offers. */
    approved: number | null
    /** What the machine offers: its free places plus the runs it holds. */
    offered: number
    /** Runs it holds now. */
    busy: number
  }
  /** Runs per card set for this machine; null — the instance setting «Посылок на карту». */
  perDevice: number | null
  readiness: RemoteReadiness[]
  /** Since it joined. `requeued`: runs it gave back without a loss (a drain, a decline). */
  counts: { scored: number; lost: number; declined: number; requeued: number }
  /** The last decline's or loss's words, for the counter's caption; null — none. */
  lastTrouble: string | null
  createdAt: number
}

/** A code minted for the dialog, as the list keeps it until it is spent or expires. The code itself is never shown again. */
export interface RemoteCodeView {
  /** The first 8 hex characters of the code's sha256: enough to tell two codes apart, useless to join with. */
  id: string
  createdAt: number
  expiresAt: number
  machines: number
  used: number
  trusted: boolean
  approvedSlots: number | null
}

/** GET /api/admin/runners — the M1 block. */
export interface RemoteMachinesResponse {
  summary: {
    /** Machines `online` / not revoked or left. */
    online: number
    total: number
    /** Places on machines that take work now, and how many are busy. */
    places: number
    busy: number
    /** Cards on machines that take work now, the runs per card most of them use, and the smallest share among them. */
    cards: number
    perDevice: number | null
    sliceMb: number | null
  }
  /** «Тетради на этом сервере»: this server runs notebooks too (the competition setting homeNotebooks). */
  homeNotebooks: boolean
  /** «Оценок одновременно»: the metric lane's places (scoreSlots). */
  scoreSlots: number
  machines: RemoteMachine[]
  /** Codes still valid, for the dialog's «ждём первую машину…». */
  codes: RemoteCodeView[]
  /** Home's own version and build, for «устарела: на ней 0.23.0, на сервере 0.24.0». */
  home: { version: string; build: string }
  /** Set when home quarantined a machine and the owner has not looked yet. */
  banner: { machineId: string; name: string; at: number } | null
}

/** A run a machine holds, on the machine's page (M3). */
export interface RemoteMachineRun {
  attemptId: string
  submissionId: string
  competitionId: string
  competition: string
  entrantName: string
  number: number
  phase: RemoteAttemptPhase
  /** When its container started, on home's clock; null — not started yet. */
  startedAt: number | null
  limitMs: number
  card: { device: string; sliceMb: number | null } | null
}

/**
 * A line of the machine's log (remote_events, kept 90 days; the page shows
 * the last 50). The panel words each kind itself; `detail` is what the
 * machine or home measured (a docker message, a size, a duration), already
 * cut to REMOTE_REASON_CHARS.
 */
export type RemoteEventKind =
  | 'joined' | 'leased' | 'applied' | 'declined' | 'lost' | 'withdrawn' | 'revoked'
  | 'quarantined' | 'resumed' | 'drained' | 'trusted' | 'untrusted' | 'renamed' | 'outdated'
  | 'image_ready' | 'data_ready' | 'sealed_fetched' | 'problem' | 'left'

export interface RemoteEvent {
  at: number
  kind: RemoteEventKind
  attemptId: string | null
  /** The submission's owner and number for run events, so the log reads «Ника Р. · #14»; null otherwise. */
  entrantName: string | null
  number: number | null
  competition: string | null
  detail: string | null
}

/** GET /api/admin/runners/:id — the M3 page. */
export interface RemoteMachineDetail extends RemoteMachine {
  runs: RemoteMachineRun[]
  events: RemoteEvent[]
}

/* -------------------------------------------------------------- actions */

/** POST /api/admin/runners/codes — mint a code for the dialog (M2). */
export interface MintRemoteCodeRequest {
  /** How many machines may join with it: 1–50. */
  machines: number
  /** How long it stays valid: 1–24 h (REMOTE_CODE_TTL_MAX_MS). */
  hours: number
  /** Machines joined with it are trusted from the start (decision 1; off by default). */
  trusted: boolean
  /** The owner's cap on each machine's places; null — whatever each offers. */
  approvedSlots: number | null
  /** The machines' names start with it, e.g. «vast-4090»; home adds a suffix. */
  namePrefix?: string
}

/**
 * The answer: the code, shown this once, inside the three join commands of
 * §8.1 filled in with this home's address and its release (so the owner
 * copies a command, never a bare code).
 */
export interface MintRemoteCodeResponse {
  code: string
  expiresAt: number
  machines: number
  trusted: boolean
  commands: { docker: string; bare: string; vast: string }
}

/** PATCH /api/admin/runners/:id — the M3 settings. A field left out is left as it is. */
export interface UpdateRemoteMachineRequest {
  name?: string
  /** null — whatever the machine offers. */
  approvedSlots?: number | null
  /** null — the instance setting. */
  perDevice?: number | null
  trusted?: boolean
}

/**
 * POST /api/admin/runners/:id/:action. `drain`: finish what it holds and take
 * nothing new; `resume`: take work again after a drain or a quarantine;
 * `revoke`: disconnect now — its leases are released with no penalty and late
 * results refused. POST /api/admin/runners/revoke-all does `revoke` to every
 * machine («Отключить все»).
 */
export type RemoteMachineAction = 'drain' | 'resume' | 'revoke'

/* ------------------------------------------------- console and «Работают» */

/**
 * Why a waiting submission is not taken, when the reason is a machine's and
 * not simply its turn (§5.7). The participant sees «готовится» instead of a
 * place for all of these except `returned`.
 *
 * `no_runners`: this server runs no notebooks and no machine takes work.
 * `no_gpu_runner`: a GPU competition and no card anywhere. `preparing_image`
 * / `preparing_data`: the machines that could take it are still downloading.
 * `needs_trusted`: it reads the hidden test and no trusted machine is free.
 * `home_only_env`: its environment runs only here and this server runs no
 * notebooks. `returned`: it came back to the queue from a machine (`from`
 * names it), first in line and with no quota spent.
 */
export type RemoteWaitReason = 'no_runners' | 'no_gpu_runner' | 'preparing_image' | 'preparing_data' | 'needs_trusted' | 'home_only_env' | 'returned'

/** A group header of the console grid (M4): this server or one machine, with the places it gives this queue. */
export interface RemoteConsoleGroup {
  /** null — this server. */
  machineId: string | null
  name: string | null
  state: RemoteMachineState | null
  places: number
  busy: number
  cards: { count: number; perDevice: number } | null
  /** This server only: «только метрики» when it runs no notebooks. */
  metricsOnly?: boolean
}

/**
 * «Работают сейчас» (M5): a competition whose submissions run on machines.
 * They hold no memory here — `scoring` counts the metric runs this server
 * does for them, which are in RunningKernels.runs like any other.
 */
export interface RunningRemote {
  competitionId: string | null
  competition: string | null
  hidden: boolean
  machines: { id: string; name: string; runs: number; devices: string[] }[]
  scoring: number
}
