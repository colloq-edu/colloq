import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRuntimeCatalog,
  resolveRuntimeEnvironment,
  imageRevision,
  parseRuntimeEnsureRequest,
  parseRuntimeResizeRequest,
  isRuntimeSessionId,
} from '../shared/runtime.js'

const image = `registry.example/colloq/base@sha256:${'a'.repeat(64)}`
const oldImage = image.replace(/a{64}$/, 'b'.repeat(64))
const catalog = (environments: unknown[] = [{ name: 'base', image, gpu: false }]) => ({
  schemaVersion: 1,
  release: 'v1.0.0',
  defaultEnvironment: 'base',
  environments,
})

test('catalog resolves current environment and preserves explicitly pinned old revisions', () => {
  const parsed = parseRuntimeCatalog(
    catalog([
      { name: 'base', image, gpu: false, current: true },
      { name: 'base', image: oldImage, gpu: false, current: false },
    ]),
  )
  assert.equal(resolveRuntimeEnvironment(parsed, 'base').image, image)
  assert.equal(resolveRuntimeEnvironment(parsed, 'base', imageRevision(oldImage)).image, oldImage)
  assert.throws(
    () => resolveRuntimeEnvironment(parsed, 'base', `sha256:${'c'.repeat(64)}`),
    /revision/i,
  )
  assert.equal(parseRuntimeCatalog(catalog()).environments[0].current, true)
})

test('catalog rejects mutable images, duplicate revisions, ambiguous current revisions and invalid names', () => {
  for (const environments of [
    [{ name: 'base', image: 'registry.example/base:latest', gpu: false }],
    [{ name: '../base', image, gpu: false }],
    [{ name: 'base', image, gpu: 'false' }],
    [
      { name: 'base', image, gpu: false },
      { name: 'base', image, gpu: false },
    ],
    [
      { name: 'base', image, gpu: false },
      { name: 'base', image: oldImage, gpu: false },
    ],
    [
      { name: 'base', image, gpu: false, current: true },
      { name: 'base', image: oldImage, gpu: false, current: true },
    ],
  ])
    assert.throws(() => parseRuntimeCatalog(catalog(environments)))
  assert.throws(() => parseRuntimeCatalog({ ...catalog(), defaultEnvironment: 'missing' }))
})

test('room intent rejects templates, image/path injection, invalid revisions and unknown fields', () => {
  assert.deepEqual(parseRuntimeEnsureRequest({ environment: 'base' }), { environment: 'base' })
  for (const value of [
    null,
    [],
    { environment: 'base', image },
    { environment: 'base', revision: 'latest' },
    { environment: '../base' },
    { environment: 'base', mount: '/' },
  ])
    assert.throws(() => parseRuntimeEnsureRequest(value))
  assert.equal(isRuntimeSessionId('abcdefgh'), true)
  assert.equal(isRuntimeSessionId('roomA_1-'), true)
  for (const value of ['../abcde', '', 'a/bcdefg', 'a'.repeat(65), 'abcdefgh%2f'])
    assert.equal(isRuntimeSessionId(value), false)
})

test('room CPU intent accepts bounded whole cores without accepting container settings', () => {
  assert.deepEqual(parseRuntimeEnsureRequest({ environment: 'base', cpus: 6 }), { environment: 'base', cpus: 6 })
  for (const cpus of [0, -1, 1.5, 65, '6', null])
    assert.throws(() => parseRuntimeEnsureRequest({ environment: 'base', cpus }))
})

test('room memory intent carries whole MiB within the protocol bounds and nothing else', () => {
  // Before 18 Sep 2026 the broker did not accept this field at all, and the Pod
  // on k3s got 2Gi whatever number the class form had.
  assert.deepEqual(parseRuntimeEnsureRequest({ environment: 'base', memoryMb: 4096 }), {
    environment: 'base',
    memoryMb: 4096,
  })
  for (const memoryMb of [0, 63, 262145, 1024.5, '4096', null, -1])
    assert.throws(() => parseRuntimeEnsureRequest({ environment: 'base', memoryMb }), /memory/)
})

test('live resize intent is memory and/or whole cores: a number, or null for the broker default', () => {
  assert.deepEqual(parseRuntimeResizeRequest({ memoryMb: 8192 }), { memoryMb: 8192 })
  assert.deepEqual(parseRuntimeResizeRequest({ memoryMb: null }), { memoryMb: null })
  // Cores, since 18 Sep 2026, go through the same input: before that only
  // replacing the Pod changed them.
  assert.deepEqual(parseRuntimeResizeRequest({ cpus: 4 }), { cpus: 4 })
  assert.deepEqual(parseRuntimeResizeRequest({ cpus: null }), { cpus: null })
  assert.deepEqual(parseRuntimeResizeRequest({ memoryMb: 8192, cpus: 4 }), { memoryMb: 8192, cpus: 4 })
  for (const value of [
    {},
    { memoryMb: 1.5 },
    { memoryMb: '8Gi' },
    { cpus: 1.5 },
    { cpus: 0 },
    { cpus: 65 },
    { cpus: 4, environment: 'base' },
    null,
    [],
  ])
    assert.throws(() => parseRuntimeResizeRequest(value))
})
