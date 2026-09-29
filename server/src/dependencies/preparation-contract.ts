import { DEPENDENCY_LOG_CODES } from '@shared/dependencies'
import type { DependencyErrorParams, DependencyLogCode, DependencyLogEntry, DependencyLogLine, DependencyPackage, DependencyState, InstalledPackage } from '@shared/dependencies'

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
