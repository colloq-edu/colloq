/**
 * What the app says about itself and how it pins the browser, by audience.
 *
 * HSTS goes out only where a browser will honour it and it cannot trap
 * anyone: over https, on a real name, unless HSTS=0. Readiness asks only
 * what serving a page needs, so a dead kernel runtime does not take the site
 * out of rotation. Health keeps its checks and codes for everyone but hands
 * its internal text (error messages with paths, the link address, the run id)
 * only to the machine itself or to staff; a request the relay forwarded from
 * the internet arrives from 127.0.0.1 and is still a stranger.
 *
 * The test environment has no kernel (JUPYTER_URL points at a closed port),
 * which is exactly "a broken kernel runtime".
 */
import './_env.mts'
import http from 'node:http'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { app } from '../server/src/app.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher } from '../server/src/admin/store.js'
import { db } from '../server/src/db.js'
import { STRICT_TRANSPORT_SECURITY, sendsStrictTransport } from '../server/src/headers.js'
import { parseInboundPolicy, useInboundPolicy } from '../server/src/net/inbound.js'
import { workspaceFs } from '../server/src/workspace.js'

let server: http.Server
let port = 0

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

after(() => server?.close())
afterEach(() => useInboundPolicy(null))

interface Answer {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** http.request, not fetch: the Host header is the point of half of these cases. */
function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const staffCookie = (() => {
  let cookie = ''
  const teacher = createTeacher({ name: 'Ops', email: 'ops.health@test.local', role: 'teacher' })
  assert.ok(teacher)
  issueStaffCookie({ cookie: (name: string, value: string) => (cookie = `${name}=${value}`) } as unknown as ExpressResponse, teacher)
  return cookie
})()

/* ------------------------------------------------------------------ HSTS */

test('HSTS goes out on https requests to a real name, on every door', async () => {
  const https = { host: 'colloq.example.edu', 'x-forwarded-proto': 'https' }
  for (const path of ['/api/livez', '/api/readyz', '/api/nope']) {
    assert.equal((await get(path, https)).headers['strict-transport-security'], STRICT_TRANSPORT_SECURITY, path)
  }
  assert.equal(STRICT_TRANSPORT_SECURITY, 'max-age=15552000')
  assert.doesNotMatch(STRICT_TRANSPORT_SECURITY, /includeSubDomains/i)
})

test('never on plain http, never with HSTS=0', async () => {
  assert.equal((await get('/api/livez', { host: 'colloq.example.edu' })).headers['strict-transport-security'], undefined)
  assert.equal(
    (await get('/api/livez', { host: 'colloq.example.edu', 'x-forwarded-proto': 'http' })).headers['strict-transport-security'],
    undefined,
  )
  useInboundPolicy(parseInboundPolicy({ HSTS: '0' }))
  assert.equal(
    (await get('/api/livez', { host: 'colloq.example.edu', 'x-forwarded-proto': 'https' })).headers['strict-transport-security'],
    undefined,
  )
})

test('never for localhost or a bare IP: that would pin the machine, not the class', async () => {
  for (const host of ['localhost:3000', 'dev.localhost', '203.0.113.5', '[2001:db8::1]:443']) {
    const seen = await get('/api/livez', { host, 'x-forwarded-proto': 'https' })
    assert.equal(seen.headers['strict-transport-security'], undefined, host)
  }
  assert.equal(sendsStrictTransport({ enabled: true, https: true, hostname: 'Colloq.Example.EDU' }), true)
  assert.equal(sendsStrictTransport({ enabled: true, https: true, hostname: '' }), false)
})

/* ------------------------------------------------------------- readiness */

test('readiness stays green with a dead kernel runtime, while health says 503', async () => {
  const health = await get('/api/health')
  assert.equal(health.status, 503, 'the fixture is supposed to have no kernel')
  const ready = await get('/api/readyz')
  assert.equal(ready.status, 200)
  assert.deepEqual(JSON.parse(ready.body), { ok: true, database: true, workspace: true })
  assert.equal(ready.headers['cache-control'], 'no-store')
})

test('readiness goes red without the workspace or the database, and names no reason', async (t) => {
  const broken = t.mock.method(workspaceFs, 'mkdirSync', () => {
    throw new Error("EACCES: permission denied, mkdir '/srv/colloq/workspace'")
  })
  const noFolder = await get('/api/readyz')
  assert.equal(noFolder.status, 503)
  assert.deepEqual(JSON.parse(noFolder.body), { ok: false, database: true, workspace: false })
  broken.mock.restore()

  const unreadable = t.mock.method(db, 'prepare', () => {
    throw new Error('SQLITE_CORRUPT: /srv/colloq/data/colloq.db')
  })
  const noDatabase = await get('/api/readyz')
  unreadable.mock.restore()
  assert.equal(noDatabase.status, 503)
  assert.deepEqual(JSON.parse(noDatabase.body), { ok: false, database: false, workspace: true })
})

/* ---------------------------------------------------------------- health */

test('a stranger from the internet gets the verdict, the checks and the version, not the reasons', async (t) => {
  t.mock.method(workspaceFs, 'mkdirSync', () => {
    throw new Error("EACCES: permission denied, mkdir '/srv/colloq/workspace'")
  })
  // Forwarded by the relay: the peer is loopback, the client is not.
  const stranger = await get('/api/health', { 'x-forwarded-for': '203.0.113.9' })
  assert.equal(stranger.status, 503, 'the status code is the same for everyone')
  const said = JSON.parse(stranger.body) as Record<string, unknown>
  // isolation stays: host.sh reads it through Docker's port publishing and the k3s NodePort.
  assert.deepEqual(Object.keys(said).sort(), ['database', 'isolation', 'kernel', 'ok', 'version', 'workspace'])
  assert.equal(said.ok, false)
  assert.equal(said.workspace, false)
  assert.equal(typeof said.version, 'string')
  assert.doesNotMatch(stranger.body, /srv\/colloq|EACCES|localhost:9999/)
  assert.equal(stranger.headers['server-timing'], undefined)

  // The machine itself (colloq-vast status, host.sh, the CLI) reads everything.
  const local = JSON.parse((await get('/api/health')).body) as Record<string, unknown>
  assert.match(String(local.reason), /./)
  for (const field of ['capabilities', 'isolation', 'publicUrl', 'localRunId', 'uptimeMs', 'loopLagMs']) {
    assert.ok(field in local, `the local answer lost ${field}`)
  }

  // Staff read everything from anywhere.
  const staff = await get('/api/health', { 'x-forwarded-for': '203.0.113.9', cookie: staffCookie })
  const full = JSON.parse(staff.body) as Record<string, unknown>
  assert.match(String(full.reason), /./)
  assert.ok('publicUrl' in full)
  assert.match(String(staff.headers['server-timing']), /^loop;dur=/)
})

test('loopback is judged after the forwarded address is resolved', async () => {
  // A client that writes 127.0.0.1 itself behind a proxy that appends is still the proxy's client.
  const appended = JSON.parse((await get('/api/health', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' })).body)
  assert.equal('reason' in appended, false)
  // With no proxy believed, a local peer is local whatever the header says.
  useInboundPolicy(parseInboundPolicy({ TRUSTED_PROXIES: 'none' }))
  const direct = JSON.parse((await get('/api/health', { 'x-forwarded-for': '203.0.113.9' })).body)
  assert.equal('reason' in direct, true)
})
