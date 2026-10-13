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
 * So the graph is read from esbuild itself, with the very options and plugin
 * the server's build uses (server/scripts/build-runner.mjs), and the bundle is
 * built twice under two versions.
 *
 * The UI's dictionaries are the same rule for texts: the core reaches
 * shared/i18n.ts through `tr`, and that module brings every catalogue, 1.6 MB
 * of strings any release may reword. The runner's build puts a shim in its
 * place whose `tr` leaves a marker for home to say in its own language
 * (shared/remote-runner.ts · remoteTextMarker, remoteRenderTexts), so the
 * graph is held free of the catalogues, the bundle to its size, its hash to a
 * reworded catalogue, and the texts the core makes on a machine to the words
 * home says for them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build, type BuildOptions, type Metafile, type Plugin } from 'esbuild'
import { REMOTE_BUILD_FILE, REMOTE_TEXT_KEY, REMOTE_TEXT_OPEN, parseRemoteBuildFile, remoteRenderTexts, remoteTextMarker } from '../shared/remote-runner.ts'
import { hasTranslation, messages, translate } from '../shared/i18n.ts'
import { I18N_SHIM, RUNNER_ENTRY, RUNNER_OPTIONS, buildRunner, withoutTranslations } from '../server/scripts/build-runner.mjs'

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
  ['../shared/i18n.ts', 'registers every catalogue of the UI when it loads: the machine\'s build would change with every text reworded (build-runner.mjs puts the shim in its place)'],
]

/** Directories the agent must never load a file from, by the same rule. */
const FORBIDDEN_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['../shared/locales/', 'the UI\'s catalogues: 1.6 MB of strings any release may reword, in the machine\'s build'],
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
  for (const [dir, why] of FORBIDDEN_DIRS) {
    for (const file of Object.keys(metafile.inputs)) if (file.startsWith(dir)) found.push(`${file}: ${why}`)
  }
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
 * and a flag added there is a flag added here. The agent's own entry is not
 * one of these: build-runner.mjs builds it, and lends its options (below).
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

/** The agent's entry and options, from the script the server's build runs for it (server/scripts/build-runner.mjs). */
const RUNNER: { entry: string; options: BuildOptions } = { entry: RUNNER_ENTRY, options: RUNNER_OPTIONS }

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

/** One bundle as the runner's build makes it: shared/i18n.ts swapped for the shim (build-runner.mjs · withoutTranslations). */
const runnerBundle = (entry: { file: string } | { source: string }, plugins: Plugin[] = []): Promise<Bundle> =>
  bundle(entry, [withoutTranslations(), ...plugins])

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
  const { metafile } = await runnerBundle({ file: RUNNER.entry })
  assert.ok('src/runner-agent/main.ts' in metafile.inputs)
  assert.deepEqual(forbiddenIn(metafile), [])
})

test('the execution core loads no database, no room pool, no settings and no .env', async () => {
  const { metafile } = await runnerBundle({ source: CORE })
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
    const [one, two] = await Promise.all([runnerBundle(entry, [releasedAs('0.30.0')]), runnerBundle(entry, [releasedAs('1.4.2')])])
    assert.equal(one.sha256, two.sha256, `${'file' in entry ? entry.file : 'the core'} changes with the release's version`)
    assert.ok(!one.text.includes('0.30.0'))
  }
  // The control: a bundle that does inline the version (version.ts) is told apart, so the equality above is not luck.
  const inlined = "import { COLLOQ_VERSION } from './version.js'\nconsole.log(COLLOQ_VERSION)"
  const [one, two] = await Promise.all([runnerBundle({ source: inlined }, [releasedAs('0.30.0')]), runnerBundle({ source: inlined }, [releasedAs('1.4.2')])])
  assert.notEqual(one.sha256, two.sha256)
})

test('the built agent reads its version beside dist/ when it runs, says it cannot work yet, and exits 2', async () => {
  const app = path.join(scratch, 'app')
  fs.mkdirSync(path.join(app, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@colloq/server', version: '9.8.7', type: 'module' }))
  await buildRunner(path.join(app, 'dist'), { logLevel: 'silent' })
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

test('the server\'s build writes the agent and its sha256 through build-runner.mjs, and the minter', () => {
  const steps = buildScript().split('&&').map((part) => part.trim())
  const at = (pattern: RegExp): number => steps.findIndex((step) => pattern.test(step))
  const agent = at(/^node scripts\/build-runner\.mjs$/)
  const minter = at(/^esbuild src\/ops\/runner-code\.ts .*--outfile=dist\/runner-code\.js$/)
  assert.ok(agent >= 0 && minter >= 0, steps.join('\n'))
  // Nothing else writes either: an esbuild line for the agent would bundle the catalogues, and a hash taken
  // apart from the script could be taken of another bundle than the one the image ships.
  assert.deepEqual(steps.filter((step) => /--outfile=dist\/runner\.js(?:\s|$)/.test(step) || step.includes('runner-sha256')), [])
  // The image's build stage copies server/ and not the root's scripts/: both helpers must live in server/.
  for (const script of ['scripts/build-runner.mjs', 'scripts/runner-sha256.mjs']) assert.ok(fs.existsSync(path.join(SERVER, script)), script)
  // Node 22 is the image's: the agent is built for it, not for the server's node20 floor, with the flags its
  // esbuild line had (--bundle --platform=node --format=esm --target=node22 --packages=external) and no other.
  assert.equal(RUNNER.options.target, 'node22')
  assert.equal(RUNNER.options.packages, 'external')
  assert.deepEqual({ ...RUNNER.options }, { bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' })
})

test('build-runner.mjs writes the bundle and then its sha256 into the directory it is given, and fails with esbuild', async () => {
  const dist = path.join(scratch, 'script-dist')
  const ran = spawnSync(process.execPath, [path.join(SERVER, 'scripts/build-runner.mjs'), dist], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(ran.status, 0, ran.stderr)
  assert.deepEqual(fs.readdirSync(dist).sort(), ['runner.js', REMOTE_BUILD_FILE])
  const written = fs.readFileSync(path.join(dist, REMOTE_BUILD_FILE), 'utf8')
  const digest = createHash('sha256').update(fs.readFileSync(path.join(dist, 'runner.js'))).digest('hex')
  // As runner-sha256.mjs writes it: the digest, two spaces and the name, the way sha256sum -c reads it.
  assert.equal(written, `${digest}  runner.js\n`)
  assert.equal(parseRemoteBuildFile(written), digest)
  // The bundle on disk is the one these tests read: the runner's options and plugin, and nothing else.
  assert.equal((await runnerBundle({ file: RUNNER.entry })).sha256, digest)

  // A build that fails stops the server's build, and leaves no hash behind it.
  const blocked = path.join(scratch, 'not-a-directory')
  fs.writeFileSync(blocked, '')
  const failed = spawnSync(process.execPath, [path.join(SERVER, 'scripts/build-runner.mjs'), path.join(blocked, 'dist')], { encoding: 'utf8', timeout: 60_000 })
  assert.notEqual(failed.status, 0, failed.stderr)
  assert.equal(fs.existsSync(path.join(blocked, 'dist', REMOTE_BUILD_FILE)), false)
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

/* -------------------------------------------------------- the translations */

/** Whatever of the dictionaries a graph holds: shared/i18n.ts itself and the catalogues under shared/locales/. */
const dictionariesIn = (metafile: Metafile): string[] =>
  Object.keys(metafile.inputs).filter((file) => file === '../shared/i18n.ts' || file.startsWith('../shared/locales/'))

const MiB = 1024 * 1024
const SHIM = path.relative(SERVER, I18N_SHIM)

test('the runner\'s build carries no dictionaries: the shim stands where shared/i18n.ts would, and the bundle stays small', async () => {
  for (const entry of [{ file: RUNNER.entry }, { source: CORE }]) {
    const what = 'file' in entry ? entry.file : 'the core'
    const built = await runnerBundle(entry)
    assert.deepEqual(dictionariesIn(built.metafile), [], `${what} carries the UI's catalogues`)
    assert.ok(Buffer.byteLength(built.text) < MiB, `${what}: ${Buffer.byteLength(built.text)} bytes`)
  }
  // The core does reach the translations, through the shim alone, under either spelling the core uses:
  // `@shared/i18n` from server/src, './i18n.js' from shared/.
  const { metafile } = await runnerBundle({ source: CORE })
  assert.ok(SHIM in metafile.inputs, 'the core no longer says anything through tr: the shim is not in its graph')
  const spoken = Object.entries(metafile.inputs).flatMap(([file, input]) => input.imports
    .filter((imported) => /(?:^|[/@])i18n(?:\.[jt]s)?$/.test(imported.original ?? ''))
    .map((imported) => ({ file, original: imported.original, path: imported.path })))
  assert.ok(spoken.some((i) => i.original === '@shared/i18n') && spoken.some((i) => i.original === './i18n.js'), JSON.stringify(spoken))
  for (const i of spoken) assert.equal(i.path, SHIM, `${i.file} imports ${i.original} from ${i.path}`)
  // The control: built as home builds it, the same core holds every catalogue and is past the cap.
  const home = await bundle({ source: CORE })
  assert.ok(dictionariesIn(home.metafile).includes('../shared/i18n.ts'))
  assert.ok(dictionariesIn(home.metafile).some((file) => file.startsWith('../shared/locales/')))
  assert.ok(Buffer.byteLength(home.text) > MiB, `the control is ${Buffer.byteLength(home.text)} bytes`)
})

test('a UI text reworded in a catalogue leaves the runner\'s build as it was', async () => {
  // A catalogue served with its first English text reworded, as a release that only touched a screen ships it.
  // The real file is read, never written.
  let reworded = 0
  const rewording: Plugin = {
    name: 'reworded-catalogue',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]shared[\\/]locales[\\/]competitions\.ts$/ }, (args) => {
        const original = fs.readFileSync(args.path, 'utf8')
        const contents = original.replace(/\ben: '/, "en: 'Reworded: ")
        assert.notEqual(contents, original, 'the catalogue has no English text to reword')
        reworded++
        return { contents, loader: 'ts' }
      })
    },
  }
  for (const entry of [{ file: RUNNER.entry }, { source: CORE }]) {
    const [as, edited] = await Promise.all([runnerBundle(entry), runnerBundle(entry, [rewording])])
    assert.equal(as.sha256, edited.sha256, `${'file' in entry ? entry.file : 'the core'} changes with a UI text`)
  }
  assert.equal(reworded, 0, 'the runner\'s build read a catalogue')
  // The control: built as home builds it, the same edit is another bundle, so the equality above is the shim's doing.
  const [home, edited] = await Promise.all([bundle({ source: CORE }), bundle({ source: CORE }, [rewording])])
  assert.ok(reworded > 0)
  assert.notEqual(home.sha256, edited.sha256)
  assert.ok(edited.text.includes('Reworded: '))
})

test('the runner\'s build swaps shared/i18n.ts however an import spells it, and refuses a catalogue imported on its own', async () => {
  for (const spelling of ['@shared/i18n', '@shared/i18n.js', '../../shared/i18n.js', '../../shared/i18n.ts', '../../shared/i18n']) {
    const { metafile, text } = await runnerBundle({ source: `import { tr } from '${spelling}'\nconsole.log(tr('competitions.answer.gpuNeverRead'))` })
    assert.ok(SHIM in metafile.inputs, spelling)
    assert.deepEqual(dictionariesIn(metafile), [], spelling)
    for (const locale of ['ru', 'en'] as const) {
      assert.ok(!text.includes(translate(locale, 'competitions.answer.gpuNeverRead')), `${spelling}: the ${locale} text is in the bundle`)
    }
  }
  // A catalogue reached some other way fails the build, rather than ride in it unnoticed.
  await assert.rejects(
    runnerBundle({ source: "import { competitionsMessages } from '@shared/locales/competitions'\nconsole.log(competitionsMessages)" }),
    (error: unknown) => /shared\/locales\/competitions\.ts is in the runner's bundle/.test(String((error as Error)?.message)),
  )
})

/**
 * Every key the core can say on a machine, read off the sources of its graph.
 * Each must be one a marker carries (REMOTE_TEXT_KEY), or home shows the key
 * and its JSON where a sentence should be, and one home has words for, or home
 * shows the bare key. A key built from a template stands for every catalogue
 * key of its shape.
 */
test('every key the runner\'s core says is one a marker carries and home has words for', async () => {
  const { metafile } = await runnerBundle({ source: CORE })
  const said = new Map<string, string>()
  for (const file of Object.keys(metafile.inputs)) {
    if (file === SHIM || !file.endsWith('.ts') || !fs.existsSync(path.join(SERVER, file))) continue
    const source = fs.readFileSync(path.join(SERVER, file), 'utf8')
    for (const match of source.matchAll(/\btr\(\s*(['"`])((?:(?!\1)[^\\\n])*)\1/g)) said.set(match[2]!, file)
  }
  assert.ok([...said.values()].includes('src/competitions/docker-runner.ts'), 'the scan no longer finds the Docker runner\'s words')
  const catalogue = Object.keys(messages)
  for (const [key, file] of said) {
    const parts = key.split(/\$\{[^}]*\}/)
    const shape = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`)
    const keys = parts.length === 1 ? [key] : catalogue.filter((known) => shape.test(known))
    assert.ok(keys.length > 0, `${file}: tr(\`${key}\`) names no key home has`)
    for (const one of keys) {
      assert.match(one, REMOTE_TEXT_KEY, `${file}: ${one}`)
      assert.ok(hasTranslation(one), `${file}: home has no words for ${one}`)
    }
  }
})

test('the shim has the runtime\'s exports, and knows no word in any language', async () => {
  const shim = await import('../server/src/runner-agent/i18n-shim.ts')
  const runtime = await import('../shared/i18n-runtime.ts')
  // tsc holds the signatures equal (i18n-shim.ts · ShimMatchesRuntime); here, the names a bundle links against.
  assert.deepEqual(Object.keys(shim).sort(), Object.keys(runtime).sort())
  for (const name of Object.keys(runtime)) {
    assert.equal(typeof (shim as Record<string, unknown>)[name], typeof (runtime as Record<string, unknown>)[name], name)
  }
  // tr and translate give the marker home renders, whatever locale they are asked for.
  assert.equal(shim.tr('competitions.answer.gpuUnread', { count: 3 }), remoteTextMarker('competitions.answer.gpuUnread', { count: 3 }))
  assert.equal(shim.translate('en', 'competitions.answer.gpuNeverRead'), remoteTextMarker('competitions.answer.gpuNeverRead'))
  assert.equal(shim.translate('ru', 'competitions.answer.gpuNeverRead', {}), shim.tr('competitions.answer.gpuNeverRead'))
  // Nothing is kept: no catalogue, no language.
  shim.registerMessages({ 'competitions.answer.gpuNeverRead': { ru: 'слово', en: 'word' } })
  shim.setLocaleResolver(() => 'en')
  assert.deepEqual(shim.messages, {})
  assert.equal(shim.hasTranslation('competitions.answer.gpuNeverRead'), false)
  assert.equal(shim.getLocale(), shim.DEFAULT_LOCALE)
  assert.equal(shim.tr('competitions.answer.gpuNeverRead'), remoteTextMarker('competitions.answer.gpuNeverRead'))
  assert.equal(shim.normalizeLocale('de'), 'ru')
  assert.equal(shim.isLocale('en'), true)
  // The formatters: no catalogue, one locale, and no grouping comma that a Russian reader takes for a decimal one.
  assert.equal(shim.formatNumber(1234.5, { maximumFractionDigits: 1 }), '1234.5')
  assert.equal(shim.formatNumber(1_234_567), '1234567')
  assert.equal(shim.formatNumber(1_234_567, { useGrouping: true }), '1,234,567')
  assert.equal(shim.formatDate('not a date'), '—')
  assert.equal(shim.formatDate(Date.UTC(2026, 9, 14, 12), { dateStyle: 'medium', timeZone: 'UTC' }), 'Oct 14, 2026')
  assert.equal(shim.formatRelativeTime(-1, 'day'), 'yesterday')
})

/**
 * The two ends together, with nothing in between that is not the real thing:
 * the core bundled as the agent bundles it and run where nothing of home is,
 * and home's own words for the same runs from the sources, with the real
 * dictionaries. unreadCardNotes nests one `tr` in another's param when the
 * card never answered, and joins two side by side when it never answered at
 * all.
 */
test('what the core says on a machine reads on home as home says it, in home\'s language', async () => {
  const cases = [
    { device: 'GPU-0b1c2d3e', sliceMb: 6141, failures: 3, lastFailure: null, answered: true },
    { device: '1', sliceMb: 12282, failures: 4, lastFailure: 'Failed to initialize NVML: Unknown Error', answered: false },
  ]
  const probe = `import { unreadCardNotes } from './competitions/docker-runner.js'\n`
    + `process.stdout.write(JSON.stringify(${JSON.stringify(cases)}.map((input) => unreadCardNotes(input))))\n`
  const machine = path.join(scratch, 'machine-texts.mjs')
  fs.writeFileSync(machine, (await runnerBundle({ source: probe })).text)
  const ran = spawnSync(process.execPath, [machine], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DATA_DIR: path.join(scratch, 'machine-texts-data') } })
  assert.equal(ran.status, 0, ran.stderr)
  const said = JSON.parse(ran.stdout) as Array<{ participant: string | null; teacher: string }>
  // Every text left the machine as markers, in no language at all.
  for (const text of said.flatMap((notes) => [notes.participant, notes.teacher])) {
    if (text === null) continue
    assert.ok(text.startsWith(REMOTE_TEXT_OPEN), text)
    assert.doesNotMatch(text, /[А-Яа-яЁё]/)
  }

  const url = (file: string) => JSON.stringify(new URL(`../${file}`, import.meta.url).href)
  const script = `
    const { setLocaleResolver } = await import(${url('shared/i18n.ts')})
    const { unreadCardNotes } = await import(${url('server/src/competitions/docker-runner.ts')})
    const words = {}
    for (const locale of ['ru', 'en']) {
      setLocaleResolver(() => locale)
      words[locale] = ${JSON.stringify(cases)}.map((input) => unreadCardNotes(input))
    }
    process.stdout.write(JSON.stringify(words))
  `
  const homeRan = spawnSync(process.execPath, [...TSX, '--input-type=module', '-e', script], {
    cwd: scratch, env: { ...process.env, ...TSX_ENV, DATA_DIR: path.join(scratch, 'home-texts-data') }, encoding: 'utf8', timeout: 60_000,
  })
  assert.equal(homeRan.status, 0, homeRan.stderr)
  const home = JSON.parse(homeRan.stdout) as Record<'ru' | 'en', typeof said>
  for (const locale of ['ru', 'en'] as const) {
    const render = (key: string, params: Record<string, string | number>): string => translate(locale, key, params)
    const read = (text: string | null): string | null => (text === null ? null : remoteRenderTexts(text, render, hasTranslation))
    assert.deepEqual(said.map((notes) => ({ participant: read(notes.participant), teacher: read(notes.teacher) })), home[locale], locale)
  }
  assert.notDeepEqual(home.ru, home.en)
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
