/**
 * Sign-in by a proxy that vouches for the person (AUTH_JWT_*): Teleport
 * application access, or oauth2-proxy in front of an OIDC provider.
 *
 * The token is the whole credential, so most of this file is about tokens
 * that must NOT count: another key, an expired one, the wrong audience, the
 * HMAC-with-the-public-key forgery, `none`. The rest pins what a verified one
 * does — staff by email, staff added by role, one participant per person in a
 * room — and that without a token nothing changes.
 */
import './_env.mts'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { STAFF_COOKIE, type AdminMe, type InstanceState } from '../shared/admin.js'
import type { JoinResponse, SessionInfo } from '../shared/protocol.js'
import { TEST_ROOT } from './_env.mts'
import { originAllowed, readSetupToken, staffCookieValue, staffFromCookieHeader, verifySetupToken } from '../server/src/admin/auth.js'
import { createTeacher, getTeacherByEmail } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'
import { createSession } from '../server/src/db.js'
import { addressForLimits, forwardedHost, parseInboundPolicy } from '../server/src/net/inbound.js'
import { identityFromClaims, parseSsoPolicy, socketCookieHeader, useSsoPolicy } from '../server/src/sso/identity.js'
import { importJwks, KeyCache, verifyJwt, type JwtRules } from '../server/src/sso/jwt.js'

/* ------------------------------------------------------------- the keys */

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const ed = crypto.generateKeyPairSync('ed25519')
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

function jwk(pair: crypto.KeyPairKeyObjectResult, kid: string, alg?: string): Record<string, unknown> {
  return { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', ...(alg ? { alg } : {}) }
}

const JWKS = { keys: [jwk(rsa, 'rsa-1', 'RS256'), jwk(ec, 'ec-1', 'ES256'), jwk(ed, 'ed-1')] }

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function sign(alg: string, key: crypto.KeyObject | string, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const head = segment({ alg, typ: 'JWT', ...header })
  const body = segment(claims)
  const data = Buffer.from(`${head}.${body}`)
  let signature: Buffer
  if (alg === 'none') signature = Buffer.alloc(0)
  else if (alg === 'HS256') signature = crypto.createHmac('sha256', key as string).update(data).digest()
  else if (alg === 'ES256') signature = crypto.sign('sha256', data, { key: key as crypto.KeyObject, dsaEncoding: 'ieee-p1363' })
  else if (alg === 'EdDSA') signature = crypto.sign(null, data, key as crypto.KeyObject)
  else if (alg === 'PS256') {
    signature = crypto.sign('sha256', data, {
      key: key as crypto.KeyObject,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
  } else signature = crypto.sign('sha256', data, key as crypto.KeyObject)
  return `${head}.${body}.${signature.toString('base64url')}`
}

const AUDIENCE = 'https://colloq.corp.test'
const now = () => Math.floor(Date.now() / 1000)

/** What Teleport application access forwards: roles, traits as lists, the user as `sub` and `username`. */
function teleportClaims(user: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'teleport.corp.test',
    aud: [AUDIENCE],
    sub: user,
    username: user,
    roles: ['access'],
    traits: { logins: [user.split('@')[0]], email: [user], name: [] },
    iat: now(),
    nbf: now() - 5,
    exp: now() + 600,
    ...extra,
  }
}

function teleport(user: string, extra: Record<string, unknown> = {}): string {
  return sign('RS256', rsa.privateKey, teleportClaims(user, extra), { kid: 'rsa-1' })
}

const RULES: JwtRules = { algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'], issuer: 'teleport.corp.test', audience: AUDIENCE, leewaySeconds: 60 }

/* ------------------------------------------------------------ verifying */

test('a token signed by one of the published keys verifies, whichever algorithm the proxy uses', () => {
  const keys = importJwks(JWKS)
  assert.equal(keys.length, 3)
  for (const [alg, key, kid] of [['RS256', rsa.privateKey, 'rsa-1'], ['ES256', ec.privateKey, 'ec-1'], ['EdDSA', ed.privateKey, 'ed-1']] as const) {
    const verdict = verifyJwt(sign(alg, key, teleportClaims('ivan@corp.test'), { kid }), keys, RULES)
    assert.equal(verdict.ok, true, `${alg}: ${JSON.stringify(verdict)}`)
  }
  // Without a kid every key of the right type is tried.
  assert.equal(verifyJwt(sign('RS256', rsa.privateKey, teleportClaims('ivan@corp.test')), keys, RULES).ok, true)
  // RSA-PSS with an RSA key whose JWK does not pin an algorithm.
  const pss = importJwks({ keys: [jwk(rsa, 'pss')] })
  assert.equal(verifyJwt(sign('PS256', rsa.privateKey, teleportClaims('ivan@corp.test'), { kid: 'pss' }), pss, RULES).ok, true)
})

test('a token that does not verify is refused, and says why', () => {
  const keys = importJwks(JWKS)
  const claims = teleportClaims('ivan@corp.test')
  const reason = (token: string, rules: JwtRules = RULES) => {
    const verdict = verifyJwt(token, keys, rules)
    return verdict.ok ? 'accepted' : verdict.reason
  }
  assert.equal(reason(sign('RS256', stranger.privateKey, claims, { kid: 'rsa-1' })), 'signature')
  assert.equal(reason(sign('RS256', stranger.privateKey, claims, { kid: 'someone-else' })), 'unknown_key')
  // The classic forgery: HMAC keyed with the public key, which anybody has.
  const publicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  assert.equal(reason(sign('HS256', publicPem, claims, { kid: 'rsa-1' })), 'algorithm')
  assert.equal(reason(sign('none', '', claims)), 'algorithm')
  // An algorithm the operator did not allow, even with a good signature.
  assert.equal(reason(sign('ES256', ec.privateKey, claims, { kid: 'ec-1' }), { ...RULES, algorithms: ['RS256'] }), 'algorithm')
  // An RSA key does not verify an EC token named with its kid.
  assert.equal(reason(sign('ES256', ec.privateKey, claims, { kid: 'rsa-1' })), 'unknown_key')
  assert.equal(reason(sign('RS256', rsa.privateKey, { ...claims, exp: now() - 120 })), 'expired')
  // Thirty seconds of clock difference is forgiven, both ways.
  assert.equal(reason(sign('RS256', rsa.privateKey, { ...claims, exp: now() - 30 })), 'accepted')
  assert.equal(reason(sign('RS256', rsa.privateKey, { ...claims, nbf: now() + 30 })), 'accepted')
  assert.equal(reason(sign('RS256', rsa.privateKey, { ...claims, nbf: now() + 600 })), 'not_yet_valid')
  const { exp: _exp, ...forever } = claims
  assert.equal(reason(sign('RS256', rsa.privateKey, forever)), 'no_expiry')
  assert.equal(reason(sign('RS256', rsa.privateKey, { ...claims, iss: 'teleport.elsewhere' })), 'issuer')
  assert.equal(reason(sign('RS256', rsa.privateKey, { ...claims, aud: ['https://grafana.corp.test'] })), 'audience')
  assert.equal(reason(sign('RS256', rsa.privateKey, { ...claims, aud: AUDIENCE })), 'accepted')
  assert.equal(reason(sign('RS256', rsa.privateKey, claims, { crit: ['b64'] })), 'malformed')
  for (const junk of ['', 'a.b', 'a.b.c.d', 'not!base64.x.y', `${segment({ alg: 'RS256' })}.${segment([1])}.AAAA`, 'x'.repeat(20_000)]) {
    assert.equal(reason(junk), 'malformed', junk.slice(0, 40))
  }
})

test('only signing keys are imported, and only their public half', () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keys = importJwks({
    keys: [
      { kty: 'oct', k: 'c2VjcmV0', kid: 'shared-secret' },
      { ...jwk(rsa, 'for-encryption'), use: 'enc' },
      { kty: 'RSA', n: 'broken', e: 'AQAB', kid: 'broken' },
      // A private key published by mistake still yields only its public half.
      { ...pair.privateKey.export({ format: 'jwk' }), kid: 'leaked' },
      jwk(ec, 'ec-1'),
    ],
  })
  assert.deepEqual(keys.map((key) => key.kid), ['leaked', 'ec-1'])
  assert.equal(keys[0]!.key.type, 'public')
  assert.deepEqual(importJwks({ nope: [] }), [])
  assert.deepEqual(importJwks(null), [])
})

/* ----------------------------------------------------------------- keys */

test('the keys come from the proxy once, again for a key they lack, and a failed fetch keeps them', async () => {
  let served: unknown = { keys: [jwk(rsa, 'rsa-1')] }
  let fetches = 0
  let failing = false
  const jwks = http.createServer((_req, res) => {
    fetches++
    if (failing) return void res.writeHead(503).end()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(served))
  })
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
  const port = (jwks.address() as { port: number }).port
  let clock = 1_000_000
  const cache = new KeyCache({ source: { url: `http://127.0.0.1:${port}/jwks`, file: null }, now: () => clock })
  try {
    await cache.ready('rsa-1')
    assert.equal(fetches, 1)
    assert.ok(cache.has('rsa-1'))
    await cache.ready('rsa-1')
    assert.equal(fetches, 1, 'a known key fetches nothing')

    // The proxy rotated its key: the first token with the new kid refetches.
    served = { keys: [jwk(rsa, 'rsa-1'), jwk(ec, 'ec-2')] }
    clock += 61_000
    await cache.ready('ec-2')
    assert.equal(fetches, 2)
    assert.ok(cache.has('ec-2'))
    // A flood of unknown kids costs one fetch a minute, not one per request.
    await cache.ready('nonsense-1')
    await cache.ready('nonsense-2')
    assert.equal(fetches, 2)

    // The endpoint blinks: the keys it gave stay usable.
    failing = true
    clock += 11 * 60_000
    await cache.ready('rsa-1')
    for (let i = 0; i < 100 && fetches < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    for (let i = 0; i < 100 && !cache.lastError; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(cache.has('rsa-1'))
    assert.match(cache.lastError ?? '', /503/)
  } finally {
    jwks.close()
  }
})

test('keys from a mounted file are reread when the file changes', async () => {
  const file = path.join(TEST_ROOT, 'jwks-rotating.json')
  fs.writeFileSync(file, JSON.stringify({ keys: [jwk(rsa, 'rsa-1')] }))
  let clock = 5_000_000
  const cache = new KeyCache({ source: { url: null, file }, now: () => clock })
  await cache.ready('rsa-1')
  assert.ok(cache.has('rsa-1'))
  fs.writeFileSync(file, JSON.stringify({ keys: [jwk(rsa, 'rsa-1'), jwk(ed, 'ed-2')] }))
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000))
  clock += 61_000
  await cache.ready('ed-2')
  assert.ok(cache.has('ed-2'))
})

/* ---------------------------------------------------------------- policy */

test('sign-in by proxy is on with a key source and an audience, and a setting it cannot read is named', () => {
  assert.equal(parseSsoPolicy({}).enabled, false)
  const keys = { AUTH_JWT_JWKS_URL: 'https://teleport.corp.test/.well-known/jwks.json' }
  const on = parseSsoPolicy({ ...keys, AUTH_JWT_AUDIENCE: AUDIENCE })
  assert.equal(on.enabled, true)
  assert.equal(on.header, 'teleport-jwt-assertion')
  assert.equal(on.rules.audience, AUDIENCE)
  assert.deepEqual(on.problems, [])
  // One proxy signs every application's tokens: without an audience it stays off, and says why.
  const anyApp = parseSsoPolicy(keys)
  assert.equal(anyApp.enabled, false)
  assert.match(anyApp.problems.join('\n'), /AUTH_JWT_AUDIENCE/)
  const star = parseSsoPolicy({ ...keys, AUTH_JWT_AUDIENCE: '*' })
  assert.equal(star.enabled, true)
  assert.equal(star.rules.audience, null)
  // The keys must not travel where someone could swap them.
  const plain = parseSsoPolicy({ AUTH_JWT_JWKS_URL: 'http://teleport.corp.test/.well-known/jwks.json', AUTH_JWT_AUDIENCE: AUDIENCE })
  assert.equal(plain.enabled, false)
  assert.match(plain.problems.join('\n'), /must be https/)
  assert.equal(parseSsoPolicy({ AUTH_JWT_JWKS_URL: 'http://teleport-proxy.teleport.svc:3080/.well-known/jwks.json', AUTH_JWT_AUDIENCE: AUDIENCE }).enabled, true)
  const both = parseSsoPolicy({ ...keys, AUTH_JWT_JWKS_FILE: '/etc/jwks.json', AUTH_JWT_AUDIENCE: AUDIENCE })
  assert.equal(both.enabled, false)
  // Authorization is the room API's: a proxy writing its token there would break it.
  for (const taken of ['Authorization', 'cookie', 'x-forwarded-host', 'two words']) {
    const policy = parseSsoPolicy({ ...keys, AUTH_JWT_AUDIENCE: AUDIENCE, AUTH_JWT_HEADER: taken })
    assert.equal(policy.enabled, false, taken)
    assert.match(policy.problems.join('\n'), /AUTH_JWT_HEADER/)
  }
  const odd = parseSsoPolicy({ AUTH_JWT_JWKS_FILE: '/etc/jwks.json', AUTH_JWT_AUDIENCE: AUDIENCE, AUTH_JWT_ALGORITHMS: 'RS256,HS256,none', AUTH_JWT_LEEWAY_SECONDS: 'soon', AUTH_JWT_HEADER: 'X-Forwarded-Access-Token' })
  assert.deepEqual(odd.rules.algorithms, ['RS256'])
  assert.equal(odd.rules.leewaySeconds, 60)
  assert.equal(odd.header, 'x-forwarded-access-token')
  assert.equal(odd.enabled, true)
  assert.equal(odd.problems.length, 3)
})

test('the claims name the person the way Teleport and an OIDC provider spell them', () => {
  const policy = parseSsoPolicy({ AUTH_JWT_JWKS_FILE: '/x' })
  const fromTeleport = identityFromClaims({
    sub: 'ivan.petrov', username: 'ivan.petrov', roles: ['access', 'colloq-teacher'],
    traits: { email: ['Ivan.Petrov@Corp.Test'], full_name: ['Иван  Петров'] },
  }, policy)
  assert.deepEqual(fromTeleport, { subject: 'ivan.petrov', name: 'Иван Петров', email: 'ivan.petrov@corp.test', roles: ['access', 'colloq-teacher'] })
  const fromOidc = identityFromClaims({ sub: '00u1', email: 'maria@corp.test', name: 'Мария', groups: ['students'] }, policy)
  assert.deepEqual(fromOidc, { subject: '00u1', name: 'Мария', email: 'maria@corp.test', roles: ['students'] })
  // A login only, and a domain to make an address of it.
  const login = parseSsoPolicy({ AUTH_JWT_JWKS_FILE: '/x', AUTH_JWT_EMAIL_DOMAIN: '@corp.test' })
  assert.equal(identityFromClaims({ sub: 'olga', username: 'olga' }, login)?.email, 'olga@corp.test')
  assert.equal(identityFromClaims({ sub: 'olga', username: 'olga' }, policy)?.email, null)
  assert.equal(identityFromClaims({ name: 'Nobody' }, policy), null, 'no subject, no person')
})

/* ------------------------------------------------- the app, end to end */

let server: http.Server
let base = ''

before(async () => {
  const file = path.join(TEST_ROOT, 'jwks.json')
  fs.writeFileSync(file, JSON.stringify(JWKS))
  useSsoPolicy(parseSsoPolicy({
    AUTH_JWT_JWKS_FILE: file,
    AUTH_JWT_ISSUER: 'teleport.corp.test',
    AUTH_JWT_AUDIENCE: AUDIENCE,
    AUTH_JWT_OWNER_ROLES: 'colloq-owner',
    AUTH_JWT_TEACHER_ROLES: 'colloq-teacher',
  }))
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  useSsoPolicy(null)
})

function call(method: string, route: string, init: { token?: string; cookie?: string; origin?: string; body?: unknown } = {}) {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { 'teleport-jwt-assertion': init.token } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

function staffCookieOf(response: globalThis.Response): string | null {
  const set = response.headers.getSetCookie().find((line) => line.startsWith(`${STAFF_COOKIE}=`))
  return set ? set.split(';')[0]! : null
}

let ownerCookie = ''

test('an unclaimed instance is claimed by the first owner the proxy vouches for, and the printed token dies', async () => {
  const printed = readSetupToken()
  // A teacher role alone does not claim: an instance needs an owner first.
  const early = await call('GET', '/api/admin/me', { token: teleport('early.teacher@corp.test', { roles: ['colloq-teacher'] }) })
  assert.equal(early.status, 401)
  assert.equal(getTeacherByEmail('early.teacher@corp.test'), null)

  const response = await call('GET', '/api/admin/me', { token: teleport('dean@corp.test', { roles: ['colloq-owner'], traits: { email: ['dean@corp.test'], name: ['Декан'] } }) })
  assert.equal(response.status, 200)
  const me = (await response.json()) as AdminMe
  assert.equal(me.teacher.role, 'owner')
  assert.equal(me.teacher.name, 'Декан')
  assert.equal(verifySetupToken(printed), false, 'the setup token printed before the claim must stop working')
  const cookie = staffCookieOf(response)
  assert.ok(cookie, 'the proxy sign-in issues the ordinary staff cookie')
  ownerCookie = cookie
})

test('the cookie the proxy sign-in issued is the one sockets and later requests read', async () => {
  assert.equal(staffFromCookieHeader(ownerCookie)?.email, 'dean@corp.test')
  const later = await call('GET', '/api/admin/me', { cookie: ownerCookie })
  assert.equal(later.status, 200)
  // Already signed in as the same person: no second cookie on every request.
  const again = await call('GET', '/api/admin/me', { cookie: ownerCookie, token: teleport('dean@corp.test') })
  assert.equal(again.status, 200)
  assert.equal(staffCookieOf(again), null)
})

test('a teacher role adds the person once; without one a person is matched by email or not at all', async () => {
  const anna = teleport('anna@corp.test', { roles: ['access', 'colloq-teacher'] })
  const first = (await (await call('GET', '/api/admin/me', { token: anna })).json()) as AdminMe
  const second = (await (await call('GET', '/api/admin/me', { token: anna })).json()) as AdminMe
  assert.equal(first.teacher.role, 'teacher')
  assert.equal(first.teacher.id, second.teacher.id)

  const petr = teleport('petr@corp.test')
  assert.equal((await call('GET', '/api/admin/me', { token: petr })).status, 401)
  const state = (await (await call('GET', '/api/admin/state', { token: petr })).json()) as InstanceState
  assert.deepEqual(state.sso?.identity, { name: 'petr@corp.test', email: 'petr@corp.test' })
  // The owner adds him in the panel, as for any colleague; the next request is signed in.
  assert.ok(createTeacher({ name: 'Пётр', email: 'Petr@corp.test', role: 'teacher' }))
  assert.equal((await call('GET', '/api/admin/me', { token: petr })).status, 200)
  // A role never changes the role of someone already on the list.
  const demoted = (await (await call('GET', '/api/admin/me', { token: teleport('anna@corp.test', { roles: ['colloq-owner'] }) })).json()) as AdminMe
  assert.equal(demoted.teacher.role, 'teacher')
})

test('a token that does not verify is no identity: no cookie, no staff, no name', async () => {
  const claims = teleportClaims('dean@corp.test', { roles: ['colloq-owner'] })
  const publicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  for (const token of [
    sign('RS256', stranger.privateKey, claims, { kid: 'rsa-1' }),
    sign('HS256', publicPem, claims, { kid: 'rsa-1' }),
    sign('none', '', claims),
    sign('RS256', rsa.privateKey, { ...claims, exp: now() - 3600 }, { kid: 'rsa-1' }),
    sign('RS256', rsa.privateKey, { ...claims, aud: ['https://other.corp.test'] }, { kid: 'rsa-1' }),
    'garbage',
  ]) {
    const response = await call('GET', '/api/admin/me', { token })
    assert.equal(response.status, 401, token.slice(0, 30))
    assert.equal(staffCookieOf(response), null)
    const state = (await (await call('GET', '/api/admin/state', { token })).json()) as InstanceState
    assert.deepEqual(state.sso, { identity: null })
  }
})

test('a student walks into a room under the proxy\'s name and stays one person on any device', async () => {
  const room = 'sso-room-1'
  createSession(room, 'Семинар', null)
  const maria = teleport('maria@corp.test', { traits: { email: ['maria@corp.test'], name: ['Мария Иванова'] } })

  const info = (await (await call('GET', `/api/sessions/${room}`, { token: maria })).json()) as SessionInfo
  assert.deepEqual(info.viewer, { name: 'Мария Иванова' })
  const plain = (await (await call('GET', `/api/sessions/${room}`)).json()) as SessionInfo
  assert.equal(plain.viewer ?? null, null)

  const laptop = (await (await call('POST', `/api/sessions/${room}/join`, { token: maria, body: { name: 'Хакер' } })).json()) as JoinResponse
  assert.equal(laptop.participant.name, 'Мария Иванова', 'the name is the one the proxy gives')
  assert.equal(laptop.participant.role, 'participant')
  // A phone: no participant token of its own, the same person.
  const phone = (await (await call('POST', `/api/sessions/${room}/join`, { token: maria, body: { name: 'Мария' } })).json()) as JoinResponse
  assert.equal(phone.participant.id, laptop.participant.id)

  const oleg = (await (await call('POST', `/api/sessions/${room}/join`, { token: teleport('oleg@corp.test'), body: { name: 'Мария Иванова' } })).json()) as JoinResponse
  assert.notEqual(oleg.participant.id, laptop.participant.id)
  // Maria's browser storage on a shared computer: Oleg does not become her.
  const shared = (await (await call('POST', `/api/sessions/${room}/join`, {
    token: teleport('oleg@corp.test'), body: { name: 'x', participantId: laptop.participant.id, token: laptop.token },
  })).json()) as JoinResponse
  assert.equal(shared.participant.id, oleg.participant.id)
  // Her own token, presented with her own sign-in, is still hers.
  const back = (await (await call('POST', `/api/sessions/${room}/join`, {
    token: maria, body: { name: 'x', participantId: laptop.participant.id, token: laptop.token },
  })).json()) as JoinResponse
  assert.equal(back.participant.id, laptop.participant.id)
  // Without the proxy a link still works, by the name typed.
  const guest = (await (await call('POST', `/api/sessions/${room}/join`, { body: { name: 'Гость' } })).json()) as JoinResponse
  assert.equal(guest.participant.name, 'Гость')
  assert.equal(guest.participant.role, 'participant')
  // And a teacher the proxy vouches for is the host of the room.
  const dean = (await (await call('POST', `/api/sessions/${room}/join`, { token: teleport('dean@corp.test'), body: { name: 'x' } })).json()) as JoinResponse
  assert.equal(dean.participant.role, 'host')
})

test('per-address limits count the person the proxy vouches for, not the proxy\'s address', () => {
  const proxy = { headers: {}, socket: { remoteAddress: '10.20.0.7' } }
  assert.equal(addressForLimits(proxy), '10.20.0.7')
  assert.equal(addressForLimits({ ...proxy, ssoIdentity: { subject: 'maria@corp.test' } }), 'sso:maria@corp.test')
})

/** A POST with a Host of our choosing, as a proxy forwarding to the Service by its name sends it. */
function postAs(host: string, origin: string): Promise<number> {
  const url = new URL(`${base}/api/admin/signout`)
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { host, origin, cookie: ownerCookie, 'content-type': 'application/json' } }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    request.on('error', reject)
    request.end('{}')
  })
}

test('a write from the public address passes the origin check whatever Host the proxy writes', async () => {
  const saved = { session: process.env.COLLOQ_LOCAL_SESSION, url: process.env.COLLOQ_LOCAL_URL }
  process.env.COLLOQ_LOCAL_SESSION = '1'
  process.env.COLLOQ_LOCAL_URL = 'https://colloq.corp.test'
  try {
    // Teleport may forward to the Service under the Service's own name.
    assert.notEqual(await postAs('colloq-app.colloq.svc:3000', 'https://colloq.corp.test'), 403)
    assert.equal(await postAs('colloq-app.colloq.svc:3000', 'https://evil.example'), 403)
    assert.equal(await postAs('colloq-app.colloq.svc:3000', 'https://colloq.corp.test.evil.example'), 403)
  } finally {
    if (saved.session === undefined) delete process.env.COLLOQ_LOCAL_SESSION
    else process.env.COLLOQ_LOCAL_SESSION = saved.session
    if (saved.url === undefined) delete process.env.COLLOQ_LOCAL_URL
    else process.env.COLLOQ_LOCAL_URL = saved.url
  }
})

test('behind a front that rewrites Host, Origin is compared with the host a trusted proxy reports', () => {
  const policy = parseInboundPolicy({ TRUSTED_PROXIES: 'private' })
  const fromProxy = { headers: { 'x-forwarded-host': 'Colloq.Teleport.Corp.Test, inner.example' }, socket: { remoteAddress: '10.42.1.17' } }
  assert.equal(forwardedHost(fromProxy, policy), 'colloq.teleport.corp.test')
  // Anyone else's X-Forwarded-Host is the client's own word.
  assert.equal(forwardedHost({ ...fromProxy, socket: { remoteAddress: '203.0.113.9' } }, policy), null)
  assert.equal(forwardedHost({ headers: { 'x-forwarded-host': 'evil.example/path' }, socket: { remoteAddress: '10.42.1.17' } }, policy), null)
  assert.equal(forwardedHost({ headers: {}, socket: { remoteAddress: '10.42.1.17' } }, policy), null)

  const service = 'colloq-app.colloq.svc:3000'
  assert.equal(originAllowed('https://colloq.teleport.corp.test', service, 'colloq.teleport.corp.test'), true)
  assert.equal(originAllowed('https://colloq.teleport.corp.test', service, null), false)
  assert.equal(originAllowed('https://evil.example', service, 'colloq.teleport.corp.test'), false)
})

test('a cookie a shared browser kept from the previous teacher never outranks the person the proxy vouches for', async () => {
  const teacher = getTeacherByEmail('dean@corp.test')
  assert.ok(teacher)
  const left = `${STAFF_COOKIE}=${staffCookieValue(teacher)}`
  // A student signs in to the proxy on the lab computer the dean used.
  const student = teleport('lab.student@corp.test')
  const me = await call('GET', '/api/admin/me', { token: student, cookie: left })
  assert.equal(me.status, 401)
  const cleared = me.headers.getSetCookie().find((line) => line.startsWith(`${STAFF_COOKIE}=`))
  assert.ok(cleared && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(cleared), `the old cookie is removed: ${cleared}`)
  const room = 'sso-room-shared-pc'
  createSession(room, 'Лаборатория', null)
  const joined = (await (await call('POST', `/api/sessions/${room}/join`, { token: student, cookie: left, body: { name: 'x' } })).json()) as JoinResponse
  assert.equal(joined.participant.role, 'participant')
  // And another teacher's sign-in replaces the cookie with their own.
  const anna = await call('GET', '/api/admin/me', { token: teleport('anna@corp.test'), cookie: left })
  assert.equal(((await anna.json()) as AdminMe).teacher.email, 'anna@corp.test')
  assert.equal(staffFromCookieHeader(staffCookieOf(anna) ?? '')?.email, 'anna@corp.test')
})

test('a socket reads the proxy\'s decision too, not the cookie the browser kept', async () => {
  const dean = getTeacherByEmail('dean@corp.test')
  assert.ok(dean)
  const left = `theme=dark; ${STAFF_COOKIE}=${staffCookieValue(dean)}`
  const forStudent = await socketCookieHeader({ cookie: left, 'teleport-jwt-assertion': teleport('lab.student@corp.test') })
  assert.equal(forStudent, 'theme=dark')
  assert.equal(staffFromCookieHeader(forStudent), null)
  const forAnna = await socketCookieHeader({ cookie: left, 'teleport-jwt-assertion': teleport('anna@corp.test') })
  assert.equal(staffFromCookieHeader(forAnna)?.email, 'anna@corp.test')
  assert.match(forAnna ?? '', /^theme=dark; /)
  // No token, or one that does not verify: the browser's own header, untouched.
  assert.equal(await socketCookieHeader({ cookie: left }), left)
  assert.equal(await socketCookieHeader({ cookie: left, 'teleport-jwt-assertion': 'garbage' }), left)
})

test('the staff cookie rides on pages and API calls, never on the build\'s cacheable assets', async () => {
  const fresh = teleport('anna@corp.test')
  const asset = await fetch(`${base}/assets/index-nothing.js`, { headers: { 'teleport-jwt-assertion': fresh, accept: '*/*' } })
  assert.equal(staffCookieOf(asset), null)
  const page = await fetch(`${base}/admin`, { headers: { 'teleport-jwt-assertion': fresh, accept: 'text/html', 'sec-fetch-mode': 'navigate' } })
  assert.ok(staffCookieOf(page), 'a navigation signs the teacher in')
})
