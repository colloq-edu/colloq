import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const LEASE_TTL_MS = 15000
import { leaseUrl, parsePublicUrlLease, publicLeaseAddress as safeUrl, type PublicUrlLease as Lease } from '@shared/local-public-url-lease'
function read(file: string): Lease | null {
  try { return parsePublicUrlLease(fs.readFileSync(file, 'utf8')) } catch { return null }
}
export function readLeaseUrl(file: string, runId: string, now = Date.now()): string | null {
  try { return leaseUrl(fs.readFileSync(file, 'utf8'), runId, now) ?? null } catch { return null }
}
/** Serialize independent host processes; never replace a live owner's lease. */
function locked<T>(file: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  // A process can be killed during this tiny critical section. Its abandoned
  // lock may be reclaimed only after every lease it could have written expires.
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.rmdirSync(lock) } catch {}
  fs.mkdirSync(lock, { mode: 0o700 })
  try { return operation() } finally { fs.rmdirSync(lock) }
}
function write(file: string, lease: Lease): void {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(lease) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally { try { fs.unlinkSync(temp) } catch {} }
}
export function acquireLease(file: string, value: Omit<Lease, 'expiresAt'>, now = Date.now(), ttl = LEASE_TTL_MS): void {
  const url = safeUrl(value.url)
  if (!url || !value.owner || !value.runId) throw new Error('Invalid public URL lease')
  locked(file, () => {
    const previous = read(file)
    if (previous && previous.expiresAt > now) throw new Error('A tunnel already owns the public URL')
    write(file, { ...value, url, expiresAt: now + ttl })
  })
}
export function renewLease(file: string, runId: string, owner: string, now = Date.now(), ttl = LEASE_TTL_MS): boolean {
  return locked(file, () => {
    const lease = read(file)
    if (!lease || lease.runId !== runId || lease.owner !== owner || lease.expiresAt <= now) return false
    write(file, { ...lease, expiresAt: now + ttl })
    return true
  })
}
export function releaseLease(file: string, runId: string, owner: string): boolean {
  return locked(file, () => {
    const lease = read(file)
    if (!lease || lease.runId !== runId || lease.owner !== owner) return false
    fs.unlinkSync(file)
    return true
  })
}
