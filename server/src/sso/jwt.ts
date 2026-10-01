/**
 * Verifying a JWT that a sign-in proxy put in front of every request.
 *
 * Teleport application access (and oauth2-proxy, Pomerium and the like in
 * front of an OIDC provider) authenticates the person before the request ever
 * reaches Colloq and hands the result on as a signed token in a header. Only
 * the signature makes that header worth anything: the same header can arrive
 * from a browser that typed it, from a student's notebook inside the cluster,
 * or replayed out of somebody's log. So the token is checked here in full —
 * signature against the proxy's published keys (JWKS), expiry, and, when the
 * operator names them, issuer and audience — and anything short of that is
 * simply no identity, never an error page: the request goes on exactly as one
 * without the header, through the personal links Colloq always had.
 *
 * Node's crypto does the cryptography (RSA, RSA-PSS, ECDSA, Ed25519 from JWK);
 * there is no dependency to audit. What is deliberately refused: `none` and
 * every HMAC algorithm. A shared-secret algorithm verified against a public
 * key is the classic forgery — whoever has the public key, which is public,
 * signs as the proxy.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

/** The algorithms a proxy signs with. HMAC and `none` are never among them, whatever the configuration says. */
export const ASYMMETRIC_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'] as const
export type JwtAlgorithm = (typeof ASYMMETRIC_ALGORITHMS)[number]

interface AlgorithmShape {
  kty: 'RSA' | 'EC' | 'OKP'
  hash: string | null
  pss?: boolean
  crv?: string
}

const SHAPES: Record<JwtAlgorithm, AlgorithmShape> = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: 'P-256' },
  ES384: { kty: 'EC', hash: 'sha384', crv: 'P-384' },
  ES512: { kty: 'EC', hash: 'sha512', crv: 'P-521' },
  EdDSA: { kty: 'OKP', hash: null },
}

export interface VerifiedKey {
  kid: string | null
  kty: string
  alg: string | null
  crv: string | null
  key: crypto.KeyObject
}

export interface JwtRules {
  algorithms: readonly JwtAlgorithm[]
  /** `iss` must equal this, when set. */
  issuer: string | null
  /** `aud` (a string or a list) must contain this, when set. */
  audience: string | null
  /** Seconds of clock difference forgiven on `exp` and `nbf`. */
  leewaySeconds: number
}

export type JwtVerdict =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: JwtRefusal; kid?: string | null }

export type JwtRefusal =
  | 'malformed'
  | 'algorithm'
  | 'unknown_key'
  | 'signature'
  | 'expired'
  | 'not_yet_valid'
  | 'no_expiry'
  | 'issuer'
  | 'audience'

/** Ten kilobytes: Teleport's token with a person's traits is one or two; anything bigger is not a token. */
export const MAX_TOKEN_LENGTH = 10 * 1024

function decodeSegment(segment: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null
  return Buffer.from(segment, 'base64url')
}

function jsonObject(bytes: Buffer | null): Record<string, unknown> | null {
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The header without checking anything: which key the token names, for the cache to fetch if it is new. */
export function peekKeyId(token: string): string | null {
  const header = jsonObject(decodeSegment(token.split('.')[0] ?? ''))
  return typeof header?.kid === 'string' ? header.kid : null
}

function keyFits(key: VerifiedKey, alg: JwtAlgorithm): boolean {
  const shape = SHAPES[alg]
  if (key.kty !== shape.kty) return false
  if (key.alg && key.alg !== alg) return false
  if (shape.crv && key.crv !== shape.crv) return false
  return true
}

function signatureHolds(alg: JwtAlgorithm, key: crypto.KeyObject, data: Buffer, signature: Buffer): boolean {
  const shape = SHAPES[alg]
  try {
    if (shape.kty === 'OKP') return crypto.verify(null, data, key, signature)
    if (shape.kty === 'EC') return crypto.verify(shape.hash, data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    if (shape.pss) {
      return crypto.verify(shape.hash, data, {
        key,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      }, signature)
    }
    return crypto.verify(shape.hash, data, key, signature)
  } catch {
    // A key of the right type but the wrong size, a truncated signature:
    // either way the signature does not hold.
    return false
  }
}

/**
 * Check a compact JWS against a set of keys. Pure: the clock and the keys come
 * in, a verdict goes out, nothing is fetched.
 */
export function verifyJwt(token: string, keys: readonly VerifiedKey[], rules: JwtRules, now = Date.now()): JwtVerdict {
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const header = jsonObject(decodeSegment(parts[0]!))
  const claims = jsonObject(decodeSegment(parts[1]!))
  const signature = decodeSegment(parts[2]!)
  if (!header || !claims || !signature) return { ok: false, reason: 'malformed' }

  // Before the signature is looked at: `none` comes with an empty one, and
  // the answer to it is about the algorithm.
  const alg = header.alg
  if (typeof alg !== 'string' || !(rules.algorithms as readonly string[]).includes(alg) || !(alg in SHAPES)) {
    return { ok: false, reason: 'algorithm' }
  }
  if (signature.length === 0) return { ok: false, reason: 'malformed' }
  // A critical extension we do not implement must not be silently skipped (RFC 7515 · 4.1.11).
  if (header.crit !== undefined) return { ok: false, reason: 'malformed' }

  const kid = typeof header.kid === 'string' ? header.kid : null
  const candidates = keys.filter((key) => (kid === null || key.kid === kid) && keyFits(key, alg as JwtAlgorithm))
  if (candidates.length === 0) return { ok: false, reason: 'unknown_key', kid }
  const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii')
  if (!candidates.some((key) => signatureHolds(alg as JwtAlgorithm, key.key, data, signature))) {
    return { ok: false, reason: 'signature', kid }
  }

  const leeway = rules.leewaySeconds * 1000
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'no_expiry' }
  if (now - leeway >= claims.exp * 1000) return { ok: false, reason: 'expired' }
  if (typeof claims.nbf === 'number' && now + leeway < claims.nbf * 1000) return { ok: false, reason: 'not_yet_valid' }
  if (rules.issuer !== null && claims.iss !== rules.issuer) return { ok: false, reason: 'issuer' }
  if (rules.audience !== null) {
    const aud = claims.aud
    const listed = Array.isArray(aud) ? aud.includes(rules.audience) : aud === rules.audience
    if (!listed) return { ok: false, reason: 'audience' }
  }
  return { ok: true, claims }
}

/* ------------------------------------------------------------------ keys */

/**
 * The usable keys of a JWKS document. A key that cannot be imported, is meant
 * for encryption, or is symmetric (`oct`) is left out rather than failing the
 * whole set: one exotic entry must not lock everybody out.
 */
export function importJwks(document: unknown): VerifiedKey[] {
  const list = (document as { keys?: unknown })?.keys
  if (!Array.isArray(list)) return []
  const keys: VerifiedKey[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const jwk = entry as Record<string, unknown>
    if (jwk.kty !== 'RSA' && jwk.kty !== 'EC' && jwk.kty !== 'OKP') continue
    if (jwk.use !== undefined && jwk.use !== 'sig') continue
    try {
      // Only the public part goes in: a private key published by mistake still
      // yields its public half, and `d` never reaches createPublicKey's output.
      const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicPart } = jwk
      const key = crypto.createPublicKey({ key: publicPart as crypto.JsonWebKey, format: 'jwk' })
      // Node imports an RSA modulus of any size; one under 2048 bits is
      // factorable, and no proxy worth trusting signs with it.
      if (jwk.kty === 'RSA' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue
      keys.push({
        kid: typeof jwk.kid === 'string' ? jwk.kid : null,
        kty: String(jwk.kty),
        alg: typeof jwk.alg === 'string' ? jwk.alg : null,
        crv: typeof jwk.crv === 'string' ? jwk.crv : null,
        key,
      })
    } catch {
      /* not a key Node can read; the rest of the set still counts */
    }
  }
  return keys
}

export interface KeySource {
  /** An https (or, for a proxy in the same cluster, http) URL of the proxy's JWKS. */
  url: string | null
  /** A JWKS file on disk: a mounted ConfigMap, for a network where the app may not call the proxy. */
  file: string | null
}

export interface KeyCacheOptions {
  source: KeySource
  /** How long a fetched set is used before the next request refreshes it. */
  ttlMs?: number
  /** At most one refetch per this interval, however many unknown key ids arrive. */
  minRefreshMs?: number
  /** The same while no set has loaded yet. */
  retryEmptyMs?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * The proxy's keys, kept in memory.
 *
 * Verification itself is synchronous and runs on every request that carries a
 * token, so the keys must already be here: they are loaded at the first token,
 * refreshed when they grow old, and refetched — at most once a minute — when a
 * token names a key the set does not have, which is what a key rotation on the
 * proxy looks like from this side. A failed fetch keeps the old set: a JWKS
 * endpoint that blinks must not sign out a whole class.
 */
export class KeyCache {
  #keys: VerifiedKey[] = []
  #loadedAt = 0
  #attemptedAt = 0
  #fileStamp = ''
  /** Whether a load has finished at least once, whatever it found. */
  #settled = false
  #inFlight: Promise<void> | null = null
  #lastError: string | null = null
  readonly #options: Required<Omit<KeyCacheOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch }

  constructor(options: KeyCacheOptions) {
    this.#options = {
      ttlMs: 10 * 60_000,
      minRefreshMs: 60_000,
      retryEmptyMs: 5_000,
      timeoutMs: 5_000,
      now: Date.now,
      ...options,
      fetchImpl: options.fetchImpl ?? ((...args) => fetch(...args)),
    }
  }

  get keys(): readonly VerifiedKey[] {
    return this.#keys
  }

  get lastError(): string | null {
    return this.#lastError
  }

  has(kid: string | null): boolean {
    return kid === null ? this.#keys.length > 0 : this.#keys.some((key) => key.kid === kid)
  }

  /**
   * Make sure the set is usable for a token naming `kid`: load it the first
   * time, refresh it when stale, refetch it for a key it lacks. Resolves when
   * there is nothing more worth waiting for; never rejects.
   */
  async ready(kid: string | null): Promise<void> {
    const now = this.#options.now()
    const empty = this.#keys.length === 0
    const stale = now - this.#loadedAt > this.#options.ttlMs
    const missing = !this.has(kid)
    if (!empty && !stale && !missing) return
    // A request waits only when the answer depends on the load: the very
    // first one (every request until it settles), or a refetch for a key the
    // set lacks. Once a first load has failed, requests stop waiting — an
    // endpoint that is down must not add its timeout to every page — and a
    // stale set refreshes in the background while its keys keep working.
    const wait = (empty && !this.#settled) || (!empty && missing)
    // Attempts are spaced out; an empty set retries sooner, because until it
    // loads nobody gets in through the proxy.
    const pause = empty ? this.#options.retryEmptyMs : this.#options.minRefreshMs
    if (this.#settled && now - this.#attemptedAt < pause) {
      if (wait && this.#inFlight) await this.#inFlight
      return
    }
    if (this.#inFlight) {
      if (wait) await this.#inFlight
      return
    }
    const load = this.#load()
    if (wait) await load
  }

  #load(): Promise<void> {
    if (this.#inFlight) return this.#inFlight
    this.#attemptedAt = this.#options.now()
    const run = async (): Promise<void> => {
      try {
        const keys = this.#options.source.file ? this.#readFile() : await this.#fetchUrl()
        if (keys === null) return
        if (keys.length === 0) throw new Error('the JWKS holds no usable signing key')
        this.#keys = keys
        this.#loadedAt = this.#options.now()
        this.#lastError = null
      } catch (error) {
        this.#lastError = error instanceof Error ? error.message : String(error)
      }
    }
    // Cleared by a callback, not inside `run`: a file read never awaits, so a
    // `finally` there would run before the assignment below and leave a
    // settled promise in place that every later load returned unread.
    const loading: Promise<void> = run().finally(() => {
      this.#settled = true
      if (this.#inFlight === loading) this.#inFlight = null
    })
    this.#inFlight = loading
    return loading
  }

  /** Null when the file has not changed since the last read: the current keys stand. */
  #readFile(): VerifiedKey[] | null {
    const file = this.#options.source.file!
    const stat = fs.statSync(file)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (stamp === this.#fileStamp && this.#keys.length > 0) {
      this.#loadedAt = this.#options.now()
      return null
    }
    const keys = importJwks(JSON.parse(fs.readFileSync(file, 'utf8')))
    this.#fileStamp = stamp
    return keys
  }

  async #fetchUrl(): Promise<VerifiedKey[]> {
    const url = this.#options.source.url
    if (!url) throw new Error('no JWKS source is configured')
    const response = await this.#options.fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.#options.timeoutMs),
    })
    if (!response.ok) throw new Error(`the JWKS answered ${response.status}`)
    const text = await response.text()
    if (text.length > 1024 * 1024) throw new Error('the JWKS is larger than a megabyte')
    return importJwks(JSON.parse(text))
  }
}
