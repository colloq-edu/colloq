import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseLaunchArgs,
  launchConfig,
  fingerprint,
  buildIsCurrent,
} from '../cli/src/launch-config.js'

test('local launch defaults to a foreground session and validates flags before work', () => {
  assert.deepEqual(parseLaunchArgs([]), {
    action: 'run',
    detach: false,
    open: true,
    fast: false,
    build: false,
  })
  assert.equal(
    parseLaunchArgs(['run', '--host', 'class.example.ru', '--detach']).host,
    'class.example.ru',
  )
  assert.equal(parseLaunchArgs(['dev', '--port', '4310', '--no-open']).port, 4310)
  for (const args of [
    ['--port', '0'],
    ['--port', '65536'],
    ['--port', '31abc'],
    ['--host'],
    ['--mystery'],
    ['dev', '--detach'],
  ]) {
    assert.throws(() => parseLaunchArgs(args))
  }
})

test('local configuration preserves data paths, ignores old public URL, and distinguishes development ports', () => {
  const config = launchConfig('/example', parseLaunchArgs(['dev', '--port', '4300']), {
    PORT: '3100',
    DATA_DIR: '/my/data',
    WORKSPACE_DIR: 'files',
    PUBLIC_URL: 'https://old.invalid',
  })
  assert.equal(config.port, 3100)
  assert.equal(config.uiPort, 4300)
  assert.equal(config.url, 'http://localhost:4300')
  assert.equal(config.dataDir, '/my/data')
  assert.equal(config.workspaceDir, '/example/files')
  assert.equal(config.env.COLLOQ_STOP_KERNELS_ON_EXIT, '0')
  assert.equal(config.env.BIND_ADDR, '127.0.0.1')
  assert.equal(config.env.WORKSPACE_HOST_DIR, '')
  assert.equal(config.env.COLLOQ_LOCAL_SESSION, '1')
  assert.equal(launchConfig('/example', parseLaunchArgs(['--port', '4400']), {}).env.PORT, '4400')
})

test('source fingerprint catches content changes, ignores generated files, and verifies both output bundles', () => {
  const root = mkdtempSync(join(tmpdir(), 'colloq-launch-config-'))
  try {
    for (const dir of ['web/src', 'server/src', 'shared', 'web/dist', 'server/dist'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'web/src/a.ts'), 'old')
    writeFileSync(join(root, 'server/src/a.ts'), 'server')
    writeFileSync(join(root, 'package.json'), '{}')
    const first = fingerprint(root)
    writeFileSync(join(root, 'web/dist/random.js'), 'generated')
    assert.equal(fingerprint(root), first)
    writeFileSync(join(root, 'web/src/a.ts'), 'new')
    assert.notEqual(fingerprint(root), first)
    const current = fingerprint(root)
    assert.equal(buildIsCurrent(root, { fingerprint: current, fast: false }, false), false)
    writeFileSync(join(root, 'web/dist/index.html'), 'built')
    writeFileSync(join(root, 'server/dist/server.js'), 'built')
    assert.equal(buildIsCurrent(root, { fingerprint: current, fast: false }, false), true)
    assert.equal(buildIsCurrent(root, { fingerprint: current, fast: true }, false), false)
    assert.equal(buildIsCurrent(root, { fingerprint: current, fast: false }, true), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
