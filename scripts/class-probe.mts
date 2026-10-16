/**
 * class-probe.mts: what relay2 does to one byte tunnel, measured before the
 * tunnel is built (docs/architecture/remote-classes.md §17.5, phase K0).
 *
 * Classes on machines pipe every kernel's bytes through one WebSocket that
 * the machine dials to home, through relay2: Caddy, frps, and the single TCP
 * leg to home's frpc that every student's socket already shares. Until this
 * runs, the design's constants are guesses (D30): the ping interval, the
 * windows, the class bulk and competition rates, the machine's pacing, the
 * help pads, and whether resumable streams (K3b) are worth building. The
 * probe plays both ends with nothing but Node and ws. Its home speaks the
 * tunnel's frame header (§4.3) and keeps the tunnel's rules (§4.4): strict
 * lanes, deficit round-robin inside a lane, a send buffer of 64 KiB at most,
 * windows and the ACK cadence. Its machine runs the plan below against it.
 * One thing is turned around: the dialling machine opens the streams here,
 * because it is the side that runs the plan; in the design only home does.
 *
 * MODES
 *
 *   home      Three doors on --port (3999), bound to --bind (127.0.0.1,
 *             where frpc connects). Each wants `Authorization: Bearer
 *             $PROBE_TOKEN` and refuses anything else with a marked 401:
 *               /probe/tunnel  WebSocket. Streams multiplexed in §4.3 frames
 *                              to four services: echo, sink (counts and
 *                              ACKs), source (N bytes at a rate), trickle (a
 *                              tqdm-sized line at a steady rate, both ways)
 *               /probe/echo    WebSocket that sends every message back: a
 *                              browser's collaboration socket
 *               /probe/blob    GET ?bytes=N&rate=MiBps&pacing=paced|bursty
 *                              streams N bytes; PUT counts what it is sent
 *             One JSON line on stdout per connection, stream and blob.
 *
 *   machine   Dials HOST and runs the plan, --steps (1,2,3,4,6,9), numbered
 *             as §17.5 numbers them:
 *               1 RTT     a tunnel echo and an echo socket at --hz (1) for
 *                         --minutes (10): p50, p95, p99, the longest gap
 *               2 RATE    1, 2 and 4 streams through the tunnel both ways,
 *                         and 1, 2 and 4 HTTP blobs, GET and PUT, for
 *                         --tp-seconds (8) each: per stream, or per box?
 *               3 BULK    echo RTT on the interactive lane and on the echo
 *                         socket while --bulk-bytes (150MB) moves by HTTP
 *                         (--bulk-dir down: home to machine) at --rates
 *                         (8,4,2) MiB/s, each paced and unpaced, then with
 *                         no limit at all
 *               4 FIGURE  one --figure-bytes (2MB) output through the tunnel:
 *                         idle, during bulk at --bulk-rate (4) and with no
 *                         limit, up (the figure's own way, by PUT) and then
 *                         down, and against a council-lane flood; beside
 *                         each time, what the machine's bucket held
 *               6 IDLE    tunnels and echo sockets left silent for --idle
 *                         (20,40,70) s, no pings at either end: alive,
 *                         closed, or a black hole?
 *               9 FRAMES  --frame-bytes (1MiB) both ways on the echo socket
 *                         and through a tunnel stream (PMTU: relay2 caps its
 *                         routes' MTU, relay-setup.sh)
 *             Progress on stderr, a table on stdout, the JSON to --out.
 *             --pace (6) is the machine's bucket on lanes 1-2 in steps 3-4;
 *             0 turns it off, to see what it buys. --window (1MiB) is an
 *             interactive stream's window; a council stream gets half. ws
 *             sets TCP_NODELAY at both ends. With --pace 0, a council flood
 *             can still queue a figure behind the kernel's own send buffer,
 *             which the 64 KiB rule does not reach; on Linux, sysctl
 *             net.ipv4.tcp_notsent_lowat=131072 on the machine bounds it.
 *
 *   watch     Keeps --tunnels (1) tunnels up with pings every 10 s and a
 *             --trickle-hz (10) line each way, and --sockets (0) echo
 *             sockets. Reconnects with the design's backoff, waited out
 *             after a drop too, and logs every drop, stall and return as a
 *             JSON line: when, the gap, the wait, and the bytes a cut ate
 *             each way (home keeps the counters of a tunnel it lost and
 *             hands them to the one that replaces it; a drop line carries
 *             this end's, so the sum can be redone from the log). This is
 *             the probe for the operator's steps: iptables cuts of 10, 60
 *             and 300 s while it runs and resets per hour on an idle tunnel
 *             (step 5, --trickle-hz 0 for idle), three tunnels and thirty
 *             sockets against frpc's pool (step 7: --tunnels 3 --sockets 30,
 *             then count "work connection pool is full" in frps's log), and
 *             an frps restart on the lab relay (step 9). The JSON lines go to
 *             stdout; --minutes (0: until Ctrl-C) ends it with a table on
 *             stderr and the JSON summary to --out.
 *
 *   selftest  The scheduler on a stand-in socket (lanes, turns, the 64 KiB
 *             rule, windows, ACKs) and Ctrl-C on stand-ins, then home and a
 *             short plan in this one process on 127.0.0.1, steps Ctrl-C
 *             breaks off, and a watch through two cuts. Every check counts
 *             what happened, none times anything. Exits 0 or 1.
 *
 * Step 8, the collaboration RTT of a real browser, is headless Chrome's; the
 * echo socket of steps 1 and 3 stands in for it from the machine's side.
 *
 * WHERE IT RUNS
 *
 * Never against vsos and never during a class: relay2 is shared, and step 3
 * alone moves a gigabyte. Stop only your own pids.
 *
 *   On H, the lab home behind relay2:
 *     export PROBE_TOKEN=$(openssl rand -hex 24)
 *     node scripts/class-probe.mts home > probe-home.jsonl &
 *   and an frpc of its own under a test name, its file written the way
 *   scripts/host.sh writes one (the relay's secret in the file, never in
 *   the arguments):
 *     serverAddr = "<relay2>"
 *     serverPort = 7000
 *     auth.method = "token"
 *     auth.token = "<RELAY_TOKEN>"
 *     transport.poolCount = 5
 *     [[proxies]]
 *     name = "probe-lab"
 *     type = "http"
 *     localIP = "127.0.0.1"
 *     localPort = 3999
 *     subdomain = "probe-lab"
 *
 *   On C, G and U, with the same token:
 *     node scripts/class-probe.mts machine --host probe-lab.colloq.ru --out k0-C.json
 *     node scripts/class-probe.mts watch --host probe-lab.colloq.ru --out k0-C-watch.json
 *   and step 3 again the other way, for class uploads (§4.9):
 *     node scripts/class-probe.mts machine --host probe-lab.colloq.ru --steps 3 --bulk-dir up --out k0-C-up.json
 *
 * HOST is a name (then wss:// and https://), or a URL such as
 * http://127.0.0.1:3999 for a probe on the same box. The probe dials
 * directly: unlike the agent, it does not read HTTPS_PROXY.
 *
 * A bare VM needs Node 22 and ws, nothing more. Type stripping is on by
 * default from Node 22.18 (an older 22.x: node --experimental-strip-types).
 * ws has no dependencies of its own, so a copy of it next to the script
 * resolves:
 *     scp scripts/class-probe.mts vm:probe/ && scp -r node_modules/ws vm:probe/node_modules/
 * Without Node on the VM, the same folder runs in Node's image, on the
 * machine's own network as the agent runs (D19):
 *     docker run --rm --network host -e PROBE_TOKEN -v "$PWD/probe:/probe" -w /probe \
 *       node:22-bookworm-slim node class-probe.mts machine --host …
 *
 * Ctrl-C prints and writes what was measured so far; a second one leaves at
 * once.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { STATUS_CODES, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createConnection, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { parseArgs } from 'node:util'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

/* ------------------------------------------------------------- the numbers */

const KiB = 1024
const MiB = 1024 * KiB
const PROTOCOL = 1

const DOORS = { tunnel: '/probe/tunnel', echo: '/probe/echo', blob: '/probe/blob' } as const
/** On every answer of the probe's own: a relay's page (frps's 404 for a name with no client) lacks it. */
const MARKER = 'x-colloq-probe'

// The tunnel as remote-classes.md §4.2-4.7 draws it.
const HEADER_BYTES = 16
const DATA_MAX = 16 * KiB
const JSON_MAX = 4 * KiB
const TUNNEL_MAX_PAYLOAD = 64 * KiB
const SEND_LOWAT = 64 * KiB
const QUANTUM = 16 * KiB
const STREAM_WINDOW = 1 * MiB
const TUNNEL_WINDOW = 16 * MiB
const ACK_MS = 50
const ACK_BYTES = 64 * KiB
const PING_MS = 10_000
const DEAD_MS = 25_000
const PACE_BURST = 2 * MiB
const MAX_STREAMS = 512

// The probe's own.
const ECHO_MAX_PAYLOAD = 8 * MiB
const BLOB_MAX = 4 * 1024 * MiB
const BLOB_CHUNK = 64 * KiB
/** A paced bulk bucket holds two chunks: a timer that fires late keeps the credit it earned, so the rate is the one asked. */
const BULK_BURST = 2 * BLOB_CHUNK
const CONNECT_MS = 10_000
const REPLY_MS = 10_000
const SILENT_MS = 30_000
const BIG_MS = 30_000
const FIGURE_MS = 60_000
/** A connection up this long starts the backoff over when it drops; one that dies younger keeps it growing. */
const STEADY_MS = 30_000
/** How long a refused upgrade's client has to read the answer before home hangs up on it. */
const REFUSED_GRACE_MS = 1000
const IDLE_CAP_MS = 10 * 60_000
const MAX_TUNNELS = 64
const MAX_SOCKETS = 256
const PROBE_BYTES = 64
const TRICKLE_BYTES = 200

const KIND = { HELLO: 1, WELCOME: 2, OPEN: 3, OPENED: 4, REFUSED: 5, DATA: 6, ACK: 7, END: 8, RESET: 9, PING: 10, PONG: 11 } as const
const KIND_NAMES = ['', 'HELLO', 'WELCOME', 'OPEN', 'OPENED', 'REFUSED', 'DATA', 'ACK', 'END', 'RESET', 'PING', 'PONG']
const JSON_KINDS: ReadonlySet<number> = new Set([KIND.HELLO, KIND.WELCOME, KIND.OPEN, KIND.REFUSED])
const LANES = [1, 2] as const

/** Every byte the probe moves comes from here: incompressible, so nothing on the path gains by compressing it. */
const FILLER = randomBytes(BLOB_CHUNK)
const EMPTY = Buffer.alloc(0)

type Lane = 1 | 2
type Pacing = 'paced' | 'bursty'
type Log = (event: string, fields?: Record<string, unknown>) => void

interface Target {
  tls: boolean
  origin: string
  wsOrigin: string
  label: string
  token: string
}

interface Frame {
  kind: number
  lane: number
  stream: number
  offset: number
  payload: Buffer
}

/** How a connection ended, from the side that saw it end. */
interface Closed {
  by: 'local' | 'peer' | 'dead' | 'error' | 'protocol' | 'replaced'
  code: number
  reason: string
  upMs: number
  /** Since the last frame or message arrived. */
  quietMs: number
}

/* ---------------------------------------------------------------- helpers */

const round = (value: number, digits = 1): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const toBuffer = (raw: RawData): Buffer => (Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw))
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const mibps = (bytes: number, ms: number): number | null => (ms > 0 ? round(bytes / MiB / (ms / 1000), 2) : null)
const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
const numberIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
/** A rate in MiB/s: 0 for none, or at least 0.1, where a bucket's second still holds a whole chunk. */
const rateIn = (value: unknown): number | null => {
  const rate = numberIn(value, 0, 10_000)
  return rate === null || (rate > 0 && rate < 0.1) ? null : rate
}
const pacingIn = (value: unknown): Pacing | null => (value === undefined || value === null || value === 'paced' ? 'paced' : value === 'bursty' ? 'bursty' : null)

let lastSeq = 0
/** Probe numbers shared by every path, so a late echo can never be taken for another's. Never 0. */
const nextSeq = (): number => (lastSeq = lastSeq >= 0xfffffffe ? 1 : lastSeq + 1)

const MAX_DELAY = 2 ** 31 - 1

/** Resolves after `ms`, or at once when the signal fires. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted || ms <= 0) return done()
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      done()
    }
    const timer = setTimeout(finish, Math.min(ms, MAX_DELAY))
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** One turn of the event loop: whatever was rejected without a handler has been reported by then. */
const nextTurn = (): Promise<void> => new Promise((done) => setImmediate(done))

/**
 * `promise`'s value, or null after `ms` or when the signal fires; the timer
 * never outlives it. Once given up on, the promise may still reject: that
 * rejection is handled here, never left to crash the probe.
 */
function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      promise.catch(() => {})
      return resolve(null)
    }
    const timer = Number.isFinite(ms) ? setTimeout(() => settle(null), Math.max(0, Math.min(ms, MAX_DELAY))) : null
    const onAbort = (): void => settle(null)
    const clean = (): void => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (value: T | null): void => {
      clean()
      resolve(value)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(settle, (error: unknown) => {
      clean()
      reject(error)
    })
  })
}

/* ----------------------------------------------------------------- frames */

/**
 * §4.3: u8 kind · u8 flags · u8 lane · u8 reserved · u32 stream · u64
 * offset · payload, numbered and laid out as shared/remote-tunnel.ts does it
 * (a stream's ACK, END and RESET carry its lane), which the probe does not
 * import, so that it runs from a bare folder. The flags stay 0 here: END
 * closes a direction, and no DATA carries FIN.
 */
function encodeFrame(kind: number, lane: number, stream: number, offset: number, payload: Buffer = EMPTY): Buffer {
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  frame[0] = kind
  frame[1] = 0
  frame[2] = lane
  frame[3] = 0
  frame.writeUInt32BE(stream, 4)
  frame.writeUInt32BE(Math.floor(offset / 2 ** 32), 8)
  frame.writeUInt32BE(offset % 2 ** 32, 12)
  payload.copy(frame, HEADER_BYTES)
  return frame
}

/** A frame, or why the bytes are not one. */
function decodeFrame(data: Buffer): Frame | string {
  if (data.length < HEADER_BYTES) return `a frame of ${data.length} bytes`
  const kind = data[0]
  if (kind < KIND.HELLO || kind > KIND.PONG) return `unknown kind ${kind}`
  const lane = data[2]
  if (lane > 2) return `lane ${lane}`
  const payload = data.subarray(HEADER_BYTES)
  const cap = kind === KIND.DATA ? DATA_MAX : JSON_KINDS.has(kind) ? JSON_MAX : 0
  if (payload.length > cap) return `${KIND_NAMES[kind]} with ${payload.length} bytes`
  return { kind, lane, stream: data.readUInt32BE(4), offset: data.readUInt32BE(8) * 2 ** 32 + data.readUInt32BE(12), payload }
}

function jsonBytes(value: Record<string, unknown>): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length > JSON_MAX) throw new Error(`a control payload of ${bytes.length} bytes`)
  return bytes
}

function jsonOfText(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/* ----------------------------------------------------------------- pacing */

/**
 * A token bucket over bytes. `paced` refills all the time, so a sender at
 * rate R spends it in chunks spread over the second. `bursty` hands out the
 * whole second's R at the top of each second, to be sent at line speed: the
 * same average, the way a per-second quota delivers it ("unpaced", §17.5).
 */
class Bucket {
  private readonly rate: number
  private readonly burst: number
  private readonly mode: Pacing
  private readonly origin = performance.now()
  private tokens: number
  private stamp: number
  private second = 0

  constructor(bytesPerSecond: number, burst: number, mode: Pacing = 'paced') {
    this.rate = bytesPerSecond
    this.mode = mode
    this.burst = mode === 'bursty' ? bytesPerSecond : burst
    this.tokens = this.burst
    this.stamp = this.origin
  }

  /** Milliseconds until `bytes` may go; 0 means now, and the caller spends them. */
  waitMs(bytes: number): number {
    const now = performance.now()
    const want = Math.min(bytes, this.burst)
    this.refill(now)
    if (this.mode === 'bursty') return this.tokens >= want ? 0 : Math.ceil(1000 - ((now - this.origin) % 1000)) + 1
    return this.tokens >= want ? 0 : Math.max(1, Math.ceil(((want - this.tokens) * 1000) / this.rate))
  }

  spend(bytes: number): void {
    this.tokens -= bytes
  }

  /** The bytes that may go now, unspent. */
  level(): number {
    this.refill(performance.now())
    return this.tokens
  }

  private refill(now: number): void {
    if (this.mode === 'bursty') {
      const second = Math.floor((now - this.origin) / 1000)
      if (second !== this.second) {
        this.second = second
        this.tokens = this.burst
      }
      return
    }
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.stamp) * this.rate) / 1000)
    this.stamp = now
  }
}

/** §4.6: 0.5 s doubling to 5 s for five tries, then the 0.23 Backoff, 1 to 30 s with jitter. */
class Backoff {
  private failures = 0

  next(): number {
    this.failures = Math.min(this.failures + 1, 30)
    if (this.failures <= 5) return Math.min(5000, 500 * 2 ** (this.failures - 1))
    const ceiling = Math.min(30_000, 1000 * 2 ** (this.failures - 5))
    return Math.round(1000 + Math.random() * (ceiling - 1000))
  }

  reset(): void {
    this.failures = 0
  }
}

/* ----------------------------------------------------------------- tunnel */

/** One multiplexed stream: both directions, each with its own offsets. */
class Stream {
  readonly id: number
  readonly lane: Lane
  readonly window: number
  readonly openedAt = performance.now()
  // Sending: queued bytes first, then `generate` bytes of filler at the producer's rate.
  queue: Buffer[] = []
  queued = 0
  generate = 0
  producer: Bucket | null = null
  tx = 0
  acked = 0
  endWanted = false
  endSent = false
  // Receiving.
  rx = 0
  consumed = 0
  ackSent = 0
  ackTimer: ReturnType<typeof setTimeout> | null = null
  peerEnded = false
  closed = false
  /** An echo's input leaves as its output, and is ACKed as it leaves: the echo's backpressure. */
  echo = false
  deficit = 0
  turn = false
  onData: ((chunk: Buffer) => void) | null = null
  onAck: ((acked: number) => void) | null = null
  onEnd: (() => void) | null = null
  onClose: ((why: string) => void) | null = null

  constructor(id: number, lane: Lane, window: number) {
    this.id = id
    this.lane = lane
    this.window = window
  }
}

interface TunnelSetup {
  role: 'home' | 'machine'
  /** The machine's bucket on lanes 1-2 (§4.4); home sends unthrottled. */
  pace: Bucket | null
  windows: Record<Lane, number>
  totalWindow: number
}

/**
 * One end of the tunnel, the same code at both: frames in and out, the
 * streams, and the sender of §4.4. A frame goes to the socket only while ws
 * holds at most SEND_LOWAT unsent bytes; everything else waits in the
 * streams' queues, where control goes first, then lane 1, then lane 2, and
 * the streams of a lane take deficit round-robin turns of QUANTUM. A sender
 * stays within its window of the peer's ACK, per stream and in all, and a
 * receiver ACKs every ACK_BYTES or ACK_MS.
 */
class Tunnel {
  readonly ws: WebSocket
  readonly role: 'home' | 'machine'
  readonly openedAt = performance.now()
  readonly streams = new Map<number, Stream>()
  /** PING round trips, ms. */
  readonly rtts: number[] = []
  readonly closed: Promise<Closed>
  id = ''
  welcomed: Record<string, unknown> | null = null
  lastFrameAt = performance.now()
  framesIn = 0
  framesOut = 0
  bytesIn = 0
  bytesOut = 0
  onHello: ((hello: Record<string, unknown>) => void) | null = null
  onOpen: ((frame: Frame, request: Record<string, unknown>) => void) | null = null
  private readonly setup: TunnelSetup
  private greeted = false
  private readonly control: Buffer[] = []
  private readonly rotation: Record<Lane, Stream[]> = { 1: [], 2: [] }
  private readonly cursor: Record<Lane, number> = { 1: 0, 2: 0 }
  private inflight = 0
  private pumping = false
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private wakeAt = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private deadTimer: ReturnType<typeof setInterval> | null = null
  private pingSeq = 0
  private readonly pings = new Map<number, number>()
  private nextStream = 1
  private readonly opening = new Map<number, { resolve(): void; reject(error: Error): void }>()
  private greeting: { resolve(welcome: Record<string, unknown>): void; reject(error: Error): void } | null = null
  private ending: Closed['by'] | null = null
  private failure = ''
  private settle: (closed: Closed) => void = () => {}
  private readonly afterSend = (error?: Error): void => {
    if (!error) this.pump()
  }

  constructor(ws: WebSocket, setup: TunnelSetup) {
    this.ws = ws
    this.role = setup.role
    this.setup = { ...setup, windows: { ...setup.windows } }
    this.closed = new Promise((resolve) => (this.settle = resolve))
    ws.on('message', (data, binary) => this.receive(data, binary))
    ws.on('error', (error) => {
      this.failure ||= error.message
      this.ending ??= 'error'
    })
    ws.on('close', (code, reason) => this.finish(code, reason.toString()))
  }

  /* ---- the handshake and liveness */

  /** The machine's HELLO, and the WELCOME that answers it. */
  hello(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the tunnel is not open'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.greeting = null
        reject(new Error(`no WELCOME in ${REPLY_MS / 1000} s`))
        this.kill('local')
      }, REPLY_MS)
      this.greeting = {
        resolve: (welcome) => {
          clearTimeout(timer)
          resolve(welcome)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.queueControl(encodeFrame(KIND.HELLO, 0, 0, 0, jsonBytes(fields)))
    })
  }

  /** Home's answer to a HELLO it took, with the windows the machine asked for. */
  welcome(fields: Record<string, unknown>, windows: Record<Lane, number>, totalWindow: number): void {
    this.setup.windows = { ...windows }
    this.setup.totalWindow = totalWindow
    this.queueControl(encodeFrame(KIND.WELCOME, 0, 0, 0, jsonBytes(fields)))
  }

  /** §4.7: a PING every `pingMs`, and the end after `deadMs` with no frame at all. 0 turns either off. */
  liveness(pingMs: number, deadMs: number): void {
    if (pingMs > 0) this.pingTimer = setInterval(() => this.ping(), pingMs)
    if (deadMs > 0) {
      this.deadTimer = setInterval(() => {
        if (performance.now() - this.lastFrameAt > deadMs) this.kill('dead')
      }, Math.min(1000, Math.max(50, deadMs / 5)))
    }
  }

  ping(): void {
    const seq = ++this.pingSeq
    this.pings.set(seq, performance.now())
    if (this.pings.size > 64) this.pings.delete(this.pings.keys().next().value as number)
    this.queueControl(encodeFrame(KIND.PING, 0, 0, seq))
  }

  /* ---- streams */

  /** The machine opens a stream to one of home's services. */
  open(service: string, lane: Lane, params: Record<string, unknown> = {}): Promise<Stream> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`the tunnel is not open for ${service}`))
    const id = this.nextStream
    this.nextStream += 2
    const stream = this.addStream(id, lane)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opening.delete(id)
        this.forget(stream, 'no answer to OPEN')
        reject(new Error(`no answer to OPEN ${service} in ${REPLY_MS / 1000} s`))
      }, REPLY_MS)
      this.opening.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve(stream)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.queueControl(encodeFrame(KIND.OPEN, lane, id, 0, jsonBytes({ service, ...params })))
    })
  }

  /** Home takes a stream the machine opened. */
  accept(id: number, lane: Lane): Stream {
    const stream = this.addStream(id, lane)
    this.queueControl(encodeFrame(KIND.OPENED, lane, id, 0))
    return stream
  }

  refuse(id: number, lane: number, code: string): void {
    this.queueControl(encodeFrame(KIND.REFUSED, lane, id, 0, jsonBytes({ code })))
  }

  write(stream: Stream, chunk: Buffer): void {
    if (stream.closed || stream.endWanted || chunk.length === 0) return
    stream.queue.push(chunk)
    stream.queued += chunk.length
    this.pump()
  }

  /** END after whatever is queued or still to generate. */
  end(stream: Stream): void {
    if (stream.closed || stream.endWanted) return
    stream.endWanted = true
    this.maybeEnd(stream)
  }

  reset(stream: Stream): void {
    if (stream.closed) return
    this.queueControl(encodeFrame(KIND.RESET, stream.lane, stream.id, 0))
    this.forget(stream, 'reset here')
  }

  /** After `generate` or a producer changed: let the sender look again. */
  kick(): void {
    this.pump()
  }

  /** What the bucket on lanes 1-2 holds now, bytes; null when this end is unpaced. */
  paceLevel(): number | null {
    return this.setup.pace?.level() ?? null
  }

  /** The receiver is done with `bytes` more: the ACK policy of §4.4. */
  consume(stream: Stream, bytes: number): void {
    stream.consumed += bytes
    if (stream.closed) return
    if (stream.consumed - stream.ackSent >= ACK_BYTES) this.ack(stream)
    else stream.ackTimer ??= setTimeout(() => this.ack(stream), ACK_MS)
  }

  /* ---- the end */

  /** Ends the tunnel with no close handshake: a dead link would never finish one (§4.7). */
  kill(by: Closed['by']): void {
    this.ending ??= by
    this.ws.terminate()
  }

  close(): void {
    this.ending ??= 'local'
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'done')
    else this.ws.terminate()
    setTimeout(() => this.ws.terminate(), 2000).unref()
  }

  fail(reason: string): void {
    this.failure ||= reason
    this.ending ??= 'protocol'
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1002, reason.slice(0, 120))
    setTimeout(() => this.ws.terminate(), 1000).unref()
  }

  /* ---- receiving */

  private receive(raw: RawData, binary: boolean): void {
    this.lastFrameAt = performance.now()
    this.framesIn++
    if (!binary) return this.fail('a text message on the tunnel')
    const data = toBuffer(raw)
    this.bytesIn += data.length
    const frame = decodeFrame(data)
    if (typeof frame === 'string') return this.fail(frame)
    const first = this.role === 'home' ? KIND.HELLO : KIND.WELCOME
    if (!this.greeted && frame.kind !== first) return this.fail(`${KIND_NAMES[frame.kind]} before ${KIND_NAMES[first]}`)
    switch (frame.kind) {
      case KIND.HELLO:
        return this.gotHello(frame)
      case KIND.WELCOME:
        return this.gotWelcome(frame)
      case KIND.OPEN:
        return this.gotOpen(frame)
      case KIND.OPENED:
      case KIND.REFUSED:
        return this.gotAnswer(frame)
      case KIND.DATA:
        return this.gotData(frame)
      case KIND.ACK:
        return this.gotAck(frame)
      case KIND.END:
        return this.gotEnd(frame)
      case KIND.RESET: {
        const stream = this.streams.get(frame.stream)
        if (stream) this.forget(stream, 'reset there')
        return
      }
      case KIND.PING:
        return this.queueControl(encodeFrame(KIND.PONG, 0, 0, frame.offset))
      case KIND.PONG: {
        const sent = this.pings.get(frame.offset)
        if (sent === undefined) return
        this.pings.delete(frame.offset)
        this.rtts.push(performance.now() - sent)
        return
      }
    }
  }

  private gotHello(frame: Frame): void {
    if (this.role !== 'home' || this.greeted) return this.fail('an unexpected HELLO')
    const hello = jsonOfText(frame.payload.toString('utf8'))
    if (!hello) return this.fail('HELLO is not JSON')
    this.greeted = true
    this.onHello?.(hello)
  }

  private gotWelcome(frame: Frame): void {
    if (this.role !== 'machine' || this.greeted) return this.fail('an unexpected WELCOME')
    const welcome = jsonOfText(frame.payload.toString('utf8'))
    if (!welcome || welcome.protocol !== PROTOCOL) return this.fail(`WELCOME of protocol ${String(welcome?.protocol)}`)
    this.greeted = true
    this.welcomed = welcome
    this.greeting?.resolve(welcome)
    this.greeting = null
  }

  private gotOpen(frame: Frame): void {
    // The design's rule turned around (see the header): here only the dialler opens.
    if (this.role !== 'home') return this.fail('OPEN from home')
    if (frame.stream === 0 || this.streams.has(frame.stream) || (frame.lane !== 1 && frame.lane !== 2)) {
      return this.fail(`OPEN of stream ${frame.stream} on lane ${frame.lane}`)
    }
    const request = jsonOfText(frame.payload.toString('utf8'))
    if (!request) return this.refuse(frame.stream, frame.lane, 'bad-request')
    if (this.streams.size >= MAX_STREAMS) return this.refuse(frame.stream, frame.lane, 'busy')
    this.onOpen?.(frame, request)
  }

  private gotAnswer(frame: Frame): void {
    if (this.role !== 'machine') return this.fail(`${KIND_NAMES[frame.kind]} sent to home`)
    const waiting = this.opening.get(frame.stream)
    if (!waiting) return
    this.opening.delete(frame.stream)
    if (frame.kind === KIND.OPENED) return waiting.resolve()
    const code = String(jsonOfText(frame.payload.toString('utf8'))?.code ?? 'refused')
    const stream = this.streams.get(frame.stream)
    if (stream) this.forget(stream, `refused: ${code}`)
    waiting.reject(new Error(`home refused the stream: ${code}`))
  }

  private gotData(frame: Frame): void {
    const stream = this.streams.get(frame.stream)
    // A stream either side reset: its last frames are still on the wire.
    if (!stream) return
    if (stream.peerEnded) return this.fail(`DATA after END on stream ${stream.id}`)
    if (frame.offset !== stream.rx) return this.fail(`stream ${stream.id}: DATA at ${frame.offset}, expected ${stream.rx}`)
    stream.rx += frame.payload.length
    if (stream.rx - stream.ackSent > stream.window) return this.fail(`stream ${stream.id}: past its window`)
    stream.onData?.(frame.payload)
    if (!stream.echo) this.consume(stream, frame.payload.length)
  }

  private gotAck(frame: Frame): void {
    const stream = this.streams.get(frame.stream)
    if (!stream) return
    if (frame.offset > stream.tx) return this.fail(`stream ${stream.id}: ACK of bytes never sent`)
    if (frame.offset <= stream.acked) return
    this.inflight -= frame.offset - stream.acked
    stream.acked = frame.offset
    stream.onAck?.(stream.acked)
    this.pump()
  }

  private gotEnd(frame: Frame): void {
    const stream = this.streams.get(frame.stream)
    if (!stream) return
    if (frame.offset !== stream.rx) return this.fail(`stream ${stream.id}: END at ${frame.offset} after ${stream.rx} bytes`)
    stream.peerEnded = true
    // The last ACK goes now, not ACK_MS later: a sender times its last byte by it.
    this.ack(stream)
    stream.onEnd?.()
    if (stream.endSent) this.forget(stream, 'done')
  }

  /* ---- sending */

  private queueControl(frame: Buffer): void {
    this.control.push(frame)
    this.pump()
  }

  private pump(): void {
    if (this.pumping || this.ws.readyState !== WebSocket.OPEN) return
    this.pumping = true
    try {
      while (this.ws.bufferedAmount <= SEND_LOWAT) {
        const frame = this.control.shift() ?? this.takeData()
        if (!frame) break
        this.framesOut++
        this.bytesOut += frame.length
        this.ws.send(frame, this.afterSend)
      }
    } finally {
      this.pumping = false
    }
  }

  /** The next DATA frame by lane, then by deficit round-robin, or null with a wake set if one waits for time. */
  private takeData(): Buffer | null {
    for (const lane of LANES) {
      const list = this.rotation[lane]
      if (list.length === 0) continue
      // One look more than the lane has streams: a stream whose turn just ran out gets the next turn
      // when nobody else in the lane has bytes, rather than leaving its bytes for the next send callback.
      for (let tried = 0; tried <= list.length; tried++) {
        const stream = list[this.cursor[lane]]
        const size = this.sendable(stream)
        if (size > 0) {
          if (!stream.turn) {
            stream.turn = true
            stream.deficit += QUANTUM
          }
          if (size <= stream.deficit) {
            const pace = this.setup.pace
            if (pace) {
              const wait = pace.waitMs(size)
              if (wait > 0) {
                this.wakeIn(wait)
                return null
              }
              pace.spend(size)
            }
            stream.deficit -= size
            return this.takeFrame(stream, size)
          }
        } else stream.deficit = 0
        stream.turn = false
        this.cursor[lane] = (this.cursor[lane] + 1) % list.length
      }
    }
    return null
  }

  /** The size of the stream's next DATA frame now: 0 when it has nothing, waits for its producer, or is out of window. */
  private sendable(stream: Stream): number {
    let size = 0
    if (stream.queued > 0) size = Math.min(stream.queue[0].length, DATA_MAX)
    else if (stream.generate > 0) {
      size = Math.min(stream.generate, DATA_MAX)
      const wait = stream.producer?.waitMs(size) ?? 0
      if (wait > 0) {
        this.wakeIn(wait)
        return 0
      }
    }
    const room = Math.min(stream.window - (stream.tx - stream.acked), this.setup.totalWindow - this.inflight)
    return Math.max(0, Math.min(size, room))
  }

  private takeFrame(stream: Stream, size: number): Buffer {
    let payload: Buffer
    if (stream.queued > 0) {
      const head = stream.queue[0]
      if (head.length <= size) {
        stream.queue.shift()
        payload = head
      } else {
        payload = head.subarray(0, size)
        stream.queue[0] = head.subarray(size)
      }
      stream.queued -= payload.length
    } else {
      payload = FILLER.subarray(0, size)
      stream.generate -= size
      stream.producer?.spend(size)
    }
    const frame = encodeFrame(KIND.DATA, stream.lane, stream.id, stream.tx, payload)
    stream.tx += payload.length
    this.inflight += payload.length
    if (stream.echo) this.consume(stream, payload.length)
    if (stream.endWanted) this.maybeEnd(stream)
    return frame
  }

  private maybeEnd(stream: Stream): void {
    if (!stream.endWanted || stream.endSent || stream.queued > 0 || stream.generate > 0) return
    stream.endSent = true
    this.ack(stream)
    this.queueControl(encodeFrame(KIND.END, stream.lane, stream.id, stream.tx))
    if (stream.peerEnded) this.forget(stream, 'done')
  }

  private ack(stream: Stream): void {
    if (stream.ackTimer) {
      clearTimeout(stream.ackTimer)
      stream.ackTimer = null
    }
    if (stream.closed || stream.consumed === stream.ackSent) return
    stream.ackSent = stream.consumed
    this.queueControl(encodeFrame(KIND.ACK, stream.lane, stream.id, stream.ackSent))
  }

  private wakeIn(ms: number): void {
    const at = performance.now() + ms
    if (this.wakeTimer && this.wakeAt <= at) return
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeAt = at
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.pump()
    }, Math.max(1, ms))
  }

  private addStream(id: number, lane: Lane): Stream {
    const stream = new Stream(id, lane, this.setup.windows[lane])
    this.streams.set(id, stream)
    this.rotation[lane].push(stream)
    return stream
  }

  private forget(stream: Stream, why: string): void {
    if (stream.closed) return
    stream.closed = true
    this.streams.delete(stream.id)
    const list = this.rotation[stream.lane]
    const at = list.indexOf(stream)
    if (at >= 0) {
      list.splice(at, 1)
      if (at < this.cursor[stream.lane]) this.cursor[stream.lane]--
      if (this.cursor[stream.lane] >= list.length) this.cursor[stream.lane] = 0
    }
    this.inflight -= stream.tx - stream.acked
    if (stream.ackTimer) clearTimeout(stream.ackTimer)
    stream.ackTimer = null
    stream.queue = []
    stream.queued = 0
    stream.generate = 0
    stream.onClose?.(why)
  }

  private finish(code: number, reason: string): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.deadTimer) clearInterval(this.deadTimer)
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    const now = performance.now()
    const closed: Closed = { by: this.ending ?? 'peer', code, reason: this.failure || reason, upMs: now - this.openedAt, quietMs: now - this.lastFrameAt }
    for (const stream of [...this.streams.values()]) this.forget(stream, 'the tunnel closed')
    for (const waiting of this.opening.values()) waiting.reject(new Error('the tunnel closed'))
    this.opening.clear()
    this.greeting?.reject(new Error(`the tunnel closed before WELCOME (${code}${closed.reason ? `, ${closed.reason}` : ''})`))
    this.greeting = null
    this.settle(closed)
  }
}

/* ------------------------------------------------------------- echo paths */

/** One way to bounce a numbered probe off home: a tunnel echo stream, or the echo socket. */
interface EchoPath {
  replies: ((seq: number) => void) | null
  send(seq: number): boolean
}

/** A tunnel echo stream carrying PROBE_BYTES records, each led by its number. */
class StreamEcho implements EchoPath {
  replies: ((seq: number) => void) | null = null
  private readonly tunnel: Tunnel
  private readonly stream: Stream
  private pending: Buffer = EMPTY

  constructor(tunnel: Tunnel, stream: Stream) {
    this.tunnel = tunnel
    this.stream = stream
    stream.onData = (chunk) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
      while (this.pending.length >= PROBE_BYTES) {
        const seq = this.pending.readUInt32BE(0)
        this.pending = this.pending.subarray(PROBE_BYTES)
        this.replies?.(seq)
      }
    }
  }

  send(seq: number): boolean {
    if (this.stream.closed) return false
    const record = Buffer.alloc(PROBE_BYTES)
    record.writeUInt32BE(seq, 0)
    this.tunnel.write(this.stream, record)
    return true
  }
}

/** A client of /probe/echo, with its own keepalive and dead timer. */
class EchoSocket implements EchoPath {
  readonly ws: WebSocket
  readonly openedAt = performance.now()
  readonly closed: Promise<Closed>
  replies: ((seq: number) => void) | null = null
  /** Takes every message instead of `replies` while set (step 9). */
  onMessage: ((data: Buffer) => void) | null = null
  lastAt = performance.now()
  private ending: Closed['by'] | null = null
  private failure = ''
  private readonly timers: ReturnType<typeof setInterval>[] = []

  constructor(ws: WebSocket, pingMs: number, deadMs: number) {
    this.ws = ws
    let settle: (closed: Closed) => void = () => {}
    this.closed = new Promise((resolve) => (settle = resolve))
    ws.on('message', (raw) => {
      this.lastAt = performance.now()
      const data = toBuffer(raw)
      if (this.onMessage) return this.onMessage(data)
      if (data.length >= 4) this.replies?.(data.readUInt32BE(0))
    })
    ws.on('error', (error) => {
      this.failure ||= error.message
      this.ending ??= 'error'
    })
    ws.on('close', (code, reason) => {
      for (const timer of this.timers) clearInterval(timer)
      const now = performance.now()
      settle({ by: this.ending ?? 'peer', code, reason: this.failure || reason.toString(), upMs: now - this.openedAt, quietMs: now - this.lastAt })
    })
    if (pingMs > 0) this.timers.push(setInterval(() => this.send(0), pingMs))
    if (deadMs > 0) {
      this.timers.push(
        setInterval(() => {
          if (performance.now() - this.lastAt > deadMs) this.kill('dead')
        }, Math.min(1000, Math.max(50, deadMs / 5))),
      )
    }
  }

  send(seq: number): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false
    const record = Buffer.alloc(PROBE_BYTES)
    record.writeUInt32BE(seq, 0)
    this.ws.send(record)
    return true
  }

  kill(by: Closed['by']): void {
    this.ending ??= by
    this.ws.terminate()
  }

  close(): void {
    this.ending ??= 'local'
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'done')
    else this.ws.terminate()
    setTimeout(() => this.ws.terminate(), 2000).unref()
  }
}

/* ---------------------------------------------------------------- samples */

interface RttStats {
  n: number
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
  mean: number | null
  /** Sent and never answered. */
  lost: number
  /** Not sent: the path was down at that tick. */
  skipped: number
  /** The longest time between two answers, ms. */
  gapMs: number
}

function rttStats(samples: readonly number[], lost = 0, skipped = 0, gapMs = 0): RttStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (share: number): number | null =>
    sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]) : null
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length ? round(sorted[sorted.length - 1]) : null,
    mean: sorted.length ? round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : null,
    lost,
    skipped,
    gapMs: round(gapMs),
  }
}

/** Probes over one path at a steady rate: round trips, losses, and the longest silence between answers. */
class Sampler {
  readonly rtt: number[] = []
  lost = 0
  skipped = 0
  gapMs = 0
  private readonly hz: number
  private readonly sentAt = new Map<number, number>()
  private path: EchoPath | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private lastReplyAt = performance.now()
  private drained: (() => void) | null = null
  private readonly onReply = (seq: number): void => {
    const at = this.sentAt.get(seq)
    if (at === undefined) return
    this.sentAt.delete(seq)
    const now = performance.now()
    this.rtt.push(now - at)
    this.gapMs = Math.max(this.gapMs, now - this.lastReplyAt)
    this.lastReplyAt = now
    if (this.sentAt.size === 0) this.drained?.()
  }

  constructor(hz: number) {
    this.hz = hz
  }

  attach(path: EchoPath): void {
    this.detach()
    this.path = path
    path.replies = this.onReply
  }

  /** The path went away: what it still owed is lost. */
  detach(): void {
    this.lost += this.sentAt.size
    this.sentAt.clear()
    if (this.path?.replies === this.onReply) this.path.replies = null
    this.path = null
  }

  /** Starts the clock once; after stop() it stays stopped, whatever reconnects late. */
  start(): void {
    if (this.timer || this.stopped) return
    this.lastReplyAt = performance.now()
    this.timer = setInterval(() => this.tick(), 1000 / this.hz)
    this.tick()
  }

  /** Stops sending, waits up to REPLY_MS for what is owed, and counts the rest as lost. */
  async stop(signal?: AbortSignal): Promise<RttStats> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.gapMs = Math.max(this.gapMs, performance.now() - this.lastReplyAt)
    if (this.sentAt.size > 0) await within(new Promise<void>((resolve) => (this.drained = resolve)), REPLY_MS, signal)
    this.drained = null
    // When the signal cut the wait short, whether the owed answers would have come is unknown: not counted.
    if (signal?.aborted) this.sentAt.clear()
    this.detach()
    return this.stats()
  }

  stats(): RttStats {
    return rttStats(this.rtt, this.lost, this.skipped, this.gapMs)
  }

  private tick(): void {
    const seq = nextSeq()
    this.sentAt.set(seq, performance.now())
    if (this.path?.send(seq)) return
    this.sentAt.delete(seq)
    this.skipped++
  }
}

/** One probe and its round trip, or null after REPLY_MS. */
function echoOnce(path: EchoPath, signal: AbortSignal): Promise<number | null> {
  const seq = nextSeq()
  const sentAt = performance.now()
  const answered = new Promise<number>((resolve) => {
    path.replies = (got) => {
      if (got === seq) resolve(performance.now() - sentAt)
    }
  })
  if (!path.send(seq)) return Promise.resolve(null)
  return within(answered, REPLY_MS, signal).finally(() => {
    path.replies = null
  })
}

/* ------------------------------------------------------------------- home */

interface Home {
  port: number
  /** What it served, for its last log line. */
  totals: { tunnels: number; sockets: number; blobs: number; refused: number }
  /**
   * Kills every tunnel from home's side (selftest: a cut to watch through).
   * With `deafBytes`, each first stops hearing the machine, as a black hole
   * would, and goes once that much of its DATA was dropped: a cut that
   * loses a known part of what the machine sent.
   */
  cut(deafBytes?: number): void
  close(): Promise<void>
}

interface HelloSettings {
  tunnel: string
  prev: string | null
  pingMs: number
  deadMs: number
  windows: Record<Lane, number>
  totalWindow: number
}

const TUNNEL_ID = /^[\w-]{1,64}$/

function helloSettings(hello: Record<string, unknown>): HelloSettings | string {
  if (hello.protocol !== PROTOCOL) return `HELLO of protocol ${String(hello.protocol)}; this home speaks ${PROTOCOL}`
  const tunnel = typeof hello.tunnel === 'string' && TUNNEL_ID.test(hello.tunnel) ? hello.tunnel : null
  const prev = hello.prev === null || hello.prev === undefined ? null : typeof hello.prev === 'string' && TUNNEL_ID.test(hello.prev) ? hello.prev : undefined
  const pingMs = intIn(hello.pingMs, 0, IDLE_CAP_MS)
  const deadMs = intIn(hello.deadMs, 0, IDLE_CAP_MS)
  const windows = Array.isArray(hello.windows) && hello.windows.length === 2 ? hello.windows.map((value) => intIn(value, DATA_MAX, 64 * MiB)) : null
  const totalWindow = intIn(hello.totalWindow, DATA_MAX, 256 * MiB)
  if (tunnel === null || prev === undefined || pingMs === null || deadMs === null || totalWindow === null || !windows || windows.includes(null)) {
    return 'a HELLO this home cannot read'
  }
  return { tunnel, prev, pingMs, deadMs, windows: { 1: windows[0] as number, 2: windows[1] as number }, totalWindow }
}

function fromOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  return String((Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.socket.remoteAddress ?? '')
}

function answer(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return void res.destroy()
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', [MARKER]: String(PROTOCOL) })
  res.end(text)
}

function refuseUpgrade(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error })
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n${MARKER}: ${PROTOCOL}\r\nConnection: close\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
  // The server half-opens upgrade sockets: a client that never hangs up its side would keep this one for good.
  setTimeout(() => socket.destroy(), REFUSED_GRACE_MS).unref()
}

/** The stand-in for home: the three doors, until close(). */
function startHome(options: { port: number; bind: string; token: string; log: Log }): Promise<Home> {
  const { log } = options
  const life = randomBytes(6).toString('hex')
  const expected = Buffer.from(`Bearer ${options.token}`)
  const authorized = (req: IncomingMessage): boolean => {
    const given = Buffer.from(req.headers.authorization ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  const totals = { tunnels: 0, sockets: 0, blobs: 0, refused: 0 }
  /** Tunnels by the machine's id for them, so a replacement can end the one it replaces. */
  const live = new Map<string, Tunnel>()
  /** The trickle's counters of tunnels that ended, for the machine to set against its own. */
  const history = new Map<string, { tx: number; rx: number }>()
  const trickles = new Map<Tunnel, Stream>()
  const remember = (tunnel: Tunnel): void => {
    const trickle = trickles.get(tunnel)
    if (!tunnel.id || !trickle) return
    history.set(tunnel.id, { tx: trickle.tx, rx: trickle.rx })
    if (history.size > 1000) history.delete(history.keys().next().value as string)
  }
  /** Refused upgrades whose clients have not hung up yet; close() does not wait for them. */
  const refusing = new Set<Duplex>()
  const refuse = (socket: Duplex, status: number, error: string): void => {
    refusing.add(socket)
    socket.once('close', () => refusing.delete(socket))
    refuseUpgrade(socket, status, error)
  }
  const cutOne = (tunnel: Tunnel, deafBytes: number): void => {
    if (deafBytes <= 0) {
      remember(tunnel)
      return tunnel.kill('local')
    }
    // Its frames are dropped from here on, never counted: the machine's trickle bytes after this are lost for sure.
    let dropped = 0
    tunnel.ws.removeAllListeners('message')
    tunnel.ws.on('message', (raw: RawData) => {
      const frame = decodeFrame(toBuffer(raw))
      if (typeof frame === 'string' || frame.kind !== KIND.DATA || dropped >= deafBytes) return
      dropped += frame.payload.length
      if (dropped < deafBytes) return
      remember(tunnel)
      tunnel.kill('local')
    })
  }

  const tunnelDoor = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: TUNNEL_MAX_PAYLOAD })
  const echoDoor = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: ECHO_MAX_PAYLOAD })

  const serveTunnel = (ws: WebSocket, req: IncomingMessage): void => {
    totals.tunnels++
    const from = fromOf(req)
    const tunnel = new Tunnel(ws, { role: 'home', pace: null, windows: { 1: STREAM_WINDOW, 2: STREAM_WINDOW / 2 }, totalWindow: TUNNEL_WINDOW })
    const greet = setTimeout(() => tunnel.fail(`no HELLO in ${REPLY_MS / 1000} s`), REPLY_MS)
    tunnel.onHello = (hello) => {
      clearTimeout(greet)
      const settings = helloSettings(hello)
      if (typeof settings === 'string') return tunnel.fail(settings)
      if (live.has(settings.tunnel)) return tunnel.fail('a tunnel by this id is up already')
      tunnel.id = settings.tunnel
      // A replacement ends the tunnel it replaces (4409 in the design) and inherits its counters.
      let prev: { tx: number; rx: number } | null = null
      if (settings.prev) {
        const old = live.get(settings.prev)
        if (old) {
          remember(old)
          old.kill('replaced')
          live.delete(settings.prev)
        }
        prev = history.get(settings.prev) ?? null
      }
      live.set(tunnel.id, tunnel)
      tunnel.welcome({ protocol: PROTOCOL, home: life, prev }, settings.windows, settings.totalWindow)
      // A tunnel that asked for no dead timer still goes after IDLE_CAP_MS of silence.
      tunnel.liveness(settings.pingMs, settings.deadMs || IDLE_CAP_MS)
      log('tunnel', { id: tunnel.id, from, prev: settings.prev, pingMs: settings.pingMs, deadMs: settings.deadMs, window: settings.windows[1] })
    }
    tunnel.onOpen = (frame, request) => serveStream(tunnel, frame, request)
    void tunnel.closed.then((closed) => {
      clearTimeout(greet)
      remember(tunnel)
      trickles.delete(tunnel)
      if (tunnel.id && live.get(tunnel.id) === tunnel) live.delete(tunnel.id)
      const pong = rttStats(tunnel.rtts)
      log('tunnel-closed', {
        id: tunnel.id,
        from,
        by: closed.by,
        code: closed.code,
        reason: closed.reason,
        upS: round(closed.upMs / 1000),
        quietMs: round(closed.quietMs),
        framesIn: tunnel.framesIn,
        framesOut: tunnel.framesOut,
        bytesIn: tunnel.bytesIn,
        bytesOut: tunnel.bytesOut,
        pingP50: pong.p50,
      })
    })
  }

  const serveStream = (tunnel: Tunnel, frame: Frame, request: Record<string, unknown>): void => {
    const service = String(request.service)
    const lane = frame.lane as Lane
    let stream: Stream
    let cleanup = (): void => {}
    if (service === 'echo') {
      stream = tunnel.accept(frame.stream, lane)
      const echo = stream
      echo.echo = true
      echo.onData = (chunk) => tunnel.write(echo, chunk)
      echo.onEnd = () => tunnel.end(echo)
    } else if (service === 'sink') {
      stream = tunnel.accept(frame.stream, lane)
      const sink = stream
      sink.onEnd = () => tunnel.end(sink)
    } else if (service === 'source') {
      const bytes = intIn(request.bytes, 0, BLOB_MAX)
      const rate = rateIn(request.rateMBps ?? 0)
      const pacing = pacingIn(request.pacing)
      if (bytes === null || rate === null || pacing === null) return tunnel.refuse(frame.stream, lane, 'bad-request')
      stream = tunnel.accept(frame.stream, lane)
      stream.generate = bytes
      stream.producer = rate > 0 ? new Bucket(rate * MiB, BULK_BURST, pacing) : null
      tunnel.end(stream)
      tunnel.kick()
    } else if (service === 'trickle') {
      const hz = numberIn(request.hz, 0.1, 100)
      if (hz === null) return tunnel.refuse(frame.stream, lane, 'bad-request')
      stream = tunnel.accept(frame.stream, lane)
      const trickle = stream
      trickles.set(tunnel, trickle)
      const timer = setInterval(() => tunnel.write(trickle, FILLER.subarray(0, TRICKLE_BYTES)), 1000 / hz)
      cleanup = () => clearInterval(timer)
      trickle.onEnd = () => tunnel.end(trickle)
    } else return tunnel.refuse(frame.stream, lane, 'unknown-service')
    const opened = stream
    opened.onClose = (why) => {
      cleanup()
      log('stream', { tunnel: tunnel.id, stream: opened.id, service, lane, rx: opened.rx, tx: opened.tx, s: round((performance.now() - opened.openedAt) / 1000), why })
    }
  }

  const serveEcho = (ws: WebSocket, req: IncomingMessage): void => {
    totals.sockets++
    const from = fromOf(req)
    const openedAt = performance.now()
    let messages = 0
    let bytes = 0
    ws.on('message', (raw, binary) => {
      const data = toBuffer(raw)
      messages++
      bytes += data.length
      ws.send(data, { binary })
    })
    ws.on('error', () => {})
    ws.on('close', (code) => log('echo-closed', { from, code, messages, bytes, upS: round((performance.now() - openedAt) / 1000) }))
    log('echo', { from })
  }

  const sendBlob = (res: ServerResponse, url: URL, from: string): void => {
    const bytes = intIn(Number(url.searchParams.get('bytes') ?? ''), 0, BLOB_MAX)
    const rate = rateIn(Number(url.searchParams.get('rate') ?? 0))
    const pacing = pacingIn(url.searchParams.get('pacing') ?? undefined)
    if (bytes === null || rate === null || pacing === null) {
      return answer(res, 400, { error: `bytes (0 to ${BLOB_MAX}), rate (MiB/s, 0 for none), pacing (paced or bursty)` })
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes, 'Cache-Control': 'no-store', [MARKER]: String(PROTOCOL) })
    const bucket = rate > 0 ? new Bucket(rate * MiB, BULK_BURST, pacing) : null
    const started = performance.now()
    let left = bytes
    let gone = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const step = (): void => {
      timer = null
      while (!gone && left > 0) {
        const size = Math.min(left, BLOB_CHUNK)
        if (bucket) {
          const wait = bucket.waitMs(size)
          if (wait > 0) {
            timer = setTimeout(step, wait)
            return
          }
          bucket.spend(size)
        }
        left -= size
        if (!res.write(FILLER.subarray(0, size))) return void res.once('drain', step)
      }
      if (!gone) res.end()
    }
    res.on('close', () => {
      gone = true
      if (timer) clearTimeout(timer)
      totals.blobs++
      log('blob', { dir: 'down', from, bytes: bytes - left, of: bytes, rate, pacing, s: round((performance.now() - started) / 1000), complete: left === 0 && res.writableFinished })
    })
    step()
  }

  const takeBlob = (req: IncomingMessage, res: ServerResponse, from: string): void => {
    let bytes = 0
    let first = 0
    let ended = false
    req.on('data', (chunk: Buffer) => {
      first ||= performance.now()
      bytes += chunk.length
      if (bytes > BLOB_MAX) {
        answer(res, 413, { error: `more than ${BLOB_MAX} bytes` })
        req.destroy()
      }
    })
    req.on('end', () => {
      ended = true
      const ms = first ? round(performance.now() - first) : 0
      log('blob', { dir: 'up', from, bytes, s: round(ms / 1000), complete: true })
      answer(res, 200, { bytes, ms })
    })
    req.on('error', () => {})
    req.on('close', () => {
      totals.blobs++
      if (!ended) log('blob', { dir: 'up', from, bytes, complete: false })
    })
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://probe')
    // Read now: once a socket is destroyed its address is gone.
    const from = fromOf(req)
    if (url.pathname !== DOORS.blob) return answer(res, 404, { error: 'no such door' })
    if (!authorized(req)) {
      totals.refused++
      log('refused', { door: url.pathname, from })
      return answer(res, 401, { error: 'a bearer token is needed' })
    }
    if (req.method === 'GET') return sendBlob(res, url, from)
    if (req.method === 'PUT') return takeBlob(req, res, from)
    res.setHeader('Allow', 'GET, PUT')
    answer(res, 405, { error: 'GET or PUT' })
  })
  // A paced upload of 150 MB takes minutes; Node's own 300 s request cap is no part of what is measured.
  server.requestTimeout = 0
  server.headersTimeout = CONNECT_MS

  server.on('upgrade', (req, socket, head) => {
    // Until handleUpgrade adopts it the socket has no error handler of its own.
    socket.on('error', () => socket.destroy())
    const path = new URL(req.url ?? '/', 'http://probe').pathname
    const door = path === DOORS.tunnel ? tunnelDoor : path === DOORS.echo ? echoDoor : null
    if (!door) return refuse(socket, 404, 'no such door')
    if (!authorized(req)) {
      totals.refused++
      log('refused', { door: path, from: fromOf(req) })
      return refuse(socket, 401, 'a bearer token is needed')
    }
    if (door.clients.size >= (door === tunnelDoor ? MAX_TUNNELS : MAX_SOCKETS)) return refuse(socket, 503, 'too many connections')
    door.handleUpgrade(req, socket, head, (ws) => (door === tunnelDoor ? serveTunnel(ws, req) : serveEcho(ws, req)))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.bind, () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      log('listen', { bind: options.bind, port, probe: PROTOCOL, home: life })
      resolve({
        port,
        totals,
        cut: (deafBytes = 0) => {
          for (const tunnel of [...live.values()]) cutOne(tunnel, deafBytes)
        },
        close: () =>
          new Promise<void>((done) => {
            // Upgraded sockets, taken or refused, are no HTTP connections: closeAllConnections() misses them, and close() waits for them.
            for (const ws of [...tunnelDoor.clients, ...echoDoor.clients]) ws.terminate()
            for (const socket of refusing) socket.destroy()
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

/* ------------------------------------------------------------ the machine */

function targetOf(raw: string, token: string): Target {
  const text = raw.trim()
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Usage(`--host ${raw}: a name, or an http(s) or ws(s) address`)
  const tls = url.protocol === 'https:' || url.protocol === 'wss:'
  return { tls, origin: `${tls ? 'https' : 'http'}://${url.host}`, wsOrigin: `${tls ? 'wss' : 'ws'}://${url.host}`, label: url.host, token }
}

const refusal = (status: number | null, marked: boolean): string =>
  marked ? `the probe answered HTTP ${status}` : `HTTP ${status}, and not from the probe (the relay's page: is home up behind frpc?)`

/** Every connection the machine holds, ended at exit whatever else happened. */
const held = new Set<{ kill(by: Closed['by']): void }>()

function hold<T extends { closed: Promise<Closed>; kill(by: Closed['by']): void }>(connection: T): T {
  held.add(connection)
  void connection.closed.then(() => held.delete(connection))
  return connection
}

/** A WebSocket to one of home's doors. The signal ends a dial still in progress, so Ctrl-C never waits out a hung handshake. */
function dial(target: Target, path: string, maxPayload: number, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(`${path}: interrupted`))
    let settled = false
    const ws = new WebSocket(`${target.wsOrigin}${path}`, {
      headers: { Authorization: `Bearer ${target.token}` },
      perMessageDeflate: false,
      maxPayload,
      handshakeTimeout: CONNECT_MS,
    })
    const onAbort = (): void => ws.terminate()
    const settle = (): void => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Stays for the socket's life: an 'error' with no listener would throw.
    ws.on('error', (error) => {
      if (settled) return
      settle()
      reject(signal?.aborted ? new Error(`${path}: interrupted`) : error)
    })
    ws.once('unexpected-response', (_request, response) => {
      settle()
      reject(new Error(`${path}: ${refusal(response.statusCode ?? null, response.headers[MARKER] !== undefined)}`))
      response.resume()
      ws.terminate()
    })
    ws.once('open', () => {
      settle()
      resolve(ws)
    })
  })
}

interface TunnelChoice {
  pingMs?: number
  deadMs?: number
  /** MiB/s on lanes 1-2 from the machine; 0 or none: unpaced. */
  pace?: number
  window?: number
  prev?: string | null
}

async function connectTunnel(target: Target, choice: TunnelChoice, signal?: AbortSignal): Promise<Tunnel> {
  const ws = await dial(target, DOORS.tunnel, TUNNEL_MAX_PAYLOAD, signal)
  const window = choice.window ?? STREAM_WINDOW
  const windows = { 1: window, 2: Math.max(DATA_MAX, Math.round(window / 2)) }
  const pingMs = choice.pingMs ?? PING_MS
  const deadMs = choice.deadMs ?? DEAD_MS
  const tunnel = hold(new Tunnel(ws, { role: 'machine', pace: choice.pace ? new Bucket(choice.pace * MiB, PACE_BURST) : null, windows, totalWindow: TUNNEL_WINDOW }))
  tunnel.id = randomBytes(9).toString('base64url')
  const onAbort = (): void => tunnel.kill('local')
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await tunnel.hello({ protocol: PROTOCOL, tunnel: tunnel.id, prev: choice.prev ?? null, pingMs, deadMs, windows: [windows[1], windows[2]], totalWindow: TUNNEL_WINDOW })
  } catch (error) {
    tunnel.kill('local')
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  tunnel.liveness(pingMs, deadMs)
  return tunnel
}

async function connectEcho(target: Target, pingMs: number, deadMs: number, signal?: AbortSignal): Promise<EchoSocket> {
  return hold(new EchoSocket(await dial(target, DOORS.echo, ECHO_MAX_PAYLOAD, signal), pingMs, deadMs))
}

interface BlobResult {
  bytes: number
  ms: number
  status: number | null
  error: string | null
}

interface BlobOrder {
  bytes: number
  rate: number
  pacing: Pacing
  signal: AbortSignal
  /** Stop there and count what came (a timed run). */
  stopAfterMs?: number
  deadlineMs?: number
}

/** GET /probe/blob: home paces it. Time-bounded with stopAfterMs; any silence of SILENT_MS ends it. */
function getBlob(target: Target, order: BlobOrder): Promise<BlobResult> {
  return new Promise((resolve) => {
    const started = performance.now()
    let bytes = 0
    let status: number | null = null
    let done = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const url = `${target.origin}${DOORS.blob}?bytes=${order.bytes}&rate=${order.rate}&pacing=${order.pacing}`
    const request = (target.tls ? httpsRequest : httpRequest)(url, { headers: { Authorization: `Bearer ${target.token}` }, agent: false, timeout: SILENT_MS }, (response) => {
      status = response.statusCode ?? null
      if (status !== 200) {
        response.resume()
        return finish(refusal(status, response.headers[MARKER] !== undefined))
      }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
      })
      response.on('end', () => finish(bytes === order.bytes ? null : `ended at ${bytes} of ${order.bytes} bytes`))
      response.on('error', (error) => finish(error.message))
    })
    const onAbort = (): void => finish('interrupted')
    const finish = (error: string | null): void => {
      if (done) return
      done = true
      for (const timer of timers) clearTimeout(timer)
      order.signal.removeEventListener('abort', onAbort)
      request.destroy()
      resolve({ bytes, ms: performance.now() - started, status, error })
    }
    request.on('timeout', () => finish(`silent for ${SILENT_MS / 1000} s`))
    request.on('error', (error) => finish(error.message))
    if (order.stopAfterMs !== undefined) timers.push(setTimeout(() => finish(null), order.stopAfterMs))
    if (order.deadlineMs !== undefined) timers.push(setTimeout(() => finish(`not done in ${secText(order.deadlineMs)}`), order.deadlineMs))
    order.signal.addEventListener('abort', onAbort, { once: true })
    if (order.signal.aborted) return finish('interrupted')
    request.end()
  })
}

/** PUT /probe/blob: the machine paces it, as the agent paces uploads; `bytes` is home's count. */
function putBlob(target: Target, order: BlobOrder): Promise<BlobResult> {
  return new Promise((resolve) => {
    const started = performance.now()
    const bucket = order.rate > 0 ? new Bucket(order.rate * MiB, BULK_BURST, order.pacing) : null
    let sent = 0
    let counted = 0
    let status: number | null = null
    let done = false
    let ending = false
    let wake: ReturnType<typeof setTimeout> | null = null
    const timers: ReturnType<typeof setTimeout>[] = []
    const request = (target.tls ? httpsRequest : httpRequest)(
      `${target.origin}${DOORS.blob}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/octet-stream' }, agent: false, timeout: SILENT_MS },
      (response) => {
        status = response.statusCode ?? null
        const parts: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          if (length >= JSON_MAX) return
          parts.push(chunk)
          length += chunk.length
        })
        response.on('end', () => {
          if (status !== 200) return finish(refusal(status, response.headers[MARKER] !== undefined))
          const reply = jsonOfText(Buffer.concat(parts).toString('utf8'))
          counted = typeof reply?.bytes === 'number' ? reply.bytes : 0
          finish(ending ? null : 'home answered before the body ended')
        })
        response.on('error', (error) => finish(error.message))
      },
    )
    const end = (): void => {
      if (ending || done) return
      ending = true
      if (wake) clearTimeout(wake)
      request.end()
    }
    const pump = (): void => {
      wake = null
      while (!done && !ending) {
        if (sent >= order.bytes) return end()
        const size = Math.min(BLOB_CHUNK, order.bytes - sent)
        if (bucket) {
          const wait = bucket.waitMs(size)
          if (wait > 0) {
            wake = setTimeout(pump, wait)
            return
          }
          bucket.spend(size)
        }
        sent += size
        if (!request.write(FILLER.subarray(0, size))) return void request.once('drain', pump)
      }
    }
    const onAbort = (): void => finish('interrupted')
    const finish = (error: string | null): void => {
      if (done) return
      done = true
      if (wake) clearTimeout(wake)
      for (const timer of timers) clearTimeout(timer)
      order.signal.removeEventListener('abort', onAbort)
      request.destroy()
      resolve({ bytes: counted, ms: performance.now() - started, status, error })
    }
    request.on('timeout', () => finish(`silent for ${SILENT_MS / 1000} s`))
    request.on('error', (error) => finish(error.message))
    if (order.stopAfterMs !== undefined) timers.push(setTimeout(end, order.stopAfterMs))
    if (order.deadlineMs !== undefined) timers.push(setTimeout(() => finish(`not done in ${secText(order.deadlineMs)}`), order.deadlineMs))
    order.signal.addEventListener('abort', onAbort, { once: true })
    if (order.signal.aborted) return finish('interrupted')
    pump()
  })
}

/** Class bulk by HTTP, as the design moves it: never through the tunnel (§4.4). */
function moveBulk(target: Target, dir: 'down' | 'up', bytes: number, rate: number, pacing: Pacing, signal: AbortSignal): Promise<BlobResult> {
  // No limit is given a floor of 1 MiB/s for its deadline.
  const expectedMs = (bytes / ((rate || 1) * MiB)) * 1000
  const order: BlobOrder = { bytes, rate, pacing, signal, deadlineMs: Math.round(Math.min(expectedMs * 3 + 60_000, MAX_DELAY)) }
  return dir === 'down' ? getBlob(target, order) : putBlob(target, order)
}

/** A load in the background until the function it returns is called; that one answers what went wrong with it, if anything. */
function background(target: Target, dir: 'down' | 'up', rate: number, signal: AbortSignal): () => Promise<string | null> {
  const local = new AbortController()
  const running = moveBulk(target, dir, BLOB_MAX, rate, 'paced', AbortSignal.any([signal, local.signal]))
  return async () => {
    local.abort()
    const result = await running
    return result.error === 'interrupted' ? null : result.error
  }
}

interface Kept {
  readonly closed: Promise<Closed>
  kill(by: Closed['by']): void
}

/**
 * Keeps one connection up until the signal: dial, wait for it to end, back
 * off, dial again. A drop waits out the backoff before the next dial, as
 * §4.6 has the agent do, so the gap a drop shows is a class's. The backoff
 * keeps growing through connections that die young, so a relay that drops
 * every one at once is never dialled in a tight loop; a connection that
 * stayed up STEADY_MS starts it over. Every wait goes through `wait`.
 */
async function keepUp<T extends Kept>(
  connect: (previous: T | null) => Promise<T>,
  hooks: { up?(connection: T, gapMs: number | null, tries: number): void; down?(connection: T, closed: Closed, waitMs: number): void; retry?(error: unknown, waitMs: number): void },
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = pause,
): Promise<void> {
  const backoff = new Backoff()
  let previous: T | null = null
  let downAt: number | null = null
  let tries = 0
  while (!signal.aborted) {
    tries++
    let connection: T | null
    try {
      // A dial can take REPLY_MS twice over; Ctrl-C does not wait for it. What it brings later is held, and ended at exit.
      connection = await within(connect(previous), Infinity, signal)
    } catch (error) {
      if (signal.aborted) break
      const ms = backoff.next()
      hooks.retry?.(error, ms)
      await wait(ms, signal)
      continue
    }
    if (!connection) break
    if (signal.aborted) {
      connection.kill('local')
      break
    }
    hooks.up?.(connection, downAt === null ? null : performance.now() - downAt, tries)
    tries = 0
    const closed = await within(connection.closed, Infinity, signal)
    if (!closed) {
      connection.kill('local')
      await connection.closed
      break
    }
    downAt = performance.now()
    if (closed.upMs >= STEADY_MS) backoff.reset()
    const ms = backoff.next()
    hooks.down?.(connection, closed, ms)
    previous = connection
    await wait(ms, signal)
  }
}

/* -------------------------------------------------------------- the plan */

interface Plan {
  steps: number[]
  minutes: number
  hz: number
  sampleHz: number
  tpSeconds: number
  bulkBytes: number
  bulkDir: 'down' | 'up'
  rates: number[]
  bulkRate: number
  pace: number
  window: number
  figureBytes: number
  figures: number
  idle: number[]
  frameBytes: number
  frames: number
  settleMs: number
  baselineMs: number
}

interface DropNote {
  path: string
  at: string
  by: string
  code: number
  reason: string
  upS: number
  backAfterMs: number | null
}

interface RttStep {
  minutes: number
  hz: number
  /** As measured: less than `minutes` when Ctrl-C cut it short. */
  seconds: number | null
  tunnel: RttStats | null
  socket: RttStats | null
  drops: DropNote[]
}

const RATE_KINDS = ['tunnel up', 'tunnel down', 'http down', 'http up'] as const
type RateKind = (typeof RATE_KINDS)[number]

interface RateRun {
  kind: RateKind
  streams: number
  mibps: number | null
  perStream: (number | null)[]
  error: string | null
}

interface RateStep {
  seconds: number
  window: number
  rttMs: number | null
  runs: RateRun[]
}

interface PathStats {
  tunnel: RttStats | null
  socket: RttStats | null
}

interface BulkRun extends PathStats {
  rate: number
  pacing: Pacing
  bulk: BlobResult | null
}

interface BulkStep {
  bytes: number
  dir: 'down' | 'up'
  pace: number
  sampleHz: number
  baseline: PathStats | null
  runs: BulkRun[]
}

interface FigureCondition {
  name: string
  ms: (number | null)[]
  /** Beside each time, FigureTime's bucket. */
  bucket: (number | null)[]
  rtt: RttStats | null
  error: string | null
}

interface FigureStep {
  bytes: number
  pace: number
  conditions: FigureCondition[]
}

interface IdleOutcome {
  outcome: 'survived' | 'closed' | 'silent' | 'error' | 'interrupted'
  rttMs?: number
  afterS?: number
  code?: number
  detail?: string
}

interface IdleRun {
  seconds: number
  tunnel: IdleOutcome | null
  socket: IdleOutcome | null
}

interface FramesResult {
  ms: number[]
  timeouts: number
  corrupt: number
  error: string | null
}

interface FramesStep {
  bytes: number
  count: number
  socket: FramesResult | null
  tunnel: FramesResult | null
}

interface Summary {
  probe: number
  mode: 'machine' | 'selftest'
  host: string
  node: string
  startedAt: string
  endedAt: string | null
  interrupted: boolean
  plan: Plan
  steps: { 1?: RttStep; 2?: RateStep; 3?: BulkStep; 4?: FigureStep; 6?: IdleStep; 9?: FramesStep }
  errors: Record<string, string>
}

interface IdleStep {
  runs: IdleRun[]
}

type Note = (text: string) => void

/** Is home there at all: a tunnel, an echo socket and a tiny blob, before ten minutes are spent waiting on it. */
async function preflight(target: Target, signal: AbortSignal): Promise<void> {
  try {
    const tunnel = await connectTunnel(target, {}, signal)
    tunnel.close()
    const socket = await connectEcho(target, 0, 0, signal)
    socket.close()
    const blob = await getBlob(target, { bytes: KiB, rate: 0, pacing: 'paced', signal, deadlineMs: REPLY_MS })
    if (blob.error) throw new Error(`${DOORS.blob}: ${blob.error}`)
  } catch (error) {
    throw new Error(`no probe home answers at ${target.wsOrigin}: ${messageOf(error)}`)
  }
}

async function runPlan(target: Target, plan: Plan, signal: AbortSignal, summary: Summary, note: Note): Promise<void> {
  for (const step of plan.steps) {
    if (signal.aborted) break
    note(`step ${step}: ${STEP_TITLES[step]}`)
    try {
      if (step === 1) await stepRtt(target, plan, signal, (summary.steps[1] = { minutes: plan.minutes, hz: plan.hz, seconds: null, tunnel: null, socket: null, drops: [] }), note)
      if (step === 2) await stepRate(target, plan, signal, (summary.steps[2] = { seconds: plan.tpSeconds, window: plan.window, rttMs: null, runs: [] }), note)
      if (step === 3) {
        const out: BulkStep = { bytes: plan.bulkBytes, dir: plan.bulkDir, pace: plan.pace, sampleHz: plan.sampleHz, baseline: null, runs: [] }
        await stepBulk(target, plan, signal, (summary.steps[3] = out), note)
      }
      if (step === 4) await stepFigure(target, plan, signal, (summary.steps[4] = { bytes: plan.figureBytes, pace: plan.pace, conditions: [] }), note)
      if (step === 6) await stepIdle(target, plan, signal, (summary.steps[6] = { runs: [] }))
      if (step === 9) await stepFrames(target, plan, signal, (summary.steps[9] = { bytes: plan.frameBytes, count: plan.frames, socket: null, tunnel: null }))
    } catch (error) {
      // What Ctrl-C broke off is no failure of the path: the summary says it was interrupted, and keeps what came before.
      if (signal.aborted) break
      summary.errors[step] = messageOf(error)
      note(`step ${step} failed: ${messageOf(error)}`)
    }
  }
}

const STEP_TITLES: Record<number, string> = {
  1: 'echo RTT',
  2: 'throughput by streams',
  3: 'RTT while bulk moves',
  4: 'a figure end to end',
  6: 'idle connections',
  9: 'big frames both ways',
}

/** Step 1: both paths at `hz` for `minutes`, kept up through drops, which are counted. */
async function stepRtt(target: Target, plan: Plan, signal: AbortSignal, out: RttStep, note: Note): Promise<void> {
  const tunnelRtt = new Sampler(plan.hz)
  const socketRtt = new Sampler(plan.hz)
  const done = new AbortController()
  const either = AbortSignal.any([signal, done.signal])
  const dropped = (path: string, sampler: Sampler, closed: Closed, waitMs: number): void => {
    sampler.detach()
    out.drops.push({ path, at: new Date().toISOString(), by: closed.by, code: closed.code, reason: closed.reason, upS: round(closed.upMs / 1000), backAfterMs: null })
    note(`${path} dropped after ${round(closed.upMs / 1000)} s (${closed.by}, ${closed.code}); again in ${secText(waitMs)}`)
  }
  const back = (path: string, gapMs: number | null): void => {
    const drop = [...out.drops].reverse().find((entry) => entry.path === path && entry.backAfterMs === null)
    if (drop && gapMs !== null) drop.backAfterMs = round(gapMs)
  }
  const retry = (path: string) => (error: unknown, waitMs: number) => note(`${path}: ${messageOf(error)}; again in ${secText(waitMs)}`)
  // Each sampler's clock starts with its first connection; a later drop counts as skipped probes and a gap.
  const loops = Promise.all([
    keepUp<Tunnel>(
      async () => {
        const tunnel = await connectTunnel(target, { window: plan.window }, either)
        try {
          tunnelRtt.attach(new StreamEcho(tunnel, await tunnel.open('echo', 1)))
        } catch (error) {
          tunnel.kill('local')
          throw error
        }
        tunnelRtt.start()
        return tunnel
      },
      { up: (_, gapMs) => back('tunnel', gapMs), down: (_, closed, waitMs) => dropped('tunnel', tunnelRtt, closed, waitMs), retry: retry('tunnel') },
      either,
    ),
    keepUp<EchoSocket>(
      async () => {
        const socket = await connectEcho(target, 0, DEAD_MS, either)
        socketRtt.attach(socket)
        socketRtt.start()
        return socket
      },
      { up: (_, gapMs) => back('socket', gapMs), down: (_, closed, waitMs) => dropped('socket', socketRtt, closed, waitMs), retry: retry('socket') },
      either,
    ),
  ])
  const started = performance.now()
  await pause(plan.minutes * 60_000, signal)
  out.seconds = round((performance.now() - started) / 1000)
  const [tunnel, socket] = await Promise.all([tunnelRtt.stop(signal), socketRtt.stop(signal)])
  out.tunnel = tunnel
  out.socket = socket
  done.abort()
  await loops
  note(`tunnel p50 ${msText(tunnel.p50)} p95 ${msText(tunnel.p95)} ms · socket p50 ${msText(socket.p50)} p95 ${msText(socket.p95)} ms`)
}

/** A median RTT from `count` probes on a fresh echo stream: what the window's ceiling is computed against. */
async function quickRtt(tunnel: Tunnel, count: number, signal: AbortSignal): Promise<number | null> {
  const stream = await tunnel.open('echo', 1)
  const sampler = new Sampler(10)
  sampler.attach(new StreamEcho(tunnel, stream))
  sampler.start()
  await pause(count * 100, signal)
  const stats = await sampler.stop(signal)
  tunnel.reset(stream)
  return stats.p50
}

/**
 * Step 2: each kind and count for tpSeconds, unpaced. Moved bytes are what
 * the far end confirmed. A run Ctrl-C cut short is left out: it measured
 * something shorter than the plan's run, or only the interruption.
 */
async function stepRate(target: Target, plan: Plan, signal: AbortSignal, out: RateStep, note: Note): Promise<void> {
  const probe = await connectTunnel(target, { window: plan.window }, signal)
  try {
    out.rttMs = await quickRtt(probe, 10, signal)
  } finally {
    probe.close()
  }
  for (const kind of RATE_KINDS) {
    for (const streams of [1, 2, 4]) {
      if (signal.aborted) return
      const run = await rateRun(target, plan, kind, streams, signal)
      if (signal.aborted) return
      out.runs.push(run)
      note(`${kind} × ${streams}: ${run.error ?? `${rateText(run.mibps)} MiB/s`}`)
      await pause(Math.min(plan.settleMs, 1000), signal)
    }
  }
}

async function rateRun(target: Target, plan: Plan, kind: RateKind, streams: number, signal: AbortSignal): Promise<RateRun> {
  const ms = plan.tpSeconds * 1000
  const run: RateRun = { kind, streams, mibps: null, perStream: [], error: null }
  try {
    if (kind === 'tunnel up' || kind === 'tunnel down') {
      const tunnel = await connectTunnel(target, { window: plan.window }, signal)
      try {
        const opened = await Promise.all(
          Array.from({ length: streams }, () => (kind === 'tunnel up' ? tunnel.open('sink', 1) : tunnel.open('source', 1, { bytes: BLOB_MAX, rateMBps: 0 }))),
        )
        const started = performance.now()
        if (kind === 'tunnel up') for (const stream of opened) stream.generate = Infinity
        tunnel.kick()
        await pause(ms, signal)
        const took = performance.now() - started
        const moved = opened.map((stream) => (kind === 'tunnel up' ? stream.acked : stream.rx))
        if (opened.some((stream) => stream.closed)) run.error = 'a stream closed during the run'
        run.perStream = moved.map((bytes) => mibps(bytes, took))
        run.mibps = mibps(moved.reduce((sum, bytes) => sum + bytes, 0), took)
        for (const stream of opened) tunnel.reset(stream)
      } finally {
        tunnel.kill('local')
      }
    } else {
      // Both ways stop at home's cap if a fast link gets there before the time is up.
      const results = await Promise.all(
        Array.from({ length: streams }, () => {
          const order: BlobOrder = { bytes: BLOB_MAX, rate: 0, pacing: 'paced', signal, stopAfterMs: ms }
          return kind === 'http down' ? getBlob(target, order) : putBlob(target, order)
        }),
      )
      run.error = results.find((result) => result.error)?.error ?? null
      run.perStream = results.map((result) => mibps(result.bytes, result.ms))
      run.mibps = mibps(
        results.reduce((sum, result) => sum + result.bytes, 0),
        Math.max(...results.map((result) => result.ms)),
      )
    }
  } catch (error) {
    run.error = messageOf(error)
  }
  return run
}

/** Two samplers, one per path, over the time `work` takes. */
async function sampleDuring(tunnelPath: EchoPath, socket: EchoSocket, hz: number, signal: AbortSignal, work: () => Promise<void>): Promise<PathStats> {
  const onTunnel = new Sampler(hz)
  const onSocket = new Sampler(hz)
  onTunnel.attach(tunnelPath)
  onSocket.attach(socket)
  onTunnel.start()
  onSocket.start()
  // Stopped on every way out, so no sampler's interval outlives the step.
  const stopBoth = () => Promise.all([onTunnel.stop(signal), onSocket.stop(signal)])
  try {
    await work()
  } catch (error) {
    await stopBoth()
    throw error
  }
  const [overTunnel, overSocket] = await stopBoth()
  return { tunnel: overTunnel, socket: overSocket }
}

/** Step 3: a baseline, then bulkBytes at each rate paced and unpaced, then with no limit. A run Ctrl-C cut short is left out. */
async function stepBulk(target: Target, plan: Plan, signal: AbortSignal, out: BulkStep, note: Note): Promise<void> {
  const tunnel = await connectTunnel(target, { window: plan.window, pace: plan.pace }, signal)
  try {
    const socket = await connectEcho(target, 0, DEAD_MS, signal)
    try {
      const path = new StreamEcho(tunnel, await tunnel.open('echo', 1))
      out.baseline = await sampleDuring(path, socket, plan.sampleHz, signal, () => pause(plan.baselineMs, signal))
      note(`baseline: tunnel p95 ${msText(out.baseline.tunnel?.p95)} ms, socket p95 ${msText(out.baseline.socket?.p95)} ms`)
      const matrix: { rate: number; pacing: Pacing }[] = [
        ...plan.rates.flatMap((rate) => (['paced', 'bursty'] as const).map((pacing) => ({ rate, pacing }))),
        { rate: 0, pacing: 'paced' },
      ]
      for (const { rate, pacing } of matrix) {
        if (signal.aborted) break
        let bulk: BlobResult | null = null
        const rtt = await sampleDuring(path, socket, plan.sampleHz, signal, async () => {
          bulk = await moveBulk(target, plan.bulkDir, plan.bulkBytes, rate, pacing, signal)
        })
        if (signal.aborted) break
        const run: BulkRun = { rate, pacing, bulk, ...rtt }
        out.runs.push(run)
        note(`${bulkLabel(run)}: ${run.bulk?.error ?? `${rateText(mibps(run.bulk?.bytes ?? 0, run.bulk?.ms ?? 0))} MiB/s`} · tunnel p95 ${msText(rtt.tunnel?.p95)} ms · socket p95 ${msText(rtt.socket?.p95)} ms`)
        await pause(plan.settleMs, signal)
      }
    } finally {
      socket.close()
    }
  } finally {
    tunnel.close()
  }
}

interface FigureTime {
  /** Until home's ACK of the last byte; null after FIGURE_MS. */
  ms: number | null
  /** What the machine's bucket on lanes 1-2 held as the figure began, bytes; null unpaced. */
  bucket: number | null
}

/** One figure: bytes on a fresh sink stream on lane 1, timed until home's ACK of the last one is back. */
async function sendFigure(tunnel: Tunnel, bytes: number, signal: AbortSignal): Promise<FigureTime> {
  const stream = await tunnel.open('sink', 1)
  const started = performance.now()
  const delivered = new Promise<number>((resolve, reject) => {
    stream.onAck = (acked) => {
      if (acked >= bytes) resolve(performance.now() - started)
    }
    stream.onClose = (why) => reject(new Error(`the figure's stream closed: ${why}`))
  })
  // What the bucket does not hold of the figure goes no faster than the pace, on any link.
  const bucket = tunnel.paceLevel()
  stream.generate = bytes
  tunnel.end(stream)
  tunnel.kick()
  const ms = await within(delivered, FIGURE_MS, signal)
  if (!stream.closed && ms === null) tunnel.reset(stream)
  return { ms: ms === null ? null : round(ms), bucket: bucket === null ? null : Math.round(bucket) }
}

/**
 * `count` figures into `condition`, each after `refill`. A figure Ctrl-C cut
 * off measured nothing, and neither it nor any after it is kept: a null
 * among the times is a figure that timed out, never an interrupted one.
 */
async function figureRun(condition: FigureCondition, count: number, signal: AbortSignal, refill: () => Promise<void>, send: () => Promise<FigureTime>): Promise<void> {
  for (let i = 0; i < count; i++) {
    await refill()
    if (signal.aborted) return
    const figure = await send()
    if (figure.ms === null && signal.aborted) return
    condition.ms.push(figure.ms)
    condition.bucket.push(figure.bucket)
  }
}

/**
 * Step 4: the figure, `figures` times under each load, with the tunnel RTT
 * sampled meanwhile. Bulk runs both ways: up, machine → home, is the
 * figure's own direction and that of class uploads (§4.9); down is the
 * barrier's. Each figure waits for the machine's bucket to refill first, so
 * every one of a load is measured alike: back to back, the second 2 MB figure
 * would wait out the first one's 2 MiB burst at the paced rate. The council
 * flood draws on the same bucket and spends the refill; what each figure
 * found in it is recorded with its time.
 */
async function stepFigure(target: Target, plan: Plan, signal: AbortSignal, out: FigureStep, note: Note): Promise<void> {
  const refillMs = plan.pace > 0 ? Math.ceil((PACE_BURST / (plan.pace * MiB)) * 1000) : 0
  const tunnel = await connectTunnel(target, { window: plan.window, pace: plan.pace }, signal)
  try {
    const path = new StreamEcho(tunnel, await tunnel.open('echo', 1))
    const loads: { name: string; start(): Promise<() => Promise<string | null>> }[] = [
      { name: 'idle', start: async () => async () => null },
      ...(['up', 'down'] as const).flatMap((dir) => [
        { name: `bulk ${plan.bulkRate} MiB/s ${dir}`, start: async () => background(target, dir, plan.bulkRate, signal) },
        { name: `bulk ${dir}, no limit`, start: async () => background(target, dir, 0, signal) },
      ]),
      {
        name: 'council flood, lane 2',
        start: async () => {
          const flood = await tunnel.open('sink', 2)
          flood.generate = Infinity
          tunnel.kick()
          return async () => {
            const lost = flood.closed
            tunnel.reset(flood)
            return lost ? 'the flood stream closed under the load' : null
          }
        },
      },
    ]
    for (const load of loads) {
      if (signal.aborted) break
      const condition: FigureCondition = { name: load.name, ms: [], bucket: [], rtt: null, error: null }
      out.conditions.push(condition)
      let stopLoad: (() => Promise<string | null>) | null = null
      const sampler = new Sampler(plan.sampleHz)
      try {
        stopLoad = await load.start()
        await pause(plan.settleMs, signal)
        sampler.attach(path)
        sampler.start()
        await figureRun(condition, plan.figures, signal, () => pause(refillMs, signal), () => sendFigure(tunnel, plan.figureBytes, signal))
      } catch (error) {
        condition.error = messageOf(error)
      } finally {
        condition.rtt = await sampler.stop(signal)
        const failed = await stopLoad?.()
        // A load that died early leaves figures measured on a quiet path: said, not hidden.
        if (failed) condition.error ??= `the load: ${failed}`
      }
      // A load Ctrl-C broke off before its first figure measured nothing.
      if (signal.aborted && condition.ms.length === 0 && !condition.error) {
        out.conditions.pop()
        break
      }
      note(`${load.name}: ${condition.error ?? condition.ms.map((ms) => msText(ms)).join(', ')} ms · tunnel p95 ${msText(condition.rtt?.p95)} ms`)
      await pause(plan.settleMs, signal)
    }
  } finally {
    tunnel.close()
  }
}

/** Step 6: every silence at once, each on a tunnel and an echo socket of its own. */
async function stepIdle(target: Target, plan: Plan, signal: AbortSignal, out: IdleStep): Promise<void> {
  const failed = (error: unknown): IdleOutcome => (signal.aborted ? { outcome: 'interrupted' } : { outcome: 'error', detail: messageOf(error) })
  await Promise.all(
    plan.idle.map(async (seconds) => {
      const run: IdleRun = { seconds, tunnel: null, socket: null }
      out.runs.push(run)
      await Promise.all([
        idleTunnel(target, plan, seconds, signal).then((outcome) => (run.tunnel = outcome), (error) => (run.tunnel = failed(error))),
        idleSocket(target, seconds, signal).then((outcome) => (run.socket = outcome), (error) => (run.socket = failed(error))),
      ])
    }),
  )
  out.runs.sort((a, b) => a.seconds - b.seconds)
}

/** One echo, silence, one echo: what became of the connection in between. An echo Ctrl-C cut off is no black hole. */
async function afterSilence(path: EchoPath, closed: Promise<Closed>, seconds: number, signal: AbortSignal): Promise<IdleOutcome> {
  const first = await echoOnce(path, signal)
  if (signal.aborted) return { outcome: 'interrupted' }
  if (first === null) return { outcome: 'silent', detail: 'no first echo' }
  // The first echo's ACKs pass first, so that the silence is silence.
  await pause(ACK_MS * 4, signal)
  const quietFrom = performance.now()
  const ended = await within(closed, seconds * 1000, signal)
  if (ended) return { outcome: 'closed', afterS: round((performance.now() - quietFrom) / 1000), code: ended.code, detail: ended.reason || ended.by }
  if (signal.aborted) return { outcome: 'interrupted' }
  const rtt = await echoOnce(path, signal)
  if (rtt === null && signal.aborted) return { outcome: 'interrupted' }
  return rtt === null ? { outcome: 'silent', detail: `no answer in ${REPLY_MS / 1000} s` } : { outcome: 'survived', rttMs: round(rtt) }
}

async function idleTunnel(target: Target, plan: Plan, seconds: number, signal: AbortSignal): Promise<IdleOutcome> {
  // No pings, no dead timer, at either end: the HELLO asks home for the same.
  const tunnel = await connectTunnel(target, { pingMs: 0, deadMs: 0, window: plan.window }, signal)
  try {
    return await afterSilence(new StreamEcho(tunnel, await tunnel.open('echo', 1)), tunnel.closed, seconds, signal)
  } finally {
    tunnel.close()
  }
}

async function idleSocket(target: Target, seconds: number, signal: AbortSignal): Promise<IdleOutcome> {
  const socket = await connectEcho(target, 0, 0, signal)
  try {
    return await afterSilence(socket, socket.closed, seconds, signal)
  } finally {
    socket.close()
  }
}

/** Step 9: frameBytes there and back, `frames` times on each path; a black hole shows as a timeout. */
async function stepFrames(target: Target, plan: Plan, signal: AbortSignal, out: FramesStep): Promise<void> {
  const socket = await connectEcho(target, 0, 0, signal)
  try {
    out.socket = await roundTrips(plan, signal, (payload) => {
      const back = new Promise<Buffer>((resolve) => (socket.onMessage = resolve))
      socket.ws.send(payload)
      return back
    })
  } finally {
    socket.close()
  }
  if (signal.aborted) return
  const tunnel = await connectTunnel(target, { window: plan.window }, signal)
  try {
    const stream = await tunnel.open('echo', 1)
    out.tunnel = await roundTrips(plan, signal, (payload) => {
      const parts: Buffer[] = []
      let got = 0
      const back = new Promise<Buffer>((resolve) => {
        stream.onData = (chunk) => {
          parts.push(chunk)
          got += chunk.length
          if (got >= payload.length) resolve(Buffer.concat(parts))
        }
      })
      tunnel.write(stream, payload)
      return back
    })
  } finally {
    tunnel.close()
  }
}

async function roundTrips(plan: Plan, signal: AbortSignal, bounce: (payload: Buffer) => Promise<Buffer>): Promise<FramesResult> {
  const result: FramesResult = { ms: [], timeouts: 0, corrupt: 0, error: null }
  for (let i = 0; i < plan.frames && !signal.aborted; i++) {
    const payload = randomBytes(plan.frameBytes)
    const started = performance.now()
    const back = await within(bounce(payload), BIG_MS, signal)
    if (back === null) {
      if (!signal.aborted) result.timeouts++
      // Whatever was stuck stays stuck: the path is spent.
      break
    }
    result.ms.push(round(performance.now() - started))
    if (back.length !== payload.length || sha(back) !== sha(payload)) result.corrupt++
  }
  return result
}

/* ------------------------------------------------------------------ watch */

interface WatchOptions {
  minutes: number
  tunnels: number
  sockets: number
  trickleHz: number
  stallMs: number
  pace: number
  window: number
}

interface WatchPath {
  path: string
  ups: number
  drops: number
  retries: number
  longestGapMs: number
  downMs: number
  stalls: number
  longestStallMs: number
  lostDownBytes: number
  lostUpBytes: number
  /** Drops whose losses home could not tell: it restarted, or never saw the tunnel. */
  lossUnknown: number
  ping: RttStats | null
  dropList: DropNote[]
}

interface WatchSummary {
  probe: number
  mode: 'watch'
  host: string
  node: string
  startedAt: string
  endedAt: string | null
  hours: number
  options: WatchOptions
  paths: WatchPath[]
}

interface Counts {
  tx: number
  rx: number
}

/**
 * What a cut ate each way, from what both ends counted of one stream: home's
 * framed bytes the machine never got (down), and the machine's that home
 * never got (up). Neither can be negative for counts of the same stream, so
 * a negative one is left to show that they are not.
 */
function cutLoss(machine: Counts, home: Counts): { down: number; up: number } {
  return { down: home.tx - machine.rx, up: machine.tx - home.rx }
}

/**
 * Watch: every connection kept up until the signal, every event a JSON line
 * through `emit`. A tunnel's trickle counts what each end framed and what
 * it received; after a cut, home's WELCOME carries its counts for the lost
 * tunnel, and the difference is what the cut ate in each direction.
 * `wait` is keepUp's, for the selftest to count.
 */
async function runWatch(target: Target, options: WatchOptions, signal: AbortSignal, emit: Log, summary: WatchSummary, wait = pause): Promise<void> {
  const started = performance.now()
  /** Round trips of the tunnels a path has lost; the live one's are read off it. */
  const pings = new Map<WatchPath, number[]>()
  const liveTunnels = new Map<WatchPath, Tunnel>()
  const socketPings = new Map<WatchPath, Sampler>()
  const newPath = (path: string): WatchPath => {
    const entry: WatchPath = { path, ups: 0, drops: 0, retries: 0, longestGapMs: 0, downMs: 0, stalls: 0, longestStallMs: 0, lostDownBytes: 0, lostUpBytes: 0, lossUnknown: 0, ping: null, dropList: [] }
    summary.paths.push(entry)
    pings.set(entry, [])
    return entry
  }
  const settle = (): void => {
    summary.hours = round((performance.now() - started) / 3_600_000, 6)
    for (const [entry, samples] of pings) {
      const all = [...samples, ...(liveTunnels.get(entry)?.rtts ?? [])]
      entry.ping = socketPings.get(entry)?.stats() ?? (all.length ? rttStats(all) : null)
    }
  }
  const dropped = (entry: WatchPath, closed: Closed, waitMs: number, fields: Record<string, unknown> = {}): void => {
    entry.drops++
    const drop: DropNote = { path: entry.path, at: new Date().toISOString(), by: closed.by, code: closed.code, reason: closed.reason, upS: round(closed.upMs / 1000), backAfterMs: null }
    entry.dropList.push(drop)
    emit('drop', { path: entry.path, by: closed.by, code: closed.code, reason: closed.reason, upS: drop.upS, quietMs: round(closed.quietMs), retryInMs: waitMs, ...fields })
    void relayState(target).then((relay) => emit('relay', { path: entry.path, relay }))
  }
  const back = (entry: WatchPath, gapMs: number | null, tries: number, fields: Record<string, unknown> = {}): void => {
    entry.ups++
    if (gapMs !== null) {
      entry.longestGapMs = Math.max(entry.longestGapMs, round(gapMs))
      entry.downMs = round(entry.downMs + gapMs)
      const drop = entry.dropList[entry.dropList.length - 1]
      if (drop) drop.backAfterMs = round(gapMs)
    }
    emit('up', { path: entry.path, tries, gapMs: gapMs === null ? null : round(gapMs), ...fields })
  }
  const retried = (entry: WatchPath) => (error: unknown, waitMs: number) => {
    entry.retries++
    emit('retry', { path: entry.path, error: messageOf(error), waitMs })
  }

  const watchTunnel = async (entry: WatchPath): Promise<void> => {
    const trickles = new Map<Tunnel, Stream>()
    const losses = new Map<Tunnel, Record<string, unknown>>()
    let home: unknown = null
    await keepUp<Tunnel>(
      async (previous) => {
        const tunnel = await connectTunnel(target, { prev: previous?.id ?? null, pace: options.pace, window: options.window }, signal)
        let trickle: Stream | null = null
        if (options.trickleHz > 0) {
          try {
            trickle = await tunnel.open('trickle', 1, { hz: options.trickleHz })
          } catch (error) {
            tunnel.kill('local')
            throw error
          }
          const stream = trickle
          let lastAt = performance.now()
          stream.onData = () => {
            const now = performance.now()
            const gap = now - lastAt
            lastAt = now
            if (gap <= options.stallMs) return
            entry.stalls++
            entry.longestStallMs = Math.max(entry.longestStallMs, round(gap))
            emit('stall', { path: entry.path, ms: round(gap) })
          }
          const timer = setInterval(() => tunnel.write(stream, FILLER.subarray(0, TRICKLE_BYTES)), 1000 / options.trickleHz)
          stream.onClose = () => clearInterval(timer)
        }
        // Up for good: only now are the lost tunnel's counters spent, so a failed try leaves them to the next.
        const fields: Record<string, unknown> = {}
        if (home !== null && tunnel.welcomed?.home !== home) fields.homeRestarted = true
        home = tunnel.welcomed?.home ?? null
        const lost = previous ? trickles.get(previous) : undefined
        if (previous) trickles.delete(previous)
        if (lost) {
          const there = tunnel.welcomed?.prev as { tx?: unknown; rx?: unknown } | null | undefined
          if (there && typeof there.tx === 'number' && typeof there.rx === 'number') {
            const loss = cutLoss(lost, { tx: there.tx, rx: there.rx })
            fields.lostDownBytes = loss.down
            fields.lostUpBytes = loss.up
            entry.lostDownBytes += loss.down
            entry.lostUpBytes += loss.up
          } else {
            fields.lostDownBytes = null
            fields.lostUpBytes = null
            entry.lossUnknown++
          }
        }
        if (trickle) trickles.set(tunnel, trickle)
        losses.set(tunnel, fields)
        return tunnel
      },
      {
        up: (tunnel, gapMs, tries) => {
          liveTunnels.set(entry, tunnel)
          back(entry, gapMs, tries, losses.get(tunnel))
        },
        down: (tunnel, closed, waitMs) => {
          liveTunnels.delete(entry)
          pings.get(entry)?.push(...tunnel.rtts)
          losses.delete(tunnel)
          // This end's half of the counts the return sets against home's, as they stood when the tunnel went; home logs its half under the same id.
          const trickle = trickles.get(tunnel)
          dropped(entry, closed, waitMs, { tunnel: tunnel.id, ...(trickle ? { trickleTx: trickle.tx, trickleRx: trickle.rx } : {}) })
        },
        retry: retried(entry),
      },
      signal,
      wait,
    )
  }

  // A socket's keepalive is a probe every PING_MS, so its round trips are measured as it is kept.
  const watchSocket = async (entry: WatchPath): Promise<void> => {
    const sampler = new Sampler(1000 / PING_MS)
    socketPings.set(entry, sampler)
    await keepUp<EchoSocket>(
      async () => {
        const socket = await connectEcho(target, 0, DEAD_MS, signal)
        sampler.attach(socket)
        sampler.start()
        return socket
      },
      {
        up: (_, gapMs, tries) => back(entry, gapMs, tries),
        down: (_, closed, waitMs) => {
          sampler.detach()
          dropped(entry, closed, waitMs)
        },
        retry: retried(entry),
      },
      signal,
      wait,
    )
    await sampler.stop(signal)
  }

  const alive = setInterval(() => {
    settle()
    emit('alive', { hours: summary.hours, drops: summary.paths.reduce((sum, entry) => sum + entry.drops, 0) })
  }, 600_000)
  try {
    await Promise.all([
      ...Array.from({ length: options.tunnels }, (_, i) => watchTunnel(newPath(`tunnel ${i + 1}`))),
      ...Array.from({ length: options.sockets }, (_, i) => watchSocket(newPath(`socket ${i + 1}`))),
    ])
  } finally {
    clearInterval(alive)
    settle()
  }
}

/** What relay2 says about home's name (its own page: no token goes there). */
async function relayState(target: Target): Promise<string> {
  try {
    const response = await fetch(`${target.origin}/.relay/state`, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (!response.ok) return `HTTP ${response.status}`
    const value = jsonOfText((await response.text()).slice(0, JSON_MAX))
    if (!value || typeof value.known !== 'boolean') return 'not the relay'
    return !value.known ? 'the relay has no record of this name' : value.tunnel === true ? "the relay sees home's tunnel up" : "the relay sees home's tunnel down"
  } catch {
    return 'unreachable'
  }
}

/* ----------------------------------------------------------------- output */

const colour = (code: number) => (text: string): string => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = colour(1)
const red = colour(31)
const missing = (value: number | null | undefined): value is null | undefined => value === null || value === undefined || !Number.isFinite(value)
const msText = (value: number | null | undefined): string => (missing(value) ? '—' : value < 10 ? value.toFixed(1) : value.toFixed(0))
const secText = (ms: number | null | undefined): string => (missing(ms) ? '—' : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`)
const rateText = (value: number | null | undefined): string => (missing(value) ? '—' : value.toFixed(value < 10 ? 2 : 1))

function sizeText(bytes: number): string {
  if (bytes >= MiB && bytes % MiB === 0) return `${bytes / MiB} MiB`
  if (bytes >= 1e6 && bytes % 1e6 === 0) return `${bytes / 1e6} MB`
  if (bytes >= KiB && bytes % KiB === 0) return `${bytes / KiB} KiB`
  return `${bytes} B`
}

/** Columns padded to fit; the first one left, the rest right. */
function grid(rows: string[][]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)))
  return rows.map((row) => `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('   ')}`.trimEnd())
}

const rttCells = (stats: RttStats | null | undefined): string[] => [msText(stats?.p50), msText(stats?.p95), msText(stats?.p99), msText(stats?.max)]
const delta = (value: number | null | undefined, base: number | null | undefined): string =>
  missing(value) || missing(base) ? '—' : `${value >= base ? '+' : ''}${msText(value - base)}`
const bulkLabel = (run: BulkRun): string => (run.rate === 0 ? 'no limit' : `${run.rate} MiB/s ${run.pacing === 'paced' ? 'paced' : 'unpaced'}`)
/** The least a figure of `bytes` takes at `pace` MiB/s when the machine's bucket held `held` bytes of it as it began. */
const paceFloorMs = (bytes: number, held: number, pace: number): number => (Math.max(0, bytes - held) / (pace * MiB)) * 1000

function idleText(outcome: IdleOutcome | null): string {
  if (!outcome) return '—'
  if (outcome.outcome === 'survived') return `alive (${msText(outcome.rttMs)} ms)`
  if (outcome.outcome === 'closed') return `closed after ${outcome.afterS} s (${outcome.code}${outcome.detail ? `, ${outcome.detail}` : ''})`
  if (outcome.outcome === 'silent') return `black hole: ${outcome.detail ?? 'no answer'}`
  return `${outcome.outcome}${outcome.detail ? `: ${outcome.detail}` : ''}`
}

function report(summary: Summary): string[] {
  const lines = [bold(`class-probe · ${summary.host} · ${summary.startedAt.replace('T', ' ').slice(0, 16)} UTC · node ${summary.node}${summary.interrupted ? ' · interrupted' : ''}`)]
  const steps = summary.steps
  const one = steps[1]
  if (one) {
    const cut = one.seconds !== null && one.seconds < one.minutes * 60 - 1 ? ` (${one.seconds} s of it)` : ''
    lines.push('', bold(`1 RTT · ${one.minutes} min${cut} at ${one.hz} Hz · ms`))
    lines.push(
      ...grid([
        ['', 'n', 'p50', 'p95', 'p99', 'max', 'longest gap', 'lost', 'skipped'],
        ...([['tunnel echo, lane 1', one.tunnel], ['echo socket', one.socket]] as const).map(([label, stats]) => [
          label,
          String(stats?.n ?? '—'),
          ...rttCells(stats),
          secText(stats?.gapMs),
          String(stats?.lost ?? '—'),
          String(stats?.skipped ?? '—'),
        ]),
      ]),
    )
    for (const drop of one.drops) {
      lines.push(`  drop: ${drop.path} at ${drop.at.slice(11, 19)} after ${drop.upS} s up (${drop.by}, ${drop.code}${drop.reason ? `, ${drop.reason}` : ''}), back after ${secText(drop.backAfterMs)}`)
    }
  }
  const two = steps[2]
  if (two) {
    const ceiling = two.rttMs ? two.window / MiB / (two.rttMs / 1000) : null
    lines.push('', bold(`2 RATE · ${two.seconds} s a run, unpaced · MiB/s`))
    if (ceiling !== null) lines.push(`  a ${sizeText(two.window)} window over a ${msText(two.rttMs)} ms RTT allows at most ${rateText(ceiling)} MiB/s a stream`)
    lines.push(
      ...grid([
        ['', 'streams', 'total', 'each'],
        ...two.runs.map((run, i) => [
          i > 0 && two.runs[i - 1].kind === run.kind ? '' : run.kind,
          String(run.streams),
          rateText(run.mibps),
          run.error ? `failed: ${run.error}` : run.perStream.map((value) => rateText(value)).join(' '),
        ]),
      ]),
    )
  }
  const three = steps[3]
  if (three) {
    lines.push('', bold(`3 BULK · ${sizeText(three.bytes)} ${three.dir === 'down' ? 'home → machine by GET' : 'machine → home by PUT'} · tunnel paced at ${three.pace || 'no'} MiB/s · RTT at ${three.sampleHz} Hz, ms`))
    const base = three.baseline
    lines.push(
      ...grid([
        ['', 'MiB/s', 'time', 'tunnel p50', 'p95', 'p99', 'max', 'Δp95', 'socket p50', 'p95', 'p99', 'max', 'Δp95'],
        ['baseline', '—', '—', ...rttCells(base?.tunnel), '—', ...rttCells(base?.socket), '—'],
        ...three.runs.map((run) => [
          bulkLabel(run),
          run.bulk?.error ? 'failed' : rateText(mibps(run.bulk?.bytes ?? 0, run.bulk?.ms ?? 0)),
          secText(run.bulk?.ms),
          ...rttCells(run.tunnel),
          delta(run.tunnel?.p95, base?.tunnel?.p95),
          ...rttCells(run.socket),
          delta(run.socket?.p95, base?.socket?.p95),
        ]),
      ]),
    )
    lines.push('  unpaced: each second\'s bytes leave at line speed at the top of the second')
    for (const run of three.runs) if (run.bulk?.error) lines.push(red(`  ${bulkLabel(run)}: ${run.bulk.error}`))
  }
  const four = steps[4]
  if (four) {
    lines.push('', bold(`4 FIGURE · ${sizeText(four.bytes)} machine → home on lane 1 · ms until home's ACK of the last byte · tunnel paced at ${four.pace || 'no'} MiB/s`))
    lines.push("  bulk up: machine → home by PUT, the figure's own way (class uploads); down: home → machine by GET")
    if (four.pace > 0) {
      lines.push(`  bucket: the least the machine's ${sizeText(PACE_BURST)} bucket held as a figure began; floor: what ${four.pace} MiB/s alone then takes for the rest`)
      lines.push('  the council flood draws on the same bucket; a time that sits on its floor measured the pace, not the relay')
    }
    lines.push(
      ...grid([
        ['', 'each', 'max', 'bucket MiB', 'floor', 'tunnel RTT p95'],
        ...four.conditions.map((condition) => {
          const got = condition.ms.filter((ms): ms is number => ms !== null)
          const held = condition.bucket.filter((bytes): bytes is number => bytes !== null)
          const least = held.length ? Math.min(...held) : null
          const floor = least === null || four.pace <= 0 ? null : paceFloorMs(four.bytes, least, four.pace)
          return [
            condition.name,
            condition.ms.map((ms) => (ms === null ? 'timeout' : msText(ms))).join(' ') || '—',
            got.length ? msText(Math.max(...got)) : '—',
            least === null ? '—' : rateText(least / MiB),
            floor === 0 ? '0' : msText(floor),
            msText(condition.rtt?.p95),
          ]
        }),
      ]),
    )
    for (const condition of four.conditions) if (condition.error) lines.push(red(`  ${condition.name}: ${condition.error}`))
  }
  const six = steps[6]
  if (six) {
    lines.push('', bold('6 IDLE · silence with no pings at either end'))
    lines.push(...grid([['silence', 'tunnel', 'echo socket'], ...six.runs.map((run) => [`${run.seconds} s`, idleText(run.tunnel), idleText(run.socket)])]))
  }
  const nine = steps[9]
  if (nine) {
    lines.push('', bold(`9 FRAMES · ${sizeText(nine.bytes)} there and back, ${nine.count} times · ms`))
    lines.push(
      ...grid([
        ['', 'each', 'max', 'timeouts', 'corrupt'],
        ...([['echo socket', nine.socket], ['tunnel echo', nine.tunnel]] as const).map(([label, result]) => [
          label,
          result ? result.ms.map((ms) => msText(ms)).join(' ') || '—' : '—',
          result?.ms.length ? msText(Math.max(...result.ms)) : '—',
          String(result?.timeouts ?? '—'),
          String(result?.corrupt ?? '—'),
        ]),
      ]),
    )
  }
  for (const [step, error] of Object.entries(summary.errors)) lines.push('', red(`step ${step} failed: ${error}`))
  return lines
}

function watchReport(summary: WatchSummary): string[] {
  const minutes = summary.hours * 60
  const lines = [
    bold(`class-probe watch · ${summary.host} · ${summary.startedAt.replace('T', ' ').slice(0, 16)} UTC · ${minutes.toFixed(1)} min · node ${summary.node}`),
  ]
  lines.push(
    ...grid([
      ['', 'ups', 'drops', 'per hour', 'longest gap', 'down', 'stalls', 'longest stall', 'lost ↓ B', 'lost ↑ B', 'unknown', 'ping p50', 'p95'],
      ...summary.paths.map((entry) => [
        entry.path,
        String(entry.ups),
        String(entry.drops),
        summary.hours > 0 ? (entry.drops / summary.hours).toFixed(2) : '—',
        secText(entry.longestGapMs),
        secText(entry.downMs),
        String(entry.stalls),
        entry.stalls ? secText(entry.longestStallMs) : '—',
        String(entry.lostDownBytes),
        String(entry.lostUpBytes),
        String(entry.lossUnknown),
        msText(entry.ping?.p50),
        msText(entry.ping?.p95),
      ]),
    ]),
  )
  return lines
}

/* ------------------------------------------------------------------ flags */

class Usage extends Error {}

const USAGE = `Usage: node scripts/class-probe.mts <mode> [flags]       PROBE_TOKEN in the environment, the same at both ends

  home      [--port 3999] [--bind 127.0.0.1]
  machine   --host HOST [--steps 1,2,3,4,6,9] [--out FILE]
            [--minutes 10] [--hz 1]                     step 1
            [--tp-seconds 8]                            step 2
            [--bulk-bytes 150MB] [--bulk-dir down|up] [--rates 8,4,2] [--baseline 10]   step 3
            [--figure-bytes 2MB] [--figures 3] [--bulk-rate 4]                          step 4, bulk both ways
            [--idle 20,40,70]                           step 6
            [--frame-bytes 1MiB] [--frames 5]           step 9
            [--pace 6] [--window 1MiB] [--sample-hz 5] [--settle 3]
  watch     --host HOST [--out FILE] [--minutes 0: until Ctrl-C] [--tunnels 1] [--sockets 0]
            [--trickle-hz 10: 0 for an idle tunnel] [--stall-ms 2000, or 3 trickle periods if longer]
            [--pace 6] [--window 1MiB]
  selftest  home and a short plan in this process on 127.0.0.1

HOST is a name (wss:// and https://) or a URL such as http://127.0.0.1:3999.
Sizes take B, KB, KiB, MB, MiB, GB or GiB. The header of this file says where each end runs.`

const FLAGS = {
  port: { type: 'string', default: '3999' },
  bind: { type: 'string', default: '127.0.0.1' },
  host: { type: 'string' },
  out: { type: 'string' },
  steps: { type: 'string', default: '1,2,3,4,6,9' },
  minutes: { type: 'string' },
  hz: { type: 'string', default: '1' },
  'sample-hz': { type: 'string', default: '5' },
  'tp-seconds': { type: 'string', default: '8' },
  'bulk-bytes': { type: 'string', default: '150MB' },
  'bulk-dir': { type: 'string', default: 'down' },
  rates: { type: 'string', default: '8,4,2' },
  'bulk-rate': { type: 'string', default: '4' },
  pace: { type: 'string', default: '6' },
  window: { type: 'string', default: '1MiB' },
  'figure-bytes': { type: 'string', default: '2MB' },
  figures: { type: 'string', default: '3' },
  idle: { type: 'string', default: '20,40,70' },
  'frame-bytes': { type: 'string', default: '1MiB' },
  frames: { type: 'string', default: '5' },
  settle: { type: 'string', default: '3' },
  baseline: { type: 'string', default: '10' },
  tunnels: { type: 'string', default: '1' },
  sockets: { type: 'string', default: '0' },
  'trickle-hz': { type: 'string', default: '10' },
  // Its default follows --trickle-hz: watchOptionsOf.
  'stall-ms': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

type Flags = Record<string, string | boolean | undefined>

const STEPS = [1, 2, 3, 4, 6, 9] as const
const OPERATOR_STEPS: Record<number, string> = {
  5: 'step 5 (cuts, resets per hour) is the operator\'s: run watch and cut with iptables (header)',
  7: 'step 7 (frpc\'s pool) is the operator\'s: watch --tunnels 3 --sockets 30, then count the pool lines in frps\'s log',
  8: 'step 8 (collaboration RTT in a real browser) is headless Chrome\'s, not this probe\'s',
}

function numberFlag(flags: Flags, name: string, min: number, max: number, fallback?: string): number {
  const raw = flags[name] ?? fallback
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value) || value < min || value > max) throw new Usage(`--${name}: a number from ${min} to ${max}, not "${String(raw)}"`)
  return value
}

function listFlag(flags: Flags, name: string, min: number, max: number): number[] {
  const raw = String(flags[name] ?? '')
  const values = raw.split(',').map((part) => part.trim()).filter(Boolean).map(Number)
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < min || value > max)) {
    throw new Usage(`--${name}: numbers from ${min} to ${max} with commas, not "${raw}"`)
  }
  return values
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, kib: KiB, mb: 1e6, mib: MiB, gb: 1e9, gib: 1024 * MiB }

function sizeFlag(flags: Flags, name: string, min: number, max: number): number {
  const raw = String(flags[name] ?? '')
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(raw.trim())
  const unit = match ? UNITS[(match[2] || 'b').toLowerCase()] : undefined
  const bytes = match && unit ? Math.round(Number(match[1]) * unit) : Number.NaN
  if (!Number.isFinite(bytes) || bytes < min || bytes > max) throw new Usage(`--${name}: a size from ${sizeText(min)} to ${sizeText(max)}, like 150MB or 1MiB, not "${raw}"`)
  return bytes
}

function stepsOf(raw: string): number[] {
  if (raw.trim() === 'all') return [...STEPS]
  const steps = raw.split(',').map((part) => part.trim()).filter(Boolean).map(Number)
  if (steps.length === 0) throw new Usage('--steps: which steps, like 1,2,3')
  for (const step of steps) {
    if (OPERATOR_STEPS[step]) throw new Usage(OPERATOR_STEPS[step])
    if (!(STEPS as readonly number[]).includes(step)) throw new Usage(`--steps: there is no step "${step}"; the probe runs ${STEPS.join(', ')}`)
  }
  return [...new Set(steps)].sort((a, b) => a - b)
}

function planOf(flags: Flags): Plan {
  const bulkDir = flags['bulk-dir']
  if (bulkDir !== 'down' && bulkDir !== 'up') throw new Usage('--bulk-dir: down (home → machine, GET) or up (machine → home, PUT)')
  const pace = numberFlag(flags, 'pace', 0, 1000)
  const bulkRate = numberFlag(flags, 'bulk-rate', 0.1, 1000)
  if (pace > 0 && pace < 0.1) throw new Usage('--pace: 0 for none, or at least 0.1 MiB/s')
  return {
    steps: stepsOf(String(flags.steps)),
    minutes: numberFlag(flags, 'minutes', 0.01, 24 * 60, '10'),
    hz: numberFlag(flags, 'hz', 0.1, 50),
    sampleHz: numberFlag(flags, 'sample-hz', 0.1, 50),
    tpSeconds: numberFlag(flags, 'tp-seconds', 0.2, 600),
    bulkBytes: sizeFlag(flags, 'bulk-bytes', KiB, BLOB_MAX),
    bulkDir,
    rates: listFlag(flags, 'rates', 0.1, 1000),
    bulkRate,
    pace,
    window: sizeFlag(flags, 'window', DATA_MAX, 64 * MiB),
    figureBytes: sizeFlag(flags, 'figure-bytes', 1, 256 * MiB),
    figures: Math.round(numberFlag(flags, 'figures', 1, 100)),
    idle: listFlag(flags, 'idle', 0.1, IDLE_CAP_MS / 1000 - REPLY_MS / 1000),
    frameBytes: sizeFlag(flags, 'frame-bytes', PROBE_BYTES, ECHO_MAX_PAYLOAD / 2),
    frames: Math.round(numberFlag(flags, 'frames', 1, 100)),
    settleMs: numberFlag(flags, 'settle', 0, 600) * 1000,
    baselineMs: numberFlag(flags, 'baseline', 0.1, 3600) * 1000,
  }
}

function requireToken(): string {
  const token = process.env.PROBE_TOKEN ?? ''
  if (token.length < 16) throw new Usage('PROBE_TOKEN: 16 characters or more, the same at both ends (openssl rand -hex 24)')
  return token
}

/* ------------------------------------------------------------------- modes */

const stop = new AbortController()
/** Whatever was measured, printed and written: the second Ctrl-C and a crash go through it. */
let emergency: (() => void) | null = null
/** Set by the modes that measure, for the words of a Ctrl-C. */
let measuring = false
/** Rejections nobody handled: the selftest collects them for a check of their own; every other mode dies of the first. */
let strays: unknown[] | null = null

const say = (text: string): void => void process.stdout.write(`${text}\n`)
const note: Note = (text) => void process.stderr.write(`${process.stderr.isTTY ? `\x1b[2m· ${text}\x1b[0m` : `· ${text}`}\n`)
const jsonLine: Log = (event, fields = {}) => say(JSON.stringify({ t: new Date().toISOString(), event, ...fields }))

function newSummary(mode: Summary['mode'], target: Target, plan: Plan): Summary {
  return { probe: PROTOCOL, mode, host: target.wsOrigin, node: process.version, startedAt: new Date().toISOString(), endedAt: null, interrupted: false, plan, steps: {}, errors: {} }
}

async function homeMode(flags: Flags): Promise<number> {
  const token = requireToken()
  const port = Math.round(numberFlag(flags, 'port', 0, 65535))
  const home = await startHome({ port, bind: String(flags.bind), token, log: jsonLine })
  await new Promise<void>((resolve) => (stop.signal.aborted ? resolve() : stop.signal.addEventListener('abort', () => resolve(), { once: true })))
  await home.close()
  jsonLine('stop', home.totals)
  return 0
}

async function machineMode(flags: Flags): Promise<number> {
  if (typeof flags.host !== 'string') throw new Usage('machine: --host HOST')
  const target = targetOf(flags.host, requireToken())
  const plan = planOf(flags)
  const out = typeof flags.out === 'string' ? flags.out : null
  const summary = newSummary('machine', target, plan)
  measuring = true
  let done = false
  const flush = (): void => {
    if (done) return
    done = true
    summary.interrupted ||= stop.signal.aborted
    summary.endedAt = new Date().toISOString()
    say(report(summary).join('\n'))
    if (out) {
      writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`)
      note(`the JSON is in ${out}`)
    } else note('no --out: the JSON summary was not written')
  }
  note(`class-probe → ${target.wsOrigin} · steps ${plan.steps.join(', ')}`)
  try {
    await preflight(target, stop.signal)
  } catch (error) {
    if (!stop.signal.aborted) throw error
    note('interrupted before the plan began: nothing was measured')
    return 130
  }
  emergency = flush
  await runPlan(target, plan, stop.signal, summary, note)
  flush()
  return summary.interrupted ? 130 : Object.keys(summary.errors).length ? 1 : 0
}

function watchOptionsOf(flags: Flags): WatchOptions {
  const trickleHz = numberFlag(flags, 'trickle-hz', 0, 100)
  if (trickleHz > 0 && trickleHz < 0.1) throw new Usage('--trickle-hz: 0 for none, or at least 0.1')
  // The gap between two trickle lines on a healthy link is no stall: the threshold stays well clear of it.
  const periodMs = trickleHz > 0 ? 1000 / trickleHz : 0
  const options: WatchOptions = {
    minutes: numberFlag(flags, 'minutes', 0, 7 * 24 * 60, '0'),
    tunnels: Math.round(numberFlag(flags, 'tunnels', 0, 16)),
    sockets: Math.round(numberFlag(flags, 'sockets', 0, 200)),
    trickleHz,
    stallMs: numberFlag(flags, 'stall-ms', 100, 600_000, String(Math.max(2000, Math.ceil(3 * periodMs)))),
    pace: numberFlag(flags, 'pace', 0, 1000),
    window: sizeFlag(flags, 'window', DATA_MAX, 64 * MiB),
  }
  if (options.tunnels + options.sockets === 0) throw new Usage('watch: --tunnels or --sockets, at least one')
  if (options.stallMs < 2 * periodMs) {
    throw new Usage(`--stall-ms: at least twice the trickle's period, ${Math.ceil(2 * periodMs)} at --trickle-hz ${trickleHz}, or every line counts as a stall`)
  }
  return options
}

async function watchMode(flags: Flags): Promise<number> {
  if (typeof flags.host !== 'string') throw new Usage('watch: --host HOST')
  const target = targetOf(flags.host, requireToken())
  const options = watchOptionsOf(flags)
  const out = typeof flags.out === 'string' ? flags.out : null
  const summary: WatchSummary = { probe: PROTOCOL, mode: 'watch', host: target.wsOrigin, node: process.version, startedAt: new Date().toISOString(), endedAt: null, hours: 0, options, paths: [] }
  measuring = true
  let done = false
  const flush = (): void => {
    if (done) return
    done = true
    summary.endedAt = new Date().toISOString()
    process.stderr.write(`${watchReport(summary).join('\n')}\n`)
    if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`)
  }
  emergency = flush
  const signal = options.minutes > 0 ? AbortSignal.any([stop.signal, AbortSignal.timeout(options.minutes * 60_000)]) : stop.signal
  await runWatch(target, options, signal, jsonLine, summary)
  flush()
  return 0
}

/**
 * A WebSocket stand-in that keeps what it is sent and never finishes a
 * write, so no send callback pumps again: what goes out is the scheduler's
 * own choice, counted with no network and no clock.
 */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  /** Whether a send fills the buffer, as a slow link would; it is drained by hand. */
  fills = false
  readonly sent: Frame[] = []

  send(data: Buffer): void {
    const frame = decodeFrame(data)
    if (typeof frame !== 'string') this.sent.push(frame)
    if (this.fills) this.bufferedAmount += data.length
  }

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.emit('close', 1006, EMPTY)
  }

  close(): void {
    this.terminate()
  }
}

/** §4.4 as the probe keeps it: lanes, round-robin turns, the shallow buffer, windows, the ACK cadence. */
function schedulerChecks(check: (name: string, ok: boolean) => void): void {
  const fresh = (fills: boolean) => {
    const socket = new FakeSocket()
    socket.fills = fills
    const tunnel = new Tunnel(socket as unknown as WebSocket, { role: 'home', pace: null, windows: { 1: STREAM_WINDOW, 2: STREAM_WINDOW / 2 }, totalWindow: TUNNEL_WINDOW })
    // Greeted, as a HELLO leaves it; nothing answers it.
    socket.emit('message', encodeFrame(KIND.HELLO, 0, 0, 0, jsonBytes({ protocol: PROTOCOL })), true)
    const data = () => socket.sent.filter((frame) => frame.kind === KIND.DATA)
    const bytes = () => data().reduce((sum, frame) => sum + frame.payload.length, 0)
    return { socket, tunnel, data, bytes }
  }

  const alone = fresh(false)
  alone.tunnel.write(alone.tunnel.accept(1, 1), Buffer.alloc(4 * DATA_MAX))
  check('scheduler: a lone stream sends its whole queue in one pump', alone.data().length === 4)
  alone.tunnel.kill('local')

  const lanes = fresh(true)
  const council = lanes.tunnel.accept(1, 2)
  const first = lanes.tunnel.accept(3, 1)
  const second = lanes.tunnel.accept(5, 1)
  // A full socket: everything queues, then drains at once.
  lanes.socket.bufferedAmount = SEND_LOWAT + 1
  for (const stream of [council, first, second]) lanes.tunnel.write(stream, Buffer.alloc(4 * DATA_MAX))
  lanes.socket.fills = false
  lanes.socket.bufferedAmount = 0
  lanes.tunnel.kick()
  // Which lane-1 stream goes first is wherever the round-robin stood; that they alternate is the rule.
  const frames = lanes.data()
  const councilFrom = frames.findIndex((frame) => frame.lane === 2)
  const interactive = frames.slice(0, councilFrom).map((frame) => frame.stream)
  check(
    'scheduler: lane 1 before lane 2, and its streams in turns',
    councilFrom === 8 && frames.slice(councilFrom).every((frame) => frame.stream === council.id) && interactive.every((stream, i) => i === 0 || stream !== interactive[i - 1]),
  )
  lanes.tunnel.kill('local')

  const shallow = fresh(true)
  shallow.tunnel.write(shallow.tunnel.accept(1, 1), Buffer.alloc(STREAM_WINDOW))
  check('scheduler: nothing more goes once ws holds over 64 KiB', shallow.data().length === 4 && shallow.socket.bufferedAmount > SEND_LOWAT)
  shallow.tunnel.kill('local')

  const windowed = fresh(false)
  windowed.tunnel.write(windowed.tunnel.accept(1, 1), Buffer.alloc(2 * STREAM_WINDOW))
  const before = windowed.bytes()
  windowed.socket.emit('message', encodeFrame(KIND.ACK, 0, 1, STREAM_WINDOW / 2), true)
  check('scheduler: a stream stays within its window of the ACK', before === STREAM_WINDOW && windowed.bytes() === STREAM_WINDOW * 1.5)
  windowed.tunnel.kill('local')

  const acking = fresh(false)
  acking.tunnel.accept(1, 1)
  for (let i = 0; i < 4; i++) acking.socket.emit('message', encodeFrame(KIND.DATA, 1, 1, i * DATA_MAX, Buffer.alloc(DATA_MAX)), true)
  const acks = acking.socket.sent.filter((frame) => frame.kind === KIND.ACK)
  check('scheduler: 64 KiB received is ACKed at once', acks.length === 1 && acks[0].offset === 4 * DATA_MAX)
  acking.tunnel.kill('local')
}

/** Ctrl-C in the middle of things, on stand-ins: nothing it cut off reads as a measurement or a failure, and nothing rejects unhandled. */
async function interruptChecks(check: (name: string, ok: boolean) => void, strayed: () => number): Promise<void> {
  const before = strayed()
  let late: (error: Error) => void = () => {}
  const given = await within(new Promise<never>((_, reject) => (late = reject)), REPLY_MS, AbortSignal.abort())
  late(new Error('a rejection after within() gave up on it'))
  await nextTurn()
  check('within: a promise given up on may still reject, and that is handled', given === null && strayed() === before)

  const condition = (): FigureCondition => ({ name: 'stand-in', ms: [], bucket: [], rtt: null, error: null })
  const inRefill = new AbortController()
  const refilled = condition()
  let refills = 0
  let sends = 0
  const refill = async (): Promise<void> => {
    if (++refills === 2) inRefill.abort()
  }
  await figureRun(refilled, 3, inRefill.signal, refill, async () => ({ ms: 10 * ++sends, bucket: null }))
  const inFlight = new AbortController()
  const flown = condition()
  let flights = 0
  await figureRun(flown, 3, inFlight.signal, async () => {}, async () => {
    if (++flights < 2) return { ms: 10, bucket: null }
    inFlight.abort()
    return { ms: null, bucket: null }
  })
  const timedOut = condition()
  await figureRun(timedOut, 2, new AbortController().signal, async () => {}, async () => ({ ms: null, bucket: null }))
  check(
    '4: a figure Ctrl-C cuts off, in its refill or in flight, is neither sent nor kept; a timeout still is',
    sends === 1 && refilled.ms.join() === '10' && flown.ms.join() === '10' && timedOut.ms.length === 2 && timedOut.ms.every((ms) => ms === null),
  )

  // Answers every probe at once, but for the one that brings Ctrl-C with it.
  const answering = (cutAt: number, cut: AbortController): EchoPath => {
    let probes = 0
    const path: EchoPath = {
      replies: null,
      send: (seq) => {
        if (++probes === cutAt) cut.abort()
        else queueMicrotask(() => path.replies?.(seq))
        return true
      },
    }
    return path
  }
  const neverClosed = new Promise<Closed>(() => {})
  const firstCut = new AbortController()
  const lastCut = new AbortController()
  const first = await afterSilence(answering(1, firstCut), neverClosed, 0.01, firstCut.signal)
  const last = await afterSilence(answering(2, lastCut), neverClosed, 0.01, lastCut.signal)
  check('6: an echo Ctrl-C cuts off is no black hole, before the silence or after it', first.outcome === 'interrupted' && last.outcome === 'interrupted')
}

/** Watch's stall threshold against its trickle, and the sum a cut's losses come from. */
function watchChecks(check: (name: string, ok: boolean) => void): void {
  const flags = (...args: string[]): Flags => parseArgs({ args: ['watch', ...args], allowPositionals: true, options: FLAGS }).values as Flags
  const refused = (...args: string[]): boolean => {
    try {
      watchOptionsOf(flags(...args))
      return false
    } catch (error) {
      return error instanceof Usage
    }
  }
  check(
    'watch: a slow trickle moves the stall threshold clear of its period, and one given below it is refused',
    watchOptionsOf(flags()).stallMs === 2000 && watchOptionsOf(flags('--trickle-hz', '0.25')).stallMs === 12_000 && refused('--trickle-hz', '0.25', '--stall-ms', '2000'),
  )
  const loss = cutLoss({ tx: 5000, rx: 1200 }, { tx: 2000, rx: 4100 })
  check("watch: a cut loses home's bytes the machine never got (down) and the machine's that home never got (up)", loss.down === 800 && loss.up === 900)
}

/**
 * The probe against itself on 127.0.0.1, in one process: the scheduler and
 * Ctrl-C on stand-ins, a refused token, every step of a short plan, steps
 * that Ctrl-C breaks off, and a watch through two cuts from home's side.
 * Each check counts what happened; none of them times anything.
 */
async function selfTest(): Promise<number> {
  measuring = true
  const caught: unknown[] = []
  strays = caught
  const token = randomBytes(18).toString('base64url')
  /** Set by a check that reads home's log, for the length of its run. */
  let onHomeLog: Log | null = null
  const home = await startHome({ port: 0, bind: '127.0.0.1', token, log: (event, fields) => onHomeLog?.(event, fields) })
  const target = targetOf(`http://127.0.0.1:${home.port}`, token)
  const checks: [string, boolean][] = []
  const check = (name: string, ok: boolean): void => void checks.push([name, ok])
  schedulerChecks(check)
  watchChecks(check)
  try {
    await interruptChecks(check, () => caught.length)
    const stranger = { ...target, token: 'not-the-token-at-all' }
    check('a blob without the token gets 401', (await getBlob(stranger, { bytes: KiB, rate: 0, pacing: 'paced', signal: stop.signal })).status === 401)
    check('a tunnel without the token gets 401', await connectTunnel(stranger, {}).then((tunnel) => (tunnel.kill('local'), false), (error: unknown) => /HTTP 401/.test(messageOf(error))))
    check('an echo socket without the token gets 401', await connectEcho(stranger, 0, 0).then((socket) => (socket.kill('local'), false), (error: unknown) => /HTTP 401/.test(messageOf(error))))

    // A client that reads its 401 and keeps its own half of the socket open.
    const lone = await startHome({ port: 0, bind: '127.0.0.1', token, log: () => {} })
    const holder = createConnection({ port: lone.port, host: '127.0.0.1', allowHalfOpen: true })
    holder.on('error', () => {})
    let refusal = ''
    holder.on('data', (chunk: Buffer) => void (refusal += chunk.toString('latin1')))
    await once(holder, 'connect')
    const answered = once(holder, 'end')
    holder.write(
      `GET ${DOORS.tunnel} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nAuthorization: Bearer ${stranger.token}\r\n\r\n`,
    )
    await answered
    const closedAll = await within(lone.close().then(() => true), REPLY_MS)
    holder.destroy()
    check('home: close() does not wait for a client that keeps a refused upgrade half open', refusal.startsWith('HTTP/1.1 401') && closedAll === true)

    const plan: Plan = {
      steps: [...STEPS],
      minutes: 0.03,
      hz: 10,
      sampleHz: 20,
      tpSeconds: 0.3,
      bulkBytes: 2 * MiB,
      bulkDir: 'down',
      rates: [16, 8],
      bulkRate: 8,
      pace: 6,
      window: STREAM_WINDOW,
      figureBytes: 512 * KiB,
      figures: 2,
      idle: [0.5, 1],
      frameBytes: MiB,
      frames: 2,
      settleMs: 100,
      baselineMs: 300,
    }
    const summary = newSummary('selftest', target, plan)
    emergency = () => say(report(summary).join('\n'))
    await preflight(target, stop.signal)
    // Home's own count of what step 4's bulk loads moved, by direction.
    let running = 0
    const fourMoved = { up: 0, down: 0 }
    onHomeLog = (event, fields = {}) => {
      const dir = fields.dir
      if (event === 'blob' && running === 4 && (dir === 'up' || dir === 'down')) fourMoved[dir] += Number(fields.bytes) || 0
    }
    await runPlan(target, plan, stop.signal, summary, (text) => {
      const begun = /^step (\d+):/.exec(text)
      if (begun) running = Number(begun[1])
      note(text)
    })
    onHomeLog = null
    say(report(summary).join('\n'))
    const { 1: one, 2: two, 3: three, 4: four, 6: six, 9: nine } = summary.steps
    check('no step failed', Object.keys(summary.errors).length === 0)
    check('1: both paths answered, none lost', !!one && (one.tunnel?.n ?? 0) > 0 && (one.socket?.n ?? 0) > 0 && one.tunnel?.lost === 0 && one.socket?.lost === 0)
    check('2: twelve runs, each moved bytes', !!two && two.runs.length === 12 && two.runs.every((run) => !run.error && (run.mibps ?? 0) > 0))
    check('2: an RTT for the window ceiling', !!two && two.rttMs !== null)
    check(
      '3: a baseline and every run, each moved every byte with probes answered on both paths',
      !!three &&
        (three.baseline?.tunnel?.n ?? 0) > 0 &&
        three.runs.length === plan.rates.length * 2 + 1 &&
        three.runs.every((run) => run.bulk?.error === null && run.bulk.bytes === plan.bulkBytes && (run.tunnel?.n ?? 0) > 0 && (run.socket?.n ?? 0) > 0),
    )
    check('4: six loads, every figure delivered', !!four && four.conditions.length === 6 && four.conditions.every((condition) => !condition.error && condition.ms.length === plan.figures && condition.ms.every((ms) => ms !== null)))
    check("4: its bulk moved both ways, up (the figure's own) as well as down", fourMoved.up > 0 && fourMoved.down > 0)
    const idle = four?.conditions.find((condition) => condition.name === 'idle')
    const flood = four?.conditions.find((condition) => condition.name.startsWith('council flood'))
    check(
      '4: an idle figure starts on a bucket that holds it; under the council flood, which drains that bucket, none does',
      !!idle &&
        !!flood &&
        idle.bucket.length === plan.figures &&
        idle.bucket.every((bytes) => bytes !== null && bytes >= plan.figureBytes) &&
        flood.bucket.length === plan.figures &&
        flood.bucket.every((bytes) => bytes !== null && bytes < plan.figureBytes),
    )
    check('6: every silence survived on both paths', !!six && six.runs.length === plan.idle.length && six.runs.every((run) => run.tunnel?.outcome === 'survived' && run.socket?.outcome === 'survived'))
    check('9: every frame came back whole on both paths', !!nine && [nine.socket, nine.tunnel].every((result) => result?.ms.length === plan.frames && result.timeouts === 0 && result.corrupt === 0))

    // A figure whose OPEN is under way when Ctrl-C comes: its stream is reset after within() gave up on it.
    const figureTunnel = await connectTunnel(target, { pace: plan.pace })
    const opening = new AbortController()
    const strayedBefore = caught.length
    const sending = sendFigure(figureTunnel, 64 * KiB, opening.signal)
    opening.abort()
    const cutFigure = await sending
    await nextTurn()
    figureTunnel.close()
    check('4: a figure whose OPEN Ctrl-C cuts short gives no time and leaves no rejection unhandled', cutFigure.ms === null && caught.length === strayedBefore)

    // Ctrl-C as each step begins (on its note), or at an event of home's in the middle of a run.
    const cutShort = async (step: number, change: Partial<Plan>, cutAt: ((event: string, fields: Record<string, unknown>) => boolean) | null): Promise<Summary> => {
      const cut = new AbortController()
      const partial = newSummary('selftest', target, { ...plan, ...change, steps: [step] })
      onHomeLog = (event, fields = {}) => {
        if (cutAt?.(event, fields)) cut.abort()
      }
      try {
        await runPlan(target, partial.plan, cut.signal, partial, (text) => {
          if (!cutAt && text.startsWith(`step ${step}:`)) cut.abort()
        })
      } finally {
        onHomeLog = null
      }
      return partial
    }
    const begun: Summary[] = []
    for (const step of STEPS) begun.push(await cutShort(step, {}, null))
    const idleBegun = begun.find((partial) => partial.steps[6])?.steps[6]
    check(
      'a step Ctrl-C breaks off as it begins records no failure, and step 6 says interrupted',
      begun.every((partial) => Object.keys(partial.errors).length === 0) &&
        !!idleBegun &&
        idleBegun.runs.length === plan.idle.length &&
        idleBegun.runs.every((run) => run.tunnel?.outcome === 'interrupted' && run.socket?.outcome === 'interrupted'),
    )
    // The second tunnel of step 2 is its first run's; the first upload of step 3 run up is its first run's.
    let tunnelsSeen = 0
    const midRate = await cutShort(2, {}, (event) => event === 'tunnel' && ++tunnelsSeen === 2)
    const midBulk = await cutShort(3, { bulkDir: 'up' }, (event, fields) => event === 'blob' && fields.dir === 'up')
    check(
      '2 and 3: a run Ctrl-C cuts short is left out, not kept as a failed one',
      midRate.steps[2]?.runs.length === 0 && midBulk.steps[3]?.runs.length === 0 && Object.keys({ ...midRate.errors, ...midBulk.errors }).length === 0,
    )

    // A watch through two cuts: the first after home went deaf to three trickle lines, the second at once.
    const watchStop = new AbortController()
    const watched: WatchSummary = { probe: PROTOCOL, mode: 'watch', host: target.wsOrigin, node: process.version, startedAt: new Date().toISOString(), endedAt: null, hours: 0, options: { minutes: 0, tunnels: 1, sockets: 1, trickleHz: 20, stallMs: 5000, pace: 6, window: STREAM_WINDOW }, paths: [] }
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const homeTrickles: Record<string, unknown>[] = []
    onHomeLog = (event, fields = {}) => {
      if (event === 'stream' && fields.service === 'trickle') homeTrickles.push(fields)
    }
    let returns = 0
    const waited: number[] = []
    await runWatch(
      target,
      watched.options,
      AbortSignal.any([watchStop.signal, stop.signal, AbortSignal.timeout(30_000)]),
      (event, fields = {}) => {
        events.push({ event, fields })
        if (event !== 'up' || fields.path !== 'tunnel 1') return
        returns++
        if (returns === 1) home.cut(3 * TRICKLE_BYTES)
        else if (returns === 2) home.cut()
        else watchStop.abort()
      },
      watched,
      (ms, signal) => {
        waited.push(ms)
        return pause(ms, signal)
      },
    )
    onHomeLog = null
    const tunnelPath = watched.paths.find((entry) => entry.path === 'tunnel 1')
    const drops = events.filter((entry) => entry.event === 'drop' && entry.fields.path === 'tunnel 1').map((entry) => entry.fields)
    const returned = events.filter((entry) => entry.event === 'up' && entry.fields.path === 'tunnel 1').map((entry) => entry.fields)
    // Home's half, from its own log line for the lost trickle; the machine's, from its drop line.
    const there = homeTrickles.find((fields) => drops[0] !== undefined && fields.tunnel === drops[0].tunnel)
    const lostUp = returned[1]?.lostUpBytes
    check('watch: the tunnel dropped twice and came back each time', !!tunnelPath && tunnelPath.drops === 2 && tunnelPath.ups === 3)
    check(
      "watch: what a cut lost each way is home's count against the machine's, and the deaf lines are in it",
      !!there &&
        typeof lostUp === 'number' &&
        lostUp === Number(drops[0].trickleTx) - Number(there.rx) &&
        returned[1].lostDownBytes === Number(there.tx) - Number(drops[0].trickleRx) &&
        lostUp >= 3 * TRICKLE_BYTES,
    )
    // Only the tunnel drops here, and no dial fails: every wait is a drop's.
    check(
      'watch: each drop waits out the backoff before it dials again, longer while tunnels die young',
      drops.map((fields) => fields.retryInMs).join() === '500,1000' && waited.join() === '500,1000',
    )
    check('watch: the echo socket stayed up', watched.paths.find((entry) => entry.path === 'socket 1')?.ups === 1)
    say(watchReport(watched).join('\n'))
  } finally {
    onHomeLog = null
    await home.close()
  }
  await nextTurn()
  check('nothing was left to reject unhandled', caught.length === 0)
  say('')
  for (const [name, ok] of checks) say(`${ok ? '✓' : red('✗')} ${name}`)
  const failed = checks.filter(([, ok]) => !ok).length
  say(failed ? red(`${failed} of ${checks.length} checks failed`) : `all ${checks.length} checks passed`)
  return failed ? 1 : 0
}

/* -------------------------------------------------------------------- main */

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: FLAGS })
  const flags = values as Flags
  const [mode, ...extra] = positionals
  if (flags.help || !mode) {
    say(USAGE)
    return flags.help ? 0 : 2
  }
  if (extra.length) throw new Usage(`one mode, not "${positionals.join(' ')}"`)
  if (mode === 'home') return homeMode(flags)
  if (mode === 'machine') return machineMode(flags)
  if (mode === 'watch') return watchMode(flags)
  if (mode === 'selftest') return selfTest()
  throw new Usage(`no mode "${mode}": home, machine, watch or selftest`)
}

function leave(code: number): void {
  process.exitCode = code
  for (const connection of held) connection.kill('local')
  // Everything is closed by now; this is only for a socket that still holds the loop open.
  setTimeout(() => process.exit(code), 3000).unref()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (!stop.signal.aborted) {
      note(`${signal}: stopping${measuring ? '; what was measured follows' : ''}`)
      stop.abort()
      return
    }
    emergency?.()
    process.exit(130)
  })
}

const crash = (error: unknown): void => {
  process.stderr.write(`class-probe: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  try {
    emergency?.()
  } finally {
    process.exit(1)
  }
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', (error) => {
  if (!strays) return crash(error)
  strays.push(error)
  note(`an unhandled rejection: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
})

main(process.argv.slice(2)).then(leave, (error: unknown) => {
  if (error instanceof Usage || (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'))) {
    process.stderr.write(`class-probe: ${error.message}\n\n${USAGE}\n`)
    return leave(2)
  }
  process.stderr.write(`class-probe: ${messageOf(error)}\n`)
  emergency?.()
  leave(1)
})
