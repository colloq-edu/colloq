import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'

export interface ManagedProcess {
  child: ChildProcess
  done: Promise<number>
  name: string
  settled: boolean
}
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Each child has its own process group, including npm/tsx and their grandchildren. */
export class Processes {
  readonly children = new Set<ManagedProcess>()
  constructor(
    private root: string,
    private env: NodeJS.ProcessEnv,
    private log?: number,
  ) {}
  start(
    name: string,
    command: string,
    args: string[],
    quiet = false,
    extraEnv: NodeJS.ProcessEnv = {},
  ): ManagedProcess {
    const child = spawn(command, args, {
      cwd: this.root,
      env: { ...this.env, ...extraEnv },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const item: ManagedProcess = { child, name, settled: false, done: Promise.resolve(0) }
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ] as const) {
      stream?.on('data', (chunk: Buffer) => {
        if (!quiet) target.write(chunk)
        if (this.log !== undefined) fs.writeSync(this.log, chunk)
      })
    }
    item.done = new Promise((resolve) => {
      let finished = false
      const done = (code: number): void => {
        if (finished) return
        finished = true
        item.settled = true
        this.children.delete(item)
        resolve(code)
      }
      child.on('error', (error) => {
        console.error(`${name}: ${error.message}`)
        done(127)
      })
      child.on('close', (code, signal) =>
        done(code ?? (signal === 'SIGINT' ? 130 : signal ? 143 : 0)),
      )
    })
    this.children.add(item)
    return item
  }
  async run(name: string, command: string, args: string[]): Promise<void> {
    const code = await this.start(name, command, args).done
    if (code !== 0) throw new Error(`${name}: процесс завершился с кодом ${code}.`)
  }
  signal(item: ManagedProcess, signal: NodeJS.Signals): void {
    if (item.settled || !item.child.pid) return
    try {
      if (process.platform === 'win32') item.child.kill(signal)
      else process.kill(-item.child.pid, signal)
    } catch {
      /* Already exited. */
    }
  }
  async stop(item: ManagedProcess, grace = 80000): Promise<void> {
    if (item.settled) return
    this.signal(item, 'SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      item.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, grace)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!item.settled) {
      this.signal(item, 'SIGKILL')
      await item.done
    }
  }
  async stopAll(grace = 80000): Promise<void> {
    await Promise.all([...this.children].map((item) => this.stop(item, grace)))
  }
}

export async function capture(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  args: string[],
  timeout = 5000,
): Promise<{ code: number; text: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    child.stdout.on('data', (chunk) => {
      text += chunk.toString()
    })
    child.stderr.resume()
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, timeout)
    const finish = (code: number): void => {
      clearTimeout(timer)
      resolve({ code, text })
    }
    child.on('error', () => finish(127))
    child.on('close', (code) => finish(code ?? 1))
  })
}
