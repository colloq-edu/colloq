import { tr } from '@shared/i18n'
import crypto from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { config } from '../config.js'
import { sessionDir } from '../workspace.js'
import { CELLS_KEY } from '@shared/notebook'

/**
 * A hand-rolled client for the slice of the Jupyter protocol a seminar needs:
 * create one kernel, run code on it, interrupt, restart.
 *
 * Rolled by hand rather than via @jupyterlab/services because that package is
 * shaped for the browser and drags in a large dependency tree for what is two
 * REST calls and one websocket. Keeping it here also keeps the Jupyter token in
 * this process — browsers never learn it and never talk to Jupyter directly.
 */

export type KernelPhase = 'starting' | 'idle' | 'busy' | 'restarting' | 'dead'

/** How long a self-restarting kernel gets to come back before it is called dead. */
const COMEBACK_MS = 60_000
const COMEBACK_POLL_MS = 1_000

export interface ExecuteHandlers {
  onExecuteInput(execCount: number): void
  /**
   * The cell called input(). Until somebody answers, the kernel is blocked —
   * this is the one message that makes a running cell wait for a person rather
   * than for a computer, so the room has to be told, not just the caller.
   */
  onInputRequest?(prompt: string, password: boolean): void
  onStream(name: 'stdout' | 'stderr', text: string): void
  onData(mimebundle: Record<string, string>, execCount: number | null): void
  onError(ename: string, evalue: string, traceback: string[]): void
  /** @param wait `clear_output(wait=True)`: erase once something replaces it. */
  onClear(wait: boolean): void
  /**
   * The answer to `opts.userExpressions`, the only way to hear the kernel
   * silently.
   *
   * With `silent: true` NOTHING travels over IOPUB: neither stream nor
   * execute_result. But the kernel still evaluates `user_expressions` and puts
   * them into `execute_reply` in this case too (ipykernel ·
   * IPythonKernel.do_execute), provided the run itself finished with status
   * `ok`. This is how the council entry reports back (council-isolation.ts):
   * it has to tell the server "the copies are ready" without writing a single
   * line into the room.
   *
   * The value of each key is a mimebundle of the form
   * `{status, data, metadata}`.
   */
  onUserExpressions?(values: Record<string, unknown>): void
}

export type ExecuteStatus = 'ok' | 'error' | 'abort'

interface JupyterHeader {
  msg_id: string
  msg_type: string
  session: string
  username: string
  version: string
  date: string
}

interface JupyterMessage {
  header?: Partial<JupyterHeader>
  parent_header?: Partial<JupyterHeader>
  metadata?: Record<string, unknown>
  content?: Record<string, any>
  channel?: string
}

interface Pending {
  handlers: ExecuteHandlers
  settle: (status: ExecuteStatus) => void
  /** Filled by execute_reply on the shell channel. */
  status: ExecuteStatus | null
  /** Filled by the iopub `status: idle` that closes this request. */
  idle: boolean
  graceTimer: NodeJS.Timeout | null
  /**
   * A service run the room has no need to know about; see `execute`.
   *
   * Here it means exactly one thing: the `busy`/`idle` around it do not move
   * the kernel phase, i.e. the room's indicator does not blink. It changes
   * nothing in how the request is handled: the closing `idle` still closes the
   * wait.
   */
  quiet: boolean
}

/** Waiting for one `*_reply` over shell: no output, no handshake with iopub. */
interface ShellPending {
  resolve: (content: Record<string, any>) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** Cold start is container boot + kernel spawn, not just an HTTP round trip. */
const STARTUP_TIMEOUT_MS = 60_000
const STARTUP_RETRY_MS = 1000
const REQUEST_TIMEOUT_MS = 20_000
/** How long a run waits for a usable socket before giving up on the kernel. */
const SOCKET_WAIT_MS = 45_000
const SOCKET_POLL_MS = 100
/*
 * Eight, with the backoff below (500ms doubling to a 5s ceiling), is about
 * half a minute of trying before the kernel is called dead. Long enough to
 * ride out a container restart, short enough that a room is not left staring
 * at a notebook that has quietly stopped.
 */
const RECONNECT_MAX_ATTEMPTS = 8
/** Silence long enough to be worth a question, never long enough to be a wait. */
const QUIET_MS = config.kernelQuietMs
const WATCHDOG_MS = config.kernelWatchdogMs
/** iopub and shell are independent streams, so the reply can beat the final idle. */
const IDLE_GRACE_MS = 3000
/**
 * How long we wait for an answer to a service request over shell: completion
 * and help.
 *
 * Two and a half seconds, and this is not "just in case". ipykernel handles
 * shell one message at a time: while a cell is computing, `complete_request`
 * simply waits in the queue behind it and there will be no answer at all.
 * There is no point waiting longer: a suggestion that arrives a minute later
 * is a suggestion for text the person finished typing long ago. A timeout here
 * is an ordinary outcome, not a failure.
 */
const SHELL_REQUEST_MS = 2500

/**
 * ANSI from the help's `text/plain`.
 *
 * IPython colours the output of `?` even when nobody asked for it:
 * `inspect_reply` carries `\x1b[0;31mSignature:\x1b[0m`, and in a tooltip above
 * the caret this looks like garbage in front of every word. The same set as in
 * publish/render.ts: CSI, OSC and two-character sequences.
 */
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

/** One completion: the replacement text and what jedi takes it to be. */
export interface CompleteMatch {
  text: string
  type: string | null
}

export interface CompleteResult {
  matches: CompleteMatch[]
  /** Bounds of the span the replacement replaces, in chars from the code start. */
  cursorStart: number
  cursorEnd: number
}

export interface InspectResult {
  found: boolean
  text: string | null
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Where a room's Python lives.
 *
 * There used to be exactly one Jupyter and its address was a global. Now a
 * seminar picks an environment, and every environment in use runs its own
 * container — so the address is a property of the room, not of the process.
 * Threading it through instead of reading a global is the whole reason two
 * seminars can be on different Python at the same time.
 */
export interface KernelEndpoint {
  url: string
  token: string
  /** Pod/container incarnation, independent of its stable network address. */
  instanceId?: string
}

/** A replacement behind the same Service DNS must not inherit a remembered PTY. */
export function endpointIdentity(endpoint: KernelEndpoint): string {
  return endpoint.instanceId ? `${endpoint.url}\0${endpoint.instanceId}` : endpoint.url
}

/**
 * The Jupyter session path that gives a notebook its own kernel.
 *
 * jupyter_server identifies sessions by PATH: `POST /api/sessions` first asks
 * `session_exists(path=…)` and on a match returns the already live session
 * with its kernel. That is the very property sessions are used for here,
 * rather than `/api/kernels`: a server restart in the middle of class finds
 * the same kernel with the same variables. And it is also the way to give each
 * notebook its own: different paths, different kernels.
 *
 * The room's notebook (`cells`) keeps the SAME path it had before multiple
 * kernels appeared, and this is not aesthetics. A room that is running right
 * now must, after a deploy, find its live kernel rather than start a second one
 * next to it: otherwise the class's variables vanish at the moment the server
 * is updated, silently. Exactly `cells`, not "the first in order": dragging
 * tabs changes the order of notebooks.
 *
 * The colon from the `nb:` root is removed: the Jupyter path is virtual, but
 * it lands on the container's file system, and a colon in a file name is an
 * invitation to trouble out of nowhere. Two roots cannot collide: `nb:` is
 * issued once and never again (shared/notebook.ts · rootForNewBook).
 *
 * There is one folder for all notebooks, the class folder: the kernel's working
 * directory is taken from the path, and `open('data.csv')` has to find what
 * was put into the files panel, from any notebook.
 */
export function jupyterSessionPath(sessionId: string, root: string): string {
  if (root === CELLS_KEY) return `${sessionId}/session.ipynb`
  return `${sessionId}/session-${root.replace(/[^A-Za-z0-9_-]+/g, '-')}.ipynb`
}

/** Session label, shown in Jupyter's kernel list; kernels are not identified by it. */
export function jupyterSessionName(sessionId: string, root: string): string {
  return root === CELLS_KEY ? sessionId : `${sessionId}#${root}`
}

/** The instance-wide kernel: what a seminar gets when it names no environment. */
export function defaultEndpoint(): KernelEndpoint {
  return { url: config.jupyter.url, token: config.jupyter.token }
}

function jupyterRequest(
  endpoint: KernelEndpoint,
  path: string,
  init?: { method?: string; body?: string },
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  return fetch(`${endpoint.url}${path}`, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: {
      Authorization: `token ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/**
 * Mimebundle values are `string | string[]` depending on the kernel — IPython
 * sends text/plain as a line array often enough that the renderer would show
 * `["1","2"]` without this.
 */
function toStringBundle(data: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!data || typeof data !== 'object') return out
  for (const [mime, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string') out[mime] = value
    else if (Array.isArray(value))
      out[mime] = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('')
    else if (value === null || value === undefined) continue
    else out[mime] = JSON.stringify(value)
  }
  return out
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' ? [value] : []
  return value.map((line) => (typeof line === 'string' ? line : String(line)))
}

function frameText(data: RawData): string | null {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  try {
    return Buffer.from(data as ArrayBuffer).toString('utf8')
  } catch {
    return null
  }
}

/**
 * Whether Jupyter answers, with a short cache so this can be asked often.
 *
 * `/api/health` said `ok: true` as long as the process itself was alive, and
 * `host.sh` and `make status` believed it. Docker is off, yesterday's node is
 * still up, and the script prints "Colloq is available at this link", after
 * which the room gets KERNEL DEAD seventy seconds later. The check answers the
 * real question: can Python start here.
 *
 * Cached for five seconds: the probe goes over the network, and the health
 * probes poll once a second and must not poke Jupyter with every request.
 */
let lastProbe: { at: number; ok: boolean; reason: string | null } | null = null

export async function jupyterReachable(): Promise<{ ok: boolean; reason: string | null }> {
  const now = Date.now()
  if (lastProbe && now - lastProbe.at < 5000) return { ok: lastProbe.ok, reason: lastProbe.reason }

  let ok = false
  let reason: string | null = null
  try {
    // /api/status is Jupyter's cheapest endpoint, and every version of it has it.
    const res = await jupyterRequest(defaultEndpoint(), '/api/status', undefined, 3000)
    ok = res.ok
    if (!ok) reason = tr("server.jupyterAnswered.d1df44", { p0: res.status })
  } catch (err) {
    reason =
      err instanceof Error ? tr("server.jupyterIsUnreachable.aa1e10", { p0: err.message }) : tr("server.jupyterIsUnreachable.372559")
  }
  lastProbe = { at: now, ok, reason }
  return { ok, reason }
}

export class JupyterKernel {
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  /**
   * Service requests over shell, in a map separate from executions.
   *
   * Separate on purpose: `pending` has output handlers and a handshake with
   * iopub ("the reply PLUS the closing idle"), and a completion needs neither;
   * both would hurt. `complete_reply` is the whole answer; waiting for an idle
   * after it as well would hold the suggestion back for extra milliseconds,
   * and on a busy kernel it would never arrive.
   */
  private readonly shellPending = new Map<string, ShellPending>()
  private readonly listeners: Array<(phase: KernelPhase, expected: boolean) => void> = []
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  /**
   * The reconnect that is under way right now.
   *
   * While `reconnect()` waits for `openSocket` (up to twenty seconds),
   * `this.socket` is already null and the timer already cleared, i.e. both
   * guards are empty, and `waitForSocket`, which polls the state every hundred
   * milliseconds from every `execute`, started a SECOND reconnect, and after it
   * a third. The sockets that opened were simply assigned on top, the old ones
   * stayed with a live `on('message')`, and iopub arrived twice: every `print`
   * in the room was printed twice until the kernel died. In terminal.ts this
   * same class of trouble is closed by the `opening` field; here it was open.
   */
  private reconnecting: Promise<void> | null = null
  private disposed = false
  private _phase: KernelPhase = 'starting'
  /** Whether we ourselves asked for the last phase change; see `phaseExpected`. */
  private _phaseExpected = false
  /** When the kernel last said anything at all. See confirmAlive(). */
  private lastHeard = Date.now()
  /** msg_id of the execution currently blocked on input(), if any. */
  private awaitingInput: string | null = null
  private watchdog: NodeJS.Timeout | null = null
  private checking: Promise<boolean> | null = null

  private constructor(
    readonly sessionId: string,
    private readonly jupyterSessionId: string,
    private readonly kernelId: string,
    /** Whose kernel this is: the address of the room's environment container. */
    readonly endpoint: KernelEndpoint,
    /** The notebook this kernel belongs to: its root in the room document. */
    readonly root: string = CELLS_KEY,
  ) {}

  get phase(): KernelPhase {
    return this._phase
  }

  /**
   * Whether the current phase came at our request.
   *
   * Tells apart two things that look the same from outside: `restarting` after
   * Restart was pressed, and the `restarting` with which Jupyter reports that
   * the process was killed (memory). In the first case the interrupted cell
   * simply did not finish; in the second the kernel's death killed it, and the
   * cell itself must say so.
   */
  get phaseExpected(): boolean {
    return this._phaseExpected
  }

  /**
   * Bring up (or re-attach to) the kernel for one notebook of a session.
   *
   * Going through the *sessions* API rather than /api/kernels is what makes the
   * kernel's cwd the session folder, so `open('data.csv')` in a cell finds what
   * the Files panel uploaded. It is also idempotent: Jupyter returns the
   * existing session for a path, so a server restart mid-seminar re-attaches to
   * the live kernel with everybody's variables still in it.
   *
   * The key of this idempotency is the PATH, not the name: jupyter_server looks
   * the session up via `session_exists(path=…)`, and `name` is just a label to
   * it. Hence the design of `jupyterSessionPath` below: each notebook has its
   * own path, therefore its own kernel and its own variables, and `cells` keeps
   * exactly the path it had.
   */
  static async connect(
    sessionId: string,
    endpoint: KernelEndpoint,
    /** The notebook root; by default the room's notebook, i.e. the old behaviour. */
    root: string = CELLS_KEY,
  ): Promise<JupyterKernel> {
    sessionDir(sessionId)

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    const body = JSON.stringify({
      name: jupyterSessionName(sessionId, root),
      path: jupyterSessionPath(sessionId, root),
      type: 'notebook',
      kernel: { name: 'python3' },
    })

    let created: { sessionId: string; kernelId: string } | null = null
    let fatal: Error | null = null
    let lastError = tr("server.noResponse.187241")

    while (!created && !fatal && Date.now() < deadline) {
      try {
        const res = await jupyterRequest(endpoint, '/api/sessions', { method: 'POST', body })
        if (res.ok) {
          const parsed = (await res.json()) as { id?: string; kernel?: { id?: string } }
          if (parsed?.id && parsed.kernel?.id) {
            created = { sessionId: parsed.id, kernelId: parsed.kernel.id }
          } else {
            lastError = tr("server.jupyterReturnedASessionWithNoKernel.29a99e")
          }
        } else if (res.status === 401 || res.status === 403) {
          fatal = new Error(
            tr("server.jupyterRefusedThisServerSCredentialsHttp.d97e7c", { p0: res.status }),
          )
        } else {
          lastError = `HTTP ${res.status}`
        }
      } catch (err) {
        // Expected while the container is still coming up; keep trying.
        lastError = errText(err)
      }
      if (!created && !fatal) await delay(STARTUP_RETRY_MS)
    }

    if (fatal) throw fatal
    if (!created) {
      throw new Error(
        tr("server.noPythonKernelAfterSAtCheck.2f3e07", { p0: Math.round(STARTUP_TIMEOUT_MS / 1000), p1: endpoint.url, p2: lastError }),
      )
    }

    const kernel = new JupyterKernel(sessionId, created.sessionId, created.kernelId, endpoint, root)
    try {
      await kernel.openSocket(Math.max(10_000, deadline - Date.now()))
    } catch (err) {
      kernel._phase = 'dead'
      throw new Error(
        tr("server.theKernelStartedButItsChannelAt.ec5fda", { p0: endpoint.url, p1: errText(err) }),
      )
    }
    kernel.setPhase('idle')
    return kernel
  }

  /**
   * `expected` is true when the death was found by *asking*, before a cell had
   * been sent — the caller is about to bring a new kernel up and say so itself,
   * so a second, grimmer announcement would contradict it.
   */
  onPhaseChange(cb: (phase: KernelPhase, expected: boolean) => void): void {
    this.listeners.push(cb)
  }

  /**
   * @param opts.silent runs the code as a tool rather than as a cell: Jupyter
   * neither increments the execution count nor broadcasts the result to other
   * clients. Used by Format, which has to run Python to do its job but must not
   * leave a footprint in a notebook thirty people are looking at.
   * @param opts.storeHistory whether IPython keeps the source in `In`/`_ih` and
   * the result in `Out`/`_`. Defaults to "not silent". Off for a council
   * attempt: the kernel is shared by the room, and anyone who can run a line
   * in it could otherwise read every attempt the teacher has run with
   * `In[-5:]` or `%history` — the one thing the council promises never happens.
   * @param opts.userExpressions expressions the kernel evaluates after the code
   * and returns in `execute_reply`; see `ExecuteHandlers.onUserExpressions`.
   * @param opts.quiet hides THIS run from the kernel indicator: the `busy` and
   * `idle` around it do not change the phase. Exactly the same rule as for
   * `complete_request` and `inspect_request` below (see handleFrame), and it
   * came from the same case: help requested by a hovering mouse is not a room
   * event, and an indicator blinking at it for thirty people is a breakage, not
   * a hint. Set only on service runs of the `silent: true` kind; an ordinary
   * cell has to be visible.
   */
  async execute(
    code: string,
    handlers: ExecuteHandlers,
    opts?: {
      silent?: boolean
      storeHistory?: boolean
      userExpressions?: Record<string, string>
      quiet?: boolean
    },
  ): Promise<ExecuteStatus> {
    // A kernel that has been quiet since before the break may not be there any
    // more, and the socket will not say so. Between two cells run back to back
    // this is skipped, so it costs the seminar nothing where it is busiest.
    if (Date.now() - this.lastHeard > QUIET_MS && !(await this.confirmAlive(true))) {
      throw new Error(tr("server.thePythonKernelIsNotRunning.a9cde2"))
    }
    const socket = await this.waitForSocket()
    const header = this.makeHeader('execute_request')
    const frame = JSON.stringify({
      header,
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: opts?.silent === true,
        store_history: opts?.storeHistory ?? opts?.silent !== true,
        user_expressions: opts?.userExpressions ?? {},
        /*
         * input() has to work. A seminar called "Intro to Python" reaches for
         * it in the first fifteen minutes, and with stdin refused the cell dies
         * with StdinNotImplementedError — an error about the frontend, in a
         * lesson about reading a number. The reply travels back on the stdin
         * channel; see handleFrame and answerInput below.
         */
        allow_stdin: true,
        stop_on_error: true,
      },
      channel: 'shell',
    })

    const done = new Promise<ExecuteStatus>((resolve) => {
      this.pending.set(header.msg_id, {
        handlers,
        settle: resolve,
        status: null,
        idle: false,
        graceTimer: null,
        quiet: opts?.quiet === true,
      })
    })

    try {
      socket.send(frame)
    } catch (err) {
      this.pending.delete(header.msg_id)
      throw new Error(tr("server.couldNotSendTheCellToThe.b4abb1", { p0: errText(err) }))
    }
    this.startWatchdog()
    return done
  }

  /**
   * Answer a blocked input() call.
   *
   * The reply goes on the stdin channel with the *original* parent header, so
   * the kernel can match it to the execution that is waiting. Answering when
   * nothing is waiting is a no-op rather than an error: in a shared room two
   * people press Send at the same moment, and the second one is not a fault.
   */
  async answerInput(value: string): Promise<boolean> {
    const parent = this.awaitingInput
    if (!parent) return false
    /*
     * The wait is cleared AFTER sending, not before.
     *
     * `waitForSocket` can wait up to forty-five seconds for the channel, and it
     * can throw. A wait cleared in advance turned such a throw into a dead end:
     * the kernel still sits in `input()`, while `waitingForInput` is already
     * false, so every next "Send" silently gets `false`, the prompt hangs for
     * the whole room, the queue stands still, and the only way out is "stop".
     */
    const socket = await this.waitForSocket()
    // While we were waiting for the channel, someone else may have answered the
    // prompt: in a seminar that is ordinary, not a race.
    if (this.awaitingInput !== parent) return false
    socket.send(
      JSON.stringify({
        header: this.makeHeader('input_reply'),
        parent_header: { msg_id: parent },
        metadata: {},
        content: { value },
        channel: 'stdin',
      }),
    )
    this.awaitingInput = null
    return true
  }

  /** True while a cell is stopped inside input(), waiting for a person. */
  get waitingForInput(): boolean {
    return this.awaitingInput !== null
  }

  /**
   * Ask the kernel something over shell, and wait for exactly one answer.
   *
   * Bypassing the execution queue, and that is the main property. `execute`
   * puts a cell into the room's shared queue (kernel/index.ts · pump), where it
   * waits its turn behind others; a suggestion that arrives a minute later is
   * no suggestion. Here the request goes onto the wire at once, and if the
   * kernel is busy with its cell, no answer comes at all, and after
   * SHELL_REQUEST_MS the promise rejects. This is a NORMAL outcome, not a
   * failure: ipykernel handles shell one message at a time, and until
   * `time.sleep(60)` is over it cannot answer.
   *
   * No channel means an immediate refusal, without `waitForSocket`: that one
   * waits up to forty-five seconds, and nobody would wait that long for a
   * suggestion.
   */
  private request(
    msgType: string,
    content: Record<string, unknown>,
    timeoutMs = SHELL_REQUEST_MS,
  ): Promise<Record<string, any>> {
    const socket = this.socket
    if (this.disposed || this._phase === 'dead' || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(tr("server.thePythonKernelIsNotRunning.a9cde2")))
    }
    const header = this.makeHeader(msgType)
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.shellPending.delete(header.msg_id)
        reject(new Error(`${msgType} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // A question to the kernel must not keep the process alive, just like the
      // watchdog above.
      timer.unref?.()
      this.shellPending.set(header.msg_id, { resolve, reject, timer })
      try {
        socket.send(
          JSON.stringify({ header, parent_header: {}, metadata: {}, content, channel: 'shell' }),
        )
      } catch (err) {
        clearTimeout(timer)
        this.shellPending.delete(header.msg_id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * What can be completed at this point in the code, as the kernel itself sees
   * it.
   *
   * The kernel's view precisely, not text parsing in the browser: `df.` in a
   * notebook is a real DataFrame with real methods, and only the process it
   * lives in knows their list. Text parsing knows the words of this same cell,
   * and we prop up the answer with them on the client when there is no kernel.
   *
   * `types` comes from `metadata._jupyter_types_experimental`: ipykernel puts
   * there what jedi takes each match to be ("function", "instance", "module").
   * The field has been experimental for more than ten years and not every
   * kernel has it, so its absence is not an error, just a list without icons.
   */
  async complete(code: string, cursorPos: number): Promise<CompleteResult> {
    const content = await this.request('complete_request', { code, cursor_pos: cursorPos })
    const matches = Array.isArray(content.matches)
      ? content.matches.filter((m: unknown): m is string => typeof m === 'string')
      : []
    const experimental = (content.metadata as Record<string, unknown> | undefined)?.[
      '_jupyter_types_experimental'
    ]
    const types = Array.isArray(experimental) ? experimental : null
    return {
      matches: matches.map((text, index) => {
        const hint = types?.[index] as { type?: unknown } | undefined
        return { text, type: typeof hint?.type === 'string' ? hint.type : null }
      }),
      cursorStart: typeof content.cursor_start === 'number' ? content.cursor_start : cursorPos,
      cursorEnd: typeof content.cursor_end === 'number' ? content.cursor_end : cursorPos,
    }
  }

  /**
   * Help for what is under the caret: the signature and the start of the
   * docstring.
   *
   * The same as `name?` does in a cell, except that the answer is not printed
   * to the output but travels to the caller. `detail_level` 0 means the
   * signature and documentation, 1 adds the source as well; zero is enough for
   * a hint above a parenthesis.
   */
  async inspect(code: string, cursorPos: number, detailLevel = 0): Promise<InspectResult> {
    const content = await this.request('inspect_request', {
      code,
      cursor_pos: cursorPos,
      detail_level: detailLevel,
    })
    const bundle = toStringBundle(content.data)
    const plain = bundle['text/plain']
    if (content.found !== true || typeof plain !== 'string') return { found: false, text: null }
    return { found: true, text: plain.replace(ANSI, '') }
  }

  /**
   * Ask Jupyter whether the kernel is still there.
   *
   * This exists because the socket lies. When a kernel dies — culled for being
   * idle, OOM-killed by the container limit, segfaulted by a bad extension, or
   * simply deleted — Jupyter leaves the channels websocket **open**. No close
   * frame, no error, nothing. Measured, not assumed: delete a kernel out from
   * under a live socket and fifteen seconds later readyState is still 1.
   *
   * So a room whose kernel had died looked perfectly healthy. Status idle, no
   * message anywhere, and the next Run vanished into a socket connected to
   * nothing: the cell sat "running" for as long as anyone cared to watch, every
   * cell queued behind it waited on it, and the only way out was for somebody
   * to guess that Restart was the answer.
   *
   * One HTTP GET settles it. 404 means gone, and gone is a phase change the
   * rest of the server already knows how to handle.
   */
  private confirmAlive(expected = false): Promise<boolean> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      try {
        const res = await jupyterRequest(this.endpoint, `/api/kernels/${this.kernelId}`)
        if (res.status === 404) {
          this.setPhase('dead', expected)
          this.abortPending()
          return false
        }
        // Anything else — a hiccup, a 503, a timeout — is not evidence of
        // death, and declaring one falsely costs the room every variable it has.
        //
        // Evidence of life counts as having heard from it: a cell that thinks
        // for an hour in silence is then asked about once every QUIET_MS rather
        // than on every tick of the watchdog.
        this.lastHeard = Date.now()
        return true
      } catch {
        return true
      } finally {
        this.checking = null
      }
    })()
    return this.checking
  }

  /**
   * After Jupyter restarts the kernel on its own, wait for the new process.
   *
   * The new process announces itself to nobody: `idle` is only ever sent in
   * reply to a request, and no request is out. So the phase would have stayed
   * `restarting` for as long as anyone cared to look — it did, for minutes,
   * with a kernel that was perfectly idle behind it. One GET a second until
   * Jupyter reports the new process idle, then the phase follows. Gone in the
   * meantime (404, or five restarts in a row and Jupyter gave up) is death,
   * and death the rest of the server already knows how to handle.
   */
  private async awaitComeback(): Promise<void> {
    const deadline = Date.now() + COMEBACK_MS
    while (Date.now() < deadline) {
      if (this.disposed || this._phase !== 'restarting') return
      try {
        const res = await jupyterRequest(this.endpoint, `/api/kernels/${this.kernelId}`)
        if (res.status === 404) {
          this.setPhase('dead')
          return
        }
        if (res.ok) {
          const info = (await res.json()) as { execution_state?: string }
          if (info?.execution_state === 'idle') {
            this.lastHeard = Date.now()
            this.setPhase('idle')
            return
          }
        }
      } catch {
        // Jupyter itself is unreachable for a moment; keep asking.
      }
      await delay(COMEBACK_POLL_MS)
    }
    // Still not back: treat it as gone, so Restart is offered rather than a
    // status that never moves.
    if (!this.disposed && this._phase === 'restarting') this.setPhase('dead')
  }

  /**
   * Runs only while a cell is out with the kernel. A long computation is
   * allowed to be silent for hours; what is not allowed is silence from a
   * kernel that no longer exists.
   */
  private startWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (this.disposed || this._phase === 'dead') return
      if (this.pending.size === 0) {
        clearInterval(this.watchdog as NodeJS.Timeout)
        this.watchdog = null
        return
      }
      if (Date.now() - this.lastHeard < QUIET_MS) return
      void this.confirmAlive()
    }, WATCHDOG_MS)
    // A question about a kernel must never be the reason a process stays up.
    this.watchdog.unref?.()
  }

  /**
   * Let go of work that outlived the server.
   *
   * Re-attaching to a live kernel is the good half of a restart: everyone's
   * variables are still there. The bad half is a cell that was *running* when
   * the server went down. The kernel never stopped — it is still in
   * `time.sleep(600)` — and its output has nowhere to go, because the socket
   * that asked for it died with the old process. Meanwhile the kernel executes
   * strictly in order, so every Run anybody presses from now on queues silently
   * behind a cell nobody can see. The room looks alive and nothing happens.
   *
   * This is only ever called immediately after connecting, before this server
   * has sent the kernel a single request, so anything it is busy with is by
   * definition not ours and nobody is waiting on it. Returns whether it had to.
   */
  async releaseOrphanedWork(): Promise<boolean> {
    try {
      const res = await jupyterRequest(this.endpoint, `/api/kernels/${this.kernelId}`)
      if (!res.ok) return false
      const info = (await res.json()) as { execution_state?: string }
      if (info?.execution_state !== 'busy') return false
      await this.interrupt()
      return true
    } catch {
      // A kernel we cannot ask about is one we leave alone; the seminar is no
      // worse off than before, and Restart is still there.
      return false
    }
  }

  async interrupt(): Promise<void> {
    const res = await jupyterRequest(this.endpoint, `/api/kernels/${this.kernelId}/interrupt`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(tr("server.jupyterRefusedTheInterruptHttp.5ac00f", { p0: res.status }))
  }

  async restart(): Promise<void> {
    // `expected`: somebody pressed the button. The unexpected kind — Jupyter
    // restarting by itself after the OOM killer — arrives as a status frame in
    // handleFrame and is the one the room needs a sentence about.
    this.setPhase('restarting', true)
    // The kernel process is about to be replaced; nothing in flight can finish.
    this.abortPending()
    const res = await jupyterRequest(
      this.endpoint,
      `/api/kernels/${this.kernelId}/restart`,
      { method: 'POST' },
      60_000,
    )
    if (!res.ok) {
      this.setPhase('dead')
      throw new Error(tr("server.jupyterRefusedTheRestartHttp.6b7f4a", { p0: res.status }))
    }
    try {
      await this.waitForSocket(30_000)
    } catch (err) {
      this.setPhase('dead')
      throw new Error(tr("server.theKernelRestartedButItsChannelDid.4a7ee0", { p0: errText(err) }))
    }
    this.setPhase('idle')
  }

  /**
   * Let go of the kernel without ending it.
   *
   * Used when the server itself is stopping. The kernel is a process in
   * another container with every variable the room has built; a restart of the
   * server after a one-line edit must not cost the seminar its state. The
   * socket closes, the timers stop, and the next start re-attaches — which is
   * what the whole re-attach path was built for and what the README promises.
   */
  detach(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.length = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnecting = null
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.abortPending()
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      /* already gone */
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.listeners.length = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnecting = null
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.abortPending()
    this._phase = 'dead'
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      /* already gone */
    }
    try {
      await jupyterRequest(
        this.endpoint,
        `/api/sessions/${this.jupyterSessionId}`,
        { method: 'DELETE' },
        5000,
      )
    } catch (err) {
      console.error(
        `[kernel] could not delete jupyter session for ${this.sessionId}:`,
        errText(err),
      )
    }
  }

  /* ------------------------------------------------------------- internals */

  private channelsUrl(): string {
    const base = new URL(this.endpoint.url)
    const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
    const prefix = base.pathname.replace(/\/+$/, '')
    const query = new URLSearchParams({
      session_id: this.jupyterSessionId,
      token: this.endpoint.token,
    })
    return `${scheme}//${base.host}${prefix}/api/kernels/${this.kernelId}/channels?${query.toString()}`
  }

  private makeHeader(msgType: string): JupyterHeader {
    return {
      msg_id: crypto.randomUUID(),
      msg_type: msgType,
      session: this.jupyterSessionId,
      username: 'colloq',
      version: '5.3',
      date: new Date().toISOString(),
    }
  }

  private setPhase(phase: KernelPhase, expected = false): void {
    if (this._phase === phase) return
    this._phase = phase
    this._phaseExpected = expected
    for (const cb of [...this.listeners]) {
      try {
        cb(phase, expected)
      } catch (err) {
        console.error(`[kernel] phase listener failed for ${this.sessionId}:`, errText(err))
      }
    }
  }

  private openSocket(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket
      try {
        // The token rides in the query string for Jupyter's websocket handler and
        // in the header for reverse proxies that strip query strings.
        socket = new WebSocket(this.channelsUrl(), {
          headers: { Authorization: `token ${this.endpoint.token}` },
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.terminate()
        } catch {
          /* nothing to terminate */
        }
        reject(new Error(tr("server.noChannelAfterS.203466", { p0: Math.round(timeoutMs / 1000) })))
      }, timeoutMs)

      socket.on('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // The previous channel is closed here and now: two open sockets to one
        // kernel mean all of iopub twice, in every cell of the room.
        const previous = this.socket
        this.socket = socket
        this.reconnectAttempts = 0
        if (previous && previous !== socket) {
          try {
            previous.terminate()
          } catch {
            /* already closed */
          }
        }
        resolve()
      })
      socket.on('message', (data: RawData) => {
        // Frames from a socket that has already been replaced are an echo of the
        // previous channel: the same messages have come (or will come) over the
        // new one.
        if (this.socket !== socket) return
        this.handleFrame(data)
      })
      socket.on('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        const ours = this.socket === socket
        if (ours) this.socket = null
        if (!settled) {
          settled = true
          reject(new Error(tr("server.channelClosedBeforeItOpened.7a0657")))
          return
        }
        // The channel that closed is not ours but the one we replaced ourselves:
        // there is no reason to reconnect to it, a live one already exists.
        if (ours) this.scheduleReconnect()
      })
    })
  }

  /**
   * A dropped channel is a network hiccup, not a dead kernel: Jupyter keeps the
   * kernel and buffers its messages, so reconnecting resumes the run in flight
   * instead of costing the room a restart.
   */
  private scheduleReconnect(): void {
    if (this.disposed || this._phase === 'dead' || this.reconnectTimer || this.reconnecting) return
    const wait = Math.min(500 * 2 ** this.reconnectAttempts, 5000)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, wait)
  }

  private reconnect(): Promise<void> {
    if (this.disposed || this._phase === 'dead') return Promise.resolve()
    // One reconnect for everyone waiting on it, like the terminal's `opening`.
    if (this.reconnecting) return this.reconnecting
    const run = (async () => {
      let failure: unknown = null
      try {
        await this.openSocket(20_000)
      } catch (err) {
        failure = err
      }
      // Cleared BEFORE the next round: otherwise `scheduleReconnect` would see
      // itself, and the loop would stop at the very first failure.
      this.reconnecting = null
      if (failure === null) return
      if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        console.error(`[kernel] giving up on ${this.sessionId}:`, errText(failure))
        this.setPhase('dead')
        this.abortPending()
        return
      }
      this.scheduleReconnect()
    })()
    this.reconnecting = run
    return run
  }

  private async waitForSocket(timeoutMs = SOCKET_WAIT_MS): Promise<WebSocket> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.disposed) throw new Error(tr("server.theKernelConnectionWasClosed.e0bdcf"))
      if (this._phase === 'dead') throw new Error(tr("server.thePythonKernelIsNotRunning.a9cde2"))
      const socket = this.socket
      if (socket && socket.readyState === WebSocket.OPEN) return socket
      if (Date.now() >= deadline) throw new Error(tr("server.lostTheConnectionToThePythonKernel.c46ec2"))
      if (!socket && !this.reconnectTimer && !this.reconnecting) this.scheduleReconnect()
      await delay(SOCKET_POLL_MS)
    }
  }

  private handleFrame(data: RawData): void {
    this.lastHeard = Date.now()
    const text = frameText(data)
    if (text === null) return
    let msg: JupyterMessage
    try {
      msg = JSON.parse(text) as JupyterMessage
    } catch {
      return
    }

    const msgType = msg.header?.msg_type
    const content = msg.content ?? {}
    const parentId = msg.parent_header?.msg_id
    const pending = parentId ? this.pending.get(parentId) : undefined

    /*
     * A reply to a service request comes before everything else.
     *
     * Before, because below this the execution handling begins: the `status`
     * branch is in charge of phases, and everything after it silently falls
     * into `if (!pending) return`. `complete_reply` is not in `pending` and
     * must not be: it has no output and no closing idle worth waiting for.
     */
    const waiting = parentId ? this.shellPending.get(parentId) : undefined
    if (waiting && typeof msgType === 'string' && msgType.endsWith('_reply')) {
      this.shellPending.delete(parentId as string)
      clearTimeout(waiting.timer)
      waiting.resolve(content)
      return
    }

    if (msgType === 'status') {
      const state = content.execution_state
      /*
       * `restarting` is Jupyter's own word for "the process died and I am
       * bringing up another one" — the container's OOM killer, most often. It
       * keeps the kernel id and the socket, so nothing else here would notice:
       * the request that was running never gets its reply, and the room sat at
       * `busy` forever. Treating it as the death it is aborts the pending work,
       * drops the queue and tells the room why — the same path as a kernel that
       * vanished outright, because from the notebook's side it did.
       */
      if (state === 'restarting') {
        /*
         * Not `dead`. Jupyter keeps the kernel id and this socket and brings
         * the process back on its own — the next frames here are the new
         * process's `starting` and, once asked something, its `idle`. Calling
         * it dead made the room start a SECOND kernel against a Jupyter that
         * was already restarting the first, and left the status stuck on the
         * way. What is actually lost is the work in flight and every variable;
         * the phase says so, the pending work is aborted, and the room gets a
         * sentence from onPhase. The kernel object itself stays valid.
         */
        this.abortPending()
        this.setPhase('restarting')
        void this.awaitComeback()
        return
      }
      /*
       * Busy from a suggestion is not the room being busy.
       *
       * ipykernel publishes `busy` and `idle` around ANY shell request, not
       * only around an execution: `complete_request` and `inspect_request` get
       * them too, with their type in `parent_header`. While these were taken
       * for the phase, the kernel indicator blinked for the whole room on every
       * Latin letter any student typed, since the editor asks for completions
       * while you type (19 Sep 2026; typing in Russian did not blink: Cyrillic
       * is not an identifier, and no request goes out). The kernel has one
       * sequential shell, so a suggestion can neither start nor end in the
       * middle of someone else's cell: skipping its statuses, we lose no
       * execution phase. The only thing we take from it is the first `idle` of
       * a kernel that has just come up: it honestly says the kernel answers.
       */
      const parentType = msg.parent_header?.msg_type
      /*
       * And a run can be a service one too; then it is not the room being busy
       * either.
       *
       * The static help analysis (inspect-static.ts) is a real
       * `execute_request`: jedi lives in the kernel, and there is no other way
       * to ask it. But its cause is still the same, a hovering mouse, and the
       * indicator must not blink from it any more than from `inspect_request`
       * above. Such runs are recognised by the REQUEST, not by the message
       * type: the mark is set by whoever started the run (`execute`,
       * opts.quiet), and a frame from outside has no way to forge it.
       */
      const quiet =
        parentType === 'complete_request' ||
        parentType === 'inspect_request' ||
        pending?.quiet === true
      if (quiet) {
        // The only thing we take even from a service run: the first `idle` of a
        // kernel that has just come up, which honestly says the kernel answers.
        if (state === 'idle' && this._phase === 'starting') this.setPhase('idle')
      } else if (state === 'busy' || state === 'idle' || state === 'starting') {
        this.setPhase(state)
      }
      /*
       * But a service run is still obliged to CLOSE the wait: `idle` is the
       * second half of the handshake, without which `execute` never resolves
       * (maybeSettle). It is quiet for the room, not for whoever waits on it.
       */
      if (pending && state === 'idle') {
        pending.idle = true
        this.maybeSettle(parentId as string, pending)
      }
      return
    }

    /*
     * A request for input arrives on the stdin channel with the parent header
     * of the cell that asked. It is handled before the `pending` guard below
     * because there is nothing to settle: the cell is still running, and will
     * keep running only if somebody answers.
     */
    if (msgType === 'input_request') {
      this.awaitingInput = parentId ?? null
      pending?.handlers.onInputRequest?.(String(content.prompt ?? ''), content.password === true)
      return
    }

    if (msgType === 'execute_reply') {
      if (!pending) return
      const status = content.status
      pending.status = status === 'ok' || status === 'error' || status === 'abort' ? status : 'ok'
      /*
       * The answer to `user_expressions` comes before settle, like the help
       * below: after settle there is nowhere to write. The kernel does not
       * evaluate the expressions on a failed run and sends an empty object, so
       * emptiness here means "not confirmed", and the listener has to read it
       * exactly that way.
       */
      if (pending.handlers.onUserExpressions) {
        const values = content.user_expressions
        pending.handlers.onUserExpressions(
          values && typeof values === 'object' ? (values as Record<string, unknown>) : {},
        )
      }
      /*
       * `print?` prints nothing, and that is not a figure of speech.
       *
       * IPython turns `name?` into a help request, and the answer does not go
       * over iopub at all: no stream, no display_data, no execute_result. It
       * arrives here, in execute_reply, as the `payload` field, a piece that in
       * a real notebook opens as a "page" at the bottom of the window. We read
       * only the status from this message, so all the help went nowhere: a
       * person wrote `print?`, the cell finished in milliseconds and stayed
       * empty, as if the question mark meant nothing.
       *
       * We hand it over as ordinary output: inside is `text/plain` with ANSI
       * colouring, which our renderer already handles; tracebacks travel the
       * same road.
       *
       * Before settle: after it there is nowhere to write.
       */
      const payload = Array.isArray(content.payload) ? content.payload : []
      for (const item of payload) {
        const part = item as { source?: unknown; data?: unknown }
        // 'page' is `?`, `??`, %pinfo and %pdoc. The other kinds (set_next_input
        // from %load, ask_exit from exit()) change not the output but the
        // session state, and showing them as output would be untrue.
        if (part.source !== 'page') continue
        const bundle = toStringBundle(part.data)
        if (Object.keys(bundle).length > 0) pending.handlers.onData(bundle, null)
      }
      this.maybeSettle(parentId as string, pending)
      return
    }

    if (!pending) return
    const handlers = pending.handlers
    try {
      switch (msgType) {
        case 'stream':
          handlers.onStream(
            content.name === 'stderr' ? 'stderr' : 'stdout',
            String(content.text ?? ''),
          )
          break
        case 'execute_input':
          if (typeof content.execution_count === 'number')
            handlers.onExecuteInput(content.execution_count)
          break
        case 'execute_result':
        case 'display_data':
        case 'update_display_data':
          handlers.onData(
            toStringBundle(content.data),
            typeof content.execution_count === 'number' ? content.execution_count : null,
          )
          break
        case 'error':
          handlers.onError(
            String(content.ename ?? 'Error'),
            String(content.evalue ?? ''),
            toStringArray(content.traceback),
          )
          break
        case 'clear_output':
          /*
           * `wait` is not a trifle, contrary to the comment that used to be
           * here.
           *
           * It claimed the difference was invisible within the coalescing
           * window. The difference is exactly in how progress bars and widgets
           * are drawn: `while ...: clear_output(wait=True); print(frame)`
           * cleared the array immediately, while the replacement waited up to
           * config.outputFlushMs, and the room watched the animation blink
           * twenty times a second.
           */
          handlers.onClear(Boolean(content.wait))
          break
        default:
          break
      }
    } catch (err) {
      console.error(`[kernel] output handler failed for ${this.sessionId}:`, errText(err))
    }
  }

  /** A request is over only once the reply AND its closing idle have arrived. */
  private maybeSettle(msgId: string, pending: Pending): void {
    if (pending.status === null) return
    if (!pending.idle) {
      if (pending.graceTimer) return
      pending.graceTimer = setTimeout(() => {
        pending.idle = true
        this.maybeSettle(msgId, pending)
      }, IDLE_GRACE_MS)
      return
    }
    if (pending.graceTimer) clearTimeout(pending.graceTimer)
    this.pending.delete(msgId)
    pending.settle(pending.status)
  }

  private abortPending(): void {
    const inFlight = [...this.pending.entries()]
    this.pending.clear()
    for (const [, pending] of inFlight) {
      if (pending.graceTimer) clearTimeout(pending.graceTimer)
      pending.settle('abort')
    }
    /*
     * Service requests go in the same sweep.
     *
     * The process behind the socket changes (a restart, OOM), and a question
     * asked of the previous process will never be answered. Without this half a
     * completion would hang until its timeout (not for long, but for nothing),
     * and `dispose` would leave behind a promise nobody will ever touch.
     */
    const asked = [...this.shellPending.entries()]
    this.shellPending.clear()
    for (const [, waiting] of asked) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(tr("server.thePythonKernelIsNotRunning.a9cde2")))
    }
  }
}
