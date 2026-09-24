/**
 * argv parsing, the dispatcher and help.
 *
 * The whole framework lives here: the command groups do not edit it. What it
 * takes on:
 *
 *   · the global flags --help --dry-run --yes --json --no-color --version,
 *     from anywhere in argv;
 *   · the command name is resolved greedily: two tokens first ("env use"),
 *     then one;
 *   · the question before a dangerous action is asked once and here, not in
 *     the commands;
 *   · the hyphenated name of a two-word command ("env-use") leads to the
 *     command itself;
 *   · an unknown word gets a hint: a group or a neighbouring name by
 *     Levenshtein distance.
 */
import { parseArgs } from 'node:util'
import { GROUPS, registry, type Command, type Ctx } from './registry.js'
import { createEnv, createIo, isDistribution, type Io } from './env.js'
import { createSh, type Runner } from './sh.js'
import {
  cancelled,
  colorAllowed,
  createUi,
  PreconditionError,
  roomsWord,
  UsageError,
} from './ui.js'

export type Deps = {
  io?: Io
  out?: (text: string) => void
  err?: (text: string) => void
  /** A stand-in executor: while it is in place, not a single process is started. */
  runner?: Runner | null
  tty?: boolean
  /** Stand-in answers to the questions. */
  ask?: (question: string) => Promise<string>
  processEnv?: NodeJS.ProcessEnv
  /** The whole registry, for tests. */
  commands?: Command[]
  root?: string
  /** The state directory. Not named, it coincides with root, as in the repository. */
  home?: string
  cwd?: string
  /** Treat the application as installed: otherwise the marker is looked up at the root. */
  dist?: boolean
}

const GLOBAL_FLAGS = new Set([
  '--help',
  '-h',
  '--dry-run',
  '--yes',
  '-y',
  '--json',
  '--no-color',
  '--version',
  '-V',
])

export async function cli(argv: string[], deps: Deps = {}): Promise<number> {
  const processEnv = deps.processEnv ?? process.env
  const commands = deps.commands ?? registry
  const io = deps.io ?? createIo()
  const tty = deps.tty ?? Boolean(process.stdout.isTTY && process.stdin.isTTY)

  // The global flags, from anywhere. Everything after `--` is untouchable.
  const globals = {
    help: false,
    dryRun: false,
    yes: false,
    json: false,
    noColor: false,
    version: false,
  }
  const tokens: string[] = []
  let raw = false
  for (const token of argv) {
    if (raw) {
      tokens.push(token)
      continue
    }
    if (token === '--') {
      raw = true
      tokens.push(token)
      continue
    }
    if (!GLOBAL_FLAGS.has(token)) {
      tokens.push(token)
      continue
    }
    if (token === '--help' || token === '-h') globals.help = true
    else if (token === '--dry-run') globals.dryRun = true
    else if (token === '--yes' || token === '-y') globals.yes = true
    else if (token === '--json') globals.json = true
    else if (token === '--no-color') globals.noColor = true
    else globals.version = true
  }

  const color = globals.noColor ? false : colorAllowed(processEnv, Boolean(process.stdout.isTTY))
  const ui = createUi({
    color,
    json: globals.json,
    out: deps.out,
    err: deps.err,
    tty,
    ask: deps.ask,
  })
  const env = createEnv({ io, root: deps.root, home: deps.home, cwd: deps.cwd, processEnv })
  const sh = createSh({
    root: env.root(),
    ui,
    dryRun: globals.dryRun,
    runner: deps.runner ?? null,
  })

  let roomsCache: Promise<number> | null = null

  const ctx: Ctx = {
    positionals: [],
    values: {},
    dryRun: globals.dryRun,
    yes: globals.yes,
    json: globals.json,
    sh,
    ui,
    env,
    io,
    dist: deps.dist ?? isDistribution(),
    rooms() {
      roomsCache ??= countRooms()
      return roomsCache
    },
    async confirm(question) {
      if (globals.yes || globals.dryRun) return true
      return await ui.confirm(await withRooms(question))
    },
  }

  /**
   * How many CLASSES are holding Python now, not how many containers.
   *
   * One class has two of them: its own and the one where the students'
   * personal notebooks are computed. Counting lines would mean warning "2
   * rooms will stop" where a single class is going on, and a person reads this
   * number right before agreeing to stop the server.
   */
  async function countRooms(): Promise<number> {
    const result = await sh.capture(
      'docker',
      ['ps', '--filter', 'label=colloq.kind=room-kernel', '--format', '{{.Label "colloq.session"}}'],
      { timeoutMs: 4000 },
    )
    if (result.code !== 0) return 0
    const rooms = new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
    return rooms.size
  }

  /** The question with a note about rooms: the number does not forbid the action, it only refines it. */
  async function withRooms(question: string): Promise<string> {
    const count = await ctx.rooms()
    return count > 0 ? question + ' ' + roomsPhrase(count) : question
  }

  try {
    if (globals.version) {
      ui.line(version(io, env.path('cli/package.json')))
      return 0
    }

    // A bare call starts nothing: the package is installed long before class,
    // and the first acquaintance should be a line of "what I can do", not a
    // suddenly taken port and an opened browser. A class starts with a word,
    // `colloq start`, like `jupyter lab`.
    if (tokens.length === 0) {
      if (globals.help) renderHelp(ui, commands, env.kernelEnv())
      else renderIntro(ui)
      return 0
    }

    return await dispatch(tokens)
  } catch (error) {
    return fail(error)
  }

  function fail(error: unknown): number {
    if (error instanceof UsageError) return report(2, error.message, error.fix, error.why)
    if (error instanceof PreconditionError) return report(3, error.message, error.fix, error.why)
    const message = error instanceof Error ? error.message : String(error)
    return report(1, message, 'colloq help')
  }

  /** A refusal in three lines, and in --json mode with the same code and not a line outside JSON. */
  function report(code: number, what: string, fix: string, why = ''): number {
    if (globals.json) {
      ui.json({ ok: false, code, error: what + (why ? '. ' + why : ''), hint: fix })
      return code
    }
    ui.refuse(what, why, fix)
    return code
  }

  async function dispatch(input: string[]): Promise<number> {
    const head = input.filter((token) => !token.startsWith('-'))
    const first = head[0] ?? ''

    if (first === 'help') {
      const wanted = head[1]
      if (wanted) {
        const target = find(commands, wanted) ?? find(commands, head.slice(1, 3).join(' '))
        if (!target) return unknown(wanted)
        renderCommandHelp(ui, target, env)
        return 0
      }
      renderHelp(ui, commands, env.kernelEnv())
      return 0
    }

    // Greedily: two tokens first, then one.
    const two = head.length > 1 ? first + ' ' + head[1] : ''
    const found = (two ? find(commands, two) : undefined) ?? find(commands, first)
    if (!found) {
      // The hyphenated twin of a two-word name is the same command: `env-use`
      // is `env use`.
      const twin = first.includes('-') ? find(commands, first.replaceAll('-', ' ')) : undefined
      if (twin) return await dispatch(respell(input, first, twin.name))
      // --help must not execute a single unknown word.
      if (globals.help) {
        renderHelp(ui, commands, env.kernelEnv())
        return 2
      }
      return unknown(first)
    }

    // How many tokens the name ate: two only if it was called by exactly the
    // two-word name or a two-word alias. A one-word alias of a two-word command
    // (`colloq env` = `env list`) eats one, otherwise the flag value after it
    // would go missing: `colloq env --json`.
    const matchedTwo = Boolean(two) && (found.name === two || (found.aliases ?? []).includes(two))
    const used = matchedTwo ? 2 : 1
    // The tail: everything except the tokens eaten by the command name.
    const tail = dropCommandTokens(input, used)

    if (globals.help) {
      renderCommandHelp(ui, found, env)
      return 0
    }

    if (globals.json && !found.flags.some((flag) => flag.name === 'json')) {
      const where = commands
        .filter((command) => command.flags.some((flag) => flag.name === 'json'))
        .map((command) => command.name)
      throw new UsageError(
        'command ' + found.name + ' has no --json',
        where.length
          ? '--json works with ' + where.join(', ')
          : 'no command has a machine-readable view',
      )
    }

    const options: Record<
      string,
      { type: 'string' | 'boolean'; short?: string; multiple?: boolean }
    > = {}
    for (const flag of found.flags) {
      options[flag.name] = {
        type: flag.arg ? 'string' : 'boolean',
        ...(flag.short ? { short: flag.short } : {}),
        ...(flag.multiple ? { multiple: true } : {}),
      }
    }

    let parsed: { values: Record<string, unknown>; positionals: string[] }
    try {
      parsed = parseArgs({ args: tail, options, strict: true, allowPositionals: true }) as {
        values: Record<string, unknown>
        positionals: string[]
      }
    } catch (error) {
      throw parseTrouble(error, found)
    }

    ctx.positionals = parsed.positionals
    ctx.values = parsed.values

    const declared = found.args ?? []
    for (let i = 0; i < declared.length; i++) {
      const arg = declared[i]
      if (!arg?.required) continue
      if ((parsed.positionals[i] ?? '').trim() !== '') continue
      throw new UsageError('missing required argument <' + arg.name + '>', 'Usage: ' + found.usage)
    }
    // An extra positional is most often a typo in the command name
    // (`colloq env cv`): silently turning it into another command is worse
    // than refusing.
    if (parsed.positionals.length > declared.length) {
      throw new UsageError(
        'extra argument: ' + (parsed.positionals[declared.length] ?? ''),
        'Usage: ' + found.usage,
      )
    }

    // The argument check comes BEFORE the question: a bad argument never gets
    // a question, and the refusal must not depend on whether there is a
    // terminal.
    if (found.check) await found.check(ctx)

    // The question is asked here and once. confirm:'script' means we stay
    // silent, the script will ask; confirm:'self' means the command itself
    // asks where it needs to.
    if (found.destructive && found.confirm === 'cli' && !globals.yes && !globals.dryRun) {
      const needed = found.confirmWhen ? await found.confirmWhen(ctx) : true
      if (needed) {
        const asked =
          typeof found.confirmQuestion === 'function'
            ? await found.confirmQuestion(ctx)
            : (found.confirmQuestion ?? 'continue?')
        const question = found.rooms === false ? asked : await withRooms(asked)
        if (!(await ui.confirm(question))) return cancelled(ui)
      }
    }

    return await found.run(ctx)
  }

  function unknown(name: string): number {
    // A bare group name is the most natural thing people type after help:
    // showing its commands is more honest than guessing by the letters.
    const inGroup = commands
      .filter((command) => command.name.startsWith(name + ' '))
      .map((command) => command.name)
    if (inGroup.length > 0) {
      return report(
        2,
        name + ' is a group of commands, not a command',
        'colloq ' + inGroup.join(' · colloq '),
        'the group needs a second word',
      )
    }
    const near = nearest(commands, name)
    return report(
      2,
      'no command ' + name,
      near ? 'did you mean colloq ' + near + '?' : 'colloq help — the list of commands',
    )
  }
}

/** The command name tokens are dropped from the tail: the rest goes to parseArgs. */
function dropCommandTokens(input: string[], count: number): string[] {
  const out: string[] = []
  let dropped = 0
  for (const token of input) {
    if (dropped < count && !token.startsWith('-')) {
      dropped++
      continue
    }
    out.push(token)
  }
  return out
}

/** The hyphenated name is rewritten as the two-word one: the tail and the flags stay as they were. */
export function respell(input: string[], from: string, to: string): string[] {
  const out: string[] = []
  let done = false
  for (const token of input) {
    if (!done && token === from) {
      out.push(...to.split(' '))
      done = true
      continue
    }
    out.push(token)
  }
  return out
}

/**
 * The parseArgs refusal in plain words. Node's English text stays only where
 * we have no word of our own: its advice "put it after --" for a typo in a
 * flag is wrong, too.
 */
export function parseTrouble(error: unknown, command: Command): UsageError {
  const message = error instanceof Error ? error.message : String(error)
  const fix = 'colloq ' + command.name + ' --help'
  if ((error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const flag = /'(-[^']+)'/.exec(message)?.[1] ?? ''
    const near = nearestWord(
      command.flags.map((item) => '--' + item.name),
      flag,
    )
    return new UsageError(
      'command ' + command.name + ' has no flag ' + flag,
      near ? 'did you mean ' + near + '? · ' + fix : fix,
    )
  }
  return new UsageError(message, fix)
}

/** A command by name or alias. */
export function find(commands: Command[], name: string): Command | undefined {
  if (!name) return undefined
  return commands.find((command) => command.name === name || (command.aliases ?? []).includes(name))
}

/** The nearest name: Levenshtein distance ≤ 3, one hint. */
export function nearest(commands: Command[], name: string): string | undefined {
  let best: string | undefined
  let bestDistance = 4
  for (const command of commands) {
    for (const candidate of [command.name, ...(command.aliases ?? [])]) {
      const distance = levenshtein(name, candidate)
      if (distance < bestDistance) {
        bestDistance = distance
        best = command.name
      }
    }
  }
  return best
}

/** The same distance over a list of words: for the command's flags. */
export function nearestWord(words: string[], name: string): string | undefined {
  let best: string | undefined
  let bestDistance = 4
  for (const word of words) {
    const distance = levenshtein(name, word)
    if (distance < bestDistance) {
      bestDistance = distance
      best = word
    }
  }
  return best
}

export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, i) => i)
  for (let i = 1; i < rows; i++) {
    const current = [i]
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
    }
    previous = current
  }
  return previous[cols - 1] ?? Math.max(a.length, b.length)
}

/** "3 rooms are running" is only a note to the question. ui counts the word. */
export function roomsPhrase(count: number): string {
  return roomsWord(count) + (count === 1 ? ' is running' : ' are running')
}

function version(io: Io, packagePath: string): string {
  const text = io.readText(packagePath)
  const match = text ? /"version"\s*:\s*"([^"]+)"/.exec(text) : null
  return match?.[1] ?? '0.0.0'
}

/**
 * The short help of a bare call.
 *
 * Four lines and not one extra: what this is, and the three words a class is
 * started with, shown to the class with and ended with. The full list stays
 * behind `colloq help`, as with git and jupyter.
 */
export function renderIntro(ui: ReturnType<typeof createUi>): void {
  ui.line(ui.bold('colloq') + ' — a class on this computer: notebooks, a Python kernel and a board')
  ui.line()
  ui.table([
    [ui.cyan('colloq start'), 'start the class and open the browser'],
    [ui.cyan('colloq host <name>'), 'publish it and give the room a link'],
    [ui.cyan('colloq stop'), 'end the class'],
  ])
  ui.line()
  ui.line(ui.dim('More: colloq help · one command: colloq <command> --help'))
}

/** The list of commands by group. */
export function renderHelp(
  ui: ReturnType<typeof createUi>,
  commands: Command[],
  kernelEnv: string,
): void {
  for (const group of GROUPS) {
    const inGroup = commands.filter((command) => command.group === group.name)
    if (inGroup.length === 0) continue
    ui.header(group.title)
    for (const command of inGroup) {
      ui.line('  ' + ui.cyan(command.name.padEnd(18)) + command.summary)
    }
    ui.line()
  }
  ui.line(ui.dim('Most used: colloq start · colloq host <name> · colloq status · colloq stop'))
  ui.line(ui.dim('Everywhere: --dry-run — show what would run and do nothing · --yes — do not ask'))
  ui.line(ui.dim('Kernel environment now: ' + kernelEnv))
  ui.line(ui.dim('In detail: colloq <command> --help'))
}

/** Help for one command: purpose, usage, arguments, flags, two examples. */
export function renderCommandHelp(
  ui: ReturnType<typeof createUi>,
  command: Command,
  env: ReturnType<typeof createEnv>,
): void {
  const domain = env.relay().domain || 'class.example.org'
  const kernel = env.kernelEnv() || 'base'
  const fill = (text: string): string =>
    text.replaceAll('{domain}', domain).replaceAll('{env}', kernel)

  ui.line(command.summary)
  ui.line('Usage: ' + ui.cyan(command.usage))
  if (command.args?.length) {
    ui.line()
    ui.header('Arguments')
    // Required ones in angle brackets, optional ones in square brackets, as in usage.
    ui.table(
      command.args.map((arg) => [
        arg.required ? '<' + arg.name + '>' : '[' + arg.name + ']',
        arg.summary,
      ]),
    )
  }
  ui.line()
  ui.header('Flags')
  ui.table([
    ...command.flags.map((flag) => [
      (flag.short ? '-' + flag.short + ', ' : '') +
        '--' +
        flag.name +
        (flag.arg ? ' <' + flag.arg + '>' : ''),
      flag.summary,
    ]),
    // The common flags are appended here, not in the usage of every command:
    // otherwise some groups list them and others do not, and help reads like
    // five different ones.
    ...globalFlagRows(command),
  ])
  const examples = (command.examples?.length ? command.examples : [command.usage]).map(fill)
  const shown =
    examples.length >= 2
      ? examples.slice(0, 2)
      : [examples[0] ?? '', fill(command.usage) + ' --dry-run']
  ui.line()
  ui.header('Examples')
  ui.table(shown.map((example) => [ui.cyan(example)]))
  if (command.notes) {
    ui.line()
    ui.line(ui.dim(command.notes))
  }
  ui.line()
  ui.line(ui.dim('delegates: ' + command.delegates))
}

/** The common flags that really apply to this command. */
function globalFlagRows(command: Command): string[][] {
  const rows: string[][] = [['--dry-run', 'Show what would run and do nothing']]
  if (command.destructive) rows.push(['-y, --yes', 'Agree in advance, no question will be asked'])
  rows.push(['--no-color', 'No colour: the same output without a single escape'])
  rows.push(['-h, --help', 'This page'])
  return rows
}

// Starting from the sources: `node --import tsx cli/src/main.ts`. The wheel has
// its own entry point, cli/src/bin.ts.
const entry = process.argv[1] ?? ''
if (entry.endsWith('/cli/src/main.ts') || entry.endsWith('/cli/src/main.js')) {
  // Without a child, Node's ordinary SIGINT applies. While a child runs, sh
  // forwards the signal itself and waits for the child: an early process.exit
  // here left it running.
  const code = await cli(process.argv.slice(2))
  process.exitCode = code
}
