import { tr, formatNumber } from '@shared/i18n'
import { appendActivity } from '../activity.js'
/**
 * The oracle's REST surface.
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
import { getOracleSettings } from '../admin/settings.js'
import {
  countRecentQuestions,
  countRoomQuestions,
  recordQuestion,
  windowResetAt,
} from '../admin/usage.js'
import { aiModel, aiReady, ask, cancel, clearThread } from '../ai/index.js'
import { stopAll, stopWork, turnsInRoom, work } from '../ai/agent.js'
import { seconds } from '../ai/text.js'
import { addressOf } from '../bans.js'
import {
  applyOnBehalf,
  getSessionDoc,
  onlineParticipantIds,
  peekSessionDoc,
} from '../collab/index.js'
import { mark } from '../collab/history.js'
import { cellLock, findCell, findChatEntry, getChat, rootOfCell, type CellLock } from '@shared/notebook'
import {
  actsAfterClass,
  allows,
  allowsAgent,
  CLASS_IS_OVER,
  mayEditCell,
  mayLeadCouncil,
  oracleLimitsIn,
  oracleModeIn,
  rulesForBook,
} from '@shared/rules'
import { getParticipant, getRules, getSession, isFinished } from '../db.js'
import { banDoor, sessionAuth } from './sessions.js'
import {
  actionAllowedIn,
  colorForId,
  SESSION_MISSING,
  type AiAction,
  type AiAskRequest,
  type AiAskResponse,
} from '@shared/protocol'
import { effortRank, isReasoningEffort } from '@shared/admin'

/*
 * Written out rather than derived from the type, so adding an action is a
 * deliberate act on both sides. It is also the list that silently swallowed
 * 'edit' the first time: the request carried it, this filter dropped it to
 * undefined, and the turn arrived as a plain question whose answer nobody could
 * apply — no error anywhere, just a feature that did nothing.
 */
const ACTIONS: readonly AiAction[] = ['explain', 'fix', 'debug', 'improve', 'hint', 'ask', 'edit']
/*
 * A question, not a document. Eight thousand characters is several screens of
 * typing — past that somebody is pasting a file in, and the notebook itself is
 * already travelling with the question.
 */
const MAX_MESSAGE = 8000
/**
 * The length of an entry name, a cell name and everything that arrives as an
 * id.
 *
 * A hundred and twenty-eight characters is four times the longest this
 * product issues (`c_` plus eight hex digits). The cap is not for looks:
 * `cellId` and twenty `cellIds` went into the room's shared document as is,
 * and a request body is up to a megabyte, so one question could carry a
 * megabyte of garbage into the CRDT, with a write to disk, a broadcast to all
 * five hundred sockets and eternal life in history snapshots. Anything too
 * long is not truncated but rejected: a cell name is a key, and a truncated
 * key is no longer the one asked for.
 */
const MAX_ENTRY_ID = 128

const HOUR_MS = 3_600_000

/*
 * The room ceiling moved to the shared door to the model (ai/door.ts): three
 * callers use it now (the question, the council summary and the student
 * hint), and its place is there rather than in one of the three. The name
 * stays here as a re-export: routes/council.ts and the tests refer to it, and
 * there is no reason to rename them for the sake of the move.
 */
export { roomQuestionCeiling } from '../ai/door.js'
import { oracleCapacity, roomQuestionCeiling } from '../ai/door.js'

/**
 * How many answers the Oracle writes in one room at once.
 *
 * The hourly ceilings count spending, while this one counts the event loop.
 * Every answer in progress is appended to the shared document several times a
 * second, and every such edit goes out to all the room's sockets; an agent
 * turn also holds a request to the provider and edits files. Without a bound
 * the teacher's words "ask the Oracle" were enough for two hundred people to
 * start two hundred streams at once, and that is hundreds of thousands of
 * frames a second on five hundred sockets, missed pings and a room that fell
 * apart.
 *
 * Twelve means "asked and waiting" for a dozen people at the same time; with
 * answers of about ten seconds the room digests more than a question a
 * second, that is, the queue drains faster than the class can build it. A
 * refusal is not an error but a wait: the panel shows it as a countdown, like
 * slow mode.
 */

/**
 * The mode this seminar actually runs in.
 *
 * `inherit` is what every room is until somebody says otherwise. A room may
 * tighten — full down to hints, hints down to off — and may not loosen: an
 * instance that is off cannot be talked back on by a seminar's own settings,
 * because that decision belongs to whoever pays for the model rather than to
 * whoever booked the room. The one rule, shared with the panel.
 */
function oracleModeFor(
  sessionId: string,
  instance: 'off' | 'hints' | 'full',
): 'off' | 'hints' | 'full' {
  return oracleModeIn(getRules(sessionId), instance)
}

/**
 * Whether this thread entry is one's own, the one they asked themselves.
 *
 * `peekSessionDoc`, not `getSessionDoc`: we ask for the sake of a refusal,
 * and a refusal is no reason to bring the room up again (the same reason is
 * written above `peekSessionDoc` itself). An unknown entry counts as someone
 * else's: there is nothing to stop in it, and better that a refusal says so
 * than silence.
 */
/**
 * The position of a cell's lock: open, locked, council.
 *
 * With the same `peekSessionDoc` and for the same reason: we ask for the sake
 * of a refusal, and a refusal is no reason to bring up the notebook of a room
 * that has gone cold. No document, or no such cell in it, counts as locked:
 * rights are not handed out on a guess.
 */
function cellLockIn(sessionId: string, cellId: string | null): CellLock {
  if (!cellId) return 'closed'
  const doc = peekSessionDoc(sessionId)?.doc
  const found = doc ? findCell(doc, cellId) : null
  return found ? cellLock(found.cell) : 'closed'
}

/**
 * The root of the notebook this cell lives in, for its own access.
 *
 * `null` means the cell is not in the room; then the room's rules apply, as
 * before.
 */
function bookRootOf(sessionId: string, cellId: string | null): string | null {
  if (!cellId) return null
  const doc = peekSessionDoc(sessionId)?.doc
  return doc ? rootOfCell(doc, cellId) : null
}

function askedBy(sessionId: string, entryId: string, participantId: string): boolean {
  const doc = peekSessionDoc(sessionId)?.doc
  const entry = doc ? findChatEntry(doc, entryId) : null
  return entry ? (entry.get('participantId') as string) === participantId : false
}

/**
 * Remove one person's questions from the feed, and stop what is being written
 * for them.
 *
 * It lives here, next to the feed's two other erasers: the thread is erased
 * in this file, and a third way of erasing it somewhere else would drift
 * apart from them on the first edit. The ban calls it (routes/bans.ts): spam
 * in the shared feed is usually exactly what people get banned for, and
 * leaving it hanging in front of the whole room would punish everyone except
 * its author.
 *
 * The history mark comes BEFORE the deletion, and not for tidiness. The feed
 * lives in the room's document, and what is erased from the document comes
 * back only through a version: a named moment is the only thing the teacher
 * can use to bring back what was purged if they banned the wrong person. The
 * name in the mark is the banned person's, the author is whoever banned.
 *
 * An answer in progress is cut off by the same pair as the "Stop" button
 * below: an agent turn has its own way, a stream has its own. Otherwise the
 * model keeps writing the answer for another minute into an entry that is no
 * longer in the feed.
 *
 * Returns how many entries were removed.
 */
export function purgeQuestions(
  sessionId: string,
  banned: { participantId: string; name: string },
  byTeacher: string,
): number {
  return purgeQuestionsOf(
    sessionId,
    new Set([banned.participantId]),
    byTeacher,
    tr("server.beforeBlocking.d2153d", { p0: banned.name }),
  )
}

/**
 * Remove several participants' entries from the shared thread at once.
 *
 * Added on 13 Sep 2026: a script from one address created five hundred
 * "participants" with one question each, getting around slow mode, which
 * counts per person. Banning them one by one would mean five hundred
 * checkpoints in the version feed and five hundred edits; here it is one
 * checkpoint and one edit for all of them.
 */
export function purgeQuestionsOf(
  sessionId: string,
  participantIds: ReadonlySet<string>,
  byTeacher: string,
  label: string,
): number {
  /*
   * `getSessionDoc`, not `peekSessionDoc`: a purge is an edit, and the edit
   * has to land in the room's document, not beside it. A room nobody has
   * opened since the restart has to be brought up, otherwise what was erased
   * would come back from disk to the first person to join.
   *
   * And not `visitSessionDoc`, which the version feed uses to bring the
   * document up: a notebook visitor lets it go with the same motion
   * (routes/doc-visit.ts), and here there is nothing to let go and no reason
   * to. People are banned in a running room, whose document is up because of
   * those sitting in it, and right after the purge the same request takes two
   * more steps in the same room: the council stacks without the banned person
   * and the closing of their sockets (routes/bans.ts). And one brought up for
   * nothing (a ban right after a restart, before anyone reconnected) will be
   * let go by the idle sweep (collab/index.ts · sweepIdleRooms).
   */
  const { doc } = getSessionDoc(sessionId)
  const chat = getChat(doc)
  const at: number[] = []
  const ids: string[] = []
  for (let i = 0; i < chat.length; i++) {
    const entry = chat.get(i)
    const author: unknown = entry.get('participantId')
    if (typeof author !== 'string' || !participantIds.has(author)) continue
    at.push(i)
    const id: unknown = entry.get('id')
    if (typeof id === 'string') ids.push(id)
  }
  if (at.length === 0) return 0

  mark(sessionId, doc, 'checkpoint', byTeacher, label, label)

  for (const id of ids) if (!stopWork(sessionId, id)) cancel(sessionId, id)

  /*
   * On behalf of the teacher, not "the room": in the version feed this row
   * must carry the name of whoever banned, otherwise next to the named moment
   * "before banning Petya" there is nobody's edit of twelve entries.
   *
   * From the end: the indices were computed before the deletion, and removing
   * the first one would shift all the following ones.
   */
  applyOnBehalf(sessionId, byTeacher, () => {
    for (let i = at.length - 1; i >= 0; i--) chat.delete(at[i], 1)
  })
  return at.length
}

/** How many names can be removed from the thread in one request. */
const MAX_PRUNE_IDS = 2000
/** The participant id length, the same as in routes/bans.ts. */
const MAX_ID = 128
/** A newcomer stays silent: a participant token must be at least this old. */
const NEWCOMER_MS = 2 * 60_000
/**
 * Oracle questions from one address per window, for all names together.
 *
 * More than the dozen concurrent ones in a room (see below, IN_FLIGHT): the
 * room's queue has to refuse first, otherwise a class behind one NAT that hit
 * the queue would read "from your address" instead of "wait five seconds".
 */
const ADDRESS_ASKS = 20
const ADDRESS_WINDOW_MS = 60_000
const asksByAddress = new Map<string, number[]>()

function addressMayAsk(sessionId: string, address: string): boolean {
  const key = `${sessionId} ${address}`
  const now = Date.now()
  const recent = (asksByAddress.get(key) ?? []).filter((at) => now - at < ADDRESS_WINDOW_MS)
  if (recent.length >= ADDRESS_ASKS) {
    asksByAddress.set(key, recent)
    return false
  }
  recent.push(now)
  asksByAddress.set(key, recent)
  // The map does not grow without bound: addresses silent for a window are swept out right here.
  if (asksByAddress.size > 5000) {
    for (const [k, v] of asksByAddress) if (v.every((at) => now - at >= ADDRESS_WINDOW_MS)) asksByAddress.delete(k)
  }
  return true
}

export function aiRoutes(): Router {
  const router = Router()

  // A banned person does not write to the shared thread and does not spend the
  // instance key: purgeQuestions removes what was written, and this closes the
  // door (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  router.get('/api/ai/status', (_req, res) => {
    const settings = getOracleSettings()
    // A student's panel asks one question — "is there an oracle here?" — and
    // a mode of 'off' or a limit of zero is the same answer as no API key.
    const enabled = aiReady() && settings.defaultMode !== 'off' && settings.questionsPerHour > 0
    res.json({
      enabled,
      model: aiModel(),
      mode: settings.defaultMode,
      /*
       * The instance ceilings, so that "as on the instance" in the rules
       * console names a number rather than staying a promise: a line "no lower
       * than the instance's" that does not say which tells the teacher
       * nothing. It is no secret: a student reads the same number in the
       * refusal on hitting it.
       */
      questionsPerHour: settings.questionsPerHour,
      slowModeSeconds: settings.slowModeSeconds,
      agentSteps: settings.agentSteps,
      /*
       * The reasoning level default, for the same reason as the ceilings: the
       * switch by the question field has to know what counts as ordinary
       * here. Without it the panel cannot tell a student which positions are
       * available to them (anyone may lower it, only a teacher may raise it),
       * and it would either lie with a button that does nothing or hide
       * "instant" where it is allowed anyway.
       */
      reasoningEffort: settings.reasoningEffort,
    })
  })

  router.post('/api/sessions/:id/ai/ask', (req, res) => {
    const sessionId = req.params.id
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })

    /*
     * The class is over: only the teacher asks.
     *
     * This cannot be expressed as a rule: `oracle` has no "who" dimension; it
     * is about how detailed the answer is for the whole room, the presenter
     * included. The refusal comes before all the others because the question
     * lands in the shared thread: an "explain this" entry under which an
     * answer never appears reads as a breakage, not as the end of the lesson.
     * "Act" mode is closed by the same check: a participant never gets to it.
     */
    if (!actsAfterClass(isFinished(sessionId), auth.role)) {
      return res.status(403).json({ error: tr(CLASS_IS_OVER) })
    }

    const settings = getOracleSettings()
    /*
     * The room may say something different from the instance, and when it does
     * the room wins — but only downwards. One class is an exercise and the next
     * is a demonstration, and they should not have to share a setting.
     */
    const mode = oracleModeFor(sessionId, settings.defaultMode)
    if (mode === 'off') {
      return res.status(403).json({
        error:
          settings.defaultMode === 'off'
            ? tr("server.theOracleIsSwitchedOffForThis.2c2849")
            : tr("server.theOracleIsSwitchedOffForThis.9dc39a"),
      })
    }
    if (settings.questionsPerHour === 0) {
      return res
        .status(403)
        .json({ error: tr("server.theOracleIsDisabledInThisColloq.e3d7f7") })
    }
    if (!aiReady()) {
      /*
       * Where to fix it is staff information. A student who cannot open the
       * panel is not helped by being sent to it, and an instance that names its
       * own admin surface to everyone who asks is telling strangers where to
       * knock. The panel splits this the same way — see AiPanel.
       */
      return res.status(503).json({
        error:
          auth.role === 'host'
            ? tr("server.noModelIsSetUpOnThis.9957d2")
            : tr("server.noModelIsConfiguredForThisColloq.112833"),
      })
    }

    const body = req.body as Partial<AiAskRequest> | undefined
    const raw = typeof body?.message === 'string' ? body.message : ''
    if (raw.length > MAX_MESSAGE) {
      return res.status(400).json({
        error: tr("server.thatQuestionIsLongerThanCharactersShorten.a8c280", { p0: formatNumber(MAX_MESSAGE) }),
      })
    }
    const message = raw.trim()
    const requested = ACTIONS.includes(body?.action as AiAction)
      ? (body?.action as AiAction)
      : undefined
    /*
     * Cell names have a length cap, and anything too long is dropped whole.
     *
     * Both fields go into the thread entry as is, and the entry goes into the
     * room's shared document: it is persisted, sent to all sockets and stays
     * in history snapshots, from which only the teacher deleting the thread
     * removes it. While there was no cap, one question could carry almost a
     * megabyte there (the request body is express.json), and within the
     * hourly limit, hundreds of megabytes from one participant. See
     * MAX_ENTRY_ID.
     */
    const asked = typeof body?.cellId === 'string' ? body.cellId : ''
    const cellId = asked && asked.length <= MAX_ENTRY_ID ? asked : null
    /*
     * The asker's selection. The cap on the number is not about security but
     * about meaning: "focus on forty cells" means "on nothing", and they would
     * take room in the frame at the expense of the rest of the notebook.
     */
    const cellIds = Array.isArray(body?.cellIds)
      ? body.cellIds
          .filter(
            (id): id is string =>
              typeof id === 'string' && id.length > 0 && id.length <= MAX_ENTRY_ID,
          )
          .slice(0, 20)
      : []
    if (!message && !requested) return res.status(400).json({ error: tr("server.nothingToAsk.d85713") })

    // Hints mode: the allowed action set is exactly {hint}. The quick actions
    // that exist to produce a solution — fix, improve, explain, debug — are
    // refused outright, and a typed question is answered as a nudge instead of
    // being bounced, so the composer still works during an exercise.
    let action = requested
    if (mode === 'hints') {
      if (action && !actionAllowedIn('hints', action)) {
        return res.status(403).json({
          error:
            tr("server.hintsModeIsEnabledAskForA.ec9c2a"),
        })
      }
      action = 'hint'
    }

    /*
     * "Rewrite the cell" is an edit, not an answer, and its rule comes from
     * the CELL.
     *
     * `edit` is the only action that ends with a proposal with an "Apply"
     * button (ai/index.ts · patchBase), that is, an edit of the shared
     * notebook. The others (`explain`, `fix`, `debug`, `improve`, `hint`,
     * `ask`) TALK ABOUT the cell, and in a lecture they are not off limits for
     * a student: asking about a locked cell is allowed and encouraged.
     *
     * The check is here, not only at "Apply": otherwise a participant in a
     * lecture types a sentence, spends a question from the room's hourly
     * limit and gets a proposal they cannot accept themselves, with the
     * question already spent.
     *
     * The council is a separate term: the `edit` rule in an open room lets a
     * participant edit cells, but the shared council cell is the task, and
     * rewriting it for oneself would mean rewriting it for the whole class.
     * They have a sheet of their own, and the sheet has its own Oracle hint.
     */
    if (action === 'edit') {
      const lock = cellLockIn(sessionId, cellId)
      /*
       * And by the rules of THE NOTEBOOK the cell lives in: "rewrite" ends
       * with an edit, and an edit is asked of the notebook
       * (shared/rules.ts · rulesForBook). Otherwise a student in a lecture
       * could not ask to rewrite a cell in their own notebook, the very one
       * they are sitting in.
       */
      const here = rulesForBook(getRules(sessionId), bookRootOf(sessionId, cellId), {
        role: auth.role,
        participantId: auth.participantId,
      })
      const mayHere =
        mayEditCell(here, auth.role, lock === 'open', isFinished(sessionId)) &&
        (lock !== 'council' || mayLeadCouncil(auth.role))
      if (!mayHere) {
        return res.status(403).json({ error: tr('server.ai.cellIsTheTeachers') })
      }
    }

    /*
     * "Act" is not a question, and it has a rule of its own.
     *
     * It is checked here, not in the agent: the refusal has to come before
     * the assignment lands in the thread, otherwise the room sees an entry
     * "do such-and-such" followed by nothing, and that reads as a breakage,
     * not as a rule. Hints mode lets nobody in here: an Oracle that does not
     * write the answer for a student certainly does not write it into a file.
     */
    /*
     * The reasoning level for this question.
     *
     * Any participant may lower it: the answer comes faster and costs less,
     * and there is nobody to ask permission from. Only a teacher may raise it
     * ABOVE the instance default: whoever runs the lesson decides whether the
     * whole class waits and pays for "thorough". A value that is not theirs
     * to set is not a refusal but silence: a student's "think longer" request
     * simply has no effect, and their question goes out at the usual level
     * instead of bouncing with a 403 in the middle of the seminar.
     */
    const wanted = isReasoningEffort(body?.effort) ? body.effort : undefined
    const effort =
      wanted === undefined ||
      (effortRank(wanted) > effortRank(settings.reasoningEffort) && auth.role !== 'host')
        ? undefined
        : wanted

    const doing = body?.mode === 'agent'
    if (doing) {
      if (mode === 'hints') {
        return res.status(403).json({
          error:
            tr("server.fileEditsAreUnavailableInHintsMode.29ff63"),
        })
      }
      if (!allowsAgent(getRules(sessionId).agent, auth.role)) {
        return res.status(403).json({
          error:
            getRules(sessionId).agent === 'off'
              ? tr("server.oracleFileEditingIsDisabledInThis.9b1999")
              : tr("server.onlyTheTeacherMayAskTheOracle.441f53"),
        })
      }
      /*
       * One turn per room, and that applies to the teacher too.
       *
       * The ceiling below (`oracleCapacity`) counts load and lets the
       * presenter pass: their single question among a dozen students' decides
       * nothing. With a turn that is not true, and it is not about load. Two
       * turns in one room race to edit the same notebook and the same files:
       * each has its own "as it was before the turn" snapshot, and undoing the
       * second returns a file to what the first one left, that is, silently
       * erases its work. The mark in the version history is also set twice
       * and points to the wrong place. The presenter is exactly the one who
       * runs into this most often: they are the only one for whom the mode is
       * available in every room, and "pressed again because it is taking a
       * long time" is their usual move.
       *
       * 409, not 429: this is not "wait in the queue" but "not allowed while
       * that one runs". The "Stop" button under the turn is right there, in
       * the same panel.
       */
      if (turnsInRoom(sessionId) > 0) {
        return res.status(409).json({ error: tr('server.agent.busyTurn') })
      }
    }

    /*
     * The ceilings are the instance setting tightened by the room's rules:
     * one function for the server and the console, and it also holds the
     * "the room tightens but does not loosen" line
     * (shared/rules.ts · oracleLimitsIn).
     */
    const limits = oracleLimitsIn(getRules(sessionId), settings)
    const limit = limits.questionsPerHour

    /*
     * The ceilings are about the class, not about the presenter.
     *
     * Both counts below protect the instance from the room: from a person who
     * asked too much and from tabs opened in a loop. The teacher is not the
     * one to protect against: they run the class, and their questions come in
     * a row because the review goes in a row. They must not hit their own
     * ceiling in the middle of a lesson, and even less the room-wide one: it
     * would be the class, not them, that drove them there, and then the one
     * running the lesson would be the one left silent.
     *
     * The role here is the same by which the route already lets the
     * presenter past slow mode below. Their questions are not subtracted from
     * the count: the instance's spending is spending, and the panel shows it
     * as it is.
     */
    if (auth.role !== 'host') {
      /*
       * A ceiling per room, not only per person.
       *
       * The personal limit is bypassed by rejoining: a name in this room is
       * not confirmed by anything (that is the whole point of "one link and
       * that is it"), so a new incognito tab gives a new participant and a
       * fresh N questions. The count had no real boundary at all, while the
       * panel promised protection.
       *
       * Thirty personal limits for the whole room, or half a limit per person
       * if there are more than sixty people: a class of twenty where everyone
       * asked twice their share fits into the first, a cohort of five hundred
       * into the second, and one person opening tabs in a loop fits into
       * neither (roomQuestionCeiling).
       */
      const roomLimit = roomQuestionCeiling(sessionId, limit)
      const roomUsed = countRoomQuestions(sessionId, HOUR_MS)
      if (roomUsed >= roomLimit) {
        res.setHeader('Retry-After', '600')
        /*
         * Where to go is the truth, not politeness.
         *
         * This used to say "ask the teacher, they will raise the limit in the
         * panel". The teacher cannot raise it: the room's rules only tighten
         * the ceiling (shared/rules.ts · oracleLimitsIn), and the knob lives
         * in the instance admin panel, which a teacher usually has no access
         * to. Twenty people went to the teacher, the teacher went to the
         * console and found nothing there. Only a participant reads this (the
         * ceilings do not hold the presenter back), so it has to say exactly
         * what helps them: wait, or ask together.
         */
        return res.status(429).json({
          error: tr("server.thisSeminarHasUsedAllOracleQuestions.5ff314", { p0: roomLimit }),
        })
      }

      const used = countRecentQuestions(sessionId, auth.participantId, HOUR_MS)
      if (used >= limit) {
        const resetAt = windowResetAt(sessionId, auth.participantId, HOUR_MS, limit)
        const minutes = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000)) : 60
        if (resetAt)
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))))
        // "all 1 oracle question" is not a sentence. A cap of one is the one
        // case a teacher is most likely to set deliberately, so it gets its own.
        const spent =
          limit === 1
            ? tr("server.youHaveUsedYourOneOracleQuestion.61ab29")
            : tr("server.youHaveUsedAllOfYourOracle.7a4f7f", { count: limit })
        return res.status(429).json({
          error: tr('server.askAgain', { spent, count: minutes }),
        })
      }
    }

    /*
     * Slow mode: not how many questions, but how often.
     *
     * The hourly ceiling catches spending, not spam: twenty questions can be
     * shouted out in twenty seconds, and what gets punished is not the shout
     * but the next real question, an hour without the Oracle. The gap stands
     * exactly where the spam is, and costs seconds.
     *
     * It comes AFTER the ceilings, not before them: whoever has run out of
     * questions for the hour must hear about the hour, not about ten seconds
     * after which they would be turned away anyway.
     *
     * It does not apply to the teacher. They do not spam, they run the class,
     * and their questions come in a row because the review goes in a row; the
     * role here is the same by which this route already tells the presenter
     * apart above.
     *
     * The same `windowResetAt` as for the hourly ceiling: with a limit of one
     * question, "when the window lets go" means exactly "when the gap after
     * the last one has passed". There is no reason to start a second counter.
     */
    /*
     * Two protections against a script, not against a person (13 Sep 2026, an
     * open class: five hundred "participants" from one address in two hours,
     * one question each).
     *
     * Slow mode and the hourly ceiling are counted per person, and are
     * bypassed exactly that way: a new participant is a new counter. So,
     * first, a newcomer waits: a question to the Oracle is accepted once the
     * participant token is at least two minutes old. A student comes in at
     * the bell and asks later; a script comes in and asks in the same second.
     * Second, the address: however many names there are, the wire is one, and
     * more than ADDRESS_ASKS a minute from one address does not happen even
     * for a class behind one NAT: twelve Oracle questions a minute from one
     * school are no longer questions. Neither applies to the teacher: they
     * review, and review in a row.
     */
    if (auth.role !== 'host') {
      const age = typeof auth.iat === 'number' ? Date.now() - auth.iat : Infinity
      if (age < NEWCOMER_MS) {
        const left = Math.ceil((NEWCOMER_MS - age) / 1000)
        res.setHeader('Retry-After', String(left))
        return res.status(429).json({
          error: tr("server.theOracleAnswersThoseWhoHaveBeen.91d4c0", { p0: seconds(left) }),
          retryAfter: left,
        })
      }
      const address = addressOf(req)
      if (address && !addressMayAsk(sessionId, address)) {
        res.setHeader('Retry-After', '60')
        return res.status(429).json({
          error: tr("server.tooManyQuestionsFromYourAddress.5e2b8d"),
          retryAfter: 60,
        })
      }
    }

    const gap = limits.slowModeSeconds
    if (gap > 0 && auth.role !== 'host') {
      const freeAt = windowResetAt(sessionId, auth.participantId, gap * 1000, 1)
      const left = freeAt === null ? 0 : Math.ceil((freeAt - Date.now()) / 1000)
      if (left > 0) {
        res.setHeader('Retry-After', String(left))
        return res.status(429).json({
          error: tr("server.waitBetweenQuestionsTryAgainIn.f64333", { p0: seconds(gap), p1: seconds(left) }),
          /*
           * A number, not only the header. Retry-After is for the machine,
           * while the panel also decides by this number how to show the
           * refusal: a wait is a calm line with a countdown, not the red error
           * it meets everything else with. It cannot tell one from the other
           * by the text of a 429.
           */
          retryAfter: left,
        })
      }
    }

    /*
     * How many answers are being written in the room right now.
     *
     * It comes last among the refusals and last in meaning: it is not about
     * spending and not about spam, but about the room having one event loop.
     * Both streams and agent turns count: the latter is more expensive but
     * loads the same place.
     *
     * It does not apply to the teacher, like the ceilings above: they run the
     * class, and their single question among a dozen students' decides
     * nothing, while an Oracle gone silent in the middle of a review decides a
     * lot.
     */
    const capacity = oracleCapacity(sessionId, auth.role)
    if (capacity) {
      res.setHeader('Retry-After', String(capacity.retryAfter))
      return res.status(429).json(capacity)
    }

    // Name and colour are resolved server-side: the bubble in everyone's panel
    // must say who really asked, not who the client claims to be.
    const participant = getParticipant(sessionId, auth.participantId)
    /*
     * The usage row is created before the question, not after.
     *
     * Counting on acceptance is an old and correct decision: the request to
     * the provider has already gone out however it ends, and a limit counting
     * only successes would let one hammer a broken endpoint forever. One
     * thing changed: the row now returns its number, and the stream's last
     * frame puts the real spending on it instead of an eternal NULL.
     */
    const usageId = recordQuestion({
      sessionId,
      participantId: auth.participantId,
      /*
       * "Act" mode has its own action in the accounting.
       *
       * Under 'ask' it was indistinguishable from an ordinary question, and it
       * is the most expensive row in the table: one turn goes to the model up
       * to twelve times and drags files along. The breakdown in the panel is
       * the only place where the key's owner sees what the semester went on,
       * and merging "asked" and "acted" there would hide the main spending
       * item from them.
       */
      action: doing ? 'work' : (action ?? 'ask'),
    })

    const entryId = doing
      ? work({
          sessionId,
          participantId: auth.participantId,
          participantName: participant?.name ?? 'Someone',
          participantColor: participant?.color ?? colorForId(auth.participantId),
          // The role is the one the person acts with right now, not the one
          // they joined with: the turn edits the notebook with their hands and
          // by their rights.
          role: auth.role,
          message,
          usageId,
          effort,
        })
      : ask({
          sessionId,
          participantId: auth.participantId,
          participantName: participant?.name ?? 'Someone',
          participantColor: participant?.color ?? colorForId(auth.participantId),
          message,
          action,
          cellId,
          cellIds,
          usageId,
          effort,
        })

    // 202: the question is in the document, the answer is still being written.
    const accepted: AiAskResponse = { entryId }
    res.status(202).json(accepted)
  })

  router.post('/api/sessions/:id/ai/cancel', (req, res) => {
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    /*
     * A 404 before anybody touches the document.
     *
     * `cancel` goes to `docOf`, and that to `getSessionDoc`, which brings the
     * room up: it starts the history with an "opened" row, seeds the starter
     * notebook and writes a snapshot. For a deleted seminar that is a
     * resurrection, by an old token, from a row no longer on the list.
     */
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })

    const entryId = typeof req.body?.entryId === 'string' ? req.body.entryId : ''
    if (!entryId || entryId.length > MAX_ENTRY_ID) {
      return res.status(400).json({ error: tr("server.entryidIsRequired.a5742a") })
    }
    /*
     * One's own entry by its author, someone else's by the teacher. Nobody
     * else.
     *
     * This used to say "anyone may stop: it destroys nothing", and that is
     * untrue exactly for someone else's entry. Cutting off someone else's
     * answer means erasing work the person is waiting for, and cutting off
     * someone else's agent turn means stopping it in the middle of editing
     * files: half the notebook rewritten, half not, a state nobody asked for.
     * One's own entry is different: it is yours, and the text that arrived
     * stays in place, so the author can always stop it.
     *
     * The teacher really needs someone else's: a runaway answer hangs on the
     * projector for the whole room, and someone in the audience asked it. The
     * role is the same one by which this file decides above who gets to fix
     * the Oracle.
     *
     * The bell no longer needs a separate check: `actsAfterClass` allowed
     * exactly the same (the teacher always, a participant until the end of
     * the lesson), and even before the bell a participant now goes only after
     * their own entry.
     */
    if (auth.role !== 'host' && !askedBy(req.params.id, entryId, auth.participantId)) {
      return res.status(403).json({
        error:
          tr("server.youMayStopYourOwnQuestionOnly.9631c6"),
      })
    }
    /*
     * An Oracle turn is not a stream, and it is cut off differently: see
     * agent.stopWork. Both stops are called here, because the entry has one
     * button, but they cannot both be called in a row: `cancel` marks the
     * entry finished at once, while a turn after "Stop" still finishes the
     * step it started; the entry would look done, and new feed rows would
     * appear under it. The turn sets its own state when it has really
     * finished.
     */
    if (!stopWork(req.params.id, entryId)) cancel(req.params.id, entryId)
    appendActivity(req.params.id, auth.participantId, 'oracle.cancel_requested', { entryId }, auth.role)
    res.json({ ok: true })
  })

  router.delete('/api/sessions/:id/ai/thread', (req, res) => {
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    // The same as in cancel: clearThread brings the room up, and there is nothing to bring up.
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })
    // The thread belongs to the room, so clearing it is the host's call — a
    // student must not be able to wipe what the class asked.
    // Erasing what is shared is the same right as wiping the whole board: the
    // question feed belongs to the room, not to whoever asked last.
    if (!allows(getRules(req.params.id).wipe, auth.role)) {
      return res.status(403).json({
        // After the end of class `wipe` tightens by itself (db.getRules), but
        // naming the rule to the person is wrong here: they would go looking
        // for a teacher who changed nothing.
        error: isFinished(req.params.id)
          ? tr(CLASS_IS_OVER)
          : tr("server.onlyTheTeacherCanClearTheShared.684c21"),
      })
    }
    /*
     * Erasing the feed also means "stop".
     *
     * clearThread cuts off the Oracle stream by itself; an agent turn lived on
     * and for another dozen steps edited files and ran scripts, with no line
     * in the thread to explain it and no cancel button, because there was
     * nowhere left to put one. Hence here, next to the same pair used for
     * "Stop".
     */
    /*
     * With names, purge only their entries; without names, the whole thread.
     * The list comes from a teacher who saw a hundred identical
     * "participants" in the feed and wants to remove them without losing the
     * group's questions.
     */
    const listed: unknown = (req.body as { participantIds?: unknown } | undefined)?.participantIds
    if (Array.isArray(listed)) {
      if (listed.length > MAX_PRUNE_IDS) {
        return res.status(400).json({ error: tr("server.tooManyParticipantsToPrune.7a1c2e", { p0: MAX_PRUNE_IDS }) })
      }
      const ids = new Set(
        listed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID),
      )
      const byTeacher = getParticipant(req.params.id, auth.participantId)?.name ?? auth.participantId
      const removed = purgeQuestionsOf(req.params.id, ids, byTeacher, tr("server.beforePruningTheThread.4b0d9f"))
      appendActivity(req.params.id, auth.participantId, 'oracle.thread_pruned', { count: removed }, auth.role)
      return res.json({ ok: true, removed })
    }
    stopAll(req.params.id)
    clearThread(req.params.id)
    appendActivity(req.params.id, auth.participantId, 'oracle.thread_cleared', {}, auth.role)
    res.json({ ok: true })
  })

  return router
}
