/**
 * Colloq's version: one number and all its copies.
 *
 *   node --import tsx scripts/version.mts current
 *   node --import tsx scripts/version.mts check [--tag vX.Y.Z]
 *   node --import tsx scripts/version.mts sync [--dry-run]
 *   make version
 *
 * There is one source: the "version" field of the root package.json. Everything
 * else is a copy of it, and every copy has a reason to exist, so they cannot be
 * removed, only kept equal:
 *
 *   · package.json of the workspaces and of shared/ — npm requires the field in
 *     each, and `colloq --version` in a working copy reads cli/package.json
 *     specifically;
 *   · package-lock.json — it records the versions of the root and of every
 *     workspace, and `npm ci` checks the lock against the manifests;
 *   · python/colloq/_version.py — hatchling takes the wheel version from it, and
 *     the sdist, which is built without node, needs it as well;
 *   · .release-please-manifest.json — the last released version, for
 *     release-please.
 *
 * Only release-please bumps the number (.github/workflows/release-please.yml):
 * it maintains the release PR, and in that PR it edits every copy at once —
 * the ones release-type node knows about (package.json, the lock root) and the
 * ones listed in extra-files of release-please-config.json. This script bumps
 * nothing. It checks the copies and replays release-please's edit ahead of
 * time, offline (simulateRelease): a copy that release-please would not touch
 * would drift from the root right in the release PR, and CI would fail it only
 * after the owner had decided to release. This way a new workspace without a
 * line in extra-files is caught on the very first PR that brings it in.
 *
 * Derived artifacts (web, server, images, release.json) keep no copies: web and
 * server take the number from the root package.json at build time, images take
 * it from the tag. See RELEASING.md.
 *
 * npm install is deliberately not called here: it would re-resolve the tree and
 * bring unrelated changes into the lock disguised as a version edit. Versions in
 * the lock are edited as JSON, and the edit refuses if the file is not in npm's
 * canonical layout (writing it would then reformat the whole file, and the diff
 * would become unreadable).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PYTHON_VERSION_FILE = 'python/colloq/_version.py'
export const CHANGELOG_FILE = 'CHANGELOG.md'
export const LOCK_FILE = 'package-lock.json'
export const RELEASE_PLEASE_CONFIG = 'release-please-config.json'
export const RELEASE_PLEASE_MANIFEST = '.release-please-manifest.json'
/*
 * shared/ is not a workspace; its package.json exists for "type": "module".
 * A version is written there anyway, and 0.0.0 next to 0.1.0 looked like a
 * forgotten copy. We keep it equal so that the question does not come up.
 */
const EXTRA_MANIFESTS = ['shared/package.json']

// ------------------------------------------------------------------ semver

/*
 * Not all of semver, only the part that all three consumers understand.
 *
 * A pre-release is only alpha|beta|rc with a number. This is not a matter of
 * taste: the version goes into the wheel, and PEP 440 knows exactly these three
 * words (0.2.0-rc.1 → 0.2.0rc1), so "0.2.0-next.1" would build in npm and in the
 * tag but fail on `pip wheel` — in the middle of a release, when the tag is
 * already in origin. Build metadata (+sha) is cut off for the same reason:
 * Docker tags and image names have no "+" character.
 * release-please will not come up with such a number itself, but Release-As in
 * a commit can.
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/

export function isVersion(text: string): boolean {
  return SEMVER.test(text)
}

// ------------------------------------------------------------------ files

type Json = Record<string, unknown>
/** File text by path from the repository root; null means there is no file. */
export type Reader = (file: string) => string | null

export function diskReader(root: string): Reader {
  return (file) => {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      return null
    }
  }
}

function parseJson(file: string, text: string): Json {
  try {
    return JSON.parse(text) as Json
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`)
  }
}

/** npm's canonical layout: 2-space indent and a trailing newline. */
function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function readJson(read: Reader, file: string): Json | null {
  const text = read(file)
  return text === null ? null : parseJson(file, text)
}

export function rootVersion(root: string = ROOT, read: Reader = diskReader(root)): string {
  const pkg = readJson(read, 'package.json')
  if (pkg === null) throw new Error(`no package.json in ${root}`)
  if (typeof pkg.version !== 'string') throw new Error('package.json has no "version"')
  return pkg.version
}

export function workspaces(read: Reader): string[] {
  const pkg = readJson(read, 'package.json') ?? {}
  const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : []
  return list.filter((item): item is string => typeof item === 'string')
}

export function manifests(read: Reader): string[] {
  return [...workspaces(read).map((w) => `${w}/package.json`), ...EXTRA_MANIFESTS].filter(
    (file) => read(file) !== null,
  )
}

/*
 * The version file for hatchling. Two parties write it: release-please in the
 * release PR and scripts/pack.mts on every pack. The text must be the same:
 * otherwise packing on CI (`make wheel`, then `git diff --exit-code`) would find
 * a "dirty" tree in the release PR. release-please changes only the number in
 * the line marked x-release-please-version (its Generic updater, extra-files)
 * and leaves the rest of the text alone, so the marker lives here, in the
 * shared template, instead of being added to the file by hand. The file header
 * does not carry it on purpose: release-please edits a marked line as a whole,
 * wherever that line is.
 */
export function pythonVersionFile(version: string): string {
  return (
    '# Package version for hatchling: pyproject.toml reads the wheel version from\n' +
    '# here. release-please bumps the number in the release PR (by the marker at\n' +
    '# the end of the line), and scripts/pack.mts rewrites the file with the same\n' +
    '# text when packing. Do not edit by hand: `make version` checks the number\n' +
    '# against the root package.json.\n' +
    `__version__ = "${version}"  # x-release-please-version\n`
  )
}

// The trailing comment is that very release-please marker.
const PY_VERSION = /^__version__\s*=\s*["']([^"']*)["']\s*(?:#.*)?$/m

export interface Copy {
  where: string
  version: string | null
}

/** Every place where the number is written, except the source itself. */
export function collectCopies(read: Reader): Copy[] {
  const out: Copy[] = []
  for (const file of manifests(read)) {
    const value = readJson(read, file)!.version
    out.push({ where: file, version: typeof value === 'string' ? value : null })
  }
  const lock = readJson(read, LOCK_FILE)
  if (lock !== null) {
    const packages = (lock.packages ?? {}) as Record<string, Json | undefined>
    const at = (value: unknown) => (typeof value === 'string' ? value : null)
    out.push({ where: LOCK_FILE, version: at(lock.version) })
    out.push({ where: `${LOCK_FILE} packages[""]`, version: at(packages['']?.version) })
    for (const w of workspaces(read)) {
      out.push({ where: `${LOCK_FILE} packages["${w}"]`, version: at(packages[w]?.version) })
    }
  }
  const py = read(PYTHON_VERSION_FILE)
  out.push({ where: PYTHON_VERSION_FILE, version: py === null ? null : (PY_VERSION.exec(py)?.[1] ?? null) })
  return out
}

/**
 * New texts of all copies for the root number. Writes nothing: both --dry-run
 * and the tests look at the result, and writing is one line in the caller.
 */
export function versionEdits(read: Reader, version: string): Map<string, string> {
  const edits = new Map<string, string>()
  const setVersion = (file: string, mutate: (value: Json) => void) => {
    const text = read(file)
    if (text === null) return
    const value = parseJson(file, text)
    if (stringify(value) !== text) {
      throw new Error(
        `${file} is not in npm's canonical JSON layout; rewriting it would reformat the whole ` +
          'file. Format it first (2-space indent, trailing newline) and run again.',
      )
    }
    mutate(value)
    const next = stringify(value)
    if (next !== text) edits.set(file, next)
  }
  for (const file of manifests(read)) {
    setVersion(file, (value) => {
      value.version = version
    })
  }
  const names = workspaces(read)
  setVersion(LOCK_FILE, (lock) => {
    lock.version = version
    const packages = (lock.packages ?? {}) as Record<string, Json | undefined>
    for (const key of ['', ...names]) {
      if (packages[key]) packages[key].version = version
    }
  })
  const py = read(PYTHON_VERSION_FILE)
  if (py !== null && py !== pythonVersionFile(version)) edits.set(PYTHON_VERSION_FILE, pythonVersionFile(version))
  return edits
}

// ------------------------------------------------------------- CHANGELOG

/*
 * Release headings that occur in the changelog: the old handwritten
 * "## [0.1.0] - 2026-09-13" and what release-please writes,
 * "## [0.2.0](…/compare/v0.1.0...v0.2.0) (2026-09-20)", or, without a previous
 * tag, "## 0.2.0 (2026-09-20)". ### is what older release-please versions use
 * for a patch. "### Features" and other subheadings do not match: a version
 * starts with a digit.
 */
const VERSION_HEADING = /^#{2,3} \[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\]?(?:[\s(]|$)/

/** Versions of the changelog sections, top to bottom. */
export function changelogVersions(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = VERSION_HEADING.exec(line)
    if (m) out.push(m[1]!)
  }
  return out
}

/*
 * Where release-please inserts the section of a new release: before the first
 * match of this pattern (updaters/changelog.ts, DEFAULT_VERSION_HEADER_REGEX).
 * Any heading like "## [", "## 1" or "### v" above the real releases — for
 * example, a handwritten "## [Unreleased]" — would hijack the insertion.
 */
const RELEASE_PLEASE_INSERT_AT = /\n###? v?[0-9[]/s

// ------------------------------------------------------------ release-please

interface ExtraFile {
  type?: string
  path: string
  jsonpath?: string
}

interface ReleasePleaseConfig {
  releaseType: string | null
  releaseAs: string | null
  extraFiles: Array<string | ExtraFile>
}

function releasePleaseConfig(read: Reader): ReleasePleaseConfig | null {
  const config = readJson(read, RELEASE_PLEASE_CONFIG)
  if (config === null) return null
  const packages = (config.packages ?? {}) as Record<string, Json | undefined>
  const root = packages['.'] ?? {}
  const pick = (key: string) => (root[key] ?? config[key]) as unknown
  const extra = pick('extra-files')
  return {
    releaseType: typeof pick('release-type') === 'string' ? (pick('release-type') as string) : null,
    releaseAs: typeof root['release-as'] === 'string' ? (root['release-as'] as string) : null,
    extraFiles: Array.isArray(extra) ? (extra as Array<string | ExtraFile>) : [],
  }
}

/*
 * The subset of JSONPath that extra-files needs: $.a.b and $.a["b-c"].
 * release-please understands all of JSONPath (jsonpath-plus), but the check
 * needs to know exactly which field it will touch, and a path more complex than
 * this is a reason to simplify the config, not the check.
 */
function jsonPathKeys(expression: string): string[] | null {
  if (!expression.startsWith('$')) return null
  const keys: string[] = []
  const step = /^(?:\.([A-Za-z_$][\w$]*)|\[(?:"([^"]*)"|'([^']*)')\])/
  let rest = expression.slice(1)
  while (rest) {
    const m = step.exec(rest)
    if (!m) return null
    keys.push(m[1] ?? m[2] ?? m[3]!)
    rest = rest.slice(m[0].length)
  }
  return keys.length ? keys : null
}

const RP_VERSION = /(\d+)\.(\d+)\.(\d+)(-[\w.]+)?(\+[-\w.]+)?/

/**
 * What release-please will do to the tree when releasing `next` — without the
 * network and without release-please itself. It repeats exactly the edits
 * release-please makes for this repository (release-please 17,
 * strategies/node.ts and base.ts):
 *
 *   · package.json → version; package-lock.json → version and packages[""]
 *     (release-type node, updaters/node/*);
 *   · extra-files: type json — the string at jsonpath (GenericJson); type
 *     generic or a plain string path — the number in lines marked
 *     x-release-please-version (Generic); a plain string path to a .json also
 *     gets $.version;
 *   · .release-please-manifest.json → {".": next};
 *   · CHANGELOG.md — the release section is inserted before the first version
 *     heading.
 *
 * If a file is missing or the path does not lead to a string with a number,
 * release-please silently skips the edit (createIfMissing: false, "No string
 * in …. Skipping."), so such places are returned in `problems` instead of
 * being swallowed.
 */
export function simulateRelease(read: Reader, next: string): { files: Map<string, string>; problems: string[] } {
  const files = new Map<string, string>()
  const problems: string[] = []
  const current = (file: string) => (files.has(file) ? files.get(file)! : read(file))
  const config = releasePleaseConfig(read)
  if (config === null) return { files, problems: [`${RELEASE_PLEASE_CONFIG} is missing`] }
  if (config.releaseType !== 'node') {
    problems.push(`${RELEASE_PLEASE_CONFIG}: release-type must be "node" (it updates package.json and the lock root)`)
  }

  const editJson = (file: string, mutate: (value: Json) => boolean, what: string) => {
    const text = current(file)
    if (text === null) {
      problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: ${file} does not exist`)
      return
    }
    const value = parseJson(file, text)
    if (mutate(value)) files.set(file, stringify(value))
    else problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: no version string there`)
  }
  const setAt = (value: Json, keys: string[]): boolean => {
    let node: unknown = value
    for (const key of keys.slice(0, -1)) {
      if (typeof node !== 'object' || node === null) return false
      node = (node as Json)[key]
    }
    const last = keys[keys.length - 1]!
    if (typeof node !== 'object' || node === null) return false
    const old = (node as Json)[last]
    if (typeof old !== 'string' || !RP_VERSION.test(old)) return false
    ;(node as Json)[last] = old.replace(RP_VERSION, next)
    return true
  }

  // release-type node.
  editJson('package.json', (pkg) => setAt(pkg, ['version']), 'package.json')
  if (read(LOCK_FILE) !== null) {
    editJson(
      LOCK_FILE,
      (lock) => {
        lock.version = next
        const packages = lock.packages as Record<string, Json> | undefined
        if (packages?.['']) packages[''].version = next
        return true
      },
      LOCK_FILE,
    )
  }

  // extra-files.
  // quiet: release-please also runs a plain string path to a .json through
  // Generic, but without the marker there is simply nothing to change there;
  // that is not a config error.
  const generic = (file: string, what: string, quiet = false) => {
    const text = current(file)
    if (text === null) {
      if (!quiet) problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: ${file} does not exist`)
      return
    }
    let touched = false
    const out = text
      .split(/\r?\n/)
      .map((line) => {
        if (!/x-release-please-version/.test(line) || !RP_VERSION.test(line)) return line
        touched = true
        return line.replace(RP_VERSION, next)
      })
      .join('\n')
    if (touched) files.set(file, out)
    else if (!quiet) problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: no line marked x-release-please-version in ${file}`)
  }
  for (const entry of config.extraFiles) {
    if (typeof entry === 'string') {
      const isJson = entry.endsWith('.json')
      if (isJson) editJson(entry, (value) => setAt(value, ['version']), `extra-files ${entry}`)
      generic(entry, `extra-files ${entry}`, isJson)
      continue
    }
    const what = `extra-files ${entry.path}${entry.jsonpath ? ` ${entry.jsonpath}` : ''}`
    if (entry.type === 'json') {
      const keys = jsonPathKeys(entry.jsonpath ?? '')
      if (!keys) {
        problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: use a plain path like $.a.b or $.a["b"]`)
        continue
      }
      editJson(entry.path, (value) => setAt(value, keys), what)
    } else if (entry.type === 'generic') generic(entry.path, what)
    else problems.push(`${RELEASE_PLEASE_CONFIG}: ${what}: type "${entry.type}" is not used in this repository`)
  }

  files.set(RELEASE_PLEASE_MANIFEST, stringify({ '.': next }))
  const changelog = current(CHANGELOG_FILE) ?? ''
  const entry = `## [${next}](https://github.com/example/colloq/compare/v0...v${next}) (2026-01-01)\n\n### Bug Fixes\n\n* something`
  const at = changelog.search(RELEASE_PLEASE_INSERT_AT)
  files.set(
    CHANGELOG_FILE,
    at === -1
      ? `# Changelog\n\n${entry}\n\n${changelog.replace(/^#(\s)/gm, '##$1').trim()}\n`
      : `${changelog.slice(0, at)}\n${entry}\n${changelog.slice(at)}`.trim() + '\n',
  )
  return { files, problems }
}

/** Next number for the trial release: patch; from a pre-release, the release itself. */
function probeVersion(version: string): string {
  const m = SEMVER.exec(version)
  if (!m) return '0.0.1'
  return m[4] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

// ------------------------------------------------------------------ check

export interface CheckOptions {
  tag?: string
}

/** The list of mismatches. Empty means everything agrees. */
export function checkVersions(root: string = ROOT, options: CheckOptions = {}, read: Reader = diskReader(root)): string[] {
  const problems: string[] = []
  const version = rootVersion(root, read)
  if (!isVersion(version)) {
    problems.push(`package.json version "${version}" is not MAJOR.MINOR.PATCH[-alpha|beta|rc.N]`)
  }
  for (const copy of collectCopies(read)) {
    if (copy.version === null) problems.push(`${copy.where} has no version (expected ${version})`)
    else if (copy.version !== version) problems.push(`${copy.where} says ${copy.version}, package.json says ${version}`)
  }

  // release-please bumps the number, and its manifest is one more copy. If they
  // diverge, package.json was bumped outside the release PR.
  const manifest = readJson(read, RELEASE_PLEASE_MANIFEST)
  if (manifest === null) problems.push(`${RELEASE_PLEASE_MANIFEST} is missing`)
  else if (manifest['.'] !== version) {
    problems.push(
      `${RELEASE_PLEASE_MANIFEST} says ${String(manifest['.'])}, package.json says ${version}; ` +
        'versions change only in the release-please pull request',
    )
  }

  const changelog = read(CHANGELOG_FILE)
  if (changelog === null) problems.push(`${CHANGELOG_FILE} is missing`)
  else {
    const versions = changelogVersions(changelog)
    // The top section is the current version: release-please puts the new
    // section at the top in the same PR where it bumps the number.
    if (versions[0] !== version) {
      problems.push(
        `${CHANGELOG_FILE}: the top section is ${versions[0] ?? 'missing'}, package.json says ${version}; ` +
          'release-please writes this file, do not add sections by hand',
      )
    }
    // A second section with the same number is a second "release X" PR after
    // release X: it happens when release-as was left in the config (RELEASING.md).
    const seen = new Set<string>()
    for (const v of versions) {
      if (seen.has(v)) problems.push(`${CHANGELOG_FILE} has two sections for ${v}`)
      seen.add(v)
    }
    // Anything above the current version's section that looks like a release
    // heading would hijack release-please's insertion.
    const first = changelog.search(RELEASE_PLEASE_INSERT_AT)
    const heading = first === -1 ? null : changelog.slice(first + 1).split('\n')[0]!
    if (heading !== null && VERSION_HEADING.exec(heading)?.[1] !== versions[0]) {
      problems.push(`${CHANGELOG_FILE}: "${heading}" would take release-please's next section; remove it`)
    }
  }

  // Trial release: everything release-please edits, and everything it does not.
  const next = probeVersion(version)
  const simulated = simulateRelease(read, next)
  problems.push(...simulated.problems)
  if (simulated.problems.length === 0) {
    const after: Reader = (file) => (simulated.files.has(file) ? simulated.files.get(file)! : read(file))
    for (const copy of collectCopies(after)) {
      if (copy.version !== next) {
        problems.push(
          `release-please would leave ${copy.where} at ${copy.version ?? 'nothing'}: ` +
            `add it to extra-files in ${RELEASE_PLEASE_CONFIG}`,
        )
      }
    }
    // Packing rewrites _version.py from the template; if it diverged from
    // release-please's edit, the release PR would fail `git diff --exit-code` in CI.
    const py = after(PYTHON_VERSION_FILE)
    if (py !== null && py !== pythonVersionFile(next)) {
      problems.push(`${PYTHON_VERSION_FILE} differs from pythonVersionFile() after release-please edits it`)
    }
    if (changelogVersions(after(CHANGELOG_FILE) ?? '')[0] !== next) {
      problems.push(`release-please would not put the next section at the top of ${CHANGELOG_FILE}`)
    }
  }

  if (options.tag !== undefined && options.tag !== `v${version}`) {
    problems.push(`tag ${options.tag} does not match package.json version ${version} (expected v${version})`)
  }
  return problems
}

// ------------------------------------------------------------------ CLI

const USAGE = `Usage: node --import tsx scripts/version.mts <command>

  current                 print the version (root package.json)
  check [--tag vX.Y.Z]    fail if any copy, the changelog, the release-please files
                          or the tag disagree, or if release-please would miss a copy
  sync [--dry-run]        rewrite every copy to the root package.json version
                          (a repair; new versions come from the release-please PR)`

export function main(argv: string[], root: string = ROOT): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tag: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command] = positionals
  const read = diskReader(root)
  if (values.help || !command) {
    console.log(USAGE)
    return command || values.help ? 0 : 2
  }

  if (command === 'current') {
    console.log(rootVersion(root, read))
    return 0
  }

  if (command === 'check') {
    const problems = checkVersions(root, { tag: values.tag }, read)
    const version = rootVersion(root, read)
    // The first release goes out with release-as; after it the line must be
    // removed, or release-please will offer the same number again. Not an error:
    // in the release PR this number is supposed to match.
    const pinned = releasePleaseConfig(read)?.releaseAs
    if (pinned && pinned === version) {
      console.log(
        `note: ${RELEASE_PLEASE_CONFIG} still pins release-as ${pinned}. Once v${pinned} is released, ` +
          'remove it (RELEASING.md, "The first release").',
      )
    }
    if (problems.length === 0) {
      console.log(`version ${version}: every copy agrees` + (values.tag ? `, tag ${values.tag} matches` : ''))
      return 0
    }
    for (const problem of problems) console.error(`✗ ${problem}`)
    console.error('\nCopies: node --import tsx scripts/version.mts sync · a new version: the release-please PR (RELEASING.md)')
    return 1
  }

  /*
   * Repairs a mismatch without a new number: the copies catch up with the root.
   * Needed by whoever adds a workspace or edits a copy by hand. The
   * release-please manifest is left alone: if someone bumped package.json
   * itself by hand, check will show it.
   */
  if (command === 'sync') {
    const version = rootVersion(root, read)
    if (!isVersion(version)) throw new Error(`package.json version "${version}" is not MAJOR.MINOR.PATCH[-alpha|beta|rc.N]`)
    const edits = versionEdits(read, version)
    for (const [file, text] of edits) {
      console.log(`  ${file.padEnd(28)} → ${version}`)
      if (!values['dry-run']) fs.writeFileSync(path.join(root, file), text)
    }
    console.log(edits.size === 0 ? `every copy already says ${version}` : values['dry-run'] ? '\nDry run: nothing written.' : '')
    return 0
  }

  console.error(USAGE)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`version: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
