import type Database from 'better-sqlite3'

export function stopsLocalKernelsOnExit(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COLLOQ_LOCAL_SESSION === '1' && env.COLLOQ_STOP_KERNELS_ON_EXIT === '1'
}

/** Database ownership is the boundary: never enumerate and remove all Docker rooms. */
export async function retireDatabaseKernels(database: Database.Database, stop: (id: string) => Promise<void>): Promise<void> {
  const sessions = database.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
  const results = await Promise.allSettled(sessions.map(({ id }) => stop(id)))
  const failures = results.flatMap((result, i) => result.status === 'rejected' ? [`${sessions[i].id}: ${String(result.reason)}`] : [])
  if (failures.length) throw new Error(`Could not retire local kernels: ${failures.join('; ')}`)
}
