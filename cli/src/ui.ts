/**
 * The only place where the CLI prints anything.
 *
 * The vocabulary is closed: five symbols, four colours, tables by hand. There
 * is no green: the Makefile has none either. Colour goes off entirely with
 * NO_COLOR, --no-color and when the output is not a terminal: then not a
 * single escape byte is left in the stream, and a test guards that.
 */

/** Symbols. Do not add others: ● running · ○ not · ✓ passed · ✗ refusal · → next. */
export const SYMBOL = { on: '●', off: '○', ok: '✓', bad: '✗', next: '→' } as const

// The same codes as in the Makefile header.
const BOLD = '\u001b[1m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const RED = '\u001b[31m'
const OFF = '\u001b[0m'

/**
 * A precondition is not met: no .env, no docker, no terminal for a question: code 3.
 *
 * The three parts are the same as in ui.refuse: what happened, what caused it,
 * what to do. why is optional: there simply will be no second line.
 */
export class PreconditionError extends Error {
  readonly code = 3
  readonly fix: string
  readonly why: string
  constructor(message: string, fix = '', why = '') {
    super(message)
    this.name = 'PreconditionError'
    this.fix = fix
    this.why = why
  }
}

/** Usage: no command, no required argument, conflicting flags: code 2. */
export class UsageError extends Error {
  readonly code = 2
  readonly fix: string
  readonly why: string
  constructor(message: string, fix = '', why = '') {
    super(message)
    this.name = 'UsageError'
    this.fix = fix
    this.why = why
  }
}

export type Ui = {
  /** Whether colour is on. */
  readonly color: boolean
  /** --json mode: the normal output is switched off entirely. */
  readonly jsonMode: boolean
  bold(text: string): string
  dim(text: string): string
  cyan(text: string): string
  red(text: string): string
  /** A line as is, to stdout. */
  line(text?: string): void
  /** A section heading: one BOLD line. */
  header(text: string): void
  /** Key-value: two spaces, the key padEnd(12), the value, then " · " and a DIM note. */
  kv(key: string, value: string, hint?: string): void
  /** A hint under a line: six spaces, DIM, starts with "→ ". */
  hint(text: string): void
  /** A table by hand: padEnd to the measured width, a two-space indent, no borders. */
  table(rows: string[][]): void
  /** A refusal is exactly three lines on stderr: what, why, what to do. */
  refuse(what: string, why: string, fix: string): void
  /** A question that defaults to "no". No terminal means PreconditionError (code 3). */
  confirm(question: string): Promise<boolean>
  /** Prints JSON and switches off all other output. */
  json(value: unknown): void
}

export type UiOptions = {
  color?: boolean
  json?: boolean
  out?: (text: string) => void
  err?: (text: string) => void
  /** Whether there is a terminal in front of us: it decides whether we may ask. */
  tty?: boolean
  /** A stand-in source of answers, for tests. */
  ask?: (question: string) => Promise<string>
}

/** The length of a string without escape sequences: column widths are measured by it. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length
}

/** Remove escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** Is colour allowed? NO_COLOR with any value and a non-terminal switch it off entirely. */
export function colorAllowed(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if ('NO_COLOR' in env) return false
  return isTty
}

/**
 * Writing to a stream that may have been closed from the other end.
 *
 * `colloq doctor | head` closes the pipe at the tenth line, and the next write
 * throws EPIPE. For us this is not an error: the reader has had enough. We go
 * quiet silently, exactly as ordinary utilities do.
 */
function writer(stream: NodeJS.WriteStream): (text: string) => void {
  let broken = false
  stream.on('error', () => void (broken = true))
  return (text: string) => {
    if (broken) return
    try {
      stream.write(text + '\n')
    } catch {
      broken = true
    }
  }
}

export function createUi(opts: UiOptions = {}): Ui {
  const color = opts.color ?? false
  const out = opts.out ?? writer(process.stdout)
  const err = opts.err ?? writer(process.stderr)
  const tty = opts.tty ?? false
  let jsonMode = opts.json ?? false
  // JSON printed once is the whole output of the command: we do not print it a second time.
  let jsonDone = false

  const paint = (code: string, text: string): string => (color ? code + text + OFF : text)

  const ui: Ui = {
    get color() {
      return color
    },
    get jsonMode() {
      return jsonMode
    },
    bold: (text) => paint(BOLD, text),
    dim: (text) => paint(DIM, text),
    cyan: (text) => paint(CYAN, text),
    red: (text) => paint(RED, text),
    line(text = '') {
      if (jsonMode) return
      out(text)
    },
    header(text) {
      if (jsonMode) return
      out(ui.bold(text))
    },
    kv(key, value, hint) {
      if (jsonMode) return
      // The note is set off by a dot, not by colour alone: without colour (a
      // pipe, NO_COLOR, a log) the value and the note ran together into one
      // phrase.
      const tail = hint ? ' · ' + ui.dim(hint) : ''
      out('  ' + key.padEnd(12) + value + tail)
    },
    hint(text) {
      if (jsonMode) return
      out('      ' + ui.dim(SYMBOL.next + ' ' + text))
    },
    table(rows) {
      if (jsonMode) return
      if (rows.length === 0) return
      const indent = '  '
      const gap = '  '
      const columns = Math.max(...rows.map((row) => row.length))
      const widths: number[] = []
      for (let i = 0; i < columns; i++) {
        widths[i] = Math.max(...rows.map((row) => visibleLength(row[i] ?? '')))
      }
      for (const row of rows) {
        const cells: string[] = []
        for (let i = 0; i < columns; i++) {
          const cell = row[i] ?? ''
          const pad = ' '.repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell)))
          cells.push(cell + pad)
        }
        // There are no trailing spaces in the output: the right edge of the line is trimmed.
        out((indent + cells.join(gap)).replace(/[ ]+$/, ''))
      }
    },
    refuse(what, why, fix) {
      // In --json mode a refusal is JSON too, and not a line outside it,
      // including on stderr.
      if (jsonMode) {
        ui.json({ ok: false, code: 3, error: what + (why ? '. ' + why : ''), hint: fix })
        return
      }
      err(ui.red(SYMBOL.bad + ' ' + what))
      if (why) err(why)
      if (fix) err(ui.dim(SYMBOL.next + ' ' + fix))
    },
    async confirm(question) {
      const ask = opts.ask
      if (!ask && !tty) {
        throw new PreconditionError(
          'no terminal to ask in',
          'repeat with --yes if you agree in advance',
        )
      }
      const line = SYMBOL.next + ' ' + question + ' [y/N] '
      const answer = ask ? await ask(line) : await readLine(line)
      const value = answer.trim().toLowerCase()
      return value === 'y' || value === 'yes'
    },
    json(value) {
      jsonMode = true
      if (jsonDone) return
      jsonDone = true
      out(JSON.stringify(value))
    },
  }
  return ui
}

/**
 * "3 rooms", "1 package": the number always comes before the word, and the
 * word follows the number.
 *
 * There are two forms, and one rule for all words, so there is no reason to
 * copy it a second time for packages. The second word is given only where the
 * plural is irregular: countWord(2, 'class', 'classes'); a regular one is fine
 * with 's'.
 */
export function countWord(count: number, one: string, many = one + 's'): string {
  return count + ' ' + (count === 1 ? one : many)
}

/** Two places need the room count: the question before a dangerous action and the status line. */
export function roomsWord(count: number): string {
  return countWord(count, 'room')
}

/**
 * The header of long work: one BOLD line, then the child's stream unchanged.
 * Under --dry-run there is exactly one line, and it is not ours, so there is
 * no header.
 */
export function heading(ctx: { dryRun: boolean; ui: Ui }, text: string): void {
  if (!ctx.dryRun) ctx.ui.header(text)
}

/** "no" to the question: DIM "cancelled" and code 4. Said the same way in every group. */
export function cancelled(ui: Ui): number {
  ui.line(ui.dim('cancelled'))
  return 4
}

/** One line from stdin. Separate, so that readline is created only for a question. */
async function readLine(question: string): Promise<string> {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}
