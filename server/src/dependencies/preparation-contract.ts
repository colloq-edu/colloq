import { DEPENDENCY_LOG_CODES } from '@shared/dependencies'
import type { DependencyErrorParams, DependencyLogCode, DependencyLogEntry, DependencyLogLine, DependencyPackage, DependencyState, InstalledPackage } from '@shared/dependencies'
import { dependencySource } from '@shared/dependency-source'

export interface PreparationRequest {
  id: string
  imageDigest: string
  requirementsText: string
  basePackages: InstalledPackage[]
  /** Dedicated staging directory, under DATA_DIR; output wheels go in workDir/wheels. */
  workDir: string
  maxDownloadBytes: number
  maxInstalledBytes: number
  wallSeconds?: number
  signal: AbortSignal
  onProgress?: (update: PreparationProgress) => void
}
export interface PreparationProgress {
  state: Extract<DependencyState, 'resolving' | 'downloading' | 'verifying'>
  normalizedRequirements?: string[]
  downloadBytes?: number
  installedBytes?: number
  /** A step of our own program as a code, or raw diagnostic text nobody can translate. */
  log?: DependencyLogLine
}
export interface PreparationResult {
  normalizedRequirements: string[]
  packages: DependencyPackage[]
  downloadBytes: number
  installedBytes: number
  contentHash: string
  /** pip --require-hashes compatible, only additional packages. */
  lock: string
}
/**
 * The room a preparation phase works in, in bytes: the phase's own limit — the
 * downloads while resolving, the installed set while verifying — plus headroom
 * for pip's own files and the request.
 *
 * One rule for both backends, and the size is the point: pip 24 (the base's)
 * downloads every wheel of a --dry-run into its temporary directory, and the
 * verifier installs the set into this room, so a room that runs out means a
 * set that outgrew its limit, whatever the host has free
 * (preparation-python.ts · download_full, installed_full). The docker backend
 * makes it the container's /tmp (preparation.ts · profile). The broker makes it
 * the job's /work: its Pod's /tmp is at most 256 MiB for every kind of job
 * (runtime competition-jobs.ts), and a set of 300 MB installed could not even
 * be verified there.
 */
export function preparationRoomBytes(phase: 'resolve' | 'verify', request: Pick<PreparationRequest, 'maxDownloadBytes' | 'maxInstalledBytes'>): number {
  return (phase === 'resolve' ? request.maxDownloadBytes : request.maxInstalledBytes) + 96 * 1024 * 1024
}

export class DependencyPreparationError extends Error {
  /** What the failure measured, for its text (shared/dependencies.ts · DependencyErrorParams). */
  public readonly params?: DependencyErrorParams
  constructor(public readonly code: string, message: string, public readonly line?: number, options?: ErrorOptions & { params?: DependencyErrorParams }) {
    super(message, options)
    this.name = 'DependencyPreparationError'
    if (options?.params) this.params = options.params
  }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+!_-]{0,63}$/
const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._\-[\],<>=!~*+]{0,99}$/
const CAUSE = /^[a-z0-9][a-z0-9._-]{0,99} [A-Za-z0-9][A-Za-z0-9.+!_-]{0,63}$/
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const amount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)

/**
 * The details a preparation program reported, cut down to the fields and
 * shapes the texts use.
 *
 * The program reads package metadata from PyPI, which anyone can publish, so
 * everything is checked again on this side: whole byte counts, canonical
 * package names, versions and plain specifiers, and short lists — nothing a
 * page could be made to say beyond a name and a number.
 */
export function dependencyErrorParams(raw: unknown): DependencyErrorParams | undefined {
  const r = record(raw)
  if (!r) return undefined
  const params: DependencyErrorParams = {}
  if (amount(r.bytes) && amount(r.limitBytes)) {
    params.bytes = r.bytes
    params.limitBytes = r.limitBytes
    if (r.partial === true) params.partial = true
    const heaviest = (Array.isArray(r.heaviest) ? r.heaviest.slice(0, 3) : []).map(record)
      .filter((item): item is Record<string, unknown> => !!item && matches(item.name, NAME) && amount(item.bytes))
      .map(item => ({ name: item.name as string, bytes: item.bytes as number }))
    if (heaviest.length) params.heaviest = heaviest
  }
  if (matches(r.package, NAME)) {
    params.package = r.package
    if (matches(r.baseVersion, VERSION)) params.baseVersion = r.baseVersion
    if (matches(r.requirement, REQUIREMENT)) params.requirement = r.requirement
    if (matches(r.requiredBy, NAME) && matches(r.requiredByVersion, VERSION)) {
      params.requiredBy = r.requiredBy
      params.requiredByVersion = r.requiredByVersion
    }
    const causes = (Array.isArray(r.causes) ? r.causes.slice(0, 4) : []).map(record)
      .filter((item): item is Record<string, unknown> => !!item && matches(item.requirement, REQUIREMENT) && (item.by === null || matches(item.by, CAUSE)))
      .map(item => ({ by: item.by as string | null, requirement: item.requirement as string }))
    if (causes.length) params.causes = causes
  }
  return Object.keys(params).length ? params : undefined
}

/** The longest wheel address a manifest keeps; PyPI's are under 250 characters. */
const WHEEL_URL_MAX = 2048

/** The host:port pairs a wheel may come from under the settings in force; none when they cannot be read. */
function wheelHosts(): string[] {
  try {
    return dependencySource(process.env).files
  } catch {
    return []
  }
}

/**
 * Where a wheel was downloaded from, as the set's manifest keeps it, or
 * undefined.
 *
 * The program reads it off pip's report (download_info.url), which the index
 * wrote, so it is checked here once more the way the program checked it
 * before downloading (preparation-python.ts · safe_url): https, no
 * credentials and no fragment, a host the index's files may come from
 * (`files`, shared/dependency-source.ts), and the wheel's own file name at the
 * end of the path, which is where the program took that name from. A machine
 * that runs submissions for this server fetches the wheel from this address
 * and checks the sha256 and the size it arrives with, so wrong bytes cannot
 * come of it; but the fetch itself happens from inside that machine's
 * network, so an address that fails here is not kept at all. The set stays:
 * without an address the machine takes the wheel from this server instead.
 */
export function wheelUrl(raw: unknown, fileName: string, files: readonly string[] = wheelHosts()): string | undefined {
  if (typeof raw !== 'string' || raw.length > WHEEL_URL_MAX) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) return undefined
  if (!files.includes(`${url.hostname}:${url.port || 443}`)) return undefined
  let last: string
  try {
    last = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1))
  } catch {
    return undefined
  }
  return last === fileName ? url.href : undefined
}

/**
 * The wheels of a ready set as its manifest and its row keep them: the fields
 * of a package and nothing else a program put next to them — and no download
 * address. One function for both copies (files.ts · publishBundle, store.ts ·
 * completeBundle), so the two always say the same.
 *
 * No address, because both are read where the class can read: the set's
 * folder, manifest.json included, is mounted into the participant's own
 * container at /deps, and 0.22 hands the row's list out as it finds it, to
 * the participant's page and the teacher's overview. An institution's mirror
 * is not named to the class (service.ts · sanitizedLog keeps it out of the
 * log for the same reason). The addresses that pass wheelUrl are kept apart
 * (wheelUrls, store.ts · dependency_bundle_wheel_urls), for the machines that
 * run submissions alone.
 */
export function manifestPackages(packages: readonly DependencyPackage[]): DependencyPackage[] {
  return packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    fileName: pkg.fileName,
    sha256: pkg.sha256,
    bytes: pkg.bytes,
  }))
}

/**
 * Where each wheel of a ready set was downloaded from, for those whose
 * address passes wheelUrl, by the wheel's sha256: what a machine that runs
 * submissions fetches from the index's CDN and checks by that sha256 and the
 * size (store.ts · bundleWheels). A wheel without one is fetched from this
 * server instead.
 */
export function wheelUrls(packages: readonly DependencyPackage[], files: readonly string[] = wheelHosts()): Array<{ sha256: string; url: string }> {
  return packages.flatMap((pkg) => {
    const url = wheelUrl(pkg.url, pkg.fileName, files)
    return url ? [{ sha256: pkg.sha256, url }] : []
  })
}

/** A step the program reported, if it is one of ours; its parameters are short scalars only. */
export function dependencyLogEntry(raw: unknown): DependencyLogEntry | undefined {
  const r = record(raw)
  if (!r || !(DEPENDENCY_LOG_CODES as readonly unknown[]).includes(r.code)) return undefined
  const entry: DependencyLogEntry = { code: r.code as DependencyLogCode }
  const params = Object.entries(record(r.params) ?? {})
    .filter(([key, value]) => /^[a-z][A-Za-z]{0,19}$/.test(key) && (Number.isSafeInteger(value) || (typeof value === 'string' && value.length <= 100)))
    .slice(0, 8)
  if (params.length) entry.params = Object.fromEntries(params) as Record<string, string | number>
  return entry
}

/** The failure a preparation program reported, or null when it is not in a shape we accept. */
export function reportedPreparationError(raw: unknown): DependencyPreparationError | null {
  const r = record(raw)
  if (!r || typeof r.code !== 'string' || !/^[a-z_]{1,50}$/.test(r.code) || typeof r.message !== 'string' || r.message.length > 500) return null
  return new DependencyPreparationError(r.code, r.message, Number.isSafeInteger(r.line) ? Number(r.line) : undefined, { params: dependencyErrorParams(r.params) })
}
