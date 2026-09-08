import { createHash, createHmac } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isIP } from 'node:net'
import {
  imageRevision,
  isRuntimeSessionId,
  parseRuntimeEnsureRequest,
  resolveRuntimeEnvironment,
  type RuntimeCatalog,
  type RuntimeEndpoint,
  type RuntimeEnsureRequest,
  type RuntimeEnvironment,
  type RuntimeHealth,
  type RuntimeRoom,
} from '../../shared/runtime.js'
import { KubernetesError, type KubernetesClient, type KubeObject } from './kubernetes.js'
import type { WorkloadConfig } from './config.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sessionHash = (id: string) => hash(id).slice(0, 40)
export const roomName = (id: string) => `colloq-room-${sessionHash(id)}`
const MANAGER = 'colloq-runtime'
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly status = 503,
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
}
const labels = (id: string) => ({
  'colloq.dev/role': 'kernel',
  'app.kubernetes.io/managed-by': MANAGER,
  'colloq.kind': 'room-kernel',
  'colloq.dev/session': sessionHash(id),
})
function owned(object: KubeObject, id: string): boolean {
  return (
    object.metadata?.name === roomName(id) &&
    object.metadata.annotations?.['colloq.dev/session-id'] === id &&
    Object.entries(labels(id)).every(([k, v]) => object.metadata.labels?.[k] === v)
  )
}
function assertOwned(object: KubeObject, id: string): void {
  if (!owned(object, id) || !object.metadata.uid)
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
/** Compare the ENTIRE spec after removing only known API defaults. A copied
 * template-hash annotation cannot authorize additional executable or secret
 * fields. nodeName is the single scheduler-populated placement field allowed. */
function canonicalPod(input: Record<string, any>): Record<string, any> {
  const spec = structuredClone(input)
  for (const [key, value] of Object.entries({
    dnsPolicy: 'ClusterFirst',
    schedulerName: 'default-scheduler',
    priority: 0,
    preemptionPolicy: 'PreemptLowerPriority',
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    hostUsers: true,
    shareProcessNamespace: false,
    initContainers: [],
    ephemeralContainers: [],
  }))
    omitDefault(spec, key, value)
  if (typeof spec.nodeName === 'string' && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(spec.nodeName))
    delete spec.nodeName
  if (spec.serviceAccount === spec.serviceAccountName) delete spec.serviceAccount
  if (
    Array.isArray(spec.tolerations) &&
    spec.tolerations.length <= 2 &&
    new Set(spec.tolerations.map((t: any) => t.key)).size === spec.tolerations.length &&
    spec.tolerations.every((t: any) =>
      ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'].some((key) =>
        isDeepStrictEqual(t, {
          key,
          operator: 'Exists',
          effect: 'NoExecute',
          tolerationSeconds: 300,
        }),
      ),
    )
  )
    delete spec.tolerations
  for (const container of spec.containers ?? []) {
    for (const [key, value] of Object.entries({
      terminationMessagePath: '/dev/termination-log',
      terminationMessagePolicy: 'File',
      stdin: false,
      stdinOnce: false,
      tty: false,
    }))
      omitDefault(container, key, value)
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
    const probe = container.readinessProbe
    if (probe) {
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
function podReason(pod: KubeObject): string | undefined {
  const state = pod.status?.containerStatuses?.find(
    (c: any) => c.state?.waiting || c.state?.terminated,
  )?.state
  const reason = state?.waiting?.reason ?? state?.terminated?.reason ?? pod.status?.reason
  return typeof reason === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(reason) ? reason : undefined
}

export class RuntimeController {
  private readonly queues = new Map<string, RoomQueue>()
  private readonly root: string
  constructor(private readonly options: Options) {
    this.root = `/api/v1/namespaces/${options.config.namespace}`
  }
  private queue(id: string): RoomQueue {
    if (!isRuntimeSessionId(id)) throw new RuntimeError('Invalid room ID', 400)
    let queue = this.queues.get(id)
    if (!queue) {
      if (this.queues.size >= 10000) throw new RuntimeError('Runtime queue capacity reached', 429)
      queue = { generation: 0, tail: Promise.resolve(), inflight: new Map() }
      this.queues.set(id, queue)
    }
    return queue
  }
  private enqueue<T>(id: string, queue: RoomQueue, fn: () => Promise<T>): Promise<T> {
    const task = queue.tail.then(fn)
    const tail = task.then(
      () => undefined,
      () => undefined,
    )
    queue.tail = tail
    void tail.then(() => {
      if (queue.tail === tail && this.queues.get(id) === queue) this.queues.delete(id)
    })
    return task
  }
  ensure(id: string, intent: RuntimeEnsureRequest): Promise<RuntimeEndpoint> {
    let environment: RuntimeEnvironment, queue: RoomQueue
    try {
      const request = parseRuntimeEnsureRequest(intent)
      environment = resolveRuntimeEnvironment(
        this.options.catalog(),
        request.environment,
        request.revision,
      )
      queue = this.queue(id)
    } catch (err) {
      return Promise.reject(
        err instanceof RuntimeError
          ? err
          : new RuntimeError(err instanceof Error ? err.message : 'Invalid room intent', 400),
      )
    }
    const generation = queue.generation,
      key = `${generation}:${environment.name}:${imageRevision(environment.image)}`
    const existing = queue.inflight.get(key)
    if (existing) return existing
    if ([...queue.inflight.keys()].some((k) => k.startsWith(`${generation}:`)))
      return Promise.reject(
        new RuntimeError('Room is starting with a different environment revision', 409),
      )
    const check = () => {
      if (queue.generation !== generation)
        throw new RuntimeError('Room startup cancelled by deletion', 409)
    }
    const task = this.enqueue(id, queue, () => this.ensureWorkload(id, environment, check)).finally(
      () => queue.inflight.delete(key),
    )
    queue.inflight.set(key, task)
    return task
  }
  remove(id: string, permanent = false): Promise<void> {
    let queue: RoomQueue
    try {
      queue = this.queue(id)
    } catch (err) {
      return Promise.reject(err)
    }
    queue.generation++
    return this.enqueue(id, queue, () => permanent ? this.retireWorkload(id) : this.deleteWorkload(id))
  }
  private async get(kind: 'pods' | 'services', id: string): Promise<KubeObject | null> {
    try {
      return await this.options.kube.request<KubeObject>(
        'GET',
        `${this.root}/${kind}/${roomName(id)}`,
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
  ): Promise<KubeObject> {
    let created: KubeObject
    try {
      created = await this.options.kube.request<KubeObject>('POST', `${this.root}/${kind}`, body)
    } catch (err) {
      if (!(err instanceof KubernetesError && err.status === 409)) throw err
      const found = await this.get(kind, id)
      if (!found) throw err
      created = found
    }
    assertOwned(created, id)
    return created
  }
  private pod(id: string, environment: RuntimeEnvironment, token: string): KubeObject {
    const { config } = this.options
    const revision = imageRevision(environment.image)
    const cpu = config.cpu.endsWith('m')
      ? Number(config.cpu.slice(0, -1)) / 1000
      : Number(config.cpu)
    const limits: Record<string, string | number> = {
      cpu: config.cpu,
      memory: config.memory,
      'ephemeral-storage': config.ephemeral,
      ...(environment.gpu ? { 'nvidia.com/gpu': 1 } : {}),
    }
    const spec = {
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
      ...(environment.gpu ? { runtimeClassName: 'nvidia' } : {}),
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
            ...['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'].map((name) => ({
              name,
              value: String(Math.max(1, Math.floor(cpu))),
            })),
          ],
          resources: { requests: { ...limits }, limits },
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
        },
      ],
      volumes: [
        { name: 'workspace', persistentVolumeClaim: { claimName: config.workspaceClaim } },
        { name: 'tmp', emptyDir: { sizeLimit: config.ephemeral } },
        { name: 'home', emptyDir: { sizeLimit: config.ephemeral } },
        {
          name: 'shm',
          emptyDir: { medium: 'Memory', sizeLimit: environment.gpu ? '1Gi' : '64Mi' },
        },
      ],
    }
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: roomName(id),
        labels: { ...labels(id), 'colloq.dev/environment': environment.name },
        annotations: {
          'colloq.dev/session-id': id,
          'colloq.dev/revision': revision,
          'colloq.dev/template-hash': hash(JSON.stringify(spec)),
        },
      },
      spec,
    }
  }
  private service(id: string): KubeObject {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: roomName(id),
        labels: labels(id),
        annotations: { 'colloq.dev/session-id': id },
      },
      spec: {
        type: 'ClusterIP',
        selector: labels(id),
        ports: [{ name: 'jupyter', protocol: 'TCP', port: 8888, targetPort: 8888 }],
      },
    }
  }
  private async ensureWorkload(
    id: string,
    environment: RuntimeEnvironment,
    check: () => void,
  ): Promise<RuntimeEndpoint> {
    check()
    const token = createHmac('sha256', this.options.roomSecret())
      .update(`jupyter:${id}`)
      .digest('hex')
    const desired = this.pod(id, environment, token),
      desiredService = this.service(id)
    let [pod, service] = await Promise.all([this.get('pods', id), this.get('services', id)])
    check()
    if (pod) assertOwned(pod, id)
    if (service) assertOwned(service, id)
    if (retired(service)) throw new RuntimeError('Room has been permanently retired', 410)
    // Never silently route Jupyter through an altered externally exposed service.
    if (
      service &&
      (!serviceMatches(service.spec, desiredService.spec) ||
        service.spec.externalIPs?.length ||
        service.spec.externalName)
    )
      throw new RuntimeError('Managed room Service does not match the private service policy', 409)
    if (
      pod &&
      (pod.metadata.deletionTimestamp ||
        podPhase(pod) === 'failed' ||
        pod.metadata.annotations?.['colloq.dev/template-hash'] !==
          desired.metadata.annotations?.['colloq.dev/template-hash'] ||
        !podMatches(pod.spec, desired.spec))
    ) {
      await this.deleteWorkload(id)
      check()
      pod = null
      service = null
    }
    if (!service) {
      service = await this.create('services', id, desiredService)
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
      pod = await this.create('pods', id, desired)
      check()
      if (!podMatches(pod.spec, desired.spec))
        throw new RuntimeError('Managed Pod does not match the requested workload policy', 409)
    }
    const endpoint: RuntimeEndpoint = {
      url: `http://${roomName(id)}.${this.options.config.namespace}.svc:8888`,
      token,
      instanceId: pod.metadata.uid!,
      environment: environment.name,
      revision: imageRevision(environment.image),
    }
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120000)
    let reason = 'Pending'
    while (Date.now() < deadline) {
      check()
      const current = await this.get('pods', id)
      check()
      if (!current || current.metadata.uid !== endpoint.instanceId)
        throw new RuntimeError('Room Pod disappeared or was replaced during startup', 409)
      assertOwned(current, id)
      const phase = podPhase(current)
      reason = podReason(current) ?? phase
      if (phase === 'failed' || phase === 'terminating')
        throw new RuntimeError(`Room Pod cannot start: ${reason}`)
      if (phase === 'ready') {
        const ready = await (this.options.probe ?? probeJupyter)(endpoint)
        check()
        if (ready) return endpoint
        reason = 'Jupyter did not accept an authenticated readiness request'
      }
      await delay(this.options.pollMs ?? 500)
    }
    throw new RuntimeError(`Room startup timed out: ${reason}`)
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
    await this.deleteWorkload(id)
  }
  private async deleteWorkload(id: string): Promise<void> {
    const [pod, service] = await Promise.all([this.get('pods', id), this.get('services', id)])
    for (const object of [pod, service]) if (object) assertOwned(object, id)
    for (const [kind, object] of [
      ['services', service],
      ['pods', pod],
    ] as const) {
      if (!object || (kind === 'services' && retired(object))) continue
      await this.deleteResource(kind,id,object)
    }
  }
  private async deleteResource(kind: 'pods' | 'services', id: string, object: KubeObject): Promise<void> {
      if (!object.metadata.deletionTimestamp) {
        try {
          await this.options.kube.request('DELETE', `${this.root}/${kind}/${roomName(id)}`, {
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
        const current = await this.get(kind, id)
        if (!current) break
        assertOwned(current, id)
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
      if (!id || !isRuntimeSessionId(id) || !owned(pod, id) || !pod.metadata.uid) return []
      return [
        {
          sessionId: id,
          instanceId: pod.metadata.uid,
          phase: podPhase(pod),
          environment: pod.metadata.labels?.['colloq.dev/environment'] ?? '',
          revision: pod.metadata.annotations?.['colloq.dev/revision'] ?? '',
          ...(podReason(pod) ? { reason: podReason(pod) } : {}),
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
      return { ok: true, reason: null }
    } catch (err) {
      return {
        ok: false,
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
