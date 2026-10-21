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
import type { RemoteFilesLag, RemoteKernelRole } from './remote-kernels.js'
import type { CLASS_MACHINE_SETTING_BOUNDS, ClassMachineSettings } from './admin.js'

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
    /**
     * What the machine offers: its free places plus the runs it holds, in
     * runs of the work at hand — the queue's notebooks, or with none the
     * largest run a competition taking uploads asks for (server ·
     * remote/views.ts · placeMix): the machine counts its places in its
     * smallest possible runs, and a 61-vCPU machine that offers 60 of them
     * holds 30 runs of two CPUs.
     */
    offered: number
    /** Runs it holds now. */
    busy: number
  }
  /** Runs per card set for this machine; null — the instance setting «Посылок на карту». */
  perDevice: number | null
  readiness: RemoteReadiness[]
  /**
   * Since it joined. `scored`: runs whose submission it ran to a score (a
   * notebook that failed on it is no score); `requeued`: runs it gave back
   * without a loss (a drain, a decline).
   */
  counts: { scored: number; lost: number; declined: number; requeued: number }
  /** The last decline's or loss's words, for the counter's caption; null — none. */
  lastTrouble: string | null
  createdAt: number
  /**
   * What its last sync said is wrong with the machine itself, not with one
   * competition's image or data (those are in `readiness`): `disk` below its
   * floor, `docker` not answering, `cards` that could not be probed, with the
   * machine's words in this server's language. Absent — nothing.
   */
  problems?: { code: RemoteProblemCode; detail: string }[]
  /**
   * The code it joined with, by the id the list's codes carry
   * (RemoteCodeView.id, MintRemoteCodeResponse.id); `null` — not known (a
   * machine joined before codes were recorded). The connect dialog counts
   * its own code's machines by it, however the list's reads fell: a
   * one-machine code spent before any read showed it is no longer in
   * `codes`. Absent — a server from before it.
   */
  codeId?: string | null
  /**
   * With `draining`: the machine drains by itself, not by the owner's or
   * home's word — its own last sync said so (`colloq-host runner update` or
   * a stop: `draining`; `leave`: `leaving`). The resume door has nothing to
   * lift then, so the panel offers «Осушить» rather than «Вернуть в работу».
   * Absent — not draining, or drained by the owner (or home's quarantine).
   */
  selfDrain?: 'draining' | 'leaving'
  /**
   * «Занятия»: the machine as classes see it (RemoteMachineClasses). Absent —
   * it was never opened to classes and holds none: no «занятия» chip, no class
   * line, as before classes (Paper 18 · Z1). A server from before classes
   * sends none either.
   */
  classes?: RemoteMachineClasses
}

/* ------------------------------------------------ classes on machines (0.25) */

/**
 * Why a machine opened to classes takes no NEW class now, the one reason
 * that matters most (docs/architecture/remote-classes.md §6.3; Paper 18 · Z1
 * readiness lines). What it holds goes on regardless: these keep only new
 * placements away, except `perimeter` with `failing`, which moved its
 * classes off.
 *
 * `gone`: revoked or left. `outdated`: its build differs from home's (new
 * placements need equal builds, 0.23 decision 5). `silent`: not heard.
 * `quarantined`: two silence failovers within half an hour (D32), until the
 * owner's «Вернуть». `winding`: «Принимает занятия» was turned off and it may
 * still hold class containers. `facts`: it has not said yet what it can do
 * (no kernels block since its classes were turned on). `host-network`: its
 * agent runs without `--network host` (D19). `same-daemon`: a Colloq server
 * shares its Docker (D20). `perimeter`: the class perimeter is not in place
 * (`detail`: the agent's word — `no-dockerd`, `no-iptables`, `refused`,
 * `failing`). `canary`: the admission canary did not pass (`detail`: what
 * failed, in the agent's words). `image`: a class image is still downloading
 * (`percent`, `environment`). `tunnel`: its tunnel is down while it syncs.
 */
export type RemoteClassBlock =
  | 'gone'
  | 'outdated'
  | 'silent'
  | 'quarantined'
  | 'winding'
  | 'facts'
  | 'host-network'
  | 'same-daemon'
  | 'perimeter'
  | 'canary'
  | 'image'
  | 'tunnel'

/** A machine as classes see it: its flag, what keeps new classes away, what it holds, its link (Z1, Z3). */
export interface RemoteMachineClasses {
  /** «Принимает занятия» (D2): the owner's flag, off by default, never together with `trusted` (D3). */
  on: boolean
  /** Turned off, and its sync has not yet said it holds no class container (store.ts · classesWindingDown): «убирает занятия». */
  windingDown: boolean
  /** When two silence failovers within 30 minutes stopped it taking classes (D32); null — not, or the owner resumed it. */
  quarantinedAt: number | null
  /**
   * What keeps a new class away now; null — it takes classes. With
   * `perimeter` and `canary`, `detail` is the agent's word; with `image`,
   * the environment downloading and how far.
   */
  block: { reason: RemoteClassBlock; detail: string | null; percent: number | null; environment: string | null } | null
  /** The classes holding a slot on it now (live placements), the memory those slots are held to there, and the card a class holds whole. */
  held: { classes: number; slots: number; memoryMb: number; card: string | null }
  /**
   * Its tunnel (§4): up or not, since when on this server's clock, and the
   * round trip home measures over it (an average and the p95, ms); `null` — no
   * tunnel was ever seen in this server's life.
   */
  link: { up: boolean; since: number | null; rttMs: number | null; p95Ms: number | null } | null
  /**
   * A silent machine holding classes: when the first of them moves away by
   * itself if nothing changes (its class's «Переезд через»); null — none
   * will by itself (every class waits for the machine, or the outage is too
   * young to tell, or it is not silent).
   */
  moveAt: number | null
}

/**
 * A banner over the machines block for the owner (Paper 18 · Z1, §13.2), one
 * per event: `quarantined` — two silence failovers within 30 minutes
 * (D32), with «Вернуть»; `tunnel` — its tunnel was taken over from other
 * addresses more than TUNNEL_REPLACEMENTS_ALERT.count times within the
 * window (§4.2), the addresses named; `perimeter` — its perimeter failed
 * closed and its classes moved here (§7.6).
 */
export type RemoteClassBanner =
  | { kind: 'quarantined'; machineId: string; name: string; at: number }
  | { kind: 'tunnel'; machineId: string; name: string; count: number; minutes: number; addresses: string[] }
  | { kind: 'perimeter'; machineId: string; name: string; at: number }

/** One class on a machine, a row of the machine's page (Paper 18 · Z3). */
export interface RemoteMachineClassRow {
  sessionId: string
  /** The class's name; null — its row is gone. */
  name: string | null
  course: { id: string; name: string } | null
  environment: string | null
  /** Its slots on this machine: «класс · личные · консилиум». */
  roles: RemoteKernelRole[]
  /** The council's planned workers, when its pool is here. */
  workers: number | null
  /** The card the class room holds whole. */
  card: string | null
  /** What its slots are held to there, and what they use, as the machine's census said; `usedMb` null — not said. */
  memory: { limitMb: number; usedMb: number | null }
  /** CPU use of its slots there, percent of one core as docker reports it; null — not said. */
  cpuPercent: number | null
  /** How far its folder copy is behind (§8.7), summed over its slots there; null — not said. */
  files: RemoteFilesLag | null
  /** A slot of it waits for this machine (unreachable). */
  waiting: boolean
}

/**
 * «Работают сейчас» (Paper 18 · Z7): one slot of a class on a machine, a
 * sub-row of the class's row. It holds none of this server's memory («0 МБ
 * здесь»); its numbers are the machine's. For a class the viewer does not
 * teach (`RunningClass.hidden`) the machine is not named.
 */
export interface RunningMachineSlot {
  role: RemoteKernelRole
  /** The machine's name; null for a class the viewer does not teach. */
  machine: string | null
  state: 'running' | 'starting'
  /** Whether the machine answers now; `lost` — a stop waits until it does. */
  link: 'ok' | 'lost'
  /** With `lost`: since when the machine has not answered, as the move counts it; null — not said. */
  lostSince: number | null
  /** What the container is held to there, and what it uses (null — not said). */
  memoryMb: number
  usedMb: number | null
  cpus: number
  cpuPercent: number | null
  /** The card a GPU room holds whole there. */
  card: string | null
  files: RemoteFilesLag | null
  /** The council's planned workers; null for the other roles. */
  workers: number | null
  /**
   * The round trip to its machine over the tunnel, ms (an average of the
   * pings, as the room's chip says it): «связь 52 мс». Null — none measured
   * yet, or a class the viewer does not teach.
   */
  rttMs: number | null
}

/**
 * What «Работают сейчас» adds to a class row for classes on machines
 * (RunningClass, shared/admin.ts): its slots there, when one moves away by
 * itself, and its last move here.
 */
export interface RunningClassMachines {
  /** Its slots on machines; absent or empty — it computes here only. */
  machines?: RunningMachineSlot[]
  /**
   * A slot of it waits for a silent machine: when it moves to this server
   * (or another machine) by itself if nothing changes; null — it waits for
   * the machine («ждать машину»), or the outage is too young to tell.
   */
  moveAt?: number | null
  /**
   * Its kernel came back from a machine within this class (Z7 «на сервере ·
   * переехало в 14:33»): when, from which machine (null for a hidden row),
   * and the files' «по 14:31:58» when known.
   */
  moved?: { at: number; from: string | null; filesAt: number | null } | null
}

/**
 * The class settings for classes on machines, read and written by the owner
 * (GET and PUT /api/admin/resources/classes; Paper 18 · Z1 «Занятия на
 * машинах»). GET is for staff: a teacher's class form reads the switch and
 * the default from it.
 */
export interface ClassMachineSettingsResponse {
  settings: ClassMachineSettings
  defaults: ClassMachineSettings
  bounds: typeof CLASS_MACHINE_SETTING_BOUNDS
  /** Machines that take classes now (opened to them, not revoked or gone). */
  machines: number
  /**
   * Which backend runs this server's kernels. Under the broker (Kubernetes)
   * no class ever goes to a machine (D26): the panel draws neither the
   * section nor a class's «Где считается».
   */
  backend: 'docker' | 'broker' | 'test'
}

/**
 * What the Resources tab's answer (GET /api/admin/resources) adds for
 * classes on machines: the class containers machines hold, none of this
 * server's memory (Z7 legend «На машинах · 9 контейнеров · 0 МБ здесь»).
 * Absent — none.
 */
export interface ResourcesOnMachines {
  onMachines?: { containers: number }
}

/**
 * The class form's live line (Paper 18 · Z4 «Подходят: …»): the machines
 * that take classes against this class, by GET
 * /api/admin/seminars/:id/placement. Staff of the class only: it names
 * machines.
 *
 * `refusal` — why no machine can take any slot of the class: its environment
 * was built here (`not-portable`), this server's blocked ranges cannot go to
 * a machine (`blocked-ranges`), or no machine takes classes (`no-machines`).
 * A machine's `refusal` is the first filter it failed (§6.3), `outdated` for
 * one whose build differs from home's; null — it fits now.
 */
export interface ClassPlacementOutlook {
  refusal: 'not-portable' | 'blocked-ranges' | 'no-machines' | null
  environment: string
  machines: Array<{
    name: string
    refusal: string | null
    freeMb: number | null
    cards: number
    rttP95Ms: number | null
    /** Its p95 is over 150 ms: «далеко: +N мс на ячейку». */
    far: boolean
  }>
  at: number
  /**
   * The class's own «Если машина пропала» (§6.2): whether it moves by
   * itself or waits for its machine. The room's staff banner reads it — it
   * offers «Ждать машину» only to a class that moves by itself, and never
   * promises a move to one that waits. Absent — a server before it.
   */
  failover?: 'auto' | 'wait'
  /** Whether this viewer may change where the class computes (the owner's switch, D4). Absent — a server before it. */
  editable?: boolean
}

/**
 * A code still valid, as the list keeps it until it is spent, expires or is
 * cancelled (DELETE /api/admin/runners/codes/:id, «Отменить»). The code itself
 * is never shown again: whoever holds it can enroll a machine — trusted, if
 * the code says so — until then, and the owner ends it from this list.
 */
export interface RemoteCodeView {
  /**
   * The first 16 hex characters of the code's sha256: useless to join with,
   * and what the cancel door names the code by. Not a code itself.
   */
  id: string
  createdAt: number
  expiresAt: number
  machines: number
  used: number
  trusted: boolean
  approvedSlots: number | null
  /** The machines' names start with it («vast-4090-2»); null — none, each is named after its host. */
  namePrefix?: string | null
  /** Who minted it, as the staff list names them; null — the instance's console, or someone since removed. */
  createdBy?: string | null
  /** Minted on the instance's console (`colloq-host runner-code`), not in the panel. */
  console?: boolean
  /** Its machines take classes from the start («Принимать занятия», D2); never together with `trusted` (D3). */
  classes?: boolean
}

/** GET /api/admin/runners — the M1 block. */
export interface RemoteMachinesResponse {
  summary: {
    /** Machines `online` / not revoked or left. */
    online: number
    total: number
    /** Places on machines that take work now, in runs of the work at hand (RemoteMachine.places.offered), and how many are busy. */
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
  /** Codes still valid, newest first: the dialog's «ждём первую машину…», and the block's list of codes with «Отменить». */
  codes: RemoteCodeView[]
  /** Home's own version and build, for «устарела: на ней 0.23.0, на сервере 0.24.0». */
  home: { version: string; build: string }
  /** Set when home quarantined a machine and the owner has not looked yet. */
  banner: { machineId: string; name: string; at: number } | null
  /**
   * The class banners above the block (Paper 18 · Z1): a machine quarantined
   * for classes, a tunnel taken over too often, a perimeter that failed
   * closed. Absent — none (and a server from before classes).
   */
  classBanners?: RemoteClassBanner[]
  /** How many machines take classes now: the block's «ведут занятия» counter. Absent — none ever did. */
  classMachines?: { machines: number; classes: number }
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
  | RemoteClassEventKind

/**
 * The lines classes on machines add to the log (remote-classes.md §11; the
 * store's REMOTE_CLASS_EVENT_KINDS): its tunnel taken over by a newer one
 * (`address` the newer tunnel's, `detail` the replaced one's), its classes
 * moved off it (`detail` the cause, «moved: Ада» for a move by hand), the
 * class quarantine set and lifted, «Принимает занятия» turned off, and its
 * perimeter failing closed.
 */
export type RemoteClassEventKind = 'tunnel_replaced' | 'class_failover' | 'classes_quarantined' | 'classes_resumed' | 'unclassed' | 'perimeter_failing'

export interface RemoteEvent {
  at: number
  kind: RemoteEventKind
  attemptId: string | null
  /** The submission's owner and number for run events, so the log reads «Ника Р. · #14»; null otherwise. */
  entrantName: string | null
  number: number | null
  competition: string | null
  detail: string | null
  /** The address the line was written about: a takeover's newer tunnel (`tunnel_replaced`); absent or null otherwise. */
  address?: string | null
}

/** GET /api/admin/runners/:id — the M3 page. */
export interface RemoteMachineDetail extends RemoteMachine {
  runs: RemoteMachineRun[]
  events: RemoteEvent[]
  /** The classes on the machine now, a row each (Paper 18 · Z3). Absent — none, or a server from before classes. */
  classRows?: RemoteMachineClassRow[]
}

/* -------------------------------------------------------------- actions */

/** POST /api/admin/runners/codes — mint a code for the dialog (M2). */
export interface MintRemoteCodeRequest {
  /** How many machines may join with it: 1–100, the bound `colloq-host runner-code --machines` has too. */
  machines: number
  /** How long it stays valid: 1–24 h (REMOTE_CODE_TTL_MAX_MS). */
  hours: number
  /** Machines joined with it are trusted from the start (decision 1; off by default). */
  trusted: boolean
  /** The owner's cap on each machine's places; null — whatever each offers. */
  approvedSlots: number | null
  /** The machines' names start with it, e.g. «vast-4090»; home adds a suffix. */
  namePrefix?: string
  /**
   * Machines joined with it take classes («Принимать занятия — машина увидит
   * код, данные, файлы и личные тетради студентов», D2). Never together with
   * `trusted` (D3): the door refuses the pair in words.
   */
  classes?: boolean
}

/**
 * The answer: the code, shown this once, inside the three join commands of
 * §8.1 filled in with this home's address and its release (so the owner
 * copies a command, never a bare code).
 */
export interface MintRemoteCodeResponse {
  /**
   * The code's own id in the list (RemoteCodeView.id): the dialog's «ждём
   * первую машину…» counts the machines that joined with THIS code, never one
   * that joined with another meanwhile.
   */
  id: string
  code: string
  expiresAt: number
  machines: number
  trusted: boolean
  /** Its machines take classes. */
  classes?: boolean
  commands: { docker: string; bare: string; vast: string }
  /**
   * The address in the commands is this server's own loopback (a PUBLIC_URL
   * of localhost or 127.x, colloq-host runner-code warns the same): a machine
   * anywhere else cannot reach it, and the dialog says so.
   */
  loopback: boolean
}

/** PATCH /api/admin/runners/:id — the M3 settings. A field left out is left as it is. */
export interface UpdateRemoteMachineRequest {
  name?: string
  /** null — whatever the machine offers. */
  approvedSlots?: number | null
  /** null — the instance setting. */
  perDevice?: number | null
  trusted?: boolean
  /**
   * «Принимает занятия» (D2). Off fails every class of the machine over first
   * (release.ts · unclassRunner). Refused in words while it is trusted, and
   * `trusted: true` is refused while it takes classes (D3).
   */
  classes?: boolean
}

/**
 * POST /api/admin/runners/:id/:action. `drain`: finish what it holds and take
 * nothing new; `resume`: take work again after a drain or a quarantine;
 * `revoke`: disconnect now — its leases are released with no penalty and late
 * results refused. POST /api/admin/runners/revoke-all does `revoke` to every
 * machine («Отключить все»).
 */
export type RemoteMachineAction = 'drain' | 'resume' | 'revoke'

/**
 * POST /api/admin/runners/:id/classes/:action. `resume`: «Вернуть» under the
 * class quarantine banner (D32) — the machine takes classes again, and the
 * next quarantine counts only what comes after. `move`: «Перенести занятия»
 * — every class slot on the machine moves now (§11.1), to another machine
 * that fits or to this server, its variables lost; the machine keeps taking
 * classes. Both the owner's.
 */
export type RemoteClassAction = 'resume' | 'move'

/* ------------------------------------------------- console and «Работают» */

/**
 * Why a waiting submission is not taken, when the reason is a machine's and
 * not simply its turn (§5.7). The participant sees «готовится» instead of a
 * place for all of these except `returned`.
 *
 * `no_runners`: this server runs no notebooks, or the notebook is too big
 * for it (WaitingRow.tooBig), and no machine takes work.
 * `no_gpu_runner`: a GPU competition and no card anywhere. `preparing_image`
 * / `preparing_data`: the machines that could take it are still downloading.
 * `needs_trusted`: it reads the hidden test and no trusted machine is free.
 * `home_only_env`: its environment runs only here and this server cannot
 * take it — it runs no notebooks, or the notebook needs a card and this
 * server has none. The same holds for the machines' other reasons: with this
 * server's notebooks on, a GPU notebook on a server without cards waits for
 * the machines alone, and for their reasons. `no_fit`: no machine that takes
 * work can ever run it as it is — its memory and the container's cushion
 * over a machine's usable memory, its CPUs over a machine's, a package set
 * too big for a lease, limits outside what the machines' contract carries,
 * or its notebook gone from disk — so it waits for this server or for a
 * bigger machine, whatever frees up. `returned`: it came back to the
 * queue from a machine (`from` names it), first in line and with no quota
 * spent.
 */
export type RemoteWaitReason = 'no_runners' | 'no_gpu_runner' | 'preparing_image' | 'preparing_data' | 'needs_trusted' | 'home_only_env' | 'no_fit' | 'returned'

/**
 * Why a `returned` row came back, when home knows (WaitingRow.returnedWhy):
 * `silent` — the machine went silent and its lease was lost (the console's
 * «вернулась: vast-1 замолчала»); `declined` — the machine refused it before
 * its container started; `released` — the machine gave it back on the
 * owner's word or its own: a drain with `--now`, a leave, a disconnect.
 * Absent — the panel says only which machine it came from, never a cause it
 * was not told.
 */
export type RemoteReturnReason = 'silent' | 'declined' | 'released'

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
  /**
   * This server only, with `metricsOnly`: the metric lane's places
   * («Оценок одновременно», scoreSlots) and the metrics it runs now, for
   * «только метрики · 1 из 2». `places` and `busy` above stay the notebook
   * lane's (0 then), and a metric is never drawn in a notebook's cell.
   */
  metric?: { places: number; busy: number }
  /** A `silent` machine: since when, ms, for «молчит 4 мин» (RemoteMachine.silentSince). Absent — the chip says «молчит» alone. */
  silentSince?: number | null
  /**
   * The colloq version it runs: a machine's for an `outdated` one's «на ней
   * 0.23.0, на сервере 0.24.0», and this server's own on this server's group
   * (the other half of that line, read off the server rather than the panel's
   * bundle). Absent — the versions are not named.
   */
  version?: string | null
}

/**
 * A machine as the competition editor's «Где считается» row names it (Paper
 * M6): its verdict for this one competition (the same words as the machine's
 * readiness, RemoteReadiness.verdict), the places and cards it brings, and
 * whether it may hold the hidden test.
 */
export interface RemoteWhereMachine {
  id: string
  name: string
  /**
   * The machine's state on this server's clock (RemoteMachine.state): the
   * editor's hidden-test warning counts only trusted machines that are
   * `online`, not one silent for an hour or outdated.
   */
  state: RemoteMachineState
  /**
   * For a competition machines do not prefetch yet (a draft), `preparing`
   * means it fits and will prepare once the competition opens.
   */
  verdict: RemoteReadinessVerdict
  /** Places it gives this competition's submissions: its approved or offered places, in runs of this competition's own size. */
  places: number
  /** Its cards; 0 — none. */
  cards: number
  trusted: boolean
}

/**
 * «Где считается» (Paper M6, CompetitionView.where): who can run this
 * competition's notebooks — this server and the machines — and what the
 * editor warns about, for the competition as saved. Absent — no machine was
 * ever connected, and the editor draws neither the row nor its warnings, as
 * before machines.
 */
export interface RemoteCompetitionWhere {
  /** This server: whether it runs notebooks («Тетради на этом сервере») or only scores, and its places for notebooks. */
  home: { notebooks: boolean; places: number }
  /** Machines not revoked and not gone, against this competition. */
  machines: RemoteWhereMachine[]
  /**
   * The environments machines can run: those whose revision has an image in
   * the registry. Warning 1 names them, and an environment picked in the form
   * but not saved yet is checked against them.
   */
  registry: string[]
  /** The saved environment has no registry image (built or edited on this server): only this server runs it (warning 1). */
  homeOnly: boolean
  /**
   * Cards on machines for a GPU competition (decision 8): how many machines
   * with cards were heard within REMOTE_GPU_SEEN_MS (the door accepts GPU
   * uploads while there is one), the last machine with cards ever heard, for
   * warning 3's «была на связи 2 ч назад», and the share a run is promised on
   * them — the smallest card's memory over its machine's runs per card among
   * those machines (§5.8), for the GPU switch's «срез ≈ 3 ГБ»; `sliceMb`
   * null — no such card said its size.
   */
  cards: { recent: number; last: { name: string; at: number } | null; sliceMb: number | null }
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
  /**
   * The submissions running on machines, for «Остановить все» through the
   * console's kill door (POST /api/admin/competitions/queue/kill, one each),
   * which cancels a machine's run durably. Empty for another course's
   * competition: its runs are a number here, not ids to act on.
   */
  submissionIds: string[]
}
