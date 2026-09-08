import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  claimSmokeDirectory,
  removeSmokeDirectory,
  parseSmokeReport,
  validateSmokeReport,
  selectSmokeEnvironment,
} from '../server/src/ops/runtime-smoke.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'

const healthy = {
  uid: 1000,
  noRuntimeSockets: true,
  noServiceAccountToken: true,
  ownWorkspace: true,
  appSeedReadable: true,
  cwdOwn: true,
}
test('smoke evidence requires actual nonroot execution and every filesystem credential check', () => {
  assert.doesNotThrow(() => validateSmokeReport('workspace', healthy))
  for (const invalid of [
    { ...healthy, uid: 0 },
    { ...healthy, uid: '1000' },
    { ...healthy, noRuntimeSockets: false },
    { ...healthy, noServiceAccountToken: false },
    { ...healthy, appSeedReadable: false },
    {},
  ])
    assert.throws(() => validateSmokeReport('workspace', invalid))
})
test('DNS failure or successful sibling connection cannot pass isolation evidence', () => {
  const report = { siblingFileBlocked: true, dnsResolved: true, siblingTcpBlocked: true }
  assert.doesNotThrow(() => validateSmokeReport('isolation', report))
  for (const invalid of [
    { ...report, dnsResolved: false },
    { ...report, siblingTcpBlocked: false },
    { ...report, siblingFileBlocked: false },
    {},
  ])
    assert.throws(() => validateSmokeReport('isolation', invalid))
  assert.deepEqual(
    parseSmokeReport('COLLOQ_RUNTIME_SMOKE=' + JSON.stringify(report) + '\n'),
    report,
  )
  assert.throws(() => parseSmokeReport('noise only'))
  assert.throws(() => parseSmokeReport('COLLOQ_RUNTIME_SMOKE={}\nCOLLOQ_RUNTIME_SMOKE={}'))
})
test('canary collision never claims or removes the preexisting directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'kernel-smoke-'))
  try {
    mkdirSync(join(root, 'smoke-collision'))
    writeFileSync(join(root, 'smoke-collision', 'keep'), 'original')
    assert.throws(() => claimSmokeDirectory(root, 'smoke-collision', 'owner'), /exist|collision/i)
    assert.equal(readFileSync(join(root, 'smoke-collision', 'keep'), 'utf8'), 'original')
    const owned = claimSmokeDirectory(root, 'smoke-owned', 'owner')
    writeFileSync(join(owned.path, 'probe'), 'test')
    removeSmokeDirectory(owned)
    assert.equal(existsSync(owned.path), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('cleanup refuses replaced directory or altered ownership marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'kernel-smoke-'))
  try {
    const owned = claimSmokeDirectory(root, 'smoke-owned', 'owner')
    renameSync(owned.path, join(root, 'saved'))
    mkdirSync(owned.path)
    writeFileSync(join(owned.path, '.runtime-smoke-owner'), 'owner')
    assert.throws(() => removeSmokeDirectory(owned), /ownership|replaced/i)
    assert.equal(existsSync(owned.path), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('CPU canary selection fails explicitly when only GPU catalog entries exist', () => {
  const make = (gpu: boolean) =>
    parseRuntimeCatalog({
      schemaVersion: 1,
      release: 'v1',
      defaultEnvironment: 'base',
      environments: [
        { name: 'base', image: 'registry.example/base@sha256:' + 'a'.repeat(64), gpu },
      ],
    })
  assert.equal(selectSmokeEnvironment(make(false)).name, 'base')
  assert.throws(() => selectSmokeEnvironment(make(true)), /CPU|gpu:false/i)
})

test('runnable CLI exits nonzero on missing configuration without printing credentials', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../server/src/ops/runtime-smoke.ts', import.meta.url)),
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        KERNEL_RUNTIME_URL: '',
        KERNEL_RUNTIME_TOKEN_FILE: '',
        KERNEL_CATALOG_FILE: '',
        KERNEL_RUNTIME_TOKEN: 'private-do-not-print',
      },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /KERNEL_RUNTIME_URL.*required/)
  assert.equal((result.stdout + result.stderr).includes('private-do-not-print'), false)
})
