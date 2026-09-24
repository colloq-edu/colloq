import { ENVIRONMENT_NAME } from './admin.js'

export interface RuntimeEnvironment {
  name: string
  image: string
  gpu: boolean
  packages?: string[]
  /**
   * Python version in the published image, `'3.12'`, if the catalog named it.
   *
   * Optional on purpose: the image here is immutable and built elsewhere, the
   * web app cannot ask it, and filling in a default would mean writing in the
   * panel a version the image may not have. Not stated means not shown.
   */
  python?: string
  current: boolean
}
export interface RuntimeCatalog {
  schemaVersion: 1
  release: string
  defaultEnvironment: string
  environments: RuntimeEnvironment[]
}
export interface RuntimeEnsureRequest {
  environment: string
  revision?: string
  /** Whole CPU cores for this room; absent uses the runtime's default. */
  cpus?: number
  /**
   * Room memory in mebibytes; no field means the broker's default.
   *
   * Before 18 Sep 2026 the memory field in the class form did nothing on k3s:
   * the broker accepted only the environment, the revision and the cores, and
   * every room Pod got its 2Gi whatever the teacher wrote. The number travels
   * in the same intent as the cores: a Pod template cannot be passed through
   * this entry point.
   */
  memoryMb?: number
}
/**
 * Raise or lower the memory and cores of a LIVE room, without a new Pod.
 *
 * A missing field leaves that resource alone; `null` restores the broker's
 * default. At least one field is required. Separate from ensure on purpose:
 * ensure starts a Pod if there is none, and changing a limit in the panel
 * must not start Python for a room nobody is in right now.
 *
 * Cores are here since 18 Sep 2026. Before that the core count arrived only
 * through ensure and was part of the Pod template hash: changing it in the
 * form did nothing to a live room, and the next start (someone opened a
 * terminal, the kernel reconnected) silently tore down the Pod together with
 * all the seminar's variables.
 */
export interface RuntimeResizeRequest {
  memoryMb?: number | null
  /** Whole cores, as in ensure. */
  cpus?: number | null
}
/**
 * What happened to the resources of a live room.
 *
 * `applied`: kubelet has already moved the cgroup; `pending`: the API
 * accepted, but the node has nothing to give yet (Deferred) or kubelet has
 * not caught up; `absent`: there is no Pod, and the next start takes the
 * number. Numbers are given only for the resources that were asked to change.
 */
export interface RuntimeResizeResult {
  outcome: 'applied' | 'pending' | 'absent'
  /** What the Pod has right now according to kubelet; no Pod, no field. */
  memoryMb?: number
  /** Cores the Pod has right now; fractional if the operator set it so. */
  cpus?: number
}
export interface RuntimeEndpoint {
  url: string
  token: string
  instanceId: string
  environment: string
  revision: string
}
export interface RuntimeHealth {
  ok: boolean
  reason: string | null
  /** Broker competition job capability; absent means that executor is unavailable. */
  competition?: import('./capabilities.js').CompetitionCapabilities
  defaultCpus?: number
  /** How much memory a room gets when nothing was set for it. */
  defaultMemoryMb?: number
  /** The broker gives a room no more than this: the operator's or node's ceiling. */
  maxMemoryMb?: number
  recovery?: { rollbackRetries: number; rollbackFailures: number; rollbacksApplied: number }
}
export interface RuntimeRoom {
  sessionId: string
  instanceId: string
  phase: 'pending' | 'ready' | 'failed' | 'terminating'
  environment: string
  revision: string
  reason?: string
  cpus?: number
  /** Memory the Pod really has, from status rather than from spec. */
  memoryMb?: number
}
/**
 * Why a room's Pod did not fit on a node: the resource the node was short of,
 * or `other` when the scheduler refused for another reason (taint, affinity,
 * volume binding).
 *
 * A word, not Kubernetes text. The scheduler's message is "0/1 nodes are
 * available: 1 Insufficient memory. preemption: …", and before 18 Sep 2026
 * not even that got out: the room read "Room startup timed out: pending"
 * after two minutes of waiting. The broker takes only the resource name from
 * the message: the rest is about other nodes and other Pods, and there is no
 * reason to show it to people.
 */
export type RuntimeUnschedulable = 'memory' | 'cpu' | 'gpu' | 'other'
const RUNTIME_UNSCHEDULABLE: readonly RuntimeUnschedulable[] = ['memory', 'cpu', 'gpu', 'other']
/**
 * A start failure that can be explained to a person: fields of the broker's
 * error body next to `error`. The numbers are what the Pod requested, not
 * what was in the form: the broker knows them exactly (default, ceiling), and
 * exactly those are what the node could not give.
 */
export interface RuntimeStartFailure {
  unschedulable: RuntimeUnschedulable
  memoryMb?: number
  /** Pod cores; fractional if the operator set it so (RUNTIME_KERNEL_CPU=1500m). */
  cpus?: number
}
/** Parse an untrusted error body: a wrong word or wrong numbers give nothing, not a failure. */
export function parseRuntimeStartFailure(value: unknown): RuntimeStartFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const kind = RUNTIME_UNSCHEDULABLE.find((known) => known === row.unschedulable)
  if (!kind) return undefined
  const cpus = row.cpus
  return {
    unschedulable: kind,
    ...(runtimeMemoryMb(row.memoryMb) ? { memoryMb: row.memoryMb } : {}),
    ...(typeof cpus === 'number' && Number.isFinite(cpus) && cpus > 0 && cpus <= 64 ? { cpus } : {}),
  }
}

/**
 * Bounds of the memory number in the protocol: the same ones the broker
 * accepts from the operator in RUNTIME_KERNEL_MEMORY. A particular node's
 * ceiling is stricter and lives in the broker.
 */
export const RUNTIME_MEMORY_MIN_MB = 64
export const RUNTIME_MEMORY_MAX_MB = 262144
const runtimeMemoryMb = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= RUNTIME_MEMORY_MIN_MB &&
  value <= RUNTIME_MEMORY_MAX_MB
/** Room cores in the protocol are whole, from one to 64, as in the form. */
const runtimeCpus = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 64

export const RUNTIME_SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/
export const RUNTIME_REVISION = /^sha256:[a-f0-9]{64}$/
/** Ordinary DELETE stops an idle room; this exact query permanently reserves its ID. */
export const RUNTIME_RETIRE_QUERY = '?retire=true'
const IMAGE =
  /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/
export const isRuntimeSessionId = (id: string): boolean => RUNTIME_SESSION_ID.test(id)

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return value as Record<string, unknown>
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unknown fields are not allowed')
}
export function imageRevision(image: string): string {
  if (image.length > 512 || !IMAGE.test(image))
    throw new Error('Environment image must be pinned by sha256 digest')
  return image.slice(image.lastIndexOf('@') + 1)
}
export function parseRuntimeEnsureRequest(value: unknown): RuntimeEnsureRequest {
  const row = object(value)
  onlyKeys(row, ['environment', 'revision', 'cpus', 'memoryMb'])
  if (typeof row.environment !== 'string' || !ENVIRONMENT_NAME.test(row.environment))
    throw new Error('Invalid environment name')
  if (
    'revision' in row &&
    (typeof row.revision !== 'string' || !RUNTIME_REVISION.test(row.revision))
  )
    throw new Error('Invalid environment revision')
  if ('cpus' in row && !runtimeCpus(row.cpus))
    throw new Error('Invalid room CPU limit: expected 1 to 64 whole cores')
  if ('memoryMb' in row && !runtimeMemoryMb(row.memoryMb))
    throw new Error(
      `Invalid room memory limit: expected ${RUNTIME_MEMORY_MIN_MB} to ${RUNTIME_MEMORY_MAX_MB} whole MiB`,
    )
  return {
    environment: row.environment,
    ...(typeof row.revision === 'string' ? { revision: row.revision } : {}),
    ...(typeof row.cpus === 'number' ? { cpus: row.cpus } : {}),
    ...(typeof row.memoryMb === 'number' ? { memoryMb: row.memoryMb } : {}),
  }
}
export function parseRuntimeResizeRequest(value: unknown): RuntimeResizeRequest {
  const row = object(value)
  onlyKeys(row, ['memoryMb', 'cpus'])
  // At least one field: an empty body is not "the default" but a caller error.
  if (!('memoryMb' in row) && !('cpus' in row))
    throw new Error('Resize requires memoryMb or cpus')
  if ('memoryMb' in row && row.memoryMb !== null && !runtimeMemoryMb(row.memoryMb))
    throw new Error(
      `Invalid room memory limit: expected null or ${RUNTIME_MEMORY_MIN_MB} to ${RUNTIME_MEMORY_MAX_MB} whole MiB`,
    )
  if ('cpus' in row && row.cpus !== null && !runtimeCpus(row.cpus))
    throw new Error('Invalid room CPU limit: expected null or 1 to 64 whole cores')
  return {
    ...('memoryMb' in row ? { memoryMb: row.memoryMb as number | null } : {}),
    ...('cpus' in row ? { cpus: row.cpus as number | null } : {}),
  }
}
export function parseRuntimeCatalog(value: unknown): RuntimeCatalog {
  const row = object(value)
  onlyKeys(row, ['schemaVersion', 'release', 'defaultEnvironment', 'environments'])
  if (
    row.schemaVersion !== 1 ||
    typeof row.release !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.release)
  )
    throw new Error('Invalid runtime catalog version or release')
  if (typeof row.defaultEnvironment !== 'string' || !ENVIRONMENT_NAME.test(row.defaultEnvironment))
    throw new Error('Invalid default environment')
  if (
    !Array.isArray(row.environments) ||
    row.environments.length === 0 ||
    row.environments.length > 1000
  )
    throw new Error('Invalid environment catalog')
  const seen = new Set<string>()
  const entries = row.environments.map((value) => {
    const item = object(value)
    onlyKeys(item, ['name', 'image', 'gpu', 'packages', 'python', 'current'])
    if (
      typeof item.name !== 'string' ||
      !ENVIRONMENT_NAME.test(item.name) ||
      typeof item.image !== 'string' ||
      typeof item.gpu !== 'boolean'
    )
      throw new Error('Invalid catalog environment')
    const key = `${item.name}:${imageRevision(item.image)}`
    if (seen.has(key)) throw new Error('Duplicate environment revision')
    seen.add(key)
    if ('current' in item && typeof item.current !== 'boolean')
      throw new Error('Invalid current revision flag')
    if (
      'packages' in item &&
      (!Array.isArray(item.packages) ||
        item.packages.length > 2000 ||
        item.packages.some((p) => typeof p !== 'string' || p.length > 512))
    )
      throw new Error('Invalid environment packages')
    // The version has the same form as in the environment directive: "3.12",
    // not "3.12 or newer". The panel shows it as a fact about the image, and
    // free text in this place would be fiction about someone else's build.
    if ('python' in item && (typeof item.python !== 'string' || !/^\d+\.\d+$/.test(item.python)))
      throw new Error('Invalid environment Python version')
    return {
      name: item.name,
      image: item.image,
      gpu: item.gpu,
      ...(Array.isArray(item.packages) ? { packages: [...item.packages] as string[] } : {}),
      ...(typeof item.python === 'string' ? { python: item.python } : {}),
      current: item.current as boolean | undefined,
    }
  })
  for (const name of new Set(entries.map((e) => e.name))) {
    const versions = entries.filter((e) => e.name === name)
    if (versions.length === 1 && versions[0].current === undefined) versions[0].current = true
    if (versions.filter((e) => e.current === true).length !== 1)
      throw new Error(`Environment ${name} requires exactly one current revision`)
  }
  if (!entries.some((e) => e.name === row.defaultEnvironment))
    throw new Error('Default environment is missing from catalog')
  return {
    schemaVersion: 1,
    release: row.release,
    defaultEnvironment: row.defaultEnvironment,
    environments: entries.map((e) => ({ ...e, current: e.current === true })),
  }
}
export function resolveRuntimeEnvironment(
  catalog: RuntimeCatalog,
  name: string,
  revision?: string,
): RuntimeEnvironment {
  if (!ENVIRONMENT_NAME.test(name)) throw new Error('Invalid environment name')
  if (revision !== undefined && !RUNTIME_REVISION.test(revision))
    throw new Error('Invalid environment revision')
  const found = catalog.environments.find(
    (e) =>
      e.name === name && (revision === undefined ? e.current : imageRevision(e.image) === revision),
  )
  if (!found)
    throw new Error(
      `Environment ${name}${revision ? ` revision ${revision}` : ''} is unavailable in the runtime catalog`,
    )
  return found
}
