/**
 * Kernel environments: which Python and which packages a class sees.
 *
 * Four commands: env list, env show, env new, env use. All four work with the
 * same files (they read and write through ctx.io) and start not a single
 * process. The env-* targets in the Makefile do the same thing, but there is
 * no way to call them from here: the CLI travels in the pip wheel together
 * with the application, and the Makefile does not travel into the wheel. The
 * commands must match them in the layout of the files and in the screen, not
 * by calling them.
 *
 * Nobody builds the environment image here, and that is a decision, not a
 * gap. colloq start builds it, before the class (launch-prepare.ts ·
 * prepare): that is where the `# colloq: from` chain, the source fingerprint,
 * merging two directories into one docker context and the progress in
 * .colloq.log live. A second build from here would turn out to be a third
 * copy next to the start and the panel (server/src/environments.ts ·
 * buildCommand), and three copies drift apart on the very first edit of the
 * Dockerfile. So `env use` only rewrites KERNEL_ENV, and honestly warns in
 * words about the price, minutes of building.
 *
 * WHERE THE ENVIRONMENTS LIE is the main decision of the group, and it is
 * this.
 *
 *   · The ones shipped with the product (base, base-gpu, cv, gpu) are in
 *     <app>/kernel/environments and are only read: for an installed colloq
 *     that is site-packages, and it cannot be written to in any sense (see
 *     env.ts · ownEnvDir).
 *   · One's own are in <home>/environments, next to .env and data/. In the
 *     repository that is the very same kernel/environments, and nothing
 *     changes there.
 *   · The list is the union of the two directories; one's own name overrides
 *     a shipped one, because redefining cv for one's course is a legitimate
 *     wish.
 *
 * Exactly one function turns a name into a path, envFile(); everything else
 * calls it. A second answer to the question "where does cv lie" would split
 * the list from the view, and the view from what the start then builds, and
 * silently at that.
 *
 * node:child_process and node:fs must not be imported: only ctx.io, and
 * ctx.sh for the sake of one --dry-run line.
 */
import type { Command, Ctx } from '../registry.js'
import { joinPath, type Io } from '../env.js'
import { localClassEnv } from '../launch-config.js'
import { countWord, PreconditionError, UsageError } from '../ui.js'
import { PYTHON_VERSIONS } from '../../../shared/admin.js'

/** The ceiling of the `# colloq: from` chain: the same as the Makefile build has. */
const CHAIN_LIMIT = 8

/** The two header directives. For pip they are comments, for us they are structure. */
const FROM = /^[ \t]*#[ \t]*colloq:[ \t]*from[ \t]+([^\s]+)[ \t]*$/m
const PYTHON = /^[ \t]*#[ \t]*colloq:[ \t]*python[ \t]+(3\.[0-9]+)[ \t]*$/m

/** The environment name: both the file and the colloq-kernel:<name> image tag are called by it. */
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** A line that is not visible in the package list: a comment, empty, a pip option. */
const NOT_A_PACKAGE = /^[ \t]*(#|-|$)/

/** A comment and an empty line: what the env-show target hides too. */
const NOT_A_LINE = /^[ \t]*(#|$)/

/** The two directories of environments: the one shipped with the product and one's own. */
type Dirs = { app: string; own: string }

function envDirs(ctx: Ctx): Dirs {
  return { app: ctx.env.paths.envDir, own: ctx.env.paths.ownEnvDir }
}

/**
 * An environment name to a file path: the only place where this is decided.
 *
 * One's own overrides a shipped one: if <home>/environments/cv.txt exists,
 * from then on everything (the view, the Python version, the package count,
 * the build) works with it, not with the cv that arrived in the package. The
 * reverse order would mean one could create an environment of one's own with
 * a taken name but not use it.
 *
 * In the repository both directories are the same path, and the choice comes
 * to nothing: the resulting string is the very same.
 */
export function envFileIn(io: Io, dirs: Dirs, name: string): string {
  const own = joinPath(dirs.own, name + '.txt')
  return io.exists(own) ? own : joinPath(dirs.app, name + '.txt')
}

/** The names of all environments: the union of the two directories, without repeats. */
export function listEnvNames(io: Io, dirs: Dirs): string[] {
  const names = new Set<string>()
  // A Set, not two lists in a row: in the repository the directories coincide,
  // and without it every environment would be printed twice.
  for (const dir of [dirs.app, dirs.own]) {
    for (const file of io.list(dir)) {
      if (file.endsWith('.txt')) names.add(file.slice(0, -'.txt'.length))
    }
  }
  return [...names].sort()
}

function envFile(ctx: Ctx, name: string): string {
  return envFileIn(ctx.io, envDirs(ctx), name)
}

/** Where `env new` writes: always one's own directory, whatever lies in the shipped one. */
function ownFile(ctx: Ctx, name: string): string {
  return joinPath(ctx.env.paths.ownEnvDir, name + '.txt')
}

/** Whether this is one's own environment, that is, whether it lies in the directory we write to. */
function isOwn(ctx: Ctx, name: string): boolean {
  const dirs = envDirs(ctx)
  if (dirs.own === dirs.app) return false
  return ctx.io.exists(ownFile(ctx, name))
}

/**
 * A shorter path: from the application root, the way the Makefile prints it;
 * from the person's home, with a tilde. For an installed colloq both
 * directories are absolute and long, and in full they do not fit into the
 * line about an environment.
 */
function short(ctx: Ctx, path: string): string {
  const root = ctx.env.root() + '/'
  if (path.startsWith(root)) return path.slice(root.length)
  const home = ctx.env.home()
  if (home && path.startsWith(home + '/')) return '~' + path.slice(home.length)
  return path
}

/** Where to look for environments, in one line for the list header. */
function places(ctx: Ctx): string {
  const dirs = envDirs(ctx)
  const app = short(ctx, dirs.app) + '/'
  return dirs.own === dirs.app ? app : app + ' and ' + short(ctx, dirs.own) + '/'
}

function textOf(ctx: Ctx, path: string): string | null {
  const text = ctx.io.readText(path)
  return text === null ? null : text.replace(/\r/g, '')
}

/** The environment name from the first positional, straight through the name sieve. */
function wantName(ctx: Ctx, usage: string): string {
  const name = (ctx.positionals[0] ?? '').trim()
  if (!name) throw new UsageError('no environment given', 'Usage: ' + usage)
  checkName(name)
  return name
}

function checkName(name: string): void {
  if (NAME.test(name)) return
  throw new UsageError(
    '"' + name + '" cannot be an environment name: lowercase latin letters, digits and a hyphen',
    'colloq env list: which ones already exist',
  )
}

/** No environment file: refuse here, before questions and before writing. */
function needFile(ctx: Ctx, name: string, fix: string): void {
  if (ctx.io.exists(envFile(ctx, name))) return
  throw new PreconditionError(
    'no ' + short(ctx, envFile(ctx, name)) + ': environment "' + name + '" has not been created',
    fix,
  )
}

/**
 * The versions the kernel builds on at all: the same ones the panel offers.
 *
 * As a value from an import, not by parsing the text of shared/admin.ts, as
 * it was done here before. That file was looked up from the APPLICATION root,
 * and a distribution has no shared/ directory at all (scripts/pack.mts ships
 * server/dist, web/dist, server/assets and kernel/*): for an installed colloq
 * the list always came out empty, and the check in wantPython was silently
 * switched off along with it: `colloq env new ml --python 3.99` went through
 * without a refusal and wrote "# colloq: python 3.99" into the header, and env
 * list and env show then showed it as the version of an environment that will
 * not build. esbuild bakes the import into the bundle, so there is nothing
 * left to read on the machine, and nothing to drift apart from the panel
 * either.
 *
 * readonly string[], not the tuple itself: with `as const` the argument type
 * of includes() is a literal from the list, and we need to ask about an
 * arbitrary string from a person.
 */
const PYTHONS: readonly string[] = PYTHON_VERSIONS

/** The Python version from --python; empty means the default. */
function wantPython(ctx: Ctx): string | undefined {
  const value = ((ctx.values.python as string | undefined) ?? '').trim()
  if (!value) return undefined
  if (!PYTHONS.includes(value)) {
    throw new UsageError(
      'Python ' + value + ' is not one of those the kernel builds on',
      'available: ' + PYTHONS.join(' '),
    )
  }
  return value
}

/** The default comes from kernel/Dockerfile itself, not from a second list. */
function defaultPython(ctx: Ctx): string {
  const text = textOf(ctx, ctx.env.path('kernel/Dockerfile')) ?? ''
  return /^ARG PARENT=python:([0-9]+\.[0-9]+)-/m.exec(text)?.[1] ?? '3.11'
}

/**
 * The `# colloq: from` inheritance chain, from the root to the named
 * environment, and the trouble if the chain is unfit.
 *
 * The trouble is returned, not thrown, because the chain has two readers with
 * different attitudes to it. For the list, showing the list matters more: one
 * environment that references itself must not blank the whole screen, so it
 * takes what could be read and stays silent. For the view and the switch,
 * telling the truth matters more: there is no way to build such an
 * environment anyway, and it is better to learn about it now than at colloq
 * start before class, when the build falls over.
 *
 * The measures are exactly the same as in the build at start
 * (launch-config.ts · kernelInputs) and in the env-build target in the
 * Makefile: a loop, a ceiling of eight links, a name that is not a name, a
 * missing parent. Our own implementation rather than a call of kernelInputs,
 * for two reasons: that one goes to the real file system bypassing ctx.io
 * (the group's tests have none) and knows one directory of environments out
 * of two.
 */
type Chain = { names: string[]; trouble?: string }

function chainOf(io: Io, dirs: Dirs, name: string): Chain {
  const names: string[] = []
  let current: string | undefined = name
  while (current) {
    const file = envFileIn(io, dirs, current)
    if (names.includes(current)) {
      return { names, trouble: 'environments reference each other in a circle: ' + current }
    }
    if (!NAME.test(current)) {
      return {
        names,
        trouble: '"' + current + '" cannot be an environment name: neither a file nor an image tag',
      }
    }
    const text = io.readText(file)
    if (text === null) {
      return {
        names,
        trouble:
          names.length === 0
            ? 'environment "' + current + '" has not been created'
            : 'environment "' + current + '" is named as a parent, and it does not exist',
      }
    }
    // unshift, not push: first in the list stands the root of the chain, the
    // one the build starts from and whose interpreter everyone below gets.
    names.unshift(current)
    if (names.length > CHAIN_LIMIT) {
      return { names, trouble: 'the environment chain is longer than eight links' }
    }
    current = FROM.exec(text.replace(/\r/g, ''))?.[1]
  }
  return { names }
}

/**
 * Which Python the environment will run on. The ROOT of the chain sets the
 * version: it comes from the base image, and a layer on top of a ready image
 * does not change the interpreter.
 */
function pythonOf(ctx: Ctx, name: string, fallback: string): string {
  const root = chainOf(ctx.io, envDirs(ctx), name).names[0]
  if (root === undefined) return fallback
  const text = textOf(ctx, envFile(ctx, root))
  return (text === null ? undefined : PYTHON.exec(text)?.[1]) ?? fallback
}

/** The chain or a refusal: for those who have nowhere to go with an unfit chain. */
function needChain(ctx: Ctx, name: string, fix: string): Chain {
  const chain = chainOf(ctx.io, envDirs(ctx), name)
  if (chain.trouble) throw new PreconditionError(chain.trouble, fix)
  return chain
}

/** How many packages on top of the base, by the same rule as the env-list target. */
function packagesOf(text: string): number {
  return text.split('\n').filter((line) => !NOT_A_PACKAGE.test(line)).length
}

/** The lines of the file the person wrote in themselves: without comments and empty ones. */
function meaningful(text: string): string[] {
  return text.split('\n').filter((line) => !NOT_A_LINE.test(line))
}

/** The header of a new environment: line for line the one the env-new target writes, only in English. */
function starter(name: string, python: string | undefined, fallback: string): string {
  const lines: string[] = []
  /*
   * The version goes in as a directive in the header, and only if what was
   * asked for is NOT the default.
   *
   * A file without the line and a file with a line about the default mean the
   * same thing today, but different things tomorrow: the default lives in ARG
   * PARENT of kernel/Dockerfile itself, and when it is raised one day, the
   * written line will become a lie nobody asked for. An unwritten one will
   * simply agree.
   */
  if (python && python !== fallback) lines.push('# colloq: python ' + python, '#')
  lines.push(
    '# Environment "' + name + '". It is installed on top of the base from',
    '# kernel/requirements.txt, so numpy/pandas/matplotlib/scikit-learn need no line here.',
    '#',
    '# One package per line, as in an ordinary requirements.txt:',
    '#',
    '#   transformers>=4.44',
    '#   datasets>=2.20',
    '',
  )
  return lines.join('\n')
}

/**
 * Pour KERNEL_ENV into .env without touching the other lines.
 *
 * The content is rewritten into the existing file rather than a new one being
 * put on top: the same reason as in the Makefile and in scripts/host.sh. On
 * Linux, where docker asks for sudo, moving the file from /tmp carried along
 * with it the root owner and 0600 permissions, and the next start by the
 * person could not read their own .env: the instance came up with the
 * defaults, that is, with someone else's kernel token and localhost in the
 * links for the audience. Writing to the same path leaves the owner and the
 * permissions as they were.
 */
function writeKernelEnv(ctx: Ctx, name: string): void {
  /*
   * The file does not exist yet, so it is created here, whole.
   *
   * A "KERNEL_ENV=…" line in an empty place would look harmless, but it is the
   * .env: from then on `colloq start` sees the file in place and does not
   * write its own (launch.ts creates it ONLY when there is no file). The class
   * came up with the defaults, that is, with the well-known JUPYTER_TOKEN from
   * .env.example, and the server honestly complained about it in the log.
   * Caught live: `colloq env use` from the wheel before the first `colloq
   * start`.
   *
   * So the basis is the very same text the start would have written
   * (launch-config.ts · localClassEnv): one file for both, and nowhere for
   * them to diverge. Permissions 0600 for the same reason as there: the
   * sign-in keys are inside.
   */
  const existing = ctx.io.readText(ctx.env.paths.envFile)
  const text = existing ?? localClassEnv(ctx.dist)
  const kept = text.split('\n').filter((line) => !/^KERNEL_ENV=/.test(line))
  while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '') kept.pop()
  kept.push('KERNEL_ENV=' + name, '')
  ctx.io.writeText(ctx.env.paths.envFile, kept.join('\n'), existing === null ? 0o600 : undefined)
}

/** The `env list` screen: the same one the env-list target prints, down to the column width. */
function renderList(ctx: Ctx): void {
  const current = ctx.env.kernelEnv()
  const fallback = defaultPython(ctx)
  const names = listEnvNames(ctx.io, envDirs(ctx))
  ctx.ui.line(ctx.ui.bold('Environments') + ' ' + ctx.ui.dim('(' + places(ctx) + ')'))
  ctx.ui.line()
  if (names.length === 0) {
    ctx.ui.line('  ' + ctx.ui.dim('no environment files: create one with colloq env new <name>'))
    return
  }
  // The 14-character column comes from the Makefile (%-14s); a long name widens
  // it rather than breaking the line.
  const width = Math.max(14, ...names.map((name) => name.length))
  for (const name of names) {
    const text = textOf(ctx, envFile(ctx, name)) ?? ''
    const tail =
      'Python ' +
      pythonOf(ctx, name, fallback) +
      ' · ' +
      countWord(packagesOf(text), 'package') +
      ' on top of the base' +
      (isOwn(ctx, name) ? ' · your own' : '')
    ctx.ui.line(
      '  ' + (name === current ? '*' : ' ') + ' ' + name.padEnd(width) + ' ' + ctx.ui.dim(tail),
    )
  }
  ctx.ui.line()
  ctx.ui.line(ctx.ui.dim('* — the default for new classes. Change it: colloq env use <name>'))
}

/** The `env show` screen: the same as the env-show target prints, but about any environment. */
function renderShow(ctx: Ctx, name: string): void {
  const file = envFile(ctx, name)
  const python = pythonOf(ctx, name, defaultPython(ctx))
  ctx.ui.line(ctx.ui.bold(name) + ' ' + ctx.ui.dim('— ' + short(ctx, file) + ' · Python ' + python))
  ctx.ui.line()
  const own = meaningful(textOf(ctx, file) ?? '')
  if (own.length > 0) ctx.ui.table(own.map((line) => [line]))
  else ctx.ui.line('  ' + ctx.ui.dim('nothing on top of the base'))
  ctx.ui.line()
  ctx.ui.line(ctx.ui.dim('Base (always there):'))
  ctx.ui.table(
    meaningful(textOf(ctx, ctx.env.path('kernel/requirements.txt')) ?? '').map((line) => [line]),
  )
}

export const commands: Command[] = [
  {
    name: 'env list',
    aliases: ['env', 'env ls'],
    group: 'env',
    summary: 'Which environments exist',
    usage: 'colloq env list [--json]',
    flags: [
      { name: 'json', summary: 'Machine-readable: name, Python, packages on top of the base' },
    ],
    destructive: false,
    delegates: 'native: reads both environment directories and KERNEL_ENV from .env',
    examples: ['colloq env list', 'colloq env list --json'],
    notes:
      'The star marks the default for new classes: KERNEL_ENV from .env, otherwise base. The Python version comes from the root of the "# colloq: from" chain, which is at most eight links long. "your own" is an environment you created yourself: it lives next to .env and survives an update of the package.',
    async run(ctx) {
      // The intent in one line, both for the person and for --json: they have
      // no reason to differ, and a line written twice drifts apart.
      const intent = 'native: env list (reads ' + places(ctx) + ' and KERNEL_ENV from .env)'
      if (ctx.dryRun) {
        if (!ctx.json) return ctx.sh.dry(intent)
        ctx.ui.json({ ok: true, dryRun: true, command: intent })
        return 0
      }
      if (!ctx.json) {
        renderList(ctx)
        return 0
      }
      const current = ctx.env.kernelEnv()
      const fallback = defaultPython(ctx)
      const dirs = envDirs(ctx)
      ctx.ui.json({
        ok: true,
        current,
        dir: short(ctx, dirs.app),
        ownDir: short(ctx, dirs.own),
        environments: listEnvNames(ctx.io, dirs).map((name) => ({
          name,
          python: pythonOf(ctx, name, fallback),
          packages: packagesOf(textOf(ctx, envFile(ctx, name)) ?? ''),
          current: name === current,
          own: isOwn(ctx, name),
          file: short(ctx, envFile(ctx, name)),
        })),
      })
      return 0
    },
  },

  {
    name: 'env show',
    group: 'env',
    summary: 'What is in an environment and which Python it runs on',
    usage: 'colloq env show [name]',
    args: [{ name: 'name', summary: 'Environment; without a name, the current one' }],
    flags: [],
    destructive: false,
    delegates: 'native: reads <environment>.txt and kernel/requirements.txt',
    examples: ['colloq env show', 'colloq env show {env}'],
    notes:
      'Without a name it shows the current one: what stands in KERNEL_ENV. When there is no such file it refuses. The base packages are listed separately: they are in every environment, and there is no need to repeat them in your own list.',
    async run(ctx) {
      const asked = (ctx.positionals[0] ?? '').trim() || ctx.env.kernelEnv()
      checkName(asked)
      needFile(ctx, asked, 'colloq env list')
      // An unfit chain means a refusal before the view: a "Python 3.11" line
      // over an environment that references itself looks like an answer, but
      // is not one.
      needChain(ctx, asked, 'colloq env show ' + asked + ': fix the "# colloq: from" line')
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: env show ' +
            asked +
            ' (reads ' +
            short(ctx, envFile(ctx, asked)) +
            ' and kernel/requirements.txt)',
        )
      }
      renderShow(ctx, asked)
      return 0
    },
  },

  {
    name: 'env new',
    group: 'env',
    summary: 'Create an environment',
    usage: 'colloq env new <name> [--python <version>]',
    args: [
      {
        name: 'name',
        summary: 'What to call it: lowercase latin letters, digits, hyphen',
        required: true,
      },
    ],
    flags: [
      {
        name: 'python',
        arg: 'version',
        summary: 'Which Python to build on; otherwise the default',
      },
    ],
    destructive: false,
    delegates: 'native: creates <name>.txt with a header in your own environment directory',
    examples: ['colloq env new cv', 'colloq env new cv --python 3.12'],
    notes:
      'Creates an empty file with a header and does not overwrite an existing one. It is always written into your own directory, next to .env, and not where the package is installed: otherwise the environment would be gone on the first update. A name already taken by a bundled environment is allowed: your file overrides the bundled one. The version comes from PYTHON_VERSIONS in shared/admin.ts, and the "# colloq: python X.Y" line is written only when the version differs from ARG PARENT in kernel/Dockerfile.',
    async run(ctx) {
      const name = wantName(ctx, 'colloq env new <name>')
      const python = wantPython(ctx)
      const file = ownFile(ctx, name)
      if (ctx.io.exists(file)) {
        throw new PreconditionError(
          short(ctx, file) + ' already exists',
          'colloq env show ' + name + ': what is in it now',
        )
      }
      // Overriding is not an error, but not a trifle either: the person must
      // see that cv now means their file, not the one that came with the
      // product.
      const shadows = ctx.io.exists(joinPath(ctx.env.paths.envDir, name + '.txt'))
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: env new ' +
            name +
            ' (creates ' +
            short(ctx, file) +
            ', Python ' +
            (python ?? defaultPython(ctx)) +
            ')',
        )
      }
      ctx.io.writeText(file, starter(name, python, defaultPython(ctx)))
      ctx.ui.line(ctx.ui.bold('created') + ' ' + short(ctx, file))
      if (shadows) {
        ctx.ui.line(ctx.ui.dim('overrides the bundled environment with the same name'))
      }
      ctx.ui.line(
        ctx.ui.dim(
          'Python ' +
            pythonOf(ctx, name, defaultPython(ctx)) +
            ' · write the packages in, then: colloq env use ' +
            name,
        ),
      )
      return 0
    },
  },

  {
    name: 'env use',
    aliases: ['env switch'],
    group: 'env',
    summary: 'Make an environment the default for new classes',
    usage: 'colloq env use <name>',
    args: [{ name: 'name', summary: 'An environment from colloq env list', required: true }],
    flags: [],
    destructive: true,
    confirm: 'cli',
    // The check before the question: no environment or an unfit chain means a
    // refusal, not a question before a refusal. The start will not build an
    // unfit chain either, and learning about it now is cheaper than at colloq
    // start before class.
    check(ctx) {
      const name = wantName(ctx, 'colloq env use <name>')
      needFile(ctx, name, 'colloq env new ' + name)
      needChain(ctx, name, 'fix the "# colloq: from" line in the chain')
    },
    // The question promises exactly what the command will do: one line in
    // .env. There is no build here, so no promise of a long wait either: the
    // command speaks about the minutes of building at colloq start only after
    // the write.
    confirmQuestion: (ctx) =>
      'make environment ' +
      wantName(ctx, 'colloq env use <name>') +
      ' the default for new classes?',
    delegates: 'native: KERNEL_ENV in .env',
    examples: ['colloq env use cv', 'colloq env use {env} --yes'],
    notes:
      'The KERNEL_ENV= line is written into the existing .env instead of a fresh file put on top of it: under sudo the file would stay root:0600, and the next start would bring an instance up with the defaults. Classes that are already open stay on their own environment. The image is not built here: colloq start builds it before the class, together with the rest of the preparation, and the first time that can take minutes.',
    async run(ctx) {
      // check() has already checked the file and the chain, before the question and under --dry-run too.
      const name = wantName(ctx, 'colloq env use <name>')
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: env use ' +
            name +
            ' (KERNEL_ENV=' +
            name +
            ' in ' +
            short(ctx, ctx.env.paths.envFile) +
            ')',
        )
      }
      writeKernelEnv(ctx, name)
      ctx.ui.line(ctx.ui.bold('Default environment for new classes: ' + name))
      ctx.ui.line(
        ctx.ui.dim('the image is built on your next colloq start: this can take minutes'),
      )
      return 0
    },
  },
]
