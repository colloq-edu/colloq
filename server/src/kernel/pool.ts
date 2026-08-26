/**
 * A kernel container per environment, started on demand.
 *
 * A seminar picks an environment when it is created, and every environment that
 * somebody is actually using gets its own container from its own image. Two
 * rooms on different Python at the same time is the whole point; one instance
 * with one global Jupyter address could not do it.
 *
 * The default environment is deliberately NOT managed here. It keeps running as
 * the container `docker compose` already brought up, at the address the server
 * has always used. That is not laziness — it means the path every existing
 * seminar takes is byte-for-byte the one that was working before any of this
 * existed, and the new machinery only runs for a room that asked for something
 * else. A feature that cannot break the common case is worth the extra branch.
 *
 * Containers are started with `docker run`, not compose: compose services are
 * declared in a file, and these are decided at runtime by whoever creates a
 * seminar. They are named `colloq-env-<name>` so a person reading `docker ps`
 * during a seminar can tell what they are looking at.
 */
import { spawn } from 'node:child_process'
import { config } from '../config.js'
import { activeName } from '../environments.js'
import { defaultEndpoint, type KernelEndpoint } from './jupyter.js'

const IMAGE_PREFIX = 'colloq-kernel'
const CONTAINER_PREFIX = 'colloq-env'

interface RunResult {
  code: number
  out: string
}

function run(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: code ?? -1, out: out.trim() })
    })
  })
}

/**
 * Where the workspace comes from, copied off the container compose already runs.
 *
 * It is a bind mount in development and a named volume in production, and a
 * kernel that mounted the wrong one would run Python that cannot see the files
 * the Files panel uploaded — the failure would look like a broken `read_csv`
 * rather than a broken mount. Asking Docker what the working container uses is
 * the only answer that is right in both arrangements.
 */
async function workspaceMount(): Promise<string | null> {
  const res = await run([
    'inspect',
    'colloq-kernel-1',
    '--format',
    '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}',
  ])
  const source = res.code === 0 ? res.out.trim() : ''
  return source.length > 0 ? source : null
}

const containerFor = (env: string) => `${CONTAINER_PREFIX}-${env}`

/** The host port Docker gave a container, read back after it started. */
async function publishedPort(container: string): Promise<number | null> {
  const res = await run(['port', container, '8888/tcp'])
  if (res.code !== 0) return null
  // "0.0.0.0:54321" or "[::]:54321\n0.0.0.0:54321"
  const match = res.out.match(/:(\d+)\s*$/m)
  const port = match ? Number(match[1]) : NaN
  return Number.isFinite(port) ? port : null
}

async function stateOf(container: string): Promise<'running' | 'stopped' | 'missing'> {
  const res = await run(['inspect', container, '--format', '{{.State.Status}}'])
  if (res.code !== 0) return 'missing'
  return res.out.trim() === 'running' ? 'running' : 'stopped'
}

async function imageExists(env: string): Promise<boolean> {
  const res = await run(['image', 'inspect', `${IMAGE_PREFIX}:${env}`, '--format', '{{.Id}}'])
  return res.code === 0
}

/** Endpoints we have already resolved, so a busy room does not shell out per cell. */
const endpoints = new Map<string, KernelEndpoint>()
/** One start at a time per environment, shared by concurrent callers. */
const starting = new Map<string, Promise<KernelEndpoint>>()

async function startContainer(env: string): Promise<KernelEndpoint> {
  const container = containerFor(env)
  const state = await stateOf(container)

  if (state === 'stopped') {
    await run(['start', container], 60_000)
  } else if (state === 'missing') {
    if (!(await imageExists(env))) {
      throw new Error(
        `The environment "${env}" has never been built. Build it under Environments in the panel, then reopen this seminar.`,
      )
    }
    const mount = await workspaceMount()
    if (!mount) {
      throw new Error(
        'Could not read the workspace mount from the running kernel container, so a second kernel would not see the room\'s files.',
      )
    }
    const created = await run(
      [
        'run',
        '-d',
        '--name',
        container,
        // Docker picks the host port. Fixing one would collide the moment a
        // second environment came up, and the port is never typed by a person.
        '-p',
        '0:8888',
        '-e',
        `JUPYTER_TOKEN=${config.jupyter.token}`,
        '-v',
        `${mount}:/workspace`,
        // Student code is arbitrary, exactly as in compose. A runaway cell in a
        // second environment must not be able to take the host down either.
        `--memory=${process.env.KERNEL_MEM ?? '2g'}`,
        `--cpus=${process.env.KERNEL_CPUS ?? '2'}`,
        '--pids-limit=512',
        '--restart=unless-stopped',
        '--label',
        'colloq.kind=environment-kernel',
        '--label',
        `colloq.environment=${env}`,
        `${IMAGE_PREFIX}:${env}`,
      ],
      120_000,
    )
    if (created.code !== 0) throw new Error(`docker run failed: ${created.out.slice(-300)}`)
  }

  const port = await publishedPort(container)
  if (port === null) throw new Error(`could not read the published port of ${container}`)

  const endpoint: KernelEndpoint = {
    url: `http://localhost:${port}`,
    token: config.jupyter.token,
  }

  // Wait for Jupyter inside it to answer. `docker run` returns as soon as the
  // process is spawned, and connecting a second later fails with a bare
  // "fetch failed" that says nothing about why.
  const deadline = Date.now() + 90_000
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint.url}/api/status?token=${endpoint.token}`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) return endpoint
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`the "${env}" kernel did not answer within 90s (${lastError})`)
}

/**
 * The address of the Python a room should be talking to.
 *
 * `null` or the instance's own environment means the container compose runs,
 * which is the path everything took before environments existed.
 */
export async function endpointForEnvironment(env: string | null): Promise<KernelEndpoint> {
  const name = (env ?? '').trim()
  if (!name || name === activeName()) return defaultEndpoint()

  const cached = endpoints.get(name)
  if (cached) return cached

  const inFlight = starting.get(name)
  if (inFlight) return inFlight

  const attempt = startContainer(name)
    .then((endpoint) => {
      endpoints.set(name, endpoint)
      return endpoint
    })
    .finally(() => starting.delete(name))
  starting.set(name, attempt)
  return attempt
}

/** Forget a resolved address, so the next room re-checks the container. */
export function forgetEnvironment(env: string): void {
  endpoints.delete(env)
}

/** Environments this process has started a container for. Used by the panel. */
export function runningEnvironments(): string[] {
  return [...endpoints.keys()]
}
