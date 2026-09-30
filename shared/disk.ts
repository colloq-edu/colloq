/**
 * Free space under the instance, as the panel shows it.
 *
 * One filesystem usually holds the database, notebook saves, uploads,
 * competition files and everything the students' code writes into the rooms,
 * and nothing gives a room a quota. A class that fills it stops notebook saves
 * in every room at once, and until now the only way to see that coming was ssh
 * and df. The Resources tab shows the numbers and warns at the thresholds
 * below; the server applies them (server/src/ops/disk.ts), so there is one copy
 * of the rule.
 */
export interface DiskSpace {
  /** What the server's user can still write (statfs bavail, not bfree). */
  freeBytes: number
  totalBytes: number
  /** Below either threshold: see diskLow. */
  low: boolean
}

export interface DiskUsage {
  /** The data directory's filesystem: the database, uploads, competition files. */
  data: DiskSpace
  /** The workspace's filesystem, or null when it is the same one as data's. */
  workspace: DiskSpace | null
}

/**
 * Two thresholds, whichever comes first. A share alone would stay silent on a
 * small disk until a single dataset upload fills it; a size alone would stay
 * silent on a large one until the last few percent, which a class filling it
 * with checkpoints burns through in an afternoon.
 */
export const DISK_LOW_FRACTION = 0.15
export const DISK_LOW_BYTES = 10 * 1024 ** 3

export function diskLow(freeBytes: number, totalBytes: number): boolean {
  if (!(totalBytes > 0) || !(freeBytes >= 0)) return false
  return freeBytes < DISK_LOW_BYTES || freeBytes < totalBytes * DISK_LOW_FRACTION
}
