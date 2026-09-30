/**
 * Where competition "own packages" come from: public PyPI by default, or an
 * institution's own PyPI-compatible index (Nexus, Artifactory, devpi, a
 * bandersnatch mirror) when the network has no way to the internet, or IT
 * wants every package to pass through their mirror.
 *
 * Two settings, read in three places that must agree: the app, which hands
 * the index to pip (server/src/dependencies/preparation*.ts); the CONNECT
 * proxy, which lets through only these hosts (preparation-python.ts on
 * Docker, runtime/src/competition-proxy.ts on k3s); and the k3s installer,
 * which opens the proxy's network policy to the mirror (scripts/release.py,
 * a Python copy of the same rules).
 *
 *   DEPENDENCY_INDEX_URL    the simple index, https only, no credentials;
 *                           default https://pypi.org/simple.
 *   DEPENDENCY_FILES_HOSTS  extra hosts that serve the wheel files, when the
 *                           index links to another host (host or host:port,
 *                           commas between).
 *
 * The hosts named here may resolve to campus addresses: that is the point of
 * a mirror. Every other host (public PyPI's) keeps today's rule, public
 * addresses only, so a DNS answer can never turn pypi.org into a way inside.
 * Loopback, link-local and multicast stay refused for everyone.
 *
 * Plain http is refused: the proxy only tunnels TLS, and an index read
 * without it could hand pip any hashes it likes. Credentials in the URL are
 * refused too: they would travel into containers and logs; a mirror for
 * student packages is expected to allow anonymous reads.
 */

export const PUBLIC_PYPI_INDEX = 'https://pypi.org/simple'
const PUBLIC_PYPI = 'pypi.org:443'
const PUBLIC_FILES = 'files.pythonhosted.org:443'

export interface DependencySource {
  /** The simple index pip resolves against: https, no credentials or query, no trailing slash. */
  indexUrl: string
  /** Public PyPI: its JSON API tells a missing project from a missing wheel, its files come from files.pythonhosted.org. */
  publicPypi: boolean
  /** host:port pairs the CONNECT proxy may open. */
  authorities: string[]
  /** Those an operator configured: they may resolve to private addresses. */
  configured: string[]
  /** host:port pairs a wheel URL may point at. */
  files: string[]
}

export class DependencySourceError extends Error {
  override name = 'DependencySourceError'
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

function validHost(host: string): boolean {
  return host.length <= 253 && (IPV4.test(host) || (HOSTNAME.test(host) && !/^[\d.]+$/.test(host)))
}

function validPort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

/** One DEPENDENCY_FILES_HOSTS entry as host:port: `host`, `host:port`, or the same after `https://`. */
function fileAuthority(entry: string): string {
  const bare = entry.toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
  const match = /^([^:/]+)(?::(\d+))?$/.exec(bare)
  const port = match?.[2] === undefined ? 443 : validPort(match[2])
  if (!match || port === null || !validHost(match[1]!)) {
    throw new DependencySourceError(`DEPENDENCY_FILES_HOSTS: "${entry}" is not a host or host:port`)
  }
  return `${match[1]}:${port}`
}

export function dependencySource(env: Record<string, string | undefined>): DependencySource {
  const raw = (env.DEPENDENCY_INDEX_URL ?? '').trim()
  const extra = [...new Set((env.DEPENDENCY_FILES_HOSTS ?? '').split(/[\s,]+/).filter(Boolean).map(fileAuthority))]
  let indexUrl = PUBLIC_PYPI_INDEX
  let index = PUBLIC_PYPI
  if (raw) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new DependencySourceError('DEPENDENCY_INDEX_URL is not a URL')
    }
    if (url.protocol !== 'https:') throw new DependencySourceError('DEPENDENCY_INDEX_URL must be an https:// URL')
    if (url.username || url.password) {
      throw new DependencySourceError('DEPENDENCY_INDEX_URL must not carry credentials; allow anonymous reads on the mirror')
    }
    if (url.search || url.hash) throw new DependencySourceError('DEPENDENCY_INDEX_URL must not have a query or a fragment')
    if (!validHost(url.hostname)) throw new DependencySourceError('DEPENDENCY_INDEX_URL must name a host (or an IPv4 address)')
    const port = url.port ? Number(url.port) : 443
    index = `${url.hostname}:${port}`
    indexUrl = `https://${url.hostname}${port === 443 ? '' : `:${port}`}${url.pathname.replace(/\/+$/, '')}`
  }
  const publicPypi = index === PUBLIC_PYPI
  const files = [...new Set([...(publicPypi ? [PUBLIC_FILES] : [index]), ...extra])]
  return {
    indexUrl,
    publicPypi,
    authorities: [...new Set([index, ...files])],
    configured: [...new Set([...(raw ? [index] : []), ...extra])],
    files,
  }
}
