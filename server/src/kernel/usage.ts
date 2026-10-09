/**
 * The class containers as the owner's «Работают сейчас» shows them: what
 * each reserves, what it really uses, since when it runs.
 *
 * Until 0.20 nothing read real use at all. Admission and the budget bar count
 * reservations (`--memory` limits), and they must: a reservation is what the
 * kernel may grow into. But on 9 Oct 2026 three idle rooms held 3 × 4 GB of
 * reservations while using about a hundred megabytes each, and from the panel
 * that difference was invisible; it is exactly what tells the owner which
 * room is safe to stop.
 *
 * ONLY the panel's route calls this. `docker stats` samples twice to compute
 * CPU and takes about a second; it must never sit on the path of a kernel
 * start, a resize or the budget, whose fakes in the tests also refuse docker
 * commands they do not expect. One `docker ps`, one batched `inspect` and one
 * `stats` per pass, and the last two are kept for ten seconds: the tab polls
 * every fifteen, and several owners may have it open.
 *
 * Under the broker the Pods come with their limits and phase from the broker
 * census; real use is not something the broker may read (no metrics API in
 * its Role), so it is reported as unknown rather than guessed.
 */
import { activeName } from '../environments.js'
import { sessionEnvironment } from '../db.js'
import { brokerLimits, dockerRead, kernelLimits, roomContainer, roomContainers, type KernelRole } from './pool.js'
import { kernelBackend, kernelRuntimeClient } from './runtime-client.js'

/** One class container as the census and the sample saw it. */
export interface ContainerReading {
  session: string
  role: KernelRole
  state: 'running' | 'starting'
  /** The GPU slice a room container holds; `null` without one. */
  gpu: string | null
  environment: string | null
  /** The limit it holds the machine to, or what it would be started with when the runtime could not tell. */
  memoryMb: number | null
  cpus: number | null
  usedMb: number | null
  cpuPercent: number | null
  startedAt: number | null
}

export interface ContainerCensus {
  /** `false`: the runtime did not answer the census, and containers may be missing. */
  complete: boolean
  /** Whether real use was measured. */
  usage: 'live' | 'unknown'
  containers: ContainerReading[]
}

/** What one batched inspect and one stats call said about one container. */
interface Sample {
  memoryMb: number | null
  cpus: number | null
  startedAt: number | null
  environment: string | null
  usedMb: number | null
  cpuPercent: number | null
}

const SAMPLE_TTL_MS = 10_000
const STATS_TIMEOUT_MS = 15_000

let cached: { at: number; byName: Map<string, Sample>; usage: boolean } | null = null
let pending: Promise<{ byName: Map<string, Sample>; usage: boolean }> | null = null

/** Drop the kept sample: after a stop, the next look must not show the container's old life. */
export function forgetContainerUsage(): void {
  cached = null
}

/** "101.2MiB" or "1.5GB" in megabytes; docker prints binary units, but be lenient. */
export function parseDockerSize(text: string): number | null {
  const match = /^\s*([\d.]+)\s*([kKmMgGtT]?)(i?)B\s*$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = match[2]!.toLowerCase()
  const base = match[3] === 'i' ? 1024 : 1000
  const power = unit === 'k' ? 1 : unit === 'm' ? 2 : unit === 'g' ? 3 : unit === 't' ? 4 : 0
  return (value * base ** power) / 1024 ** 2
}

function parsePercent(text: string): number | null {
  const value = Number(text.trim().replace(/%$/, ''))
  return Number.isFinite(value) ? value : null
}

function parseTime(text: string): number | null {
  const at = Date.parse(text.trim())
  // Docker writes the zero time for a container that never started.
  return Number.isFinite(at) && at > 0 ? at : null
}

const INSPECT_FORMAT =
  '{{.Name}}\t{{.HostConfig.Memory}}\t{{.HostConfig.NanoCpus}}\t{{.State.StartedAt}}\t{{index .Config.Labels "colloq.environment"}}'
const STATS_FORMAT = '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'

/**
 * One inspect and one stats call for all the names. Either may fail as a
 * whole or for some names (a container removed between the census and the
 * call); what was answered is kept, the rest stays unknown.
 */
async function measure(names: string[]): Promise<{ byName: Map<string, Sample>; usage: boolean }> {
  const byName = new Map<string, Sample>(
    names.map((name) => [
      name,
      { memoryMb: null, cpus: null, startedAt: null, environment: null, usedMb: null, cpuPercent: null },
    ]),
  )
  const [inspected, stats] = await Promise.all([
    dockerRead(['inspect', '--format', INSPECT_FORMAT, ...names]).catch(() => ({ code: -1, out: '' })),
    dockerRead(['stats', '--no-stream', '--format', STATS_FORMAT, ...names], STATS_TIMEOUT_MS).catch(() => ({
      code: -1,
      out: '',
    })),
  ])
  for (const line of inspected.out.split('\n')) {
    const [rawName, rawBytes, rawNano, rawStarted, rawEnvironment] = line.split('\t')
    const sample = byName.get((rawName ?? '').trim().replace(/^\//, ''))
    if (!sample) continue
    const bytes = Number(rawBytes)
    const nano = Number(rawNano)
    sample.memoryMb = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / 1024 ** 2) : null
    sample.cpus = Number.isFinite(nano) && nano > 0 ? Math.round(nano / 1e8) / 10 : null
    sample.startedAt = parseTime(rawStarted ?? '')
    const environment = (rawEnvironment ?? '').trim()
    sample.environment = environment && environment !== '<no value>' ? environment : null
  }
  let measured = 0
  for (const line of stats.out.split('\n')) {
    const [rawName, rawUsage, rawCpu] = line.split('\t')
    const sample = byName.get((rawName ?? '').trim())
    if (!sample) continue
    const used = parseDockerSize((rawUsage ?? '').split('/')[0] ?? '')
    sample.usedMb = used === null ? null : Math.round(used)
    sample.cpuPercent = parsePercent(rawCpu ?? '')
    if (sample.usedMb !== null) measured += 1
  }
  return { byName, usage: measured > 0 }
}

/** The kept sample when it is fresh and covers every name, otherwise a new one, one at a time. */
async function sampleOf(names: string[]): Promise<{ byName: Map<string, Sample>; usage: boolean }> {
  const covers = (sample: { byName: Map<string, Sample> } | null): boolean =>
    sample !== null && names.every((name) => sample.byName.has(name))
  if (cached && Date.now() - cached.at < SAMPLE_TTL_MS && covers(cached)) return cached
  if (pending) {
    const shared = await pending
    if (covers(shared)) return shared
  }
  const attempt = measure(names)
  pending = attempt
  try {
    const fresh = await attempt
    cached = { at: Date.now(), ...fresh }
    return fresh
  } finally {
    if (pending === attempt) pending = null
  }
}

async function dockerCensus(): Promise<ContainerCensus> {
  let census: Awaited<ReturnType<typeof roomContainers>>
  try {
    census = await roomContainers({ strict: true })
  } catch {
    return { complete: false, usage: 'unknown', containers: [] }
  }
  const running = census.filter((container) => container.running && container.session.length > 0)
  if (running.length === 0) return { complete: true, usage: 'live', containers: [] }
  const names = running.map((container) => roomContainer(container.session, container.role))
  const sample = await sampleOf(names)
  return {
    complete: true,
    usage: sample.usage ? 'live' : 'unknown',
    containers: running.map((container, index) => {
      const read = sample.byName.get(names[index]!)
      const environment = read?.environment ?? sessionEnvironment(container.session)
      // A limit docker would not tell is counted by what the container would
      // be started with, as the budget bar counts it (pool.ts · runningKernelLimits).
      const planned = kernelLimits(container.session, environment ?? activeName(), container.role)
      return {
        session: container.session,
        role: container.role,
        state: 'running',
        gpu: container.gpu || null,
        environment,
        memoryMb: read?.memoryMb ?? planned.memoryMb,
        cpus: read?.cpus ?? planned.cpus,
        usedMb: read?.usedMb ?? null,
        cpuPercent: read?.cpuPercent ?? null,
        startedAt: read?.startedAt ?? null,
      }
    }),
  }
}

async function brokerCensus(): Promise<ContainerCensus> {
  let rooms: Awaited<ReturnType<ReturnType<typeof kernelRuntimeClient>['rooms']>>
  try {
    rooms = await kernelRuntimeClient().rooms()
  } catch {
    return { complete: false, usage: 'unknown', containers: [] }
  }
  return {
    complete: true,
    usage: 'unknown',
    containers: rooms
      .filter((room) => room.phase === 'ready' || room.phase === 'pending')
      .map((room) => {
        const role: KernelRole = room.role === 'own' ? 'own' : 'room'
        const planned = brokerLimits(room.sessionId, role)
        return {
          session: room.sessionId,
          role,
          state: room.phase === 'ready' ? 'running' : 'starting',
          gpu: null,
          environment: room.environment || null,
          memoryMb: room.memoryMb ?? planned.memoryMb,
          cpus: room.cpus ?? planned.cpus,
          usedMb: null,
          cpuPercent: null,
          startedAt: null,
        }
      }),
  }
}

/** Every running class container with its limits and, on docker, its real use. Read-only. */
export async function containerCensus(): Promise<ContainerCensus> {
  const backend = kernelBackend()
  if (backend === 'docker') return dockerCensus()
  if (backend === 'broker') return brokerCensus()
  return { complete: true, usage: 'unknown', containers: [] }
}
