/**
 * Platform wheels (scripts/platform-wheels.py): Node and node_modules inside,
 * so that after `pip install colloq` only Docker is needed.
 *
 * No network and no npm here: the builder is checked piece by piece, namely
 * reading binary headers, repacking the wheel and refusing a foreign
 * architecture. The real build, and running each wheel on its own OS, is in
 * CI (ci.yml: package and wheel-smoke; publish.yml: smoke).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const script = path.join(repo, 'scripts/platform-wheels.py')

/** Run Python with the builder loaded as `pw`; return the JSON it prints. */
function py(code: string, ...args: string[]): unknown {
  const prelude = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("pw", ${JSON.stringify(script)})`,
    'pw = importlib.util.module_from_spec(spec)',
    // dataclass looks its module up in sys.modules.
    'sys.modules["pw"] = pw',
    'spec.loader.exec_module(pw)',
  ].join('\n')
  const result = spawnSync('python3', ['-c', prelude + '\n' + code, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'))

test('every target has a pinned Node archive, and the tags say what Node 24 needs', () => {
  const targets = py(
    'print(json.dumps({k: {"tag": t.tag, "binary": list(t.binary)} for k, t in pw.TARGETS.items()}))',
  ) as Record<string, { tag: string; binary: string[] }>
  const pin = readJson('scripts/node-runtime.json')
  assert.deepEqual(Object.keys(targets).sort(), Object.keys(pin.archives).sort())
  for (const [name, archive] of Object.entries(pin.archives) as [string, { file: string; sha256: string }][]) {
    assert.equal(archive.file, `node-${pin.version}-${name}.tar.gz`)
    assert.match(archive.sha256, /^[0-9a-f]{64}$/)
  }
  // Node 24 needs macOS 13.5+ and glibc 2.28+. pip tags macOS by whole
  // versions, and 13_0 would let in 13.0-13.4, where Node does not start.
  assert.match(pin.version, /^v24\./)
  for (const [name, { tag }] of Object.entries(targets)) {
    if (name.startsWith('darwin-')) assert.match(tag, /^macosx_14_0_(arm64|x86_64)$/)
    else assert.match(tag, /^manylinux_2_28_(x86_64|aarch64)$/)
  }
})

test('every target but linux-x64 runs on its own runner, in CI and before a release', () => {
  // linux-x64 runs where it is built (ubuntu-24.04).
  const tags = py('print(json.dumps({k: t.tag for k, t in pw.TARGETS.items()}))') as Record<string, string>
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    assert.match(text, /platform-wheels\.py build/, `${file}: no platform build`)
    assert.match(text, /platform-wheels\.py smoke --wheel [^\n]*manylinux_2_28_x86_64\.whl/, `${file}: linux-x64`)
    for (const [name, tag] of Object.entries(tags)) {
      if (name === 'linux-x64') continue
      assert.match(text, new RegExp(`target: ${name}, os: [\\w.-]+, tag: ${tag} `), `${file}: ${name}`)
    }
  }
  const publish = fs.readFileSync(path.join(repo, '.github/workflows/publish.yml'), 'utf8')
  assert.match(publish, /github-release:\n(?:.*\n)*?\s+needs: \[build, smoke\]/)
})

test('the header of a binary names its format and machine', () => {
  const kinds = py(
    [
      'heads = {',
      '  "macho-arm64": bytes.fromhex("cffaedfe0c000001"),',
      '  "macho-x64": bytes.fromhex("cffaedfe07000001"),',
      '  "elf-x64": b"\\x7fELF\\x02\\x01" + bytes(12) + (62).to_bytes(2, "little"),',
      '  "elf-arm64": b"\\x7fELF\\x02\\x01" + bytes(12) + (183).to_bytes(2, "little"),',
      '  "script": b"#!/bin/sh\\n",',
      '}',
      'print(json.dumps({k: pw.binary_kind(v) for k, v in heads.items()}))',
    ].join('\n'),
  )
  assert.deepEqual(kinds, {
    'macho-arm64': ['macho', 'arm64'],
    'macho-x64': ['macho', 'x86_64'],
    'elf-x64': ['elf', 'x86_64'],
    'elf-arm64': ['elf', 'aarch64'],
    script: null,
  })
  // And a real one: the Node running these tests.
  const own = py('print(json.dumps(pw.binary_kind(open(sys.argv[1], "rb").read(64))))', process.execPath)
  const want = { darwin: 'macho', linux: 'elf' }[process.platform as 'darwin' | 'linux']
  if (want) assert.deepEqual(own, [want, { arm64: process.platform === 'linux' ? 'aarch64' : 'arm64', x64: 'x86_64' }[process.arch as 'arm64' | 'x64']])
})

/** A py3-none-any wheel shaped the way hatchling writes it. */
function universalWheel(dir: string): string {
  const wheel = path.join(dir, 'colloq-9.9.9-py3-none-any.whl')
  const code = [
    'import zipfile, sys',
    'with zipfile.ZipFile(sys.argv[1], "w") as z:',
    '  z.writestr("colloq/__init__.py", "")',
    '  z.writestr("colloq/_app/package.json", \'{"name": "colloq", "version": "9.9.9", "dependencies": {"better-sqlite3": "^13.0.3"}}\')',
    '  z.writestr("colloq/_app/.colloq-dist.json", \'{"name": "colloq", "version": "9.9.9"}\')',
    '  z.writestr("colloq-9.9.9.dist-info/METADATA", "Metadata-Version: 2.4\\nName: colloq\\nVersion: 9.9.9\\n")',
    '  z.writestr("colloq-9.9.9.dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: hatchling\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
    '  z.writestr("colloq-9.9.9.dist-info/RECORD", "")',
  ].join('\n')
  const result = spawnSync('python3', ['-c', code, wheel], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return wheel
}

test('repack: the tag, the Node, the node_modules and a RECORD that checks out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-wheels-'))
  try {
    const universal = universalWheel(dir)
    const modules = path.join(dir, 'node_modules')
    fs.mkdirSync(path.join(modules, 'better-sqlite3/prebuilds'), { recursive: true })
    fs.writeFileSync(path.join(modules, 'better-sqlite3/prebuilds/darwin-arm64.node'), 'native')
    fs.writeFileSync(path.join(modules, 'better-sqlite3/package.json'), '{}')
    const out = py(
      [
        'from pathlib import Path',
        'target = pw.TARGETS["darwin-arm64"]',
        'wheel = pw.repack(Path(sys.argv[1]), target, b"NODE", b"MIT", "v24.0.0", Path(sys.argv[2]), Path(sys.argv[3]), 1700000000)',
        'import zipfile, csv, io, hashlib, base64',
        'z = zipfile.ZipFile(wheel)',
        'rows = list(csv.reader(io.StringIO(z.read("colloq-9.9.9.dist-info/RECORD").decode())))',
        'ok = all(h == "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(z.read(p)).digest()).rstrip(b"=").decode() and int(n) == len(z.read(p)) for p, h, n in rows if h)',
        'print(json.dumps({',
        '  "name": wheel.name,',
        '  "names": z.namelist(),',
        '  "wheel": z.read("colloq-9.9.9.dist-info/WHEEL").decode(),',
        '  "record_ok": ok,',
        '  "recorded": sorted(r[0] for r in rows),',
        '  "node_mode": oct(z.getinfo("colloq/_app/bin/node").external_attr >> 16),',
        '  "stamp": json.loads(z.read("colloq/_app/.node-modules.json")),',
        '  "dist": json.loads(z.read("colloq/_app/.colloq-dist.json")),',
        '  "dates": sorted({i.date_time for i in z.infolist()}),',
        '}))',
      ].join('\n'),
      universal,
      modules,
      path.join(dir, 'out'),
    ) as {
      name: string
      names: string[]
      wheel: string
      record_ok: boolean
      recorded: string[]
      node_mode: string
      stamp: unknown
      dist: { bundled?: { target: string; node: string } }
      dates: number[][]
    }
    assert.equal(out.name, 'colloq-9.9.9-py3-none-macosx_14_0_arm64.whl')
    assert.match(out.wheel, /^Root-Is-Purelib: false$/m)
    assert.match(out.wheel, /^Tag: py3-none-macosx_14_0_arm64$/m)
    assert.doesNotMatch(out.wheel, /py3-none-any/)
    assert.equal(out.record_ok, true)
    assert.deepEqual(out.recorded, [...out.names].sort())
    // RECORD last, .dist-info at the end of the archive.
    assert.equal(out.names.at(-1), 'colloq-9.9.9.dist-info/RECORD')
    assert.ok(out.names.includes('colloq/_app/node_modules/better-sqlite3/prebuilds/darwin-arm64.node'))
    assert.ok(out.names.includes('colloq/_app/bin/node.LICENSE'))
    assert.equal(out.node_mode, '0o100755')
    // The same stamp the shim writes after npm install: with it the first run installs nothing.
    assert.deepEqual(out.stamp, { version: '9.9.9', dependencies: { 'better-sqlite3': '^13.0.3' } })
    assert.deepEqual(out.dist.bundled?.target, 'darwin-arm64')
    assert.equal(out.dist.bundled?.node, 'v24.0.0')
    // One date for every file: SOURCE_DATE_EPOCH, not the build time.
    assert.deepEqual(out.dates, [[2023, 11, 14, 22, 13, 20]])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verify: a native module built for another machine is a refusal, not a wheel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-wheels-'))
  try {
    const macArm = Buffer.concat([Buffer.from('cffaedfe0c000001', 'hex'), Buffer.alloc(56)])
    const macX64 = Buffer.concat([Buffer.from('cffaedfe07000001', 'hex'), Buffer.alloc(56)])
    const modules = path.join(dir, 'node_modules')
    fs.mkdirSync(path.join(modules, 'better-sqlite3/prebuilds'), { recursive: true })
    fs.mkdirSync(path.join(modules, '@resvg/resvg-js-darwin-arm64'), { recursive: true })
    fs.writeFileSync(path.join(modules, 'better-sqlite3/prebuilds/darwin-arm64.node'), macArm)
    fs.writeFileSync(path.join(modules, '@resvg/resvg-js-darwin-arm64/resvgjs.darwin-arm64.node'), macArm)
    const verify = (node: Buffer) => {
      fs.writeFileSync(path.join(dir, 'node'), node)
      return spawnSync(
        'python3',
        [
          '-c',
          [
            'import importlib.util, sys',
            'from pathlib import Path',
            `spec = importlib.util.spec_from_file_location("pw", ${JSON.stringify(script)})`,
            'pw = importlib.util.module_from_spec(spec); sys.modules["pw"] = pw; spec.loader.exec_module(pw)',
            'pw.verify(pw.TARGETS["darwin-arm64"], open(sys.argv[1], "rb").read(), Path(sys.argv[2]))',
          ].join('\n'),
          path.join(dir, 'node'),
          modules,
        ],
        { encoding: 'utf8' },
      )
    }
    assert.equal(verify(macArm).status, 0, verify(macArm).stderr)
    // Node for the wrong machine.
    const wrongNode = verify(macX64)
    assert.notEqual(wrongNode.status, 0)
    assert.match(wrongNode.stderr, /Node for darwin-arm64/)
    // A module for the wrong machine.
    fs.writeFileSync(path.join(modules, '@resvg/resvg-js-darwin-arm64/resvgjs.darwin-arm64.node'), macX64)
    const wrongModule = verify(macArm)
    assert.notEqual(wrongModule.status, 0)
    assert.match(wrongModule.stderr, /resvgjs\.darwin-arm64\.node is built as/)
    // No platform package for resvg: npm did not pick one for the target.
    fs.rmSync(path.join(modules, '@resvg'), { recursive: true })
    assert.match(verify(macArm).stderr, /@resvg\/resvg-js-\*/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the Node archives are what the pin says (when they are in the cache)', () => {
  // No network in tests: only archives already in the cache are checked.
  const pin = readJson('scripts/node-runtime.json')
  const cache = process.env.COLLOQ_NODE_CACHE || path.join(os.homedir(), '.cache/colloq/node')
  for (const archive of Object.values(pin.archives) as { file: string; sha256: string }[]) {
    const file = path.join(cache, archive.file)
    if (!fs.existsSync(file)) continue
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    assert.equal(digest, archive.sha256, archive.file)
  }
})
