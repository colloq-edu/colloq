/**
 * Speaker notes written many pages at once: a lecture script imported in one
 * go.
 *
 * HTTP and not the control socket, and the reason is size. A socket frame is
 * capped at 32 KB (control.ts · MAX_FRAME_BYTES), and fifty slides of talk in
 * Cyrillic are a hundred and fifty kilobytes. Over the socket the import would
 * have to go in pieces, and pieces are exactly what "in one go" must not be: a
 * script that stopped at slide 23 leaves the deck half old, half new. Here
 * the whole script is one request and one transaction.
 *
 * The rights are those of `notes:set`, word for word: the host role, nothing
 * about who presents and nothing about the room's `board` rule. Notes are
 * written the evening before, with no lecture running, and they are never
 * shown to the room, so neither of those decides who may write them.
 *
 * What comes back goes only to the teacher tabs that have this document's
 * notes open (control.ts · notesRewritten), never to the room.
 */
import { Router } from 'express'
import { tr } from '@shared/i18n'
import { MAX_NOTE_CHARS } from '@shared/lecture'
import { normalizePath } from '@shared/paths'
import { SESSION_MISSING } from '@shared/protocol'
import { notesRewritten } from '../control.js'
import { getSession, notesOf, setNotes } from '../db.js'
import { banDoor, sessionAuth } from './sessions.js'

/**
 * Pages per import. A deck has tens of slides, a long handout a couple of
 * hundred; the ceiling is there so that one request cannot keep the database
 * busy writing a hundred thousand rows, not to fit anybody's lecture.
 */
export const MAX_IMPORT_PAGES = 500

/** A page number a document can have: the same four digits the script headings carry. */
const MAX_PAGE = 9999

export function noteRoutes(): Router {
  const router = Router()
  router.use('/api/sessions/:id/notes', (_req, res, next) => {
    // The teacher's words to themselves: no shared cache keeps a copy.
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  })

  router.put('/api/sessions/:id/notes', banDoor, (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr('server.joinTheSessionFirst.442dd6') })
    if (auth.role !== 'host') {
      return res.status(403).json({ error: tr('server.onlyTheTeacherMayEditSpeakerNotes.729773') })
    }

    const body = req.body as { file?: unknown; notes?: unknown } | undefined
    const raw = body?.notes
    if (typeof body?.file !== 'string' || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return res.status(400).json({ error: tr('server.notes.importBody') })
    }
    const file = normalizePath(body.file)
    if (!file) return res.status(400).json({ error: tr('server.notes.importFile') })

    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length > MAX_IMPORT_PAGES) {
      return res
        .status(400)
        .json({ error: tr('server.notes.importTooMany', { p0: MAX_IMPORT_PAGES }) })
    }
    /*
     * Everything is checked before anything is written, and one bad page
     * refuses the whole request out loud. Skipping it silently would be the
     * import's way of losing text: the teacher would see "imported" and find
     * slide 14 still saying last year's words in class.
     */
    const notes = new Map<number, string>()
    for (const [key, value] of entries) {
      const page = Number(key)
      if (!/^\d+$/.test(key) || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) {
        return res.status(400).json({ error: tr('server.aNoteMustBelongToADocument.783591') })
      }
      if (typeof value !== 'string') {
        return res.status(400).json({ error: tr('server.notes.importBody') })
      }
      // Counted after trimming, as the database stores it and as the editor counts.
      const text = value.trim()
      if (text.length > MAX_NOTE_CHARS) {
        return res.status(400).json({
          error: tr('server.notes.importTooLong', {
            p0: page,
            p1: MAX_NOTE_CHARS,
            p2: text.length,
          }),
        })
      }
      notes.set(page, text)
    }

    setNotes(sessionId, file, notes)
    notesRewritten(sessionId, file)
    res.json({ file, notes: notesOf(sessionId, file) })
  })

  return router
}
