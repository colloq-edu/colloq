import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeController, roomName } from '../runtime/src/controller.js'
import { KubernetesError, type KubeObject, type KubernetesClient } from '../runtime/src/kubernetes.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'

const catalog = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'base',
  environments: [{ name: 'base', image: `registry.example/base@sha256:${'a'.repeat(64)}`, gpu: false }] })

// Kubernetes is the unavailable external boundary. The controller and its
// persisted Pod spec/status transitions remain real.
class ResizeCluster implements KubernetesClient {
  objects = new Map<string, KubeObject>()
  revision = 0
  conflicts = 1
  replaceOnConflict = false
  rollbackAttempts = 0
  async request<T>(method: string, path: string, body?: any): Promise<T> {
    if (method === 'POST') {
      const object = structuredClone(body) as KubeObject
      object.metadata.uid = `uid-${++this.revision}`
      object.metadata.resourceVersion = String(this.revision)
      object.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: object.kind === 'Pod' ? object.spec.containers.map((c: any) => ({ name: c.name, resources: structuredClone(c.resources) })) : [] }
      this.objects.set(`${path}/${object.metadata.name}`, object)
      return structuredClone(object) as T
    }
    if (method === 'PATCH') {
      const object = this.objects.get(path.replace(/\/resize$/, ''))!
      assert.equal(body.metadata.resourceVersion, object.metadata.resourceVersion, 'every retry must reread resourceVersion')
      const target = body.spec.containers[0].resources.limits.memory
      if (target === '2048Mi') {
        this.rollbackAttempts++
        if (this.conflicts-- > 0) {
          object.metadata.resourceVersion = String(++this.revision)
          if (this.replaceOnConflict) object.metadata.uid = 'replacement'
          throw new KubernetesError(409, 'Conflict')
        }
      }
      for (const group of ['requests', 'limits']) Object.assign(object.spec.containers[0].resources[group], body.spec.containers[0].resources[group])
      object.metadata.resourceVersion = String(++this.revision)
      object.status!.conditions = [{ type: 'Ready', status: 'True' },
        ...(target === '8192Mi' ? [{ type: 'PodResizePending', status: 'True', reason: 'Infeasible' }] : [])]
      return structuredClone(object) as T
    }
    if (method === 'DELETE') throw new Error('Resize must preserve Python and Pod identity')
    const object = this.objects.get(path)
    if (!object) throw new KubernetesError(404, 'NotFound')
    return structuredClone(object) as T
  }
  pod() { return this.objects.get(`/api/v1/namespaces/colloq/pods/${roomName('rollback')}`)! }
}
function controller(kube: ResizeCluster) {
  return new RuntimeController({ kube, catalog: () => catalog, roomSecret: () => 'test-secret',
    config: { namespace: 'colloq', workspaceClaim: 'workspace', cpu: '2', memory: '2Gi', ephemeral: '2Gi' },
    probe: async () => true, pollMs: 1, startupTimeoutMs: 50, resizeTimeoutMs: 50 })
}

test('infeasible resize restores actual resources after a status conflict without replacing Python', async () => {
  const kube = new ResizeCluster(), runtime = controller(kube)
  const started = await runtime.ensure('rollback', { environment: 'base' })
  await assert.rejects(runtime.resize('rollback', { memoryMb: 8192 }), /infeasible/)
  assert.equal(kube.pod().spec.containers[0].resources.limits.memory, '2048Mi')
  assert.equal(kube.pod().metadata.uid, started.instanceId)
  assert.equal(kube.rollbackAttempts, 2)
})

test('exhausted rollback is explicit and a new controller reconciles the persisted infeasible Pod on ensure', async () => {
  const kube = new ResizeCluster(), runtime = controller(kube)
  await runtime.ensure('rollback', { environment: 'base' })
  kube.conflicts = 20
  await assert.rejects(runtime.resize('rollback', { memoryMb: 8192 }), /rollback.*unreconciled/i)
  assert.ok(kube.rollbackAttempts <= 3, 'rollback retries are bounded')
  assert.equal(kube.pod().spec.containers[0].resources.limits.memory, '8192Mi')
  kube.conflicts = 0
  await controller(kube).ensure('rollback', { environment: 'base', memoryMb: 8192 })
  assert.equal(kube.pod().spec.containers[0].resources.limits.memory, '2048Mi')
})

test('rollback never changes a replacement Pod after a conflict', async () => {
  const kube = new ResizeCluster(), runtime = controller(kube)
  await runtime.ensure('rollback', { environment: 'base' })
  kube.replaceOnConflict = true
  await assert.rejects(runtime.resize('rollback', { memoryMb: 8192 }), /rollback.*unreconciled/i)
  assert.equal(kube.pod().metadata.uid, 'replacement')
  assert.equal(kube.pod().spec.containers[0].resources.limits.memory, '8192Mi')
  assert.equal(kube.rollbackAttempts, 1)
})
