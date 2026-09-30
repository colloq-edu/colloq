import { createHash, createHmac } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isIP } from 'node:net'
import {
  imageRevision,
  isRuntimeSessionId,
  parseRuntimeEnsureRequest,
  parseRuntimeResizeRequest,
  resolveRuntimeEnvironment,
  RUNTIME_MEMORY_MAX_MB,
  type RuntimeCatalog,
  type RuntimeEndpoint,
  type RuntimeEnsureRequest,
  type RuntimeEnvironment,
  type RuntimeHealth,
  type RuntimeKernelRole,
  type RuntimeResizeRequest,
  type RuntimeResizeResult,
  type RuntimeRoom,
  type RuntimeStartFailure,
  type RuntimeUnschedulable,
} from '../../shared/runtime.js'
import { KubernetesError, type KubernetesClient, type KubeObject } from './kubernetes.js'
import type { WorkloadConfig } from './config.js'
import { placementSatisfies, policyMetadata, policyPlacement, withoutPlacement } from './pod-policy.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sessionHash = (id: string) => hash(id).slice(0, 40)
export const roomName = (id: string) => `colloq-room-${sessionHash(id)}`
/**
 * The Pod and Service of a class's personal notebooks: the room's name with
 * `-own`, the Docker container's naming (`colloq-room-<id>-own`), so that
 * `kubectl get pods` lists the two side by side. 56 characters, inside the
 * 63 a Service name may have.
 */
export const ownName = (id: string) => `${roomName(id)}-own`
export const kernelName = (id: string, role: RuntimeKernelRole = 'room') =>
  role === 'own' ? ownName(id) : roomName(id)
/** The queue key of one of a room's two Pods; a room ID never contains `#`. */
const slotOf = (id: string, role: RuntimeKernelRole) => (role === 'own' ? `${id}#own` : id)
const MANAGER = 'colloq-runtime'
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly status = 503,
    /** Why the start failed, as a word the web translates for the person (see http.ts). */
    readonly failure?: RuntimeStartFailure,
  ) {
    super(message)
  }
}
interface RoomQueue {
  generation: number
  tail: Promise<void>
  inflight: Map<string, Promise<RuntimeEndpoint>>
}
interface Options {
  kube: KubernetesClient
  config: WorkloadConfig
  catalog: () => RuntimeCatalog
  roomSecret: () => string
  probe?: (endpoint: RuntimeEndpoint) => Promise<boolean>
  pollMs?: number
  startupTimeoutMs?: number
  deletionTimeoutMs?: number
  /** How long to wait for kubelet to reset the memory and cores of a live Pod. */
  resizeTimeoutMs?: number
  /** How long a Pod may stand refused by the scheduler before the start gives up. */
  unschedulableGraceMs?: number
}
/**
 * The labels a Pod and its Service are owned and selected by.
 *
 * The room's set is exactly what it always was: it is the selector of every
 * live room's Service, and the broker refuses a Service that differs from the
 * one it would create, so changing it would refuse every live class.
 *
 * The personal notebooks' Pod keeps `colloq.dev/role=kernel`: the room
 * isolation NetworkPolicy selects by it (Jupyter ingress from app and runtime
 * only, egress to DNS at most), and a second policy the chart could forget
 * would be a Pod with an open network. What tells the two apart is
 * `colloq.kind` (`own-kernel`, not `room-kernel`), so the room's Service does
 * not select the personal Pod and the other way round, plus an explicit
 * `colloq.dev/kernel=own` for operators and policies.
 */
const labels = (id: string, role: RuntimeKernelRole = 'room'): Record<string, string> =>
  role === 'own'
    ? {
        'colloq.dev/role': 'kernel',
        'app.kubernetes.io/managed-by': MANAGER,
        'colloq.kind': 'own-kernel',
        'colloq.dev/session': sessionHash(id),
        'colloq.dev/kernel': 'own',
      }
    : {
        'colloq.dev/role': 'kernel',
        'app.kubernetes.io/managed-by': MANAGER,
        'colloq.kind': 'room-kernel',
        'colloq.dev/session': sessionHash(id),
      }
function owned(object: KubeObject, id: string, role: RuntimeKernelRole = 'room'): boolean {
  return (
    object.metadata?.name === kernelName(id, role) &&
    object.metadata.annotations?.['colloq.dev/session-id'] === id &&
    Object.entries(labels(id, role)).every(([k, v]) => object.metadata.labels?.[k] === v)
  )
}
function assertOwned(object: KubeObject, id: string, role: RuntimeKernelRole = 'room'): void {
  if (!owned(object, id, role) || !object.metadata.uid)
    throw new RuntimeError('Refusing resource with mismatched runtime ownership', 409)
}
function retired(service: KubeObject | null): boolean {
  // Either marker is enough to fail closed if an operator partially modifies
  // the resource. Ordinary cleanup must never erase a retirement reservation.
  return service?.metadata.annotations?.['colloq.dev/retired'] === 'true' ||
    service?.metadata.labels?.['colloq.dev/retired'] === 'true'
}
function omitDefault(object: Record<string, any>, key: string, value: unknown): void {
  if (isDeepStrictEqual(object[key], value)) delete object[key]
}
function resourceQuantity(name: string, value: unknown): unknown {
  const text = String(value)
  if (name === 'cpu' && /^(?:[0-9]+(?:\.[0-9]+)?m?)$/.test(text))
    return Number(text.replace(/m$/, '')) * (text.endsWith('m') ? 1 : 1000)
  if (name === 'memory' || name === 'ephemeral-storage') {
    const match = /^([0-9]+)(Ki|Mi|Gi|Ti)?$/.exec(text)
    if (match)
      return (
        Number(match[1]) *
        ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }[match[2] ?? ''] ?? 1)
      )
  }
  if (name === 'nvidia.com/gpu' && /^[0-9]+$/.test(text)) return Number(text)
  return value
}
const MiB = 1024 ** 2
const KERNEL = 'kernel'
const RESIZE_PATCH = 'application/strategic-merge-patch+json'
/** The 501 a resize gets when the operator turned in-place resize off, the same status a cluster older than 1.33 gets. */
const RESIZE_DISABLED = 'In-place Pod resize is disabled on this runtime (RUNTIME_IN_PLACE_RESIZE=0)'
/** What to change on a live Pod: memory in MiB, cores as a Kubernetes quantity ("2", "1500m"). */
interface ResizeTarget {
  memoryMb?: number
  cpu?: string
}
/** Memory of the kernel container (limits) in MiB, from spec or from status. */
function memoryOf(resources: any): number | undefined {
  const bytes = resourceQuantity('memory', resources?.limits?.memory)
  return typeof bytes === 'number' && bytes > 0 ? Math.floor(bytes / MiB) : undefined
}
/** Cores of the kernel container (limits) in millicores, from spec or from status. */
function milliCpuOf(resources: any): number | undefined {
  const milli = resourceQuantity('cpu', resources?.limits?.cpu)
  return typeof milli === 'number' && milli > 0 ? milli : undefined
}
const kernelOf = (containers: unknown): any =>
  Array.isArray(containers) ? containers.find((c: any) => c?.name === KERNEL) : undefined
/**
 * The spec without the memory and cores of the kernel container.
 *
 * These are exactly the Pod fields the broker changes on a LIVE Pod (the
 * resize subresource). The template hash and the comparison for an in-place
 * change are computed without them: otherwise the very first limit change
 * would make the Pod "foreign", and the next ensure would take it down along
 * with all the seminar's variables, the very thing the limit is changed in
 * place for rather than by re-creation. With cores that is how it was until
 * 18 Sep 2026: they were in the hash, and changing the number in the form cost
 * the room its Python on the next start, for example, when someone opened a
 * terminal.
 */
function withoutResizable(input: Record<string, any>): Record<string, any> {
  const spec = structuredClone(input)
  const kernel = kernelOf(spec.containers)
  for (const group of ['requests', 'limits'])
    for (const name of ['memory', 'cpu'])
      if (kernel?.resources?.[group]) delete kernel.resources[group][name]
  return spec
}
/** Compare the ENTIRE workload after removing only known API defaults. A
 * copied template-hash annotation cannot authorize additional executable or
 * secret fields. Placement (where and how urgently the Pod runs, nodeName
 * included) is compared apart: pod-policy.ts · PLACEMENT_FIELDS says why. */
function canonicalPod(input: Record<string, any>): Record<string, any> {
  const spec = structuredClone(withoutPlacement(input))
  for (const [key, value] of Object.entries({
    dnsPolicy: 'ClusterFirst',
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    hostUsers: true,
    shareProcessNamespace: false,
    initContainers: [],
    ephemeralContainers: [],
  }))
    omitDefault(spec, key, value)
  if (spec.serviceAccount === spec.serviceAccountName) delete spec.serviceAccount
  for (const container of spec.containers ?? []) {
    for (const [key, value] of Object.entries({
      terminationMessagePath: '/dev/termination-log',
      terminationMessagePolicy: 'File',
      stdin: false,
      stdinOnce: false,
      tty: false,
    }))
      omitDefault(container, key, value)
    // An in-place change without a restart is the API default; an explicit
    // entry and one filled in by the server are the same thing, and neither is
    // a reason to change the Pod.
    if (Array.isArray(container.resizePolicy)) {
      container.resizePolicy = container.resizePolicy.filter(
        (p: any) =>
          !(['cpu', 'memory'].includes(p?.resourceName) && p?.restartPolicy === 'NotRequired' &&
            Object.keys(p).length === 2),
      )
      omitDefault(container, 'resizePolicy', [])
    }
    const security = container.securityContext
    if (security) {
      omitDefault(security, 'privileged', false)
      omitDefault(security, 'procMount', 'Default')
      if (security.capabilities) omitDefault(security.capabilities, 'add', [])
    }
    for (const group of ['requests', 'limits']) {
      const resources = container.resources?.[group]
      if (resources)
        for (const name of Object.keys(resources))
          resources[name] = resourceQuantity(name, resources[name])
    }
    for (const mount of container.volumeMounts ?? []) {
      omitDefault(mount, 'readOnly', false)
      omitDefault(mount, 'mountPropagation', 'None')
      omitDefault(mount, 'recursiveReadOnly', 'Disabled')
    }
    for (const probe of [container.readinessProbe, container.livenessProbe]) {
      if (!probe) continue
      for (const [key, value] of Object.entries({
        initialDelaySeconds: 0,
        timeoutSeconds: 1,
        periodSeconds: 10,
        successThreshold: 1,
        failureThreshold: 3,
      }))
        omitDefault(probe, key, value)
      if (probe.tcpSocket) omitDefault(probe.tcpSocket, 'host', '')
    }
  }
  for (const volume of spec.volumes ?? []) {
    if (volume.persistentVolumeClaim) omitDefault(volume.persistentVolumeClaim, 'readOnly', false)
    if (volume.emptyDir) {
      omitDefault(volume.emptyDir, 'medium', '')
      if (volume.emptyDir.sizeLimit !== undefined)
        volume.emptyDir.sizeLimit = resourceQuantity('ephemeral-storage', volume.emptyDir.sizeLimit)
    }
  }
  return spec
}
function podMatches(actual: Record<string, any>, expected: Record<string, any>): boolean {
  try {
    return isDeepStrictEqual(canonicalPod(actual), canonicalPod(expected))
  } catch {
    return false
  }
}
/**
 * Where a found Pod differs from the one the broker asked for: field paths
 * only, never values (the kernel's environment carries the room's token).
 *
 * For the operator of a cluster whose admission webhooks rewrite Pods: a
 * sidecar injector, a policy that sets `imagePullPolicy: Always`. The broker
 * refuses such a Pod as not its own, and "does not match the requested
 * workload policy" alone does not say which webhook to exempt it from.
 */
function workloadDifferences(actual: Record<string, any>, expected: Record<string, any>): string[] {
  const found: string[] = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (found.length >= 8 || isDeepStrictEqual(a, b)) return
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      const keys = Array.isArray(a)
        ? [...Array(Math.max(a.length, (b as unknown[]).length)).keys()].map(String)
        : [...new Set([...Object.keys(a), ...Object.keys(b as object)])]
      for (const key of keys)
        walk((a as any)[key], (b as any)[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`)
      return
    }
    found.push(path)
  }
  try {
    walk(canonicalPod(actual), canonicalPod(expected), 'spec')
  } catch {
    return ['spec']
  }
  return found
}
/**
 * The template hash: the workload the broker creates, without the resources
 * it changes on a live Pod and without placement.
 *
 * Placement left the hash in 0.10, together with the settings that decide it
 * (colocation, node selectors, tolerations, the priority class, the GPU
 * RuntimeClass): a changed setting must reach the NEXT Pod, not make every
 * live class foreign at its next run.
 */
function templateHash(spec: Record<string, any>): string {
  return hash(JSON.stringify(withoutResizable(withoutPlacement(spec))))
}
/**
 * The room Pod 0.9 created from the same intent, for adopting it.
 *
 * Two things differ: 0.9 had no liveness probe, and it hashed a GPU room's
 * `runtimeClassName` (in the place it wrote it, after the securityContext).
 * Without this, the upgrade to 0.10 would make every live class's Pod
 * foreign, and its next run would replace it with all the seminar's
 * variables. The found Pod must still match this template exactly, field for
 * field; only the template it is held to is the one it was created from.
 */
function legacyTemplate(spec: Record<string, any>, gpu: boolean): { hash: string; spec: Record<string, any> } {
  const legacy = structuredClone(spec)
  const kernel = kernelOf(legacy.containers)
  if (kernel) delete kernel.livenessProbe
  const hashed: Record<string, any> = {}
  for (const [key, value] of Object.entries(withoutPlacement(legacy))) {
    hashed[key] = value
    if (gpu && key === 'securityContext') hashed.runtimeClassName = 'nvidia'
  }
  return { hash: hash(JSON.stringify(withoutResizable(hashed))), spec: legacy }
}
/** A Pod has not started a container yet: there is no Python in it to lose. */
const notStarted = (pod: KubeObject) => !pod.status?.phase || pod.status.phase === 'Pending'
/**
 * The same Pod, only with different memory or cores: it is changed in place,
 * not taken down.
 *
 * Everything else is compared as strictly as in podMatches: a swapped command
 * or mount still means a replacement. Memory and cores must be readable and
 * equal in requests and limits: otherwise the Pod is no longer Guaranteed and
 * not the one the broker created.
 */
function onlyResizableDiffers(actual: Record<string, any>, expected: Record<string, any>): boolean {
  try {
    const resources = kernelOf(actual.containers)?.resources
    const limit = memoryOf(resources)
    if (limit === undefined || memoryOf({ limits: resources?.requests }) !== limit) return false
    const cpu = milliCpuOf(resources)
    if (cpu === undefined || milliCpuOf({ limits: resources?.requests }) !== cpu) return false
    return isDeepStrictEqual(
      canonicalPod(withoutResizable(actual)),
      canonicalPod(withoutResizable(expected)),
    )
  } catch {
    return false
  }
}
/** The conditions by which kubelet (1.33+) says a change has not landed yet. */
function resizeCondition(pod: KubeObject, type: 'PodResizePending' | 'PodResizeInProgress') {
  return pod.status?.conditions?.find((c: any) => c?.type === type && c?.status === 'True')
}
function canonicalService(input: Record<string, any>): Record<string, any> {
  const spec = structuredClone(input)
  const ip = spec.clusterIP
  if (typeof ip === 'string' && isIP(ip)) {
    delete spec.clusterIP
    omitDefault(spec, 'clusterIPs', [ip])
  }
  if (ip === 'None') omitDefault(spec, 'clusterIPs', ['None'])
  for (const [key, value] of Object.entries({
    ipFamilies: ['IPv4'],
    ipFamilyPolicy: 'SingleStack',
    sessionAffinity: 'None',
    internalTrafficPolicy: 'Cluster',
    publishNotReadyAddresses: false,
  }))
    omitDefault(spec, key, value)
  return spec
}
function serviceMatches(actual: Record<string, any>, expected: Record<string, any>): boolean {
  try {
    return isDeepStrictEqual(canonicalService(actual), canonicalService(expected))
  } catch {
    return false
  }
}
function podPhase(pod: KubeObject): RuntimeRoom['phase'] {
  if (pod.metadata.deletionTimestamp) return 'terminating'
  if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') return 'failed'
  return pod.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')
    ? 'ready'
    : 'pending'
}
/** The PodScheduled=False condition: the Pod is not on a node yet, and the scheduler said why. */
const notScheduled = (pod: KubeObject) =>
  pod.status?.conditions?.find((c: any) => c?.type === 'PodScheduled' && c?.status === 'False')
function podReason(pod: KubeObject): string | undefined {
  const state = pod.status?.containerStatuses?.find(
    (c: any) => c.state?.waiting || c.state?.terminated,
  )?.state
  // The scheduler's reason (`Unschedulable`) comes last: a Pod that has no
  // room on the node has neither containers nor status.reason, and both the
  // room census and the timeout said just "pending" about it.
  const reason =
    state?.waiting?.reason ?? state?.terminated?.reason ?? pod.status?.reason ?? notScheduled(pod)?.reason
  return typeof reason === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(reason) ? reason : undefined
}
/** Kubernetes resource names → protocol word; the order is the order of importance. */
const SHORTAGES: ReadonlyArray<readonly [string, RuntimeUnschedulable]> = [
  // The GPU first: it cannot be shared, and the advice "reduce the memory"
  // would do nothing for a room that did not get a card.
  ['nvidia.com/gpu', 'gpu'],
  ['memory', 'memory'],
  ['cpu', 'cpu'],
]
/**
 * What the node lacked to place the Pod, or nothing if the Pod is already on a
 * node.
 *
 * Only the resource names after "Insufficient" are taken from the scheduler
 * message: the text itself talks about the cluster's nodes and other Pods,
 * while into the broker's response, and further on to people, only the
 * resource name gets out of the API body (the same rule as
 * KubernetesError.insufficient). No shortage but a refusal all the same:
 * `other`.
 */
function unschedulable(pod: KubeObject): RuntimeUnschedulable | undefined {
  const condition = notScheduled(pod)
  if (pod.spec?.nodeName || condition?.reason !== 'Unschedulable') return undefined
  const message = typeof condition.message === 'string' ? condition.message.slice(0, 4096) : ''
  const lacking = new Set(
    // The name ends with a letter or a digit: a dot after it is the end of the
    // scheduler's sentence.
    [...message.matchAll(/\bInsufficient ([a-z0-9](?:[a-z0-9./-]{0,61}[a-z0-9])?)/g)].map((match) => match[1]),
  )
  return SHORTAGES.find(([name]) => lacking.has(name))?.[1] ?? 'other'
}
/** How long to wait for a Pod the scheduler refused before saying so. */
const UNSCHEDULABLE_GRACE_MS = 20000

export class RuntimeController {
  private readonly queues = new Map<string, RoomQueue>()
  private readonly root: string
  private readonly recovery = { rollbackRetries: 0, rollbackFailures: 0, rollbacksApplied: 0 }
  /** What was already said about a Pod, so a warning comes once per Pod rather than once per run. */
  private readonly noted = new Set<string>()
  recoveryDiagnostics() { return { ...this.recovery } }
  constructor(private readonly options: Options) {
    this.root = `/api/v1/namespaces/${options.config.namespace}`
  }
  /** Whether a live Pod's memory and cores are changed at all (RUNTIME_IN_PLACE_RESIZE). */
  private get inPlaceResize(): boolean {
    return this.options.config.inPlaceResize !== false
  }
  private noteOnce(key: string, text: string): void {
    if (this.noted.has(key)) return
    if (this.noted.size >= 10000) this.noted.clear()
    this.noted.add(key)
    console.warn(text)
  }
  /**
   * One queue per Pod, not per room.
   *
   * The personal notebooks' Pod has a queue of its own: a student's first run
   * in a personal notebook waits for that Pod up to the startup timeout, and
   * in a shared queue the lecture's own start would wait behind it. What the
   * two share is the room's end, and `remove` holds both queues for it.
   */
  private queue(id: string, role: RuntimeKernelRole = 'room'): RoomQueue {
    if (!isRuntimeSessionId(id)) throw new RuntimeError('Invalid room ID', 400)
    const slot = slotOf(id, role)
    let queue = this.queues.get(slot)
    if (!queue) {
      if (this.queues.size >= 10000) throw new RuntimeError('Runtime queue capacity reached', 429)
      queue = { generation: 0, tail: Promise.resolve(), inflight: new Map() }
      this.queues.set(slot, queue)
    }
    return queue
  }
  private enqueue<T>(slot: string, queue: RoomQueue, fn: () => Promise<T>): Promise<T> {
    const task = queue.tail.then(fn)
    const tail = task.then(
      () => undefined,
      () => undefined,
    )
    queue.tail = tail
    void tail.then(() => {
      if (queue.tail === tail && this.queues.get(slot) === queue) this.queues.delete(slot)
    })
    return task
  }
  ensure(id: string, intent: RuntimeEnsureRequest, role: RuntimeKernelRole = 'room'): Promise<RuntimeEndpoint> {
    let environment: RuntimeEnvironment, queue: RoomQueue
    let cpus: number | undefined, memoryMb: number | undefined
    try {
      const request = parseRuntimeEnsureRequest(intent)
      cpus = request.cpus
      /*
       * Above the ceiling means the ceiling, not a refusal. A refusal here would
       * mean a room with no Python at all: the number is written in the seminar
       * row, and every next cell run would get the same 400. The web checks
       * against the ceiling itself (it reads it from /v1/health), so such a
       * number gets here only past the form; and what the Pod actually got,
       * the room census will tell from status.
       */
      if (request.memoryMb !== undefined) {
        memoryMb = Math.min(request.memoryMb, this.maxMemoryMb())
        if (memoryMb !== request.memoryMb)
          console.warn(`[runtime] room memory ${request.memoryMb}Mi capped at ${memoryMb}Mi`)
      }
      environment = resolveRuntimeEnvironment(
        this.options.catalog(),
        request.environment,
        request.revision,
      )
      queue = this.queue(id, role)
    } catch (err) {
      return Promise.reject(
        err instanceof RuntimeError
          ? err
          : new RuntimeError(err instanceof Error ? err.message : 'Invalid room intent', 400),
      )
    }
    const generation = queue.generation,
      workload = `${generation}:${environment.name}:${imageRevision(environment.image)}:`,
      key = `${workload}${cpus ?? 'default'}:${memoryMb ?? 'default'}`
    const existing = queue.inflight.get(key)
    if (existing) return existing
    /*
     * Different memory or cores with the same environment are not a conflict
     * but a queue.
     *
     * The teacher raises the memory while the room's Pod is still coming up
     * (after an OOM everyone presses Run at once), and the next Run already
     * arrives with the new number. A 409 "different revision" refusal here
     * would take a run away from a student for nothing: such an ensure queues
     * behind the current one and, once the Pod is there, changes its resources
     * in place.
     */
    if ([...queue.inflight.keys()].some((k) => k.startsWith(`${generation}:`) && !k.startsWith(workload)))
      return Promise.reject(
        new RuntimeError('Room is starting with a different environment revision', 409),
      )
    const check = () => {
      if (queue.generation !== generation)
        throw new RuntimeError('Room startup cancelled by deletion', 409)
    }
    const task = this.enqueue(slotOf(id, role), queue, () =>
      this.ensureWorkload(id, role, environment, check, cpus, memoryMb),
    ).finally(
      () => queue.inflight.delete(key),
    )
    queue.inflight.set(key, task)
    return task
  }
  /**
   * Stop a room: both of its Pods, or with `role` `own` only its personal
   * notebooks' Pod (its last personal kernel went away, the class goes on).
   *
   * The whole room (idle sweep, deleted seminar, permanent retirement) holds
   * BOTH queues for the work: it takes its place in the personal queue first,
   * then in the room's, and deletes only once both are reached. Holding one
   * would leave a window: a personal ensure queued behind this deletion but
   * run before it would create a Pod for a room being removed, and after a
   * permanent retirement one that nothing would ever delete. No other task
   * waits across the two queues, so this cannot deadlock.
   */
  remove(id: string, permanent = false, role: RuntimeKernelRole = 'room'): Promise<void> {
    let own: RoomQueue, room: RoomQueue | undefined
    try {
      if (role === 'own' && permanent)
        throw new RuntimeError('Personal notebook kernels are retired together with their room', 400)
      own = this.queue(id, 'own')
      if (role === 'room') room = this.queue(id)
    } catch (err) {
      return Promise.reject(err)
    }
    own.generation++
    if (!room) return this.enqueue(slotOf(id, 'own'), own, () => this.deleteWorkload(id, 'own'))
    room.generation++
    let reached!: () => void
    const roomReached = new Promise<void>((resolve) => (reached = resolve))
    const work = this.enqueue(slotOf(id, 'own'), own, async () => {
      await roomReached
      await (permanent ? this.retireWorkload(id) : this.deleteRoom(id))
    })
    const held = this.enqueue(slotOf(id, 'room'), room, async () => {
      reached()
      await work.catch(() => undefined)
    })
    return Promise.all([work, held]).then(() => undefined)
  }
  /**
   * Raise or lower the memory and cores of a LIVE room without touching its
   * Python.
   *
   * This is the same knob as `docker update --memory`/`--cpus` on a
   * developer's machine: a teacher whose kernel was just killed for memory, or
   * who has too few cores for training, adds them and runs the cell again.
   * Kubernetes 1.33+ can change the cgroup of a running container through the
   * `pods/resize` subresource; the Pod and its UID stay the same.
   *
   * No Pod is neither an error nor a reason to start one: the number already
   * lies in the seminar row, and the next ensure creates the Pod with it right
   * away. It joins the same room queue as ensure and DELETE, so as not to
   * change a Pod that is being started or taken down right now.
   *
   * With RUNTIME_IN_PLACE_RESIZE=0 a change that would need the subresource
   * answers 501, exactly as a cluster older than 1.33 does: the operator took
   * `pods/resize` out of the Role, and a call would only be a 403.
   */
  resize(id: string, intent: RuntimeResizeRequest, role: RuntimeKernelRole = 'room'): Promise<RuntimeResizeResult> {
    let queue: RoomQueue
    const target: ResizeTarget = {}
    try {
      const request = parseRuntimeResizeRequest(intent)
      if (request.memoryMb !== undefined) {
        target.memoryMb = request.memoryMb ?? this.defaultMemoryMb()
        // Here, unlike in ensure, above the ceiling is a refusal: nothing breaks
        // for a live room, and the caller must learn that the number will not
        // be applied.
        if (target.memoryMb > this.maxMemoryMb())
          throw new RuntimeError(
            `Room memory limit exceeds the runtime ceiling of ${this.maxMemoryMb()} MiB`,
            400,
          )
      }
      // `null` is the broker default, as the same string a new Pod gets, even a
      // fractional one ("1500m"): a reset must not produce a Pod that ensure
      // would not create.
      if (request.cpus !== undefined)
        target.cpu = request.cpus === null ? this.options.config.cpu : String(request.cpus)
      queue = this.queue(id, role)
    } catch (err) {
      return Promise.reject(
        err instanceof RuntimeError
          ? err
          : new RuntimeError(err instanceof Error ? err.message : 'Invalid resize intent', 400),
      )
    }
    return this.enqueue(slotOf(id, role), queue, () => this.resizeWorkload(id, role, target))
  }
  private defaultMemoryMb(): number {
    return Math.floor(Number(resourceQuantity('memory', this.options.config.memory)) / MiB)
  }
  private maxMemoryMb(): number {
    return this.options.config.maxMemoryMb ?? RUNTIME_MEMORY_MAX_MB
  }
  /**
   * A patch to the resize subresource: only memory and cores, only the kernel
   * container, and only those of the two that were asked for: memory nobody
   * touched is not overwritten with a number read a second ago.
   */
  private patchResources(id: string, role: RuntimeKernelRole, pod: KubeObject, target: ResizeTarget): Promise<KubeObject> {
    // Every caller checks this first; the guard is here so that no future one
    // can reach a subresource the operator's Role may not grant.
    if (!this.inPlaceResize) return Promise.reject(new RuntimeError(RESIZE_DISABLED, 501))
    const values: Record<string, string> = {
      ...(target.memoryMb !== undefined ? { memory: `${target.memoryMb}Mi` } : {}),
      ...(target.cpu !== undefined ? { cpu: target.cpu } : {}),
    }
    return this.options.kube.request<KubeObject>(
      'PATCH',
      `${this.root}/pods/${kernelName(id, role)}/resize`,
      {
        // resourceVersion is a precondition: a Pod that was replaced or changed
        // between the read and the patch gets a 409, not someone else's limits.
        metadata: { resourceVersion: pod.metadata.resourceVersion },
        spec: {
          containers: [
            { name: KERNEL, resources: { requests: { ...values }, limits: { ...values } } },
          ],
        },
      },
      RESIZE_PATCH,
    )
  }
  /** Restore only this Pod, rereading the resourceVersion after kubelet races.
   * The persisted Infeasible condition lets a later ensure (even after a broker
   * restart) retry restoration if all three writes fail. */
  private async rollbackResources(id: string, role: RuntimeKernelRole, pod: KubeObject, target: ResizeTarget): Promise<KubeObject> {
    const uid = pod.metadata.uid
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        assertOwned(pod, id, role)
        if (pod.metadata.uid !== uid || pod.metadata.deletionTimestamp)
          throw new Error('Pod was replaced or is terminating')
        try {
          const restored = await this.patchResources(id, role, pod, target)
          this.recovery.rollbacksApplied = Math.min(Number.MAX_SAFE_INTEGER, this.recovery.rollbacksApplied + 1)
          return restored
        } catch (err) {
          if (!(err instanceof KubernetesError && err.status === 409) || attempt === 2) throw err
          this.recovery.rollbackRetries = Math.min(Number.MAX_SAFE_INTEGER, this.recovery.rollbackRetries + 1)
          const current = await this.get('pods', id, role)
          if (!current) throw new Error('Pod disappeared')
          pod = current
        }
      }
    } catch {
      this.recovery.rollbackFailures = Math.min(Number.MAX_SAFE_INTEGER, this.recovery.rollbackFailures + 1)
      // Never include an API response body or Pod credentials in diagnostics.
      console.warn(`[runtime] room ${id} resize rollback unreconciled; next ensure will retry`)
    }
    throw new RuntimeError('Room resize rollback failed; resources are unreconciled, retry required', 503)
  }
  private async resizeWorkload(id: string, role: RuntimeKernelRole, target: ResizeTarget): Promise<RuntimeResizeResult> {
    const wantCpu = target.cpu === undefined ? undefined : milliCpuOf({ limits: { cpu: target.cpu } })
    let uid: string | undefined
    // What the Pod actually has: the spec returns to this if the node cannot
    // give that much.
    let before: ResizeTarget = {}
    for (let attempt = 0; ; attempt++) {
      const pod = await this.get('pods', id, role)
      if (!pod || pod.metadata.deletionTimestamp || podPhase(pod) === 'failed')
        return { outcome: 'absent' }
      assertOwned(pod, id, role)
      uid = pod.metadata.uid
      const kernel = kernelOf(pod.spec.containers)
      if (!kernel) throw new RuntimeError('Managed room Pod has no kernel container', 409)
      const status = kernelOf(pod.status?.containerStatuses)?.resources
      const memory = memoryOf(status) ?? memoryOf(kernel.resources)
      const cpu = milliCpuOf(status) !== undefined ? status.limits.cpu : kernel.resources?.limits?.cpu
      before = {
        ...(target.memoryMb !== undefined && memory !== undefined ? { memoryMb: memory } : {}),
        ...(target.cpu !== undefined && milliCpuOf({ limits: { cpu } }) !== undefined ? { cpu: String(cpu) } : {}),
      }
      const memoryDone =
        target.memoryMb === undefined ||
        (memoryOf(kernel.resources) === target.memoryMb &&
          memoryOf({ limits: kernel.resources?.requests }) === target.memoryMb)
      const cpuDone =
        wantCpu === undefined ||
        (milliCpuOf(kernel.resources) === wantCpu &&
          milliCpuOf({ limits: kernel.resources?.requests }) === wantCpu)
      if (memoryDone && cpuDone) break
      // The same answer as a cluster without the subresource gives below.
      if (!this.inPlaceResize) throw new RuntimeError(RESIZE_DISABLED, 501)
      try {
        await this.patchResources(id, role, pod, target)
        break
      } catch (err) {
        // Kubelet updated status between the read and the patch: reread, retry.
        if (err instanceof KubernetesError && err.status === 409 && attempt < 2) continue
        if (err instanceof KubernetesError && err.status === 404)
          throw new RuntimeError('Kubernetes does not support in-place Pod resize (1.33+ required)', 501)
        // API 1.35+ rejects an infeasible change right away, without touching
        // spec (checked on k3s 1.36 for both memory and cores).
        if (err instanceof KubernetesError && err.insufficient)
          throw new RuntimeError(
            `Room resize is infeasible on this node: not enough allocatable ${err.insufficient}`,
            409,
          )
        throw err
      }
    }
    const deadline = Date.now() + (this.options.resizeTimeoutMs ?? 10000)
    while (true) {
      const pod = await this.get('pods', id, role)
      if (!pod || pod.metadata.uid !== uid || pod.metadata.deletionTimestamp)
        return { outcome: 'absent' }
      assertOwned(pod, id, role)
      const status = kernelOf(pod.status?.containerStatuses)?.resources
      const actualMemory = memoryOf(status)
      const actualCpu = milliCpuOf(status)
      const pending = resizeCondition(pod, 'PodResizePending')
      if (pending?.reason === 'Infeasible') {
        /*
         * The node can never give that much. The infeasible number must not
         * stay in spec: the next Pod of this room, created from it, would hang
         * in Pending forever. We return spec to what the Pod has and give the
         * caller an honest "no".
         */
        const revert: ResizeTarget = {
          ...(before.memoryMb !== undefined && before.memoryMb !== target.memoryMb
            ? { memoryMb: before.memoryMb }
            : {}),
          ...(before.cpu !== undefined && milliCpuOf({ limits: { cpu: before.cpu } }) !== wantCpu
            ? { cpu: before.cpu }
            : {}),
        }
        if (Object.keys(revert).length)
          await this.rollbackResources(id, role, pod, revert)
        throw new RuntimeError('Room resize is infeasible on this node', 409)
      }
      const reached =
        (target.memoryMb === undefined || actualMemory === target.memoryMb) &&
        (wantCpu === undefined || actualCpu === wantCpu)
      if (reached && !pending && !resizeCondition(pod, 'PodResizeInProgress'))
        return {
          outcome: 'applied',
          ...(target.memoryMb !== undefined ? { memoryMb: target.memoryMb } : {}),
          ...(wantCpu !== undefined ? { cpus: wantCpu / 1000 } : {}),
        }
      if (Date.now() >= deadline)
        return {
          outcome: 'pending',
          ...(target.memoryMb !== undefined && actualMemory !== undefined ? { memoryMb: actualMemory } : {}),
          ...(wantCpu !== undefined && actualCpu !== undefined ? { cpus: actualCpu / 1000 } : {}),
        }
      await delay(this.options.pollMs ?? 500)
    }
  }
  private async get(kind: 'pods' | 'services', id: string, role: RuntimeKernelRole = 'room'): Promise<KubeObject | null> {
    try {
      return await this.options.kube.request<KubeObject>(
        'GET',
        `${this.root}/${kind}/${kernelName(id, role)}`,
      )
    } catch (err) {
      if (err instanceof KubernetesError && err.status === 404) return null
      throw err
    }
  }
  private async create(
    kind: 'pods' | 'services',
    id: string,
    body: KubeObject,
    role: RuntimeKernelRole = 'room',
  ): Promise<KubeObject> {
    let created: KubeObject
    try {
      created = await this.options.kube.request<KubeObject>('POST', `${this.root}/${kind}`, body)
    } catch (err) {
      if (!(err instanceof KubernetesError && err.status === 409)) throw err
      const found = await this.get(kind, id, role)
      if (!found) throw err
      created = found
    }
    assertOwned(created, id, role)
    return created
  }
  /**
   * Where a room's or a personal notebook's Pod may run, from the operator's
   * settings (pod-policy.ts). A setting that is not given adds nothing, so a
   * room Pod on the installer's single-node k3s is exactly the Pod of 0.9.
   */
  private placement(gpu: boolean): Record<string, unknown> {
    const { config } = this.options
    const runtimeClass = config.gpuRuntimeClass ?? 'nvidia'
    const nodeSelector = { ...config.roomNodeSelector, ...(gpu ? config.gpuNodeSelector : {}) }
    const tolerations = [...(config.roomTolerations ?? []), ...(gpu ? config.gpuTolerations ?? [] : [])]
    return {
      ...(gpu && runtimeClass ? { runtimeClassName: runtimeClass } : {}),
      ...(Object.keys(nodeSelector).length ? { nodeSelector } : {}),
      ...(tolerations.length ? { tolerations: tolerations.map((toleration) => ({ ...toleration })) } : {}),
      // Both of a room's Pods mount the workspace claim.
      ...policyPlacement(config, true),
    }
  }
  private pod(
    id: string,
    role: RuntimeKernelRole,
    environment: RuntimeEnvironment,
    token: string,
    cpus?: number,
    memoryMb?: number,
  ): KubeObject {
    const { config } = this.options
    const revision = imageRevision(environment.image)
    /*
     * The personal notebooks' Pod never gets the class's card: it runs a GPU
     * environment's image on the CPU, exactly as the Docker backend's second
     * container does. The card is the class's, and a GPU is given to a Pod as
     * a whole; that is not a setting but the reason the second Pod exists.
     */
    const gpu = role === 'room' && environment.gpu
    const quota = cpus === undefined ? config.cpu : String(cpus)
    const limits: Record<string, string | number> = {
      cpu: quota,
      memory: memoryMb === undefined ? config.memory : `${memoryMb}Mi`,
      'ephemeral-storage': config.ephemeral,
      ...(gpu ? { 'nvidia.com/gpu': 1 } : {}),
    }
    const workload = {
      serviceAccountName: 'colloq-kernel',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 10,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
      containers: [
        {
          name: 'kernel',
          image: environment.image,
          imagePullPolicy: 'IfNotPresent',
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          ports: [{ name: 'jupyter', containerPort: 8888, protocol: 'TCP' }],
          env: [
            { name: 'JUPYTER_TOKEN', value: token },
            { name: 'HOME', value: '/home/runner' },
            /*
             * Threads of the numeric libraries follow the Pod's cores, not the
             * node's (those are what `os.cpu_count()` sees inside), otherwise
             * numpy starts dozens of threads on two cores and they fight over
             * them. The number is taken by kubelet from limits.cpu when the
             * container starts (Downward API), not written by the broker as a
             * string: that way the Pod template does not depend on the cores,
             * and an in-place change of cores does not make the Pod "foreign"
             * for the next ensure. The rounding here is up (1500m → 2): that is
             * how Kubernetes computes with divisor 1; whole room cores come out
             * exactly.
             *
             * Nothing can change this number for a live Python any more:
             * environment variables are read at process start, and even a
             * Jupyter kernel restart inherits them from the server in the same
             * container. The new thread count goes to the next Pod of the room,
             * the same as in docker, where `docker run` sets them.
             */
            ...['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'].map(
              (name) => ({
                name,
                valueFrom: {
                  resourceFieldRef: { containerName: 'kernel', resource: 'limits.cpu', divisor: '1' },
                },
              }),
            ),
          ],
          resources: { requests: { ...limits }, limits },
          // Memory and cores are changed on a live Pod (see resize): restarting
          // the container for that means losing all the seminar's variables, so
          // no restart.
          resizePolicy: [
            { resourceName: 'memory', restartPolicy: 'NotRequired' },
            { resourceName: 'cpu', restartPolicy: 'NotRequired' },
          ],
          /*
           * The room's folder, and only it, at the same path in both Pods: the
           * Docker backend mounts the same folder into both of its containers,
           * and a personal notebook reads the class's data files exactly where
           * the lecture's notebook reads them.
           */
          volumeMounts: [
            { name: 'workspace', mountPath: `/workspace/${id}`, subPath: id },
            { name: 'tmp', mountPath: '/tmp' },
            { name: 'home', mountPath: '/home/runner' },
            { name: 'shm', mountPath: '/dev/shm' },
          ],
          readinessProbe: {
            tcpSocket: { port: 8888 },
            initialDelaySeconds: 1,
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 3,
          },
          /*
           * Liveness, for a cluster whose policy engine requires it on every
           * long-running container, and for a Jupyter server that stopped
           * accepting connections, which is gone anyway.
           *
           * TCP on the Jupyter port, never an HTTP call into it: the kernels
           * are other processes, and the node completes the handshake on the
           * server's listening socket however long a cell computes and however
           * throttled the Pod's cores are. With restartPolicy Never a failed
           * liveness ends the Pod and the seminar's variables with it, so it
           * acts only after five minutes of refused connections.
           */
          livenessProbe: {
            tcpSocket: { port: 8888 },
            initialDelaySeconds: 30,
            periodSeconds: 30,
            timeoutSeconds: 5,
            failureThreshold: 10,
          },
        },
      ],
      volumes: [
        { name: 'workspace', persistentVolumeClaim: { claimName: config.workspaceClaim } },
        { name: 'tmp', emptyDir: { sizeLimit: config.ephemeral } },
        { name: 'home', emptyDir: { sizeLimit: config.ephemeral } },
        {
          name: 'shm',
          emptyDir: { medium: 'Memory', sizeLimit: gpu ? '1Gi' : '64Mi' },
        },
      ],
    }
    // Placement comes last and stays out of the template hash (templateHash).
    const spec = { ...workload, ...this.placement(gpu) }
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: kernelName(id, role),
        ...policyMetadata(
          config,
          { ...labels(id, role), 'colloq.dev/environment': environment.name },
          {
            'colloq.dev/session-id': id,
            'colloq.dev/revision': revision,
            'colloq.dev/template-hash': templateHash(spec),
          },
        ),
      },
      spec,
    }
  }
  private service(id: string, role: RuntimeKernelRole = 'room'): KubeObject {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: kernelName(id, role),
        labels: labels(id, role),
        annotations: { 'colloq.dev/session-id': id },
      },
      spec: {
        type: 'ClusterIP',
        selector: labels(id, role),
        ports: [{ name: 'jupyter', protocol: 'TCP', port: 8888, targetPort: 8888 }],
      },
    }
  }
  private async ensureWorkload(
    id: string,
    role: RuntimeKernelRole,
    environment: RuntimeEnvironment,
    check: () => void,
    cpus?: number,
    memoryMb?: number,
  ): Promise<RuntimeEndpoint> {
    check()
    /*
     * Each Pod its own Jupyter token. A line in a personal notebook reading its
     * JUPYTER_TOKEN must not open the lecture's Jupyter, other people's kernels
     * and variables (the NetworkPolicy already keeps kernel Pods apart; the
     * token does not rely on it). The room keeps the string it always had, so
     * live Pods answer to their own token after an upgrade.
     */
    const token = createHmac('sha256', this.options.roomSecret())
      .update(role === 'own' ? `jupyter:own:${id}` : `jupyter:${id}`)
      .digest('hex')
    const desired = this.pod(id, role, environment, token, cpus, memoryMb),
      desiredService = this.service(id, role)
    let [pod, service] = await Promise.all([this.get('pods', id, role), this.get('services', id, role)])
    check()
    if (pod) assertOwned(pod, id, role)
    if (service) assertOwned(service, id, role)
    // A permanent retirement is recorded on the ROOM's Service, and it closes
    // the room's personal notebooks as well.
    const reservation = role === 'own' ? await this.get('services', id) : service
    if (role === 'own') {
      check()
      if (reservation) assertOwned(reservation, id)
    }
    if (retired(reservation)) throw new RuntimeError('Room has been permanently retired', 410)
    // Never silently route Jupyter through an altered externally exposed service.
    if (
      service &&
      (!serviceMatches(service.spec, desiredService.spec) ||
        service.spec.externalIPs?.length ||
        service.spec.externalName)
    )
      throw new RuntimeError('Managed room Service does not match the private service policy', 409)
    /*
     * The template the found Pod was created from, by the hash it carries:
     * this version's, or for a room the one of 0.9 (legacyTemplate), so the
     * upgrade does not replace a single live class. A hash that is neither
     * is another template, and the Pod is replaced below.
     */
    const templates = [
      { hash: desired.metadata.annotations?.['colloq.dev/template-hash'], spec: desired.spec },
      ...(role === 'room' ? [legacyTemplate(desired.spec, environment.gpu)] : []),
    ]
    const template = pod
      ? templates.find((candidate) => candidate.hash === pod!.metadata.annotations?.['colloq.dev/template-hash'])
      : undefined
    // An infeasible spec can survive a failed rollback and a broker restart.
    // Recover from the actual kubelet allocation before adopting the Pod. Do
    // not immediately submit the same impossible resize again in this ensure.
    // Without in-place resize there is nothing to write it back with: the Pod
    // is adopted as it is below, and its next incarnation takes the desired
    // numbers, not its spec.
    let reconciled = false
    if (this.inPlaceResize && pod && !pod.metadata.deletionTimestamp && podPhase(pod) !== 'failed' &&
      resizeCondition(pod, 'PodResizePending')?.reason === 'Infeasible' &&
      onlyResizableDiffers(pod.spec, (template ?? templates[0]).spec)) {
      const resources = kernelOf(pod.status?.containerStatuses)?.resources
      const actualMemory = memoryOf(resources), actualCpu = milliCpuOf(resources)
      if (actualMemory === undefined || actualCpu === undefined)
        throw new RuntimeError('Room resize rollback failed; actual resources are unknown and unreconciled', 503)
      pod = await this.rollbackResources(id, role, pod, { memoryMb: actualMemory, cpu: String(resources.limits.cpu) })
      reconciled = true
      check()
    }
    /*
     * A live Pod that differs only in memory and cores is a limit change that
     * did not land earlier (the broker was down, the patch was refused, the web
     * is older than the broker). It is changed in place: taking the Pod down
     * for the sake of a limit means taking all the variables away from the
     * seminar exactly when it was given more so as not to lose them.
     */
    const live = !!pod && !pod.metadata.deletionTimestamp && podPhase(pod) !== 'failed'
    const matches = live && !!template && podMatches(pod!.spec, template.spec)
    const resize = live && !!template && !matches && onlyResizableDiffers(pod!.spec, template.spec)
    /*
     * A Pod placed under another configuration (the operator changed the node
     * selector, the tolerations, the priority class, turned colocation on) is
     * replaced only while it has not started: there is no Python in it to
     * lose, and the new placement may be exactly what lets it start, the
     * Multi-Attach of a ReadWriteOnce volume on the wrong node. A running Pod
     * stays where it is until the room stops; its next Pod follows the
     * setting. Placement is immutable on a live Pod, so there is nothing to
     * change in place.
     */
    const misplaced = live && !placementSatisfies(pod!.spec, desired.spec)
    if (pod && (!(matches || resize) || (misplaced && notStarted(pod)))) {
      await this.deleteWorkload(id, role)
      check()
      pod = null
      service = null
    } else if (pod && misplaced) {
      this.noteOnce(
        `placement:${pod.metadata.uid}`,
        `[runtime] ${kernelName(id, role)} keeps running where an earlier configuration placed it; the room's next Pod follows the current node selector, tolerations, affinity and priority class`,
      )
    }
    if (!service) {
      service = await this.create('services', id, desiredService, role)
      check()
      if (
        !serviceMatches(service.spec, desiredService.spec) ||
        service.spec.externalIPs?.length ||
        service.spec.externalName
      )
        throw new RuntimeError(
          'Managed room Service does not match the private service policy',
          409,
        )
    }
    if (!pod) {
      pod = await this.create('pods', id, desired, role)
      check()
      if (!podMatches(pod.spec, desired.spec)) {
        // The names of the differing fields, never their values: that is what
        // the operator needs to find the webhook that rewrote the Pod.
        console.warn(
          `[runtime] ${kernelName(id, role)} was changed at admission and is refused; differing fields: ` +
            `${workloadDifferences(pod.spec, desired.spec).join(', ')}. Exempt broker-created Pods ` +
            '(colloq.dev/role=kernel) from mutating webhooks such as sidecar injection',
        )
        throw new RuntimeError('Managed Pod does not match the requested workload policy', 409)
      }
    } else if (resize && !reconciled) {
      if (!this.inPlaceResize) {
        // The cluster changes no live Pod: the room keeps its Python and its
        // numbers, the census shows what it has, the next Pod gets the new ones.
        this.noteOnce(
          `resize:${pod.metadata.uid}`,
          `[runtime] ${kernelName(id, role)} keeps its memory and CPU: in-place resize is disabled (RUNTIME_IN_PLACE_RESIZE=0); the room's next Pod gets the new numbers`,
        )
      } else {
        // Without waiting for kubelet: the room needs Python, not a report on the
        // cgroup. If it fails (the node has nothing to give right now, the API is
        // old), the Pod stays as it was and working, and the room census shows
        // the memory and cores it actually has.
        const resources = kernelOf(desired.spec.containers).resources
        const target: ResizeTarget = {
          memoryMb: memoryOf(resources)!,
          cpu: String(resources.limits.cpu),
        }
        await this.patchResources(id, role, pod, target).catch((err) =>
          console.warn(
            `[runtime] in-place resize to ${target.memoryMb}Mi/${target.cpu} CPU failed: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
          ),
        )
        check()
      }
    }
    const endpoint: RuntimeEndpoint = {
      url: `http://${kernelName(id, role)}.${this.options.config.namespace}.svc:8888`,
      token,
      instanceId: pod.metadata.uid!,
      environment: environment.name,
      revision: imageRevision(environment.image),
    }
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120000)
    let reason = 'Pending'
    // A Pod the scheduler refused, and since when it has been standing so.
    let refused: { pod: KubeObject; lacking: RuntimeUnschedulable; since: number } | undefined
    while (Date.now() < deadline) {
      check()
      const current = await this.get('pods', id, role)
      check()
      if (!current || current.metadata.uid !== endpoint.instanceId)
        throw new RuntimeError('Room Pod disappeared or was replaced during startup', 409)
      assertOwned(current, id, role)
      const phase = podPhase(current)
      reason = podReason(current) ?? phase
      if (phase === 'failed' || phase === 'terminating')
        throw new RuntimeError(`Room Pod cannot start: ${reason}`)
      /*
       * A scheduler refusal is no reason to wait two minutes for the timeout.
       *
       * The room's memory is reserved in full (requests = limits), and on a
       * busy node the Pod goes into Pending with "Insufficient memory" and
       * stays there until someone frees up space. A short refusal also happens
       * to a healthy room (a neighbor has just closed and its Pod is still
       * shutting down), and the scheduler retries by itself as soon as that one
       * is gone. So first a pause, and only a refusal that outlives it becomes
       * an answer with a word.
       */
      const lacking = phase === 'pending' ? unschedulable(current) : undefined
      refused = lacking ? { pod: current, lacking, since: refused?.since ?? Date.now() } : undefined
      if (refused && Date.now() - refused.since >= (this.options.unschedulableGraceMs ?? UNSCHEDULABLE_GRACE_MS))
        return this.refuseUnschedulable(id, role, refused.pod, refused.lacking)
      if (phase === 'ready') {
        const ready = await (this.options.probe ?? probeJupyter)(endpoint)
        check()
        if (ready) return endpoint
        reason = 'Jupyter did not accept an authenticated readiness request'
      }
      await delay(this.options.pollMs ?? 500)
    }
    // The deadline passed before the pause did (the startup is shorter than
    // it): the reason is the same, and saying it as a word is more honest than
    // "timed out: Unschedulable".
    if (refused) return this.refuseUnschedulable(id, role, refused.pod, refused.lacking)
    throw new RuntimeError(`Room startup timed out: ${reason}`)
  }
  /**
   * A Pod that has no room on the node: a refusal with a word and numbers, not
   * a timeout.
   *
   * The Pod itself is deleted. It never stood on a node, there was no Python in
   * it, and there is nothing to lose; while left in Pending it would hold on to
   * the old numbers: resource accounting would count its memory as promised,
   * and the next start after the teacher reduced the room's memory would change
   * it on a Pod that is on no node at all. The next ensure creates a new one,
   * already with what is in the form.
   */
  private async refuseUnschedulable(
    id: string,
    role: RuntimeKernelRole,
    pod: KubeObject,
    lacking: RuntimeUnschedulable,
  ): Promise<never> {
    const resources = kernelOf(pod.spec.containers)?.resources
    const memoryMb = memoryOf(resources)
    const milli = resourceQuantity('cpu', resources?.limits?.cpu)
    await this.deleteResource('pods', id, pod, role).catch((err) =>
      console.warn(
        `[runtime] unschedulable room Pod was not deleted: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
      ),
    )
    throw new RuntimeError(
      lacking === 'other'
        ? 'Room Pod cannot be scheduled on the node'
        : `Room Pod cannot be scheduled: node lacks allocatable ${lacking}`,
      503,
      {
        unschedulable: lacking,
        ...(memoryMb !== undefined ? { memoryMb } : {}),
        ...(typeof milli === 'number' && milli > 0 ? { cpus: milli / 1000 } : {}),
      },
    )
  }
  private async retireWorkload(id: string): Promise<void> {
    const [pod, service] = await Promise.all([this.get('pods', id), this.get('services', id)])
    for (const object of [pod, service]) if (object) assertOwned(object, id)
    if (!retired(service)) {
      // RBAC deliberately has no patch/update permission. Replace the Service
      // with a selectorless headless reservation before terminating the Pod.
      // Failure here leaves the caller unable to claim permanent termination.
      if (service) await this.deleteResource('services', id, service)
      const tombstone: KubeObject = {
        apiVersion: 'v1', kind: 'Service',
        metadata: {name: roomName(id), labels: {...labels(id), 'colloq.dev/retired':'true'},
          annotations: {'colloq.dev/session-id':id, 'colloq.dev/retired':'true'}},
        // Selectorless headless Services otherwise default to RequireDualStack
        // on current Kubernetes, even in this IPv4 deployment.
        spec: {type:'ClusterIP',clusterIP:'None',ipFamilies:['IPv4'],ipFamilyPolicy:'SingleStack',ports:[{name:'retired',protocol:'TCP',port:8888,targetPort:8888}]},
      }
      const created = await this.create('services', id, tombstone)
      if (!retired(created) || !serviceMatches(created.spec,tombstone.spec))
        throw new RuntimeError('Permanent room retirement could not be persisted',409)
    }
    await this.deleteRoom(id)
  }
  /**
   * Both of a room's Pods and their Services; a retirement reservation stays.
   * Both deletions are attempted even when one fails, and the first failure
   * is what the caller hears: a stuck personal Pod must not keep the class's
   * own Pod alive, or the other way round.
   */
  private async deleteRoom(id: string): Promise<void> {
    const results = await Promise.allSettled([this.deleteWorkload(id, 'room'), this.deleteWorkload(id, 'own')])
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  private async deleteWorkload(id: string, role: RuntimeKernelRole = 'room'): Promise<void> {
    const [pod, service] = await Promise.all([this.get('pods', id, role), this.get('services', id, role)])
    for (const object of [pod, service]) if (object) assertOwned(object, id, role)
    for (const [kind, object] of [
      ['services', service],
      ['pods', pod],
    ] as const) {
      if (!object || (kind === 'services' && retired(object))) continue
      await this.deleteResource(kind,id,object,role)
    }
  }
  private async deleteResource(kind: 'pods' | 'services', id: string, object: KubeObject, role: RuntimeKernelRole = 'room'): Promise<void> {
      if (!object.metadata.deletionTimestamp) {
        try {
          await this.options.kube.request('DELETE', `${this.root}/${kind}/${kernelName(id, role)}`, {
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid: object.metadata.uid },
            ...(kind === 'pods' ? { gracePeriodSeconds: 10 } : {}),
          })
        } catch (err) {
          if (!(err instanceof KubernetesError && err.status === 404)) throw err
        }
      }
      const deadline = Date.now() + (this.options.deletionTimeoutMs ?? 60000)
      while (true) {
        const current = await this.get(kind, id, role)
        if (!current) break
        assertOwned(current, id, role)
        if (current.metadata.uid !== object.metadata.uid)
          throw new RuntimeError('Room resource was replaced during deletion', 409)
        if (Date.now() >= deadline)
          throw new RuntimeError(
            'Room resource is still terminating; refusing overlapping replacement',
            409,
          )
        await delay(this.options.pollMs ?? 500)
      }
  }
  /**
   * The census of kernel Pods: rooms, and since 0.10 their personal notebooks'
   * Pods, marked `role: own`. The selector already matches both
   * (`colloq.dev/role=kernel`); a Pod is counted only under the name and the
   * labels its role gives it.
   */
  async list(): Promise<RuntimeRoom[]> {
    const selector = encodeURIComponent(
      'colloq.dev/role=kernel,app.kubernetes.io/managed-by=colloq-runtime',
    )
    const pods: KubeObject[] = []
    const continuations = new Set<string>()
    let continuation = ''
    do {
      const result = await this.options.kube.request<{
        items: KubeObject[]
        metadata?: { continue?: string }
      }>(
        'GET',
        `${this.root}/pods?labelSelector=${selector}&limit=100${continuation ? `&continue=${encodeURIComponent(continuation)}` : ''}`,
      )
      if (!Array.isArray(result.items))
        throw new RuntimeError('Kubernetes returned an invalid room census')
      pods.push(...result.items)
      if (pods.length > 10000) throw new RuntimeError('Runtime room census exceeds capacity')
      continuation = result.metadata?.continue ?? ''
      if (continuation) {
        if (continuations.has(continuation) || continuation.length > 16384)
          throw new RuntimeError('Kubernetes returned an invalid continuation')
        continuations.add(continuation)
      }
    } while (continuation)
    return pods.flatMap((pod) => {
      const id = pod.metadata.annotations?.['colloq.dev/session-id']
      if (!id || !isRuntimeSessionId(id) || !pod.metadata.uid) return []
      const role: RuntimeKernelRole = pod.metadata.name === ownName(id) ? 'own' : 'room'
      if (!owned(pod, id, role)) return []
      // What the Pod has, not what is written for it: after an in-place change
      // spec is already new, while kubelet may not have caught up yet, or the
      // node had nothing to give (Deferred).
      const milliCpus =
        milliCpuOf(kernelOf(pod.status?.containerStatuses)?.resources) ??
        milliCpuOf(kernelOf(pod.spec.containers)?.resources)
      const memoryMb =
        memoryOf(kernelOf(pod.status?.containerStatuses)?.resources) ??
        memoryOf(kernelOf(pod.spec.containers)?.resources)
      return [
        {
          sessionId: id,
          instanceId: pod.metadata.uid,
          phase: podPhase(pod),
          environment: pod.metadata.labels?.['colloq.dev/environment'] ?? '',
          revision: pod.metadata.annotations?.['colloq.dev/revision'] ?? '',
          ...(milliCpus !== undefined ? { cpus: milliCpus / 1000 } : {}),
          ...(memoryMb !== undefined ? { memoryMb } : {}),
          ...(podReason(pod) ? { reason: podReason(pod) } : {}),
          ...(role === 'own' ? { role } : {}),
        },
      ]
    })
  }
  async health(): Promise<RuntimeHealth> {
    try {
      this.options.catalog()
      this.options.roomSecret()
      await Promise.all(
        ['pods', 'services'].map((kind) =>
          this.options.kube.request('GET', `${this.root}/${kind}?limit=1`),
        ),
      )
      return {
        ok: true,
        reason: null,
        defaultCpus: Number(resourceQuantity('cpu', this.options.config.cpu)) / 1000,
        defaultMemoryMb: this.defaultMemoryMb(),
        maxMemoryMb: this.maxMemoryMb(),
        inPlaceResize: this.inPlaceResize,
        recovery: this.recoveryDiagnostics(),
      }
    } catch (err) {
      return {
        ok: false,
        recovery: this.recoveryDiagnostics(),
        reason:
          err instanceof KubernetesError
            ? err.message
            : 'Runtime catalog, credentials or Kubernetes API is unavailable',
      }
    }
  }
}
async function probeJupyter(endpoint: RuntimeEndpoint): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.url}/api/status`, {
      headers: { Authorization: `token ${endpoint.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}
