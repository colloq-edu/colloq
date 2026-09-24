/**
 * The Colloq distribution: what goes into the pip wheel.
 *
 *   npx tsx scripts/pack.mts          build afresh and put it into python/colloq/_app
 *   npx tsx scripts/pack.mts --skip-build   pack what has already been built
 *   make pack · make wheel
 *
 * Why this exists at all. The teacher's machine has no repository, no make and
 * no tsx: `pip install colloq` and `colloq`. So everything that today is
 * computed from the sources (the frontend build, the tree fingerprint, npm run
 * calls) must be computed HERE, once, and arrive ready. The sign of "arrived
 * ready" is the .colloq-dist.json file at the application root: on seeing it,
 * the launch builds nothing and does not call npm at all.
 *
 * The layout inside app/ repeats the repository, and that is not decoration.
 * Three places in the code look for their files relative to themselves, and
 * all three work only with this layout:
 *
 *   · server/src/config.ts:26: repoRoot is `../..` from the built
 *     server/dist/server.js, that is, the application root. Put the server in
 *     app/server.js, and data/ with workspace/ move one level up;
 *   · server/src/environments.ts:23: looks for kernel/environments, stepping
 *     up from itself. That is why kernel/ lies next to server/ and not just
 *     anywhere;
 *   · cli/src/launch-config.ts:104: STATIC_DIR is <root>/web/dist.
 *
 * The ops scripts (scripts/) travel with everything else, and not "just in
 * case". `colloq host <name>`, the only command by which a class gets its
 * link, is `make host`, and that calls scripts/host.sh. While they were not in
 * the package, publishing died in an installed colloq: no make, no script,
 * `colloq start --host` fell over with code 127, the receipt got
 * hosting: 'failed', and the person read "local work continues" and went to
 * class with a session nobody could see from outside. Exactly what is called
 * travels: host.sh with what it sources and runs, and the backup/restore pair
 * with their helpers; the list and the reasons are at SCRIPTS below.
 *
 * What this universal wheel deliberately lacks: node_modules. Two of the
 * server's dependencies are native (better-sqlite3 and @resvg/resvg-js), and a
 * wheel with them is a platform wheel. Instead, a package.json with the
 * server's production dependencies sits next to the app, and `colloq` installs
 * them on the first run (python/colloq/__main__.py). The platform wheels are
 * built on top of this one by scripts/platform-wheels.py: they add Node and
 * node_modules for macOS and Linux, and pip prefers them where they fit.
 *
 * The CLI itself has no node_modules either: the bundles are built with
 * --packages=external, and from outside they need only dotenv and
 * better-sqlite3 (the latter only for launch.mjs, as a deferred import:
 * --share reads the list of classes from the database), and both are among
 * the server's dependencies anyway. colloq.mjs needs nothing at all: --help
 * works before npm install. There is no need to check this by eye: the build
 * itself compares the list of external names with what package.json will
 * install, and fails if someone has added a new library to the CLI.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { build, type Metafile } from 'esbuild'
import { pythonVersionFile } from './version.mts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'no-python': { type: 'boolean', default: false },
    date: { type: 'string' },
  },
})

const outDir = path.resolve(root, values.out ?? 'dist-pkg')
const appDir = path.join(outDir, 'app')
const pythonApp = path.join(root, 'python/colloq/_app')

/**
 * The build date comes from outside, not from Date.now().
 *
 * The stamp lies in a file that goes into the wheel, so two runs in a row
 * would give two different wheels from identical sources. Whoever builds
 * reproducibly passes SOURCE_DATE_EPOCH (that is what it is called
 * everywhere, from Debian to pypa) or --date; whoever builds for themselves
 * gets the current time, and that is exactly what they want to see in
 * `colloq --version`.
 */
const builtAt = values.date
  ? new Date(values.date).toISOString()
  : process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString()
if (Number.isNaN(Date.parse(builtAt))) throw new Error('Invalid build date: --date <ISO>')

type Json = Record<string, unknown>
function readJson(file: string): Json {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Json
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} — code ${result.status ?? 'signal'}`)
}

/**
 * A copy of a directory, with two filters, and neither is cosmetic.
 *
 * .DS_Store on macOS appears in every directory that was opened in Finder, and
 * would go into the wheel as part of the distribution.
 *
 * kernel/environments/.<name>.built is the stamp "which package list is baked
 * into the kernel image on THIS machine" (see .gitignore). Machine state, not
 * source: arriving at the teacher's, it would speak of an image they do not
 * have, and the launch would consider the environment ready without building
 * anything.
 */
const JUNK = new Set(['.DS_Store', '.vite'])
function junk(source: string): boolean {
  const name = path.basename(source)
  return JUNK.has(name) || name.endsWith('.built')
}
function copyInto(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, dereference: true, filter: (source) => !junk(source) })
}
function weigh(target: string): { files: number; bytes: number } {
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size }
  let files = 0,
    bytes = 0
  for (const name of fs.readdirSync(target)) {
    const inner = weigh(path.join(target, name))
    files += inner.files
    bytes += inner.bytes
  }
  return { files, bytes }
}
function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

const rootPkg = readJson(path.join(root, 'package.json'))
const serverPkg = readJson(path.join(root, 'server/package.json'))
const version = String(rootPkg.version ?? '0.0.0')
const dependencies = (serverPkg.dependencies ?? {}) as Record<string, string>

// ---------------------------------------------------------------- build

if (!values['skip-build']) {
  // The same pipeline that colloq run calls today: web/dist with compression
  // and server/dist. The difference is that here it runs ONCE, on our side,
  // not at the teacher's during class.
  run('npm', ['run', 'build:optimized'])
}
for (const required of ['web/dist/index.html', 'server/dist/server.js']) {
  if (!fs.existsSync(path.join(root, required)))
    throw new Error(
      `Nothing to pack: no ${required}. Drop --skip-build or build it: npm run build:optimized`,
    )
}
if (values['skip-build'])
  console.log('— taking the already built web/dist and server/dist as they are (--skip-build)')

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(appDir, { recursive: true })
/*
 * dist-pkg ignores itself: the root .gitignore does not list this directory,
 * and six megabytes of built frontend in `git status` is a sure way to commit
 * them whole one day.
 */
fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n')

// ---------------------------------------------------------------- CLI

/**
 * The bundle's entry point.
 *
 * main.ts runs itself only if argv[1] ends in cli/src/main.ts or .js
 * (main.ts:788): a bundle named colloq.mjs does not pass this check and
 * silently exits with zero. So the distribution has its own entry point,
 * cli/src/bin.ts, which simply calls cli(). While it is not in the tree, we
 * build the same one on the fly from stdin: the package does not depend on it,
 * and the packing can already be checked today.
 */
const binFile = path.join(root, 'cli/src/bin.ts')
const hasBin = fs.existsSync(binFile)
const external = new Set<string>()
function collectExternal(meta: Metafile | undefined): void {
  for (const input of Object.values(meta?.outputs ?? {})) {
    for (const item of input.imports ?? []) {
      if (item.external && !item.path.startsWith('node:')) external.add(item.path)
    }
  }
}

const cliBundle = await build({
  ...(hasBin
    ? { entryPoints: [binFile] }
    : {
        stdin: {
          contents:
            "import { cli } from './cli/src/main.js'\n" +
            'process.exitCode = await cli(process.argv.slice(2))\n',
          resolveDir: root,
          sourcefile: 'bin.ts',
          loader: 'ts' as const,
        },
      }),
  outfile: path.join(appDir, 'cli/colloq.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  metafile: true,
})
collectExternal(cliBundle.metafile)

/*
 * launch.ts is built separately because it also lives separately: the CLI
 * starts it as a process of its own (cli/src/commands/local.ts · launch), and
 * it is exactly this process that remains the supervisor of the class: it
 * holds the receipt, the pid file and the kernels. They cannot be glued into
 * one bundle: launch.ts has its own top-level main().
 */
const launchBundle = await build({
  entryPoints: [path.join(root, 'cli/src/launch.ts')],
  outfile: path.join(appDir, 'cli/launch.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  metafile: true,
})
collectExternal(launchBundle.metafile)

/*
 * The external address receipt is a third separate bundle, for exactly the
 * same reason as launch.mjs: it is started as a process, not imported.
 * scripts/host.sh starts it, and until now it did so with the command
 * `node --import tsx scripts/public-url-lease.mts`. The distribution has no
 * tsx at all: in a local session the very first call (discover) died on
 * "Cannot find package 'tsx'", and publishing died along with it. The bundle
 * goes next to launch.mjs, and host.sh chooses on its own: if the file is
 * there, plain node; if not, the old tsx next to the repository.
 */
const leaseBundle = await build({
  entryPoints: [path.join(root, 'scripts/public-url-lease.mts')],
  outfile: path.join(appDir, 'cli/public-url-lease.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  metafile: true,
})
collectExternal(leaseBundle.metafile)

/*
 * The external names of the bundles must be found in the node_modules that
 * app/package.json will install. Today those are dotenv and better-sqlite3;
 * tomorrow someone adds one more library to the CLI, and on the teacher's
 * machine the very first launch dies on ERR_MODULE_NOT_FOUND, not here. Let
 * it die here.
 */
const missing = [...external].filter((name) => {
  const owner = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
  return !(owner in dependencies)
})
if (missing.length)
  throw new Error(
    `The CLI asks from outside for what is not among the server's dependencies: ${missing.join(', ')}. ` +
      'Add them to server/package.json or remove them from the CLI.',
  )

// ---------------------------------------------------------------- pieces

copyInto(path.join(root, 'server/dist'), path.join(appDir, 'server/dist'))
copyInto(path.join(root, 'web/dist'), path.join(appDir, 'web/dist'))
// The kernel arrives as source, not as an image: the Python image is built on
// the spot, from this Dockerfile and these package lists, and every teacher
// has their own.
for (const item of ['Dockerfile', 'requirements.txt', 'environments']) {
  copyInto(path.join(root, 'kernel', item), path.join(appDir, 'kernel', item))
}
// Fonts for link cards (satori + resvg). The server reads them, and without
// them the room preview silently comes out without text.
if (fs.existsSync(path.join(root, 'server/assets')))
  copyInto(path.join(root, 'server/assets'), path.join(appDir, 'server/assets'))
// The license and the third-party licenses go to the application root, that
// is, inside the wheel. MIT requires the text to travel with every copy, and a
// wheel is a copy; the bundles also hold pdf.js, satori, resvg and fonts under
// their own licenses, and THIRD_PARTY_NOTICES.md is the only place that says
// so. hatchling will not put them into dist-info: it looks for LICENSE next to
// pyproject.toml, in python/.
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const from = path.join(root, name)
  if (!fs.existsSync(from)) throw new Error(`Nothing to pack: no ${name} at the repository root`)
  copyInto(from, path.join(appDir, name))
}

/**
 * The ops scripts: exactly those that get called, and exactly those that they
 * call in turn. The list was made by reading, not by eye: each line answers
 * the question "who runs it".
 *
 * Nothing extra is here on purpose. vast.sh, relay-setup.sh, release.py and
 * the rest set up and maintain OTHER machines: that is the workshop's job, and
 * it has the repository. The wheel carries what the teacher's machine cannot
 * live without.
 */
const SCRIPTS: Record<string, string> = {
  // The only command by which a class gets its link: colloq host and
  // colloq start --host are this script.
  'host.sh': 'publishing the class to the outside',
  // Sourced by host.sh, dns.sh and restore.sh: reading .env and the state root.
  'lib.sh': 'shared .env reading and the state directory',
  // Direct mode (colloq host --direct) writes the A record with it.
  'dns.sh': 'records in the Cloudflare zone',
  // host.sh hands it the address on an installation with k3s; it also starts
  // and stops the services that backup and restore wait for.
  'cluster.sh': 'k3s installation: address, services, state',
  // The whole pair for colloq backup/restore: the commands themselves and
  // their helpers.
  //
  // The local backup is the only one a teacher needs: a portable k3s backup
  // can be taken only where the cluster runs. The recipe lived in the
  // Makefile, and `colloq backup` from the wheel died on "make: command not
  // found"; now it is a script, and it travels here.
  'backup-local.sh': 'a backup of the class on this machine: database and files',
  'backup.sh': 'portable backup',
  'restore.sh': 'restoring a backup',
  'runtime-backup.py': 'archive format: building, checking, restoring',
  'state-lock.py': 'state lock: no two backups at once',
}
for (const [name, why] of Object.entries(SCRIPTS)) {
  const from = path.join(root, 'scripts', name)
  // A renamed or deleted script is a build failure, not a wheel without it:
  // the loss would be found anyway, but during class and with code 127.
  if (!fs.existsSync(from)) throw new Error(`Nothing to pack: no scripts/${name} — ${why}`)
  copyInto(from, path.join(appDir, 'scripts', name))
}

// ------------------------------------------------------- package.json alongside

/*
 * Three package.json files, and each one is needed.
 *
 * app/package.json: `npm install --omit=dev` installs the server's
 * node_modules from it. The dependencies are taken from server/package.json
 * as they are.
 *
 * app/cli/package.json and app/server/package.json are about "type":
 * "module". Formally the top one would be enough (Node looks for the nearest
 * package.json up the tree), but both directories are code in other people's
 * hands: someone only has to copy app/server separately, and a .js file
 * without "type" is read as CommonJS, while it is ESM. Also, app/cli holds
 * version: `colloq --version` reads it from cli/package.json relative to the
 * application root (cli/src/main.ts:229).
 */
writeJson(path.join(appDir, 'package.json'), {
  name: 'colloq',
  version,
  private: true,
  type: 'module',
  description: 'Colloq — the built application. colloq installs its dependencies on the first run.',
  dependencies,
})
writeJson(path.join(appDir, 'cli/package.json'), { name: 'colloq', version, type: 'module' })
writeJson(path.join(appDir, 'server/package.json'), {
  name: '@colloq/server',
  version,
  private: true,
  type: 'module',
})

// ---------------------------------------------------------------- stamp

const parts = [
  'cli/colloq.mjs',
  'cli/launch.mjs',
  'cli/public-url-lease.mjs',
  'server/dist',
  'server/assets',
  'web/dist',
  'kernel',
  'scripts',
]
  .filter((item) => fs.existsSync(path.join(appDir, item)))
  .map((item) => ({ path: item, ...weigh(path.join(appDir, item)) }))

writeJson(path.join(appDir, '.colloq-dist.json'), {
  name: 'colloq',
  version,
  builtAt,
  builtBy: 'scripts/pack.mts',
  node: process.version,
  /* Where to look, for whoever reads this file instead of guessing. */
  layout: {
    cli: 'cli/colloq.mjs',
    launch: 'cli/launch.mjs',
    lease: 'cli/public-url-lease.mjs',
    server: 'server/dist/server.js',
    web: 'web/dist',
    kernel: 'kernel',
    scripts: 'scripts',
  },
  /* node_modules are installed on the spot: see the header of this file and python/colloq/__main__.py. */
  install: { manager: 'npm', args: ['install', '--omit=dev'], cwd: '.' },
  parts,
})

// ---------------------------------------------------------- the bundle speaks

/*
 * The built CLI must answer --help, and that is not a formality.
 *
 * main.ts runs itself only on recognizing its own name in argv[1]
 * (main.ts:788): a bundle under another name slipped past this check and
 * exited with code 0 without printing a line. Silence with a zero is the worst
 * of failures: the build is green, the wheel is built, and the command
 * "works" while doing nothing. So here the bundle is called for real and
 * required to say something.
 *
 * COLLOQ_HOME is redirected to a temporary directory: without that the check
 * would create a real ~/.colloq for whoever builds, class state where nobody
 * asked for it.
 */
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-pack-'))
try {
  const probe = spawnSync(process.execPath, [path.join(appDir, 'cli/colloq.mjs'), '--help'], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      COLLOQ_APP_DIR: appDir,
      COLLOQ_HOME: probeHome,
      NO_COLOR: '1',
    },
  })
  if (probe.status !== 0 || !(probe.stdout ?? '').trim())
    throw new Error(
      'The built CLI did not answer --help ' +
        `(code ${probe.status ?? 'signal'}). ${(probe.stderr ?? '').trim().slice(0, 400)}\n` +
        'It looks like the entry point does not call cli(): see cli/src/bin.ts and the tail of cli/src/main.ts.',
    )
  /*
   * And the version is the very one in the root package.json. `colloq
   * --version` reads app/cli/package.json, written above; the check catches the
   * day someone changes where it reads from, and the wheel ships with "0.0.0"
   * from the fallback branch.
   */
  const said = spawnSync(process.execPath, [path.join(appDir, 'cli/colloq.mjs'), '--version'], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, COLLOQ_APP_DIR: appDir, COLLOQ_HOME: probeHome, NO_COLOR: '1' },
  })
  if (said.status !== 0 || (said.stdout ?? '').trim() !== version)
    throw new Error(
      `The built CLI named the version "${(said.stdout ?? '').trim()}" instead of ${version} ` +
        `(code ${said.status ?? 'signal'}). ${(said.stderr ?? '').trim().slice(0, 400)}`,
    )
} finally {
  fs.rmSync(probeHome, { recursive: true, force: true })
}

// ---------------------------------------------------------------- into python

if (!values['no-python']) {
  /*
   * The wheel is built from python/, and the application must lie INSIDE the
   * package: hatchling puts into the wheel what lies under colloq/, and that is
   * where _app lies. The directory is wiped entirely rather than topped up:
   * otherwise stale asset hashes from the previous build would remain, and the
   * wheel would drag both sets along.
   */
  fs.rmSync(pythonApp, { recursive: true, force: true })
  copyInto(appDir, pythonApp)
  // The Python package version comes from the root package.json, one number
  // for the whole project. pyproject.toml reads it from here
  // (tool.hatch.version), so there is nowhere for them to drift apart. The
  // file's text is the shared pythonVersionFile template (scripts/version.mts):
  // the file is tracked by git, and in the release PR release-please edits it
  // too, only the number on the line with the marker that the template
  // carries. Should packing lose the marker or the header, every `make wheel`
  // would dirty the tree, and the next release would leave _version.py at the
  // old number.
  fs.writeFileSync(path.join(root, 'python/colloq/_version.py'), pythonVersionFile(version))
}

// ---------------------------------------------------------------- report

const total = weigh(appDir)
console.log(`\nColloq ${version} — distribution built: ${appDir}`)
for (const part of parts)
  console.log(
    `  ${part.path.padEnd(24)} ${String(part.files).padStart(5)} files  ${human(part.bytes)}`,
  )
console.log(`  ${'total'.padEnd(24)} ${String(total.files).padStart(5)} files  ${human(total.bytes)}`)
if (!values['no-python']) console.log(`\nIn the Python package: ${pythonApp}\nWheel: make wheel`)
