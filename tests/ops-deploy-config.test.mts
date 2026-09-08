import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (file: string) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
test('Docker Compose is explicitly development-only and never starts a shared kernel', () => {
  const compose = read('docker-compose.yml')
  assert.match(compose, /target: development/)
  assert.match(compose, /NODE_ENV: development/)
  assert.match(compose, /KERNEL_BACKEND: docker/)
  assert.equal((compose.match(/^  kernel:$/gm) ?? []).length, 1)
  assert.match(compose.split('\n  kernel:')[1]!, /profiles: \[image-build\]/)
  assert.doesNotMatch(compose, /JUPYTER_URL:|depends_on:/)
})
test('production app image excludes Docker clients and root systemd entry point is retired', () => {
  const dockerfile = read('Dockerfile')
  const base = dockerfile.split('AS app-base')[1]!.split('FROM app-base AS development')[0]!
  assert.doesNotMatch(base, /COPY --from=docker:/)
  assert.match(base, /USER node/)
  assert.match(dockerfile, /FROM app-base AS production\s*$/)
  assert.doesNotMatch(read('deploy/colloq.service'), /^User=root$/m)
  assert.match(read('scripts/service.sh'), /cluster.sh install/)
})
