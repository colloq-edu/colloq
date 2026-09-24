/**
 * What the notebook uses to show an output record — and why there is exactly
 * one list of types.
 *
 * The set of raster types was copied by hand next to a comment promising that
 * it matches the publication's `BLOB_MIMES`, "and that is no coincidence".
 * Nothing tied them together: a type added to `BLOB_MIMES` arrives on the
 * published page as an address and is drawn, while in a live room it arrives
 * as base64 and is not drawn at all — `pickMime` does not choose it. Exactly
 * the two places that must match would drift apart silently.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOB_MIMES } from '../shared/publish.js'
import {
  asImage,
  IMG_MIMES,
  imageSrc,
  isAddress,
  isPicture,
  pickMime,
} from '../web/src/components/notebook/output-mimes.js'

test('the image set is the same as the one publication moves out to blobs', () => {
  assert.deepEqual([...IMG_MIMES].sort(), [...BLOB_MIMES].sort())
  // And it is not empty: an empty list would silently send every plot down
  // the text branch.
  assert.ok(IMG_MIMES.length >= 4)
})

test('everything publication moves out to a blob, the notebook shows as an image', () => {
  for (const mime of BLOB_MIMES) {
    assert.equal(pickMime({ [mime]: 'AAAA', 'text/plain': '<Figure>' }, true), mime)
    assert.equal(asImage(mime, 'AAAA'), true)
  }
})

test('an image beats text, and markup beats only text', () => {
  assert.equal(pickMime({ 'text/html': '<b>x</b>', 'text/plain': 'x' }, true), 'text/html')
  // Until the sanitizer has arrived, markup is not shown at all — only text.
  assert.equal(pickMime({ 'text/html': '<b>x</b>', 'text/plain': 'x' }, false), 'text/plain')
  assert.equal(pickMime({ 'image/png': 'AAAA', 'text/html': '<b>x</b>' }, false), 'image/png')
})

test('an unfamiliar text type is still shown', () => {
  assert.equal(pickMime({ 'text/markdown': '# hi' }, true), 'text/markdown')
  assert.equal(pickMime({ 'application/vnd.unknown': '{}' }, true), null)
})

test('a blob address is recognised by /api/, not by a slash', () => {
  assert.equal(isAddress('/api/p/pub1/blob/abc'), true)
  // The base64 of any JPEG starts with "/9j/" — going by the slash, a photo
  // went into src as a raw payload, that is, as a broken icon for the whole
  // room.
  assert.equal(isAddress('/9j/4AAQSkZJRg=='), false)
  assert.equal(asImage('text/html', '/api/p/pub1/blob/abc'), true, 'an address is drawn as an image from any branch')
})

test('src is built only where there is none', () => {
  assert.equal(imageSrc('image/png', '/api/p/pub1/blob/abc'), '/api/p/pub1/blob/abc')
  assert.equal(imageSrc('image/png', 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(imageSrc('image/png', 'AA\nAA'), 'data:image/png;base64,AAAA')
})

test('an image is not cut, a table is', () => {
  const png = { kind: 'data', data: { 'image/png': 'AAAA' }, execCount: null } as const
  const html = { kind: 'data', data: { 'text/html': '<table></table>' }, execCount: null } as const
  const svg = { kind: 'data', data: { 'image/svg+xml': '<svg></svg>' }, execCount: null } as const
  assert.equal(isPicture(png, true), true)
  assert.equal(isPicture(svg, true), true)
  assert.equal(isPicture(html, true), false)
  assert.equal(isPicture({ kind: 'stream', name: 'stdout', text: 'x' } as const, true), false)
})
