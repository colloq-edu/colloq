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
   * `contentType` is needed exactly by PATCH: the resize subresource accepts a
   * strategic merge, where containers are merged by name. Plain JSON would
   * replace the list of containers entirely, and the API rejects such a patch.
   */
  request<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T>
}
/**
 * What the API server's "no" to a write was about, in the few words of its
 * message we know, and nothing else of that message: the rest names the
 * cluster's objects, its policies and other tenants' usage.
 *
 * - `quota`: a ResourceQuota of the namespace has no room left ("exceeded
 *   quota"), with the quota's names for what was asked over it
 *   (`requests.nvidia.com/gpu`, `limits.memory`), at most three;
 * - `runtime-class`: the Pod names a RuntimeClass the cluster does not have;
 * - `permission`: the broker's ServiceAccount may not do it (RBAC);
 * - `admission`: something else said no at admission — a policy engine's
 *   webhook, a ValidatingAdmissionPolicy, Pod Security, a LimitRange.
 *
 * A 403 is one of them (unless a node lacked a resource: `insufficient`
 * below); a 400 or 422 only when it says an admission check denied the
 * request (a webhook's denial is a 400 unless the webhook picks its own code),
 * since otherwise it is a request we built wrong.
 */
export type KubernetesRefusal =
  | { kind: 'quota'; resources: string[] }
  | { kind: 'runtime-class' | 'permission' | 'admission' }
const QUOTA = /\bexceeded quota: [^,]{0,253}, requested: (.{0,1024}?), used: /
// The quota's resource names are sorted and joined with bare commas: `limits.memory=2Gi,requests.memory=2Gi`.
const QUOTA_NAME = /(?:^|,)\s*([A-Za-z0-9](?:[A-Za-z0-9._/-]{0,98}[A-Za-z0-9])?)=/g
export function refusalOf(status: number, message: string): KubernetesRefusal | undefined {
  const text = message.slice(0, 4096)
  if (status === 403) {
    const quota = QUOTA.exec(text)
    if (quota) return { kind: 'quota', resources: [...new Set([...quota[1].matchAll(QUOTA_NAME)].map((match) => match[1]))].slice(0, 3) }
    // The RuntimeClass admission plugin: `pod rejected: RuntimeClass "nvidia" not found`.
    if (/\bRuntimeClass "[^"]{1,253}" not found/.test(text)) return { kind: 'runtime-class' }
    // RBAC: `User "system:serviceaccount:…" cannot create resource "pods" in API group ""…`.
    if (/\bcannot [a-z]{1,32} resource "/.test(text)) return { kind: 'permission' }
    return { kind: 'admission' }
  }
  if ((status === 400 || status === 422) && /\bdenied (?:the )?request\b/.test(text)) return { kind: 'admission' }
  return undefined
}
export class KubernetesError extends Error {
  constructor(
    readonly status: number,
    reason: string,
    /**
     * Which resource the node ran short of: the only thing from the API
     * response body that gets out, and only as the resource name. A 403 on
     * `pods/resize` means one of two things: the broker lacks the permission,
     * or the node cannot give that much (that is how API 1.35+ answers an
     * infeasible change, checked on k3s 1.36). The teacher needs the second,
     * the operator the first; they must not be confused.
     */
    readonly insufficient?: string,
    /**
     * Why the API server refused it, as far as refusalOf can tell; never in
     * the message, which stays the status and the reason word.
     */
    readonly refusal?: KubernetesRefusal,
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
              const message = typeof data?.message === 'string' ? data.message : ''
              const lacking = message ? INSUFFICIENT.exec(message)?.[1] : undefined
              reject(
                new KubernetesError(
                  status,
                  typeof data?.reason === 'string' ? data.reason : 'RequestFailed',
                  lacking,
                  // A node short of a resource is that, not an admission policy.
                  lacking ? undefined : refusalOf(status, message),
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
