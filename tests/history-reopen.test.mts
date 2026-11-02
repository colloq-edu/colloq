/**
 * Opening a room nobody edits writes nothing — not into the notebook, not into
 * its history.
 *
 * Found on a live install, not in a test: a past class that students only came
 * back to read logged "the history fell behind the notebook on disk — the
 * process died with an unclosed burst" on every open after the idle eviction,
 * though the process had been up for sixteen hours, and wrote a whole 200 KB
 * keyframe each time — sixteen of them in a day and a half, each one ~31 bytes
 * bigger than the last, with no edit in between.
 *
 * The ~31 bytes were the kernel's "at rest" state written again on every open
 * (shared/notebook.ts · clearStaleWork): a Y.Map `set` of the value the key
 * already holds is still a new item. It happens before the history starts, so
 * those clocks reached the snapshot and never the history, and the next open's
 * repair found the notebook ahead of its history.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, loadDocSnapshot, versionCount } from '../server/src/db.js'
import { getSessionDoc, releaseSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { getMeta, kernelEntry, KERNEL_STATUS_FIELD } from '../shared/notebook.js'

after(() => shutdownCollab())

/** Every `console.warn` line while `run` works. */
function warnings(run: () => void): string[] {
  const seen: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(' '))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return seen
}

test('reopening a room nobody edits writes neither the notebook nor a history keyframe', () => {
  const id = 'reopen-idle'
  createSession(id, 'Деревья решений', null)
  const { doc } = getSessionDoc(id)
  // A class ran code here: the kernel's state is in the room, as the server writes it.
  doc.transact(() => {
    getMeta(doc).set('kernelStatus', 'busy')
    kernelEntry(doc, 'cells').set(KERNEL_STATUS_FIELD, 'busy')
  })
  assert.equal(releaseSessionDoc(id), true)

  // The first open after that puts the kernel to rest: a real change, and the
  // history may well take a keyframe for it.
  getSessionDoc(id)
  assert.equal(releaseSessionDoc(id), true)

  const rows = versionCount(id)
  const vector = Y.encodeStateVectorFromUpdate(loadDocSnapshot(id)!)
  const said = warnings(() => {
    for (let visit = 0; visit < 3; visit++) {
      const { doc: again } = getSessionDoc(id)
      assert.equal(getMeta(again).get('kernelStatus'), 'idle')
      assert.equal(kernelEntry(again, 'cells').get(KERNEL_STATUS_FIELD), 'off')
      assert.equal(releaseSessionDoc(id), true)
    }
  })

  assert.equal(versionCount(id), rows, 'three quiet visits added history rows')
  assert.deepEqual(
    Y.encodeStateVectorFromUpdate(loadDocSnapshot(id)!),
    vector,
    'three quiet visits changed the stored notebook',
  )
  assert.deepEqual(said.filter((line) => line.includes('[history]')), [])
})
