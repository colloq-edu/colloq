import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { hostPathOf } from '../competitions/storage.js'
import { DEPENDENCY_LIMITS, requirementLineCount } from '@shared/dependencies'
import { DependencyPreparationError } from './preparation-contract.js'
import type { PreparationRequest, PreparationResult, PreparationProgress } from './preparation-contract.js'
import { PREPARATION_PROXY_PYTHON, PREPARATION_PYTHON } from './preparation-python.js'

const LABEL = 'ru.colloq.dependency-preparation'
const scope = createHash('sha256').update(path.resolve(hostPathOf(config.dataDir))).digest('hex').slice(0, 16)
const label = `${LABEL}=${scope}`
const active = new Set<string>()
const MARKER = '__COLLOQ_DEP__'
const MiB = 1024 * 1024

type DockerResult = { code: number; out: string }
function docker(args: string[], options: { signal?: AbortSignal; onLine?: (line: string) => void; timeoutMs?: number } = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return }
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', pending = '', settled = false
    const finish = (error?: unknown, code = -1) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ code, out })
    }
    const abort = () => { child.kill('SIGKILL'); finish(options.signal?.reason ?? new DependencyPreparationError('cancelled', 'Package preparation was cancelled.')) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new DependencyPreparationError('docker_unavailable', 'The container service did not respond.')) }, options.timeoutMs ?? 60_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      out = (out + text).slice(-1024 * 1024)
      pending += text
      if (pending.length > 1024 * 1024) { child.kill('SIGKILL'); finish(new DependencyPreparationError('invalid_output', 'Package preparation returned too much output.')); return }
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        try { options.onLine?.(line) } catch (error) { child.kill('SIGKILL'); finish(error); return }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { out = (out + chunk.toString('utf8')).slice(-1024 * 1024) })
    child.on('error', () => finish(new DependencyPreparationError('docker_unavailable', 'The container service is unavailable.')))
    child.on('close', (code) => finish(undefined, code ?? -1))
  })
}

async function checkedDocker(args: string[], signal: AbortSignal): Promise<string> {
  const result = await docker(args, { signal })
  if (result.code !== 0) throw new DependencyPreparationError('docker_unavailable', 'The isolated preparation container could not be started.')
  return result.out.trim()
}

function profile(name: string, memory: number, tmpBytes: number): string[] {
  return ['--name', name, '--label', label, '--log-driver=local', '--log-opt=max-size=8m', '--log-opt=max-file=2', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--cpus=1', `--memory=${memory}`, `--memory-swap=${memory}`, '--ulimit=nofile=1024:1024', '--sysctl=net.ipv6.conf.all.disable_ipv6=1', '--tmpfs', `/tmp:rw,nosuid,nodev,exec,size=${tmpBytes},mode=1777`, '--env', 'HOME=/tmp', '--env', 'PYTHONNOUSERSITE=1', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PIP_CONFIG_FILE=/dev/null', '--entrypoint', 'python']
}

function bind(source: string, target: string, readOnly: boolean): string[] {
  const translated = hostPathOf(source)
  if (translated.includes(',')) throw new DependencyPreparationError('storage_unavailable', 'The preparation storage mount is not supported.')
  return ['--mount', `type=bind,src=${translated},dst=${target}${readOnly ? ',readonly' : ''}`]
}

/** Call once at server startup, before enqueueing preparations. Scoped to this DATA_DIR. */
export async function cleanupPreparationResources(): Promise<void> {
  const containers = await docker(['ps', '-aq', '--filter', `label=${label}`], { timeoutMs: 10_000 })
  if (containers.code !== 0) throw new DependencyPreparationError('docker_unavailable', 'The container service is unavailable.')
  // The queue calls this before starting jobs; still preserve active in-process jobs.
  const inspect = await Promise.all(containers.out.trim().split(/\s+/).filter(Boolean).map(async id => {
    const result = await docker(['inspect', '--format', '{{.Name}}', id], { timeoutMs: 10_000 })
    return { id, name: result.out.trim().replace(/^\//, '') }
  }))
  for (const { id, name } of inspect) if (!active.has(name)) await docker(['rm', '-f', id], { timeoutMs: 10_000 })
  const networks = await docker(['network', 'ls', '-q', '--filter', `label=${label}`], { timeoutMs: 10_000 })
  for (const id of networks.out.trim().split(/\s+/).filter(Boolean)) await docker(['network', 'rm', id], { timeoutMs: 10_000 })
}

export async function prepareDependencies(request: PreparationRequest): Promise<PreparationResult> {
  if (request.signal.aborted) throw new DependencyPreparationError('cancelled', 'Package preparation was cancelled.')
  if (!/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9._/:\-]+@sha256:[a-f0-9]{64})$/.test(request.imageDigest)) {
    throw new DependencyPreparationError('image_unpinned', 'Package preparation requires an immutable base image.')
  }
  if (Buffer.byteLength(request.requirementsText, 'utf8') > DEPENDENCY_LIMITS.requestBytes || requirementLineCount(request.requirementsText) > DEPENDENCY_LIMITS.lines) {
    throw new DependencyPreparationError('requirements_limit', 'Requirements exceed the allowed size or number of lines.')
  }
  if (![request.maxDownloadBytes, request.maxInstalledBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || request.maxDownloadBytes > DEPENDENCY_LIMITS.downloadBytes || request.maxInstalledBytes > DEPENDENCY_LIMITS.installedBytes) {
    throw new DependencyPreparationError('invalid_limits', 'The package preparation size limits are invalid.')
  }
  if (request.wallSeconds !== undefined && (!Number.isFinite(request.wallSeconds) || request.wallSeconds <= 0)) throw new DependencyPreparationError('invalid_limits', 'The package preparation time limit is invalid.')
  const seconds = Math.min(DEPENDENCY_LIMITS.wallSeconds, Math.max(1, request.wallSeconds ?? DEPENDENCY_LIMITS.wallSeconds))
  const controller = new AbortController()
  const cancel = () => controller.abort(new DependencyPreparationError('cancelled', 'Package preparation was cancelled.'))
  request.signal.addEventListener('abort', cancel, { once: true })
  if (request.signal.aborted) cancel()
  const timeout = setTimeout(() => controller.abort(new DependencyPreparationError('timeout', 'Package preparation exceeded its time limit.')), seconds * 1000)
  const suffix = randomUUID().replaceAll('-', '')
  const network = `colloq-dep-net-${suffix}`
  const proxy = `colloq-dep-proxy-${suffix}`
  const resolver = `colloq-dep-resolve-${suffix}`
  const verifier = `colloq-dep-verify-${suffix}`
  const names = [resolver, verifier, proxy]
  for (const name of names) active.add(name)
  const input = path.join(request.workDir, 'input')
  const wheels = path.join(request.workDir, 'wheels')
  let started = false, succeeded = false, inputCreated = false, wheelsCreated = false
  const progress = (update: PreparationProgress) => request.onProgress?.(update)
  try {
    // Dedicated fresh directory only; never follow a previous job's symlink or reuse partial wheels.
    await fs.mkdir(request.workDir, { recursive: true, mode: 0o700 })
    if (!(await fs.lstat(request.workDir)).isDirectory()) throw new DependencyPreparationError('storage_unavailable', 'The preparation storage directory is invalid.')
    await fs.mkdir(input, { mode: 0o755 }); inputCreated = true
    await fs.mkdir(wheels, { mode: 0o777 }); wheelsCreated = true
    await fs.chmod(wheels, 0o777)
    const disk = await fs.statfs(request.workDir)
    if (disk.bavail * disk.bsize < request.maxDownloadBytes + 64 * MiB) throw new DependencyPreparationError('disk_full', 'There is not enough free storage to prepare these packages.')
    const job = { requirementsText: request.requirementsText, basePackages: request.basePackages, maxDownloadBytes: request.maxDownloadBytes, maxInstalledBytes: request.maxInstalledBytes }
    const writeJob = async (value: object) => { await fs.writeFile(path.join(input, 'request.json'), JSON.stringify(value), { mode: 0o644 }) }
    await writeJob(job)
    progress({ state: 'resolving', log: 'Starting isolated package preparation.' })
    started = true
    await checkedDocker(['network', 'create', '--internal', '--driver=bridge', '--opt=com.docker.network.bridge.gateway_mode_ipv4=isolated', '--label', label, network], controller.signal)
    // Only the trusted CONNECT proxy has external connectivity. It has no mounts or secrets.
    await checkedDocker(['create', '--pull=never', ...profile(proxy, 128 * MiB, 8 * MiB), '--network=bridge', request.imageDigest, '-I', '-u', '-c', PREPARATION_PROXY_PYTHON, String(3 * request.maxDownloadBytes + 32 * MiB), String(seconds)], controller.signal)
    await checkedDocker(['network', 'connect', '--alias', 'pypi-proxy', network, proxy], controller.signal)
    await checkedDocker(['start', proxy], controller.signal)
    // Docker's embedded DNS resolves this private alias; no published host port.
    const proxyEnv = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].flatMap(key => ['--env', `${key}=http://pypi-proxy:3128`])
    let resolved: Pick<PreparationResult, 'normalizedRequirements' | 'packages' | 'downloadBytes'> | undefined
    let verified: Pick<PreparationResult, 'installedBytes' | 'lock'> | undefined
    const run = async (name: string, phase: 'resolve' | 'verify') => {
      let reportedError: DependencyPreparationError | undefined
      let latestState: PreparationProgress['state'] = phase === 'resolve' ? 'resolving' : 'verifying'
      const args = ['run', '--rm', '--pull=never', ...profile(name, 1536 * MiB, (phase === 'resolve' ? request.maxDownloadBytes : request.maxInstalledBytes) + 96 * MiB), `--network=${phase === 'resolve' ? network : 'none'}`, ...bind(input, '/input', true), ...bind(wheels, '/wheels', phase === 'verify')]
      if (phase === 'resolve') args.push(...proxyEnv, '--env', 'NO_PROXY=', '--env', 'no_proxy=', '--env', 'ALL_PROXY=', '--env', 'all_proxy=')
      args.push(request.imageDigest, '-I', '-u', '-c', PREPARATION_PYTHON, phase)
      const result = await docker(args, { signal: controller.signal, timeoutMs: seconds * 1000 + 1000, onLine: line => {
        if (!line.startsWith(MARKER)) return
        const value = JSON.parse(line.slice(MARKER.length))
        if (value.error) reportedError = new DependencyPreparationError(value.error.code, value.error.message, value.error.line ?? undefined)
        if (value.state) { latestState = value.state; progress(value) }
        if (value.resolved) resolved = value.resolved
        if (value.verified) verified = value.verified
      } })
      if (reportedError) throw reportedError
      if (result.code !== 0) {
        progress({ state: latestState, log: result.out.slice(-2000) })
        throw new DependencyPreparationError(result.code === 137 ? 'resource_limit' : 'preparation_failed', result.code === 137 ? 'Package preparation exceeded its memory limit.' : 'The isolated package preparation failed.')
      }
    }
    await run(resolver, 'resolve')
    if (!resolved) throw new DependencyPreparationError('invalid_output', 'Package resolution produced no manifest.')
    await writeJob({ ...job, resolved })
    progress({ state: 'verifying', downloadBytes: resolved.downloadBytes, log: 'Verifying hashes and installing the wheel bundle without network access.' })
    await run(verifier, 'verify')
    if (!verified) throw new DependencyPreparationError('invalid_output', 'Offline package verification produced no manifest.')
    // Independently hash host files after both containers exited; publish no symlinks or extras.
    const files = await fs.readdir(wheels)
    if (files.length !== resolved.packages.length) throw new DependencyPreparationError('invalid_wheel', 'The wheel bundle contains unexpected files.')
    let bytes = 0
    for (const item of resolved.packages) {
      if (!/^[A-Za-z0-9_.+!\-]+\.whl$/.test(item.fileName) || !files.includes(item.fileName)) throw new DependencyPreparationError('invalid_wheel', 'An unsafe wheel file was rejected.')
      const file = path.join(wheels, item.fileName)
      const info = await fs.lstat(file)
      if (!info.isFile() || info.size !== item.bytes) throw new DependencyPreparationError('invalid_wheel', 'A wheel has an invalid file type or size.')
      bytes += info.size
      if (bytes > request.maxDownloadBytes) throw new DependencyPreparationError('download_limit', 'The wheel downloads exceed the configured size limit.')
      const hash = createHash('sha256')
      const handle = await fs.open(file, 'r')
      try { for await (const chunk of handle.createReadStream()) hash.update(chunk) } finally { await handle.close() }
      if (hash.digest('hex') !== item.sha256) throw new DependencyPreparationError('hash_mismatch', 'A wheel failed its SHA-256 integrity check.')
      await fs.chmod(file, 0o444)
    }
    if (bytes !== resolved.downloadBytes || !Number.isSafeInteger(verified.installedBytes) || verified.installedBytes < 0 || verified.installedBytes > request.maxInstalledBytes) throw new DependencyPreparationError('invalid_output', 'The verified package sizes are invalid.')
    if (controller.signal.aborted) throw controller.signal.reason
    const contentHash = createHash('sha256').update(JSON.stringify({ imageDigest: request.imageDigest, normalizedRequirements: resolved.normalizedRequirements, packages: resolved.packages })).digest('hex')
    progress({ state: 'verifying', installedBytes: verified.installedBytes, downloadBytes: bytes, log: 'Offline installation and dependency checks passed.' })
    succeeded = true
    return { ...resolved, ...verified, contentHash }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof DependencyPreparationError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new DependencyPreparationError('disk_full', 'There is not enough storage to prepare these packages.')
    throw new DependencyPreparationError('preparation_failed', 'Package preparation could not finish.')
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', cancel)
    let cleanupFailed = false
    if (started) {
      // Kill the container, not merely the attached docker CLI, even after abort/timeout.
      // Confirm absence before returning artifacts; daemon outages must not publish a ready bundle.
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await Promise.allSettled(names.map(name => docker(['rm', '-f', name], { timeoutMs: 10_000 })))
          const remaining = await docker(['ps', '-aq', '--filter', `label=${label}`, '--filter', `name=${suffix}`], { timeoutMs: 10_000 })
          if (remaining.code !== 0) throw new Error('cleanup')
          if (!remaining.out.trim()) break
          if (attempt === 1) throw new Error('cleanup')
        }
        await docker(['network', 'rm', network], { timeoutMs: 10_000 })
        const remaining = await docker(['network', 'ls', '-q', '--filter', `label=${label}`, '--filter', `name=^${network}$`], { timeoutMs: 10_000 })
        if (remaining.code !== 0 || remaining.out.trim()) throw new Error('cleanup')
      } catch { cleanupFailed = true }
    }
    for (const name of names) active.delete(name)
    if (cleanupFailed) throw new DependencyPreparationError('cleanup_failed', 'The preparation containers could not be fully stopped. The package bundle was not published.')
    if (inputCreated) await fs.rm(input, { recursive: true, force: true }).catch(() => {})
    if (wheelsCreated && !succeeded) await fs.rm(wheels, { recursive: true, force: true }).catch(() => {})
  }
}
