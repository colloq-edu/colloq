import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRuntimeCatalog } from '../shared/runtime.js'

const script = new URL('../scripts/release.py', import.meta.url).pathname
const image = (letter: string) => `ghcr.io/example/colloq@sha256:${letter.repeat(64)}`
const release = () => ({ schemaVersion: 1, version: '0.2.0', sourceCommit: 'a'.repeat(40),
  k3sVersion: 'v1.34.1+k3s1', appImage: image('b'), runtimeImage: image('c'),
  dataSchemaVersion: 1, compatibleDataSchemaVersions: [1],
  catalog: { schemaVersion: 1, release: '0.2.0', defaultEnvironment: 'base',
    environments: [{ name: 'base', image: image('d'), gpu: false }] } })
function run(command: string, value = release(), args: string[] = [], previous?: ReturnType<typeof release>, dataRelease?: ReturnType<typeof release>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-release-'))
  try {
    const file = path.join(dir, 'release.json')
    fs.writeFileSync(file, JSON.stringify(value))
    if (previous) { fs.writeFileSync(path.join(dir, 'previous.json'), JSON.stringify(previous)); args.push('--previous', path.join(dir, 'previous.json')) }
    if (dataRelease) { fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(dataRelease)); args.push('--data-release', path.join(dir, 'data.json')) }
    return spawnSync('python3', [script, command, '--release', file, ...args], { encoding: 'utf8' })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
test('release validator accepts explicit digests and rejects mutable images and missing pins', () => {
  assert.equal(run('validate').status, 0)
  for (const field of ['appImage', 'runtimeImage', 'k3sVersion', 'sourceCommit']) {
    const value = release(); (value as any)[field] = 'latest'
    const result = run('validate', value)
    assert.notEqual(result.status, 0, field); assert.match(result.stderr, new RegExp(field))
  }
})
test('catalog rejects ambiguous defaults, duplicate current revisions, and unknown schema', () => {
  const value = release(); value.catalog.defaultEnvironment = 'absent'
  assert.notEqual(run('validate', value).status, 0)
  value.catalog.defaultEnvironment = 'base'; value.catalog.environments.push({ name: 'base', image: image('e'), gpu: false })
  assert.notEqual(run('validate', value).status, 0)
  value.schemaVersion = 2; assert.notEqual(run('validate', value).status, 0)
})
test('render confines broker privileges and isolates credentials and persistent data', () => {
  const result = run('render', release(), ['--node-name', 'test-node', '--state-dir', '/var/lib/colloq'])
  assert.equal(result.status, 0, result.stderr)
  const items = JSON.parse(result.stdout).items as any[]
  const find = (kind: string, name: string) => items.find(x => x.kind === kind && x.metadata.name === name)
  assert.equal(find('Namespace', 'colloq').metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted')
  for (const mode of ['enforce', 'audit', 'warn']) {
    assert.equal(find('Namespace', 'colloq').metadata.labels[`pod-security.kubernetes.io/${mode}-version`], 'v1.34')
  }
  const app = find('Deployment', 'colloq-app').spec
  assert.equal(app.replicas, 0); assert.equal(app.strategy.type, 'Recreate')
  assert.equal(app.template.spec.automountServiceAccountToken, false)
  assert.equal(app.template.spec.securityContext.runAsUser, 1000)
  assert.equal(app.template.spec.containers[0].livenessProbe.httpGet.path, '/api/livez')
  assert.equal(JSON.stringify(app).includes('docker.sock'), false)
  assert.equal(JSON.stringify(app).includes('room-secret'), false)
  assert.equal(JSON.stringify(app).includes('KUBE_TOKEN'), false)
  const broker = find('Deployment', 'colloq-runtime').spec.template.spec
  assert.equal(broker.serviceAccountName, 'colloq-runtime')
  assert.equal(broker.volumes.some((x: any) => x.persistentVolumeClaim), false)
  const brokerEnv = Object.fromEntries(broker.containers[0].env.map((e: any) => [e.name, e.value]))
  assert.equal(brokerEnv.RUNTIME_IMAGE_PULL_SECRET, 'colloq-registry')
  assert.equal(brokerEnv.RUNTIME_KUBE_URL, 'https://kubernetes.default.svc')
  const brokerAuth = broker.containers[0].volumeMounts.find((v: any) => v.name === 'runtime-token')
  const projectedTokenDirectory = '/run/secrets/kubernetes.io/serviceaccount'
  assert.equal(projectedTokenDirectory.startsWith(brokerAuth.mountPath + '/'), false,
    'read-only auth mount must not shadow the service-account projection (/var/run links to /run)')
  assert.equal(brokerEnv.RUNTIME_TOKEN_FILE, `${brokerAuth.mountPath}/runtime-token`)
  assert.deepEqual(find('Role', 'colloq-runtime').rules, [{ apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'create', 'delete'] }])
  assert.equal(find('PersistentVolume', 'colloq-data').spec.persistentVolumeReclaimPolicy, 'Retain')
  assert.equal(find('PersistentVolume', 'colloq-workspace').spec.local.path, '/var/lib/colloq/workspace')
  assert.equal(find('Service', 'colloq-app').spec.ports[0].nodePort, 30080)
  assert.deepEqual(find('NetworkPolicy', 'room-isolation').spec.egress, [{ to: [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
  }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }])
})
test('update catalog retains old revisions while selecting new current revision', () => {
  const previous = release(); previous.version = '0.1.0'; previous.catalog.release = '0.1.0'
  const next = release(); next.catalog.environments[0]!.image = image('e')
  const result = run('merge', next, [], previous)
  assert.equal(result.status, 0, result.stderr)
  const merged = JSON.parse(result.stdout)
  assert.equal(merged.catalog.environments.length, 2)
  assert.equal(merged.catalog.environments.find((e: any) => e.image === image('d')).current, false)
  assert.equal(merged.catalog.environments.find((e: any) => e.image === image('e')).current, true)
})
test('an image revision cannot silently change its package metadata on update', () => {
  const old = release()
  const next = release(); (next.catalog.environments[0] as any).packages = ['different==2']
  const result = run('merge', next, [], old)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /conflict.*revision|revision.*conflict/)
})
test('release catalog acceptance matches runtime bounds, fields and canonical image references', () => {
  const mutations: Array<(catalog: any) => void> = [
    c => { c.unexpected = true },
    c => { c.environments[0].unexpected = true },
    c => { c.environments[0].image = image('d').replace('@', ':latest@') },
    c => { c.environments[0].image = `ghcr.io/${'a'.repeat(500)}@sha256:${'d'.repeat(64)}` },
    c => { c.environments[0].packages = ['a'.repeat(513)] },
    c => { c.environments[0].packages = ['😀'.repeat(257)] },
    c => { c.schemaVersion = true },
    c => { c.environments[0].packages = Array(2001).fill('p') },
    c => { c.environments = Array.from({ length: 1001 }, (_, i) => ({ ...c.environments[0], name: `e${i}` })) ; c.defaultEnvironment = 'e0' },
    c => { c.environments.push({ name: 'other', image: image('e'), gpu: false, current: false }) },
    c => { c.environments[0].current = true; c.environments.push({ name: 'base', image: image('e'), gpu: false }) },
  ]
  for (const change of mutations) {
    const value = release(); change(value.catalog)
    let runtimeAccepts = true
    try { parseRuntimeCatalog(value.catalog) } catch { runtimeAccepts = false }
    const result = run('validate', value)
    assert.equal(result.status === 0, runtimeAccepts, JSON.stringify(value.catalog).slice(0, 300))
  }
  const accepted = release()
  ;(accepted.catalog.environments[0] as any).packages = Array(2000).fill('a'.repeat(512))
  assert.doesNotThrow(() => parseRuntimeCatalog(accepted.catalog))
  assert.equal(run('validate', accepted).status, 0)
})
test('merging a removed environment retains one current revision and remains runtime-compatible', () => {
  const old = release(); old.catalog.environments.push({ name: 'old-course', image: image('f'), gpu: false })
  const result = run('merge', release(), [], old)
  assert.equal(result.status, 0, result.stderr)
  const catalog = JSON.parse(result.stdout).catalog
  assert.doesNotThrow(() => parseRuntimeCatalog(catalog))
  assert.equal(catalog.environments.find((e: any) => e.name === 'old-course').current, true)
})
test('rollback rejects incompatible database schema before rendering', () => {
  const previous = release(); previous.dataSchemaVersion = 2; previous.compatibleDataSchemaVersions = [2]
  const result = run('merge', release(), ['--rollback'], previous)
  assert.notEqual(result.status, 0); assert.match(result.stderr, /schema.*backup|backup.*schema/i)
})
test('verified restored data schema replaces installed-version metadata for compatibility checks', () => {
  const installed = release(); installed.dataSchemaVersion = 2; installed.compatibleDataSchemaVersions = [2]
  const restored = release()
  const result = run('merge', release(), ['--rollback'], installed, restored)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).dataSchemaVersion, 1)
  const incompatible = run('merge', release(), ['--rollback'], restored, installed)
  assert.notEqual(incompatible.status, 0)
})
test('GPU releases require exact host tooling and render a pinned plugin and CUDA canary', () => {
  const value = release(); value.catalog.environments[0]!.gpu = true
  assert.notEqual(run('validate', value).status, 0)
  ;(value as any).tooling = { gpu: { toolkitVersion: '1.17.8-1', devicePluginImage: image('f') } }
  assert.equal(run('validate', value).status, 0)
  const result = run('gpu', value)
  assert.equal(result.status, 0, result.stderr)
  const objects = JSON.parse(result.stdout).items
  const daemon = objects.find((x: any) => x.kind === 'DaemonSet')
  assert.equal(daemon.metadata.namespace, 'kube-system')
  assert.equal(daemon.spec.template.spec.containers[0].image, image('f'))
  const canary = run('gpu-smoke', value)
  assert.equal(canary.status, 0, canary.stderr)
  const pod = JSON.parse(canary.stdout)
  assert.equal(pod.spec.automountServiceAccountToken, false)
  assert.equal(pod.spec.containers[0].resources.limits['nvidia.com/gpu'], 1)
  assert.match(pod.spec.containers[0].command.join(' '), /torch.*cuda/)
})
