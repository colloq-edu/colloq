import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import { config } from '../config.js'
import { kernelBackend } from '../kernel/runtime-client.js'
import { competitionBackend } from './runner-port.js'
import { tr } from '@shared/i18n'
import type { CompetitionCapabilities, RuntimeCapability } from '@shared/capabilities'

const execute = promisify(execFile)
const ok = (): RuntimeCapability => ({ available: true, code: 'available', reason: null })
const unavailable = (code: string, key: string): RuntimeCapability => ({ available: false, code, reason: tr(key) })
type Backend = 'broker' | 'docker' | 'test'
function dockerMajor(version: string | null | undefined): number | null {
  const matched = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version ?? '')
  const major = matched ? Number(matched[1]) : NaN
  return Number.isSafeInteger(major) ? major : null
}
export function evaluateCapabilities(input: { backend: Backend; dockerVersion?: string | null; imageAvailable?: boolean; storageAvailable?: boolean }): CompetitionCapabilities {
  let execution = ok()
  if (input.backend === 'broker') execution = unavailable('unsupported_backend', 'runtime.brokerUnavailable')
  else if (input.backend === 'docker' && !input.dockerVersion) execution = unavailable('docker_unavailable', 'runtime.dockerUnavailable')
  else if (input.imageAvailable === false) execution = unavailable('image_unavailable', 'runtime.imageUnavailable')
  else if (input.storageAvailable === false) execution = unavailable('storage_unavailable', 'runtime.storageUnavailable')
  const major = dockerMajor(input.dockerVersion)
  const preparation = !execution.available ? { ...execution }
    : input.backend === 'docker' && (major === null || major < 28)
      ? unavailable('docker_version', 'runtime.preparationVersion') : ok()
  return { execution, preparation }
}

type Command = (args: string[]) => Promise<string>
interface Probe<T> { until: number; value: Promise<T> }
interface CapabilityReaderOptions {
  backend?: () => Backend
  run?: Command
  clock?: () => number
  storageAvailable?: () => boolean
}
/** One short cache for both successful and failed probes. In-flight callers
 * share the promise; expiry starts at completion, so slow probes also coalesce. */
export function createCapabilityReader(options: CapabilityReaderOptions = {}) {
  const clock = options.clock ?? Date.now
  const backendOf = options.backend ?? (() => competitionBackend() === 'test' ? 'test' : kernelBackend() === 'broker' ? 'broker' : 'docker')
  const run = options.run ?? (async (args) => (await execute('docker', args, { timeout: 3000, maxBuffer: 4096 })).stdout.trim())
  const storageAvailable = options.storageAvailable ?? (() => {
    try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK); return true }
    catch { return false }
  })
  let daemon: Probe<string | null> | null = null
  const images = new Map<string, Probe<boolean>>()
  const probe = <T>(work: () => Promise<T>): Probe<T> => {
    const entry: Probe<T> = { until: Infinity, value: Promise.resolve().then(work) }
    entry.value.finally(() => { entry.until = clock() + 5000 }).catch(() => undefined)
    return entry
  }
  return async (environmentName?: string, imageDigest?: string): Promise<CompetitionCapabilities> => {
    const backend = backendOf()
    // Unsupported deployments never invoke commands or touch worker resources.
    if (backend !== 'docker') return evaluateCapabilities({ backend })
    if (!daemon || daemon.until <= clock()) daemon = probe(() => run(['version', '--format', '{{.Server.Version}}']).then(value => value || null, () => null))
    const version = await daemon.value
    if (!version) return evaluateCapabilities({ backend, dockerVersion: null })
    let imageAvailable = true
    if (environmentName || imageDigest) {
      const image = imageDigest ?? `colloq-kernel:${environmentName}`
      let cached = images.get(image)
      if (!cached || cached.until <= clock()) {
        cached = probe(() => run(['image', 'inspect', '--format', '{{.Id}}', image]).then(() => true, () => false))
        if (images.size >= 64 && !images.has(image)) images.delete(images.keys().next().value!)
        images.set(image, cached)
      }
      imageAvailable = await cached.value
    }
    return evaluateCapabilities({ backend, dockerVersion: version, imageAvailable, storageAvailable: storageAvailable() })
  }
}
export const competitionCapabilities = createCapabilityReader()
export class RuntimeUnavailableError extends Error {
  readonly status = 503
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RuntimeUnavailableError' }
}
export async function assertCompetitionCapability(kind: 'execution' | 'preparation', environmentName?: string, imageDigest?: string): Promise<void> {
  const capability = (await competitionCapabilities(environmentName, imageDigest))[kind]
  if (!capability.available) throw new RuntimeUnavailableError(capability.code, capability.reason ?? tr('runtime.prepareUnavailable'))
}
