import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import type { CompetitionCapabilities, RuntimeCapability } from '../../shared/capabilities.js'
import { resolveRuntimeEnvironment, type RuntimeCatalog } from '../../shared/runtime.js'
import {
  COMPETITION_GPU_PULL_SECONDS_MAX, COMPETITION_JOB_ID, COMPETITION_RESOURCES_UNAVAILABLE, parseCompetitionJobIntent,
  type CompetitionJobCollection, type CompetitionJobIntent, type CompetitionJobKind,
  type CompetitionJobProgress, type CompetitionJobStatus,
} from '../../shared/competition-runtime.js'
import { RuntimeError } from './controller.js'
import { KubernetesError, type KubernetesClient, type KubeObject } from './kubernetes.js'
import { policyMetadata, policyPlacement, type PodPolicy, type Toleration } from './pod-policy.js'

const MANAGER = 'colloq-runtime'
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const ROOT = (namespace: string) => `/api/v1/namespaces/${namespace}`
const jobName = (id: string) => `colloq-job-${id}`
const proxyName = (id: string) => `colloq-proxy-${id}`
const iso = (time: number) => new Date(time).toISOString()

/**
 * Where Pods that run student code go: the rooms' node selector and
 * tolerations, when set. A notebook given a GPU adds what a GPU room adds
 * (controller.ts · placement): the GPU RuntimeClass, unless set empty, and the
 * GPU nodes' selector over the students' and their tolerations after them.
 * The cards a platform keeps for rooms are on those nodes; a submission's share
 * of one is no different.
 */
function studentPlacement(config: CompetitionJobConfig, gpu = false): Record<string, unknown> {
  const runtimeClass = gpu ? config.gpuRuntimeClass ?? 'nvidia' : ''
  const nodeSelector = { ...config.studentNodeSelector, ...(gpu ? config.gpuNodeSelector : {}) }
  const tolerations = [...(config.studentTolerations ?? []), ...(gpu ? config.gpuTolerations ?? [] : [])]
  return {
    ...(runtimeClass ? { runtimeClassName: runtimeClass } : {}),
    ...(Object.keys(nodeSelector).length ? { nodeSelector } : {}),
    ...(tolerations.length ? { tolerations } : {}),
  }
}

/**
 * The cluster's Pod policy (pod-policy.ts) applies here as to rooms: the
 * priority class, the operator's labels and annotations, and the colocation
 * affinity for the Pods that mount the data claim (the job and the resolver;
 * the exporter is a container of the job's Pod). The package proxy mounts
 * nothing and is left free to run anywhere.
 *
 * The rooms' node selector and tolerations (RUNTIME_ROOM_*) go to the job and
 * resolver Pods too: a submission is student code as much as a cell is, and a
 * platform that keeps student code on its own tainted node pool means every
 * Pod that runs it. The proxy runs none and keeps the cluster's defaults.
 */
export interface CompetitionJobConfig extends PodPolicy {
  namespace: string
  dataClaim: string
  exporterImage: string
  instanceId: string
  imagePullSecret?: string
  /**
   * The institution's package index for "own packages" (DEPENDENCY_INDEX_URL,
   * DEPENDENCY_FILES_HOSTS), passed to the CONNECT proxy Pod as they are: the
   * proxy reads them (competition-proxy.ts) and refuses to start on a bad one,
   * so a mistake costs a preparation, not the broker.
   */
  dependencyIndexUrl?: string
  dependencyFilesHosts?: string
  /** RUNTIME_ROOM_NODE_SELECTOR / RUNTIME_ROOM_TOLERATIONS, for the Pods that run student code. */
  studentNodeSelector?: Record<string, string>
  studentTolerations?: Toleration[]
  /**
   * RUNTIME_COMPETITION_GPU_RESOURCE / _COUNT: what the main container of a
   * notebook job whose intent asks for a GPU requests, in its requests and its
   * limits alike (an extended resource is never overcommitted). Absent: no
   * competition job gets a GPU, and one that asks is refused.
   *
   * Every other job runs a GPU environment's image on the CPU: an inventory, a
   * package preparation, the metric (it mounts the hidden answers and must
   * never share a device with a participant's code), and a notebook whose
   * competition asked for no card.
   *
   * `slots` (RUNTIME_COMPETITION_GPU_SLOTS): how many such notebooks the
   * cluster runs at once for this instance, as the operator knows it; only
   * reported (health), for the app's queue. `shmMb`
   * (RUNTIME_COMPETITION_GPU_SHM_MB): the ceiling of the notebook's own
   * /dev/shm, 1024 when absent, 0 for none (shmMb below).
   */
  gpu?: { resource: string; count: number; slots?: number | null; shmMb?: number }
  /**
   * RUNTIME_COMPETITION_GPU_PULL_SECONDS: the pull allowance of every Pod of a
   * GPU environment's image, whether or not it gets a card; 900 when absent
   * (pullSeconds below).
   */
  gpuPullSeconds?: number
  /**
   * RUNTIME_GPU_RUNTIME_CLASS / _NODE_SELECTOR / _TOLERATIONS: the GPU rooms'
   * placement, which a notebook given a GPU shares. As for rooms, an absent
   * RuntimeClass is `nvidia` and an empty one is none.
   */
  gpuRuntimeClass?: string
  gpuNodeSelector?: Record<string, string>
  gpuTolerations?: Toleration[]
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
/**
 * Liveness of the two servers a competition Pod runs, the exporter and the
 * package proxy, for a policy engine that requires probes on long-running
 * containers. TCP, generous: the node completes the handshake even while the
 * exporter's event loop copies a large file, and two minutes of refusals
 * outlast the proxy's own close at its deadline, 90 seconds before the Pod's.
 *
 * The notebook, scorer and resolver themselves (`main`) get none: a batch
 * process has no endpoint, an exec probe would spend the submission's own
 * process budget, and a probe there could only end a legitimate long run that
 * activeDeadlineSeconds already bounds. The egress preflight is an init
 * container, which Kubernetes does not probe.
 */
const SERVER_LIVENESS = (port: number) => ({ tcpSocket: { port }, initialDelaySeconds: 10, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 })
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
/**
 * The memory-backed room a notebook's package set is installed into, sized
 * for that set by the app (limits.packagesMb): /work is the participant's
 * folder at an eighth of the memory, and a ready set of 300 MB never fit into
 * the 256 MiB it gives at 2 GB. Counted in the Pod's memory like every
 * memory-backed volume; null — no set, or an app that did not size one.
 */
function packageRoom(intent: CompetitionJobIntent): number | null {
  return intent.kind === 'notebook' && intent.bundleId && intent.limits.packagesMb ? intent.limits.packagesMb : null
}
/**
 * The annotation of a job Pod that holds its image pull allowance, seconds
 * (CompetitionJobs · pullSeconds): the Pod's own record, so that its clock
 * stays the one it was created with across a broker restart with other
 * settings.
 */
const PULL_SECONDS = 'colloq.dev/pull-seconds'
/** The pull allowance a job Pod was created with; 0 for a CPU image's Pod and for one from a broker before it. */
function pullAllowance(pod: KubeObject): number {
  const seconds = Number(pod.metadata.annotations?.[PULL_SECONDS])
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, COMPETITION_GPU_PULL_SECONDS_MAX) : 0
}
/**
 * For every container of a GPU environment's image that requests no GPU: the
 * metric, an inventory, a preparation, a notebook without a card, the egress
 * preflight. Images built from nvidia/cuda carry NVIDIA_VISIBLE_DEVICES=all,
 * and on a node whose default container runtime is NVIDIA's (the GPU
 * operator's default on many clusters) that alone mounts every card of the
 * node into the container, whatever the scheduler counted. `void` is the
 * runtime's own word for "no GPU and no driver at all"; any other runtime
 * ignores the variable. Never on the main container of a notebook given a
 * GPU: there the device plugin sets it to the units it allocated, and ours
 * would override it.
 */
const noGpu = () => env('NVIDIA_VISIBLE_DEVICES', 'void')
/**
 * The resource names a scheduler refusal says it lacked: "0/3 nodes are
 * available: 1 Insufficient nvidia.com/gpu, 2 Insufficient memory." gives
 * `nvidia.com/gpu` and `memory`. Only the names, as for rooms
 * (controller.ts · unschedulable): the rest is about other nodes and other
 * Pods. A name ends with a letter or a digit, so a dot after it is the end of
 * the scheduler's sentence.
 */
function shortages(message: string): Set<string> {
  return new Set([...message.slice(0, 4096).matchAll(/\binsufficient\s+([a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?)/gi)]
    .map((match) => match[1].toLowerCase()))
}
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
  async health(): Promise<CompetitionCapabilities> {
    const unavailable = (code: string, reason: string) => ({ available: false, code, reason })
    const available = { available: true, code: 'ready', reason: null }
    /*
     * `gpu`: whether a notebook that asks for a card can run. Only where the
     * operator named the cluster's GPU resource, and then exactly when
     * execution can: a GPU job is a job first, with the same claim, isolation
     * and images. The app refuses a GPU competition's uploads and baseline
     * check at the door on this answer, instead of queueing work this broker
     * would refuse.
     *
     * `gpuSlots`: how many such notebooks the operator says the cluster runs
     * at once (RUNTIME_COMPETITION_GPU_SLOTS), null when unset or off. The
     * app's queue keeps that many at the broker, one for null, and lets CPU
     * work go past the others: a GPU notebook Kubernetes cannot place holds
     * a general slot for the 30 seconds this broker waits on the scheduler
     * (phase · unschedulable), and a queue that sent every waiting one would
     * keep every slot busy with them.
     */
    const off = unavailable('gpu_unavailable', 'Competition jobs get no GPU on this cluster: RUNTIME_COMPETITION_GPU_RESOURCE (Helm: gpu.competitions.resource) is not set')
    const answer = (execution: RuntimeCapability, preparation: RuntimeCapability): CompetitionCapabilities =>
      ({ execution, preparation, gpu: this.options.config.gpu ? execution : off, gpuSlots: this.options.config.gpu?.slots ?? null })
    try { this.configured() }
    catch { const state = unavailable('broker_unavailable', 'Competition broker configuration is incomplete'); return answer(state, state) }
    /*
     * Any pinned image will do. This used to ask for an image without a GPU,
     * because a GPU environment's image was refused for every job; now it runs
     * every kind of job on the CPU, and only a notebook that asked for a card
     * gets one, so a catalog of GPU environments alone is a working catalog.
     */
    let hasImage = false
    try { hasImage = this.options.catalog().environments.some(row => IMAGE.test(row.image)) } catch { /* reported below */ }
    if (!hasImage) {
      const state = unavailable('image_unavailable', 'No pinned competition registry image is available')
      return answer(state, state)
    }
    try { await this.options.kube.request('GET', `${this.root}/persistentvolumeclaims/${this.options.config.dataClaim}`) }
    catch { const state = unavailable('storage_unavailable', 'Competition data claim is unavailable'); return answer(state, state) }
    const policy = async (name: string) => this.options.kube.request('GET', `/apis/networking.k8s.io/v1/namespaces/${this.options.config.namespace}/networkpolicies/${name}`)
    try { await policy('competition-job-isolation') }
    catch { const state = unavailable('isolation_unavailable', 'Competition job network isolation is unavailable'); return answer(state, state) }
    let preparation: RuntimeCapability = available
    try { await policy('competition-resolver-isolation'); await policy('competition-proxy-isolation');
      await this.options.kube.request('GET', `${this.root}/services?limit=1`) }
    catch { preparation = unavailable('preparation_unavailable', 'Dependency resolver proxy isolation is unavailable') }
    return answer(available, preparation)
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
  /**
   * The GPU this job's Pod requests, or null: a notebook intent with
   * `gpu: true` on a broker that names the cluster's GPU resource. Anything
   * else that asks for one never reaches a Pod (startPrepared).
   */
  private gpu(intent: CompetitionJobIntent): NonNullable<CompetitionJobConfig['gpu']> | null {
    return intent.kind === 'notebook' && intent.gpu === true && this.options.config.gpu ? this.options.config.gpu : null
  }
  /**
   * /dev/shm of a notebook given a GPU, MiB; 0 — none of ours. PyTorch's
   * DataLoader workers hand their batches over through it, and the 64 MiB a
   * container has by default ends such a run with "bus error". Memory-backed,
   * and so paid for from the job's memory like every such volume: half of it
   * at most, and never more than the operator's ceiling
   * (RUNTIME_COMPETITION_GPU_SHM_MB), by default the 1 GiB a GPU room gets
   * (controller.ts).
   *
   * A ceiling of 0 is for MPS sharing: there the device plugin mounts its MPS
   * daemon's shared memory at /dev/shm for the CUDA client to reach the
   * server, and the kubelet mounts the Pod's own volumes after the plugin's,
   * so a volume of ours at the same path hides it: CUDA fails to start, and
   * the notebook trains on the CPU until its limit or dies in its first
   * `.cuda()` (NVIDIA/k8s-device-plugin#467, #805). The /dev/shm is then the
   * daemon's, shared by the node's MPS clients and sized by it.
   */
  private shmMb(intent: CompetitionJobIntent): number {
    const gpu = this.gpu(intent)
    return gpu ? Math.min(gpu.shmMb ?? 1024, Math.floor(intent.limits.memoryMb / 2)) : 0
  }
  /**
   * The pull allowance of a Pod of this image, seconds: 0 for a CPU image, and
   * for a GPU environment's image RUNTIME_COMPETITION_GPU_PULL_SECONDS (900
   * when unset).
   *
   * Such an image is 10 to 13 GB, and every job of a GPU competition runs it,
   * the metric and a package preparation included, on whatever node the
   * scheduler picks: a metric on a CPU node that never ran it, a notebook on a
   * GPU node that has not yet. Its pull happens after the Pod is created and
   * before its first container starts, and without the allowance it came out
   * of the job's own time: 30 seconds of startup and then the wall limit of
   * the job (a metric's is two minutes), so the first metric on every cold
   * node failed as "Wall time limit exceeded", and a notebook lost to the pull
   * what it had to train. With it, the broker waits that much longer for
   * `main` to start (phase), the Pod's activeDeadlineSeconds grows by as
   * much, and so does the package proxy's life for a preparation. A started
   * job still gets exactly its limit from its own start: the broker counts
   * the wall from `main`'s start, and the notebook's harness stops it from
   * its own (run_notebook.py · stop_at), so the allowance only ever covers
   * the wait before.
   */
  private pullSeconds(gpuImage: boolean): number {
    return gpuImage ? Math.min(this.options.config.gpuPullSeconds ?? 900, COMPETITION_GPU_PULL_SECONDS_MAX) : 0
  }
  private main(intent: CompetitionJobIntent, image: string, gpuImage: boolean) {
    const base = `competitions/${intent.competitionId}/s/${intent.submissionId}`
    const attempt = `${base}/attempts/${intent.attemptId}`
    // With the hidden test the app has composed this attempt's own data folder
    // (open files, the hidden ones swapped in); the competition's open data/
    // is not mounted at all then, so nothing reads the example by mistake.
    const dataSource = intent.sealedInputs ? `${attempt}/inputs` : `competitions/${intent.competitionId}/data`
    const input = intent.kind === 'notebook'
      ? [mount('data', '/data', dataSource, true), mount('data', '/submission', `${base}/in`, true),
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
    // The units of the cluster's GPU resource, in requests and limits alike:
    // Kubernetes allows an extended resource no other way.
    const gpu = this.gpu(intent)
    const card = gpu ? { [gpu.resource]: gpu.count } : {}
    return { name: 'main', image, imagePullPolicy: 'IfNotPresent', command,
      workingDir: '/work', securityContext: security,
      resources: { requests: { cpu: `${intent.limits.cpus}`, memory: `${intent.limits.memoryMb}Mi`, 'ephemeral-storage': '64Mi', ...card },
        limits: { cpu: `${intent.limits.cpus}`, memory: `${intent.limits.memoryMb}Mi`, 'ephemeral-storage': '256Mi', ...card } },
      env: [env('HOME', '/tmp/home'), env('PYTHONDONTWRITEBYTECODE', '1'), env('PYTHONNOUSERSITE', '1'),
        env('PYTHONUNBUFFERED', '1'), env('PIP_CONFIG_FILE', '/dev/null'),
        // Every thread pool a notebook is likely to meet, capped at the Pod's
        // CPUs: polars (rayon), BLIS, vecLib and numba each read their own variable.
        ...['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'POLARS_MAX_THREADS',
          'RAYON_NUM_THREADS', 'BLIS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMBA_NUM_THREADS', 'LOKY_MAX_CPU_COUNT']
          .map((name) => env(name, String(Math.max(1, Math.floor(intent.limits.cpus))))),
        env('COMP_ATTEMPT_ID', intent.attemptId ?? intent.jobId), env('COMP_RESULT', '/out'), env('COMP_OUT', intent.kind === 'metric' ? '/out' : '/work'),
        env('COMP_TARGET', 'submission.csv'), env('COMP_MAX_TARGET_BYTES', String(intent.limits.targetBytes)),
        env('COMP_CELL_TIMEOUT_SEC', String(intent.limits.wallSeconds)),
        // The whole run's limit: the harness stops a late notebook itself a few
        // seconds before this Pod's deadline, with its outputs saved, instead
        // of leaving nothing to collect after a kill (run_notebook.py · stop_at).
        ...(intent.kind === 'notebook' ? [env('COMP_WALL_SECONDS', String(intent.limits.wallSeconds))] : []),
        ...(intent.bundleId ? [env('COMP_DEPENDENCIES', '/deps')] : []),
        ...(packageRoom(intent) ? [env('COMP_PACKAGES', '/packages')] : []),
        ...(intent.kind === 'resolve' ? [env('HTTPS_PROXY', `http://${proxyName(intent.jobId)}:3128`), env('HTTP_PROXY', `http://${proxyName(intent.jobId)}:3128`),
          env('https_proxy', `http://${proxyName(intent.jobId)}:3128`), env('http_proxy', `http://${proxyName(intent.jobId)}:3128`),
          env('NO_PROXY', ''), env('no_proxy', ''), env('ALL_PROXY', ''), env('all_proxy', '')] : []),
        ...(gpuImage && !gpu ? [noGpu()] : [])],
      volumeMounts: [mount('out', '/out'), mount('work', '/work'), mount('tmp', '/tmp'),
        ...(packageRoom(intent) ? [mount('packages', '/packages')] : []),
        ...(this.shmMb(intent) ? [mount('shm', '/dev/shm')] : []),
        mount('data', '/harness', intent.kind === 'notebook' || intent.kind === 'metric' ? 'competitions/harness' : 'dependencies/harness', true), ...input],
    }
  }
  private pod(intent: CompetitionJobIntent, image: string, gpuImage: boolean): KubeObject {
    const role = intent.kind === 'resolve' ? 'competition-resolver' : 'competition-job'
    const gpu = this.gpu(intent)
    const pull = this.pullSeconds(gpuImage)
    const shm = this.shmMb(intent)
    return { apiVersion: 'v1', kind: 'Pod', metadata: { name: jobName(intent.jobId),
        ...policyMetadata(this.options.config, this.labels(intent.jobId, role),
          { ...this.annotations(intent), ...(pull ? { [PULL_SECONDS]: String(pull) } : {}) }) },
      spec: { restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
        // Counted by the kubelet from the Pod's start, the image pull included.
        terminationGracePeriodSeconds: 5, activeDeadlineSeconds: intent.limits.wallSeconds + 90 + pull,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
        ...(this.options.config.imagePullSecret ? { imagePullSecrets: [{ name: this.options.config.imagePullSecret }] } : {}),
        // Both of this Pod's containers mount the data claim.
        ...policyPlacement(this.options.config, true),
        ...studentPlacement(this.options.config, gpu !== null),
        ...(intent.kind === 'resolve' ? {} : { initContainers: [{ name: 'egress-probe', image,
          imagePullPolicy: 'IfNotPresent', command: ['python', '-I', '-c', OFFLINE_PROBE],
          // The preflight runs the job's image, but never needs its card.
          ...(gpuImage ? { env: [noGpu()] } : {}),
          securityContext: security,
          resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '250m', memory: '128Mi', 'ephemeral-storage': '16Mi' } },
        }] }),
        // The data claim is ONE volume, mounted at every path: two volumes naming
        // the same claim left the Pod in ContainerCreating for minutes on a
        // Kubernetes 1.31 node (local PVs, found on a bank-like cluster on 1 Oct
        // 2026), and every inventory and submission timed out behind it.
        volumes: [pvc('data', this.options.config.dataClaim),
          { name: 'out', emptyDir: memory(intent.limits.tmpfsMb) }, { name: 'work', emptyDir: memory(intent.limits.tmpfsMb) },
          // Never more than 256 MiB, whatever the job: a package preparation works
          // in /work (COMP_OUT), which the app sizes for the phase through tmpfsMb.
          { name: 'tmp', emptyDir: memory(Math.min(intent.limits.tmpfsMb, 256)) },
          ...(packageRoom(intent) ? [{ name: 'packages', emptyDir: memory(packageRoom(intent)!) }] : []),
          ...(shm ? [{ name: 'shm', emptyDir: memory(shm) }] : [])],
        containers: [this.main(intent, image, gpuImage), { name: 'exporter', image: this.options.config.exporterImage,
          imagePullPolicy: 'IfNotPresent', command: ['node', '/app/export-sidecar.js'], securityContext: security,
          resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi', 'ephemeral-storage': '64Mi' } },
          env: [env('COMP_EXPORT_TOKEN', this.token(intent.jobId)), env('COMP_EXPORT_KIND', intent.kind),
            env('COMP_EXPORT_MAX_BYTES', String(intent.limits.targetBytes))],
          ports: [{ name: 'export', containerPort: 8765, protocol: 'TCP' }],
          readinessProbe: { tcpSocket: { port: 8765 }, periodSeconds: 1, failureThreshold: 10 },
          livenessProbe: SERVER_LIVENESS(8765),
          volumeMounts: [mount('out', '/out'), mount('data', '/result', this.destination(intent)), mount('tmp', '/tmp')],
        }],
      } }
  }
  /**
   * `pull`: the resolver's image pull allowance (pullSeconds). The proxy is
   * up before the resolver's Pod is created, and its own clock
   * (COMP_PROXY_WALL_SECONDS) runs from its start: a resolver that spends its
   * allowance pulling still has the proxy for its whole limit.
   */
  private proxyPod(intent: CompetitionJobIntent, pull = 0): KubeObject {
    return { apiVersion: 'v1', kind: 'Pod', metadata: { name: proxyName(intent.jobId),
        ...policyMetadata(this.options.config, this.labels(intent.jobId, 'competition-proxy'), this.annotations(intent)) },
      spec: { restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
        activeDeadlineSeconds: intent.limits.wallSeconds + 90 + pull, securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
        // No claim mounted: the priority, but no colocation.
        ...policyPlacement(this.options.config, false),
        containers: [{ name: 'proxy', image: this.options.config.exporterImage, command: ['node', '/app/competition-proxy.js'],
          securityContext: security, ports: [{ containerPort: 3128, name: 'proxy' }],
          readinessProbe: { tcpSocket: { port: 3128 }, periodSeconds: 1, failureThreshold: 10 },
          livenessProbe: SERVER_LIVENESS(3128),
          resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '128Mi', 'ephemeral-storage': '32Mi' } },
          env: [env('COMP_PROXY_MAX_BYTES', String(Math.min(intent.limits.targetBytes * 3 + 32 * 1024 * 1024, 1536 * 1024 * 1024))),
            env('COMP_PROXY_WALL_SECONDS', String(intent.limits.wallSeconds + pull)),
            ...(this.options.config.dependencyIndexUrl ? [env('DEPENDENCY_INDEX_URL', this.options.config.dependencyIndexUrl)] : []),
            ...(this.options.config.dependencyFilesHosts ? [env('DEPENDENCY_FILES_HOSTS', this.options.config.dependencyFilesHosts)] : [])],
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
    let gpuImage = false
    try {
      const environment = resolveRuntimeEnvironment(this.options.catalog(), intent.environment, intent.revision)
      image = environment.image
      gpuImage = environment.gpu
    }
    catch { throw new RuntimeError('Competition image revision is unavailable in catalog', 409) }
    if (!IMAGE.test(image)) throw new RuntimeError('Competition image is not a pinned registry digest', 409)
    /*
     * A GPU environment's image runs any job on the CPU, as a personal
     * notebook's Pod runs it (controller.ts · pod). A card goes only to a
     * notebook whose intent asks for one, and only where the operator named
     * the cluster's GPU resource. Asked for anywhere else, it is refused here,
     * before a Pod exists: training on the CPU without a word to anyone is
     * what GPU competitions did before they could get a card, and it is not
     * an answer.
     */
    if (intent.gpu === true) {
      if (!this.options.config.gpu)
        throw new RuntimeError('Competition GPU jobs are off on this broker: RUNTIME_COMPETITION_GPU_RESOURCE is not set', 409)
      if (!gpuImage) throw new RuntimeError('A competition GPU job needs a GPU environment from the catalog', 409)
    }
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
      const proxy = this.proxyPod(intent, this.pullSeconds(gpuImage))
      const service = this.proxyService(intent)
      await this.options.kube.request('POST', `${this.root}/pods`, proxy)
      try { await this.options.kube.request('POST', `${this.root}/services`, service); await this.awaitProxy(jobId) }
      catch (err) { await this.cleanupProxy(jobId).catch(() => {}); throw err }
    }
    if (this.cancelled.has(jobId)) { if (intent.kind === 'resolve') await this.cleanupProxy(jobId); throw new RuntimeError('Competition job was cancelled', 409) }
    let created: KubeObject
    try { created = await this.options.kube.request<KubeObject>('POST', `${this.root}/pods`, this.pod(intent, image, gpuImage)) }
    catch (err) {
      if (intent.kind === 'resolve') await this.cleanupProxy(jobId).catch(() => {})
      const refused = this.refusedAtAdmission(intent, err)
      if (refused) return refused
      throw err
    }
    if (this.cancelled.has(jobId)) throw new RuntimeError('Competition job was cancelled', 409)
    return this.phase(created, intent)
  }
  /**
   * The API server's "no" to the Pod of a notebook given a GPU, as the status
   * of a job that found no room: `unschedulable`, resource `gpu`, and the
   * cause in words of our own for the teacher, while the app puts the job
   * back into its queue and tries again a few seconds to a minute later.
   *
   * The Pod is refused before it exists when the namespace's ResourceQuota
   * has no unit of the GPU resource left (GPU rooms and the submissions
   * already running hold them: it frees itself), when the cluster has no
   * RuntimeClass of the name RUNTIME_GPU_RUNTIME_CLASS gives (the chart's
   * `nvidia`, absent on a cluster without the GPU operator), or when an
   * admission policy turns down what only a GPU notebook's Pod carries: the
   * units, the RuntimeClass, the GPU nodes' tolerations. It used to come back
   * as an error, which the app records as a failed metric: every GPU
   * submission of the class "failed" within seconds, nothing retried them,
   * and the teacher read only "Forbidden". As with the scheduler and the
   * kubelet (phase · cardRefused), it is "no card for this job now".
   *
   * Only for a GPU notebook: a CPU job refused at admission is not waiting
   * for a card and stays the error it was. Nor a refusal of the broker's own
   * permissions (RBAC), which every job would meet.
   */
  private refusedAtAdmission(intent: CompetitionJobIntent, err: unknown): CompetitionJobStatus | null {
    const refusal = this.gpu(intent) && err instanceof KubernetesError ? err.refusal : undefined
    if (!refusal || refusal.kind === 'permission') return null
    const error = refusal.kind === 'quota'
      ? `Kubernetes refused the GPU notebook's Pod: the namespace's resource quota is used up${refusal.resources.length ? ` (${refusal.resources.join(', ')})` : ''}`
      : refusal.kind === 'runtime-class'
        ? `Kubernetes refused the GPU notebook's Pod: the cluster has no RuntimeClass "${this.options.config.gpuRuntimeClass ?? 'nvidia'}" (RUNTIME_GPU_RUNTIME_CLASS, Helm: gpu.runtimeClassName)`
        : "Kubernetes refused the GPU notebook's Pod at admission: a policy of the cluster denied it"
    const now = this.now()
    return { jobId: intent.jobId, kind: intent.kind, phase: 'failed', startedAt: now, finishedAt: now, exitCode: null, oomKilled: false,
      progress: null, error: error.slice(0, 300), failure: { code: 'unschedulable', resource: 'gpu' } }
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
    // starts, and a GPU environment's image its pull allowance on top
    // (pullSeconds). Kubernetes reports the main start time once it has
    // actually run, and the limit counts from there.
    const wallStartedAt = Number.isFinite(mainStartedAt) ? mainStartedAt
      : startedAt + (terminated ? 0 : 30_000 + pullAllowance(pod) * 1000)
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
    // The card first, as for rooms (controller.ts · SHORTAGES): advice to ask
    // for less memory does nothing for a job that did not get a card.
    const gpu = this.gpu(intent)
    const resource = gpu && shortages(schedulerMessage).has(gpu.resource.toLowerCase()) ? 'gpu' :
      /insufficient\s+memory/i.test(schedulerMessage) ? 'memory' :
      /insufficient\s+cpu/i.test(schedulerMessage) ? 'cpu' :
        /insufficient\s+ephemeral-storage/i.test(schedulerMessage) ? 'storage' : 'other'
    /*
     * The kubelet can still refuse a GPU Pod the scheduler has placed: the
     * device plugin failed to hand the units over (UnexpectedAdmissionError;
     * a card whose previous job is still being torn down is a typical cause),
     * or the node has none left after all (OutOf<resource>). For the job that
     * is the same "no card free right now" as a scheduler refusal, and the
     * same answer: back to the queue, not a failed metric.
     */
    const cardRefused = !!gpu && failedPod && !terminated &&
      (pod.status?.reason === 'UnexpectedAdmissionError' || pod.status?.reason === `OutOf${gpu.resource}`)
    const failure: CompetitionJobStatus['failure'] | undefined = deadlineExceeded ? undefined :
      unschedulable ? { code: 'unschedulable', resource } :
      cardRefused ? { code: 'unschedulable', resource: 'gpu' } :
      imageUnavailable ? { code: 'image_unavailable' } :
        exporterFailed ? { code: 'export_failed' } :
          (failedPod && pod.status?.reason !== 'DeadlineExceeded' || preflightFailed) && !terminated ? { code: 'runtime_unavailable' } : undefined
    return { jobId: intent.jobId, kind: intent.kind, phase, startedAt,
      finishedAt: deadlineExceeded ? this.now() : terminated ? mainFinishedAt || this.now() : phase === 'failed' ? this.now() : null,
      exitCode, oomKilled: !deadlineExceeded && terminated?.reason === 'OOMKilled', progress: null,
      error: deadlineExceeded ? 'Wall time limit exceeded' : preflightFailed ? 'Network isolation preflight failed' : unschedulable || cardRefused ? COMPETITION_RESOURCES_UNAVAILABLE :
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
      // A GPU image's pull allowance is the job's time as much as its limit is.
      try { ttl = Math.max(2 * 3600_000, (this.parseIntent(pod).limits.wallSeconds + pullAllowance(pod)) * 1000 + 600_000) }
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
