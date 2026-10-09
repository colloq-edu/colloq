/**
 * Docker, faked at the process boundary, with state: room containers that
 * exist, run, are measured and go away.
 *
 * For the owner's «Работают сейчас» (routes/admin-running.ts) and its stop:
 * the census (`ps`), the batched `inspect` and `stats` the list reads, and
 * the `rm -f` a stop issues, plus what admission and the resources census ask
 * on the way (`version`, `network`, the per-container `inspect`). Anything
 * else answers code 1, the way a daemon refuses an unknown object; the call
 * log lets a test see what was asked.
 *
 * The shape follows kernel-shared-admission's fake, which stays its own:
 * that one throws on an unknown command on purpose, to prove admission asks
 * nothing new.
 */
import cp from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'

const MB = 1024 * 1024

export interface FakeContainer {
  /** The memory limit, in megabytes. */
  memoryMb: number
  /** What `docker stats` says it uses, in megabytes. */
  usedMb: number
  cpus: number
  running: boolean
  gpu: string
  environment: string
  startedAt: string
}

export interface FakeDocker {
  containers: Map<string, FakeContainer>
  calls: string[][]
  /**
   * Called before each command is answered: return a reply to answer with
   * it instead (a daemon that times out on `rm`), or nothing to go on. A
   * test also uses it to act at the very moment a command is asked.
   */
  intercept: ((args: string[]) => Reply | void) | null
  /** Add a class container by session and role. */
  add(session: string, role?: 'room' | 'own', container?: Partial<FakeContainer>): void
  /** Put the environment, spawn and fs back. */
  restore(): void
}

export type Reply = { code: number; out: string }

const nameOf = (session: string, role: 'room' | 'own') =>
  role === 'own' ? `colloq-room-${session}-own` : `colloq-room-${session}`

const sessionOf = (name: string) => name.slice('colloq-room-'.length).replace(/-own$/, '')

const defaults = (): FakeContainer => ({
  memoryMb: 4096,
  usedMb: 100,
  cpus: 2,
  running: true,
  gpu: '',
  environment: 'base',
  startedAt: '2026-10-09T18:00:00.000000000Z',
})

export function fakeDocker(): FakeDocker {
  const env = { ...process.env }
  const spawn = cp.spawn
  const exists = fs.existsSync
  Object.assign(process.env, {
    KERNEL_BACKEND: 'docker',
    KERNEL_ISOLATION: 'required',
    KERNEL_NETWORK: 'running-network',
    COLLOQ_ROOM_NETWORK: 'open',
  })
  // "The server runs in a container": the room network is then KERNEL_NETWORK, asked of the fake.
  fs.existsSync = ((p: fs.PathLike) => p === '/.dockerenv' || exists(p)) as typeof fs.existsSync
  const containers = new Map<string, FakeContainer>()
  const calls: string[][] = []

  const answer = (args: string[]): Reply => {
    calls.push(args)
    const instead = fake.intercept?.(args)
    if (instead) return instead
    const [command] = args
    if (command === 'version') return { code: 0, out: '28.0.0' }
    if (command === 'network') return { code: 0, out: args.at(-1)?.includes('Subnet') ? '10.213.0.0/22' : 'network-id' }
    if (command === 'ps') {
      return {
        code: 0,
        out: [...containers]
          .map(([name, c]) => {
            const own = name.endsWith('-own')
            return `${sessionOf(name)}\t${c.gpu}\t${c.running ? 'running' : 'exited'}\t${own ? 'own' : 'room'}`
          })
          .join('\n'),
      }
    }
    if (command === 'inspect') {
      // The panel's batched form: `inspect --format <format> <names…>`.
      if (args[1] === '--format') {
        const format = args[2]!
        const names = args.slice(3)
        const lines = names.flatMap((name) => {
          const c = containers.get(name)
          if (!c) return []
          if (!format.includes('StartedAt')) return []
          return [`/${name}\t${c.memoryMb * MB}\t${c.cpus * 1e9}\t${c.startedAt}\t${c.environment}`]
        })
        return { code: lines.length === names.length ? 0 : 1, out: lines.join('\n') }
      }
      const c = containers.get(args[1]!)
      if (!c) return { code: 1, out: 'Error: No such object' }
      const format = args.at(-1)!
      if (format.includes('HostConfig.Memory')) return { code: 0, out: `${c.memoryMb * MB} ${c.cpus * 1e9}` }
      if (format.includes('State')) return { code: 0, out: c.running ? 'running' : 'exited' }
      return { code: 0, out: '' }
    }
    if (command === 'stats') {
      const names = args.slice(args.indexOf('--format') + 2)
      const lines = names.flatMap((name) => {
        const c = containers.get(name)
        if (!c || !c.running) return []
        return [`${name}\t${c.usedMb}MiB / ${c.memoryMb / 1024}GiB\t3.50%`]
      })
      return { code: lines.length === names.length ? 0 : 1, out: lines.join('\n') }
    }
    // A start gets as far as admission: the image is there, the perimeter goes up.
    if (command === 'image') return { code: 0, out: 'ready' }
    if (command === 'run') {
      if (!args.includes('--name')) return { code: 0, out: 'colloq-perimeter: ok' }
      const name = args[args.indexOf('--name') + 1]!
      const memoryMb = Number(args.find((arg) => arg.startsWith('--memory='))?.match(/\d+/)?.[0] ?? 4096)
      containers.set(name, { ...defaults(), memoryMb })
      return { code: 0, out: name }
    }
    if (command === 'rm') {
      const name = args.at(-1)!
      const had = containers.delete(name)
      return had ? { code: 0, out: name } : { code: 1, out: `Error: No such container: ${name}` }
    }
    return { code: 1, out: `Error: unknown command ${command}` }
  }

  cp.spawn = ((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const result = command === 'docker' ? answer(args) : { code: 1, out: '' }
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(result.out))
      child.emit('close', result.code)
    })
    return child
  }) as unknown as typeof cp.spawn
  syncBuiltinESMExports()

  const fake: FakeDocker = {
    containers,
    calls,
    intercept: null,
    add(session, role = 'room', container = {}) {
      containers.set(nameOf(session, role), { ...defaults(), ...container })
    },
    restore() {
      cp.spawn = spawn
      fs.existsSync = exists
      syncBuiltinESMExports()
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
      Object.assign(process.env, env)
    },
  }
  return fake
}
