/**
 * The disk gauge in the Resources tab.
 *
 * One filesystem usually holds the database, notebook saves, uploads and
 * everything the students' code writes, with no quota per room; a class that
 * fills it stops saves in every room. The panel shows free space and warns
 * below 15 % or 10 GB free, whichever comes first; the server applies the rule.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { DISK_LOW_BYTES, DISK_LOW_FRACTION, diskLow } from '../shared/disk.ts'

const GB = 1024 ** 3

test('the warning thresholds: under 15 % free or under 10 GB free, whichever comes first', () => {
  assert.equal(DISK_LOW_FRACTION, 0.15)
  assert.equal(DISK_LOW_BYTES, 10 * GB)
  // A large disk: the share decides.
  assert.equal(diskLow(149 * GB, 1000 * GB), true)
  assert.equal(diskLow(150 * GB, 1000 * GB), false)
  assert.equal(diskLow(11 * GB, 1000 * GB), true)
  // A small disk: the size decides, long before the share would.
  assert.equal(diskLow(9.9 * GB, 40 * GB), true)
  assert.equal(diskLow(10 * GB, 40 * GB), false)
  assert.equal(diskLow(30 * GB, 40 * GB), false)
  // A disk smaller than the size threshold is always tight.
  assert.equal(diskLow(7 * GB, 8 * GB), true)
  // Nothing known, nothing to warn about.
  assert.equal(diskLow(0, 0), false)
  assert.equal(diskLow(Number.NaN, 100 * GB), false)
})

test('the server measures the data filesystem, and the workspace only when it is a different one', async () => {
  const { config } = await import('../server/src/config.ts')
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(config.workspaceDir, { recursive: true })
  const { diskUsage } = await import('../server/src/ops/disk.ts')
  const usage = diskUsage()
  assert.ok(usage)
  assert.ok(usage.data.totalBytes > 0)
  assert.ok(usage.data.freeBytes >= 0 && usage.data.freeBytes <= usage.data.totalBytes)
  assert.equal(usage.data.low, diskLow(usage.data.freeBytes, usage.data.totalBytes))
  // The test directories share one filesystem: one bar, not two copies of it.
  assert.equal(usage.workspace, null)
})

test('staff get the numbers with the Resources payload and from the operations endpoint', async () => {
  const { app } = await import('../server/src/app.ts')
  const { createTeacher } = await import('../server/src/admin/store.ts')
  const { issueStaffCookie } = await import('../server/src/admin/auth.ts')
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    let cookie = ''
    issueStaffCookie({ cookie: (name: string, value: string) => (cookie = `${name}=${value}`) } as never,
      createTeacher({ name: 'Disk', email: 'disk@test.local', role: 'owner' })!)
    const resources = await (await fetch(`${origin}/api/admin/resources`, { headers: { cookie } })).json()
    assert.ok(resources.disk.data.totalBytes > 0)
    assert.equal(typeof resources.disk.data.low, 'boolean')
    const operations = await (await fetch(`${origin}/api/instance/operations`, { headers: { cookie } })).json()
    assert.deepEqual(Object.keys(operations.disk.data).sort(), ['freeBytes', 'low', 'totalBytes'])
    // Staff only, like everything else in the Resources tab.
    assert.equal((await fetch(`${origin}/api/admin/resources`)).status, 401)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
