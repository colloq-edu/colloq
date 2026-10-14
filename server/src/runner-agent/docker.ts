/**
 * The agent's own calls to docker: pulls, inspects, tags, the card probe, the
 * GPU smoke test, the sweep of its check containers, and `docker update` of
 * its own container on a 401.
 *
 * NOT THE DOCKER RUNNER'S SHELL. A submission's container is started, watched,
 * exported and removed by DockerCompetitionRunner exactly as home does it
 * (competitions/docker-runner.ts), through that module's own shell, which only
 * its tests swap (useDockerForCompetitions). What is here is everything around
 * the run that only a machine does: a home never pulls by digest or smoke-
 * tests a card, because its images were built or pulled by the owner.
 *
 * The same form as that shell and card-probe.ts's: spawn with an array, no
 * shell, no quoting, a real timeout (kill, not just reject), output capped,
 * never a rejection — a daemon that is gone answers like one that refused,
 * with its words in `out`. `onLine` streams stdout line by line, for a pull's
 * progress («образ ↓ 45 %») without holding a gigabyte's worth of log lines.
 */
import { spawn } from 'node:child_process'

export interface DockerResult {
  /** The exit code; -1 — docker could not be started, was killed at the timeout, or overflowed its output. */
  code: number
  out: string
}

export interface DockerOptions {
  timeoutMs?: number
  /** The most stdout and stderr together that is kept; past it the call is killed and fails. */
  maxBytes?: number
  /** Each line of stdout as it comes, besides `out`. */
  onLine?: (line: string) => void
  /** Aborting kills the client (the daemon's work, a pull for one, may go on: it is the daemon's). */
  signal?: AbortSignal
}

/** A docker call: argv in, exit code and output out; never rejects. Tests hand the agent a fake. */
export type Docker = (args: string[], options?: DockerOptions) => Promise<DockerResult>

/** How much of a call's output is kept by default: an inspect of an image is a few kilobytes. */
const DEFAULT_MAX_BYTES = 1024 * 1024

/**
 * A pull's log lines are not all kept: one per layer per state, thousands for
 * a big image, and only the progress they tell is wanted, which `onLine`
 * reads as they come. The tail is kept for the error a failed pull ends with.
 */
const STREAMED_KEEP_CHARS = 16 * 1024

export const realDocker: Docker = (args, options = {}) =>
  new Promise((resolve) => {
    const max = options.maxBytes ?? DEFAULT_MAX_BYTES
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, out: String(error) })
      return
    }
    let out = ''
    let bytes = 0
    let overflow = false
    let pending = ''
    let settled = false
    const finish = (result: DockerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const kill = (): void => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    const timer = setTimeout(kill, options.timeoutMs ?? 60_000)
    const onAbort = (): void => kill()
    if (options.signal?.aborted) kill()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const keep = (text: string): void => {
      out += text
      if (options.onLine && out.length > STREAMED_KEEP_CHARS) out = out.slice(-STREAMED_KEEP_CHARS)
    }
    const take = (chunk: Buffer): boolean => {
      bytes += chunk.length
      // A streamed call keeps only its tail, so only an unstreamed one can overflow.
      if (!options.onLine && bytes > max) {
        overflow = true
        kill()
        return false
      }
      return true
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!take(chunk)) return
      const text = chunk.toString()
      keep(text)
      if (options.onLine) {
        pending += text
        const lines = pending.split(/\r?\n|\r/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) options.onLine(line)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (take(chunk)) keep(chunk.toString())
    })
    child.on('error', (error) => finish({ code: -1, out: String(error) }))
    child.on('close', (code) => {
      if (options.onLine && pending.trim()) options.onLine(pending)
      finish({ code: overflow ? -1 : code ?? -1, out: overflow ? 'Docker response exceeded its output limit' : out.trim() })
    })
  })

/** The first line of what docker said, for a problem's detail or a log line. */
export function dockerWords(result: DockerResult): string {
  const line = result.out.split('\n').map((part) => part.trim()).filter(Boolean)
  return line.find((part) => /error|denied|not found|no such|unauthorized|manifest|toomanyrequests|timeout|refused/i.test(part)) ?? line[line.length - 1] ?? `docker exited with ${result.code}`
}

/** The daemon said the object does not exist: an answer, not a hiccup (docker-runner.ts · missing). */
export function dockerMissing(result: DockerResult): boolean {
  return result.code !== 0 && /No such (?:container|object|image)/i.test(result.out)
}
