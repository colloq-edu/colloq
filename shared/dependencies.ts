/** Public contracts for competition dependency management. No filesystem paths. */
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
export interface DependencyError { code: string; message: string; line?: number }
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
  log: string[]
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
