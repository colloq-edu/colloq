import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  isRuntimeSessionId,
  parseRuntimeEnsureRequest,
  RUNTIME_RETIRE_QUERY,
  type RuntimeCatalog,
} from '../../shared/runtime.js'
import { RuntimeError, type RuntimeController } from './controller.js'
import { KubernetesError } from './kubernetes.js'

interface Options {
  token: () => string
  catalog: () => RuntimeCatalog
  controller: Pick<RuntimeController, 'ensure' | 'remove' | 'list' | 'health'>
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
          reply(res, health.ok ? 200 : 503, health)
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
        reply(res, status, { error })
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
