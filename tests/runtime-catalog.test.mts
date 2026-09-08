import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRuntimeCatalog,
  resolveRuntimeEnvironment,
  imageRevision,
  parseRuntimeEnsureRequest,
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
