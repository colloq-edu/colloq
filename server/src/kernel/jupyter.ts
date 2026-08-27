import crypto from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { config } from '../config.js'
import { sessionDir } from '../workspace.js'

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
  /** @param wait `clear_output(wait=True)` — стереть, когда будет чем заменить. */
  onClear(wait: boolean): void
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
    else if (Array.isArray(value)) out[mime] = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('')
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
 * Отвечает ли Jupyter — с коротким кешем, чтобы это можно было спрашивать часто.
 *
 * `/api/health` говорил `ok: true`, пока жив сам процесс, а `host.sh` и
 * `make status` ему верили. Docker выключен, вчерашний node ещё стоит — и
 * скрипт печатает «Colloq доступен по ссылке», после чего комната через
 * семьдесят секунд получает KERNEL DEAD. Проверка отвечает на настоящий
 * вопрос: сможет ли здесь запуститься Python.
 *
 * Кеш на пять секунд: проба ходит по сети, а зонды опрашивают health раз в
 * секунду и не должны каждым запросом дёргать Jupyter.
 */
let lastProbe: { at: number; ok: boolean; reason: string | null } | null = null

export async function jupyterReachable(): Promise<{ ok: boolean; reason: string | null }> {
  const now = Date.now()
  if (lastProbe && now - lastProbe.at < 5000) return { ok: lastProbe.ok, reason: lastProbe.reason }

  let ok = false
  let reason: string | null = null
  try {
    // /api/status — самая дешёвая ручка Jupyter, и она есть у всех его версий.
    const res = await jupyterRequest(defaultEndpoint(), '/api/status', undefined, 3000)
    ok = res.ok
    if (!ok) reason = `Jupyter answered ${res.status}`
  } catch (err) {
    reason = err instanceof Error ? `Jupyter is unreachable: ${err.message}` : 'Jupyter is unreachable'
  }
  lastProbe = { at: now, ok, reason }
  return { ok, reason }
}

export class JupyterKernel {
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly listeners: Array<(phase: KernelPhase, expected: boolean) => void> = []
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private disposed = false
  private _phase: KernelPhase = 'starting'
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
    /** Кому принадлежит это ядро: адрес контейнера окружения этой комнаты. */
    readonly endpoint: KernelEndpoint,
  ) {}

  get phase(): KernelPhase {
    return this._phase
  }

  /**
   * Bring up (or re-attach to) the kernel for a session.
   *
   * Going through the *sessions* API rather than /api/kernels is what makes the
   * kernel's cwd the session folder, so `open('data.csv')` in a cell finds what
   * the Files panel uploaded. It is also idempotent: Jupyter returns the
   * existing session for a path, so a server restart mid-seminar re-attaches to
   * the live kernel with everybody's variables still in it.
   */
  static async connect(sessionId: string, endpoint: KernelEndpoint): Promise<JupyterKernel> {
    sessionDir(sessionId)

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    const body = JSON.stringify({
      name: sessionId,
      path: `${sessionId}/session.ipynb`,
      type: 'notebook',
      kernel: { name: 'python3' },
    })

    let created: { sessionId: string; kernelId: string } | null = null
    let fatal: Error | null = null
    let lastError = 'no response'

    while (!created && !fatal && Date.now() < deadline) {
      try {
        const res = await jupyterRequest(endpoint, '/api/sessions', { method: 'POST', body })
        if (res.ok) {
          const parsed = (await res.json()) as { id?: string; kernel?: { id?: string } }
          if (parsed?.id && parsed.kernel?.id) {
            created = { sessionId: parsed.id, kernelId: parsed.kernel.id }
          } else {
            lastError = 'Jupyter returned a session with no kernel'
          }
        } else if (res.status === 401 || res.status === 403) {
          fatal = new Error(
            `Jupyter refused this server's credentials (HTTP ${res.status}). JUPYTER_TOKEN must match the token the Jupyter container was started with.`,
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
        `No Python kernel after ${Math.round(STARTUP_TIMEOUT_MS / 1000)}s at ${endpoint.url} (${lastError}). Check that the jupyter service is running and reachable.`,
      )
    }

    const kernel = new JupyterKernel(sessionId, created.sessionId, created.kernelId, endpoint)
    try {
      await kernel.openSocket(Math.max(10_000, deadline - Date.now()))
    } catch (err) {
      kernel._phase = 'dead'
      throw new Error(
        `The kernel started but its channel at ${endpoint.url} would not open (${errText(err)}).`,
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
   */
  async execute(
    code: string,
    handlers: ExecuteHandlers,
    opts?: { silent?: boolean },
  ): Promise<ExecuteStatus> {
    // A kernel that has been quiet since before the break may not be there any
    // more, and the socket will not say so. Between two cells run back to back
    // this is skipped, so it costs the seminar nothing where it is busiest.
    if (Date.now() - this.lastHeard > QUIET_MS && !(await this.confirmAlive(true))) {
      throw new Error('the Python kernel is not running')
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
        store_history: opts?.silent !== true,
        user_expressions: {},
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
      })
    })

    try {
      socket.send(frame)
    } catch (err) {
      this.pending.delete(header.msg_id)
      throw new Error(`Could not send the cell to the kernel (${errText(err)}).`)
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
    this.awaitingInput = null
    const socket = await this.waitForSocket()
    socket.send(
      JSON.stringify({
        header: this.makeHeader('input_reply'),
        parent_header: { msg_id: parent },
        metadata: {},
        content: { value },
        channel: 'stdin',
      }),
    )
    return true
  }

  /** True while a cell is stopped inside input(), waiting for a person. */
  get waitingForInput(): boolean {
    return this.awaitingInput !== null
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
    const res = await jupyterRequest(this.endpoint, `/api/kernels/${this.kernelId}/interrupt`, { method: 'POST' })
    if (!res.ok) throw new Error(`Jupyter refused the interrupt (HTTP ${res.status}).`)
  }

  async restart(): Promise<void> {
    // `expected`: somebody pressed the button. The unexpected kind — Jupyter
    // restarting by itself after the OOM killer — arrives as a status frame in
    // handleFrame and is the one the room needs a sentence about.
    this.setPhase('restarting', true)
    // The kernel process is about to be replaced; nothing in flight can finish.
    this.abortPending()
    const res = await jupyterRequest(this.endpoint, `/api/kernels/${this.kernelId}/restart`, { method: 'POST' }, 60_000)
    if (!res.ok) {
      this.setPhase('dead')
      throw new Error(`Jupyter refused the restart (HTTP ${res.status}).`)
    }
    try {
      await this.waitForSocket(30_000)
    } catch (err) {
      this.setPhase('dead')
      throw new Error(`The kernel restarted but its channel did not come back (${errText(err)}).`)
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
      await jupyterRequest(this.endpoint, `/api/sessions/${this.jupyterSessionId}`, { method: 'DELETE' }, 5000)
    } catch (err) {
      console.error(`[kernel] could not delete jupyter session for ${this.sessionId}:`, errText(err))
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
        reject(new Error(`no channel after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)

      socket.on('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket = socket
        this.reconnectAttempts = 0
        resolve()
      })
      socket.on('message', (data: RawData) => this.handleFrame(data))
      socket.on('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        if (this.socket === socket) this.socket = null
        if (!settled) {
          settled = true
          reject(new Error('channel closed before it opened'))
          return
        }
        this.scheduleReconnect()
      })
    })
  }

  /**
   * A dropped channel is a network hiccup, not a dead kernel: Jupyter keeps the
   * kernel and buffers its messages, so reconnecting resumes the run in flight
   * instead of costing the room a restart.
   */
  private scheduleReconnect(): void {
    if (this.disposed || this._phase === 'dead' || this.reconnectTimer) return
    const wait = Math.min(500 * 2 ** this.reconnectAttempts, 5000)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, wait)
  }

  private async reconnect(): Promise<void> {
    if (this.disposed || this._phase === 'dead') return
    try {
      await this.openSocket(20_000)
    } catch (err) {
      if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        console.error(`[kernel] giving up on ${this.sessionId}:`, errText(err))
        this.setPhase('dead')
        this.abortPending()
        return
      }
      this.scheduleReconnect()
    }
  }

  private async waitForSocket(timeoutMs = SOCKET_WAIT_MS): Promise<WebSocket> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.disposed) throw new Error('the kernel connection was closed')
      if (this._phase === 'dead') throw new Error('the Python kernel is not running')
      const socket = this.socket
      if (socket && socket.readyState === WebSocket.OPEN) return socket
      if (Date.now() >= deadline) throw new Error('lost the connection to the Python kernel')
      if (!socket && !this.reconnectTimer) this.scheduleReconnect()
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
      if (state === 'busy' || state === 'idle' || state === 'starting') this.setPhase(state)
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
      pending?.handlers.onInputRequest?.(
        String(content.prompt ?? ''),
        content.password === true,
      )
      return
    }

    if (msgType === 'execute_reply') {
      if (!pending) return
      const status = content.status
      pending.status = status === 'ok' || status === 'error' || status === 'abort' ? status : 'ok'
      /*
       * `print?` ничего не печатает — и это не фигура речи.
       *
       * IPython превращает `имя?` в запрос справки, и ответ на него не идёт
       * по iopub вовсе: ни stream, ни display_data, ни execute_result. Он
       * приезжает сюда, в execute_reply, полем `payload` — куском, который в
       * настоящем ноутбуке открывается «страницей» внизу окна. Мы читали из
       * этого сообщения один только status, так что вся справка отправлялась в
       * никуда: человек писал `print?`, ячейка отрабатывала за миллисекунды и
       * оставалась пустой, будто вопросительный знак ничего не значит.
       *
       * Отдаём его как обычный вывод: внутри `text/plain` с ANSI-раскраской,
       * которую наш рендер уже умеет — той же дорогой ходят трейсбеки.
       *
       * Раньше settle: после него писать уже некуда.
       */
      const payload = Array.isArray(content.payload) ? content.payload : []
      for (const item of payload) {
        const part = item as { source?: unknown; data?: unknown }
        // 'page' — это `?`, `??`, %pinfo и %pdoc. Остальные виды (set_next_input
        // от %load, ask_exit от exit()) меняют не вывод, а состояние сеанса, и
        // показывать их как вывод было бы неправдой.
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
          handlers.onStream(content.name === 'stderr' ? 'stderr' : 'stdout', String(content.text ?? ''))
          break
        case 'execute_input':
          if (typeof content.execution_count === 'number') handlers.onExecuteInput(content.execution_count)
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
           * `wait` — это не мелочь, вопреки прежнему комментарию здесь.
           *
           * Он утверждал, что на окне склейки разница незаметна. Разница ровно
           * в том, чем рисуются прогресс-бары и виджеты:
           * `while ...: clear_output(wait=True); print(frame)` очищал массив
           * немедленно, а замена ждала до config.outputFlushMs — и комната
           * смотрела, как анимация мигает раз двадцать в секунду.
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
  }
}
