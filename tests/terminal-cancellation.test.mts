import './_env.mts'
import { TEST_ROOT } from './_env.mts'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
type Gate = { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }
const gate = (): Gate => ({ entered: deferred(), released: deferred() })
let endpointGate: Gate | null = null, createGate: Gate | null = null, upgradeGate: Gate | null = null
let server: Server, wss: WebSocketServer, url = '', created = 0, upgrades = 0
const deleted = new Set<string>()
const sockets = new Map<string, WebSocket>()
before(async () => {
  server = createServer((req, res) => { void (async () => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/rooms/')) {
      const held = endpointGate; endpointGate = null
      if (held) { held.entered.resolve(); await held.released.promise }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url, token: 'jupyter-test-token', instanceId: 'pod-uid', environment: 'base', revision: `sha256:${'a'.repeat(64)}` })); return
    }
    if (req.method === 'POST' && req.url === '/api/terminals') {
      const name = String(++created), held = createGate; createGate = null
      if (held) { held.entered.resolve(); await held.released.promise }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name })); return
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/api/terminals/')) {
      deleted.add(decodeURIComponent(req.url.slice('/api/terminals/'.length))); res.writeHead(204).end(); return
    }
    res.writeHead(404).end()
  })() })
  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => { void (async () => {
    upgrades++; const held = upgradeGate; upgradeGate = null
    if (held) { held.entered.resolve(); await held.released.promise }
    if (socket.destroyed) return
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.set(/\/websocket\/([^?]+)/.exec(req.url!)![1], ws)
      ws.send(JSON.stringify(['setup', {}])); ws.send(JSON.stringify(['stdout', '$ ']))
    })
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.JUPYTER_URL = url
  process.env.KERNEL_BACKEND = 'broker'; delete process.env.KERNEL_ISOLATION
  process.env.KERNEL_RUNTIME_URL = url; process.env.KERNEL_RUNTIME_TOKEN = 'test-runtime-credential-1234567890abcdef'
  const catalog = path.join(TEST_ROOT, 'catalog.json')
  fs.writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, release: 'test', defaultEnvironment: 'base', environments: [{ name: 'base', image: `example.com/base@sha256:${'a'.repeat(64)}`, gpu: false, current: true }] }))
  process.env.KERNEL_CATALOG_FILE = catalog
})
after(async () => {
  const { shutdownTerminals } = await import('../server/src/kernel/terminal.js'); await shutdownTerminals()
  const { shutdownCollab } = await import('../server/src/collab/index.js'); shutdownCollab()
  for (const ws of wss.clients) ws.terminate()
  wss.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
})
let sequence = 0
async function room() {
  const { createSession } = await import('../server/src/db.js'); const id = `term-cancel-${++sequence}`; createSession(id, id)
  const terminal = await import('../server/src/kernel/terminal.js')
  return { id, ...terminal }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('close while room endpoint is pending prevents PTY creation and preserves closed phase', async () => {
  const t = await room(), held = gate(); endpointGate = held; const before = created
  const opening = t.openTerminal(t.id).then(() => null, error => error)
  await held.entered.promise; await t.closeTerminal(t.id); held.released.resolve()
  assert.ok(await opening instanceof Error); assert.equal(created, before); assert.equal(t.terminalPhase(t.id), 'closed')
})
test('a PTY returned after close is deleted without opening a socket', async () => {
  const t = await room(), held = gate(); createGate = held; const before = upgrades
  const opening = t.openTerminal(t.id).then(() => null, error => error)
  await held.entered.promise; const lateName = String(created); await t.closeTerminal(t.id); held.released.resolve()
  assert.ok(await opening instanceof Error); assert.ok(deleted.has(lateName)); assert.equal(upgrades, before); assert.equal(t.terminalPhase(t.id), 'closed')
})
test('closing a pending socket handshake cannot later attach it', async () => {
  const t = await room(), held = gate(); upgradeGate = held
  const opening = t.openTerminal(t.id).then(() => null, error => error)
  await held.entered.promise; await t.closeTerminal(t.id); held.released.resolve()
  assert.ok(await opening instanceof Error); await pause(30); assert.equal(t.terminalPhase(t.id), 'closed')
})
test('a canceled opening cannot overwrite a later explicit reopen', async () => {
  const t = await room(), held = gate(); createGate = held
  const old = t.openTerminal(t.id).then(() => null, error => error)
  await held.entered.promise; const lateName = String(created); await t.closeTerminal(t.id)
  const handshake = gate(); upgradeGate = handshake
  const fresh = t.openTerminal(t.id)
  await handshake.entered.promise
  held.released.resolve(); assert.ok(await old instanceof Error)
  assert.equal(t.openTerminal(t.id), fresh, 'old finally must not clear the newer opening promise')
  handshake.released.resolve(); await fresh
  assert.ok(deleted.has(lateName)); assert.notEqual(t.terminalPhase(t.id), 'closed')
  await t.closeTerminal(t.id)
})
test('shutdown invalidates pending PTY creation without mutating a replacement term', async () => {
  const t = await room(), held = gate(); createGate = held
  const old = t.openTerminal(t.id).then(() => null, error => error)
  await held.entered.promise; const lateName = String(created); await t.shutdownTerminals(); held.released.resolve()
  assert.ok(await old instanceof Error); assert.ok(deleted.has(lateName)); assert.equal(t.terminalPhase(t.id), 'closed')
})
test('close cancels a reconnect waiting for a broker endpoint', async () => {
  const t = await room(); await t.openTerminal(t.id)
  const name = String(created), held = gate(); endpointGate = held; const before = upgrades
  sockets.get(name)!.terminate()
  await held.entered.promise; await t.closeTerminal(t.id); held.released.resolve()
  await pause(50); assert.equal(upgrades, before); assert.equal(t.terminalPhase(t.id), 'closed')
})
test('close cancels a reconnect socket handshake without scheduling another reconnect', async () => {
  const t = await room(); await t.openTerminal(t.id)
  const name = String(created), held = gate(); upgradeGate = held
  sockets.get(name)!.terminate()
  await held.entered.promise; const before = upgrades; await t.closeTerminal(t.id); held.released.resolve()
  await pause(600); assert.equal(upgrades, before); assert.equal(t.terminalPhase(t.id), 'closed')
})
