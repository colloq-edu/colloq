/**
 * Outbound HTTP through the institution's proxy.
 *
 * A university network often lets a server out only through an HTTP proxy,
 * and IT staff configure that the way every tool on the machine expects:
 * HTTPS_PROXY, HTTP_PROXY and NO_PROXY, in either case. Node's fetch reads none
 * of them, so the model endpoint and GitHub import simply failed to connect on
 * such a network. At start, and only when one of the proxy variables is set,
 * the process gets a global dispatcher that sends what leaves the campus
 * through the proxy (undici's EnvHttpProxyAgent) and keeps everything else
 * direct. Without the variables nothing changes at all: the module does not
 * even load undici, whose import alone would claim the global dispatcher slot.
 *
 * The one thing the proxy must never carry is Colloq's own traffic: the room
 * kernels' Jupyter (a loopback port, a Docker container name, a Kubernetes
 * Service under `.svc`) and the k3s broker (`colloq-runtime`). A campus proxy
 * cannot reach any of them, and with HTTP_PROXY set every cell run would fail
 * unless NO_PROXY listed names the operator cannot know in advance. So
 * loopback, private and link-local addresses, single-label names and the
 * `.localhost`, `.local`, `.internal` and `.svc` suffixes always go direct, on
 * top of NO_PROXY.
 *
 * NO_PROXY reads the way curl and Python read it, which is what IT staff
 * write for: `*` for everything, `example.edu` (also `.example.edu`,
 * `*.example.edu`) for that domain and every name under it, `host:port` for
 * one port, and address ranges (`10.0.0.0/8`, `fd00::/8`) for literal
 * addresses. An internal model endpoint (OPENAI_BASE_URL) on a private address
 * needs no entry at all; one under a campus domain needs that domain listed.
 *
 * NODE_EXTRA_CA_CERTS, the internal CA a TLS-inspecting proxy re-signs with,
 * needs nothing here: Node adds it to the default trust store at process
 * start, and both the proxied and the direct connections use that store. It
 * must be in the environment when the process starts, not only in .env; the
 * pip CLI and the server image both pass it that way.
 */
import net from 'node:net'
import type { Dispatcher } from 'undici'

export interface ProxySettings {
  /** The proxy for http:// requests, '' for none. */
  http: string
  /** The proxy for https:// requests: HTTPS_PROXY, else HTTP_PROXY, as undici and most tools fall back. */
  https: string
  /** NO_PROXY as written. */
  noProxy: string
  /** Variables that were set but could not be read as a proxy address, for the journal. */
  problems: string[]
}

/** The lowercase spelling wins, as in curl and undici; an empty one does not hide the uppercase. */
function variable(env: NodeJS.ProcessEnv, name: string): string {
  const lower = (env[name.toLowerCase()] ?? '').trim()
  return lower || (env[name] ?? '').trim()
}

/**
 * A proxy address as undici takes it. A bare `host:port` gets `http://`, the
 * way curl reads it; anything that is still not an http(s) URL with a host is
 * a problem to report, not a crash at start.
 */
function proxyAddress(raw: string, name: string, problems: string[]): string {
  if (!raw) return ''
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(value)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return url.href.replace(/\/$/, '')
  } catch {
    /* reported below */
  }
  problems.push(`${name} is not an http(s)://host:port address; it is ignored`)
  return ''
}

export function proxySettings(env: NodeJS.ProcessEnv = process.env): ProxySettings {
  const problems: string[] = []
  const http = proxyAddress(variable(env, 'HTTP_PROXY'), 'HTTP_PROXY', problems)
  const https = proxyAddress(variable(env, 'HTTPS_PROXY'), 'HTTPS_PROXY', problems) || http
  return { http, https, noProxy: variable(env, 'NO_PROXY'), problems }
}

/** A proxy address fit for a log line: the password, if any, is not. */
export function redactedProxy(address: string): string {
  try {
    const url = new URL(address)
    if (url.password) url.password = '***'
    return url.href.replace(/\/$/, '')
  } catch {
    return address
  }
}

/* ------------------------------------------------------------- NO_PROXY */

export interface NoProxyRules {
  all: boolean
  /** Domains (and literal addresses with a port): a name matches itself and every name under it. */
  hosts: Array<{ host: string; port: number | null }>
  /** Literal addresses and ranges, matched against literal addresses only, as curl does. */
  networks: net.BlockList
}

export function parseNoProxy(value: string): NoProxyRules {
  const rules: NoProxyRules = { all: false, hosts: [], networks: new net.BlockList() }
  for (const raw of value.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') {
      rules.all = true
      continue
    }
    const range = /^([^/]+)\/(\d{1,3})$/.exec(entry)
    if (range) {
      const family = net.isIP(range[1]!)
      const bits = Number(range[2])
      // An entry nobody can read exempts nothing, as in curl.
      if (family && bits <= (family === 4 ? 32 : 128)) rules.networks.addSubnet(range[1]!, bits, family === 4 ? 'ipv4' : 'ipv6')
      continue
    }
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    let host = entry
    let port: number | null = null
    if (bracketed) {
      host = bracketed[1]!
      port = bracketed[2] ? Number(bracketed[2]) : null
    } else if (!net.isIPv6(entry)) {
      const withPort = /^(.*):(\d+)$/.exec(entry)
      if (withPort) {
        host = withPort[1]!
        port = Number(withPort[2])
      }
    }
    const family = net.isIP(host)
    if (family && port === null) {
      rules.networks.addAddress(host, family === 4 ? 'ipv4' : 'ipv6')
      continue
    }
    host = host.replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '')
    if (host) rules.hosts.push({ host, port })
  }
  return rules
}

/** Addresses no campus proxy can reach on Colloq's behalf: loopback, private, carrier-grade NAT, link-local. */
const LOCAL_ADDRESSES = new net.BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
] as const) LOCAL_ADDRESSES.addSubnet(address, bits, 'ipv4')
for (const [address, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) {
  LOCAL_ADDRESSES.addSubnet(address, bits, 'ipv6')
}
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'svc']

function literalFamily(host: string): 'ipv4' | 'ipv6' | null {
  const family = net.isIP(host)
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null
}

/** Colloq's own destinations: kernels, the broker, a model on the LAN (see the header). */
export function localDestination(host: string): boolean {
  const family = literalFamily(host)
  if (family) return LOCAL_ADDRESSES.check(host, family)
  if (!host.includes('.')) return true
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/** Whether a request to this URL goes direct rather than through the proxy. */
export function bypassesProxy(target: URL, rules: NoProxyRules): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (localDestination(host) || rules.all) return true
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  const family = literalFamily(host)
  if (family && rules.networks.check(host, family)) return true
  return rules.hosts.some(
    (rule) => (rule.port === null || rule.port === port) && (host === rule.host || (!family && host.endsWith(`.${rule.host}`))),
  )
}

/* ------------------------------------------------------------ the dispatcher */

/**
 * One Content-Length where the caller's fetch wrote it twice.
 *
 * On Node 22 the fetch that hands requests to this dispatcher is Node's own
 * undici 6, while the proxy agent comes from the undici 7 package. A caller
 * that sets Content-Length itself (the openai client does, for every model
 * request) gets undici 6's computed value appended to its own, and the
 * dispatcher receives "2, 2". Node's own client takes the first number; undici
 * 7 refuses the whole request as an invalid header, so the Oracle failed with
 * "Connection error" behind a campus proxy while GitHub import worked (found
 * by CI on Node 22, 30 Sep 2026; the server image runs Node 22). Identical
 * repeats become one value; differing ones are left for undici to refuse.
 */
export function withOneContentLength(options: Dispatcher.DispatchOptions): Dispatcher.DispatchOptions {
  const headers = options.headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Symbol.iterator in headers) return options
  const value = (headers as Record<string, unknown>)['content-length']
  if (typeof value !== 'string' || !value.includes(',')) return options
  const parts = value.split(',').map((part) => part.trim())
  if (parts.some((part) => part !== parts[0])) return options
  return { ...options, headers: { ...(headers as Record<string, string>), 'content-length': parts[0]! } }
}

let active = false

/** Whether outbound HTTP goes through a proxy in this process (installOutboundProxy succeeded). */
export function outboundProxyActive(): boolean {
  return active
}

/**
 * Route this process's fetch through the proxy the environment names, or do
 * nothing when it names none. Called once at start (index.ts), after .env is
 * loaded. Returns what undoes it, for tests.
 */
export async function installOutboundProxy(env: NodeJS.ProcessEnv = process.env): Promise<(() => Promise<void>) | null> {
  const settings = proxySettings(env)
  for (const problem of settings.problems) console.warn(`[net] ${problem}`)
  if (!settings.http && !settings.https) return null
  /*
   * Node's own fetch loads its bundled undici lazily, and that copy puts its
   * Agent into the process's global dispatcher slot when it loads, unless the
   * slot is taken. Touching `Response` loads it now, so the slot holds Node's
   * Agent, and everything that does not go through the proxy (the rooms'
   * Jupyter traffic above all) keeps the very client it always had. Importing
   * the undici package first would put ITS Agent there instead.
   */
  void globalThis.Response
  const undici = await import('undici')
  const direct = undici.getGlobalDispatcher()
  /*
   * NO_PROXY is decided here, in front of it: undici's own reading knows
   * neither ranges nor subdomains of a plain entry. `proxyTunnel: false`
   * sends plain http as an ordinary proxy request instead of a CONNECT
   * tunnel: a campus proxy usually allows CONNECT to port 443 only (Squid's
   * default), and https still tunnels, as it must.
   */
  const proxied = new undici.EnvHttpProxyAgent({
    httpProxy: settings.http,
    httpsProxy: settings.https,
    noProxy: '',
    proxyTunnel: false,
  })
  const rules = parseNoProxy(settings.noProxy)

  class OutboundDispatcher extends undici.Dispatcher {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const target = new URL(String(options.origin))
      if (bypassesProxy(target, rules)) return direct.dispatch(options, handler)
      return proxied.dispatch(withOneContentLength(options), handler)
    }
    // Node's own Agent stays open: it is the process's, not ours.
    override close(): Promise<void>
    override close(callback: () => void): void
    override close(callback?: () => void): Promise<void> | void {
      const done = proxied.close()
      if (!callback) return done
      done.then(callback, callback)
    }
    override destroy(): Promise<void>
    override destroy(err: Error | null): Promise<void>
    override destroy(callback: () => void): void
    override destroy(err: Error | null, callback: () => void): void
    override destroy(first?: Error | null | (() => void), second?: () => void): Promise<void> | void {
      const callback = typeof first === 'function' ? first : second
      const done = proxied.destroy(typeof first === 'function' ? null : (first ?? null))
      if (!callback) return done
      done.then(callback, callback)
    }
  }

  undici.setGlobalDispatcher(new OutboundDispatcher())
  active = true
  const through = settings.https === settings.http || !settings.http
    ? redactedProxy(settings.https)
    : `${redactedProxy(settings.https)} (https) and ${redactedProxy(settings.http)} (http)`
  console.log(
    `[net] outbound HTTP goes through ${through}; direct: loopback, private addresses, single-label names, .local/.internal/.svc` +
      (settings.noProxy ? `, NO_PROXY=${settings.noProxy}` : ''),
  )
  return async () => {
    undici.setGlobalDispatcher(direct)
    active = false
    await proxied.close()
  }
}

/* ------------------------------------------------------------ containers */

let loopbackWarned = false

/**
 * The proxy as a container can use it: a proxy on this machine's loopback (a
 * local cntlm or px on a teacher's laptop) is reachable by this process and
 * by no container, so containers go without it rather than fail on it.
 */
function forContainers(address: string): string {
  if (!address) return ''
  let host = ''
  try {
    host = new URL(address).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
  const loopback = host === 'localhost' || host.endsWith('.localhost') || (literalFamily(host) !== null && /^(127\.|::1$)/.test(host))
  if (!loopback) return address
  if (!loopbackWarned) {
    loopbackWarned = true
    console.warn(`[net] the proxy ${redactedProxy(address)} is on this machine's loopback, which containers cannot reach; builds and package preparation go without it`)
  }
  return ''
}

/**
 * The proxy settings a container that must leave the campus gets (package
 * preparation's CONNECT proxy): the same reading as this process's, one
 * variable of each kind. Empty when no proxy is configured.
 */
export function proxyEnvironmentFor(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const settings = proxySettings(env)
  const https = forContainers(settings.https)
  if (!https) return {}
  return { HTTPS_PROXY: https, ...(settings.noProxy ? { NO_PROXY: settings.noProxy } : {}) }
}

/**
 * The proxy for an environment build's RUN steps (pip, apt), as Docker's
 * predefined proxy arguments: they need no ARG in the Dockerfile and stay out
 * of the image's history. Both spellings, since apt and curl read only the
 * lowercase one. Empty without a proxy.
 */
export function proxyBuildArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const settings = proxySettings(env)
  const http = forContainers(settings.http)
  const https = forContainers(settings.https)
  const pairs: Array<[string, string]> = []
  if (http) pairs.push(['HTTP_PROXY', http], ['http_proxy', http])
  if (https) pairs.push(['HTTPS_PROXY', https], ['https_proxy', https])
  if ((http || https) && settings.noProxy) pairs.push(['NO_PROXY', settings.noProxy], ['no_proxy', settings.noProxy])
  return pairs.flatMap(([key, value]) => ['--build-arg', `${key}=${value}`])
}

/** A command-line argument fit for a log line: a proxy's password is not. */
export function redactedArgument(argument: string): string {
  const match = /^((?:HTTPS?|https?)_(?:PROXY|proxy))=(.*)$/.exec(argument)
  return match ? `${match[1]}=${redactedProxy(match[2]!)}` : argument
}
