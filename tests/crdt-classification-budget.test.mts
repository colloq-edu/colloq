import './_env.mts'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import { classify } from '../server/src/collab/gate.js'

test('a compressed logical range costs one index entry rather than one entry per clock', () => {
  // A bounded, tiny local fixture: no sockets, allocation attack or live doc.
  const enc = new Y.UpdateEncoderV1()
  encoding.writeVarUint(enc.restEncoder, 1) // client count
  encoding.writeVarUint(enc.restEncoder, 1) // struct count
  enc.writeClient(7)
  encoding.writeVarUint(enc.restEncoder, 0)
  const item = new Y.Item(Y.createID(7, 0), null, null, null, null, 'meta' as any, 'title', new Y.ContentDeleted(4096))
  item.write(enc, 0)
  encoding.writeVarUint(enc.restEncoder, 0) // delete set
  const bytes = enc.toUint8Array()
  assert.ok(bytes.byteLength < 32)
  const doc = new Y.Doc()
  const before = Y.encodeStateVector(doc)
  let entries = 0
  const original = Map.prototype.set
  const count = mock.method(Map.prototype, 'set', function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    entries += 1
    return original.call(this, key, value)
  })
  try { classify(doc, bytes) } finally { count.mock.restore() }
  assert.ok(entries < 64, `classification allocated ${entries} map entries for one struct`)
  assert.deepEqual(Y.encodeStateVector(doc), before)
  doc.destroy()
})
