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
  /**
   * Память комнаты в мебибайтах; нет поля — умолчание брокера.
   *
   * До 18.09 поле памяти в форме занятия на k3s не делало ничего: брокер
   * принимал только окружение, ревизию и ядра, и каждый Pod комнаты получал
   * свои 2Gi, сколько бы преподаватель ни написал. Число едет тем же
   * намерением, что и ядра, — шаблона Pod через этот вход не передать.
   */
  memoryMb?: number
}
/**
 * Поднять или опустить память и ядра ЖИВОЙ комнате — без нового Pod.
 *
 * Поля нет — этот ресурс не трогается; `null` — вернуть умолчание брокера.
 * Нужно хотя бы одно поле. Отдельно от ensure намеренно: ensure поднимает Pod,
 * если его нет, а смена лимита в панели не должна запускать Python комнате, в
 * которой сейчас никого.
 *
 * Ядра здесь с 18.09. До того число ядер доезжало только через ensure и
 * входило в хэш шаблона Pod: смена его в форме ничего не меняла живой комнате,
 * а следующий подъём (открыли терминал, переподключилось ядро) молча сносил
 * Pod вместе со всеми переменными семинара.
 */
export interface RuntimeResizeRequest {
  memoryMb?: number | null
  /** Целые ядра, как в ensure. */
  cpus?: number | null
}
/**
 * Что стало с ресурсами живой комнаты.
 *
 * `applied` — kubelet уже переставил cgroup; `pending` — API принял, но узлу
 * пока нечем (Deferred) или kubelet ещё не успел; `absent` — Pod нет, число
 * возьмёт следующий подъём. Числа — только тех ресурсов, что просили менять.
 */
export interface RuntimeResizeResult {
  outcome: 'applied' | 'pending' | 'absent'
  /** Сколько у Pod есть сейчас по словам kubelet; нет Pod — поля нет. */
  memoryMb?: number
  /** Ядра, которые у Pod есть сейчас; дробные, если так задал оператор. */
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
  /** Сколько памяти получает комната, которой ничего не задали. */
  defaultMemoryMb?: number
  /** Больше этого брокер комнате не выдаст: потолок оператора или узла. */
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
  /** Память, которая у Pod есть на самом деле, — из status, а не из spec. */
  memoryMb?: number
}
/**
 * Почему Pod комнаты не встал на узел: ресурс, которого узлу не хватило, или
 * `other` — планировщик отказал по иной причине (taint, affinity, привязка тома).
 *
 * Слово, а не текст Kubernetes. Сообщение планировщика — это «0/1 nodes are
 * available: 1 Insufficient memory. preemption: …», и до 18.09 наружу не
 * выходило даже оно: комната читала «Room startup timed out: pending» через две
 * минуты ожидания. Из сообщения брокер берёт только имя ресурса — остальное
 * там про чужие узлы и чужие Pod, и показывать это людям незачем.
 */
export type RuntimeUnschedulable = 'memory' | 'cpu' | 'gpu' | 'other'
const RUNTIME_UNSCHEDULABLE: readonly RuntimeUnschedulable[] = ['memory', 'cpu', 'gpu', 'other']
/**
 * Отказ подъёма, который можно объяснить человеку: поля тела ошибки брокера
 * рядом с `error`. Числа — то, что Pod просил, а не то, что было в форме: их
 * брокер знает точно (умолчание, потолок), и ровно их узел не смог дать.
 */
export interface RuntimeStartFailure {
  unschedulable: RuntimeUnschedulable
  memoryMb?: number
  /** Ядра Pod; дробные, если так задал оператор (RUNTIME_KERNEL_CPU=1500m). */
  cpus?: number
}
/** Разбор недоверенного тела ошибки: не то слово или не те числа — не отказ, а ничего. */
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
 * Границы числа памяти в протоколе — те же, что брокер принимает у оператора
 * в RUNTIME_KERNEL_MEMORY. Потолок конкретного узла строже и живёт в брокере.
 */
export const RUNTIME_MEMORY_MIN_MB = 64
export const RUNTIME_MEMORY_MAX_MB = 262144
const runtimeMemoryMb = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= RUNTIME_MEMORY_MIN_MB &&
  value <= RUNTIME_MEMORY_MAX_MB
/** Ядра комнаты в протоколе — целые, от одного до 64, как и в форме. */
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
  // Хотя бы одно поле: пустое тело — не «умолчание», а ошибка вызывающего.
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
