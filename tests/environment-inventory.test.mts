import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryReader, parseInventory } from '../server/src/environment-inventory.js'

const IMAGE_A = `sha256:${'a'.repeat(64)}`
const IMAGE_B = `sha256:${'b'.repeat(64)}`
const payload = JSON.stringify({ python: '3.11.16', packages: [{ name: 'numpy', version: '2.4.6' }, { name: 'LightGBM', version: '4.6.0' }, { name: 'pip', version: '25.1' }] })

test('inventory exposes actual versions, sorts packages and drops extra image metadata', () => {
  assert.deepEqual(parseInventory('pvz-geo', JSON.stringify({ ...JSON.parse(payload), token: 'not-public' })), {
    name: 'pvz-geo', python: '3.11.16', packages: [{ name: 'LightGBM', version: '4.6.0' }, { name: 'numpy', version: '2.4.6' }, { name: 'pip', version: '25.1' }],
  })
  assert.throws(() => parseInventory('pvz-geo', '{broken'))
  assert.throws(() => parseInventory('pvz-geo', JSON.stringify({ python: '3.11', packages: ['lightgbm>=4'] })))
})

test('concurrent reads inspect once; a changed image gets a new inventory', async () => {
  let now = 0
  let image = IMAGE_A
  const calls: string[][] = []
  const read = createInventoryReader(async (args) => {
    calls.push(args)
    if (args[0] === 'image') return image
    if (args[0] === 'run') return payload
    return ''
  }, () => now)
  const [a, b] = await Promise.all([read('pvz-geo'), read('pvz-geo')])
  assert.deepEqual(a, b)
  assert.equal(calls.filter(c => c[0] === 'run').length, 1)
  const run = calls.find(c => c[0] === 'run')!
  for (const flag of ['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL']) assert(run.includes(flag))
  assert(run.includes(IMAGE_A), 'run the inspected immutable image, not a mutable tag')
  now = 31_000
  await read('pvz-geo')
  assert.equal(calls.filter(c => c[0] === 'run').length, 1)
  image = IMAGE_B
  now += 31_000
  await read('pvz-geo')
  assert.equal(calls.filter(c => c[0] === 'run').length, 2)
})

test('invalid names never call Docker; a failed probe is cleaned up and can retry', async () => {
  let now = 0
  let failed = true
  const calls: string[][] = []
  const read = createInventoryReader(async (args) => {
    calls.push(args)
    if (args[0] === 'image') return IMAGE_A
    if (args[0] === 'run') { if (failed) throw new Error('probe failed'); return payload }
    return ''
  }, () => now)
  await assert.rejects(read('../secret'))
  assert.equal(calls.length, 0)
  await assert.rejects(read('pvz-geo'))
  assert(calls.some(c => c[0] === 'rm'))
  failed = false
  now += 31_000
  assert.equal((await read('pvz-geo')).python, '3.11.16')
})

test('public environment endpoint serves only the environment of a visible competition', async () => {
  const { default: express } = await import('express')
  const { competitionRoutes } = await import('../server/src/routes/competitions.js')
  const { createCompetition, setCompetitionState } = await import('../server/src/competitions/store.js')
  const live = createCompetition({ slug: 'inventory-live', title: 'Inventory', environment: 'pvz-geo' })
  createCompetition({ slug: 'inventory-draft', title: 'Draft', environment: 'private-env' })
  setCompetitionState(live.id, 'live')
  const app = express()
  let calls = 0
  app.use(competitionRoutes(async name => { calls++; return parseInventory(name, payload) }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.on('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    for (const slug of ['inventory-draft', 'missing']) {
      assert.equal((await fetch(`${base}/api/k/competitions/${slug}/environment`)).status, 404)
    }
    assert.equal(calls, 0)
    const response = await fetch(`${base}/api/k/competitions/inventory-live/environment`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), parseInventory('pvz-geo', payload))
  } finally { server.closeAllConnections(); server.close() }
})

test('unavailable environment returns a readable error without Docker diagnostics', async () => {
  const { default: express } = await import('express')
  const { competitionRoutes } = await import('../server/src/routes/competitions.js')
  const app = express()
  app.use(competitionRoutes(async () => { throw new Error('private host path and daemon diagnostics') }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.on('listening', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const response = await fetch(`${base}/api/k/competitions/inventory-live/environment`)
    assert.equal(response.status, 503)
    const body = await response.json() as { error: string; reason: string }
    assert.equal(body.reason, 'unavailable')
    assert(body.error.length > 20)
    assert(!body.error.includes('private host'))
  } finally { server.closeAllConnections(); server.close() }
})
