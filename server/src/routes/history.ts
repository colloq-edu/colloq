/**
 * Reading a room's history, and putting an old version back.
 *
 * Everyone in the seminar can read it: the notebook is shared, so who changed
 * what is not a secret from the people it was changed in front of. Restoring is
 * narrower — it rewrites what the whole room is looking at, so it belongs to
 * whoever is teaching.
 */
import { Router, type Request, type Response } from 'express'
import type { CellDiff, Version, VersionKind } from '@shared/history'
import { sessionAuth } from './sessions.js'
import { getSessionDoc } from '../collab/index.js'
import { cellsAt, cellsOf, mark, restoreInto } from '../collab/history.js'
import { diffLines } from '@shared/diff'
import { getParticipant, getVersion, listVersions, getSession } from '../db.js'

/**
 * Everyone in the room may read the history — the notebook is shared, so who
 * changed what is not a secret from the people it changed in front of. The two
 * writing routes below check for the host on top of this.
 */
function whoever(req: Request, res: Response): ReturnType<typeof sessionAuth> {
  /*
   * The room has to still exist. Without this the history routes were the one
   * door a deleted seminar was still open through: getSessionDoc() below
   * builds a document for any id it is handed, so a stale token fetched the
   * notebook of a room the panel had already reported gone — and, worse, put
   * that room back in memory.
   */
  if (!getSession(req.params.id)) {
    res.status(404).json({ error: 'session not found' })
    return null
  }
  const payload = sessionAuth(req)
  if (!payload) {
    res.status(401).json({ error: 'this history belongs to a seminar you are not in' })
    return null
  }
  return payload
}

/** The timeline is read whole; a seminar that produced more than this is an outlier. */
const MAX_VERSIONS = 400

function toVersion(sessionId: string, row: {
  seq: number
  kind: string
  author_id: string | null
  created_at: number
  label: string | null
  summary: string
  added: number
  removed: number
  cells: string
}): Version {
  const person = row.author_id ? getParticipant(sessionId, row.author_id) : null
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
  }
}

export function historyRoutes(): Router {
  const router = Router()

  /**
   * The timeline.
   *
   * НЕ сбрасывает открытый всплеск, хотя когда-то сбрасывал и комментарий об
   * этом пережил правку на несколько месяцев. Сбрасывать нельзя: чтение
   * истории — это чтение, а закрытие всплеска пишет версию, и панель, открытая
   * посреди набора, разрезала бы чужую строку пополам (коммит 862ca42).
   *
   * Последняя минута появляется не здесь, а у того, кто смотрит: панель
   * перечитывает список ещё раз через BURST_IDLE_MS после последней правки —
   * ровно тогда, когда сервер её и запишет.
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
     */
    getSessionDoc(sessionId)
    const rows = listVersions(sessionId, MAX_VERSIONS)
    // Keyframes are bookkeeping — full-document rows written every so often so
    // that rebuilding is cheap. They are not something anybody did.
    const versions = rows
      // Two kinds are bookkeeping, not story: the keyframe is a snapshot the
      // replay starts from, the quiet row is bytes the replay must not skip.
      .filter((r) => r.kind !== 'keyframe' && r.kind !== 'quiet')
      .map((r) => toVersion(sessionId, r))

    res.json({ versions })
  })

  /** The notebook as it stood at one version, and what that version changed. */
  router.get('/api/sessions/:id/history/:seq', (req: Request, res: Response) => {
    if (!whoever(req, res)) return
    const sessionId = req.params.id
    const seq = Number(req.params.seq)
    if (!Number.isInteger(seq)) return res.status(400).json({ error: 'bad version' })
    const row = getVersion(sessionId, seq)
    if (!row) return res.status(404).json({ error: 'no such version' })

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

    res.json({ version: toVersion(sessionId, row), cells: after, diffs })
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
  router.post(
    '/api/sessions/:id/history/:seq/restore',
    (req: Request, res: Response) => {
      const identity = whoever(req, res)
      if (!identity) return
      if (identity.role !== 'host') {
        return res.status(403).json({ error: 'only the host can restore a version' })
      }
      const sessionId = req.params.id
      const seq = Number(req.params.seq)
      const row = getVersion(sessionId, seq)
      if (!row) return res.status(404).json({ error: 'no such version' })

      const onlyCell = typeof req.body?.cellId === 'string' ? req.body.cellId : null
      const { doc } = getSessionDoc(sessionId)
      const stamp = new Date(row.created_at)
      const at = `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`

      const changed = restoreInto(sessionId, doc, seq, identity.participantId, onlyCell, at)

      res.json({ restored: changed })
    },
  )

  /** Name this moment, so it can be found later without reading the whole list. */
  router.post(
    '/api/sessions/:id/history/checkpoint',
    (req: Request, res: Response) => {
      const identity = whoever(req, res)
      if (!identity) return
      if (identity.role !== 'host') {
        return res.status(403).json({ error: 'only the host can set a checkpoint' })
      }
      const sessionId = req.params.id
      const label = String(req.body?.label ?? '').trim().slice(0, 80)
      if (!label) return res.status(400).json({ error: 'a checkpoint needs a name' })

      const { doc } = getSessionDoc(sessionId)
      const seq = mark(sessionId, doc, 'checkpoint', identity.participantId, label, label)
      res.status(201).json({ seq, cells: cellsOf(doc).length })
    },
  )

  return router
}
