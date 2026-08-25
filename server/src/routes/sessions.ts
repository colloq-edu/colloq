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
import { ensureKernel } from '../kernel/index.js'
import { setSeminarCreator } from './admin-instance.js'
import type { AdminErrorBody } from '@shared/admin'
import type {
  CreateSessionResponse,
  JoinResponse,
  ParticipantRole,
} from '@shared/protocol'

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
  return payload
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
    // A seminar started from the home screen by a signed-in teacher is still
    // theirs; only an open instance produces one with nobody's name on it.
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

    // Role never comes from the client's stored identity: a signed host token is
    // the only way to become host, otherwise anyone could paste in someone
    // else's participantId and inherit their badge.
    const role: ParticipantRole = verifyHostToken(sessionId, req.body?.hostToken) ? 'host' : 'participant'

    const claimed = typeof req.body?.participantId === 'string' ? req.body.participantId : null
    const known = claimed ? getParticipant(sessionId, claimed) : null
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
    res.json({ participants: listParticipants(req.params.id) })
  })

  router.get('/api/sessions/:id/link', (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: 'session not found' })
    res.json({ url: `${config.publicUrl}/s/${req.params.id}` })
  })

  return router
}
