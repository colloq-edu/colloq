/**
 * README and .env.example are a contract too, and here it is checked against
 * the code.
 *
 * Two things a teacher was told nowhere, and they cost a class.
 *
 * BIND_ADDR was known only to the code (server/src/index.ts) and the systemd
 * unit. Neither the README settings table nor .env.example mentioned it, so
 * `make run` on a laptop in a classroom also served the room at
 * http://<laptop-ip>:3000 — bypassing the issued link and the tunnel. Under
 * `make up` the same door was open through publishing the port without an
 * address, even though docker-compose.dev.yml closes exactly that for 8888
 * and explains it.
 *
 * The council runs attempts in the room's ONE kernel: an attempt sees the
 * `df` the teacher prepared in the shared cell, and that is on purpose — but
 * it gets its own data, and the namespace returns to what it was after it.
 * What stays shared meanwhile is files and module state. The room says so
 * (COUNCIL_SHARED_KERNEL_NOTE), and the README about the modes must say the
 * same: the teacher marks "correct" based on the output.
 *
 * Only the "word" is checked here, because the "deed" is checked by the
 * neighbours: ban/gate/kernel by their own suites, while nobody builds or
 * type-checks these two files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const readme = read('README.md')
const example = read('.env.example')
const compose = read('docker-compose.yml')

test('BIND_ADDR is named both in .env.example and in the README settings table', () => {
  // Explain the host bind address and keep the shipped example on loopback.
  const at = example.indexOf('BIND_ADDR')
  assert.notEqual(at, -1, 'BIND_ADDR is not named in .env.example')
  const about = example.slice(Math.max(0, at - 900), at + 200)
  assert.match(about, /127\.0\.0\.1/)
  assert.match(about, /make up/)
  assert.match(about, /make host/, 'it is not said how the room goes outside instead of an open port')

  const row = readme.split('\n').find((l) => l.startsWith('| `BIND_ADDR`'))
  assert.ok(row, 'the README settings table has no BIND_ADDR row')
  assert.match(row, /every interface/i)
  assert.match(row, /127\.0\.0\.1/)

  assert.match(example, /^BIND_ADDR=127\.0\.0\.1$/m)
})

test('the server variable and the port publishing address are one word, not two', () => {
  // BIND_ADDR must not be passed into the container: there the server must
  // listen on all interfaces, otherwise even the published port cannot be
  // reached. So compose limits the HOST side of the port with it — and only
  // that side.
  const app = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  kernel:'))
  assert.match(app, /- "\$\{BIND_ADDR:-0\.0\.0\.0\}:\$\{PORT:-3000\}:3000"/)
  assert.ok(
    !/\n {6}BIND_ADDR: /.test(app),
    'BIND_ADDR went into the container environment — the server inside will listen on the container loopback, that is, to nobody',
  )

  // Production ingress is a loopback NodePort, with no root systemd web process.
  assert.match(read('scripts/cluster.sh'), /nodeport-addresses=127\.0\.0\.0\/8/)
  assert.doesNotMatch(read('deploy/colloq.service'), /^User=root$/m)

  // The code's default is empty, that is, all interfaces: the README table
  // describes exactly that, and renaming the variable in the server will
  // break this line.
  assert.match(read('server/src/index.ts'), /process\.env\.BIND_ADDR/)
})

test('deployment documentation describes mandatory broker isolation and explicit development limits', () => {
  for (const file of ['runtime/README.md', 'deploy/k3s/README.md', 'docs/deployment-vast.md']) {
    assert.ok(readme.includes(file), `missing operational documentation link: ${file}`)
  }
  for (const variable of ['KERNEL_BACKEND', 'KERNEL_RUNTIME_URL', 'KERNEL_RUNTIME_TOKEN_FILE', 'KERNEL_CATALOG_FILE', 'COLLOQ_UNSAFE_DEV_FILES']) {
    assert.ok(example.includes(variable), `missing configuration contract: ${variable}`)
  }
  assert.doesNotMatch(example, /^KERNEL_ISOLATION=auto$|KERNEL_ISOLATION=off/m)
  assert.doesNotMatch(example, /^JUPYTER_TOKEN=.+$/m)
  assert.match(read('runtime/README.md'), /\.restore-in-progress/)
  assert.match(readme, /MODE=consistent/)
  assert.match(readme, /live.*not an atomic snapshot/is)
  assert.match(readme, /sourceCommit/)
  // COLLOQ_UNSAFE_DEV_FILES no longer decides anything
  // (server/src/secure-files.ts), and the README does not tell anyone to set
  // it; the development limit that remains is that Linux in production
  // requires /proc/self/fd.
  assert.doesNotMatch(readme, /COLLOQ_UNSAFE_DEV_FILES=1/)
  assert.match(readme, /\/proc\/self\/fd/)
})

test('the README about the council says the same as the room: one kernel', () => {
  const bullet = readme.slice(readme.indexOf('* **council** —'))
  const said = bullet.slice(0, bullet.indexOf('\n\n'))
  assert.match(said, /one kernel/i, 'the README does not say that attempts run in the room\'s shared kernel')
  assert.match(said, /one after another|in turn|queue/i, 'it is not said that it goes in turn')
  // Three halves of the truth: personal copies, removed names, the shared
  // remainder.
  assert.match(said, /personal cop/i, 'the README does not mention personal copies of data')
  assert.match(said, /takes away|removes/i)
  assert.match(said, /stays shared/i)
  // And the copy budget is named in the same place as its cost: what exceeds
  // it is shared.
  assert.match(said, /COUNCIL_COPY_MB/)
})
