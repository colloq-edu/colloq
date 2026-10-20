/**
 * A fake Jupyter: what jupyter_server answers over REST, on a kernel's
 * channels and through terminado, answered from memory, so the REAL client
 * (server/src/kernel/jupyter.ts and terminal.ts) runs against it with no
 * Docker, no Python and no network. And a fake road to it (startFakeLink)
 * that a test opens and closes, with the KernelLink that reports on it.
 *
 * TWO WAYS TO RUN IT. In a test's own process, `startFakeJupyter()` returns
 * the server and its state, which the test reads and steers directly
 * (kernel.test.mts, kernel-link.test.mts). As a process of its own:
 *
 *     node tests/_fake-jupyter.mjs --port 0 --cwd DIR [--token T]
 *
 * prints its port on the first line of stdout and serves until SIGTERM, so a
 * fake `docker run` (tests/_remote-e2e-docker.mjs) can stand one behind a
 * class container's loopback port. Plain JavaScript on purpose, as that file
 * is: no TypeScript loader in a process that starts with every container.
 * The fake docker adds what a container's life is made of:
 *
 *     --container-file F --container-id ID   ends once F (the container's
 *                                            state) no longer names this
 *                                            process: `docker rm`, `kill`
 *     --owner PID                            ends once that process (the
 *                                            test's) is gone, however it went
 *     --read-only                            the folder is mounted `:ro` (the
 *                                            council's view of the class folder)
 *     --oom-file F                           a line in F for each kernel the
 *                                            OOM killer took (the cgroup's
 *                                            oom_kill counter)
 *     --calls-file F                         every call (`calls`, below) also
 *                                            a JSON line in F, which outlives
 *                                            the process
 *
 * A container's process outlives the agent that started it, as a container
 * does, and never the test.
 *
 * TWO KINDS OF CELL. By default a cell prints its own source, apart from the
 * markers kernel.test.mts has always used: HOLD and `swallowExecutes` hold
 * it until the test lets go, OOM kills the kernel for memory, RAISE fails it,
 * SILENT prints nothing, a trailing `?` is help. With `interpreter: true`
 * (the process's default) a cell is a small program, one statement a line:
 *
 *     x = 5    s = "a" + "b"    name = input("? ")     bindings that live in the kernel
 *     print(x, s)            stdout, values separated by spaces
 *     x                      a bare expression on the last line is the cell's result
 *     HOLD [name]            wait until RELEASE [name] runs in any kernel here, or release(name)
 *     SLEEP ms               wait
 *     STREAM n ms            print 0 … n-1, a line every ms
 *     RAISE [text] · OOM     a ValueError; the kernel killed for memory
 *     WRITE path text        into the kernel's folder (`\n` is a line break)
 *     READ path              print a file of that folder
 *     COUNT                  count this run and print the count: proof of no double execution
 *     LOSE                   the cell's reply and closing idle are lost on the way
 *
 * Such a kernel runs one shell request at a time, as ipykernel does: a held
 * cell keeps help, the guard and kernel_info waiting behind it. Interrupt
 * ends a cell with KeyboardInterrupt; restart, and OOM, start a fresh process
 * with no bindings, no count and no guard. Every message names the process
 * that sent it in `header.session`, as ipykernel's do: a fresh process draws
 * a new one.
 *
 * WHAT A RECONNECT FINDS (`buffer: true`, the process's default).
 * jupyter_server keeps what a kernel says while a session's channel is down
 * and replays it when a channel with the same session_id comes back, before
 * it answers anything asked on the new one: the order remote-classes.md §5.5
 * rests on. The fake replays on the new channel's first message (or after
 * `replayAfterMs`), so a client that asks kernel_info reads the replay first.
 * What jupyter_server says itself is not kept: the `restarting` of a kernel
 * killed for memory reaches the channels open at that moment, or nobody.
 * Off, a reply goes to the socket that asked, or nowhere, as kernel.test.mts
 * has always had it.
 *
 * TERMINALS, as terminado has them: POST /api/terminals names a pty, a socket
 * to /terminals/websocket/<name> gets `setup` and the tail of what the pty
 * printed, and stdin is echoed and run line by line. The shell knows echo,
 * printf, pwd, cd (`/workspace/<id>` is the kernels' folder, `<id>`'s own
 * with `perSession`), ls, cat, clear,
 * sleep (Ctrl-C stops it), true, false and exit, and `python [-u] FILE` (the
 * file's lines through the interpreter below, as a room's run of a .py sends
 * it); `&&` chains them, and a line typed while a command runs waits for it.
 *
 * SERVICE RUNS ARE ANSWERED BY THEIR MODULE. A silent execute reports through
 * `user_expressions`, and three hidden modules share its `colloq` key: the
 * guard's report (`<guard module>.report`) is what this process's guard
 * said, or a KeyError in a fresh one; the help's static parse
 * (`_colloq_inspect`) and the council's entry, export and load
 * (`_colloq_council`) get canned reports told apart by their code. The
 * council's export and load (remote-classes.md §9.3, 0.26) are placeholders
 * of the shape a worker's seeding reads, until that code exists.
 *
 * WHAT A TEST SEES. `calls` logs every request: HTTP by method and path,
 * channel upgrades, shell requests by type, terminal input and size, COUNT by
 * value, LOSE. The process serves it at GET /_fake/calls, the kernels at
 * GET /_fake/kernels and what was asked to run at GET /_fake/requests, with
 * POST /_fake/release/<name>, POST /_fake/restarts/<normal|unanswered|ignored|held>
 * and POST /_fake/knobs (a JSON body of holdKernelInfo, slowRevival,
 * upgradeDelayMs, refuseUpgrades, holdInterrupts, restarts; a knob turned off
 * lets go of what it held) beside them, and GET /_fake/life for what a
 * container's process knows of its container (named yet or not). Kernel ids are the process's own, as
 * jupyter_server's uuids are: a container started again knows none of its
 * earlier life's.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'

/* ------------------------------------------------------------------ guard */

/** The guard's hidden module: server/src/kernel/danger.ts · GUARD_MODULE. */
export const GUARD_MODULE = '_colloq_guard'

/**
 * How a fake answers the install of the guard against dangerous commands.
 *
 * In a test's process the shared tests/_guard.mts is passed in instead, so
 * every fake there answers alike; a plain node process cannot load
 * TypeScript, so this one mirrors it, module name and report alike.
 */
export function guardAnswerFor(module = GUARD_MODULE) {
  return (code) => {
    if (!code.includes(module) || !code.includes('.apply(')) return null
    const blocked = code.includes('.apply(True')
    return {
      ok: true,
      on: blocked,
      policy: blocked,
      holds: 0,
      patched: blocked ? ['ask_exit', '_exit', 'abort', 'kill', 'system', 'run_line_magic'] : [],
    }
  }
}

/** A hidden module's report expression: `__import__('sys').modules['<module>'].report`. */
function reportOf(module) {
  const name = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`modules\\[(['"])${name}\\1\\]\\.report\\s*$`)
}

/** The council's hidden module (server/src/kernel/council-isolation.ts · COUNCIL_MODULE): its entry, exit, export and load. */
const COUNCIL_MODULE = '_colloq_council'

/** A call of one of the council module's functions, the way the entry calls `enter`: `modules["_colloq_council"].<name>(`. */
const COUNCIL_CALL = (name) => new RegExp(`modules\\[(['"])${COUNCIL_MODULE}\\1\\]\\.${name}\\(`)

/* ------------------------------------------------------------ interpreter */

/** A Python exception raised by an interpreted cell. */
class PyError extends Error {
  constructor(ename, evalue) {
    super(evalue)
    this.ename = ename
    this.evalue = evalue
  }
}
/** The cell killed its kernel for memory. */
class Oom extends Error {}
/** The process went away under the cell (restart). */
class Aborted extends Error {}

function str(value) {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (value === null || value === undefined) return 'None'
  return String(value)
}

function repr(value) {
  return typeof value === 'string' ? `'${value}'` : str(value)
}

/** Split on `separator` outside quotes. */
function splitTop(text, separator) {
  const parts = []
  let quote = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === separator) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim())
}

function atom(ns, text) {
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (/^(['"]).*\1$/.test(text)) return text.slice(1, -1)
  if (text === 'True') return true
  if (text === 'False') return false
  if (text === 'None') return null
  if (/^[A-Za-z_]\w*$/.test(text)) {
    if (ns.has(text)) return ns.get(text)
    throw new PyError('NameError', `name '${text}' is not defined`)
  }
  throw new PyError('SyntaxError', 'invalid syntax')
}

/* -------------------------------------------------------------- the fake */

const KERNEL_INFO = {
  status: 'ok',
  protocol_version: '5.3',
  implementation: 'ipython',
  implementation_version: '8.0.0',
  language_info: { name: 'python', version: '3.11.0', mimetype: 'text/x-python', file_extension: '.py' },
  banner: 'fake kernel',
  help_links: [],
}

const PROMPT = '$ '
/** What terminado replays to a socket that attaches: the tail of the pty's output. */
const SCROLLBACK_CHARS = 4096

/**
 * Start a fake Jupyter on 127.0.0.1.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 (any free port) by default
 * @param {boolean} [options.interpreter] cells are small programs (see the header); off, a cell prints its source
 * @param {boolean} [options.buffer] a session's messages wait out its channel's absence and are replayed
 * @param {number | null} [options.replayAfterMs] replay this long after a reconnect even if the client says nothing
 * @param {boolean} [options.deletes] DELETE of a session or kernel ends it; off, it is answered 404, as before
 * @param {string} [options.cwd] the kernels' folder and the shell's start; a temporary one by default
 * @param {string} [options.root] the in-container path of that folder's parent the shell's `cd` knows, `/workspace`
 * @param {string} [options.token] the token every /api request and socket must carry; none, anything goes
 * @param {boolean} [options.keepAlive] false: every HTTP answer closes its connection, so no idle connection
 *   outlives the request (see the HTTP handler)
 * @param {(code: string) => object | null} [options.guardAnswer] how the guard's install is answered
 * @param {string} [options.guardModule] the guard's hidden module, whose `.report` this process answers (GUARD_MODULE)
 * @param {boolean} [options.perSession] each kernel's folder is its session path's own under `cwd`
 *   (`<id>/session.ipynb` → `cwd/<id>`), as a home's Jupyter rooted at the workspace has it; off, every
 *   kernel works in `cwd` itself, as a class container's does, which sees its one class folder
 * @param {boolean} [options.readOnly] the folder is mounted read-only: WRITE fails as a write there would
 * @param {string} [options.oomFile] a line is added to this file for every kernel killed for memory
 * @param {(line: string) => void} [options.log] what jupyter_server would log (a kernel restarted): the process
 *   mode's stdout, the container's log
 * @param {() => object} [options.life] what GET /_fake/life answers: the process mode's watch of its container
 */
export async function startFakeJupyter(options = {}) {
  const guardAnswer = options.guardAnswer ?? guardAnswerFor()
  const guardReport = reportOf(options.guardModule ?? GUARD_MODULE)
  const madeCwd = !options.cwd
  const home = options.cwd ? path.resolve(options.cwd) : fs.mkdtempSync(path.join(os.tmpdir(), 'fake-jupyter-'))
  const root = options.root ?? '/workspace'
  // Kernel ids are this process's own, as jupyter_server's uuids are: a container started again knows none of its earlier life's.
  const life = Math.random().toString(16).slice(2, 8)
  let minted = 0
  let ptyMinted = 0
  /** Which session a channel socket belongs to. */
  const sessionOf = new WeakMap()
  /** Which kernel a channel socket talks to. */
  const kernelOf = new WeakMap()
  /** Interpreted cells waiting at HOLD, by name. */
  const holds = new Map()
  const ptys = new Map()
  const started = new Date().toISOString()

  const fake = {
    /** Every kernel by id: `alive` and `busy` are what GET /api/kernels/:id reads. */
    kernels: new Map(),
    /** Sessions by path, as jupyter_server identifies them. */
    byPath: new Map(),
    /** Every channel socket ever opened, for the teardown. */
    sockets: /** @type {import('ws').WebSocket[]} */ ([]),
    /** What was asked to run and how: `store_history` is whether IPython puts the source into In/_ih. */
    requests: /** @type {Array<{ code: string, store_history?: boolean, silent?: boolean }>} */ ([]),
    /** The legacy cells' execution counter, In [n]. */
    executions: 0,
    /** Set to hang instead of answering, the way a kernel that is thinking does (legacy cells). */
    swallowExecutes: false,
    /** The same for completions and help: a kernel computing someone else's cell does not answer them. */
    swallowShell: false,
    /** Delay the HTTP interrupt response to exercise the queue/interrupt race. */
    holdInterrupts: false,
    pendingInterrupts: /** @type {Array<() => void>} */ ([]),
    /** Legacy requests the fake is sitting on: `{ socket, parent, asked, code }`. */
    held: /** @type {Array<{ socket: import('ws').WebSocket, parent: object, asked?: boolean, code?: string }>} */ ([]),
    /**
     * How a restart is taken. 'normal': a fresh process and an answer.
     * 'unanswered': a fresh process, and the answer never leaves (the road
     * cut it). 'ignored': the request never reached the kernel, and nothing
     * happens. 'held': a fresh process, and the answer waits for
     * answerRestarts().
     */
    restarts: 'normal',
    /** Hold kernel_info requests until releaseKernelInfo(): a question stuck behind other work. */
    holdKernelInfo: false,
    /** A kernel killed for memory stays `starting` until revive(): a slow comeback. */
    slowRevival: false,
    /** Delay every channel and terminal handshake: the window a reconnect in flight opens. */
    upgradeDelayMs: 0,
    /** Turn away this many of the next channel and terminal handshakes: a container not ready yet. */
    refuseUpgrades: 0,
    /** Every request, in order (see the header). */
    calls: /** @type {Array<{ kind: string, [field: string]: any }>} */ ([]),
    port: 0,
    url: '',
    /** The kernels' folder. */
    cwd: home,

    reply,
    councilExpressions,

    /** Push one stdout chunk into whatever legacy request the fake is sitting on. */
    say(text) {
      const [first] = fake.held
      if (!first) throw new Error('wait for the fake to receive execute_request before injecting output')
      reply(first.socket, first.parent, 'stream', { name: 'stdout', text })
    },

    /** Release only the held legacy requests whose code matches the pattern. */
    finishHeld(match) {
      const mine = fake.held.filter((one) => match.test(one.code ?? ''))
      fake.held = fake.held.filter((one) => !match.test(one.code ?? ''))
      for (const { socket, parent, asked } of mine) {
        reply(socket, parent, 'execute_reply', {
          status: 'ok',
          execution_count: 1,
          ...councilExpressions(asked === true),
        })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
      return mine.length
    },

    /** Let every held legacy request finish, the way a kernel does when the cell ends. */
    shellFinish() {
      for (const { socket, parent, asked } of fake.held.splice(0)) {
        reply(socket, parent, 'execute_reply', {
          status: 'ok',
          execution_count: 1,
          ...councilExpressions(asked === true),
        })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
    },

    /** Every knob back to rest, held legacy requests forgotten: what kernel.test.mts does after every test. */
    reset() {
      fake.swallowExecutes = false
      fake.swallowShell = false
      fake.holdInterrupts = false
      for (const finish of fake.pendingInterrupts.splice(0)) finish()
      fake.held = []
      fake.restarts = 'normal'
      fake.answerRestarts()
      fake.releaseKernelInfo()
      fake.slowRevival = false
      fake.revive()
      fake.upgradeDelayMs = 0
      fake.refuseUpgrades = 0
    },

    /** Let interpreted cells waiting at `HOLD name` go on. Returns how many did. */
    release(name = '') {
      const waiting = holds.get(name)
      if (!waiting) return 0
      holds.delete(name)
      for (const go of [...waiting]) go()
      return waiting.size
    },

    /** How many interpreted cells wait at `HOLD name` now (any name when omitted). */
    holding(name) {
      if (name !== undefined) return holds.get(name)?.size ?? 0
      let total = 0
      for (const waiting of holds.values()) total += waiting.size
      return total
    },

    /** Send the answers of restarts taken as 'held'. */
    answerRestarts() {
      for (const answer of heldRestarts.splice(0)) answer()
    },

    /** Answer the kernel_info requests held by `holdKernelInfo`. */
    releaseKernelInfo() {
      fake.holdKernelInfo = false
      for (const go of infoWaiters.splice(0)) go()
    },

    /** Let kernels killed for memory come back (see `slowRevival`). */
    revive() {
      for (const kernel of fake.kernels.values()) kernel.reviving = false
    },

    /** Let the handshakes `upgradeDelayMs` is holding go through now. */
    releaseUpgrades() {
      for (const delayed of [...slowUpgrades]) {
        clearTimeout(delayed.timer)
        slowUpgrades.delete(delayed)
        delayed.accept()
      }
    },

    /** How many of a kernel's sessions have a channel open right now. */
    online(kernelId) {
      const kernel = fake.kernels.get(kernelId)
      if (!kernel) return 0
      let count = 0
      for (const session of kernel.sessions.values()) if (session.socket?.readyState === 1) count++
      return count
    },

    /** How many messages wait for a kernel's sessions to come back. */
    buffered(kernelId) {
      const kernel = fake.kernels.get(kernelId)
      if (!kernel) return 0
      let count = 0
      for (const session of kernel.sessions.values()) count += session.buffer.length
      return count
    },

    /** The id of the kernel serving a session path, or null. */
    kernelAt(sessionPath) {
      return fake.byPath.get(sessionPath) ?? null
    },

    /** Names of the terminals that exist. */
    terminals() {
      return [...ptys.keys()]
    },

    async close() {
      fake.held = []
      for (const kernel of fake.kernels.values()) kernel.running?.abort()
      for (const waiting of holds.values()) waiting.clear()
      holds.clear()
      for (const go of infoWaiters.splice(0)) go()
      heldRestarts.length = 0
      for (const { socket, timer } of slowUpgrades) {
        clearTimeout(timer)
        socket.destroy()
      }
      slowUpgrades.clear()
      for (const socket of fake.sockets) socket.terminate()
      for (const pty of ptys.values()) {
        pty.running?.interrupt()
        for (const socket of pty.sockets) socket.terminate()
      }
      wss.close()
      http.closeAllConnections()
      await new Promise((resolve) => http.close(() => resolve()))
      if (madeCwd) fs.rmSync(home, { recursive: true, force: true })
    },
  }

  /** kernel_info requests waiting for releaseKernelInfo(). */
  const infoWaiters = []
  /** Answers of restarts taken as 'held'. */
  const heldRestarts = []
  /** Handshakes held back by `upgradeDelayMs`. */
  const slowUpgrades = new Set()

  /** Where a session's kernel works: its path's folder under the root when each session has its own (`perSession`), else the one folder. */
  function folderOf(sessionPath) {
    const dir = path.posix.dirname(String(sessionPath).replace(/\\/g, '/'))
    if (!options.perSession || dir === '.' || dir === '/') return home
    const target = path.resolve(home, dir)
    return target === home || target.startsWith(home + path.sep) ? target : home
  }

  function newKernel(id, sessionPath) {
    return {
      id,
      path: sessionPath,
      /** The kernel's working folder: what WRITE and READ resolve against. */
      dir: folderOf(sessionPath),
      alive: true,
      busy: false,
      /** The process incarnation: a restart makes a new one, and work queued for the old one is lost with it. */
      process: 0,
      ns: new Map(),
      count: 0,
      executions: 0,
      /** The guard's last report, or null while this process has no guard. */
      guarded: null,
      reviving: false,
      /** The shell: one request at a time. */
      shell: Promise.resolve(),
      /** How the interpreted cell waiting right now can be stopped. */
      running: null,
      sessions: new Map(),
    }
  }

  /** A new process behind the same kernel id: what a restart and the OOM killer leave. */
  function freshProcess(kernel) {
    kernel.process += 1
    kernel.ns = new Map()
    kernel.count = 0
    kernel.guarded = null
    kernel.running?.abort()
  }

  function sessionFor(kernel, id) {
    let session = kernel.sessions.get(id)
    if (!session) {
      session = { id, socket: null, buffer: [], replayPending: false }
      kernel.sessions.set(id, session)
    }
    return session
  }

  /** Send what a session's absence kept, in order, before anything new. */
  function flush(session) {
    if (!session.replayPending || session.socket?.readyState !== 1) return
    session.replayPending = false
    for (const frame of session.buffer.splice(0)) session.socket.send(frame)
  }

  /**
   * What one process of a kernel puts into the `session` of every header it
   * sends: ipykernel draws it once per process, so a restart changes it.
   */
  const stampOf = (kernel) => `${kernel.id}.${kernel.process}`

  /** @param {string} [stamp] the sending process's `header.session`; none for what jupyter_server says itself */
  function frameOf(parent, msgType, content, stamp) {
    return JSON.stringify({
      header: { msg_id: `m_${Math.random().toString(36).slice(2)}`, msg_type: msgType, session: stamp },
      parent_header: parent,
      metadata: {},
      content,
      /*
       * The channel is the real one, not "iopub, whatever it is".
       *
       * Here stood `msgType === 'status' ? 'iopub' : 'iopub'` — a dead
       * ternary, both branches the same. The server does not read the
       * `channel` field today, so the fake stayed green with any value; but a
       * real Jupyter sends `execute_reply` over shell and `input_request` over
       * stdin, and the very first routing of incoming messages by channel
       * would silently diverge from the fake — tests green, live kernel broken.
       */
      channel: msgType.endsWith('_reply') ? 'shell' : msgType === 'input_request' ? 'stdin' : 'iopub',
    })
  }

  /**
   * Send one message in answer to a request that came on `socket`.
   *
   * Buffered, it goes to the request's session, whichever channel that has
   * now, or waits for it to come back; otherwise to the socket itself, or
   * nowhere once that socket is closed.
   */
  function reply(socket, parent, msgType, content) {
    const kernel = kernelOf.get(socket)
    const frame = frameOf(parent, msgType, content, kernel && stampOf(kernel))
    const session = sessionOf.get(socket)
    if (options.buffer && session) {
      if (session.socket?.readyState === 1 && !session.replayPending) session.socket.send(frame)
      else session.buffer.push(frame)
      return
    }
    socket.send(frame)
  }

  /**
   * A status jupyter_server says itself instead of relaying it from the
   * kernel: the `restarting` of a process killed for memory, which its
   * restart callback writes to the channels open at that moment. Nothing of
   * it is buffered, so a session whose channel was down never hears it.
   */
  function notice(kernel, state) {
    const frame = frameOf({}, 'status', { execution_state: state })
    for (const session of kernel.sessions.values()) {
      if (session.socket?.readyState === 1) session.socket.send(frame)
    }
  }

  /**
   * The report of the council isolation entry (kernel/council-isolation.ts).
   *
   * A real kernel answers `user_expressions` even when silent, and the server
   * reads that as "the personal data copies are ready". Without an answer it
   * must NOT start the attempt — so a fake without this branch would check
   * only the refusal.
   */
  function councilExpressions(asked, code = '', kernel = null) {
    if (!asked) return {}
    /*
     * Installing the guard against dangerous commands comes by the same road
     * and with the same key, and without confirmation the server does not run
     * the cell at all (kernel/index.ts · ensureGuard). The answer is shared by
     * all fakes — tests/_guard.mts.
     */
    const guard = guardAnswer(code)
    if (guard) {
      return {
        user_expressions: {
          colloq: { status: 'ok', data: { 'text/plain': JSON.stringify(guard) }, metadata: {} },
        },
      }
    }
    /*
     * The `colloq` key is shared by two service runs — the council entry and
     * the static help parse (kernel/inspect-static.ts) — and they must be
     * answered DIFFERENTLY. We tell them apart by the code: help arrives with its
     * own hidden module on the very first line. Otherwise the help parse would
     * read the council report and always answer "not found".
     */
    const text = code.includes('.brief(globals()')
      ? JSON.stringify({ found: true, brief: { type: 'DataFrame', dims: '1460 × 81' } })
      : code.includes('.facts(globals()')
      ? JSON.stringify({
          found: true,
          text: 'Module: seaborn\nType: module\nPackage: seaborn 0.13.2\nSummary: Statistical data visualization\nDocs: http://seaborn.pydata.org',
        })
      : code.includes('_colloq_inspect')
        ? JSON.stringify({ found: true, text: 'Signature:\nsns.lmplot(data)\nType: function' })
        : COUNCIL_CALL('export').test(code)
          ? JSON.stringify(epochExport(kernel))
          : COUNCIL_CALL('load').test(code)
            ? JSON.stringify(epochLoad(kernel))
            : JSON.stringify({ ok: true, copied: 1, skipped: [], failed: [], bytes: 0, ms: 1 })
    return {
      user_expressions: {
        colloq: { status: 'ok', data: { 'text/plain': text }, metadata: {} },
      },
    }
  }

  /**
   * The council's export of an epoch (remote-classes.md §9.3), a placeholder
   * of its report's shape: the kernel's bindings carried, nothing left
   * behind, no buffer worth shipping. The real one comes with the pool.
   */
  function epochExport(kernel) {
    const carried = kernel ? [...kernel.ns.keys()].sort() : []
    const digest = (what) => createHash('sha256').update(`${what}:${carried.join(',')}`).digest('hex')
    return { ok: true, manifest: digest('manifest'), body: digest('body'), bytes: 0, shipBytes: 0, carried, imported: {}, left: [], buffers: [], ms: 1 }
  }

  /** A worker's load of an epoch, the placeholder beside epochExport: everything carried came in, the OOM score is written. */
  function epochLoad(kernel) {
    return { ok: true, loaded: kernel ? kernel.ns.size : 0, left: [], oomScoreAdj: 1000, ms: 1 }
  }

  /**
   * An interpreted kernel's answer to `user_expressions`, key by key.
   *
   * The guard's install answers with its report, as above. The guard's report
   * on its own (its module's `.report`, and only its module's) is what a
   * process that has the guard can evaluate and a fresh one cannot
   * (KeyError). A bare name is the kernel's binding. Anything else — the
   * help's report, the council's entry, exit, export or load — gets the
   * canned report its code asks for (councilExpressions): the three modules
   * share the expression's form, and a guard's report given to a help parse
   * or a council entry would be read as their own.
   */
  function expressionAnswers(kernel, code, expressions) {
    const answers = {}
    const installed = guardAnswer(code)
    for (const [key, expression] of Object.entries(expressions ?? {})) {
      const text = String(expression)
      if (installed) answers[key] = { status: 'ok', data: { 'text/plain': JSON.stringify(installed) }, metadata: {} }
      else if (guardReport.test(text)) {
        answers[key] = kernel.guarded
          ? { status: 'ok', data: { 'text/plain': JSON.stringify(kernel.guarded) }, metadata: {} }
          : { status: 'error', ename: 'KeyError', evalue: `'${GUARD_MODULE}'`, traceback: [] }
      } else if (/^[A-Za-z_]\w*$/.test(text)) {
        answers[key] = kernel.ns.has(text)
          ? { status: 'ok', data: { 'text/plain': repr(kernel.ns.get(text)) }, metadata: {} }
          : { status: 'error', ename: 'NameError', evalue: `name '${text}' is not defined`, traceback: [] }
      } else {
        answers[key] = councilExpressions(true, code, kernel).user_expressions.colloq
      }
    }
    return answers
  }

  function authorized(req, url) {
    if (!options.token) return true
    return req.headers.authorization === `token ${options.token}` || url.searchParams.get('token') === options.token
  }

  /* ------------------------------------------------------------- HTTP */

  const http = createServer((req, res) => {
    /*
     * A connection that idles after its answer carries the client's
     * keep-alive timer. A test that mocks setTimeout and then cuts the road
     * leaves that real timer uncancelled (the mocked clearTimeout does not
     * know it), and it fires seconds later on a connection that is gone.
     */
    if (options.keepAlive === false) res.shouldKeepAlive = false
    const url = new URL(req.url ?? '/', 'http://x')
    fake.calls.push({ kind: 'http', method: req.method, path: url.pathname })
    if (url.pathname.startsWith('/_fake/')) {
      control(req, res, url)
      return
    }
    if (!authorized(req, url)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"Forbidden"}')
      return
    }
    const kernelMatch = /^\/api\/kernels\/([^/]+)$/.exec(url.pathname)

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      // Idempotent by path, exactly as Jupyter is — which is what lets a
      // restarted server re-attach to a live kernel instead of orphaning it.
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const sessionPath = JSON.parse(body || '{}').path ?? ''
        let id = fake.byPath.get(sessionPath)
        if (!id || !fake.kernels.get(id)?.alive) {
          id = `k_${life}_${++minted}`
          fake.byPath.set(sessionPath, id)
          fake.kernels.set(id, newKernel(id, sessionPath))
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `s_${id}`, kernel: { id } }))
      })
      return
    }
    if (req.method === 'GET' && kernelMatch) {
      const kernel = fake.kernels.get(kernelMatch[1])
      // The one question this whole mechanism rests on.
      if (!kernel?.alive) {
        res.writeHead(404).end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: kernelMatch[1],
          execution_state: kernel.reviving ? 'starting' : kernel.busy ? 'busy' : 'idle',
        }),
      )
      return
    }
    if (req.method === 'POST' && /\/restart$/.test(url.pathname)) {
      /*
       * A restart the way a real Jupyter does it: the same kernel id, the same
       * socket, a new process behind them. The fake could not do this at all
       * and answered 404, so `restartSession` went into catch and never got to
       * resetting the cells — and a test for that reset would therefore have
       * to run against a live container. Once it did: green as long as a
       * kernel happened to be running nearby.
       */
      const id = /^\/api\/kernels\/([^/]+)\/restart$/.exec(url.pathname)?.[1]
      const kernel = id ? fake.kernels.get(id) : undefined
      // Lost on the way in: no restart, and no answer.
      if (fake.restarts === 'ignored') return
      if (kernel) kernel.busy = false
      // Pending executions die together with the process.
      for (const { socket, parent } of fake.held.splice(0)) {
        reply(socket, parent, 'execute_reply', { status: 'abort', execution_count: 1 })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
      if (kernel) freshProcess(kernel)
      // Done, and the answer lost on the way out.
      if (fake.restarts === 'unanswered') return
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id, name: 'python3' }))
      }
      if (fake.restarts === 'held') heldRestarts.push(answer)
      else answer()
      return
    }
    if (req.method === 'POST' && /\/interrupt$/.test(url.pathname)) {
      const finish = () => {
        const id = /^\/api\/kernels\/([^/]+)\/interrupt$/.exec(url.pathname)?.[1]
        const kernel = id ? fake.kernels.get(id) : undefined
        if (kernel) kernel.busy = false
        for (const { socket, parent } of fake.held.splice(0)) {
          reply(socket, parent, 'error', { ename: 'KeyboardInterrupt', evalue: '', traceback: [] })
          reply(socket, parent, 'execute_reply', { status: 'error', execution_count: 1 })
          reply(socket, parent, 'status', { execution_state: 'idle' })
        }
        kernel?.running?.interrupt()
        res.writeHead(204).end()
      }
      if (fake.holdInterrupts) fake.pendingInterrupts.push(finish)
      else finish()
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ started, last_activity: new Date().toISOString(), connections: 0, kernels: fake.kernels.size }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/kernels') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([...fake.kernels.values()].filter((k) => k.alive).map((k) => ({ id: k.id, name: 'python3', execution_state: k.busy ? 'busy' : 'idle' }))))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const sessions = [...fake.byPath].filter(([, id]) => fake.kernels.get(id)?.alive).map(([sessionPath, id]) => ({
        id: `s_${id}`,
        path: sessionPath,
        type: 'notebook',
        kernel: { id, name: 'python3', execution_state: fake.kernels.get(id).busy ? 'busy' : 'idle' },
      }))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sessions))
      return
    }
    const ended = req.method === 'DELETE' && (/^\/api\/sessions\/s_([^/]+)$/.exec(url.pathname) ?? kernelMatch)
    if (ended && options.deletes) {
      const kernel = fake.kernels.get(ended[1])
      if (!kernel?.alive) {
        res.writeHead(404).end('{}')
        return
      }
      kernel.alive = false
      kernel.running?.abort()
      fake.byPath.delete(kernel.path)
      for (const session of kernel.sessions.values()) session.socket?.close()
      res.writeHead(204).end()
      return
    }
    if (url.pathname === '/api/terminals' || url.pathname.startsWith('/api/terminals/')) {
      terminals(req, res, url)
      return
    }
    res.writeHead(404).end('{}')
  })

  function control(req, res, url) {
    const [, , what, arg] = url.pathname.split('/')
    if (req.method === 'GET' && what === 'calls') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fake.calls))
      return
    }
    if (req.method === 'GET' && what === 'kernels') {
      const kernels = [...fake.kernels.values()].map((k) => ({
        id: k.id, path: k.path, alive: k.alive, busy: k.busy, count: k.count, guarded: k.guarded !== null, online: fake.online(k.id),
      }))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(kernels))
      return
    }
    if (req.method === 'POST' && what === 'release') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ released: fake.release(decodeURIComponent(arg ?? '')) }))
      return
    }
    if (req.method === 'POST' && what === 'restarts' && ['normal', 'unanswered', 'ignored', 'held'].includes(arg)) {
      fake.restarts = arg
      res.writeHead(204).end()
      return
    }
    if (req.method === 'GET' && what === 'life') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(options.life?.() ?? null))
      return
    }
    if (req.method === 'GET' && what === 'requests') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fake.requests))
      return
    }
    if (req.method === 'POST' && what === 'knobs') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        let asked
        try {
          asked = JSON.parse(body || '{}')
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"not JSON"}')
          return
        }
        knobs(asked && typeof asked === 'object' ? asked : {})
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          holdKernelInfo: fake.holdKernelInfo, slowRevival: fake.slowRevival, upgradeDelayMs: fake.upgradeDelayMs,
          refuseUpgrades: fake.refuseUpgrades, holdInterrupts: fake.holdInterrupts, restarts: fake.restarts,
        }))
      })
      return
    }
    res.writeHead(404).end('{}')
  }

  /**
   * The knobs a test in another process turns (POST /_fake/knobs): each one
   * named is set, and one turned off lets go of what it held — the
   * kernel_info requests, a slow comeback, the handshakes in their delay, the
   * interrupts, the restarts' answers.
   */
  function knobs(asked) {
    if (typeof asked.holdKernelInfo === 'boolean') {
      if (asked.holdKernelInfo) fake.holdKernelInfo = true
      else fake.releaseKernelInfo()
    }
    if (typeof asked.slowRevival === 'boolean') {
      fake.slowRevival = asked.slowRevival
      if (!asked.slowRevival) fake.revive()
    }
    if (Number.isFinite(asked.upgradeDelayMs) && asked.upgradeDelayMs >= 0) {
      fake.upgradeDelayMs = asked.upgradeDelayMs
      if (asked.upgradeDelayMs === 0) fake.releaseUpgrades()
    }
    if (Number.isSafeInteger(asked.refuseUpgrades) && asked.refuseUpgrades >= 0) fake.refuseUpgrades = asked.refuseUpgrades
    if (typeof asked.holdInterrupts === 'boolean') {
      fake.holdInterrupts = asked.holdInterrupts
      if (!asked.holdInterrupts) for (const finish of fake.pendingInterrupts.splice(0)) finish()
    }
    if (['normal', 'unanswered', 'ignored', 'held'].includes(asked.restarts)) {
      fake.restarts = asked.restarts
      if (asked.restarts !== 'held') fake.answerRestarts()
    }
  }

  /* ---------------------------------------------------------- channels */

  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const kernelId = /^\/api\/kernels\/([^/]+)\/channels/.exec(url.pathname)?.[1]
    const ptyName = /^\/terminals\/websocket\/([^/?]+)/.exec(url.pathname)?.[1]
    fake.calls.push({ kind: 'upgrade', path: url.pathname })
    if (!authorized(req, url)) return socket.destroy()
    if (fake.refuseUpgrades > 0) {
      fake.refuseUpgrades -= 1
      return socket.destroy()
    }
    if (kernelId) {
      if (!fake.kernels.has(kernelId)) return socket.destroy()
      fake.calls.push({ kind: 'channel', kernel: kernelId })
    } else if (ptyName) {
      if (!ptys.has(decodeURIComponent(ptyName))) return socket.destroy()
    } else {
      return socket.destroy()
    }
    const accept = () => {
      if (socket.destroyed) return
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (kernelId) onChannel(ws, fake.kernels.get(kernelId), url.searchParams.get('session_id') ?? '')
        else onPty(ws, decodeURIComponent(ptyName))
      })
    }
    if (fake.upgradeDelayMs <= 0) {
      accept()
      return
    }
    // A socket nobody reads yet does not notice its peer leaving: close() ends it.
    const delayed = {
      socket,
      accept,
      timer: setTimeout(() => {
        slowUpgrades.delete(delayed)
        accept()
      }, fake.upgradeDelayMs),
    }
    slowUpgrades.add(delayed)
  })

  function onChannel(ws, kernel, sessionId) {
    fake.sockets.push(ws)
    const session = sessionFor(kernel, sessionId)
    // The newest channel of a session is its channel, as jupyter_server has it.
    session.socket = ws
    sessionOf.set(ws, session)
    kernelOf.set(ws, kernel)
    if (options.buffer && session.buffer.length > 0) {
      session.replayPending = true
      if (options.replayAfterMs != null) setTimeout(() => flush(session), options.replayAfterMs).unref?.()
    }
    ws.on('close', () => {
      if (session.socket === ws) session.socket = null
    })
    ws.on('message', (raw) => {
      if (session.socket === ws) flush(session)
      const msg = JSON.parse(String(raw))
      fake.calls.push({ kind: 'shell', kernel: kernel.id, msgType: msg.header?.msg_type })
      if (options.interpreter) interpreted(ws, kernel, msg)
      else legacy(ws, kernel, msg)
    })
  }

  /** The cells kernel.test.mts has always run: the output is the source, markers aside. */
  function legacy(ws, kernel, msg) {
    /*
     * Completion and help: the same socket, the same shell, no output —
     * but there are `busy` and `idle` around the answer, as with a real
     * ipykernel: it publishes a status around ANY request over shell. The
     * fake used to not send them, and so did not see the kernel indicator
     * blinking for the whole room on every completion keystroke.
     */
    if (msg.header.msg_type === 'complete_request') {
      if (fake.swallowShell) return
      reply(ws, msg.header, 'status', { execution_state: 'busy' })
      reply(ws, msg.header, 'complete_reply', completion())
      reply(ws, msg.header, 'status', { execution_state: 'idle' })
      return
    }
    if (msg.header.msg_type === 'inspect_request') {
      if (fake.swallowShell) return
      reply(ws, msg.header, 'status', { execution_state: 'busy' })
      reply(ws, msg.header, 'inspect_reply', inspection(msg.content.code))
      reply(ws, msg.header, 'status', { execution_state: 'idle' })
      return
    }
    // The question a reconnect to a machine asks (jupyter.ts · reconcileAfterReset).
    if (msg.header.msg_type === 'kernel_info_request') {
      if (fake.swallowShell) return
      reply(ws, msg.header, 'status', { execution_state: 'busy' })
      reply(ws, msg.header, 'kernel_info_reply', KERNEL_INFO)
      reply(ws, msg.header, 'status', { execution_state: 'idle' })
      return
    }
    if (msg.header.msg_type !== 'execute_request') return
    fake.requests.push({
      code: msg.content.code,
      store_history: msg.content.store_history,
      silent: msg.content.silent,
    })
    const asked = Object.keys(msg.content.user_expressions ?? {}).length > 0
    /*
     * Markers are looked for only in CELL CODE, not in service requests.
     *
     * The service kernel runs silently (`silent: true`), and the council
     * isolation source goes there — a hundred lines with comments that
     * honestly say "OOM-killer". The fake read that as "the cell killed
     * the kernel for memory" and answered `restarting`: the attempt never
     * started, and the test failed after five seconds of waiting.
     */
    const service = msg.content.silent === true
    /*
     * `HOLD` is a cell that does not finish until it is released BY NAME.
     *
     * `swallowExecutes` is a flag for the whole fake, and for one kernel
     * that was enough. There are now as many kernels as notebooks, and the
     * main thing about them is that they compute IN PARALLEL: this can be
     * checked only by holding one while the other answers. The marker is
     * in the cell code, so exactly the kernel it was sent to is held.
     */
    /*
     * The guard installation is NEVER held, whatever the flags say.
     *
     * A real kernel answers it in the very first millisecond after coming
     * up — it is one `apply()` line in a fresh process, and there is
     * nothing to hold it with. A fake that held it together with the cell
     * would be checking not the queue but a five-second wait for a
     * confirmation nobody was going to send.
     */
    const guard = guardAnswer(msg.content.code)
    if (guard) kernel.guarded = guard
    const guarding = guard !== null
    if (!guarding && (fake.swallowExecutes || (!service && /HOLD/.test(msg.content.code)))) {
      reply(ws, msg.header, 'status', { execution_state: 'busy' })
      fake.held.push({ socket: ws, parent: msg.header, asked, code: msg.content.code })
      return
    }
    reply(ws, msg.header, 'status', { execution_state: 'busy' })
    /*
     * The execution number arrives in execute_input, and a real kernel
     * always sends it — while the fake never did, so execCount in tests
     * silently stayed null and any check about the number was pointless.
     */
    reply(ws, msg.header, 'execute_input', {
      code: msg.content.code,
      execution_count: ++fake.executions,
    })
    /*
     * A cell that kills the kernel for memory.
     *
     * In this case a real Jupyter does not answer the request at all: it
     * sends `status: restarting` — the same kernel id, the same socket, a
     * new process behind them. The fake could not do this, and the whole
     * auto-restart path was covered by nothing.
     */
    if (!service && /OOM/.test(msg.content.code)) {
      reply(ws, msg.header, 'status', { execution_state: 'restarting' })
      return
    }
    // A cell whose source says so fails, so a suite can build a notebook
    // that breaks in the middle without needing a real Python.
    if (!service && /RAISE/.test(msg.content.code)) {
      reply(ws, msg.header, 'error', {
        ename: 'ValueError',
        evalue: 'the exercise stops here',
        traceback: ['ValueError: the exercise stops here'],
      })
      reply(ws, msg.header, 'execute_reply', { status: 'error', execution_count: 1 })
      reply(ws, msg.header, 'status', { execution_state: 'idle' })
      return
    }
    /*
     * `name?` is help, and it does not arrive over iopub.
     *
     * IPython answers it with the `payload` field in the execute_reply
     * itself, the very piece that in a real notebook opens as a "page" at
     * the bottom of the window. There is no stream and no display_data at
     * all — which is why the cell stayed empty while the server read only
     * the status from this message. The fake repeats the same shape.
     */
    if (!service && /\?$/.test(msg.content.code.trim())) {
      reply(ws, msg.header, 'execute_reply', {
        status: 'ok',
        execution_count: 1,
        payload: [
          {
            source: 'page',
            data: { 'text/plain': 'Signature: print(*args)\nDocstring: Prints the values.' },
            start: 0,
          },
        ],
      })
      reply(ws, msg.header, 'status', { execution_state: 'idle' })
      return
    }
    // A cell that prints nothing: `x = 1`, a function definition, an
    // import. A real kernel answers such a cell with exactly this — a reply
    // and idle, without a single iopub output.
    if (!service && /SILENT/.test(msg.content.code)) {
      reply(ws, msg.header, 'execute_reply', { status: 'ok', execution_count: 1 })
      reply(ws, msg.header, 'status', { execution_state: 'idle' })
      return
    }
    // A silent request shows no output — but the isolation entry expects
    // `user_expressions` from it, and that is the only answer it will hear.
    if (!msg.content.silent) {
      reply(ws, msg.header, 'stream', { name: 'stdout', text: `${msg.content.code}\n` })
    }
    reply(ws, msg.header, 'execute_reply', {
      status: 'ok',
      execution_count: 1,
      ...councilExpressions(asked, msg.content.code),
    })
    reply(ws, msg.header, 'status', { execution_state: 'idle' })
  }

  function completion() {
    return {
      status: 'ok',
      matches: ['df.head', 'df.describe'],
      cursor_start: 3,
      cursor_end: 3,
      // The field is experimental and not every kernel has it — hence
      // the check that the list is built even without it.
      metadata: {
        _jupyter_types_experimental: [{ type: 'function' }, { type: 'function' }],
      },
    }
  }

  function inspection(code) {
    return {
      status: 'ok',
      /*
       * `NOTFOUND` in the code is a name that is not in the namespace.
       * A real kernel answers like this whenever the cell with the
       * import has not been run yet, and exactly here the second help
       * path begins — jedi's static parse.
       */
      found: !code.includes('NOTFOUND'),
      /*
       * About a MODULE a real IPython answers exactly this: the kind, the
       * object's memory address and `<no docstring>` — seaborn has no
       * docstring at all. The package addition (kernel/inspect-static.ts
       * · facts) exists for this kind of answer.
       */
      data: {
        'text/plain': code.includes('MODULE')
          ? "\u001b[0;31mType:\u001b[0m        module\nString form: <module 'seaborn' from '/x/seaborn/__init__.py'>\nFile:        /x/seaborn/__init__.py\nDocstring:   <no docstring>"
          : '\u001b[0;31mSignature:\u001b[0m df.head(n=5)',
      },
    }
  }

  /* ------------------------------------------------- interpreted cells */

  function interpreted(ws, kernel, msg) {
    const type = msg.header?.msg_type
    // stdin is not shell: the answer reaches the cell that waits for it at once.
    if (type === 'input_reply') {
      kernel.running?.answer?.(String(msg.content?.value ?? ''))
      return
    }
    if (!['execute_request', 'complete_request', 'inspect_request', 'kernel_info_request'].includes(type)) return
    const incarnation = kernel.process
    kernel.shell = kernel.shell.then(() => serve(ws, kernel, msg, incarnation)).catch(() => {})
  }

  async function serve(ws, kernel, msg, incarnation) {
    // Queued for a process that is gone: lost with it.
    if (incarnation !== kernel.process || !kernel.alive) return
    const parent = msg.header
    const say = (msgType, content) => reply(ws, parent, msgType, content)
    const type = parent.msg_type
    if (type === 'kernel_info_request') {
      if (fake.holdKernelInfo) await new Promise((resolve) => infoWaiters.push(resolve))
      say('status', { execution_state: 'busy' })
      say('kernel_info_reply', KERNEL_INFO)
      say('status', { execution_state: 'idle' })
      return
    }
    if (type === 'complete_request' || type === 'inspect_request') {
      say('status', { execution_state: 'busy' })
      say(type === 'complete_request' ? 'complete_reply' : 'inspect_reply', type === 'complete_request' ? completion() : inspection(String(msg.content?.code ?? '')))
      say('status', { execution_state: 'idle' })
      return
    }
    const content = msg.content ?? {}
    const code = String(content.code ?? '')
    fake.requests.push({ code, store_history: content.store_history, silent: content.silent })
    kernel.busy = true
    say('status', { execution_state: 'busy' })
    // A service run: nothing is interpreted, only the expressions are answered.
    if (content.silent === true) {
      const guard = guardAnswer(code)
      if (guard) kernel.guarded = guard
      say('execute_reply', { status: 'ok', execution_count: kernel.executions, user_expressions: expressionAnswers(kernel, code, content.user_expressions) })
      say('status', { execution_state: 'idle' })
      kernel.busy = false
      return
    }
    const count = ++kernel.executions
    say('execute_input', { code, execution_count: count })
    const io = cellIo(kernel, say, count)
    let failure = null
    try {
      await run(kernel, code, io)
    } catch (err) {
      failure = err
    }
    if (failure instanceof Oom) {
      // The cgroup counts the kill (memory.events · oom_kill), which a post-mortem reads through `docker exec`.
      if (options.oomFile) fs.appendFileSync(options.oomFile, `${kernel.id}\n`)
      options.log?.(`[I ${new Date().toISOString()} ServerApp] AsyncIOLoopKernelRestarter: restarting kernel (1/5), new random ports`)
      // No answer at all, as for real: the process is gone and another comes
      // up, and only jupyter_server says so, to whoever is connected now.
      notice(kernel, 'restarting')
      freshProcess(kernel)
      kernel.reviving = fake.slowRevival
      kernel.busy = false
      return
    }
    kernel.busy = false
    if (failure instanceof Aborted) {
      say('execute_reply', { status: 'abort', execution_count: count })
      say('status', { execution_state: 'idle' })
      return
    }
    if (io.lost) {
      fake.calls.push({ kind: 'lost', kernel: kernel.id })
      return
    }
    if (failure) {
      const ename = failure instanceof PyError ? failure.ename : 'Exception'
      const evalue = failure instanceof PyError ? failure.evalue : String(failure.message ?? failure)
      say('error', { ename, evalue, traceback: [`${ename}: ${evalue}`] })
      say('execute_reply', { status: 'error', execution_count: count })
      say('status', { execution_state: 'idle' })
      return
    }
    say('execute_reply', { status: 'ok', execution_count: count, user_expressions: expressionAnswers(kernel, code, content.user_expressions) })
    say('status', { execution_state: 'idle' })
  }

  /** What a running cell reaches the room and the folder through. */
  function cellIo(kernel, say, count) {
    /** A wait an interrupt, a restart or the end of the wait itself can end. */
    const wait = (arm) =>
      new Promise((resolve, reject) => {
        let disarm = () => {}
        const end = (settle) => {
          if (kernel.running !== running) return
          kernel.running = null
          disarm()
          settle()
        }
        const running = {
          interrupt: () => end(() => reject(new PyError('KeyboardInterrupt', ''))),
          abort: () => end(() => reject(new Aborted())),
          answer: null,
        }
        kernel.running = running
        disarm = arm((value) => end(() => resolve(value)), running) ?? (() => {})
      })
    return {
      lost: false,
      stdout: (text) => say('stream', { name: 'stdout', text }),
      result: (text) => say('execute_result', { data: { 'text/plain': text }, metadata: {}, execution_count: count }),
      sleep: (ms) =>
        wait((done) => {
          const timer = setTimeout(done, ms)
          return () => clearTimeout(timer)
        }),
      hold: (name) =>
        wait((done) => {
          const waiting = holds.get(name) ?? new Set()
          waiting.add(done)
          holds.set(name, waiting)
          return () => waiting.delete(done)
        }),
      input: (prompt) =>
        wait((done, running) => {
          running.answer = done
          say('input_request', { prompt, password: false })
        }),
      file: (relative) => {
        const target = path.resolve(kernel.dir, relative ?? '')
        if (target !== home && !target.startsWith(home + path.sep)) throw new PyError('PermissionError', `${relative}: outside the folder`)
        return target
      },
    }
  }

  async function value(kernel, expression, io) {
    const input = /^input\((.*)\)$/.exec(expression)
    if (input) return io.input(input[1].trim() ? str(atom(kernel.ns, input[1].trim())) : '')
    const parts = splitTop(expression, '+')
    if (parts.length === 1) return atom(kernel.ns, expression)
    return parts
      .map((part) => atom(kernel.ns, part))
      .reduce((sum, next) => {
        if (typeof sum !== typeof next || (typeof sum !== 'number' && typeof sum !== 'string')) {
          throw new PyError('TypeError', 'unsupported operand type(s) for +')
        }
        return sum + next
      })
  }

  async function run(kernel, code, io) {
    const lines = code.split('\n').map((line) => line.trim())
    const last = lines.findLastIndex((line) => line !== '' && !line.startsWith('#'))
    for (let i = 0; i <= last; i++) {
      const line = lines[i]
      if (line === '' || line.startsWith('#')) continue
      const [word, ...rest] = line.split(/\s+/)
      switch (word) {
        case 'HOLD':
          await io.hold(rest[0] ?? '')
          continue
        case 'RELEASE':
          fake.release(rest[0] ?? '')
          continue
        case 'SLEEP':
          await io.sleep(Number(rest[0]) || 0)
          continue
        case 'STREAM': {
          const total = Number(rest[0]) || 0
          const every = Number(rest[1]) || 0
          for (let k = 0; k < total; k++) {
            if (k > 0 && every > 0) await io.sleep(every)
            io.stdout(`${k}\n`)
          }
          continue
        }
        case 'RAISE':
          throw new PyError('ValueError', rest.join(' ') || 'the exercise stops here')
        case 'OOM':
          throw new Oom()
        case 'WRITE': {
          const [, relative, text] = /^WRITE\s+(\S+)\s?(.*)$/.exec(line) ?? []
          const target = io.file(relative)
          // The council's view of the class folder (`-v …:ro`): the write fails as Python's open() does there.
          if (options.readOnly) throw new PyError('OSError', `[Errno 30] Read-only file system: '${relative}'`)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, (text ?? '').replace(/\\n/g, '\n'))
          continue
        }
        case 'READ': {
          const target = io.file(rest[0])
          if (!fs.existsSync(target)) throw new PyError('FileNotFoundError', `No such file or directory: '${rest[0]}'`)
          io.stdout(fs.readFileSync(target, 'utf8'))
          continue
        }
        case 'COUNT':
          kernel.count += 1
          fake.calls.push({ kind: 'count', kernel: kernel.id, value: kernel.count })
          io.stdout(`${kernel.count}\n`)
          continue
        case 'LOSE':
          io.lost = true
          continue
      }
      const print = /^print\((.*)\)$/.exec(line)
      if (print) {
        const values = []
        for (const part of print[1].trim() ? splitTop(print[1], ',') : []) values.push(await value(kernel, part, io))
        io.stdout(`${values.map(str).join(' ')}\n`)
        continue
      }
      const binding = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(line)
      if (binding) {
        kernel.ns.set(binding[1], await value(kernel, binding[2], io))
        continue
      }
      const result = await value(kernel, line, io)
      if (i === last && result !== null && result !== undefined) io.result(repr(result))
    }
  }

  /* ---------------------------------------------------------- terminado */

  function terminals(req, res, url) {
    const name = url.pathname.startsWith('/api/terminals/')
      ? decodeURIComponent(url.pathname.slice('/api/terminals/'.length))
      : null
    if (req.method === 'POST' && name === null) {
      const pty = { name: String(++ptyMinted), cwd: home, sockets: new Set(), scrollback: PROMPT, line: '', queue: [], running: null }
      ptys.set(pty.name, pty)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: pty.name, last_activity: new Date().toISOString() }))
      return
    }
    if (req.method === 'GET' && name === null) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([...ptys.keys()].map((n) => ({ name: n }))))
      return
    }
    if (req.method === 'DELETE' && name !== null) {
      const pty = ptys.get(name)
      if (!pty) {
        res.writeHead(404).end('{}')
        return
      }
      endPty(pty)
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end('{}')
  }

  function onPty(ws, name) {
    const pty = ptys.get(name)
    if (!pty) {
      ws.terminate()
      return
    }
    pty.sockets.add(ws)
    ws.on('close', () => pty.sockets.delete(ws))
    // terminado's greeting, then what the pty printed lately: a reattach sees the last prompt again.
    ws.send(JSON.stringify(['setup', {}]))
    ws.send(JSON.stringify(['stdout', pty.scrollback]))
    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!Array.isArray(frame)) return
      // A client sends its size once its socket is open: the moment its greeting begins.
      if (frame[0] === 'set_size') fake.calls.push({ kind: 'size', pty: pty.name })
      if (frame[0] !== 'stdin') return
      typed(pty, String(frame[1] ?? ''))
    })
  }

  /** The shell printed something: every socket of its pty sees it, and the scrollback keeps it. */
  function out(pty, text) {
    pty.scrollback = (pty.scrollback + text).slice(-SCROLLBACK_CHARS)
    for (const ws of pty.sockets) if (ws.readyState === 1) ws.send(JSON.stringify(['stdout', text]))
  }

  function endPty(pty) {
    pty.running?.interrupt()
    ptys.delete(pty.name)
    for (const ws of pty.sockets) {
      if (ws.readyState === 1) ws.send(JSON.stringify(['disconnect', 1]))
      ws.close()
    }
  }

  /** What a person typed: echoed as a pty echoes it, run line by line. */
  function typed(pty, data) {
    fake.calls.push({ kind: 'stdin', pty: pty.name, data })
    let echo = ''
    for (const ch of data) {
      if (ch === '\u0003') {
        out(pty, `${echo}^C\r\n`)
        echo = ''
        pty.line = ''
        if (pty.running) pty.running.interrupt()
        else out(pty, PROMPT)
        continue
      }
      if (ch === '\r' || ch === '\n') {
        out(pty, `${echo}\r\n`)
        echo = ''
        const line = pty.line
        pty.line = ''
        if (pty.running) pty.queue.push(line)
        else void shell(pty, line)
        continue
      }
      pty.line += ch
      echo += ch
    }
    if (echo) out(pty, echo)
  }

  async function shell(pty, line) {
    for (const command of splitTop(line, '&').filter(Boolean)) {
      if (!ptys.has(pty.name) || !(await command1(pty, command))) break
    }
    if (!ptys.has(pty.name)) return
    out(pty, PROMPT)
    const next = pty.queue.shift()
    if (next !== undefined) void shell(pty, next)
  }

  /** One command of a line; false stops the rest of an `&&` chain. */
  async function command1(pty, command) {
    const [name, ...args] = command.split(/\s+/)
    const text = args.join(' ').replace(/^(['"])(.*)\1$/, '$2')
    switch (name) {
      case 'echo':
        out(pty, `${text}\r\n`)
        return true
      case 'printf':
        out(pty, text.replace(/\\n/g, '\r\n'))
        return true
      case 'pwd':
        out(pty, `${pty.cwd}\r\n`)
        return true
      case 'cd': {
        // `/workspace/<id>/…` is the kernels' folder: the one class folder itself in a class container, `<id>`'s own
        // under a home's Jupyter rooted at the workspace (`perSession`), where terminal.ts's greeting lands as a kernel does.
        const inside = text === root || text.startsWith(`${root}/`) ? text.slice(root.length).split('/').filter(Boolean) : null
        const target = !text ? home : inside
          ? path.join(home, ...(options.perSession ? inside : inside.slice(1)))
          : path.resolve(pty.cwd, text)
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          out(pty, `sh: 1: cd: can't cd to ${text}\r\n`)
          return false
        }
        pty.cwd = target
        return true
      }
      case 'clear':
        out(pty, '\u001b[H\u001b[2J')
        return true
      case 'ls': {
        const names = fs.readdirSync(pty.cwd).filter((entry) => !entry.startsWith('.')).sort()
        if (names.length > 0) out(pty, `${names.join('  ')}\r\n`)
        return true
      }
      case 'cat': {
        const target = path.resolve(pty.cwd, text)
        if (!fs.existsSync(target)) {
          out(pty, `cat: ${text}: No such file or directory\r\n`)
          return false
        }
        out(pty, fs.readFileSync(target, 'utf8').replace(/\r?\n/g, '\r\n'))
        return true
      }
      case 'sleep': {
        const stopped = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            pty.running = null
            resolve(false)
          }, (Number(text) || 0) * 1000)
          pty.running = {
            interrupt: () => {
              clearTimeout(timer)
              pty.running = null
              resolve(true)
            },
          }
        })
        return !stopped
      }
      case 'python': {
        // `python [-u] FILE`, as the room's run of a .py sends it (control.ts · file:run): the file's lines run by this
        // fake's interpreter in a namespace of their own, their prints on the pty; a failure ends it as Python ends a script.
        const file = args.filter((arg) => arg !== '-u').join(' ').replace(/^(['"])(.*)\1$/, '$2')
        const target = path.resolve(pty.cwd, file)
        if (!file || !fs.existsSync(target)) {
          out(pty, `python: can't open file '${target}': [Errno 2] No such file or directory\r\n`)
          return false
        }
        const script = { id: `python-${pty.name}`, ns: new Map(), count: 0, dir: pty.cwd, running: null }
        const io = {
          lost: false,
          stdout: (printed) => out(pty, printed.replace(/\r?\n/g, '\r\n')),
          result: () => {},
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          hold: () => Promise.reject(new PyError('RuntimeError', 'HOLD waits in a cell, not in a script')),
          input: () => Promise.reject(new PyError('EOFError', 'EOF when reading a line')),
          file: (relative) => path.resolve(pty.cwd, relative ?? ''),
        }
        try {
          await run(script, fs.readFileSync(target, 'utf8'), io)
          return true
        } catch (err) {
          out(pty, `Traceback (most recent call last):\r\n${err instanceof PyError ? `${err.ename}: ${err.evalue}` : String(err)}\r\n`)
          return false
        }
      }
      case 'exit':
        endPty(pty)
        return false
      case 'true':
      case undefined:
      case '':
        return true
      case 'false':
        return false
      default:
        out(pty, `sh: 1: ${name}: not found\r\n`)
        return false
    }
  }

  await new Promise((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve))
  fake.port = http.address().port
  fake.url = `http://127.0.0.1:${fake.port}`
  return fake
}

/* ------------------------------------------------------------- the road */

/**
 * A road to a port that a test opens and closes, and the KernelLink that
 * reports on it (server/src/kernel/jupyter.ts · KernelLink).
 *
 * A TCP relay on 127.0.0.1 in front of `target`, doing to the connections
 * through it what the tunnel does to a placement's streams
 * (remote-classes.md §4.5): `down()` destroys every live one, and while the
 * road is down a new one is destroyed on arrival, a fast ECONNRESET;
 * `lose()` closes it for good, as a failover does; `stall()` is a cut the
 * streams ride out. Each road is a port of its own, so two roads to one fake
 * are a placement before and after a home restart.
 *
 * The link answers `next()` at once with 'up' while the road is up and with
 * 'lost' once it is lost; while it is down, when it changes. So that a test
 * counts events instead of milliseconds, it never times out by itself:
 * `expire()` answers every waiter 'timeout'. `waiting` is how many wait now;
 * `counts` how many connections went through, how many were turned away, and
 * how many times the link was asked.
 *
 * @param {{ target: number, rttMs?: number }} options `target` is the fake's port; `rttMs` what the link reports as its round trip
 */
export async function startFakeLink({ target, rttMs = 40 }) {
  let state = 'up'
  let since = Date.now()
  let rtt = rttMs
  const waiters = []
  const pairs = new Set()
  const counts = { accepted: 0, refused: 0, asked: 0 }
  const answer = (word) => {
    for (const resolve of waiters.splice(0)) resolve(word)
  }
  const cut = () => {
    for (const [client, upstream] of pairs) {
      client.destroy()
      upstream.destroy()
    }
    pairs.clear()
  }
  const server = net.createServer((client) => {
    if (state !== 'up') {
      counts.refused++
      client.destroy()
      return
    }
    counts.accepted++
    client.setNoDelay(true)
    const upstream = net.connect(target, '127.0.0.1')
    upstream.setNoDelay(true)
    const pair = [client, upstream]
    pairs.add(pair)
    const drop = () => {
      pairs.delete(pair)
      client.destroy()
      upstream.destroy()
    }
    for (const end of pair) {
      end.on('error', drop)
      end.on('close', drop)
    }
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const link = {
    get up() {
      return state === 'up'
    },
    get rttMs() {
      return rtt
    },
    get since() {
      return since
    },
    next() {
      counts.asked++
      if (state === 'lost') return Promise.resolve('lost')
      if (state === 'up') return Promise.resolve('up')
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    link,
    counts,
    get waiting() {
      return waiters.length
    },
    down() {
      if (state !== 'up') return
      state = 'down'
      since = Date.now()
      cut()
    },
    /**
     * Down, with the connections kept but stalled: what a resumable tunnel
     * does through a cut (remote-classes.md §4.8). `up()` lets them flow again.
     */
    stall() {
      if (state !== 'up') return
      state = 'down'
      since = Date.now()
      for (const pair of pairs) for (const end of pair) end.pause()
    },
    up() {
      if (state !== 'down') return
      state = 'up'
      since = Date.now()
      for (const pair of pairs) for (const end of pair) end.resume()
      answer('up')
    },
    /** Lost for good; `{ cut: false }` leaves the connections already through it alone. */
    lose({ cut: cutting = true } = {}) {
      if (state === 'lost') return
      state = 'lost'
      since = Date.now()
      if (cutting) cut()
      answer('lost')
    },
    expire() {
      answer('timeout')
    },
    setRtt(ms) {
      rtt = ms
    },
    async close() {
      state = 'lost'
      cut()
      answer('lost')
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/* --------------------------------------------------------- the process */

/** How often a container's process looks at its container's state and its owner (see the header). */
const WATCH_MS = 250

/** A process its container's state never named (the `docker run` that started it died first) ends after this. */
const UNNAMED_MS = 30_000

/**
 * The life of a container's process (the header's flags): it ends once its
 * container's state no longer names it — removed, killed, or started again
 * as another process — and once the test whose run started it is gone, by a
 * crash or a kill as much as by its end.
 */
function watchContainer(values, end, life) {
  const file = values['container-file']
  const id = values['container-id']
  const owner = Number(values.owner)
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return end()
      }
    }
    if (!file || !id) return
    let state = null
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch { /* not written yet, or removed */ }
    if (state !== null && state.id === id && state.pid === process.pid && state.status === 'running') life.named = true
    else if (life.named || Date.now() - startedAt > UNNAMED_MS) end()
  }, WATCH_MS)
  timer.unref()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      cwd: { type: 'string' },
      token: { type: 'string' },
      'guard-module': { type: 'string' },
      'replay-after-ms': { type: 'string' },
      'read-only': { type: 'boolean' },
      'oom-file': { type: 'string' },
      'container-file': { type: 'string' },
      'container-id': { type: 'string' },
      owner: { type: 'string' },
      'calls-file': { type: 'string' },
    },
  })
  const guardModule = values['guard-module'] ?? GUARD_MODULE
  // What the watch knows of its container (GET /_fake/life): named once its state named this process.
  const life = { named: false, container: values['container-id'] ?? null, owner: values.owner ? Number(values.owner) : null }
  const fake = await startFakeJupyter({
    port: Number(values.port),
    cwd: values.cwd ?? process.cwd(),
    token: values.token,
    interpreter: true,
    buffer: true,
    deletes: true,
    replayAfterMs: values['replay-after-ms'] !== undefined ? Number(values['replay-after-ms']) : null,
    guardAnswer: guardAnswerFor(guardModule),
    guardModule,
    readOnly: values['read-only'] === true,
    oomFile: values['oom-file'],
    log: (line) => process.stdout.write(`${line}\n`),
    life: () => life,
  })
  if (values['calls-file']) {
    // Each call also written down as it is logged, one JSON line: what a test reads once docker has removed the container.
    const file = values['calls-file']
    const push = fake.calls.push.bind(fake.calls)
    fake.calls.push = (...entries) => {
      for (const entry of entries) {
        try {
          fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
        } catch { /* a folder gone with the test: the call is still logged in memory */ }
      }
      return push(...entries)
    }
  }
  process.stdout.write(`${fake.port}\n`)
  // What a Jupyter's log says first: never a line a post-mortem's tail keeps (postmortem-core.ts · NOISE).
  process.stdout.write(`[I ${new Date().toISOString()} ServerApp] Jupyter Server fake is running at: http://127.0.0.1:${fake.port}/\n`)
  let ending = false
  const end = () => {
    if (ending) return
    ending = true
    void fake.close().finally(() => process.exit(0))
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, end)
  watchContainer(values, end, life)
}
