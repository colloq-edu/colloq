/**
 * The Kubernetes release and its end-to-end check: what publish.yml's
 * app-images and chart jobs publish, how scripts/chart-values.py writes a
 * release into the Helm chart, and what .github/workflows/k8s-e2e.yml sets up
 * before scripts/k8s-e2e.mts runs.
 *
 * None of it can run here for real (GHCR, a GitHub Release, a k3d cluster), so,
 * as tests/vast-image.test.mts does for the kernels job, the workflow scripts
 * themselves are run with stand-in docker, helm, gh and kubectl, and the rest is
 * held by the text: the gates, the names, the pins that must agree between
 * files, and the order of the steps where the order is the point (nothing is
 * pushed before the release is known to exist; no credentials on disk while the
 * repository's code runs; the namespace denies everything before the chart
 * arrives).
 *
 * chart-values.py itself is run for real, on a chart shaped like
 * deploy/helm/colloq, and on deploy/helm/colloq itself when the tree has it: the
 * chart and the release job must agree on every path the release writes. With a
 * helm on PATH the result is rendered too.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { colocationProblems, forwardedPort, pinnedToApp, DISPOSABLE_LABEL } from '../scripts/k8s-e2e.mts'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const PUBLISH = read('.github/workflows/publish.yml')
const E2E = read('.github/workflows/k8s-e2e.yml')
const DIGEST_A = 'sha256:' + 'a'.repeat(64)
const DIGEST_B = 'sha256:' + 'b'.repeat(64)
const DIGEST_C = 'sha256:' + 'c'.repeat(64)
const has = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0
const HAS_JQ = has('jq')
const HAS_HELM = spawnSync('helm', ['version'], { encoding: 'utf8' }).status === 0

/** The text of a workflow job: from "  <name>:" to the next job. */
function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `no job ${name}`)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/** The `run: |` block of the step named `step` inside `text`, unindented, as bash runs it. */
function runBlock(text: string, step: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() === `- name: ${step}`)
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

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A directory of stand-in executables, first on PATH. */
function standIns(dir: string, bins: Record<string, string>): string {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const [name, body] of Object.entries(bins)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}`, { mode: 0o755 })
  return `${bin}:${process.env.PATH}`
}

function bash(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: { HOME: os.homedir(), ...env } })
}

/** KEY=value lines a step wrote to $GITHUB_OUTPUT. */
function outputs(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {}
  return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }))
}

/** A chart shaped like deploy/helm/colloq: the paths the release writes, among comments and settings it must leave alone. */
const CHART_YAML = `apiVersion: v2
name: colloq
description: Colloq
type: application
# The chart version is the app version.
version: 0.9.0
appVersion: "0.9.0"
kubeVersion: ">=1.30.0-0"
`
const VALUES_YAML = `# Colloq in one namespace.
global:
  # Replaces the registry of every image.
  imageRegistry: ""

image:
  registry: ghcr.io
  pullPolicy: IfNotPresent
  # Digests are filled by the release job.
  app:
    repository: colloq-edu/colloq-app
    digest: ""  # set by the release
  runtime:
    # The same image runs the competition exporter.
    repository: 'colloq-edu/colloq-runtime'
    digest: ""

catalog:
  release: ""
  defaultEnvironment: base
  environments:
    # name, image, gpu, packages.
    - name: base
      image: ""
      gpu: false
      packages: []
    - name: kaggle-base
      image: ""
      gpu: false
      packages: []

persistence:
  accessMode: ReadWriteOnce
  data:
    size: 10Gi
`

function chartDir(dir: string, values = VALUES_YAML, chart = CHART_YAML): string {
  const at = path.join(dir, 'deploy/helm/colloq')
  fs.mkdirSync(path.join(at, 'templates'), { recursive: true })
  fs.writeFileSync(path.join(at, 'Chart.yaml'), chart)
  fs.writeFileSync(path.join(at, 'values.yaml'), values)
  return at
}

function chartValues(args: string[]) {
  return spawnSync('python3', [path.join(ROOT, 'scripts/chart-values.py'), ...args], { cwd: ROOT, encoding: 'utf8' })
}

const releaseArgs = (chart: string | null, output: string, kernels: Record<string, string> = {
  base: `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_B}`, 'kaggle-base': `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_C}` }) => [
  '--version', '0.10.0', '--app-image', `ghcr.io/colloq-edu/colloq-app@${DIGEST_A}`,
  '--runtime-image', `ghcr.io/colloq-edu/colloq-runtime@${DIGEST_A}`, '--kernel-images', JSON.stringify(kernels),
  ...(chart ? ['--chart', chart] : []), '--output', output]

/* ------------------------------------------------------ scripts/chart-values.py */

test('chart-values writes the release into the chart and leaves every other line alone', () => {
  const dir = tempDir('colloq-chart-values-')
  try {
    const chart = chartDir(dir)
    const output = path.join(dir, 'values-0.10.0.yaml')
    const run = chartValues(releaseArgs(chart, output))
    assert.equal(run.status, 0, run.stderr)
    const values = fs.readFileSync(path.join(chart, 'values.yaml'), 'utf8')
    // The registry and the host-less repositories, as the chart renders them.
    assert.match(values, /\n {2}registry: "ghcr\.io"\n/)
    assert.match(values, /\n {4}repository: "colloq-edu\/colloq-app"\n/)
    assert.match(values, new RegExp(`\\n {4}digest: "${DIGEST_A}"  # set by the release\\n`))
    assert.match(values, /\n {4}repository: "colloq-edu\/colloq-runtime"\n/)
    assert.equal(values.split(`digest: "${DIGEST_A}"`).length, 3)
    // The catalog: parents first, package lists from kernel/environments, the old entries gone.
    assert.match(values, /\n {2}environments:\n {4}# name, image, gpu, packages\.\n {4}- name: "base"\n/)
    assert.ok(values.includes(`      image: "ghcr.io/colloq-edu/colloq-kernel@${DIGEST_B}"\n      gpu: false\n      packages:\n        - "seaborn"\n`), values)
    assert.ok(values.includes(`    - name: "kaggle-base"\n      image: "ghcr.io/colloq-edu/colloq-kernel@${DIGEST_C}"\n`))
    assert.ok(values.includes('        - "catboost==1.2.10"\n'))
    assert.doesNotMatch(values, /image: ""/)
    // Everything else as it was: comments, the release label, the settings after the catalog.
    for (const kept of ['# Colloq in one namespace.\n', '  # Replaces the registry of every image.\n  imageRegistry: ""\n',
      '  pullPolicy: IfNotPresent\n', '    # The same image runs the competition exporter.\n', '  release: ""\n',
      '\npersistence:\n  accessMode: ReadWriteOnce\n  data:\n    size: 10Gi\n']) {
      assert.ok(values.includes(kept), `lost: ${kept}`)
    }
    const chartYaml = fs.readFileSync(path.join(chart, 'Chart.yaml'), 'utf8')
    assert.match(chartYaml, /\nversion: 0\.10\.0\nappVersion: "0\.10\.0"\nkubeVersion/)
    assert.ok(chartYaml.includes('# The chart version is the app version.\n'))
    // The same values on their own for the release page, and as JSON on stdout.
    const said = JSON.parse(run.stdout)
    assert.deepEqual(said.image, { registry: 'ghcr.io', app: { repository: 'colloq-edu/colloq-app', digest: DIGEST_A },
      runtime: { repository: 'colloq-edu/colloq-runtime', digest: DIGEST_A } })
    assert.deepEqual(said.catalog.environments.map((e: any) => [e.name, e.gpu]), [['base', false], ['kaggle-base', false]])
    assert.equal('current' in said.catalog.environments[0], false)
    const overlay = fs.readFileSync(output, 'utf8')
    assert.match(overlay, /^# Colloq 0\.10\.0: the images and the kernel catalog this release published, by digest\.\n/)
    assert.match(overlay, /\nimage:\n {2}registry: "ghcr\.io"\n {2}app:\n {4}repository: "colloq-edu\/colloq-app"\n/)
    assert.match(overlay, /\ncatalog:\n {2}defaultEnvironment: "base"\n {2}environments:\n {4}- name: "base"\n/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('chart-values puts parents first and marks GPU environments by the directive', () => {
  const dir = tempDir('colloq-chart-values-order-')
  try {
    const run = chartValues(releaseArgs(null, path.join(dir, 'v.yaml'), {
      'kaggle-base': `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_C}`, base: `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_B}`,
      'base-gpu': `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_A}` }))
    assert.equal(run.status, 0, run.stderr)
    const envs = JSON.parse(run.stdout).catalog.environments
    assert.deepEqual(envs.map((e: any) => e.name), ['base', 'kaggle-base', 'base-gpu'])
    assert.deepEqual(envs.map((e: any) => e.gpu), [false, false, true])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('chart-values refuses what it cannot write truthfully, and leaves the chart as it was', () => {
  const dir = tempDir('colloq-chart-values-refuse-')
  try {
    const chart = chartDir(dir)
    const before = fs.readFileSync(path.join(chart, 'values.yaml'), 'utf8')
    const output = path.join(dir, 'v.yaml')
    const refused = (args: string[], pattern: RegExp) => {
      const run = chartValues(args)
      assert.notEqual(run.status, 0, `accepted: ${args.join(' ')}`)
      assert.match(run.stderr, pattern)
      assert.equal(fs.readFileSync(path.join(chart, 'values.yaml'), 'utf8'), before)
    }
    const args = releaseArgs(chart, output)
    const swap = (flag: string, value: string) => args.map((v, i) => (args[i - 1] === flag ? value : v))
    refused(swap('--app-image', 'ghcr.io/colloq-edu/colloq-app:v0.10.0'), /pinned by sha256 digest/)
    refused(swap('--runtime-image', `registry.example/colloq-runtime@${DIGEST_A}`), /different registries/)
    refused(swap('--version', 'v0.10.0'), /not a release version/)
    refused(swap('--kernel-images', JSON.stringify({ 'kaggle-base': `ghcr.io/x/colloq-kernel@${DIGEST_C}` })), /no published image for base/)
    refused(swap('--kernel-images', JSON.stringify({ nope: `ghcr.io/x/colloq-kernel@${DIGEST_C}` })), /kernel\/environments\/nope\.txt/)
    refused(swap('--kernel-images', JSON.stringify({ 'kaggle-base': `ghcr.io/x/colloq-kernel@${DIGEST_C}`, base: 'ghcr.io/x/k:latest' })), /pinned by sha256/)
    refused([...args, '--default-environment', 'base-gpu'], /default environment base-gpu is not among/)
    // A chart that moved a value the release writes is a refusal naming it, never a guess.
    fs.writeFileSync(path.join(chart, 'values.yaml'), before.replace('  registry: ghcr.io\n', ''))
    const moved = chartValues(args)
    assert.notEqual(moved.status, 0)
    assert.match(moved.stderr, /values\.yaml has no image\.registry/)
    fs.writeFileSync(path.join(chart, 'values.yaml'), before)
    fs.writeFileSync(path.join(chart, 'Chart.yaml'), CHART_YAML.replace('name: colloq', 'name: other'))
    refused(args, /name the chart colloq/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the chart catalog and release.json come out of one function', () => {
  // release-build.py main with the builds stubbed, and chart-values.py, given the
  // same images: the same entries (release.json also marks each one current).
  const dir = tempDir('colloq-chart-values-same-')
  try {
    const out = path.join(dir, 'release.json')
    // The kernel tag's environment is read without the version: the tree's
    // version moves with every release, and a pinned one broke the release PR.
    const code = `import importlib.util,sys,json,re
s=importlib.util.spec_from_file_location('builder',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.archive_source=lambda repo,commit,dest: repo
m.pinned=lambda base: base+'@sha256:'+'0'*64
m.release.tooling_hashes=lambda root: {f:'0'*64 for f in m.release.TOOLING_FILES}
digests={'base':'b','kaggle-base':'c'}
m.build=lambda tag,*args,**kw: tag.rsplit(':',1)[0]+'@sha256:'+digests.get(re.sub(r'^v[0-9]+[.][0-9]+[.][0-9]+-','',tag.rsplit(':',1)[-1]) if '-kernel:' in tag else '','a')*64
sys.argv=['release-build.py','--registry','ghcr.io/colloq-edu/colloq','--k3s-version','v1.36.4+k3s1','--source-commit','a'*40,'--output',sys.argv[2]]
m.main()
`
    const built = spawnSync('python3', ['-c', code, path.join(ROOT, 'scripts/release-build.py'), out], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    const manifest = JSON.parse(fs.readFileSync(out, 'utf8'))
    const run = chartValues(releaseArgs(null, path.join(dir, 'v.yaml')))
    assert.equal(run.status, 0, run.stderr)
    const chart = JSON.parse(run.stdout).catalog
    assert.deepEqual(manifest.catalog.environments.map(({ current, ...entry }: any) => (assert.equal(current, true), entry)),
      chart.environments)
    assert.equal(manifest.catalog.defaultEnvironment, chart.defaultEnvironment)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('deploy/helm/colloq has every path the release writes, and renders the digests', {
  skip: !fs.existsSync(path.join(ROOT, 'deploy/helm/colloq/values.yaml')) && 'deploy/helm/colloq is not in this tree',
}, () => {
  const dir = tempDir('colloq-chart-real-')
  try {
    const chart = path.join(dir, 'colloq')
    fs.cpSync(path.join(ROOT, 'deploy/helm/colloq'), chart, { recursive: true })
    const run = chartValues(releaseArgs(chart, path.join(dir, 'values-0.10.0.yaml')))
    assert.equal(run.status, 0, run.stderr)
    if (!HAS_HELM) return
    const rendered = spawnSync('helm', ['template', 'colloq', chart, '--namespace', 'colloq', '--set', 'ingress.enabled=false'], { encoding: 'utf8' })
    assert.equal(rendered.status, 0, rendered.stderr)
    for (const image of [`ghcr.io/colloq-edu/colloq-app@${DIGEST_A}`, `ghcr.io/colloq-edu/colloq-runtime@${DIGEST_A}`,
      `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_B}`, `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_C}`]) {
      assert.ok(rendered.stdout.includes(image), `the rendered chart lacks ${image}`)
    }
    const shown = spawnSync('helm', ['show', 'chart', chart], { encoding: 'utf8' })
    assert.match(shown.stdout, /^version: 0\.10\.0$/m)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('chart-values output parses as the values it claims (helm reads it back)', { skip: !HAS_HELM && 'no helm on PATH' }, () => {
  const dir = tempDir('colloq-chart-values-helm-')
  try {
    const chart = chartDir(dir)
    fs.writeFileSync(path.join(chart, 'templates/values.yaml'),
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: values\ndata:\n  values.json: {{ toJson .Values | quote }}\n')
    const run = chartValues(releaseArgs(chart, path.join(dir, 'values-0.10.0.yaml')))
    assert.equal(run.status, 0, run.stderr)
    for (const values of [[], ['--values', path.join(dir, 'values-0.10.0.yaml')]]) {
      const rendered = spawnSync('helm', ['template', 'x', chart, ...values], { encoding: 'utf8' })
      assert.equal(rendered.status, 0, rendered.stderr)
      const json = JSON.parse(JSON.parse(/values\.json: (".*")/.exec(rendered.stdout)![1]!))
      assert.deepEqual(json.image, { registry: 'ghcr.io', pullPolicy: 'IfNotPresent',
        app: { repository: 'colloq-edu/colloq-app', digest: DIGEST_A }, runtime: { repository: 'colloq-edu/colloq-runtime', digest: DIGEST_A } })
      assert.deepEqual(json.catalog.environments.map((e: any) => e.image),
        [`ghcr.io/colloq-edu/colloq-kernel@${DIGEST_B}`, `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_C}`])
      assert.deepEqual(json.catalog.environments[0].packages, ['seaborn'])
      assert.equal(json.catalog.release, '')
      assert.deepEqual(json.persistence, { accessMode: 'ReadWriteOnce', data: { size: '10Gi' } })
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/* ----------------------------------------------------- publish.yml: the images */

test('app-images builds colloq-app and colloq-runtime for amd64 with attestations, under PUBLISH_IMAGES', () => {
  const images = job(PUBLISH, 'app-images')
  assert.match(images, /\n {4}needs: build\n/)
  assert.match(images, /\n {4}if: vars\.PUBLISH_IMAGES == 'true'\n/)
  assert.match(images, /\n {6}packages: write\n/)
  assert.match(images, /\n {6}app: \$\{\{ steps\.pinned\.outputs\.app \}\}\n {6}runtime: \$\{\{ steps\.pinned\.outputs\.runtime \}\}\n/)
  for (const [kind, target] of [['app', 'production'], ['runtime', 'broker']]) {
    const at = images.indexOf(`- name: Build and push colloq-${kind}\n`)
    assert.ok(at > 0, `no build of colloq-${kind}`)
    const step = images.slice(at, images.indexOf('\n      - ', at + 1))
    assert.match(step, new RegExp(`\\n {8}if: steps\\.published\\.outputs\\.${kind}_digest == ''\\n`))
    assert.match(step, new RegExp(`\\n {10}target: ${target}\\n`))
    assert.match(step, /\n {10}platforms: linux\/amd64\n {10}push: true\n {10}provenance: mode=max\n {10}sbom: true\n/)
    assert.match(step, new RegExp(`tags: \\$\\{\\{ steps\\.published\\.outputs\\.${kind} \\}\\}:\\$\\{\\{ steps\\.published\\.outputs\\.tag \\}\\}\\n`))
    assert.match(step, /NODE_IMAGE=\$\{\{ steps\.published\.outputs\.node \}\}/)
    assert.match(step, new RegExp(`org\\.opencontainers\\.image\\.title=colloq-${kind}\\n`))
    assert.match(step, /org\.opencontainers\.image\.revision=\$\{\{ needs\.build\.outputs\.commit \}\}/)
  }
  // The chart installs by digest: no moving tag is published for Kubernetes.
  assert.doesNotMatch(images, /latest/)
})

test('app-images skips a published tag and hands on its digest; a new one is built on a pinned node base', () => {
  const dir = tempDir('colloq-app-images-')
  try {
    const script = runBlock(job(PUBLISH, 'app-images'), 'Skip what is already published')
    const PATH = standIns(dir, { docker: `printf '%s\\n' "$*" >> "$LOG"
if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then
  case " $PUBLISHED " in *" $4 "*) echo "sha256:$(printf '%064d' 7)"; exit 0 ;; esac
  exit 1
fi
exit 0
` })
    const run = (published: string) => {
      const out = path.join(dir, `out-${published.length}`)
      const r = bash(script, ROOT, { PATH, LOG: path.join(dir, 'log'), PUBLISHED: published, OWNER: 'Colloq-Edu', VERSION: '0.10.0', GITHUB_OUTPUT: out })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      return outputs(out)
    }
    const fresh = run('node:22-bookworm-slim')
    assert.deepEqual(fresh, { app: 'ghcr.io/colloq-edu/colloq-app', runtime: 'ghcr.io/colloq-edu/colloq-runtime', tag: 'v0.10.0',
      node: `node:22-bookworm-slim@sha256:${'0'.repeat(63)}7` })
    const rerun = run('node:22-bookworm-slim ghcr.io/colloq-edu/colloq-app:v0.10.0')
    assert.equal(rerun.app_digest, `sha256:${'0'.repeat(63)}7`)
    assert.equal(rerun.runtime_digest, undefined)
    // The node base is the Dockerfile's own default, not a second copy of its name.
    assert.match(read('Dockerfile'), /^ARG NODE_IMAGE=node:22-bookworm-slim$/m)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('app-images hands the chart pinned references, and nothing without a digest', () => {
  const script = runBlock(job(PUBLISH, 'app-images'), 'Pinned references for the chart')
  const dir = tempDir('colloq-app-pinned-')
  try {
    const out = path.join(dir, 'out')
    const env = { PATH: process.env.PATH!, APP: 'ghcr.io/o/colloq-app', RUNTIME: 'ghcr.io/o/colloq-runtime', GITHUB_OUTPUT: out }
    const ok = bash(script, dir, { ...env, APP_DIGEST: DIGEST_A, RUNTIME_DIGEST: DIGEST_B })
    assert.equal(ok.status, 0, ok.stderr)
    assert.deepEqual(outputs(out), { app: `ghcr.io/o/colloq-app@${DIGEST_A}`, runtime: `ghcr.io/o/colloq-runtime@${DIGEST_B}` })
    const missing = bash(script, dir, { ...env, GITHUB_OUTPUT: path.join(dir, 'out2'), APP_DIGEST: DIGEST_A, RUNTIME_DIGEST: '' })
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /::error::an image of this release came out without a digest/)
    // Either the digest of the tag found, or the one the build reports: never a second lookup.
    assert.match(job(PUBLISH, 'app-images'), /APP_DIGEST: \$\{\{ steps\.published\.outputs\.app_digest \|\| steps\.app\.outputs\.digest \}\}/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the kernels job hands the chart one JSON of the digests it recorded', { skip: !HAS_JQ && 'jq is not installed' }, () => {
  const kernels = job(PUBLISH, 'kernels')
  assert.match(kernels, /\n {6}images: \$\{\{ steps\.pinned\.outputs\.images \}\}\n/)
  const dir = tempDir('colloq-kernel-pinned-')
  try {
    fs.mkdirSync(path.join(dir, 'kernel-digests'))
    fs.writeFileSync(path.join(dir, 'kernel-digests/kaggle-base'), DIGEST_C + '\n')
    fs.writeFileSync(path.join(dir, 'kernel-digests/base'), DIGEST_B + '\n')
    const out = path.join(dir, 'out')
    const r = bash(runBlock(kernels, 'Pinned references for the chart'), dir,
      { PATH: process.env.PATH!, OWNER: 'Colloq-Edu', RUNNER_TEMP: dir, GITHUB_OUTPUT: out })
    assert.equal(r.status, 0, r.stderr)
    const said = fs.readFileSync(out, 'utf8')
    assert.equal(said.trim().split('\n').length, 1, 'one line: a job output')
    assert.deepEqual(JSON.parse(outputs(out).images!), {
      base: `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_B}`, 'kaggle-base': `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_C}` })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/* ------------------------------------------------------ publish.yml: the chart */

test('the chart job waits for both image jobs, holds its pins, and pushes nothing before the release is known', () => {
  const chart = job(PUBLISH, 'chart')
  assert.match(chart, /\n {4}needs: \[build, app-images, kernels\]\n/)
  assert.match(chart, /\n {4}if: vars\.PUBLISH_IMAGES == 'true'\n/)
  assert.match(chart, /\n {6}contents: write\n {6}packages: write\n/)
  assert.match(chart, /APP_IMAGE: \$\{\{ needs\.app-images\.outputs\.app \}\}/)
  assert.match(chart, /RUNTIME_IMAGE: \$\{\{ needs\.app-images\.outputs\.runtime \}\}/)
  assert.match(chart, /KERNEL_IMAGES: \$\{\{ needs\.kernels\.outputs\.images \}\}/)
  assert.doesNotMatch(chart, /imagetools inspect/, 'the digests come from the image jobs, not from a lookup')
  const order = ['- name: Install helm', '- name: Write the release into the chart', '- name: Refuse a tag without a GitHub Release',
    'helm registry login', 'helm push', '- name: Attach the chart to the GitHub Release']
  const at = order.map((mark) => chart.indexOf(mark))
  assert.ok(at.every((i) => i > 0), `missing: ${order.filter((_, i) => at[i]! < 0).join(', ')}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'steps out of order')
  // The same helm, pinned by checksum, in the release and in the end-to-end check.
  const pin = (text: string, key: string) => new RegExp(`\\n {6}${key}: (\\S+)\\n`).exec(text)?.[1]
  assert.match(pin(chart, 'HELM_VERSION') ?? '', /^v3\.\d+\.\d+$/)
  assert.match(pin(chart, 'HELM_SHA256') ?? '', /^[a-f0-9]{64}$/)
  assert.equal(pin(E2E, 'HELM_VERSION'), pin(chart, 'HELM_VERSION'))
  assert.equal(pin(E2E, 'HELM_SHA256'), pin(chart, 'HELM_SHA256'))
  assert.match(runBlock(chart, 'Install helm'), /printf '%s {2}%s\\n' "\$HELM_SHA256" "\$archive" \| sha256sum --check --status/)
  // The header names both new jobs.
  assert.match(PUBLISH.slice(0, PUBLISH.indexOf('\nname: Publish')), /#\s+app-images\s[\s\S]*#\s+chart\s/)
})

test('the chart job writes the release, packages it and finds every digest in what the package renders', () => {
  const dir = tempDir('colloq-chart-job-')
  try {
    const work = path.join(dir, 'work')
    chartDir(work)
    fs.mkdirSync(path.join(work, 'scripts'))
    fs.symlinkSync(path.join(ROOT, 'scripts/chart-values.py'), path.join(work, 'scripts/chart-values.py'))
    spawnSync('git', ['init', '-q'], { cwd: work })
    const log = path.join(dir, 'helm.log')
    // package keeps the written values as the "package"; template prints them,
    // or nothing when BLIND is set; show chart reads the version from the name.
    const PATH = standIns(dir, { helm: `printf '%s\\n' "$*" >> "$LOG"
case "$1" in
  lint) exit 0 ;;
  package) v=$(sed -n 's/^version: //p' "$2/Chart.yaml"); cp "$2/values.yaml" "$4/colloq-$v.tgz" ;;
  show) b=$(basename "$3" .tgz); echo "version: \${b#colloq-}" ;;
  template) [ -n "$BLIND" ] || cat "$3" ;;
esac
` })
    const script = runBlock(job(PUBLISH, 'chart'), 'Write the release into the chart')
    const env = { PATH, LOG: log, VERSION: '0.10.0', APP_IMAGE: `ghcr.io/colloq-edu/colloq-app@${DIGEST_A}`,
      RUNTIME_IMAGE: `ghcr.io/colloq-edu/colloq-runtime@${DIGEST_A}`,
      KERNEL_IMAGES: JSON.stringify({ base: `ghcr.io/colloq-edu/colloq-kernel@${DIGEST_B}` }) }
    const ok = bash(script, work, env)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.ok(fs.existsSync(path.join(work, 'out/values-0.10.0.yaml')))
    assert.ok(fs.readFileSync(path.join(work, 'deploy/helm/colloq/values.yaml'), 'utf8').includes(DIGEST_B))
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['lint', 'package', 'show', 'template'])
    assert.equal(calls[3], 'template colloq out/colloq-0.10.0.tgz --namespace colloq --set ingress.enabled=false')
    // A package that does not install the release's images is not published.
    fs.rmSync(path.join(work, 'out'), { recursive: true })
    fs.writeFileSync(path.join(work, 'deploy/helm/colloq/values.yaml'), VALUES_YAML)
    const blind = bash(script, work, { ...env, BLIND: '1' })
    assert.equal(blind.status, 1)
    assert.match(blind.stdout, /::error::the packaged chart does not install ghcr\.io\/colloq-edu\/colloq-app@/)
    // And a tag without the chart is said plainly.
    fs.rmSync(path.join(work, 'deploy'), { recursive: true })
    const none = bash(script, work, env)
    assert.equal(none.status, 1)
    assert.match(none.stdout, /deploy\/helm\/colloq is missing at this tag/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the chart job pushes a new version, and attaches the one in the registry on a rerun', () => {
  const dir = tempDir('colloq-chart-push-')
  try {
    const script = runBlock(job(PUBLISH, 'chart'), 'Push the chart unless this version is published')
    const log = path.join(dir, 'helm.log')
    const PATH = standIns(dir, { helm: `printf '%s\\n' "$*" >> "$LOG"
case "$1" in
  registry) cat > "$DIR/password" ;;
  show) [ "$PUBLISHED" = yes ] ;;
  pull) touch "$6/colloq-$4.tgz" ;;
esac
` })
    const run = (published: string) => {
      fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true })
      fs.mkdirSync(path.join(dir, 'out'))
      fs.writeFileSync(path.join(dir, 'out/colloq-0.10.0.tgz'), 'this build')
      fs.rmSync(log, { force: true })
      const r = bash(script, dir, { PATH, LOG: log, DIR: dir, PUBLISHED: published, OWNER: 'Colloq-Edu', VERSION: '0.10.0',
        ACTOR: 'someone', TOKEN: 'ghs_secret' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      return fs.readFileSync(log, 'utf8').trim().split('\n')
    }
    const fresh = run('no')
    assert.deepEqual(fresh, ['registry login ghcr.io --username someone --password-stdin',
      'show chart oci://ghcr.io/colloq-edu/charts/colloq --version 0.10.0',
      'push out/colloq-0.10.0.tgz oci://ghcr.io/colloq-edu/charts'])
    // The token goes in on stdin, never in the arguments.
    assert.equal(fs.readFileSync(path.join(dir, 'password'), 'utf8'), 'ghs_secret')
    const rerun = run('yes')
    assert.deepEqual(rerun.slice(1), ['show chart oci://ghcr.io/colloq-edu/charts/colloq --version 0.10.0',
      'pull oci://ghcr.io/colloq-edu/charts/colloq --version 0.10.0 --destination out'])
    assert.equal(fs.readFileSync(path.join(dir, 'out/colloq-0.10.0.tgz'), 'utf8'), '', 'the registry\'s package, not this build')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the chart job attaches only what the release lacks, never over a file of the same name', () => {
  const dir = tempDir('colloq-chart-attach-')
  try {
    const script = runBlock(job(PUBLISH, 'chart'), 'Attach the chart to the GitHub Release')
    assert.doesNotMatch(script, /gh release upload[^\n]*--clobber/)
    const log = path.join(dir, 'gh.log')
    const PATH = standIns(dir, { gh: `if [ "$1 $2" = "release view" ]; then printf '%s\\n' $ASSETS; exit 0; fi
printf '%s\\n' "$*" >> "$LOG"
` })
    const run = (assets: string) => {
      fs.rmSync(log, { force: true })
      const r = bash(script, dir, { PATH, LOG: log, ASSETS: assets, TAG: 'v0.10.0', VERSION: '0.10.0' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      return { calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '', said: r.stdout }
    }
    assert.equal(run('colloq-0.9.0.tgz').calls, 'release upload v0.10.0 out/colloq-0.10.0.tgz out/values-0.10.0.yaml')
    assert.equal(run('colloq-0.10.0.tgz').calls, 'release upload v0.10.0 out/values-0.10.0.yaml')
    const both = run('colloq-0.10.0.tgz values-0.10.0.yaml')
    assert.equal(both.calls, '')
    assert.match(both.said, /already carries the chart and its values/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('release.yml takes the tags publish.yml pushed rather than moving them', () => {
  // scripts/release-build.py · published: see tests/release-source.test.mts for the behaviour.
  const builder = read('scripts/release-build.py')
  assert.ok(builder.indexOf('digest = published(tag)') < builder.indexOf("cmd = ['docker', 'buildx', 'build'"))
  assert.match(PUBLISH, /takes the app, broker and kernel tags this\n# workflow has published as they are/)
})

/* ------------------------------------------------------------ k8s-e2e.yml */

test('the end-to-end workflow runs on chart and runtime changes, nightly and by hand, with a read-only token', () => {
  const on = E2E.slice(E2E.indexOf('\non:\n'), E2E.indexOf('\npermissions:'))
  for (const changed of ['deploy/helm/**', 'runtime/**', 'server/src/kernel/**', 'Dockerfile', 'scripts/k8s-e2e.mts',
    'scripts/e2e.mts', 'scripts/chart-values.py', '.github/workflows/k8s-e2e.yml']) {
    assert.ok(on.includes(`      - '${changed}'\n`), `a change to ${changed} does not run it`)
  }
  assert.match(on, /\n {2}schedule:\n {4}- cron: '[\d*]+ [\d*]+ \* \* \*'\n/)
  assert.match(on, /\n {2}workflow_dispatch:\n/)
  assert.match(E2E, /\npermissions:\n {2}contents: read\n\n/)
  // Local images only: no registry login, no write permission, no secret.
  assert.doesNotMatch(E2E, /packages: write|docker\/login-action|secrets\.|ghcr\.io\/\$\{/)
  for (const tag of E2E.matchAll(/\n {10}tags: (\S+)\n/g)) assert.match(tag[1]!, /^localhost:\$\{\{ env\.REGISTRY_PORT \}\}\/colloq-edu\//)
  assert.equal([...E2E.matchAll(/\n {10}push: true\n/g)].length, 3)
  const minutes = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(E2E)?.[1])
  assert.ok(minutes >= 25 && minutes <= 45, `timeout ${minutes}`)
})

test('the end-to-end cluster is the pinned k3s and the oldest the chart accepts, with two agents, and the namespace denies everything before the chart', () => {
  const pin = (key: string) => new RegExp(`\\n {6}${key}: (\\S+)\\n`).exec(E2E)?.[1]
  const entries = [...E2E.matchAll(/\n {10}- kubernetes: '(\d+\.\d+)'\n {12}k3s-image: (\S+)\n {12}kubectl: (\S+)\n/g)]
    .map(([, minor, image, kubectl]) => ({ minor: minor!, image: image!, kubectl: kubectl! }))
  assert.equal(entries.length, 2, 'two Kubernetes versions')
  for (const entry of entries) {
    // Each entry is the Kubernetes it says, with the kubectl of the same version.
    const version = /^rancher\/k3s:v(\d+\.\d+\.\d+)-k3s\d+$/.exec(entry.image)?.[1]
    assert.ok(version?.startsWith(`${entry.minor}.`), `${entry.image} is not Kubernetes ${entry.minor}`)
    assert.equal(entry.kubectl, `v${version}`)
  }
  // The same k3s as the competition smoke...
  const smokeImage = /k3sImage: '([^']+)'/.exec(read('scripts/competition-k3s-smoke.mts'))?.[1]
  assert.ok(entries.some((entry) => entry.image === smokeImage), `no entry runs ${smokeImage}`)
  // ...and the oldest Kubernetes the chart installs on.
  const oldest = /\nkubeVersion: ">=(\d+\.\d+)\.0-0"\n/.exec(read('deploy/helm/colloq/Chart.yaml'))?.[1]
  assert.ok(oldest && entries.some((entry) => entry.minor === oldest), `no entry runs Kubernetes ${oldest}`)
  assert.match(E2E, /\n {6}fail-fast: false\n/)
  assert.match(E2E, /\n {6}K3S_IMAGE: \$\{\{ matrix\.k3s-image \}\}\n/)
  assert.match(E2E, /\n {6}KUBECTL_VERSION: \$\{\{ matrix\.kubectl \}\}\n/)
  assert.equal(pin('K3D_VERSION'), /k3d\/releases\/download\/(v[\d.]+)\/k3d-linux-amd64/.exec(read('.github/workflows/competition-k3s-smoke.yml'))?.[1])
  const create = runBlock(E2E, 'Create the registry and a cluster of one server and two agents')
  assert.match(create, /--servers 1 --agents 2 /)
  assert.match(create, /--registry-use "k3d-\$REGISTRY:5000"/)
  assert.match(create, /--kubeconfig-update-default=false --kubeconfig-switch-context=false/)
  assert.doesNotMatch(E2E, /disable-network-policy/)
  const order = ['- name: A namespace that denies all traffic', '- name: Write this build into the chart as a release would',
    'helm install colloq deploy/helm/colloq', '- name: Pull the kernel onto the app', 'run: node --import tsx scripts/k8s-e2e.mts']
  const at = order.map((mark) => E2E.indexOf(mark))
  assert.ok(at.every((i) => i > 0), `missing: ${order.filter((_, i) => at[i]! < 0).join(', ')}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'steps out of order')
  assert.match(E2E, /\n {6}- name: Dump the cluster\n {8}if: failure\(\)\n/)

  const dir = tempDir('colloq-e2e-namespace-')
  try {
    const log = path.join(dir, 'kubectl.log')
    const PATH = standIns(dir, { kubectl: `printf '%s\\n' "$*" >> "$LOG"
[ "$1" = apply ] && cat >> "$LOG"
exit 0
` })
    const r = bash(runBlock(E2E, 'A namespace that denies all traffic and enforces restricted Pod Security'), dir,
      { PATH, LOG: log, NAMESPACE: 'colloq-e2e' })
    assert.equal(r.status, 0, r.stderr)
    const said = fs.readFileSync(log, 'utf8')
    assert.match(said, /^create namespace colloq-e2e\n/)
    assert.match(said, new RegExp(`label namespace colloq-e2e ${DISPOSABLE_LABEL}=disposable pod-security\\.kubernetes\\.io/enforce=restricted `))
    // Every Pod of the namespace, both directions, nothing allowed.
    assert.ok(said.includes('kind: NetworkPolicy\nmetadata:\n  name: default-deny\nspec:\n  podSelector: {}\n  policyTypes: [Ingress, Egress]\n'), said)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the end-to-end chart takes the release values through a mirror, on ReadWriteOnce storage, and must turn co-location on', () => {
  const write = runBlock(E2E, 'Write this build into the chart as a release would')
  assert.match(write, /python3 scripts\/chart-values\.py /)
  assert.match(write, /--app-image "ghcr\.io\/colloq-edu\/colloq-app@\$APP_DIGEST"/)
  assert.match(write, /--chart deploy\/helm\/colloq /)
  const dir = tempDir('colloq-e2e-install-')
  try {
    const log = path.join(dir, 'calls.log')
    const PATH = standIns(dir, {
      helm: `printf 'helm %s\\n' "$*" >> "$LOG"\n`,
      kubectl: `printf 'kubectl %s\\n' "$*" >> "$LOG"
case "$*" in *RUNTIME_COLOCATE_WITH_APP*) printf '%s' "$COLOCATE" ;; esac
`,
    })
    const run = (colocate: string) => bash(runBlock(E2E, 'Install the chart'), dir,
      { PATH, LOG: log, COLOCATE: colocate, RUNNER_TEMP: dir, REGISTRY: 'colloq-e2e-registry', NAMESPACE: 'colloq-e2e' })
    const ok = run('1')
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.equal(fs.readFileSync(path.join(dir, 'e2e-values.yaml'), 'utf8'),
      'global:\n  imageRegistry: k3d-colloq-e2e-registry:5000\npersistence:\n  accessMode: ReadWriteOnce\ningress:\n  enabled: false\n')
    assert.match(fs.readFileSync(log, 'utf8'),
      new RegExp(`^helm install colloq deploy/helm/colloq --namespace colloq-e2e --values ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/e2e-values\\.yaml --wait --timeout 8m$`, 'm'))
    const off = run('0')
    assert.equal(off.status, 1)
    assert.match(off.stdout, /did not set RUNTIME_COLOCATE_WITH_APP=1/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/* ----------------------------------------------------------- k8s-e2e.mts */

test('k8s-e2e reads the port kubectl chose and knows a Pod pinned to the app', () => {
  assert.equal(forwardedPort('Forwarding from 127.0.0.1:43127 -> 3000\nForwarding from [::1]:43127 -> 3000\n'), 43127)
  assert.equal(forwardedPort('error: unable to forward'), null)
  const term = (labelSelector: unknown, topologyKey = 'kubernetes.io/hostname') =>
    ({ spec: { affinity: { podAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ topologyKey, labelSelector }] } } } })
  assert.equal(pinnedToApp(term({ matchLabels: { 'colloq.dev/role': 'app' } })), true)
  assert.equal(pinnedToApp(term({ matchExpressions: [{ key: 'colloq.dev/role', operator: 'In', values: ['app'] }] })), true)
  assert.equal(pinnedToApp(term({ matchLabels: { 'colloq.dev/role': 'app' } }, 'topology.kubernetes.io/zone')), false)
  assert.equal(pinnedToApp(term({ matchExpressions: [{ key: 'colloq.dev/role', operator: 'In', values: ['app', 'kernel'] }] })), false)
  // Preferred is not required: a busy node would still take the room elsewhere.
  assert.equal(pinnedToApp({ spec: { affinity: { podAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [
    { weight: 100, podAffinityTerm: { topologyKey: 'kubernetes.io/hostname', labelSelector: { matchLabels: { 'colloq.dev/role': 'app' } } } }] } } } }), false)
  assert.equal(pinnedToApp({ spec: {} }), false)
})

test('k8s-e2e finds every broker Pod with a volume that is not next to the app', () => {
  const pinned = { podAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [
    { topologyKey: 'kubernetes.io/hostname', labelSelector: { matchLabels: { 'colloq.dev/role': 'app' } } }] } }
  const pod = (name: string, role: string, node: string | undefined, claims: string[], affinity?: unknown) => ({
    metadata: { name, labels: { 'colloq.dev/role': role } },
    spec: { nodeName: node, affinity, volumes: [...claims.map((claimName) => ({ persistentVolumeClaim: { claimName } })), {}] } })
  assert.deepEqual(colocationProblems([
    pod('room-a', 'kernel', 'agent-0', ['colloq-workspace'], pinned),
    pod('job-b', 'competition-job', undefined, ['colloq-data'], pinned),
    pod('proxy-c', 'competition-proxy', 'agent-1', []),
  ], 'agent-0'), [])
  assert.deepEqual(colocationProblems([
    pod('room-a', 'kernel', 'agent-1', ['colloq-workspace'], pinned),
    pod('job-b', 'competition-job', 'agent-0', ['colloq-data']),
  ], 'agent-0'), [
    'kernel room-a runs on agent-1, the app on agent-0',
    'competition-job job-b mounts colloq-data without a required podAffinity to the app',
  ])
})

test('k8s-e2e claims nothing in a namespace that is not marked disposable', () => {
  const dir = tempDir('colloq-k8s-e2e-refuse-')
  try {
    const log = path.join(dir, 'kubectl.log')
    fs.writeFileSync(path.join(dir, 'kubeconfig'), 'apiVersion: v1\n')
    const PATH = standIns(dir, { kubectl: `printf '%s\\n' "$*" >> "$LOG"
case "$*" in *"get namespace"*) printf '{"metadata":{"labels":{"kubernetes.io/metadata.name":"colloq"}}}' ;; esac
` })
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/k8s-e2e.mts')], { cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, PATH, LOG: log, KUBECONFIG: path.join(dir, 'kubeconfig'), K8S_E2E_NAMESPACE: 'colloq' } })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /namespace colloq is not labelled colloq\.dev\/e2e=disposable/)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(calls.length, 1, calls.join('\n'))
    assert.match(calls[0]!, new RegExp(`^--kubeconfig ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/kubeconfig --namespace colloq get namespace colloq -o json$`))
    // Without a kubeconfig of its own it does not even ask.
    const bare = spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/k8s-e2e.mts')], { cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, PATH, LOG: log, KUBECONFIG: '', K8S_E2E_NAMESPACE: 'colloq' } })
    assert.equal(bare.status, 1)
    assert.match(bare.stderr, /KUBECONFIG must name/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('e2e.mts probes the room network only when asked, with a probe that is valid Python', () => {
  const e2e = read('scripts/e2e.mts')
  assert.match(e2e, /const EXPECT_ISOLATED = process\.env\.E2E_EXPECT_ISOLATED === '1'/)
  assert.match(e2e, /if \(EXPECT_ISOLATED\) \{/)
  assert.match(read('scripts/k8s-e2e.mts'), /E2E_EXPECT_ISOLATED: '1'/)
  const probe = /const ISOLATION_PROBE = `([\s\S]*?)`/.exec(e2e)?.[1]
  assert.ok(probe)
  const compiled = spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "probe", "exec")'], { input: probe, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  assert.match(probe, /closed\("1\.1\.1\.1", 443\)/)
  assert.match(probe, /closed\("kubernetes\.default\.svc", 443\)/)
})
