/**
 * The held `sync` calls of the machines, woken on news (§3.4 "answered early
 * on news").
 *
 * A machine keeps one long-poll open, and home answers it the moment there
 * is something to say: a new upload it could take (runner.ts ·
 * wakeCompetitionPump wakes every machine, as it wakes the pump), a cancel of
 * its run, a revoke, a change of what it should hold. Without the wake a
 * cancelled run would go on for up to ten seconds of a held sync, and a new
 * submission would wait up to twenty-five for an idle machine to ask again.
 *
 * A module of its own that imports nothing, on purpose: the pump
 * (runner.ts), the cancel (lease.ts) and the owner's doors all wake machines,
 * and the module that answers the syncs (routes.ts) imports all of them. A
 * wake that lived there would close an import cycle at every call site.
 */

type Waker = () => void

const waiting = new Map<string, Set<Waker>>()

/**
 * Wait until `runnerId` is woken or `ms` passes, whichever comes first, or
 * until `signal` aborts (the machine hung up). Resolves `true` when woken.
 */
export function waitForNews(runnerId: string, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve(false)
      return
    }
    let done = false
    const finish = (woken: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      const set = waiting.get(runnerId)
      set?.delete(wake)
      if (set && set.size === 0) waiting.delete(runnerId)
      resolve(woken)
    }
    const wake = () => finish(true)
    const aborted = () => finish(false)
    const timer = setTimeout(() => finish(false), ms)
    timer.unref?.()
    signal?.addEventListener('abort', aborted, { once: true })
    const set = waiting.get(runnerId) ?? new Set<Waker>()
    set.add(wake)
    waiting.set(runnerId, set)
  })
}

/** Answer this machine's held sync now: it has news. */
export function wakeRunner(runnerId: string): void {
  for (const wake of [...(waiting.get(runnerId) ?? [])]) wake()
}

/** Answer every held sync: work arrived that any of them may take, or something all of them hold changed. */
export function wakeAllRunners(): void {
  for (const id of [...waiting.keys()]) wakeRunner(id)
}

/** How many syncs are held now, for the tests and the metrics. */
export function heldSyncs(): number {
  let n = 0
  for (const set of waiting.values()) n += set.size
  return n
}
