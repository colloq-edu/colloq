/** Final supervisor cleanup, including crashed servers; no notebook/workspace deletion. */
import { db, closeDatabase } from '../db.js'
import { retireDatabaseKernels } from '../local/kernel-cleanup.js'
import { dropLocalRoomKernel } from '../kernel/pool.js'

try {
  await retireDatabaseKernels(db, dropLocalRoomKernel)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  closeDatabase()
}
