/**
 * The receipt of the running class, as read from the side of the commands.
 *
 * The class is run by the supervisor (launch.ts), which leaves a receipt in the
 * state directory: the port, the address, its own pid and the server's pid.
 * This is the only place that knows what is running RIGHT NOW, and therefore
 * the only place the port, the address and the process numbers may be taken
 * from.
 *
 * Why this is a separate file and not inline. There are three readers, `link`,
 * `status` and `doctor`, and while each read it in its own way, they disagreed
 * on one screen: status called the supervisor's pid "the server", doctor right
 * away declared the real listener of the port "a second Colloq" and advised
 * stopping one's own class, and both took the port from .env, where nobody had
 * changed it.
 *
 * Three things are NOT done here, and each on purpose.
 *
 * The port is not taken from .env. The questions differ: .env says what is
 * configured, the receipt says what the class runs on. `colloq run --port 4100`
 * does not touch .env (launch-config.ts · launchConfig), and the two answers
 * coincide only by chance.
 *
 * "Is it alive" is not worked out here: that is a question for the processes,
 * and the group modules do not go to them except through ctx.sh. What lies
 * here is what is written in the file, and the liveness check stays with
 * whoever asks.
 *
 * The receipt of SOMEONE ELSE'S root is not read. There is one path,
 * ctx.env.paths.sessionFile, and it is computed from the state directory. A
 * relative path written out by hand was broken in exactly this way: the
 * commands looked for the receipt next to the application.
 */
import type { Io } from './env.js'

/** The part of the receipt the commands need. The supervisor reads the other fields itself. */
export interface Session {
  /** The supervisor: its exit is the end of the class. */
  pid: number
  /** The server is the supervisor's child. It is the one listening on the port. */
  serverPid: number | null
  port: number
  url: string
  runId: string
  mode: 'run' | 'dev'
  phase: 'preparing' | 'starting' | 'ready' | 'stopping'
  startedAt: number
  /** The receipt file for a temporary public address; an empty string means there is none. */
  leaseFile: string
}

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1 ? value : null
}

/**
 * The local address from the receipt, which is also the check that the file
 * is ours.
 *
 * The requirements are the same as sessionAddress had in the local group: http
 * only, loopback only, no user, password, query or path. The receipt is
 * written by our own supervisor, but it lies in an ordinary file, and the link
 * from it lands on a person's screen, so not just any link is accepted.
 */
function loopback(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:') return null
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
    if (url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== '/') return null
    return value
  } catch {
    return null
  }
}

/** The receipt or null: no file, a broken file and a foreign format are all equally null. */
export function readSession(io: Io, file: string): Session | null {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(io.readText(file) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const pid = whole(data.pid)
  const url = loopback(data.url)
  const port = whole(data.port)
  const mode = data.mode === 'dev' ? 'dev' : data.mode === 'run' ? 'run' : null
  if (pid === null || url === null || port === null || port > 65535 || mode === null) return null
  if (typeof data.runId !== 'string' || !data.runId) return null
  const phase = ['preparing', 'starting', 'ready', 'stopping'].includes(String(data.phase))
    ? (data.phase as Session['phase'])
    : 'ready'
  return {
    pid,
    serverPid: whole(data.serverPid),
    port,
    url,
    runId: data.runId,
    mode,
    phase,
    startedAt: whole(data.startedAt) ?? 0,
    leaseFile: typeof data.leaseFile === 'string' ? data.leaseFile : '',
  }
}
