import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DependencyBundle } from '../shared/dependencies.js'
import { dependencyRoot, bundleDir, freshStaging, publishBundle, verifyBundleFiles, reconcileArtifacts, ensureDependencyStorage } from '../server/src/dependencies/files.js'

function fixture() {
  const id = randomUUID().replaceAll('-', '')
  const bytes = Buffer.from(`wheel fixture ${id}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const pkg = { name: 'example', version: '1.0', fileName: 'example-1.0-py3-none-any.whl', sha256, bytes: bytes.length }
  const lock = `example==1.0 --hash=sha256:${sha256}\n`
  const result = { normalizedRequirements: ['example==1.0'], packages: [pkg], downloadBytes: bytes.length, installedBytes: bytes.length, contentHash: sha256, lock }
  const stage = freshStaging(id)
  fs.mkdirSync(path.join(stage, 'wheels'))
  fs.writeFileSync(path.join(stage, 'wheels', pkg.fileName), bytes)
  const bundle: DependencyBundle = { id, number: 1, competitionId: 'test', entrantId: 'test', revisionId: 'test', requirementsText: 'example', state: 'ready', error: null, log: [], createdAt: Date.now(), readyAt: Date.now(), ...result }
  return { id, pkg, result, bundle, stage }
}

test('published wheels and lock are immutable and checked before execution', async () => {
  const f = fixture()
  await publishBundle(f.id, f.result)
  assert.equal(await verifyBundleFiles(f.bundle, f.result.lock), bundleDir(f.id))
  await assert.rejects(publishBundle(f.id, f.result), /immutable/)
  const lockPath = path.join(bundleDir(f.id), 'requirements.lock')
  fs.chmodSync(lockPath, 0o600)
  fs.writeFileSync(lockPath, '')
  await assert.rejects(verifyBundleFiles(f.bundle, f.result.lock), /lock.*corrupt/)
  fs.writeFileSync(lockPath, f.result.lock)
  const wheel = path.join(bundleDir(f.id), 'wheels', f.pkg.fileName)
  fs.chmodSync(wheel, 0o600)
  fs.writeFileSync(wheel, Buffer.alloc(f.pkg.bytes, 0))
  await assert.rejects(verifyBundleFiles(f.bundle, f.result.lock), /wheel.*corrupt/)
})

test('publication rejects corrupt source wheels before creating a usable bundle', async () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.stage, 'wheels', f.pkg.fileName), Buffer.alloc(f.pkg.bytes, 0))
  await assert.rejects(publishBundle(f.id, f.result), { code: 'hash_mismatch' })
  assert.equal(fs.existsSync(bundleDir(f.id)), false)
})

test('publication refuses wheel path traversal and symbolic links', async () => {
  const traversal = fixture()
  traversal.result.packages[0].fileName = '../example.whl'
  await assert.rejects(publishBundle(traversal.id, traversal.result), /filename/)
  const linked = fixture()
  const wheel = path.join(linked.stage, 'wheels', linked.pkg.fileName)
  fs.renameSync(wheel, path.join(linked.stage, 'original'))
  fs.symlinkSync(path.join(linked.stage, 'original'), wheel)
  await assert.rejects(publishBundle(linked.id, linked.result), /regular file/)
})

test('CAS reconciliation removes old unrecorded artifacts and retains known or recent files', () => {
  ensureDependencyStorage()
  const artifact = (name: string) => path.join(dependencyRoot, 'artifacts', name)
  const old = '1'.repeat(64), referenced = '2'.repeat(64), recent = '3'.repeat(64)
  const cutoff = Date.now() - 3600000
  for (const name of [old, referenced, recent]) fs.writeFileSync(artifact(name), 'fixture')
  for (const name of [old, referenced]) fs.utimesSync(artifact(name), new Date(cutoff - 1000), new Date(cutoff - 1000))
  reconcileArtifacts(new Set([referenced]), cutoff)
  assert.equal(fs.existsSync(artifact(old)), false)
  assert.equal(fs.existsSync(artifact(referenced)), true)
  assert.equal(fs.existsSync(artifact(recent)), true)
})
