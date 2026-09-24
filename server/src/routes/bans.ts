import { tr } from '@shared/i18n'
/**
 * The three ban doors: create, list, lift.
 *
 * Everything a ban relies on (marks, duration, matching, the refusal to the
 * banned person) lives in server/src/bans.ts, next to the entry check. Here
 * is only what a button press does: the right, the refusal in words, and
 * three consequences the entry check does not have.
 *
 * The consequences are the reason a ban is not just one row in a table. The
 * person banned may be sitting in the room right now: their questions hang in
 * the shared feed (usually that is exactly what they are banned for), the
 * model is still writing something for them, and their sockets are open and
 * know nothing about the ban. All three close the door at once.
 */
import { Router } from 'express'
import { addressOf, banParticipant, deviceOf, liftBan, listBans } from '../bans.js'
import { evictBanned, purgeCouncilOf } from '../control.js'
import { getParticipant, getSession } from '../db.js'
import { purgeQuestions } from './ai.js'
import { banDoor, sessionAuth } from './sessions.js'
import { SESSION_MISSING } from '@shared/protocol'

/** The same as for the other ids on these wires. */
const MAX_ID = 128

export function banRoutes(): Router {
  const router = Router()

  // On its own doors too: the ban list is the room, and the room has one right
  // (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  /*
   * The right is the same at all three doors and is checked where the
   * neighboring routes check it: `sessionAuth` recomputes the role on every
   * request from the staff cookie instead of taking it from the token.
   * Otherwise a teacher removed from staff would keep banning in every room
   * they ever opened.
   *
   * And the room has to exist before anything else: purging the feed brings
   * up the document, and bringing up the document of a removed seminar would
   * resurrect it by a token that is no longer on the list.
   */

  router.get('/api/sessions/:id/bans', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (auth.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherMayViewBlockedParticipants.5bc743") })
    }
    res.json({ bans: listBans(sessionId, deviceOf(req.headers.cookie)) })
  })

  router.post('/api/sessions/:id/bans', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (auth.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherMayBlockAccessTo.0508ad") })
    }

    const body = req.body as { participantId?: unknown } | undefined
    const participantId =
      typeof body?.participantId === 'string' && body.participantId.length <= MAX_ID
        ? body.participantId
        : ''
    if (!participantId) return res.status(400).json({ error: tr("server.participantidIsRequired.fc7d8c") })
    /*
     * "No such person here" and "this is a teacher" are different answers,
     * yet `banParticipant` answers `null` to both: the "staff cannot be
     * banned" invariant lives there, next to the check itself. This line tells
     * them apart, and only for the sake of the refusal's wording.
     */
    if (!getParticipant(sessionId, participantId)) {
      return res.status(404).json({ error: tr("server.participantNotFound.d59506") })
    }

    const ban = banParticipant({
      sessionId,
      participantId,
      // A "seems to be back" hint and nothing more: the address takes no part
      // in the check, since the whole lecture hall sits behind one NAT.
      ip: addressOf(req),
      // A name, not a staff id: the row is read by a second teacher of the
      // same room, who needs to know who blocked, not whose key it is.
      byTeacher: getParticipant(sessionId, auth.participantId)?.name ?? null,
      viewerDevice: deviceOf(req.headers.cookie),
    })
    if (!ban) return res.status(403).json({ error: tr("server.aTeacherCannotBeBlocked.ac6170") })

    /*
     * The order here matters.
     *
     * First the database row: the purge involves a history write and an edit
     * of the shared document, and if it failed halfway, the person would stay
     * unblocked with their questions already erased. Eviction comes last:
     * while the sockets are open the feed can be tidied from under them
     * silently, and after the frame they will not see anything any more.
     */
    purgeQuestions(sessionId, { participantId, name: ban.name }, auth.participantId)
    // And their council attempts: the same text before the teacher's eyes,
    // only in the stack rather than in the feed. The stacks without them go to
    // the host from here too.
    purgeCouncilOf(sessionId, participantId)
    evictBanned(sessionId, participantId, ban.until)

    res.status(201).json({ ban })
  })

  router.delete('/api/sessions/:id/bans/:banId', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (auth.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherMayRestoreAccess.001a27") })
    }
    /*
     * Lifting brings back the person, not their questions: what was erased
     * from the feed is brought back by the version named "before banning
     * <name>". Promising more here would mean lying to the teacher at exactly
     * the minute they realized they banned the wrong person.
     */
    if (!liftBan(sessionId, req.params.banId)) {
      return res.status(404).json({ error: tr("server.noSuchBan.55c3bd") })
    }
    res.json({ ok: true })
  })

  return router
}
