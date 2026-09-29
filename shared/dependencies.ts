/** Public contracts for competition dependency management. No filesystem paths. */
import { formatNumber, tr } from './i18n.js'

export type DependencyState = 'queued' | 'resolving' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'cancelled'
export interface InstalledPackage { name: string; version: string }
export interface EnvironmentRevision {
  id: string
  environmentName: string
  imageDigest: string
  pythonVersion: string
  pythonAbi: string
  platform: string
  packages: InstalledPackage[]
  baseConstraintsHash: string
  createdAt: number
}
export interface DependencyPolicy {
  enabled: boolean
  maxDownloadBytes: number
  maxInstalledBytes: number
}
export interface DependencyPackage extends InstalledPackage {
  fileName: string
  sha256: string
  bytes: number
}
/** A package's share of a set that did not fit: the heaviest ones are named. */
export interface DependencySize { name: string; bytes: number }
/** Who asks for which version in a conflict pip could not resolve; `by` is null for the list itself. */
export interface DependencyConflictCause { by: string | null; requirement: string }
/**
 * What a failed preparation measured, so that its text can say more than its
 * code: "the set exceeds the limit" is meaningless for a single package, and
 * "versions conflict with the base" does not say which version the base has.
 *
 * Every field is optional. Errors stored before these existed have none, and
 * a reader then draws the plain text of the code, as it always did.
 */
export interface DependencyErrorParams {
  /** Size limits: what the set measured, and the limit it broke. */
  bytes?: number
  limitBytes?: number
  /** Preparation stopped before measuring all of the set: `bytes` is a lower bound. */
  partial?: boolean
  heaviest?: DependencySize[]
  /** Version conflicts: the package whose versions collide, and its version in the base. */
  package?: string
  baseVersion?: string
  /** A package of the set that requires another version of a base package, and what it requires. */
  requiredBy?: string
  requiredByVersion?: string
  requirement?: string
  /** A conflict inside the set: who requires which version of `package`. */
  causes?: DependencyConflictCause[]
}
export interface DependencyError { code: string; message: string; line?: number; params?: DependencyErrorParams }
/**
 * The steps of our own preparation program, kept as codes: the technical log
 * then reads in the language of whoever opens it, like the rest of the page.
 * A plain string is a line nobody can translate (Docker's own output, an
 * unexpected exception) and is shown as it is.
 */
export const DEPENDENCY_LOG_CODES = ['start', 'resolve', 'download', 'verify', 'verified'] as const
export type DependencyLogCode = typeof DEPENDENCY_LOG_CODES[number]
export interface DependencyLogEntry { code: DependencyLogCode; params?: Record<string, string | number> }
export type DependencyLogLine = string | DependencyLogEntry
export interface DependencyBundle {
  id: string
  number: number
  competitionId: string
  entrantId: string
  revisionId: string
  requirementsText: string
  normalizedRequirements: string[]
  state: DependencyState
  packages: DependencyPackage[]
  downloadBytes: number
  installedBytes: number
  contentHash: string | null
  error: DependencyError | null
  log: DependencyLogLine[]
  createdAt: number
  readyAt: number | null
}
export interface DependencyDraft { requirementsText: string; selectedBundleId: string | null }
export interface DependencyOverview {
  capabilities?: import('./capabilities.js').CompetitionCapabilities
  policy: DependencyPolicy
  revision: EnvironmentRevision | null
  draft: DependencyDraft
  bundles: DependencyBundle[]
  joined: boolean
}
export interface AdminDependencyOverview {
  capabilities?: import('./capabilities.js').CompetitionCapabilities
  policy: DependencyPolicy
  revision: EnvironmentRevision | null
  bundles: (DependencyBundle & { entrantName: string })[]
}
export interface SubmissionEnvironment {
  revisionId: string | null
  environmentName: string
  pythonVersion: string | null
  platform: string | null
  bundleId: string | null
  bundleNumber: number | null
  legacy: boolean
}
export const DEPENDENCY_LIMITS = {
  lines: 32,
  requestBytes: 8 * 1024,
  downloadBytes: 500 * 1024 * 1024,
  installedBytes: 512 * 1024 * 1024,
  wallSeconds: 600,
  perHour: 10,
  retainedUnusedDays: 30,
} as const
export const dependencyActive = (state: DependencyState): boolean =>
  state === 'queued' || state === 'resolving' || state === 'downloading' || state === 'verifying'

/** Match Python str.splitlines(), including imported Unicode separators. */
export function normalizeRequirements(text: string): string {
  return text.replace(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g, '\n')
}
/** Same meaningful-line rule in the editor, intake and isolated resolver. */
export function requirementLineCount(text: string): number {
  return normalizeRequirements(text).split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).length
}

/* ---------------------------------------------------------- what is said */

/**
 * Codes to texts, in one place for both readers: the server stores and
 * returns the text in the instance's language (server/src/dependencies/
 * messages.ts), and the browser draws the same text from the code and its
 * numbers in whatever language the page is in now.
 */
export const DEPENDENCY_ERROR_KEYS: Readonly<Record<string, string>> = {
  dependency_disabled: 'dependencies.disabled', dependency_limits: 'dependencies.limitError',
  dependency_empty: 'dependencies.error.empty', dependency_owner: 'dependencies.error.missing',
  dependency_revision: 'dependencies.error.revision', dependency_not_ready: 'dependencies.error.notReady',
  dependency_active: 'dependencies.error.active', dependency_quota: 'dependencies.error.quota',
  dependency_submission_active: 'competitions.refusal.inFlight', dependency_submission_quota: 'dependencies.error.submissionQuota',
  dependency_join: 'dependencies.error.join', dependency_closed: 'dependencies.error.closed',
  base_conflict: 'dependencies.error.conflict', dependency_conflict: 'dependencies.error.conflict',
  wheel_unavailable: 'dependencies.error.wheel', invalid_requirement: 'dependencies.error.syntax',
  unsupported_source: 'dependencies.error.source', package_not_found: 'dependencies.error.missingPackage',
  hash_mismatch: 'dependencies.error.integrity', download_limit: 'dependencies.error.size', installed_limit: 'dependencies.error.size',
  disk_full: 'dependencies.error.disk', network_error: 'dependencies.error.network', timeout: 'dependencies.error.timeout',
  cancelled: 'dependencies.error.cancelled', image_unpinned: 'dependencies.error.base', base_changed: 'dependencies.error.base',
  dependency_image: 'dependencies.error.base', worker_restarted: 'dependencies.error.restarted',
}

/**
 * Lighter builds of packages whose PyPI wheels outgrow a set, by name.
 *
 * A hint is a fact about PyPI, not about a screen, so it lives next to the
 * texts both readers share. It follows a size error when the package is among
 * the heaviest or was asked for by name. `xgboost` pulls `nvidia-nccl-cu12`
 * on Linux, and that is what outgrows the limit; `xgboost-cpu` is the same
 * library without CUDA. torch has no such twin on PyPI at all: its CPU-only
 * wheels live on download.pytorch.org, which the isolated resolver never
 * reaches (preparation-python.ts · the proxy's allowlist); torchvision and
 * torchaudio bring that same torch with them.
 */
export const DEPENDENCY_SIZE_HINTS: Readonly<Record<string, string>> = {
  xgboost: 'dependencies.hint.xgboost',
  torch: 'dependencies.hint.torch',
  torchvision: 'dependencies.hint.torch',
  torchaudio: 'dependencies.hint.torch',
}

const MiB = 1024 * 1024

/**
 * A package or set size, in the units of the limits themselves: they are set
 * in MiB (DEPENDENCY_LIMITS) and shown as "MB", like every other file size on
 * the competition pages. Gigabytes appear only for what never fits anyway.
 */
export function dependencySize(bytes: number): string {
  if (bytes < MiB) return tr('competitions.p.sizeKb', { size: formatNumber(Math.round(bytes / 1024)) })
  const mb = bytes / MiB
  if (mb >= 1024) return tr('competitions.p.sizeGb', { size: formatNumber(mb / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
  const digits = mb < 10 ? 1 : 0
  return tr('competitions.p.sizeMb', { size: formatNumber(mb, { minimumFractionDigits: digits, maximumFractionDigits: digits }) })
}

/** A set a hair over its limit must not read "500 MB with a limit of 500 MB". */
function measured(bytes: number, limit: number): { size: string; limit: string } {
  const size = dependencySize(bytes), shown = dependencySize(limit)
  if (size !== shown || bytes <= limit) return { size, limit: shown }
  const mb = Math.ceil((bytes / MiB) * 100) / 100
  return { size: tr('competitions.p.sizeMb', { size: formatNumber(mb, { maximumFractionDigits: 2 }) }), limit: shown }
}

/** Canonical names of the packages a list asks for, the way PyPI compares them. */
function requestedNames(requirementsText: string): string[] {
  return normalizeRequirements(requirementsText).split('\n')
    .map(line => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1])
    .filter((name): name is string => !!name)
    .map(name => name.toLowerCase().replace(/[-_.]+/g, '-'))
}

/**
 * The text of a failed preparation: its explanation first, then any hints.
 *
 * `requirementsText` is the set's own list, for hints about packages asked
 * for by name. A code without a text of its own (another version's, or an
 * infrastructure failure's) keeps the message stored with it.
 */
export function dependencyErrorLines(
  error: Pick<DependencyError, 'code'> & Partial<Pick<DependencyError, 'message' | 'params'>>,
  requirementsText = '',
): string[] {
  const key = Object.hasOwn(DEPENDENCY_ERROR_KEYS, error.code) ? DEPENDENCY_ERROR_KEYS[error.code] : null
  if (!key) return [error.message || tr('dependencies.error.generic')]
  const p = error.params ?? {}
  if (error.code === 'download_limit' || error.code === 'installed_limit') {
    const heaviest = p.heaviest ?? []
    let text = tr(key)
    if (p.bytes !== undefined && p.limitBytes !== undefined) {
      const kind = error.code === 'download_limit' ? 'downloadLimit' : 'installedLimit'
      text = tr(`dependencies.error.${kind}${p.partial ? 'AtLeast' : ''}`, measured(p.bytes, p.limitBytes))
      if (heaviest.length) {
        const list = heaviest.map(item => `${item.name} (${dependencySize(item.bytes)})`).join(', ')
        text += ' ' + tr('dependencies.error.heaviest', { count: heaviest.length, list })
      }
    }
    const names = new Set([...heaviest.map(item => item.name), ...requestedNames(requirementsText)])
    const hints = new Set(Object.keys(DEPENDENCY_SIZE_HINTS).filter(name => names.has(name)).map(name => DEPENDENCY_SIZE_HINTS[name]))
    return [text, ...[...hints].map(hint => tr(hint))]
  }
  if ((error.code === 'base_conflict' || error.code === 'dependency_conflict') && p.package) {
    if (p.baseVersion && p.requiredBy && p.requiredByVersion && p.requirement) {
      return [tr('dependencies.error.baseRequired', { parent: p.requiredBy, parentVersion: p.requiredByVersion, requirement: p.requirement, package: p.package, version: p.baseVersion })]
    }
    if (p.baseVersion) return [tr('dependencies.error.baseVersion', { package: p.package, version: p.baseVersion })]
    if (p.causes?.length) {
      const causes = p.causes.map(cause => `${cause.by ?? tr('dependencies.error.conflictList')} — ${cause.requirement}`).join('; ')
      return [tr('dependencies.error.conflictCauses', { package: p.package, causes })]
    }
  }
  return [tr(key)]
}

export function dependencyErrorText(error: Parameters<typeof dependencyErrorLines>[0], requirementsText = ''): string {
  return dependencyErrorLines(error, requirementsText).join(' ')
}

/** One line of the technical log, in the reader's language when it is one of our steps. */
export function dependencyLogText(line: DependencyLogLine): string {
  if (typeof line === 'string') return line
  return (DEPENDENCY_LOG_CODES as readonly string[]).includes(line.code) ? tr(`dependencies.log.${line.code}`, line.params) : ''
}
