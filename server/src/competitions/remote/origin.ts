/**
 * This server's address as the machines are told to reach it: an http(s)
 * origin and nothing else, the shape the agent keeps (shared/remote-runner.ts
 * · remoteJoinTarget) and colloq-host checks (check_home). A PUBLIC_URL with
 * a path, a query or credentials in it is no origin; `null` then.
 */
export function homeOrigin(text: string): string | null {
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Whether an address is this server's own loopback — `localhost` (and any
 * name under it, RFC 6761), 127.0.0.0/8, ::1 — which nothing on another
 * machine can reach: the default PUBLIC_URL of an instance nobody gave an
 * address yet (config.ts, http://localhost:PORT). A join command naming it
 * enrolls no machine, so the panel warns as `colloq-host runner-code` does;
 * and a probe of it never leaves this machine, so it says nothing of the
 * relay and the tunnel the machines come through (liveness.ts · probeOwnPath).
 */
export function loopbackAddress(text: string): boolean {
  let host: string
  try {
    host = new URL(text).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.[0-9]{1,3}){3}$/.test(host)
    || host === '::1' || /^::ffff:127(?:\.[0-9]{1,3}){3}$/.test(host) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
}
