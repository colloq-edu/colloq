/**
 * What a machine that runs submissions loads, and what its build is made of
 * («машины для посылок», docs/architecture/remote-runners.md §2, §8.2, §8.4).
 *
 * The machine's agent (dist/runner.js) calls home's own Docker runner, so
 * that the argv, the harness and the verdicts are home's by construction. It
 * must load that core without anything of home's: a module that opens the
 * database, reads .env, starts a timer or patches the process when it loads
 * would do it on a rented VM, under the agent, with nothing there to answer.
 * And the sha256 of the bundle is the machine's build, which home compares
 * with its own before it hands out work (decision 5): what changes with every
 * release must not be in it, or every release idles the fleet.
 *
 * Each rule fails quietly: one import of db.ts at the top of a module the
 * core happens to load, and the agent opens a SQLite file in its state
 * directory on the first start; one `import { COLLOQ_VERSION }`, and every
 * machine is «устарел» after the next release that changed nothing they run.
 * So the graph is read from esbuild itself, with the very flags the server's
 * build uses, and the bundle is built twice under two versions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build, type BuildOptions, type Metafile, type Plugin } from 'esbuild'
import { REMOTE_BUILD_FILE, parseRemoteBuildFile } from '../shared/remote-runner.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const SERVER = path.join(ROOT, 'server')
/**
 * A node that runs the sources from any working directory: tsx by its own
 * path, and the root's tsconfig for the @shared alias (tsx looks for one in
 * the working directory, and the .env below needs that to be another).
 */
const TSX = ['--import', import.meta.resolve('tsx')]
const TSX_ENV = { TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json') }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-runner-graph-'))
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))

/* ------------------------------------------------------- what is forbidden */

/**
 * Modules the machine's agent must never load, each with the reason. Most of
 * what touches the database reaches it through db.ts or config.ts, so those
 * two catch the rest; the others are named because each fails in a way of its
 * own, and a path that skipped db.ts would still bring them.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['src/db.ts', 'opens the SQLite database when it loads, migrates it and starts the WAL checkpoint timer'],
  ['src/config.ts', 'reads .env from the working directory when it loads (dotenv), and without SESSION_SECRET writes a signing key into DATA_DIR'],
  ['src/kernel/pool.ts', 'the room kernel pool: the database, the rooms\' containers and the cards they hold'],
  ['src/kernel/resources.ts', 'prepares statements on the database when it loads (the rooms\' memory)'],
  ['src/kernel/runtime-client.ts', 'loads config.ts: the kernel backend of this server and the broker\'s client'],
  ['src/admin/settings.ts', 'reads the instance settings from the database, and installs the instance language as every tr()\'s when it loads'],
  ['src/competitions/settings.ts', 'the competition settings kept in the database'],
  ['src/competitions/store.ts', 'the competitions\' rows in the database'],
  ['src/competitions/capacity.ts', 'home\'s admission: the room census and the settings behind it'],
  ['src/competitions/gpu.ts', 'home\'s cards: KERNEL_GPUS, the owner\'s setting and the rooms that hold cards'],
  ['src/competitions/runner.ts', 'the queue\'s pump, which loads all of the above'],
  ['src/log.ts', 'patches console when it loads'],
  ['src/version.ts', 'inlines the release\'s version into the bundle: the machine\'s build would change with every release'],
]

/** Packages the agent must never import, by the same rule. */
const FORBIDDEN_PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ['better-sqlite3', 'the native SQLite binding: the database'],
  ['dotenv', 'reads .env'],
  ['dotenv/config', 'reads .env when it loads'],
]

/** What of the forbidden a graph holds, with the reasons; empty — nothing. */
function forbiddenIn(metafile: Metafile): string[] {
  const found: string[] = []
  for (const [file, why] of FORBIDDEN) if (file in metafile.inputs) found.push(`${file}: ${why}`)
  const packages = new Map(FORBIDDEN_PACKAGES)
  for (const [file, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) {
      const why = imported.external ? packages.get(imported.path) : undefined
      if (why) found.push(`${imported.path} (imported by ${file}): ${why}`)
    }
  }
  return found
}

/* ------------------------------------------------- the build, as it is made */

const buildScript = (): string => JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8')).scripts.build as string

/**
 * The esbuild command of the server's build that writes `outfile`, turned
 * into the options of esbuild's API: the test builds what the build builds,
 * and a flag added there is a flag added here.
 */
function buildEntry(outfile: string): { entry: string; options: BuildOptions } {
  const command = buildScript().split('&&').map((part) => part.trim()).find((part) => part.startsWith('esbuild ') && part.includes(`--outfile=${outfile}`))
  assert.ok(command, `the server's build has no esbuild entry that writes ${outfile}`)
  const [, entry, ...flags] = command.split(/\s+/)
  const options: Record<string, unknown> = {}
  for (const flag of flags) {
    const [key, value] = flag.replace(/^--/, '').split('=')
    if (key === 'outfile') continue
    options[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value ?? true
  }
  return { entry, options }
}

const RUNNER = buildEntry('dist/runner.js')

/**
 * The execution core the agent is to run notebooks with, as one entry: the
 * Docker runner (with the harness and the storage layout behind it), the GPU
 * arithmetic, the meminfo reader and the card probe. Each namespace is used,
 * so that none of it is shaken out of the bundle the version test hashes.
 */
const CORE = [
  "import * as dockerRunner from './competitions/docker-runner.js'",
  "import * as gpuMath from './competitions/gpu-math.js'",
  "import * as meminfo from './ops/meminfo.js'",
  "import * as cardProbe from './kernel/card-probe.js'",
  "import * as harness from './competitions/harness.js'",
  "import * as storage from './competitions/storage.js'",
  'console.log(dockerRunner, gpuMath, meminfo, cardProbe, harness, storage)',
].join('\n')

type Bundle = { metafile: Metafile; text: string; sha256: string }

/** One bundle in memory: `entry` is a file under server/ or a probe's source under server/src. */
async function bundle(entry: { file: string } | { source: string }, plugins: Plugin[] = []): Promise<Bundle> {
  const result = await build({
    ...RUNNER.options,
    ...('file' in entry
      ? { entryPoints: [entry.file] }
      : { stdin: { contents: entry.source, resolveDir: path.join(SERVER, 'src'), sourcefile: 'runner-probe.ts', loader: 'ts' as const } }),
    absWorkingDir: SERVER,
    outfile: path.join(scratch, 'bundle.js'),
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins,
  })
  const text = result.outputFiles[0]!.text
  return { metafile: result.metafile, text, sha256: createHash('sha256').update(text).digest('hex') }
}

/** Every package.json the bundle reads, served with this version: a release, as far as the bundle can tell. */
function releasedAs(version: string): Plugin {
  return {
    name: 'released-as',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]package\.json$/ }, (args) => ({
        contents: JSON.stringify({ ...JSON.parse(fs.readFileSync(args.path, 'utf8')), version }),
        loader: 'json',
      }))
    },
  }
}

/* -------------------------------------------------------------- the graph */

test('the agent\'s entry loads nothing of home\'s', async () => {
  const { metafile } = await bundle({ file: RUNNER.entry })
  assert.ok('src/runner-agent/main.ts' in metafile.inputs)
  assert.deepEqual(forbiddenIn(metafile), [])
})

test('the execution core loads no database, no room pool, no settings and no .env', async () => {
  const { metafile } = await bundle({ source: CORE })
  for (const file of ['src/competitions/docker-runner.ts', 'src/competitions/gpu-math.ts', 'src/ops/meminfo.ts', 'src/kernel/card-probe.ts', 'src/data-dir.ts']) {
    assert.ok(file in metafile.inputs, `${file} is not in the core's graph: the probe no longer reaches it`)
  }
  assert.deepEqual(forbiddenIn(metafile), [])
  // Nothing from outside but node itself: a package the core needed would be a package every machine needs.
  const external = new Set(Object.values(metafile.inputs).flatMap((input) => input.imports.filter((imported) => imported.external).map((imported) => imported.path)))
  assert.deepEqual([...external].filter((name) => !name.startsWith('node:')), [])
})

test('the check sees a forbidden module when there is one', async () => {
  // Home's own modules, which the core used to import: each brings the database.
  for (const file of ['src/competitions/gpu.ts', 'src/competitions/capacity.ts', 'src/kernel/resources.ts']) {
    const found = forbiddenIn((await bundle({ file })).metafile)
    assert.ok(found.some((line) => line.startsWith('src/db.ts')), `${file}: ${found.join('; ')}`)
  }
  assert.ok(forbiddenIn((await bundle({ source: "import './config.js'" })).metafile).some((line) => line.startsWith('dotenv/config')))
})

/* -------------------------------------------------------------- the build */

test('the agent\'s build is the same under two releases', async () => {
  for (const entry of [{ file: RUNNER.entry }, { source: CORE }]) {
    const [one, two] = await Promise.all([bundle(entry, [releasedAs('0.30.0')]), bundle(entry, [releasedAs('1.4.2')])])
    assert.equal(one.sha256, two.sha256, `${'file' in entry ? entry.file : 'the core'} changes with the release's version`)
    assert.ok(!one.text.includes('0.30.0'))
  }
  // The control: a bundle that does inline the version (version.ts) is told apart, so the equality above is not luck.
  const inlined = "import { COLLOQ_VERSION } from './version.js'\nconsole.log(COLLOQ_VERSION)"
  const [one, two] = await Promise.all([bundle({ source: inlined }, [releasedAs('0.30.0')]), bundle({ source: inlined }, [releasedAs('1.4.2')])])
  assert.notEqual(one.sha256, two.sha256)
})

test('the built agent reads its version beside dist/ when it runs, says it cannot work yet, and exits 2', async () => {
  const app = path.join(scratch, 'app')
  fs.mkdirSync(path.join(app, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@colloq/server', version: '9.8.7', type: 'module' }))
  await build({ ...RUNNER.options, entryPoints: [RUNNER.entry], absWorkingDir: SERVER, outfile: path.join(app, 'dist/runner.js'), logLevel: 'silent' })
  const ran = spawnSync(process.execPath, [path.join(app, 'dist/runner.js')], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, COLLOQ_VERSION: '1.1.1' } })
  assert.equal(ran.status, 2, ran.stderr)
  assert.equal(ran.stdout, '')
  // The package.json next to the code wins over the environment: it is the code's own.
  assert.match(ran.stderr, /^colloq-runner 9\.8\.7\n/)
  assert.match(ran.stderr, /cannot run submissions yet/)
  assert.equal(ran.stderr.trim().split('\n').length, 2)

  // The enrollment minter's stub refuses the same way, and prints no code: stdout is the code's alone.
  const minter = buildEntry('dist/runner-code.js')
  assert.equal(minter.entry, 'src/ops/runner-code.ts')
  await build({ ...minter.options, entryPoints: [minter.entry], absWorkingDir: SERVER, outfile: path.join(app, 'dist/runner-code.js'), logLevel: 'silent' })
  const minted = spawnSync(process.execPath, [path.join(app, 'dist/runner-code.js'), '--machines', '2', '--hours', '3'], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(minted.status, 2, minted.stderr)
  assert.equal(minted.stdout, '')
  assert.match(minted.stderr, /cannot mint enrollment codes yet/)
})

test('the server\'s build writes the agent, the minter and the agent\'s sha256, in that order', () => {
  const steps = buildScript().split('&&').map((part) => part.trim())
  const at = (pattern: RegExp): number => steps.findIndex((step) => pattern.test(step))
  const agent = at(/^esbuild src\/runner-agent\/main\.ts .*--outfile=dist\/runner\.js$/)
  const minter = at(/^esbuild src\/ops\/runner-code\.ts .*--outfile=dist\/runner-code\.js$/)
  const hash = at(/^node scripts\/runner-sha256\.mjs$/)
  assert.ok(agent >= 0 && minter >= 0 && hash >= 0, steps.join('\n'))
  assert.ok(hash > agent, 'the hash is written before the bundle it hashes')
  // The image's build stage copies server/ and not the root's scripts/: the helper must live in server/.
  assert.ok(fs.existsSync(path.join(SERVER, 'scripts/runner-sha256.mjs')))
  // Node 22 is the image's: the agent is built for it, not for the server's node20 floor.
  assert.equal(RUNNER.options.target, 'node22')
  assert.equal(RUNNER.options.packages, 'external')
})

test('the build file holds the bundle\'s sha256 as sha256sum prints it', () => {
  const dist = path.join(scratch, 'hash-dist')
  fs.mkdirSync(dist, { recursive: true })
  const body = '// a bundle\nconsole.log(1)\n'
  fs.writeFileSync(path.join(dist, 'runner.js'), body)
  const ran = spawnSync(process.execPath, [path.join(SERVER, 'scripts/runner-sha256.mjs'), dist], { encoding: 'utf8' })
  assert.equal(ran.status, 0, ran.stderr)
  const written = fs.readFileSync(path.join(dist, REMOTE_BUILD_FILE), 'utf8')
  const digest = createHash('sha256').update(body).digest('hex')
  assert.equal(written, `${digest}  runner.js\n`)
  assert.equal(parseRemoteBuildFile(written), digest)
})

/* ----------------------------------------------------- what loading does */

/**
 * The core in a process of its own, loaded and nothing else: what it did to
 * the process and to the disk by loading. A .env of a home lies in the working
 * directory, as it does when an agent is started from a checkout, and names
 * another data directory and a marker.
 */
test('loading the core reads no .env, writes nothing, registers no handler, patches no console and holds no timer', () => {
  const dir = path.join(scratch, 'loading')
  const dataDir = path.join(dir, 'machine-data')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.env'), `DATA_DIR=${path.join(dir, 'home-data')}\nCOLLOQ_HOME_MARKER=1\n`)
  const url = (file: string) => JSON.stringify(new URL(`../server/src/${file}`, import.meta.url).href)
  const script = `
    const events = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']
    const listeners = () => events.map((name) => process.listenerCount(name))
    const before = { listeners: listeners(), log: console.log, warn: console.warn }
    const storage = await import(${url('competitions/storage.ts')})
    for (const file of [${['competitions/docker-runner.ts', 'competitions/gpu-math.ts', 'ops/meminfo.ts', 'kernel/card-probe.ts', 'competitions/harness.ts', 'runner-agent/version.ts'].map(url).join(', ')}]) await import(file)
    const fs = await import('node:fs')
    process.stdout.write(JSON.stringify({
      listeners: String(listeners()) === String(before.listeners),
      console: console.log === before.log && console.warn === before.warn,
      marker: process.env.COLLOQ_HOME_MARKER ?? null,
      competitionsDir: storage.competitionsDir,
      wrote: fs.existsSync(process.env.DATA_DIR),
    }))
  `
  const env: NodeJS.ProcessEnv = { ...process.env, ...TSX_ENV, DATA_DIR: dataDir }
  delete env.SESSION_SECRET
  // No process.exit in the script: a timer the core left running would keep it alive past the deadline.
  const ran = spawnSync(process.execPath, [...TSX, '--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(ran.status, 0, ran.stderr || String(ran.error))
  assert.deepEqual(JSON.parse(ran.stdout), {
    listeners: true,
    console: true,
    marker: null,
    competitionsDir: path.join(dataDir, 'competitions'),
    wrote: false,
  })
})

test('home still reads a DATA_DIR written only in .env: config.ts loads dotenv before the data directory is fixed', () => {
  const dir = path.join(scratch, 'home-env')
  const fromEnvFile = path.join(dir, 'data-from-env-file')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.env'), `DATA_DIR=${fromEnvFile}\n`)
  const url = (file: string) => JSON.stringify(new URL(`../server/src/${file}`, import.meta.url).href)
  const script = `
    const { config } = await import(${url('config.ts')})
    const { dataDir } = await import(${url('data-dir.ts')})
    const { competitionsDir } = await import(${url('competitions/storage.ts')})
    process.stdout.write(JSON.stringify({ config: config.dataDir, dataDir, competitionsDir }))
    process.exit(0)
  `
  const env: NodeJS.ProcessEnv = { ...process.env, ...TSX_ENV, SESSION_SECRET: 'test' }
  delete env.DATA_DIR
  const ran = spawnSync(process.execPath, [...TSX, '--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(ran.status, 0, ran.stderr)
  assert.deepEqual(JSON.parse(ran.stdout), { config: fromEnvFile, dataDir: fromEnvFile, competitionsDir: path.join(fromEnvFile, 'competitions') })
})

/** The server's own graph, built once for the tests below. */
let server: Promise<Bundle> | null = null
const serverGraph = (): Promise<Bundle> => (server ??= bundle({ file: 'src/index.ts' }))

/**
 * The same rule for the server as a whole: in the order node evaluates its
 * modules, dotenv runs before anything reaches data-dir.ts. The bundle hoists
 * the dotenv import above all its code anyway; this is the order under tsx
 * (make dev), and the one a module imported early by index.ts would break.
 */
test('in the server\'s own load order dotenv runs before the data directory is read', async () => {
  const { metafile } = await serverGraph()
  const events: string[] = []
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    events.push(`enter ${file}`)
    for (const imported of metafile.inputs[file]?.imports ?? []) {
      if (imported.kind !== 'import-statement') continue
      if (!imported.external) visit(imported.path)
      else if (!seen.has(imported.path)) {
        seen.add(imported.path)
        events.push(`load ${imported.path}`)
      }
    }
  }
  visit('src/index.ts')
  const dotenv = events.indexOf('load dotenv/config')
  const dataDir = events.indexOf('enter src/data-dir.ts')
  assert.ok(dotenv >= 0 && dataDir >= 0, 'the server no longer loads dotenv or data-dir.ts')
  assert.ok(dotenv < dataDir, `data-dir.ts is reached before dotenv has run, by: ${events.slice(0, dataDir + 1).filter((event) => event.startsWith('enter')).slice(-4).join(' → ')}`)
})

/**
 * The other half of the core's freedom: the Docker runner no longer reaches
 * for home's memory, so the server must hand it over, and capacity.ts does so
 * when it loads (docker-runner.ts · provideMachineMemory). A server that
 * stopped loading it would admit submissions without weighing memory, with
 * one line in the log to say so.
 */
test('the server loads capacity.ts, which hands the Docker runner the memory it reports', async () => {
  const { metafile } = await serverGraph()
  const capacity = metafile.inputs['src/competitions/capacity.ts']
  assert.ok(capacity, 'the server no longer loads competitions/capacity.ts')
  assert.ok(capacity.imports.some((imported) => imported.path === 'src/competitions/docker-runner.ts'))
  assert.match(fs.readFileSync(path.join(SERVER, 'src/competitions/capacity.ts'), 'utf8'), /^provideMachineMemory\(competitionMemory\)$/m)
})
