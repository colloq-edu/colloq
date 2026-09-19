import { tr } from '@shared/i18n'
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
  /**
   * Ответ на `opts.userExpressions` — единственный способ услышать ядро молча.
   *
   * При `silent: true` в IOPUB не едет НИЧЕГО: ни stream, ни execute_result.
   * А `user_expressions` ядро считает и кладёт в `execute_reply` и в этом
   * случае тоже (ipykernel · IPythonKernel.do_execute) — если сам запуск
   * прошёл со статусом `ok`. Этим отчитывается вход консилиума
   * (council-isolation.ts), которому надо сказать серверу «копии готовы», не
   * написав в комнату ни строки.
   *
   * Значение каждого ключа — mimebundle вида `{status, data, metadata}`.
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
}

/** Ожидание одного `*_reply` по shell: ни вывода, ни рукопожатия с iopub. */
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
 * Сколько ждём ответа на служебный запрос по shell — дополнение и справку.
 *
 * Две с половиной секунды, и это не «на всякий случай». ipykernel разбирает
 * shell по одному сообщению за раз: пока считается ячейка, `complete_request`
 * просто стоит в очереди за ней и ответа не будет вовсе. Ждать его дольше
 * нечем — подсказка, приехавшая через минуту, это подсказка к тексту, который
 * человек давно дописал. Отказ по времени здесь — обычный исход, а не сбой.
 */
const SHELL_REQUEST_MS = 2500

/**
 * ANSI из `text/plain` справки.
 *
 * IPython раскрашивает вывод `?` даже тогда, когда его никто не просил: в
 * `inspect_reply` приезжает `\x1b[0;31mSignature:\x1b[0m` — и в подсказке над
 * кареткой это выглядит как мусор перед каждым словом. Тот же набор, что в
 * publish/render.ts: CSI, OSC и двухсимвольные.
 */
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

/** Одно дополнение: текст замены и то, чем jedi его считает. */
export interface CompleteMatch {
  text: string
  type: string | null
}

export interface CompleteResult {
  matches: CompleteMatch[]
  /** Границы куска, который замена собой заменяет, в знаках от начала кода. */
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
   * Служебные запросы по shell — отдельной картой от выполнений.
   *
   * Отдельной намеренно: у `pending` есть обработчики вывода и рукопожатие с
   * iopub («ответ ПЛЮС закрывающий idle»), а дополнению ни то ни другое не
   * нужно и вредно. `complete_reply` — это весь ответ целиком; ждать после
   * него ещё и idle значило бы держать подсказку лишние миллисекунды, а на
   * занятом ядре — не дождаться её никогда.
   */
  private readonly shellPending = new Map<string, ShellPending>()
  private readonly listeners: Array<(phase: KernelPhase, expected: boolean) => void> = []
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  /**
   * Переподключение, которое идёт прямо сейчас.
   *
   * Пока `reconnect()` ждёт `openSocket` (до двадцати секунд), `this.socket`
   * уже null, а таймер уже снят — то есть оба сторожа пусты, и `waitForSocket`,
   * опрашивающий состояние каждые сто миллисекунд из каждого `execute`, заводил
   * ВТОРОЕ переподключение, а за ним третье. Открывшиеся сокеты просто
   * присваивались поверх, старые оставались с живым `on('message')`, и iopub
   * приходил дважды: каждый `print` в комнате печатался по два раза до конца
   * жизни ядра. В terminal.ts этот же класс бед закрыт полем `opening`; здесь
   * он был открыт.
   */
  private reconnecting: Promise<void> | null = null
  private disposed = false
  private _phase: KernelPhase = 'starting'
  /** Просили ли мы сами о последней смене фазы; см. `phaseExpected`. */
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
    /** Кому принадлежит это ядро: адрес контейнера окружения этой комнаты. */
    readonly endpoint: KernelEndpoint,
  ) {}

  get phase(): KernelPhase {
    return this._phase
  }

  /**
   * Пришла ли текущая фаза по нашей просьбе.
   *
   * Различает две одинаковые снаружи вещи: `restarting` после нажатия Restart —
   * и `restarting`, которым Jupyter сообщает, что процесс убили (память). В
   * первом случае прерванная ячейка просто не доработала, во втором её убило
   * ядро, и сказать об этом должна она сама.
   */
  get phaseExpected(): boolean {
    return this._phaseExpected
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

    const kernel = new JupyterKernel(sessionId, created.sessionId, created.kernelId, endpoint)
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
   * the result in `Out`/`_`. Defaults to «not silent». Off for a council
   * attempt: the kernel is shared by the room, and anyone who can run a line
   * in it could otherwise read every attempt the teacher has run with
   * `In[-5:]` or `%history` — the one thing the council promises never happens.
   * @param opts.userExpressions выражения, которые ядро посчитает после кода и
   * вернёт в `execute_reply` — см. `ExecuteHandlers.onUserExpressions`.
   */
  async execute(
    code: string,
    handlers: ExecuteHandlers,
    opts?: { silent?: boolean; storeHistory?: boolean; userExpressions?: Record<string, string> },
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
     * Ожидание снимается ПОСЛЕ отправки, а не до.
     *
     * `waitForSocket` — это до сорока пяти секунд ожидания канала, и он умеет
     * бросить. Сброшенное заранее ожидание превращало такой бросок в тупик:
     * ядро всё ещё стоит в `input()`, а `waitingForInput` уже false — значит
     * каждое следующее «Send» молча получает `false`, приглашение висит у всей
     * комнаты, очередь стоит, и выход один — «остановить».
     */
    const socket = await this.waitForSocket()
    // Пока мы ждали канал, на приглашение мог ответить кто-то другой — в
    // семинаре это обычное дело, а не гонка.
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
   * Спросить ядро о чём-нибудь по shell — и дождаться ровно одного ответа.
   *
   * Мимо очереди выполнения, и это главное свойство. `execute` ставит ячейку в
   * общую очередь комнаты (kernel/index.ts · pump), где она ждёт своей минуты
   * за чужими; подсказка, доехавшая через минуту, не подсказка. Здесь запрос
   * уходит в провод сразу, а если ядро занято своей ячейкой — ответа не
   * приходит вовсе, и через SHELL_REQUEST_MS обещание отказывает. Это
   * НОРМАЛЬНЫЙ исход, а не сбой: ipykernel разбирает shell по одному, и пока
   * `time.sleep(60)` не кончится, ответить он не может.
   *
   * Канала нет — отказ сразу, без `waitForSocket`: тот ждёт до сорока пяти
   * секунд, и ждать их ради подсказки некому.
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
      // Вопрос о ядре не имеет права держать процесс живым — как и сторож выше.
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
   * Что можно дописать в этом месте кода — глазами самого ядра.
   *
   * Именно ядра, а не разбора текста в браузере: `df.` в тетради — это
   * настоящий DataFrame с настоящими методами, и список их знает только тот
   * процесс, где он лежит. Разбор текста знает слова этой же ячейки, и ими мы
   * подпираем ответ на клиенте, когда ядра нет.
   *
   * `types` — из `metadata._jupyter_types_experimental`: ipykernel кладёт туда
   * то, чем jedi считает каждое совпадение («function», «instance», «module»).
   * Поле экспериментальное больше десяти лет и есть не у всех ядер, поэтому
   * его отсутствие — не ошибка, а просто список без значков.
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
   * Справка о том, что стоит под кареткой: сигнатура и начало docstring.
   *
   * То же, что делает `имя?` в ячейке, только ответ не печатается в вывод, а
   * едет вызвавшему. `detail_level` 0 — сигнатура и документация, 1 — ещё и
   * исходник; для подсказки над скобкой хватает нуля.
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
        // Предыдущий канал закрывается здесь и сейчас: два открытых сокета к
        // одному ядру — это весь iopub дважды, в каждой ячейке комнаты.
        const previous = this.socket
        this.socket = socket
        this.reconnectAttempts = 0
        if (previous && previous !== socket) {
          try {
            previous.terminate()
          } catch {
            /* уже закрыт */
          }
        }
        resolve()
      })
      socket.on('message', (data: RawData) => {
        // Кадры сокета, который уже сменили, — эхо прошлого канала: те же
        // сообщения уже пришли (или придут) по новому.
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
        // Закрылся не наш канал — тот, что мы сами и сменили: переподключаться
        // к нему незачем, живой уже есть.
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
    // Одно переподключение на всех, кто его ждёт, — как `opening` у терминала.
    if (this.reconnecting) return this.reconnecting
    const run = (async () => {
      let failure: unknown = null
      try {
        await this.openSocket(20_000)
      } catch (err) {
        failure = err
      }
      // Снимается ДО следующего захода: иначе `scheduleReconnect` увидел бы
      // самого себя и круг остановился бы на первой же неудаче.
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
     * Ответ на служебный запрос — раньше всего остального.
     *
     * Раньше, потому что ниже начинается разбор выполнения: ветка `status`
     * отвечает за фазы, а всё, что после неё, молча уходит в `if (!pending)
     * return`. `complete_reply` в `pending` не лежит и лежать не должен — у
     * него нет ни вывода, ни закрывающего idle, которого стоило бы ждать.
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
       * Занятость от подсказки — не занятость комнаты.
       *
       * ipykernel публикует `busy` и `idle` вокруг ЛЮБОГО запроса по shell, не
       * только вокруг выполнения: у `complete_request` и `inspect_request` они
       * такие же, и в `parent_header` стоит их тип. Пока их принимали за фазу,
       * индикатор ядра моргал у всей комнаты на каждую латинскую букву любого
       * студента — редактор спрашивает дополнение по мере набора (19.09.2026;
       * по-русски не моргало: кириллица — не идентификатор, и запрос не
       * уходит). Shell у ядра один и последовательный, так что подсказка не
       * может ни начаться, ни кончиться посреди чужой ячейки: пропуская её
       * статусы, фазу выполнения мы не теряем. Единственное, что от неё
       * берём, — первый `idle` только что поднятого ядра: он честно говорит,
       * что ядро отвечает.
       */
      const parentType = msg.parent_header?.msg_type
      if (parentType === 'complete_request' || parentType === 'inspect_request') {
        if (state === 'idle' && this._phase === 'starting') this.setPhase('idle')
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
      pending?.handlers.onInputRequest?.(String(content.prompt ?? ''), content.password === true)
      return
    }

    if (msgType === 'execute_reply') {
      if (!pending) return
      const status = content.status
      pending.status = status === 'ok' || status === 'error' || status === 'abort' ? status : 'ok'
      /*
       * Ответ на `user_expressions` — до settle, как и справка ниже: после
       * него писать уже некуда. Ядро не считает выражения на упавшем запуске
       * и присылает пустой объект — значит пустота здесь означает «не
       * подтверждено», и слушатель обязан читать её именно так.
       */
      if (pending.handlers.onUserExpressions) {
        const values = content.user_expressions
        pending.handlers.onUserExpressions(
          values && typeof values === 'object' ? (values as Record<string, unknown>) : {},
        )
      }
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
    /*
     * Служебные запросы — тем же движением.
     *
     * Процесс за сокетом меняется (перезапуск, OOM), и ответа на вопрос,
     * заданный прошлому процессу, не будет никогда. Без этой половины
     * дополнение висело бы до своего таймаута — недолго, но на ровном месте, а
     * `dispose` оставлял бы после себя обещание, которое никто не тронет.
     */
    const asked = [...this.shellPending.entries()]
    this.shellPending.clear()
    for (const [, waiting] of asked) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(tr("server.thePythonKernelIsNotRunning.a9cde2")))
    }
  }
}
