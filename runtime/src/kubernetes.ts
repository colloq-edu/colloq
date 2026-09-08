import { request } from 'node:https'
import { readBoundedFile } from './config.js'

export interface KubeObject {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    uid?: string
    resourceVersion?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    deletionTimestamp?: string
  }
  spec: Record<string, any>
  status?: Record<string, any>
}
export interface KubernetesClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>
}
export class KubernetesError extends Error {
  constructor(
    readonly status: number,
    reason: string,
  ) {
    super(
      `Kubernetes HTTP ${status}: ${/^[A-Za-z]{1,80}$/.test(reason) ? reason : 'RequestFailed'}`,
    )
  }
}
export class HttpsKubernetesClient implements KubernetesClient {
  private readonly origin: URL
  constructor(
    private readonly options: {
      url: string
      tokenFile: string
      caFile: string
      timeoutMs?: number
      maxResponseBytes?: number
    },
  ) {
    this.origin = new URL(options.url)
    if (
      this.origin.protocol !== 'https:' ||
      this.origin.username ||
      this.origin.password ||
      this.origin.pathname !== '/' ||
      this.origin.search ||
      this.origin.hash
    )
      throw new Error('Kubernetes API must be an HTTPS origin')
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#\\]/.test(path))
      throw new Error('Invalid Kubernetes request path')
    const token = readBoundedFile(this.options.tokenFile, 16384).trim()
    if (!token || /[\s]/.test(token)) throw new Error('Invalid Kubernetes service account token')
    // Projected token and CA files are read per request, including after rotations.
    const ca = readBoundedFile(this.options.caFile, 131072)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    if (payload && Buffer.byteLength(payload) > 262144)
      throw new Error('Kubernetes request exceeds size limit')
    return new Promise<T>((resolve, reject) => {
      const req = request(
        this.origin,
        {
          method,
          path,
          ca,
          rejectUnauthorized: true,
          agent: false,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          let bytes = 0
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > (this.options.maxResponseBytes ?? 2 * 1024 * 1024)) {
              const error = new Error('Kubernetes response exceeds size limit')
              clearTimeout(timer)
              reject(error)
              req.destroy(error)
              return
            }
            chunks.push(chunk)
          })
          res.on('error', reject)
          res.on('end', () => {
            clearTimeout(timer)
            let data: any
            try {
              data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
            } catch {
              reject(new Error('Kubernetes returned invalid JSON'))
              return
            }
            const status = res.statusCode ?? 502
            if (status < 200 || status >= 300) {
              reject(
                new KubernetesError(
                  status,
                  typeof data?.reason === 'string' ? data.reason : 'RequestFailed',
                ),
              )
              return
            }
            resolve(data as T)
          })
        },
      )
      const timer = setTimeout(
        () => req.destroy(new Error('Kubernetes request timed out')),
        this.options.timeoutMs ?? 10000,
      )
      req.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      req.end(payload)
    })
  }
}
