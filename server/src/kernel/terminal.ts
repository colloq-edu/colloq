import { tr } from '@shared/i18n'
import { endpointIdentity } from './jupyter.js'
import { kernelBackend } from './runtime-client.js'
import { createHash } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import {
  createTerminalLine,
  getMeta,
  getTerminal,
  terminalText,
  type YTerminalLine,
} from '@shared/notebook'
import { plural } from '@shared/plural'
import { getSessionDoc } from '../collab/index.js'
import { sessionEnvironment } from '../db.js'
import { kernelCwd, sessionDir } from '../workspace.js'
import { defaultEndpoint, type KernelEndpoint } from './jupyter.js'
import { endpointForSession, forgetSessionKernel } from './pool.js'

/**
 * One shared terminal per seminar, in the same container as the kernel.
 *
 * The terminal is shared for the same reason the kernel is: `pip install pandas`
 * changes what every cell in the room can import, so showing it to one person
 * would be a lie. The transcript therefore lives in the session document — each
 * command carries the name of whoever typed it, and the room watches the output
 * arrive through the same CRDT that already carries cell outputs.
 *
 * One shell also means one command at a time. A command typed while another is
 * running waits its turn here rather than being pushed at a shell that would
 * buffer it and echo it back later — that produced a transcript where one
 * person's output printed under another person's command line.
 *
 * Deliberate scope: this is a line-oriented transcript, not a VT emulator. It
 * understands the escapes that ordinary command output actually uses — colours
 * (dropped), carriage-return redraws (collapsed to the line's final state),
 * erase-in-line, horizontal cursor moves — and refuses the rest. A program that
 * paints a whole screen (vim, top) gets one honest sentence instead of a page of
 * garbage, because nothing sensible can be shown in an append-only transcript
 * that ten people are reading at their own pace.
 */

export type TerminalPhase = 'closed' | 'starting' | 'idle' | 'busy' | 'dead'

/** Marks every write this module makes to a session document. */
const ORIGIN = 'terminal'

const ESC = '\u001b'
const BEL = '\u0007'
const DEL = '\u007f'
/** Ctrl-C: the only control code this module ever sends. */
const ETX = '\u0003'

/** Coalescing window: one CRDT update per window, never one per pty chunk. */
const FLUSH_MS = 60
/** Silence this long is the first half of "the command finished". */
const QUIET_MS = 400
/** After connecting, the shell's banner stops arriving this long after it starts. */
const PRIME_QUIET_MS = 350
const PRIME_MAX_MS = 4000
const CONNECT_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000
/** Six, on the same backoff: ~20s. A shell is cheaper to reopen than a kernel. */
const MAX_RECONNECT_ATTEMPTS = 6

/** A document everyone syncs cannot grow without bound. */
const MAX_TRANSCRIPT_LINES = 800
const MAX_TRANSCRIPT_CHARS = 200 * 1024
/** Rolling over to a new entry is what lets the front-trim actually free anything. */
const MAX_ENTRY_CHARS = 32 * 1024
/** An unbroken line has to end somewhere; minified JSON is the usual culprit. */
const MAX_PARTIAL_CHARS = 4096
/**
 * How much output goes into the document per coalescing window.
 *
 * A kernel cell has a cap per execution; the terminal had nothing: `cat` of a
 * hundred-megabyte file poured a megabyte or two into the CRDT every 60 ms,
 * and that was broadcast to all thirty tabs, together with the notebook that
 * lives in the same document. We keep the tail of the window: the transcript
 * is a tail anyway, and what matters is almost always in the last lines;
 * "successfully installed" arrives after a mile of progress bars.
 */
const MAX_FLUSH_CHARS = 64 * 1024
/*
 * Transcript lines are in the room's language.
 *
 * The server prints them, and they are read in the same drawer that holds the
 * "Terminal / Kernel log / History" tabs, the "shell is starting…" prompt and
 * the "Clear" and "Start the shell again" buttons. The English half sat right
 * next to the Russian one, on the same line, and called the buttons by foreign
 * names: "Press Stop", "with Clear". We name a button the way it is labelled
 * in the drawer; where there is no button (a command can only be stopped with
 * Ctrl+C), we name the key rather than an invented button.
 *
 * The person's name is a separate subject, "Maria: command removed" rather
 * than "Maria removed it": names come in any form, including "oracle"
 * (ai/agent.ts · runInRoom), we do not know their grammatical gender, and a
 * "(s)he pressed" form in the shared transcript reads like a draft.
 */
const FLOOD_NOTICE = 'server.terminal.flood'
/** Never trim away the command that is producing output right now. */
const MIN_KEPT_ENTRIES = 2
const MAX_COMMAND_BYTES = 4096
/** An escape split across chunks is normal; one this long is not an escape. */
const MAX_PENDING_ESC = 128

/*
 * The shell's own idea of its size, which everyone in the room then reads.
 *
 * A pty has one geometry and the transcript has many readers, so this cannot
 * follow anybody's window. 120 columns is wide enough that `pip` and `ls -l`
 * do not wrap into nonsense, and narrow enough to still fit the drawer on a
 * laptop; 40 rows is what `less` and friends page against.
 */
const TERM_ROWS = 40
const TERM_COLS = 120

const SCREEN_NOTICE = 'server.terminal.screen'
const CLEAR_NOTICE = 'server.terminal.clear'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
}

/** Mirrors the CRDT array entry-for-entry, so trimming needs no full walk. */
interface LedgerEntry {
  id: string
  chars: number
  lines: number
}

/** Who typed a command; the transcript puts a face and a name against it. */
interface Sender {
  name: string
  color: string
  participantId: string
}

interface Term {
  sessionId: string
  /**
   * Which Jupyter this room's shell lives in.
   *
   * A property of the room, not of the process — the same rule the kernel
   * follows, and for the same reason. A seminar on its own environment runs in
   * its own container, and a terminal that went to the instance-wide address
   * instead put `pip install` into a container the room's Python never sees:
   * the command succeeded, said so, and changed nothing that any cell could
   * import.
   *
   * Resolved when the terminal opens and kept for its life, so a reconnect
   * returns to the same pty rather than hunting for it in a second container.
   */
  endpoint: KernelEndpoint
  /** Jupyter's terminal name ("1"); null when nothing is allocated. */
  name: string | null
  socket: WebSocket | null
  phase: TerminalPhase
  opening: Promise<void> | null
  /** Set while we tear down on purpose, so the socket does not reconnect. */
  closing: boolean
  /** Invalidates every async continuation from a previous open/close lifetime. */
  generation: number
  connecting: Set<WebSocket>
  /** False until the shell's banner and terminado's replayed scrollback are behind us. */
  primed: boolean
  primeDeadline: number
  waiters: Waiter[]
  queued: string[]
  /**
   * Commands typed while the shell was busy, in the order they were typed.
   *
   * `queued` above is bytes on their way to the pty; this is whole commands
   * that have not been sent at all yet. They are held rather than pushed
   * because a shell buffers what it cannot run and echoes it later, in its own
   * time: two people typing in one shell produced a transcript where somebody's
   * output landed under somebody else's command line, and the second command
   * appeared twice — once as we wrote it, once as the shell echoed it back.
   */
  pending: Array<{ text: string; by: Sender; done?: Done }>
  /**
   * Whom to tell that the command has finished, if someone is waiting for it.
   *
   * Exactly one waits for it now: the Oracle in "Act" mode. A person at the
   * keyboard sees the output anyway, but the agent has to look at it to decide
   * what to do next; otherwise it "runs" blindly and reports a result it never
   * saw.
   */
  runningDone: Done | null
  /**
   * Who typed the command the shell is running now, or null between commands.
   *
   * Ctrl+C throws away everything queued, including other people's, so the
   * same rule the kernel's interrupt uses applies here: the host, or whoever's
   * command is actually running.
   */
  runningBy: string | null
  reconnectAttempts: number
  flushTimer: NodeJS.Timeout | null
  quietTimer: NodeJS.Timeout | null
  primeTimer: NodeJS.Timeout | null
  reconnectTimer: NodeJS.Timeout | null
  /** Raw pty text not yet parsed (may end mid-escape). */
  raw: string
  /** The line being drawn: \r and cursor moves rewrite it in place. */
  partial: string
  col: number
  /** How much of `partial` is currently written at the end of the output entry. */
  tailLen: number
  skipEcho: string | null
  screenApp: boolean
  clearNoticed: boolean
  /** Whether the flood has already been reported for this command; see MAX_FLUSH_CHARS. */
  flooded: boolean
  /** The id of the line the document marks "running" while we hold no live command for it; see resumeCommand. */
  resumable: string | null
  /**
   * Ask the shell whether it is free as soon as priming is over.
   *
   * Set in exactly one case: we came back to a pty that survived a server
   * restart and revived from the transcript a command marked "running".
   * Whether it is still running or finished while the server was away only
   * the shell itself knows, and it answers in the only way it can: a free
   * shell prints a prompt, a busy one stays silent. See `probeShell`.
   */
  probe: boolean
  commandLine: YTerminalLine | null
  commandLineId: string | null
  outputLine: YTerminalLine | null
  outputLineId: string | null
  outChars: number
  outLines: number
  ledger: LedgerEntry[]
  chars: number
  lines: number
}

const terms = new Map<string, Term>()
const phaseListeners: Array<(sessionId: string, phase: TerminalPhase) => void> = []

function getTerm(sessionId: string): Term {
  let term = terms.get(sessionId)
  if (!term) {
    term = {
      sessionId,
      runningBy: null,
      // A placeholder until opening: the real address is asked of the room's
      // environment in openTerminal, where waiting for the container is fine.
      endpoint: defaultEndpoint(),
      name: null,
      socket: null,
      phase: 'closed',
      opening: null,
      closing: false,
      generation: 0,
      connecting: new Set(),
      primed: false,
      primeDeadline: 0,
      waiters: [],
      queued: [],
      pending: [],
      runningDone: null,
      reconnectAttempts: 0,
      flushTimer: null,
      quietTimer: null,
      primeTimer: null,
      reconnectTimer: null,
      raw: '',
      partial: '',
      col: 0,
      tailLen: 0,
      skipEcho: null,
      screenApp: false,
      clearNoticed: false,
      flooded: false,
      resumable: null,
      probe: false,
      commandLine: null,
      commandLineId: null,
      outputLine: null,
      outputLineId: null,
      outChars: 0,
      outLines: 0,
      ledger: [],
      chars: 0,
      lines: 0,
    }
    terms.set(sessionId, term)
  }
  return term
}

const docOf = (term: Term) => getSessionDoc(term.sessionId).doc

/**
 * The pty name that survives a server restart, kept in the room's document.
 *
 * `shutdownKernels` deliberately lets go of the kernel so that `make run`
 * after an edit does not cost the seminar its state; in the same scenario the
 * terminal deleted its pty, and a three-hour training run started in the
 * shell died with it, without a single line in the transcript. The container
 * is now per room and lives on, so the pty outlives us just like the kernel;
 * we only need to remember its name. The address next to the name is not
 * decoration: every container has a pty named "1", and returning by it to the
 * wrong one would lead the room into someone else's shell.
 */
const PTY_KEY = 'terminalPty'

/**
 * The address as a fingerprint, not a string: the whole room reads the
 * document, and it has no need to know the container's internal address.
 * Comparing fingerprints is enough for "is this the same container".
 */
const ptyHome = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 12)

function rememberPty(term: Term): void {
  const doc = docOf(term)
  const value = term.name ? `${ptyHome(endpointIdentity(term.endpoint))}\n${term.name}` : null
  const meta = getMeta(doc)
  if ((meta.get(PTY_KEY) ?? null) === value) return
  doc.transact(() => meta.set(PTY_KEY, value), ORIGIN)
}

/** The pty name, if it comes from the same address we are heading to now. */
function rememberedPty(term: Term, identity: string): string | null {
  const saved = getMeta(docOf(term)).get(PTY_KEY)
  if (typeof saved !== 'string') return null
  const at = saved.indexOf('\n')
  if (at < 0) return null
  return saved.slice(0, at) === ptyHome(identity) ? saved.slice(at + 1) || null : null
}

/* ------------------------------------------------------------------ phase */

function setPhase(term: Term, phase: TerminalPhase): void {
  if (term.phase === phase) return
  term.phase = phase
  for (const cb of [...phaseListeners]) {
    try {
      cb(term.sessionId, phase)
    } catch (err) {
      console.error(`[terminal] phase listener failed for ${term.sessionId}:`, errText(err))
    }
  }
}

export function onTerminalPhase(cb: (sessionId: string, phase: TerminalPhase) => void): void {
  phaseListeners.push(cb)
}

export function terminalPhase(sessionId: string): TerminalPhase {
  return terms.get(sessionId)?.phase ?? 'closed'
}

/* ------------------------------------------------------------- transcript */

function countLines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++
  return n
}

function lineId(line: YTerminalLine): string {
  return (line.get('id') as string) ?? ''
}

/**
 * Adopt whatever the persisted document already holds. A server restart brings
 * back the transcript but not the shell, so a command still marked `running` is
 * a claim we can no longer stand behind.
 *
 * Our own live command is the exception, and that is no small matter.
 *
 * Opening the terminal is not the only thing that triggers the recount: kernel
 * notes (kernel/index.ts) write to the same array, and any of them breaks the
 * alignment, after which `ensureAligned` calls us in the middle of a running
 * command. By clearing `commandLine` here we declared `python train.py`
 * finished: the dot and the counter went out, the "one command at a time"
 * guard stopped holding, and the next command went straight into the busy
 * shell. The first command into a not-yet-opened terminal broke the same way:
 * `openTerminal` adopted the transcript right after the command line landed in
 * it.
 *
 * So the live lines are looked up by id and stay themselves: their accounting
 * (`tailLen`, `outChars`) keeps describing the very same entries in the
 * document.
 */
function adoptTranscript(term: Term): void {
  const doc = docOf(term)
  const array = getTerminal(doc)
  const liveCommandId = term.commandLineId
  const liveOutputId = term.outputLineId
  term.ledger = []
  term.chars = 0
  term.lines = 0
  let command: YTerminalLine | null = null
  let output: YTerminalLine | null = null
  let outputChars = 0
  let outputLines = 0
  // An array, not a variable: the assignment happens inside the transaction's
  // closure, and the compiler cannot narrow the type back from there.
  const resumable: Array<{ id: string; kind: string }> = []
  doc.transact(() => {
    for (const line of array.toArray()) {
      const text = terminalText(line).toString()
      const entry: LedgerEntry = {
        id: lineId(line),
        chars: text.length,
        lines: countLines(text) + 1,
      }
      term.ledger.push(entry)
      term.chars += entry.chars
      term.lines += entry.lines
      if (liveCommandId !== null && entry.id === liveCommandId) {
        command = line
        continue
      }
      if (liveOutputId !== null && entry.id === liveOutputId) {
        output = line
        outputChars = entry.chars
        outputLines = entry.lines
        continue
      }
      if (line.get('running') === true) {
        /*
         * Whoever LAST claimed to be running, in case it is true.
         *
         * We clear the flag: without a shell nobody stands behind it. But if a
         * second later it turns out the pty survived the server restart, this
         * line is the only trace of a command still running inside, and
         * `resumeCommand` brings it back. Only then does it become live.
         */
        resumable.push({ id: entry.id, kind: String(line.get('kind') ?? '') })
        line.set('running', false)
      }
    }
  }, ORIGIN)
  term.commandLine = command
  term.commandLineId = command === null ? null : liveCommandId
  term.outputLine = output
  term.outputLineId = output === null ? null : liveOutputId
  term.outChars = output === null ? 0 : outputChars
  term.outLines = output === null ? 0 : outputLines
  if (output === null) term.tailLen = 0
  /*
   * What is found is remembered; what is not found does not erase what was
   * found earlier.
   *
   * Adoption happens more than once: any kernel note breaks the alignment, and
   * `ensureAligned` calls us again, now over a transcript where we ourselves
   * cleared the "running" flags. Clearing here would lose the trace of a live
   * command because of one system line between opening the terminal and
   * connecting to it.
   */
  const last = resumable[resumable.length - 1]
  if (command !== null) term.resumable = null
  else if (last?.kind === 'command') term.resumable = last.id
}

/**
 * Bring back a command that, judging by the transcript, is still running.
 *
 * Called in exactly one place: when we came back to a pty that survived a
 * server restart. Without it the "one command at a time" guard does not hold
 * at all after a restart: `commandLine` is empty, the phase is `idle`, and the
 * first person to type `ls` sends it into a shell where someone else's
 * training is running.
 */
function resumeCommand(term: Term): boolean {
  const id = term.resumable
  term.resumable = null
  if (!id) return false
  const doc = docOf(term)
  const line = getTerminal(doc)
    .toArray()
    .find((entry) => lineId(entry) === id)
  if (!line) return false
  doc.transact(() => line.set('running', true), ORIGIN)
  term.commandLine = line
  term.commandLineId = id
  term.runningBy = (line.get('participantId') as string | null) ?? null
  return true
}

function syncLedger(term: Term, id: string, chars: number, lines: number): void {
  for (let i = term.ledger.length - 1; i >= 0; i--) {
    const entry = term.ledger[i]
    if (entry.id !== id) continue
    term.chars += chars - entry.chars
    term.lines += lines - entry.lines
    entry.chars = chars
    entry.lines = lines
    return
  }
}

/** The ledger is index-aligned with the array; if that ever slips, rebuild it. */
function ensureAligned(term: Term): void {
  if (getTerminal(docOf(term)).length !== term.ledger.length) adoptTranscript(term)
}

function forgetEntry(term: Term, id: string): void {
  if (term.outputLineId === id) {
    term.outputLine = null
    term.outputLineId = null
    term.tailLen = 0
    term.outChars = 0
    term.outLines = 0
  }
  if (term.commandLineId === id) {
    term.commandLine = null
    term.commandLineId = null
  }
}

/**
 * Oldest-first eviction: a seminar terminal is a tail, not an archive.
 *
 * The line of the RUNNING command is never evicted, and that is not transcript
 * cosmetics but the whole "one command at a time" guard.
 *
 * It is the oldest of the live entries, because output rolls over into new
 * entries every 32 KB, and it used to be evicted first. `forgetEntry` cleared
 * `commandLine` along with it, and that is exactly what `runCommand` measures
 * busyness by: the next person to type `ls` sent it straight into the busy
 * shell's stdin; their bytes went to `train.py`, someone else's output was
 * printed under their line, the echo doubled, and nobody ever saw "X's command
 * is waiting for the shell". Eight hundred lines of output, that is, one
 * `find /`, were enough. `MIN_KEPT_ENTRIES` promised exactly this and did not
 * deliver: it counts entries rather than looking at what an entry is.
 *
 * So now what is evicted is not "the first N" but the first N EXCEPT this one,
 * at the cost of deleting by index instead of one slice from the head.
 */
function trim(term: Term): void {
  if (term.chars <= MAX_TRANSCRIPT_CHARS && term.lines <= MAX_TRANSCRIPT_LINES) return
  ensureAligned(term)
  const drop: number[] = []
  let kept = term.ledger.length
  for (let i = 0; i < term.ledger.length; i++) {
    if (kept <= MIN_KEPT_ENTRIES) break
    if (term.chars <= MAX_TRANSCRIPT_CHARS && term.lines <= MAX_TRANSCRIPT_LINES) break
    const entry = term.ledger[i]
    if (entry.id === term.commandLineId) continue
    term.chars -= entry.chars
    term.lines -= entry.lines
    drop.push(i)
    kept--
  }
  if (drop.length === 0) return
  const removed = drop.map((index) => term.ledger[index])
  const doc = docOf(term)
  const array = getTerminal(doc)
  // From the end, otherwise each deletion would shift the indices of the next ones.
  doc.transact(() => {
    for (let i = drop.length - 1; i >= 0; i--) array.delete(drop[i], 1)
  }, ORIGIN)
  for (let i = drop.length - 1; i >= 0; i--) term.ledger.splice(drop[i], 1)
  for (const entry of removed) forgetEntry(term, entry.id)
}

function appendEntry(term: Term, line: YTerminalLine, chars: number, lines: number): void {
  const doc = docOf(term)
  ensureAligned(term)
  doc.transact(() => getTerminal(doc).push([line]), ORIGIN)
  term.ledger.push({ id: lineId(line), chars, lines })
  term.chars += chars
  term.lines += lines
  trim(term)
}

function removeEntry(term: Term, id: string): void {
  ensureAligned(term)
  const index = term.ledger.findIndex((entry) => entry.id === id)
  if (index < 0) return
  const entry = term.ledger[index]
  term.chars -= entry.chars
  term.lines -= entry.lines
  term.ledger.splice(index, 1)
  const doc = docOf(term)
  doc.transact(() => getTerminal(doc).delete(index, 1), ORIGIN)
  forgetEntry(term, id)
}

function systemLine(term: Term, text: string): void {
  appendEntry(term, createTerminalLine({ kind: 'system', text }), text.length, countLines(text) + 1)
}

/** The counted word in "N commands removed": the plural rules are shared, from shared/. */
const commandWord = (n: number) => tr('server.commandWord', { count: n })

/**
 * Stop appending to the current output entry, taking the in-progress tail back
 * out of the document first. Whatever is still in `partial` gets re-rendered
 * into the next entry, so nothing is duplicated and nothing is lost.
 */
function detachOutput(term: Term): void {
  const line = term.outputLine
  const id = term.outputLineId
  const tail = term.tailLen
  term.outputLine = null
  term.outputLineId = null
  term.tailLen = 0
  const lines = term.outLines
  term.outChars = 0
  term.outLines = 0
  if (!line || !id) return

  const doc = docOf(term)
  const text = terminalText(line)
  if (tail > 0 && text.length >= tail) {
    doc.transact(() => text.delete(text.length - tail, tail), ORIGIN)
  }
  // `cd ..` leaves an entry holding nothing but the prompt we just removed.
  if (text.length === 0) removeEntry(term, id)
  else syncLedger(term, id, text.length, lines)
}

function ensureOutputLine(term: Term): YTerminalLine {
  if (term.outputLine && term.outChars <= MAX_ENTRY_CHARS) return term.outputLine
  if (term.outputLine) detachOutput(term)
  const line = createTerminalLine({ kind: 'output' })
  appendEntry(term, line, 0, 1)
  term.outputLine = line
  term.outputLineId = lineId(line)
  term.outChars = 0
  term.outLines = 1
  term.tailLen = 0
  return line
}

/**
 * One CRDT edit per flush window: completed lines are appended, and the tail —
 * the line still being drawn — is replaced. That replacement is what makes a
 * progress bar readable: the room sees its latest state, not every redraw.
 */
function writeOut(term: Term, committed: string): void {
  if (committed.length === 0 && term.partial.length === 0 && term.tailLen === 0) return
  const line = ensureOutputLine(term)
  const id = term.outputLineId
  if (!id) return
  const tail = term.tailLen
  const add = committed + term.partial
  const doc = docOf(term)
  const text = terminalText(line)
  doc.transact(() => {
    if (tail > 0 && text.length >= tail) text.delete(text.length - tail, tail)
    if (add.length > 0) text.insert(text.length, add)
  }, ORIGIN)
  term.tailLen = term.partial.length
  term.outChars = text.length
  term.outLines += countLines(committed)
  syncLedger(term, id, term.outChars, term.outLines)
  trim(term)
}

/* ------------------------------------------------------------ ansi policy */

interface Esc {
  end: number
  csi: boolean
  priv: boolean
  params: number[]
  final: string
}

type CsiEffect = 'none' | 'screen' | 'cleared'

const PARAM_CHARS = /[0-9;:]/
const PRIVATE_CHARS = /[<=>?]/

/** Returns null when the sequence is cut off by the end of the chunk. */
function parseEscape(input: string, start: number): Esc | null {
  const next = input[start + 1]
  if (next === undefined) return null

  if (next === '[') {
    let i = start + 2
    let priv = false
    let raw = ''
    while (i < input.length && (PARAM_CHARS.test(input[i]) || PRIVATE_CHARS.test(input[i]))) {
      if (PRIVATE_CHARS.test(input[i])) priv = true
      else raw += input[i]
      i++
    }
    while (i < input.length && input[i] >= ' ' && input[i] <= '/') i++
    if (i >= input.length) return null
    const params = raw.length === 0 ? [] : raw.split(/[;:]/).map((p) => Number.parseInt(p, 10) || 0)
    return { end: i + 1, csi: true, priv, params, final: input[i] }
  }

  // OSC/DCS/PM/APC: a string terminated by BEL or ESC \ — window titles, mostly.
  if (next === ']' || next === 'P' || next === '^' || next === '_') {
    let i = start + 2
    while (i < input.length) {
      if (input[i] === BEL) return { end: i + 1, csi: false, priv: false, params: [], final: next }
      if (input[i] === ESC) {
        if (i + 1 >= input.length) return null
        if (input[i + 1] === '\\') {
          return { end: i + 2, csi: false, priv: false, params: [], final: next }
        }
      }
      i++
    }
    return null
  }

  if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') {
    if (start + 2 >= input.length) return null
    return { end: start + 3, csi: false, priv: false, params: [], final: next }
  }

  return { end: start + 2, csi: false, priv: false, params: [], final: next }
}

function put(term: Term, ch: string): void {
  if (term.col < term.partial.length) {
    term.partial = term.partial.slice(0, term.col) + ch + term.partial.slice(term.col + 1)
  } else {
    if (term.col > term.partial.length) term.partial = term.partial.padEnd(term.col, ' ')
    term.partial += ch
  }
  term.col++
}

function applyCsi(term: Term, esc: Esc): CsiEffect {
  const p0 = esc.params.length > 0 ? esc.params[0] : 0
  switch (esc.final) {
    // Colours, styles, cursor visibility, device queries: the transcript styles itself.
    case 'm':
    case 'n':
    case 's':
    case 'u':
      return 'none'
    case 'h':
    case 'l':
      // The alternate screen buffer is a full-screen program announcing itself.
      return esc.priv && esc.params.some((p) => p === 47 || p === 1047 || p === 1049)
        ? 'screen'
        : 'none'
    case 'C':
      term.col += Math.max(1, p0)
      return 'none'
    case 'D':
      term.col = Math.max(0, term.col - Math.max(1, p0))
      return 'none'
    case 'G':
    case '`':
      term.col = Math.max(0, (p0 || 1) - 1)
      return 'none'
    case 'K':
      if (p0 === 2) term.partial = ''
      else if (p0 === 1) {
        term.partial =
          ' '.repeat(Math.min(term.col, term.partial.length)) + term.partial.slice(term.col)
      } else term.partial = term.partial.slice(0, term.col)
      return 'none'
    case 'J':
      if (p0 !== 2 && p0 !== 3) return 'none'
      // The screen is blank afterwards, so the line being drawn is gone too —
      // carrying it forward would paste pre-`clear` text into the next entry.
      term.partial = ''
      term.col = 0
      return 'cleared'
    case 'H':
    case 'f': {
      const row = esc.params.length > 0 ? esc.params[0] : 1
      const column = esc.params.length > 1 ? esc.params[1] : 1
      // Home on its own is what `clear` sends; anywhere else is a program painting.
      if (row > 1 || column > 1) return 'screen'
      term.partial = ''
      term.col = 0
      return 'cleared'
    }
    case 'A':
    case 'B':
    case 'S':
    case 'T':
    case 'L':
    case 'M':
    case 'd':
    case 'r':
      return 'screen'
    default:
      return 'none'
  }
}

function commitLine(term: Term, out: string[]): void {
  const line = term.partial
  term.partial = ''
  term.col = 0
  if (term.skipEcho !== null && line.trim().length > 0) {
    const echo = term.skipEcho.trim()
    term.skipEcho = null
    // The pty echoes what we typed; the command already has its own attributed line.
    if (echo.length > 0 && (line.trim() === echo || line.trimEnd().endsWith(echo))) return
  }
  out.push(line + '\n')
}

interface ScanResult {
  committed: string
  rest: string
  screen: boolean
  cleared: boolean
}

function scan(term: Term, input: string): ScanResult {
  const out: string[] = []
  let screen = false
  let cleared = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ESC) {
      const esc = parseEscape(input, i)
      if (!esc) return { committed: out.join(''), rest: input.slice(i), screen, cleared }
      i = esc.end
      if (!esc.csi) continue
      const effect = applyCsi(term, esc)
      if (effect === 'screen') screen = true
      else if (effect === 'cleared') cleared = true
      continue
    }
    i++
    if (ch === '\n') {
      commitLine(term, out)
      continue
    }
    if (ch === '\r') {
      // The whole point of the line buffer: a redraw overwrites, it does not stack.
      term.col = 0
      continue
    }
    if (ch === '\b') {
      if (term.col > 0) term.col--
      continue
    }
    if (ch === '\t') {
      const stop = term.col + (8 - (term.col % 8))
      while (term.col < stop) put(term, ' ')
      continue
    }
    if (ch < ' ' || ch === DEL) continue
    put(term, ch)
    if (term.partial.length >= MAX_PARTIAL_CHARS) commitLine(term, out)
  }
  return { committed: out.join(''), rest: '', screen, cleared }
}

/* --------------------------------------------------------------- pipeline */

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

function flush(term: Term): void {
  if (term.flushTimer) {
    clearTimeout(term.flushTimer)
    term.flushTimer = null
  }
  if (term.raw.length === 0) return
  const input = term.raw
  term.raw = ''
  // Priming: the login banner and terminado's replayed scrollback are not this
  // command's output, and the transcript already holds anything worth keeping.
  if (!term.primed) return

  const res = scan(term, input)
  // A held-back "escape" this long is really just text with a stray ESC in it.
  term.raw = res.rest.length > MAX_PENDING_ESC ? res.rest.slice(1) : res.rest

  if (res.screen && !term.screenApp) {
    term.screenApp = true
    detachOutput(term)
    systemLine(term, tr(SCREEN_NOTICE))
  }
  if (term.screenApp) return

  if (res.cleared && !term.clearNoticed) {
    term.clearNoticed = true
    detachOutput(term)
    systemLine(term, tr(CLEAR_NOTICE))
  }
  writeOut(term, budgeted(term, res.committed))
}

/** Keep only the tail of the window, saying so once per command. */
function budgeted(term: Term, committed: string): string {
  if (committed.length <= MAX_FLUSH_CHARS) return committed
  // At a line boundary if one is near: a stub cut mid-line reads as broken
  // output rather than trimmed output.
  const cut = committed.indexOf('\n', committed.length - MAX_FLUSH_CHARS)
  const from = cut < 0 || cut + 1 >= committed.length ? committed.length - MAX_FLUSH_CHARS : cut + 1
  const tail = committed.slice(from)
  if (!term.flooded) {
    term.flooded = true
    detachOutput(term)
    systemLine(term, tr(FLOOD_NOTICE))
  }
  return tail
}

/**
 * A shell prompt is the only signal a pty gives that a command is over, and it
 * is a guess: the prompt is just text. So both halves have to hold — output has
 * stopped for QUIET_MS *and* what is left on the line looks like a prompt. When
 * they do not, the command stays marked running, which is the honest answer for
 * `sleep 60` and anything else waiting on input.
 *
 * `>` in the set is not an oversight but a decision.
 *
 * The comment above used to name `python` as a case that stays "running"
 * here, and that was untrue: `>>> ` ends in `>`, and a REPL started in the
 * shared shell counts as finished at once. It counts, and that is good: while
 * a command is "running" its output is not handed over, and the person sitting
 * in python expects to see their lines. Without `>` a REPL in the shared shell
 * would be mute.
 *
 * The price is known: a line that happens to end in `>` in the middle of work
 * will be taken for a prompt. For that it also has to hang silent for
 * QUIET_MS, so in practice it is `>>> ` and `... `.
 *
 * `%` at the end of a line comes from zsh (its prompt) and from progress
 * indicators that print percentages. The second is handled by the same
 * silence: an indicator that moves is not silent.
 */
function promptLike(tail: string): boolean {
  if (tail.length === 0 || tail.length > 200) return false
  return /[$#%>❯]\s{0,2}$/.test(tail)
}

function onQuiet(term: Term): void {
  term.quietTimer = null
  flush(term)
  if (!promptLike(term.partial)) return
  finishCommand(term)
}

function armQuiet(term: Term): void {
  if (term.quietTimer) clearTimeout(term.quietTimer)
  term.quietTimer = setTimeout(() => onQuiet(term), QUIET_MS)
}

function finishCommand(term: Term): void {
  flush(term)
  /*
   * The output is taken BEFORE `detachOutput`: it unbinds the entry, and after
   * it there is nothing left to read. Whoever waits gets exactly what the room
   * saw.
   */
  settleRun(term, true)
  // The prompt is the shell talking to itself; the transcript has its own frame.
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.skipEcho = null
  term.screenApp = false
  term.clearNoticed = false
  term.flooded = false
  clearRunning(term)
  setPhase(term, 'idle')
  startNextPending(term)
}

/**
 * Tell the waiter how it ended, and forget it.
 *
 * `finished: false` means the command did not run to the end: the shell died,
 * the terminal was closed, the process is stopping. That is not the same as
 * "the command ended with an error", and the agent needs to tell them apart:
 * in the second case there is something to look at, in the first there is
 * nothing.
 */
function settleRun(term: Term, finished: boolean): void {
  const done = term.runningDone
  if (!done) return
  term.runningDone = null
  const line = term.outputLine
  let output = ''
  try {
    if (line) output = terminalText(line).toString()
  } catch {
    /* the entry was already unbound, so there is simply no output */
  }
  try {
    done({ output, finished })
  } catch (err) {
    console.error('[terminal] command waiter failed:', errText(err))
  }
}

/**
 * Queued commands that will no longer run.
 *
 * Three places dropped the queue silently: the shell dying, the terminal
 * failing, and its closing. `onShellExit` and `fail` cleared only the bytes in
 * flight and left `pending`, so the very first command in a reopened terminal
 * dragged along a `pip install` queued ten minutes and one shell ago. This is
 * where the queue goes out: whoever waited for it gets an answer at once, and
 * the room learns whose commands were lost.
 */
function dropPending(term: Term, why: string): void {
  if (term.pending.length === 0) return
  const dropped = term.pending.splice(0, term.pending.length)
  settlePending(dropped)
  systemLine(
    term,
    dropped.length === 1
      ? tr("server.colloqTheCommandWasRemovedFromThe.7c25e4", { p0: dropped[0].by.name, p1: why })
      : tr("server.colloqRemovedFromTheQueue.649577", { p0: dropped.length, p1: commandWord(dropped.length), p2: why }),
  )
}

/** Tell those who waited for the removed commands that they will not run. */
function settlePending(items: Array<{ done?: Done }>): void {
  for (const item of items) {
    if (!item.done) continue
    try {
      item.done({ output: '', finished: false })
    } catch (err) {
      console.error('[terminal] command waiter failed:', errText(err))
    }
  }
}

function clearRunning(term: Term): void {
  const line = term.commandLine
  term.commandLine = null
  term.commandLineId = null
  if (!line) return
  const doc = docOf(term)
  if (line.get('running') === true) doc.transact(() => line.set('running', false), ORIGIN)
}

function onChunk(term: Term, chunk: string): void {
  if (!term.primed) {
    if (Date.now() >= term.primeDeadline) finishPrime(term)
    else armPrime(term)
    return
  }
  term.raw += chunk
  if (!term.flushTimer) {
    term.flushTimer = setTimeout(() => {
      term.flushTimer = null
      flush(term)
    }, FLUSH_MS)
  }
  armQuiet(term)
}

/* ----------------------------------------------------------------- socket */

function jupyterRequest(endpoint: KernelEndpoint, path: string, method: string) {
  return fetch(`${endpoint.url}${path}`, {
    method,
    headers: {
      Authorization: `token ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

async function createJupyterTerminal(endpoint: KernelEndpoint): Promise<string> {
  const res = await jupyterRequest(endpoint, '/api/terminals', 'POST')
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        tr("server.jupyterRejectedTheServerCredentialsHttpCheck.9d96c8", { p0: res.status }),
      )
    }
    throw new Error(tr("server.jupyterCouldNotCreateTheShellHttp.1a2d57", { p0: res.status }))
  }
  const parsed = (await res.json()) as { name?: unknown }
  const name = parsed?.name
  if (typeof name !== 'string' && typeof name !== 'number') {
    throw new Error(tr("server.jupyterCreatedAShellWithoutAName.f86302"))
  }
  return String(name)
}

async function deleteJupyterTerminal(endpoint: KernelEndpoint, name: string): Promise<void> {
  const res = await jupyterRequest(endpoint, `/api/terminals/${encodeURIComponent(name)}`, 'DELETE')
  // 404 means somebody beat us to it, which is the outcome we wanted anyway.
  if (!res.ok && res.status !== 404) {
    throw new Error(tr("server.jupyterCouldNotCloseTheShellHttp.2aef51", { p0: res.status }))
  }
}

class TerminalCancelled extends Error {
  constructor() { super(tr("server.openingTheTerminalWasCancelledBecauseIt.783698")) }
}
function currentAttempt(term: Term, generation: number): boolean {
  return term.generation === generation && !term.closing && terms.get(term.sessionId) === term
}
function checkAttempt(term: Term, generation: number): void {
  if (!currentAttempt(term, generation)) throw new TerminalCancelled()
}
function invalidateAttempt(term: Term): void {
  term.generation++
  term.closing = true
  // A new explicit open need not wait for a canceled, slow HTTP response.
  term.opening = null
  for (const socket of term.connecting) socket.terminate()
  term.connecting.clear()
}
async function createForAttempt(term: Term, endpoint: KernelEndpoint, generation: number): Promise<void> {
  checkAttempt(term, generation)
  const name = await createJupyterTerminal(endpoint)
  if (!currentAttempt(term, generation)) {
    // This PTY was never handed to term.name, so closeTerminal could not own
    // its cleanup. Never overwrite the name belonging to a newer attempt.
    try { await deleteJupyterTerminal(endpoint, name) }
    catch (error) { console.error(`[terminal] late PTY cleanup failed for ${term.sessionId}:`, errText(error)) }
    throw new TerminalCancelled()
  }
  // Transfer cleanup ownership synchronously with the generation check. An
  // assignment in the caller after await would reopen a microtask race.
  term.name = name
}

function socketUrl(endpoint: KernelEndpoint, name: string): string {
  const base = new URL(endpoint.url)
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = base.pathname.replace(/\/+$/, '')
  const query = new URLSearchParams({ token: endpoint.token })
  return `${scheme}//${base.host}${prefix}/terminals/websocket/${encodeURIComponent(name)}?${query.toString()}`
}

function sendFrame(term: Term, frame: unknown[]): boolean {
  const socket = term.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

const sendStdin = (term: Term, data: string) => sendFrame(term, ['stdin', data])

const sendSize = (term: Term) =>
  sendFrame(term, ['set_size', TERM_ROWS, TERM_COLS, TERM_ROWS * 16, TERM_COLS * 8])

function connect(term: Term, generation: number): Promise<void> {
  checkAttempt(term, generation)
  const name = term.name
  if (!name) return Promise.reject(new Error(tr("server.cannotConnectTheShellHasNoName.f64bd7")))

  return new Promise<void>((resolve, reject) => {
    let socket: WebSocket
    try {
      // The token rides in the query string for terminado and in the header for
      // reverse proxies that strip query strings.
      socket = new WebSocket(socketUrl(term.endpoint, name), {
        headers: { Authorization: `token ${term.endpoint.token}` },
      })
      term.connecting.add(socket)
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
      reject(
        new Error(tr("server.theShellChannelDidNotOpenWithin.dcc3b4", { p0: Math.round(CONNECT_TIMEOUT_MS / 1000) })),
      )
    }, CONNECT_TIMEOUT_MS)

    socket.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      term.connecting.delete(socket)
      if (!currentAttempt(term, generation)) {
        socket.terminate()
        reject(new TerminalCancelled())
        return
      }
      /*
       * The previous socket to the same pty is closed here, not "some time".
       *
       * `term.socket = socket` used to simply overwrite the previous one, which
       * stayed with a live handler: terminado sends output to both, and every
       * line of the running command was written into the shared transcript
       * twice, until the end of the lesson.
       */
      const previous = term.socket
      if (previous && previous !== socket) {
        try {
          previous.close()
        } catch {
          /* already gone */
        }
      }
      term.socket = socket
      resolve()
    })

    socket.on('message', (data: RawData) => {
      // An orphaned socket's frames are not our output: its command moved to another socket long ago.
      if (term.socket !== socket || !currentAttempt(term, generation)) return
      const text = frameText(data)
      if (text === null) return
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      // terminado frames are JSON arrays: ["stdout", text], ["setup", {}], ["disconnect", n].
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return
      if (parsed[0] === 'stdout' || parsed[0] === 'stderr') {
        const chunk = typeof parsed[1] === 'string' ? parsed[1] : ''
        if (chunk.length > 0) onChunk(term, chunk)
      } else if (parsed[0] === 'disconnect') {
        onShellExit(term)
      }
    })

    socket.on('error', (err: Error) => {
      term.connecting.delete(socket)
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    socket.on('close', () => {
      term.connecting.delete(socket)
      clearTimeout(timer)
      const ours = term.socket === socket
      if (ours) term.socket = null
      if (!settled) {
        settled = true
        reject(new Error(tr("server.theShellChannelClosedBeforeOpening.45e62d")))
        return
      }
      // The socket that closed is not the one the terminal uses now: this is
      // cleaning up after ourselves, not a dropout. Reconnecting on it would
      // breed a third one.
      if (!ours) return
      if (!currentAttempt(term, generation) || term.phase === 'closed' || term.phase === 'dead') return
      term.primed = false
      scheduleReconnect(term)
    })
  })
}

function closeSocket(term: Term): void {
  const socket = term.socket
  term.socket = null
  if (!socket) return
  try {
    socket.close()
  } catch {
    /* already gone */
  }
}

/** Somebody typed `exit` (or Ctrl-D): the pty is gone, not broken. */
function onShellExit(term: Term): void {
  invalidateAttempt(term)
  clearTimers(term)
  clearRunning(term)
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.raw = ''
  term.queued = []
  term.primed = false
  term.name = null
  closeSocket(term)
  settleRun(term, false)
  rejectWaiters(term, new Error(tr("server.theShellExited.3948b2")))
  setPhase(term, 'closed')
  systemLine(term, tr("server.colloqTheShellExitedSelectRestartShell.bc74b5"))
  dropPending(term, tr("server.theShellExited.3948b2"))
}

/* -------------------------------------------------------------- lifecycle */

function clearTimers(term: Term): void {
  for (const key of ['flushTimer', 'quietTimer', 'primeTimer', 'reconnectTimer'] as const) {
    const timer = term[key]
    if (timer) clearTimeout(timer)
    term[key] = null
  }
}

function resolveWaiters(term: Term): void {
  for (const waiter of term.waiters.splice(0, term.waiters.length)) waiter.resolve()
}

function rejectWaiters(term: Term, err: Error): void {
  for (const waiter of term.waiters.splice(0, term.waiters.length)) waiter.reject(err)
}

/** Gone for good: say so in the transcript the room is reading, not just in a log. */
function fail(term: Term, message: string): void {
  clearTimers(term)
  term.queued = []
  term.raw = ''
  term.primed = false
  clearRunning(term)
  closeSocket(term)
  setPhase(term, 'dead')
  systemLine(term, `[colloq] ${message}`)
  dropPending(term, tr("server.theTerminalNoLongerExists.fe4ae0"))
  rejectWaiters(term, new Error(message))
}

function armPrime(term: Term): void {
  if (term.primeTimer) clearTimeout(term.primeTimer)
  term.primeTimer = setTimeout(() => finishPrime(term), PRIME_QUIET_MS)
}

function startPrime(term: Term, greet: boolean): void {
  term.primed = false
  term.raw = ''
  term.primeDeadline = Date.now() + PRIME_MAX_MS
  // The prompt belongs where the notebook's files are, so `ls` in the terminal
  // and `open('data.csv')` in a cell agree about what "here" means.
  if (greet) sendStdin(term, `cd ${kernelCwd(term.sessionId)} && clear\n`)
  armPrime(term)
}

function finishPrime(term: Term): void {
  if (term.primeTimer) {
    clearTimeout(term.primeTimer)
    term.primeTimer = null
  }
  if (term.primed) return
  term.primed = true
  term.raw = ''
  /*
   * An unfinished line is closed here, not forgotten.
   *
   * This used to be `term.tailLen = 0`, that is, the tail's accounting was
   * reset while the tail itself (a tqdm frame, half a line) stayed at the end
   * of the entry in the document. The next `writeOut` saw `tail === 0`, erased
   * nothing and appended the new frame after the old one: two frames of one
   * line in a row in the transcript. `detachOutput` takes the tail out of the
   * document and closes the entry, so we write from a clean slate after it.
   */
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.reconnectAttempts = 0
  setPhase(term, term.commandLine ? 'busy' : 'idle')
  resolveWaiters(term)
  drainQueued(term)
  probeShell(term)
}

/**
 * Ask the shell whether it is free, with an empty line.
 *
 * After a server restart the transcript says a command is running, and only
 * the pty knows the truth. A free shell prints a new prompt on `\n`; `onQuiet`
 * sees it and closes the line the usual way (`finishCommand`), and the guard
 * is lifted with it. A busy one stays silent, and the line stays "running",
 * which is the truth. A newline into the stdin of a running program costs the
 * same as the greeting `cd … && clear` we send on every open anyway.
 */
function probeShell(term: Term): void {
  if (!term.probe) return
  term.probe = false
  sendStdin(term, '\n')
}

function scheduleReconnect(term: Term): void {
  if (term.reconnectTimer || term.closing) return
  if (term.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    fail(term, tr("server.theConnectionToTheSharedShellWas.94c77c"))
    return
  }
  const wait = Math.min(500 * 2 ** term.reconnectAttempts, 5000)
  term.reconnectAttempts++
  setPhase(term, 'starting')
  term.reconnectTimer = setTimeout(() => {
    term.reconnectTimer = null
    void reconnect(term)
  }, wait)
}

/**
 * A dropped websocket is a network hiccup, not a dead shell: the pty keeps
 * running inside the container, so re-attaching resumes the same session with
 * the same cwd. Terminado replays its scrollback on attach, which the transcript
 * already has — hence the prime, which throws that replay away.
 */
function reconnect(term: Term): Promise<void> {
  if (term.closing || term.phase === 'closed' || !term.name) return Promise.resolve()
  if (term.opening) return term.opening
  const generation = term.generation
  /*
   * A reconnect holds the same field as an open, and that closes a window.
   *
   * While `connect` is in flight, `term.socket` is already null and the
   * reconnect timer already cleared, and `opening` used not to be set, so all
   * three guards of `openTerminal` were empty, and a second entry (the
   * Oracle's hands, a command arriving at that instant) opened a SECOND socket
   * to the same shell: `cd … && clear` into the stdin of a running `pip`,
   * output in the transcript twice, phase `idle` with a live command.
   */
  const run = (async () => {
    try {
      if (kernelBackend() === 'broker') {
        const current = await endpointForSession(term.sessionId, sessionEnvironment(term.sessionId))
        checkAttempt(term, generation)
        if (endpointIdentity(current) !== endpointIdentity(term.endpoint)) {
          term.name = null
          term.endpoint = current
          rememberPty(term)
          fail(term, tr("server.theSeminarKernelWasReplacedThePrevious.bacb22"))
          return
        }
        term.endpoint = current
      }
      await connect(term, generation)
      checkAttempt(term, generation)
      sendSize(term)
      startPrime(term, false)
    } catch (err) {
      if (!currentAttempt(term, generation)) return
      console.error(`[terminal] reconnect failed for ${term.sessionId}:`, errText(err))
      scheduleReconnect(term)
    } finally {
      if (term.generation === generation) term.opening = null
    }
  })()
  term.opening = run
  return run
}

/**
 * Idempotent and concurrency-safe: two people opening the terminal at the same
 * moment share one pty, the same way they share one kernel.
 */
export function openTerminal(sessionId: string): Promise<void> {
  const term = getTerm(sessionId)
  if (term.opening) return term.opening
  if (term.socket && term.socket.readyState === WebSocket.OPEN) return Promise.resolve()
  if (term.reconnectTimer) return waitFor(term)
  const generation = ++term.generation

  term.opening = (async () => {
    term.closing = false
    term.reconnectAttempts = 0
    setPhase(term, 'starting')
    // A transcript restored from disk is somebody else's bookkeeping until now.
    adoptTranscript(term)
    sessionDir(sessionId)
    try {
      /*
       * The shell goes into this same room's container, the very one its
       * cells compute in. That can take a minute: if the container is not up
       * yet, this is where it starts, exactly the same pause as on the first
       * cell run, and for the same reason.
       */
      const endpoint = await endpointForSession(sessionId, sessionEnvironment(sessionId))
      checkAttempt(term, generation)
      /*
       * A changed address invalidates the remembered name: a pty with that
       * name lives in another container, and trying to connect to it will at
       * best miss, and at worst lead us into someone else's shell.
       */
      if (endpointIdentity(endpoint) !== endpointIdentity(term.endpoint)) term.name = null
      term.endpoint = endpoint

      /*
       * The pty name is looked up beyond this process too.
       *
       * The shell lives in the room's container and survives a server restart,
       * just like the kernel. The `terms` map does not survive it, so the name
       * is kept in the room's document (see PTY_KEY): without it `make run`
       * after an edit started a new shell, while a `python train.py` started in
       * the old one kept computing into nowhere.
       */
      const restored = term.name === null ? rememberedPty(term, endpointIdentity(endpoint)) : null
      if (restored) term.name = restored

      const remembered = term.name !== null
      if (!term.name) await createForAttempt(term, endpoint, generation)
      checkAttempt(term, generation)
      let fresh = !remembered
      try {
        await connect(term, generation)
        checkAttempt(term, generation)
      } catch (err) {
        checkAttempt(term, generation)
        // A remembered pty that will not take a connection is gone (container
        // restarted, terminal reaped). Allocate a fresh one rather than making
        // someone click Open twice to find that out.
        if (!remembered) throw err
        await createForAttempt(term, endpoint, generation)
        checkAttempt(term, generation)
        fresh = true
        await connect(term, generation)
        checkAttempt(term, generation)
      }
      rememberPty(term)
      // We are back in the same shell, so a command marked "running" may
      // really be running. We revive it and ask the shell (see probeShell).
      const resumed = !fresh && restored !== null && resumeCommand(term)
      if (resumed) term.probe = true
      sendSize(term)
      /*
       * The greeting goes only into a free shell.
       *
       * `cd … && clear` into a shell running `python train.py` is a line of
       * text in someone else's program's stdin. Until we know whether the shell
       * is free, we ask with the quietest thing there is: an empty line (see
       * probeShell). Same cost and same answer, but without a command that
       * might execute.
       */
      startPrime(term, !resumed)
    } catch (err) {
      if (!currentAttempt(term, generation)) throw new TerminalCancelled()
      term.name = null
      // The room container's port is random and remembered by the pool; after
      // `docker restart` it is different. Forget it, otherwise the next attempt
      // goes to the same dead address, and so on until the whole server
      // restarts.
      forgetSessionKernel(sessionId)
      const message = tr("server.couldNotOpenTheSharedShell.c33160", { p0: errText(err) })
      fail(term, message)
      throw new Error(message)
    } finally {
      if (term.generation === generation) term.opening = null
    }
  })()

  return term.opening
}

function waitFor(term: Term): Promise<void> {
  if (term.primed && term.socket && term.socket.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => term.waiters.push({ resolve, reject }))
}

function whenReady(term: Term): Promise<void> {
  if (term.primed && term.socket && term.socket.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }
  const waiting = waitFor(term)
  // The open may already be in flight; either way its failure reaches the waiter.
  void openTerminal(term.sessionId).catch(() => {})
  return waiting
}

/** Typed-before-it-was-ready commands run in the order they were typed. */
function drainQueued(term: Term): void {
  if (term.queued.length === 0) return
  const pending = term.queued.splice(0, term.queued.length)
  for (const payload of pending) {
    if (!sendStdin(term, payload)) {
      fail(term, tr("server.couldNotConnectToTheSharedShell.5b8c9e"))
      return
    }
  }
}

/* --------------------------------------------------------------- commands */

export function runCommand(
  sessionId: string,
  command: string,
  by: { name: string; color: string; participantId: string },
  done?: Done,
): void {
  const term = getTerm(sessionId)
  const text = command.replace(/\r/g, '').replace(/\n+$/, '')
  if (text.trim().length === 0) {
    done?.({ output: '', finished: false })
    return
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) {
    systemLine(term, tr("server.colloqTheCommandIsTooLongPut.50c546"))
    done?.({ output: '', finished: false })
    return
  }

  /*
   * One shell, so one command at a time. A command typed while another is
   * running waits its turn instead of being pushed at a shell that will buffer
   * it and echo it back later: that produced a transcript nobody could read —
   * the first person's last line of output printed underneath the second
   * person's command, and the second command written twice.
   *
   * The line is not written here either. It goes in when the command actually
   * starts, so the order in the transcript is the order things ran.
   *
   * Busyness is measured by the live command line, not by the phase. The phase
   * lies in two ordinary cases: a dropped socket to Jupyter sets `starting`
   * even though the pty inside the container keeps computing, and `Clear` in
   * the middle of someone else's command. In both, the `phase === 'busy'`
   * condition stopped holding, and the command went into the running one's
   * stdin: its bytes went to `train.py`, and the rest of someone else's output
   * was printed under the line of whoever just typed `ls`. The command line
   * lives exactly as long as the command: `clearRunning` clears it at the end,
   * when the shell dies and when the terminal closes.
   */
  if (term.commandLine) {
    if (term.pending.length >= MAX_PENDING_COMMANDS) {
      systemLine(term, tr("server.colloqTooManyCommandsAreQueuedTry.76db34"))
      // Whoever waits for the answer (the Oracle) must learn about the refusal
      // now, not a minute and a half later from a timeout.
      done?.({ output: '', finished: false })
      return
    }
    term.pending.push({ text, by, done })
    systemLine(term, tr("server.colloqTheCommandIsWaitingForThe.0e6b42", { p0: by.name }))
    return
  }

  dispatch(term, text, by, done)
}

/** Hard stop on how many commands may be stacked up behind a busy shell. */
const MAX_PENDING_COMMANDS = 8

/** How a command ended: all its output and whether its end was reached at all. */
export type Done = (result: { output: string; finished: boolean }) => void

function dispatch(term: Term, text: string, by: Sender, done?: Done): void {
  // Whatever ran before is no longer the thing producing output, whether or not
  // we ever recognised its prompt.
  // And whoever waited for the previous one waits in vain: its output will not be collected.
  settleRun(term, false)
  term.runningDone = done ?? null
  term.runningBy = by.participantId
  clearRunning(term)
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.screenApp = false
  term.clearNoticed = false
  term.flooded = false
  term.skipEcho = text.split('\n')[0]

  const line = createTerminalLine({
    kind: 'command',
    text,
    name: by.name,
    color: by.color,
    participantId: by.participantId,
  })
  appendEntry(term, line, text.length, countLines(text) + 1)
  term.commandLine = line
  term.commandLineId = lineId(line)
  setPhase(term, 'busy')

  term.queued.push(`${text}\n`)
  void whenReady(term)
    .then(() => drainQueued(term))
    .catch(() => {
      // fail() already put the reason in the transcript; do not keep claiming
      // this command is running.
      clearRunning(term)
      startNextPending(term)
    })
}

/** The shell is free again: give it whatever has been waiting longest. */
function startNextPending(term: Term): void {
  const next = term.pending.shift()
  if (!next) return
  dispatch(term, next.text, next.by, next.done)
}

/** Whoever typed the command the shell is running now, or null between commands. */
export function typedRunningCommand(sessionId: string, participantId: string): boolean {
  return terms.get(sessionId)?.runningBy === participantId
}

/**
 * Whether the shell is busy right now, by the same measure as `runCommand`.
 *
 * By the live command line, not by the phase. The phase lies in the two
 * ordinary cases listed above `runCommand`: a dropped socket to Jupyter sets
 * `starting` even though the pty inside the container keeps computing, and
 * `Clear` in the middle of someone else's command. For the asker (the Oracle
 * in "Act" mode) a mistake is costly: it decides by this answer whether to put
 * its run into the shared queue, and a command that starts after its turn has
 * ended runs in the room on its own.
 */
export function terminalBusy(sessionId: string): boolean {
  return terms.get(sessionId)?.commandLine != null
}

/**
 * Remove this person's commands from the queue without touching the running
 * one.
 *
 * `interruptTerminal` does the same, but together with Ctrl+C; here only the
 * first step is needed: the Oracle's turn is over, and its command, queued
 * behind someone else's, would start a minute later, with no audience, nobody
 * waiting, and in the middle of something else entirely. Returns how many
 * were removed.
 */
export function dropPendingOf(sessionId: string, participantId: string): number {
  const term = terms.get(sessionId)
  if (!term || term.pending.length === 0) return 0
  const mine = term.pending.filter((item) => item.by.participantId === participantId)
  if (mine.length === 0) return 0
  term.pending = term.pending.filter((item) => item.by.participantId !== participantId)
  // The waiter is answered at once: its command was removed, not "running".
  settlePending(mine)
  systemLine(
    term,
    mine.length === 1
      ? tr("server.colloqTheCommandWasRemovedFromThe.1c9d79", { p0: mine[0].by.name })
      : tr("server.colloqRemovedFromTheQueue.9a6da6", { p0: mine.length, p1: commandWord(mine.length) }),
  )
  return mine.length
}

/**
 * Ctrl+C into the shared shell: take your own commands out of the queue and
 * stop your own command.
 *
 * @param by       Who pressed it, for the line in the transcript.
 * @param byId     Their participantId. The host does not pass it: the host stops everything.
 */
export function interruptTerminal(sessionId: string, by?: string, byId?: string): void {
  const term = terms.get(sessionId)
  if (!term) return
  /*
   * Ctrl+C goes into your own command, not whichever happens to be there.
   *
   * The host comes without `byId`: for the host the button means "stop
   * everything in this room", and that makes sense too. Others have nothing
   * to interrupt if someone else's command is running, and they come here not
   * only by the button: the Oracle's wait deadline (`ai/agent.ts` · stopRun)
   * fell exactly when its own run was still queued, and the ninetieth second
   * of someone else's `pip install` ended with a Ctrl+C into it.
   * `term:interrupt` from the console already checks the same thing with its
   * `typedRunningCommand`; this is a second lock, because more than one door
   * leads here.
   */
  const mayStop = !byId || term.runningBy === byId
  // Commands still waiting to be sent would run *after* the interrupt, which is
  // the opposite of what the button means. That goes for both queues: the bytes
  // on their way to the pty, and whole commands still waiting their turn.
  // The bytes in flight belong to the RUNNING command: someone else's line
  // must not be cut halfway into the pty, the shell would execute the stub.
  if (mayStop) term.queued = []
  if (term.pending.length > 0) {
    /*
     * Your own commands drop out of the queue, not everything in it.
     *
     * Ctrl+C stops the command that is running. The queue behind it holds
     * commands queued by other people, and a student who interrupted a hung
     * `pip install` used to silently take with it everything the teacher had
     * managed to queue. The same rule as for cells: your own batch, not
     * someone else's.
     *
     * The host comes here without byId and still drops everything: for the
     * host the button means "stop everything in this room", and that makes
     * sense too.
     */
    const mine = byId ? term.pending.filter((item) => item.by.participantId === byId) : term.pending
    const keep = byId ? term.pending.filter((item) => item.by.participantId !== byId) : []
    const dropped = mine.length
    term.pending = keep
    // The waiter (the Oracle) is answered at once: its command was removed, not "running".
    settlePending(mine)
    if (dropped > 0) {
      systemLine(
        term,
        dropped === 1
          ? tr("server.colloqTheCommandWasRemovedFromThe.1c9d79", { p0: mine[0].by.name })
          : tr("server.colloqRemovedFromTheQueue.9a6da6", { p0: dropped, p1: commandWord(dropped) }),
      )
    }
  }
  /*
   * Nothing to interrupt, and nothing to say.
   *
   * A line "X pressed Ctrl+C" above someone else's command that keeps running
   * is a lie in the shared transcript: the room reads it as "the command was
   * stopped". Your own queued commands have been removed meanwhile, and that
   * was said above in its own words.
   */
  if (!mayStop) return
  // Named, because a shared shell that goes quiet without saying who did it is
  // a room where everybody assumes it was somebody else.
  if (by) systemLine(term, tr("server.colloqCtrlCIsStoppingTheCommand.3aead4", { p0: by }))
  /*
   * The send result is read, and that is no small matter.
   *
   * `sendStdin` returns false when there is no open socket: the channel to
   * Jupyter dropped, a reconnect. The room still saw the "X pressed Ctrl+C"
   * line, while the command in the pty kept running: the queue already
   * dropped, no explanation, and the person presses "stop" a second and third
   * time into the void. ETX goes first into `queued` and will be sent as soon
   * as the channel returns, the same way as commands typed before the shell
   * was ready.
   */
  if (!sendStdin(term, ETX)) {
    // A closed terminal has nothing to interrupt, and an ETX left in its queue
    // would go to the next, different, shell.
    if (term.phase === 'closed') return
    term.queued.unshift(ETX)
    systemLine(
      term,
      tr("server.colloqTheShellIsDisconnectedSoCtrl.885614") +
        tr("server.itWillBeSentWhenTheTerminal.bdfcc3"),
    )
  }
}

export function clearTerminal(sessionId: string): void {
  const term = getTerm(sessionId)
  const doc = docOf(term)
  const array = getTerminal(doc)
  /*
   * A running command survives the clearing, as a new line.
   *
   * The transcript can be erased, but the command in the shell cannot: the
   * `pip install` inside keeps running. The command line used to be lost along
   * with the entries, and with it the whole "one command at a time" guard: the
   * next person to type `ls` sent it into the busy shell, and its output was
   * printed under someone else's line. We create a fresh line for the running
   * command, so the room sees exactly what is still working.
   */
  const running = term.commandLine
  const carried = running
    ? {
        text: terminalText(running).toString(),
        name: (running.get('name') as string | null) ?? null,
        color: (running.get('color') as string | null) ?? null,
        participantId: (running.get('participantId') as string | null) ?? null,
      }
    : null
  if (array.length > 0) doc.transact(() => array.delete(0, array.length), ORIGIN)
  term.ledger = []
  term.chars = 0
  term.lines = 0
  term.outputLine = null
  term.outputLineId = null
  term.outChars = 0
  term.outLines = 0
  term.tailLen = 0
  term.commandLine = null
  term.commandLineId = null
  // The tail is gone from the document; keeping it here would duplicate it into
  // the next entry a moment later.
  term.partial = ''
  term.col = 0
  if (!carried) return
  const line = createTerminalLine({
    kind: 'command',
    text: carried.text,
    name: carried.name,
    color: carried.color,
    participantId: carried.participantId,
  })
  appendEntry(term, line, carried.text.length, countLines(carried.text) + 1)
  term.commandLine = line
  term.commandLineId = lineId(line)
}

export async function closeTerminal(sessionId: string): Promise<void> {
  const term = terms.get(sessionId)
  if (!term) return
  invalidateAttempt(term)
  clearTimers(term)
  clearRunning(term)
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.raw = ''
  term.queued = []
  term.primed = false
  closeSocket(term)
  const name = term.name
  term.name = null
  // We are about to delete this shell, so there will be nothing to return to.
  rememberPty(term)
  settleRun(term, false)
  rejectWaiters(term, new Error(tr("server.theTerminalWasClosed.5a818b")))
  setPhase(term, 'closed')
  systemLine(term, tr("server.colloqTheTerminalIsClosed.9cf9fb"))
  dropPending(term, tr("server.theTerminalWasClosed.5a818b"))
  if (!name) return
  try {
    await deleteJupyterTerminal(term.endpoint, name)
  } catch (err) {
    // The pty may outlive us, but the room's view of it is already correct.
    console.error(`[terminal] could not delete terminal for ${sessionId}:`, errText(err))
  }
}

/**
 * The server is stopping, not the seminars: the same rule as `shutdownKernels`.
 *
 * There used to be a `DELETE /api/terminals/<name>` here, and the shell died
 * together with the `python train.py` inside: `make run`, which the Makefile
 * advises after any edit, cost the seminar a three-hour training run, and the
 * transcript said not a word about it. The justification ("otherwise the pty
 * outlives the process and takes up the container's memory") stopped holding
 * once the container became one per room: it lives on anyway, and the idle
 * sweep removes it along with everything else. The pty name is in the room's
 * document, so the next start returns to the same shell; see PTY_KEY and
 * `resumeCommand`.
 */
export async function shutdownTerminals(): Promise<void> {
  const all = [...terms.values()]
  terms.clear()
  for (const term of all) {
    invalidateAttempt(term)
    clearTimers(term)
    closeSocket(term)
    rejectWaiters(term, new Error(tr("server.theServerIsShuttingDown.79c391")))
  }
}
