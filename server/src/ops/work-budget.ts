/** Promises not yet represented by the physical census. One server owns this
 * local queue; Kubernetes continues to own production Pod admission. */
export interface WorkReservation {
  id: string
  kind: 'competition' | 'preparation' | 'kernel'
  memoryMb: number
  diskBytes: number
  /** Kernel memory is the target allocation, credited against its census row. */
  allocationKey?: string
}
export interface WorkLease {
  (): void
  /** Keep a successful mutation reserved until the census sees its allocation. */
  settle(): void
}
const held = new Map<string, WorkReservation>()
const settled = new Map<string, bigint>()
let observedMemory = new Map<string, number>()
let observedComplete = false

function unobservedMb(work: WorkReservation): number {
  return Math.max(0, work.memoryMb - (work.allocationKey ? observedMemory.get(work.allocationKey) ?? 0 : 0))
}

export function observedWorkMemory(key: string): number | null { return observedComplete ? observedMemory.get(key) ?? 0 : null }
export function hasWorkAllocation(key: string): boolean { return [...held.values()].some(work => work.allocationKey === key) }

/** Called only with the complete allocation census, never its UI page. */
export function observeWorkMemory(allocations: Map<string, number> | null, censusStartedAt = process.hrtime.bigint()): void {
  observedComplete = allocations !== null
  if (!allocations) return
  observedMemory = new Map(allocations)
  for (const [id, work] of held) {
    const finishedAt = settled.get(id)
    // A stopped row from before docker start completed cannot free its new
    // promise. A later stopped row confirms that the admitted process exited.
    const stoppedAfterMutation = finishedAt !== undefined && censusStartedAt > finishedAt
      && work.allocationKey !== undefined && observedMemory.get(work.allocationKey) === 0
    if (finishedAt !== undefined && work.allocationKey && observedMemory.has(work.allocationKey)
      && (unobservedMb(work) === 0 || stoppedAfterMutation)) {
      held.delete(id)
      settled.delete(id)
    }
  }
}

/** Successful deletion ends any reservation left by an interrupted startup. */
export function releaseWorkAllocation(key: string): void {
  observedMemory.delete(key)
  for (const [id, work] of held) if (work.allocationKey === key) { held.delete(id); settled.delete(id) }
}

export function workBudgetSnapshot() {
  let memoryMb = 0, diskBytes = 0
  const byKind = { competition: 0, preparation: 0, kernel: 0 }
  for (const work of held.values()) { memoryMb += unobservedMb(work); diskBytes += work.diskBytes; byKind[work.kind]++ }
  return { memoryMb, diskBytes, jobs: held.size, byKind }
}

/** Capacity excludes reservations; subtract them exactly once, atomically. */
export function reserveWork(work: WorkReservation, capacity: { availableMemoryMb?: number | null; availableDiskBytes?: number | null }): WorkLease | null {
  if (!work.id || ![work.memoryMb, work.diskBytes].every(v => Number.isSafeInteger(v) && v >= 0)
    || (work.allocationKey !== undefined && (work.kind !== 'kernel' || !work.allocationKey))) throw new Error('Invalid work reservation')
  if (held.has(work.id) || (work.allocationKey && [...held.values()].some(other => other.allocationKey === work.allocationKey))) return null
  const reserved = workBudgetSnapshot()
  if (capacity.availableMemoryMb != null && unobservedMb(work) + reserved.memoryMb > capacity.availableMemoryMb) return null
  if (capacity.availableDiskBytes != null && work.diskBytes + reserved.diskBytes > capacity.availableDiskBytes) return null
  const stored = { ...work }
  held.set(work.id, stored)
  const release = (() => {
    // A late finally from an older attempt must not release a replacement.
    if (held.get(work.id) === stored) { held.delete(work.id); settled.delete(work.id) }
  }) as WorkLease
  release.settle = () => {
    if (held.get(work.id) !== stored) return
    settled.set(work.id, process.hrtime.bigint())
    if (observedComplete && work.allocationKey && observedMemory.has(work.allocationKey) && unobservedMb(work) === 0) release()
  }
  return release
}
