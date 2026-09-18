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
  /**
   * `contentType` нужен ровно PATCH: подресурс resize принимает стратегическое
   * слияние, где контейнеры сливаются по имени. Обычный JSON заменил бы список
   * контейнеров целиком — такой патч API отвергает.
   */
  request<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T>
}
export class KubernetesError extends Error {
  constructor(
    readonly status: number,
    reason: string,
    /**
     * Какого ресурса узлу не хватило — единственное, что из тела ответа API
     * выходит наружу, и только именем ресурса. 403 на `pods/resize` значит
     * одно из двух: у брокера нет права или узлу столько не дать (так API
     * 1.35+ отвечает на невыполнимое изменение, проверено на k3s 1.36).
     * Преподавателю нужно второе, оператору — первое; путать их нельзя.
     */
    readonly insufficient?: string,
  ) {
    super(
      `Kubernetes HTTP ${status}: ${/^[A-Za-z]{1,80}$/.test(reason) ? reason : 'RequestFailed'}` +
        (insufficient ? ` (node lacks allocatable ${insufficient})` : ''),
    )
  }
}
const INSUFFICIENT = /enough allocatable resources: ([a-z0-9./-]{1,63})/
const CONTENT_TYPES = new Set(['application/json', 'application/strategic-merge-patch+json'])
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
  async request<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#\\]/.test(path))
      throw new Error('Invalid Kubernetes request path')
    if (!CONTENT_TYPES.has(contentType)) throw new Error('Unsupported Kubernetes request content type')
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
              ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) }
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
              const lacking =
                typeof data?.message === 'string' ? INSUFFICIENT.exec(data.message)?.[1] : undefined
              reject(
                new KubernetesError(
                  status,
                  typeof data?.reason === 'string' ? data.reason : 'RequestFailed',
                  lacking,
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
