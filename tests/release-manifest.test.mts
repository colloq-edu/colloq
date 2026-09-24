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
test('release refuses a k3s older than in-place Pod resize: the memory field would never reach a live room', () => {
  const old = release(); old.k3sVersion = 'v1.32.9+k3s1'
  const refused = run('validate', old)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /v1\.33 or newer/)
  const floor = release(); floor.k3sVersion = 'v1.33.0+k3s1'
  assert.equal(run('validate', floor).status, 0)
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
  assert.deepEqual(broker.volumes.filter((x: any) => x.persistentVolumeClaim), [
    { name: 'data', persistentVolumeClaim: { claimName: 'colloq-data' } },
  ])
  const brokerEnv = Object.fromEntries(broker.containers[0].env.map((e: any) => [e.name, e.value]))
  assert.equal(brokerEnv.RUNTIME_IMAGE_PULL_SECRET, 'colloq-registry')
  assert.equal(brokerEnv.RUNTIME_KUBE_URL, 'https://kubernetes.default.svc')
  assert.equal(brokerEnv.RUNTIME_COMPETITION_EXPORTER_IMAGE, image('c'))
  assert.equal(brokerEnv.RUNTIME_COMPETITION_DATA_CLAIM, 'colloq-data')
  assert.equal(brokerEnv.RUNTIME_COMPETITION_INSTANCE_ID, 'colloq')
  assert.ok(broker.containers[0].volumeMounts.some((mount: any) => mount.name === 'data' && mount.mountPath === '/data'))
  const brokerAuth = broker.containers[0].volumeMounts.find((v: any) => v.name === 'runtime-token')
  const projectedTokenDirectory = '/run/secrets/kubernetes.io/serviceaccount'
  assert.equal(projectedTokenDirectory.startsWith(brokerAuth.mountPath + '/'), false,
    'read-only auth mount must not shadow the service-account projection (/var/run links to /run)')
  assert.equal(brokerEnv.RUNTIME_TOKEN_FILE, `${brokerAuth.mountPath}/runtime-token`)
  // The only write beyond create/delete is the resize subresource: a live room's
  // memory is changed in place. The Pod itself (image, command, mounts) is closed to patches.
  assert.deepEqual(find('Role', 'colloq-runtime').rules, [
    { apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'create', 'delete'] },
    { apiGroups: [''], resources: ['pods/resize'], verbs: ['patch'] },
    { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    { apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['get'] },
    { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['get'] },
  ])
  assert.equal(find('PersistentVolume', 'colloq-data').spec.persistentVolumeReclaimPolicy, 'Retain')
  assert.equal(find('PersistentVolume', 'colloq-workspace').spec.local.path, '/var/lib/colloq/workspace')
  assert.equal(find('Service', 'colloq-app').spec.ports[0].nodePort, 30080)
  assert.deepEqual(find('NetworkPolicy', 'room-isolation').spec.egress, [{ to: [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
  }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }])
})
test('competition network policies isolate jobs and constrain the resolver proxy', () => {
  const rendered = run('render')
  assert.equal(rendered.status, 0, rendered.stderr)
  const items = JSON.parse(rendered.stdout).items as any[]
  const policy = (name: string) => items.find(x => x.kind === 'NetworkPolicy' && x.metadata.name === name)?.spec
  const broker = { podSelector: { matchLabels: { 'colloq.dev/role': 'runtime' } } }
  const resolver = { podSelector: { matchLabels: { 'colloq.dev/role': 'competition-resolver' } } }
  const proxy = { podSelector: { matchLabels: { 'colloq.dev/role': 'competition-proxy' } } }
  const dns = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }
  assert.deepEqual(policy('competition-job-isolation'), {
    podSelector: { matchLabels: { 'colloq.dev/role': 'competition-job' } }, policyTypes: ['Ingress', 'Egress'],
    ingress: [{ from: [broker], ports: [{ protocol: 'TCP', port: 8765 }] }], egress: [],
  })
  assert.deepEqual(policy('competition-resolver-isolation'), {
    podSelector: { matchLabels: { 'colloq.dev/role': 'competition-resolver' } }, policyTypes: ['Ingress', 'Egress'],
    ingress: [{ from: [broker], ports: [{ protocol: 'TCP', port: 8765 }] }],
    egress: [
      { to: [proxy], ports: [{ protocol: 'TCP', port: 3128 }] },
      { to: [dns], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
    ],
  })
  const proxyPolicy = policy('competition-proxy-isolation')
  assert.deepEqual(proxyPolicy.policyTypes, ['Ingress', 'Egress'])
  assert.deepEqual(proxyPolicy.ingress, [{ from: [resolver], ports: [{ protocol: 'TCP', port: 3128 }] }])
  assert.deepEqual(proxyPolicy.egress[0], { to: [dns], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] })
  assert.deepEqual(proxyPolicy.egress[1].ports, [{ protocol: 'TCP', port: 443 }])
  assert.deepEqual(proxyPolicy.egress[1].to[0].ipBlock.cidr, '0.0.0.0/0')
  assert.ok(proxyPolicy.egress[1].to[0].ipBlock.except.includes('10.0.0.0/8'))
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
/*
 * The default room memory and its ceiling belong to the operator, not to a
 * hand edit.
 *
 * Before 18 Sep 2026 the broker's Deployment did not carry
 * RUNTIME_KERNEL_MEMORY[_MAX] at all: the only way to set them was
 * `kubectl edit`, and the next update rendered the Deployment afresh and
 * silently wiped the edit. Now they travel from the same env file as the app
 * settings, and only into the broker.
 */
function withEnv(text: string, check: (file: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-env-'))
  try {
    const file = path.join(dir, 'instance.env')
    fs.writeFileSync(file, text)
    check(file)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const brokerEnv = (stdout: string) => {
  const items = JSON.parse(stdout).items as any[]
  const broker = items.find(x => x.kind === 'Deployment' && x.metadata.name === 'colloq-runtime')
  return Object.fromEntries(broker.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]))
}
test('render puts the operator memory default and ceiling into the broker and nowhere else', () => {
  withEnv('PUBLIC_URL=https://x.example\nRUNTIME_KERNEL_MEMORY=4Gi\nRUNTIME_KERNEL_MEMORY_MAX="24Gi"\nRUNTIME_KERNEL_CPU=8\nRUNTIME_NAMESPACE=evil\n', file => {
    const result = run('render', release(), ['--env-file', file])
    assert.equal(result.status, 0, result.stderr)
    const env = brokerEnv(result.stdout)
    assert.equal(env.RUNTIME_KERNEL_MEMORY, '4Gi')
    assert.equal(env.RUNTIME_KERNEL_MEMORY_MAX, '24Gi')
    // Only these two keys: the rest of the broker's settings is pinned by the installer.
    assert.equal(env.RUNTIME_KERNEL_CPU, undefined)
    assert.equal(env.RUNTIME_NAMESPACE, 'colloq')
    const app = JSON.parse(result.stdout).items.find((x: any) => x.kind === 'Deployment' && x.metadata.name === 'colloq-app')
    assert.equal(JSON.stringify(app).includes('RUNTIME_KERNEL_MEMORY'), false)
    // Nor do they end up in the app's Secret.
    const config = run('config', release(), ['--env-file', file])
    assert.equal(config.status, 0, config.stderr)
    assert.deepEqual(Object.keys(JSON.parse(config.stdout).stringData), ['PUBLIC_URL'])
  })
  // No file, or empty values: the broker's defaults, not an empty variable.
  assert.equal(brokerEnv(run('render').stdout).RUNTIME_KERNEL_MEMORY, undefined)
  withEnv('RUNTIME_KERNEL_MEMORY=\nRUNTIME_KERNEL_MEMORY_MAX=\n', file => {
    const env = brokerEnv(run('render', release(), ['--env-file', file]).stdout)
    assert.equal('RUNTIME_KERNEL_MEMORY' in env || 'RUNTIME_KERNEL_MEMORY_MAX' in env, false)
  })
})
test('render refuses memory the broker would refuse at start: bad quantity, out of bounds, default above ceiling', () => {
  for (const [text, pattern] of [
    ['RUNTIME_KERNEL_MEMORY=4G', /RUNTIME_KERNEL_MEMORY must be/],
    ['RUNTIME_KERNEL_MEMORY=4096M', /RUNTIME_KERNEL_MEMORY must be/],
    ['RUNTIME_KERNEL_MEMORY=1.5Gi', /RUNTIME_KERNEL_MEMORY must be/],
    ['RUNTIME_KERNEL_MEMORY_MAX=32Mi', /RUNTIME_KERNEL_MEMORY_MAX must be/],
    ['RUNTIME_KERNEL_MEMORY_MAX=512Gi', /RUNTIME_KERNEL_MEMORY_MAX must be/],
    ['RUNTIME_KERNEL_MEMORY=8Gi\nRUNTIME_KERNEL_MEMORY_MAX=4Gi', /exceeds RUNTIME_KERNEL_MEMORY_MAX/],
    // The broker's default is 2Gi: the broker would refuse a ceiling below it at start.
    ['RUNTIME_KERNEL_MEMORY_MAX=1Gi', /\(2Gi\) exceeds/],
  ] as const) {
    withEnv(text + '\n', file => {
      const result = run('render', release(), ['--env-file', file])
      assert.notEqual(result.status, 0, text)
      assert.match(result.stderr, pattern, text)
    })
  }
  withEnv('RUNTIME_KERNEL_MEMORY=1536Mi\nRUNTIME_KERNEL_MEMORY_MAX=1536Mi\n', file => {
    assert.equal(run('render', release(), ['--env-file', file]).status, 0)
  })
})
