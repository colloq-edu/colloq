/**
 * What the k3s release is built and probed with.
 *
 * The workflow's default environment list named cv and gpu for weeks after
 * those files were deleted (29 Sep): a default run failed in release-build.py
 * before pushing anything, and the docs repeated the same list. And the app
 * Pod's readiness asked the full health check, broker included, so a broker
 * hiccup took the only app Pod out of rotation and the site answered 502.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8')
const environments = new Set(fs.readdirSync(path.join(repo, 'kernel/environments'))
  .filter((name) => name.endsWith('.txt')).map((name) => name.slice(0, -4)))

function gpu(name: string): boolean {
  const source = read(`kernel/environments/${name}.txt`)
  if (/^#\s*colloq:\s*gpu\s*$/m.test(source)) return true
  const parent = source.match(/^#\s*colloq:\s*from\s+(\S+)\s*$/m)?.[1]
  return parent ? gpu(parent) : false
}

test('every environment in the release workflow default exists, and none needs the GPU pins', () => {
  const workflow = read('.github/workflows/release.yml')
  const input = workflow.slice(workflow.indexOf('      environments:'))
  const defaults = input.match(/^\s+default:\s*(\S+)\s*$/m)?.[1]
  assert.ok(defaults, 'the environments input has a default')
  const names = defaults.split(',').filter(Boolean)
  assert.ok(names.length > 0)
  for (const name of names) {
    assert.ok(environments.has(name), `release.yml default names ${name}, which is not in kernel/environments`)
    // A default run has no toolkit or device-plugin pins to give.
    assert.equal(gpu(name), false, `${name} is a GPU environment and cannot be in the default`)
  }
})

test('the release docs name only environments that exist', () => {
  const releasing = read('RELEASING.md')
  const row = releasing.split('\n').find((line) => line.startsWith('| `environments` |'))
  assert.ok(row, 'RELEASING.md has the environments input row')
  const guide = read('deploy/k3s/README.md')
  const flag = guide.match(/--environments\s+(\S+)/)?.[1]
  assert.ok(flag, 'the k3s guide shows the --environments flag')
  const named = [...(row.match(/`([a-z0-9,-]+)`/g) ?? []).map((m) => m.slice(1, -1)).filter((m) => m !== 'environments'), flag]
    .flatMap((list) => list.split(','))
  for (const name of named) assert.ok(environments.has(name), `a release doc names ${name}, which is not in kernel/environments`)
})

test('the app Pod is ready on its own health, lives on livez, and the k3s guide says so and is marked a preview', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-probe-'))
  try {
    const release = path.join(dir, 'release.json')
    fs.writeFileSync(release, JSON.stringify({ schemaVersion: 1, version: 'v1', sourceCommit: 'a'.repeat(40), k3sVersion: 'v1.34.1+k3s1',
      appImage: 'registry.example/app@sha256:' + 'b'.repeat(64), runtimeImage: 'registry.example/runtime@sha256:' + 'c'.repeat(64),
      dataSchemaVersion: 1, compatibleDataSchemaVersions: [1], catalog: { schemaVersion: 1, release: 'v1', defaultEnvironment: 'base',
        environments: [{ name: 'base', image: 'registry.example/kernel@sha256:' + 'd'.repeat(64), gpu: false }] } }))
    const rendered = spawnSync('python3', [path.join(repo, 'scripts/release.py'), 'render', '--release', release], { encoding: 'utf8' })
    assert.equal(rendered.status, 0, rendered.stderr)
    const items = JSON.parse(rendered.stdout).items as any[]
    const deployment = (name: string) => items.find((x) => x.kind === 'Deployment' && x.metadata.name === name).spec.template.spec
    const app = deployment('colloq-app').containers[0]
    assert.equal(app.readinessProbe.httpGet.path, '/api/readyz')
    assert.equal(app.livenessProbe.httpGet.path, '/api/livez')
    // The guide describes the broker's mounts as the manifest renders them.
    const broker = deployment('colloq-runtime')
    const claims = broker.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => v.persistentVolumeClaim.claimName)
    assert.deepEqual(claims, ['colloq-data'])
    const guide = read('deploy/k3s/README.md')
    assert.doesNotMatch(guide, /broker mounts neither PVC/i)
    assert.match(guide, /broker at `\/data`/)
    assert.match(guide, /\/api\/readyz/)
    assert.match(guide, /^> \*\*Preview\.\*\*/m)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
