import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const script = path.join(root, 'scripts/competition-k3s-smoke.mts')

test('k3d smoke dry run plans isolated names and leaves the filesystem untouched', () => {
  const run = () => spawnSync('node', ['--import', 'tsx', script, '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
  const first = run(), second = run()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  const a = JSON.parse(first.stdout), b = JSON.parse(second.stdout)
  assert.notEqual(a.cluster, b.cluster)
  assert.notEqual(a.registry, b.registry)
  assert.match(a.cluster, /^colloq-smoke-[a-f0-9]{12}$/)
  assert.match(a.registry, /^colloq-smoke-reg-[a-f0-9]{12}$/)
  assert.ok(a.fixture.startsWith(path.join(root, 'scratchpad/k3d/fixture-')))
  assert.equal(fs.existsSync(a.fixture), false)
  assert.equal(a.kubeconfig.startsWith(a.fixture + path.sep), true)
  assert.equal(JSON.stringify(a).includes('.kube/config'), false)
  assert.deepEqual(a.images, ['app', 'runtime', 'kernel-base'])
})

test('k3d smoke dry run requires explicit flag for large Kaggle image', () => {
  const result = spawnSync('node', ['--import', 'tsx', script, '--dry-run', '--json', '--include-kaggle'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.deepEqual(plan.images, ['app', 'runtime', 'kernel-base', 'kernel-kaggle-base'])
  assert.equal(fs.existsSync(plan.fixture), false)
})

test('k3d smoke accepts a named Colima profile without changing Docker context', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync('node', ['--import', 'tsx', script, '--dry-run', '--json', '--colima-profile', 'colloq-smoke'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.colimaProfile, 'colloq-smoke')
  assert.match(plan.dockerHost, /\/\.colima\/colloq-smoke\/docker\.sock$/)
  assert.equal(fs.existsSync(plan.fixture), false)
  const invalid = spawnSync('node', ['--import', 'tsx', script, '--dry-run', '--colima-profile', '../default'], { cwd: root, encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
})

test('k3d smoke rejects a Colima profile on non-macOS hosts', { skip: process.platform === 'darwin' }, () => {
  const result = spawnSync('node', ['--import', 'tsx', script, '--dry-run', '--colima-profile', 'colloq-smoke'], { cwd: root, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires a simple profile name on macOS/)
})
