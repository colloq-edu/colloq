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
import { REMOTE_ATTEMPT_DISK_MB, remoteCompatible, type RemoteSyncRequest } from '@shared/remote-runner'
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
import type { Competition } from '@shared/competitions'
import { competitionRevision, revisions } from '../../dependencies/store.js'
import { canSeeCompetition } from '../scope.js'
import type { StaffLike } from '../../admin/access.js'
import { gpuSliceMb } from '../gpu-math.js'
import { gpuPerDeviceSetting, homeNotebooksSetting, scoreSlotsSetting } from '../settings.js'
import { getCompetition, getEntrant, getSubmission, heldRows, runningRows, type QueueRow } from '../store.js'
import { heardAddress, heardAt, lastSync, liveRunner, machineState, remoteCardsSeen, runnerCards } from './heard.js'
import { fitCache, machineFit, rowNeeds, stepClaim, type FitCache, type FitMachine, type MachineRefusal } from './fit.js'
import {
  anyRunnerEver,
  boundedPerDevice,
  codeIdOf,
  codeJoins,
  getLease,
  getRunner,
  homeRunnerBuild,
  homeVersion,
  lastLeasesOf,
  lastTrouble,
  liveCodes,
  liveLeases,
  listRunners,
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

/** A machine's places: the owner's cap, what it offers (free and held), what it holds now, and the places that makes. */
export function machinePlaces(runner: RunnerRow): { approved: number | null; offered: number; busy: number; places: number } {
  const sync = lastSync(runner.id)
  const offered = sync ? sync.free.slots + sync.attempts.length : 0
  const busy = liveLeases(runner.id).length
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

export function machineView(runner: RunnerRow, stock: ReadonlyMap<string, CompetitionStock>, now = Date.now()): RemoteMachine {
  const state = machineState(runner, now)
  const at = heardAt(runner.id) ?? runner.lastSeenAt
  const places = machinePlaces(runner)
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
  }
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
  const machines = runners.map((runner) => machineView(runner, stock, now))
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
    ...machineView(runner, stock, now),
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
 * owner's cap or what it offers; its shares, its cards times the runs per
 * card it is held to.
 *
 * ONCE PER FORECAST. Every participant's page recomputes the forecast every
 * second, so the machines are read here in one pass — the rows once, every
 * live lease once — and the same picture goes to the GPU places, the wait
 * reasons and the places (forecast.ts · queueForecast), rather than each
 * asking again per machine.
 */
export function remoteFleet(now = Date.now()): RemoteFleet {
  let places = 0
  let gpuShares = 0
  let sliceMb: number | null = null
  const runners = new Set<string>()
  const machines: FleetMachine[] = []
  const live = listRunners().filter((runner) => liveRunner(runner, now))
  const leases = new Map<string, LeaseRow[]>()
  if (live.length > 0) {
    for (const lease of liveLeases()) {
      const held = leases.get(lease.runnerId)
      if (held) held.push(lease)
      else leases.set(lease.runnerId, [lease])
    }
  }
  for (const runner of live) {
    runners.add(runner.id)
    const sync = lastSync(runner.id)!
    const held = leases.get(runner.id) ?? []
    const offered = sync.free.slots + sync.attempts.length
    places += runner.approvedSlots === null ? offered : Math.min(runner.approvedSlots, offered)
    const cards = runnerCards(runner)
    const perDevice = perDeviceOf(runner)
    gpuShares += cards.length * perDevice
    for (const card of cards) {
      const slice = gpuSliceMb(card.memoryMb, perDevice)
      if (slice !== null) sliceMb = sliceMb === null ? slice : Math.min(sliceMb, slice)
    }
    machines.push({ runner, fit: capacityOf(runner, sync, held, cards.length * perDevice) })
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
 * a metric of the metric lane holds no notebook place, here or anywhere.
 */
export function consoleGroups(homeSlots: number, homeCards: { count: number; perDevice: number } | null, now = Date.now()): RemoteConsoleGroup[] | undefined {
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
  for (const runner of listRunners()) {
    const busy = liveLeases(runner.id).length
    if (!liveRunner(runner, now) && busy === 0) continue
    const state = machineState(runner, now)
    const places = machinePlaces(runner)
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
}

/** Whether a reason keeps a row out of every executor's reach now: no place, «готовится» for the participant. */
export function blocking(reason: WaitReason | undefined): boolean {
  return reason !== undefined && reason.reason !== 'returned'
}

/**
 * Why each waiting notebook is not taken, when the reason is a machine's and
 * not its turn (§5.7, RemoteWaitReason) — on a picture read once for all the
 * rows: the fleet (passed in by the forecast, which has it already), each
 * competition, revision and set once (fit.ts · FitCache), and the last lease
 * of every row in one query. Nothing for a row this server's own notebooks
 * can take; `returned` for a row that came back from a machine (its place
 * kept, no quota spent).
 */
export function waitReasons(rows: readonly QueueRow[], options: { homeCards: boolean; now?: number; fleet?: RemoteFleet } = { homeCards: false }): Map<string, WaitReason> {
  const now = options.now ?? Date.now()
  const out = new Map<string, WaitReason>()
  const notebooks = rows.filter((row) => row.state === 'waiting' && row.kind === 'notebook')
  if (notebooks.length === 0) return out
  const homeOn = homeNotebooksSetting().value
  // No machine ever, and this server runs notebooks: the queue as it was before machines, with no word of them.
  if (homeOn && !anyRunnerEver()) return out
  const fleet = options.fleet ?? remoteFleet(now)
  const cache = fitCache()
  const last = lastLeasesOf(notebooks.map((row) => row.submissionId))
  let names: Map<string, string> | null = null
  const nameOf = (runnerId: string): string => {
    names ??= new Map(listRunners().map((runner) => [runner.id, runner.name]))
    return names.get(runnerId) ?? runnerId
  }
  for (const row of notebooks) {
    const blocked = blockedBy(row, homeOn, options.homeCards, fleet.machines, cache)
    if (blocked) {
      out.set(row.submissionId, { reason: blocked })
      continue
    }
    const returned = returnedOf(row, last.get(row.submissionId) ?? null, nameOf)
    if (returned) out.set(row.submissionId, returned)
  }
  return out
}

/** The machine a waiting row came back from, if its last lease ended without its result in this stay in the queue. */
function returnedOf(row: QueueRow, last: LeaseRow | null, nameOf: (runnerId: string) => string): WaitReason | null {
  if (!last || last.offeredAt < row.enqueuedAt) return null
  if (last.state !== 'lost' && last.state !== 'withdrawn' && last.state !== 'declined' && !(last.state === 'revoked' && last.cause !== 'cancelled')) return null
  const why: RemoteReturnReason | undefined = last.cause === 'silent'
    ? 'silent'
    : last.state === 'declined' && last.cause !== 'draining'
      ? 'declined'
      : last.cause === 'draining' || last.cause === 'revoked' || last.cause === 'untrusted'
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
 * run it once its turn and a place come, or this server will.
 */
function blockedBy(row: QueueRow, homeOn: boolean, homeCards: boolean, live: readonly FleetMachine[], cache: FitCache): RemoteWaitReason | null {
  const read = rowNeeds(row, cache)
  // A competition gone is a row on its way out; a set that cannot fit is settled by this server itself (liveness.ts · settleUnfit).
  if (!read.ok && (read.why === 'gone' || read.why === 'unfit')) return null
  const gpu = read.ok ? read.needs.gpu : getCompetition(row.competitionId)?.limits.gpu === true
  /*
   * This server runs it, on its own cards for a GPU notebook. A GPU notebook
   * on a server without cards is the machines' alone, whatever this server's
   * switch says, so it waits for the same reasons it would with the switch
   * off: no machine with cards, an environment only this server has, the
   * trust, the room, the image, the data.
   */
  if (homeOn && !(gpu && !homeCards)) return null
  if (!read.ok) return read.why === 'home_only' ? 'home_only_env' : 'no_fit'
  if (live.length === 0) return homeOn ? 'no_gpu_runner' : 'no_runners'
  let furthest = -1
  for (const machine of live) {
    const refusal = machineFit(read.needs, machine.fit)
    if (refusal === null) return null
    furthest = Math.max(furthest, REFUSAL_ORDER.indexOf(refusal))
  }
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
 */
export function runningRemote(viewer: StaffLike): RunningRemote[] | undefined {
  const held = heldRows()
  if (held.length === 0) return undefined
  const metrics = new Map<string, number>()
  for (const row of runningRows()) if (row.kind === 'metric') metrics.set(row.competitionId, (metrics.get(row.competitionId) ?? 0) + 1)
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
  const machines = listRunners()
    .filter((runner) => runner.state !== 'revoked' && runner.state !== 'left')
    .map((runner) => ({
      id: runner.id,
      name: runner.name,
      verdict: readinessFor(runner, entry).verdict,
      places: machinePlaces(runner).places,
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
