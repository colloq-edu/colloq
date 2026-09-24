/**
 * The rules for serving static files live in three files, and all three are
 * not code but scripts.
 *
 * The Makefile decides whether the build is compressed ahead of time;
 * scripts/host.sh decides whether anyone says out loud that it is not
 * compressed, and whether it goes to the relay; scripts/relay-setup.sh decides
 * whether the relay will serve it. They cannot be checked by running them: one
 * builds the frontend, the second opens a tunnel, the third installs services
 * on someone else's machine. So the decisions themselves are pinned down here
 * — the ones that have already been lost once.
 *
 * This is how they were lost: compression was turned on by the `OPTIMIZE=1`
 * flag, the flag had to be remembered, and nobody remembered it. A build
 * without a single .br went off to the classroom, and the server compressed
 * every file on every request — 219 751 bytes instead of 194 920 and 11.6 ms
 * of CPU time per student.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name: string) => fs.readFileSync(path.join(repo, name), 'utf8')
const makefile = read('Makefile')
const host = read('scripts/host.sh')
const relay = read('scripts/relay-setup.sh')
const load = read('scripts/load.mts')

/** Lines without comments: the comments are exactly where these decisions are described. */
const code = (text: string, mark = '#') =>
  text
    .split('\n')
    .filter((line) => !new RegExp(`^\\s*(@#|${mark})`).test(line))
    .join('\n')

test('the build is compressed ahead of time by default, not by a remembered flag', () => {
  assert.match(
    code(makefile),
    /npm run \$\(if \$\(filter 1,\$\(FAST\)\),build,build:optimized\)/,
    'make run builds without precompression again',
  )
  assert.equal(
    /OPTIMIZE/.test(code(makefile)),
    false,
    'compression is hiding behind a flag that has to be remembered again',
  )
})

test('make host counts uncompressed files and reports them before the link', () => {
  const lines = code(host).split('\n')
  const counted = lines.findIndex((line) => /UNCOMPRESSED="\$\(assets_uncompressed\)"/.test(line))
  const opened = lines.findIndex((line) => /^if \[ "\$VIA" = direct \]; then$/.test(line))
  assert.ok(counted > 0, 'the .br check is gone from host.sh')
  assert.ok(counted < opened, 'the uncompressed build is reported only after the address was opened')
  assert.match(host, /npm run build:optimized/)
})

test('only what really should be compressed counts as uncompressed', () => {
  // The one-kilobyte threshold is the same as in web/scripts/precompress.mjs:
  // smaller files have no .br by design, and complaining about them would mean
  // complaining always.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-dist-'))
  const assets = path.join(fake, 'web/dist/assets')
  fs.mkdirSync(assets, { recursive: true })
  const счёт = (): string => {
    const run = spawnSync(
      'bash',
      ['-c', `${/^assets_uncompressed\(\) \{$[\s\S]*?^\}$/m.exec(host)![0]}\nassets_uncompressed`],
      {
        cwd: fake,
        encoding: 'utf8',
      },
    )
    assert.equal(run.status, 0, run.stderr)
    return run.stdout.trim()
  }
  assert.equal(счёт(), '0', 'an empty build is no reason to complain')
  fs.writeFileSync(path.join(assets, 'tiny-a.js'), 'x'.repeat(500))
  assert.equal(счёт(), '0', 'a complaint about a file that is not compressed by design')
  fs.writeFileSync(path.join(assets, 'big-b.js'), 'x'.repeat(4000))
  assert.equal(счёт(), '1')
  fs.writeFileSync(path.join(assets, 'big-b.js.br'), 'сжато')
  assert.equal(счёт(), '0')
  fs.rmSync(fake, { recursive: true, force: true })
})

test('static files go to the relay after the tunnel, and a failure is not fatal', () => {
  const lines = code(host).split('\n')
  const proxied = lines.findIndex((line) => /no answer from the relay/.test(line))
  const uploaded = lines.findIndex((line) => /^\s*upload_assets$/.test(line))
  assert.ok(uploaded > proxied && proxied > 0, 'the mirror is filled before the tunnel is confirmed')
  const body = /^upload_assets\(\) \{$[\s\S]*?^\}$/m.exec(host)![0]
  assert.match(body, /--upload-file/)
  assert.match(body, /Authorization: Bearer \$\{RELAY_TOKEN\}/)
  assert.equal(/\bdie\b/.test(body), false, 'a failed mirror upload brings down make host')
})

test('the tunnel keeps spare connections and does not compress what is already compressed', () => {
  assert.match(host, /transport\.poolCount = 5/)
  assert.match(relay, /transport\.maxPoolCount = 10/)
  // useCompression over a tunnel that carries already compressed data is
  // paying with CPU for a negative gain. The decision is written down, not
  // forgotten.
  assert.equal(/useCompression\s*=\s*true/.test(host), false)
  assert.match(host, /useCompression is NOT enabled here/)
})

test('the relay serves the mirror itself, and a miss goes to the tunnel', () => {
  // The `file` matcher, not file_server with pass_thru: an empty or stale
  // mirror must neither answer nor set headers.
  assert.match(
    relay,
    /@mirror \{[\s\S]*?host \*\.\$\{DOMAIN\}[\s\S]*?path \/assets\/\* \/fonts\/\* \/pdf\/\*[\s\S]*?file \{[\s\S]*?try_files \{path\}/,
  )
  assert.match(relay, /handle @mirror \{[\s\S]*?precompressed br gzip/)
  assert.match(relay, /header \/assets\/\* Cache-Control "public, max-age=31536000, immutable"/)
  // A font under the same name is replaced by hand: a year of caching for it
  // is a year in which no returning visitor sees the replacement (the same
  // argument as in server/src/app.ts).
  assert.match(relay, /header \/fonts\/\* Cache-Control "public, max-age=3600"/)
  assert.match(relay, /header \/pdf\/\* Cache-Control "public, max-age=3600"/)
  assert.equal(
    /header \/(fonts|pdf)\/\* Cache-Control "[^"]*immutable/.test(relay),
    false,
    'fonts and pdf are cached as immutable for a year again',
  )
  assert.match(relay, /handle \/\.relay\/assets\/\*/)
  assert.match(relay, /reverse_proxy 127\.0\.0\.1:9182/)
  // One user writes the mirror, another reads it; without setgid caddy would
  // get a 403 on every file, that is, the mirror would not work at all.
  assert.match(relay, /install -d -o assets -g caddy -m 2750 \/var\/lib\/colloq-assets/)
  assert.match(relay, /systemctl enable --now frps caddy colloq-capy colloq-assets/)
  assert.match(relay, /colloq-assets-prune\.timer/)
})

test('the relay daemons have room to breathe: swap, limits, descriptors', () => {
  // Measured during a live class: the Linux kernel killed frps or caddy
  // thirty-six times, and every kill broke ALL tunnels at once.
  assert.match(relay, /mkswap \/swapfile/)
  assert.match(relay, /swapon \/swapfile/)
  assert.match(relay, /^MemoryHigh=1536M$/m)
  assert.match(relay, /^MemoryHigh=1024M$/m)
  assert.equal(
    (relay.match(/^LimitNOFILE=65535$/gm) ?? []).length,
    2,
    'descriptors are raised for only one of the two daemons',
  )
})

test('the load stand does not replay to the server what tabs no longer send', () => {
  // A tab stopped echoing other people's presence back
  // (web/src/lib/presence.ts · ownChanges), but the stand kept doing it — and
  // overstated idle CPU 2.7 times.
  assert.match(load, /const ECHO = process\.env\.LOAD_ECHO === '1'/)
  assert.match(makefile, /LOAD_ECHO=1 make load/)
})
