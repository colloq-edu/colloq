/**
 * How full the disks under the instance are: the data directory's filesystem
 * and, when it is a different one, the workspace's. For the Resources tab and
 * the staff operations endpoint; the thresholds are in @shared/disk.
 *
 * Asked on every read, never cached: the tab refreshes every fifteen seconds
 * precisely because a class can fill a disk within a period, and statfs costs
 * a syscall.
 */
import fs from 'node:fs'
import { config } from '../config.js'
import { diskLow, type DiskSpace, type DiskUsage } from '@shared/disk'

/** Free and total bytes of the filesystem under `directory`; throws when it cannot be measured. */
export function filesystemSpace(directory: string): DiskSpace {
  const found = fs.statfsSync(directory)
  const freeBytes = Number(found.bavail) * Number(found.bsize)
  const totalBytes = Number(found.blocks) * Number(found.bsize)
  return { freeBytes, totalBytes, low: diskLow(freeBytes, totalBytes) }
}

/** null when the data directory cannot be measured: a state to show, not a failed request. */
export function diskUsage(): DiskUsage | null {
  let data: DiskSpace
  try {
    data = filesystemSpace(config.dataDir)
  } catch {
    return null
  }
  let workspace: DiskSpace | null = null
  try {
    // One device, one filesystem: bind mounts of the same disk (k3s volumes,
    // the server image's state folder) show one bar, not two copies of it.
    if (fs.statSync(config.workspaceDir).dev !== fs.statSync(config.dataDir).dev) {
      workspace = filesystemSpace(config.workspaceDir)
    }
  } catch {
    // No workspace folder yet: nothing separate to show.
  }
  return { data, workspace }
}
