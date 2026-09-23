import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { resolveRuntimeEnvironment, type RuntimeCatalog } from '../../shared/runtime.js'
import {
  COMPETITION_JOB_ID, parseCompetitionJobIntent,
  type CompetitionJobCollection, type CompetitionJobIntent, type CompetitionJobKind,
  type CompetitionJobProgress, type CompetitionJobStatus,
} from '../../shared/competition-runtime.js'
import { RuntimeError } from './controller.js'
import { KubernetesError, type KubernetesClient, type KubeObject } from './kubernetes.js'

const MANAGER = 'colloq-runtime'
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const ROOT = (namespace: string) => `/api/v1/namespaces/${namespace}`
const jobName = (id: string) => `colloq-job-${id}`
const proxyName = (id: string) => `colloq-proxy-${id}`
const iso = (time: number) => new Date(time).toISOString()

export interface CompetitionJobConfig {
  namespace: string
  dataClaim: string
  exporterImage: string
  instanceId: string
  imagePullSecret?: string
}
interface Options {
  kube: KubernetesClient
  config: CompetitionJobConfig
  catalog: () => RuntimeCatalog
  secret: () => string
  exporter?: (url: string, token: string, method: 'GET' | 'POST', payload?: unknown, timeoutMs?: number) => Promise<unknown>
  now?: () => number
  proxyStartupMs?: number
  pollMs?: number
}
const env = (name: string, value: string) => ({ name, value })
const mount = (name: string, mountPath: string, subPath?: string, readOnly?: boolean) => ({ name, mountPath, ...(subPath ? { subPath } : {}), ...(readOnly ? { readOnly: true } : {}) })
const pvc = (name: string, claimName: string) => ({ name, persistentVolumeClaim: { claimName } })
const memory = (size: number) => ({ medium: 'Memory', sizeLimit: `${size}Mi` })
const security = { runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const MiB = 1024 * 1024
const OFFLINE_PROBE = `import socket,sys,time
started=time.monotonic()
denied=0
while True:
    try:
        connection=socket.create_connection(('1.1.1.1',443),1)
    except OSError:
        denied+=1
        if denied>=3:
            break
    else:
        connection.close()
        denied=0
    if time.monotonic()-started>=30:
        sys.exit(41)
    time.sleep(1)
`
function exportBudget(kind: CompetitionJobKind, target: number): number {
  if (kind === 'notebook') return Math.min(2 * target, 256 * MiB)
  if (kind === 'metric') return Math.min(2 * target, 16 * MiB)
  if (kind === 'resolve') return Math.min(target + 8 * MiB, 512 * MiB)
  return Math.min(target, 2 * MiB)
}

export class CompetitionJobs {
  private readonly root: string
  private readonly now: () => number
  private readonly exporter: NonNullable<Options['exporter']>
  private readonly collected = new Set<string>()
  private readonly starts = new Map<string, { intent: string; promise: Promise<CompetitionJobStatus> }>()
  private readonly cancelled = new Set<string>()
  constructor(private readonly options: Options) {
    this.root = ROOT(options.config.namespace)
    this.now = options.now ?? Date.now
    this.exporter = options.exporter ?? exportRequest
  }
  private configured(): void {
    const { exporterImage, instanceId, dataClaim } = this.options.config
    if (!IMAGE.test(exporterImage) || !/^[a-z0-9-]{1,40}$/.test(instanceId) || !/^[a-z0-9-]{1,63}$/.test(dataClaim))
      throw new RuntimeError('Competition broker is not configured', 503)
  }
  async health(): Promise<import('../../shared/capabilities.js').CompetitionCapabilities> {
    const unavailable = (code: string, reason: string) => ({ available: false, code, reason })
    const available = { available: true, code: 'ready', reason: null }
    try { this.configured() }
    catch { const state = unavailable('broker_unavailable', 'Competition broker configuration is incomplete'); return { execution: state, preparation: state } }
    let hasImage = false
    try { hasImage = this.options.catalog().environments.some(row => IMAGE.test(row.image) && !row.gpu) } catch { /* reported below */ }
    if (!hasImage) {
      const state = unavailable('image_unavailable', 'No pinned competition registry image is available')
      return { execution: state, preparation: state }
    }
    try { await this.options.kube.request('GET', `${this.root}/persistentvolumeclaims/${this.options.config.dataClaim}`) }
    catch { const state = unavailable('storage_unavailable', 'Competition data claim is unavailable'); return { execution: state, preparation: state } }
    const policy = async (name: string) => this.options.kube.request('GET', `/apis/networking.k8s.io/v1/namespaces/${this.options.config.namespace}/networkpolicies/${name}`)
    try { await policy('competition-job-isolation') }
    catch { const state = unavailable('isolation_unavailable', 'Competition job network isolation is unavailable'); return { execution: state, preparation: state } }
    let preparation: import('../../shared/capabilities.js').RuntimeCapability = available
    try { await policy('competition-resolver-isolation'); await policy('competition-proxy-isolation');
      await this.options.kube.request('GET', `${this.root}/services?limit=1`) }
    catch { preparation = unavailable('preparation_unavailable', 'Dependency resolver proxy isolation is unavailable') }
    return { execution: available, preparation }
  }
  private labels(jobId: string, role: string) {
    return { 'app.kubernetes.io/managed-by': MANAGER, 'colloq.dev/instance': this.options.config.instanceId,
      'colloq.dev/job': jobId, 'colloq.dev/role': role }
  }
  private annotations(intent: CompetitionJobIntent) {
    return { 'colloq.dev/intent': JSON.stringify(intent), 'colloq.dev/started-at': String(this.now()) }
  }
  private token(jobId: string) { return createHmac('sha256', this.options.secret()).update(`competition-export:${jobId}`).digest('hex') }
  private destination(intent: CompetitionJobIntent): string {
    if (intent.kind === 'inventory') return `dependencies/inventory/${intent.jobId}`
    if (intent.kind === 'resolve' || intent.kind === 'verify') return `dependencies/staging/${intent.preparationId}`
    const attempt = `competitions/${intent.competitionId}/s/${intent.submissionId}/attempts/${intent.attemptId}`
    return `${attempt}/${intent.kind === 'metric' ? 'score-out' : 'result'}`
  }
  private main(intent: CompetitionJobIntent, image: string) {
    const base = `competitions/${intent.competitionId}/s/${intent.submissionId}`
    const attempt = `${base}/attempts/${intent.attemptId}`
    const input = intent.kind === 'notebook'
      ? [mount('data', '/data', `competitions/${intent.competitionId}/data`, true), mount('data', '/submission', `${base}/in`, true),
          ...(intent.bundleId ? [mount('data', '/deps', `dependencies/bundles/${intent.bundleId}`, true)] : [])]
      : intent.kind === 'metric'
        ? [mount('data', '/secret', `${attempt}/secret`, true), mount('data', '/submission', `${attempt}/score`, true), mount('data', '/config', `${attempt}/score-config`, true)]
        : intent.kind === 'resolve' || intent.kind === 'verify'
          ? [mount('data', '/input', `dependencies/staging/${intent.preparationId}/input`, true),
              ...(intent.kind === 'verify' ? [mount('data', '/wheels', `dependencies/staging/${intent.preparationId}/wheels`, true)] : [mount('out', '/wheels', 'wheels')])]
          : []
    const script = intent.kind === 'notebook' ? '/harness/run_notebook.py'
      : intent.kind === 'metric' ? '/harness/broker_score.py'
        : intent.kind === 'inventory' ? '/harness/broker_inventory.py'
          : `/harness/broker_prepare.py ${intent.kind}`
    // Entrant stdout can be unbounded. Reports live in the bounded memory volume.
    const command = ['sh', '-c', `exec python -I -u ${script} >/dev/null 2>&1`]
    return { name: 'main', image, imagePullPolicy: 'IfNotPresent', command,
      workingDir: '/work', securityContext: security,
      resources: { requests: { cpu: `${intent.limits.cpus}`, memory: `${intent.limits.memoryMb}Mi`, 'ephemeral-storage': '64Mi' },
        limits: { cpu: `${intent.limits.cpus}`, memory: `${intent.limits.memoryMb}Mi`, 'ephemeral-storage': '256Mi' } },
      env: [env('HOME', '/tmp/home'), env('PYTHONDONTWRITEBYTECODE', '1'), env('PYTHONNOUSERSITE', '1'),
        env('PYTHONUNBUFFERED', '1'), env('PIP_CONFIG_FILE', '/dev/null'),
        env('OMP_NUM_THREADS', String(intent.limits.cpus)), env('MKL_NUM_THREADS', String(intent.limits.cpus)),
        env('OPENBLAS_NUM_THREADS', String(intent.limits.cpus)), env('NUMEXPR_NUM_THREADS', String(intent.limits.cpus)),
        env('COMP_ATTEMPT_ID', intent.attemptId ?? intent.jobId), env('COMP_RESULT', '/out'), env('COMP_OUT', intent.kind === 'metric' ? '/out' : '/work'),
        env('COMP_TARGET', 'submission.csv'), env('COMP_MAX_TARGET_BYTES', String(intent.limits.targetBytes)),
        env('COMP_CELL_TIMEOUT_SEC', String(intent.limits.wallSeconds)),
        ...(intent.bundleId ? [env('COMP_DEPENDENCIES', '/deps')] : []),
        ...(intent.kind === 'resolve' ? [env('HTTPS_PROXY', `http://${proxyName(intent.jobId)}:3128`), env('HTTP_PROXY', `http://${proxyName(intent.jobId)}:3128`),
          env('https_proxy', `http://${proxyName(intent.jobId)}:3128`), env('http_proxy', `http://${proxyName(intent.jobId)}:3128`),
          env('NO_PROXY', ''), env('no_proxy', ''), env('ALL_PROXY', ''), env('all_proxy', '')] : [])],
      volumeMounts: [mount('out', '/out'), mount('work', '/work'), mount('tmp', '/tmp'),
        mount('data', '/harness', intent.kind === 'notebook' || intent.kind === 'metric' ? 'competitions/harness' : 'dependencies/harness', true), ...input],
    }
  }
  private pod(intent: CompetitionJobIntent, image: string): KubeObject {
    const role = intent.kind === 'resolve' ? 'competition-resolver' : 'competition-job'
    return { apiVersion: 'v1', kind: 'Pod', metadata: { name: jobName(intent.jobId), labels: this.labels(intent.jobId, role), annotations: this.annotations(intent) },
      spec: { restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
        terminationGracePeriodSeconds: 5, activeDeadlineSeconds: intent.limits.wallSeconds + 90,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
        ...(this.options.config.imagePullSecret ? { imagePullSecrets: [{ name: this.options.config.imagePullSecret }] } : {}),
        ...(intent.kind === 'resolve' ? {} : { initContainers: [{ name: 'egress-probe', image,
          imagePullPolicy: 'IfNotPresent', command: ['python', '-I', '-c', OFFLINE_PROBE],
          securityContext: security,
          resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '250m', memory: '128Mi', 'ephemeral-storage': '16Mi' } },
        }] }),
        volumes: [pvc('data', this.options.config.dataClaim), pvc('destination', this.options.config.dataClaim),
          { name: 'out', emptyDir: memory(intent.limits.tmpfsMb) }, { name: 'work', emptyDir: memory(intent.limits.tmpfsMb) },
          { name: 'tmp', emptyDir: memory(Math.min(intent.limits.tmpfsMb, 256)) }],
        containers: [this.main(intent, image), { name: 'exporter', image: this.options.config.exporterImage,
          imagePullPolicy: 'IfNotPresent', command: ['node', '/app/export-sidecar.js'], securityContext: security,
          resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi', 'ephemeral-storage': '64Mi' } },
          env: [env('COMP_EXPORT_TOKEN', this.token(intent.jobId)), env('COMP_EXPORT_KIND', intent.kind),
            env('COMP_EXPORT_MAX_BYTES', String(intent.limits.targetBytes))],
          ports: [{ name: 'export', containerPort: 8765, protocol: 'TCP' }],
          readinessProbe: { tcpSocket: { port: 8765 }, periodSeconds: 1, failureThreshold: 10 },
          volumeMounts: [mount('out', '/out'), mount('destination', '/result', this.destination(intent)), mount('tmp', '/tmp')],
        }],
      } }
  }
  private proxyPod(intent: CompetitionJobIntent): KubeObject {
    return { apiVersion: 'v1', kind: 'Pod', metadata: { name: proxyName(intent.jobId), labels: this.labels(intent.jobId, 'competition-proxy'), annotations: this.annotations(intent) },
      spec: { restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
        activeDeadlineSeconds: intent.limits.wallSeconds + 90, securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
        containers: [{ name: 'proxy', image: this.options.config.exporterImage, command: ['node', '/app/competition-proxy.js'],
          securityContext: security, ports: [{ containerPort: 3128, name: 'proxy' }],
          readinessProbe: { tcpSocket: { port: 3128 }, periodSeconds: 1, failureThreshold: 10 },
          resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '128Mi', 'ephemeral-storage': '32Mi' } },
          env: [env('COMP_PROXY_MAX_BYTES', String(Math.min(intent.limits.targetBytes * 3 + 32 * 1024 * 1024, 1536 * 1024 * 1024))),
            env('COMP_PROXY_WALL_SECONDS', String(intent.limits.wallSeconds))],
          volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
        }], volumes: [{ name: 'tmp', emptyDir: memory(16) }] } }
  }
  private proxyService(intent: CompetitionJobIntent): KubeObject {
    return { apiVersion: 'v1', kind: 'Service', metadata: { name: proxyName(intent.jobId), labels: this.labels(intent.jobId, 'competition-proxy'), annotations: this.annotations(intent) },
      spec: { type: 'ClusterIP', selector: this.labels(intent.jobId, 'competition-proxy'), ports: [{ name: 'proxy', port: 3128, targetPort: 3128, protocol: 'TCP' }] } }
  }
  private async awaitProxy(jobId: string): Promise<void> {
    const deadline = Date.now() + (this.options.proxyStartupMs ?? 60_000)
    for (;;) {
      const proxy = await this.get('pods', proxyName(jobId))
      if (this.cancelled.has(jobId)) throw new RuntimeError('Competition job was cancelled', 409)
      if (!proxy) throw new RuntimeError('Dependency proxy disappeared during startup', 503)
      this.assertOwned(proxy, jobId, 'competition-proxy')
      if (proxy.status?.conditions?.some((row: any) => row.type === 'Ready' && row.status === 'True')) return
      if (proxy.status?.phase === 'Failed' || proxy.status?.phase === 'Succeeded') throw new RuntimeError('Dependency proxy failed to start', 503)
      if (Date.now() >= deadline) throw new RuntimeError('Dependency proxy startup timed out', 503)
      await delay(this.options.pollMs ?? 500)
    }
  }
  private async get(kind: 'pods' | 'services', name: string): Promise<KubeObject | null> {
    try { return await this.options.kube.request<KubeObject>('GET', `${this.root}/${kind}/${name}`) }
    catch (err) { if ((err instanceof KubernetesError || typeof err === 'object') && (err as any).status === 404) return null; throw err }
  }
  private assertOwned(object: KubeObject, jobId: string, role?: string): void {
    if (!object.metadata.uid || object.metadata.labels?.['colloq.dev/job'] !== jobId ||
      object.metadata.labels?.['colloq.dev/instance'] !== this.options.config.instanceId ||
      object.metadata.labels?.['app.kubernetes.io/managed-by'] !== MANAGER ||
      (role && object.metadata.labels?.['colloq.dev/role'] !== role))
      throw new RuntimeError('Refusing resource with mismatched competition ownership', 409)
  }
  async start(jobId: string, raw: unknown): Promise<CompetitionJobStatus> {
    this.configured()
    const intent = parseCompetitionJobIntent(raw)
    if (jobId !== intent.jobId) throw new RuntimeError('Job ID does not match intent', 400)
    if (this.cancelled.has(jobId)) throw new RuntimeError('Competition job was cancelled', 409)
    const serialized = JSON.stringify(intent)
    const pending = this.starts.get(jobId)
    if (pending) {
      if (pending.intent !== serialized) throw new RuntimeError('Job ID already has another intent', 409)
      return pending.promise
    }
    const promise = this.startPrepared(intent).finally(() => {
      if (this.starts.get(jobId)?.promise === promise) this.starts.delete(jobId)
    })
    this.starts.set(jobId, { intent: serialized, promise })
    return promise
  }
  private async startPrepared(intent: CompetitionJobIntent): Promise<CompetitionJobStatus> {
    const jobId = intent.jobId
    let image: string
    let gpu = false
    try {
      const environment = resolveRuntimeEnvironment(this.options.catalog(), intent.environment, intent.revision)
      image = environment.image
      gpu = environment.gpu
    }
    catch { throw new RuntimeError('Competition image revision is unavailable in catalog', 409) }
    if (!IMAGE.test(image)) throw new RuntimeError('Competition image is not a pinned registry digest', 409)
    if (gpu) throw new RuntimeError('GPU competition images are unsupported by this executor', 409)
    const readiness = await this.health()
    const capability = intent.kind === 'resolve' || intent.kind === 'verify' ? readiness.preparation : readiness.execution
    if (!capability.available) throw new RuntimeError(capability.reason ?? 'Competition executor is unavailable', 503)
    if (this.cancelled.has(jobId)) throw new RuntimeError('Competition job was cancelled', 409)
    const previous = await this.get('pods', jobName(jobId))
    if (previous) {
      this.assertOwned(previous, jobId)
      if (previous.metadata.annotations?.['colloq.dev/intent'] !== JSON.stringify(intent)) throw new RuntimeError('Job ID already has another intent', 409)
      return this.phase(previous, intent)
    }
    if (intent.kind === 'resolve') {
      await this.cleanupProxy(jobId)
      const proxy = this.proxyPod(intent)
      const service = this.proxyService(intent)
      await this.options.kube.request('POST', `${this.root}/pods`, proxy)
      try { await this.options.kube.request('POST', `${this.root}/services`, service); await this.awaitProxy(jobId) }
      catch (err) { await this.cleanupProxy(jobId).catch(() => {}); throw err }
    }
    if (this.cancelled.has(jobId)) { if (intent.kind === 'resolve') await this.cleanupProxy(jobId); throw new RuntimeError('Competition job was cancelled', 409) }
    let created: KubeObject
    try { created = await this.options.kube.request<KubeObject>('POST', `${this.root}/pods`, this.pod(intent, image)) }
    catch (err) { if (intent.kind === 'resolve') await this.cleanupProxy(jobId).catch(() => {}); throw err }
    if (this.cancelled.has(jobId)) throw new RuntimeError('Competition job was cancelled', 409)
    return this.phase(created, intent)
  }
  private parseIntent(pod: KubeObject): CompetitionJobIntent {
    try { return parseCompetitionJobIntent(JSON.parse(pod.metadata.annotations?.['colloq.dev/intent'] ?? '')) }
    catch { throw new RuntimeError('Competition Pod has invalid intent metadata', 409) }
  }
  private phase(pod: KubeObject, intent: CompetitionJobIntent): CompetitionJobStatus {
    const startedAt = Number(pod.metadata.annotations?.['colloq.dev/started-at']) || Date.parse((pod.metadata as any).creationTimestamp ?? '') || this.now()
    const main = Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses.find((c: any) => c.name === 'main') : undefined
    const terminated = main?.state?.terminated
    const mainStartedAt = Date.parse(main?.state?.running?.startedAt ?? terminated?.startedAt ?? '')
    // Image startup and policy propagation can consume 30 seconds before main
    // starts. Kubernetes reports the main start time once it has actually run.
    const wallStartedAt = Number.isFinite(mainStartedAt) ? mainStartedAt : startedAt + (terminated ? 0 : 30_000)
    const wallDeadline = wallStartedAt + intent.limits.wallSeconds * 1000
    const timedOut = this.now() > wallDeadline
    const scheduling = Array.isArray(pod.status?.conditions) ? pod.status.conditions.find((condition: any) =>
      condition.type === 'PodScheduled' && condition.status === 'False' && condition.reason === 'Unschedulable') : undefined
    const unschedulable = this.now() > startedAt + 30_000 && !!scheduling
    const failedPod = pod.status?.phase === 'Failed'
    const preflightFailed = Array.isArray(pod.status?.initContainerStatuses) && pod.status.initContainerStatuses.some((container: any) =>
      container.name === 'egress-probe' && container.state?.terminated?.exitCode === 41)
    const statuses = Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : []
    const imageUnavailable = statuses.some((container: any) => ['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'].includes(container.state?.waiting?.reason))
    const exporterFailed = !this.collected.has(intent.jobId) && statuses.some((container: any) =>
      container.name === 'exporter' && container.state?.terminated)
    const mainFinishedAt = Date.parse(terminated?.finishedAt ?? '')
    const deadlineExceeded = pod.status?.reason === 'DeadlineExceeded' || terminated?.reason === 'DeadlineExceeded' ||
      timedOut && (!terminated || Number.isFinite(mainFinishedAt) && mainFinishedAt > wallDeadline || exporterFailed)
    const exitCode = Number.isInteger(terminated?.exitCode) ? terminated.exitCode : null
    const collected = this.collected.has(intent.jobId)
    const phase = (deadlineExceeded || (unschedulable || failedPod || preflightFailed) && !terminated ||
      imageUnavailable && !collected || exporterFailed) ? 'failed' :
      terminated ? collected ? exitCode === 0 ? 'complete' : 'failed' : 'exporting' : main?.state?.running ? 'running' : 'queued'
    const schedulerMessage = typeof scheduling?.message === 'string' ? scheduling.message : ''
    const resource = /insufficient\s+memory/i.test(schedulerMessage) ? 'memory' :
      /insufficient\s+cpu/i.test(schedulerMessage) ? 'cpu' :
        /insufficient\s+ephemeral-storage/i.test(schedulerMessage) ? 'storage' : 'other'
    const failure: CompetitionJobStatus['failure'] | undefined = deadlineExceeded ? undefined :
      unschedulable ? { code: 'unschedulable', resource } :
      imageUnavailable ? { code: 'image_unavailable' } :
        exporterFailed ? { code: 'export_failed' } :
          (failedPod && pod.status?.reason !== 'DeadlineExceeded' || preflightFailed) && !terminated ? { code: 'runtime_unavailable' } : undefined
    return { jobId: intent.jobId, kind: intent.kind, phase, startedAt,
      finishedAt: deadlineExceeded ? this.now() : terminated ? mainFinishedAt || this.now() : phase === 'failed' ? this.now() : null,
      exitCode, oomKilled: !deadlineExceeded && terminated?.reason === 'OOMKilled', progress: null,
      error: deadlineExceeded ? 'Wall time limit exceeded' : preflightFailed ? 'Network isolation preflight failed' : unschedulable ? 'Competition resources are unavailable' :
        imageUnavailable ? 'Competition image is unavailable' : exporterFailed ? 'Competition exporter failed' :
        failedPod && !terminated ? 'Competition Pod failed before execution' :
            terminated?.reason === 'OOMKilled' ? 'Memory limit exceeded' : null,
      ...(failure ? { failure } : {}) }
  }
  async status(jobId: string): Promise<CompetitionJobStatus> {
    this.configured()
    if (!COMPETITION_JOB_ID.test(jobId)) throw new RuntimeError('Invalid job ID', 400)
    const pod = await this.get('pods', jobName(jobId))
    if (!pod) throw new RuntimeError('Competition job not found', 404)
    this.assertOwned(pod, jobId)
    const intent = this.parseIntent(pod)
    const status = this.phase(pod, intent)
    if (status.phase === 'failed' && (status.exitCode === null || status.failure || status.error === 'Wall time limit exceeded')) await this.cancel(jobId)
    if ((status.phase === 'running' || status.phase === 'exporting') && typeof pod.status?.podIP === 'string' && isIP(pod.status.podIP)) {
      try {
        const host = isIP(pod.status.podIP) === 6 ? `[${pod.status.podIP}]` : pod.status.podIP
        const response = await this.exporter(`http://${host}:8765/status`, this.token(jobId), 'GET') as any
        const progress = response?.progress
        if (progress && ['dependencies', 'notebook', 'score', 'resolve', 'verify'].includes(progress.phase) &&
          Number.isSafeInteger(progress.cell) && progress.cell >= -1 && progress.cell <= 100000 &&
          Number.isSafeInteger(progress.cells) && progress.cells >= 0 && progress.cells <= 100000 &&
          Number.isSafeInteger(progress.outputBytes) && progress.outputBytes >= 0 &&
          progress.outputBytes <= Number.MAX_SAFE_INTEGER)
          status.progress = progress as CompetitionJobProgress
      } catch { /* sidecar may still be starting; Pod termination remains authoritative */ }
    }
    return status
  }
  async collect(jobId: string): Promise<CompetitionJobCollection> {
    const pod = await this.get('pods', jobName(jobId))
    if (!pod) throw new RuntimeError('Competition job not found', 404)
    this.assertOwned(pod, jobId)
    const intent = this.parseIntent(pod)
    if (this.phase(pod, intent).error === 'Wall time limit exceeded')
      throw new RuntimeError('Wall time limit exceeded', 409)
    const main = Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses.find((c: any) => c.name === 'main') : undefined
    if (!main?.state?.terminated) throw new RuntimeError('Competition job is still running', 409)
    if (typeof pod.status?.podIP !== 'string' || !isIP(pod.status.podIP)) throw new RuntimeError('Competition exporter is unavailable', 503)
    const host = isIP(pod.status.podIP) === 6 ? `[${pod.status.podIP}]` : pod.status.podIP
    const collectTimeout = Math.min(120_000, 30_000 + Math.ceil(exportBudget(intent.kind, intent.limits.targetBytes) / (4 * MiB)) * 1000)
    let response: unknown
    const readyDeadline = Date.now() + 10_000
    for (;;) {
      try {
        response = await this.exporter(`http://${host}:8765/collect`, this.token(jobId), 'POST', {
          kind: intent.kind, targetBytes: intent.limits.targetBytes,
          ...(main.state.terminated.exitCode !== 0 ? { allowIncomplete: true } : {}),
        }, collectTimeout)
        break
      } catch (error) {
        // A fast main can exit before the exporter begins listening. Do not retry
        // an HTTP refusal: it may mean the exporter rejected an unsafe file.
        if (error instanceof RuntimeError || Date.now() >= readyDeadline)
          throw error instanceof RuntimeError ? error : new RuntimeError('Competition exporter is unavailable', 503)
        await delay(250)
      }
    }
    const result = parseCollection(response, intent.kind, intent.limits.targetBytes)
    this.collected.add(jobId)
    return result
  }
  private async deleteOwned(kind: 'pods' | 'services', name: string, jobId: string) {
    const object = await this.get(kind, name)
    if (!object) return
    this.assertOwned(object, jobId)
    try {
      await this.options.kube.request('DELETE', `${this.root}/${kind}/${name}`, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: object.metadata.uid }, ...(kind === 'pods' ? { gracePeriodSeconds: 0 } : {}) })
    } catch (error) {
      if (!(error instanceof KubernetesError && error.status === 404)) throw error
    }
    const deadline = Date.now() + 20_000
    for (;;) {
      const current = await this.get(kind, name)
      if (!current) return
      this.assertOwned(current, jobId)
      if (current.metadata.uid !== object.metadata.uid) throw new RuntimeError('Competition resource was replaced during deletion', 409)
      if (Date.now() >= deadline) throw new RuntimeError('Competition resource is still terminating', 503)
      await delay(this.options.pollMs ?? 500)
    }
  }
  private async cleanupProxy(jobId: string) {
    await Promise.all([
      this.deleteOwned('services', proxyName(jobId), jobId),
      this.deleteOwned('pods', proxyName(jobId), jobId),
    ])
  }
  private async census(kind: 'pods' | 'services'): Promise<KubeObject[]> {
    const selector = encodeURIComponent(`app.kubernetes.io/managed-by=${MANAGER},colloq.dev/instance=${this.options.config.instanceId}`)
    const objects: KubeObject[] = []
    const seen = new Set<string>()
    let continuation = ''
    do {
      const page = await this.options.kube.request<{ items: KubeObject[]; metadata?: { continue?: string } }>('GET', `${this.root}/${kind}?labelSelector=${selector}&limit=100${continuation ? `&continue=${encodeURIComponent(continuation)}` : ''}`)
      if (!Array.isArray(page.items) || page.items.length > 100) throw new RuntimeError('Invalid competition resource census', 503)
      objects.push(...page.items)
      if (objects.length > 10000) throw new RuntimeError('Competition resource census exceeds capacity', 503)
      continuation = page.metadata?.continue ?? ''
      if (continuation && (continuation.length > 16384 || seen.has(continuation))) throw new RuntimeError('Invalid competition continuation', 503)
      seen.add(continuation)
    } while (continuation)
    return objects
  }
  /** Startup reconciliation never sweeps another instance's resources. */
  async reconcile(): Promise<void> {
    this.configured()
    const [pods, services] = await Promise.all([this.census('pods'), this.census('services')])
    const owned = (object: KubeObject, id: string, role: string, name: string) =>
      object.metadata.name === name && !!object.metadata.uid &&
      object.metadata.labels?.['app.kubernetes.io/managed-by'] === MANAGER &&
      object.metadata.labels?.['colloq.dev/instance'] === this.options.config.instanceId &&
      object.metadata.labels?.['colloq.dev/job'] === id &&
      object.metadata.labels?.['colloq.dev/role'] === role
    const active = new Set(pods.flatMap(pod => {
      const id = pod.metadata.labels?.['colloq.dev/job'] ?? ''
      return COMPETITION_JOB_ID.test(id) && owned(pod, id,
        pod.metadata.labels?.['colloq.dev/role'] === 'competition-resolver' ? 'competition-resolver' : 'competition-job',
        jobName(id)) ? [id] : []
    }))
    for (const pod of pods) {
      const id = pod.metadata.labels?.['colloq.dev/job'] ?? ''
      if (!COMPETITION_JOB_ID.test(id) || !owned(pod, id, 'competition-proxy', proxyName(id)) || active.has(id)) continue
      const age = this.now() - (Number(pod.metadata.annotations?.['colloq.dev/started-at']) || this.now())
      if (age >= 120_000) await this.cleanupProxy(id)
    }
    for (const service of services) {
      const id = service.metadata.labels?.['colloq.dev/job'] ?? ''
      if (!COMPETITION_JOB_ID.test(id) || !owned(service, id, 'competition-proxy', proxyName(id)) || active.has(id)) continue
      const age = this.now() - (Number(service.metadata.annotations?.['colloq.dev/started-at']) || this.now())
      if (age >= 120_000) await this.deleteOwned('services', proxyName(id), id)
    }
    for (const pod of pods) {
      const id = pod.metadata.labels?.['colloq.dev/job'] ?? ''
      if (!COMPETITION_JOB_ID.test(id) || !owned(pod, id,
        pod.metadata.labels?.['colloq.dev/role'] === 'competition-resolver' ? 'competition-resolver' : 'competition-job',
        jobName(id))) continue
      const age = this.now() - (Number(pod.metadata.annotations?.['colloq.dev/started-at']) || this.now())
      let ttl: number
      try { ttl = Math.max(2 * 3600_000, this.parseIntent(pod).limits.wallSeconds * 1000 + 600_000) }
      catch { continue }
      if (age >= ttl) await this.cancel(id)
    }
  }
  async cancel(jobId: string): Promise<void> {
    this.configured()
    if (!COMPETITION_JOB_ID.test(jobId)) throw new RuntimeError('Invalid job ID', 400)
    if (this.cancelled.size >= 10000) this.cancelled.delete(this.cancelled.values().next().value!)
    this.cancelled.add(jobId)
    await this.starts.get(jobId)?.promise.catch(() => {})
    await this.deleteOwned('pods', jobName(jobId), jobId)
    await this.cleanupProxy(jobId)
    this.collected.delete(jobId)
  }
  async list(): Promise<CompetitionJobStatus[]> {
    this.configured()
    const jobs: CompetitionJobStatus[] = []
    for (const pod of await this.census('pods')) {
        const id = pod.metadata.labels?.['colloq.dev/job'] ?? ''
        if (!COMPETITION_JOB_ID.test(id) || pod.metadata.name !== jobName(id)) continue
        this.assertOwned(pod, id)
        jobs.push(this.phase(pod, this.parseIntent(pod)))
    }
    return jobs
  }
}

function parseCollection(value: unknown, kind: CompetitionJobKind, target: number): CompetitionJobCollection {
  if (!value || typeof value !== 'object') throw new RuntimeError('Invalid exporter collection', 503)
  const row = value as any
  if (!Array.isArray(row.files) || row.files.length > 260 || !Number.isSafeInteger(row.totalBytes) || row.totalBytes < 0 || row.totalBytes > exportBudget(kind, target))
    throw new RuntimeError('Invalid exporter collection', 503)
  let sum = 0
  const allowed: Record<CompetitionJobKind, Set<string>> = {
    notebook: new Set(['run.json', 'progress.json', 'executed.ipynb', 'submission.csv']),
    metric: new Set(['score.json']), inventory: new Set(['inventory.json']),
    resolve: new Set(['resolved.json', 'progress.ndjson']), verify: new Set(['verified.json', 'progress.ndjson']),
  }
  const seen = new Set<string>()
  let wheelBytes = 0
  for (const file of row.files) {
    if (!file || typeof file.name !== 'string' || !/^(?:wheels\/[A-Za-z0-9][A-Za-z0-9_.+!-]{0,230}\.whl|[A-Za-z0-9_.-]+(?:\.json|\.ndjson|\.csv|\.ipynb))$/.test(file.name) ||
      !(allowed[kind].has(file.name) || kind === 'resolve' && /^wheels\/[A-Za-z0-9][A-Za-z0-9_.+!-]{0,230}\.whl$/.test(file.name)) || seen.has(file.name) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new RuntimeError('Invalid exporter file metadata', 503)
    seen.add(file.name)
    if (file.name === 'submission.csv' && file.bytes > target ||
      file.name === 'executed.ipynb' && file.bytes > 64 * MiB ||
      file.name === 'score.json' && file.bytes > Math.min(target, MiB) ||
      file.name === 'progress.json' && file.bytes > 64 * 1024 ||
      file.name === 'progress.ndjson' && file.bytes > MiB ||
      file.name === 'run.json' && file.bytes > MiB ||
      file.name === 'inventory.json' && file.bytes > 2 * MiB ||
      file.name === 'resolved.json' && file.bytes > MiB ||
      file.name === 'verified.json' && file.bytes > MiB)
      throw new RuntimeError('Exporter file exceeds its cap', 503)
    if (file.name.startsWith('wheels/')) wheelBytes += file.bytes
    sum += file.bytes
  }
  if (sum !== row.totalBytes || wheelBytes > target) throw new RuntimeError('Invalid exporter collection size', 503)
  return row as CompetitionJobCollection
}

async function exportRequest(url: string, token: string, method: 'GET' | 'POST', payload?: unknown, timeoutMs = 5000): Promise<unknown> {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
  if (!response.ok) throw new RuntimeError('Competition exporter is unavailable', 503)
  if (!response.body) throw new RuntimeError('Invalid exporter response', 503)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 65536) throw new RuntimeError('Competition exporter response exceeds limit', 503)
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RuntimeError('Invalid exporter response', 503) }
}
