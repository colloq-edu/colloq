/**
 * The machine's calls to its home: /api/runners/v1 (shared/remote-runner.ts)
 * and the relay's /.relay/state, through fetch, outbound only.
 *
 * EVERY ANSWER IS ONE OF THREE (CallResult). `ok`: home's reply, parsed by the
 * contract's strict parser. `refused`: home's own refusal, by its code
 * (REMOTE_ERRORS), which the caller acts on — a 401 is a revoked machine, a
 * 409 an attempt to discard. `transient`: anything that is not home answering —
 * a reply without the marker header (the relay's own page served as a 404 or a
 * 502, frps's 504 at sixty seconds, frps's EOF turned into a 404 on a reused
 * POST connection), a 429 or a 5xx (home saying "not now"), a connection that
 * failed or timed out, and a reply the parser refuses, since a proxy that
 * mangled one reply is no reason to drop a lease. A transient answer never
 * changes what the machine holds: the caller backs off (Backoff) and asks
 * again, and the relay is asked whether home is offline (relayState), for the
 * status and the log, never for a decision.
 *
 * THE SECRET GOES IN THE AUTHORIZATION HEADER AND NOWHERE ELSE: never in a
 * URL, which proxies, the relay and every access log keep, never in a log
 * line, and never to the relay's page or to a wheel's CDN. Redirects are not
 * followed: home never redirects these calls, and a redirect is not home's
 * answer (it is transient, like any reply without the marker).
 *
 * Proxies are the process's (installOutboundProxy in main.ts, which reads
 * HTTPS_PROXY, NO_PROXY and friends the way the server does, and Node itself
 * NODE_EXTRA_CA_CERTS at start): nothing here knows of them.
 */
import fs from 'node:fs'
import {
  REMOTE_API_BASE,
  REMOTE_BACKOFF_MAX_MS,
  REMOTE_BACKOFF_MIN_MS,
  REMOTE_BYTES_HEADER,
  REMOTE_ERRORS,
  REMOTE_MARKER_HEADER,
  REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_RELAY_STATE_PATH,
  REMOTE_REPLY_BYTES,
  REMOTE_SHA256_HEADER,
  REMOTE_VERSION,
  parseRemoteErrorReply,
  parseRemoteJoinReply,
  parseRemoteOutcomeReply,
  parseRemoteSyncReply,
  parseRemoteUploadReply,
  remotePaths,
  remoteProtocolOf,
  remoteText,
  remoteTransient,
  REMOTE_REASON_CHARS,
  type RemoteErrorCode,
  type RemoteFileName,
  type RemoteJoinReply,
  type RemoteJoinRequest,
  type RemoteOutcomeReply,
  type RemoteOutcomeRequest,
  type RemoteSyncReply,
  type RemoteSyncRequest,
  type RemoteUploadReply,
} from '@shared/remote-runner'
import type { HomePath } from './state.js'

export type CallResult<T> =
  | { kind: 'ok'; status: number; value: T }
  | { kind: 'refused'; status: number; error: RemoteErrorCode; detail: string }
  | { kind: 'transient'; status: number | null; reason: string; retryAfterMs: number | null; heard?: HomeWord }

/**
 * What a reply of home's that this build's parser refuses still says
 * plainly about the build (parsed): whether home takes it, and home's
 * version. Read for the status and nothing else (sync.ts · loop): a home of
 * another build is exactly the one whose replies may not parse here, and the
 * machine's `runner status` kept saying `compatible: true` while home said
 * false on every reply it could not read.
 */
export interface HomeWord {
  compatible: boolean
  homeVersion: string | null
}

/** A blob's reply: the bytes as they come, after the marker was checked. */
export type BlobResult =
  | { kind: 'ok'; status: 200 | 206; body: ReadableStream<Uint8Array>; headers: Headers }
  | Exclude<CallResult<never>, { kind: 'ok' }>

export interface ClientOptions {
  /** Home's origin, as the join target named it (remoteJoinTarget). */
  home: string
  /** This agent's build (the sha256 of dist/runner.js, or `dev`), sent in every JSON request. */
  build: string
  /** `Bearer cr1.<runnerId>.<secret>` once joined (remoteCredential); null — not yet. */
  credential: () => string | null
  /** The fetch to call: the process's own, or a test's. */
  fetch?: typeof fetch
}

/** How long each call may take before it is given up as transient. */
export const CALL_TIMEOUT_MS = {
  join: 30_000,
  /** A sync is held at home for up to its holdMs; this is on top of that. */
  syncSlack: 20_000,
  outcome: 60_000,
  /** Home gives a request 300 s (§3.6); an upload is at most 64 MiB before gzip. */
  upload: 300_000,
  relay: 10_000,
  /** Until a blob's headers arrive; its bytes then have an idle timeout of their own (cache.ts). */
  blobHeaders: 30_000,
} as const

export class RemoteClient {
  readonly home: string
  private readonly options: ClientOptions
  private readonly fetchImpl: typeof fetch

  constructor(options: ClientOptions) {
    this.home = options.home
    this.options = options
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  get build(): string {
    return this.options.build
  }

  join(body: RemoteJoinRequest, signal?: AbortSignal): Promise<CallResult<RemoteJoinReply>> {
    return this.json('POST', remotePaths.join, body, parseRemoteJoinReply, { timeoutMs: CALL_TIMEOUT_MS.join, signal, signed: false })
  }

  sync(body: RemoteSyncRequest, signal?: AbortSignal): Promise<CallResult<RemoteSyncReply>> {
    return this.json('POST', remotePaths.sync, body, parseRemoteSyncReply, { timeoutMs: body.holdMs + CALL_TIMEOUT_MS.syncSlack, signal })
  }

  outcome(attemptId: string, body: RemoteOutcomeRequest, signal?: AbortSignal): Promise<CallResult<RemoteOutcomeReply>> {
    return this.json('POST', remotePaths.outcome(attemptId), body, parseRemoteOutcomeReply, { timeoutMs: CALL_TIMEOUT_MS.outcome, signal })
  }

  /**
   * PUT one result file: `gzipped` is the file compressed, `sha256` and
   * `bytes` describe it uncompressed (REMOTE_SHA256_HEADER,
   * REMOTE_BYTES_HEADER). The body goes from the disk as it is read, with its
   * length known (fs.openAsBlob): a 64 MiB answer never sits in memory whole.
   */
  async upload(attemptId: string, name: RemoteFileName, gzipped: string, meta: { sha256: string; bytes: number }, signal?: AbortSignal): Promise<CallResult<RemoteUploadReply>> {
    let body: Blob
    try {
      body = await fs.openAsBlob(gzipped)
    } catch (error) {
      return { kind: 'transient', status: null, reason: `cannot read ${gzipped}: ${String(error)}`, retryAfterMs: null }
    }
    return this.call('PUT', remotePaths.file(attemptId, name), {
      body,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip',
        [REMOTE_SHA256_HEADER]: meta.sha256,
        [REMOTE_BYTES_HEADER]: String(meta.bytes),
      },
      timeoutMs: CALL_TIMEOUT_MS.upload,
      signal,
      read: async (response) => this.parsed(response, parseRemoteUploadReply),
    })
  }

  /** GET a blob by its hash, from `offset` on (a Range request) when the start is already on disk. */
  blob(sha256: string, offset: number, signal?: AbortSignal): Promise<BlobResult> {
    return this.call('GET', remotePaths.blob(sha256), {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      timeoutMs: CALL_TIMEOUT_MS.blobHeaders,
      // Only the headers are bounded by the timeout: the bytes are the caller's to read, under an idle timeout of its own.
      headersOnly: true,
      signal,
      read: async (response) => {
        if ((response.status !== 200 && response.status !== 206) || !response.body) {
          await response.body?.cancel().catch(() => undefined)
          return { kind: 'transient', status: response.status, reason: `blob answered ${response.status}`, retryAfterMs: null }
        }
        return { kind: 'ok', status: response.status as 200 | 206, body: response.body, headers: response.headers }
      },
    })
  }

  /**
   * What the relay in front of home says about it (REMOTE_RELAY_STATE_PATH):
   * `home_offline` — the relay knows home and its tunnel is down,
   * `home_silent` — the relay says the tunnel is up and home did not answer
   * (a word that lags a cut tunnel: whether it is up is unknown, state.ts ·
   * HomePath), `home_unknown` —
   * the relay serves no home by this name at all (`known: false`: a wrong
   * address, or a name given up; no tunnel will ever come up for it, and
   * telling the owner "offline" would have them wait for it), `unreachable` —
   * no relay answered (this machine's own network, or a home with no relay in
   * front). Unsigned: the relay's own page, not home's.
   */
  async relayState(signal?: AbortSignal): Promise<Exclude<HomePath, 'ok' | 'refused'>> {
    try {
      const response = await this.fetchImpl(`${this.home}${REMOTE_RELAY_STATE_PATH}`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: signals(CALL_TIMEOUT_MS.relay, signal),
      })
      const text = response.ok ? await capped(response, 4096) : null
      const value = text === null ? null : (JSON.parse(text) as { known?: unknown; tunnel?: unknown })
      if (!value || typeof value.known !== 'boolean' || typeof value.tunnel !== 'boolean') return 'unreachable'
      if (!value.known) return 'home_unknown'
      return value.tunnel ? 'home_silent' : 'home_offline'
    } catch {
      return 'unreachable'
    }
  }

  /* ------------------------------------------------------------ the calls */

  private json<T>(method: string, at: string, body: unknown, parse: (value: unknown) => T, options: { timeoutMs: number; signal?: AbortSignal; signed?: boolean }): Promise<CallResult<T>> {
    return this.call(method, at, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      signed: options.signed,
      read: (response) => this.parsed(response, parse),
    })
  }

  private async call<R>(
    method: string,
    at: string,
    options: {
      body?: string | Blob
      headers: Record<string, string>
      timeoutMs: number
      signal?: AbortSignal
      signed?: boolean
      headersOnly?: boolean
      read: (response: Response) => Promise<R | Exclude<CallResult<never>, { kind: 'ok' }>>
    },
  ): Promise<R | Exclude<CallResult<never>, { kind: 'ok' }>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    if (options.signed !== false) {
      const credential = this.options.credential()
      if (credential) headers.Authorization = `Bearer ${credential}`
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error(`no answer in ${Math.round(options.timeoutMs / 1000)} s`)), options.timeoutMs)
    timer.unref?.()
    const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal
    let response: Response
    try {
      response = await this.fetchImpl(`${this.home}${REMOTE_API_BASE}/${at}`, {
        method,
        headers,
        body: options.body,
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      clearTimeout(timer)
      return { kind: 'transient', status: null, reason: failure(error, options.signal), retryAfterMs: null }
    }
    if (options.headersOnly) clearTimeout(timer)
    try {
      if (remoteTransient(response.status, response.headers.get(REMOTE_MARKER_HEADER))) {
        await response.body?.cancel().catch(() => undefined)
        const marked = response.headers.get(REMOTE_MARKER_HEADER) !== null
        return {
          kind: 'transient',
          status: response.status,
          reason: marked ? `home answered ${response.status}` : `a reply without ${REMOTE_MARKER_HEADER} (${response.status}): not home's`,
          retryAfterMs: retryAfter(response.headers.get('Retry-After')),
        }
      }
      if (response.status >= 400) return await this.refusal(response)
      return await options.read(response)
    } catch (error) {
      return { kind: 'transient', status: response.status, reason: failure(error, options.signal), retryAfterMs: null }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A 2xx with the marker, through the contract's parser; one the parser
   * refuses is a hiccup of the path, with what it still says plainly about
   * this build when it says it (HomeWord).
   */
  private async parsed<T>(response: Response, parse: (value: unknown) => T): Promise<CallResult<T>> {
    const text = await capped(response, REMOTE_REPLY_BYTES)
    if (text === null) return { kind: 'transient', status: response.status, reason: 'a reply over its size cap', retryAfterMs: null }
    let value: unknown
    try {
      value = JSON.parse(text)
      return { kind: 'ok', status: response.status, value: parse(value) }
    } catch (error) {
      const heard = homeWord(value)
      return { kind: 'transient', status: response.status, reason: `a reply the contract refuses: ${error instanceof Error ? error.message : String(error)}`, retryAfterMs: null, ...(heard ? { heard } : {}) }
    }
  }

  /**
   * Home's refusal by its code; a body that does not say is named by its
   * status, as REMOTE_ERRORS lists them. A `protocol` refusal (426, from a
   * home of another version) says which protocol home speaks
   * (REMOTE_PROTOCOL_HEADER) in its detail: what the machine must be updated
   * to, for the owner and the fleet's update.
   */
  private async refusal(response: Response): Promise<Exclude<CallResult<never>, { kind: 'ok' | 'transient' }>> {
    const text = await capped(response, 64 * 1024).catch(() => null)
    let refused: Exclude<CallResult<never>, { kind: 'ok' | 'transient' }>
    try {
      const reply = parseRemoteErrorReply(JSON.parse(text ?? ''))
      refused = { kind: 'refused', status: response.status, error: reply.error, detail: reply.detail ?? '' }
    } catch {
      const error = (Object.keys(REMOTE_ERRORS) as RemoteErrorCode[]).find((code) => REMOTE_ERRORS[code] === response.status) ?? 'invalid'
      refused = { kind: 'refused', status: response.status, error, detail: remoteText((text ?? '').trim(), REMOTE_REASON_CHARS, 'start') }
    }
    if (refused.error !== 'protocol') return refused
    const spoken = remoteProtocolOf(response.headers.get(REMOTE_PROTOCOL_HEADER))
    const said = `home speaks protocol ${spoken ?? 'unknown'}, this machine ${REMOTE_PROTOCOL}`
    return { ...refused, detail: remoteText(refused.detail ? `${said}: ${refused.detail}` : said, REMOTE_REASON_CHARS, 'start') }
  }
}

/** A reply's plain word on this build (HomeWord), from a value the contract's parser refused; null — it says none. */
function homeWord(value: unknown): HomeWord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as { compatible?: unknown; homeVersion?: unknown }
  if (typeof v.compatible !== 'boolean') return null
  return { compatible: v.compatible, homeVersion: typeof v.homeVersion === 'string' && REMOTE_VERSION.test(v.homeVersion) ? v.homeVersion : null }
}

/** A body read as text up to `limit` bytes; `null` — it was longer (and the rest is not read). */
async function capped(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One signal for a timeout and the caller's own. */
function signals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

function failure(error: unknown, own?: AbortSignal): string {
  if (own?.aborted) return 'cancelled'
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
  return error instanceof Error ? `${error.message}${cause}` : String(error)
}

/** Retry-After in seconds or as a date, in ms within the backoff's range; null — none. */
export function retryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const seconds = /^\s*(\d{1,6})\s*$/.exec(header)
  const ms = seconds ? Number(seconds[1]) * 1000 : Date.parse(header) - now
  return Number.isFinite(ms) ? Math.min(REMOTE_BACKOFF_MAX_MS, Math.max(0, ms)) : null
}

/**
 * The wait after a transient answer: from REMOTE_BACKOFF_MIN_MS, its ceiling
 * doubling with each failure in a row up to REMOTE_BACKOFF_MAX_MS, with full
 * jitter between the floor and that ceiling — the first wait included, so
 * that a fleet the relay dropped at once does not come back at once.
 * Retry-After, when home sent one, is the least of it.
 */
export class Backoff {
  private failures = 0

  constructor(
    private readonly random: () => number = Math.random,
    private readonly min = REMOTE_BACKOFF_MIN_MS,
    private readonly max = REMOTE_BACKOFF_MAX_MS,
  ) {}

  next(retryAfterMs: number | null = null): number {
    const ceiling = Math.min(this.max, this.min * 2 ** (this.failures + 1))
    this.failures = Math.min(this.failures + 1, 30)
    const jittered = this.min + this.random() * Math.max(0, ceiling - this.min)
    return Math.round(Math.min(this.max, Math.max(jittered, retryAfterMs ?? 0)))
  }

  reset(): void {
    this.failures = 0
  }

  /** Failures in a row since the last success. */
  get streak(): number {
    return this.failures
  }
}
