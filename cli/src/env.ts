/**
 * How the CLI knows where it is and what is around it: the application
 * directory, the state directory, .env, paths.
 *
 * Reading .env is a line-by-line copy of read_env() from scripts/lib.sh,
 * including what it appeared there for: only the edges are trimmed, quotes are
 * removed as a pair, the inside of the value is not touched at all ("RTX 4090"
 * keeps its space). These two readings must not drift apart.
 *
 * The CLI does not read secrets. For JUPYTER_TOKEN, SESSION_SECRET and the
 * rest of SECRET_KEYS there is only has(): whether the line is there or not.
 * read() on such a key throws, and a test guards that, so that the value leaks
 * neither into argv, nor into the --dry-run line, nor into the status output.
 */

import * as fs from 'node:fs'

/*
 * The two roots, the application and the state, are resolved in one place for
 * the whole CLI: launch-state.ts (which also explains why exactly there). Here
 * they are only re-exported, so that the commands call them from here along
 * with the other paths, and no second answer to the question "where is my
 * data" appears.
 */
import { appDir, homeDir, isDistribution, SESSION_FILE } from './launch-state.js'
export { appDir, homeDir, isDistribution }

/**
 * An environment name: word for word the same sieve as in scripts/backup.sh
 * and scripts/restore.sh, letters, digits and a hyphen in the middle. An
 * environment name is a subdirectory of backups/.
 */
export function envNameOk(name: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(name) && !name.startsWith('-') && !name.endsWith('-')
}

/** Keys whose values the CLI never takes into its hands. */
export const SECRET_KEYS = [
  'JUPYTER_TOKEN',
  'SESSION_SECRET',
  'RELAY_TOKEN',
  'CF_TOKEN',
  'VAST_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

/** The only door to the file system for the commands. Paths are absolute. */
export type Io = {
  exists(path: string): boolean
  /** The file's content, or null if it does not exist. */
  readText(path: string): string | null
  /** The modification time in milliseconds, or null. */
  mtime(path: string): number | null
  /** The names in a directory, sorted; no directory means an empty list. */
  list(path: string): string[]
  /** Now, in milliseconds. In tests, a constant number. */
  now(): number
  /**
   * Writing. mode is set only when the file is created, just as with fs: the
   * permissions of an existing file are not touched, and a .env put there by
   * the person stays theirs. It is needed for one case: the .env that holds
   * the sign-in keys.
   */
  writeText(path: string, text: string, mode?: number): void
}

export type Relay = { domain: string; addr: string; port: number }

export type EnvPaths = {
  /**
   * The application directory: web/dist, server/dist, kernel/, scripts/,
   * node_modules.
   *
   * Not "the repository root", as it said here before the roots were split:
   * an installed colloq has no repository at all, but it does have this
   * directory, inside the package. The class state is NEVER put here (see home
   * below): the next `pip install -U` would overwrite it, and on many machines
   * it is not writable anyway.
   */
  root: string
  /**
   * The state directory: .env, .colloq/, .colloq.pid, .colloq.log, data/.
   * In the repository it is the root itself; an installed colloq has its own
   * (homeDir). The paths below that belong to the state are resolved from it.
   */
  home: string
  envFile: string
  /**
   * Who is running the class now: the pid of the supervisor, NOT of the
   * server.
   *
   * The server is its child, and its number lies in the receipt in the
   * serverPid field. Whoever looks for the port listener by this file will find
   * the wrong one and call their own class someone else's.
   */
  pidFile: string
  logFile: string
  /**
   * The receipt of the running class: the port, the address, the pids of the
   * supervisor and of the server.
   *
   * The single source of truth about what is running RIGHT NOW. .env answers
   * another question, what is configured, and `colloq run --port 4100` does
   * not touch it at all.
   */
  sessionFile: string
  /** The package lists that arrived with the product: one environment, one file. */
  envDir: string
  /**
   * The package lists the person created: `colloq env new` writes here and
   * only here. Why there is a second directory is explained at its
   * computation below.
   */
  ownEnvDir: string
  backupsDir: string
  /** The built panel. */
  dist: string
}

export type Env = {
  /** The application directory; see EnvPaths.root. */
  root(): string
  /**
   * A path inside the APPLICATION directory.
   *
   * Only for files that arrived together with the program: cli/launch.mjs,
   * kernel/Dockerfile, web/dist. Everything created on the machine (.env, the
   * log, the receipt, the data, one's own environments) is taken from paths.*,
   * where it is already resolved from the state directory.
   */
  path(...parts: string[]): string
  /** A path from the person's argument: resolved from the directory they called from (COLLOQ_CWD). */
  userPath(path: string): string
  /** A line from .env. Throws on a key from SECRET_KEYS. */
  read(key: string): string
  /** Whether there is a non-empty line with this key. The only thing one may ask about a secret. */
  has(key: string): boolean
  /** PORT, default 3000. */
  port(): number
  /** KERNEL_ENV, default base. */
  kernelEnv(): string
  /** PUBLIC_URL or an empty string. */
  publicUrl(): string
  /** RELAY_DOMAIN / RELAY_ADDR / RELAY_PORT (7000). */
  relay(): Relay
  /** The person's home directory or an empty string: the ssh and cloudflared keys lie there. */
  home(): string
  paths: EnvPaths
  io: Io
}

export type EnvOptions = {
  io?: Io
  /** The root; by default it is searched for upwards from this file. */
  root?: string
  /** The state directory; by default the root, as it always was. */
  home?: string
  /** The directory it was called from (the shim puts it into COLLOQ_CWD). */
  cwd?: string
  /** The process environment variables, for COLLOQ_CWD. */
  processEnv?: NodeJS.ProcessEnv
}

const SEP = '/'

/** Join path parts without node:path: this module does not need it. */
export function joinPath(...parts: string[]): string {
  const segments: string[] = []
  let absolute = false
  for (const part of parts) {
    if (part === '') continue
    if (part.startsWith(SEP)) {
      segments.length = 0
      absolute = true
    }
    for (const piece of part.split(SEP)) {
      if (piece === '' || piece === '.') continue
      if (piece === '..') {
        segments.pop()
        continue
      }
      segments.push(piece)
    }
  }
  return (absolute ? SEP : '') + segments.join(SEP)
}

/**
 * The key's value the way scripts/lib.sh reads it: the last matching line,
 * \r cut off, spaces trimmed only at the edges, paired quotes removed.
 */
export function parseEnvValue(text: string, key: string): string {
  let found = ''
  for (const raw of text.split('\n')) {
    if (!raw.startsWith(key + '=')) continue
    found = raw.slice(key.length + 1)
  }
  let value = found
  if (value.endsWith('\r')) value = value.slice(0, -1)
  value = value.replace(/^[\s]+/, '').replace(/[\s]+$/, '')
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1)
    }
  }
  return value
}

/** The real file system. */
export function createIo(): Io {
  // node:fs lives here and only here: it is forbidden to the commands, they have ctx.io.
  return {
    exists: (path) => fs.existsSync(path),
    readText: (path) => {
      try {
        return fs.readFileSync(path, 'utf8') as string
      } catch {
        return null
      }
    },
    mtime: (path) => {
      try {
        return fs.statSync(path).mtimeMs as number
      } catch {
        return null
      }
    },
    list: (path) => {
      try {
        return (fs.readdirSync(path) as string[]).slice().sort()
      } catch {
        return []
      }
    },
    now: () => Date.now(),
    writeText: (path, text, mode) => {
      const dir = path.slice(0, path.lastIndexOf(SEP))
      if (dir) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path, text, mode === undefined ? undefined : { mode })
    },
  }
}

/** A map of files in memory, for tests. The keys here are absolute paths too. */
export function createMemoryIo(files: Record<string, string> = {}, now = 0): Io {
  const map = new Map<string, string>(Object.entries(files))
  return {
    exists: (path) => map.has(path) || [...map.keys()].some((key) => key.startsWith(path + SEP)),
    readText: (path) => map.get(path) ?? null,
    mtime: (path) => (map.has(path) ? now : null),
    list: (path) => {
      const prefix = path.endsWith(SEP) ? path : path + SEP
      const names = new Set<string>()
      for (const key of map.keys()) {
        if (!key.startsWith(prefix)) continue
        names.add(key.slice(prefix.length).split(SEP)[0] ?? '')
      }
      return [...names].filter(Boolean).sort()
    },
    now: () => now,
    writeText: (path, text) => void map.set(path, text),
  }
}

export function createEnv(opts: EnvOptions = {}): Env {
  const processEnv = opts.processEnv ?? process.env
  const io = opts.io ?? createIo()
  /*
   * The defaults of the roots are the same two answers as the start has
   * (launch-state.ts), and this matters more than it seems: otherwise
   * `colloq run` would write the log in one place and `colloq logs` would read
   * it in another.
   *
   * home takes the root when the root was named explicitly: that is how the
   * tests live, and everything that pins the CLI to its own tree; nothing
   * changes for them.
   */
  const root = opts.root ?? appDir()
  const home = opts.home ?? opts.root ?? homeDir()
  const cwd = opts.cwd ?? processEnv.COLLOQ_CWD ?? root

  const path = (...parts: string[]): string => joinPath(root, ...parts)
  const statePath = (...parts: string[]): string => joinPath(home, ...parts)
  const paths: EnvPaths = {
    root,
    home,
    envFile: statePath('.env'),
    pidFile: statePath('.colloq.pid'),
    logFile: statePath('.colloq.log'),
    envDir: path('kernel/environments'),
    /*
     * The second directory of environments, and it is created exactly where
     * the first one cannot be written to.
     *
     * The environments that arrived with the product (base, base-gpu, cv, gpu)
     * lie in <app>/kernel/environments. For an installed colloq that is
     * site-packages: the directory is overwritten entirely by the next
     * `pip install -U`, and on many machines is not writable at all. Creating
     * one's own environment there means either a permission refusal or losing
     * the file on the very first update.
     *
     * So one's own lives in the state directory, next to .env and data/, where
     * nobody will overwrite it: <home>/environments.
     *
     * In the repository (and in any working tree where home is the
     * application root) the second directory is the FIRST one, the very same
     * path. That is intended: there kernel/environments is both written and
     * read, goes into the `docker build` context, and is seen by the Makefile,
     * launch-config.ts · kernelInputs and the teacher's panel. A new directory
     * next to it would pull the file from under all three, and `colloq env new`
     * in a clone would create an environment the build does not see.
     */
    ownEnvDir: home === root ? path('kernel/environments') : joinPath(home, 'environments'),
    sessionFile: statePath(SESSION_FILE),
    backupsDir: statePath('backups'),
    dist: path('web/dist'),
  }

  const readRaw = (key: string): string => {
    const text = io.readText(paths.envFile)
    if (text === null) return ''
    return parseEnvValue(text, key)
  }

  const env: Env = {
    root: () => root,
    path,
    userPath: (value) => (value.startsWith(SEP) ? value : joinPath(cwd, value)),
    read(key) {
      if ((SECRET_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          'the value of ' + key + ' is not readable: secrets live in .env, the CLI only has has()',
        )
      }
      return readRaw(key)
    },
    has: (key) => readRaw(key) !== '',
    port() {
      const value = Number.parseInt(readRaw('PORT'), 10)
      return Number.isFinite(value) && value > 0 ? value : 3000
    },
    kernelEnv: () => readRaw('KERNEL_ENV') || 'base',
    home: () => processEnv.HOME ?? processEnv.USERPROFILE ?? '',
    publicUrl: () => readRaw('PUBLIC_URL'),
    relay() {
      const port = Number.parseInt(readRaw('RELAY_PORT'), 10)
      return {
        domain: readRaw('RELAY_DOMAIN'),
        addr: readRaw('RELAY_ADDR'),
        port: Number.isFinite(port) && port > 0 ? port : 7000,
      }
    },
    paths,
    io,
  }
  return env
}
