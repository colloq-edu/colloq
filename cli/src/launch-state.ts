import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { LaunchOptions } from './launch-config.js'

/*
 * ------------------------------------------------------------------ two roots
 *
 * There used to be one root, the repository, and everything lay in it at
 * once: server/dist with web/dist, .env, data/ with the database, and
 * workspace/ with the students' files. While colloq was started from a clone,
 * this was true and cost nothing.
 *
 * `pip install colloq` breaks that truth. The code arrives wherever the
 * installer puts it (site-packages, Cellar, /usr/lib): the directory is
 * overwritten entirely by the next update and on many machines is not
 * writable at all. A class, though, is .env with the sign-in keys, data/ with
 * the database of classes and workspace/ with the notebooks; losing them on
 * `pip install -U` is not an option, and putting them next to the code means
 * losing them one day.
 *
 * So there are two roots, and they are named:
 *   COLLOQ_APP_DIR — the application: server/dist, web/dist, kernel/, node_modules;
 *   COLLOQ_HOME    — the state: .env, .colloq/, .colloq.pid, .colloq.log,
 *                    data/, workspace/.
 *
 * The first rule matters more than the others: in the repository both point
 * at the repository. Development does not change a single step: the same files
 * in the same places, the same tests; the divergence starts only where the
 * application is installed.
 *
 * Why here and not in env.ts, where the other CLI paths live. launch*.ts must
 * be runnable separately from the rest of the CLI:
 * tests/local-launch-process.test.mts assembles a test rig by copying exactly
 * `cli/src/launch*.ts` into it, and an import of env.js from launch.ts would
 * not be found by that rig. There is one implementation, and it lies in a file
 * with the launch prefix; env.ts re-exports it for the commands (env.ts ·
 * appDir/homeDir), so that the CLI does not grow a second answer to the same
 * question.
 */

/** This file's directory: <app>/cli/src in the repository, <app>/cli in the bundle. */
const selfDir = path.dirname(fileURLToPath(import.meta.url))

/** `~` in a variable's value: the shell does not expand it if it was asked to quote. */
function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value
}

/** The repository: a Makefile next to a package.json whose name is colloq. */
function isRepository(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'Makefile'))) return false
    return /"name"\s*:\s*"colloq"/.test(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return false
  }
}

/**
 * A working tree without the marks of the repository: the CLI sources are in
 * place.
 *
 * This is what test rigs look like (a copy of cli/src/launch*.ts in an empty
 * directory, without a Makefile), and a clone whose Makefile was renamed. The
 * state in such a directory stays next to the code, exactly as it always has;
 * moving it into ~/.colloq is worth it only for an installed application,
 * where it would not survive next to the code.
 */
function isWorkingTree(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'cli/src/launch.ts'))
}

/**
 * The marker "this is a ready distribution, not the sources":
 * <app>/.colloq-dist.json.
 *
 * The package builder puts the file there. Everything decided by it is decided
 * the same way: do not compute the fingerprint of the sources, do not call npm
 * and make, do not look for tsx; a distribution has none of these and never
 * will.
 */
export function isDistribution(dir = appDir()): boolean {
  return fs.existsSync(path.join(dir, '.colloq-dist.json'))
}

/**
 * A directory that looks like the application root: the repository, an
 * unpacked distribution or just a built tree.
 *
 * It has to be found by its marks rather than by counting levels: in the
 * repository this code lies in cli/src/launch-state.ts, while in the package
 * the same code arrives as a single bundle cli/launch.mjs (scripts/pack.mts),
 * one level higher. A fixed "two up" would be right in exactly one of the two
 * layouts and would miss the root in the other, and silently at that.
 */
function looksLikeApp(dir: string): boolean {
  if (isRepository(dir) || fs.existsSync(path.join(dir, '.colloq-dist.json'))) return true
  return (
    fs.existsSync(path.join(dir, 'server/dist/server.js')) &&
    fs.existsSync(path.join(dir, 'web/dist'))
  )
}

let appCache: string | undefined
/** The application directory. */
export function appDir(): string {
  if (appCache) return appCache
  const explicit = process.env.COLLOQ_APP_DIR
  if (explicit) return (appCache = path.resolve(expandHome(explicit)))
  for (let dir = selfDir, step = 0; step < 12; step++) {
    if (looksLikeApp(dir)) return (appCache = dir)
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  // The last word goes to the former expression of launch.ts: two levels above cli/src.
  return (appCache = path.resolve(selfDir, '../..'))
}

/** The user's directory for the state, when it has no place next to the code. */
function userStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return xdg && path.isAbsolute(xdg) ? path.join(xdg, 'colloq') : path.join(os.homedir(), '.colloq')
}

function resolveHome(): string {
  // A relative COLLOQ_HOME is resolved from the person's current directory;
  // children (a background start) get it already absolute: launch.ts ·
  // detached.
  const explicit = process.env.COLLOQ_HOME
  if (explicit) return path.resolve(expandHome(explicit))
  const app = appDir()
  if (isRepository(app)) return app
  if (isDistribution(app)) return userStateDir()
  if (isWorkingTree(app)) return app
  return userStateDir()
}

let homeCache: string | undefined
/** The state directory; created on first access. */
export function homeDir(): string {
  if (homeCache) return homeCache
  const home = resolveHome()
  // 0700 applies only on creation: inside are .env with the sign-in keys and data/.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return (homeCache = home)
}

/**
 * The receipt of the running class, as a relative name, one for everybody.
 *
 * The supervisor (launch.ts) writes it; the commands (commands/local.ts,
 * commands/tools.ts) and the framework read it. While the name was written out
 * in each place as its own string, the sides drifted apart silently: the
 * commands looked for the receipt in the APPLICATION directory, the supervisor
 * wrote to the STATE directory, and for an installed colloq `colloq stop`
 * answered "no class is running" while a class was running. The name here is
 * one, and which root it is resolved against is decided by the caller.
 */
export const SESSION_FILE = '.colloq/local-session.json'

export interface LaunchReceipt {
  pid: number
  runId: string
  root: string
  port: number
  url: string
  dataDir: string
  workspaceDir: string
  leaseFile: string
  mode: 'run' | 'dev'
  startedAt: number
  phase: 'preparing' | 'starting' | 'ready' | 'stopping'
  options: LaunchOptions
  serverPid?: number
  hosting?: 'starting' | 'failed'
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}`
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
  try {
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
}
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
export function readReceipt(file: string): LaunchReceipt | null {
  const value = readJson<LaunchReceipt>(file)
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    !['run', 'dev'].includes(value.mode) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !['root', 'url', 'dataDir', 'workspaceDir', 'leaseFile'].every(
      (key) => typeof (value as unknown as Record<string, unknown>)[key] === 'string',
    ) ||
    !value.options ||
    typeof value.options !== 'object'
  )
    return null
  return value
}

/** Reclaim under a separate exclusive guard: two stale-lock readers cannot unlink a new owner. */
export function acquireLock(file: string, pid: number, runId: string, isAlive = alive): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const create = (): void => {
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid, runId }) + '\n')
    } finally {
      fs.closeSync(fd)
    }
  }
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const guard = `${file}.reclaim`
    try {
      fs.mkdirSync(guard, { mode: 0o700 })
    } catch {
      throw new Error('Another run is already checking the local session. Repeat the command.')
    }
    try {
      const prior = readJson<{ pid: number; runId: string }>(file)
      if (!prior || isAlive(prior.pid))
        throw new Error(
          'A local session is already starting or running. Use colloq status / colloq stop.',
        )
      fs.unlinkSync(file)
      create()
    } finally {
      fs.rmdirSync(guard)
    }
  }
  return () => {
    if (readJson<{ runId: string }>(file)?.runId === runId) fs.unlinkSync(file)
  }
}
