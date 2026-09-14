import { ENVIRONMENT_NAME } from './admin.js'

export interface RuntimeEnvironment {
  name: string
  image: string
  gpu: boolean
  packages?: string[]
  /**
   * Версия Python в опубликованном образе, `'3.12'` — если каталог её назвал.
   *
   * Необязательна нарочно: образ здесь неизменен и собран снаружи, спросить его
   * веб-приложение не может, а подставить умолчание — значит написать в панели
   * версию, которой в образе может не быть. Не сказано — не показываем.
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
  defaultCpus?: number
}
export interface RuntimeRoom {
  sessionId: string
  instanceId: string
  phase: 'pending' | 'ready' | 'failed' | 'terminating'
  environment: string
  revision: string
  reason?: string
  cpus?: number
}

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
  onlyKeys(row, ['environment', 'revision', 'cpus'])
  if (typeof row.environment !== 'string' || !ENVIRONMENT_NAME.test(row.environment))
    throw new Error('Invalid environment name')
  if (
    'revision' in row &&
    (typeof row.revision !== 'string' || !RUNTIME_REVISION.test(row.revision))
  )
    throw new Error('Invalid environment revision')
  if ('cpus' in row && (typeof row.cpus !== 'number' || !Number.isInteger(row.cpus) || row.cpus < 1 || row.cpus > 64))
    throw new Error('Invalid room CPU limit: expected 1 to 64 whole cores')
  return {
    environment: row.environment,
    ...(typeof row.revision === 'string' ? { revision: row.revision } : {}),
    ...(typeof row.cpus === 'number' ? { cpus: row.cpus } : {}),
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
    // Версия — та же форма, что и в директиве окружения: «3.12», а не «3.12 или
    // новее». Панель показывает её как факт об образе, и свободный текст на
    // этом месте был бы выдумкой о чужой сборке.
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
