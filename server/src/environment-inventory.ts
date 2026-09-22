import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { ENVIRONMENT_NAME } from '@shared/admin'
import type { EnvironmentInventory } from '@shared/environment-inventory'
import { usingRuntimeBroker } from './kernel/runtime-client.js'

type Command = (args: string[]) => Promise<string>
const exec = promisify(execFile)
const command: Command = async (args) => {
  const result = await exec('docker', args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })
  return result.stdout.trim()
}

// Read metadata only: importing packages could initialize CUDA or execute user code.
const PROBE = `import importlib.metadata as m, json, platform
print(json.dumps({"python": platform.python_version(), "packages": [
    {"name": d.metadata["Name"], "version": d.version} for d in m.distributions()
]}))`

export function parseInventory(name: string, source: string): EnvironmentInventory {
  const value = JSON.parse(source)
  if (!value || typeof value.python !== 'string' || !/^\d+\.\d+\.\d+/.test(value.python)
      || !Array.isArray(value.packages) || value.packages.length === 0) {
    throw new Error('Invalid environment inventory')
  }
  const packages = value.packages.map((pkg: unknown) => {
    const item = pkg as { name?: unknown; version?: unknown } | null
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name)
        || typeof item.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+!_-]*$/.test(item.version)) {
      throw new Error('Invalid installed package')
    }
    return { name: item.name, version: item.version }
  })
  packages.sort((a: { name: string }, b: { name: string }) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en'))
  return { name, python: value.python, packages }
}

/** One probe per immutable image. Concurrent readers share it; mutable tags are
 * rechecked after 30 seconds so a rebuild cannot leave a permanent stale list. */
export function createInventoryReader(run: Command = command, clock = Date.now) {
  const names = new Map<string, { at: number; pending: Promise<EnvironmentInventory> }>()
  const images = new Map<string, Promise<string>>()
  return async (name: string): Promise<EnvironmentInventory> => {
    if (!ENVIRONMENT_NAME.test(name)) throw new Error('Invalid environment name')
    const cached = names.get(name)
    if (cached && clock() - cached.at < 30_000) return cached.pending
    const pending = (async () => {
      const image = (await run(['image', 'inspect', `colloq-kernel:${name}`, '--format', '{{.Id}}'])).trim()
      if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Environment image is unavailable')
      let source = images.get(image)
      if (!source) {
        const container = `colloq-inventory-${randomUUID()}`
        source = (async () => {
          try {
            return await run(['run', '--rm', '--pull=never', '--name', container,
              '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
              '--user=1000:1000', '--pids-limit=64', '--memory=256m', '--cpus=0.5',
              '--entrypoint', 'python', image, '-c', PROBE])
          } finally {
            // A timed-out Docker client can leave its container alive.
            await run(['rm', '-f', container]).catch(() => undefined)
          }
        })()
        if (images.size >= 64) images.delete(images.keys().next().value!)
        images.set(image, source)
        source.catch(() => { if (images.get(image) === source) images.delete(image) })
      }
      return parseInventory(name, await source)
    })()
    if (names.size >= 64) names.delete(names.keys().next().value!)
    names.set(name, { at: clock(), pending })
    return pending
  }
}

const localInventory = createInventoryReader()
export async function readEnvironmentInventory(name: string): Promise<EnvironmentInventory> {
  // The remote catalog's requirements are not an installed-package inventory.
  if (usingRuntimeBroker()) throw new Error('Installed inventory is unavailable from the runtime catalog')
  return localInventory(name)
}
