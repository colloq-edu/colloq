/** Real deployment canary. No room, image, path or Python source is accepted from CLI input. */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  imageRevision,
  isRuntimeSessionId,
  type RuntimeCatalog,
  type RuntimeEndpoint,
  type RuntimeEnvironment,
} from '../../../shared/runtime.js'
import type { JupyterKernel } from '../kernel/jupyter.js'

const PREFIX = 'COLLOQ_RUNTIME_SMOKE='
const OWNER_FILE = '.runtime-smoke-owner'
const WORK_MS = 130000
const CLEANUP_MS = 30000
class SmokeFailure extends Error {}

export interface SmokeDirectory {
  path: string
  owner: string
  dev: number
  ino: number
}
export function claimSmokeDirectory(root: string, id: string, owner: string): SmokeDirectory {
  if (!isRuntimeSessionId(id) || !id.startsWith('smoke-'))
    throw new SmokeFailure('Invalid canary identifier')
  const directory = path.join(fs.realpathSync(root), id)
  // No recursive mkdir: existing paths, including symlinks, are collisions.
  fs.mkdirSync(directory, { mode: 0o700 })
  try {
    fs.writeFileSync(path.join(directory, OWNER_FILE), owner, { flag: 'wx', mode: 0o600 })
    const stat = fs.lstatSync(directory)
    return { path: directory, owner, dev: stat.dev, ino: stat.ino }
  } catch (error) {
    // Only an empty directory that this call created may be removed here.
    try {
      fs.rmdirSync(directory)
    } catch {
      /* retain if it acquired contents */
    }
    throw error
  }
}
export function removeSmokeDirectory(directory: SmokeDirectory): void {
  const stat = fs.lstatSync(directory.path)
  const marker = path.join(directory.path, OWNER_FILE)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== directory.dev ||
    stat.ino !== directory.ino ||
    !fs.lstatSync(marker).isFile() ||
    fs.lstatSync(marker).isSymbolicLink() ||
    fs.readFileSync(marker, 'utf8') !== directory.owner
  ) {
    throw new SmokeFailure(
      'Canary directory ownership changed or directory was replaced; refusing cleanup',
    )
  }
  fs.rmSync(directory.path, { recursive: true })
}
export function selectSmokeEnvironment(catalog: RuntimeCatalog): RuntimeEnvironment {
  const environment =
    catalog.environments.find(
      (entry) => entry.current && !entry.gpu && entry.name === catalog.defaultEnvironment,
    ) ?? catalog.environments.find((entry) => entry.current && !entry.gpu)
  if (!environment)
    throw new SmokeFailure(
      'A current CPU environment (gpu:false) is required; the smoke test cannot be skipped',
    )
  return environment
}
export function parseSmokeReport(output: string): Record<string, unknown> {
  const reports = output.split(/\r?\n/).filter((line) => line.startsWith(PREFIX))
  if (reports.length !== 1) throw new SmokeFailure('Python did not return exactly one smoke report')
  let report: unknown
  try {
    report = JSON.parse(reports[0].slice(PREFIX.length))
  } catch {
    throw new SmokeFailure('Python returned invalid smoke evidence')
  }
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new SmokeFailure('Python returned invalid smoke evidence')
  return report as Record<string, unknown>
}
export function validateSmokeReport(
  stage: 'workspace' | 'isolation',
  report: Record<string, unknown>,
): void {
  if (
    stage === 'workspace' &&
    (typeof report.uid !== 'number' || !Number.isInteger(report.uid) || report.uid <= 0)
  ) {
    throw new SmokeFailure('Kernel must execute as a non-root UID')
  }
  const checks =
    stage === 'workspace'
      ? ['noRuntimeSockets', 'noServiceAccountToken', 'ownWorkspace', 'appSeedReadable', 'cwdOwn']
      : ['siblingFileBlocked', 'dnsResolved', 'siblingTcpBlocked']
  for (const check of checks)
    if (report[check] !== true) throw new SmokeFailure(`Smoke check failed: ${check}`)
}
function workspaceCode(id: string, seed: string): string {
  return `import os, pathlib, json
_root = pathlib.Path(${JSON.stringify(`/workspace/${id}`)})
_seed = ${JSON.stringify(seed)}
_seed_ok = (_root / "runtime-smoke-seed.txt").read_text() == _seed
(_root / "runtime-smoke.txt").write_text(_seed)
_sockets = ["/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock", "/var/run/containerd/containerd.sock", "/run/k3s/containerd/containerd.sock"]
_report = {
 "uid": os.getuid(),
 "noRuntimeSockets": not any(os.path.lexists(p) for p in _sockets),
 "noServiceAccountToken": not os.path.lexists("/var/run/secrets/kubernetes.io/serviceaccount/token"),
 "ownWorkspace": (_root / "runtime-smoke.txt").read_text() == _seed,
 "appSeedReadable": _seed_ok,
 "cwdOwn": pathlib.Path.cwd() == _root,
}
print(${JSON.stringify(PREFIX)} + json.dumps(_report))`
}
function siblingHost(id: string, endpoint: RuntimeEndpoint): string {
  const target = new URL(endpoint.url)
  const expected = `colloq-room-${createHash('sha256').update(id).digest('hex').slice(0, 40)}.`
  if (
    target.protocol !== 'http:' ||
    target.port !== '8888' ||
    !target.hostname.startsWith(expected) ||
    !/\.svc(?:\.cluster\.local)?$/.test(target.hostname)
  ) {
    throw new SmokeFailure('Broker returned an unexpected canary Service address')
  }
  return target.hostname
}
function isolationCode(otherId: string, hostname: string): string {
  return `import pathlib, socket, errno, json
_file_blocked = False
try:
    pathlib.Path(${JSON.stringify(`/workspace/${otherId}/runtime-smoke.txt`)}).read_bytes()
except (FileNotFoundError, PermissionError):
    _file_blocked = True
_resolved = False
_blocked = False
try:
    _addresses = socket.getaddrinfo(${JSON.stringify(hostname)}, 8888, type=socket.SOCK_STREAM)
    _resolved = bool(_addresses)
except socket.gaierror:
    _addresses = []
if _resolved:
    _blocked = True
    for _family, _type, _proto, _, _address in _addresses[:4]:
        with socket.socket(_family, _type, _proto) as _sock:
            _sock.settimeout(1.5)
            try:
                _sock.connect(_address)
                _blocked = False
                break
            except (TimeoutError, ConnectionRefusedError):
                pass
            except OSError as _error:
                if _error.errno not in (errno.EACCES, errno.EPERM):
                    _blocked = False
                    break
print(${JSON.stringify(PREFIX)} + json.dumps({"siblingFileBlocked": _file_blocked, "dnsResolved": _resolved, "siblingTcpBlocked": _blocked}))`
}
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SmokeFailure(`${label} exceeded its deadline`)),
          Math.max(1, ms),
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
async function executeReport(
  kernel: JupyterKernel,
  source: string,
  stage: 'workspace' | 'isolation',
  ms: number,
): Promise<void> {
  let output = '',
    invalid = false
  const result = await bounded(
    kernel.execute(
      source,
      {
        onExecuteInput() {},
        onClear() {},
        onData() {},
        onInputRequest() {
          invalid = true
        },
        onError() {
          invalid = true
        },
        onStream(name, text) {
          if (name !== 'stdout') return
          if (output.length + text.length > 16384) {
            invalid = true
            return
          }
          output += text
        },
      },
      { storeHistory: false },
    ),
    ms,
    `Python ${stage} check`,
  )
  if (result !== 'ok' || invalid)
    throw new SmokeFailure(`Python ${stage} check did not complete successfully`)
  validateSmokeReport(stage, parseSmokeReport(output))
}

export async function runRuntimeSmoke(): Promise<void> {
  if (
    !process.env.KERNEL_RUNTIME_URL ||
    !process.env.KERNEL_RUNTIME_TOKEN_FILE ||
    !process.env.KERNEL_CATALOG_FILE
  ) {
    throw new SmokeFailure(
      'KERNEL_RUNTIME_URL, KERNEL_RUNTIME_TOKEN_FILE and KERNEL_CATALOG_FILE are required',
    )
  }
  const [{ RuntimeClient, loadRuntimeCatalog }, { config }, { JupyterKernel }] = await Promise.all([
    import('../kernel/runtime-client.js'),
    import('../config.js'),
    import('../kernel/jupyter.js'),
  ])
  const environment = selectSmokeEnvironment(loadRuntimeCatalog())
  const connection = {
    url: process.env.KERNEL_RUNTIME_URL,
    tokenFile: process.env.KERNEL_RUNTIME_TOKEN_FILE,
  }
  const client = new RuntimeClient({ ...connection, timeoutMs: 100000 })
  const cleaner = new RuntimeClient({ ...connection, timeoutMs: CLEANUP_MS - 1000 })
  const inspector = new RuntimeClient({ ...connection, timeoutMs: 5000 })
  const deadline = Date.now() + WORK_MS
  const remaining = (max: number) => Math.max(1, Math.min(max, deadline - Date.now()))
  const random = randomBytes(16).toString('hex')
  const ids = [`smoke-${random}-a`, `smoke-${random}-b`]
  const owner = randomBytes(32).toString('hex')
  const seed = randomBytes(32).toString('hex')
  const directories: SmokeDirectory[] = []
  const kernels: JupyterKernel[] = []
  let retired = false,
    attempted = false,
    failure: unknown = null
  const existing = await inspector.rooms()
  if (existing.some((room) => ids.includes(room.sessionId)))
    throw new SmokeFailure('Canary room collision; existing rooms were not modified')
  try {
    for (const id of ids) {
      const directory = claimSmokeDirectory(config.workspaceDir, id, owner)
      directories.push(directory)
      fs.writeFileSync(path.join(directory.path, 'runtime-smoke-seed.txt'), seed, {
        flag: 'wx',
        mode: 0o600,
      })
    }
    attempted = true
    const ensured = await bounded(
      Promise.allSettled(
        ids.map((id) => client.ensure(id, environment.name, imageRevision(environment.image))),
      ),
      remaining(105000),
      'Canary startup',
    )
    if (ensured.some((result) => result.status !== 'fulfilled'))
      throw new SmokeFailure('Canary room startup failed')
    const endpoints = ensured.map(
      (result) => (result as PromiseFulfilledResult<RuntimeEndpoint>).value,
    )
    if (
      endpoints[0].instanceId === endpoints[1].instanceId ||
      endpoints[0].url === endpoints[1].url ||
      endpoints[0].token === endpoints[1].token
    ) {
      throw new SmokeFailure('Canary rooms do not have distinct runtimes and credentials')
    }
    const hosts = endpoints.map((endpoint, i) => siblingHost(ids[i], endpoint))
    const connected = await bounded(
      Promise.all(
        ids.map((id, i) =>
          JupyterKernel.connect(id, endpoints[i]).then((kernel) => {
            if (retired) {
              kernel.detach()
              throw new SmokeFailure('Canary connection completed after cleanup started')
            }
            kernels.push(kernel)
            return kernel
          }),
        ),
      ),
      remaining(20000),
      'Authenticated Jupyter connection',
    )
    await bounded(
      Promise.all(
        connected.map((kernel, i) =>
          executeReport(kernel, workspaceCode(ids[i], seed), 'workspace', remaining(10000)),
        ),
      ),
      remaining(10000),
      'Workspace execution',
    )
    for (const directory of directories) {
      if (fs.readFileSync(path.join(directory.path, 'runtime-smoke.txt'), 'utf8') !== seed)
        throw new SmokeFailure('The application cannot read Python workspace writes')
    }
    await bounded(
      Promise.all(
        connected.map((kernel, i) =>
          executeReport(
            kernel,
            isolationCode(ids[1 - i], hosts[1 - i]),
            'isolation',
            remaining(10000),
          ),
        ),
      ),
      remaining(10000),
      'Sibling isolation execution',
    )
  } catch (error) {
    failure = error
  } finally {
    retired = true
    for (const kernel of kernels) kernel.detach()
    const stopped = attempted
      ? await Promise.allSettled(
          ids.map((id) => bounded(cleaner.stop(id), CLEANUP_MS, 'Canary termination')),
        )
      : []
    let cleanupFailed = false
    for (let i = 0; i < directories.length; i++) {
      if (attempted && stopped[i]?.status !== 'fulfilled') {
        cleanupFailed = true
        continue
      }
      try {
        removeSmokeDirectory(directories[i])
      } catch {
        cleanupFailed = true
      }
    }
    if (cleanupFailed)
      throw new SmokeFailure(
        `Canary cleanup was not confirmed; inspect task-owned rooms/directories ${ids.join(', ')}`,
      )
  }
  if (failure) throw failure
}

export async function main(): Promise<number> {
  try {
    await runRuntimeSmoke()
    console.log(
      'Runtime smoke passed: two CPU rooms executed Python with separate credentials, non-root users, isolated files and blocked sibling TCP access. Canary rooms and directories were removed.',
    )
    console.log('Host-node network filtering was not tested.')
    return 0
  } catch (error) {
    // Never print Jupyter output, endpoint tokens, arbitrary runtime error bodies or stack traces.
    console.error(
      `Runtime smoke failed: ${error instanceof SmokeFailure ? error.message : 'configuration, runtime or Python execution failed'}`,
    )
    return 1
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A timed-out Jupyter connect may still have internal retries; do not let them
  // keep the deployment command alive after bounded cleanup has completed.
  void main().then((code) => process.exit(code))
}
