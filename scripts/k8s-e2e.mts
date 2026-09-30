#!/usr/bin/env node
/**
 * The end-to-end check of Colloq installed by its Helm chart, against a live
 * cluster: .github/workflows/k8s-e2e.yml builds one with k3d, but any cluster
 * with the chart installed in a disposable namespace will do.
 *
 * It goes through the doors people use:
 *   1. the setup token is read from the app Pod (kubectl exec) and the
 *      instance claimed with it, over a port-forward to the app;
 *   2. scripts/e2e.mts runs against that: a seminar, a cell run over the
 *      WebSocket and its output, a file in the room's folder, and a probe cell
 *      that must reach neither the internet nor the Kubernetes API;
 *   3. one competition submission: the check of the sample notebook, which
 *      takes the queue every submission takes (a notebook Pod, then a metric
 *      Pod), with the fixtures of the k3s smoke;
 *   4. all along, every Pod the broker creates is watched: each one that mounts
 *      a volume claim must carry the required podAffinity to the app and run on
 *      the app's node. With ReadWriteOnce storage that is what keeps a room
 *      from waiting forever for a volume attached elsewhere
 *      (RUNTIME_COLOCATE_WITH_APP).
 *
 * Claiming makes this script the owner of the instance, so it refuses a
 * namespace that is not labelled colloq.dev/e2e=disposable: pointed at a real
 * installation by mistake, it stops before it touches anything. Its seminar
 * and competition are removed at the end.
 *
 *   KUBECONFIG=… K8S_E2E_NAMESPACE=colloq-e2e node --import tsx scripts/k8s-e2e.mts
 *
 *   KUBECONFIG           the cluster; required: the default kubeconfig is never read
 *   K8S_E2E_NAMESPACE    the chart's namespace; required
 *   K8S_E2E_KUBECTL      kubectl to use (default: kubectl on PATH)
 *   K8S_E2E_COMPETITION  0 skips step 3
 * The setup token is never printed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SMOKE_METRIC_CODE, SMOKE_SAMPLE_SUBMISSION, SMOKE_SOLUTION, smokeNotebook } from './competition-k3s-fixtures.mts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The label a namespace must carry before this script claims the instance in it. */
export const DISPOSABLE_LABEL = 'colloq.dev/e2e'
/** Submission states that are final (shared/competitions.ts · SubmissionState). */
const FINAL = new Set(['scored', 'notebookFailed', 'rejected', 'timedOut', 'outOfMemory', 'metricFailed', 'cancelled'])

/* ------------------------------------------------------------ pure checks */

type Pod = {
  metadata?: { name?: string, uid?: string, labels?: Record<string, string> }
  spec?: { nodeName?: string, volumes?: { persistentVolumeClaim?: { claimName?: string } }[], affinity?: any }
}

/** The port kubectl port-forward chose, from its first line of output. */
export function forwardedPort(text: string): number | null {
  const match = /Forwarding from 127\.0\.0\.1:(\d+) -> \d+/.exec(text)
  return match ? Number(match[1]) : null
}

/** Whether a Pod must be scheduled next to a Pod labelled colloq.dev/role=app. */
export function pinnedToApp(pod: Pod): boolean {
  const terms: any[] = pod.spec?.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []
  return terms.some((term) => term?.topologyKey === 'kubernetes.io/hostname' && (
    term.labelSelector?.matchLabels?.['colloq.dev/role'] === 'app' ||
    (term.labelSelector?.matchExpressions ?? []).some((e: any) =>
      e?.key === 'colloq.dev/role' && e.operator === 'In' && Array.isArray(e.values) && e.values.length === 1 && e.values[0] === 'app')))
}

/**
 * What is wrong with where the broker put its Pods: one line per Pod that mounts
 * a claim without the affinity to the app, or runs on another node than the app.
 * A Pod without a claim may go anywhere (the package proxy mounts none).
 */
export function colocationProblems(pods: Pod[], appNode: string): string[] {
  const problems: string[] = []
  for (const pod of pods) {
    const claims = [...new Set((pod.spec?.volumes ?? []).map((v) => v.persistentVolumeClaim?.claimName).filter(Boolean))]
    if (claims.length === 0) continue
    const name = `${pod.metadata?.labels?.['colloq.dev/role'] ?? 'Pod'} ${pod.metadata?.name ?? '?'}`
    if (!pinnedToApp(pod)) problems.push(`${name} mounts ${claims.join(', ')} without a required podAffinity to the app`)
    const node = pod.spec?.nodeName
    if (node && node !== appNode) problems.push(`${name} runs on ${node}, the app on ${appNode}`)
  }
  return problems
}

/* ------------------------------------------------------------- kubectl */

const kubeconfig = process.env.KUBECONFIG ?? ''
const namespace = process.env.K8S_E2E_NAMESPACE ?? ''
const kubectlBin = process.env.K8S_E2E_KUBECTL || 'kubectl'
const children: ChildProcess[] = []

function kubectl(args: string[], options: { quiet?: boolean, timeoutMs?: number } = {}): Promise<string> {
  const argv = ['--kubeconfig', kubeconfig, '--namespace', namespace, ...args]
  if (!options.quiet) console.log(`$ kubectl ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(kubectlBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = [], err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 60_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8')
      if (code === 0) resolve(stdout)
      // A quiet call's output may be a secret: only its error text is told.
      else reject(new Error(`kubectl ${args[0]} exited ${code}: ${stderr.trim().slice(-2000) || (options.quiet ? '' : stdout.slice(-2000))}`))
    })
  })
}

async function appPod(): Promise<{ name: string, node: string, port: number }> {
  const list = JSON.parse(await kubectl(['get', 'pods', '-l', 'colloq.dev/role=app', '-o', 'json']))
  const running = (list.items ?? []).filter((pod: any) => pod.status?.phase === 'Running' && !pod.metadata?.deletionTimestamp)
  if (running.length !== 1) throw new Error(`expected one running app Pod (colloq.dev/role=app), found ${running.length}`)
  const pod = running[0]
  const ports: any[] = pod.spec.containers.flatMap((c: any) => c.ports ?? [])
  const port = ports.find((p) => p.name === 'http')?.containerPort ?? 3000
  return { name: pod.metadata.name, node: pod.spec.nodeName, port }
}

async function portForward(pod: string, port: number): Promise<string> {
  const child = spawn(kubectlBin, ['--kubeconfig', kubeconfig, '--namespace', namespace, 'port-forward', `pod/${pod}`, `:${port}`,
    '--address', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let said = ''
  const local = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`port-forward did not start: ${said.slice(-500)}`)), 30_000)
    const read = (chunk: Buffer) => {
      said += chunk.toString('utf8')
      const found = forwardedPort(said)
      if (found) { clearTimeout(timer); resolve(found) }
    }
    child.stdout!.on('data', read)
    child.stderr!.on('data', read)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`port-forward exited ${code}: ${said.slice(-500)}`)) })
  })
  return `http://127.0.0.1:${local}`
}

/** The setup token, read where the app keeps it; never printed. */
async function setupToken(pod: string): Promise<string> {
  const token = (await kubectl(['exec', pod, '--', 'sh', '-c', 'cat "${DATA_DIR:-/data}/setup-token"'], { quiet: true })).trim()
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) throw new Error('the app Pod has no readable setup token')
  return token
}

/* ------------------------------------------------------------- the app */

async function waitForApp(base: string): Promise<{ claimed: boolean }> {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < 60_000) {
    try {
      const res = await fetch(`${base}/api/admin/state`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) return await res.json() as { claimed: boolean }
      last = `HTTP ${res.status}`
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await sleep(1000)
  }
  throw new Error(`the app did not answer through the port-forward: ${last}`)
}

async function staffCookie(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/api/admin/signin/token`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  if (!res.ok) throw new Error(`staff sign-in refused (${res.status})`)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie.startsWith('colloq_staff=')) throw new Error('no staff cookie was issued')
  return cookie
}

async function runE2e(base: string, dataDir: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/e2e.mts')], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, E2E_BASE_URL: base, DATA_DIR: dataDir, E2E_EXPECT_ISOLATED: '1' },
  })
  children.push(child)
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`scripts/e2e.mts failed (exit ${code})`)
}

/** One submission through the queue: the sample notebook's check, scored against the answers. */
async function competition(base: string, cookie: string): Promise<{ state: string, publicScore: number | null }> {
  const api = async (method: string, route: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { cookie } }
    if (body instanceof FormData) init.body = body
    else if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { cookie, 'content-type': 'application/json' }
    }
    const res = await fetch(`${base}/api/admin${route}`, init)
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} /api/admin${route} answered ${res.status}: ${text.slice(0, 500)}`)
    return text ? JSON.parse(text) : null
  }
  const file = (name: string, bytes: Buffer | string) => {
    const form = new FormData()
    form.append('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)]), name)
    return form
  }
  const slug = `k8s-e2e-${randomBytes(3).toString('hex')}`
  const created = await api('POST', '/competitions', { slug, title: 'Kubernetes end-to-end', environment: 'base',
    publicPercent: 50, limits: { wallSeconds: 120, memoryMb: 1024, cpus: 1, perDay: 0 },
    metric: { name: 'MAE', direction: 'lower', code: SMOKE_METRIC_CODE } })
  const id = created.competition.id as string
  console.log(`competition /k/${slug} created`)
  try {
    await api('POST', `/competitions/${id}/files`, file('sample_submission.csv', SMOKE_SAMPLE_SUBMISSION))
    await api('POST', `/competitions/${id}/solution`, file('solution.csv', SMOKE_SOLUTION))
    await api('POST', `/competitions/${id}/baseline`, file('baseline.ipynb', smokeNotebook()))
    const { submissionId } = await api('POST', `/competitions/${id}/baseline/check`)
    console.log(`the sample notebook is in the queue as submission ${submissionId}`)
    const started = Date.now()
    let submission: any = null
    while (Date.now() - started < 360_000) {
      submission = (await api('GET', `/competitions/${id}/submissions/${submissionId}`)).submission
      if (FINAL.has(submission.state)) break
      await sleep(2000)
    }
    const seconds = Math.round((Date.now() - started) / 1000)
    console.log(`submission ${submission?.state ?? 'unknown'} after ${seconds} s, public score ${submission?.publicScore}`)
    if (submission?.state !== 'scored') {
      throw new Error(`the submission ended ${submission?.state ?? 'nowhere'}: ${submission?.teacherError ?? submission?.participantError ?? ''}`)
    }
    if (submission.publicScore !== 0) throw new Error(`the sample notebook scored ${submission.publicScore}, not 0`)
    return { state: submission.state, publicScore: submission.publicScore }
  } finally {
    await api('DELETE', `/competitions/${id}`).then(() => console.log(`competition /k/${slug} removed`),
      (error) => console.log(`could not remove /k/${slug}: ${error instanceof Error ? error.message : String(error)}`))
  }
}

/* ---------------------------------------------------------------- main */

async function main(): Promise<void> {
  if (!kubeconfig || !fs.existsSync(kubeconfig)) throw new Error('KUBECONFIG must name the cluster\'s kubeconfig file')
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) throw new Error('K8S_E2E_NAMESPACE must name the chart\'s namespace')
  const labels = JSON.parse(await kubectl(['get', 'namespace', namespace, '-o', 'json'])).metadata?.labels ?? {}
  if (labels[DISPOSABLE_LABEL] !== 'disposable') {
    throw new Error(`namespace ${namespace} is not labelled ${DISPOSABLE_LABEL}=disposable; this check claims the instance, so it runs only where that is meant`)
  }
  const app = await appPod()
  console.log(`app Pod ${app.name} on node ${app.node}`)
  const base = await portForward(app.name, app.port)
  const state = await waitForApp(base)

  if (!state.claimed) {
    const res = await fetch(`${base}/api/admin/claim`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await setupToken(app.name), name: 'Kubernetes e2e', email: 'e2e@colloq.test' }) })
    if (res.status !== 201) throw new Error(`claiming the instance was refused (${res.status}): ${(await res.text()).slice(0, 300)}`)
    console.log('claimed the instance with the setup token from the app Pod')
  }
  // The claim replaced the token (admin/auth.ts · retireSetupToken): e2e.mts
  // signs in with the one the app keeps now, from a DATA_DIR of its own.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-k8s-e2e-'))
  const seen = new Map<string, Pod>()
  let watching = true
  const watcher = (async () => {
    while (watching) {
      try {
        const list = JSON.parse(await kubectl(['get', 'pods', '-l', 'app.kubernetes.io/managed-by=colloq-runtime', '-o', 'json'],
          { quiet: true, timeoutMs: 15_000 }))
        for (const pod of list.items ?? []) if (pod.metadata?.uid) seen.set(pod.metadata.uid, pod)
      } catch { /* the next poll, or the checks below, will tell */ }
      await sleep(1000)
    }
  })()
  const roles = () => [...seen.values()].map((pod) => pod.metadata?.labels?.['colloq.dev/role'] ?? '?')
  try {
    const token = await setupToken(app.name)
    fs.writeFileSync(path.join(dataDir, 'setup-token'), token + '\n', { mode: 0o600 })
    await runE2e(base, dataDir)
    const rooms = [...seen.values()].filter((pod) => pod.metadata?.labels?.['colloq.dev/role'] === 'kernel')
    if (!rooms.some((pod) => pod.spec?.nodeName)) throw new Error('no scheduled room Pod was seen while the seminar ran')
    console.log(`room Pods seen: ${rooms.map((pod) => `${pod.metadata?.name} on ${pod.spec?.nodeName}`).join(', ')}`)

    if (process.env.K8S_E2E_COMPETITION !== '0') {
      const result = await competition(base, await staffCookie(base, token))
      if (!roles().includes('competition-job')) throw new Error('the submission was scored, but no competition job Pod was seen')
      console.log(`competition: ${JSON.stringify(result)}`)
    }
    const problems = colocationProblems([...seen.values()], app.node)
    if (problems.length) throw new Error(`broker Pods are not next to the app:\n  ${problems.join('\n  ')}`)
    console.log(`\nPASS: ${seen.size} broker Pods (${[...new Set(roles())].sort().join(', ')}), every one with a volume on ${app.node} and pinned to the app`)
  } finally {
    watching = false
    await watcher
    fs.rmSync(dataDir, { recursive: true, force: true })
    // What the broker made, however the run ended: a failed seminar still
    // says where its room ran and whether it was pinned there.
    for (const pod of seen.values()) {
      console.log(`  broker Pod ${pod.metadata?.name} (${pod.metadata?.labels?.['colloq.dev/role'] ?? '?'}) on ` +
        `${pod.spec?.nodeName ?? 'no node'}${pinnedToApp(pod) ? ', pinned to the app' : ''}`)
    }
  }
}

// Run, not imported (the tests import the checks above). Real paths on both
// sides: a script started through a symlink (macOS /tmp) must not do nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    await main()
  } catch (error) {
    console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  }
}
