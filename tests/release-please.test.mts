/**
 * Releasing through release-please: .github/workflows/release-please.yml, its
 * config, and how publish.yml and release.yml line up behind it.
 *
 * A workflow on GitHub cannot be run from here, so what is checked is what can
 * be checked locally and what breaks silently:
 *
 *   · the token is only the personal RELEASE_PLEASE_TOKEN, with no quiet
 *     fallback to GITHUB_TOKEN: with that one the release PR would come from
 *     the bot and without CI;
 *   · publishing goes exactly one way: a run from the tag started by
 *     release-please.yml, without `push: tags` (a tag from the personal token
 *     would start it a second time), and only release-please creates the
 *     GitHub Release;
 *   · the config: the tag is vX.Y.Z without a component name, and every
 *     extra-files path exists and holds the current number right now —
 *     checked here separately from scripts/version.mts, in a different way;
 *   · the PR title check lets Conventional Commits (and the release PR)
 *     through and nothing else — the very script from the workflow is run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8')
const workflows = fs.readdirSync(path.join(repo, '.github/workflows')).filter((name) => name.endsWith('.yml'))

/** The text of a workflow job: from "  <name>:" to the next job at the same indent. */
function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `no job ${name}`)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/** The `run: |` block of the step named `step`, unindented, the way bash will run it. */
function runBlock(text: string, step: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.includes(`- name: ${step}`))
  assert.notEqual(at, -1, `no step ${step}`)
  const run = lines.findIndex((line, i) => i > at && /^\s+run: \|\s*$/.test(line))
  const indent = lines[run + 1]!.match(/^\s*/)![0].length
  const body: string[] = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.match(/^\s*/)![0].length < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

test('release-please runs on main with the owner token, and fails rather than fall back', () => {
  const text = read('.github/workflows/release-please.yml')
  assert.match(text, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/m)
  assert.match(text, /^permissions: \{\}$/m)
  const rp = job(text, 'release-please')

  // Pinned by commit: the action holds a personal token with write access to main.
  assert.match(rp, /uses: googleapis\/release-please-action@[0-9a-f]{40} # v4\.\d+\.\d+/)
  assert.match(rp, /token: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/)
  assert.doesNotMatch(rp, /token: \$\{\{ (github\.token|secrets\.GITHUB_TOKEN)/)
  assert.doesNotMatch(rp, /RELEASE_PLEASE_TOKEN \|\|/)
  // The secret check comes before the action, and it fails on an empty one.
  const guard = rp.indexOf('RELEASE_PLEASE_TOKEN is set')
  assert.ok(guard !== -1 && guard < rp.indexOf('googleapis/release-please-action'))
  const script = runBlock(rp, 'RELEASE_PLEASE_TOKEN is set')
  const empty = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, TOKEN: '' }, encoding: 'utf8' })
  assert.equal(empty.status, 1)
  assert.match(empty.stdout, /::error::Repository secret RELEASE_PLEASE_TOKEN is not set/)
  const set = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, TOKEN: 'github_pat_x' }, encoding: 'utf8' })
  assert.equal(set.status, 0)

  // The token goes only to the API: no checkout and no npm next to it.
  assert.doesNotMatch(rp, /actions\/checkout|npm (ci|install)/)
  assert.match(rp, /permissions: \{\}/)
  // A fork has no secret, so the job does not run there at all.
  assert.match(rp, /if: \$\{\{ !github\.event\.repository\.fork \}\}/)
})

test('a release publishes exactly once: started from release-please on the tag, never a tag push', () => {
  const rp = read('.github/workflows/release-please.yml')
  const publish = job(rp, 'publish')
  assert.match(publish, /needs: release-please/)
  assert.match(publish, /if: needs\.release-please\.outputs\.release_created == 'true'/)
  // A run from the tag, not `uses:`: called as a reusable workflow, publish.yml carried
  // workflow_ref = release-please.yml, and PyPI refused v0.2.0 (invalid-publisher).
  assert.doesNotMatch(publish, /uses: \.\/\.github\/workflows\/publish\.yml/)
  assert.match(publish, /gh workflow run publish\.yml --ref "\$TAG" -f tag="\$TAG"/)
  assert.match(publish, /TAG: \$\{\{ needs\.release-please\.outputs\.tag_name \}\}/)
  // No personal token nearby: GITHUB_TOKEN starts it.
  assert.doesNotMatch(publish, /secrets\./)
  assert.match(job(rp, 'release-please'), /release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}/)

  const text = read('.github/workflows/publish.yml')
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'))
  assert.doesNotMatch(on, /\n {2}push:/)
  assert.doesNotMatch(on, /\n {2}workflow_call:/)
  assert.match(on, /\n {2}workflow_dispatch:/)
  // No workflow creates a release on its own: release-please writes the notes.
  for (const file of workflows) {
    assert.doesNotMatch(read(`.github/workflows/${file}`), /gh release create/, `${file} creates a release`)
  }
  // Every wheel at once, universal and platform, with the list of sums.
  const release = job(text, 'github-release')
  assert.match(release, /for file in out\/\*\.whl out\/python-SHA256SUMS; do/)
  assert.match(release, /gh release upload "\$TAG" "\$\{upload\[@\]\}"/)
  assert.doesNotMatch(release, /gh release upload[^\n]*--clobber/)
  assert.match(read('.github/workflows/release.yml'), /gh release upload "\$VERSION" release\.json/)
})

test('no workflow has a plain step name with ": " in it', () => {
  // There is no YAML parser among the dependencies, and the text checks above let
  // such a file through: "- name: type(scope)!: subject" is no longer a string but
  // a parse error, and GitHub rejects the whole workflow. That happened with pr-title.yml.
  for (const file of workflows) {
    for (const line of read(`.github/workflows/${file}`).split('\n')) {
      const m = /^\s*(?:- )?name: (.*)$/.exec(line)
      if (!m || /^["']/.test(m[1]!)) continue
      assert.doesNotMatch(m[1]!.replace(/\s+#.*$/, ''), /: /, `${file}: ${line.trim()}`)
    }
  }
})

test('nothing points at the removed cut-release machinery', () => {
  for (const gone of ['.github/workflows/cut-release.yml', 'scripts/release-commit-check.sh', 'scripts/changelog-notes.mts']) {
    assert.equal(fs.existsSync(path.join(repo, gone)), false, `${gone} is back`)
  }
  const places = [
    ...workflows.map((file) => `.github/workflows/${file}`),
    'Makefile',
    'README.md',
    // The Russian README talks about releases too: the translation must not go
    // stale here any more than the original.
    'README.ru.md',
    'RELEASING.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'deploy/k3s/README.md',
    'scripts/release-build.py',
  ]
  for (const file of places) {
    const text = read(file)
    assert.doesNotMatch(text, /cut-release|Cut release|release-commit-check|changelog-notes|RELEASE_TOKEN\b/, file)
    assert.doesNotMatch(text, /version\.mts (bump|notes)|make bump PART/, file)
    assert.doesNotMatch(text, /## \[Unreleased\]/, file)
  }
})

test('the config tags vX.Y.Z and names every copy of the version at its current value', () => {
  const config = JSON.parse(read('release-please-config.json'))
  const manifest = JSON.parse(read('.release-please-manifest.json'))
  const version = JSON.parse(read('package.json')).version as string
  assert.deepEqual(manifest, { '.': version })
  assert.equal(config['release-type'], 'node')
  assert.equal(config['include-v-in-tag'], true)
  assert.equal(config['include-component-in-tag'], false)
  // Before 1.0: feat and a breaking change bump minor, fix bumps patch.
  assert.equal(config['bump-minor-pre-major'], true)
  assert.equal(config['bump-patch-for-minor-pre-major'], false)
  assert.deepEqual(Object.keys(config.packages), ['.'])
  // prerelease: true would mark every 0.x as a prerelease too (manifest.ts);
  // -rc.N is marked by publish.yml.
  assert.equal(config.prerelease ?? config.packages['.'].prerelease, undefined)

  const extra = config.packages['.']['extra-files'] as Array<{ type: string; path: string; jsonpath?: string }>
  const lock = JSON.parse(read('package-lock.json'))
  const workspaces = JSON.parse(read('package.json')).workspaces as string[]
  const covered = new Set<string>()
  for (const entry of extra) {
    assert.ok(fs.existsSync(path.join(repo, entry.path)), `${entry.path} does not exist`)
    if (entry.type === 'json') {
      // The path is only $.a.b.c: exactly what jsonpath-plus understands unambiguously.
      assert.match(entry.jsonpath!, /^\$(\.[A-Za-z_]\w*)+$/, entry.jsonpath)
      let node: unknown = JSON.parse(read(entry.path))
      for (const key of entry.jsonpath!.slice(2).split('.')) node = (node as Record<string, unknown>)[key]
      assert.equal(node, version, `${entry.path} ${entry.jsonpath}`)
      covered.add(`${entry.path} ${entry.jsonpath}`)
    } else {
      assert.equal(entry.type, 'generic')
      const marked = read(entry.path).split('\n').filter((line) => line.includes('x-release-please-version'))
      assert.equal(marked.length, 1, `${entry.path}: one marked line`)
      assert.ok(marked[0]!.includes(`"${version}"`), marked[0])
      covered.add(entry.path)
    }
  }
  // The root and packages[""] of the lockfile are updated by release-type node
  // itself; the workspaces are not.
  for (const w of workspaces) {
    assert.ok(covered.has(`${w}/package.json $.version`), `${w}/package.json is not in extra-files`)
    assert.ok(lock.packages[w], `package-lock.json has no packages["${w}"]`)
    assert.ok(covered.has(`package-lock.json $.packages.${w}.version`), `package-lock.json packages["${w}"] is not in extra-files`)
  }
  assert.ok(covered.has('shared/package.json $.version'))
  assert.ok(covered.has('python/colloq/_version.py'))
})

test('release-as pins only the first release, and its reminder travels with it', () => {
  const root = JSON.parse(read('release-please-config.json')).packages['.']
  const version = JSON.parse(read('package.json')).version as string
  if (root['release-as'] === undefined) {
    // After the first release the line was removed, together with the reminder in the PR header.
    assert.equal(root['pull-request-header'], undefined)
    return
  }
  // While it is there, it has to point forward: a release-as equal to the
  // released number would open a second "release X" PR.
  assert.match(root['release-as'], /^\d+\.\d+\.\d+$/)
  const [a, b] = [root['release-as'], version].map((v: string) => v.split('.').map(Number))
  const newer = a![0]! - b![0]! || a![1]! - b![1]! || a![2]! - b![2]!
  assert.ok(newer > 0 || root['release-as'] === version, `release-as ${root['release-as']} is behind ${version}`)
  assert.match(root['pull-request-header'], /delete `release-as` and this `pull-request-header`/)
  // The header must not contain the notes separator: release-please splits the
  // PR body at the "---" line, and a header containing it would eat the release notes.
  assert.doesNotMatch(root['pull-request-header'], /^---$/m)
})

test('the PR title check accepts Conventional Commits and the release PR, and nothing else', () => {
  const text = read('.github/workflows/pr-title.yml')
  const script = runBlock(text, 'The title is a Conventional Commit')
  const check = (title: string) =>
    spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, TITLE: title }, encoding: 'utf8' }).status
  for (const good of [
    'feat(council): show the queue to the teacher',
    'fix: keep the notebook where it was',
    'feat(cli)!: drop the vast command',
    'perf(server): compress the first sync frame',
    'revert: feat(web): tab reordering',
    'docs(deploy): k3s upgrade notes',
    'chore(main): release 0.2.0',
    'build(deps): bump yjs',
  ]) {
    assert.equal(check(good), 0, good)
  }
  for (const bad of [
    'Fix the queue',
    'feat:no space',
    'feature(council): x',
    'feat(Council): capital scope',
    'feat(): empty scope',
    'Revert "feat: x"',
    'fix(council) missing colon',
  ]) {
    assert.equal(check(bad), 1, bad)
  }
  // The check's types and the changelog sections are one list: a type that
  // release-please does not know would pass the check and vanish from the notes.
  const types = /types='([^']+)'/.exec(script)![1]!.split('|').sort()
  const sections = (JSON.parse(read('release-please-config.json'))['changelog-sections'] as Array<{ type: string }>)
    .map((s) => s.type)
    .sort()
  assert.deepEqual(types, sections)
})
