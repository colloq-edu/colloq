import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isDistribution } from './launch-state.js'

export interface LaunchOptions {
  /**
   * cloudflared is not a class but a service word for scripts/host.sh: find
   * or download cloudflared and print the path (launch-cloudflared.ts). The
   * script calls it when there is no cloudflared in PATH, so `colloq host` and
   * `make host` also do without a manual install, and the search rule stays
   * one.
   */
  action: 'run' | 'dev' | 'stop' | 'restart' | 'cloudflared'
  detach: boolean
  open: boolean
  fast: boolean
  build: boolean
  host?: string
  /** A Cloudflare quick tunnel with one link for the class (launch-share.ts). */
  share?: boolean
  port?: number
  child?: boolean
}

export function parseLaunchArgs(args: string[]): LaunchOptions {
  const options: LaunchOptions = {
    action: 'run',
    detach: false,
    open: true,
    fast: false,
    build: false,
  }
  let at = 0
  if (['run', 'dev', 'stop', 'restart', 'cloudflared'].includes(args[0]))
    options.action = args[at++] as LaunchOptions['action']
  for (; at < args.length; at++) {
    const flag = args[at]
    if (flag === '--detach') options.detach = true
    else if (flag === '--no-open') options.open = false
    else if (flag === '--fast') options.fast = true
    else if (flag === '--build') options.build = true
    else if (flag === '--child') options.child = true
    else if (flag === '--share') options.share = true
    else if (flag === '--port') {
      const value = args[++at]
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error('The port must be a whole number from 1 to 65535.')
      options.port = Number(value)
    } else if (flag === '--host') {
      const host = args[++at]
      if (!host || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
        throw new Error('Give a name after --host, for example class.example.ru.')
      options.host = host
    } else throw new Error(`Unknown launch argument: ${flag}`)
  }
  if (options.action === 'dev' && options.detach)
    throw new Error('dev runs in the terminal; use run --detach for the background.')
  // Two ways of going outside at once mean two tunnels on one address receipt,
  // and the second would get the refusal "the address is already taken" in
  // the middle of the start. Refusing here is cheaper: nothing is up yet.
  if (options.share && options.host)
    throw new Error(
      '--share and --host do not work together: --share is a quick Cloudflare link, --host is your own name.',
    )
  return options
}

export interface LaunchConfig {
  /** The application directory: server/dist, web/dist, kernel/, node_modules. */
  root: string
  /** The state directory: .env, .colloq/, data/, workspace/. In the repository it equals root. */
  home: string
  /** The application is installed ready-made: there is no build, and nothing to call make and npm with. */
  dist: boolean
  port: number
  uiPort: number
  url: string
  dataDir: string
  workspaceDir: string
  leaseFile: string
  env: Record<string, string>
  kernelEnv: string
}

/**
 * The settings of one start. root is where the application is, home is where
 * the state is (launch-state.ts · two roots). As the fourth parameter, not an
 * object field: in the repository and in the tests there is one root, and the
 * call stays as it was.
 */
export function launchConfig(
  root: string,
  options: LaunchOptions,
  source: NodeJS.ProcessEnv,
  home: string = root,
): LaunchConfig {
  const dev = options.action === 'dev'
  const configuredPort = Number(source.PORT || 3000)
  const port = dev ? configuredPort : (options.port ?? configuredPort)
  const uiPort = dev ? (options.port ?? 5173) : port
  for (const value of [port, uiPort])
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('Invalid PORT in the launch settings.')
  if (dev && port === uiPort)
    throw new Error('The dev frontend port must differ from the server PORT in .env.')
  // The data, the files and the address lease receipt are the class state, so
  // home. In the repository home is the repository, and all three paths stay
  // as they were.
  const dataDir = path.resolve(home, source.DATA_DIR || 'data')
  const workspaceDir = path.resolve(home, source.WORKSPACE_DIR || 'workspace')
  const leaseFile = path.join(home, '.colloq/public-url.json')
  const url = `http://localhost:${uiPort}`
  const kernelEnv = source.KERNEL_ENV || 'base'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(kernelEnv))
    throw new Error('Invalid environment name in KERNEL_ENV.')
  /*
   * The refusal on broker stays, and it is about someone else's installation,
   * not about the first start.
   *
   * It used to fire precisely on the first one: .env was made as a copy of
   * .env.example, which has KERNEL_BACKEND=broker (it is the production
   * template), and colloq refused on a file it had itself written out a
   * minute earlier. The fix is not a weaker check but that colloq no longer
   * copies someone else's template: it writes its own .env for a local class,
   * with docker in it (see localClassEnv below).
   *
   * We look at the effective environment (the file plus the shell variables),
   * the same one the server will see. If the machine has a real installation
   * with a broker, run still refuses: a class on a laptop and production are
   * different things.
   *
   * The same bug lived in the Makefile too: the `.env` target copied the
   * template, and after `make up` it was `make dev` that refused. The target
   * now writes this same file (scripts/local-env.sh), but the clones where the
   * copy already lies are still around: broker has stood in the template since
   * 9 Sep 2026. For them the refusal says which line to change: the former
   * "this is an installation with a broker, go to cluster" was untrue and a
   * dead end for a developer with a laptop. COLLOQ_CLUSTER=1 does not get such
   * a hint: only a deployment writes it (scripts/vast.sh), it is never an
   * accidental copy.
   */
  if (source.COLLOQ_CLUSTER === '1')
    throw new Error(
      'This is a runtime broker installation: use the service or cluster commands for it. run is meant for local Docker.',
    )
  if (source.KERNEL_BACKEND === 'broker')
    throw new Error(
      'KERNEL_BACKEND=broker is the production setting from .env.example, and a local class runs its kernels in Docker. ' +
        `Set KERNEL_BACKEND=docker in ${path.join(home, '.env')} (or move that file aside: colloq then writes one for this machine). ` +
        'A real runtime broker installation is run with the service or cluster commands.',
    )
  const env = Object.fromEntries(
    Object.entries(source).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  )
  Object.assign(env, {
    NODE_ENV: 'development',
    KERNEL_BACKEND: 'docker',
    PORT: String(port),
    BIND_ADDR: '127.0.0.1',
    DATA_DIR: dataDir,
    WORKSPACE_DIR: workspaceDir,
    WORKSPACE_HOST_DIR: '',
    COLLOQ_LOCAL_SESSION: '1',
    COLLOQ_LOCAL_URL: url,
    COLLOQ_PUBLIC_URL_LEASE_FILE: leaseFile,
    COLLOQ_STOP_KERNELS_ON_EXIT: dev ? '0' : '1',
    // The state directory has to be TOLD to the server. On its own it works
    // out only the application root (stepping up to kernel/environments), and
    // so the "Environments" window did not see a single environment created
    // by `colloq env new`, and put the ones created from the panel into
    // site-packages. By this line the panel finds its environments and .env;
    // without it the panel has one directory, as before.
    COLLOQ_HOME: home,
    // The built interface is part of the application, so root, not home.
    STATIC_DIR: path.join(root, 'web/dist'),
    VITE_API_TARGET: `http://127.0.0.1:${port}`,
  })
  return {
    root,
    home,
    dist: isDistribution(root),
    port,
    uiPort,
    url,
    dataDir,
    workspaceDir,
    leaseFile,
    env,
    kernelEnv,
  }
}

/**
 * The .env of a local class: the one colloq writes out itself.
 *
 * A copy of .env.example here was a mistake at the very root: that is the
 * installation template, its very first line speaks of production and a
 * release, and its settings are production ones (KERNEL_BACKEND=broker). It
 * turned out that the first `colloq run` on a clean machine wrote a file that
 * it then refused on itself.
 *
 * The rule is simple now: a file colloq writes on a person's behalf must be
 * fit for what colloq is about to do. The Makefile is protected in exactly the
 * same way: in the run recipe it sets `KERNEL_BACKEND=docker` in the
 * environment (Makefile · run) without relying on the line in the file. The
 * difference is that a variable in a recipe is invisible: a person opens .env,
 * reads broker and does not understand why the class runs in Docker. Here the
 * same thing is said out loud, in the file they will be editing.
 *
 * Here is only what a person may really want to change before a class.
 * Everything else is the code's defaults; the full list of settings stays in
 * .env.example, and the very first line names it.
 *
 * The language depends on how the program was installed, and this is not a
 * whim. The repository is the authors' working tree and the machines where
 * classes are taught in Russian: there it is ru, as it was. The pip package is
 * installed anywhere, and its default is English. The line meanwhile stays in
 * the file in plain view: the person edits it themselves, with one word,
 * without searching the documentation.
 */
export function localClassEnv(dist: boolean): string {
  return `# Settings for this machine. colloq wrote this file on its first start:
# edit it and restart with colloq restart. The full list of everything that
# can be configured is in .env.example next to the application.

# The address of the class on this machine. From outside it is visible
# only through colloq host.
PORT=3000
BIND_ADDR=127.0.0.1
UI_LANGUAGE=${dist ? 'en' : 'ru'}

# The kernels of a class are Docker containers on this computer, one per room.
# Each room container is hardened: no privileges, a process limit, the internet
# yes, your local network and this computer no. COLLOQ_ROOM_NETWORK=open lifts
# the network block for a machine you fully trust.
KERNEL_BACKEND=docker
KERNEL_ENV=base
# Memory and processors of one room. 4g is enough for an ordinary class; for a
# class that trains networks set 8g-16g, if the machine has that much.
KERNEL_MEM=4g
KERNEL_CPUS=2
KERNEL_SHM=1g

# Signs the sign-in links of teachers and students. Left empty, the key is
# created in data/ on its own and survives a restart; a value written here
# wins over it.
SESSION_SECRET=
# Not a shared Jupyter: every room has a token of its own. This line is here
# so the log does not keep the token from .env.example, which everyone knows.
JUPYTER_TOKEN=${randomBytes(24).toString('hex')}

# File uploads and the disk space one class may take.
MAX_UPLOAD_MB=50
MAX_SESSION_MB=1024

# The Oracle. Without a key the class still runs, but the model cannot be asked.
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
`
}

function filesBelow(root: string, relative: string): string[] {
  const full = path.join(root, relative)
  if (!fs.existsSync(full)) return []
  const stat = fs.lstatSync(full)
  if (stat.isSymbolicLink()) return []
  if (!stat.isDirectory()) return [relative]
  return fs
    .readdirSync(full)
    .sort()
    .flatMap((name) => {
      if (
        ['node_modules', 'dist', '.git', '.vite'].includes(name) ||
        name.endsWith('.built') ||
        // Copies of third-party bundles that the build step itself lays out
        // (`npm run assets` in web/package.json): the pdf.js worker and
        // plotly.js. They are not sources: their content is already accounted
        // for through package-lock.json, and hashing them separately would mean
        // rebuilding the frontend every time a copy appeared or vanished.
        ['web/public/pdf', 'web/public/plotly'].includes(path.join(relative, name))
      )
        return []
      return filesBelow(root, path.join(relative, name))
    })
}

export function fingerprint(
  root: string,
  inputs = [
    'web',
    'server',
    'runtime',
    'shared',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ],
): string {
  const hash = createHash('sha256')
  for (const file of inputs.flatMap((input) => filesBelow(root, input)).sort()) {
    hash
      .update(file)
      .update('\0')
      .update(fs.readFileSync(path.join(root, file)))
      .update('\0')
  }
  return hash.digest('hex')
}

export interface BuildStamp {
  fingerprint: string
  fast: boolean
}
export function buildIsCurrent(root: string, stamp: BuildStamp | null, fast: boolean): boolean {
  return Boolean(
    stamp &&
      stamp.fingerprint === fingerprint(root) &&
      (fast || !stamp.fast) &&
      fs.existsSync(path.join(root, 'web/dist/index.html')) &&
      fs.existsSync(path.join(root, 'server/dist/server.js')),
  )
}

export function kernelInputs(root: string, name: string): string[] {
  const files = ['kernel/Dockerfile', 'kernel/requirements.txt']
  const seen = new Set<string>()
  let current: string | undefined = name
  while (current) {
    if (seen.has(current) || seen.size >= 8)
      throw new Error('A cycle or too long a chain of Python environments.')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(current))
      throw new Error('Invalid parent environment name.')
    seen.add(current)
    const file: string = `kernel/environments/${current}.txt`
    if (!fs.existsSync(path.join(root, file))) throw new Error(`No environment ${current}: ${file}`)
    files.push(file)
    current = fs
      .readFileSync(path.join(root, file), 'utf8')
      .match(/^\s*#\s*colloq:\s*from\s+(\S+)/m)?.[1]
  }
  return files
}
