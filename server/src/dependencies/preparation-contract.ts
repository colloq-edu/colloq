import type { DependencyPackage, DependencyState, InstalledPackage } from '@shared/dependencies'

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
  log?: string
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
  constructor(public readonly code: string, message: string, public readonly line?: number) {
    super(message)
    this.name = 'DependencyPreparationError'
  }
}
