/**
 * The colloq-vast image (deploy/vast/): what must agree with the rest of the
 * code.
 *
 * The image itself is built and checked by real docker in
 * `make vast-image-run` (deploy/vast/smoke.sh: dind instead of a VM, a room, a
 * cell, a copy), and it is not in the suite — not everyone has docker here.
 * But five things break silently — the first four when a NEIGHBOURING file is
 * edited — and people learn about them only on a rented machine. This file
 * holds them:
 *
 *   1. what the Dockerfile copies from the repository exists: rename a script
 *      and the image build fails already in CI, not for the owner right before
 *      renting;
 *   2. the server really allows the docker backend with the environment the
 *      entrypoint gives it (NODE_ENV=development, KERNEL_BACKEND=docker): if
 *      someone forbids docker outside tests, the image comes up and refuses on
 *      the first Run;
 *   3. the kernel image name is the one pool.ts expects: the entrypoint builds
 *      and pulls `colloq-kernel:<environment>`, and a different name means
 *      "environment not built" in every room while the image is built;
 *   4. frpc in the image is the same version as the one installed on the relay
 *      and on the old VM path: the frp protocol has broken between versions;
 *   5. a repeated on-start (a VM reboot) does not touch a live instance: it
 *      does not recreate the container because of the line order in
 *      colloq.env and does not roll the image chosen by `colloq-host update`
 *      back to the one in the template.
 *
 * And, since the image became the university path (0.9.0), what joins it to
 * the rest: the tunnel the entry point picks off Vast (never a quick one), the
 * Cloudflare header it trusts only behind its own cloudflared, the published
 * kernel it pulls and the tag publish.yml pushes, the kernels job itself (run
 * here with a stand-in docker), and the settings colloq-host carries into the
 * container. colloq-host's own behaviour is tests/vast-host.test.mts.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { selectKernelBackend } from '../server/src/kernel/runtime-client.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const DOCKERFILE = read('deploy/vast/Dockerfile')
const ENTRYPOINT = read('deploy/vast/entrypoint.sh')

test('every path the vast Dockerfile copies from the repository exists', () => {
  // Continuation lines (`\`) are joined: COPY can span several lines.
  const lines = DOCKERFILE.replace(/\\\n/g, ' ').split('\n')
  const sources: string[] = []
  for (const line of lines) {
    const match = /^\s*COPY\s+(.*)$/.exec(line)
    if (!match || /--from=/.test(match[1])) continue
    const parts = match[1].trim().split(/\s+/).filter((part) => !part.startsWith('--'))
    sources.push(...parts.slice(0, -1))
  }
  assert.ok(sources.length >= 8, `expected the Dockerfile to copy repository files, got ${sources.join(', ')}`)
  for (const source of sources) {
    assert.ok(fs.existsSync(path.join(ROOT, source)), `deploy/vast/Dockerfile copies ${source}, which does not exist`)
  }
})

test('the server accepts the kernel backend the entrypoint starts it with', () => {
  const block = /exec env \\\n([\s\S]*?)node server\/dist\/server\.js/.exec(ENTRYPOINT)
  assert.ok(block, 'the entrypoint should start the server with an explicit `exec env` block')
  const env: Record<string, string> = {}
  for (const line of block[1].split('\n')) {
    const pair = /^\s*([A-Z_]+)=("?)([^"\s\\]*)\2/.exec(line)
    if (pair) env[pair[1]] = pair[3]
  }
  assert.equal(env.NODE_ENV, 'development')
  assert.equal(env.KERNEL_BACKEND, 'docker')
  assert.equal(env.KERNEL_ISOLATION, 'required')
  assert.equal(selectKernelBackend({ NODE_ENV: env.NODE_ENV, KERNEL_BACKEND: env.KERNEL_BACKEND }), 'docker')
})

test('the entrypoint prepares kernel images under the name the Docker pool runs', () => {
  const pool = read('server/src/kernel/pool.ts')
  const prefix = /const IMAGE_PREFIX = '([^']+)'/.exec(pool)?.[1]
  assert.equal(prefix, 'colloq-kernel')
  assert.match(ENTRYPOINT, /-t "colloq-kernel:\$link"/)
  assert.match(ENTRYPOINT, /docker tag "\$ref" "colloq-kernel:\$link"/)
})

test('the image pins the same frp version as the relay and the VM path', () => {
  const image = /ARG FRP_VERSION=(\S+)/.exec(DOCKERFILE)?.[1]
  assert.ok(image, 'deploy/vast/Dockerfile should pin FRP_VERSION')
  for (const file of ['scripts/relay-setup.sh', 'scripts/vast-legacy.sh']) {
    // With and without quotes: `FRP_VERSION="${FRP_VERSION:-0.71.0}"` and `FRP_VERSION=${FRP_VERSION:-0.71.0}`.
    const pinned = /^FRP_VERSION="?\$\{FRP_VERSION:-([0-9.]+)\}"?/m.exec(read(file))?.[1]
    assert.equal(pinned, image, `${file} pins frp ${pinned}, the image ${image}`)
  }
  for (const arch of ['AMD64', 'ARM64']) {
    assert.match(DOCKERFILE, new RegExp(`ARG FRP_SHA256_${arch}=[0-9a-f]{64}\\b`))
    assert.match(DOCKERFILE, new RegExp(`ARG CLOUDFLARED_SHA256_${arch}=[0-9a-f]{64}\\b`))
  }
})

test('the vast shell scripts parse', () => {
  for (const file of ['entrypoint.sh', 'colloq-host', 'onstart.sh', 'smoke.sh']) {
    const result = spawnSync('bash', ['-n', path.join(ROOT, 'deploy/vast', file)], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file}: ${result.stderr}`)
  }
})

test('a repeated on-start leaves a running instance and its image alone', () => {
  const host = read('deploy/vast/colloq-host')
  // The settings fingerprint decides whether to recreate the container.
  // write_env moves every rewritten key to the end of the file, ensure_gpu
  // appends KERNEL_GPUS last — the same values arrive in a different order,
  // and without sort the second boot of a GPU machine took down the live
  // server (checked with a docker stub).
  const sum = /\nconfig_sum\(\) \{\n([^\n]*)/.exec(host)?.[1] ?? ''
  assert.match(sum, /sort "\$ENV_FILE"/, 'config_sum should hash colloq.env sorted, not in file order')
  // COLLOQ_IMAGE from on-start only seeds /etc/colloq/image; after an update
  // the file belongs to update, otherwise a reboot would roll the version back.
  const image = /\nimage\(\) \{\n([\s\S]*?)\n\}/.exec(host)?.[1] ?? ''
  assert.match(image, /elif \[ ! -s "\$IMAGE_FILE" \] && \[ -n "\$\{COLLOQ_IMAGE:-\}" \]/,
    'COLLOQ_IMAGE should only seed /etc/colloq/image, never overwrite it')
})

// ------------------------------------------------ the university path (0.9.0)

/** One function of a shell script, `name() {` to the `}` that closes it at the start of a line. */
function shellFunction(source: string, name: string): string {
  const found = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(source)
  assert.ok(found, `${name}() is not in the script`)
  return found[0]
}

const SHELL_HEAD = `set -euo pipefail
say()  { printf '[vast] %s\\n' "$*"; }
warn() { printf '[vast] WARNING: %s\\n' "$*" >&2; }
die()  { printf '[vast] ERROR: %s\\n' "$*" >&2; exit "\${2:-1}"; }
`

/** Run functions lifted out of the entry point, with nothing of this process's environment but PATH. */
function runLifted(names: string[], tail: string, env: Record<string, string>, extraPath = '') {
  const body = SHELL_HEAD + names.map((n) => shellFunction(ENTRYPOINT, n)).join('\n') + tail
  // stdin from /dev/null: on macOS node's pipes are sockets, and bash on a
  // socket takes itself for an rsh session and reads ~/.bashrc.
  const r = spawnSync('bash', ['-c', body], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${extraPath}${process.env.PATH}`, ...env },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('off Vast, auto opens no quick tunnel: without an address it is none, said loudly', () => {
  const pick = (env: Record<string, string>) =>
    runLifted(['relay_hostname', 'on_vast', 'pick_mode', 'warn_no_address'],
      'PORT=3000; MODE=""; PUBLIC=""\npick_mode; warn_no_address\nprintf "%s %s" "$MODE" "$PUBLIC"\n', env)
  let r = pick({})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'none http://localhost:3000')
  assert.match(r.stderr, /no public address: PUBLIC_URL is not set, and no tunnel is configured/)
  r = pick({ COLLOQ_TUNNEL: 'none' })
  assert.equal(r.stdout, 'none http://localhost:3000')
  assert.match(r.stderr, /no public address/)
  // A university's proxy in front.
  r = pick({ PUBLIC_URL: 'https://colloq.example.edu' })
  assert.equal(r.stdout, 'none https://colloq.example.edu')
  assert.equal(r.stderr, '')
  // Vast keeps its old default, by the on-start's flag or Vast's own variable.
  assert.equal(pick({ COLLOQ_ON_VAST: '1' }).stdout, 'cloudflare ')
  assert.equal(pick({ COLLOQ_ON_VAST: '1' }).stderr, '')
  assert.equal(pick({ VAST_CONTAINERLABEL: 'C.51006376' }).stdout, 'cloudflare ')
  // Asked for in so many words, the quick tunnel opens anywhere.
  assert.equal(pick({ COLLOQ_TUNNEL: 'cloudflare' }).stdout, 'cloudflare ')
  // The configured tunnels are chosen as before, on Vast or not.
  assert.equal(pick({ COLLOQ_HOSTNAME: 'class1', RELAY_DOMAIN: 'relay.example.org', RELAY_ADDR: '192.0.2.7', RELAY_TOKEN: 't' }).stdout,
    'relay https://class1.relay.example.org')
  assert.equal(pick({ CLOUDFLARE_TUNNEL_TOKEN: 't', COLLOQ_HOSTNAME: 'class.example.org' }).stdout, 'cloudflare https://class.example.org')
})

test('the server trusts CF-Connecting-IP behind the container\'s own cloudflared, and only there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-vast-server-'))
  try {
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nenv > "$DUMP"\n', { mode: 0o755 })
    const seen = (mode: string, env: Record<string, string> = {}) => {
      const dump = path.join(dir, `env-${mode}-${Object.keys(env).length}`)
      const r = runLifted(['start_server'],
        `APP='${dir}'; NET=colloq; STATE=/s; HOST_STATE=/h; PORT=3000; SERVER_PID=""; MODE='${mode}'\nstart_server; wait "$SERVER_PID"\n`,
        { DUMP: dump, ...env }, `${dir}:`)
      assert.equal(r.status, 0, r.stderr)
      const line = fs.readFileSync(dump, 'utf8').split('\n').find((l) => l.startsWith('TRUST_CF_CONNECTING_IP='))
      return line?.slice('TRUST_CF_CONNECTING_IP='.length)
    }
    assert.equal(seen('cloudflare'), '1')
    assert.equal(seen('relay'), '')
    assert.equal(seen('none'), '')
    assert.equal(seen('cloudflare', { TRUST_CF_CONNECTING_IP: '0' }), '0', 'an explicit value still wins')
    assert.equal(seen('none', { TRUST_CF_CONNECTING_IP: '1' }), '1', 'a Cloudflare tunnel of the operator\'s own, in front of none')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the entry point pulls the tag publish.yml pushes, and builds what was never published', () => {
  const ref = (env: Record<string, string>, link = 'base', edited = '0') =>
    runLifted(['kernel_pull_ref'], `kernel_pull_ref '${link}' '${edited}'\n`, { VERSION: '0.9.0', ...env }).stdout
  // The same shape as publish.yml's "$repo:v$VERSION-$name".
  assert.equal(ref({}), 'ghcr.io/colloq-edu/colloq-kernel:v0.9.0-base')
  assert.equal(ref({}, 'kaggle-base'), 'ghcr.io/colloq-edu/colloq-kernel:v0.9.0-kaggle-base')
  assert.equal(ref({ COLLOQ_KERNEL_REPO: 'ghcr.io/a-fork/colloq-kernel' }), 'ghcr.io/a-fork/colloq-kernel:v0.9.0-base')
  // A development image has no published tag to look for.
  assert.equal(ref({ VERSION: '0.0.0-dev' }), '')
  // A list the operator redefined (or a parent of it) is never swapped for the shipped one.
  assert.equal(ref({}, 'base', '1'), '')
  // An operator's own registry is asked as it always was; `none` builds everything.
  assert.equal(ref({ KERNEL_IMAGE_REPO: 'registry.example/colloq-kernel' }, 'mycourse', '1'), 'registry.example/colloq-kernel:v0.9.0-mycourse')
  assert.equal(ref({ KERNEL_IMAGE_REPO: 'none' }), '')
  assert.equal(ref({ KERNEL_IMAGE_TAG: 'v0.9.0-rc.1' }), 'ghcr.io/colloq-edu/colloq-kernel:v0.9.0-rc.1-base')
  const publish = read('.github/workflows/publish.yml')
  assert.match(publish, /ref="\$repo:v\$VERSION-\$name"/)
  // The default the entry point uses is the one the image is built with.
  assert.match(DOCKERFILE, /^ARG COLLOQ_KERNEL_REPO=ghcr\.io\/colloq-edu\/colloq-kernel$/m)
  assert.match(DOCKERFILE, /COLLOQ_KERNEL_REPO=\$\{COLLOQ_KERNEL_REPO\}/)
  assert.match(publish, /COLLOQ_KERNEL_REPO=\$\{\{ steps\.image\.outputs\.kernels \}\}/)
  assert.match(publish, /echo "kernels=ghcr\.io\/\$\{OWNER,,\}\/colloq-kernel"/)
  // Offline, nothing is pulled or built: the check comes before either.
  const prepare = shellFunction(ENTRYPOINT, 'prepare_kernels')
  assert.ok(prepare.indexOf('if offline; then') < prepare.indexOf('kernel_pull_ref'), 'offline must be decided before any pull')
  assert.ok(prepare.indexOf('if offline; then') < prepare.indexOf('build -f'), 'offline must be decided before any build')
})

/** The `run: |` block of one job's step, dedented, read without a YAML parser (the repo has none). */
function jobScript(workflow: string, job: string): string {
  const at = workflow.indexOf(`\n  ${job}:\n`)
  assert.ok(at >= 0, `no ${job} job`)
  const next = workflow.slice(at + 1).search(/\n {2}[a-z-]+:\n/)
  const text = next < 0 ? workflow.slice(at) : workflow.slice(at, at + 1 + next)
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === '        run: |')
  assert.ok(start >= 0, `${job} has no run block`)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break
    body.push(line.slice(10))
  }
  return body.join('\n')
}

test('the kernels job publishes base and kaggle-base, parents first, checked before the push', () => {
  const publish = read('.github/workflows/publish.yml')
  const at = publish.indexOf('\n  kernels:\n')
  const job = publish.slice(at)
  assert.match(job, /\n {4}needs: build\n/)
  assert.match(job, /\n {4}if: vars\.PUBLISH_IMAGES == 'true'\n/)
  assert.match(job, /\n {10}ENVIRONMENTS: base kaggle-base\n/)
  assert.doesNotMatch(job.slice(0, job.indexOf('run: |')), /base-gpu/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-kernels-job-'))
  try {
    fs.writeFileSync(path.join(dir, 'job.sh'), jobScript(publish, 'kernels'))
    fs.mkdirSync(path.join(dir, 'bin'))
    // A docker that publishes nothing but what PUBLISHED names, and a jq that
    // reads the digest buildx would have written.
    fs.writeFileSync(path.join(dir, 'bin', 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then
  case " $PUBLISHED " in *" $4 "*) case "$*" in *--format*) echo "sha256:$(printf '%064d' 7)" ;; esac; exit 0 ;; esac
  exit 1
fi
if [ "$1 $2" = "buildx build" ]; then
  while [ "$#" -gt 0 ]; do [ "$1" = --metadata-file ] && printf '{"containerimage.digest":"sha256:%064d"}' 1 > "$2"; shift; done
fi
exit 0
`, { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'bin', 'jq'), `#!${process.execPath}\nconst f = process.argv[process.argv.length - 1]\nconsole.log(JSON.parse(require('node:fs').readFileSync(f, 'utf8'))['containerimage.digest'])\n`, { mode: 0o755 })
    const run = (published: string) => {
      const log = path.join(dir, `log-${published.length}`)
      const r = spawnSync('bash', [path.join(dir, 'job.sh')], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, LOG: log, PUBLISHED: published, OWNER: 'Colloq-Edu',
          VERSION: '0.9.0', COMMIT: 'c0ffee', SOURCE_URL: 'https://github.com/colloq-edu/colloq', ENVIRONMENTS: 'base kaggle-base',
          RUNNER_TEMP: dir },
      })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      return fs.readFileSync(log, 'utf8').trim().split('\n')
    }
    const repo = 'ghcr.io/colloq-edu/colloq-kernel'
    let calls = run('')
    const builds = calls.filter((c) => c.startsWith('buildx build'))
    assert.equal(builds.length, 4, calls.join('\n'))
    const [baseLoad, basePush, kaggleLoad, kagglePush] = builds
    for (const b of [baseLoad!, basePush!]) {
      assert.match(b, /--platform linux\/amd64 -f kernel\/Dockerfile --build-arg KERNEL_ENV=base /)
      // No python directive in base.txt: the Dockerfile's own default, no second copy of its name.
      assert.doesNotMatch(b, /PARENT=/)
    }
    assert.match(baseLoad!, /--load -t colloq-kernel:base kernel$/)
    assert.match(basePush!, /--push --provenance=mode=max --sbom=true --metadata-file \S+ -t ghcr\.io\/colloq-edu\/colloq-kernel:v0\.9\.0-base kernel$/)
    // kaggle-base stands on the base image just published, pinned by its digest.
    for (const b of [kaggleLoad!, kagglePush!]) assert.ok(b.includes(`--build-arg PARENT=${repo}@sha256:${'0'.repeat(63)}1`), b)
    assert.match(kagglePush!, /-t ghcr\.io\/colloq-edu\/colloq-kernel:v0\.9\.0-kaggle-base kernel$/)
    for (const b of builds) {
      assert.match(b, /--label org\.opencontainers\.image\.version=0\.9\.0 /)
      assert.match(b, /--label colloq\.environment=(base|kaggle-base) /)
    }
    // Each image is run once before its push: kaggle-base by the kernel/locks check, with no network.
    const runs = calls.filter((c) => c.startsWith('run '))
    assert.equal(runs.length, 2)
    assert.ok(calls.indexOf(runs[0]!) < calls.indexOf(basePush!))
    assert.ok(calls.indexOf(runs[1]!) < calls.indexOf(kagglePush!))
    assert.match(runs[1]!, /--network none .*scripts\/check-kaggle-base\.py:\/check\.py:ro colloq-kernel:kaggle-base python \/check\.py$/)
    // A rerun skips what is published and builds the rest on it.
    calls = run(`${repo}:v0.9.0-base`)
    assert.equal(calls.filter((c) => c.includes('KERNEL_ENV=base ')).length, 0, calls.join('\n'))
    assert.ok(calls.filter((c) => c.startsWith('buildx build')).every((c) => c.includes(`PARENT=${repo}@sha256:${'0'.repeat(63)}7`)), calls.join('\n'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the server image is pushed as colloq-vast and colloq-server in one build', () => {
  const publish = read('.github/workflows/publish.yml')
  assert.match(publish, /server="ghcr\.io\/\$\{OWNER,,\}\/colloq-server"/)
  assert.match(publish, /tags="\$name:\$VERSION,\$server:\$VERSION"/)
  assert.match(publish, /tags="\$tags,\$name:latest,\$server:latest"/)
  // A version published before the name existed gets it copied, not rebuilt.
  assert.match(publish, /docker buildx imagetools create -t "\$SERVER:\$VERSION" "\$NAME@\$digest"/)
})

test('colloq-host carries the settings of the university contract into the container', () => {
  const host = read('deploy/vast/colloq-host')
  const keys = /\nAPP_KEYS="([^"]*)"/.exec(host)?.[1]?.split(/\s+/) ?? []
  for (const key of ['TRUSTED_PROXIES', 'TRUST_CF_CONNECTING_IP', 'SHARED_ADDRESSES', 'HSTS', 'HTTPS_PROXY', 'HTTP_PROXY',
    'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'DEPENDENCY_INDEX_URL', 'DEPENDENCY_FILES_HOSTS',
    'COLLOQ_ROOM_NETWORK', 'KERNEL_BLOCKED_CIDRS', 'BACKUP_KEEP', 'COLLOQ_HELPER_IMAGE', 'COLLOQ_OFFLINE', 'COLLOQ_ON_VAST',
    // Sign-in by proxy (server/src/sso/identity.ts): a VM behind Teleport needs every one of them.
    'AUTH_JWT_JWKS_URL', 'AUTH_JWT_JWKS_FILE', 'AUTH_JWT_HEADER', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE', 'AUTH_JWT_ALGORITHMS',
    'AUTH_JWT_LEEWAY_SECONDS', 'AUTH_JWT_SUBJECT_CLAIM', 'AUTH_JWT_NAME_CLAIM', 'AUTH_JWT_EMAIL_CLAIM', 'AUTH_JWT_ROLES_CLAIM',
    'AUTH_JWT_EMAIL_DOMAIN', 'AUTH_JWT_TEACHER_ROLES', 'AUTH_JWT_OWNER_ROLES']) {
    assert.ok(keys.includes(key), `APP_KEYS lacks ${key}`)
  }
  // The Vast on-start names the two Vast-only behaviours itself.
  const onstart = read('deploy/vast/onstart.sh')
  assert.match(onstart, /^export COLLOQ_ON_VAST=1$/m)
  assert.match(onstart, /^export COLLOQ_FREEZE_UPDATES=1$/m)
  assert.ok(onstart.indexOf('export COLLOQ_FREEZE_UPDATES=1') < onstart.indexOf('exec /usr/local/sbin/colloq-host up'))
})

test('the vast files name only the environments that exist', () => {
  const shipped = fs.readdirSync(path.join(ROOT, 'kernel/environments')).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4))
  assert.deepEqual(shipped.sort(), ['base', 'base-gpu', 'kaggle-base'])
  for (const file of ['deploy/vast/onstart.sh', 'deploy/vast/README.md', 'deploy/vast/entrypoint.sh', 'deploy/vast/colloq-host']) {
    const text = read(file)
    assert.doesNotMatch(text, /base,gpu\b|KERNEL_MEM_GPU\b|\bgpu stands on\b|kernel\/environments\/(cv|gpu|pvz-geo)\.txt/, file)
  }
})
