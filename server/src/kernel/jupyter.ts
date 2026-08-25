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

export interface ExecuteHandlers {
  onExecuteInput(execCount: number): void
  onStream(name: 'stdout' | 'stderr', text: string): void
  onData(mimebundle: Record<string, string>, execCount: number | null): void
  onError(ename: string, evalue: string, traceback: string[]): void
  onClear(): void
}

type ExecuteStatus = 'ok' | 'error' | 'abort'

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
const RECONNECT_MAX_ATTEMPTS = 8
/** iopub and shell are independent streams, so the reply can beat the final idle. */
const IDLE_GRACE_MS = 3000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function jupyterRequest(
  path: string,
  init?: { method?: string; body?: string },
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  return fetch(`${config.jupyter.url}${path}`, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: {
      Authorization: `token ${config.jupyter.token}`,
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

export class JupyterKernel {
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly listeners: Array<(phase: KernelPhase) => void> = []
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private disposed = false
  private _phase: KernelPhase = 'starting'

  private constructor(
    readonly sessionId: string,
    private readonly jupyterSessionId: string,
    private readonly kernelId: string,
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
  static async connect(sessionId: string): Promise<JupyterKernel> {
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
        const res = await jupyterRequest('/api/sessions', { method: 'POST', body })
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
        `No Python kernel after ${Math.round(STARTUP_TIMEOUT_MS / 1000)}s at ${config.jupyter.url} (${lastError}). Check that the jupyter service is running and reachable.`,
      )
    }

    const kernel = new JupyterKernel(sessionId, created.sessionId, created.kernelId)
    try {
      await kernel.openSocket(Math.max(10_000, deadline - Date.now()))
    } catch (err) {
      kernel._phase = 'dead'
      throw new Error(
        `The kernel started but its channel at ${config.jupyter.url} would not open (${errText(err)}).`,
      )
    }
    kernel.setPhase('idle')
    return kernel
  }

  onPhaseChange(cb: (phase: KernelPhase) => void): void {
    this.listeners.push(cb)
  }

  async execute(code: string, handlers: ExecuteHandlers): Promise<ExecuteStatus> {
    const socket = await this.waitForSocket()
    const header = this.makeHeader('execute_request')
    const frame = JSON.stringify({
      header,
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
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
    return done
  }

  async interrupt(): Promise<void> {
    const res = await jupyterRequest(`/api/kernels/${this.kernelId}/interrupt`, { method: 'POST' })
    if (!res.ok) throw new Error(`Jupyter refused the interrupt (HTTP ${res.status}).`)
  }

  async restart(): Promise<void> {
    this.setPhase('restarting')
    // The kernel process is about to be replaced; nothing in flight can finish.
    this.abortPending()
    const res = await jupyterRequest(`/api/kernels/${this.kernelId}/restart`, { method: 'POST' }, 60_000)
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

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.listeners.length = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
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
      await jupyterRequest(`/api/sessions/${this.jupyterSessionId}`, { method: 'DELETE' }, 5000)
    } catch (err) {
      console.error(`[kernel] could not delete jupyter session for ${this.sessionId}:`, errText(err))
    }
  }

  /* ------------------------------------------------------------- internals */

  private channelsUrl(): string {
    const base = new URL(config.jupyter.url)
    const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
    const prefix = base.pathname.replace(/\/+$/, '')
    const query = new URLSearchParams({
      session_id: this.jupyterSessionId,
      token: config.jupyter.token,
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

  private setPhase(phase: KernelPhase): void {
    if (this._phase === phase) return
    this._phase = phase
    for (const cb of [...this.listeners]) {
      try {
        cb(phase)
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
          headers: { Authorization: `token ${config.jupyter.token}` },
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
      if (state === 'busy' || state === 'idle' || state === 'starting') this.setPhase(state)
      if (pending && state === 'idle') {
        pending.idle = true
        this.maybeSettle(parentId as string, pending)
      }
      return
    }

    if (msgType === 'execute_reply') {
      if (!pending) return
      const status = content.status
      pending.status = status === 'ok' || status === 'error' || status === 'abort' ? status : 'ok'
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
          // `wait: true` means "clear when the next output arrives"; at the
          // writer's coalescing window the difference is imperceptible.
          handlers.onClear()
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
