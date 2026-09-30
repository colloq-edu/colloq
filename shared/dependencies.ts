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
  /** The hour's preparations spent: whole minutes until the next one is possible. */
  waitMinutes?: number
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
/**
 * The hour's preparations (DEPENDENCY_LIMITS.perHour) as the refusal counts
 * them: every set the entrant started within the last hour, in any
 * competition and whatever became of it (server/src/dependencies/store.ts ·
 * preparationQuota). Shown next to the button: the eleventh preparation used
 * to be the first place the limit was mentioned at all.
 */
export interface DependencyQuota {
  left: number
  /** When the next preparation becomes possible, while none is left; null otherwise. */
  nextAt: number | null
}
export interface DependencyOverview {
  capabilities?: import('./capabilities.js').CompetitionCapabilities
  policy: DependencyPolicy
  revision: EnvironmentRevision | null
  draft: DependencyDraft
  bundles: DependencyBundle[]
  joined: boolean
  quota: DependencyQuota
  /** The memory one submission gets: a set's room counts in it (`packagesFit`). */
  memoryMb?: number
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

/**
 * The room a ready set gets inside a submission, in MiB.
 *
 * The set is installed at the start of every run into memory-backed storage
 * of its own (runner-port.ts · RunRequest.packagesMb): the container's root
 * is read-only, and nothing a participant's container writes may reach the
 * host disk. `installedBytes` is what the set's files weighed when it was
 * prepared; the filesystem rounds every file up to a page and the environment
 * itself takes a little, hence a tenth and a fixed margin on top. A ceiling,
 * not a reservation: memory goes only to what is actually written.
 */
export function packagesRoomMb(installedBytes: number): number {
  const bytes = Number.isFinite(installedBytes) && installedBytes > 0 ? installedBytes : 0
  return Math.ceil((bytes * 1.1) / (1024 * 1024)) + 32
}

/**
 * Whether a set may ride with a submission of `memoryMb`.
 *
 * Its room counts in the submission's memory — a tmpfs page cannot be swapped
 * out — so a set may take at most half of it, and the rest is the kernel's,
 * the data's and the working folder's. A set over that is refused when it is
 * chosen, with the numbers, not inside the run as a failed install.
 */
export function packagesFit(installedBytes: number, memoryMb: number): boolean {
  return packagesRoomMb(installedBytes) * 2 <= memoryMb
}

/** What a set that does not fit is explained with (`dependency_memory`): its room against the memory. */
export function packagesMemoryParams(installedBytes: number, memoryMb: number): DependencyErrorParams {
  return { bytes: packagesRoomMb(installedBytes) * 1024 * 1024, limitBytes: memoryMb * 1024 * 1024 }
}

/** Match Python str.splitlines(), including imported Unicode separators. */
export function normalizeRequirements(text: string): string {
  return text.replace(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g, '\n')
}
/** Same meaningful-line rule in the editor, intake and isolated resolver. */
export function requirementLineCount(text: string): number {
  return normalizeRequirements(text).split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).length
}

// pip's comment (pip/_internal/req/req_file.py · COMMENT_RE): a `#` at the start of a line or after whitespace.
const COMMENT = /(?:^|\s)#/

/**
 * A requirement line without its trailing comment and the whitespace before it.
 *
 * `numpy==1.26  # for the metric` is good pip, which drops the note before it
 * reads the line; the parser, reading PEP 508 alone, refused it as malformed
 * (invalid_requirement) and sent people to look for a typo in a line pip
 * takes. A `#` inside a word stays: it is a URL's fragment
 * (`…/repo.git#egg=pkg`) or a typo, never a note. A comment line comes out
 * empty.
 *
 * The preparation program cuts the same comment (preparation-python.ts ·
 * without_comment); the two must stay in step.
 */
export function requirementWithoutComment(line: string): string {
  const at = line.search(COMMENT)
  return at < 0 ? line : line.slice(0, at).trimEnd()
}

// Quoted marker values: a marker may compare against any string, slashes and dashes included.
const QUOTED = /"[^"]*"|'[^']*'/g
// pip's own archive extensions (pip/_internal/utils/filetypes.py): a line ending in one is a file to pip, never a name.
const ARCHIVE = /\.(?:whl|zip|tar|tar\.gz|tgz|tar\.bz2|tbz|tar\.xz|txz|tlz|tar\.lz|tar\.lzma)$/i

/**
 * Whether a requirement line asks for something other than a package on PyPI.
 *
 * pip takes far more than PEP 508 from a requirements line: URLs
 * (`git+https://…`, `file:///…`, `https://…/x.whl`), local paths and
 * archives, and its own options, even after a name on the same line
 * (`torch --index-url …`, `numpy --hash=sha256:…`). PEP 508 has no words for
 * most of these, so the parser called them malformed and sent people to look
 * for a typo in a line that is good pip, just nothing the isolated resolver
 * can reach: its proxy admits PyPI only (preparation-python.ts · ALLOWED).
 *
 * A trailing comment is not asked about: a URL or an option in a note is
 * only words (`requirementWithoutComment`).
 *
 * The preparation program asks the same question (preparation-python.ts ·
 * unsupported_source); the two must stay in step.
 */
export function requirementSourceUnsupported(line: string): boolean {
  const value = requirementWithoutComment(line).trim()
  if (/^[-./~]/.test(value) || value.includes('\\') || value.includes('\0')) return true
  const bare = value.replace(QUOTED, '""')
  if (/[/@]|\s-/.test(bare) || /^(?:file:|(?:git|hg|svn|bzr)\+)/i.test(bare)) return true
  return ARCHIVE.test(bare.split(';', 1)[0].trim().replace(/\[[^\]]*\]$/, ''))
}

/**
 * The number of the first line that is not a PyPI requirement, or null.
 * Every line is counted, blank and comment ones too, the way the preparation
 * program numbers them.
 */
export function unsupportedRequirementLine(text: string): number | null {
  const lines = normalizeRequirements(text).split('\n')
  for (let index = 0; index < lines.length; index++) {
    const value = requirementWithoutComment(lines[index]).trim()
    if (value && requirementSourceUnsupported(value)) return index + 1
  }
  return null
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
  dependency_memory: 'dependencies.error.memory',
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

/**
 * Packages that install from PyPI but cannot run where notebooks are checked,
 * by name.
 *
 * Unlike a size hint, these follow no failure: the set prepares fine, and the
 * trouble shows only in the run, a spent submission later. So the hint is on
 * the ready set's card, and the set is not refused: the fact is about the
 * checking image, not about the package. tinygrad's CPU backends compile
 * every operation with a C compiler or LLVM, the checking image has neither,
 * and the first tensor dies with "RuntimeError: no usable devices"; its
 * pure-Python backend needs no compiler but is far too slow for a run.
 */
export const DEPENDENCY_READY_HINTS: Readonly<Record<string, string>> = {
  tinygrad: 'dependencies.hint.tinygrad',
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

/** A package name the way PyPI compares them: case and runs of `-_.` do not count. */
const canonicalName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

/** Canonical names of the packages a list asks for. */
function requestedNames(requirementsText: string): string[] {
  return normalizeRequirements(requirementsText).split('\n')
    .map(line => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1])
    .filter((name): name is string => !!name)
    .map(canonicalName)
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
  if (error.code === 'dependency_memory' && p.bytes !== undefined && p.limitBytes !== undefined) {
    // bytes: the set's room; limitBytes: the memory a submission gets.
    return [tr('dependencies.error.memorySize', { size: dependencySize(p.bytes), memory: dependencySize(p.limitBytes) })]
  }
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
  if (error.code === 'dependency_quota' && p.waitMinutes !== undefined) {
    return [tr('dependencies.error.quotaWait', { minutes: p.waitMinutes })]
  }
  return [tr(key)]
}

export function dependencyErrorText(error: Parameters<typeof dependencyErrorLines>[0], requirementsText = ''): string {
  return dependencyErrorLines(error, requirementsText).join(' ')
}

/**
 * Whole minutes until the next preparation, and never "0 min": at the moment
 * this is said the preparation is not possible yet, so the last minute counts.
 */
export function quotaWaitMinutes(nextAt: number, now: number): number {
  return Math.max(1, Math.ceil((nextAt - now) / 60_000))
}

/** The line next to the button: what the hour leaves, or when the next preparation is possible. */
export function dependencyQuotaText(quota: DependencyQuota, now: number): string {
  if (quota.left > 0 || quota.nextAt === null) return tr('dependencies.quotaLeft', { left: quota.left })
  return tr('dependencies.error.quotaWait', { minutes: quotaWaitMinutes(quota.nextAt, now) })
}

/**
 * What a ready set's card says about packages in it that the checking image
 * cannot run (DEPENDENCY_READY_HINTS): asked for by name or pulled in by
 * another package, the run fails the same.
 */
export function dependencyReadyHints(bundle: Pick<DependencyBundle, 'requirementsText' | 'packages'>): string[] {
  const names = new Set([...requestedNames(bundle.requirementsText), ...bundle.packages.map(item => canonicalName(item.name))])
  const keys = new Set(Object.keys(DEPENDENCY_READY_HINTS).filter(name => names.has(name)).map(name => DEPENDENCY_READY_HINTS[name]))
  return [...keys].map(key => tr(key))
}

/** One line of the technical log, in the reader's language when it is one of our steps. */
export function dependencyLogText(line: DependencyLogLine): string {
  if (typeof line === 'string') return line
  return (DEPENDENCY_LOG_CODES as readonly string[]).includes(line.code) ? tr(`dependencies.log.${line.code}`, line.params) : ''
}
