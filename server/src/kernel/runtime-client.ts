/** The web process sends room intent; it never forwards a container specification. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import {
  imageRevision, isRuntimeSessionId, parseRuntimeCatalog, parseRuntimeEnsureRequest,
  resolveRuntimeEnvironment, RUNTIME_REVISION,
  type RuntimeCatalog, type RuntimeEndpoint, type RuntimeHealth, type RuntimeRoom,
} from '@shared/runtime'

export type KernelBackend = 'broker' | 'docker' | 'test'
export function selectKernelBackend(env: NodeJS.ProcessEnv): KernelBackend {
  const chosen = env.KERNEL_BACKEND?.trim() ||
    (env.NODE_ENV === 'production' || env.KERNEL_RUNTIME_URL ? 'broker' : 'docker')
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
  constructor(message: string, readonly status = 0) { super(message); this.name = 'RuntimeRequestError' }
}
interface ClientOptions { url: string; tokenFile?: string; token?: string; timeoutMs?: number }
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const MAX_RESPONSE = 1024 * 1024
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeRequestError('Invalid kernel runtime response')
  return value as Record<string, unknown>
}
function runtimeUrl(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new RuntimeRequestError('Invalid kernel runtime URL') }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new RuntimeRequestError('Invalid kernel runtime URL: credentials, query strings and path prefixes are not allowed')
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
    catch { throw new RuntimeRequestError('Cannot read the kernel runtime credential') }
  }
  if (!token || !TOKEN.test(token)) throw new RuntimeRequestError('A valid kernel runtime credential is required')
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
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new RuntimeRequestError('Kernel runtime response exceeds the size limit') }
      chunks.push(value)
    }
    if (!size) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new RuntimeRequestError('Kernel runtime returned invalid JSON', response.status) }
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
    } catch { throw new RuntimeRequestError('Kernel runtime is unreachable or did not respond in time') }
    const value = await boundedJson(response)
    if (!response.ok) {
      const message = value && typeof value === 'object' && typeof (value as Record<string,unknown>).error === 'string'
        ? String((value as Record<string,unknown>).error).slice(0,512)
        : `Kernel runtime refused the request (${response.status})`
      throw new RuntimeRequestError(message,response.status)
    }
    return value
  }
  async ensure(sessionId: string, environment: string, revision?: string): Promise<RuntimeEndpoint> {
    if (!isRuntimeSessionId(sessionId)) throw new RuntimeRequestError('Invalid session identifier')
    const body = parseRuntimeEnsureRequest({environment,...(revision ? {revision} : {})})
    const value = object(await this.request('POST',`/v1/rooms/${encodeURIComponent(sessionId)}`,body,180000))
    if (typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length < 16 ||
      /[\r\n]/.test(value.token) || typeof value.instanceId !== 'string' || !value.instanceId ||
      value.environment !== environment || typeof value.revision !== 'string' || !RUNTIME_REVISION.test(value.revision)) {
      throw new RuntimeRequestError('Invalid kernel runtime endpoint or instance identity')
    }
    if (revision && value.revision !== revision) throw new RuntimeRequestError('Kernel runtime returned a different environment revision')
    let target: URL
    try { target = new URL(value.url) } catch { throw new RuntimeRequestError('Invalid Jupyter endpoint URL') }
    if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash ||
      !['','/'].includes(target.pathname)) throw new RuntimeRequestError('Invalid Jupyter endpoint URL')
    return {url:value.url, token:value.token, instanceId:value.instanceId,environment,revision:value.revision}
  }
  async stop(sessionId: string, permanent = false): Promise<void> {
    if (!isRuntimeSessionId(sessionId)) throw new RuntimeRequestError('Invalid session identifier')
    const value=object(await this.request('DELETE',`/v1/rooms/${encodeURIComponent(sessionId)}${permanent ? '?retire=true' : ''}`,undefined,180000))
    if (value.ok !== true) throw new RuntimeRequestError('Kernel runtime did not confirm room termination')
  }
  async health(): Promise<RuntimeHealth> {
    try {
      const value=object(await this.request('GET','/v1/health',undefined,5000))
      if (typeof value.ok !== 'boolean' || !(value.reason === null || typeof value.reason === 'string')) {
        throw new RuntimeRequestError('Invalid kernel runtime health response')
      }
      return {ok:value.ok,reason:value.ok ? null : value.reason as string | null}
    } catch(error) { return {ok:false,reason:error instanceof Error ? error.message : 'Kernel runtime is unavailable'} }
  }
  async catalog(): Promise<RuntimeCatalog> { return parseRuntimeCatalog(await this.request('GET','/v1/catalog')) }
  async rooms(): Promise<RuntimeRoom[]> {
    const value=object(await this.request('GET','/v1/rooms'))
    if (!Array.isArray(value.rooms) || value.rooms.length>10000) throw new RuntimeRequestError('Invalid runtime room list')
    return value.rooms.map(raw=>{
      const row=object(raw)
      if (typeof row.sessionId!=='string'||!isRuntimeSessionId(row.sessionId)||typeof row.instanceId!=='string'||
        !['pending','ready','failed','terminating'].includes(String(row.phase))||typeof row.environment!=='string'||
        typeof row.revision!=='string'||!RUNTIME_REVISION.test(row.revision)) throw new RuntimeRequestError('Invalid runtime room list')
      return row as unknown as RuntimeRoom
    })
  }
}

export function kernelRuntimeClient(): RuntimeClient {
  requireKernelIsolation()
  const url=process.env.KERNEL_RUNTIME_URL?.trim()
  if (!url) throw new RuntimeRequestError('Kernel runtime is not configured: set KERNEL_RUNTIME_URL')
  const tokenFile=process.env.KERNEL_RUNTIME_TOKEN_FILE?.trim()
  if (process.env.NODE_ENV==='production'&&!tokenFile) throw new RuntimeRequestError('Production requires KERNEL_RUNTIME_TOKEN_FILE')
  return new RuntimeClient({url,tokenFile,token:process.env.KERNEL_RUNTIME_TOKEN})
}
export function loadRuntimeCatalog(): RuntimeCatalog {
  const file=process.env.KERNEL_CATALOG_FILE?.trim()
  if (!file) throw new RuntimeRequestError('Kernel image catalog is not configured: set KERNEL_CATALOG_FILE')
  try {
    if (fs.statSync(file).size>MAX_RESPONSE) throw new Error('too large')
    return parseRuntimeCatalog(JSON.parse(fs.readFileSync(file,'utf8')))
  } catch(error) {
    throw new RuntimeRequestError(`Cannot read the kernel image catalog: ${error instanceof Error ? error.message : 'invalid catalog'}`)
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
    } catch { throw new RuntimeRequestError('The saved default kernel environment is invalid') }
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
