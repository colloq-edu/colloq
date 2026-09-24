import { tr } from '@shared/i18n'
/**
 * Reading a room's history, and putting an old version back.
 *
 * Everyone in the seminar can read it: the notebook is shared, so who changed
 * what is not a secret from the people it was changed in front of. Restoring is
 * narrower — it rewrites what the whole room is looking at, so it belongs to
 * whoever is teaching.
 */
import { Router, type Request, type Response } from 'express'
import type { CellDiff, Version, VersionKind, VersionList } from '@shared/history'
import { SESSION_MISSING } from '@shared/protocol'
import { banDoor, sessionAuth } from './sessions.js'
import { allows } from '@shared/rules'
import { cellsWithCarets } from '../collab/index.js'
import { visitSessionDoc } from './doc-visit.js'
import { cellsAt, cellsOf, mark, restoreInto } from '../collab/history.js'
import { diffLines } from '@shared/diff'
import {
  getRules,
  getVersion,
  historyTrimmed,
  listParticipants,
  listStoryVersions,
  getSession,
} from '../db.js'

/**
 * Everyone in the room may read the history — the notebook is shared, so who
 * changed what is not a secret from the people it changed in front of. The two
 * writing routes below check for the host on top of this.
 */
function whoever(req: Request, res: Response): ReturnType<typeof sessionAuth> {
  /*
   * The room has to still exist. Without this the history routes were the one
   * door a deleted seminar was still open through: visitSessionDoc() below
   * builds a document for any id it is handed, so a stale token fetched the
   * notebook of a room the panel had already reported gone — rebuilding it in
   * memory to do so.
   */
  if (!getSession(req.params.id)) {
    res.status(404).json({ error: SESSION_MISSING })
    return null
  }
  const payload = sessionAuth(req)
  if (!payload) {
    res.status(401).json({ error: tr("server.thisHistoryBelongsToASeminarYou.5112cc") })
    return null
  }
  /*
   * The feed follows the room's rule. By default the whole room sees it: the
   * notebook is shared, and who changed what is no secret from those in whose
   * presence it changed. But a seminar where the notebook is shown rather
   * than written together has the right to close it: there the feed is the
   * teacher's drafts, which they never showed.
   *
   * The end of class deliberately does not touch this rule (shared/rules.ts ·
   * rulesAfterClass): history is reading, and after the lesson is exactly when
   * people come for it, to see what was in a cell before it was rewritten.
   * Restore and checkpoint are closed, but they are teacher-only anyway.
   */
  if (!allows(getRules(req.params.id).history, payload.role)) {
    res.status(403).json({ error: tr("server.onlyTheTeacherCanViewThisSeminar.4c05e0") })
    return null
  }
  return payload
}

/**
 * The timeline is read whole; a seminar that produced more than this is an outlier.
 *
 * The same number of named moments is taken too, in a separate window: a
 * checkpoint must not be pushed out by edits (see listStoryVersions).
 */
const MAX_VERSIONS = 400

/**
 * Who wrote it, from one map per request rather than a query per row.
 *
 * `getParticipant` for each of four hundred rows is four hundred synchronous
 * SELECTs for one GET, and the feed opens for the whole room at once: the
 * teacher said "look at the history", and five hundred people clicked. The
 * room's participant list is one query, and after that it is a Map lookup.
 */
type People = Map<string, { name: string; color: string }>

function peopleOf(sessionId: string): People {
  const people: People = new Map()
  for (const person of listParticipants(sessionId)) {
    people.set(person.id, { name: person.name, color: person.color })
  }
  return people
}

function toVersion(
  people: People,
  row: {
    seq: number
    kind: string
    author_id: string | null
    created_at: number
    label: string | null
    summary: string
    added: number
    removed: number
    cells: string
    target_seq: number | null
  },
): Version {
  const person = row.author_id ? (people.get(row.author_id) ?? null) : null
  return {
    seq: row.seq,
    kind: row.kind as VersionKind,
    authorId: row.author_id,
    authorName: person?.name ?? null,
    authorColor: person?.color ?? null,
    createdAt: row.created_at,
    label: row.label,
    summary: row.summary,
    added: row.added,
    removed: row.removed,
    cells: JSON.parse(row.cells) as string[],
    targetSeq: row.target_seq,
  }
}

export function historyRoutes(): Router {
  const router = Router()

  // The feed is the room too: blocked access blocks it as well (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  /**
   * The timeline.
   *
   * Does NOT flush the open burst, although it once did, and the comment
   * saying so outlived that change by several months. It must not flush:
   * reading history is reading, while closing a burst writes a version, and a
   * panel opened mid-typing would cut someone else's line in half (commit
   * 862ca42).
   *
   * The last minute appears not here but on the viewer's side: the panel
   * re-reads the list once more BURST_IDLE_MS after the last edit, exactly
   * when the server writes it.
   */
  router.get('/api/sessions/:id/history', (req: Request, res: Response) => {
    if (!whoever(req, res)) return
    const sessionId = req.params.id
    /*
     * Load the room before reading its history.
     *
     * A seminar nobody has opened since the server started has no live
     * document, and therefore no base row — the one carrying a whole notebook
     * that every rebuild replays from. Without this the panel opens on an empty
     * list for a room full of work, which is exactly the moment somebody is
     * looking for something they lost. Binding it is what the first person
     * through the door would have done anyway.
     *
     * And with the same motion we let it go: someone else's notebook brought
     * up for a single read has no reason to stay in memory until the idle
     * sweep (routes/doc-visit.ts).
     */
    visitSessionDoc(sessionId, () => {})
    /*
     * Internal rows are filtered out by SQL, not by this handler.
     *
     * Two kinds are bookkeeping, not history: keyframe, where a replay starts,
     * and quiet, whose bytes the replay must not skip. While the window of four
     * hundred rows was cut before the filter, there were so many of them that
     * the window went to them entirely: a lesson with running cells wrote a
     * quiet row every few seconds, and the panel showed a handful of edits or
     * nothing, with a hundred edits and a "before the exercise" checkpoint in
     * the database.
     *
     * And the query takes the named moments in their own window: even edits
     * alone add up to four hundred rows within an hour of an active lesson,
     * and a checkpoint is set so as to return to it at the end.
     */
    const people = peopleOf(sessionId)
    const versions = listStoryVersions(sessionId, MAX_VERSIONS).map((r) => toVersion(people, r))

    /*
     * The incompleteness flag travels with the rows, because the rows
     * themselves do not show it: trimming by size (db.ts · trimHistory)
     * removes the start of the feed entirely, and the rest looks like the
     * complete history of a short lesson.
     *
     * It is exactly about what was deleted. The `MAX_VERSIONS` window above
     * does not return everything either, but those versions are in the
     * database and open by link: the two kinds of incompleteness must not be
     * mixed in one word.
     */
    const body: VersionList = { versions, trimmed: historyTrimmed(sessionId) }
    res.json(body)
  })

  /** The notebook as it stood at one version, and what that version changed. */
  router.get('/api/sessions/:id/history/:seq', (req: Request, res: Response) => {
    if (!whoever(req, res)) return
    const sessionId = req.params.id
    const seq = Number(req.params.seq)
    if (!Number.isInteger(seq)) return res.status(400).json({ error: tr("server.badVersion.a29edb") })
    const row = getVersion(sessionId, seq)
    if (!row) return res.status(404).json({ error: tr("server.noSuchVersion.57ccc9") })

    const after = cellsAt(sessionId, seq)
    // seq - 1 is not necessarily a row, but updatesUpTo takes a ceiling rather
    // than an exact address, so it resolves to the state just before this one.
    const before = cellsAt(sessionId, seq - 1)
    const wasById = new Map(before.map((c) => [c.id, c]))
    const nowById = new Map(after.map((c) => [c.id, c]))

    const touched: string[] = JSON.parse(row.cells)
    const diffs: CellDiff[] = touched.map((cellId) => {
      const was = wasById.get(cellId)?.source ?? null
      const now = nowById.get(cellId)?.source ?? null
      return {
        cellId,
        before: was,
        after: now,
        lines: diffLines(was ?? '', now ?? ''),
      }
    })

    res.json({ version: toVersion(peopleOf(sessionId), row), cells: after, diffs })
  })

  /**
   * Put a version back.
   *
   * The CRDT is not rewound. Rewinding would mean rolling back state vectors
   * that every browser in the room is holding, and the next keystroke from any
   * of them would arrive against a document that no longer matches — the room
   * would tear. Instead the old content is written into the live document as an
   * ordinary edit: it merges the way any edit merges, everybody sees it at
   * once, and because it is an edit it is itself a version, so a restore can be
   * undone by restoring what came before it.
   */
  router.post('/api/sessions/:id/history/:seq/restore', (req: Request, res: Response) => {
    const identity = whoever(req, res)
    if (!identity) return
    if (identity.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheHostCanRestoreAVersion.0540c5") })
    }
    const sessionId = req.params.id
    const seq = Number(req.params.seq)
    const row = getVersion(sessionId, seq)
    if (!row) return res.status(404).json({ error: tr("server.noSuchVersion.57ccc9") })

    const onlyCell = typeof req.body?.cellId === 'string' ? req.body.cellId : null
    /*
     * The time is not assembled here. The server used to format it in its own
     * zone (UTC in the node image), while the browser draws the feed rows in
     * its own: in a UTC+3 lecture hall the caption "restored the version from
     * 15:04" pointed at a row that is not in the list. The version is named by
     * address (`targetSeq`), and the clock is drawn by whoever looks.
     */
    const changed = visitSessionDoc(sessionId, (doc) =>
      restoreInto(
        sessionId,
        doc,
        seq,
        identity.participantId,
        onlyCell,
        // Who is typing right now, for the cell reordering: it can move a cell
        // only by recreating it as a clone, and the clone loses keystrokes that
        // went into the old `Y.Text` a round trip before the server. Where
        // there is a choice, the one with the caret stays.
        cellsWithCarets(doc),
      ),
    )

    res.json({ restored: changed })
  })

  /** Name this moment, so it can be found later without reading the whole list. */
  router.post('/api/sessions/:id/history/checkpoint', (req: Request, res: Response) => {
    const identity = whoever(req, res)
    if (!identity) return
    if (identity.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheHostCanSetACheckpoint.e8860a") })
    }
    const sessionId = req.params.id
    const label = String(req.body?.label ?? '')
      .trim()
      .slice(0, 80)
    if (!label) return res.status(400).json({ error: tr("server.aCheckpointNeedsAName.845b89") })

    const marked = visitSessionDoc(sessionId, (doc) => ({
      seq: mark(sessionId, doc, 'checkpoint', identity.participantId, label, label),
      cells: cellsOf(doc).length,
    }))
    res.status(201).json(marked)
  })

  return router
}
