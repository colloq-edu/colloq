/**
 * What it costs when the hall comes back: every returning tab's step2 and the
 * server's answer to it.
 *
 * After a server restart or a relay blink, five hundred tabs reconnect within
 * one or two seconds, two sockets each, and on a shared document this is not
 * "a delta of a couple dozen bytes": step2 carries the room's ENTIRE delete
 * set, and the server's answer — `encodeStateAsUpdate(doc, sv)` — carries the
 * same set back. Both numbers grew all through the class and do not figure in
 * the complaints: nobody had ever measured them, and in the audit finding they
 * stood as a guess.
 *
 * Measurement (this machine, a room of 400 cells, 160 thousand typed
 * characters and 22.8 thousand deletions — one course's semester):
 *
 *   the whole document ............................ 750 KB
 *   step2 of a returning client ................... 87 KB
 *   encodeStateAsUpdate(doc, sv), in-sync tab ..... 87 KB, 1.3 ms
 *   classify(step2) — the gate parses a frame ..... 5.6 ms
 *
 * That is, the hall coming back means ≈2.8 s of busy event loop on parsing
 * alone (5.6 ms × 500) and ≈44 MB of outgoing traffic on top of everything
 * else. None of this is fixed here; here it is RECORDED as a number and
 * pinned by caps that catch real trouble: quadratic parsing and a frame that
 * runs into `MAX_SYNC_STEP2_BYTES` (past it, a returning tab is not let in at
 * all).
 *
 * The caps have an order of magnitude of headroom: on a loaded machine timing
 * drifts, and a test that fails because of a neighbouring process is worse
 * than no test at all.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { classify, MAX_SYNC_STEP2_BYTES } from '../server/src/collab/gate.js'
import { createCell, getCells } from '../shared/notebook.js'

/** Cells in a room over a semester: six course notebooks worked through in class. */
const CELLS = 400
/** Characters per cell — and every seventh is erased: the edits are the delete set. */
const CHARS = 400

function semester(): Y.Doc {
  const doc = new Y.Doc()
  const cells = getCells(doc)
  doc.transact(() => {
    for (let i = 0; i < CELLS; i++) cells.push([createCell('code', '')])
  })
  for (let i = 0; i < CELLS; i++) {
    const text = (cells.get(i) as Y.Map<unknown>).get('source') as Y.Text
    doc.transact(() => {
      for (let k = 0; k < CHARS; k++) {
        text.insert(text.length, String.fromCharCode(97 + (k % 26)))
        if (k % 7 === 6) text.delete(text.length - 1, 1)
      }
    })
  }
  return doc
}

/** How many milliseconds it took — by the best of the runs, not the first. */
function fastest(times: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < times; i++) {
    const at = process.hrtime.bigint()
    run()
    best = Math.min(best, Number(process.hrtime.bigint() - at) / 1e6)
  }
  return best
}

test('the step2 of a semester-long room does not hit the frame cap', () => {
  const doc = semester()
  const server = Y.encodeStateVector(doc)

  // A returning client: it has everything except the last minute of someone
  // else's typing.
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc))
  client.transact(() => {
    const text = (getCells(client).get(0) as Y.Map<unknown>).get('source') as Y.Text
    text.insert(0, 'вернулся и дописал')
  })
  const step2 = Y.encodeStateAsUpdate(client, server)

  /*
   * A frame thicker than the cap is a refusal at the entrance: the returning
   * tab does not sync at all and stays with "no connection" until the end of
   * class. A semester room is still far from this boundary (87 KB versus
   * 8 MB), and one needs to know how far before notebooks twice as big land
   * in the room.
   */
  assert.ok(
    step2.byteLength < MAX_SYNC_STEP2_BYTES / 8,
    `the semester's step2 is ${(step2.byteLength / 1024).toFixed(0)} KB, the cap is ${(
      MAX_SYNC_STEP2_BYTES / 1024
    ).toFixed(0)} KB: the headroom is running out`,
  )

  const judged = classify(doc, step2, MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true, 'the gate could not parse an ordinary return frame')
  const took = fastest(5, () => classify(doc, step2, MAX_SYNC_STEP2_BYTES))
  assert.ok(took < 60, `parsing step2 took ${took.toFixed(1)} ms — this is no longer linear`)
})

test('the answer to an in-sync client is not an empty frame but the whole delete set', () => {
  const doc = semester()
  const sv = Y.encodeStateVector(doc)
  const answer = Y.encodeStateAsUpdate(doc, sv)

  /*
   * "The server answers a client that has everything with next to nothing" —
   * that is how it reads and that is how it does NOT work: there are no
   * structs in the answer, but the delete set travels whole, and when the
   * hall comes back it goes out to five hundred tabs.
   */
  assert.ok(
    answer.byteLength > 1024,
    'the answer to an in-sync client became empty — check that this is the right Yjs',
  )
  const took = fastest(5, () => Y.encodeStateAsUpdate(doc, sv))
  assert.ok(took < 20, `building the answer took ${took.toFixed(1)} ms for a room of ${CELLS} cells`)
})
