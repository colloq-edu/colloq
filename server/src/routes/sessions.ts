import { Router, type Request } from 'express'
import { currentStaff } from '../admin/auth.js'
import {
  newParticipantId,
  newSessionId,
  signHostToken,
  signToken,
  verifyHostToken,
  verifyToken,
  type TokenPayload,
} from '../auth.js'
import { config } from '../config.js'
import {
  createSession,
  getParticipant,
  getSession,
  listParticipants,
  upsertParticipant,
} from '../db.js'
import { onlineParticipantIds } from '../collab/index.js'
import { ensureKernel } from '../kernel/index.js'
import { setSeminarCreator } from './admin-instance.js'
import type { AdminErrorBody } from '@shared/admin'
import type {
  CreateSessionResponse,
  JoinResponse,
  ParticipantRole,
} from '@shared/protocol'

/*
 * Lengths that have to survive being drawn, not just stored. A seminar name is
 * a display heading and a person's name sits in a cell footer and an avatar
 * tooltip, so both are cut where the layout stops coping rather than where the
 * column would. The avatar is one emoji, and 512 UTF-16 code units is
 * room for the longest of them — flags and family sequences run long.
 */
const MAX_SESSION_NAME = 80
const MAX_PARTICIPANT_NAME = 40
const MAX_AVATAR = 512

/** Collapse whitespace and drop control characters so a name cannot break the roster layout. */
function normalize(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Bearer credential that must belong to the `:id` in the path. Lives here
 * because this module mints the tokens; the file and AI routes import it.
 *
 * A staff cookie outranks the role the token was minted with — the same rule
 * the WebSocket upgrade applies in effectiveRole(), and it has to be the same
 * rule or the product answers one question two ways. It did: a teacher who
 * opened the seminar link before signing in holds a participant token for a
 * room that is theirs, and while the sockets let them interrupt the kernel, the
 * HTTP side refused them a checkpoint, a restore and the thread's own eraser.
 * Same person, same browser, same second, two answers.
 *
 * Re-read per request rather than baked into the token, so signing out of the
 * teaching side takes the powers with it on the next call.
 */
export function sessionAuth(req: Request): TokenPayload | null {
  const header = req.headers.authorization ?? ''
  const raw = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : typeof req.query.token === 'string'
      ? req.query.token
      : ''
  const payload = verifyToken(raw)
  if (!payload || payload.sessionId !== req.params.id) return null
  return currentStaff(req) ? { ...payload, role: 'host' } : payload
}

export function sessionRoutes(): Router {
  const router = Router()

  router.post('/api/sessions', (req, res) => {
    // Who may open a room. An instance with OPEN_SEMINAR_CREATION off is one
    // where a visitor spinning up a seminar would be spending the owner's API
    // key, so staff are the only ones left; the students who matter here arrive
    // through /join with a link and never touch this route.
    const staff = currentStaff(req)
    if (!config.openSeminarCreation && !staff) {
      const denied: AdminErrorBody = {
        error: 'Only staff can create a seminar on this instance. Ask for a link to the one you are joining.',
        reason: 'forbidden',
      }
      return res.status(403).json(denied)
    }

    const name = normalize(req.body?.name)
    if (!name) return res.status(400).json({ error: 'a session name is required' })
    if (name.length > MAX_SESSION_NAME) {
      return res.status(400).json({ error: `session name must be ${MAX_SESSION_NAME} characters or fewer` })
    }

    const id = newSessionId()
    const session = createSession(id, name)
    // A seminar created straight against this endpoint by a signed-in teacher
    // is still theirs. There is no page that does it — the panel has its own
    // route — so this is the scripted path, and on an open instance it produces
    // a seminar with nobody's name on it.
    if (staff) setSeminarCreator(id, staff.name)
    const body: CreateSessionResponse = { session, hostToken: signHostToken(id) }
    res.status(201).json(body)
  })

  router.get('/api/sessions/:id', (req, res) => {
    const session = getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'session not found' })
    res.json(session)
  })

  router.post('/api/sessions/:id/join', (req, res) => {
    const sessionId = req.params.id
    const session = getSession(sessionId)
    if (!session) return res.status(404).json({ error: 'session not found' })

    const name = normalize(req.body?.name).slice(0, MAX_PARTICIPANT_NAME)
    if (!name) return res.status(400).json({ error: 'a name is required' })

    const rawAvatar = req.body?.avatar
    const avatar =
      typeof rawAvatar === 'string' && rawAvatar.length > 0 && rawAvatar.length <= MAX_AVATAR
        ? rawAvatar
        : null

    /*
     * Role never comes from the client's stored identity — anyone could paste in
     * someone else's participantId and inherit their badge. Two things grant it:
     *
     *  - a signed host token, minted at creation and kept by whoever made the
     *    room, which is how an open instance with no staff list works;
     *  - a staff cookie. Seminars created in the admin panel never handed a host
     *    token to anybody, so nobody could interrupt or restart the kernel in
     *    them — the controls were dead for the whole room. A teacher signed in
     *    to this instance is exactly the person those controls are for, and the
     *    cookie is a stronger credential than the token.
     */
    const staff = currentStaff(req)
    const role: ParticipantRole =
      staff || verifyHostToken(sessionId, req.body?.hostToken) ? 'host' : 'participant'

    /*
     * Coming back as yourself has to be proved.
     *
     * Awareness broadcasts every participant id to the whole room, because that
     * is how a caret gets a face — so "I am p_xyz" is a sentence any student in
     * the seminar can say about anybody in it. It never granted the badge: the
     * role is decided above, from credentials this request carries. But an
     * unproved claim still overwrote the row it named, which meant one person
     * could rename another in the participants list, take their avatar, and set
     * the role recorded against them back to participant.
     *
     * The proof is the token minted for that participant when they joined. Only
     * their own browser has it. Without it — a cleared store, another machine —
     * the visitor is somebody new, which is the honest reading of "I cannot show
     * you anything that says I was here before".
     */
    const claimed = typeof req.body?.participantId === 'string' ? req.body.participantId : null
    const proof = verifyToken(typeof req.body?.token === 'string' ? req.body.token : null)
    const proved =
      claimed !== null && proof !== null && proof.sessionId === sessionId && proof.participantId === claimed
    const known = proved ? getParticipant(sessionId, claimed) : null
    const participantId = known ? known.id : newParticipantId()

    const participant = upsertParticipant({ id: participantId, sessionId, name, avatar, role })
    const token = signToken({ sessionId, participantId, role })

    // Warm the kernel while the student is still reading the page; a failure
    // here is not fatal, the control socket reports kernel health on its own.
    void ensureKernel(sessionId).catch((err: unknown) => {
      console.warn(`[session ${sessionId}] kernel warmup failed:`, err instanceof Error ? err.message : err)
    })

    const body: JoinResponse = { session, participant, token }
    res.json(body)
  })

  router.get('/api/sessions/:id/participants', (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: 'session not found' })
    // `participants` is everyone who ever joined; `online` is who is in the room
    // this second. The join screen needs the second to say "N already inside"
    // without counting last term's students.
    res.json({
      participants: listParticipants(req.params.id),
      online: onlineParticipantIds(req.params.id),
    })
  })

  router.get('/api/sessions/:id/link', (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: 'session not found' })
    res.json({ url: `${config.publicUrl}/s/${req.params.id}` })
  })

  return router
}
