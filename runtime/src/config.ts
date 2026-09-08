import { readFileSync, statSync } from 'node:fs'
import { parseRuntimeCatalog, type RuntimeCatalog } from '../../shared/runtime.js'

export interface WorkloadConfig {
  namespace: string
  workspaceClaim: string
  memory: string
  cpu: string
  ephemeral: string
  imagePullSecret?: string
}
export interface RuntimeConfig extends WorkloadConfig {
  port: number
  tokenFile: string
  roomSecretFile: string
  catalogFile: string
  kubeUrl: string
  kubeTokenFile: string
  kubeCaFile: string
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
export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
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
    ...(imagePullSecret ? { imagePullSecret } : {}),
    kubeUrl: url.origin,
    kubeTokenFile:
      env.RUNTIME_KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    kubeCaFile: env.RUNTIME_KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
  }
}
