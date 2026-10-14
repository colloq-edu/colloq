/**
 * Whether a machine can run a waiting notebook (§5.2's skip rules): ONE
 * predicate, asked by the take (lease.ts · takeForRunner) and by the reasons
 * a row waits (views.ts · waitReasons, which the forecast and both screens
 * read).
 *
 * TWO COPIES DRIFTED THE WAY THAT HURTS. The take skipped a row for its
 * memory, its CPUs, its package set, its limits or a notebook gone from
 * disk, while the wait reasons knew only the image, the data, the trust and
 * the cards. A row no live machine could ever fit — two CPUs on a two-vCPU
 * machine, 32 GB on a 32 GB VM — then got a place and an ETA from the
 * fleet's places and never showed «готовится», while the take passed it over
 * for ever: a participant waiting on a promise nothing would keep. So both
 * ask the same two questions, here, in the same order:
 *
 *   1. the row itself (rowNeeds) — its competition is there, its revision
 *      is in a registry, its limits are ones the contract carries, its
 *      package set fits its memory and has a room a lease can name, its
 *      notebook is on disk within its cap: nothing any machine changes;
 *   2. the row on one machine (machineFit) — a card share when it needs one
 *      (and a card at all for a GPU image), the trust for a hidden test, the
 *      room for its memory, CPUs and disk, its image in place, its data in
 *      place.
 *
 * The take asks (2) against what the machine has left NOW and leases the
 * first row that fits; the wait reasons ask it against what the machine has
 * AT ALL — its room with its runs ended — and a row no live machine can ever
 * fit waits as `no_fit`, with no place. The order of (2) is the order a
 * machine gets nearer to running a row, so across machines the furthest
 * refusal is the reason that matters (views.ts · blockedBy). Never a write.
 *
 * A module of its own that reaches neither the queue's pump (runner.ts) nor
 * the router: the views, which the forecast and the participant's page
 * read, import it.
 */
import path from 'node:path'
import { packagesFit, packagesRoomMb, type DependencyBundle, type EnvironmentRevision } from '@shared/dependencies'
import type { Competition } from '@shared/competitions'
import {
  REMOTE_ATTEMPT_DISK_MB,
  REMOTE_CONTAINER_CUSHION_MB,
  REMOTE_NOTEBOOK_BYTES,
  type RemoteStepLimits,
} from '@shared/remote-runner'
import { getBinding, getBundle, getRevision } from '../../dependencies/store.js'
import { limitsFor } from '../runner-port.js'
import { competitionsFs, inputDir, NOTEBOOK_FILE } from '../storage.js'
import { getCompetition } from '../store.js'
import { sha256 } from './store.js'
import { dataNow, gpuRevision, portableRevision, type DataSet } from './want.js'

/* ------------------------------------------------------------ the claim */

/** What a run claims of its machine: the memory docker gives the container and its cushion, and its CPUs. */
export function stepClaim(limits: Pick<RemoteStepLimits, 'memoryMb' | 'cpus'>): { memoryMb: number; cpus: number } {
  return { memoryMb: limits.memoryMb + REMOTE_CONTAINER_CUSHION_MB, cpus: limits.cpus }
}

/** The step's limits as the contract bounds them (shared/remote-runner.ts · limitsOf); anything else runs here only. */
export function contractLimits(limits: RemoteStepLimits): boolean {
  const within = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max
  return within(limits.wallSeconds, 1, 4 * 60 * 60) && within(limits.memoryMb, 128, 65536) && within(limits.cpus, 1, 32) && within(limits.pids, 16, 2048)
    && within(limits.fsizeBytes, 1, 1024 ** 3) && within(limits.tmpfsMb, 16, 4096) && within(limits.targetBytes, 1, 64 * 1024 * 1024)
    && within(limits.outputBytes, 0, 1024 ** 3) && within(limits.outputKillBytes, 0, 1024 ** 3)
}

/* ------------------------------------------------------------- the row */

/** A submitted notebook's sha256 and size, read once: a submission's notebook is written at upload and never again. */
const notebooks = new Map<string, { sha256: string; bytes: number } | null>()

export function notebookOf(competitionId: string, submissionId: string): { sha256: string; bytes: number } | null {
  if (notebooks.has(submissionId)) return notebooks.get(submissionId)!
  let found: { sha256: string; bytes: number } | null = null
  try {
    const body = competitionsFs.readFileSync(path.join(inputDir(competitionId, submissionId), NOTEBOOK_FILE)) as Buffer
    if (body.length >= 1 && body.length <= REMOTE_NOTEBOOK_BYTES) found = { sha256: sha256(body), bytes: body.length }
  } catch {
    found = null
  }
  if (notebooks.size >= 4096) notebooks.delete(notebooks.keys().next().value!)
  notebooks.set(submissionId, found)
  return found
}

/*
 * A submission's pin and set are written once (dependencies/store.ts ·
 * bindSubmission refuses to change them), so which revision and which set it
 * names is remembered here: the wait reasons ask about every waiting row on
 * every participant's poll. The revision and the set themselves are read
 * once per pass (FitCache): a registry reference is what a backfill may still
 * add to a revision. A submission with no pin yet is not remembered — it may
 * get one.
 */
const pins = new Map<string, { revisionId: string | null; bundleId: string | null }>()

function pinOf(submissionId: string): { revisionId: string | null; bundleId: string | null } | null {
  const known = pins.get(submissionId)
  if (known) return known
  const binding = getBinding(submissionId)
  if (!binding) return null
  const pin = { revisionId: binding.revision?.id ?? null, bundleId: binding.bundle?.id ?? null }
  if (pins.size >= 10_000) pins.delete(pins.keys().next().value!)
  pins.set(submissionId, pin)
  return pin
}

/** What one pass of the take or of the wait reasons reads once and asks about many rows. */
export interface FitCache {
  competitions: Map<string, CompetitionNeeds | null>
  revisions: Map<string, EnvironmentRevision | null>
  bundles: Map<string, DependencyBundle | null>
}

export function fitCache(): FitCache {
  return { competitions: new Map(), revisions: new Map(), bundles: new Map() }
}

/** One competition as every waiting row of it needs it. */
interface CompetitionNeeds {
  competition: Competition
  limits: RemoteStepLimits
  claim: { memoryMb: number; cpus: number }
  gpu: boolean
  open: DataSet | null
  sealed: DataSet | null
  hasSealed: boolean
}

function competitionNeeds(competitionId: string, cache: FitCache): CompetitionNeeds | null {
  if (cache.competitions.has(competitionId)) return cache.competitions.get(competitionId)!
  const competition = getCompetition(competitionId)
  let needs: CompetitionNeeds | null = null
  if (competition) {
    const limits = limitsFor(competition, 'notebook')
    const sets = dataNow(competition.id)
    needs = { competition, limits, claim: stepClaim(limits), gpu: competition.limits.gpu === true, open: sets.open, sealed: sets.sealed, hasSealed: sets.hasSealed }
  }
  cache.competitions.set(competitionId, needs)
  return needs
}

/** What a waiting row needs of any machine, everything its lease will carry. */
export interface RowNeeds extends CompetitionNeeds {
  revision: EnvironmentRevision & { registryRef: string; layers: string }
  /** A GPU kernel: only a machine with cards is asked for it (want.ts), whether or not the competition takes a card. */
  gpuImage: boolean
  bundle: { id: string; packagesMb: number } | null
  notebook: { sha256: string; bytes: number }
}

/**
 * Why a row cannot run on any machine, whatever the machine: `gone` — its
 * competition is; `home_only` — its revision has no registry image (built or
 * edited here, or a legacy row with no pin); `limits` — its step's limits
 * are outside what the contract carries; `unfit` — its package set cannot
 * fit its memory, which this server settles with the refusal itself
 * (liveness.ts · settleUnfit, or its own pump); `bundle` — its set's room is
 * outside what a lease names; `notebook` — the notebook is gone from disk,
 * or over its cap.
 */
export type RowRefusal = 'gone' | 'home_only' | 'limits' | 'unfit' | 'bundle' | 'notebook'

/*
 * THE TWO QUESTIONS THE PUMP'S SIDE ASKS TOO (runner.ts, forecast.ts), here
 * so that they are asked one way: whether this server's own pump takes a
 * notebook at all, and whether a row's package set can never ride with its
 * memory — which no executor runs, and which this server settles itself with
 * the refusal (liveness.ts · settleUnfit, runner.ts · unfitOutcome).
 */

/**
 * Whether this server's own pump takes a waiting notebook (§5.3): its
 * notebooks are on («Тетради на этом сервере»), and a GPU notebook only where
 * it has cards for submissions (its own, or the cluster's under the broker).
 * Otherwise only the machines run it, whatever the switch says.
 */
export function homeTakes(input: { gpu: boolean; homeNotebooks: boolean; homeCards: boolean }): boolean {
  return input.homeNotebooks && !(input.gpu && !input.homeCards)
}

/** Whether a set cannot ride with a submission of the competition's memory (packagesFit): the refusal settled before any container. */
export function setUnfit(set: { installedBytes: number } | null | undefined, competition: { limits: { memoryMb: number } }): boolean {
  return !!set && !packagesFit(set.installedBytes, competition.limits.memoryMb)
}

/** Whether a waiting row's own package set can never ride with its competition's memory (setUnfit), read through a pass's cache. */
export function rowSetUnfit(row: { competitionId: string; submissionId: string }, cache: FitCache = fitCache()): boolean {
  const base = competitionNeeds(row.competitionId, cache)
  const pin = pinOf(row.submissionId)
  const set = pin?.bundleId ? read(cache.bundles, pin.bundleId, getBundle) : null
  return base !== null && setUnfit(set, base.competition)
}

/** Whether a waiting row is a GPU notebook (its competition's card is on), read through a pass's cache: what homeTakes is asked about. */
export function rowNeedsCard(row: { competitionId: string }, cache: FitCache = fitCache()): boolean {
  return competitionNeeds(row.competitionId, cache)?.gpu === true
}

export function rowNeeds(row: { competitionId: string; submissionId: string }, cache: FitCache): { ok: true; needs: RowNeeds } | { ok: false; why: RowRefusal } {
  const base = competitionNeeds(row.competitionId, cache)
  if (!base) return { ok: false, why: 'gone' }
  const pin = pinOf(row.submissionId)
  const revision = pin?.revisionId ? read(cache.revisions, pin.revisionId, getRevision) : null
  // Built or edited on this server, or a legacy submission with no pin: only this server runs it.
  if (!portableRevision(revision)) return { ok: false, why: 'home_only' }
  if (!contractLimits(base.limits)) return { ok: false, why: 'limits' }
  const set = pin?.bundleId ? read(cache.bundles, pin.bundleId, getBundle) : null
  // A set that cannot fit is refused before any container, by this server; one whose room the contract cannot carry runs here.
  if (set && (set.state !== 'ready' || setUnfit(set, base.competition))) return { ok: false, why: 'unfit' }
  const packagesMb = set ? packagesRoomMb(set.installedBytes) : 0
  if (set && (packagesMb < 16 || packagesMb > 4096)) return { ok: false, why: 'bundle' }
  const notebook = notebookOf(base.competition.id, row.submissionId)
  if (!notebook) return { ok: false, why: 'notebook' }
  return {
    ok: true,
    needs: { ...base, revision, gpuImage: gpuRevision(revision), bundle: set ? { id: set.id, packagesMb } : null, notebook },
  }
}

function read<T>(cache: Map<string, T | null>, id: string, fetch: (id: string) => T | null): T | null {
  if (!cache.has(id)) cache.set(id, fetch(id))
  return cache.get(id) ?? null
}

/* --------------------------------------------------------- the machine */

/** A machine as the predicate judges it: what it has in place, whether it may hold the hidden test, its cards, and the room it is judged against. */
export interface FitMachine {
  ready: { revisions: ReadonlySet<string>; data: ReadonlySet<string>; sealed: ReadonlySet<string> }
  trusted: boolean
  /** It has cards at all: a GPU kernel is pulled only where there are (want.ts · runnerWant). */
  cards: boolean
  /** What is left now (the take), or all it has (the wait reasons). */
  room: { memoryMb: number; cpus: number; gpuShares: number; diskMb: number }
}

/**
 * Why this machine cannot run the row, in the order a machine gets nearer
 * to running it: `card` — it needs a share of a card and none is left (or
 * a GPU kernel, and the machine has no card at all); `trusted` — it reads
 * the hidden test and the machine is not trusted (decision 1); `room` — its
 * memory and cushion, its CPUs or its disk are more than the machine has;
 * `image` — its revision is not pulled and verified there; `data` — its open
 * data, or its hidden test, is not complete there. `null` — it can.
 */
export type MachineRefusal = 'card' | 'trusted' | 'room' | 'image' | 'data'

export function machineFit(needs: RowNeeds, machine: FitMachine): MachineRefusal | null {
  if ((needs.gpu && machine.room.gpuShares < 1) || (needs.gpuImage && !machine.cards)) return 'card'
  if (needs.hasSealed && !machine.trusted) return 'trusted'
  if (needs.claim.memoryMb > machine.room.memoryMb || needs.claim.cpus > machine.room.cpus || machine.room.diskMb < REMOTE_ATTEMPT_DISK_MB) return 'room'
  if (!machine.ready.revisions.has(needs.revision.id)) return 'image'
  if (!needs.open || !machine.ready.data.has(needs.open.manifest)) return 'data'
  // The hidden test only once its manifest is complete there.
  if (needs.hasSealed && (!needs.sealed || !machine.ready.sealed.has(needs.sealed.manifest))) return 'data'
  return null
}
