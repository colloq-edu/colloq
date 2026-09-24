import { tr } from '@shared/i18n'
/**
 * One door to the model — the one that counts questions and says "no" in words.
 *
 * The oracle's rules are written once (`/ai/ask`, routes/ai.ts) and until now
 * lived only there: off on the instance, off in the room, no key, the room
 * ceiling, the personal ceiling, the newcomer waits, slow mode. The second way
 * in to the same model — a hint to a student in the council (control.ts ·
 * council:hint) — goes not over HTTP but over the socket, and without a shared
 * door it would have grown a second copy of the seven checks. A copy that
 * would one day drift from the first: the limit could then be bypassed through
 * the door where someone forgot to update the rule.
 *
 * Exactly two things from `/ai/ask` are missing here, and neither is a loss.
 * The per-address limit lives on HTTP (bans.ts · addressOf reads the request
 * headers); a socket has an address too, but letting it in here would mean
 * dragging `Request` into a module that knows nothing about the network. And
 * the hints mode: it is about WHAT the model answers, not about whether to let
 * someone ask — the callers handle it.
 *
 * The room ceiling lived in routes/ai.ts and moved here with the rest: three
 * callers use it already (a question, the council summary, a hint), and its
 * place is in the shared module, not in one of the three.
 */
import { actsAfterClass, CLASS_IS_OVER, oracleLimitsIn, oracleModeIn } from '@shared/rules'
import { getOracleSettings } from '../admin/settings.js'
import {
  countRecentQuestions,
  countRoomQuestions,
  windowResetAt,
} from '../admin/usage.js'
import { onlineParticipantIds } from '../collab/index.js'
import { getRules, isFinished } from '../db.js'
import { aiReady, streamsInRoom } from './index.js'
import { turnsInRoom } from './agent.js'
import { seconds } from './text.js'

const HOUR_MS = 3_600_000

/**
 * How many personal limits a room may spend per hour, at the very least.
 *
 * Thirty was written as "a full lecture hall" and clung to that number for dear
 * life: with an instance limit of 20 questions the room got 600 for everyone —
 * a little over one per person in a hall of 500. Now it is a FLOOR: a small
 * room gets exactly as much as it used to, a big one counts from its own size.
 */
const ROOM_MULTIPLIER = 30

/**
 * How many questions a room may spend per hour.
 *
 * Counted from the number of people who are in the room right now — half of
 * the personal limit per person. Half, not a whole, because this ceiling holds
 * back not the class but tabs: the personal limit is bypassed by rejoining (a
 * name in the room is not confirmed by anything — that is the whole point of
 * "one link, and that's it"), and someone opening tabs in a loop gets a new
 * limit for each one. They also have to keep presence open, but they can gain
 * only twofold, not without bound.
 *
 * Presence, not the participants table: that one remembers everyone who ever
 * entered this seminar across all its classes, and by it a room of three
 * people would look like a hundred and fifty.
 */
export function roomQuestionCeiling(sessionId: string, limit: number): number {
  const people = onlineParticipantIds(sessionId).length
  return limit * Math.max(ROOM_MULTIPLIER, Math.ceil(people / 2))
}

/**
 * A newcomer waits two minutes.
 *
 * 13 Sep 2026: five hundred "participants" from one address in two hours, one
 * question each. The personal counter is bypassed by a new participant, but
 * the token's age is not: a student joins at the bell and asks later, a script
 * joins and asks in the same second.
 */
export const NEWCOMER_MS = 120_000

/** Who is asking — exactly what the door needs to know about a person. */
export interface Asker {
  role: 'host' | 'participant'
  participantId: string
  /** When the participant token was issued: "the newcomer waits" counts from it. */
  iat?: number
}

/** Is the door open. `null` means open; a string is a refusal in the words to show. */
export interface DoorRefusal {
  error: string
  /** In how many seconds to try again — if this is a wait, not a ban. */
  retryAfter?: number
}

const hintsInRoom = new Map<string, number>()

/** Private hints, public answers and agent turns share the same room capacity. */
export function oracleCapacity(sessionId: string, role: Asker['role']): DoorRefusal | null {
  if (role === 'host') return null
  const busy = streamsInRoom(sessionId) + turnsInRoom(sessionId) + (hintsInRoom.get(sessionId) ?? 0)
  if (busy < 12) return null
  return {
    error: tr('server.thereAreAlreadyOracleRequestsRunningIn.5ae3f8', { p0: busy, p1: seconds(5) }),
    retryAfter: 5,
  }
}

/** Reserve until the provider settles, including failures and empty replies. */
export function holdOracleHint(sessionId: string): () => void {
  hintsInRoom.set(sessionId, (hintsInRoom.get(sessionId) ?? 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    const left = (hintsInRoom.get(sessionId) ?? 1) - 1
    if (left > 0) hintsInRoom.set(sessionId, left)
    else hintsInRoom.delete(sessionId)
  }
}

/**
 * Whether to let this question through to the model.
 *
 * The order of refusals is the same as in `/ai/ask`, and it is not random:
 * first what waiting will not change (the class is over, it is off, no key),
 * then the ceilings, and only then the gap. Someone who has run out of
 * questions for the hour should hear about the hour, not about ten seconds
 * after which they will be turned away anyway.
 *
 * Ceilings and the gap do not apply to the teacher: they run the class, and
 * their questions come in a row because the walkthrough goes in a row.
 */
export function oracleDoor(sessionId: string, who: Asker): DoorRefusal | null {
  const settings = getOracleSettings()
  if (!actsAfterClass(isFinished(sessionId), who.role)) {
    return { error: tr(CLASS_IS_OVER) }
  }
  const mode = oracleModeIn(getRules(sessionId), settings.defaultMode)
  if (mode === 'off') {
    return {
      error:
        settings.defaultMode === 'off'
          ? tr('server.theOracleIsDisabledOnThisColloq.e47e9a')
          : tr('server.theOracleIsDisabledForThisSeminar.48f5c6'),
    }
  }
  if (settings.questionsPerHour === 0) {
    return { error: tr('server.theOracleIsDisabledOnThisColloq.395e3a') }
  }
  if (!aiReady()) {
    return { error: tr('server.noModelIsConfiguredForThisColloq.112833') }
  }
  if (who.role === 'host') return null

  const limits = oracleLimitsIn(getRules(sessionId), settings)
  const limit = limits.questionsPerHour

  const roomLimit = roomQuestionCeiling(sessionId, limit)
  if (countRoomQuestions(sessionId, HOUR_MS) >= roomLimit) {
    return {
      error: tr('server.thisSeminarHasUsedAllOracleQuestions.5ff314', { p0: roomLimit }),
      retryAfter: 600,
    }
  }

  if (countRecentQuestions(sessionId, who.participantId, HOUR_MS) >= limit) {
    const resetAt = windowResetAt(sessionId, who.participantId, HOUR_MS, limit)
    const minutes = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000)) : 60
    // "all 1 oracle question" is not a phrase. A teacher sets a limit of one
    // deliberately more often than any other, and it has its own line.
    const spent =
      limit === 1
        ? tr('server.youHaveUsedYourOneOracleQuestion.61ab29')
        : tr('server.youHaveUsedAllOfYourOracle.7a4f7f', { count: limit })
    return {
      error: tr('server.askAgain', { spent, count: minutes }),
      retryAfter: resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : 3600,
    }
  }

  const age = typeof who.iat === 'number' ? Date.now() - who.iat : Infinity
  if (age < NEWCOMER_MS) {
    const left = Math.ceil((NEWCOMER_MS - age) / 1000)
    return {
      error: tr('server.theOracleAnswersThoseWhoHaveBeen.91d4c0', { p0: seconds(left) }),
      retryAfter: left,
    }
  }

  const gap = limits.slowModeSeconds
  if (gap > 0) {
    const freeAt = windowResetAt(sessionId, who.participantId, gap * 1000, 1)
    const left = freeAt === null ? 0 : Math.ceil((freeAt - Date.now()) / 1000)
    if (left > 0) {
      return {
        error: tr('server.waitBetweenQuestionsTryAgainIn.f64333', {
          p0: seconds(gap),
          p1: seconds(left),
        }),
        retryAfter: left,
      }
    }
  }
  return null
}
