/**
 * The assistant's REST surface.
 *
 * There is no response stream here any more. Asking is fire-and-forget: the
 * server appends the question to the session document and streams the answer
 * into it, so the reply reaches the whole room through the CRDT that already
 * carries cell outputs. The asker's own browser is just another reader of it.
 *
 * This is also where the instance's guardrails are enforced. They are checked
 * here rather than deeper in ai/index.ts on purpose: a refusal has to reach the
 * student as an HTTP status their panel can explain, not as an error bubble the
 * whole room watches the model appear to produce.
 */
import { Router } from 'express'
import { getAssistantSettings } from '../admin/settings.js'
import { countRecentQuestions, recordQuestion, windowResetAt } from '../admin/usage.js'
import { aiModel, aiReady, ask, cancel, clearThread } from '../ai/index.js'
import { getParticipant, getSession } from '../db.js'
import { sessionAuth } from './sessions.js'
import { colorForId, type AiAction, type AiAskRequest, type AiAskResponse } from '@shared/protocol'

const ACTIONS: readonly AiAction[] = ['explain', 'fix', 'debug', 'improve', 'hint', 'ask']
const MAX_MESSAGE = 8000
const MAX_ENTRY_ID = 128

const HOUR_MS = 3_600_000

/**
 * 'ask' is what the composer sends with a typed question: it carries no
 * instruction of its own (see actionInstruction in ai/index.ts), so it is "no
 * action" rather than a request for a particular kind of answer.
 */
const FREE_FORM: readonly AiAction[] = ['ask']

export function aiRoutes(): Router {
  const router = Router()

  router.get('/api/ai/status', (_req, res) => {
    const settings = getAssistantSettings()
    // A student's panel asks one question — "is there an assistant here?" — and
    // a mode of 'off' or a limit of zero is the same answer as no API key.
    const enabled = aiReady() && settings.defaultMode !== 'off' && settings.questionsPerHour > 0
    res.json({ enabled, model: aiModel(), mode: settings.defaultMode })
  })

  router.post('/api/sessions/:id/ai/ask', (req, res) => {
    const sessionId = req.params.id
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })

    const settings = getAssistantSettings()
    if (settings.defaultMode === 'off') {
      return res.status(403).json({ error: 'The assistant is switched off for this instance.' })
    }
    if (settings.questionsPerHour === 0) {
      return res
        .status(403)
        .json({ error: 'The assistant is switched off for this instance — no questions are allowed.' })
    }
    if (!aiReady()) {
      return res.status(503).json({ error: 'the assistant is not configured on this server' })
    }

    const body = req.body as Partial<AiAskRequest> | undefined
    const raw = typeof body?.message === 'string' ? body.message : ''
    if (raw.length > MAX_MESSAGE) return res.status(400).json({ error: 'message too long' })
    const message = raw.trim()
    const requested = ACTIONS.includes(body?.action as AiAction) ? (body?.action as AiAction) : undefined
    const cellId = typeof body?.cellId === 'string' ? body.cellId : null
    if (!message && !requested) return res.status(400).json({ error: 'nothing to ask' })

    // Hints mode: the allowed action set is exactly {hint}. The quick actions
    // that exist to produce a solution — fix, improve, explain, debug — are
    // refused outright, and a typed question is answered as a nudge instead of
    // being bounced, so the composer still works during an exercise.
    let action = requested
    if (settings.defaultMode === 'hints') {
      if (action && action !== 'hint' && !FREE_FORM.includes(action)) {
        return res.status(403).json({
          error: 'This assistant is in hints mode: it can point you at the problem, but it will not write the answer for you. Ask for a hint instead.',
        })
      }
      action = 'hint'
    }

    const limit = settings.questionsPerHour
    const used = countRecentQuestions(sessionId, auth.participantId, HOUR_MS)
    if (used >= limit) {
      const resetAt = windowResetAt(sessionId, auth.participantId, HOUR_MS, limit)
      const minutes = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000)) : 60
      if (resetAt) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))))
      return res.status(429).json({
        error: `You have used all ${limit} assistant question${limit === 1 ? '' : 's'} for this hour in this seminar. You can ask again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      })
    }

    // Name and colour are resolved server-side: the bubble in everyone's panel
    // must say who really asked, not who the client claims to be.
    const participant = getParticipant(sessionId, auth.participantId)
    const entryId = ask({
      sessionId,
      participantId: auth.participantId,
      participantName: participant?.name ?? 'Someone',
      participantColor: participant?.color ?? colorForId(auth.participantId),
      message,
      action,
      cellId,
    })

    // Counted at acceptance, not at completion: the request has been sent to the
    // provider by then whatever the answer turns out to be, and a limit that
    // only counted successes would let a broken endpoint be retried forever.
    recordQuestion({
      sessionId,
      participantId: auth.participantId,
      action: action ?? 'ask',
    })

    // 202: the question is in the document, the answer is still being written.
    const accepted: AiAskResponse = { entryId }
    res.status(202).json(accepted)
  })

  router.post('/api/sessions/:id/ai/cancel', (req, res) => {
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })

    const entryId = typeof req.body?.entryId === 'string' ? req.body.entryId : ''
    if (!entryId || entryId.length > MAX_ENTRY_ID) {
      return res.status(400).json({ error: 'entryId is required' })
    }
    // Open to anyone present: a runaway answer is on every screen in the room,
    // and stopping it destroys nothing — the text that arrived stays put.
    cancel(req.params.id, entryId)
    res.json({ ok: true })
  })

  router.delete('/api/sessions/:id/ai/thread', (req, res) => {
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    // The thread belongs to the room, so clearing it is the host's call — a
    // student must not be able to wipe what the class asked.
    if (auth.role !== 'host') {
      return res.status(403).json({ error: 'only the host can clear the shared thread' })
    }
    clearThread(req.params.id)
    res.json({ ok: true })
  })

  return router
}
