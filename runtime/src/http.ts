import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  isRuntimeSessionId,
  parseRuntimeEnsureRequest,
  parseRuntimeResizeRequest,
  RUNTIME_RETIRE_QUERY,
  type RuntimeCatalog,
} from '../../shared/runtime.js'
import { RuntimeError, type RuntimeController } from './controller.js'
import { KubernetesError } from './kubernetes.js'
import { COMPETITION_JOB_ID, parseCompetitionJobIntent } from '../../shared/competition-runtime.js'
import type { CompetitionJobs } from './competition-jobs.js'

interface Options {
  token: () => string
  catalog: () => RuntimeCatalog
  controller: Pick<RuntimeController, 'ensure' | 'remove' | 'list' | 'health' | 'resize'>
  jobs?: Pick<CompetitionJobs, 'start' | 'status' | 'collect' | 'cancel' | 'list' | 'health'>
}
const digest = (value: string) => createHash('sha256').update(value).digest()
const reply = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new RuntimeError('Expected application/json', 415)
  const length = Number(req.headers['content-length'] ?? 0)
  if (length > 4096) throw new RuntimeError('Request body exceeds 4096 bytes', 413)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 4096) throw new RuntimeError('Request body exceeds 4096 bytes', 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RuntimeError('Invalid JSON', 400)
  }
}
export function createRuntimeServer(options: Options) {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const authorization = req.headers.authorization ?? ''
        const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        if (!timingSafeEqual(digest(candidate), digest(options.token())) || !candidate) {
          reply(res, 401, { error: 'Unauthorized' })
          req.resume()
          return
        }
        const rawPath = req.url ?? ''
        const permanent = req.method === 'DELETE' && rawPath.endsWith(RUNTIME_RETIRE_QUERY)
        const path = permanent ? rawPath.slice(0, -RUNTIME_RETIRE_QUERY.length) : rawPath
        if (path === '/v1/health' && req.method === 'GET') {
          const health = await options.controller.health()
          const competition = options.jobs ? await options.jobs.health() : {
            execution: { available: false, code: 'broker_unavailable', reason: 'Competition broker is not configured' },
            preparation: { available: false, code: 'broker_unavailable', reason: 'Competition broker is not configured' },
          }
          reply(res, health.ok ? 200 : 503, { ...health, competition })
          return
        }
        if (path === '/v1/catalog' && req.method === 'GET') {
          reply(res, 200, options.catalog())
          return
        }
        if (path === '/v1/rooms' && req.method === 'GET') {
          reply(res, 200, { rooms: await options.controller.list() })
          return
        }
        if (path === '/v1/competition-jobs') {
          if (req.method !== 'GET') throw new RuntimeError('Method not allowed', 405)
          if (!options.jobs) throw new RuntimeError('Competition broker is not configured', 503)
          reply(res, 200, { jobs: await options.jobs.list() })
          return
        }
        if (path.startsWith('/v1/competition-jobs/')) {
          const rest = path.slice('/v1/competition-jobs/'.length)
          const collect = rest.endsWith('/collect')
          const id = collect ? rest.slice(0, -'/collect'.length) : rest
          if (!COMPETITION_JOB_ID.test(id)) throw new RuntimeError('Invalid competition job ID', 400)
          if (!options.jobs) throw new RuntimeError('Competition broker is not configured', 503)
          if (collect) {
            if (req.method !== 'POST') throw new RuntimeError('Method not allowed', 405)
            if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)
              throw new RuntimeError('Collect does not accept a request body', 400)
            reply(res, 200, await options.jobs.collect(id))
            return
          }
          if (req.method === 'POST') {
            let intent
            try { intent = parseCompetitionJobIntent(await body(req)) }
            catch (err) { if (err instanceof RuntimeError) throw err
              throw new RuntimeError(err instanceof Error ? err.message : 'Invalid competition intent', 400) }
            reply(res, 200, await options.jobs.start(id, intent))
            return
          }
          if (req.method === 'GET') { reply(res, 200, await options.jobs.status(id)); return }
          if (req.method === 'DELETE') {
            if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)
              throw new RuntimeError('DELETE does not accept a request body', 400)
            await options.jobs.cancel(id)
            reply(res, 200, { ok: true })
            return
          }
          throw new RuntimeError('Method not allowed', 405)
        }
        if (path.startsWith('/v1/rooms/')) {
          const id = path.slice('/v1/rooms/'.length)
          if (!isRuntimeSessionId(id)) throw new RuntimeError('Invalid room ID', 400)
          if (req.method === 'POST') {
            let intent
            try {
              intent = parseRuntimeEnsureRequest(await body(req))
            } catch (err) {
              if (err instanceof RuntimeError) throw err
              throw new RuntimeError(err instanceof Error ? err.message : 'Invalid intent', 400)
            }
            reply(res, 200, await options.controller.ensure(id, intent))
            return
          }
          if (req.method === 'PATCH') {
            // Только память и ядра живой комнаты — Pod этим входом не создать.
            let intent
            try {
              intent = parseRuntimeResizeRequest(await body(req))
            } catch (err) {
              if (err instanceof RuntimeError) throw err
              throw new RuntimeError(err instanceof Error ? err.message : 'Invalid resize intent', 400)
            }
            reply(res, 200, await options.controller.resize(id, intent))
            return
          }
          if (req.method === 'DELETE') {
            if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)
              throw new RuntimeError('DELETE does not accept a request body', 400)
            await options.controller.remove(id, permanent)
            reply(res, 200, { ok: true })
            return
          }
          throw new RuntimeError('Method not allowed', 405)
        }
        throw new RuntimeError('Not found', 404)
      } catch (err) {
        if (res.destroyed) return
        const status = err instanceof RuntimeError ? err.status : 503
        const error =
          err instanceof RuntimeError || err instanceof KubernetesError
            ? err.message.slice(0, 300)
            : 'Runtime service is unavailable'
        // Рядом с текстом — слово и числа отказа, если они есть: веб переводит
        // их человеку сам, а текст остаётся для журнала (shared/runtime.ts).
        const failure = err instanceof RuntimeError ? err.failure : undefined
        reply(res, status, { error, ...failure })
        req.resume()
      }
    })()
  })
  server.requestTimeout = 150000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  server.maxHeadersCount = 32
  return server
}
