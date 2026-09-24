/**
 * Presence for one cell: the editor sees only those who stand IN IT.
 *
 * `yCollab` got the whole room's presence, and its remote-caret plugin
 * dispatched a transaction into its editor on ANY remote frame, then walked
 * all states and resolved two relative positions per cursor. A notebook has
 * ten to twenty-five editors mounted, so one remote cursor cost "editors ×
 * states". What is checked here: that the view hands out only its own, that
 * the walk is shared per presence (not per editor), that no frame arrives at
 * all if nothing changed in this cell — and that leaving DOES COUNT as a
 * change: whoever left must arrive in `removed`.
 *
 * All of this breaks silently: without comparing snapshots an extra frame is
 * just "a bit more expensive", with a wrong filter a remote caret stops being
 * drawn at all, and without `removed` it, on the contrary, stays drawn in the
 * abandoned cell — the plugin dispatches a transaction only for a frame that
 * has at least one remote client.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { cellAwareness, type AwarenessDiff } from '../web/src/components/notebook/cell-awareness.js'

/** Frame batching by hand: an animation frame never comes in node. */
function manualSchedule() {
  const queue: (() => void)[] = []
  const schedule = (run: () => void) => {
    queue.push(run)
    return () => {
      const at = queue.indexOf(run)
      if (at >= 0) queue.splice(at, 1)
    }
  }
  const flush = () => {
    const pending = queue.splice(0, queue.length)
    for (const run of pending) run()
  }
  return { schedule, flush, get size() { return queue.length } }
}

/*
 * Presence holds its own staleness timer, and the document holds memory:
 * without cleanup the test file does not finish at all. The same order as in
 * the component itself.
 */
const opened: { doc: Y.Doc; awareness: Awareness }[] = []
after(() => {
  for (const { doc, awareness } of opened) {
    awareness.destroy()
    doc.destroy()
  }
})

function room() {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('user', { id: 'me', name: 'Я', color: '#fff', activeCellId: 'c1' })
  opened.push({ doc, awareness })
  return { doc, awareness }
}

/** A remote client in the shared presence — the way the network puts it there. */
function peer(
  awareness: Awareness,
  clientId: number,
  activeCellId: string | null,
  cursor: unknown = { anchor: { item: clientId }, head: { item: clientId } },
): void {
  const states = awareness.getStates()
  states.set(clientId, {
    user: { id: `p${clientId}`, name: `P${clientId}`, color: '#0f0', activeCellId },
    cursor,
  })
  awareness.emit('change', [{ added: [clientId], updated: [], removed: [] }, 'test'])
}

/** A tab closed: presence drops the state and says `removed`. */
function leave(awareness: Awareness, clientId: number): void {
  awareness.getStates().delete(clientId)
  awareness.emit('change', [{ added: [], updated: [], removed: [clientId] }, 'test'])
}

/** The very condition by which the remote-caret plugin decides to dispatch. */
function wakesEditor(diff: AwarenessDiff, self: number): boolean {
  const clients = diff.added.concat(diff.updated).concat(diff.removed)
  return clients.findIndex((id) => id !== self) >= 0
}

test('the cell view shows its own people and itself, but not others', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  peer(awareness, 2, 'c1')
  peer(awareness, 3, 'c2')
  peer(awareness, 4, null)

  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const states = view.getStates()
  assert.deepEqual([...states.keys()].sort((a, b) => a - b), [awareness.clientID, 2].sort((a, b) => a - b))
  // The local state stays in place: one's own cursor is still announced in
  // the real presence, the view only reads.
  assert.equal(view.getLocalState()?.user !== undefined, true)
  assert.equal(view.clientID, awareness.clientID)
  view.destroy()
})

test('a person without an announced cell does not get into the view', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  peer(awareness, 7, null)
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  assert.deepEqual([...view.getStates().keys()], [awareness.clientID])
  view.destroy()
})

test('a remote cursor in ANOTHER cell gives no frame', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  let frames = 0
  view.on('change', () => (frames += 1))

  peer(awareness, 5, 'c2')
  clock.flush()
  assert.equal(frames, 0, 'a neighbour typing in another cell does not concern this editor')

  peer(awareness, 6, 'c1')
  clock.flush()
  assert.equal(frames, 1, 'but whoever stepped in here must appear')
  view.destroy()
})

test('cursor movement in its own cell gives a frame; a repeat of the same does not', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  let frames = 0
  view.on('change', () => (frames += 1))

  peer(awareness, 8, 'c1', { anchor: { item: 1 }, head: { item: 1 } })
  clock.flush()
  assert.equal(frames, 1)

  // Presence decodes states anew on every tick, so the object is always new:
  // comparing by reference would give a frame out of nothing.
  peer(awareness, 8, 'c1', { anchor: { item: 1 }, head: { item: 1 } })
  clock.flush()
  assert.equal(frames, 1, 'the same position — nothing to redraw')

  peer(awareness, 8, 'c1', { anchor: { item: 4 }, head: { item: 9 } })
  clock.flush()
  assert.equal(frames, 2, 'the caret moved — a frame')
  view.destroy()
})

test('ten frames in a row are batched into one walk', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  let frames = 0
  view.on('change', () => (frames += 1))

  for (let i = 0; i < 10; i++) peer(awareness, 20 + i, 'c1')
  assert.equal(clock.size, 1, 'exactly one walk is deferred, not ten')
  clock.flush()
  assert.equal(frames, 1)
  assert.equal(view.getStates().size, 11)
  view.destroy()
})

test('twenty-five editors share one presence walk', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const views = Array.from({ length: 25 }, (_, i) => cellAwareness(awareness, `c${i}`, clock.schedule))
  const seen = views.map(() => 0)
  views.forEach((view, index) => view.on('change', () => (seen[index] += 1)))

  peer(awareness, 99, 'c7')
  assert.equal(clock.size, 1, 'one walk per presence, not one per editor')
  clock.flush()
  assert.deepEqual(
    seen.map((count, index) => (count > 0 ? index : -1)).filter((index) => index >= 0),
    [7],
    'exactly the cell someone stepped into must be woken',
  )
  for (const view of views) view.destroy()
})

test('the view lets go of presence: no listeners remain after destroy', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const handler = () => {}
  view.on('change', handler)
  // Not every y-protocols build has `listenerCount`, so it is asked through an
  // optional call: where it is missing, there is nothing to check.
  const observed = awareness as unknown as { listenerCount?: (name: string) => number }
  assert.ok((observed.listenerCount?.('change') ?? 1) > 0)
  view.destroy()
  peer(awareness, 42, 'c1')
  // Nothing is deferred: the presence subscription is gone together with the
  // last view.
  assert.equal(clock.size, 0)
})

test('a neighbour moved to another cell — the frame carries them in removed', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const frames: AwarenessDiff[] = []
  view.on('change', (diff) => frames.push(diff))

  peer(awareness, 11, 'c1')
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [11], updated: [], removed: [] })

  // They moved to the next cell: they are no longer here — and the frame must
  // say so explicitly, not by silence, otherwise the caret with their name
  // stays hanging.
  peer(awareness, 11, 'c2')
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [], updated: [], removed: [11] })
  assert.equal(wakesEditor(frames.at(-1)!, awareness.clientID), true)
  assert.deepEqual([...view.getStates().keys()], [awareness.clientID])
  view.destroy()
})

test('the tab of a neighbour closed — only they are removed, the others are left alone', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const frames: AwarenessDiff[] = []
  view.on('change', (diff) => frames.push(diff))

  peer(awareness, 12, 'c1')
  peer(awareness, 13, 'c1')
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [12, 13], updated: [], removed: [] })

  leave(awareness, 13)
  clock.flush()
  // Number twelve did not move — it has no business in `updated`.
  assert.deepEqual(frames.at(-1), { added: [], updated: [], removed: [13] })
  assert.equal(wakesEditor(frames.at(-1)!, awareness.clientID), true)
  assert.deepEqual([...view.getStates().keys()].sort((a, b) => a - b), [awareness.clientID, 12].sort((a, b) => a - b))
  view.destroy()
})

test('movement of someone already there is updated, not a repeated added', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const frames: AwarenessDiff[] = []
  view.on('change', (diff) => frames.push(diff))

  peer(awareness, 14, 'c1', { anchor: { item: 1 }, head: { item: 1 } })
  clock.flush()
  peer(awareness, 14, 'c1', { anchor: { item: 5 }, head: { item: 7 } })
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [], updated: [14], removed: [] })
  view.destroy()
})

test('the last one left a cell where nobody remains — the frame still arrives', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  // Two views on one cell: just like two mounted editors of one cell (a
  // component rebuild). Each has its own diff, but they are identical.
  const first = cellAwareness(awareness, 'c1', clock.schedule)
  peer(awareness, 15, 'c1')
  clock.flush()
  const second = cellAwareness(awareness, 'c1', clock.schedule)
  const seenFirst: AwarenessDiff[] = []
  const seenSecond: AwarenessDiff[] = []
  first.on('change', (diff) => seenFirst.push(diff))
  second.on('change', (diff) => seenSecond.push(diff))

  leave(awareness, 15)
  clock.flush()
  assert.deepEqual(seenFirst, [{ added: [], updated: [], removed: [15] }])
  assert.deepEqual(seenSecond, [{ added: [], updated: [], removed: [15] }])
  first.destroy()
  second.destroy()
})
