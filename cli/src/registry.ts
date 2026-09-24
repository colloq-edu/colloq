/**
 * What a command is and where to get them.
 *
 * The registry is assembled from four files, one file per group. The order in
 * help is the order of the array inside the group's file.
 *
 * Here is only what the teacher runs a class with after `pip install colloq`:
 * bring it up, expose it to the outside, look, stop, take a backup. The
 * workshop (renting machines, the cluster, the relay, DNS, the build, tests)
 * lives in the Makefile and scripts/, and there is no wrapper over it here.
 */
import type { Env, Io } from './env.js'
import type { Sh } from './sh.js'
import type { Ui } from './ui.js'

import { commands as local } from './commands/local.js'
import { commands as host } from './commands/host.js'
import { commands as env } from './commands/env.js'
import { commands as tools } from './commands/tools.js'

export type Group = 'local' | 'host' | 'env' | 'tools'

/** A command flag. arg is the name of the value; with no arg the flag is boolean. */
export type Flag = {
  name: string
  short?: string
  arg?: string
  summary: string
  multiple?: boolean
}

/** A positional argument, for help. */
export type Arg = { name: string; summary: string; required?: boolean }

export type Ctx = {
  /** Positional arguments after the command name. */
  positionals: string[]
  /** Flag values from parseArgs. */
  values: Record<string, unknown>
  dryRun: boolean
  yes: boolean
  json: boolean
  sh: Sh
  ui: Ui
  env: Env
  io: Io
  /** How many rooms are running now (kernels in docker). Forbids nothing, only refines the question. */
  rooms(): Promise<number>
  /**
   * The application arrived ready-made (a pip wheel) rather than being run
   * from the sources.
   *
   * It decides only one thing: what to call the supervisor with and where to
   * read the built output from, cli/launch.mjs with bare node or
   * cli/src/launch.ts through tsx. The behaviour of the commands does not
   * depend on it. Through ctx, not by looking at the disk on its own: a group
   * module does not look at the file system bypassing ctx.io, otherwise it
   * could not be tested without laying out a real distribution. The framework
   * decides, by a marker at the application root (launch-state.ts ·
   * isDistribution).
   */
  dist: boolean
  /** Ask on its own: --yes and --dry-run answer "yes" silently. */
  confirm(question: string): Promise<boolean>
}

export type Command = {
  name: string
  aliases?: string[]
  group: Group
  /** One line in English: what it does. */
  summary: string
  /** Starts with 'colloq '. */
  usage: string
  args?: Arg[]
  flags: Flag[]
  /** Changes the state of the machine. */
  destructive: boolean
  /**
   * Who asks the question: 'cli' means the framework before run(); 'script'
   * means we do not ask at all, the script will ask; 'self' means the command
   * calls ctx.confirm() where it needs to.
   */
  confirm?: 'cli' | 'script' | 'self'
  confirmWhen?: (ctx: Ctx) => Promise<boolean>
  /** The framework's question. A function when the cost depends on the arguments and flags. */
  confirmQuestion?: string | ((ctx: Ctx) => string | Promise<string>)
  /**
   * The argument check BEFORE the question. Asking "point the name at this
   * address?" only to say "this is not an address" afterwards means asking
   * for nothing; throws UsageError or PreconditionError.
   */
  check?: (ctx: Ctx) => void | Promise<void>
  /**
   * Whether to append the number of running rooms to the question. Rooms are
   * counted on THIS machine: where the writers are on a rented one, the number
   * is misleading.
   */
  rooms?: boolean
  /** What will be executed: `scripts/host.sh`, `native: …`. */
  delegates: string
  /** Examples for --help. {domain} and {env} are filled in from .env. */
  examples?: string[]
  notes?: string
  run(ctx: Ctx): Promise<number>
}

export const GROUPS: { name: Group; title: string }[] = [
  { name: 'local', title: 'Locally' },
  { name: 'host', title: 'Class online' },
  { name: 'env', title: 'Kernel environments' },
  { name: 'tools', title: 'Tools' },
]

export const registry: Command[] = [...local, ...host, ...env, ...tools]
