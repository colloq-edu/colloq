#!/usr/bin/env node
/** Disposable, opt-in k3d proof of the broker notebook/scorer path.
 *
 * `--dry-run` does not contact Docker or Kubernetes. `--preflight` is read-only.
 * `--run` creates only uniquely named fixture resources and writes its report
 * under scratchpad/k3d. It never reads or changes the default kubeconfig.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = path.join(root, 'scratchpad/k3d')
const id = randomBytes(6).toString('hex')
const fixture = path.join(scratch, `fixture-${id}`)
const cluster = `colloq-smoke-${id}`
const registry = `colloq-smoke-reg-${id}`
const kubeconfig = path.join(fixture, 'kubeconfig')
const inputArgs = process.argv.slice(2)
const profileFlag = inputArgs.indexOf('--colima-profile')
const colimaProfile = profileFlag < 0 ? null : inputArgs[profileFlag + 1] ?? null
if (profileFlag >= 0 && (!colimaProfile || !/^[a-z][a-z0-9-]{0,30}$/.test(colimaProfile) || process.platform !== 'darwin'))
  throw new Error('--colima-profile requires a simple profile name on macOS')
const optionArgs = profileFlag < 0 ? inputArgs : inputArgs.filter((_, index) => index !== profileFlag && index !== profileFlag + 1)
const args = new Set(optionArgs)
const dryRun = args.has('--dry-run')
const preflightOnly = args.has('--preflight')
const realRun = args.has('--run')
const includeKaggle = args.has('--include-kaggle')
const prepare = args.has('--prepare')
const jsonOutput = args.has('--json')
const known = new Set(['--dry-run', '--preflight', '--run', '--include-kaggle', '--prepare', '--json'])
if (optionArgs.some(value => !known.has(value)) || [dryRun, preflightOnly, realRun].filter(Boolean).length !== 1) {
  throw new Error('Choose exactly one of --dry-run, --preflight, or --run; optional --include-kaggle, --prepare, --json, --colima-profile NAME')
}
const dockerHost = colimaProfile ? `unix://${path.join(process.env.COLIMA_HOME || path.join(os.homedir(), '.colima'), colimaProfile, 'docker.sock')}` : null
const childEnv = dockerHost ? { ...process.env, DOCKER_HOST: dockerHost, DOCKER_CONTEXT: undefined } : process.env
const imageKinds = ['app', 'runtime', 'kernel-base', ...(includeKaggle ? ['kernel-kaggle-base'] : [])]
const plan = { cluster, registry, fixture, kubeconfig, images: imageKinds, prepare,
  k3sImage: 'rancher/k3s:v1.36.4-k3s1', registryImage: 'registry:2',
  minFreeGiB: includeKaggle ? 22 : 12, minMemoryGiB: includeKaggle ? 8 : 5,
  ...(colimaProfile ? { colimaProfile, dockerHost } : {}) }

type Result = { stdout: string, stderr: string }
async function command(bin: string, argv: string[], options: { input?: string | Buffer, env?: NodeJS.ProcessEnv, timeout?: number, quiet?: boolean } = {}): Promise<Result> {
  if (!options.quiet) process.stderr.write(`$ ${bin} ${argv.map(x => /token|secret/i.test(x) ? '[redacted]' : x).join(' ')}\n`)
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd: root, env: options.env ?? childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let size = 0
    const add = (chunks: Buffer[], data: Buffer) => {
      size += data.length
      if (size > 32 * 1024 * 1024) { child.kill(); reject(new Error('command output exceeded 32 MiB')); return }
      chunks.push(data)
    }
    child.stdout.on('data', (data: Buffer) => add(stdout, data))
    child.stderr.on('data', (data: Buffer) => add(stderr, data))
    child.on('error', reject)
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`command timed out: ${bin}`)) }, options.timeout ?? 120_000)
    child.on('close', code => {
      clearTimeout(timer)
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
      if (code === 0) resolve(result)
      else reject(new Error(`${bin} exited ${code}: ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`))
    })
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error) })
    child.stdin.end(options.input)
  })
}
const k3dBin = fs.existsSync(path.join(scratch, `k3d-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`))
  ? path.join(scratch, `k3d-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`) : 'k3d'
let kubectlBin = process.env.COLLOQ_KUBECTL_BIN || ''
const kube = (argv: string[], input?: string | Buffer, timeout?: number, quiet = false) => command(kubectlBin, ['--kubeconfig', kubeconfig, ...argv], { input, timeout, quiet })
const k3d = (argv: string[], timeout?: number) => command(k3dBin, argv, { env: { ...childEnv, KUBECONFIG: kubeconfig }, timeout })
const GiB = 1024 ** 3
function availableKib(df: string): number {
  const line = df.trim().split('\n').at(-1) ?? ''
  const value = Number(line.trim().split(/\s+/)[3])
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Could not read Docker filesystem free space')
  return value
}
async function preflight() {
  const info = JSON.parse((await command('docker', ['info', '--format', '{{json .}}'], { quiet: true })).stdout)
  const architecture = info.Architecture
  if (!['aarch64', 'arm64', 'x86_64', 'amd64'].includes(architecture)) throw new Error(`Unsupported Docker architecture: ${architecture}`)
  const df = process.platform === 'darwin'
    ? (await command('colima', ['ssh', ...(colimaProfile ? ['--profile', colimaProfile] : []), '--', 'df', '-Pk', '/var/lib/docker'], { quiet: true })).stdout
    : (await command('df', ['-Pk', info.DockerRootDir], { quiet: true })).stdout
  const freeBytes = availableKib(df) * 1024
  const memoryBytes = Number(info.MemTotal)
  const result: typeof plan & { architecture: string, freeGiB: number, memoryGiB: number, ready: boolean, reason?: string } = {
    ...plan, architecture, freeGiB: Math.round(freeBytes / GiB * 100) / 100,
    memoryGiB: Math.round(memoryBytes / GiB * 100) / 100,
    ready: freeBytes >= plan.minFreeGiB * GiB && memoryBytes >= plan.minMemoryGiB * GiB }
  if (!result.ready) result.reason = `Docker VM needs ${plan.minFreeGiB} GiB free and ${plan.minMemoryGiB} GiB RAM; found ${result.freeGiB} GiB free and ${result.memoryGiB} GiB RAM`
  return result
}
async function freePort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function writeJson(file: string, value: unknown) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }) }
function key() { return randomBytes(32).toString('hex') }
function defaultKubeconfigHash(): string | null {
  const file = path.join(os.homedir(), '.kube/config')
  return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null
}
async function ensureKubectl(): Promise<string | null> {
  if (kubectlBin) {
    if (!fs.statSync(kubectlBin).isFile()) throw new Error('COLLOQ_KUBECTL_BIN is not a regular file')
    return null
  }
  const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const url = `https://dl.k8s.io/release/v1.36.4/bin/${platform}/${architecture}/kubectl`
  const file = path.join(fixture, 'kubectl')
  await command('curl', ['--fail', '--silent', '--show-error', '--location', url, '--output', file], { timeout: 120_000 })
  const expected = (await command('curl', ['--fail', '--silent', '--show-error', '--location', `${url}.sha256`], { timeout: 30_000 })).stdout.trim().split(/\s+/)[0]
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('Scoped kubectl checksum mismatch')
  fs.chmodSync(file, 0o700)
  kubectlBin = file
  return file
}
async function digest(hostPort: number, repository: string, tag: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${hostPort}/v2/${repository}/manifests/${tag}`, {
    headers: { Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json' },
    signal: AbortSignal.timeout(10_000),
  })
  const value = response.headers.get('docker-content-digest') ?? ''
  if (!response.ok || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`Registry did not publish a digest for ${repository}:${tag}`)
  await response.body?.cancel()
  return value
}
async function run() {
  const capacity = await preflight()
  if (!capacity.ready) { process.stdout.write(JSON.stringify(capacity) + '\n'); throw new Error(String((capacity as any).reason)) }
  const defaultConfigBefore = defaultKubeconfigHash()
  fs.mkdirSync(scratch, { recursive: true })
  fs.mkdirSync(fixture, { mode: 0o700 })
  for (const name of ['data', 'workspace']) fs.mkdirSync(path.join(fixture, name), { mode: 0o777 })
  fs.chmodSync(path.join(fixture, 'data'), 0o777)
  fs.chmodSync(path.join(fixture, 'workspace'), 0o777)
  fs.writeFileSync(path.join(fixture, '.colloq-k3s-smoke-root'), 'colloq-k3s-smoke-v1', { mode: 0o600 })
  fs.writeFileSync(path.join(fixture, 'data/.colloq-k3s-smoke-fixture'), 'colloq-k3s-smoke-v1', { mode: 0o644 })
  const report: Record<string, unknown> = { ...capacity, status: 'started', created: [] as string[] }
  const created: string[] = []
  const tags: string[] = []
  let downloadedKubectl: string | null = null
  let registryAttempted = false, clusterAttempted = false
  try {
    downloadedKubectl = await ensureKubectl()
    const existingClusters = JSON.parse((await k3d(['cluster', 'list', '-o', 'json'])).stdout)
    const existingRegistries = JSON.parse((await k3d(['registry', 'list', '-o', 'json'])).stdout)
    if (existingClusters.some((row: any) => row.name === cluster) || existingRegistries.some((row: any) => row.name === registry))
      throw new Error('Random smoke resource name is already allocated')
    const registryPort = await freePort()
    registryAttempted = true
    await k3d(['registry', 'create', registry, '--image', plan.registryImage, '--port', `127.0.0.1:${registryPort}`], 120_000)
    created.push(`registry:${registry}`)
    const apiPort = await freePort()
    clusterAttempted = true
    await k3d(['cluster', 'create', cluster, '--image', plan.k3sImage, '--servers', '1', '--agents', '0', '--no-lb',
      '--api-port', `127.0.0.1:${apiPort}`, '--registry-use', `k3d-${registry}:5000`,
      '--volume', `${fixture}:/var/lib/colloq@server:0`, '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false',
      '--k3s-arg', '--disable=traefik@server:0', '--k3s-arg', '--disable=servicelb@server:0',
      '--k3s-arg', '--kubelet-arg=pod-max-pids=256@server:0', '--timeout', '180s'], 240_000)
    created.push(`cluster:${cluster}`)
    fs.writeFileSync(kubeconfig, (await k3d(['kubeconfig', 'get', cluster])).stdout, { mode: 0o600 })
    const dockerArch = capacity.architecture === 'aarch64' || capacity.architecture === 'arm64' ? 'arm64' : 'amd64'
    const hostRegistry = `127.0.0.1:${registryPort}`
    const internalRegistry = `k3d-${registry}:5000`
    const build = async (repository: string, dockerfile: string, context: string, extra: string[] = []) => {
      const tag = `${hostRegistry}/${repository}:${id}`
      await command('docker', ['buildx', 'build', '--platform', `linux/${dockerArch}`, '--load', '-t', tag, '-f', dockerfile, ...extra, context], { timeout: 1_200_000 })
      tags.push(tag)
      await command('docker', ['push', tag], { timeout: 600_000 })
      return `${internalRegistry}/${repository}@${await digest(registryPort, repository, id)}`
    }
    const appImage = await build('colloq-app', 'Dockerfile', '.', ['--target', 'production'])
    const runtimeImage = await build('colloq-runtime', 'Dockerfile', '.', ['--target', 'broker'])
    const baseImage = await build('colloq-kernel-base', 'kernel/Dockerfile', 'kernel', ['--build-arg', 'KERNEL_ENV=base'])
    const kaggleImage = includeKaggle ? await build('colloq-kernel-kaggle-base', 'kernel/Dockerfile', 'kernel',
      ['--build-arg', `PARENT=${hostRegistry}/colloq-kernel-base:${id}`, '--build-arg', 'KERNEL_ENV=kaggle-base']) : null
    const release = { schemaVersion: 1, version: `smoke-${id}`, sourceCommit: (await command('git', ['rev-parse', 'HEAD'], { quiet: true })).stdout.trim(),
      k3sVersion: 'v1.36.4+k3s1', appImage, runtimeImage, dataSchemaVersion: 1, compatibleDataSchemaVersions: [1],
      catalog: { schemaVersion: 1, release: `smoke-${id}`, defaultEnvironment: 'base',
        environments: [{ name: 'base', image: baseImage, gpu: false }, ...(kaggleImage ? [{ name: 'kaggle-base', image: kaggleImage, gpu: false }] : [])] } }
    writeJson(path.join(fixture, 'release.json'), release)
    const nodes = JSON.parse((await kube(['get', 'nodes', '-o', 'json'])).stdout)
    const nodeName = nodes.items?.[0]?.metadata?.name
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(nodeName ?? '')) throw new Error('Missing isolated k3d node')
    const rendered = await command('python3', ['scripts/release.py', 'render', '--release', path.join(fixture, 'release.json'),
      '--node-name', nodeName, '--state-dir', '/var/lib/colloq'])
    fs.writeFileSync(path.join(fixture, 'manifest.json'), rendered.stdout, { mode: 0o600 })
    await kube(['apply', '-f', '-'], rendered.stdout, 120_000)
    const authToken = key(), roomSecret = key()
    const secrets = { apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'Secret', metadata: { namespace: 'colloq', name: 'colloq-runtime-auth' }, stringData: { 'runtime-token': authToken } },
      { apiVersion: 'v1', kind: 'Secret', metadata: { namespace: 'colloq', name: 'colloq-room-secret' }, stringData: { 'room-secret': roomSecret } },
      { apiVersion: 'v1', kind: 'Secret', metadata: { namespace: 'colloq', name: 'colloq-registry' }, type: 'kubernetes.io/dockerconfigjson',
        stringData: { '.dockerconfigjson': '{"auths":{}}' } },
    ] }
    await kube(['apply', '-f', '-'], JSON.stringify(secrets))
    await kube(['scale', '-n', 'colloq', 'deployment/colloq-runtime', '--replicas=1'])
    await kube(['rollout', 'status', '-n', 'colloq', 'deployment/colloq-runtime', '--timeout=120s'], undefined, 150_000)
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { namespace: 'colloq', name: `smoke-app-${id}`, labels: { 'colloq.dev/role': 'app' } },
      spec: { restartPolicy: 'Never', automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'fixture', image: appImage, command: ['sleep', '3600'], imagePullPolicy: 'IfNotPresent',
          securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
          resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
          env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'KERNEL_BACKEND', value: 'broker' },
            { name: 'DATA_DIR', value: '/data' }, { name: 'WORKSPACE_DIR', value: '/workspace' },
            { name: 'KERNEL_RUNTIME_URL', value: 'http://colloq-runtime:8787' },
            { name: 'KERNEL_RUNTIME_TOKEN_FILE', value: '/run/secrets/runtime-token' },
            { name: 'KERNEL_CATALOG_FILE', value: '/etc/colloq/catalog.json' },
            { name: 'COLLOQ_K3S_SMOKE_PREPARE', value: prepare ? '1' : '0' }],
          volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'workspace', mountPath: '/workspace' },
            { name: 'catalog', mountPath: '/etc/colloq', readOnly: true },
            { name: 'token', mountPath: '/run/secrets', readOnly: true },
            { name: 'smoke', mountPath: '/app/smoke' }, { name: 'tmp', mountPath: '/tmp' }] }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'colloq-data' } },
          { name: 'workspace', persistentVolumeClaim: { claimName: 'colloq-workspace' } },
          { name: 'catalog', configMap: { name: 'colloq-catalog' } },
          { name: 'token', secret: { secretName: 'colloq-runtime-auth' } },
          { name: 'smoke', emptyDir: { sizeLimit: '8Mi' } }, { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }] } }
    await kube(['apply', '-f', '-'], JSON.stringify(pod))
    await kube(['wait', '-n', 'colloq', '--for=condition=Ready', `pod/${pod.metadata.name}`, '--timeout=120s'], undefined, 150_000)
    // A newly started kube-router controller may not have installed its first
    // NetworkPolicy chain yet. Prove enforcement before accepting a job; the
    // broker's own init probe then independently fails closed on any regression.
    const probeName = `smoke-netpol-probe-${id}`
    const probe = { apiVersion: 'v1', kind: 'Pod', metadata: { namespace: 'colloq', name: probeName,
      labels: { 'colloq.dev/role': 'competition-job' } }, spec: { restartPolicy: 'Never', automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'probe', image: baseImage, command: ['python', '-I', '-c', 'import time;time.sleep(120)'],
        securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '250m', memory: '128Mi' } } }] } }
    await kube(['apply', '-f', '-'], JSON.stringify(probe))
    try {
      await kube(['wait', '-n', 'colloq', '--for=condition=Ready', `pod/${probeName}`, '--timeout=90s'], undefined, 120_000)
      let blocked = 0
      for (let attempt = 0; attempt < 30 && blocked < 3; attempt++) {
        const result = await kube(['exec', '-n', 'colloq', probeName, '--', 'python', '-I', '-c',
          'import socket;s=socket.socket();s.settimeout(1);print(s.connect_ex(("1.1.1.1",443)));s.close()'], undefined, 5000, true)
        blocked = Number(result.stdout.trim()) === 0 ? 0 : blocked + 1
        if (blocked < 3) await new Promise(resolve => setTimeout(resolve, 1000))
      }
      if (blocked < 3) throw new Error('k3s did not enforce competition egress NetworkPolicy')
      report.networkPolicyEgress = 'three consecutive external TCP connection refusals from a selected Pod'
    } finally { await kube(['delete', '-n', 'colloq', `pod/${probeName}`, '--wait=true'], undefined, 30_000).catch(() => {}) }
    const bundle = path.join(fixture, 'smoke.mjs')
    await command(path.join(root, 'node_modules/.bin/esbuild'), ['scripts/competition-k3s-app-fixture.mts', '--bundle', '--platform=node',
      '--format=esm', '--target=node22', '--external:better-sqlite3',
      '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      `--outfile=${bundle}`])
    await kube(['exec', '-n', 'colloq', '-i', pod.metadata.name, '--', 'sh', '-c', 'cat > /app/smoke/smoke.mjs'], fs.readFileSync(bundle), 30_000)
    const observed: any[] = []
    let done = false
    const invocation = kube(['exec', '-n', 'colloq', pod.metadata.name, '--', 'node', '/app/smoke/smoke.mjs'], undefined, prepare ? 420_000 : 240_000)
      .then(value => ({ value, error: null as Error | null }), error => ({ value: null as Result | null, error: error as Error }))
      .finally(() => { done = true })
    while (!done) {
      try {
        const listed = JSON.parse((await kube(['get', 'pods', '-n', 'colloq', '-l', 'app.kubernetes.io/managed-by=colloq-runtime', '-o', 'json'], undefined, 10_000, true)).stdout)
        for (const item of listed.items ?? []) if (!observed.some(row => row.metadata.uid === item.metadata.uid)) observed.push(item)
      } catch { /* The command result will surface a real failure. */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const invocationResult = await invocation
    if (invocationResult.error) throw invocationResult.error
    const output = invocationResult.value!.stdout
    const match = output.match(/COLLOQ_K3S_SMOKE_RESULT=(\{[^\n]+\})/)
    if (!match) throw new Error(`Fixture did not report success: ${output.slice(-2000)}`)
    const result = JSON.parse(match[1]!)
    const notebook = observed.find(item => item.metadata?.labels?.['colloq.dev/role'] === 'competition-job' &&
      item.spec?.containers?.[0]?.command?.some((arg: string) => arg.includes('run_notebook')))
    const metric = observed.find(item => item.metadata?.labels?.['colloq.dev/role'] === 'competition-job' &&
      item.spec?.containers?.[0]?.command?.some((arg: string) => arg.includes('broker_score')))
    if (!notebook || !metric) throw new Error('Did not capture both notebook and metric Pod specifications')
    for (const job of [notebook, metric]) {
      if (job.spec.automountServiceAccountToken !== false || job.spec.containers.length !== 2) throw new Error('Job Pod security shape changed')
      const mainMounts = job.spec.containers[0].volumeMounts.map((entry: any) => entry.mountPath)
      const exportMounts = job.spec.containers[1].volumeMounts.map((entry: any) => entry.mountPath)
      if (mainMounts.includes('/result') || !exportMounts.includes('/result')) throw new Error('Exporter destination leaked to main')
    }
    const notebookMounts = notebook.spec.containers[0].volumeMounts.map((entry: any) => entry.mountPath)
    const metricMounts = metric.spec.containers[0].volumeMounts.map((entry: any) => entry.mountPath)
    if (notebookMounts.includes('/secret') || metricMounts.includes('/data') || metricMounts.includes('/deps')) throw new Error('Notebook/scorer mount separation failed')
    if (prepare) {
      const resolver = observed.find(item => item.metadata?.labels?.['colloq.dev/role'] === 'competition-resolver')
      const proxy = observed.find(item => item.metadata?.labels?.['colloq.dev/role'] === 'competition-proxy')
      if (!resolver || !proxy) throw new Error('Did not capture isolated resolver and proxy Pods')
      const resolverMounts = resolver.spec.containers[0].volumeMounts.map((entry: any) => entry.mountPath)
      if (resolverMounts.includes('/secret') || resolverMounts.includes('/data') || !resolverMounts.includes('/input') || !resolverMounts.includes('/wheels'))
        throw new Error('Resolver received competition data or lost its input/wheels mount')
      if (proxy.spec.volumes?.some((volume: any) => volume.persistentVolumeClaim) ||
          proxy.spec.containers[0].volumeMounts?.some((entry: any) => ['/data', '/secret', '/result', '/wheels'].includes(entry.mountPath)))
        throw new Error('Proxy received a data PVC mount')
    }
    report.status = 'passed'; report.result = result
    report.pods = observed.map(item => ({ name: item.metadata.name, role: item.metadata.labels?.['colloq.dev/role'],
      containers: item.spec.containers.map((container: any) => ({ name: container.name, image: container.image,
        readOnlyRootFilesystem: container.securityContext?.readOnlyRootFilesystem,
        mounts: (container.volumeMounts ?? []).map((mount: any) => ({ path: mount.mountPath, readOnly: mount.readOnly === true })) })) }))
    report.images = { appImage, runtimeImage, baseImage, kaggleImage }
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    report.created = created
    writeJson(path.join(fixture, 'report.json'), report)
    const cleanupErrors: string[] = []
    if (clusterAttempted) await k3d(['cluster', 'delete', cluster], 180_000).catch(error => cleanupErrors.push(`Cluster cleanup failed: ${error}`))
    if (registryAttempted) await k3d(['registry', 'delete', registry], 120_000).catch(error => cleanupErrors.push(`Registry cleanup failed: ${error}`))
    if (clusterAttempted) {
      // k3d may retain its network when an attached registry is deleted after
      // the cluster. Remove only this run's empty network, never one in use.
      const network = `k3d-${cluster}`
      const inspected = await command('docker', ['network', 'inspect', network, '--format', '{{json .Containers}}'], { quiet: true }).catch(() => null)
      if (inspected) {
        try {
          if (Object.keys(JSON.parse(inspected.stdout)).length !== 0) cleanupErrors.push(`Owned network ${network} still has endpoints`)
          else await command('docker', ['network', 'rm', network], { quiet: true })
        } catch (error) { cleanupErrors.push(`Owned network cleanup failed: ${error}`) }
      }
    }
    for (const tag of tags) await command('docker', ['image', 'rm', tag], { quiet: true }).catch(() => {})
    if (downloadedKubectl && fs.existsSync(downloadedKubectl)) fs.unlinkSync(downloadedKubectl)
    if (fs.existsSync(kubeconfig)) fs.unlinkSync(kubeconfig)
    if (defaultKubeconfigHash() !== defaultConfigBefore) cleanupErrors.push('Default kubeconfig content changed during the smoke run')
    if (cleanupErrors.length) {
      report.status = 'cleanup_failed'
      report.cleanupErrors = cleanupErrors
      process.exitCode = 2
      for (const error of cleanupErrors) process.stderr.write(error + '\n')
    }
    writeJson(path.join(fixture, 'report.json'), report)
  }
  process.stdout.write(JSON.stringify({ report: path.join(fixture, 'report.json'), result: report.result }) + '\n')
}

if (dryRun) process.stdout.write(JSON.stringify(plan, null, jsonOutput ? 0 : 2) + '\n')
else if (preflightOnly) {
  const result = await preflight()
  process.stdout.write(JSON.stringify(result, null, jsonOutput ? 0 : 2) + '\n')
  if (!result.ready) process.exitCode = 2
} else await run().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 2
})
