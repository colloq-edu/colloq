/**
 * What the panel shows about the machines (shared/remote-admin.ts, Paper page
 * «16 · Машины для посылок»): the owner's list and a machine's page, the
 * console's groups and the reasons a submission waits, «Работают сейчас»,
 * the editor's «Где считается» — and the fleet's places and card shares the
 * forecast counts.
 *
 * Everything here is read on this server's clock from the machines' last
 * syncs (heard.ts) and the rows (store.ts); nothing is written, except that
 * opening a quarantined machine's page is the owner having looked
 * (`quarantineSeen`).
 */
import { REMOTE_ATTEMPT_DISK_MB, REMOTE_DECLINE_SKIP_MS, remoteCompatible, type RemoteSyncRequest } from '@shared/remote-runner'
import type {
  RemoteCodeView,
  RemoteCompetitionWhere,
  RemoteConsoleGroup,
  RemoteEvent,
  RemoteMachine,
  RemoteMachineCard,
  RemoteMachineDetail,
  RemoteMachineFacts,
  RemoteMachineRun,
  RemoteMachinesResponse,
  RemoteReadiness,
  RemoteReadinessItem,
  RemoteReadinessVerdict,
  RemoteReturnReason,
  RemoteWaitReason,
  RunningRemote,
} from '@shared/remote-admin'
import { acceptsUploads, submissionsOpen, type Competition } from '@shared/competitions'
import { competitionRevision, revisions } from '../../dependencies/store.js'
import { canSeeCompetition } from '../scope.js'
import type { StaffLike } from '../../admin/access.js'
import { getTeacher } from '../../admin/store.js'
import { gpuSliceMb } from '../gpu-math.js'
import { limitsFor } from '../runner-port.js'
import { competitionDefaults, gpuPerDeviceSetting, homeNotebooksSetting, scoreSlotsSetting } from '../settings.js'
import { getCompetition, getEntrant, getSubmission, heldRows, listCompetitions, queueRows, runningRows, type QueueRow } from '../store.js'
import { heardAddress, heardAt, lastSync, liveRunner, machineState, remoteCardsSeen, runnerCards } from './heard.js'
import { fitCache, homeTakes, machineFit, rowNeedsCard, rowNeeds, stepClaim, type FitCache, type FitMachine, type MachineRefusal } from './fit.js'
import {
  anyRunnerEver,
  boundedPerDevice,
  codeIdOf,
  codeJoins,
  declinedByRunners,
  getLease,
  getRunner,
  homeRunnerBuild,
  homeVersion,
  lastLeasesOf,
  lastTrouble,
  liveCodes,
  liveLeases,
  listRunners,
  listStandingRunners,
  runnerEvents,
  runnerLeaseCounts,
  updateRunner,
  type LeaseRow,
  type RunnerRow,
} from './store.js'
import { dataNow, gpuRevision, homeStock, portableRevision, stockNow, type CompetitionStock } from './want.js'
import { homeWords } from './words.js'

/* ---------------------------------------------------------------- pieces */

/** Runs per card a machine is held to: its own setting, or the instance's «Посылок на карту». */
export function perDeviceOf(runner: Pick<RunnerRow, 'perDevice'>): number {
  return boundedPerDevice(runner.perDevice ?? gpuPerDeviceSetting().value)
}

/*
 * PLACES ARE COUNTED IN THE RUNS THERE ARE (§5.7). A machine says how many
 * more of the smallest run it would take (RemoteFree.slots: a CPU and 384 MB
 * each), and that number was read as the notebooks it runs: a 61-vCPU VM
 * «offered 60» for a competition whose runs need two CPUs each, and the
 * forecast promised «starts now» and the console free cells to rows the take
 * would never lease there — ETAs two to four times too short. So a machine's
 * places are its cap (the owner's, or what it offers) bounded by how many of
 * the competition's own runs — its memory and the container's cushion, its
 * CPUs (fit.ts · stepClaim) — what the machine has AT ALL holds (capacityOf),
 * for the competition a screen is about, or for the mix of runs the queue
 * holds (placeMix).
 */

/** What one run claims of a machine (fit.ts · stepClaim): the unit a machine's places are counted in. */
export interface PlaceClaim {
  memoryMb: number
  cpus: number
}

/** The run sizes a count of places is for, each with its weight (the rows of that size). */
export type PlaceMix = ReadonlyArray<{ claim: PlaceClaim; weight: number }>

/** A machine's places for runs of one size: its cap, bounded by how many such runs its memory and its CPUs hold at all. */
export function placesFor(cap: number, room: Pick<FitMachine['room'], 'memoryMb' | 'cpus'>, claim: PlaceClaim): number {
  return Math.max(0, Math.min(cap, Math.floor(room.memoryMb / Math.max(1, claim.memoryMb)), Math.floor(room.cpus / Math.max(1, claim.cpus))))
}

/** A machine's places for a mix of runs: the mean of placesFor over the mix, by weight, rounded down; no mix — its cap. */
export function placesForMix(cap: number, room: Pick<FitMachine['room'], 'memoryMb' | 'cpus'>, mix: PlaceMix): number {
  let sum = 0
  let weight = 0
  for (const one of mix) {
    sum += one.weight * placesFor(cap, room, one.claim)
    weight += one.weight
  }
  return weight > 0 ? Math.floor(sum / weight) : Math.max(0, cap)
}

/** One competition's own run (limitsFor's notebook step), as a mix of one. */
export function competitionMix(competition: Competition): PlaceMix {
  return [{ claim: stepClaim(limitsFor(competition, 'notebook')), weight: 1 }]
}

/**
 * The runs the machines' places are counted in when no one competition is
 * asked about: the queue's notebook work, waiting or running, by count; with
 * none, the largest run of a competition that takes uploads now (an empty
 * queue must not promise places a run the next upload brings will not
 * have); with none open, the instance's default limits.
 */
export function placeMix(rows: readonly QueueRow[] = queueRows(), now = Date.now()): PlaceMix {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.kind !== 'notebook' || (row.state !== 'waiting' && row.state !== 'running')) continue
    counts.set(row.competitionId, (counts.get(row.competitionId) ?? 0) + 1)
  }
  const mix: Array<{ claim: PlaceClaim; weight: number }> = []
  for (const [competitionId, weight] of counts) {
    const competition = getCompetition(competitionId)
    if (competition) mix.push({ claim: stepClaim(limitsFor(competition, 'notebook')), weight })
  }
  if (mix.length > 0) return mix
  let largest: PlaceClaim | null = null
  for (const competition of listCompetitions()) {
    if (!acceptsUploads(submissionsOpen(competition, now))) continue
    const claim = stepClaim(limitsFor(competition, 'notebook'))
    largest = largest === null ? claim : { memoryMb: Math.max(largest.memoryMb, claim.memoryMb), cpus: Math.max(largest.cpus, claim.cpus) }
  }
  if (largest) return [{ claim: largest, weight: 1 }]
  const { limits } = competitionDefaults()
  return [{ claim: stepClaim({ memoryMb: limits.memoryMb, cpus: limits.cpus }), weight: 1 }]
}

/**
 * A machine's places: the owner's cap, what it offers (free and held) in
 * runs of the mix, what it holds now, and the places that makes. `offered`
 * is what the machine said in units of the smallest run, bounded by how many
 * of these runs it holds at all (placesFor): the number the panel shows, and
 * the one the take will lease up to.
 */
export function machinePlaces(runner: RunnerRow, mix: PlaceMix = placeMix()): { approved: number | null; offered: number; busy: number; places: number } {
  const sync = lastSync(runner.id)
  const held = liveLeases(runner.id)
  const busy = held.length
  if (!sync) return { approved: runner.approvedSlots, offered: 0, busy, places: 0 }
  const room = capacityOf(runner, sync, held, 0).room
  const said = sync.free.slots + sync.attempts.length
  const offered = placesForMix(said, room, mix)
  const places = runner.approvedSlots === null ? offered : Math.min(runner.approvedSlots, offered)
  return { approved: runner.approvedSlots, offered, busy, places }
}

function cardsView(runner: RunnerRow): RemoteMachineCard[] {
  return runnerCards(runner).map((card) => ({
    device: card.device,
    name: card.name,
    memoryMb: card.memoryMb,
    perDevice: card.perDevice,
    busyShares: card.busyShares,
    sliceMb: gpuSliceMb(card.memoryMb, card.perDevice),
  }))
}

function factsView(runner: RunnerRow): RemoteMachineFacts {
  const facts = lastSync(runner.id)?.facts ?? runner.facts
  return {
    hostname: facts?.hostname ?? null,
    platform: facts?.platform ?? null,
    cpus: facts?.cpus ?? null,
    memoryMb: facts?.memoryMb ?? null,
    diskMb: facts?.diskMb ?? null,
    docker: facts?.docker ?? null,
    storage: facts?.storage ?? null,
    driver: facts?.driver ?? null,
  }
}

/* ------------------------------------------------------------- readiness */

function itemOf(sync: RemoteSyncRequest | null, what: { revisionId?: string; manifest?: string }, ready: boolean, bytes: number | null): RemoteReadinessItem {
  if (ready) return { state: 'ready', percent: null, bytes, problem: null }
  const problem = sync?.problems.find((one) => (what.revisionId !== undefined && one.revisionId === what.revisionId) || (what.manifest !== undefined && one.manifest === what.manifest))
  if (problem) return { state: 'problem', percent: null, bytes, problem: { code: problem.code, detail: homeWords(problem.detail) } }
  const fetching = sync?.fetching.find((one) => (what.revisionId !== undefined && one.revisionId === what.revisionId) || (what.manifest !== undefined && one.manifest === what.manifest))
  if (fetching) return { state: 'fetching', percent: fetching.percent, bytes, problem: null }
  return { state: 'waiting', percent: null, bytes, problem: null }
}

const NOT_NEEDED: RemoteReadinessItem = { state: 'not_needed', percent: null, bytes: null, problem: null }

/** One machine against one competition (RemoteReadiness): what it has in place, and the one reason that matters most. */
export function readinessFor(runner: RunnerRow, entry: CompetitionStock): RemoteReadiness {
  const sync = lastSync(runner.id)
  const competition = entry.competition
  const cards = runnerCards(runner).length > 0
  const revisionId = entry.currentRevisionId
  const current = revisionId ? entry.revisions.find((one) => one.id === revisionId) ?? null : null
  const gpuImage = current ? gpuRevision(current) : false
  const image = revisionId === null ? NOT_NEEDED : itemOf(sync, { revisionId }, sync?.ready.revisions.includes(revisionId) ?? false, null)
  const openBytes = entry.open ? entry.open.files.reduce((sum, file) => sum + file.bytes, 0) : null
  const data = entry.open ? itemOf(sync, { manifest: entry.open.manifest }, sync?.ready.data.includes(entry.open.manifest) ?? false, openBytes) : { ...NOT_NEEDED, state: 'waiting' as const }
  const sealedBytes = entry.sealed ? entry.sealed.files.reduce((sum, file) => sum + file.bytes, 0) : null
  const sealedData = !entry.hasSealed || !runner.trusted
    ? NOT_NEEDED
    : entry.sealed ? itemOf(sync, { manifest: entry.sealed.manifest }, sync?.ready.sealed.includes(entry.sealed.manifest) ?? false, sealedBytes) : { ...NOT_NEEDED, state: 'waiting' as const }
  let verdict: RemoteReadinessVerdict
  if (!remoteCompatible(homeRunnerBuild(), runner.build ?? '')) verdict = 'outdated'
  else if (entry.homeOnly) verdict = 'home_only'
  else if ((competition.limits.gpu === true || gpuImage) && !cards) verdict = 'needs_card'
  else if (entry.hasSealed && !runner.trusted) verdict = 'needs_trusted'
  else if ([image, data, sealedData].some((item) => item.state === 'problem')) verdict = 'problem'
  else if ([image, data, sealedData].every((item) => item.state === 'ready' || item.state === 'not_needed')) verdict = 'taking'
  else verdict = 'preparing'
  return {
    competitionId: competition.id,
    title: competition.title,
    environment: competition.environment,
    gpu: competition.limits.gpu === true,
    sealed: entry.hasSealed,
    verdict,
    image,
    data,
    sealedData,
    running: liveLeases(runner.id).filter((lease) => lease.competitionId === competition.id).length,
  }
}

function readinessOf(runner: RunnerRow, stock: ReadonlyMap<string, CompetitionStock>): RemoteReadiness[] {
  if (runner.state === 'revoked' || runner.state === 'left') return []
  return [...stock.values()].sort((a, b) => a.rank - b.rank || a.competition.createdAt - b.competition.createdAt).map((entry) => readinessFor(runner, entry))
}

/* ----------------------------------------------------------- the machines */

export function machineView(runner: RunnerRow, stock: ReadonlyMap<string, CompetitionStock>, now = Date.now(), mix: PlaceMix = placeMix(queueRows(), now)): RemoteMachine {
  const state = machineState(runner, now)
  const at = heardAt(runner.id) ?? runner.lastSeenAt
  const places = machinePlaces(runner, mix)
  const counts = runnerLeaseCounts(runner.id)
  // «Был на связи» is a sync's: a machine that joined and never synced has none, in this life or a previous one (seenDue).
  const seen = lastSync(runner.id) !== null ? heardAt(runner.id) : runner.lastSeenAt
  const trouble = lastTrouble(runner.id)
  return {
    id: runner.id,
    name: runner.name,
    state,
    trusted: runner.trusted,
    lastSeenAt: seen,
    silentSince: state === 'silent' ? at : null,
    address: heardAddress(runner.id) ?? runner.lastAddress,
    version: lastSync(runner.id)?.facts?.version ?? runner.version,
    compatible: remoteCompatible(homeRunnerBuild(), runner.build ?? ''),
    facts: factsView(runner),
    cards: cardsView(runner),
    places: { approved: places.approved, offered: places.offered, busy: places.busy },
    perDevice: runner.perDevice,
    readiness: readinessOf(runner, stock),
    counts: { scored: counts.scored, lost: counts.lost, declined: counts.declined, requeued: counts.requeued },
    // A machine's words in this server's: a marker its core wrote, or one a notebook printed, never reaches the panel raw.
    lastTrouble: trouble === null ? null : homeWords(trouble),
    createdAt: runner.createdAt,
    ...machineProblems(runner),
    // The code it came with, by the list's own id: the connect dialog counts its code's machines by it.
    codeId: runner.codeSha256 === null ? null : codeIdOf(runner.codeSha256),
    ...selfDrain(runner, state),
  }
}

/**
 * A machine draining by its own word (RemoteMachine.selfDrain): its last
 * sync said `draining` (an update, a stop) or `leaving`, while its row is
 * still active — the owner did not drain it, and home did not quarantine it
 * (machineState reads either as `draining`). The resume door lifts only
 * those two, so it answered 200 and changed nothing for this one.
 */
function selfDrain(runner: RunnerRow, state: RemoteMachine['state']): Pick<RemoteMachine, 'selfDrain'> {
  if (state !== 'draining' || runner.state !== 'active') return {}
  const own = lastSync(runner.id)?.state
  return own === 'draining' || own === 'leaving' ? { selfDrain: own } : {}
}

/** The machine's own problems of its last sync (disk, docker, cards): none of them is one competition's. */
function machineProblems(runner: RunnerRow): Pick<RemoteMachine, 'problems'> {
  const own = (lastSync(runner.id)?.problems ?? []).filter((problem) => !problem.revisionId && !problem.manifest && !problem.bundleId)
  return own.length ? { problems: own.map((problem) => ({ code: problem.code, detail: homeWords(problem.detail) })) } : {}
}

function codeView(code: ReturnType<typeof liveCodes>[number]): RemoteCodeView {
  return {
    id: codeIdOf(code.codeSha256),
    createdAt: code.createdAt,
    expiresAt: code.expiresAt,
    machines: code.machines,
    used: codeJoins(code.codeSha256),
    trusted: code.trusted,
    approvedSlots: code.approvedSlots,
    namePrefix: code.namePrefix || null,
    createdBy: code.createdBy === 'colloq-host' ? null : (getTeacher(code.createdBy)?.name ?? null),
    console: code.createdBy === 'colloq-host',
  }
}

/** The most common of some numbers; `null` — none. */
function mode(values: readonly number[]): number | null {
  const seen = new Map<number, number>()
  for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1)
  let best: number | null = null
  for (const [value, n] of seen) if (best === null || n > (seen.get(best) ?? 0) || (n === seen.get(best) && value < best)) best = value
  return best
}

/** GET /api/admin/runners (M1). */
export async function machinesResponse(now = Date.now()): Promise<RemoteMachinesResponse> {
  const stock = await homeStock(now).catch(() => new Map<string, CompetitionStock>())
  const runners = listRunners()
  // Every machine's places in the same runs: the queue's, or the next upload's (placeMix).
  const mix = placeMix(queueRows(), now)
  const machines = runners.map((runner) => machineView(runner, stock, now, mix))
  const online = machines.filter((machine) => machine.state === 'online')
  const onlineCards = online.flatMap((machine) => machine.cards)
  const slices = onlineCards.map((card) => card.sliceMb)
  const quarantined = runners
    .filter((runner) => runner.state === 'draining' && runner.quarantinedAt !== null && !runner.quarantineSeen)
    .sort((a, b) => (b.quarantinedAt ?? 0) - (a.quarantinedAt ?? 0))[0]
  return {
    summary: {
      online: online.length,
      total: machines.filter((machine) => machine.state !== 'revoked' && machine.state !== 'left').length,
      places: online.reduce((sum, machine) => sum + (machine.places.approved === null ? machine.places.offered : Math.min(machine.places.approved, machine.places.offered)), 0),
      busy: online.reduce((sum, machine) => sum + machine.places.busy, 0),
      cards: onlineCards.length,
      perDevice: mode(onlineCards.map((card) => card.perDevice)),
      sliceMb: slices.length === 0 || slices.some((slice) => slice === null) ? null : Math.min(...(slices as number[])),
    },
    homeNotebooks: homeNotebooksSetting().value,
    scoreSlots: scoreSlotsSetting().value,
    machines,
    codes: liveCodes(now).map(codeView),
    home: { version: homeVersion(), build: homeRunnerBuild() },
    banner: quarantined ? { machineId: quarantined.id, name: quarantined.name, at: quarantined.quarantinedAt! } : null,
  }
}

/** A lease as the machine's page lists it: whose submission, how far, on which card. */
function runView(lease: LeaseRow): RemoteMachineRun | null {
  const submission = getSubmission(lease.submissionId)
  const competition = getCompetition(lease.competitionId)
  if (!submission || !competition) return null
  return {
    attemptId: lease.attemptId,
    submissionId: lease.submissionId,
    competitionId: lease.competitionId,
    competition: competition.title,
    entrantName: getEntrant(submission.entrantId)?.name ?? '',
    number: submission.number,
    phase: lease.phase ?? 'accepted',
    startedAt: lease.startedAt,
    limitMs: lease.manifest.limits.wallSeconds * 1000,
    card: lease.device ? { device: lease.device, sliceMb: lease.sliceMb } : null,
  }
}

/** GET /api/admin/runners/:id (M3); `null` — no such machine. Opening it is the owner having looked at its quarantine. */
export async function machineDetail(id: string, now = Date.now()): Promise<RemoteMachineDetail | null> {
  let runner = getRunner(id)
  if (!runner) return null
  if (runner.quarantinedAt !== null && !runner.quarantineSeen) runner = updateRunner(id, { quarantineSeen: true }) ?? runner
  const stock = await homeStock(now).catch(() => new Map<string, CompetitionStock>())
  const events: RemoteEvent[] = runnerEvents(id, 50).map((event) => {
    const lease = event.attemptId ? getLease(event.attemptId) : null
    const submission = lease ? getSubmission(lease.submissionId) : null
    const competition = lease ? getCompetition(lease.competitionId) : null
    return {
      at: event.at,
      kind: event.kind,
      attemptId: event.attemptId,
      entrantName: submission ? (getEntrant(submission.entrantId)?.name ?? null) : null,
      number: submission?.number ?? null,
      competition: competition?.title ?? null,
      // What a machine said (its hostname at the join, a problem, a decline's detail) is shown in this server's words, never as raw markers.
      detail: event.detail === null ? null : homeWords(event.detail),
    }
  })
  return {
    ...machineView(runner, stock, now, placeMix(queueRows(), now)),
    runs: liveLeases(id).map(runView).filter((run): run is RemoteMachineRun => run !== null),
    events,
  }
}

/* -------------------------------------------------------------- the fleet */

/** A live machine as the forecast counts it, read once per forecast: its row, and what it could give a run at all (fit.ts). */
export interface FleetMachine {
  runner: RunnerRow
  /** Judged against all the machine has — its room with its runs ended — not what is left now: a row no machine can EVER fit is `no_fit`. */
  fit: FitMachine
  /** Its places before the size of the runs: the owner's cap, or what it offers in all (free and held). */
  cap: number
  /** The submissions it is skipping for a decline (store.ts · declinedBy): it will not take them for REMOTE_DECLINE_SKIP_MS. */
  declined: ReadonlySet<string>
}

/** The machines that take work now (§5.7), as the forecast and the wait reasons read them, once per pass. */
export interface RemoteFleet {
  places: number
  gpuShares: number
  runners: Set<string>
  sliceMb: number | null
  machines: FleetMachine[]
}

/**
 * The places and card shares of the machines that take work now (§5.7):
 * what the forecast adds to this server's own. A machine's places are the
 * owner's cap or what it offers, in runs of `mix` (placesForMix: the
 * forecast's queue, the console's competition); its shares, its cards times
 * the runs per card it is held to.
 *
 * ONCE PER FORECAST. Every participant's page recomputes the forecast every
 * second, so the machines are read here in one pass — the rows once, every
 * live lease once — and the same picture goes to the GPU places, the wait
 * reasons and the places (forecast.ts · queueForecast), rather than each
 * asking again per machine. Only machines still allowed to call are read: a
 * revoked or gone machine is no part of any forecast (listStandingRunners).
 */
export function remoteFleet(now = Date.now(), mix?: PlaceMix): RemoteFleet {
  let places = 0
  let gpuShares = 0
  let sliceMb: number | null = null
  const runners = new Set<string>()
  const machines: FleetMachine[] = []
  const live = listStandingRunners().filter((runner) => liveRunner(runner, now))
  const leases = new Map<string, LeaseRow[]>()
  if (live.length > 0) {
    for (const lease of liveLeases()) {
      const held = leases.get(lease.runnerId)
      if (held) held.push(lease)
      else leases.set(lease.runnerId, [lease])
    }
  }
  const sizes = live.length > 0 ? (mix ?? placeMix(queueRows(), now)) : []
  // What each machine is skipping for a decline, for all of them in one read (the take's own skip, store.ts · declinedBy).
  const skipped = declinedByRunners(live.map((runner) => runner.id), now - REMOTE_DECLINE_SKIP_MS)
  for (const runner of live) {
    runners.add(runner.id)
    const sync = lastSync(runner.id)!
    const held = leases.get(runner.id) ?? []
    const offered = sync.free.slots + sync.attempts.length
    const cap = runner.approvedSlots === null ? offered : Math.min(runner.approvedSlots, offered)
    const cards = runnerCards(runner)
    const perDevice = perDeviceOf(runner)
    gpuShares += cards.length * perDevice
    for (const card of cards) {
      const slice = gpuSliceMb(card.memoryMb, perDevice)
      if (slice !== null) sliceMb = sliceMb === null ? slice : Math.min(sliceMb, slice)
    }
    const fit = capacityOf(runner, sync, held, cards.length * perDevice)
    places += placesForMix(cap, fit.room, sizes)
    machines.push({ runner, fit, cap, declined: skipped.get(runner.id) ?? new Set() })
  }
  return { places, gpuShares, runners, sliceMb, machines }
}

/**
 * What a machine could give a run AT ALL, as the take would find it on the
 * machine idle: the room its last sync says is free, plus what the runs it
 * listed hold (the agent's own sum, §5.2 "Runner-side admission": usable
 * memory is its total less the host's reserve less each run's memory and
 * cushion), every card share it has, and disk taken for what it will be —
 * a full disk is a decline and an eviction, never a row that cannot fit.
 */
function capacityOf(runner: RunnerRow, sync: RemoteSyncRequest, held: readonly LeaseRow[], shares: number): FitMachine {
  const listed = new Set(sync.attempts.map((attempt) => attempt.id))
  let memoryMb = sync.free.memoryMb
  let cpus = sync.free.cpus
  for (const lease of held) {
    if (!listed.has(lease.attemptId)) continue
    const claim = stepClaim(lease.manifest.limits)
    memoryMb += claim.memoryMb
    cpus += claim.cpus
  }
  return {
    ready: {
      revisions: new Set(sync.ready.revisions),
      data: new Set(sync.ready.data),
      sealed: new Set(runner.trusted ? sync.ready.sealed : []),
    },
    trusted: runner.trusted,
    cards: sync.cards.length > 0,
    room: { memoryMb, cpus, gpuShares: shares, diskMb: Math.max(REMOTE_ATTEMPT_DISK_MB, sync.free.diskMb) },
  }
}

/**
 * The console's grid groups (M4): this server first — its places for
 * notebooks, none with «Тетради на этом сервере» off (`metricsOnly`), when
 * the metric lane's places and runs come in `metric` instead, and its own
 * version beside the machines' — then each machine that takes work or still
 * holds runs. `undefined` — no machine was ever connected, and the grid
 * stays one block as before. This server's `busy` is its notebook runs only:
 * a metric of the metric lane holds no notebook place, here or anywhere. A
 * machine's places are in runs of `mix` (placesForMix): the console's own
 * competition, or the queue's work.
 */
export function consoleGroups(homeSlots: number, homeCards: { count: number; perDevice: number } | null, now = Date.now(), mix: PlaceMix = placeMix(queueRows(), now)): RemoteConsoleGroup[] | undefined {
  if (!anyRunnerEver()) return undefined
  const homeOn = homeNotebooksSetting().value
  const here = runningRows()
  const groups: RemoteConsoleGroup[] = [{
    machineId: null,
    name: null,
    state: null,
    places: homeOn ? homeSlots : 0,
    busy: here.filter((row) => row.kind === 'notebook').length,
    cards: homeOn ? homeCards : null,
    ...(homeOn ? {} : { metricsOnly: true, metric: { places: scoreSlotsSetting().value, busy: here.filter((row) => row.kind === 'metric').length } }),
    version: homeVersion(),
  }]
  // The machines still allowed to call, and any other that still holds a row (a result of a machine revoked meanwhile, being applied).
  const standing = listStandingRunners()
  const holders = new Set(heldRows().flatMap((row) => (row.holder !== null && !standing.some((runner) => runner.id === row.holder) ? [row.holder] : [])))
  const others = [...holders].flatMap((id) => getRunner(id) ?? [])
  for (const runner of [...standing, ...others]) {
    const busy = liveLeases(runner.id).length
    if (!liveRunner(runner, now) && busy === 0) continue
    const state = machineState(runner, now)
    const places = machinePlaces(runner, mix)
    const cards = runnerCards(runner)
    const at = heardAt(runner.id) ?? runner.lastSeenAt
    groups.push({
      machineId: runner.id,
      name: runner.name,
      state,
      places: places.places,
      busy,
      cards: cards.length ? { count: cards.length, perDevice: perDeviceOf(runner) } : null,
      ...(state === 'silent' ? { silentSince: at } : {}),
      version: lastSync(runner.id)?.facts?.version ?? runner.version,
    })
  }
  return groups
}

/* ------------------------------------------------------------ wait reasons */

export interface WaitReason {
  reason: RemoteWaitReason
  /** With `returned`: the machine, by name, and why when known. */
  returnedFrom?: string
  returnedWhy?: RemoteReturnReason
  /**
   * With `returned`: every live machine is skipping it for a decline (the
   * take will not lease it to any of them within REMOTE_DECLINE_SKIP_MS), and
   * this server does not take it either — back in its place, and still no
   * place to start in for now.
   */
  skipped?: boolean
  /**
   * This server's pump would take it, and leaves it to the machines for its
   * size instead (runner.ts · leftToMachines): more memory than this server
   * could ever reserve, or more CPUs than it has while a machine will take
   * it. Its reason is the machines' — `no_runners` with none on line — and
   * the words say this server is too small, not that it runs no notebooks.
   */
  tooBig?: true
}

/** Whether a reason keeps a row out of every executor's reach now: no place, «готовится» for the participant. */
export function blocking(reason: WaitReason | undefined): boolean {
  return reason !== undefined && (reason.reason !== 'returned' || reason.skipped === true)
}

/**
 * Why each waiting notebook is not taken, when the reason is a machine's and
 * not its turn (§5.7, RemoteWaitReason) — on a picture read once for all the
 * rows: the fleet (passed in by the forecast, which has it already), each
 * competition, revision and set once (fit.ts · FitCache), and the last lease
 * of every row in one query. Nothing for a row this server's own notebooks
 * can take; `returned` for a row that came back from a machine (its place
 * kept, no quota spent).
 *
 * `left` — the notebooks this server leaves to the machines for their size
 * (runner.ts · leftToMachines, which the forecast asks once per pass): its
 * own pump passes them over, so they wait for the machines' reasons like a
 * notebook this server never takes (`tooBig`). Without a machine ever
 * connected the queue has no word of machines, except for these: nothing
 * here will run them.
 */
export function waitReasons(
  rows: readonly QueueRow[],
  options: { homeCards: boolean; now?: number; fleet?: RemoteFleet; left?: ReadonlySet<string> } = { homeCards: false },
): Map<string, WaitReason> {
  const now = options.now ?? Date.now()
  const out = new Map<string, WaitReason>()
  const waiting = rows.filter((row) => row.state === 'waiting' && row.kind === 'notebook')
  if (waiting.length === 0) return out
  const homeOn = homeNotebooksSetting().value
  const cache = fitCache()
  // Left for its size by a server whose pump would take it otherwise; a notebook it never takes (a card it has not) waits as it did.
  const big = new Set(
    waiting
      .filter((row) => options.left?.has(row.submissionId) && homeTakes({ gpu: rowNeedsCard(row, cache), homeNotebooks: homeOn, homeCards: options.homeCards }))
      .map((row) => row.submissionId),
  )
  // No machine ever, and this server runs notebooks: the queue as it was before machines, but for the notebooks too big for it.
  const notebooks = homeOn && !anyRunnerEver() ? waiting.filter((row) => big.has(row.submissionId)) : waiting
  if (notebooks.length === 0) return out
  const fleet = options.fleet ?? remoteFleet(now)
  const last = lastLeasesOf(notebooks.map((row) => row.submissionId))
  let names: Map<string, string> | null = null
  const nameOf = (runnerId: string): string => {
    names ??= new Map(listRunners().map((runner) => [runner.id, runner.name]))
    return names.get(runnerId) ?? runnerId
  }
  for (const row of notebooks) {
    const tooBig = big.has(row.submissionId)
    const size = tooBig ? { tooBig: true as const } : {}
    const blocked = blockedBy(row, homeOn, options.homeCards, fleet.machines, cache, tooBig)
    if (blocked && blocked !== 'skipped') {
      out.set(row.submissionId, { reason: blocked, ...size })
      continue
    }
    const returned = returnedOf(row, last.get(row.submissionId) ?? null, nameOf)
    // Skipped by every live machine for a decline: back from one of them, and no place until the skip ends or another machine comes.
    if (blocked === 'skipped') out.set(row.submissionId, { ...(returned ?? { reason: 'returned' as const }), skipped: true, ...size })
    else if (returned) out.set(row.submissionId, { ...returned, ...size })
  }
  return out
}

/** The machine a waiting row came back from, if its last lease ended without its result in this stay in the queue. */
function returnedOf(row: QueueRow, last: LeaseRow | null, nameOf: (runnerId: string) => string): WaitReason | null {
  if (!last || last.offeredAt < row.enqueuedAt) return null
  if (last.state !== 'lost' && last.state !== 'withdrawn' && last.state !== 'declined' && !(last.state === 'revoked' && last.cause !== 'cancelled')) return null
  const why: RemoteReturnReason | undefined = last.cause === 'silent'
    ? 'silent'
    : last.state === 'declined' && last.cause !== 'draining' && last.cause !== 'starved'
      ? 'declined'
      : last.cause === 'draining' || last.cause === 'revoked' || last.cause === 'untrusted' || last.cause === 'orphan'
        ? 'released'
        : undefined
  return { reason: 'returned', returnedFrom: nameOf(last.runnerId), ...(why ? { returnedWhy: why } : {}) }
}

/** The wait reason of a machine's refusal (fit.ts · MachineRefusal), the furthest of them across machines being the one that matters. */
const REFUSAL_REASON: Readonly<Record<MachineRefusal, RemoteWaitReason>> = {
  card: 'no_gpu_runner',
  trusted: 'needs_trusted',
  room: 'no_fit',
  image: 'preparing_image',
  data: 'preparing_data',
}
const REFUSAL_ORDER: readonly MachineRefusal[] = ['card', 'trusted', 'room', 'image', 'data']

/**
 * Why no live machine can take this row, by the take's own predicate
 * (fit.ts): what the row needs of any machine first — its environment only
 * this server has, or something no machine changes (`no_fit`) — then each
 * live machine against all it has, and of their refusals the furthest one,
 * the reason the nearest machine waits on. `null` — some live machine can
 * run it once its turn and a place come, or this server will. `skipped` —
 * every live machine that could run it is skipping it for a decline (the
 * take's own skip, store.ts · declinedBy), so nothing takes it before the
 * skip ends: it gets no place either, as the take gives it none.
 *
 * WHETHER THIS SERVER TAKES IT IS ASKED FIRST, from the competition alone
 * (fit.ts · homeTakes): on a server that runs its notebooks itself the row's
 * needs of a machine change nothing, and reading them — the revision, the
 * set, the notebook, whether the image is a GPU kernel — for every waiting row
 * on every participant's poll was the forecast's whole cost. Unless it is too
 * big for this server (`tooBig`, runner.ts · leftToMachines): then only a
 * machine runs it, and with none on line nobody does (`no_runners` — not
 * `no_gpu_runner`, which is a card's).
 */
function blockedBy(row: QueueRow, homeOn: boolean, homeCards: boolean, live: readonly FleetMachine[], cache: FitCache, tooBig = false): RemoteWaitReason | 'skipped' | null {
  if (!tooBig && homeTakes({ gpu: rowNeedsCard(row, cache), homeNotebooks: homeOn, homeCards })) return null
  const read = rowNeeds(row, cache)
  // A competition gone is a row on its way out.
  if (!read.ok && read.why === 'gone') return null
  /*
   * A set that cannot fit runs nowhere: this server settles it with the
   * refusal (liveness.ts · settleUnfit) — within a pass of the clock — and
   * until then it has no place. Only this server's own pump settles it at
   * once, and that pump takes this row only where homeTakes said so above.
   */
  if (!read.ok && read.why === 'unfit') return 'no_fit'
  /*
   * A GPU notebook on a server without cards is the machines' alone, whatever
   * this server's switch says, so it waits for the same reasons it would with
   * the switch off: no machine with cards, an environment only this server
   * has, the trust, the room, the image, the data.
   */
  if (!read.ok) return read.why === 'home_only' ? 'home_only_env' : 'no_fit'
  // With this server's notebooks on, a row it does not take is a GPU one it has no card for — unless it is too big for it.
  if (live.length === 0) return homeOn && !tooBig ? 'no_gpu_runner' : 'no_runners'
  let furthest = -1
  let skipping = false
  for (const machine of live) {
    // Its run's size against all the machine has (capacityOf): a machine whose places are full now is no machine it can never fit.
    const refusal = machineFit(read.needs, machine.fit)
    if (refusal === null) {
      if (!machine.declined.has(row.submissionId)) return null
      skipping = true
      continue
    }
    furthest = Math.max(furthest, REFUSAL_ORDER.indexOf(refusal))
  }
  // The nearest machine is one that could run it and skips it: any that cannot yet is further from it.
  if (skipping) return 'skipped'
  return REFUSAL_REASON[REFUSAL_ORDER[furthest]]
}

/* --------------------------------------------------------- the console rows */

/** A machine's run as the console shows it (RunningNow.machine, remotePhase, gpu). */
export function heldRunView(row: QueueRow): { machine: { id: string; name: string }; phase: LeaseRow['phase']; card: { device: string; sliceMb: number | null } | null } | null {
  if (!row.holder || !row.attemptId) return null
  const lease = getLease(row.attemptId)
  const runner = getRunner(row.holder)
  return {
    machine: { id: row.holder, name: runner?.name ?? row.holder },
    phase: lease?.phase ?? 'accepted',
    card: lease?.device ? { device: lease.device, sliceMb: lease.sliceMb } : null,
  }
}

/* ------------------------------------------------------- «Работают сейчас» */

/**
 * «Работают сейчас» (M5): competitions whose submissions run on machines,
 * each with the machines and their runs, and the metric runs this server
 * does for them (which are in RunningKernels.runs, holding memory here, like
 * any other), and the submissions themselves, for «Остановить все» through
 * the console's kill door — a durable cancel for a machine's run
 * (runner.ts · cancelSubmission → release.ts · cancelRemote). Another
 * course's competitions are one line of numbers, with no ids to act on.
 * `undefined` — no machine holds a run.
 *
 * `scoring` counts the metrics of results that came from machines (a fresh
 * result's row, QueueRow.fresh), never a rescore: «Пересчитать все» during a
 * burst read as «2 ответа с машин» for submissions scored long ago.
 */
export function runningRemote(viewer: StaffLike): RunningRemote[] | undefined {
  const held = heldRows()
  if (held.length === 0) return undefined
  const metrics = new Map<string, number>()
  for (const row of runningRows()) if (row.kind === 'metric' && row.fresh) metrics.set(row.competitionId, (metrics.get(row.competitionId) ?? 0) + 1)
  const out = new Map<string, RunningRemote>()
  const hiddenKey = '\u0000hidden'
  for (const row of held) {
    const competition = getCompetition(row.competitionId)
    const visible = competition !== null && canSeeCompetition(viewer, competition)
    const key = visible ? row.competitionId : hiddenKey
    let entry = out.get(key)
    if (!entry) {
      entry = { competitionId: visible ? row.competitionId : null, competition: visible ? competition.title : null, hidden: !visible, machines: [], scoring: 0, submissionIds: [] }
      out.set(key, entry)
    }
    if (visible) {
      entry.scoring = metrics.get(row.competitionId) ?? 0
      entry.submissionIds.push(row.submissionId)
    }
    const view = heldRunView(row)
    if (!view) continue
    let machine = entry.machines.find((one) => one.id === view.machine.id)
    if (!machine) {
      machine = { id: view.machine.id, name: view.machine.name, runs: 0, devices: [] }
      entry.machines.push(machine)
    }
    machine.runs++
    if (view.card && !machine.devices.includes(view.card.device)) machine.devices.push(view.card.device)
  }
  return [...out.values()]
}

/* --------------------------------------------------------- «Где считается» */

/**
 * The editor's «Где считается» (M6, CompetitionView.where): this server and
 * the machines against this competition as saved, and what the editor warns
 * about. `undefined` — no machine was ever connected, and the editor draws
 * neither the row nor its warnings, as before machines.
 */
export function competitionWhere(competition: Competition, homeSlots: number, now = Date.now()): RemoteCompetitionWhere | undefined {
  if (!anyRunnerEver()) return undefined
  const homeOn = homeNotebooksSetting().value
  const stock = stockNow(now)
  const entry: CompetitionStock = stock.get(competition.id) ?? stockEntry(competition)
  // This competition's places on each machine are in runs of its own size: what the take will lease there.
  const mix = competitionMix(competition)
  const machines = listStandingRunners()
    .map((runner) => ({
      id: runner.id,
      name: runner.name,
      state: machineState(runner, now),
      verdict: readinessFor(runner, entry).verdict,
      places: machinePlaces(runner, mix).places,
      cards: runnerCards(runner).length,
      trusted: runner.trusted,
    }))
  const registry = [...new Set(revisions().filter((revision) => portableRevision(revision)).map((revision) => revision.environmentName))].sort()
  const cards = remoteCardsSeen(now)
  return {
    home: { notebooks: homeOn, places: homeOn ? homeSlots : 0 },
    machines,
    registry,
    homeOnly: entry.homeOnly,
    cards: { recent: cards.recent, last: cards.last, sliceMb: smallestShare(cards.runners) },
  }
}

/**
 * The share a GPU run is promised on the machines (§5.8, decision 8): the
 * smallest card's memory over its machine's runs per card, among the
 * machines with cards heard within REMOTE_GPU_SEEN_MS — those the GPU door
 * counts. `null` — none of their cards said its size.
 */
function smallestShare(runners: readonly RunnerRow[]): number | null {
  let smallest: number | null = null
  for (const runner of runners) {
    const perDevice = perDeviceOf(runner)
    for (const card of runnerCards(runner)) {
      const slice = gpuSliceMb(card.memoryMb, perDevice)
      if (slice !== null) smallest = smallest === null ? slice : Math.min(smallest, slice)
    }
  }
  return smallest
}

/** A competition the machines do not prefetch yet (a draft): its picture as it would be, read from the rows. */
function stockEntry(competition: Competition): CompetitionStock {
  const data = dataNow(competition.id)
  const current = competitionRevision(competition.id)
  return {
    competition,
    rank: 9,
    revisions: current && portableRevision(current) ? [current] : [],
    homeOnly: !portableRevision(current),
    currentRevisionId: current && portableRevision(current) ? current.id : null,
    open: data.open,
    sealed: data.sealed,
    hasSealed: data.hasSealed,
    bundles: [],
  }
}
