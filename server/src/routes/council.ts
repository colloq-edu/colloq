import { tr } from '@shared/i18n'
/**
 * The council's REST doors: asking the Oracle about the solutions, and an
 * attempt's own files (the last below).
 *
 * Everything else in the council goes over the control socket (control.ts ·
 * council:*): attempts, showing, answers, marks. The Oracle is here because
 * it goes to the same model and spends the same room question limit as
 * `/api/sessions/:id/ai/ask` (routes/ai.ts · countRoomQuestions/recordQuestion),
 * and its right is the same: teacher only (`sessionAuth`, the role from the
 * staff cookie, not from the token).
 *
 *   POST   /api/sessions/:id/council/:cellId/oracle  — "Ask"/"Refresh":
 *          one question from the limit; the answer goes out over the socket
 *          (`council:oracle`), here a 202 with the current `CouncilOracle`
 *          (state: 'reading') or a refusal in words: 403 disabled / 503 no key
 *          / 429 limit / 409 already reading
 *   DELETE /api/sessions/:id/council/:cellId/oracle  — "Stop"
 *   GET    /api/sessions/:id/council/:cellId/files[/ticket]  — a pool
 *          attempt's own files, kept here from its machine: its author's and
 *          the teachers' (remote-classes.md §9.7)
 *
 * POST has one kind: a question about the class. The body
 * `{ question?: string }` is the teacher's own words, and an empty body means
 * the stock question set by the SERVER (`server.council.statusQuestion`): it
 * goes to the model in the prompt and must be the same for any client,
 * including one opened half a year from now.
 *
 * One can ALWAYS ask. A 400 "nobody has written anything in this cell yet"
 * used to be here and was removed: on an empty cell the frame still carries
 * the text of the shared cell and the markdown above it, and "what is this
 * task anyway and how should we go about it" is a legitimate question exactly
 * in the minutes when nobody has written anything yet.
 *
 * The model sees the task, the whole class (drafts, runs, marks, silence) and
 * the solutions by name. The names are real if the instance allows it
 * (`OracleSettings.sendNames`, yes by default); when it is off, labels go
 * instead, and the "label → person" mapping stays on the server
 * (`CouncilOracleAnswer.people`). Frame assembly and state are in
 * ai/council.ts; here there is only the right, the limit and the cell.
 *
 * Storage is council.ts, but through `deps`, not directly: tests replace it
 * with an in-memory list, and the route is checked without the attempts
 * table, which belongs to another module and changes separately from this
 * one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { json, Router, type Request, type Response } from 'express'
import { cellSource, findCell } from '@shared/notebook'
import { mayLeadCouncil, oracleLimitsIn, oracleModeIn } from '@shared/rules'
import { MAX_ORACLE_QUESTION, SESSION_MISSING, type CouncilOracle, type CouncilRun } from '@shared/protocol'
import { effortRank, isReasoningEffort, type ReasoningEffort } from '@shared/admin'
import { getOracleSettings } from '../admin/settings.js'
import { countRoomQuestions, recordQuestion } from '../admin/usage.js'
import {
  askCouncilOracle,
  idleOracle,
  isOracleReading,
  stopCouncilOracle,
  type OracleAttempt,
  type OracleStore,
} from '../ai/council.js'
import { aiReady } from '../ai/index.js'
import { visitSessionDoc } from './doc-visit.js'
import { attemptOf, attemptsOf, oracleOf, setOracle } from '../council.js'
import { signDownloadToken, verifyDownloadToken } from '../auth.js'
import { artifactPath } from '../kernel/remote/epochs.js'
import { getParticipant, getRules, getSession } from '../db.js'
/*
 * The room ceiling is the very same one, not an equal number.
 *
 * There used to be a separate `ROOM_MULTIPLIER = 30` here with the comment
 * "the same number as in routes/ai.ts", and that admission was the only thing
 * tying them together: editing one silently split the limits, even though the
 * summary Oracle and the question Oracle spend one key and are counted in one
 * table. Now there is one function for both, and it also knows that the
 * ceiling is computed from the room's size.
 */
import { roomQuestionCeiling } from './ai.js'
import { banDoor, sessionAuth } from './sessions.js'

const HOUR_MS = 3_600_000

/** Where the route gets attempts and where it puts the Oracle. council.ts by default. */
export interface CouncilOracleDeps extends OracleStore {
  attemptsOf(sessionId: string, cellId: string): OracleAttempt[]
  /** An author's run of a cell, for its files' door; council.ts's stored attempt when absent. */
  runOf?(sessionId: string, cellId: string, participantId: string): CouncilRun | null
}

/**
 * The name for an attempt, here rather than in council.ts.
 *
 * The teacher's stack collects names anyway (`toAttempt`), but what goes to
 * the Oracle is not the stack but bare rows: looking up the participant makes
 * sense exactly for the attempts going into the frame now, and exactly when
 * the instance allowed sending names. The participant row may not exist at
 * all (the person left, was removed), and then the frame calls them by a
 * label (ai/council.ts · namesFor).
 */
function named(sessionId: string, cellId: string): OracleAttempt[] {
  return attemptsOf(sessionId, cellId).map((attempt) => {
    let name: string | null = null
    try {
      name = getParticipant(sessionId, attempt.participantId)?.name ?? null
    } catch {
      /* no participant row: the frame will do with a label */
    }
    return { ...attempt, name }
  })
}

const live: CouncilOracleDeps = { attemptsOf: named, oracleOf, setOracle }

export function councilRoutes(deps: CouncilOracleDeps = live): Router {
  const router = Router()

  // The same door as the room's other routes (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  /**
   * Who, and about which cell. Three refusals shared by both routes: not
   * joined, no room, not a teacher. The refusal's words are the same as the
   * console's flag (web/src/lib/may.ts · councilWhy), so that the button and
   * the server say the same thing.
   */
  const lead = (
    req: Request,
    res: Response,
  ): { sessionId: string; cellId: string; participantId: string } | null => {
    const sessionId = req.params.id
    const auth = sessionAuth(req)
    if (!auth) {
      res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
      return null
    }
    if (!getSession(sessionId)) {
      res.status(404).json({ error: SESSION_MISSING })
      return null
    }
    if (!mayLeadCouncil(auth.role)) {
      res.status(403).json({ error: tr("server.onlyTheTeacherMayLeadCouncil.9554ff") })
      return null
    }
    return { sessionId, cellId: req.params.cellId, participantId: auth.participantId }
  }

  /*
   * Body parsing of our own, not only the common one from app.ts.
   *
   * The common `express.json` sits on the app and does reach this route; but
   * the router is also assembled in tests, where there is no app at all, and
   * a question about the class would silently turn into a summary there, that
   * is, the wrong path would be tested. Parsing twice costs nothing:
   * body-parser skips a body that has already been read (`req._body`).
   */
  router.post('/api/sessions/:id/council/:cellId/oracle', json({ limit: '8kb' }), (req, res) => {
    const who = lead(req, res)
    if (!who) return
    const { sessionId, cellId } = who

    /*
     * Disabled, no key, no questions: the same three doors as /ai/ask, in the
     * same order; the words are in Russian because the teacher reads them on
     * the console, not a student in the panel. Hints mode is let through
     * here: the summary is for the presenter, and it writes no solutions for
     * the students.
     */
    const settings = getOracleSettings()
    const mode = oracleModeIn(getRules(sessionId), settings.defaultMode)
    if (mode === 'off') {
      return res.status(403).json({
        error:
          settings.defaultMode === 'off'
            ? tr("server.theOracleIsDisabledOnThisColloq.e47e9a")
            : tr("server.theOracleIsDisabledForThisSeminar.48f5c6"),
      })
    }
    if (settings.questionsPerHour === 0) {
      return res
        .status(403)
        .json({ error: tr("server.theOracleIsDisabledOnThisColloq.395e3a") })
    }
    if (!aiReady()) {
      return res.status(503).json({
        error: tr("server.noModelIsConfiguredOnThisColloq.c1d63b"),
      })
    }

    /*
     * The cell comes from the room's document, not from the request body: the
     * task for the model is the text of the shared cell as everyone has it
     * right now, with the cell above it as the problem statement.
     *
     * Through `visitSessionDoc`: in a running council the document is up
     * anyway, and then this is just a read; but "Refresh" in a room everyone
     * has left brings its notebook up, and without the visit it would sit in
     * memory until the idle sweep (routes/doc-visit.ts). Strings are taken
     * from the document, not references to `Y.Text`: beyond the visit the
     * document may no longer exist.
     */
    const task = visitSessionDoc(sessionId, (doc) => {
      const found = findCell(doc, cellId)
      if (!found) return null
      const before = found.index > 0 ? found.cells.get(found.index - 1) : null
      return {
        source: cellSource(found.cell).toString(),
        before: before ? cellSource(before).toString() : null,
        // The notebook has no reference solution yet: when the cell gets such a field, it goes here.
        reference: null,
      }
    })
    if (!task) return res.status(404).json({ error: tr("server.thisCellIsNotInTheRoom.b481d9") })

    if (isOracleReading(sessionId, cellId)) {
      return res.status(409).json({
        error: tr("server.aSummaryIsAlreadyBeingPreparedWait.80427e"),
        oracle: deps.oracleOf(sessionId, cellId) ?? idleOracle(),
      })
    }

    /*
     * The room ceiling applies to the teacher too.
     *
     * At /ai/ask the ceilings do not hold the presenter back: their questions
     * are the review, and it would be the class that drove them into the room
     * limit. Here it is different: the summary is the most expensive question
     * in the room, it carries all the solutions to the model at once, and
     * "Refresh" on every submission is exactly the spending the ceiling
     * protects the instance from. The personal limit and slow mode do not
     * apply to the presenter here either.
     */
    const limit = oracleLimitsIn(getRules(sessionId), settings).questionsPerHour
    const roomLimit = roomQuestionCeiling(sessionId, limit)
    const roomUsed = countRoomQuestions(sessionId, HOUR_MS)
    if (roomUsed >= roomLimit) {
      res.setHeader('Retry-After', '600')
      return res.status(429).json({
        error: tr("server.thisSeminarHasReachedItsHourlyLimit.7638ce", { p0: roomLimit }),
      })
    }

    /*
     * The question. An empty string means "no question", not "a question made
     * of spaces": the console's input field sends whatever is in it, and an
     * Enter on a space must not go to the model.
     *
     * Not a single sheet in the cell is a legitimate case too, and it used to
     * be the only 400. One wants to ask "what is this task and how should we
     * go about it" exactly when nobody has written anything yet; at that
     * moment the frame carries the shared cell's text and the markdown above
     * it, and that is enough.
     */
    const body = (req.body ?? {}) as { question?: unknown; effort?: unknown }
    const asked =
      typeof body.question === 'string' ? body.question.trim().slice(0, MAX_ORACLE_QUESTION) : ''
    const question = asked !== '' ? asked : tr('server.council.statusQuestion')

    /*
     * The reasoning level: anyone may lower it, only a teacher may raise it
     * above the instance's. Only a teacher gets here (`mayLeadCouncil` above),
     * so only the value itself is checked here; the rights are sorted out by
     * the /ai/ask door, which the whole room uses.
     */
    const effort: ReasoningEffort | undefined = isReasoningEffort(body.effort)
      ? body.effort
      : undefined

    const attempts = deps.attemptsOf(sessionId, cellId)

    /*
     * The usage row is written on acceptance, as at /ai/ask: the request to
     * the provider will go out however it ends. It has its own action in the
     * accounting: the council Oracle must not hide among "asked" in the
     * panel's breakdown. If the request comes to nothing, the row is removed
     * (ai/council.ts · wasted).
     */
    const usageId = recordQuestion({
      sessionId,
      participantId: who.participantId,
      action: 'council',
    })

    const oracle = askCouncilOracle({
      sessionId,
      cellId,
      task,
      attempts,
      store: deps,
      usageId,
      question,
      effort,
    })
    // 202: the question went out, the answer arrives over the socket (`council:oracle`), as at /ai/ask.
    res.status(202).json(oracle satisfies CouncilOracle)
  })

  router.delete('/api/sessions/:id/council/:cellId/oracle', (req, res) => {
    const who = lead(req, res)
    if (!who) return
    /*
     * "Stop" must ALWAYS work, and "nothing to stop" is not an error.
     *
     * The button and a late answer meet all the time, and there is no reason
     * to paint that red. But there is a worse case: a cell stuck in `reading`
     * without a live read. Then "Stop" used to do nothing, and the next
     * question got a 409 "already being prepared" until the server restarted.
     * So the store goes inside: if there was nothing to cut off but the state
     * still says "reading", put it in order and answer with success.
     */
    stopCouncilOracle(who.sessionId, who.cellId, deps)
    res.json({ ok: true })
  })

  /*
   * AN ATTEMPT'S OWN FILES (remote-classes.md §9.7, D10): what a pool's
   * attempt wrote into its folder on the machine, brought here and named on
   * its card. They are the attempt's, not the class folder's: its author and
   * the teachers take them, nobody else — not the class from the screen.
   *
   *   GET /api/sessions/:id/council/:cellId/files/ticket?participant=&name=
   *       — a ticket for the anchor, asked with the header (as for the class
   *         folder's files: routes/files.ts · file/ticket)
   *   GET /api/sessions/:id/council/:cellId/files?participant=&name=&token=
   *       — the file, by the header or the ticket
   *
   * The file is found by its card: the run's own name and the file's sha256
   * there, for one the card says is here (`kept: true`); anything else is a
   * 404, a file on its way included.
   */
  const keptFile = (req: Request, res: Response, ticket: boolean): { sessionId: string; path: string; name: string } | null => {
    const sessionId = req.params.id
    const cellId = req.params.cellId
    if (!getSession(sessionId)) {
      res.status(404).json({ error: SESSION_MISSING })
      return null
    }
    const participant = typeof req.query.participant === 'string' ? req.query.participant : ''
    const name = typeof req.query.name === 'string' ? req.query.name : ''
    const auth = sessionAuth(req)
    const subject = attemptFileSubject(cellId, participant, name)
    const token = typeof req.query.token === 'string' ? req.query.token : ''
    const allowed = auth !== null
      ? auth.participantId === participant || mayLeadCouncil(auth.role)
      : ticket && verifyDownloadToken(sessionId, subject, token)
    if (!allowed) {
      res.status(auth ? 403 : 401).json({ error: auth ? tr('server.onlyTheAttemptSAuthorAndThe.94ba37') : tr("server.joinTheSessionFirst.442dd6") })
      return null
    }
    const run = deps.runOf?.(sessionId, cellId, participant) ?? attemptOf(sessionId, cellId, participant)?.run ?? null
    const file = run?.files?.find((one) => one.name === name && one.kept === true && typeof one.sha256 === 'string')
    let at: string | null = null
    try {
      at = file && run?.runId ? artifactPath(sessionId, run.runId, file.sha256!) : null
    } catch {
      at = null
    }
    if (!at || !fs.existsSync(at)) {
      res.status(404).json({ error: tr("server.fileNotFound.3e2256") })
      return null
    }
    return { sessionId, path: at, name }
  }

  router.get('/api/sessions/:id/council/:cellId/files/ticket', (req, res) => {
    // Asked with the header alone: a ticket never buys another.
    const found = keptFile(req, res, false)
    if (!found) return
    const participant = String(req.query.participant)
    res.json({ token: signDownloadToken(found.sessionId, attemptFileSubject(req.params.cellId, participant, found.name)) })
  })

  router.get('/api/sessions/:id/council/:cellId/files', (req, res) => {
    const found = keptFile(req, res, true)
    if (!found) return
    // By its own name, the folders of it aside: «out.csv» of «results/out.csv».
    const base = path.posix.basename(found.name)
    res.type(base)
    res.download(found.path, base, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: tr("server.fileNotFound.3e2256") })
    })
  })

  return router
}

/** What a ticket for one attempt's file names: the cell, the author and the file, never the class folder's path. */
function attemptFileSubject(cellId: string, participantId: string, name: string): string {
  return `council-file\u0000${cellId}\u0000${participantId}\u0000${name}`
}
