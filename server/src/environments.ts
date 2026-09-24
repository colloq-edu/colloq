import { tr } from '@shared/i18n'
import {
  usingRuntimeBroker,
  loadRuntimeCatalog,
  runtimeDefaultEnvironment,
  setRuntimeDefaultEnvironment,
  runtimeEnvironment,
  imageRevision,
} from './kernel/runtime-client.js'
/** Production environments are immutable entries in the operator's release
 * catalog. The selected default is persisted separately and only affects new
 * rooms. File editing and Docker builds below serve local development only. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdminEnvironment, EnvironmentAbilities, EnvironmentState } from '@shared/admin'
import {
  DEFAULT_PYTHON,
  ENVIRONMENT_NAME,
  declaresParent,
  declaresPython,
  pythonImage,
} from '@shared/admin'
/*
 * Header directives are parsed in one place for everyone, in shared/admin.ts.
 *
 * The environment creation form reads `# colloq: from` and `# colloq: python`
 * with the same parser as the build: a second list of regular expressions
 * would drift away from the first at the very first edit, and the panel would
 * show a different version from the one the image gets built on. The
 * re-export lets the neighbours in this file (declaresGpu, buildChain) read as
 * one family, which is what they are.
 */
export { declaresParent, declaresPython }

const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * The repository, found by walking up until the kernel directory appears.
 *
 * Not a constant number of `..`: this file is imported from `server/src` in
 * development and from `server/dist` in a container, and those are different
 * depths. Looking for the thing we actually need is stable under both.
 */
function findRepoRoot(): string {
  let dir = here
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'kernel', 'environments'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.resolve(here, '../..')
}

const ROOT = findRepoRoot()
/**
 * The build context: the Dockerfile, requirements.txt and environment lists.
 *
 * A directory, not a file: `docker build` reads it on the CLIENT and hands it
 * to the daemon, so this folder is all the build needs, and the daemon may
 * even be on the host.
 */
const KERNEL_DIR = path.join(ROOT, 'kernel')
export const ENV_DIR = path.join(KERNEL_DIR, 'environments')
/** The repository: compose and .env next to it are host files, not the image's. */
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.yml')

/* ------------------------------------------- two environment directories */

/**
 * This machine's state directory: .env, data/, workspace/ and its own
 * environments.
 *
 * The server does not compute it and cannot: it finds the APPLICATION root by
 * walking up to kernel/environments (findRepoRoot above), while the state of
 * a colloq installed through pip lives somewhere else entirely, ~/.colloq or
 * COLLOQ_HOME. So the directory is PASSED to it in a variable, exactly like
 * DATA_DIR and WORKSPACE_DIR (cli/src/launch-config.ts · launchConfig).
 *
 * No variable means the server was not started by the supervisor: the
 * repository, `make up`, a service. Then there is one environment directory,
 * as there always was, and not a single line below changes its behaviour.
 *
 * Read on every call, not once at import: .env reaches process.env from
 * config.ts (`dotenv/config`), and the order of module evaluation must not
 * decide whether we see the variable. The price is one path.join.
 */
function stateHome(): string | null {
  const named = process.env.COLLOQ_HOME?.trim()
  return named ? path.resolve(named) : null
}

/**
 * Where the panel WRITES environments. The same fork as in the CLI
 * (cli/src/env.ts · ownEnvDir), copied from there word for word: the two must
 * not drift apart, otherwise `colloq env new` creates an environment the
 * panel does not see, and the panel creates one `colloq env list` does not
 * see. That is exactly what happened.
 *
 * For an installed colloq, <app>/kernel/environments is site-packages: the
 * whole directory is overwritten by the next `pip install -U`, and on many
 * machines it is not writable at all. So our own environments live in the
 * state directory, next to .env and data/, where nobody will overwrite them.
 *
 * When the state IS the application directory (the repository, a clone, a
 * container under `make up`), the second directory is the FIRST one, the same
 * path: a new directory alongside would pull the file out from under make
 * env-list, `colloq env new` and the `docker build` context.
 */
export function ownEnvDirOf(root: string, home: string | null): string {
  const shipped = path.join(root, 'kernel', 'environments')
  if (home === null || home === path.resolve(root)) return shipped
  return path.join(home, 'environments')
}

function ownEnvDir(): string {
  return ownEnvDirOf(ROOT, stateHome())
}

/**
 * Both directories in order of precedence: our own overrides the shipped one.
 *
 * Overrides, not refuses: a person is entitled to redefine `cv` for their
 * course, and their list must win everywhere: in reading, in the list, in the
 * inheritance chain and in the build context.
 */
function envDirs(): string[] {
  const own = ownEnvDir()
  return own === ENV_DIR ? [ENV_DIR] : [own, ENV_DIR]
}

/* ------------------------------------------------------------- the files */

function checkName(name: string): void {
  // Belt and braces. `name` is validated at the route, and it also decides a
  // path — so it is checked again at the moment it becomes one.
  if (!ENVIRONMENT_NAME.test(name))
    throw new Error(tr('server.badEnvironmentName.cf94f0', { p0: name }))
}

/**
 * Where the file LIVES: first our own directory, then the shipped one.
 *
 * If it is in neither, the shipped path is returned: there is nothing to read
 * there, and "no such environment" is answered by the callers, each in its
 * own way (readSource with an empty string, fromDisk with null).
 */
function findFile(file: string): string {
  const dirs = envDirs()
  return path.join(dirs.find((dir) => fs.existsSync(path.join(dir, file))) ?? ENV_DIR, file)
}

function fileFor(name: string): string {
  checkName(name)
  return findFile(`${name}.txt`)
}

/** Where to WRITE a list: always our own. The app directory is only read. */
function ownFileFor(name: string): string {
  checkName(name)
  return path.join(ownEnvDir(), `${name}.txt`)
}

/**
 * Came with the product and has no copy of our own, so it is not our file.
 *
 * A separate question, because refusing a delete depends on it: an `rm` in
 * site-packages either fails on permissions or deletes a file that the next
 * `pip install -U` brings back. A button that sometimes works is worse than
 * an honest refusal. In the repository there is one directory, our own and
 * the shipped one coincide, and the answer here is always "no", i.e. the
 * behaviour is as before.
 */
export function isShipped(name: string): boolean {
  checkName(name)
  return !fs.existsSync(ownFileFor(name)) && fs.existsSync(path.join(ENV_DIR, `${name}.txt`))
}

/** The `.env` with the KERNEL_ENV line is a STATE file, not an application one. */
function envFile(): string {
  return path.join(stateHome() ?? ROOT, '.env')
}

/**
 * What the package list looked like when the image was last built.
 *
 * Staleness used to be decided by comparing the file's mtime to the image's
 * creation time, and that answers a different question: whether the file was
 * WRITTEN since, not whether it says anything new. Opening the list and saving
 * it unchanged — or the file simply being created later than an image built by
 * `docker compose` — was enough to put "Needs rebuild" on a perfectly current
 * environment, which is exactly how `base` ended up reading "216 MB · built 5
 * days ago" beside a pill saying it was never built.
 *
 * The stamp holds the built list itself, so the comparison is about content.
 * No stamp (an image from before this file existed) falls back to the mtime,
 * which is the old behaviour and the safer guess: better to offer a rebuild
 * nobody needs than to hide one somebody does.
 *
 * The stamp is the state of THIS machine: it is about the image sitting in its
 * docker, not about the product. So it is written into our own directory
 * (ownStampFor), even when the list itself came with colloq: in site-packages
 * it would either be refused on permissions or vanish at the first
 * `pip install -U` together with the whole folder. It is read from both: a
 * stamp left in the application directory by a previous version is the answer
 * to the same question, and losing it means calling for a needless rebuild
 * right before class.
 */
function stampFor(name: string): string {
  checkName(name)
  return findFile(`.${name}.built`)
}

function ownStampFor(name: string): string {
  checkName(name)
  return path.join(ownEnvDir(), `.${name}.built`)
}

/**
 * Did the package list actually change since it was built?
 *
 * Compares what the lists SAY, not how they are written: a comment added, a
 * blank line, trailing whitespace, the same packages in another order — none of
 * those change what pip installs, and none of them should put "Needs rebuild"
 * on a working environment. Exported because this rule is the whole difference
 * between an honest badge and a nagging one, and it is worth pinning.
 */
export function listChanged(stamped: string, current: string): boolean {
  const meaningful = (source: string) =>
    source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .sort()
      .join('\n')
  return meaningful(stamped) !== meaningful(current)
}

/**
 * All environments, as the union of the two directories, one name per line.
 *
 * A Set, not concatenation: our own environment with a shipped one's name is
 * the same environment, redefined, and it gets one line in the panel's list.
 * Previously only the application directory was read, and an environment
 * created by `colloq env new` was not shown at all, even though the panel
 * named exactly that one as active.
 */
export function listNames(): string[] {
  if (usingRuntimeBroker())
    return loadRuntimeCatalog()
      .environments.filter((e) => e.current)
      .map((e) => e.name)
      .sort()
  const names = new Set<string>()
  for (const dir of envDirs()) {
    let files: string[] = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      // Our own directory may not exist at all: no environment was created yet.
      continue
    }
    for (const file of files) {
      const name = file.endsWith('.txt') ? file.slice(0, -4) : ''
      if (name && ENVIRONMENT_NAME.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

export function readSource(name: string): string {
  if (usingRuntimeBroker()) return (runtimeEnvironment(name).packages ?? []).join('\n')
  try {
    return fs.readFileSync(fileFor(name), 'utf8')
  } catch {
    return ''
  }
}

/**
 * The packages a file asks for, as a person would count them.
 *
 * Comments and blank lines are not packages, and neither is a pip directive
 * like `--extra-index-url` — counting those told the room "6 packages" for a
 * file listing five.
 */
export function parsePackages(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('-'))
}

/**
 * Whether this environment needs a GPU slice, by the `# colloq: gpu` directive
 * in the header.
 *
 * The flag lives in the package list itself, not next to the room, because it
 * is a property of the environment: torch wheels are built for CUDA, and "the
 * same thing, only on the CPU" does not exist here. A room on such an
 * environment either gets a slice for the whole lifetime of its container or
 * honestly does not start.
 *
 * To pip this is a comment, so the directive installs nothing, does not change
 * `listChanged` and does not light up "Needs rebuild" on a built image.
 *
 * It is looked for among all comments, not only up to the first package line:
 * a directive a person appended at the end of the file must work, not stay
 * silent. The line is compared whole: the phrase "# colloq: gpu not needed"
 * does not count as the directive.
 */
export function declaresGpu(source: string): boolean {
  return source.split('\n').some((line) => /^#\s*colloq:\s*gpu$/i.test(line.trim()))
}

/** How a list is read: name to text, or null when there is no such environment. */
export type ReadEnvironment = (name: string) => string | null

/**
 * Tells "empty" from "no such thing": readSource returns '' for both, while
 * the build has to refuse an unknown parent, not silently build on the base.
 */
const fromDisk: ReadEnvironment = (name) => {
  try {
    return fs.readFileSync(fileFor(name), 'utf8')
  } catch {
    return null
  }
}

/** No chain is longer than this: beyond it is a typo, not a design. */
export const MAX_INHERITANCE = 8

/**
 * The build order: from the root to the leaf, `['base-gpu', 'gpu']`.
 *
 * Three refusals instead of an endless build, and all three before docker: a
 * loop (a → b → a), a chain longer than MAX_INHERITANCE, and a parent that
 * does not exist. Nine minutes spent only to fail on
 * `COPY environments/no-such.txt` are the same error, just more expensive.
 */
export function buildChain(name: string, read: ReadEnvironment = fromDisk): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current: string | null = name
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(
        tr('server.environmentsReferToEachOtherInA.0d5bfa', {
          p0: [...chain, current].join(' → '),
        }),
      )
    }
    if (!ENVIRONMENT_NAME.test(current)) {
      throw new Error(tr('server.cannotBeAnEnvironmentFilenameOrImage.0ea5d5', { p0: current }))
    }
    const source = read(current)
    if (source === null) {
      throw new Error(
        chain.length === 0
          ? tr('server.environmentDoesNotExist.8a7fc4', { p0: current })
          : tr('server.environmentIsBasedOnWhichDoesNot.3611b2', { p0: chain[0], p1: current }),
      )
    }
    if (chain.length >= MAX_INHERITANCE) {
      throw new Error(
        tr('server.theEnvironmentChainExceedsLevels.8f1ecf', {
          p0: MAX_INHERITANCE,
          p1: chain.join(' → '),
        }),
      )
    }
    seen.add(current)
    chain.unshift(current)
    current = declaresParent(source)
  }
  /*
   * The Python version is chosen by the chain's ROOT, and the fourth refusal
   * is about that.
   *
   * A layer on top of a ready image does not change the interpreter: pip in it
   * installs wheels for the Python that came from the base. A file saying
   * `# colloq: from base-gpu` and `# colloq: python 3.12` promises exactly what
   * the build cannot do, and it would silently build on the parent's version
   * while the panel showed 3.12. The same price as an unknown parent: better to
   * refuse here and name both versions out loud.
   *
   * Repeating the parent's version is not a conflict: it is a redundant line,
   * not a lie.
   */
  const root = chain[0] as string
  const rootPython = declaresPython(read(root) ?? '') ?? DEFAULT_PYTHON
  for (const step of chain.slice(1)) {
    const own = declaresPython(read(step) ?? '')
    if (own !== null && own !== rootPython) {
      throw new Error(
        tr('server.environmentAsksForPythonButTheChain.7b21ac', {
          p0: step,
          p1: own,
          p2: root,
          p3: rootPython,
        }),
      )
    }
  }
  return chain
}

/**
 * Which Python this environment will run on: the chain root's version,
 * otherwise the Dockerfile default.
 *
 * The root's directive, not its own, because the version comes from the base
 * image: `# colloq: python` on a leaf is either a repeat of the root or a lie,
 * and the build rejects the latter (buildChain above). A broken chain does not
 * throw here: the build will say so, while the panel needs to show something,
 * and what it shows is what the file itself asks for.
 */
export function pythonOf(name: string, read: ReadEnvironment = fromDisk): string {
  let root = name
  try {
    root = buildChain(name, read)[0] ?? name
  } catch {
    root = name
  }
  return declaresPython(read(root) ?? '') ?? DEFAULT_PYTHON
}

/**
 * Whether the environment asks for a GPU slice, by its own directive or its
 * parent's.
 *
 * The flag is inherited because its cause is inherited: an image on top of
 * base-gpu carries CUDA wheels, and without the device a room on it fails at
 * the first `.cuda()`. A broken chain does not throw here: the build will say
 * so, and taking the slice away from an environment that asks for it is the
 * worse of the two answers.
 */
export function needsGpu(name: string, read: ReadEnvironment = fromDisk): boolean {
  if (usingRuntimeBroker()) return runtimeEnvironment(name).gpu
  let chain: string[]
  try {
    chain = buildChain(name, read)
  } catch {
    chain = [name]
  }
  return chain.some((step) => declaresGpu(read(step) ?? ''))
}

/**
 * Writes always go to our own directory, never to the application one.
 *
 * That includes editing a shipped environment: the edit lands as our own copy,
 * and reading prefers it (envDirs). Otherwise the panel would write into
 * site-packages: a permission refusal at best, and at worst a file that
 * vanishes at the first `pip install -U` together with the build stamp, and
 * the person will not understand where their list went.
 */
export function writeSource(name: string, source: string): void {
  if (usingRuntimeBroker())
    throw new Error(tr('server.publishedEnvironmentsAreManagedByTheRelease.8ff51e'))
  const file = ownFileFor(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = source.endsWith('\n') ? source : `${source}\n`
  // Temp-file then rename: a half-written requirements file is a build that
  // fails in a way nobody can explain.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Only our own can be deleted.
 *
 * A refusal, not a quiet "nothing happened": an `rm` in the application
 * directory either fails on permissions or removes a file that the next
 * package update brings back, and in both cases the line in the panel does not
 * go away for good. The route asks isShipped first and answers 409; this
 * refusal is for everyone else, so the hole cannot be reached around the
 * route.
 */
export function removeEnvironment(name: string): void {
  if (usingRuntimeBroker())
    throw new Error(tr('server.publishedEnvironmentsAreManagedByTheRelease.8ff51e'))
  if (isShipped(name)) {
    throw new Error(tr('server.shipsWithColloqAndCannotBeDeletedHere.06a8ea', { p0: name }))
  }
  fs.rmSync(ownFileFor(name), { force: true })
  // The stamp goes along with the list: otherwise an environment created anew
  // under the same name would be compared against someone else's build.
  fs.rmSync(ownStampFor(name), { force: true })
}

export function exists(name: string): boolean {
  if (usingRuntimeBroker())
    return loadRuntimeCatalog().environments.some((e) => e.current && e.name === name)
  return fs.existsSync(fileFor(name))
}

/* ------------------------------------------------- which one is running */

/**
 * Which environment counts as the default: the `.env` line, and if there is
 * none, what compose passed to the process as an environment variable.
 *
 * The second is about the container. The app image has no `.env` file and
 * must not have one (it is a host file), so without the fallback, under
 * `make up` the panel always answered "base", and a new seminar was recorded
 * on base while the built kernel was `cv`: a seminar's environment name is
 * the image its container will come up from once the server sees docker.
 */
export function pickActiveName(envFile: string | null, fromEnv: string | undefined): string {
  const line = envFile
    ?.split('\n')
    .reverse()
    .find((l) => l.startsWith('KERNEL_ENV='))
  const value = line?.slice('KERNEL_ENV='.length).trim()
  if (value && ENVIRONMENT_NAME.test(value)) return value
  const forwarded = fromEnv?.trim()
  return forwarded && ENVIRONMENT_NAME.test(forwarded) ? forwarded : 'base'
}

/**
 * `KERNEL_ENV` in `.env` — the same line `make env-use` writes.
 *
 * Read from disk on every call rather than cached: the make targets edit this
 * file too, and a panel that believed a value from process start would show the
 * wrong environment as active for as long as the server ran.
 *
 * The file is taken from the STATE directory (envFile above). For an installed
 * colloq, .env lives in ~/.colloq, not in site-packages: `colloq env use` writes
 * it there, the next start reads it from there, and the panel has to look at
 * the same file, otherwise it names one environment as active while the class
 * comes up on another.
 */
export function activeName(): string {
  if (usingRuntimeBroker()) return runtimeDefaultEnvironment()
  let text: string | null = null
  try {
    text = fs.readFileSync(envFile(), 'utf8')
  } catch {
    text = null
  }
  return pickActiveName(text, process.env.KERNEL_ENV)
}

export function setActiveName(name: string): void {
  if (usingRuntimeBroker()) {
    setRuntimeDefaultEnvironment(name)
    return
  }
  if (!ENVIRONMENT_NAME.test(name))
    throw new Error(tr('server.badEnvironmentName.cf94f0', { p0: name }))
  const file = envFile()
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    /* no .env yet: the file is about to have exactly one line */
  }
  const kept = lines.filter((l) => !l.startsWith('KERNEL_ENV='))
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  kept.push(`KERNEL_ENV=${name}`, '')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, kept.join('\n'), 'utf8')
  fs.renameSync(tmp, file)
}

/* ------------------------------------------------------------- docker */

interface RunResult {
  code: number
  out: string
}

function run(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...extraEnv } })
    let out = ''
    const done = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(done)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(done)
      resolve({ code: code ?? -1, out })
    })
  })
}

/**
 * What this server can do with environments, each ability separately.
 *
 * This used to be one question for both ("is docker-compose.yml next to us"),
 * and under `make up` it turned off both buttons at once: on a rented machine
 * an environment could not be built at all, only over ssh. But the two need
 * DIFFERENT things.
 *
 * Building needs only the docker client and the kernel directory: the client
 * reads the context and hands it to the daemon, so the daemon being on the
 * host does not matter, and `docker build` does not need compose at all.
 *
 * The default is the `KERNEL_ENV` line in the .env next to docker-compose.yml,
 * i.e. a HOST file. Writing it inside the container would be lying to the
 * person: the edit would survive until the first rebuild, while compose keeps
 * reading the file on the host the whole time. So "Make default" stays a
 * command on the host, and the panel says so on exactly the button it
 * concerns.
 *
 * For an installed colloq all of this is the other way round, hence a third
 * question, `home`. There is no repository and no docker-compose.yml there,
 * but there is a .env: it lives in the state directory the supervisor named.
 * `colloq env use` reads and writes that same file, and the next `colloq run`
 * rereads it; no host "outside" exists here, and there is nobody to lie to.
 * Turning off "Make default" in this case would take away the teacher's only
 * way to choose an environment from the panel and send them to make, which
 * they do not have either.
 */
export function abilities(found: {
  docker: boolean
  /** kernel/Dockerfile: the build context is visible from here. */
  context: boolean
  /** docker-compose.yml: the whole repository, and with it .env. */
  repository: boolean
  /** We were given a state directory: its .env is ours and may be written. */
  home: boolean
}): EnvironmentAbilities {
  if (!found.docker) {
    const reason =
      tr('server.dockerIsNotReachableFromTheServer.ffa886') +
      tr('server.andDockerGidTheGroupThatOwns.6ee275') +
      'Environments still list and edit here; switching is `make env-use NAME=<name>`.'
    return {
      canBuild: false,
      cannotBuildReason: reason,
      canSetDefault: false,
      cannotSetDefaultReason: reason,
    }
  }
  return {
    canBuild: found.context,
    cannotBuildReason: found.context
      ? null
      : tr('server.theKernelDirectoryIsNotInThis.3ff129') +
        tr('server.kernelDockerfileAndThePackageListsBeside.7f2949') +
        tr('server.updateItAndRestartOrBuildOn.25c277'),
    canSetDefault: found.repository || found.home,
    cannotSetDefaultReason:
      found.repository || found.home
        ? null
        : tr('server.makingAnEnvironmentTheDefaultWritesKernel.40527e') +
          tr('server.andThatFileIsTheHostS.d583a8') +
          (found.context ? tr('server.buildingAnImageNeedsNeitherAndWorks.0701a2') : ''),
  }
}

/** The same, but after asking docker and looking at what is actually around. */
export async function environmentAbilities(): Promise<EnvironmentAbilities> {
  if (usingRuntimeBroker()) {
    loadRuntimeCatalog()
    return {
      canBuild: false,
      cannotBuildReason: tr('server.imagesArePublishedOutsideTheWebApplication.d2806b'),
      canSetDefault: true,
      cannotSetDefaultReason: null,
    }
  }
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], 8000)
  return abilities({
    docker: version.code === 0,
    context: fs.existsSync(path.join(KERNEL_DIR, 'Dockerfile')),
    repository: fs.existsSync(COMPOSE_FILE),
    // A variable from the supervisor, not a guess from files: it is exactly what
    // says that this installation's .env lies where we can write.
    home: stateHome() !== null,
  })
}

interface ImageFacts {
  bytes: number
  builtAt: number
  /** `3.12.7`, from the image itself; null if it says nothing about Python. */
  python: string | null
}

/**
 * The format string: the image's size, date and variables, one line each.
 *
 * One `docker image inspect`, not two: the list queries EVERY environment on
 * every opening of the screen and on every poll tick during a build, and a
 * second call per row would double that in the same event loop that is
 * running someone else's class.
 */
const IMAGE_FORMAT =
  '{{println .Size}}{{println .Created}}{{range .Config.Env}}{{println .}}{{end}}'

/**
 * What the image tells about itself.
 *
 * The Python version comes from the PYTHON_VERSION variable that the official
 * `python:<version>-slim` writes into the image config, so it can be asked for
 * without starting a container. This is the BUILD's version, not what the file
 * asks for: they diverge exactly when the file was edited after the build, and
 * both have to be shown.
 */
export function parseImageFacts(out: string): ImageFacts | null {
  const [size, created, ...vars] = out.split('\n')
  const bytes = Number(size?.trim())
  const builtAt = Date.parse(created?.trim() ?? '')
  if (!Number.isFinite(bytes) || !Number.isFinite(builtAt)) return null
  const found = vars
    .map((line) => /^PYTHON_VERSION=(\d+\.\d+(?:\.\d+)?)/.exec(line.trim())?.[1])
    .find((value) => value !== undefined)
  return { bytes, builtAt, python: found ?? null }
}

/** Size, build time and Python of `colloq-kernel:<name>`; null when never built. */
async function imageFacts(name: string): Promise<ImageFacts | null> {
  const res = await run(
    'docker',
    ['image', 'inspect', `colloq-kernel:${name}`, '--format', IMAGE_FORMAT],
    8000,
  )
  if (res.code !== 0) return null
  return parseImageFacts(res.out)
}

/* --------------------------------------------------------- build state */

/**
 * Builds happen in the background and their log is watched from the panel, so
 * the last one has to outlive the request that started it.
 */
interface Build {
  name: string
  lines: string[]
  done: boolean
  failed: boolean
  startedAt: number
  listeners: Set<(line: string) => void>
  child: ReturnType<typeof spawn> | null
}

const builds = new Map<string, Build>()
/** A finished failure, kept so the panel can show it after the log scrolls. */
const failures = new Map<string, string>()

export function buildOf(name: string): Build | undefined {
  return builds.get(name)
}

export function isBuilding(name: string): boolean {
  return builds.get(name)?.done === false
}

/** The log so far, so a panel opened mid-build is not left staring at nothing. */
export function buildLog(name: string): { lines: string[]; done: boolean; failed: boolean } | null {
  const build = builds.get(name)
  if (!build) return null
  return { lines: [...build.lines], done: build.done, failed: build.failed }
}

export function watchBuild(name: string, onLine: (line: string) => void): () => void {
  const build = builds.get(name)
  if (!build) return () => {}
  build.listeners.add(onLine)
  return () => build.listeners.delete(onLine)
}

/** How many log lines a build keeps. Enough to see what broke, bounded. */
const LOG_LINES = 400

function push(build: Build, chunk: string): void {
  for (const line of chunk.split('\n')) {
    const text = line.replace(/\r/g, '').trimEnd()
    if (!text) continue
    build.lines.push(text)
    if (build.lines.length > LOG_LINES) build.lines.shift()
    for (const listener of build.listeners) listener(text)
  }
}

/**
 * What to build with: a direct `docker build` or compose over the repository.
 *
 * Compose is needed exactly where it exists, on a machine with the repository:
 * it picks up the dev override, without which the rebuilt shared kernel loses
 * the forwarded 8888. In the app container it is not there and never will be
 * (it is a host file), but the kernel directory is, and that is enough.
 */
export type BuildPlan = { via: 'direct' } | { via: 'compose'; files: string[] }

/**
 * The command for one link of the chain. Both paths produce the same image
 * `colloq-kernel:<name>` from the same Dockerfile; they differ only in who
 * fills in the arguments: compose from its file, or we ourselves.
 *
 * The parent is the PARENT argument: the same Dockerfile builds both the base
 * (on top of python-slim) and a thin layer on top of a ready colloq image. When
 * there is no parent, the argument is not passed at all: the Dockerfile's own
 * default applies, and the base image name stays in one place, not in two that
 * drift apart.
 *
 * `kernel` is the context directory: usually the application's kernel/, and
 * for an installed colloq a merged copy with its own environments
 * (buildContext). The compose path does not accept it and should not: the
 * ./kernel context is written in docker-compose.yml, and that file exists only
 * where there is a single environment directory anyway.
 */
export function buildCommand(
  plan: BuildPlan,
  step: string,
  parentImage: string | null,
  kernel: string = KERNEL_DIR,
): { args: string[]; env: Record<string, string> } {
  // The log is read line by line in the panel, and BuildKit's "pretty" progress
  // redraws itself with carriage returns and turns into mush in a text window.
  const env: Record<string, string> = { DOCKER_BUILDKIT: '1', BUILDKIT_PROGRESS: 'plain' }
  if (plan.via === 'compose') {
    env.KERNEL_ENV = step
    if (parentImage) env.KERNEL_PARENT = parentImage
    return { args: ['compose', ...plan.files, 'build', 'kernel'], env }
  }
  return {
    args: [
      'build',
      '-f',
      path.join(kernel, 'Dockerfile'),
      '--build-arg',
      `KERNEL_ENV=${step}`,
      ...(parentImage ? ['--build-arg', `PARENT=${parentImage}`] : []),
      '-t',
      `colloq-kernel:${step}`,
      kernel,
    ],
    env,
  }
}

/**
 * The `docker build` context when there are two environment directories: a
 * copy of kernel/ with our own lists on top of the shipped ones.
 *
 * Merging, not a fork inside the build itself: the same choice, for the same
 * reason, as on the launch side (cli/src/launch-prepare.ts · kernelRoot): a
 * "this file from there, that one from here" fork would have to be dragged
 * into the inheritance chain, into the COPY inside the Dockerfile and into the
 * docker call itself, and one day one of the three would be forgotten. Here it
 * sits in exactly one place: the context is assembled anew before a build, and
 * from then on everything goes as before, with ONE directory.
 *
 * The directory, though, is our own, and one per name: kernelRoot cleans its
 * place with rmSync once per launch, when there is no server yet at all, while
 * the panel builds several environments at once. Two builds on one directory
 * mean that the second one's cleanup pulls the context out from under the
 * first, and that one fails with "no such file or directory" in the middle of
 * reading. One name is never built twice at the same time (the slot in
 * builds), so cleaning a directory of its own is safe.
 *
 * The directory is not removed after the build: it is small (all of kernel/ is
 * tens of kilobytes), it shows exactly what went into docker, and the next
 * build of the same name overwrites it whole anyway.
 *
 * What is returned is the kernel directory itself, not the root above it:
 * buildCommand expects the folder where the Dockerfile lies.
 */
export function buildContext(name: string): string {
  const home = stateHome()
  if (home === null || ownEnvDir() === ENV_DIR) return KERNEL_DIR
  const staged = path.join(home, '.colloq', 'kernel-context', name)
  fs.rmSync(staged, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(staged), { recursive: true })
  // preserveTimestamps: the copy must be indistinguishable from the original,
  // since the image's freshness is decided by edit time while there is no build
  // stamp yet.
  const keep = { recursive: true, preserveTimestamps: true } as const
  fs.cpSync(KERNEL_DIR, staged, keep)
  const into = path.join(staged, 'environments')
  fs.mkdirSync(into, { recursive: true })
  for (const file of fs.readdirSync(ownEnvDir()))
    if (file.endsWith('.txt')) fs.cpSync(path.join(ownEnvDir(), file), path.join(into, file), keep)
  return staged
}

/**
 * One link of the chain: one build of one environment.
 *
 * Returns whether to go on: a failed link makes the next ones pointless.
 */
function runStage(
  build: Build,
  plan: BuildPlan,
  step: string,
  parentImage: string | null,
  kernel: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const { args, env: vars } = buildCommand(plan, step, parentImage, kernel)
    /*
     * The list is read BEFORE the spawn: this is what goes into the stamp.
     *
     * The stamp exists so that "Needs rebuild" speaks about the content, not
     * about the file's edit time. Reading the list on `close`, it spoke about
     * the content at the WRONG moment: a build with torch takes minutes, in
     * that time the teacher adds `timm` to the same list and saves, the stamp
     * gets the new list, `editedSinceBuild` compares it with the file, they
     * match, and the row shows "Ready" over an image without timm. This comes
     * to light at `import timm` in the middle of class: exactly the lie the
     * stamp exists to prevent.
     *
     * An error is possible here in one direction only: saying "rebuild" where
     * docker had already read the new file. A needless rebuild costs minutes; a
     * false "Ready" costs a class.
     */
    const built = readSource(step)
    const child = spawn('docker', args, {
      cwd: ROOT,
      env: { ...process.env, ...vars },
    })
    build.child = child
    // The log line is something a person can repeat by hand: the variables the
    // build really reads, and the whole command itself.
    const shown = Object.entries(vars)
      .filter(([name]) => name.startsWith('KERNEL_'))
      .map(([name, value]) => `${name}=${value} `)
      .join('')
    push(build, `$ ${shown}docker ${args.join(' ')}`)

    child.stdout.on('data', (d: Buffer) => push(build, d.toString()))
    child.stderr.on('data', (d: Buffer) => push(build, d.toString()))
    // The error of a cancelled build is not overwritten: "cancelled" is an
    // answer, and "build exited null" in its place is a riddle.
    child.on('error', (err) => {
      push(build, String(err))
      if (!build.done) {
        build.failed = true
        failures.set(build.name, String(err))
      }
      resolve(false)
    })
    child.on('close', (code) => {
      if (code === 0) {
        // Remember WHAT was built, so the next comparison is about content.
        // The stamp is about the image in this machine's docker, so it goes to
        // our own directory: see stampFor. The directory may not exist yet: the
        // person has not created environments of their own, only built a
        // shipped one.
        try {
          const stamp = ownStampFor(step)
          fs.mkdirSync(path.dirname(stamp), { recursive: true })
          fs.writeFileSync(stamp, built)
        } catch {
          // No stamp is not a failure: staleness falls back to mtime, as before.
        }
        resolve(true)
        return
      }
      if (!build.done) {
        build.failed = true
        // The last non-empty line is what a person reads first; keeping the whole
        // log for the panel and one line for the row is the difference between
        // "it failed" and "tensorflow==1.15 does not exist".
        failures.set(
          build.name,
          build.lines.filter((l) => /error|ERROR/.test(l)).pop() ??
            tr('server.buildExited.e3b35b', { p0: String(code) }),
        )
      }
      push(build, tr('server.buildFailed.3e3a83', { p0: String(code) }))
      resolve(false)
    })
  })
}

/**
 * What the chain's ROOT stands on: the official python of the version its
 * file asks for.
 *
 * Always passed, not only when the version is not the default, precisely so
 * that the command line in the log names the base image in full: a person
 * reads "what was this built on" there, not in the Dockerfile.
 *
 * KERNEL_PARENT from the server's environment (the shell, or a line in .env,
 * which config.ts reads with dotenv) is stronger than the directive: it is the
 * way to build the chain on a base image of your own, and silently ignoring it
 * would mean building something other than what was asked for. But then this
 * is said out loud, because the panel will show the directive's version for
 * the environment, while the image has a different one.
 */
export function rootParentImage(version: string, override?: string): string {
  const named = override?.trim()
  return named ? named : pythonImage(version)
}

function rootParent(build: Build, root: string): string {
  const asked = pythonImage(pythonOf(root))
  const chosen = rootParentImage(pythonOf(root), process.env.KERNEL_PARENT)
  if (chosen !== asked) {
    push(build, tr('server.kernelParentIsSetInTheServers.4c1d90', { p0: chosen, p1: asked }))
  }
  return chosen
}

/**
 * Build an environment's image, in the background — together with the chain
 * it stands on.
 *
 * A parent is built first, and only if its image does not exist yet: that is
 * what inheritance is for, since an edit to a leaf must not install torch all
 * over again. While the chain runs, "Building" shows on every link it BUILDS:
 * they share one log, and a second Build on the parent will not start in the
 * middle of this build. Links whose images already exist are released as soon
 * as that becomes clear: their button must not be locked by someone else's
 * build.
 *
 * Uses the dev override when the kernel is currently published on the host —
 * the same reasoning as the Makefile: rebuilding without it silently drops the
 * port the host server reaches the kernel through, and the room loses Python
 * while every container still reports healthy.
 */
export async function startBuild(name: string): Promise<void> {
  if (usingRuntimeBroker())
    throw new Error(tr('server.publishedEnvironmentsAreBuiltOutsideTheWeb.538ec6'))
  if (isBuilding(name)) return
  failures.delete(name)

  /*
   * The slot is taken synchronously, before the first await, and this matters.
   *
   * Between the `isBuilding` check and `builds.set` there used to be a
   * `docker compose ps`: hundreds of milliseconds in which a second Build on
   * the same name (a second tab, a tablet next to the laptop) passed the check
   * and started a second build. The first one was then pushed out of the map:
   * its log and Cancel became unreachable, and when it finished it silently
   * wrote the stamp.
   */
  const build: Build = {
    name,
    lines: [],
    done: false,
    failed: false,
    startedAt: Date.now(),
    listeners: new Set(),
    child: null,
  }
  builds.set(name, build)

  let chain: string[]
  try {
    chain = buildChain(name)
  } catch (err) {
    // A loop, a chain that is too long, a parent that does not exist: refused
    // before docker. Building for nine minutes only to fail on COPY is the same
    // error, just more expensive.
    const message = err instanceof Error ? err.message : String(err)
    push(build, message)
    build.failed = true
    build.done = true
    failures.set(name, message)
    return
  }

  /*
   * The WHOLE chain is taken, also before the first await.
   *
   * The slot on the name closed only half the door: the parents were
   * registered a line below, after `docker compose ps` and the image queries,
   * hundreds of milliseconds in which a Build on the parent from a second
   * window passed `isBuilding`, started its own `docker build` with the same
   * `-t`, and was then pushed out by the child's entry: the parent's log and
   * Cancel disappeared, and the end of the chain deleted the entry while the
   * parent's own build was still running. The promise from the header, "a
   * second Build on the parent will not start", is kept here.
   */
  const busy = chain.find((step) => step !== name && isBuilding(step))
  if (busy) {
    // Not "failed" but "busy": the very layer we would stand on is being built,
    // and waiting for it is the only sensible thing.
    const message = tr('server.environmentInThisChainIsAlreadyBuilding.166f94', { p0: busy })
    push(build, message)
    build.failed = true
    build.done = true
    failures.set(name, message)
    return
  }
  const held = chain.filter((step) => step !== name)
  for (const step of held) builds.set(step, build)
  /** Release the links, but only the ones we really hold. */
  const release = (steps: readonly string[]): void => {
    for (const step of steps) if (builds.get(step) === build) builds.delete(step)
  }

  /*
   * Through compose only where it exists.
   *
   * In the app container the kernel directory is mounted, while
   * docker-compose.yml and .env stayed on the host: `docker compose build`
   * there would fail with "no configuration file provided", and so the panel
   * turned Build off entirely. A direct build does not need them (the client
   * reads the context), and the compose path stays on the machine with the
   * repository for the sake of the dev override: without it the rebuilt shared
   * kernel comes back without the forwarded 8888, and the room loses Python
   * while every container is healthy.
   */
  const plan: BuildPlan = fs.existsSync(COMPOSE_FILE)
    ? {
        via: 'compose',
        files: (await usesDevOverride())
          ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
          : [],
      }
    : { via: 'direct' }
  // Cancel may have come while we were asking docker: then there is nothing to
  // start.
  if (build.done) {
    release(held)
    return
  }

  /*
   * We start from where the ready images end.
   *
   * A parent is needed exactly so that the next layer can stand on top of it:
   * if its image exists, there is no reason to touch the great-grandmother.
   * And a stale parent (its list was edited) is a separate button in its own
   * row: we have no right to rebuild three gigabytes on behalf of a person who
   * pressed Build on the child.
   */
  let from = 0
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    const step = chain[i]
    if (step !== undefined && (await imageFacts(step)) !== null) {
      from = i + 1
      break
    }
  }
  const stages = chain.slice(from)
  if (build.done) {
    release(held)
    return
  }
  // Skipped links are released: their images exist, nobody is going to build
  // them, and "Building" in their row would be a lie with a locked button.
  release(chain.slice(0, from))

  /*
   * The context is prepared here, not at the start: up to this line the build
   * could have been cancelled, and there is no reason to copy a directory for a
   * cancelled build. A copy failure (no space, the state directory is closed)
   * is a build failure with its own reason in the log, not an exception flying
   * past the panel.
   */
  let kernel: string
  try {
    kernel = buildContext(name)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    push(build, message)
    build.failed = true
    build.done = true
    failures.set(name, message)
    release(held)
    return
  }

  const base = rootParent(build, chain[0] as string)
  for (const step of stages) {
    if (build.done) break
    const before = chain[chain.indexOf(step) - 1]
    if (!(await runStage(build, plan, step, before ? `colloq-kernel:${before}` : base, kernel)))
      break
  }

  build.done = true
  if (!build.failed) push(build, tr('server.buildFinished.ce23d0'))
  // From here on each link answers for itself: someone else's log in a row of
  // its own is a "build failed" on an image that did build.
  release(held)
}

export function cancelBuild(name: string): boolean {
  const build = builds.get(name)
  if (!build || build.done) return false
  build.child?.kill('SIGTERM')
  push(build, '— cancelled')
  build.done = true
  build.failed = true
  failures.set(name, 'cancelled')
  return true
}

/** True when the kernel container publishes 8888 — i.e. the dev arrangement. */
async function usesDevOverride(): Promise<boolean> {
  const res = await run('docker', ['compose', 'ps', 'kernel', '--format', '{{.Publishers}}'], 8000)
  return res.code === 0 && res.out.includes('8888')
}

/**
 * Switches go one at a time.
 *
 * `docker compose up -d kernel` is an operation on one service of one project,
 * and two such calls overlapping fight over one container: the second fails on
 * a name conflict, and the panel shows "The kernel did not come back" where
 * the kernel came back just fine, only not for this request. The queue is
 * shared, not per environment name: there is one service, and two DIFFERENT
 * names quarrel over it just the same.
 */
let switching: Promise<void> = Promise.resolve()

/**
 * Point the instance's kernel at an environment.
 *
 * Writes `KERNEL_ENV` first and restarts second, in that order: the file is
 * what every later `make up` and every panel read will believe, and a restart
 * that succeeded against a file that did not get written is a lie that outlives
 * the process.
 *
 * `restartShared`: whether the rooms really sit on the compose kernel. When
 * each has its own container, there is no reason to recreate this service: not
 * a single room goes to it, and a restart ties up the machine for a minute and
 * looks in the panel as though something happened to the seminars. Then
 * "Make default" is just writing the default for new seminars, and nothing
 * more.
 */
export function activate(
  name: string,
  restartShared = true,
): Promise<{ ok: boolean; out: string }> {
  const done = switching.then(() => switchTo(name, restartShared))
  // A failed switch does not break the queue: the next one still has to be let
  // through, otherwise the panel gets stuck until the server restarts.
  switching = done.then(
    () => undefined,
    () => undefined,
  )
  return done
}

async function switchTo(
  name: string,
  restartShared: boolean,
): Promise<{ ok: boolean; out: string }> {
  setActiveName(name)
  if (usingRuntimeBroker() || !restartShared) return { ok: true, out: '' }
  const files = (await usesDevOverride())
    ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
    : []
  /*
   * KERNEL_ENV is passed explicitly, and that is the whole fix.
   *
   * compose resolves `image: colloq-kernel:${KERNEL_ENV:-base}` from the
   * environment before it looks at the .env file, and this process was started
   * by `make run`, which had already exported the OLD value. So writing the
   * file and calling compose brought the container back up on the previous
   * image while the panel reported the new one — "nlp is active", and
   * `import transformers` still failing in every room.
   */
  const res = await run('docker', ['compose', ...files, 'up', '-d', 'kernel'], 120_000, {
    KERNEL_ENV: name,
  })
  return { ok: res.code === 0, out: res.out }
}

/* ------------------------------------------------------------- assembly */

function stateOf(
  name: string,
  built: ImageFacts | null,
  parentBuilt: ImageFacts | null,
): EnvironmentState {
  if (isBuilding(name)) return 'building'
  /*
   * A built image outranks a remembered failure.
   *
   * `failures` lives in memory and is only ever cleared by starting another
   * build, so one bad rebuild hid a perfectly good image: the environment
   * vanished from the seminar form and lost its "Make default" until somebody
   * restarted the process. The error is still reported beside the row; it just
   * no longer pretends there is nothing there.
   */
  if (!built) return failures.has(name) ? 'failed' : 'unbuilt'
  /*
   * Edited since the last build is not ready — that is what `unbuilt` says in
   * the contract, and it was never returned. Saving a package list and seeing
   * "Ready · built 3 days ago" is how a room ends up on the old image with
   * nothing on screen disagreeing.
   */
  if (editedSinceBuild(name, built)) return 'unbuilt'
  /*
   * Asks for one Python version but was built on another: also "rebuild".
   *
   * A separate check, because the stamp does not help here: to pip the
   * directive is a comment, and `listChanged` does not see it at all, i.e.
   * changing the version in the header changes NOTHING in how we tell a fresh
   * image from an old one. The panel would show "Python 3.12 · Ready" over an
   * image with 3.11, and people would find out at the first `match` in the
   * middle of class.
   */
  if (pythonDrifted(name, built)) return 'unbuilt'
  /*
   * The parent was rebuilt later, so this image stands on the previous layer.
   *
   * The child's list did not change, and by it everything is ready; but the
   * torch in it is the one from before base-gpu was rebuilt, while the panel
   * would say "Ready". The same "Needs rebuild" as for a list edit: the image
   * exists, rooms run on it, and a rebuild costs seconds.
   */
  if (parentBuilt && parentBuilt.builtAt > built.builtAt) return 'unbuilt'
  return 'ready'
}

/**
 * Whether the version from the file and the version in the image diverged.
 *
 * Minor versions are compared: the image says `3.12.7`, the file asks for
 * `3.12`, and that is the same version; offering a rebuild over a patch would
 * mean calling for one after every update of the official image. An image
 * that says nothing about Python (built not from python-slim) does not count
 * as a divergence: saying "rebuild" on the basis of not knowing is worse than
 * saying nothing.
 */
function pythonDrifted(name: string, built: ImageFacts): boolean {
  if (built.python === null) return false
  const minor = built.python.split('.').slice(0, 2).join('.')
  return minor !== pythonOf(name)
}

/** Whether the package list was written after the image was built. */
function editedSinceBuild(name: string, built: ImageFacts): boolean {
  let stamped: string | null = null
  try {
    stamped = fs.readFileSync(stampFor(name), 'utf8')
  } catch {
    stamped = null
  }
  if (stamped !== null) return listChanged(stamped, readSource(name))
  try {
    return fs.statSync(fileFor(name)).mtimeMs > built.builtAt
  } catch {
    // No file to compare against; the image is all there is.
    return false
  }
}

export async function listEnvironments(): Promise<AdminEnvironment[]> {
  if (usingRuntimeBroker()) {
    const active = activeName()
    return loadRuntimeCatalog()
      .environments.filter((e) => e.current)
      .map((e) => ({
        name: e.name,
        state: 'ready',
        packages: e.packages ?? [],
        imageBytes: null,
        builtAt: null,
        active: e.name === active,
        error: null,
        parent: null,
        gpu: e.gpu,
        // Only the version the catalog named: the image here is someone else's
        // and immutable, there is nothing to ask it with from here, and a
        // default in this place would be an invention about the production
        // build. If nothing is stated, the panel says nothing.
        python: e.python ?? '',
        pythonBuilt: null,
        managed: true,
        image: e.image,
        revision: imageRevision(e.image),
      }))
  }
  const active = activeName()
  const names = listNames()
  // All environments' images at once: a row needs not only its own but also
  // its parent's, otherwise "the parent was rebuilt" can only be seen by eye,
  // from the dates.
  const facts = new Map<string, ImageFacts | null>(
    await Promise.all(names.map(async (name) => [name, await imageFacts(name)] as const)),
  )
  return names.map((name) => {
    const built = facts.get(name) ?? null
    const source = readSource(name)
    const parent = declaresParent(source)
    return {
      name,
      state: stateOf(name, built, parent === null ? null : (facts.get(parent) ?? null)),
      packages: parsePackages(source),
      imageBytes: built?.bytes ?? null,
      builtAt: built?.builtAt ?? null,
      active: name === active,
      error: failures.get(name) ?? null,
      parent,
      // The directive from the file header, not a separate registry: the panel
      // shows the same thing the kernel start later decides by, including what
      // is inherited from the parent.
      gpu: needsGpu(name),
      // Both versions: what the file asks for and what the image ended up with.
      // While they match, the panel shows the second, being more precise
      // (`3.12.7`); once they diverge, the first, together with the "Needs
      // rebuild" that explains it.
      python: pythonOf(name),
      pythonBuilt: built?.python ?? null,
    }
  })
}
