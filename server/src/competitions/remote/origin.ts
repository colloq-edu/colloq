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
