/**
 * The inbound perimeter: what this server believes about who is knocking.
 *
 * At a university the HTTPS proxy usually sits on another machine, or the
 * whole class arrives through one campus NAT. Both used to look the same from
 * here: one address for thirty people, because the forwarded address was
 * believed only from a proxy on this same machine. The per-address limits
 * (sixty newcomers to a room per ten minutes, twenty oracle questions a
 * minute, the competition sign-in, join and upload ceilings) then held back
 * the whole class at once, and the sixty-first student got HTTP 429 at the
 * door. The opposite hole sat next to it: `CF-Connecting-IP` was believed
 * from any loopback peer, and the shipped Caddy passes unknown headers
 * through, so behind it anybody could name any address.
 *
 * Four settings, read once per process (their contract is in .env.example):
 *
 *   TRUSTED_PROXIES         whose X-Forwarded-For is believed (default loopback)
 *   TRUST_CF_CONNECTING_IP  1: Cloudflare's own header wins from such a peer
 *   SHARED_ADDRESSES        addresses many people share: no per-address caps
 *   HSTS                    0: do not pin browsers to https
 *
 * A malformed entry is dropped with a line in the journal rather than
 * refusing to start: the same rule as the other network settings of this
 * server (KERNEL_ROOM_SUBNET, COLLOQ_ROOM_NETWORK in kernel/perimeter.ts), and
 * dropping always errs toward believing less. The start line names what is
 * believed, so a typo is visible in the first screen of the log.
 */
import { BlockList, isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'

/** What the address code needs from a request: an express Request and the raw upgrade request both fit. */
export interface RequestLike {
  headers: IncomingHttpHeaders
  socket?: { remoteAddress?: string | undefined }
}

/** A set of addresses and ranges, plus how the operator wrote it (for the start line). */
export interface AddressList {
  readonly names: readonly string[]
  /** `address` must already be normalised (normalizeAddress). */
  has(address: string): boolean
}

export interface InboundPolicy {
  readonly trustedProxies: AddressList
  readonly trustCfConnectingIp: boolean
  readonly sharedAddresses: AddressList
  readonly hsts: boolean
  /** Entries and values that were dropped, in words for the journal. */
  readonly problems: readonly string[]
}

/*
 * The two words an operator may write instead of ranges. `private` is the
 * RFC 1918 space plus carrier-grade NAT and the IPv6 unique-local and
 * link-local ranges: where a campus proxy or a container gateway lives.
 */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fe80::/10'],
}

/** 64 characters: room for any address with a port or a zone; a hint is no reason to keep a paragraph. */
const MAX_ADDRESS = 64

/* ------------------------------------------------------------- addresses */

/** An address in its one written form, or null. Strict: no ports, brackets or zones. */
function canonicalIp(text: string): { address: string; family: 4 | 6 } | null {
  const family = isIP(text)
  // net.isIP refuses leading zeros, so a valid IPv4 has exactly one spelling.
  if (family === 4) return { address: text, family: 4 }
  if (family !== 6) return null
  let canonical: string
  try {
    // The URL parser writes IPv6 the one canonical way: lower case, the
    // longest run of zeros compressed. Two spellings of one client must not
    // become two counters.
    canonical = new URL(`http://[${text}]`).hostname.slice(1, -1)
  } catch {
    return null
  }
  /*
   * An IPv4 client on a dual-stack socket arrives as ::ffff:a.b.c.d. It is
   * the same person as a.b.c.d, and a TRUSTED_PROXIES line written in IPv4
   * must match it.
   */
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (mapped) {
    const high = parseInt(mapped[1], 16)
    const low = parseInt(mapped[2], 16)
    return { address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, family: 4 }
  }
  return { address: canonical, family: 6 }
}

/**
 * An address as a socket or a proxy wrote it, in its canonical form, or null.
 *
 * More lenient than a settings entry: some proxies append the port
 * (`203.0.113.7:51514`, `[2001:db8::7]:443`), and a link-local peer carries a
 * zone. Anything else that is not an address (`unknown`, an obfuscated
 * identifier, garbage a client wrote) is null, and the caller skips it.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null
  let text = raw.trim()
  if (!text || text.length > MAX_ADDRESS) return null
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text)
  if (bracketed) text = bracketed[1]
  else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text)
    if (withPort) text = withPort[1]
  }
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  return canonicalIp(text)?.address ?? null
}

export function isLoopbackAddress(address: string | null): boolean {
  return address === '::1' || (address !== null && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address))
}

/* -------------------------------------------------------------- settings */

function addressList(names: string[], blocks: BlockList): AddressList {
  return {
    names,
    has: (address) => blocks.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'),
  }
}

/** One entry: a keyword, an address or a CIDR range. Adds it and returns its name, or null. */
function addEntry(word: string, blocks: BlockList): string | null {
  const keyword = KEYWORDS[word.toLowerCase()]
  if (keyword) {
    for (const range of keyword) addEntry(range, blocks)
    return word.toLowerCase()
  }
  const [text, bits, ...rest] = word.split('/')
  if (rest.length > 0 || text === undefined) return null
  const ip = canonicalIp(text)
  if (!ip) return null
  const written = isIP(text)
  const max = written === 6 ? 128 : 32
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return null
  let prefix = bits === undefined ? max : Number(bits)
  if (prefix > max) return null
  // `::ffff:10.0.0.0/104` is 10.0.0.0/8 written in IPv6.
  if (written === 6 && ip.family === 4) {
    if (prefix < 96) return null
    prefix -= 96
  }
  blocks.addSubnet(ip.address, prefix, ip.family === 6 ? 'ipv6' : 'ipv4')
  return prefix === (ip.family === 6 ? 128 : 32) ? ip.address : `${ip.address}/${prefix}`
}

/**
 * A list setting: comma- or space-separated entries.
 *
 * `none` says "nobody" out loud, and only alone: next to other entries it
 * contradicts them. When nothing valid is left of a value that was written,
 * the default stands, so a typo never changes behaviour against today's.
 */
function parseAddressList(name: string, raw: string | undefined, fallback: string, problems: string[]): AddressList {
  const words = (raw ?? '').split(/[\s,]+/).filter(Boolean)
  if (words.length === 0) return defaultList(fallback)
  if (words.length === 1 && words[0].toLowerCase() === 'none') return addressList([], new BlockList())
  const blocks = new BlockList()
  const names: string[] = []
  for (const word of words) {
    if (word.toLowerCase() === 'none') {
      problems.push(`${name}: "none" cannot stand next to other entries; it is ignored`)
      continue
    }
    const added = addEntry(word, blocks)
    if (added === null) {
      problems.push(`${name}: "${word}" is not an IP address, a CIDR range or one of loopback, private, none; it is ignored`)
    } else if (!names.includes(added)) {
      names.push(added)
    }
  }
  if (names.length > 0) return addressList(names, blocks)
  problems.push(`${name}: nothing valid is left, so the default (${fallback || 'empty'}) stands`)
  return defaultList(fallback)
}

function defaultList(fallback: string): AddressList {
  const blocks = new BlockList()
  // The defaults are written in this file and always parse.
  const names = fallback.split(/[\s,]+/).filter(Boolean).map((word) => addEntry(word, blocks) ?? word)
  return addressList(names, blocks)
}

function parseSwitch(name: string, raw: string | undefined, fallback: boolean, problems: string[]): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  problems.push(`${name}=${raw}: unknown value, it stays ${fallback ? 'on' : 'off'} (write 1 or 0)`)
  return fallback
}

/** Pure: the policy these settings describe. */
export function parseInboundPolicy(env: NodeJS.ProcessEnv): InboundPolicy {
  const problems: string[] = []
  return {
    trustedProxies: parseAddressList('TRUSTED_PROXIES', env.TRUSTED_PROXIES, 'loopback', problems),
    trustCfConnectingIp: parseSwitch('TRUST_CF_CONNECTING_IP', env.TRUST_CF_CONNECTING_IP, false, problems),
    sharedAddresses: parseAddressList('SHARED_ADDRESSES', env.SHARED_ADDRESSES, '', problems),
    hsts: parseSwitch('HSTS', env.HSTS, true, problems),
    problems,
  }
}

let current: InboundPolicy | null = null

/**
 * The policy of this process: parsed once, on first use.
 *
 * Nothing re-reads the environment per request, so a line edited in .env
 * reaches the server with a restart, like every other setting of this kind.
 */
export function inboundPolicy(): InboundPolicy {
  return (current ??= parseInboundPolicy(process.env))
}

/** Tests put a policy of their own in place; null goes back to the environment. */
export function useInboundPolicy(policy: InboundPolicy | null): void {
  current = policy
}

/** The start line: what is believed and from whom (index.ts prints it once). */
export function describeInboundPolicy(policy: InboundPolicy): string {
  const trusted = policy.trustedProxies.names
  const shared = policy.sharedAddresses.names
  return (
    `X-Forwarded-For is believed from ${trusted.length > 0 ? trusted.join(', ') : 'nobody'}` +
    `; CF-Connecting-IP ${policy.trustCfConnectingIp ? 'wins from them' : 'is ignored'}` +
    `; per-address limits ${shared.length > 0 ? `skip ${shared.join(', ')}` : 'apply to every address'}` +
    `; HSTS ${policy.hsts ? 'on https' : 'off'}`
  )
}

/* ---------------------------------------------------------------- client */

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/**
 * The address a request came from.
 *
 * The socket peer, unless it is a trusted proxy. Then the client is the
 * rightmost X-Forwarded-For hop that is not itself a trusted proxy. Not the
 * leftmost, which is what the old code took: every proxy APPENDS the address
 * it saw, so whatever stands left of the entry our proxy wrote came from the
 * client and is worth exactly what the client says. The rightmost untrusted
 * hop is the one that connected to a proxy we trust, and that connection
 * could not be faked. All header values count (Node joins repeated headers
 * with a comma), malformed entries are skipped, and when every hop is trusted
 * (a campus client inside a trusted range) the leftmost stands.
 *
 * Cloudflare writes the visitor into CF-Connecting-IP and appends the same
 * address to X-Forwarded-For, so behind a tunnel the rightmost hop already
 * names the visitor. The switch only lets Cloudflare's own header win, and it
 * is off by default: a client can send that header too, and a proxy that does
 * not strip it hands it on as if Cloudflare had said it.
 */
export function clientAddress(req: RequestLike, policy: InboundPolicy = inboundPolicy()): string | null {
  const raw = req.socket?.remoteAddress
  if (!raw) return null
  const peer = normalizeAddress(raw)
  // A socket always names a real address; the cut is for the day it does not.
  if (!peer) return raw.slice(0, MAX_ADDRESS)
  if (!policy.trustedProxies.has(peer)) return peer
  if (policy.trustCfConnectingIp) {
    const said = headerText(req.headers['cf-connecting-ip'])
    // One value or nothing: a second copy of the header is somebody's addition.
    const cf = said.includes(',') ? null : normalizeAddress(said)
    if (cf) return cf
  }
  const hops = headerText(req.headers['x-forwarded-for']).split(',')
  let leftmost: string | null = null
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeAddress(hops[i])
    if (!hop) continue
    if (!policy.trustedProxies.has(hop)) return hop
    leftmost = hop
  }
  return leftmost ?? peer
}

/**
 * The address a per-address limit counts, or null when it must not count one.
 *
 * Null for an address in SHARED_ADDRESSES: a campus NAT is hundreds of people
 * behind one address, and a ceiling sized against one script's loop would
 * turn them away at the bell. Only the per-address counters use this; the
 * per-room and per-person ones hold whatever the address.
 */
export function addressForLimits(req: RequestLike, policy: InboundPolicy = inboundPolicy()): string | null {
  const address = clientAddress(req, policy)
  if (!address || policy.sharedAddresses.has(address)) return null
  return address
}
