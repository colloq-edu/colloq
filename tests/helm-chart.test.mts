/**
 * The Helm chart a bank's platform team deploys into one namespace of its own
 * Kubernetes (deploy/helm/colloq): restricted Pod Security, a policy engine,
 * default-deny network policies, images only from its registry, secrets from
 * Vault, ArgoCD. Everything here is checked on what `helm template` actually
 * renders, value set by value set, because that is what the platform's
 * admission controllers will see.
 *
 * Needs helm (HELM_BIN or on PATH) and skips without it. No cluster is ever
 * contacted: every helm call gets a kubeconfig of its own, which points at
 * nothing or at a fake API server in this process (for `lookup` and NOTES).
 * The rendered YAML becomes JSON through helm itself (fromYaml/toJson in a
 * throwaway chart), so the objects are parsed exactly as Kubernetes parses
 * them, without a YAML dependency.
 *
 * KUBECONFORM_BIN=<path> also validates every object against the Kubernetes
 * 1.30 schemas (downloads them, so it is opt-in).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = any
type Values = Record<string, unknown>

const CHART = fileURLToPath(new URL('../deploy/helm/colloq', import.meta.url))
const APP_VERSION = /^appVersion:\s*"?([^"\s]+)"?\s*$/m.exec(fs.readFileSync(path.join(CHART, 'Chart.yaml'), 'utf8'))![1]

function findHelm(): string | null {
  for (const bin of [process.env.HELM_BIN, 'helm']) {
    if (!bin) continue
    const probe = spawnSync(bin, ['version', '--short'], { encoding: 'utf8' })
    if (probe.status === 0) return bin
  }
  return null
}
const HELM = findHelm()
const skip = HELM ? false : 'helm is not installed (set HELM_BIN or put helm on PATH)'

const digest = (c: string) => `sha256:${c.repeat(64)}`
const KERNEL = (c: string) => `ghcr.io/colloq-edu/colloq-kernel@${digest(c)}`
/** What the release job fills in: digests and the catalog. The host keeps the default Ingress valid. */
const RELEASE: Values = {
  image: { app: { digest: digest('a') }, runtime: { digest: digest('b') } },
  catalog: {
    defaultEnvironment: 'base',
    environments: [
      { name: 'base', image: KERNEL('c'), gpu: false, packages: ['numpy', 'pandas'] },
      { name: 'kaggle-base', image: KERNEL('d'), gpu: false, packages: [] },
    ],
  },
  ingress: { host: 'colloq.example.edu' },
}

let tmp = ''
let converter = ''
let helmEnv: NodeJS.ProcessEnv = {}

function helm(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(HELM!, args, { env: { ...helmEnv, ...env }, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }))
  })
}

let files = 0
function valuesFile(values: Values): string {
  // JSON is YAML: helm reads it as a values file, nulls included.
  const file = path.join(tmp, `values-${files++}.json`)
  fs.writeFileSync(file, JSON.stringify(values))
  return file
}

interface RenderOptions { namespace?: string; release?: string; args?: string[]; env?: NodeJS.ProcessEnv; base?: Values | null }

/** helm template with the release's values under `values`; the raw YAML. */
async function template(values: Values = {}, options: RenderOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = options.base === undefined ? RELEASE : options.base
  const args = ['template', options.release ?? 'colloq', CHART, '--namespace', options.namespace ?? 'colloq', '--kube-version', '1.30.0']
  if (base) args.push('-f', valuesFile(base))
  args.push('-f', valuesFile(values), ...(options.args ?? []))
  return helm(args, options.env)
}

async function toObjects(manifest: string): Promise<Json[]> {
  const file = path.join(tmp, `manifest-${files++}.yaml`)
  fs.writeFileSync(file, manifest)
  const result = await helm(['template', 'json', converter, '--set-file', `manifest=${file}`])
  assert.equal(result.code, 0, result.stderr)
  const encoded = /^\s*json: (\S+)\s*$/m.exec(result.stdout)
  assert.ok(encoded, result.stdout)
  return JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8'))
}

async function render(values: Values = {}, options: RenderOptions = {}): Promise<Json[]> {
  const result = await template(values, options)
  assert.equal(result.code, 0, result.stderr)
  return toObjects(result.stdout)
}

async function refused(values: Values, reason: RegExp, options: RenderOptions = {}): Promise<void> {
  const result = await template(values, options)
  assert.notEqual(result.code, 0, `rendered although it should not: ${JSON.stringify(values)}`)
  assert.match(result.stderr, reason)
}

const find = (objects: Json[], kind: string, name: string): Json => objects.find((o) => o.kind === kind && o.metadata.name === name)
const deployment = (objects: Json[], name: string): Json => {
  const found = find(objects, 'Deployment', name)
  assert.ok(found, `Deployment ${name} is rendered`)
  return found
}
const container = (objects: Json[], name: string): Json => deployment(objects, name).spec.template.spec.containers[0]
const envOf = (c: Json): Record<string, any> =>
  Object.fromEntries((c.env ?? []).map((e: Json) => [e.name, e.valueFrom ?? e.value]))
const podTemplates = (objects: Json[]) => objects.filter((o) => o.kind === 'Deployment').map((o) => ({ owner: o.metadata.name, template: o.spec.template }))
const configData = (objects: Json[]): Record<string, string> => find(objects, 'ConfigMap', 'colloq-app-env').data ?? {}
const catalogOf = (objects: Json[]): Json => JSON.parse(find(objects, 'ConfigMap', 'colloq-catalog').data['catalog.json'])

/** Everything optional switched on, so every template is under the checks below. */
const EVERYTHING: Values = {
  global: { imagePullSecrets: ['harbor-pull'] },
  commonLabels: { 'bank.example/cost-centre': 'edu' },
  config: { ai: { apiKey: 'sk-test', baseUrl: 'https://llm.bank.local/v1' }, sessionSecret: 'x'.repeat(40), sso: { jwks: '{"keys": []}', audience: 'http://colloq-app.colloq.svc:3000' } },
  outbound: { httpsProxy: 'http://proxy.bank.local:3128', extraCa: { pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' } },
  dependencies: { indexUrl: 'https://nexus.bank.local/repository/pypi/simple', mirrorEgress: [{ cidrs: ['10.20.30.40/32'], ports: [443] }] },
  metrics: { enabled: true, serviceMonitor: { enabled: true } },
  networkPolicy: { kubeApiServer: { ciliumEntity: true }, app: { egress: [{ cidrs: ['10.1.2.3/32'], ports: [3128] }] } },
  rooms: { maxMemory: '32Gi', nodeSelector: { pool: 'rooms' }, priorityClassName: 'classroom' },
}

before(async () => {
  if (!HELM) return
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-helm-'))
  // Helm's own state and kubeconfig stay inside the test: never the user's cluster.
  helmEnv = {
    PATH: process.env.PATH, HOME: tmp,
    HELM_CACHE_HOME: path.join(tmp, 'cache'), HELM_CONFIG_HOME: path.join(tmp, 'config'), HELM_DATA_HOME: path.join(tmp, 'data'),
    KUBECONFIG: path.join(tmp, 'no-cluster'),
  }
  converter = path.join(tmp, 'to-json')
  fs.mkdirSync(path.join(converter, 'templates'), { recursive: true })
  fs.writeFileSync(path.join(converter, 'Chart.yaml'), 'apiVersion: v2\nname: to-json\nversion: 0.0.0\n')
  fs.writeFileSync(path.join(converter, 'templates', 'out.yaml'), [
    '{{- $docs := list -}}',
    '{{- range $raw := regexSplit "(?m)^---[ \\t]*$" .Values.manifest -1 -}}',
    '{{- $doc := fromYaml $raw -}}',
    '{{- if hasKey $doc "Error" -}}{{- fail (printf "unparseable document: %s" (get $doc "Error")) -}}{{- end -}}',
    '{{- if $doc -}}{{- $docs = append $docs $doc -}}{{- end -}}',
    '{{- end -}}',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: json',
    'data:',
    '  json: {{ toJson $docs | b64enc }}',
    '',
  ].join('\n'))
})

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/* ------------------------------------------------------------- the chart */

test('helm lint --strict passes, with the source tree values and with a release\'s', { skip }, async () => {
  for (const extra of [[], ['-f', valuesFile(RELEASE)], ['-f', valuesFile(RELEASE), '-f', valuesFile(EVERYTHING)]]) {
    const result = await helm(['lint', '--strict', CHART, ...extra])
    assert.equal(result.code, 0, result.stdout + result.stderr)
  }
})

test('the source tree carries no digests: it refuses to render and says where the published chart is', { skip }, async () => {
  const result = await template({}, { base: null, args: ['--set', 'ingress.host=colloq.example.edu'] })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /image\.app\.digest is empty.*oci:\/\/ghcr\.io\/colloq-edu\/charts\/colloq/)
  await refused({ catalog: { environments: [{ name: 'base', image: '', gpu: false }] } }, /catalog\.environments\[0\]\.image \(base\) is empty/)
  await refused({ image: { app: { digest: 'sha256:short' } } }, /image\.app\.digest|does not match pattern/)
  await refused({ catalog: { environments: [{ name: 'base', image: 'ghcr.io/colloq-edu/colloq-kernel:latest', gpu: false }] } }, /pinned by digest/)
})

test('Kubernetes 1.30 is the floor the chart declares', { skip }, async () => {
  const old = await template({}, { args: ['--kube-version', '1.29.9'] })
  assert.notEqual(old.code, 0)
  assert.match(old.stderr, /kubeVersion: >=1\.30\.0-0/)
  assert.equal((await template({}, { args: ['--kube-version', '1.34.0'] })).code, 0)
})

test('only namespaced objects, all in the release namespace: no Namespace, PV, RuntimeClass, DaemonSet, CRD or ClusterRole', { skip }, async () => {
  const namespaced = new Set(['NetworkPolicy', 'ServiceAccount', 'Secret', 'ConfigMap', 'PersistentVolumeClaim', 'Role',
    'RoleBinding', 'Service', 'Deployment', 'Ingress', 'ServiceMonitor', 'CiliumNetworkPolicy'])
  for (const values of [{}, EVERYTHING]) {
    const objects = await render(values, { namespace: 'edu-colloq' })
    for (const object of objects) {
      assert.ok(namespaced.has(object.kind), `${object.kind} ${object.metadata.name} is not an expected namespaced kind`)
      assert.equal(object.metadata.namespace, 'edu-colloq', `${object.kind} ${object.metadata.name}`)
    }
  }
})

test('every Pod template passes restricted Pod Security and the usual policy-engine rules', { skip }, async () => {
  const allowedVolumes = new Set(['configMap', 'csi', 'downwardAPI', 'emptyDir', 'ephemeral', 'persistentVolumeClaim', 'projected', 'secret'])
  for (const values of [{}, EVERYTHING]) {
    const objects = await render(values)
    const templates = podTemplates(objects)
    assert.deepEqual(templates.map((t) => t.owner).sort(), ['colloq-app', 'colloq-runtime'])
    for (const { owner, template: pod } of templates) {
      const spec = pod.spec
      for (const host of ['hostNetwork', 'hostPID', 'hostIPC']) assert.notEqual(spec[host], true, `${owner} ${host}`)
      assert.equal(spec.securityContext.runAsNonRoot, true, owner)
      assert.ok(spec.securityContext.runAsUser > 0, owner)
      assert.equal(spec.securityContext.seccompProfile.type, 'RuntimeDefault', owner)
      // The broker alone talks to the Kubernetes API.
      assert.equal(spec.automountServiceAccountToken, owner === 'colloq-runtime', owner)
      assert.equal(spec.enableServiceLinks, false, owner)
      for (const volume of spec.volumes) {
        const type = Object.keys(volume).find((key) => key !== 'name')!
        assert.ok(allowedVolumes.has(type), `${owner} volume ${volume.name}: ${type}`)
      }
      for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
        const security = c.securityContext
        assert.equal(security.allowPrivilegeEscalation, false, `${owner}/${c.name}`)
        assert.equal(security.readOnlyRootFilesystem, true, `${owner}/${c.name}`)
        assert.notEqual(security.privileged, true, `${owner}/${c.name}`)
        assert.deepEqual(security.capabilities.drop, ['ALL'], `${owner}/${c.name}`)
        assert.equal(security.capabilities.add, undefined, `${owner}/${c.name}`)
        for (const port of c.ports ?? []) assert.equal(port.hostPort, undefined, `${owner}/${c.name}`)
        for (const group of ['requests', 'limits'])
          for (const resource of ['cpu', 'memory'])
            assert.ok(c.resources?.[group]?.[resource], `${owner}/${c.name} ${group}.${resource}`)
        assert.ok(c.livenessProbe && c.readinessProbe, `${owner}/${c.name} probes`)
      }
    }
    // SQLite has one writer: one replica, never two at once.
    for (const name of ['colloq-app', 'colloq-runtime']) {
      assert.equal(deployment(objects, name).spec.replicas, 1, name)
      assert.equal(deployment(objects, name).spec.strategy.type, 'Recreate', name)
    }
    const app = container(objects, 'colloq-app')
    assert.equal(app.startupProbe.httpGet.path, '/api/livez')
    assert.equal(app.livenessProbe.httpGet.path, '/api/livez')
    assert.equal(app.readinessProbe.httpGet.path, '/api/readyz')
    const runtime = container(objects, 'colloq-runtime')
    assert.ok(runtime.livenessProbe.tcpSocket && runtime.readinessProbe.tcpSocket)
    // Every ServiceAccount is tokenless by itself; only the broker's Pod asks for one.
    for (const account of objects.filter((o) => o.kind === 'ServiceAccount'))
      assert.equal(account.automountServiceAccountToken, false, account.metadata.name)
    assert.deepEqual(objects.filter((o) => o.kind === 'ServiceAccount').map((o) => o.metadata.name).sort(),
      ['colloq-app', 'colloq-kernel', 'colloq-runtime'])
  }
})

test('standard labels on every object and Pod template; broker-created Pods get them through RUNTIME_POD_LABELS', { skip }, async () => {
  const objects = await render({ commonLabels: { 'bank.example/cost-centre': 'edu' }, rooms: { podLabels: { 'bank.example/tier': 'rooms' } } },
    { release: 'classroom' })
  const expect = (labels: Record<string, string>, where: string) => {
    assert.equal(labels['app.kubernetes.io/name'], 'colloq', where)
    assert.equal(labels['app.kubernetes.io/instance'], 'classroom', where)
    assert.equal(labels['app.kubernetes.io/version'], APP_VERSION, where)
    assert.ok(labels['app.kubernetes.io/component'], where)
    assert.equal(labels['app.kubernetes.io/part-of'], 'colloq', where)
    assert.equal(labels['app.kubernetes.io/managed-by'], 'Helm', where)
    assert.equal(labels['bank.example/cost-centre'], 'edu', where)
  }
  for (const object of objects) expect(object.metadata.labels, `${object.kind} ${object.metadata.name}`)
  for (const { owner, template: pod } of podTemplates(objects)) expect(pod.metadata.labels, `${owner} Pod template`)
  // The roles the policies and the broker's co-location select by.
  assert.equal(deployment(objects, 'colloq-app').spec.template.metadata.labels['colloq.dev/role'], 'app')
  assert.equal(deployment(objects, 'colloq-runtime').spec.template.metadata.labels['colloq.dev/role'], 'runtime')
  const podLabels: Record<string, string> = JSON.parse(envOf(container(objects, 'colloq-runtime')).RUNTIME_POD_LABELS)
  // No version there: a label that changes on every upgrade would make live rooms differ from new ones.
  assert.equal(podLabels['app.kubernetes.io/version'], undefined)
  // No instance either: ArgoCD's label tracking would prune room Pods it cannot find in Git.
  assert.equal(podLabels['app.kubernetes.io/instance'], undefined)
  assert.deepEqual(podLabels, {
    'app.kubernetes.io/name': 'colloq', 'app.kubernetes.io/part-of': 'colloq',
    'bank.example/cost-centre': 'edu', 'bank.example/tier': 'rooms',
  })
  // Selectors are the immutable part only.
  assert.deepEqual(deployment(objects, 'colloq-app').spec.selector.matchLabels, {
    'app.kubernetes.io/name': 'colloq', 'app.kubernetes.io/instance': 'classroom', 'app.kubernetes.io/component': 'app',
  })
})

test('every image is pinned by digest; global.imageRegistry rewrites all of them, the catalog kernels and the exporter included', { skip }, async () => {
  const pinned = /^[a-z0-9.:/_-]+@sha256:[a-f0-9]{64}$/
  const plain = await render({})
  assert.equal(container(plain, 'colloq-app').image, `ghcr.io/colloq-edu/colloq-app@${digest('a')}`)
  assert.equal(container(plain, 'colloq-runtime').image, `ghcr.io/colloq-edu/colloq-runtime@${digest('b')}`)

  const objects = await render({
    global: { imageRegistry: 'harbor.bank.local/ghcr' },
    catalog: {
      defaultEnvironment: 'base',
      environments: [
        { name: 'base', image: KERNEL('c'), gpu: false },
        { name: 'hub', image: `python@${digest('e')}`, gpu: false },
        { name: 'local', image: `localhost:5000/team/kernel@${digest('f')}`, gpu: false },
        { name: 'nested', image: `registry.example.com:8443/a/b/c@${digest('1')}`, gpu: false },
      ],
    },
  })
  for (const name of ['colloq-app', 'colloq-runtime']) {
    const image = container(objects, name).image
    assert.match(image, pinned)
    assert.ok(image.startsWith('harbor.bank.local/ghcr/colloq-edu/'), image)
  }
  assert.equal(container(objects, 'colloq-app').image, `harbor.bank.local/ghcr/colloq-edu/colloq-app@${digest('a')}`)
  const exporter = envOf(container(objects, 'colloq-runtime')).RUNTIME_COMPETITION_EXPORTER_IMAGE
  assert.equal(exporter, `harbor.bank.local/ghcr/colloq-edu/colloq-runtime@${digest('b')}`)
  assert.deepEqual(catalogOf(objects).environments.map((e: Json) => e.image), [
    `harbor.bank.local/ghcr/colloq-edu/colloq-kernel@${digest('c')}`,
    `harbor.bank.local/ghcr/library/python@${digest('e')}`,
    `harbor.bank.local/ghcr/team/kernel@${digest('f')}`,
    `harbor.bank.local/ghcr/a/b/c@${digest('1')}`,
  ])
  // The catalog the app and the broker read is theirs to parse: same keys, same rules.
  const catalog = catalogOf(plain)
  assert.deepEqual(Object.keys(catalog).sort(), ['defaultEnvironment', 'environments', 'release', 'schemaVersion'])
  assert.equal(catalog.release, `v${APP_VERSION}`)
  assert.deepEqual(catalog.environments[0], { name: 'base', image: KERNEL('c'), gpu: false, packages: ['numpy', 'pandas'] })
})

test('the release job can copy release.json\'s catalog in as is', { skip }, async () => {
  // The shape scripts/release-build.py writes: schemaVersion, release, and a current flag per revision.
  const catalog = {
    schemaVersion: 1, release: 'v0.9.0', defaultEnvironment: 'base',
    environments: [
      { name: 'base', image: KERNEL('c'), gpu: false, packages: ['numpy'], current: true },
      { name: 'base', image: KERNEL('e'), gpu: false, packages: ['numpy'], current: false },
      { name: 'kaggle-base', image: KERNEL('d'), gpu: false, packages: [], current: true },
    ],
  }
  const rendered = catalogOf(await render({ catalog }))
  assert.deepEqual(rendered, catalog)
})

test('pull secrets: every Pod gets all of them, the broker passes the first to the Pods it creates', { skip }, async () => {
  const objects = await render({ global: { imagePullSecrets: ['harbor-pull', { name: 'nexus-pull' }] } })
  for (const name of ['colloq-app', 'colloq-runtime'])
    assert.deepEqual(deployment(objects, name).spec.template.spec.imagePullSecrets, [{ name: 'harbor-pull' }, { name: 'nexus-pull' }])
  assert.equal(envOf(container(objects, 'colloq-runtime')).RUNTIME_IMAGE_PULL_SECRET, 'harbor-pull')
  // None configured: no field, and no empty variable (which the broker would refuse as a name).
  const none = await render({})
  assert.equal(deployment(none, 'colloq-app').spec.template.spec.imagePullSecrets, undefined)
  assert.equal('RUNTIME_IMAGE_PULL_SECRET' in envOf(container(none, 'colloq-runtime')), false)
})

/* ------------------------------------------------------------ the broker */

test('the broker\'s Role holds exactly its verbs, in-place resize only when switched on', { skip }, async () => {
  const rules = (objects: Json[]) => find(objects, 'Role', 'colloq-runtime').rules.map((r: Json) =>
    `${r.apiGroups.join(',')}|${r.resources.join(',')}|${r.verbs.join(',')}`)
  const on = await render({})
  assert.deepEqual(rules(on), [
    '|pods,services|get,list,create,delete',
    '|pods/resize|patch',
    '|persistentvolumeclaims|get',
    'networking.k8s.io|networkpolicies|get',
  ])
  assert.equal(envOf(container(on, 'colloq-runtime')).RUNTIME_IN_PLACE_RESIZE, '1')
  const off = await render({ runtime: { inPlaceResize: false } })
  assert.ok(!rules(off).some((rule: string) => rule.includes('pods/resize')))
  assert.equal(envOf(container(off, 'colloq-runtime')).RUNTIME_IN_PLACE_RESIZE, '0')
  const binding = find(on, 'RoleBinding', 'colloq-runtime')
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'colloq-runtime', namespace: 'colloq' }])
  assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'colloq-runtime' })
})

test('the broker gets every setting it reads, with the room defaults and the paths the k3s installer used', { skip }, async () => {
  const env = envOf(container(await render({}, { namespace: 'edu-colloq' }), 'colloq-runtime'))
  assert.deepEqual({
    RUNTIME_PORT: env.RUNTIME_PORT, RUNTIME_TOKEN_FILE: env.RUNTIME_TOKEN_FILE, RUNTIME_ROOM_SECRET_FILE: env.RUNTIME_ROOM_SECRET_FILE,
    RUNTIME_CATALOG_FILE: env.RUNTIME_CATALOG_FILE, RUNTIME_NAMESPACE: env.RUNTIME_NAMESPACE,
    RUNTIME_WORKSPACE_CLAIM: env.RUNTIME_WORKSPACE_CLAIM, RUNTIME_COMPETITION_DATA_CLAIM: env.RUNTIME_COMPETITION_DATA_CLAIM,
    RUNTIME_COMPETITION_INSTANCE_ID: env.RUNTIME_COMPETITION_INSTANCE_ID, RUNTIME_KUBE_URL: env.RUNTIME_KUBE_URL,
    RUNTIME_KERNEL_MEMORY: env.RUNTIME_KERNEL_MEMORY, RUNTIME_KERNEL_CPU: env.RUNTIME_KERNEL_CPU,
    RUNTIME_KERNEL_EPHEMERAL: env.RUNTIME_KERNEL_EPHEMERAL, RUNTIME_GPU_RUNTIME_CLASS: env.RUNTIME_GPU_RUNTIME_CLASS,
  }, {
    RUNTIME_PORT: '8787', RUNTIME_TOKEN_FILE: '/etc/colloq-runtime-auth/runtime-token', RUNTIME_ROOM_SECRET_FILE: '/run/room-secret/room-secret',
    RUNTIME_CATALOG_FILE: '/etc/colloq/catalog.json', RUNTIME_NAMESPACE: 'edu-colloq',
    RUNTIME_WORKSPACE_CLAIM: 'colloq-workspace', RUNTIME_COMPETITION_DATA_CLAIM: 'colloq-data',
    RUNTIME_COMPETITION_INSTANCE_ID: 'edu-colloq', RUNTIME_KUBE_URL: 'https://kubernetes.default.svc',
    // 4Gi, not the broker's own 2Gi: two gigabytes is a laptop's number, not a seminar's.
    RUNTIME_KERNEL_MEMORY: '4Gi', RUNTIME_KERNEL_CPU: '2', RUNTIME_KERNEL_EPHEMERAL: '2Gi', RUNTIME_GPU_RUNTIME_CLASS: 'nvidia',
  })
  // Empty variables would be read as unparseable numbers or names, not as defaults.
  for (const key of ['RUNTIME_KERNEL_MEMORY_MAX', 'RUNTIME_PRIORITY_CLASS', 'RUNTIME_ROOM_NODE_SELECTOR', 'RUNTIME_ROOM_TOLERATIONS',
    'RUNTIME_GPU_NODE_SELECTOR', 'RUNTIME_GPU_TOLERATIONS', 'RUNTIME_POD_ANNOTATIONS', 'DEPENDENCY_INDEX_URL'])
    assert.equal(key in env, false, key)
  // The broker never reads the database: no data volume, so a ReadWriteOnce claim does not pin it.
  const runtime = deployment(await render({}), 'colloq-runtime').spec.template.spec
  assert.ok(!runtime.volumes.some((v: Json) => v.persistentVolumeClaim), 'no claim mounted in the broker')
  // Its own token stays out of /run/secrets, where it would block the ServiceAccount token's projection.
  assert.ok(runtime.containers[0].volumeMounts.every((m: Json) => !m.mountPath.startsWith('/run/secrets') && !m.mountPath.startsWith('/var/run')))
  // A long namespace still gives a valid competition instance ID.
  const long = 'a'.repeat(38) + '-colloq-namespace'
  const id = envOf(container(await render({}, { namespace: long }), 'colloq-runtime')).RUNTIME_COMPETITION_INSTANCE_ID
  assert.match(id, /^[a-z0-9-]{1,40}$/)
})

test('rooms, GPU and placement values become the broker\'s JSON settings', { skip }, async () => {
  const objects = await render({
    rooms: {
      memory: '8Gi', cpu: '1500m', maxMemory: '48Gi', ephemeralStorage: '4Gi',
      nodeSelector: { 'node-pool': 'rooms' }, tolerations: [{ key: 'rooms', operator: 'Exists', effect: 'NoSchedule' }],
      priorityClassName: 'classroom', podAnnotations: { 'bank.example/owner': 'edu' },
    },
    gpu: { runtimeClassName: 'nvidia-cdi', nodeSelector: { 'nvidia.com/gpu.present': 'true' }, tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists' }] },
    catalog: { defaultEnvironment: 'base', environments: [
      { name: 'base', image: KERNEL('c'), gpu: false },
      { name: 'base-gpu', image: KERNEL('e'), gpu: true, packages: ['torch'] },
    ] },
  })
  const env = envOf(container(objects, 'colloq-runtime'))
  assert.equal(env.RUNTIME_KERNEL_MEMORY, '8Gi')
  assert.equal(env.RUNTIME_KERNEL_CPU, '1500m')
  assert.equal(env.RUNTIME_KERNEL_MEMORY_MAX, '48Gi')
  assert.equal(env.RUNTIME_KERNEL_EPHEMERAL, '4Gi')
  assert.deepEqual(JSON.parse(env.RUNTIME_ROOM_NODE_SELECTOR), { 'node-pool': 'rooms' })
  assert.deepEqual(JSON.parse(env.RUNTIME_ROOM_TOLERATIONS), [{ key: 'rooms', operator: 'Exists', effect: 'NoSchedule' }])
  assert.equal(env.RUNTIME_PRIORITY_CLASS, 'classroom')
  assert.deepEqual(JSON.parse(env.RUNTIME_POD_ANNOTATIONS), { 'bank.example/owner': 'edu' })
  assert.equal(env.RUNTIME_GPU_RUNTIME_CLASS, 'nvidia-cdi')
  assert.deepEqual(JSON.parse(env.RUNTIME_GPU_NODE_SELECTOR), { 'nvidia.com/gpu.present': 'true' })
  assert.deepEqual(JSON.parse(env.RUNTIME_GPU_TOLERATIONS), [{ key: 'nvidia.com/gpu', operator: 'Exists' }])
  assert.equal(catalogOf(objects).environments[1].gpu, true)
  // An empty runtime class is a setting of its own (none), so it is passed, not dropped.
  const none = envOf(container(await render({ gpu: { runtimeClassName: '' } }), 'colloq-runtime'))
  assert.equal(none.RUNTIME_GPU_RUNTIME_CLASS, '')
  // A number is a quantity too.
  assert.equal(envOf(container(await render({ rooms: { cpu: 4 } }), 'colloq-runtime')).RUNTIME_KERNEL_CPU, '4')
})

/* --------------------------------------------------------------- storage */

test('ReadWriteOnce storage co-locates the broker\'s Pods with the app; ReadWriteMany does not', { skip }, async () => {
  const colocate = (objects: Json[]) => envOf(container(objects, 'colloq-runtime')).RUNTIME_COLOCATE_WITH_APP
  const modes = (objects: Json[]) => objects.filter((o) => o.kind === 'PersistentVolumeClaim').map((o) => `${o.metadata.name}:${o.spec.accessModes.join(',')}`).sort()

  const rwo = await render({})
  assert.equal(colocate(rwo), '1')
  assert.deepEqual(modes(rwo), ['colloq-data:ReadWriteOnce', 'colloq-workspace:ReadWriteOnce'])
  // The app prefers the node where rooms run: their attachment of the volume is what a new app Pod needs.
  const affinity = deployment(rwo, 'colloq-app').spec.template.spec.affinity.podAffinity.preferredDuringSchedulingIgnoredDuringExecution[0]
  assert.equal(affinity.podAffinityTerm.topologyKey, 'kubernetes.io/hostname')
  assert.deepEqual(affinity.podAffinityTerm.labelSelector.matchExpressions[0].values, ['kernel', 'own', 'competition-job', 'competition-resolver'])

  const rwx = await render({ persistence: { accessMode: 'ReadWriteMany', storageClass: 'cephfs' } })
  assert.equal(colocate(rwx), '0')
  assert.deepEqual(modes(rwx), ['colloq-data:ReadWriteMany', 'colloq-workspace:ReadWriteMany'])
  assert.equal(deployment(rwx, 'colloq-app').spec.template.spec.affinity, undefined)
  for (const claim of rwx.filter((o) => o.kind === 'PersistentVolumeClaim')) assert.equal(claim.spec.storageClassName, 'cephfs')

  // One ReadWriteOnce volume is enough: competition jobs mount the data, rooms the workspace.
  const mixed = await render({ persistence: { accessMode: 'ReadWriteMany', data: { accessMode: 'ReadWriteOnce', storageClass: 'rbd' } } })
  assert.equal(colocate(mixed), '1')
  assert.deepEqual(modes(mixed), ['colloq-data:ReadWriteOnce', 'colloq-workspace:ReadWriteMany'])
  assert.equal(find(mixed, 'PersistentVolumeClaim', 'colloq-data').spec.storageClassName, 'rbd')

  // An explicit affinity replaces the chart's.
  const own = await render({ app: { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'pool', operator: 'In', values: ['colloq'] }] }] } } } } })
  assert.ok(deployment(own, 'colloq-app').spec.template.spec.affinity.nodeAffinity)
  assert.equal(deployment(own, 'colloq-app').spec.template.spec.affinity.podAffinity, undefined)
})

test('claims: sizes, storage classes, existing claims, and kept on uninstall', { skip }, async () => {
  const objects = await render({ persistence: { storageClass: '-', data: { size: '20Gi' }, workspace: { existingClaim: 'rooms-nfs', accessMode: 'ReadWriteMany' } } })
  const data = find(objects, 'PersistentVolumeClaim', 'colloq-data')
  assert.equal(data.spec.resources.requests.storage, '20Gi')
  assert.equal(data.spec.storageClassName, '', '"-" means no class')
  assert.equal(data.metadata.annotations['helm.sh/resource-policy'], 'keep')
  assert.equal(data.metadata.annotations['argocd.argoproj.io/sync-options'], 'Prune=false,Delete=false')
  assert.equal(find(objects, 'PersistentVolumeClaim', 'colloq-workspace'), undefined)
  const app = deployment(objects, 'colloq-app').spec.template.spec
  assert.equal(app.volumes.find((v: Json) => v.name === 'workspace').persistentVolumeClaim.claimName, 'rooms-nfs')
  assert.equal(app.volumes.find((v: Json) => v.name === 'data').persistentVolumeClaim.claimName, 'colloq-data')
  const env = envOf(container(objects, 'colloq-runtime'))
  assert.equal(env.RUNTIME_WORKSPACE_CLAIM, 'rooms-nfs')
  assert.equal(env.RUNTIME_COLOCATE_WITH_APP, '1', 'the data claim is still ReadWriteOnce')
  const released = await render({ persistence: { retain: false } })
  assert.equal(find(released, 'PersistentVolumeClaim', 'colloq-data').metadata.annotations, undefined)
  const plain = find(await render({}), 'PersistentVolumeClaim', 'colloq-workspace')
  assert.equal(plain.spec.storageClassName, undefined, 'empty: the cluster default')
  assert.equal(plain.spec.resources.requests.storage, '100Gi')
})

/* --------------------------------------------------------------- secrets */

test('existing secrets are referenced, never rendered', { skip }, async () => {
  const objects = await render({
    config: { existingSecret: 'vault-colloq' },
    secrets: {
      runtimeToken: { existingSecret: 'vault-runtime', existingSecretKey: 'token' },
      roomSecret: { existingSecret: 'vault-rooms', existingSecretKey: 'key' },
    },
    metrics: { enabled: true, existingSecret: 'vault-metrics', existingSecretKey: 'bearer', serviceMonitor: { enabled: true } },
  })
  assert.deepEqual(objects.filter((o) => o.kind === 'Secret'), [], 'the chart renders no Secret at all')
  const app = deployment(objects, 'colloq-app').spec.template.spec
  const runtime = deployment(objects, 'colloq-runtime').spec.template.spec
  const volume = (spec: Json, name: string) => spec.volumes.find((v: Json) => v.name === name)?.secret
  assert.deepEqual(volume(app, 'runtime-token'), { secretName: 'vault-runtime', defaultMode: 288, items: [{ key: 'token', path: 'runtime-token' }] })
  assert.deepEqual(volume(runtime, 'runtime-token'), volume(app, 'runtime-token'))
  assert.deepEqual(volume(runtime, 'room-secret'), { secretName: 'vault-rooms', defaultMode: 288, items: [{ key: 'key', path: 'room-secret' }] })
  // The app never sees the key room tokens come from.
  assert.equal(volume(app, 'room-secret'), undefined)
  assert.deepEqual(app.containers[0].envFrom, [{ configMapRef: { name: 'colloq-app-env' } }, { secretRef: { name: 'vault-colloq' } }])
  assert.deepEqual(envOf(app.containers[0]).METRICS_TOKEN, { secretKeyRef: { name: 'vault-metrics', key: 'bearer' } })
  assert.deepEqual(find(objects, 'ServiceMonitor', 'colloq-app').spec.endpoints[0].authorization,
    { type: 'Bearer', credentials: { name: 'vault-metrics', key: 'bearer' } })
})

test('generated secrets are read back from the live Secret, so an upgrade never re-randomises them', { skip }, async () => {
  const fresh = await render({})
  const token = (objects: Json[], name: string, key: string) => Buffer.from(find(objects, 'Secret', name).data[key], 'base64').toString()
  assert.match(token(fresh, 'colloq-runtime-auth', 'runtime-token'), /^[A-Za-z0-9]{64}$/)
  assert.match(token(fresh, 'colloq-room-secret', 'room-secret'), /^[A-Za-z0-9]{64}$/)
  // Without a cluster (ArgoCD renders like this) there is nothing to read back: a new value every time.
  assert.notEqual(token(fresh, 'colloq-runtime-auth', 'runtime-token'), token(await render({}), 'colloq-runtime-auth', 'runtime-token'))

  const live = { runtime: 'r'.repeat(20) + 'LiveRuntimeToken0123456789abcdefgh', room: 'LiveRoomSecret-0123456789_abcdefghijklmnopqrstu' }
  await withFakeCluster({
    'colloq-runtime-auth': { 'runtime-token': Buffer.from(live.runtime).toString('base64') },
    'colloq-room-secret': { 'room-secret': Buffer.from(live.room).toString('base64') },
  }, async (env) => {
    for (let round = 0; round < 2; round++) {
      const objects = await render({ metrics: { enabled: true } }, { args: ['--dry-run=server'], env })
      assert.equal(token(objects, 'colloq-runtime-auth', 'runtime-token'), live.runtime)
      assert.equal(token(objects, 'colloq-room-secret', 'room-secret'), live.room)
      // The metrics Secret does not exist yet: generated now, read back from the next upgrade on.
      assert.match(token(objects, 'colloq-metrics', 'metrics-token'), /^[A-Za-z0-9]{64}$/)
    }
  })
  // An explicit value (e.g. from argocd-vault-plugin) is taken as is.
  const explicit = 'Explicit-Value_0123456789abcdefghijklmnopqrstuv'
  assert.equal(token(await render({ secrets: { roomSecret: { value: explicit } } }), 'colloq-room-secret', 'room-secret'), explicit)
})

test('a helm upgrade keeps the previous release\'s kernel revisions, not current, so pinned rooms keep their Python', { skip }, async () => {
  const catalogOf = (objects: Json[]) => JSON.parse(find(objects, 'ConfigMap', 'colloq-catalog').data['catalog.json'])
  const old = (digit: string) => `ghcr.io/colloq-edu/colloq-kernel@sha256:${digit.repeat(64)}`
  const live = { schemaVersion: 1, release: 'v0.9.0', defaultEnvironment: 'base', environments: [
    { name: 'base', image: old('1'), gpu: false, packages: [] },
    { name: 'base', image: old('2'), gpu: false, packages: [], current: false },
    { name: 'retired', image: old('3'), gpu: false, packages: [] },
  ] }
  await withFakeCluster({}, async (env) => {
    const catalog = catalogOf(await render({}, { args: ['--dry-run=server'], env }))
    const base = catalog.environments.filter((e: Json) => e.name === 'base')
    assert.equal(base.filter((e: Json) => e.current === true).length, 1, 'exactly one current base: this release\'s')
    assert.ok(base.some((e: Json) => e.image === old('1') && e.current === false), 'the previous release\'s base stays, not current')
    assert.ok(base.some((e: Json) => e.image === old('2') && e.current === false))
    assert.equal(catalog.environments.some((e: Json) => e.name === 'retired'), false, 'a name this release no longer ships is not kept')
    const bounded = catalogOf(await render({ catalog: { maxRetainedPerEnvironment: 1 } }, { args: ['--dry-run=server'], env }))
    assert.equal(bounded.environments.filter((e: Json) => e.name === 'base' && e.current === false).length, 1)
    const off = catalogOf(await render({ catalog: { retainPrevious: false } }, { args: ['--dry-run=server'], env }))
    assert.equal(off.environments.some((e: Json) => e.image === old('1')), false)
  }, { 'colloq-catalog': { 'catalog.json': JSON.stringify(live) } })
  // Without a cluster (ArgoCD) there is nothing to keep, and the render is the release's own.
  assert.equal(catalogOf(await render({})).environments.some((e: Json) => e.image === old('1')), false)
})

test('app settings reach the app under the documented variable names', { skip }, async () => {
  const objects = await render({
    config: {
      publicUrl: 'https://classes.bank.local/', uiLanguage: 'en', timezone: 'Europe/Moscow', institution: 'T-Bank University',
      adminEmail: 'owner@bank.local', openSeminarCreation: true, maxUploadMb: 100, maxSessionMb: 2048, councilCopyMb: 256,
      councilMemoryGuard: false, logFormat: 'json', dbSnapshotHours: 6, dbSnapshotKeep: 14, sessionSecret: 's'.repeat(40),
      ai: { provider: 'openai', apiKey: 'sk-internal', baseUrl: 'https://llm.bank.local/v1', model: 'qwen', reasoning: true },
      inbound: { trustedProxies: '10.0.0.0/8', sharedAddresses: '198.51.100.7', trustCfConnectingIp: true, hsts: false },
      extraEnv: { COMPETITION_SLOTS: '8', PUBLIC_URL: 'https://ignored.example' },
    },
    outbound: { httpsProxy: 'http://proxy.bank.local:3128', httpProxy: 'http://proxy.bank.local:3128', noProxy: '.bank.local' },
  })
  assert.deepEqual(configData(objects), {
    PUBLIC_URL: 'https://classes.bank.local', UI_LANGUAGE: 'en', TZ: 'Europe/Moscow', INSTITUTION: 'T-Bank University',
    ADMIN_EMAIL: 'owner@bank.local', OPEN_SEMINAR_CREATION: 'true', MAX_UPLOAD_MB: '100', MAX_SESSION_MB: '2048',
    COUNCIL_COPY_MB: '256', COUNCIL_MEMORY_GUARD: '0', LOG_FORMAT: 'json', DB_SNAPSHOT_HOURS: '6', DB_SNAPSHOT_KEEP: '14',
    AI_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://llm.bank.local/v1', OPENAI_MODEL: 'qwen', AI_REASONING: 'true',
    TRUSTED_PROXIES: '10.0.0.0/8', SHARED_ADDRESSES: '198.51.100.7', TRUST_CF_CONNECTING_IP: '1', HSTS: '0',
    HTTPS_PROXY: 'http://proxy.bank.local:3128', https_proxy: 'http://proxy.bank.local:3128',
    HTTP_PROXY: 'http://proxy.bank.local:3128', http_proxy: 'http://proxy.bank.local:3128',
    NO_PROXY: '.bank.local', no_proxy: '.bank.local', COMPETITION_SLOTS: '8',
  })
  const secret = find(objects, 'Secret', 'colloq-app-config')
  assert.deepEqual(Object.fromEntries(Object.entries(secret.data).map(([k, v]) => [k, Buffer.from(String(v), 'base64').toString()])),
    { OPENAI_API_KEY: 'sk-internal', SESSION_SECRET: 's'.repeat(40) })
  // The Secret comes after the ConfigMap: a key in both is the Secret's.
  assert.deepEqual(container(objects, 'colloq-app').envFrom, [{ configMapRef: { name: 'colloq-app-env' } }, { secretRef: { name: 'colloq-app-config' } }])

  const defaults = await render({})
  assert.deepEqual(configData(defaults), {
    PUBLIC_URL: 'https://colloq.example.edu', OPEN_SEMINAR_CREATION: 'false', MAX_UPLOAD_MB: '50', MAX_SESSION_MB: '1024',
    COUNCIL_COPY_MB: '512', COUNCIL_MEMORY_GUARD: '1', DB_SNAPSHOT_HOURS: '24', DB_SNAPSHOT_KEEP: '7', AI_PROVIDER: 'openai',
    AI_REASONING: 'false', TRUSTED_PROXIES: 'private', TRUST_CF_CONNECTING_IP: '0', HSTS: '1',
  })
  // No secret settings: no Secret, and no reference to one.
  assert.equal(find(defaults, 'Secret', 'colloq-app-config'), undefined)
  assert.deepEqual(container(defaults, 'colloq-app').envFrom, [{ configMapRef: { name: 'colloq-app-env' } }])
  const env = envOf(container(defaults, 'colloq-app'))
  assert.equal(env.KERNEL_BACKEND, 'broker')
  assert.equal(env.KERNEL_RUNTIME_URL, 'http://colloq-runtime.colloq.svc:8787')
  assert.equal(env.KERNEL_RUNTIME_TOKEN_FILE, '/run/secrets/runtime-token')
  assert.equal(env.KERNEL_CATALOG_FILE, '/etc/colloq/catalog.json')
  assert.equal(env.NODE_ENV, 'production')
  assert.equal('METRICS_TOKEN' in env, false)
})

test('outbound: the CA inline or from a ConfigMap, the mirror for the app, the broker and the proxy policy', { skip }, async () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIBbankCA\n-----END CERTIFICATE-----\n'
  const inline = await render({ outbound: { extraCa: { pem } } })
  assert.equal(find(inline, 'ConfigMap', 'colloq-extra-ca').data['extra-ca.pem'], pem)
  const app = deployment(inline, 'colloq-app').spec.template.spec
  assert.equal(envOf(app.containers[0]).NODE_EXTRA_CA_CERTS, '/etc/colloq-ca/extra-ca.pem')
  assert.deepEqual(app.containers[0].volumeMounts.find((m: Json) => m.name === 'extra-ca'), { name: 'extra-ca', mountPath: '/etc/colloq-ca', readOnly: true })
  assert.deepEqual(app.volumes.find((v: Json) => v.name === 'extra-ca').configMap, { name: 'colloq-extra-ca', items: [{ key: 'extra-ca.pem', path: 'extra-ca.pem' }] })

  const existing = await render({ outbound: { extraCa: { existingConfigMap: 'bank-root-ca', key: 'ca.crt' } } })
  assert.equal(find(existing, 'ConfigMap', 'colloq-extra-ca'), undefined)
  assert.deepEqual(deployment(existing, 'colloq-app').spec.template.spec.volumes.find((v: Json) => v.name === 'extra-ca').configMap,
    { name: 'bank-root-ca', items: [{ key: 'ca.crt', path: 'extra-ca.pem' }] })
  const none = await render({})
  assert.equal('NODE_EXTRA_CA_CERTS' in envOf(container(none, 'colloq-app')), false)

  const mirror = await render({ dependencies: {
    indexUrl: 'https://nexus.bank.local:8443/repository/pypi/simple', filesHosts: 'files.bank.local, 10.9.8.7:8443',
    mirrorEgress: [{ cidrs: ['10.20.30.40/32', '10.20.30.41/32'], ports: [8443] }, { cidrs: ['10.9.8.7/32'], ports: [8443, 443] }],
    publicEgress: false,
  } })
  for (const name of ['colloq-app', 'colloq-runtime']) {
    const env = envOf(container(mirror, name))
    assert.equal(env.DEPENDENCY_INDEX_URL, 'https://nexus.bank.local:8443/repository/pypi/simple', name)
    assert.equal(env.DEPENDENCY_FILES_HOSTS, 'files.bank.local, 10.9.8.7:8443', name)
  }
  const egress = find(mirror, 'NetworkPolicy', 'competition-proxy-isolation').spec.egress
  assert.equal(egress.length, 3, 'DNS and the two mirror rules; no public rule')
  assert.deepEqual(egress.slice(1), [
    { to: [{ ipBlock: { cidr: '10.20.30.40/32' } }, { ipBlock: { cidr: '10.20.30.41/32' } }], ports: [{ port: 8443, protocol: 'TCP' }] },
    { to: [{ ipBlock: { cidr: '10.9.8.7/32' } }], ports: [{ port: 8443, protocol: 'TCP' }, { port: 443, protocol: 'TCP' }] },
  ])
  // By default the proxy keeps the k3s installer's rule: public IPv4 on 443.
  const general = find(none, 'NetworkPolicy', 'competition-proxy-isolation').spec.egress[1]
  assert.equal(general.to[0].ipBlock.cidr, '0.0.0.0/0')
  assert.ok(general.to[0].ipBlock.except.includes('10.0.0.0/8') && general.to[0].ipBlock.except.includes('169.254.0.0/16'))
  assert.deepEqual(general.ports, [{ protocol: 'TCP', port: 443 }])
})

/* ------------------------------------------------------ ingress, metrics */

test('ingress: what ingress-nginx needs, TLS from a Secret or cert-manager, and a Service-only mode', { skip }, async () => {
  const objects = await render({})
  const ingress = find(objects, 'Ingress', 'colloq-app')
  assert.deepEqual(ingress.metadata.annotations, {
    'nginx.ingress.kubernetes.io/proxy-body-size': '256m',
    'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
    'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600',
    'nginx.ingress.kubernetes.io/proxy-buffering': 'off',
  })
  assert.equal(ingress.spec.ingressClassName, 'nginx')
  assert.deepEqual(ingress.spec.tls, [{ hosts: ['colloq.example.edu'], secretName: 'colloq-tls' }])
  assert.deepEqual(ingress.spec.rules[0], { host: 'colloq.example.edu', http: { paths: [{ path: '/', pathType: 'Prefix',
    backend: { service: { name: 'colloq-app', port: { name: 'http' } } } }] } })
  assert.equal(find(objects, 'Service', 'colloq-app').spec.ports[0].port, 3000)

  const managed = await render({ ingress: { className: 'corp-nginx', annotations: { 'nginx.ingress.kubernetes.io/proxy-buffering': null, 'example/extra': 'yes' },
    tls: { secretName: 'corp-cert', certManager: { clusterIssuer: 'corp-ca' } } } })
  const annotations = find(managed, 'Ingress', 'colloq-app').metadata.annotations
  assert.equal(annotations['cert-manager.io/cluster-issuer'], 'corp-ca')
  assert.equal(annotations['example/extra'], 'yes')
  assert.equal('nginx.ingress.kubernetes.io/proxy-buffering' in annotations, false, 'null drops a default')
  assert.equal(find(managed, 'Ingress', 'colloq-app').spec.tls[0].secretName, 'corp-cert')
  assert.equal(find(managed, 'Ingress', 'colloq-app').spec.ingressClassName, 'corp-nginx')

  const plainHttp = await render({ ingress: { tls: { enabled: false } } })
  assert.equal(find(plainHttp, 'Ingress', 'colloq-app').spec.tls, undefined)
  assert.equal(configData(plainHttp).PUBLIC_URL, 'http://colloq.example.edu')

  const serviceOnly = await render({ ingress: { enabled: false, host: '' } })
  assert.equal(find(serviceOnly, 'Ingress', 'colloq-app'), undefined)
  assert.ok(find(serviceOnly, 'Service', 'colloq-app'))
  assert.equal('PUBLIC_URL' in configData(serviceOnly), false)
  const behindOwnProxy = await render({ ingress: { enabled: false }, config: { publicUrl: 'https://colloq.bank.local' } })
  assert.equal(configData(behindOwnProxy).PUBLIC_URL, 'https://colloq.bank.local')
})

test('metrics: a token Secret for the app and a ServiceMonitor that scrapes with it', { skip }, async () => {
  const objects = await render({ metrics: { enabled: true, serviceMonitor: { enabled: true, labels: { release: 'kube-prometheus-stack' } } } })
  assert.ok(find(objects, 'Secret', 'colloq-metrics').data['metrics-token'])
  assert.deepEqual(envOf(container(objects, 'colloq-app')).METRICS_TOKEN, { secretKeyRef: { name: 'colloq-metrics', key: 'metrics-token' } })
  const monitor = find(objects, 'ServiceMonitor', 'colloq-app')
  assert.equal(monitor.metadata.labels.release, 'kube-prometheus-stack')
  assert.deepEqual(monitor.spec.selector.matchLabels, { 'app.kubernetes.io/name': 'colloq', 'app.kubernetes.io/instance': 'colloq', 'app.kubernetes.io/component': 'app' })
  assert.deepEqual(monitor.spec.endpoints[0], { port: 'http', path: '/metrics', interval: '30s', scrapeTimeout: '10s',
    authorization: { type: 'Bearer', credentials: { name: 'colloq-metrics', key: 'metrics-token' } } })
  const off = await render({})
  assert.equal(find(off, 'ServiceMonitor', 'colloq-app'), undefined)
  assert.equal(find(off, 'Secret', 'colloq-metrics'), undefined)
  const explicit = await render({ metrics: { enabled: true, token: 'metrics-token-0123456789' } })
  assert.equal(Buffer.from(find(explicit, 'Secret', 'colloq-metrics').data['metrics-token'], 'base64').toString(), 'metrics-token-0123456789')
})

/* -------------------------------------------------------- network policy */

interface Pod { kind: 'pod'; name: string; namespace: string; nsLabels: Record<string, string>; labels: Record<string, string> }
interface Address { kind: 'ip'; name: string; ip: string }
type Endpoint = Pod | Address

function selects(selector: Json, labels: Record<string, string>): boolean {
  if (!selector) return true
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) if (labels[key] !== value) return false
  for (const expression of selector.matchExpressions ?? []) {
    const has = expression.key in labels
    const value = labels[expression.key]
    if (expression.operator === 'In' && !(has && expression.values.includes(value))) return false
    if (expression.operator === 'NotIn' && has && expression.values.includes(value)) return false
    if (expression.operator === 'Exists' && !has) return false
    if (expression.operator === 'DoesNotExist' && has) return false
  }
  return true
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/')
  if (base.includes(':') || ip.includes(':')) return base.includes(':') && ip.includes(':') && Number(bits) === 0
  const number = (text: string) => text.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return ((number(ip) & mask) >>> 0) === ((number(base) & mask) >>> 0)
}

function peerMatches(peer: Json, target: Endpoint, policyNamespace: string): boolean {
  if (target.kind === 'ip') {
    if (!peer.ipBlock) return false
    return inCidr(target.ip, peer.ipBlock.cidr) && !(peer.ipBlock.except ?? []).some((cidr: string) => inCidr(target.ip, cidr))
  }
  if (peer.ipBlock) return false
  if (peer.namespaceSelector) return selects(peer.namespaceSelector, target.nsLabels) && selects(peer.podSelector, target.labels)
  return target.namespace === policyNamespace && selects(peer.podSelector, target.labels)
}

const portMatches = (ports: Json[] | undefined, port: number, protocol: string) =>
  !ports || ports.length === 0 || ports.some((p) => (p.protocol ?? 'TCP') === protocol && (p.port === undefined || p.port === port))

/**
 * Kubernetes NetworkPolicy semantics in a namespace whose default is deny:
 * a flow passes only if a policy selecting the source allows it out and a
 * policy selecting the destination allows it in. Ends outside the namespace
 * are the platform's business, so only our side is checked there.
 */
function allowed(policies: Json[], namespace: string, from: Endpoint, to: Endpoint, port: number, protocol = 'TCP'): boolean {
  const ours = (e: Endpoint): e is Pod => e.kind === 'pod' && e.namespace === namespace
  const side = (pod: Pod, type: 'Egress' | 'Ingress', other: Endpoint) => {
    const selecting = policies.filter((p) => p.spec.policyTypes.includes(type) && selects(p.spec.podSelector, pod.labels))
    return selecting.some((p) => ((type === 'Egress' ? p.spec.egress : p.spec.ingress) ?? []).some((rule: Json) => {
      const peers = type === 'Egress' ? rule.to : rule.from
      return (!peers || peers.length === 0 || peers.some((peer: Json) => peerMatches(peer, other, namespace))) && portMatches(rule.ports, port, protocol)
    }))
  }
  return (!ours(from) || side(from, 'Egress', to)) && (!ours(to) || side(to, 'Ingress', from))
}

function world(objects: Json[], namespace = 'colloq') {
  const nsLabels = { 'kubernetes.io/metadata.name': namespace }
  const podLabels = JSON.parse(envOf(container(objects, 'colloq-runtime')).RUNTIME_POD_LABELS)
  const pod = (name: string, labels: Record<string, string>): Pod => ({ kind: 'pod', name, namespace, nsLabels, labels })
  const broker = (role: string, extra: Record<string, string> = {}) =>
    pod(role, { ...podLabels, 'app.kubernetes.io/managed-by': 'colloq-runtime', 'colloq.dev/role': role, ...extra })
  const elsewhere = (name: string, ns: string, labels: Record<string, string>): Pod =>
    ({ kind: 'pod', name, namespace: ns, nsLabels: { 'kubernetes.io/metadata.name': ns }, labels })
  return {
    app: pod('app', deployment(objects, 'colloq-app').spec.template.metadata.labels),
    runtime: pod('runtime', deployment(objects, 'colloq-runtime').spec.template.metadata.labels),
    room: broker('kernel', { 'colloq.kind': 'room-kernel', 'colloq.dev/session': 'abc' }),
    own: broker('own'),
    job: broker('competition-job', { 'colloq.dev/job': 'j1', 'colloq.dev/instance': namespace }),
    resolver: broker('competition-resolver', { 'colloq.dev/job': 'j2', 'colloq.dev/instance': namespace }),
    proxy: broker('competition-proxy', { 'colloq.dev/job': 'j2', 'colloq.dev/instance': namespace }),
    stranger: pod('stranger', { app: 'something-else' }),
    ingress: elsewhere('ingress-nginx', 'ingress-nginx', { 'app.kubernetes.io/name': 'ingress-nginx' }),
    otherIngress: elsewhere('traefik', 'kube-system', { 'app.kubernetes.io/name': 'traefik' }),
    dns: elsewhere('coredns', 'kube-system', { 'k8s-app': 'kube-dns' }),
    prometheus: elsewhere('prometheus', 'monitoring', { 'app.kubernetes.io/name': 'prometheus' }),
    apiServer: { kind: 'ip', name: 'api', ip: '10.0.0.1' } as Address,
    internet: { kind: 'ip', name: 'internet', ip: '93.184.216.34' } as Address,
    campus: { kind: 'ip', name: 'campus', ip: '10.20.30.40' } as Address,
    metadata: { kind: 'ip', name: 'metadata', ip: '169.254.169.254' } as Address,
  }
}

test('network policies admit exactly the flows Colloq needs, in a namespace whose default is deny', { skip }, async () => {
  const objects = await render({ metrics: { enabled: true }, dependencies: { mirrorEgress: [{ cidrs: ['10.20.30.40/32'], ports: [8443] }] } })
  const policies = objects.filter((o) => o.kind === 'NetworkPolicy')
  const w = world(objects)
  const can = (from: Endpoint, to: Endpoint, port: number, protocol = 'TCP') => allowed(policies, 'colloq', from, to, port, protocol)
  const needed: Array<[Endpoint, Endpoint, number, string?]> = [
    [w.ingress, w.app, 3000], [w.prometheus, w.app, 3000],
    [w.app, w.runtime, 8787], [w.app, w.room, 8888], [w.app, w.own, 8888],
    [w.runtime, w.room, 8888], [w.runtime, w.own, 8888], [w.runtime, w.job, 8765], [w.runtime, w.resolver, 8765],
    [w.runtime, w.apiServer, 443], [w.runtime, w.apiServer, 6443],
    [w.resolver, w.proxy, 3128], [w.proxy, w.internet, 443], [w.proxy, w.campus, 8443],
  ]
  for (const who of [w.app, w.runtime, w.room, w.own, w.resolver, w.proxy])
    needed.push([who, w.dns, 53, 'UDP'], [who, w.dns, 53, 'TCP'])
  for (const [from, to, port, protocol] of needed)
    assert.ok(can(from, to, port, protocol), `${from.name} -> ${to.name}:${port}/${protocol ?? 'TCP'} must pass`)
  const refused: Array<[Endpoint, Endpoint, number, string?]> = [
    // Student code reaches nobody.
    [w.room, w.app, 3000], [w.room, w.runtime, 8787], [w.room, w.room, 8888], [w.room, w.own, 8888], [w.own, w.room, 8888],
    [w.room, w.internet, 443], [w.room, w.metadata, 80], [w.room, w.apiServer, 443], [w.room, w.proxy, 3128],
    // Submissions not even DNS.
    [w.job, w.dns, 53, 'UDP'], [w.job, w.internet, 443], [w.job, w.app, 3000], [w.job, w.proxy, 3128],
    [w.resolver, w.internet, 443], [w.proxy, w.campus, 443], [w.proxy, w.metadata, 80], [w.proxy, w.room, 8888],
    // Only the ingress controller (and the scraper) reach the app; only the app the broker.
    [w.otherIngress, w.app, 3000], [w.stranger, w.app, 3000], [w.stranger, w.runtime, 8787], [w.stranger, w.room, 8888],
    [w.ingress, w.runtime, 8787], [w.ingress, w.room, 8888], [w.room, w.job, 8765], [w.app, w.job, 8765],
    // The app leaves the namespace only as configured.
    [w.app, w.internet, 443], [w.app, w.apiServer, 443], [w.runtime, w.internet, 80],
  ]
  for (const [from, to, port, protocol] of refused)
    assert.ok(!can(from, to, port, protocol), `${from.name} -> ${to.name}:${port}/${protocol ?? 'TCP'} must be refused`)

  // The broker checks these three by name before it accepts a submission.
  for (const name of ['competition-job-isolation', 'competition-resolver-isolation', 'competition-proxy-isolation'])
    assert.ok(find(objects, 'NetworkPolicy', name), name)
  // Every policy covers both directions, so none depends on a default the namespace may not have.
  for (const policy of policies) assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress'], policy.metadata.name)

  // Scraping is open only with metrics on.
  const plain = await render({})
  assert.ok(!allowed(plain.filter((o) => o.kind === 'NetworkPolicy'), 'colloq', w.prometheus, w.app, 3000))
})

test('network policy values: DNS, ingress controller, API servers and the app\'s own egress are the platform\'s to say', { skip }, async () => {
  const objects = await render({ networkPolicy: {
    dns: { to: [{ ipBlock: { cidr: '169.254.20.10/32' } }] },
    ingressController: { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'd8-ingress-nginx' } } }] },
    kubeApiServer: { cidrs: ['10.0.0.0/30'], ports: [6443] },
    app: { egress: [{ cidrs: ['10.1.2.3/32'], ports: [3128] }], extraEgress: [{ to: [{ ipBlock: { cidr: '10.5.0.0/16' } }], ports: [{ protocol: 'TCP', port: 8443 }] }] },
  } })
  const policies = objects.filter((o) => o.kind === 'NetworkPolicy')
  const w = world(objects)
  const localDns: Address = { kind: 'ip', name: 'nodelocaldns', ip: '169.254.20.10' }
  const deckhouse: Pod = { kind: 'pod', name: 'controller', namespace: 'd8-ingress-nginx', nsLabels: { 'kubernetes.io/metadata.name': 'd8-ingress-nginx' }, labels: { app: 'controller' } }
  const can = (from: Endpoint, to: Endpoint, port: number, protocol = 'TCP') => allowed(policies, 'colloq', from, to, port, protocol)
  assert.ok(can(w.app, localDns, 53, 'UDP') && can(w.room, localDns, 53, 'UDP'))
  assert.ok(!can(w.app, w.dns, 53, 'UDP'), 'the default DNS peer was replaced')
  assert.ok(can(deckhouse, w.app, 3000) && !can(w.ingress, w.app, 3000))
  assert.ok(can(w.runtime, { kind: 'ip', name: 'api', ip: '10.0.0.2' }, 6443))
  assert.ok(!can(w.runtime, { kind: 'ip', name: 'api', ip: '10.0.0.9' }, 6443) && !can(w.runtime, w.apiServer, 443))
  assert.ok(can(w.app, { kind: 'ip', name: 'proxy', ip: '10.1.2.3' }, 3128) && !can(w.app, { kind: 'ip', name: 'proxy', ip: '10.1.2.3' }, 80))
  assert.ok(can(w.app, { kind: 'ip', name: 'llm', ip: '10.5.1.1' }, 8443))
  // An empty list admits nobody: an empty `from` in a NetworkPolicy would admit everyone.
  const closed = await render({ networkPolicy: { ingressController: { from: [] } } })
  const app = find(closed, 'NetworkPolicy', 'colloq-app')
  assert.deepEqual(app.spec.ingress, [])
  assert.ok(!allowed(closed.filter((o) => o.kind === 'NetworkPolicy'), 'colloq', w.ingress, w.app, 3000))
  // Cilium: the API servers by identity, in a namespaced policy.
  const cilium = find(await render({ networkPolicy: { kubeApiServer: { ciliumEntity: true } } }), 'CiliumNetworkPolicy', 'colloq-runtime-kube-api')
  assert.deepEqual(cilium.spec, { endpointSelector: { matchLabels: { 'colloq.dev/role': 'runtime' } },
    egress: [{ toEntities: ['kube-apiserver'], toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }, { port: '6443', protocol: 'TCP' }] }] }] })
})

test('rooms.network=none takes DNS away from rooms; the app is told the same', { skip }, async () => {
  const objects = await render({ rooms: { network: 'none' } })
  assert.deepEqual(find(objects, 'NetworkPolicy', 'room-isolation').spec.egress, [])
  assert.equal(envOf(container(objects, 'colloq-app')).COLLOQ_ROOM_NETWORK, 'none')
  const policies = objects.filter((o) => o.kind === 'NetworkPolicy')
  const w = world(objects)
  assert.ok(!allowed(policies, 'colloq', w.room, w.dns, 53, 'UDP') && !allowed(policies, 'colloq', w.own, w.dns, 53, 'UDP'))
  // Rooms are still reachable for the app and the broker, and the rest keeps its DNS.
  assert.ok(allowed(policies, 'colloq', w.app, w.room, 8888) && allowed(policies, 'colloq', w.runtime, w.room, 8888))
  assert.ok(allowed(policies, 'colloq', w.app, w.dns, 53, 'UDP'))
  const open = await render({})
  assert.equal('COLLOQ_ROOM_NETWORK' in envOf(container(open, 'colloq-app')), false)
})

/* ------------------------------------------------------------ refusals */

test('values the app or the broker would refuse stop the render, with the reason', { skip }, async () => {
  const cases: Array<[Values, RegExp]> = [
    [{ ingress: { host: '' } }, /ingress\.host is required/],
    [{ rooms: { memory: '8Gi', maxMemory: '4Gi' } }, /rooms\.memory \(8Gi\) exceeds rooms\.maxMemory \(4Gi\)/],
    [{ rooms: { memory: '32Mi' } }, /rooms\.memory "32Mi": whole Mi or Gi from 64Mi to 256Gi/],
    [{ rooms: { memory: '4G' } }, /rooms\.memory|does not match pattern/],
    [{ rooms: { cpu: '65' } }, /at most 64 cores/],
    [{ rooms: { cpu: 'two' } }, /rooms\.cpu "two"/],
    [{ rooms: { maxMemory: '512Gi' } }, /rooms\.maxMemory "512Gi"/],
    [{ rooms: { network: 'open' } }, /network/],
    [{ rooms: { podLabels: { 'colloq.dev/role': 'kernel' } } }, /rooms\.podLabels\.colloq\.dev\/role/],
    [{ rooms: { podLabels: { 'app.kubernetes.io/managed-by': 'me' } } }, /rooms\.podLabels\.app\.kubernetes\.io\/managed-by/],
    [{ rooms: { podAnnotations: { 'colloq.dev/session-id': 'x' } } }, /rooms\.podAnnotations\.colloq\.dev\/session-id/],
    [{ commonLabels: { 'app.kubernetes.io/part-of': 'lms' } }, /commonLabels\.app\.kubernetes\.io\/part-of/],
    [{ catalog: { defaultEnvironment: 'gpu', environments: [{ name: 'base', image: KERNEL('c'), gpu: false }] } }, /catalog\.defaultEnvironment "gpu"/],
    [{ catalog: { defaultEnvironment: 'base', environments: [{ name: 'base', image: KERNEL('c'), gpu: false }, { name: 'base', image: KERNEL('d'), gpu: false }] } },
      /exactly one of them needs current: true/],
    [{ catalog: { defaultEnvironment: 'base', environments: [{ name: 'base', image: KERNEL('c'), gpu: false, current: false }] } }, /nothing would be current/],
    [{ catalog: { defaultEnvironment: 'Base', environments: [{ name: 'Base', image: KERNEL('c'), gpu: false }] } }, /name|pattern/],
    [{ config: { existingSecret: 'vault', ai: { apiKey: 'sk' } } }, /put OPENAI_API_KEY and SESSION_SECRET into that Secret/],
    [{ secrets: { runtimeToken: { value: 'short' } } }, /secrets\.runtimeToken\.value: 43 to 128 characters/],
    [{ secrets: { roomSecret: { value: 'a'.repeat(64) } } }, /secrets\.roomSecret\.value/],
    [{ secrets: { roomSecret: { value: 'b'.repeat(20) + 'LiveRoomSecret0123456789abcdef', existingSecret: 'x' } } }, /either existingSecret or value/],
    [{ metrics: { serviceMonitor: { enabled: true } } }, /metrics\.serviceMonitor\.enabled needs metrics\.enabled/],
    [{ metrics: { enabled: true, token: 'short' } }, /metrics\.token/],
    [{ outbound: { extraCa: { pem: 'not a certificate' } } }, /PEM bundle/],
    [{ outbound: { extraCa: { pem: '-----BEGIN CERTIFICATE-----', existingConfigMap: 'x' } } }, /either pem or existingConfigMap/],
    [{ dependencies: { indexUrl: 'http://nexus.bank.local/simple' } }, /dependencies\.indexUrl/],
    [{ dependencies: { indexUrl: 'https://user:pw@nexus.bank.local/simple' } }, /dependencies\.indexUrl/],
    [{ dependencies: { filesHosts: 'files.bank.local/wheels' } }, /dependencies\.filesHosts: "files\.bank\.local\/wheels"/],
    [{ dependencies: { mirrorEgress: [{ cidrs: ['nexus.bank.local'], ports: [443] }] } }, /cidr|pattern/],
    [{ persistence: { accessMode: 'ReadWriteOncePod' } }, /accessMode|enum|must be one of/],
    [{ global: { imageRegistry: 'Harbor.Bank.Local' } }, /imageRegistry|pattern/],
    [{ unknownSetting: true }, /unknownSetting|additional/],
  ]
  for (const [values, reason] of cases) await refused(values, reason)
})

/* ------------------------------------------------------------------ NOTES */

async function withFakeCluster(secrets: Record<string, Record<string, string>>, run: (env: NodeJS.ProcessEnv) => Promise<void>, configMaps: Record<string, Record<string, string>> = {}): Promise<void> {
  // Discovery for the kinds the chart renders, the Secrets `lookup` asks for,
  // 404 for everything else. Helm's dry runs only read.
  const resource = (name: string, kind: string) => ({ name, singularName: kind.toLowerCase(), namespaced: true, kind, verbs: ['get', 'list', 'create', 'delete', 'patch'] })
  const groups: Record<string, Json[]> = {
    'apps/v1': [resource('deployments', 'Deployment')],
    'rbac.authorization.k8s.io/v1': [resource('roles', 'Role'), resource('rolebindings', 'RoleBinding')],
    'networking.k8s.io/v1': [resource('networkpolicies', 'NetworkPolicy'), resource('ingresses', 'Ingress')],
    'monitoring.coreos.com/v1': [resource('servicemonitors', 'ServiceMonitor')],
    'cilium.io/v2': [resource('ciliumnetworkpolicies', 'CiliumNetworkPolicy')],
  }
  const core = [['secrets', 'Secret'], ['configmaps', 'ConfigMap'], ['services', 'Service'], ['serviceaccounts', 'ServiceAccount'],
    ['persistentvolumeclaims', 'PersistentVolumeClaim'], ['pods', 'Pod']].map(([name, kind]) => resource(name, kind))
  const writes: string[] = []
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const route = new URL(req.url ?? '/', 'http://fake').pathname
    if (req.method !== 'GET') writes.push(`${req.method} ${route}`)
    if (route === '/version') return send(200, { major: '1', minor: '33', gitVersion: 'v1.33.0' })
    if (route === '/api') return send(200, { kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [] })
    if (route === '/apis') return send(200, { kind: 'APIGroupList', apiVersion: 'v1', groups: Object.keys(groups).map((gv) => {
      const [name, version] = gv.split('/')
      return { name, versions: [{ groupVersion: gv, version }], preferredVersion: { groupVersion: gv, version } }
    }) })
    if (route === '/api/v1') return send(200, { kind: 'APIResourceList', groupVersion: 'v1', resources: core })
    const group = /^\/apis\/([^/]+\/[^/]+)$/.exec(route)
    if (group && groups[group[1]]) return send(200, { kind: 'APIResourceList', groupVersion: group[1], resources: groups[group[1]] })
    const secret = /^\/api\/v1\/namespaces\/([^/]+)\/secrets\/([^/]+)$/.exec(route)
    if (secret && secrets[secret[2]]) return send(200, { apiVersion: 'v1', kind: 'Secret', metadata: { name: secret[2], namespace: secret[1] }, type: 'Opaque', data: secrets[secret[2]] })
    if (/^\/api\/v1\/namespaces\/[^/]+\/secrets$/.test(route)) return send(200, { kind: 'SecretList', apiVersion: 'v1', metadata: {}, items: [] })
    const configMap = /^\/api\/v1\/namespaces\/([^/]+)\/configmaps\/([^/]+)$/.exec(route)
    if (configMap && configMaps[configMap[2]]) return send(200, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: configMap[2], namespace: configMap[1] }, data: configMaps[configMap[2]] })
    send(404, { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', reason: 'NotFound', code: 404 })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const kubeconfig = path.join(tmp, `kubeconfig-${files++}`)
  fs.writeFileSync(kubeconfig, [
    'apiVersion: v1', 'kind: Config',
    `clusters: [{name: fake, cluster: {server: "http://127.0.0.1:${port}"}}]`,
    'users: [{name: fake, user: {token: fake}}]',
    'contexts: [{name: fake, context: {cluster: fake, user: fake}}]',
    'current-context: fake', '',
  ].join('\n'))
  try {
    await run({ KUBECONFIG: kubeconfig })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.deepEqual(writes, [], 'a dry run writes nothing')
}

async function notes(values: Values): Promise<string> {
  let text = ''
  await withFakeCluster({}, async (env) => {
    const result = await helm(['install', 'colloq', CHART, '--namespace', 'colloq', '--dry-run=server', '--disable-openapi-validation',
      '-f', valuesFile(RELEASE), '-f', valuesFile(values)], env)
    assert.equal(result.code, 0, result.stderr)
    text = result.stdout.slice(result.stdout.indexOf('NOTES:'))
  })
  return text
}

test('NOTES say how to open Colloq and how the first owner gets in', { skip }, async () => {
  const text = await notes({})
  assert.match(text, /https:\/\/colloq\.example\.edu\n/)
  assert.match(text, /kubectl -n colloq exec deploy\/colloq-app -- cat \/data\/setup-token/)
  assert.match(text, /https:\/\/colloq\.example\.edu\/admin\/t\/<token>/)
  assert.match(text, /kubectl -n colloq logs deploy\/colloq-app \| grep \/admin\/t\//)
  assert.match(text, /one replica each, strategy Recreate/)
  assert.match(text, /ReadWriteOnce/)
  assert.match(text, /ArgoCD/)
  const serviceOnly = await notes({ ingress: { enabled: false }, persistence: { accessMode: 'ReadWriteMany' },
    secrets: { runtimeToken: { existingSecret: 'a' }, roomSecret: { existingSecret: 'b' } }, rooms: { maxMemory: '16Gi' } })
  assert.match(serviceOnly, /kubectl -n colloq port-forward svc\/colloq-app 3000:3000/)
  assert.match(serviceOnly, /Set config\.publicUrl/)
  assert.doesNotMatch(serviceOnly, /ReadWriteOnce|ArgoCD|rooms\.maxMemory is not set/)
})

/* ------------------------------------------------------------- kubeconform */

test('every rendered object is valid against the Kubernetes 1.30 schemas (KUBECONFORM_BIN)', {
  skip: skip || (process.env.KUBECONFORM_BIN ? false : 'set KUBECONFORM_BIN to validate against the Kubernetes schemas'),
}, async () => {
  for (const values of [{}, EVERYTHING, { persistence: { accessMode: 'ReadWriteMany' }, ingress: { enabled: false }, rooms: { network: 'none' } }]) {
    const result = await template(values)
    assert.equal(result.code, 0, result.stderr)
    const file = path.join(tmp, `kubeconform-${files++}.yaml`)
    fs.writeFileSync(file, result.stdout)
    const check = spawnSync(process.env.KUBECONFORM_BIN!, ['-strict', '-summary', '-kubernetes-version', '1.30.0',
      '-schema-location', 'default',
      '-schema-location', 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json',
      file], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stdout + check.stderr)
    assert.match(check.stdout, /Invalid: 0, Errors: 0, Skipped: 0/)
  }
})

test('sign-in by proxy: the settings reach the app, inline keys are mounted read-only, and one key source is required', { skip }, async () => {
  const off = await render()
  assert.equal(configData(off).AUTH_JWT_JWKS_URL, undefined)
  assert.equal(envOf(container(off, 'colloq-app')).AUTH_JWT_JWKS_FILE, undefined)
  assert.equal(find(off, 'ConfigMap', 'colloq-sso-jwks'), undefined)

  const byUrl = configData(await render({ config: { sso: {
    jwksUrl: 'https://teleport.bank.local/.well-known/jwks.json', issuer: 'bank', audience: 'https://colloq.bank.local',
    teacherRoles: 'colloq-teacher', emailDomain: 'bank.local', claims: { email: 'traits.mail' },
  } } }))
  assert.equal(byUrl.AUTH_JWT_JWKS_URL, 'https://teleport.bank.local/.well-known/jwks.json')
  assert.equal(byUrl.AUTH_JWT_HEADER, 'teleport-jwt-assertion')
  assert.equal(byUrl.AUTH_JWT_ISSUER, 'bank')
  assert.equal(byUrl.AUTH_JWT_AUDIENCE, 'https://colloq.bank.local')
  assert.equal(byUrl.AUTH_JWT_EMAIL_CLAIM, 'traits.mail')
  assert.equal(byUrl.AUTH_JWT_EMAIL_DOMAIN, 'bank.local')
  assert.equal(byUrl.AUTH_JWT_TEACHER_ROLES, 'colloq-teacher')
  assert.equal(byUrl.AUTH_JWT_OWNER_ROLES, undefined, 'an empty value is left out, so the app default applies')

  const jwks = JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', kid: 'k1', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }] })
  const inline = await render({ config: { sso: { jwks, audience: '*' } } })
  assert.equal(find(inline, 'ConfigMap', 'colloq-sso-jwks').data['jwks.json'], jwks)
  const app = container(inline, 'colloq-app')
  assert.equal(envOf(app).AUTH_JWT_JWKS_FILE, '/etc/colloq-sso/jwks.json')
  assert.ok(app.volumeMounts.some((m: Json) => m.name === 'sso-jwks' && m.mountPath === '/etc/colloq-sso' && m.readOnly === true))
  assert.ok(deployment(inline, 'colloq-app').spec.template.spec.volumes.some((v: Json) => v.name === 'sso-jwks' && v.configMap?.name === 'colloq-sso-jwks'))

  await refused({ config: { sso: { jwksUrl: 'https://teleport.bank.local/jwks', jwks, audience: '*' } } }, /jwksUrl or jwks, not both/)
  await refused({ config: { sso: { jwks: '[1, 2]', audience: '*' } } }, /must be a JWKS document/)
  await refused({ config: { sso: { jwksUrl: 'ldap://teleport.bank.local', audience: '*' } } }, /must be an https URL/)
  await refused({ config: { sso: { jwksUrl: 'http://teleport.bank.local/.well-known/jwks.json', audience: '*' } } }, /must be an https URL/)
  // One proxy signs every application's tokens: the chart will not render a sign-in that would take them all.
  await refused({ config: { sso: { jwksUrl: 'https://teleport.bank.local/.well-known/jwks.json' } } }, /config\.sso\.audience is required/)
  await refused({ config: { sso: { header: 'two words' } } }, /header|does not match pattern/)
})
