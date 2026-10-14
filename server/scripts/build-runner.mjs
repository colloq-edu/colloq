// The build of the machines that run submissions: dist/runner.js, bundled
// through esbuild's API with the UI's translations swapped out, and then
// dist/runner.sha256 beside it (server/package.json · build).
//
// WHY A SCRIPT AND NOT ONE MORE esbuild LINE. The sha256 of the bundle is the
// machine's build, which home compares with its own copy before it hands the
// machine work (shared/remote-runner.ts · remoteCompatible, the owner's
// decision 5), so what changes with every release must not be in it, or every
// release idles the fleet (docs/architecture/remote-runners.md §8.4). The
// execution core the agent runs reaches shared/i18n.ts through `tr`, and that
// module registers every catalogue of the UI when it loads, some 1.6 MB of
// strings: one edit of a button's label anywhere, and every machine would be
// «устарела» (§13, note 9). esbuild's command line cannot put one module in
// another's place; a plugin can, and a plugin needs the API. The flags are the
// command line's, as the other entries of the build pass them.
//
// WHAT THE PLUGIN DOES (withoutTranslations). Every import that lands on
// shared/i18n.ts, `@shared/i18n` from server/src and './i18n.js' from shared/
// alike, lands on server/src/runner-agent/i18n-shim.ts instead, whose `tr`
// gives a marker home renders in its own language (remoteTextMarker,
// remoteRenderTexts). It goes by where an import lands, not by how it is
// spelled, so a third spelling is caught too. And a build that would still
// load shared/i18n.ts, or anything under shared/locales/, fails instead of
// shipping the catalogues quietly. tests/runner-import-graph.test.mts builds
// the agent and the core through it, holds the graph free of both and the hash
// unchanged when a catalogue changes.
//
// THE HASH is written by runner-sha256.mjs, run as the build ran it before and
// only once the bundle is on disk: one definition of the file's format, which
// parseRemoteBuildFile and the image's guard (deploy/vast/Dockerfile) read.
//
// Plain JavaScript beside src/, like runner-sha256.mjs: the image's build stage
// runs it with bare node, and the root's scripts/ is not copied there.
//
//   node scripts/build-runner.mjs [DIST]
//
// writes DIST/runner.js and DIST/runner.sha256; DIST, for tests, is by default
// the dist/ next to this folder, as for runner-sha256.mjs. Imported, the
// module builds nothing, and lends the tests its options and its plugin.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))

/** server/: the working directory the entry is named from, as the command line's under `npm run build -w @colloq/server`. */
export const SERVER = path.resolve(SCRIPTS, '..')
const SHARED = path.resolve(SERVER, '..', 'shared')

/** The module kept out of the bundle, the catalogues it registers, and what stands in its place. */
export const I18N = path.join(SHARED, 'i18n.ts')
export const LOCALES = path.join(SHARED, 'locales')
export const I18N_SHIM = path.join(SERVER, 'src', 'runner-agent', 'i18n-shim.ts')

export const RUNNER_ENTRY = 'src/runner-agent/main.ts'
export const RUNNER_BUNDLE = 'runner.js'

/**
 * `--bundle --platform=node --format=esm --target=node22 --packages=external`,
 * as the build's other node22 entries pass them: Node 22 is the image's, and
 * nothing a machine would have to install goes into the bundle.
 * @type {Readonly<import('esbuild').BuildOptions>}
 */
export const RUNNER_OPTIONS = Object.freeze({ bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' })

/** What the plugin passes to its own resolve, so that its callback stays out of it. */
const RESOLVING = Object.freeze({ resolving: 'colloq-runner-i18n' })

/** A file's real path: a checkout reached through a symbolic link must compare as itself. */
function real(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

const samePath = (a, b) => path.resolve(a) === path.resolve(b) || real(a) === real(b)
const inside = (file, dir) => {
  const relative = path.relative(real(dir), real(file))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * The plugin: shared/i18n.ts resolved to the shim, and the build refused if
 * the dictionaries are loaded all the same. Only an import whose spelling
 * names i18n is asked about (the filter), and it is resolved as esbuild would
 * resolve it, the tsconfig's @shared alias included, before its target is
 * compared.
 * @returns {import('esbuild').Plugin}
 */
export function withoutTranslations() {
  return {
    name: 'colloq-runner-without-translations',
    setup(builder) {
      builder.onResolve({ filter: /i18n/ }, async (args) => {
        if (args.pluginData === RESOLVING) return undefined
        const found = await builder.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: RESOLVING })
        // Anything else, an import that does not resolve included, is esbuild's as usual.
        return found.errors.length === 0 && samePath(found.path, I18N) ? { path: I18N_SHIM } : undefined
      })
      builder.onLoad({ filter: /[\\/]i18n\.ts$|[\\/]locales[\\/]/ }, (args) => {
        if (!samePath(args.path, I18N) && !inside(args.path, LOCALES)) return undefined
        return {
          errors: [{
            text: `${path.relative(SERVER, args.path)} is in the runner's bundle: the machines' build would carry the UI's catalogues, `
              + 'and change with every text edited in them (server/scripts/build-runner.mjs)',
          }],
        }
      })
    },
  }
}

/**
 * dist/runner.js and then, only once it is written, dist/runner.sha256 of it.
 * `dist` is taken from the working directory, as runner-sha256.mjs takes it,
 * and made absolute before either sees it: esbuild would read a relative one
 * from server/ instead, and the hash would be of some other directory's file.
 * @param {string} dist
 * @param {{ logLevel?: import('esbuild').LogLevel }} [options]
 */
export async function buildRunner(dist, { logLevel = 'info' } = {}) {
  const out = path.resolve(dist)
  await build({
    ...RUNNER_OPTIONS,
    entryPoints: [RUNNER_ENTRY],
    absWorkingDir: SERVER,
    outfile: path.join(out, RUNNER_BUNDLE),
    plugins: [withoutTranslations()],
    logLevel,
  })
  const hashed = spawnSync(process.execPath, [path.join(SCRIPTS, 'runner-sha256.mjs'), out], { stdio: 'inherit' })
  if (hashed.status !== 0) {
    throw new Error(`runner-sha256.mjs ${hashed.error ? `did not start: ${hashed.error.message}` : `failed (${hashed.status ?? hashed.signal})`}`)
  }
}

// Run, not imported: by the real path on both sides, or a checkout reached
// through a link would skip the build and leave last time's bundle in place.
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  buildRunner(process.argv[2] ?? path.join(SERVER, 'dist')).catch((error) => {
    // esbuild has printed its own errors already; the others have only their message.
    if (!Array.isArray(error?.errors)) console.error(`build-runner: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
