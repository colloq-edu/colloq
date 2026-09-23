import type { CompetitionCapabilities } from '@shared/capabilities'
import { competitionCapabilities } from './capabilities.js'

type Worker = 'execution' | 'preparation'
interface WorkerStartupOptions {
  capabilities?: () => Promise<CompetitionCapabilities>
  startExecution: () => Promise<boolean | void>
  startPreparation: () => Promise<boolean | void>
  onError: (worker: Worker | 'capabilities', error: unknown) => void
}
/** Startup recovery waits for a supported, available runtime. A short bounded
 * retry survives daemon outages without new traffic; concurrent wakes coalesce.
 * Once started, each worker's own pump handles later availability changes. */
export function createWorkerStartup(options: WorkerStartupOptions) {
  const read = options.capabilities ?? competitionCapabilities
  const started: Record<Worker, boolean> = { execution: false, preparation: false }
  let stopped = true
  let timer: ReturnType<typeof setInterval> | null = null
  let pending: Promise<void> | null = null
  const failures = new Map<string, string>()
  function report(worker: Worker | 'capabilities', error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (failures.get(worker) === message) return
    failures.set(worker, message)
    options.onError(worker, error)
  }
  async function attempt(): Promise<void> {
    let capabilities: CompetitionCapabilities
    try { capabilities = await read(); failures.delete('capabilities') }
    catch (error) { report('capabilities', error); return }
    for (const worker of ['execution', 'preparation'] as const) {
      if (stopped || started[worker] || !capabilities[worker].available) continue
      try {
        const result = await (worker === 'execution' ? options.startExecution() : options.startPreparation())
        started[worker] = result !== false
        failures.delete(worker)
      } catch (error) { report(worker, error) }
    }
    if (started.execution && started.preparation && timer) {
      clearInterval(timer)
      timer = null
    }
  }
  function wake(): Promise<void> {
    if (stopped || (started.execution && started.preparation)) return Promise.resolve()
    if (pending) return pending
    pending = Promise.resolve().then(attempt).finally(() => { pending = null })
    return pending
  }
  return {
    start(): Promise<void> {
      stopped = false
      if (!timer && !(started.execution && started.preparation)) {
        timer = setInterval(() => { void wake() }, 5000)
        timer.unref?.()
      }
      return wake()
    },
    wake,
    async stop(): Promise<void> {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      await pending
    },
  }
}
