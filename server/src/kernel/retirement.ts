/** A process-local gate held until a room's runtime and data have been removed.
 * The deployment runs one app replica; this is not a distributed lock. */
const retiring = new Map<string, number>()

export function kernelRetirementInProgress(id: string): boolean {
  return retiring.has(id)
}

export function blockKernelStarts(id: string): () => void {
  retiring.set(id, (retiring.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (retiring.get(id) ?? 1) - 1
    if (count > 0) retiring.set(id, count)
    else retiring.delete(id)
  }
}

/**
 * A narrower gate for the owner's "stop the kernel" (kernel/index.ts ·
 * stopKernelsByOwner): it refuses kernel and shell STARTS for the seconds the
 * stop takes, and nothing else.
 *
 * Not `blockKernelStarts`, which also shuts the room's door (the socket
 * upgrade and the join route read it) because a deleted room must not be
 * entered. A stopped kernel is not a deleted room: people stay in it, and a
 * student who reconnects in those seconds must get in. What must not happen
 * is a Run in the gap between "the containers are going" and `docker rm`:
 * it would start a fresh container that the stop then removes under it.
 *
 * Per container role, not per room: stopping only the personal notebooks
 * touches only their container, and a lecture's first Run or the shared
 * shell opening meanwhile has nothing to wait for. The whole class's stop
 * pauses both.
 */
type PausedRole = 'room' | 'own'

const paused = new Map<string, number>()
const pauseKey = (id: string, role: PausedRole): string => `${role}\u0000${id}`

export function kernelStartsPaused(id: string, role: PausedRole): boolean {
  return paused.has(pauseKey(id, role))
}

export function pauseKernelStarts(id: string, roles: readonly PausedRole[]): () => void {
  const keys = [...new Set(roles)].map((role) => pauseKey(id, role))
  for (const key of keys) paused.set(key, (paused.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    for (const key of keys) {
      const count = (paused.get(key) ?? 1) - 1
      if (count > 0) paused.set(key, count)
      else paused.delete(key)
    }
  }
}
