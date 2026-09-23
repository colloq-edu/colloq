import { tr } from '@shared/i18n'
import { COMPETITION_JOB_ID, parseCompetitionJobIntent, parseCompetitionJobStatus, parseCompetitionJobCollection, type CompetitionJobCollection, type CompetitionJobIntent, type CompetitionJobStatus } from '@shared/competition-runtime'
/** The web process sends room intent; it never forwards a container specification. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import {
  imageRevision, isRuntimeSessionId, parseRuntimeCatalog, parseRuntimeEnsureRequest,
  parseRuntimeResizeRequest, resolveRuntimeEnvironment, RUNTIME_MEMORY_MAX_MB, RUNTIME_MEMORY_MIN_MB,
  RUNTIME_REVISION, parseRuntimeStartFailure, type RuntimeStartFailure,
  type RuntimeCatalog, type RuntimeEndpoint, type RuntimeHealth, type RuntimeResizeRequest, type RuntimeResizeResult, type RuntimeRoom,
} from '@shared/runtime'

export type KernelBackend = 'broker' | 'docker' | 'test'
/**
 * Чем поднимать ядра. Умолчание для `NODE_ENV=test` — подставные ядра.
 *
 * Прежде тестовый сервер без явного `KERNEL_BACKEND` брал docker — и начинал
 * распоряжаться НАСТОЯЩИМИ контейнерами: уборщик простоя ходит по меткам
 * `colloq.kind=room-kernel` через `docker ps -a`, то есть видит и комнаты
 * чужого, живого сервера на той же машине. 20.09.2026 так поднятый стенд
 * оказался рядом с идущим занятием и мог погасить его комнату; цена ошибки —
 * сброшенные переменные у всего класса посреди пары.
 *
 * Тестовому серверу настоящие контейнеры не нужны ни для чего, поэтому
 * умолчание здесь безопасное, а не «как у разработки». Кому нужен docker под
 * `NODE_ENV=test`, тот пишет `KERNEL_BACKEND=docker` руками — и делает это
 * осознанно.
 */
export function selectKernelBackend(env: NodeJS.ProcessEnv): KernelBackend {
  const chosen = env.KERNEL_BACKEND?.trim() ||
    (env.NODE_ENV === 'production' || env.KERNEL_RUNTIME_URL
      ? 'broker'
      : env.NODE_ENV === 'test'
        ? 'test'
        : 'docker')
  if (!['broker', 'docker', 'test'].includes(chosen)) throw new Error(`Unknown kernel backend: ${chosen}`)
  if (chosen === 'test' && env.NODE_ENV !== 'test') throw new Error('The test kernel backend requires NODE_ENV=test')
  if (chosen === 'docker' && env.NODE_ENV === 'production') {
    throw new Error('Production requires the private kernel runtime; the Docker backend is for local development only')
  }
  return chosen as KernelBackend
}
export function kernelBackend(): KernelBackend { return selectKernelBackend(process.env) }
export function usingRuntimeBroker(): boolean { return kernelBackend() === 'broker' }
export function requireKernelIsolation(env: NodeJS.ProcessEnv = process.env): void {
  const backend = selectKernelBackend(env)
  if (backend === 'test') return
  if (env.KERNEL_ISOLATION?.toLowerCase() === 'off') {
    throw new Error('Room isolation is mandatory. Remove KERNEL_ISOLATION=off; shared Jupyter execution is disabled')
  }
}

export class RuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    /** Почему комната не поднялась — словом брокера; преподавателю из него пишут совет (shared/kernel-problem.ts). */
    readonly failure?: RuntimeStartFailure,
  ) { super(message); this.name = 'RuntimeRequestError' }
}
interface ClientOptions { url: string; tokenFile?: string; token?: string; timeoutMs?: number }
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const MAX_RESPONSE = 1024 * 1024
/** Мебибайты от брокера — целые и в границах протокола; иначе ответ не его. */
const memoryField = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === 'number' && Number.isInteger(value) && value >= RUNTIME_MEMORY_MIN_MB && value <= RUNTIME_MEMORY_MAX_MB)
/** Ядра от брокера — как в переписи комнат: дробные можно (1500m у оператора), мусор нельзя. */
const cpusField = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 64)
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeRequestError(tr("server.invalidKernelRuntimeResponse.110f37"))
  return value as Record<string, unknown>
}
function competitionStatus(value: unknown, expected?: string): CompetitionJobStatus {
  try {
    const row=parseCompetitionJobStatus(value)
    if (expected && row.jobId!==expected) throw new Error('identity')
    return row
  } catch { throw new RuntimeRequestError('Invalid competition job status or identity') }
}
function competitionCollection(value: unknown): CompetitionJobCollection {
  try { return parseCompetitionJobCollection(value) }
  catch { throw new RuntimeRequestError('Invalid competition job collection') }
}
function runtimeUrl(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new RuntimeRequestError(tr("server.invalidKernelRuntimeUrl.e0bb3b")) }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new RuntimeRequestError(tr("server.invalidKernelRuntimeUrlCredentialsQueryStrings.b2ea18"))
  }
  const local = ['localhost', '127.0.0.1', '[::1]', 'colloq-runtime'].includes(url.hostname) ||
    url.hostname.endsWith('.svc') || url.hostname.endsWith('.svc.cluster.local')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new RuntimeRequestError('Use HTTPS for a kernel runtime outside the local host or cluster; public cleartext URLs are disabled')
  }
  return url.origin
}
function readToken(options: ClientOptions): string {
  let token = options.token
  if (options.tokenFile) {
    try { token = fs.readFileSync(options.tokenFile, 'utf8').trim() }
    catch { throw new RuntimeRequestError(tr("server.cannotReadTheKernelRuntimeCredential.01bb5b")) }
  }
  if (!token || !TOKEN.test(token)) throw new RuntimeRequestError(tr("server.aValidKernelRuntimeCredentialIsRequired.bf5c2f"))
  return token
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const {done,value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new RuntimeRequestError(tr("server.kernelRuntimeResponseExceedsTheSizeLimit.3c5ab1")) }
      chunks.push(value)
    }
    if (!size) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new RuntimeRequestError(tr("server.kernelRuntimeReturnedInvalidJson.c52e11"), response.status) }
  } finally { reader.releaseLock() }
}

export class RuntimeClient {
  private readonly url: string
  constructor(private readonly options: ClientOptions) { this.url = runtimeUrl(options.url) }
  private async request(method: string, route: string, body?: unknown, timeout = 10000): Promise<unknown> {
    const token = readToken(this.options)
    let response: Response
    try {
      response = await fetch(`${this.url}${route}`, {
        method, redirect: 'error',
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? timeout),
      })
    } catch { throw new RuntimeRequestError(tr("server.kernelRuntimeIsUnreachableOrDidNot.86406b")) }
    const value = await boundedJson(response)
    if (!response.ok) {
      /*
       * Pod комнаты не встал на узел — и это видит вся комната.
       *
       * Текст брокера («node lacks allocatable memory») здесь не годится: он
       * уходит в ячейку и журнал ядра общего документа, то есть студентам. Им —
       * короткое и без устройства сервера; преподавателю совет с числами
       * рисует комната сама по `failure` (см. kernel/index.ts · kernelProblem).
       */
      const failure = parseRuntimeStartFailure(value)
      if (failure) throw new RuntimeRequestError(tr('server.kernel.unschedulable'), response.status, failure)
      const message = value && typeof value === 'object' && typeof (value as Record<string,unknown>).error === 'string'
        ? String((value as Record<string,unknown>).error).slice(0,512)
        : tr("server.kernelRuntimeRefusedTheRequest.39c35d", { p0: response.status })
      throw new RuntimeRequestError(message,response.status)
    }
    return value
  }
  async ensure(
    sessionId: string, environment: string, revision?: string, cpus?: number | null, memoryMb?: number | null,
  ): Promise<RuntimeEndpoint> {
    if (!isRuntimeSessionId(sessionId)) throw new RuntimeRequestError(tr("server.invalidSessionIdentifier.0f97c4"))
    const body = parseRuntimeEnsureRequest({
      environment, ...(revision ? {revision} : {}), ...(cpus != null ? {cpus} : {}),
      // Своё число комнаты — или ничего, и тогда умолчание брокера. До 18.09
      // этого поля не было, и Pod на k3s получал 2Gi при любом числе в форме.
      ...(memoryMb != null ? {memoryMb} : {}),
    })
    const value = object(await this.request('POST',`/v1/rooms/${encodeURIComponent(sessionId)}`,body,180000))
    if (typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length < 16 ||
      /[\r\n]/.test(value.token) || typeof value.instanceId !== 'string' || !value.instanceId ||
      value.environment !== environment || typeof value.revision !== 'string' || !RUNTIME_REVISION.test(value.revision)) {
      throw new RuntimeRequestError(tr("server.invalidKernelRuntimeEndpointOrInstanceIdentity.a63d8b"))
    }
    if (revision && value.revision !== revision) throw new RuntimeRequestError(tr("server.kernelRuntimeReturnedADifferentEnvironmentRevision.8f728c"))
    let target: URL
    try { target = new URL(value.url) } catch { throw new RuntimeRequestError(tr("server.invalidJupyterEndpointUrl.edef18")) }
    if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash ||
      !['','/'].includes(target.pathname)) throw new RuntimeRequestError(tr("server.invalidJupyterEndpointUrl.edef18"))
    return {url:value.url, token:value.token, instanceId:value.instanceId,environment,revision:value.revision}
  }
  /**
   * Память и ядра живой комнате — без нового Pod и без потери её Python.
   *
   * Поля нет — ресурс не трогается; `null` — умолчание брокера. Pod нет —
   * `absent`, и это не ошибка: число уже в строке семинара, следующий подъём
   * возьмёт его оттуда.
   */
  async resize(sessionId: string, change: RuntimeResizeRequest): Promise<RuntimeResizeResult> {
    if (!isRuntimeSessionId(sessionId)) throw new RuntimeRequestError(tr("server.invalidSessionIdentifier.0f97c4"))
    const body = parseRuntimeResizeRequest(change)
    // Встаёт в очередь комнаты за её подъёмом — отсюда срок как у ensure.
    const value = object(await this.request('PATCH',`/v1/rooms/${encodeURIComponent(sessionId)}`,body,180000))
    if (!['applied','pending','absent'].includes(String(value.outcome)) || !memoryField(value.memoryMb) || !cpusField(value.cpus))
      throw new RuntimeRequestError(tr("server.invalidKernelRuntimeResponse.110f37"))
    return {
      outcome:value.outcome as RuntimeResizeResult['outcome'],
      ...(typeof value.memoryMb === 'number' ? {memoryMb:value.memoryMb} : {}),
      ...(typeof value.cpus === 'number' ? {cpus:value.cpus} : {}),
    }
  }
  async stop(sessionId: string, permanent = false): Promise<void> {
    if (!isRuntimeSessionId(sessionId)) throw new RuntimeRequestError(tr("server.invalidSessionIdentifier.0f97c4"))
    const value=object(await this.request('DELETE',`/v1/rooms/${encodeURIComponent(sessionId)}${permanent ? '?retire=true' : ''}`,undefined,180000))
    if (value.ok !== true) throw new RuntimeRequestError(tr("server.kernelRuntimeDidNotConfirmRoomTermination.eed974"))
  }
  async health(): Promise<RuntimeHealth> {
    try {
      const value=object(await this.request('GET','/v1/health',undefined,5000))
      if (typeof value.ok !== 'boolean' || !(value.reason === null || typeof value.reason === 'string')) {
        throw new RuntimeRequestError(tr("server.invalidKernelRuntimeHealthResponse.dc255b"))
      }
      const cpus = value.defaultCpus
      if (cpus !== undefined && (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0 || cpus > 64))
        throw new RuntimeRequestError(tr("server.invalidKernelRuntimeHealthResponse.dc255b"))
      if (!memoryField(value.defaultMemoryMb) || !memoryField(value.maxMemoryMb))
        throw new RuntimeRequestError(tr("server.invalidKernelRuntimeHealthResponse.dc255b"))
      const recovery = value.recovery as RuntimeHealth['recovery']
      const validRecovery = recovery && ['rollbackRetries', 'rollbackFailures', 'rollbacksApplied'].every((key) =>
        Number.isSafeInteger(recovery[key as keyof typeof recovery]) && recovery[key as keyof typeof recovery] >= 0)
      const capability=(raw:unknown):raw is {available:boolean;code:string;reason:string|null} => {
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return false
        const row=raw as Record<string,unknown>
        return typeof row.available==='boolean'&&typeof row.code==='string'&&row.code.length<=100&&(row.reason===null||typeof row.reason==='string'&&row.reason.length<=500)
      }
      const competition=value.competition as Record<string,unknown>|undefined
      const validCompetition=competition&&capability(competition.execution)&&capability(competition.preparation)
      return {
        ok:value.ok,reason:value.ok ? null : value.reason as string | null,
        ...(typeof cpus === 'number' ? {defaultCpus:cpus} : {}),
        ...(typeof value.defaultMemoryMb === 'number' ? {defaultMemoryMb:value.defaultMemoryMb} : {}),
        ...(typeof value.maxMemoryMb === 'number' ? {maxMemoryMb:value.maxMemoryMb} : {}),
        ...(validRecovery ? { recovery } : {}),
        ...(validCompetition ? {competition:competition as unknown as NonNullable<RuntimeHealth['competition']>} : {}),
      }
    } catch(error) { return {ok:false,reason:error instanceof Error ? error.message : tr("server.kernelRuntimeIsUnavailable.44455e")} }
  }
  async catalog(): Promise<RuntimeCatalog> { return parseRuntimeCatalog(await this.request('GET','/v1/catalog')) }
  async startCompetitionJob(intent: CompetitionJobIntent): Promise<CompetitionJobStatus> {
    const valid = parseCompetitionJobIntent(intent)
    return competitionStatus(await this.request('POST',`/v1/competition-jobs/${valid.jobId}`,valid,180000), valid.jobId)
  }
  async competitionJob(jobId: string): Promise<CompetitionJobStatus> {
    if (!COMPETITION_JOB_ID.test(jobId)) throw new RuntimeRequestError('Invalid competition job identity')
    return competitionStatus(await this.request('GET',`/v1/competition-jobs/${jobId}`,undefined,30000),jobId)
  }
  async collectCompetitionJob(jobId: string): Promise<CompetitionJobCollection> {
    if (!COMPETITION_JOB_ID.test(jobId)) throw new RuntimeRequestError('Invalid competition job identity')
    return competitionCollection(await this.request('POST',`/v1/competition-jobs/${jobId}/collect`,undefined,180000))
  }
  async cancelCompetitionJob(jobId: string): Promise<void> {
    if (!COMPETITION_JOB_ID.test(jobId)) throw new RuntimeRequestError('Invalid competition job identity')
    const result = object(await this.request('DELETE',`/v1/competition-jobs/${jobId}`,undefined,90000))
    if (result.ok !== true) throw new RuntimeRequestError('Competition job cancellation was not confirmed')
  }
  async competitionJobs(): Promise<CompetitionJobStatus[]> {
    const result = object(await this.request('GET','/v1/competition-jobs',undefined,30000))
    if (!Array.isArray(result.jobs) || result.jobs.length > 10000) throw new RuntimeRequestError('Invalid competition job list')
    return result.jobs.map(value => competitionStatus(value))
  }
  async rooms(): Promise<RuntimeRoom[]> {
    const value=object(await this.request('GET','/v1/rooms'))
    if (!Array.isArray(value.rooms) || value.rooms.length>10000) throw new RuntimeRequestError(tr("server.invalidRuntimeRoomList.9cdcda"))
    return value.rooms.map(raw=>{
      const row=object(raw)
      if (typeof row.sessionId!=='string'||!isRuntimeSessionId(row.sessionId)||typeof row.instanceId!=='string'||
        !['pending','ready','failed','terminating'].includes(String(row.phase))||typeof row.environment!=='string'||
        typeof row.revision!=='string'||!RUNTIME_REVISION.test(row.revision)) throw new RuntimeRequestError(tr("server.invalidRuntimeRoomList.9cdcda"))
      if (row.cpus !== undefined && (typeof row.cpus !== 'number' || !Number.isFinite(row.cpus) || row.cpus <= 0 || row.cpus > 64))
        throw new RuntimeRequestError(tr("server.invalidRuntimeRoomList.9cdcda"))
      if (!memoryField(row.memoryMb)) throw new RuntimeRequestError(tr("server.invalidRuntimeRoomList.9cdcda"))
      return row as unknown as RuntimeRoom
    })
  }
}

export function kernelRuntimeClient(): RuntimeClient {
  requireKernelIsolation()
  const url=process.env.KERNEL_RUNTIME_URL?.trim()
  if (!url) throw new RuntimeRequestError(tr("server.kernelRuntimeIsNotConfiguredSetKernel.4598c3"))
  const tokenFile=process.env.KERNEL_RUNTIME_TOKEN_FILE?.trim()
  if (process.env.NODE_ENV==='production'&&!tokenFile) throw new RuntimeRequestError(tr("server.productionRequiresKernelRuntimeTokenFile.6f556a"))
  return new RuntimeClient({url,tokenFile,token:process.env.KERNEL_RUNTIME_TOKEN})
}
export function loadRuntimeCatalog(): RuntimeCatalog {
  const file=process.env.KERNEL_CATALOG_FILE?.trim()
  if (!file) throw new RuntimeRequestError(tr("server.kernelImageCatalogIsNotConfiguredSet.60170e"))
  try {
    if (fs.statSync(file).size>MAX_RESPONSE) throw new Error('too large')
    return parseRuntimeCatalog(JSON.parse(fs.readFileSync(file,'utf8')))
  } catch(error) {
    throw new RuntimeRequestError(tr("server.cannotReadTheKernelImageCatalog.c9c5bc", { p0: error instanceof Error ? error.message : 'invalid catalog' }))
  }
}
function defaultFile(): string { return path.join(config.dataDir,'kernel-default.json') }
export function runtimeDefaultEnvironment(): string {
  const catalog=loadRuntimeCatalog()
  let name=catalog.defaultEnvironment
  if (fs.existsSync(defaultFile())) {
    try {
      const stored=JSON.parse(fs.readFileSync(defaultFile(),'utf8'))
      if (typeof stored.environment!=='string') throw new Error('missing environment')
      name=stored.environment
    } catch { throw new RuntimeRequestError(tr("server.theSavedDefaultKernelEnvironmentIsInvalid.c7c72c")) }
  }
  resolveRuntimeEnvironment(catalog,name)
  return name
}
export function setRuntimeDefaultEnvironment(name: string): void {
  resolveRuntimeEnvironment(loadRuntimeCatalog(),name)
  const file=defaultFile(),tmp=`${file}.${randomUUID()}.tmp`
  fs.mkdirSync(config.dataDir,{recursive:true,mode:0o700})
  try { fs.writeFileSync(tmp,JSON.stringify({environment:name})+'\n',{mode:0o600});fs.renameSync(tmp,file) }
  finally { if(fs.existsSync(tmp))fs.unlinkSync(tmp) }
}
export function runtimeEnvironment(name?: string | null,revision?: string | null) {
  const catalog=loadRuntimeCatalog()
  return resolveRuntimeEnvironment(catalog,name?.trim()||runtimeDefaultEnvironment(),revision??undefined)
}
export { imageRevision }
