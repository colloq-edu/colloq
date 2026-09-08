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
