/**
 * What the machines should hold before the bell (§4.3): the images, the data
 * and the package sets of every competition they may soon be asked to run,
 * and what they may drop.
 *
 * WHICH COMPETITIONS. Those that take uploads now (on time or late), those
 * that open within REMOTE_PREFETCH_AHEAD_MS, those with notebooks waiting
 * (a draft's sample-notebook check among them), and those a machine holds a
 * lease of — and only where the image is portable: an environment revision
 * with a registry reference and a layer fingerprint (§4.4). A revision built
 * or edited on this server has neither, and its notebooks run here only
 * (`homeOnly`), whatever machines there are.
 *
 * IN WHICH ORDER. A machine fetches one stream at a time, in the order the
 * lists name things: competitions with waiting notebooks first, then open
 * ones, then upcoming ones. A class waiting on a 150 MB dataset is not kept
 * waiting by tomorrow's competition's.
 *
 * WHAT GATES A LEASE AND WHAT DOES NOT. The take (lease.ts) leases a row only
 * to a machine that reported its revision and its data manifests ready; a
 * package set never gates one, since a wheel the machine lacks comes from
 * the index's CDN in seconds, before the participant's clock starts.
 */
import {
  REMOTE_BUNDLES_MAX,
  REMOTE_BUNDLE_DETAILS_MAX,
  REMOTE_DATA_BYTES,
  REMOTE_DATA_FILES_MAX,
  REMOTE_DATA_NAME,
  REMOTE_IMAGE_REF,
  REMOTE_LOCK_CHARS,
  REMOTE_MANIFESTS_MAX,
  REMOTE_PREFETCH_AHEAD_MS,
  REMOTE_REVISIONS_MAX,
  REMOTE_SHA256,
  REMOTE_WHEELS_BYTES,
  REMOTE_WHEELS_MAX,
  REMOTE_WHEEL_NAME,
  remoteManifest,
  remoteWheelUrl,
  type RemoteDataFile,
  type RemoteSyncRequest,
  type RemoteWant,
  type RemoteWantBundle,
  type RemoteWantData,
  type RemoteWantRevision,
} from '@shared/remote-runner'
import { acceptsUploads, competitionPhase, submissionsOpen, type Competition } from '@shared/competitions'
import { packagesRoomMb, type EnvironmentRevision } from '@shared/dependencies'
import { bundleWheels, competitionRevision, getBinding, getBundle, getRevision, listBundles, lockOf } from '../../dependencies/store.js'
import { competitionFileHashes, fileHashesNow, listCompetitions, queueRows, type HashedFile } from '../store.js'
import { environmentNeedsGpu } from '../gpu.js'
import { sha256, type LeaseRow } from './store.js'

/* ------------------------------------------------------- what is portable */

/**
 * Whether machines can run a revision: its image is in a registry by digest
 * (REMOTE_IMAGE_REF — what the contract's parser takes, which is narrower
 * than what docker writes into RepoDigests) and its layers are fingerprinted.
 * Anything else is this server's alone (§4.4, decision 3).
 */
export function portableRevision(revision: EnvironmentRevision | null | undefined): revision is EnvironmentRevision & { registryRef: string; layers: string } {
  return !!revision && typeof revision.registryRef === 'string' && revision.registryRef.length <= 600 && REMOTE_IMAGE_REF.test(revision.registryRef)
    && typeof revision.layers === 'string' && REMOTE_SHA256.test(revision.layers)
}

/** Whether a revision is a GPU kernel: only machines with cards are asked for it, and it passes the smoke test there. */
export function gpuRevision(revision: Pick<EnvironmentRevision, 'environmentName'>): boolean {
  return environmentNeedsGpu(revision.environmentName)
}

/** A set of data files as a manifest names it (§3.3); `null` — a file is not hashed yet, or not one a machine may hold. */
export interface DataSet {
  manifest: string
  files: RemoteDataFile[]
}

/**
 * The manifest of a list of file rows, or `null` when any row lacks its
 * hash (the backfill has not reached it, or its file is gone), carries a
 * name the contract refuses, or the set is over its caps: such a set cannot
 * be described to a machine, and its competition is not leased until it can.
 */
export function dataSetOf(rows: readonly HashedFile[]): DataSet | null {
  if (rows.length > REMOTE_DATA_FILES_MAX) return null
  const files: RemoteDataFile[] = []
  let bytes = 0
  for (const row of rows) {
    if (row.sha256 === null || !REMOTE_DATA_NAME.test(row.name) || row.name.includes('..')) return null
    files.push({ name: row.name, sha256: row.sha256, bytes: row.bytes })
    bytes += row.bytes
  }
  if (bytes > REMOTE_DATA_BYTES) return null
  try {
    return { manifest: remoteManifest(files, sha256), files }
  } catch {
    return null
  }
}

/** A competition's open data and hidden test as the rows say them now, without reading the disk. */
export function dataNow(competitionId: string): { open: DataSet | null; sealed: DataSet | null; hasSealed: boolean } {
  const sealedRows = fileHashesNow(competitionId, 'sealed')
  return { open: dataSetOf(fileHashesNow(competitionId, 'open')), sealed: sealedRows.length ? dataSetOf(sealedRows) : null, hasSealed: sealedRows.length > 0 }
}

/* ------------------------------------------------------------ the stock */

/** One competition as the machines see it. */
export interface CompetitionStock {
  competition: Competition
  /** The fetch order: 0 — notebooks are waiting, 1 — it takes uploads, 2 — it opens within the day. */
  rank: number
  /** Its portable revisions: the competition's own and those its waiting notebooks are pinned to. */
  revisions: Array<EnvironmentRevision & { registryRef: string; layers: string }>
  /** Its current revision runs on this server only (no registry image). */
  homeOnly: boolean
  /** Its current revision's id, when it is portable: the image the panel's readiness reads. */
  currentRevisionId: string | null
  open: DataSet | null
  sealed: DataSet | null
  hasSealed: boolean
  /** Package sets to keep, most needed first: those of waiting notebooks, then each entrant's newest ready one. */
  bundles: string[]
}

const STOCK_TTL_MS = 2_000
let stock: { at: number; value: Map<string, CompetitionStock> } | null = null
let stocking: Promise<Map<string, CompetitionStock>> | null = null

/**
 * Every competition the machines should hold now, worked out at most every
 * two seconds and shared by every sync: ten machines asking within the same
 * second ask for the same picture. Hashing the data rows uploaded before
 * hashes existed reads their files once (store.ts · competitionFileHashes,
 * stat-cached), which is why this is asynchronous; the take itself reads the
 * rows only (dataNow).
 */
export function homeStock(now = Date.now()): Promise<Map<string, CompetitionStock>> {
  if (stock && now - stock.at < STOCK_TTL_MS) return Promise.resolve(stock.value)
  stocking ??= buildStock(now)
    .then((value) => {
      stock = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      stocking = null
    })
  return stocking
}

/** For tests, and after something the picture is made of changed in a way two seconds matter for. */
export function forgetStock(): void {
  stock = null
}

/**
 * The stock as last worked out, for the screens that cannot wait for it
 * (the console's queue snapshot is synchronous): a stale one starts a new
 * one behind the answer, and before the first there is none — the screen
 * says «готовится» for a second, never a reason made up.
 */
export function stockNow(now = Date.now()): ReadonlyMap<string, CompetitionStock> {
  if (!stock || now - stock.at >= STOCK_TTL_MS) void homeStock(now).catch(() => undefined)
  return stock?.value ?? new Map()
}

/*
 * A competition only a lease still holds (closed since, with a run out) is
 * not in the stock: its lease carries its own manifests, which every want of
 * that machine names first (runnerWant), and nothing new of it is fetched.
 */
async function buildStock(now: number): Promise<Map<string, CompetitionStock>> {
  const waitingNotebooks = new Map<string, string[]>()
  for (const row of queueRows()) {
    if (row.kind !== 'notebook' || row.state !== 'waiting') continue
    waitingNotebooks.set(row.competitionId, [...(waitingNotebooks.get(row.competitionId) ?? []), row.submissionId])
  }
  const out = new Map<string, CompetitionStock>()
  for (const competition of listCompetitions()) {
    const rank = rankOf(competition, waitingNotebooks.has(competition.id), now)
    if (rank === null) continue
    const current = competitionRevision(competition.id)
    const pinned = new Map<string, EnvironmentRevision & { registryRef: string; layers: string }>()
    if (portableRevision(current)) pinned.set(current.id, current)
    const bound = new Set<string>()
    for (const submissionId of waitingNotebooks.get(competition.id) ?? []) {
      const binding = getBinding(submissionId)
      if (portableRevision(binding?.revision)) pinned.set(binding.revision.id, binding.revision)
      if (binding?.bundle?.state === 'ready') bound.add(binding.bundle.id)
    }
    /*
     * A competition no machine can run (its environment is this server's
     * alone, and nothing waiting is pinned to a registry image) stays in the
     * stock, with no revision: no machine is asked for anything of it
     * (runnerWant names data only beside a revision the machine pulls), but
     * each machine's readiness says «только на этом сервере» for it — the
     * owner's one hint that the environment must be published before the
     * machines can help (views.ts · readinessFor, `home_only`).
     */
    // Backfill the hashes of rows uploaded before them; the rows are then read as they are.
    await competitionFileHashes(competition.id, 'open').catch(() => [])
    await competitionFileHashes(competition.id, 'sealed').catch(() => [])
    const data = dataNow(competition.id)
    const bundles = [...bound]
    const newest = new Set<string>()
    for (const bundle of listBundles(competition.id)) {
      if (bundle.state !== 'ready' || newest.has(bundle.entrantId)) continue
      newest.add(bundle.entrantId)
      if (!bound.has(bundle.id)) bundles.push(bundle.id)
    }
    out.set(competition.id, {
      competition,
      rank,
      revisions: [...pinned.values()],
      homeOnly: !portableRevision(current),
      currentRevisionId: portableRevision(current) ? current.id : null,
      open: data.open,
      sealed: data.sealed,
      hasSealed: data.hasSealed,
      bundles,
    })
  }
  return out
}

/** Where a competition stands in the fetch order; `null` — no machine needs it now. */
function rankOf(competition: Competition, waiting: boolean, now: number): number | null {
  if (waiting) return 0
  if (acceptsUploads(submissionsOpen(competition, now))) return 1
  if (competitionPhase(competition, now) === 'soon' && competition.startsAt !== null && competition.startsAt - now <= REMOTE_PREFETCH_AHEAD_MS) return 2
  return null
}

/* ------------------------------------------------------ one machine's want */

export interface RunnerWant {
  want: RemoteWant
  /** Competitions to drop: named in this machine's want before, wanted no longer, and with no lease of it out. */
  forget: string[]
  /** Competitions named in `want.data` now. */
  wanted: string[]
}

/**
 * What one machine should hold: the stock filtered by what it may take —
 * GPU kernels only with cards, the hidden test only when trusted (decision
 * 1) — and by the caps of the contract, plus everything its live leases
 * need, whatever the stock says. A set it has not reported ready comes with
 * its lock and wheels, at most REMOTE_BUNDLE_DETAILS_MAX of them, its
 * leases' first; one it has comes by id.
 */
export function runnerWant(input: {
  stock: ReadonlyMap<string, CompetitionStock>
  trusted: boolean
  cards: boolean
  sync: RemoteSyncRequest | null
  leases: readonly LeaseRow[]
  wantedBefore: ReadonlySet<string>
}): RunnerWant {
  const { trusted, cards, sync, leases } = input
  const ordered = [...input.stock.values()].sort((a, b) => a.rank - b.rank || a.competition.createdAt - b.competition.createdAt || (a.competition.id < b.competition.id ? -1 : 1))
  const revisions: RemoteWantRevision[] = []
  const revisionIds = new Set<string>()
  // `held`: a lease runs on it already, so it stays whether or not the machine has cards for it now.
  const addRevision = (revision: { id: string; ref: string; layers: string }, gpu: boolean, held = false): void => {
    if (revisionIds.has(revision.id) || revisions.length >= REMOTE_REVISIONS_MAX) return
    if (gpu && !cards && !held) return
    revisionIds.add(revision.id)
    revisions.push({ id: revision.id, ref: revision.ref, layers: revision.layers, gpu })
  }
  const data: RemoteWantData[] = []
  /*
   * One entry per competition and kind, never one per manifest: two
   * competitions with the very same files (one task for two groups, a
   * hidden-test copy of an open one) share a manifest, and each needs its
   * own entry — the machine keeps and forgets data per competition, and
   * a competition left out here would be forgotten under a lease of it.
   * The contract refuses only the same (competition, kind, manifest) twice
   * (shared/remote-runner.ts · wantOf).
   */
  const entries = new Set<string>()
  const addData = (competitionId: string, set: DataSet | null, sealed: boolean): void => {
    const key = set ? `${competitionId}:${sealed}:${set.manifest}` : ''
    if (!set || entries.has(key) || data.length >= REMOTE_MANIFESTS_MAX) return
    if (sealed && !trusted) return
    entries.add(key)
    data.push({ competitionId, manifest: set.manifest, sealed, files: set.files })
  }
  const bundleIds: string[] = []
  const bundleSet = new Set<string>()
  const addBundle = (id: string): void => {
    if (bundleSet.has(id) || bundleIds.length >= REMOTE_BUNDLES_MAX) return
    bundleSet.add(id)
    bundleIds.push(id)
  }

  // What the machine's live leases run with comes first: it must stay, whatever else is wanted.
  for (const lease of leases) {
    const pinned = getRevision(lease.manifest.revision.id)
    addRevision(lease.manifest.revision, pinned ? gpuRevision(pinned) : false, true)
    addData(lease.competitionId, lease.manifest.data, false)
    if (lease.manifest.sealed) addData(lease.competitionId, lease.manifest.sealed, true)
    if (lease.manifest.bundle) addBundle(lease.manifest.bundle.id)
  }
  for (const entry of ordered) {
    for (const revision of entry.revisions) addRevision({ id: revision.id, ref: revision.registryRef, layers: revision.layers }, gpuRevision(revision))
    // A competition whose image this machine cannot run is no data it needs (a GPU kernel on a machine without cards).
    if (!entry.revisions.some((revision) => revisionIds.has(revision.id))) continue
    addData(entry.competition.id, entry.open, false)
    if (entry.hasSealed) addData(entry.competition.id, entry.sealed, true)
    for (const id of entry.bundles) addBundle(id)
  }

  const readyBundles = new Set(sync?.ready.bundles ?? [])
  const leased = new Set(leases.flatMap((lease) => (lease.manifest.bundle ? [lease.manifest.bundle.id] : [])))
  const detailFirst = [...bundleIds].sort((a, b) => Number(leased.has(b)) - Number(leased.has(a)))
  const described = new Set<string>()
  for (const id of detailFirst) {
    if (described.size >= REMOTE_BUNDLE_DETAILS_MAX) break
    if (!readyBundles.has(id)) described.add(id)
  }
  const bundles: RemoteWantBundle[] = []
  for (const id of bundleIds) {
    const item = wantBundle(id, described.has(id))
    if (item) bundles.push(item)
  }

  const wanted = [...new Set(data.map((entry) => entry.competitionId))]
  const held = new Set(leases.map((lease) => lease.competitionId))
  // At most what one reply may name (REMOTE_MANIFESTS_MAX); the rest are named by the next replies.
  const forget = [...input.wantedBefore].filter((id) => !wanted.includes(id) && !held.has(id)).slice(0, REMOTE_MANIFESTS_MAX)
  return { want: { revisions, data, bundles }, forget, wanted }
}

/** A package set as `want` names it: by id with its room, and described in full (lock and wheels) when asked. */
function wantBundle(id: string, describe: boolean): RemoteWantBundle | null {
  const bundle = getBundle(id)
  if (!bundle || bundle.state !== 'ready') return null
  const packagesMb = packagesRoomMb(bundle.installedBytes)
  // The broker's own bounds for a set's room (shared/remote-runner.ts · packagesMb).
  if (packagesMb < 16 || packagesMb > 4096) return null
  if (!describe) return { id, packagesMb }
  const lock = lockOf(id)
  const wheels = bundleWheels(id)
  if (lock === null || wheels === null || lock.length > REMOTE_LOCK_CHARS || !/^[\x20-\x7E\n]*$/.test(lock) || wheels.length > REMOTE_WHEELS_MAX) return { id, packagesMb }
  let bytes = 0
  const out = []
  for (const wheel of wheels) {
    if (!REMOTE_WHEEL_NAME.test(wheel.fileName) || !REMOTE_SHA256.test(wheel.sha256) || !Number.isSafeInteger(wheel.bytes) || wheel.bytes < 0) return { id, packagesMb }
    bytes += wheel.bytes
    // An address the contract's rule drops is fetched from this server by its hash instead (remoteWheelUrl).
    const url = remoteWheelUrl(wheel.url)
    out.push({ fileName: wheel.fileName, sha256: wheel.sha256, bytes: wheel.bytes, ...(url ? { url } : {}) })
  }
  if (bytes > REMOTE_WHEELS_BYTES) return { id, packagesMb }
  return { id, packagesMb, lock, wheels: out }
}
