/**
 * The version a machine's agent reports about itself (its facts at join, its
 * log lines), read when it runs and never inlined into the bundle.
 *
 * WHY NOT ../version.ts. That one is a JSON import of the root package.json,
 * which esbuild inlines into whatever bundle imports it, and the sha256 of
 * dist/runner.js IS the machine's build: what home compares with its own copy
 * of the same file to decide whether the machine may take new work
 * (shared/remote-runner.ts · remoteCompatible, the owner's decision 5). A
 * version inlined there would change that hash with every release, and a
 * release that touches nothing a run depends on — the panel, the docs, home's
 * own logic — would idle the whole fleet until `make runners-update`
 * (docs/architecture/remote-runners.md §8.4, §13 note 4).
 * tests/runner-import-graph.test.mts builds the agent under two versions and
 * holds the two hashes equal.
 *
 * So the number comes from the package.json that travels with the code: the
 * nearest one above this module, which is server/package.json next to dist/
 * in the image (/opt/colloq/server in colloq-vast, /app in colloq-server), in
 * the wheel and in a checkout — scripts/version.mts keeps it equal to the
 * root's, and release-please bumps both. COLLOQ_VERSION from the environment
 * when no package.json says (the colloq-vast image sets it as well), and
 * otherwise a version that is plainly no release. Each must have the shape
 * the contract accepts in a machine's facts (REMOTE_VERSION), or it is passed
 * over: a version home refuses to parse would refuse the machine with it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REMOTE_VERSION } from '@shared/remote-runner'

/** What is reported when nothing says better: accepted by the contract, and no release's. */
export const UNKNOWN_RUNNER_VERSION = '0.0.0-dev'

/**
 * How many directories up package.json is looked for: dist/runner.js sits one
 * level under server/, this file two (src/runner-agent/). A little more for a
 * layout of someone else's, never the whole disk.
 */
const LEVELS = 4

/**
 * The agent's version now. `from` is the directory to start from (this
 * module's own by default) and `env` the environment, both for tests.
 */
export function runnerVersion(options: { from?: string; env?: NodeJS.ProcessEnv } = {}): string {
  let dir = options.from ?? path.dirname(fileURLToPath(import.meta.url))
  for (let level = 0; level < LEVELS; level++) {
    const said = versionIn(path.join(dir, 'package.json'))
    if (said !== null) return said
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const named = (options.env ?? process.env).COLLOQ_VERSION?.trim() ?? ''
  return REMOTE_VERSION.test(named) ? named : UNKNOWN_RUNNER_VERSION
}

/** The version a package.json names, if it is one the contract accepts; `null` — no file, no JSON, or no such version. */
function versionIn(file: string): string | null {
  try {
    const version: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))?.version
    return typeof version === 'string' && REMOTE_VERSION.test(version) ? version : null
  } catch {
    return null
  }
}
