/**
 * Starting subordinate processes. The CLI does nothing else on its own:
 * scripts/*.sh and the class supervisor know their business, our job is not to
 * get in the way.
 *
 * The child's stream goes through unchanged: stdio is inherited, with no
 * interception, no redrawing and no filtering. The scripts number their steps
 * themselves ("5/7 installing docker"), and that must not be hidden. The
 * refusals of a delegated script are not rewritten either: its stderr goes out
 * as is.
 *
 * --dry-run prints exactly one line, what would have been executed, and starts
 * nothing. Values from .env are never substituted into it: secrets live in
 * .env, they are not in argv.
 */
import { constants } from 'node:os'
import type { Ui } from './ui.js'

export type RunOptions = {
  cwd?: string
  /** An addition to the child's environment. In the --dry-run line it goes as a `VAR=v ...` prefix. */
  env?: Record<string, string>
}

export type CaptureOptions = {
  cwd?: string
  env?: Record<string, string>
  /** A soft ceiling on waiting; once it expires the child is killed, code 124. */
  timeoutMs?: number
}

export type CaptureResult = { code: number; stdout: string; stderr: string }

/**
 * A stand-in executor for tests: it arrives as the Deps.runner field in cli().
 * While it is in place, not a single real process is started.
 */
export type Runner = {
  run(cmd: string, args: string[], opts: RunOptions): Promise<number>
  capture(cmd: string, args: string[], opts: CaptureOptions): Promise<CaptureResult>
}

export type Sh = {
  /** Start and return the exit code. The child's stream goes out unchanged. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<number>
  /** Start silently and collect the output: for status and doctor. Prints nothing to the outside. */
  capture(cmd: string, args: string[], opts?: CaptureOptions): Promise<CaptureResult>
  /** A direct call of scripts/*.sh from the application root. */
  script(path: string, args?: string[], opts?: RunOptions): Promise<number>
  /** A native command under --dry-run: one line `native: …`, code 0. */
  dry(line: string): number
  /** Whether --dry-run is on. */
  readonly dryRun: boolean
}

export type ShOptions = {
  root: string
  ui: Ui
  dryRun?: boolean
  runner?: Runner | null
}

/**
 * A one-line TCP probe for `node -e`: a connection to the address and port,
 * two seconds for an answer, code 0 means it answers.
 *
 * As a subordinate process, not our own socket: node:* is closed to the
 * command groups, and sh.capture is the very door the test replaces entirely.
 */
export const TCP_PROBE = [
  "const net = require('net')",
  'const [addr, port] = process.argv.slice(1)',
  'const socket = net.connect({ host: addr, port: Number(port) })',
  'const done = (code) => { socket.destroy(); process.exit(code) }',
  'socket.setTimeout(2000)',
  "socket.on('connect', () => done(0))",
  "socket.on('timeout', () => done(1))",
  "socket.on('error', () => done(1))",
].join('; ')

/** Whether the address answers: one TCP connection, two seconds, nothing more. */
export async function probeTcp(sh: Sh, addr: string, port: number): Promise<boolean> {
  const result = await sh.capture('node', ['-e', TCP_PROBE, addr, String(port)], {
    timeoutMs: 2500,
  })
  return result.code === 0
}

/** The exit code for a signal: 128 + its number, as in the shell. SIGINT is 130. */
export function exitFromSignal(signal: NodeJS.Signals): number {
  const number = constants.signals[signal]
  return 128 + (typeof number === 'number' ? number : 2)
}

/** Quotes for the --dry-run line: exactly as much as it takes to make it copyable. */
export function quote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** The call line as it will be executed: `VAR=v ./scripts/host.sh`. */
export function commandLine(cmd: string, args: string[], env?: Record<string, string>): string {
  const head = env
    ? Object.entries(env)
        .map(([key, value]) => key + '=' + quote(value))
        .join(' ')
    : ''
  const body = [cmd, ...args].map(quote).join(' ')
  return head ? head + ' ' + body : body
}

export function createSh(opts: ShOptions): Sh {
  const { root, ui } = opts
  const dryRun = opts.dryRun ?? false
  const runner: Runner | null = opts.runner ?? null

  const real: Runner = {
    async run(cmd, args, runOpts) {
      const { spawn } = await import('node:child_process')
      return await new Promise<number>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: runOpts.cwd ?? root,
          env: { ...process.env, ...(runOpts.env ?? {}) },
          stdio: 'inherit',
        })
        // Ctrl+C goes to the child, and we wait for it to exit: we add no output of our own.
        const forward = (signal: NodeJS.Signals) => () => {
          try {
            child.kill(signal)
          } catch {
            /* the child is already gone */
          }
        }
        const onInt = forward('SIGINT')
        const onTerm = forward('SIGTERM')
        const onHangup = forward('SIGHUP')
        process.on('SIGINT', onInt)
        process.on('SIGTERM', onTerm)
        process.on('SIGHUP', onHangup)
        const done = (code: number) => {
          process.off('SIGINT', onInt)
          process.off('SIGTERM', onTerm)
          process.off('SIGHUP', onHangup)
          resolve(code)
        }
        child.on('error', () => done(127))
        // A signal is 128 + its number, as in the shell: 130 stays reserved for
        // SIGINT alone. Otherwise a child killed for lack of memory would look
        // like the person giving up: "interrupted by hand".
        child.on('close', (code, signal) => done(signal ? exitFromSignal(signal) : (code ?? 0)))
      })
    },
    async capture(cmd, args, captureOpts) {
      const { spawn } = await import('node:child_process')
      return await new Promise<CaptureResult>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: captureOpts.cwd ?? root,
          env: { ...process.env, ...(captureOpts.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let timer: NodeJS.Timeout | null = null
        // Whether this is our own ceiling: only our own timer gives 124, a
        // foreign signal gives 128 + its number. Otherwise a child killed from
        // outside would pass itself off as a timeout.
        let expired = false
        child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
        child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
        child.stdin?.end()
        if (captureOpts.timeoutMs) {
          timer = setTimeout(() => {
            expired = true
            try {
              child.kill('SIGKILL')
            } catch {
              /* already gone */
            }
          }, captureOpts.timeoutMs)
        }
        const done = (code: number) => {
          if (timer) clearTimeout(timer)
          resolve({ code, stdout, stderr })
        }
        child.on('error', () => done(127))
        child.on('close', (code, signal) => {
          if (expired) return done(124)
          done(signal ? exitFromSignal(signal) : (code ?? 0))
        })
      })
    },
  }

  const sh: Sh = {
    get dryRun() {
      return dryRun
    },
    dry(line) {
      ui.line(line)
      return 0
    },
    async run(cmd, args, runOpts = {}) {
      if (dryRun) {
        ui.line(commandLine(cmd, args, runOpts.env))
        return 0
      }
      return await (runner ?? real).run(cmd, args, runOpts)
    },
    async capture(cmd, args, captureOpts = {}) {
      // capture prints nothing to the outside, under --dry-run as well: it is
      // reading state, not an action.
      return await (runner ?? real).capture(cmd, args, captureOpts)
    },
    async script(path, args = [], runOpts = {}) {
      return await sh.run(path, args, runOpts)
    },
  }
  return sh
}
