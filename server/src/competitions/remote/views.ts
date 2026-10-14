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
import { remoteCompatible, type RemoteSyncRequest } from '@shared/remote-runner'
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
import { competitionRevision, getBinding, getRevision, revisions } from '../../dependencies/store.js'
import { canSeeCompetition } from '../scope.js'
import type { StaffLike } from '../../admin/access.js'
import { gpuSliceMb } from '../gpu-math.js'
import { gpuPerDeviceSetting, homeNotebooksSetting, scoreSlotsSetting } from '../settings.js'
import { getCompetition, getEntrant, getSubmission, heldRows, runningRows, type QueueRow } from '../store.js'
import { heardAddress, heardAt, lastSync, liveRunner, liveRunners, machineState, remoteCardsSeen, runnerCards } from './heard.js'
import {
  anyRunnerEver,
  boundedPerDevice,
  codeJoins,
  getLease,
  getRunner,
  homeRunnerBuild,
  homeVersion,
  lastLeaseOf,
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
  return {
    id: runner.id,
    name: runner.name,
    state,
    trusted: runner.trusted,
    lastSeenAt: at,
    silentSince: state === 'silent' ? at : null,
    address: heardAddress(runner.id) ?? runner.lastAddress,
    version: lastSync(runner.id)?.facts?.version ?? runner.version,
    compatible: remoteCompatible(homeRunnerBuild(), runner.build ?? ''),
    facts: factsView(runner),
    cards: cardsView(runner),
    places: { approved: places.approved, offered: places.offered, busy: places.busy },
    perDevice: runner.perDevice,
    readiness: readinessOf(runner, stock),
    counts: { scored: counts.applied, lost: counts.lost, declined: counts.declined, requeued: counts.requeued },
    lastTrouble: lastTrouble(runner.id),
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
    id: code.codeSha256.slice(0, 8),
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
      detail: event.detail,
    }
  })
  return {
    ...machineView(runner, stock, now),
    runs: liveLeases(id).map(runView).filter((run): run is RemoteMachineRun => run !== null),
    events,
  }
}

/* -------------------------------------------------------------- the fleet */

/**
 * The places and card shares of the machines that take work now (§5.7):
 * what the forecast adds to this server's own. A machine's places are the
 * owner's cap or what it offers; its shares, its cards times the runs per
 * card it is held to.
 */
export function remoteFleet(now = Date.now()): { places: number; gpuShares: number; runners: Set<string>; sliceMb: number | null } {
  let places = 0
  let gpuShares = 0
  let sliceMb: number | null = null
  const runners = new Set<string>()
  for (const runner of liveRunners(now)) {
    runners.add(runner.id)
    places += machinePlaces(runner).places
    const cards = runnerCards(runner)
    const perDevice = perDeviceOf(runner)
    gpuShares += cards.length * perDevice
    for (const card of cards) {
      const slice = gpuSliceMb(card.memoryMb, perDevice)
      if (slice !== null) sliceMb = sliceMb === null ? slice : Math.min(sliceMb, slice)
    }
  }
  return { places, gpuShares, runners, sliceMb }
}

/**
 * The console's grid groups (M4): this server first — its places for
 * notebooks, none with «Тетради на этом сервере» off (`metricsOnly`) — then
 * each machine that takes work or still holds runs. `undefined` — no machine
 * was ever connected, and the grid stays one block as before.
 */
export function consoleGroups(homeSlots: number, homeCards: { count: number; perDevice: number } | null, now = Date.now()): RemoteConsoleGroup[] | undefined {
  if (!anyRunnerEver()) return undefined
  const homeOn = homeNotebooksSetting().value
  const here = runningRows().filter((row) => row.kind === 'notebook').length
  const groups: RemoteConsoleGroup[] = [{
    machineId: null,
    name: null,
    state: null,
    places: homeOn ? homeSlots : 0,
    busy: here,
    cards: homeOn ? homeCards : null,
    ...(homeOn ? {} : { metricsOnly: true }),
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
 * rows. Nothing for a row this server's own notebooks can take; `returned`
 * for a row that came back from a machine (its place kept, no quota spent).
 */
export function waitReasons(rows: readonly QueueRow[], options: { homeCards: boolean; now?: number } = { homeCards: false }): Map<string, WaitReason> {
  const now = options.now ?? Date.now()
  const out = new Map<string, WaitReason>()
  const notebooks = rows.filter((row) => row.state === 'waiting' && row.kind === 'notebook')
  if (notebooks.length === 0) return out
  const homeOn = homeNotebooksSetting().value
  // No machine ever, and this server runs notebooks: the queue as it was before machines, with no word of them.
  if (homeOn && !anyRunnerEver()) return out
  const live = liveRunners(now)
  const data = new Map<string, ReturnType<typeof dataNow>>()
  const revisionsSeen = new Map<string, ReturnType<typeof getRevision>>()
  const competitions = new Map<string, Competition | null>()
  for (const row of notebooks) {
    if (!competitions.has(row.competitionId)) competitions.set(row.competitionId, getCompetition(row.competitionId))
    const competition = competitions.get(row.competitionId)
    if (!competition) continue
    const returned = returnedOf(row)
    const blocked = blockedBy(row, competition, homeOn, options.homeCards, live, data, revisionsSeen)
    if (blocked) out.set(row.submissionId, { reason: blocked })
    else if (returned) out.set(row.submissionId, returned)
  }
  return out
}

/** The machine a waiting row came back from, if its last lease ended without its result in this stay in the queue. */
function returnedOf(row: QueueRow): WaitReason | null {
  const last = lastLeaseOf(row.submissionId)
  if (!last || last.offeredAt < row.enqueuedAt) return null
  if (last.state !== 'lost' && last.state !== 'withdrawn' && last.state !== 'declined' && !(last.state === 'revoked' && last.cause !== 'cancelled')) return null
  const why: RemoteReturnReason | undefined = last.cause === 'silent'
    ? 'silent'
    : last.state === 'declined' && last.cause !== 'draining'
      ? 'declined'
      : last.cause === 'draining' || last.cause === 'revoked' || last.cause === 'untrusted'
        ? 'released'
        : undefined
  return { reason: 'returned', returnedFrom: getRunner(last.runnerId)?.name ?? last.runnerId, ...(why ? { returnedWhy: why } : {}) }
}

/*
 * A submission's pin is written once (dependencies/store.ts · bindSubmission
 * refuses to change it), so the revision it names is remembered here: the
 * forecast asks for every waiting row on every participant's poll. The
 * revision itself is read once per pass, its registry reference being what
 * a backfill may still add.
 */
const pins = new Map<string, string>()

function pinnedRevision(submissionId: string, seen: Map<string, ReturnType<typeof getRevision>>): ReturnType<typeof getRevision> {
  let id = pins.get(submissionId)
  if (id === undefined) {
    const bound = getBinding(submissionId)?.revision?.id
    if (!bound) return null
    if (pins.size >= 10_000) pins.delete(pins.keys().next().value!)
    pins.set(submissionId, bound)
    id = bound
  }
  if (!seen.has(id)) seen.set(id, getRevision(id))
  return seen.get(id) ?? null
}

function blockedBy(
  row: QueueRow,
  competition: Competition,
  homeOn: boolean,
  homeCards: boolean,
  live: readonly RunnerRow[],
  data: Map<string, ReturnType<typeof dataNow>>,
  revisionsSeen: Map<string, ReturnType<typeof getRevision>>,
): RemoteWaitReason | null {
  const gpu = competition.limits.gpu === true
  const carded = live.filter((runner) => runnerCards(runner).length > 0)
  /*
   * This server runs it, on its own cards for a GPU notebook. A GPU notebook
   * on a server without cards is the machines' alone, whatever this server's
   * switch says, so it waits for the same reasons it would with the switch
   * off: no machine with cards, an environment only this server has, the
   * trust, the image, the data.
   */
  if (homeOn && !(gpu && !homeCards)) return null
  if (live.length === 0) return homeOn ? 'no_gpu_runner' : 'no_runners'
  const revision = pinnedRevision(row.submissionId, revisionsSeen)
  if (!portableRevision(revision)) return 'home_only_env'
  let candidates = gpu || gpuRevision(revision) ? carded : [...live]
  if (candidates.length === 0) return 'no_gpu_runner'
  let sets = data.get(competition.id)
  if (!sets) {
    sets = dataNow(competition.id)
    data.set(competition.id, sets)
  }
  if (sets.hasSealed) {
    candidates = candidates.filter((runner) => runner.trusted)
    if (candidates.length === 0) return 'needs_trusted'
  }
  const imaged = candidates.filter((runner) => lastSync(runner.id)?.ready.revisions.includes(revision.id))
  if (imaged.length === 0) return 'preparing_image'
  const open = sets.open
  const sealed = sets.sealed
  const ready = imaged.some((runner) => {
    const sync = lastSync(runner.id)
    return open !== null && (sync?.ready.data.includes(open.manifest) ?? false) && (!sets.hasSealed || (sealed !== null && (sync?.ready.sealed.includes(sealed.manifest) ?? false)))
  })
  return ready ? null : 'preparing_data'
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
 * any other). Another course's competitions are one line of numbers.
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
      entry = { competitionId: visible ? row.competitionId : null, competition: visible ? competition.title : null, hidden: !visible, machines: [], scoring: 0 }
      out.set(key, entry)
    }
    if (visible) entry.scoring = metrics.get(row.competitionId) ?? 0
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
    cards: { recent: cards.recent, last: cards.last },
  }
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
