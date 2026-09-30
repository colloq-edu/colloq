/**
 * Whose word about the client address is taken (server/src/net/inbound.ts).
 *
 * The cases are the ones a university install meets: no proxy at all, the
 * relay or a tunnel on this machine, a campus proxy on another machine with
 * a chain of hops, a client that writes the header itself — directly or
 * through a proxy that appends — Cloudflare's own header with and without
 * the switch, IPv6 and IPv4 dressed as IPv6, and the three words. Each case
 * names the address the per-address limits would count, because that is
 * what a wrong answer costs: one address for the whole class, or a script
 * that picks a fresh address per request.
 */
import './_env.mts'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addressForLimits,
  clientAddress,
  describeInboundPolicy,
  isLoopbackAddress,
  normalizeAddress,
  parseInboundPolicy,
  useInboundPolicy,
  type InboundPolicy,
} from '../server/src/net/inbound.js'
import { addressOf } from '../server/src/bans.js'

afterEach(() => useInboundPolicy(null))

const policy = (env: NodeJS.ProcessEnv = {}): InboundPolicy => parseInboundPolicy(env)
const from = (peer: string | undefined, headers: Record<string, string | string[]> = {}) => ({
  headers,
  socket: peer === undefined ? undefined : { remoteAddress: peer },
})

/* ---------------------------------------------------------------- matrix */

test('without a proxy in front the socket is the client, whatever the header says', () => {
  const direct = policy()
  // A student straight on the server, writing somebody else's address.
  assert.equal(clientAddress(from('198.51.100.4', { 'x-forwarded-for': '203.0.113.7' }), direct), '198.51.100.4')
  assert.equal(clientAddress(from('198.51.100.4', { 'cf-connecting-ip': '203.0.113.7' }), direct), '198.51.100.4')
  assert.equal(clientAddress(from('198.51.100.4'), direct), '198.51.100.4')
  assert.equal(clientAddress(from(undefined), direct), null)
})

test('a proxy on this machine is believed by default: the relay and the tunnels keep working', () => {
  const byDefault = policy()
  for (const peer of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(clientAddress(from(peer, { 'x-forwarded-for': '203.0.113.7' }), byDefault), '203.0.113.7', peer)
  }
  // No header from a local peer: that is the machine itself (curl, host.sh).
  assert.equal(clientAddress(from('127.0.0.1'), byDefault), '127.0.0.1')
  // frps appends caddy's loopback address after the client's: it is a trusted hop, skipped.
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7, 127.0.0.1' }), byDefault), '203.0.113.7')
})

test('a campus proxy on another machine: the rightmost hop that is not a trusted proxy is the student', () => {
  const campus = policy({ TRUSTED_PROXIES: '10.0.0.0/8' })
  // Student → outer proxy 10.0.0.7 → inner proxy 10.0.0.6 → server (peer 10.0.0.5).
  const chain = { 'x-forwarded-for': '198.51.100.9, 10.0.0.7, 10.0.0.6' }
  assert.equal(clientAddress(from('10.0.0.5', chain), campus), '198.51.100.9')
  // Repeated headers are one list, in order.
  assert.equal(clientAddress(from('10.0.0.5', { 'x-forwarded-for': ['198.51.100.9', '10.0.0.7, 10.0.0.6'] }), campus), '198.51.100.9')
  // Loopback is no longer trusted once the operator names the proxies explicitly.
  assert.equal(clientAddress(from('127.0.0.1', chain), campus), '127.0.0.1')
})

test('a header sent by an untrusted peer changes nothing', () => {
  const campus = policy({ TRUSTED_PROXIES: '10.0.0.5' })
  assert.equal(clientAddress(from('10.0.0.99', { 'x-forwarded-for': '203.0.113.7' }), campus), '10.0.0.99')
})

test('a leftmost entry the client wrote itself is not believed through a trusted proxy', () => {
  // The proxy appends what it saw; everything left of that is the client's word.
  const campus = policy({ TRUSTED_PROXIES: 'loopback, 10.0.0.5' })
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }), campus), '203.0.113.7')
  assert.equal(clientAddress(from('10.0.0.5', { 'x-forwarded-for': '10.0.0.5, 6.6.6.6, 203.0.113.7' }), campus), '203.0.113.7')
  // A client who writes one of our proxies into the header gains nothing either.
  assert.equal(clientAddress(from('10.0.0.5', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.5' }), campus), '203.0.113.7')
})

test('CF-Connecting-IP counts only with the switch, and only from a trusted peer', () => {
  const headers = { 'cf-connecting-ip': '192.0.2.44', 'x-forwarded-for': '203.0.113.7' }
  // Off by default: behind the shipped Caddy anyone could have sent it.
  assert.equal(clientAddress(from('127.0.0.1', headers), policy()), '203.0.113.7')
  const tunnel = policy({ TRUST_CF_CONNECTING_IP: '1' })
  assert.equal(clientAddress(from('127.0.0.1', headers), tunnel), '192.0.2.44')
  // The switch does not make a stranger's header true.
  assert.equal(clientAddress(from('198.51.100.4', headers), tunnel), '198.51.100.4')
  // Malformed or doubled: back to X-Forwarded-For.
  assert.equal(clientAddress(from('127.0.0.1', { ...headers, 'cf-connecting-ip': 'unknown' }), tunnel), '203.0.113.7')
  assert.equal(clientAddress(from('127.0.0.1', { ...headers, 'cf-connecting-ip': '192.0.2.44, 6.6.6.6' }), tunnel), '203.0.113.7')
})

test('IPv6 is written one way, and IPv4 dressed as IPv6 is IPv4', () => {
  const campus = policy({ TRUSTED_PROXIES: '10.0.0.5, 2001:db8:ffff::1' })
  // A dual-stack socket reports an IPv4 proxy as ::ffff:10.0.0.5; the IPv4 entry matches it.
  assert.equal(clientAddress(from('::ffff:10.0.0.5', { 'x-forwarded-for': '2001:DB8:0:0::7' }), campus), '2001:db8::7')
  assert.equal(clientAddress(from('2001:db8:ffff::1', { 'x-forwarded-for': '[2001:db8::8]:443' }), campus), '2001:db8::8')
  assert.equal(clientAddress(from('10.0.0.5', { 'x-forwarded-for': '::ffff:203.0.113.8' }), campus), '203.0.113.8')
  assert.equal(clientAddress(from('10.0.0.5', { 'x-forwarded-for': '203.0.113.9:51514' }), campus), '203.0.113.9')
  // An untrusted client is counted the same way whichever socket family it arrived on.
  assert.equal(clientAddress(from('::ffff:198.51.100.4'), campus), '198.51.100.4')
  assert.equal(clientAddress(from('fe80::1%en0'), campus), 'fe80::1')
})

test('private trusts the usual proxy and container ranges; a chain inside them yields its leftmost hop', () => {
  const inside = policy({ TRUSTED_PROXIES: 'private' })
  // The Docker gateway a host proxy arrives from.
  assert.equal(clientAddress(from('172.20.0.1', { 'x-forwarded-for': '203.0.113.7, 192.168.1.10' }), inside), '203.0.113.7')
  assert.equal(clientAddress(from('100.64.3.4', { 'x-forwarded-for': '198.51.100.2' }), inside), '198.51.100.2')
  assert.equal(clientAddress(from('fd00::5', { 'x-forwarded-for': '2001:db8::9' }), inside), '2001:db8::9')
  // Every hop trusted: a campus client inside the trusted range stands as the leftmost.
  assert.equal(clientAddress(from('10.9.9.9', { 'x-forwarded-for': '10.1.1.1, 10.2.2.2' }), inside), '10.1.1.1')
  // Loopback is not in `private`.
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), inside), '127.0.0.1')
})

test('none believes nobody, not even a proxy on this machine', () => {
  const nobody = policy({ TRUSTED_PROXIES: 'none' })
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), nobody), '127.0.0.1')
  assert.deepEqual(nobody.trustedProxies.names, [])
  assert.deepEqual(nobody.problems, [])
})

test('malformed hops are skipped, and a long peer is cut to a hint', () => {
  const byDefault = policy()
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7, unknown, ' }), byDefault), '203.0.113.7')
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '_hidden, 010.0.0.1' }), byDefault), '127.0.0.1')
  assert.equal(clientAddress(from('x'.repeat(100)), byDefault)?.length, 64)
  for (const bad of ['', 'unknown', '1.2.3', '300.1.1.1', '[::1', 'a'.repeat(80)]) assert.equal(normalizeAddress(bad), null, bad)
})

/* --------------------------------------------------------------- settings */

test('an entry that does not parse is named and dropped; with nothing left the default stands', () => {
  const partly = policy({ TRUSTED_PROXIES: '10.0.0.5, 10.0.0.300 fd00::/200' })
  assert.deepEqual(partly.trustedProxies.names, ['10.0.0.5'])
  assert.equal(partly.problems.length, 2)
  assert.match(partly.problems[0], /TRUSTED_PROXIES: "10\.0\.0\.300" is not an IP address/)
  // Dropping errs toward believing less: loopback is not added back behind the operator's back.
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), partly), '127.0.0.1')

  const nothing = policy({ TRUSTED_PROXIES: 'proxy.campus.example' })
  assert.deepEqual(nothing.trustedProxies.names, ['loopback'])
  assert.match(nothing.problems.at(-1)!, /nothing valid is left, so the default \(loopback\) stands/)

  const contradiction = policy({ TRUSTED_PROXIES: 'none, 10.0.0.5' })
  assert.deepEqual(contradiction.trustedProxies.names, ['10.0.0.5'])
  assert.match(contradiction.problems[0], /"none" cannot stand next to other entries/)
})

test('ranges are ranges: host bits, IPv4 written as IPv6, words in any case', () => {
  const written = policy({ TRUSTED_PROXIES: '10.1.2.3/8 ::ffff:192.168.0.0/112 PRIVATE' })
  assert.deepEqual(written.trustedProxies.names, ['10.1.2.3/8', '192.168.0.0/16', 'private'])
  assert.equal(written.trustedProxies.has('10.200.0.1'), true)
  assert.equal(written.trustedProxies.has('192.168.44.1'), true)
  assert.equal(written.trustedProxies.has('11.0.0.1'), false)
  assert.deepEqual(written.problems, [])
})

test('switches take 1 and 0; anything else keeps the default and says so', () => {
  assert.equal(policy().trustCfConnectingIp, false)
  assert.equal(policy().hsts, true)
  assert.equal(policy({ TRUST_CF_CONNECTING_IP: '1', HSTS: '0' }).trustCfConnectingIp, true)
  assert.equal(policy({ TRUST_CF_CONNECTING_IP: '1', HSTS: '0' }).hsts, false)
  const odd = policy({ HSTS: 'disable' })
  assert.equal(odd.hsts, true)
  assert.match(odd.problems[0], /HSTS=disable: unknown value, it stays on/)
})

test('the start line names what is believed', () => {
  assert.equal(
    describeInboundPolicy(policy()),
    'X-Forwarded-For is believed from loopback; CF-Connecting-IP is ignored; per-address limits apply to every address; HSTS on https',
  )
  assert.equal(
    describeInboundPolicy(policy({ TRUSTED_PROXIES: 'none', TRUST_CF_CONNECTING_IP: '1', SHARED_ADDRESSES: '198.51.100.7', HSTS: '0' })),
    'X-Forwarded-For is believed from nobody; CF-Connecting-IP wins from them; per-address limits skip 198.51.100.7; HSTS off',
  )
})

/* ------------------------------------------------------ shared addresses */

test('a shared address is not counted by the per-address limits; everyone else is', () => {
  const campus = policy({ TRUSTED_PROXIES: 'loopback', SHARED_ADDRESSES: '198.51.100.0/24, 2001:db8:aaaa::/48' })
  assert.equal(addressForLimits(from('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' }), campus), null)
  assert.equal(addressForLimits(from('::ffff:198.51.100.8'), campus), null)
  assert.equal(addressForLimits(from('127.0.0.1', { 'x-forwarded-for': '2001:db8:aaaa::1' }), campus), null)
  assert.equal(addressForLimits(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), campus), '203.0.113.7')
  // The shared address is still the address: the ban hint keeps it.
  assert.equal(clientAddress(from('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' }), campus), '198.51.100.7')
  // A client cannot join the shared range by writing it into the header.
  assert.equal(addressForLimits(from('203.0.113.50', { 'x-forwarded-for': '198.51.100.7' }), campus), '203.0.113.50')
})

test('the ban hint and loopback read the policy of the process', () => {
  useInboundPolicy(policy({ TRUSTED_PROXIES: '10.0.0.5' }))
  assert.equal(addressOf(from('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7')
  assert.equal(addressOf(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), '127.0.0.1')
  useInboundPolicy(null)
  assert.equal(addressOf(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7')
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('203.0.113.7'), false)
  assert.equal(isLoopbackAddress(null), false)
})
