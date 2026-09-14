/** Lease parsing shared by the native server and CLI; no filesystem side effects. */
export interface PublicUrlLease { runId: string; owner: string; url: string; expiresAt: number }
export function publicLeaseAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return url.href.replace(/\/+$/, '')
  } catch { return null }
}
export function parsePublicUrlLease(raw: string | null): PublicUrlLease | null {
  try {
    const lease = JSON.parse(raw ?? '')
    if (!lease || typeof lease.runId !== 'string' || !lease.runId || typeof lease.owner !== 'string' || !lease.owner || !Number.isFinite(lease.expiresAt)) return null
    const url = publicLeaseAddress(lease.url)
    return url ? { runId: lease.runId, owner: lease.owner, expiresAt: lease.expiresAt, url } : null
  } catch { return null }
}
export function leaseUrl(raw: string | null, runId: string, now: number): string | undefined {
  const lease = parsePublicUrlLease(raw)
  return lease && lease.runId === runId && lease.expiresAt > now ? lease.url : undefined
}
