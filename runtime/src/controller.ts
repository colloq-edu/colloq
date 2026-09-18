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
  type RuntimeResizeRequest,
  type RuntimeResizeResult,
  type RuntimeRoom,
  type RuntimeStartFailure,
  type RuntimeUnschedulable,
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
    /** Почему подъём не вышел — словом, которое веб переводит человеку (см. http.ts). */
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
  /** Сколько ждать, пока kubelet переставит память и ядра живому Pod. */
  resizeTimeoutMs?: number
  /** Сколько Pod может стоять с отказом планировщика, пока подъём не сдастся. */
  unschedulableGraceMs?: number
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
const MiB = 1024 ** 2
const KERNEL = 'kernel'
const RESIZE_PATCH = 'application/strategic-merge-patch+json'
/** Что поменять живому Pod: память в MiB, ядра — количеством Kubernetes («2», «1500m»). */
interface ResizeTarget {
  memoryMb?: number
  cpu?: string
}
/** Память контейнера kernel (limits) в MiB — из spec или из status. */
function memoryOf(resources: any): number | undefined {
  const bytes = resourceQuantity('memory', resources?.limits?.memory)
  return typeof bytes === 'number' && bytes > 0 ? Math.floor(bytes / MiB) : undefined
}
/** Ядра контейнера kernel (limits) в милликорах — из spec или из status. */
function milliCpuOf(resources: any): number | undefined {
  const milli = resourceQuantity('cpu', resources?.limits?.cpu)
  return typeof milli === 'number' && milli > 0 ? milli : undefined
}
const kernelOf = (containers: unknown): any =>
  Array.isArray(containers) ? containers.find((c: any) => c?.name === KERNEL) : undefined
/**
 * Spec без памяти и ядер контейнера kernel.
 *
 * Это ровно те поля Pod, которые брокер меняет у ЖИВОГО Pod (подресурс
 * resize). Хэш шаблона и сравнение для изменения на месте считаются без них:
 * иначе первое же изменение лимита делало бы Pod «чужим», и следующий ensure
 * сносил бы его вместе со всеми переменными семинара — ровно то, ради чего
 * лимит меняют на месте, а не пересозданием. С ядрами так и было до 18.09:
 * они стояли в хэше, и смена числа в форме стоила комнате её Python при
 * следующем подъёме — например, когда кто-то открывал терминал.
 */
function withoutResizable(input: Record<string, any>): Record<string, any> {
  const spec = structuredClone(input)
  const kernel = kernelOf(spec.containers)
  for (const group of ['requests', 'limits'])
    for (const name of ['memory', 'cpu'])
      if (kernel?.resources?.[group]) delete kernel.resources[group][name]
  return spec
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
    // Изменение на месте без перезапуска — умолчание API; явная запись и
    // подставленная сервером — одно и то же, и ни та ни другая не повод менять Pod.
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
/**
 * Тот же Pod, только с другой памятью или ядрами — его меняют на месте, а не сносят.
 *
 * Всё остальное сравнивается так же строго, как в podMatches: подменённая
 * команда или монтирование по-прежнему означают замену. Память и ядра обязаны
 * быть разборчивыми и одинаковыми в requests и limits — иначе Pod уже не
 * Guaranteed и не тот, что создавал брокер.
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
/** Условия, которыми kubelet (1.33+) говорит, что изменение ещё не доехало. */
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
/** Условие PodScheduled=False: Pod ещё не поставлен на узел, и планировщик сказал почему. */
const notScheduled = (pod: KubeObject) =>
  pod.status?.conditions?.find((c: any) => c?.type === 'PodScheduled' && c?.status === 'False')
function podReason(pod: KubeObject): string | undefined {
  const state = pod.status?.containerStatuses?.find(
    (c: any) => c.state?.waiting || c.state?.terminated,
  )?.state
  // Последним — причина планировщика (`Unschedulable`): у Pod, которому нет
  // места на узле, нет ни контейнеров, ни status.reason, и перепись комнат
  // вместе с таймаутом говорили про него одно «pending».
  const reason =
    state?.waiting?.reason ?? state?.terminated?.reason ?? pod.status?.reason ?? notScheduled(pod)?.reason
  return typeof reason === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(reason) ? reason : undefined
}
/** Имена ресурсов Kubernetes → слово протокола; порядок — порядок важности. */
const SHORTAGES: ReadonlyArray<readonly [string, RuntimeUnschedulable]> = [
  // Видеокарта первой: её не поделить, и совет «уменьшите память» комнате,
  // которой не досталось карты, ничего бы не дал.
  ['nvidia.com/gpu', 'gpu'],
  ['memory', 'memory'],
  ['cpu', 'cpu'],
]
/**
 * Чего узлу не хватило, чтобы поставить Pod, — или ничего, если Pod уже на узле.
 *
 * Из сообщения планировщика берутся только имена ресурсов после «Insufficient»:
 * сам текст говорит про узлы и чужие Pod кластера, а в ответ брокера и дальше
 * к людям из тела API выходит лишь имя ресурса (то же правило, что у
 * KubernetesError.insufficient). Нехватки нет, а отказ есть — `other`.
 */
function unschedulable(pod: KubeObject): RuntimeUnschedulable | undefined {
  const condition = notScheduled(pod)
  if (pod.spec?.nodeName || condition?.reason !== 'Unschedulable') return undefined
  const message = typeof condition.message === 'string' ? condition.message.slice(0, 4096) : ''
  const lacking = new Set(
    // Имя кончается буквой или цифрой: точка после него — конец фразы планировщика.
    [...message.matchAll(/\bInsufficient ([a-z0-9](?:[a-z0-9./-]{0,61}[a-z0-9])?)/g)].map((match) => match[1]),
  )
  return SHORTAGES.find(([name]) => lacking.has(name))?.[1] ?? 'other'
}
/** Сколько ждать Pod, которому планировщик отказал, прежде чем сказать об этом. */
const UNSCHEDULABLE_GRACE_MS = 20000

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
    let cpus: number | undefined, memoryMb: number | undefined
    try {
      const request = parseRuntimeEnsureRequest(intent)
      cpus = request.cpus
      /*
       * Выше потолка — не отказ, а потолок. Отказ здесь значил бы комнату без
       * Python вовсе: число записано в строке семинара, и каждый следующий
       * запуск ячейки получал бы тот же 400. Веб проверяет по потолку сам (он
       * его читает из /v1/health), так что сюда такое доезжает только мимо
       * формы; а что Pod получил на самом деле, перепись комнат скажет из status.
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
      queue = this.queue(id)
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
     * Другие память или ядра при том же окружении — не конфликт, а очередь.
     *
     * Преподаватель поднимает память, пока Pod комнаты ещё встаёт (после OOM
     * все жмут Run разом), и следующий Run приходит уже с новым числом. Отказ
     * 409 «другая ревизия» здесь отнимал бы у студента запуск ни за что: такой
     * ensure встаёт за текущим и, дождавшись Pod, меняет ему ресурсы на месте.
     */
    if ([...queue.inflight.keys()].some((k) => k.startsWith(`${generation}:`) && !k.startsWith(workload)))
      return Promise.reject(
        new RuntimeError('Room is starting with a different environment revision', 409),
      )
    const check = () => {
      if (queue.generation !== generation)
        throw new RuntimeError('Room startup cancelled by deletion', 409)
    }
    const task = this.enqueue(id, queue, () =>
      this.ensureWorkload(id, environment, check, cpus, memoryMb),
    ).finally(
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
  /**
   * Поднять или опустить память и ядра ЖИВОЙ комнате, не трогая её Python.
   *
   * Это та же ручка, что `docker update --memory`/`--cpus` на машине
   * разработчика: преподаватель, чьё ядро только что убили по памяти или
   * которому мало ядер на обучении, добавляет их и запускает ячейку заново.
   * Kubernetes 1.33+ умеет менять cgroup работающего контейнера через
   * подресурс `pods/resize`; Pod и его UID остаются прежними.
   *
   * Pod нет — не ошибка и не повод его поднимать: число уже лежит в строке
   * семинара, и следующий ensure создаст Pod сразу с ним. Встаёт в ту же
   * очередь комнаты, что ensure и DELETE, чтобы не менять Pod, который прямо
   * сейчас поднимают или сносят.
   */
  resize(id: string, intent: RuntimeResizeRequest): Promise<RuntimeResizeResult> {
    let queue: RoomQueue
    const target: ResizeTarget = {}
    try {
      const request = parseRuntimeResizeRequest(intent)
      if (request.memoryMb !== undefined) {
        target.memoryMb = request.memoryMb ?? this.defaultMemoryMb()
        // Здесь, в отличие от ensure, выше потолка — отказ: живой комнате ничего
        // не сломается, а вызывающий должен узнать, что числа не будет.
        if (target.memoryMb > this.maxMemoryMb())
          throw new RuntimeError(
            `Room memory limit exceeds the runtime ceiling of ${this.maxMemoryMb()} MiB`,
            400,
          )
      }
      // `null` — умолчание брокера той же строкой, что у нового Pod, хоть бы и
      // дробной («1500m»): сброс не должен давать Pod, которого ensure не создаст.
      if (request.cpus !== undefined)
        target.cpu = request.cpus === null ? this.options.config.cpu : String(request.cpus)
      queue = this.queue(id)
    } catch (err) {
      return Promise.reject(
        err instanceof RuntimeError
          ? err
          : new RuntimeError(err instanceof Error ? err.message : 'Invalid resize intent', 400),
      )
    }
    return this.enqueue(id, queue, () => this.resizeWorkload(id, target))
  }
  private defaultMemoryMb(): number {
    return Math.floor(Number(resourceQuantity('memory', this.options.config.memory)) / MiB)
  }
  private maxMemoryMb(): number {
    return this.options.config.maxMemoryMb ?? RUNTIME_MEMORY_MAX_MB
  }
  /**
   * Патч в подресурс resize — только память и ядра, только контейнер kernel, и
   * только те из двух, что просили: память, которую не трогали, не переписывается
   * числом, прочитанным секунду назад.
   */
  private patchResources(id: string, pod: KubeObject, target: ResizeTarget): Promise<KubeObject> {
    const values: Record<string, string> = {
      ...(target.memoryMb !== undefined ? { memory: `${target.memoryMb}Mi` } : {}),
      ...(target.cpu !== undefined ? { cpu: target.cpu } : {}),
    }
    return this.options.kube.request<KubeObject>(
      'PATCH',
      `${this.root}/pods/${roomName(id)}/resize`,
      {
        // resourceVersion — предусловие: Pod, который успели заменить или
        // изменить между чтением и патчем, получит 409, а не чужие лимиты.
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
  private async resizeWorkload(id: string, target: ResizeTarget): Promise<RuntimeResizeResult> {
    const wantCpu = target.cpu === undefined ? undefined : milliCpuOf({ limits: { cpu: target.cpu } })
    let uid: string | undefined
    // Что у Pod есть на деле — к этому spec возвращается, если узлу столько не дать.
    let before: ResizeTarget = {}
    for (let attempt = 0; ; attempt++) {
      const pod = await this.get('pods', id)
      if (!pod || pod.metadata.deletionTimestamp || podPhase(pod) === 'failed')
        return { outcome: 'absent' }
      assertOwned(pod, id)
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
      try {
        await this.patchResources(id, pod, target)
        break
      } catch (err) {
        // Kubelet обновил status между чтением и патчем — перечитать и повторить.
        if (err instanceof KubernetesError && err.status === 409 && attempt < 2) continue
        if (err instanceof KubernetesError && err.status === 404)
          throw new RuntimeError('Kubernetes does not support in-place Pod resize (1.33+ required)', 501)
        // API 1.35+ отвергает невыполнимое изменение сразу, не трогая spec
        // (на k3s 1.36 проверено и для памяти, и для ядер).
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
      const pod = await this.get('pods', id)
      if (!pod || pod.metadata.uid !== uid || pod.metadata.deletionTimestamp)
        return { outcome: 'absent' }
      assertOwned(pod, id)
      const status = kernelOf(pod.status?.containerStatuses)?.resources
      const actualMemory = memoryOf(status)
      const actualCpu = milliCpuOf(status)
      const pending = resizeCondition(pod, 'PodResizePending')
      if (pending?.reason === 'Infeasible') {
        /*
         * Узлу столько не дать никогда. Оставить в spec невыполнимое число
         * нельзя: следующий Pod этой комнаты, созданный по нему же, повис бы в
         * Pending навсегда. Возвращаем spec к тому, что у Pod есть, и говорим
         * вызывающему честное «нет».
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
          await this.patchResources(id, pod, revert).catch(() => undefined)
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
  private pod(
    id: string,
    environment: RuntimeEnvironment,
    token: string,
    cpus?: number,
    memoryMb?: number,
  ): KubeObject {
    const { config } = this.options
    const revision = imageRevision(environment.image)
    const quota = cpus === undefined ? config.cpu : String(cpus)
    const limits: Record<string, string | number> = {
      cpu: quota,
      memory: memoryMb === undefined ? config.memory : `${memoryMb}Mi`,
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
            /*
             * Потоки численных библиотек — по ядрам Pod, а не по ядрам узла
             * (их `os.cpu_count()` видит внутри), иначе numpy поднимает десятки
             * потоков на два ядра и дерётся за них. Число берёт kubelet из
             * limits.cpu при старте контейнера (Downward API), а не брокер
             * строкой: так шаблон Pod не зависит от ядер, и смена ядер на месте
             * не делает Pod «чужим» для следующего ensure. Округление здесь
             * вверх (1500m → 2) — так Kubernetes считает делитель 1; целые ядра
             * комнаты выходят ровно.
             *
             * Живому Python это число уже не поменять ничем: переменные
             * окружения читаются при старте процесса, и даже перезапуск ядра
             * Jupyter наследует их от сервера в том же контейнере. Новое число
             * потоков получит следующий Pod комнаты — так же, как в docker,
             * где их задаёт `docker run`.
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
          // Память и ядра меняют живому Pod (см. resize): перезапуск контейнера
          // при этом — потеря всех переменных семинара, поэтому без него.
          resizePolicy: [
            { resourceName: 'memory', restartPolicy: 'NotRequired' },
            { resourceName: 'cpu', restartPolicy: 'NotRequired' },
          ],
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
          'colloq.dev/template-hash': hash(JSON.stringify(withoutResizable(spec))),
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
    cpus?: number,
    memoryMb?: number,
  ): Promise<RuntimeEndpoint> {
    check()
    const token = createHmac('sha256', this.options.roomSecret())
      .update(`jupyter:${id}`)
      .digest('hex')
    const desired = this.pod(id, environment, token, cpus, memoryMb),
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
    /*
     * Живой Pod, у которого отличаются одни память и ядра, — это изменение
     * лимита, не доехавшее раньше (брокер лежал, патч отказал, веб старее
     * брокера). Его меняют на месте: сносить Pod ради лимита значит отнять у
     * семинара все переменные ровно тогда, когда ему добавили, чтобы их не
     * потерять.
     */
    const resize =
      pod &&
      !pod.metadata.deletionTimestamp &&
      podPhase(pod) !== 'failed' &&
      pod.metadata.annotations?.['colloq.dev/template-hash'] ===
        desired.metadata.annotations?.['colloq.dev/template-hash'] &&
      !podMatches(pod.spec, desired.spec) &&
      onlyResizableDiffers(pod.spec, desired.spec)
    if (
      pod &&
      !resize &&
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
    } else if (resize) {
      // Не дожидаясь kubelet: комнате нужен Python, а не отчёт о cgroup. Не
      // вышло (узлу сейчас нечем, API старый) — Pod остаётся прежним и рабочим,
      // а перепись комнат покажет те память и ядра, что у него есть на деле.
      const resources = kernelOf(desired.spec.containers).resources
      const target: ResizeTarget = {
        memoryMb: memoryOf(resources)!,
        cpu: String(resources.limits.cpu),
      }
      await this.patchResources(id, pod, target).catch((err) =>
        console.warn(
          `[runtime] in-place resize to ${target.memoryMb}Mi/${target.cpu} CPU failed: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
        ),
      )
      check()
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
    // Pod, которому планировщик отказал, и с какого момента он так стоит.
    let refused: { pod: KubeObject; lacking: RuntimeUnschedulable; since: number } | undefined
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
      /*
       * Отказ планировщика — не повод ждать две минуты до таймаута.
       *
       * Память комнаты зарезервирована целиком (requests = limits), и на
       * занятом узле Pod встаёт в Pending с «Insufficient memory» и стоит там,
       * пока кто-то не освободит место. Короткий отказ бывает и у здоровой
       * комнаты — соседняя только что закрылась, и её Pod ещё гасится, — а
       * планировщик сам повторит, как только тот исчезнет. Поэтому сначала
       * пауза, и только отказ, переживший её, становится ответом со словом.
       */
      const lacking = phase === 'pending' ? unschedulable(current) : undefined
      refused = lacking ? { pod: current, lacking, since: refused?.since ?? Date.now() } : undefined
      if (refused && Date.now() - refused.since >= (this.options.unschedulableGraceMs ?? UNSCHEDULABLE_GRACE_MS))
        return this.refuseUnschedulable(id, refused.pod, refused.lacking)
      if (phase === 'ready') {
        const ready = await (this.options.probe ?? probeJupyter)(endpoint)
        check()
        if (ready) return endpoint
        reason = 'Jupyter did not accept an authenticated readiness request'
      }
      await delay(this.options.pollMs ?? 500)
    }
    // Срок вышел раньше паузы (подъём короче её): причина та же, и сказать её
    // словом честнее, чем «timed out: Unschedulable».
    if (refused) return this.refuseUnschedulable(id, refused.pod, refused.lacking)
    throw new RuntimeError(`Room startup timed out: ${reason}`)
  }
  /**
   * Pod, которому на узле нет места, — отказ со словом и числами, а не таймаут.
   *
   * Сам Pod удаляется. Он ни разу не стоял на узле, Python в нём не было, и
   * терять нечего; а оставшись в Pending, он держал бы старые числа: учёт
   * ресурсов считал бы его память обещанной, а следующий подъём после того,
   * как преподаватель уменьшил память комнаты, менял бы её Pod-у, которого нет
   * ни на одном узле. Следующий ensure создаст новый — уже с тем, что в форме.
   */
  private async refuseUnschedulable(
    id: string,
    pod: KubeObject,
    lacking: RuntimeUnschedulable,
  ): Promise<never> {
    const resources = kernelOf(pod.spec.containers)?.resources
    const memoryMb = memoryOf(resources)
    const milli = resourceQuantity('cpu', resources?.limits?.cpu)
    await this.deleteResource('pods', id, pod).catch((err) =>
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
      // Что у Pod есть, а не что ему записано: после изменения на месте spec
      // уже новый, а kubelet мог ещё не успеть или узлу было нечем (Deferred).
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
      }
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
