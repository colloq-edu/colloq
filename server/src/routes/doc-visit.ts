/**
 * Look into a room's notebook without settling it in memory for good.
 *
 * `getSessionDoc` creates a document for any id it is given, and it is
 * brought up not only by people in the room: a rename in the panel, an open
 * version feed, a publication, an import, a council summary. The sweep of idle
 * rooms (collab/index.ts · sweepIdleRooms) will let such a notebook go, but
 * not before ten minutes of emptiness: rename fifty archived seminars in a
 * row, and fifty other people's notebooks with images (every second one with
 * a full snapshot in history and the text of every cell) sit in memory at
 * once, next to live rooms. There is nothing to wait for: a room brought up
 * for the sake of one line was nobody's for a single second.
 *
 * The rule is simple: a room with someone in it already has its document up,
 * and we work with that one, touching nothing. For an empty one we borrow it:
 * flush what was written to disk and evict it. The next person to join brings
 * it up from the same snapshot they would have without us.
 *
 * The visitor has to be synchronous. There must be no await between `peek`
 * and the eviction: otherwise someone would join the room mid-visit, and we
 * would pull the document out from under them.
 */
import type * as Y from 'yjs'
import { getSessionDoc, peekSessionDoc, releaseSessionDoc } from '../collab/index.js'
import { flushHistory } from '../collab/history.js'
import { flushPersistence } from '../collab/persistence.js'

export function visitSessionDoc<T>(sessionId: string, visit: (doc: Y.Doc) => T): T {
  const live = peekSessionDoc(sessionId)
  if (live) return visit(live.doc)

  const { doc } = getSessionDoc(sessionId)
  try {
    return visit(doc)
  } finally {
    /*
     * First the history, then the snapshot, then the eviction.
     *
     * The eviction leaves silently, so everything the visit wrote has to be
     * put on disk by us in time: the open burst of edits (otherwise there
     * would be an edit but no row about it) and the document snapshot.
     *
     * `releaseSessionDoc` evicts: the same exit the idle sweep uses, and it
     * closes nothing. The deletion door (`dropSessionDoc`) is no good for a
     * visitor: besides evicting, it cuts off the Oracle's answers, forgets
     * what was cancelled and closes the room's sockets with the words "this
     * seminar was deleted", while file sockets live in their own map
     * (collab/files.ts) and do not bring up the room document: an open `.py`
     * editor that survived the sweep would get code 1001 "room closed" from it
     * in the middle of a live seminar.
     *
     * The flush before eviction is a statement rather than an extra
     * precaution: `evictRoom` writes both the history and the snapshot itself,
     * but here the intent is visible: the visitor leaves without losing
     * anything.
     *
     * We do not check the answer of `releaseSessionDoc`: it says `false` about
     * a room with people in it, and only rooms for which `peek` returned null
     * get here, with no await between that and the eviction, so nobody can
     * join mid-visit.
     */
    flushHistory(sessionId)
    flushPersistence(sessionId)
    releaseSessionDoc(sessionId)
  }
}
