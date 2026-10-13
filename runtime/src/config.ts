import { readFileSync, statSync } from 'node:fs'
import { totalmem } from 'node:os'
import { parseRuntimeCatalog, type RuntimeCatalog } from '../../shared/runtime.js'
import { COMPETITION_GPU_PULL_SECONDS_MAX, COMPETITION_GPU_SLOTS_MAX } from '../../shared/competition-runtime.js'
import {
  parseExtendedResource,
  parsePriorityClass,
  parseRuntimeClass,
  parseStringMap,
  parseSwitch,
  parseTolerations,
  type PodPolicy,
  type Toleration,
} from './pod-policy.js'

/**
 * What a room's and a personal notebook's Pod are built from.
 *
 * Every field after `maxMemoryMb` is optional and means "as before" when
 * absent: the single-node k3s the installer builds sets none of them, and a
 * room Pod created with all of them absent is byte for byte the Pod of 0.9, so
 * an upgrade does not make a single live class look foreign.
 */
export interface WorkloadConfig extends PodPolicy {
  namespace: string
  workspaceClaim: string
  memory: string
  cpu: string
  ephemeral: string
  imagePullSecret?: string
  /**
   * The memory ceiling of one room, MiB. No field means only the protocol limit.
   *
   * Without a ceiling the number from the class form would go into the Pod as
   * is, and a Pod the node cannot give that much hangs in Pending until the
   * startup timeout, while a change to a live one becomes Infeasible. The
   * broker decides, not the web: it is its node and its policy.
   */
  maxMemoryMb?: number
  /**
   * RUNTIME_GPU_RUNTIME_CLASS: the RuntimeClass of a GPU room; absent is
   * `nvidia` (what the installer's k3s creates), empty is none, for clusters
   * where the NVIDIA runtime is the node's default.
   */
  gpuRuntimeClass?: string
  /**
   * RUNTIME_IN_PLACE_RESIZE: `false` never calls `pods/resize`, and the Role
   * may then lack it. A live room keeps its memory and cores until its next
   * Pod, as on a cluster older than 1.33. Absent is `true`.
   */
  inPlaceResize?: boolean
  /** RUNTIME_ROOM_NODE_SELECTOR / _TOLERATIONS: room and personal-notebook Pods. */
  roomNodeSelector?: Record<string, string>
  roomTolerations?: Toleration[]
  /** RUNTIME_GPU_NODE_SELECTOR / _TOLERATIONS: added for GPU rooms only; a personal notebook never has a GPU. */
  gpuNodeSelector?: Record<string, string>
  gpuTolerations?: Toleration[]
}
export interface RuntimeConfig extends WorkloadConfig {
  port: number
  tokenFile: string
  roomSecretFile: string
  catalogFile: string
  kubeUrl: string
  kubeTokenFile: string
  kubeCaFile: string
  competitionExporterImage: string
  competitionInstanceId: string
  competitionDataClaim: string
  /**
   * RUNTIME_COMPETITION_GPU_RESOURCE: what the notebook Pod of a competition
   * that asks for a GPU requests, as the cluster's device plugin names it
   * (pod-policy.ts · parseExtendedResource); empty is off, and such a
   * notebook is refused. What one unit is (a whole card, a time-sliced or MPS
   * replica, a MIG slice) is the device plugin's configuration, not ours.
   */
  competitionGpuResource: string
  /** RUNTIME_COMPETITION_GPU_COUNT: how many units of it, 1 to 8; 1 when unset. */
  competitionGpuCount: number
  /**
   * RUNTIME_COMPETITION_GPU_SLOTS: how many such notebooks of this instance
   * the cluster runs at once, 1 to 256, as the operator knows it (the units
   * set aside for submissions over the count); null when unset. The broker
   * only reports it (/v1/health · competition.gpuSlots): the app's queue
   * keeps that many GPU notebooks at the broker, one when it is null, and
   * lets CPU work go past the rest.
   */
  competitionGpuSlots: number | null
  /**
   * RUNTIME_COMPETITION_GPU_SHM_MB: the ceiling of such a notebook's own
   * memory-backed /dev/shm, MiB, 0 to 65536; 1024 when unset. 0 gives it
   * none, for MPS sharing, whose device plugin mounts its daemon's shared
   * memory there (competition-jobs.ts · shmMb).
   */
  competitionGpuShmMb: number
  /**
   * RUNTIME_COMPETITION_GPU_PULL_SECONDS: how long a Pod of a GPU
   * environment's image may take to pull it before the job's own time starts,
   * 0 to 3600; 900 when unset (competition-jobs.ts · pullSeconds).
   */
  competitionGpuPullSeconds: number
  dependencyIndexUrl: string
  dependencyFilesHosts: string
}
export function readBoundedFile(file: string, maxBytes: number): string {
  if (statSync(file).size > maxBytes)
    throw new Error('Runtime configuration file exceeds size limit')
  const data = readFileSync(file)
  if (data.length > maxBytes) throw new Error('Runtime configuration file exceeds size limit')
  return data.toString('utf8')
}
export function readStrongSecret(file: string): string {
  const secret = readBoundedFile(file, 4096).trim()
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret) || new Set(secret).size < 8)
    throw new Error(
      'Runtime secret must contain at least 32 random bytes encoded as hex or base64url',
    )
  return secret
}
export const readCatalog = (file: string): RuntimeCatalog =>
  parseRuntimeCatalog(JSON.parse(readBoundedFile(file, 2 * 1024 * 1024)))
const dnsName = (value: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
/** A gigabyte for the node itself: the same rule as in the web form (HOST_RESERVE_MB). */
const NODE_RESERVE_MI = 1024
export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
  // The node's MemTotal: sysinfo in a container reports on the whole node, not
  // on the broker's cgroup. A parameter for the sake of tests, whose node is
  // made up.
  nodeMemoryMi: number = Math.floor(totalmem() / 1024 ** 2),
): RuntimeConfig {
  const required = (key: string): string => {
    const value = env[key]
    if (!value) throw new Error(`${key} is required`)
    return value
  }
  const tokenFile = required('RUNTIME_TOKEN_FILE'),
    roomSecretFile = required('RUNTIME_ROOM_SECRET_FILE'),
    catalogFile = required('RUNTIME_CATALOG_FILE')
  readStrongSecret(tokenFile)
  readStrongSecret(roomSecretFile)
  readCatalog(catalogFile)
  const port = Number(env.RUNTIME_PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RUNTIME_PORT')
  const namespace = env.RUNTIME_NAMESPACE ?? 'colloq',
    workspaceClaim = env.RUNTIME_WORKSPACE_CLAIM ?? 'colloq-workspace',
    imagePullSecret = env.RUNTIME_IMAGE_PULL_SECRET
  if (
    !dnsName(namespace) ||
    !dnsName(workspaceClaim) ||
    (imagePullSecret !== undefined && !dnsName(imagePullSecret))
  )
    throw new Error('Invalid runtime namespace, claim or pull secret name')
  const memory = env.RUNTIME_KERNEL_MEMORY ?? '2Gi',
    cpu = env.RUNTIME_KERNEL_CPU ?? '2',
    ephemeral = env.RUNTIME_KERNEL_EPHEMERAL ?? '2Gi'
  const memoryMi = (value: string): number => {
    const match = /^([1-9][0-9]*)(Mi|Gi)$/.exec(value)
    return match ? Number(match[1]) * (match[2] === 'Gi' ? 1024 : 1) : NaN
  }
  const cpuCount = /^(?:[1-9][0-9]*(?:\.[0-9]{1,3})?|0\.[0-9]{1,3}|[1-9][0-9]*m)$/.test(cpu)
    ? cpu.endsWith('m')
      ? Number(cpu.slice(0, -1)) / 1000
      : Number(cpu)
    : NaN
  if (
    !(cpuCount > 0 && cpuCount <= 64) ||
    !(memoryMi(memory) >= 64 && memoryMi(memory) <= 262144) ||
    !(memoryMi(ephemeral) >= 64 && memoryMi(ephemeral) <= 1048576)
  )
    throw new Error('Invalid or excessive runtime CPU, memory or ephemeral storage limit')
  /*
   * The room ceiling: explicit from the operator, otherwise the node minus a
   * gigabyte for itself.
   *
   * The node is read as MemTotal, not as allocatable from the API: for that
   * the broker would need permissions on cluster Nodes, and it has only Pods
   * and Services in its own namespace. On k3s without kubelet reservations
   * these are almost the same, and the gigabyte of margin covers the
   * difference and the application's pods. The room default must fit under
   * the ceiling: otherwise every room without its own number would violate
   * the broker's own policy.
   */
  const explicitMax = env.RUNTIME_KERNEL_MEMORY_MAX
  const maxMemoryMb =
    explicitMax !== undefined
      ? memoryMi(explicitMax)
      : Math.min(262144, Math.max(memoryMi(memory), nodeMemoryMi - NODE_RESERVE_MI))
  if (!(maxMemoryMb >= 64 && maxMemoryMb <= 262144))
    throw new Error('Invalid RUNTIME_KERNEL_MEMORY_MAX: expected integral Mi/Gi from 64Mi to 256Gi')
  if (memoryMi(memory) > maxMemoryMb)
    throw new Error('RUNTIME_KERNEL_MEMORY exceeds RUNTIME_KERNEL_MEMORY_MAX')
  const kubeUrl = env.RUNTIME_KUBE_URL ?? 'https://kubernetes.default.svc'
  const url = new URL(kubeUrl)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('RUNTIME_KUBE_URL must be an HTTPS origin')
  /*
   * The customer's cluster rules (pod-policy.ts), checked here so that a typo
   * stops the broker at start with the variable's name, instead of every room
   * failing later with a Kubernetes validation error nobody connects to it.
   */
  const colocateWithApp = parseSwitch('RUNTIME_COLOCATE_WITH_APP', env.RUNTIME_COLOCATE_WITH_APP, false)
  const inPlaceResize = parseSwitch('RUNTIME_IN_PLACE_RESIZE', env.RUNTIME_IN_PLACE_RESIZE, true)
  const gpuRuntimeClass = parseRuntimeClass(env.RUNTIME_GPU_RUNTIME_CLASS)
  const priorityClass = parsePriorityClass(env.RUNTIME_PRIORITY_CLASS)
  const podLabels = parseStringMap('RUNTIME_POD_LABELS', env.RUNTIME_POD_LABELS, 'labels')
  const podAnnotations = parseStringMap('RUNTIME_POD_ANNOTATIONS', env.RUNTIME_POD_ANNOTATIONS, 'annotations')
  const roomNodeSelector = parseStringMap('RUNTIME_ROOM_NODE_SELECTOR', env.RUNTIME_ROOM_NODE_SELECTOR, 'nodeSelector')
  const roomTolerations = parseTolerations('RUNTIME_ROOM_TOLERATIONS', env.RUNTIME_ROOM_TOLERATIONS)
  const gpuNodeSelector = parseStringMap('RUNTIME_GPU_NODE_SELECTOR', env.RUNTIME_GPU_NODE_SELECTOR, 'nodeSelector')
  const gpuTolerations = parseTolerations('RUNTIME_GPU_TOLERATIONS', env.RUNTIME_GPU_TOLERATIONS)
  /*
   * A competition's GPU: the resource and how many units of it. The count is
   * checked even while the resource is unset, so that a typo there does not
   * wait to surface until the day someone turns the feature on.
   */
  const competitionGpuResource = parseExtendedResource('RUNTIME_COMPETITION_GPU_RESOURCE', env.RUNTIME_COMPETITION_GPU_RESOURCE)
  const gpuCount = (env.RUNTIME_COMPETITION_GPU_COUNT ?? '').trim()
  if (gpuCount !== '' && !/^[1-8]$/.test(gpuCount))
    throw new Error('RUNTIME_COMPETITION_GPU_COUNT must be a whole number from 1 to 8')
  const competitionGpuCount = gpuCount === '' ? 1 : Number(gpuCount)
  // The rest of the GPU settings: whole numbers in their bounds, or unset.
  const whole = (name: string, min: number, max: number, unset: number | null): number | null => {
    const raw = (env[name] ?? '').trim()
    if (raw === '') return unset
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(raw) || Number(raw) < min || Number(raw) > max)
      throw new Error(`${name} must be a whole number from ${min} to ${max}`)
    return Number(raw)
  }
  const competitionGpuSlots = whole('RUNTIME_COMPETITION_GPU_SLOTS', 1, COMPETITION_GPU_SLOTS_MAX, null)
  const competitionGpuShmMb = whole('RUNTIME_COMPETITION_GPU_SHM_MB', 0, 65536, 1024)!
  const competitionGpuPullSeconds = whole('RUNTIME_COMPETITION_GPU_PULL_SECONDS', 0, COMPETITION_GPU_PULL_SECONDS_MAX, 900)!
  return {
    port,
    tokenFile,
    roomSecretFile,
    catalogFile,
    namespace,
    workspaceClaim,
    memory,
    cpu,
    ephemeral,
    maxMemoryMb,
    ...(imagePullSecret ? { imagePullSecret } : {}),
    kubeUrl: url.origin,
    kubeTokenFile:
      env.RUNTIME_KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    kubeCaFile: env.RUNTIME_KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    competitionExporterImage: env.RUNTIME_COMPETITION_EXPORTER_IMAGE ?? '',
    competitionInstanceId: env.RUNTIME_COMPETITION_INSTANCE_ID ?? '',
    competitionDataClaim: env.RUNTIME_COMPETITION_DATA_CLAIM ?? '',
    competitionGpuResource,
    competitionGpuCount,
    competitionGpuSlots,
    competitionGpuShmMb,
    competitionGpuPullSeconds,
    // Passed through to the package proxy Pod unread (competition-jobs.ts).
    dependencyIndexUrl: (env.DEPENDENCY_INDEX_URL ?? '').trim(),
    dependencyFilesHosts: (env.DEPENDENCY_FILES_HOSTS ?? '').trim(),
    colocateWithApp,
    inPlaceResize,
    gpuRuntimeClass,
    priorityClass,
    podLabels,
    podAnnotations,
    roomNodeSelector,
    roomTolerations,
    gpuNodeSelector,
    gpuTolerations,
  }
}
