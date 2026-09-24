import { tr } from '@shared/i18n'
/**
 * Output images by a separate request, not inside the room's document.
 *
 * Why they live outside is said in `server/src/blobs.ts`. This is about how
 * they are fetched.
 *
 * THE KEY. The address goes into the `src` of an `<img>` element, and a
 * header cannot be put there, so the credential travels in the query string,
 * and that is exactly the case `signDownloadToken` exists for (see
 * routes/files.ts): a short-lived key for one job instead of the participant
 * token that opens the control socket. The key here is one per room, not per
 * image: the output of one cell is a dozen records, and asking for a key for
 * each would mean a dozen extra requests per chart. The key opens nothing
 * beyond what the person already sees in the notebook: it is good exactly for
 * `/api/sessions/:id/blobs/*` of the room the person joined.
 *
 * THE CACHE. A record's name is the hash of its content, so the response is
 * served `immutable` for a year: no other image can ever appear at this
 * address. `private` because access to it is by key after all, and a shared
 * cache in front of the server is not supposed to keep it.
 */
import { Router } from 'express'
import { SESSION_MISSING } from '@shared/protocol'
import { signDownloadToken, verifyDownloadToken } from '../auth.js'
import { blobBytes, readBlob, sniffMime } from '../blobs.js'
import { getSession } from '../db.js'
import { banDoor, sessionAuth } from './sessions.js'

/**
 * What the key to a room's images is signed with.
 *
 * `signDownloadToken` signs the pair "seminar + name", and the name here is
 * not a file but the whole shelf of outputs. It cannot collide with a real
 * file: a file path is normalized (`normalizePath`), and it never starts with
 * a colon; and even if it matched, both doors are opened by the same thing,
 * participation in the room.
 */
const BLOB_SUBJECT = ':blobs'

export function blobRoutes(): Router {
  const router = Router()

  // Blocked access is blocked here too: someone removed from the room does not
  // fetch its images with an old key (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id/blobs', banDoor)

  /**
   * The key to this room's images, behind the ordinary participant credential.
   *
   * Five minutes (`DOWNLOAD_TTL_MS`), and that is enough: the key is taken
   * before drawing the first image, and a drawn image lives in the browser
   * cache at its address and is not requested a second time.
   */
  router.get('/api/sessions/:id/blobs/ticket', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    if (!sessionAuth(req)) {
      return res.status(401).json({ error: tr('server.joinTheSessionFirst.442dd6') })
    }
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ token: signDownloadToken(sessionId, BLOB_SUBJECT) })
  })

  router.get('/api/sessions/:id/blobs/:sha', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const ticket = typeof req.query.token === 'string' ? req.query.token : ''
    const allowed = sessionAuth(req) !== null || verifyDownloadToken(sessionId, BLOB_SUBJECT, ticket)
    if (!allowed) return res.status(401).json({ error: tr('server.joinTheSessionFirst.442dd6') })

    const sha = req.params.sha
    /*
     * The ETag comes before reading the file: a record's name is its content,
     * so a repeat visit can be answered without touching the disk at all. This
     * is not optimization for its own sake: in a seminar an image is one for
     * everyone, and five hundred tabs waking from sleep come for it in the
     * same second.
     */
    const etag = `"${sha}"`
    const bytes = blobBytes(sessionId, sha)
    if (bytes === null) return res.status(404).json({ error: tr('server.fileNotFound.3e2256') })
    res.setHeader('ETag', etag)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    if (req.headers['if-none-match'] === etag) return res.status(304).end()

    const body = readBlob(sessionId, sha)
    if (!body) return res.status(404).json({ error: tr('server.fileNotFound.3e2256') })
    /*
     * The type comes from the bytes themselves (`sniffMime`), not from what
     * was asked for: the `display_data` bundle is assembled by a library in
     * the student's code, and "now show these bytes as text/html" would be
     * someone else's document on the instance's origin.
     */
    res.setHeader('Content-Type', sniffMime(body))
    res.setHeader('Content-Length', String(body.length))
    // An image is displayed, not opened as a separate page.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(body)
  })

  return router
}
