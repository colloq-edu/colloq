/**
 * cloudflared without a manual install: which file, from where, and what runs.
 *
 * There is no network here: GitHub is replaced by a fetch function that
 * returns bytes built right in the test, and the pinned table by one of our
 * own, with the sums of those bytes. The real table is checked separately — by
 * its shape, not by a download: the live download is done by
 * `colloq start --share` on a live machine.
 *
 * The main property this file guards: a file from the internet does not become
 * executable until its sum matches the pinned one. A tampered archive, a
 * tampered binary inside a correct archive, one byte over the size — all of it
 * is a refusal, after which <home>/bin holds neither cloudflared nor a
 * temporary file.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  cloudflaredBinary,
  cloudflaredUrl,
  ensureCloudflared,
  pickCloudflaredAsset,
  resolveCloudflared,
  sha256,
  untarFile,
  verifySha256,
  type CloudflaredLookup,
} from '../cli/src/launch-cloudflared.js'
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  type CloudflaredAsset,
} from '../cli/src/launch-cloudflared-pin.js'

/* -------------------------------------------------------- tar in the test */

type Entry = { name: string; body?: string | Buffer; type?: string }

/** A ustar header: just the fields untarFile reads, and an honest checksum. */
function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 100), 0, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(size.toString(8).padStart(11, '0') + '\0', 124)
  block.write('00000000000\0', 136)
  block.write('        ', 148)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return block
}

function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    parts.push(header(entry.name, body.length, entry.type ?? '0'), body)
    const pad = (512 - (body.length % 512)) % 512
    parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

/* ---------------------------------------------------- the pinned table */

test('the pinned table covers exactly the systems the wheel is built for', () => {
  assert.match(CLOUDFLARED_VERSION, /^\d{4}\.\d{1,2}\.\d+$/)
  assert.deepEqual(
    CLOUDFLARED_ASSETS.map((asset) => `${asset.platform}/${asset.arch}`).sort(),
    ['darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64'],
  )
  for (const asset of CLOUDFLARED_ASSETS) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, asset.name)
    assert.match(asset.binarySha256, /^[0-9a-f]{64}$/, asset.name)
    assert.ok(asset.size > 10_000_000 && asset.size < 100_000_000, asset.name)
    // On Linux the downloaded file is the binary itself; on macOS it is an
    // archive, and the sums differ.
    if (asset.archive === 'binary') assert.equal(asset.binarySha256, asset.sha256, asset.name)
    else assert.notEqual(asset.binarySha256, asset.sha256, asset.name)
    assert.equal(
      cloudflaredUrl(asset),
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`,
    )
  }
})

test('asset per platform: macOS gets the .tgz, Linux the raw binary', () => {
  assert.equal(pickCloudflaredAsset('darwin', 'arm64').name, 'cloudflared-darwin-arm64.tgz')
  assert.equal(pickCloudflaredAsset('darwin', 'x64').name, 'cloudflared-darwin-amd64.tgz')
  assert.equal(pickCloudflaredAsset('linux', 'x64').name, 'cloudflared-linux-amd64')
  assert.equal(pickCloudflaredAsset('linux', 'arm64').name, 'cloudflared-linux-arm64')
  assert.equal(pickCloudflaredAsset('darwin', 'arm64').archive, 'tgz')
  assert.equal(pickCloudflaredAsset('linux', 'arm64').archive, 'binary')
})

test('Windows and unknown machines are refused in words, with a way out', () => {
  assert.throws(() => pickCloudflaredAsset('win32', 'x64'), /Windows is not supported.*WSL 2/)
  for (const [platform, arch] of [
    ['linux', 'ia32'],
    ['linux', 'arm'],
    ['freebsd', 'x64'],
  ])
    assert.throws(
      () => pickCloudflaredAsset(platform!, arch!),
      /no pinned cloudflared build.*COLLOQ_CLOUDFLARED=\/path\/to\/cloudflared/,
      `${platform} ${arch}`,
    )
})

/* ------------------------------------------------------ verification */

test('sha256 is checked, and a mismatch names both sums', () => {
  const data = Buffer.from('cloudflared')
  assert.doesNotThrow(() => verifySha256(data, sha256(data), 'x'))
  const wrong = '0'.repeat(64)
  assert.throws(
    () => verifySha256(data, wrong, 'cloudflared-linux-amd64'),
    (error: Error) =>
      error.message.includes(wrong) &&
      error.message.includes(sha256(data)) &&
      /Nothing was saved or run/.test(error.message),
  )
})

test('tar: the one file named cloudflared comes out, in every shape tar writes', () => {
  const binary = Buffer.from('#!/bin/sh\necho tunnel\n')
  assert.deepEqual(untarFile(tar([{ name: 'cloudflared', body: binary }]), 'cloudflared'), binary)
  // bsdtar with ./ in front, a directory and a sibling file next to it.
  assert.deepEqual(
    untarFile(
      tar([
        { name: './', type: '5' },
        { name: './README', body: 'read me' },
        { name: './cloudflared', body: binary },
      ]),
      'cloudflared',
    ),
    binary,
  )
  // A GNU long name (L) and a pax path (x): the entry name comes from them.
  assert.deepEqual(
    untarFile(
      tar([
        { name: '././@LongLink', body: 'cloudflared\0', type: 'L' },
        { name: 'truncated-name', body: binary },
      ]),
      'cloudflared',
    ),
    binary,
  )
  assert.deepEqual(
    untarFile(
      tar([
        { name: 'PaxHeader/x', body: '20 path=cloudflared\n', type: 'x' },
        { name: 'other', body: binary },
      ]),
      'cloudflared',
    ),
    binary,
  )
})

test('tar: no cloudflared, one in a subdirectory, or a cut archive is a refusal', () => {
  assert.throws(() => untarFile(tar([{ name: 'README', body: 'x' }]), 'cloudflared'), /no cloudflared/)
  // Only the entry with this name: bin/cloudflared is someone else's file.
  assert.throws(
    () => untarFile(tar([{ name: 'bin/cloudflared', body: 'x' }]), 'cloudflared'),
    /no cloudflared/,
  )
  const whole = tar([{ name: 'cloudflared', body: Buffer.alloc(2000, 1) }])
  assert.throws(() => untarFile(whole.subarray(0, 1024), 'cloudflared'), /cut short/)
})

/** Our own pinned entry, with the sums of bytes built in the test. */
function fakeAsset(
  platform: 'darwin' | 'linux',
  arch: 'arm64' | 'x64',
  binary: Buffer,
): { asset: CloudflaredAsset; download: Buffer } {
  const download = platform === 'darwin' ? gzipSync(tar([{ name: 'cloudflared', body: binary }])) : binary
  return {
    download,
    asset: {
      platform,
      arch,
      name: platform === 'darwin' ? `cloudflared-${platform}-test.tgz` : `cloudflared-${platform}-test`,
      archive: platform === 'darwin' ? 'tgz' : 'binary',
      size: download.length,
      sha256: sha256(download),
      binarySha256: sha256(binary),
    },
  }
}

test('archive → binary: both sums are checked, the archive before it is opened', () => {
  const binary = Buffer.from('#!/bin/sh\necho mac\n')
  const { asset, download } = fakeAsset('darwin', 'arm64', binary)
  assert.deepEqual(cloudflaredBinary(asset, download), binary)
  // A tampered archive is refused before unpacking.
  const tampered = Buffer.from(download)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => cloudflaredBinary(asset, tampered), /cloudflared-darwin-test\.tgz: the sha256/)
  // A correct archive, but the binary inside is not the pinned one.
  assert.throws(
    () => cloudflaredBinary({ ...asset, binarySha256: '1'.repeat(64) }, download),
    /cloudflared from cloudflared-darwin-test\.tgz: the sha256/,
  )
})

/* --------------------------------------------------------- where to look */

function lookup(over: Partial<CloudflaredLookup> & { files?: Record<string, string> }): CloudflaredLookup {
  const files = over.files ?? {}
  return {
    env: {},
    platform: 'linux',
    arch: 'x64',
    binDir: '/home/t/.colloq/bin',
    executable: (file) => file in files,
    hashOf: (file) => files[file] ?? null,
    ...over,
  }
}

test('lookup order: named file, then PATH, then our verified copy, then a download', () => {
  const linux = pickCloudflaredAsset('linux', 'x64')
  const ours = '/home/t/.colloq/bin/cloudflared'
  const everything = {
    '/opt/cf/cloudflared': 'x',
    '/usr/local/bin/cloudflared': 'y',
    [ours]: linux.binarySha256,
  }
  assert.deepEqual(
    resolveCloudflared(
      lookup({
        env: { COLLOQ_CLOUDFLARED: '/opt/cf/cloudflared', PATH: '/usr/local/bin' },
        files: everything,
      }),
    ),
    { kind: 'use', path: '/opt/cf/cloudflared', source: 'override' },
  )
  assert.deepEqual(
    resolveCloudflared(lookup({ env: { PATH: '/usr/bin:/usr/local/bin' }, files: everything })),
    { kind: 'use', path: '/usr/local/bin/cloudflared', source: 'path' },
  )
  assert.deepEqual(resolveCloudflared(lookup({ env: { PATH: '/usr/bin' }, files: everything })), {
    kind: 'use',
    path: ours,
    source: 'colloq',
  })
  assert.deepEqual(resolveCloudflared(lookup({ env: { PATH: '/usr/bin' } })), {
    kind: 'download',
    asset: linux,
    stale: false,
  })
})

test('our copy runs only verified — even when <home>/bin is on PATH', () => {
  const ours = '/home/t/.colloq/bin/cloudflared'
  // A copy from an earlier colloq version, or a tampered one: the sum is
  // wrong, so download it again.
  const stale = resolveCloudflared(
    lookup({ env: { PATH: '/home/t/.colloq/bin' }, files: { [ours]: 'f'.repeat(64) } }),
  )
  assert.equal(stale.kind, 'download')
  assert.equal(stale.kind === 'download' && stale.stale, true)
})

test('a bad COLLOQ_CLOUDFLARED is a refusal, never a silent fallback', () => {
  const relative = resolveCloudflared(lookup({ env: { COLLOQ_CLOUDFLARED: 'bin/cloudflared' } }))
  assert.equal(relative.kind, 'refuse')
  assert.match(relative.kind === 'refuse' ? relative.message : '', /absolute path/)
  const missing = resolveCloudflared(lookup({ env: { COLLOQ_CLOUDFLARED: '/nowhere/cloudflared' } }))
  assert.equal(missing.kind, 'refuse')
  assert.match(missing.kind === 'refuse' ? missing.message : '', /not an executable file/)
})

test('COLLOQ_CLOUDFLARED_DOWNLOAD=0 forbids the download and says what to do', () => {
  const none = resolveCloudflared(lookup({ env: { COLLOQ_CLOUDFLARED_DOWNLOAD: '0' } }))
  assert.equal(none.kind, 'refuse')
  assert.match(
    none.kind === 'refuse' ? none.message : '',
    /not installed, and downloading is switched off.*brew install cloudflared/,
  )
  const ours = '/home/t/.colloq/bin/cloudflared'
  const stale = resolveCloudflared(
    lookup({ env: { COLLOQ_CLOUDFLARED_DOWNLOAD: '0' }, files: { [ours]: 'old' } }),
  )
  assert.match(stale.kind === 'refuse' ? stale.message : '', /is not the pinned cloudflared/)
})

test('Windows: refused unless a file is named explicitly', () => {
  const refused = resolveCloudflared(lookup({ platform: 'win32' }))
  assert.equal(refused.kind, 'refuse')
  assert.match(refused.kind === 'refuse' ? refused.message : '', /WSL 2/)
})

/* ------------------------------------------------------------ download */

type Fetched = { url: string; redirect?: string }

function fakeFetch(bytes: Buffer, status = 200): { fetch: typeof fetch; seen: Fetched[] } {
  const seen: Fetched[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), redirect: init?.redirect })
    return new Response(status === 200 ? new Uint8Array(bytes) : 'Not Found', { status })
  }) as typeof fetch
  return { fetch: impl, seen }
}

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-cloudflared-'))
}

test('first run downloads, verifies, installs 0755; the second run uses the verified copy', async () => {
  const dir = home()
  try {
    const binary = Buffer.from('#!/bin/sh\necho linux\n')
    const { asset, download } = fakeAsset('linux', 'x64', binary)
    const { fetch, seen } = fakeFetch(download)
    const said: string[] = []
    const options = {
      home: dir,
      env: { PATH: '' },
      platform: 'linux',
      arch: 'x64',
      fetch,
      assets: [asset],
      say: (line: string) => void said.push(line),
    }
    const file = await ensureCloudflared(options)
    assert.equal(file, path.join(dir, 'bin/cloudflared'))
    assert.deepEqual(fs.readFileSync(file), binary)
    assert.equal(fs.statSync(file).mode & 0o777, 0o755)
    // Said out loud: what, which version, and from where.
    assert.deepEqual(seen, [{ url: cloudflaredUrl(asset), redirect: 'follow' }])
    const text = said.join('\n')
    assert.match(text, /cloudflared is not installed: colloq fetches it once/)
    assert.ok(text.includes(`cloudflared ${CLOUDFLARED_VERSION} for Linux x64`), text)
    assert.ok(text.includes(cloudflaredUrl(asset)), text)
    assert.match(text, /sha256 matches the pinned one/)

    const again = await ensureCloudflared({ ...options, say: () => assert.fail('said something') })
    assert.equal(again, file)
    assert.equal(seen.length, 1, 'the verified copy was downloaded again')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('macOS: the .tgz is unpacked in memory, and only cloudflared becomes executable', async () => {
  const dir = home()
  try {
    const binary = Buffer.from('#!/bin/sh\necho mac\n')
    const { asset, download } = fakeAsset('darwin', 'arm64', binary)
    const file = await ensureCloudflared({
      home: dir,
      env: { PATH: '' },
      platform: 'darwin',
      arch: 'arm64',
      fetch: fakeFetch(download).fetch,
      assets: [asset],
      say: () => {},
    })
    assert.deepEqual(fs.readFileSync(file), binary)
    assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), ['cloudflared'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a tampered, oversized or missing download leaves nothing behind to run', async () => {
  const binary = Buffer.from('#!/bin/sh\necho linux\n')
  const { asset, download } = fakeAsset('linux', 'x64', binary)
  const tampered = Buffer.from(download)
  tampered[0] ^= 1
  for (const [label, bytes, status, pattern] of [
    ['tampered', tampered, 200, /the sha256 does not match/],
    ['oversized', Buffer.concat([download, Buffer.from('x')]), 200, /larger than the pinned/],
    ['missing', download, 404, /GitHub answered 404/],
  ] as const) {
    const dir = home()
    try {
      await assert.rejects(
        ensureCloudflared({
          home: dir,
          env: { PATH: '' },
          platform: 'linux',
          arch: 'x64',
          fetch: fakeFetch(bytes, status).fetch,
          assets: [asset],
          say: () => {},
        }),
        pattern,
        label,
      )
      const bin = path.join(dir, 'bin')
      assert.deepEqual(fs.existsSync(bin) ? fs.readdirSync(bin) : [], [], label)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a stale copy is replaced by the pinned one, in place', async () => {
  const dir = home()
  try {
    const binary = Buffer.from('#!/bin/sh\necho new\n')
    const { asset, download } = fakeAsset('linux', 'x64', binary)
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.writeFileSync(path.join(dir, 'bin/cloudflared'), 'old build', { mode: 0o755 })
    const said: string[] = []
    const file = await ensureCloudflared({
      home: dir,
      env: { PATH: '' },
      platform: 'linux',
      arch: 'x64',
      fetch: fakeFetch(download).fetch,
      assets: [asset],
      say: (line) => void said.push(line),
    })
    assert.deepEqual(fs.readFileSync(file), binary)
    assert.match(said[0] ?? '', /is not the pinned .* build: fetching it again/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the module uses node built-ins only: the CLI bundle has no dependencies', () => {
  for (const name of ['launch-cloudflared.ts', 'launch-cloudflared-pin.ts']) {
    const source = fs.readFileSync(new URL(`../cli/src/${name}`, import.meta.url), 'utf8')
    // Import lines and only them: "from" also occurs in the refusal text.
    for (const [, spec] of source.matchAll(/^(?:import .*|\}) from '([^']+)'$/gm))
      assert.ok(spec!.startsWith('node:') || spec!.startsWith('./'), `${name} imports ${spec}`)
  }
})
