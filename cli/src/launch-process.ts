import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

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
  /**
   * onLine — слушатель строк stdout ребёнка: вернул true — строка его, и на
   * экран она не идёт (в журнал идёт всё как есть). Так супервизор слышит
   * строку-метку host.sh под --share, не показывая её человеку. Без
   * слушателя поток идёт кусками, как шёл: построчная буферизация нужна
   * только тому, кто просил.
   */
  start(
    name: string,
    command: string,
    args: string[],
    quiet = false,
    extraEnv: NodeJS.ProcessEnv = {},
    cwd = this.root,
    onLine?: (line: string) => boolean,
  ): ManagedProcess {
    const child = spawn(command, args, {
      cwd,
      env: { ...this.env, ...extraEnv },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const item: ManagedProcess = { child, name, settled: false, done: Promise.resolve(0) }
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ] as const) {
      const lines =
        stream === child.stdout && onLine ? { rest: '', decoder: new StringDecoder('utf8') } : null
      stream?.on('data', (chunk: Buffer) => {
        if (this.log !== undefined) fs.writeSync(this.log, chunk)
        if (!lines) {
          if (!quiet) target.write(chunk)
          return
        }
        // Декодер, а не toString: буква из двух байт, разрезанная между
        // кусками, иначе превратилась бы в два знака вопроса.
        const text = lines.rest + lines.decoder.write(chunk)
        const parts = text.split('\n')
        lines.rest = parts.pop() ?? ''
        for (const line of parts) if (!onLine!(line) && !quiet) target.write(line + '\n')
      })
      if (lines)
        stream?.on('end', () => {
          lines.rest += lines.decoder.end()
          if (lines.rest && !onLine!(lines.rest) && !quiet) target.write(lines.rest)
          lines.rest = ''
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
    if (code !== 0) throw new Error(`${name}: the process exited with code ${code}.`)
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
