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
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
  assert.match(ENTRYPOINT, /docker tag "\$\{KERNEL_IMAGE_REPO\}:\$\{tag\}" "colloq-kernel:\$link"/)
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
