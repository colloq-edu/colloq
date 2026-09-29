/**
 * The public doors of competitions: everything open at the `/k` address.
 *
 * There is not a single teacher door here: those live in
 * `/api/admin/competitions` and ask for `requireStaff`. The split is not
 * cosmetic: it is the boundary along which ALL of a competition's rights run.
 * Nothing below serves the metric code, the row split seed, the hidden
 * answers, the private score before the leaderboard opens, someone else's
 * submission or someone else's trace. Each of these "nots" has its own test
 * (tests/competitions-entrants.test.mts), because each breaks silently: the
 * response gets a little wider, the screen looks the same, and the
 * competition can be won without solving the task.
 *
 * WHAT IS HERE. The entrant's identity (sign-in key, sign-in, sign-out), the
 * list of competitions with a summary, the page of one, joining, my
 * submissions, sending a notebook as a file, cancelling one's own submission,
 * choosing the scored one, leaderboards, the live stream and downloads: of
 * the open data files and of one's own notebook.
 *
 * Cancelling does not kill the container itself: it calls the runner's
 * `cancelSubmission(id, 'entrant')`, because knowing what to kill and how is
 * the runner's business, while checking that the submission is YOURS and
 * still running is the business here.
 *
 * WHAT IS DELIBERATELY MISSING. Uploading "from a notebook in a class": the
 * owner removed it from the mockup, and the only way to send a solution is a
 * file.
 */
import busboy from 'busboy'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import { assertCompetitionCapability, competitionCapabilities } from '../competitions/capabilities.js'
import { competitionRevision } from '../dependencies/store.js'
import { readEnvironmentInventory } from '../environment-inventory.js'
import { acceptPinnedSubmission, executionRevision, publicExecution } from '../dependencies/service.js'
import { DependencyStoreError } from '../dependencies/store.js'
import { dependencyMessage, dependencyRefusal } from '../dependencies/messages.js'
import { addressOf } from '../bans.js'
import { config } from '../config.js'
import { db } from '../db.js'
import { downloadHeldFile, type HeldFile } from '../secure-files.js'
import {
  clearEntrantCookie,
  currentEntrant,
  issueEntrantCookie,
  requireEntrant,
  slideEntrantCookie,
  type EntrantRequest,
} from '../competitions/identity.js'
import {
  chooseSubmission,
  createEntrant,
  entrantByKey,
  entrantKeyOf,
  findCompetition,
  getSubmission,
  inFlightCount,
  joinCompetition,
  joinedAt,
  leaderboard,
  leftToday,
  listCompetitions,
  listEntrantSubmissions,
  listFiles,
  acceptSubmission,
  competitionSummary,
  getEntrant,
  intakePlan,
  myCompetitionIds,
  queuePaused,
  submissionCounts,
} from '../competitions/store.js'
import { withoutBaseline } from '../competitions/panel.js'
import { queueForecast } from '../competitions/forecast.js'
import { holdUpload, privateBoardState } from '../competitions/results.js'
import { uploadsPerMinute } from '../competitions/settings.js'
import { cancelSubmission, queueSlots, wakeCompetitionPump } from '../competitions/runner.js'
import {
  ensureCompetition,
  holdExecutedNotebook,
  holdOpenFile,
  holdSubmittedNotebook,
  notebookOnDisk,
  putSubmissionNotebook,
  removeSubmission,
} from '../competitions/storage.js'
import { intakeNotebook } from '../competitions/intake.js'
import {
  entrantSubmission,
  ENTRANT_SIGN_IN_PATH,
  isTerminal,
  LIMITS,
  nameForJoin,
  normalizeEntrantKey,
  placesAmongPeople,
  placesByScore,
  publicCompetition,
  submissionsOpen,
  type Competition,
  type CompetitionRefusal,
  type Entrant,
  type EntrantSubmission,
  type RankedRow,
  type Submission,
} from '@shared/competitions'
import type { CompetitionCounts } from '@shared/competitions-api'
import type {
  EntrantBoardLine,
  EntrantCompetitionList,
  EntrantCompetitionView,
  EntrantLeaderboard,
  EntrantMe,
  EntrantSubmissions,
  SubmissionAccepted,
  SubmissionLive,
} from '@shared/competitions-entrant'

/*
 * Responses are assembled through `reply<T>`, not a bare `res.json({…})`.
 *
 * `res.json` takes `any`: a field renamed in `competitions-entrant.ts` breaks
 * neither the server build nor the browser build; the page simply draws an
 * empty space where a number used to be, and people find out during the
 * lesson. One annotation per door turns such a mismatch into a compile error.
 */
function reply<T>(res: Response, body: T): void {
  res.json(body)
}

function refuse(res: Response, status: number, reason: CompetitionRefusal, error: string): void {
  res.status(status).json({ error, reason })
}

/* --------------------------------------------------------- rate limits */

/**
 * How many times from one address, the same way as for entering a room and
 * for the Oracle (routes/sessions.ts, routes/ai.ts).
 *
 * Counted by address, not by person, and that is the whole point: a script
 * has no person, it creates one. A class behind one NAT comes in all at once,
 * so the windows are long and the numbers leave room for a cohort; a loop
 * hits this in the first seconds.
 */
function tooOften(bucket: Map<string, number[]>, address: string | null, windowMs: number, max: number): boolean {
  if (!address) return false
  const now = Date.now()
  const recent = (bucket.get(address) ?? []).filter((at) => now - at < windowMs)
  if (recent.length >= max) {
    bucket.set(address, recent)
    return true
  }
  recent.push(now)
  bucket.set(address, recent)
  // Otherwise the map grows all semester: a lesson brings more addresses than people.
  if (bucket.size > 5000) {
    for (const [key, hits] of bucket) if (hits.every((at) => now - at >= windowMs)) bucket.delete(key)
  }
  return false
}

const MINUTE = 60_000
/** Key guessing: 31⁹ combinations, so this protects against noise, not brute force. */
const signIns = new Map<string, number[]>()
const SIGN_IN_WINDOW = 10 * MINUTE
const MAX_SIGN_INS = 40
/** Joining creates an ENTRANT ROW, exactly what a script bloats the database with. */
const joins = new Map<string, number[]>()
const JOIN_WINDOW = 10 * MINUTE
const MAX_JOINS = 60
/*
 * Sending: the real limit is the daily quota; these two pay for parsing the
 * notebook. Per PERSON (the owner's setting, twelve a minute by default),
 * because a class behind one NAT is thirty people at one address, and all of
 * them send in the last minute before the deadline. Per address only a
 * ceiling against floods, generous enough for a whole lecture hall.
 */
const uploadsByEntrant = new Map<string, number[]>()
const uploadsByAddress = new Map<string, number[]>()
const UPLOAD_WINDOW = MINUTE
const MAX_UPLOADS_PER_ADDRESS = 300

/* ----------------------------------------------------------------- helpers */

/**
 * The competition as an entrant sees it, or `null`.
 *
 * A draft does not exist on `/k` at all: it has no data and no verified
 * baseline yet, but it already has an address, and opened early it would
 * hand the class a task the teacher is still writing.
 */
function visible(slugOrId: string): Competition | null {
  const competition = findCompetition(slugOrId)
  if (!competition || competition.state === 'draft') return null
  return competition
}

/** The baseline's public number: the "baseline 0.0587" line in the card (P1). */
function baselineScore(competition: Competition): number | null {
  if (!competition.baselineSubmissionId) return null
  return getSubmission(competition.baselineSubmissionId)?.publicScore ?? null
}

/** Who the sample notebook is recorded under: the table sets its row off with a dashed line at the bottom. */
function baselineEntrantOf(competition: Competition): string | null {
  return competition.baselineEntrantId ?? null
}

/**
 * The competition summary WITHOUT the baseline solution, with the same
 * numbers as the panel.
 *
 * The sample notebook is recorded as an ordinary submission of a service
 * entrant; otherwise there would be no point running it the same way. But "2
 * entrants" in a competition with one person, and "leader 0.5023" where the
 * leader is the baseline, are exactly the small things that make people stop
 * trusting the whole screen. The panel removes it through `withoutBaseline`
 * (competitions/panel.ts), and it is the same here: two different answers to
 * one question are worse than one wrong one.
 */
function summaryOf(competition: Competition): CompetitionCounts {
  const baseline = baselineEntrantOf(competition)
  const rows = baseline ? listEntrantSubmissions(competition.id, baseline) : []
  const best = leaderboard(competition.id, 'public').find(
    (row) => row.entrantId !== baseline,
  )?.score ?? null
  return withoutBaseline(competitionSummary(competition.id), rows, best)
}

/**
 * A leaderboard row with a name: a place cannot be shown without a name.
 *
 * The submission number and whether its author chose it come here for the
 * "SCORED SUBMISSION" column (P3): "#12 · entrant's choice" and "#19 · best
 * public score" are different things, and one id cannot tell them apart.
 *
 * `counts` are spent submissions (store · submissionCounts), by the same rule
 * the daily quota refuses by: the class reads the "SUBMISSIONS" column against
 * the limit, and a row that is not in the quota has no business in it.
 *
 * The place is the one the page draws: among people, equal scores sharing
 * it, the baseline where it would rank (`placesAmongPeople`). The place the
 * store gives counts the baseline as a row, and an answer that says "5"
 * where the screen says "4" is a second truth waiting for its first reader.
 */
function withNames(
  rows: readonly RankedRow[],
  counts: Map<string, number>,
  me: Entrant | null,
  baseline: string | null,
): EntrantBoardLine[] {
  return placesAmongPeople(rows, (row) => row.entrantId === baseline).map((row) => {
    const submission = getSubmission(row.submissionId)
    return {
      place: row.place,
      entrantId: row.entrantId,
      name: getEntrant(row.entrantId)?.name ?? '',
      score: row.score,
      submissionId: row.submissionId,
      number: submission?.number ?? 0,
      chosen: submission?.chosen ?? false,
      submissions: counts.get(row.entrantId) ?? 0,
      baseline: baseline !== null && row.entrantId === baseline,
      you: me !== null && row.entrantId === me.id,
    }
  })
}

/* -------------------------------------------------------------- live queue */

/**
 * The queue through one person's eyes: what moves on the screen by itself.
 *
 * The place and the estimate come from the same forecast as the teacher's
 * queue block (competitions/forecast.ts): over the WHOLE instance queue, in
 * the order the runner takes work, aware of how many run at once. "Third in
 * the queue, ≈ 4 min" must mean the same thing on the phone and on the
 * projector, otherwise two screens argue about a number the person checks
 * with a stopwatch.
 */
function liveOf(competition: Competition, me: Entrant, now = Date.now()): SubmissionLive[] {
  const mine = listEntrantSubmissions(competition.id, me.id).filter(
    (submission) => !isTerminal(submission.state),
  )
  if (mine.length === 0) return []
  const forecast = queueForecast(queueSlots(), now)
  const limitMs = competition.limits.wallSeconds * 1000
  return mine.map((submission): SubmissionLive => {
    const spot = forecast.at.get(submission.id) ?? null
    const waiting = [...forecast.eligible, ...forecast.deferred].find((row) => row.submissionId === submission.id)
    /*
     * Whose submission runs right before mine, and only MINE: "starts after
     * submission #12 finishes" says nothing about someone else's number, and
     * the number itself is someone else's row in someone else's list.
     */
    const ahead = spot === null
      ? null
      : [...forecast.running, ...forecast.eligible.slice(0, spot.place - 1)]
          .reverse()
          .find((row) => row.entrantId === me.id) ?? null
    return {
      submissionId: submission.id,
      place: spot?.place ?? null,
      etaMs: spot?.etaMs ?? null,
      resourcePending: (waiting?.resourceRetries ?? 0) > 0,
      startedAt: forecast.running.find((row) => row.submissionId === submission.id)?.startedAt ?? null,
      limitMs,
      aheadNumber: ahead ? (getSubmission(ahead.submissionId)?.number ?? null) : null,
      stage: submission.stage,
      cellsDone: submission.cellsDone,
      cellsTotal: submission.cellsTotal,
    }
  })
}

/*
 * Which notebook each submission's download hands out, remembered per version
 * of its row. The live stream rebuilds "My submissions" every second for every
 * person watching, while the answer changes only when a run ends — and the row
 * changes in the same breath (runner.ts publishes the executed copy before it
 * writes the outcome). Asking the disk once a second per submission per
 * person is the whole class's event loop spent on a link.
 */
const notebookSeen = new Map<string, { version: string; notebook: EntrantSubmission['notebook'] }>()

function notebookOf(competitionId: string, submission: Submission): EntrantSubmission['notebook'] {
  // Only a finished submission offers the link, so a running one costs no look at the disk.
  if (!isTerminal(submission.state)) return undefined
  const version = `${submission.state}:${submission.durationMs}:${submission.cellsDone}:${submission.stage}`
  const seen = notebookSeen.get(submission.id)
  if (seen?.version === version) return seen.notebook
  const notebook = notebookOnDisk(competitionId, submission.id)
  if (notebookSeen.size >= 20_000) notebookSeen.clear()
  notebookSeen.set(submission.id, { version, notebook })
  return notebook
}

/** "My submissions" in one piece; the live stream serves the same piece. */
function submissionsView(competition: Competition, me: Entrant): EntrantSubmissions {
  const now = Date.now()
  const { open } = privateBoardState(competition, now)
  const accepting = submissionsOpen(competition, now)
  return {
    submissions: listEntrantSubmissions(competition.id, me.id).map((s) => ({
      ...entrantSubmission(publicExecution(s, competition.environment), open),
      notebook: notebookOf(competition.id, s),
    })),
    leftToday: leftToday(competition, me.id),
    perDay: competition.limits.perDay,
    inFlight: inFlightCount(competition.id, me.id),
    accepting,
    joined: joinedAt(competition.id, me.id) !== null,
    live: liveOf(competition, me, now),
    paused: queuePaused(),
    replaceable: accepting === 'open' ? replaceableOf(competition, me.id, now) : null,
  }
}

/**
 * The waiting submission a new upload would take the place of — only when
 * the upload would actually be accepted: the send box offers exactly what the
 * door will do.
 */
function replaceableOf(competition: Competition, entrantId: string, now: number): EntrantSubmissions['replaceable'] {
  const plan = intakePlan(competition.id, entrantId)
  if (plan === 'in_flight' || !plan.replaces) return null
  const left = leftToday(competition, entrantId, now, 0, plan.replaces.id)
  if (left !== null && left <= 0) return null
  return { submissionId: plan.replaces.id, number: plan.replaces.number }
}

/**
 * What a person knows about themselves in this competition: the "YOU" block
 * of the P1 card.
 *
 * The place is counted AMONG PEOPLE: the baseline solution sits in the table
 * as an ordinary row (as in the P3 mockup), but the denominator is entrants
 * everywhere, and a place from the combined table would one day give "2 of
 * 1" in a competition where nobody has beaten the baseline yet.
 *
 * And it is a shared place, not a row number: seven people with one score
 * all stand fourth, and the list must not tell the last of them "10th"
 * while the table beside it says "4".
 */
function mineIn(competition: Competition, me: Entrant) {
  const baseline = baselineEntrantOf(competition)
  const board = placesByScore(leaderboard(competition.id, 'public').filter((row) => row.entrantId !== baseline))
  const mine = board.find((row) => row.entrantId === me.id) ?? null
  const mySubmissions = listEntrantSubmissions(competition.id, me.id)
  return {
    joined: joinedAt(competition.id, me.id) !== null || mySubmissions.length > 0,
    place: mine?.place ?? null,
    score: mine?.score ?? null,
    submissions: mySubmissions.length,
    inFlight: inFlightCount(competition.id, me.id),
    leftToday: leftToday(competition, me.id),
  }
}

/** The key and the link go only to their owner, and only in these two fields. */
function keyCard(entrant: Entrant): { key: string | null; link: string | null } {
  const key = entrantKeyOf(entrant.id)
  return { key, link: key ? `${config.publicUrl}${ENTRANT_SIGN_IN_PATH}${key}` : null }
}

function sendHeld(res: Response, hold: () => HeldFile, name: string): void {
  let file: HeldFile
  try {
    file = hold()
  } catch {
    return refuse(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
  }
  downloadHeldFile(res, file, name)
}

/* ------------------------------------------------------------------ doors */

export function competitionRoutes(inventory = readEnvironmentInventory): Router {
  const router = Router()

  /*
   * The cookie is extended by activity on ALL `/k` pages, not only where a
   * right is asked for: a person may read the task and the leaderboard for a
   * week without sending anything, and must not be signed out because of it.
   */
  router.use('/api/k', (req, res, next) => {
    slideEntrantCookie(req, res)
    next()
  })

  /* ------------------------------------------------------------ identity */

  /** Who I am, my key and sign-in link: the "YOUR SIGN-IN KEY" card (P1). */
  router.get('/api/k/me', (req, res) => {
    const entrant = currentEntrant(req)
    if (!entrant) return reply<EntrantMe>(res, { entrant: null, key: null, link: null })
    reply<EntrantMe>(res, { entrant, ...keyCard(entrant) })
  })

  /**
   * Sign-in by key, both from the "Enter your key" field and from the
   * `/k/t/<key>` link.
   *
   * The key travels in the POST body, not in the door's address: the address
   * ends up in the server log and in the `Referer` header of any image on the
   * page. That it is still visible in the browser's address bar for the
   * sign-in link is the price of the link itself, and the page erases it from
   * there right after the exchange.
   */
  router.post('/api/k/sign-in', (req, res) => {
    if (tooOften(signIns, addressOf(req), SIGN_IN_WINDOW, MAX_SIGN_INS)) {
      res.setHeader('Retry-After', '60')
      return refuse(res, 429, 'too_often', tr('competitions.refusal.tooOften'))
    }
    const key = normalizeEntrantKey(typeof req.body?.key === 'string' ? req.body.key : '')
    if (!key) return refuse(res, 404, 'key_unknown', tr('competitions.refusal.keyUnknown'))
    const entrant = entrantByKey(key)
    if (!entrant) return refuse(res, 404, 'key_unknown', tr('competitions.refusal.keyUnknown'))
    /*
     * "Disabled" and "no such key" are different refusals on purpose (see
     * store · entrantByKey): in the first case the person was already issued a
     * new key and has to go get it, in the second they mistyped a letter. One
     * word for both cases would send half the class to the teacher for a key
     * they already have.
     */
    if (entrant.disabled) return refuse(res, 403, 'key_disabled', tr('competitions.refusal.keyDisabled'))
    issueEntrantCookie(res, entrant)
    reply<EntrantMe>(res, { entrant, ...keyCard(entrant) })
  })

  router.post('/api/k/sign-out', (_req, res) => {
    clearEntrantCookie(res)
    res.json({ ok: true })
  })

  /* ------------------------------------------------------- competitions */

  /** The list for P1: running and finished ones, with what the person knows about themselves. */
  router.get('/api/k/competitions', (req, res) => {
    const me = currentEntrant(req)
    const mine = me ? myCompetitionIds(me.id) : new Set<string>()
    const rows = listCompetitions()
      .filter((competition) => competition.state !== 'draft')
      .map((competition) => {
        const summary = summaryOf(competition)
        const about = me ? mineIn(competition, me) : null
        const board = privateBoardState(competition)
        return {
          competition: publicCompetition(competition),
          entrants: summary.entrants,
          submissions: summary.submissions,
          bestPublic: summary.bestPublic,
          baselinePublic: baselineScore(competition),
          privateOpen: board.open,
          privatePending: board.pending,
          mine: about && { ...about, joined: about.joined || mine.has(competition.id) },
        }
      })
    reply<EntrantCompetitionList>(res, { entrant: me, competitions: rows })
  })

  /** The page of one competition: the task, the files to download, the checking conditions. */
  router.get('/api/k/competitions/:slug', async (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = currentEntrant(req)
    const summary = summaryOf(competition)
    const board = privateBoardState(competition)
    reply<EntrantCompetitionView>(res, {
      // publicCompetition is not decoration of the response but the only place
      // where the metric code and the row split seed are stripped from the
      // competition.
      competition: publicCompetition(competition),
      capabilities: await competitionCapabilities(competition.environment, competitionRevision(competition.id)?.imageDigest),
      files: listFiles(competition.id, 'open').map((file) => ({
        name: file.name,
        bytes: file.bytes,
        rows: file.rows,
      })),
      entrants: summary.entrants,
      submissions: summary.submissions,
      bestPublic: summary.bestPublic,
      baselinePublic: baselineScore(competition),
      privateOpen: board.open,
      privatePending: board.pending,
      accepting: submissionsOpen(competition, Date.now()),
      mine: me ? mineIn(competition, me) : null,
    })
  })

  /** Installed packages are public only through a published competition. */
  router.get('/api/k/competitions/:slug/environment', async (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    try {
      const retained = competitionRevision(competition.id)
      res.json(retained && retained.environmentName === competition.environment
        ? { name: retained.environmentName, python: retained.pythonVersion,
            packages: retained.packages, revisionId: retained.id }
        : await inventory(competition.environment))
    } catch {
      refuse(res, 503, 'unavailable', tr('common.environmentUnavailable'))
    }
  })

  /**
   * "JOIN": give a name and get a key.
   *
   * One door for two cases, a newcomer and a returning person, because on the
   * screen it is one button. A newcomer gets an instance identity and a key,
   * which they will see once in large print; a signed-in person simply joins,
   * and there is no key in the response: they already have it.
   */
  router.post('/api/k/competitions/:slug/join', (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    /*
     * One can join only a running one. A finished one has no "JOIN" button on
     * P1 at all, just a "Results and review" link, and adding new people to it
     * would mean adding names to a table that has already been counted.
     */
    const accepting = submissionsOpen(competition, Date.now())
    if (accepting === 'not_open') return refuse(res, 403, 'not_open', tr('competitions.refusal.notOpen'))
    if (accepting === 'closed') return refuse(res, 403, 'closed', tr('competitions.refusal.closed'))
    const known = currentEntrant(req)
    /*
     * A newly typed name must be a Telegram username or an email address, and
     * it is stored in its one form (`@anya_smirnova`, `anna@mail.ru`) BEFORE
     * the namesake key is taken from it: that is what makes `@Anya_Smirnova`
     * and `anya_smirnova` one person to the unique index. A signed-in person
     * who sends no name, or sends back the one they carry, keeps it even if
     * it predates the rule (shared/competitions.ts · nameForJoin).
     */
    const name = nameForJoin(String(req.body?.name ?? ''), known?.name ?? null)
    if (!name) return refuse(res, 400, 'invalid', tr('competitions.refusal.nameNotHandle'))

    if (!known && tooOften(joins, addressOf(req), JOIN_WINDOW, MAX_JOINS)) {
      res.setHeader('Retry-After', '60')
      return refuse(res, 429, 'too_often', tr('competitions.refusal.tooOften'))
    }

    /*
     * A namesake is checked BEFORE a new identity is created: otherwise a
     * "this name is taken" refusal would leave behind an entrant with no
     * competition and a key the person never saw, a row nobody can remove.
     */
    if (known) {
      if (joinCompetition(competition.id, known.id, name) === 'taken') {
        return refuse(res, 409, 'name_taken', tr('competitions.refusal.nameTaken'))
      }
      return reply<EntrantMe>(res, { entrant: getEntrant(known.id), key: null, link: null })
    }
    const minted = createEntrant(name)
    if (joinCompetition(competition.id, minted.entrant.id, name) === 'taken') {
      // The identity stays: it is instance-level, and the person will join
      // under another name with the same key. So the cookie is issued here too.
      issueEntrantCookie(res, minted.entrant)
      return refuse(res, 409, 'name_taken', tr('competitions.refusal.nameTaken'))
    }
    issueEntrantCookie(res, minted.entrant)
    reply<EntrantMe>(res, {
      entrant: getEntrant(minted.entrant.id),
      key: minted.key,
      link: `${config.publicUrl}${ENTRANT_SIGN_IN_PATH}${minted.key}`,
    })
  })

  /**
   * Both leaderboards at once, but the private one only when it is open.
   *
   * One door, because the P3 screen shows them side by side: "FINAL MAPE" and
   * "PUBLIC MAPE · place" in neighboring columns, and the shift arrow is
   * computed from the difference in places. Two requests for this would give
   * two pictures of different seconds.
   *
   * `private: null` means not "empty" but "still closed", and that is exactly
   * what the private part exists for: it cannot be fitted by refreshing the
   * page.
   */
  router.get('/api/k/competitions/:slug/leaderboard', (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = currentEntrant(req)
    const counts = submissionCounts(competition.id)
    const { open, pending } = privateBoardState(competition)
    const baseline = baselineEntrantOf(competition)
    reply<EntrantLeaderboard>(res, {
      public: withNames(leaderboard(competition.id, 'public'), counts, me, baseline),
      private: open
        ? withNames(leaderboard(competition.id, 'private'), counts, me, baseline)
        : null,
      privateOpen: open,
      privatePending: pending,
      baselinePublic: baselineScore(competition),
    })
  })

  /** Open data files. There are no hidden answers here, and no other door either. */
  router.get('/api/k/competitions/:slug/files/:name', (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const name = req.params.name
    /*
     * The name is checked against the LIST of open files, not only against the
     * letters of the path. `storage.checkName` rejects `..` and slashes, but it
     * lets the name `solution.csv` through, and if such a file ever ends up in
     * `data/`, the door would serve it. The list is the only source of truth
     * about what is open.
     */
    if (!listFiles(competition.id, 'open').some((file) => file.name === name)) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    }
    sendHeld(res, () => holdOpenFile(competition.id, name), name)
  })

  /* --------------------------------------------------------- submissions */

  /** "My submissions": no private score and no trace here; see entrantSubmission. */
  router.get('/api/k/competitions/:slug/submissions', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    reply<EntrantSubmissions>(res, submissionsView(competition, (req as EntrantRequest).entrant!))
  })

  /**
   * The same, but pushed by itself, while the person has something running.
   *
   * Server-sent events, like the live environment build log and the teacher's
   * screen (`/api/admin/competitions/:id/stream`): a one-way stream, the
   * browser reconnects by itself, and no second protocol for the sake of
   * three numbers. The room socket does not fit here at all: this page lives
   * outside a class and has no room, no document and no presence.
   *
   * It is sent on change, not on a timer: a page where nothing happens must
   * not redraw every second, and exactly two things happen here: a stage
   * change and a change of place in the queue.
   */
  router.get('/api/k/competitions/:slug/stream', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // By default the relay buffers the response, that is, turns a live
      // screen into one packet at the end of the lesson.
      'X-Accel-Buffering': 'no',
    })
    let last = ''
    const push = (): void => {
      const fresh = findCompetition(competition.id)
      if (!fresh) return
      const body = JSON.stringify(submissionsView(fresh, me))
      if (body === last) return
      last = body
      res.write(`event: state\ndata: ${body}\n\n`)
    }
    push()
    const tick = setInterval(push, 1000)
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000)
    req.on('close', () => {
      clearInterval(tick)
      clearInterval(beat)
    })
  })

  /**
   * Sending a notebook as a file.
   *
   * The refusals come in the order a person understands them: first
   * "submissions are closed", then "you have not joined", then "the previous
   * one is still running", then "that is enough for today", and only after
   * that is the file parsed. The other way round would be cruel: twenty
   * megabytes over mobile internet for the answer "the deadline passed
   * yesterday".
   */
  router.post('/api/k/competitions/:slug/submissions', requireEntrant, async (req, res) => {
    /*
     * The deadline is judged by the moment the request arrived, not the moment
     * its body finished: twenty megabytes over a classroom's Wi-Fi take a
     * minute, and a notebook sent at 23:59:50 must not lose to the connection
     * (competitions/results.ts, the grace and its cap).
     */
    const startedAt = Date.now()
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!

    const accepting = submissionsOpen(competition, startedAt)
    if (accepting === 'not_open') return refuse(res, 403, 'not_open', tr('competitions.refusal.notOpen'))
    if (accepting === 'closed') return refuse(res, 403, 'closed', tr('competitions.refusal.closed'))
    /*
     * "Joined" means a row in the table OR at least one earlier submission.
     * The second condition keeps afloat competitions created before joining
     * became a separate step: a person with twelve submissions must not hear
     * "join first" on the thirteenth.
     */
    const joined = joinedAt(competition.id, me.id) !== null
      || listEntrantSubmissions(competition.id, me.id).length > 0
    if (!joined) return refuse(res, 403, 'not_joined', tr('competitions.refusal.notJoined'))
    /*
     * One submission in flight per person, not out of politeness to the queue
     * but out of fairness: ten notebooks from one person queued at once make a
     * lesson in which nobody else sends anything. The queue already takes one
     * at a time from each person (store · turn), but that is about order, not
     * about count. A submission still WAITING is not a reason to refuse: the
     * new notebook takes its place (store · intakePlan) — only a running one
     * is, or a waiting re-run, which already has a result to lose.
     */
    const plan = intakePlan(competition.id, me.id)
    if (plan === 'in_flight') {
      return refuse(res, 409, 'in_flight', tr('competitions.refusal.inFlight'))
    }
    const left = leftToday(competition, me.id, startedAt, 0, plan.replaces?.id ?? null)
    if (left !== null && left <= 0) {
      return refuse(res, 429, 'quota', tr('competitions.refusal.dailyQuota', { count: competition.limits.perDay }))
    }
    if (tooOften(uploadsByAddress, addressOf(req), UPLOAD_WINDOW, MAX_UPLOADS_PER_ADDRESS)
      || tooOften(uploadsByEntrant, me.id, UPLOAD_WINDOW, uploadsPerMinute().value)) {
      res.setHeader('Retry-After', '60')
      return refuse(res, 429, 'too_often', tr('competitions.refusal.tooOften'))
    }

    /*
     * From here until the body is in (or refused), this upload is a result
     * the final board has to wait for if the deadline passes meanwhile. It is
     * counted before the first await: the runtime probe below may take
     * seconds, and an upload that passed the door at 23:59:59 uncounted let
     * the board open, private scores and all, for exactly that long. Every
     * way out below ends the response, and whichever comes first counts it
     * out: the answer handed to the socket, or the socket gone.
     */
    const release = holdUpload(competition.id)
    res.once('finish', release)
    res.once('close', release)
    try {
      await assertCompetitionCapability('execution', competition.environment, competitionRevision(competition.id)?.imageDigest)
    } catch (error) {
      return refuse(res, 503, 'unavailable', error instanceof Error ? error.message : tr('runtime.brokerUnavailable'))
    }

    readNotebook(req, res, async (fileName, body, bundleId) => {
      const revision = await executionRevision(competition)
      /*
       * The acceptance and the notebook on disk commit together or not at
       * all. A replacement cancels the person's waiting submission inside the
       * acceptance, and a write that failed after that commit (a full disk)
       * left them with neither. In one transaction the failed write rolls the
       * whole intake back and the waiting one keeps its place. The write is
       * synchronous either way: the transaction holds nothing longer than the
       * event loop already did.
       */
      const submission = db.transaction(() => {
        const accepted = acceptPinnedSubmission(competition, me.id, fileName, body.length, revision, bundleId, { startedAt })
        try {
          ensureCompetition(competition.id)
          putSubmissionNotebook(competition.id, accepted.id, body)
        } catch (error) {
          // The rows roll back with the throw; the half-made folder is ours to remove.
          removeSubmission(competition.id, accepted.id)
          throw error
        }
        return accepted
      })()
      /*
       * Wake the runner at once instead of waiting for its one-second tick.
       *
       * The notebook is already on disk, a queue slot may be free, and still
       * the submission would sit in "QUEUED" for up to a second simply because
       * the timer has not ticked yet. The student is looking at the phone
       * screen in that second and doing nothing else. All the teacher doors
       * wake the pump with the same call; this one was the only one that
       * stayed silent.
       */
      wakeCompetitionPump()
      reply<SubmissionAccepted>(res, {
        submission: entrantSubmission(
          publicExecution(getSubmission(submission.id)!, competition.environment),
          privateBoardState(competition).open,
        ),
        leftToday: leftToday(competition, me.id),
        replacedNumber: submission.replaced?.number ?? null,
      })
    })
  })

  /** "Choose for scoring". Someone else's submission cannot be chosen; the store checks that. */
  router.post('/api/k/competitions/:slug/submissions/:id/choose', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    const submission = getSubmission(req.params.id)
    if (!submission || submission.competitionId !== competition.id) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    }
    if (submission.entrantId !== me.id) {
      // A 404 would say "no such submission", and that would be untrue; a 403
      // with these words is more honest and gives nothing away: the person has
      // already seen the submission number.
      return refuse(res, 403, 'forbidden', tr('competitions.refusal.notYours'))
    }
    /*
     * The choice freezes at the deadline, together with submissions.
     *
     * Otherwise the private part stops being hidden for everyone who sent more
     * than one submission: the results open, a person sees the private score
     * of EACH of their submissions in "my submissions" and picks the best one
     * for scoring. That is not getting around the rule but outright fitting to
     * the hidden part, exactly what it was introduced to prevent. This takes
     * away no freedom: before the deadline the choice can be changed any
     * number of times.
     */
    if (submissionsOpen(competition, Date.now()) !== 'open') {
      return refuse(res, 403, 'closed', tr('competitions.refusal.chooseClosed'))
    }
    if (competition.scoring !== 'chosen') {
      return refuse(res, 409, 'invalid', tr('competitions.refusal.chooseAutomatic'))
    }
    if (!chooseSubmission(competition.id, me.id, submission.id)) {
      return refuse(res, 409, 'invalid', tr('competitions.refusal.notScored'))
    }
    // The whole list, not one row: the choice removes the mark from the
    // previous submission, and a screen that redrew only the pressed one would
    // show two "scored".
    reply<EntrantSubmissions>(res, submissionsView(competition, me))
  })

  /**
   * "Cancel": take one's submission off the queue or cut its run short.
   *
   * A waiting one leaves the queue as a database row; a running one is taken
   * down by the runner, which kills the container (runner ·
   * cancelSubmission). An entrant has no separate "kill" door and cannot have
   * one: they name the submission, and what to do with it is decided by
   * whoever knows what it is busy with right now.
   *
   * `false` from the runner is not an error but "too late": while the request
   * was travelling, the run ended by itself. This case is not drawn in the
   * mockup, and lying about it is not allowed.
   */
  router.post('/api/k/competitions/:slug/submissions/:id/cancel', requireEntrant, async (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    const submission = getSubmission(req.params.id)
    if (!submission || submission.competitionId !== competition.id) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    }
    if (submission.entrantId !== me.id) {
      return refuse(res, 403, 'forbidden', tr('competitions.refusal.notYours'))
    }
    if (!(await cancelSubmission(submission.id, 'entrant'))) {
      return refuse(res, 409, 'invalid', tr('competitions.refusal.tooLateToCancel'))
    }
    reply<EntrantSubmissions>(res, submissionsView(competition, me))
  })

  /**
   * One's own notebook: the executed one, and the sent one until the run
   * ends.
   *
   * "Download the notebook with output" (P2) is what a person looks at a
   * failed submission for in the first place: the trace in the list is short,
   * and the cause is sometimes visible only in the output of a neighboring
   * cell.
   *
   * The sent notebook goes out only when there is truly no executed one — the
   * run has not ended, or never reached a cell. This door used to ask `out/`
   * for the SENT notebook's name, found nothing there and fell back every
   * time: each download was the person's own file, without a single output.
   * An executed copy that is there but will not open is an error, not a
   * reason to hand out the other file.
   */
  router.get('/api/k/competitions/:slug/submissions/:id/notebook', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    const submission = getSubmission(req.params.id)
    if (!submission || submission.competitionId !== competition.id) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    }
    if (submission.entrantId !== me.id) {
      return refuse(res, 403, 'forbidden', tr('competitions.refusal.notYours'))
    }
    let executed: HeldFile | null
    try {
      executed = holdExecutedNotebook(competition.id, submission.id)
    } catch (error) {
      console.error('[competitions] executed notebook could not be opened', submission.id, error)
      return refuse(res, 503, 'unavailable', tr('common.requestFailed', { status: 503 }))
    }
    if (executed) return downloadHeldFile(res, executed, submission.fileName)
    sendHeld(res, () => holdSubmittedNotebook(competition.id, submission.id), submission.fileName)
  })

  return router
}

/* ----------------------------------------------------- notebook parsing */

/*
 * The intake transaction re-checks what the door checked before the body
 * (the deadline, one in flight, the day's quota), and the answer must be the
 * same word the door would have said: the screen branches on `reason`, and
 * "invalid" after a passed deadline dims nothing.
 */
const INTAKE_REFUSALS: Record<string, { reason: CompetitionRefusal; say: () => string }> = {
  dependency_closed: { reason: 'closed', say: () => tr('competitions.refusal.closed') },
  dependency_submission_active: { reason: 'in_flight', say: () => tr('competitions.refusal.inFlight') },
  dependency_submission_quota: { reason: 'quota', say: () => dependencyMessage('dependency_submission_quota') },
}

/**
 * Read one notebook from multipart and hand over its bytes.
 *
 * Into memory, not into a temp file, and that is a decision about the
 * number: the cap here is its own, `LIMITS.notebookBytes`, twenty megabytes,
 * because `nbformat.read` in the container will parse the whole file anyway.
 * Real notebooks are two orders of magnitude smaller; bigger ones carry
 * forgotten cell output with images, and the honest answer to them is "clear
 * the output", not "out of memory" after ten minutes of execution.
 *
 * `config.maxUploadBytes` (room files) is no good here either as a cap or as
 * a guide: it is about the dataset a student brings to the lesson.
 */
function readNotebook(req: Request, res: Response, done: (fileName: string, body: Buffer, bundleId: string | null) => void | Promise<void>): void {
  let bb: ReturnType<typeof busboy>
  try {
    bb = busboy({
      headers: req.headers,
      // Otherwise busboy reads the file name as latin-1, and `модель.ipynb`
      // arrives as mojibake: exactly the same fix as in routes/files.ts.
      defParamCharset: 'utf8',
      limits: { fileSize: LIMITS.notebookBytes, files: 1, fields: 2, fieldSize: 4096 },
    })
  } catch {
    return refuse(res, 400, 'invalid', tr('competitions.refusal.noFile'))
  }

  const chunks: Buffer[] = []
  let fileName = ''
  let answered = false
  let tooBig = false
  let bundleId: string | null = null
  let sawBundle = false

  const say = (status: number, reason: CompetitionRefusal, error: string) => {
    if (answered) return
    answered = true
    req.unpipe(bb)
    req.resume()
    refuse(res, status, reason, error)
  }

  bb.on('file', (field, stream, info) => {
    if (field !== 'file' || fileName) return stream.resume()
    fileName = path.basename(info.filename ?? '')
    stream.on('limit', () => {
      tooBig = true
      stream.resume()
    })
    stream.on('data', (chunk: Buffer) => {
      if (!tooBig) chunks.push(chunk)
    })
  })

  bb.on('field', (field, value, info) => {
    if (field !== 'bundleId') return
    if (sawBundle || info.valueTruncated || (value !== '' && !/^[a-f0-9]{32}$/.test(value))) {
      say(400, 'invalid', dependencyMessage('dependency_owner'))
      return
    }
    sawBundle = true
    bundleId = value || null
  })
  bb.on('fieldsLimit', () => say(400, 'invalid', dependencyMessage('dependency_limits')))
  bb.on('filesLimit', () => say(400, 'invalid', tr('competitions.refusal.notIpynb')))

  bb.on('error', () => say(400, 'invalid', tr('competitions.refusal.noFile')))

  bb.on('close', () => {
    if (answered) return
    if (tooBig) {
      return say(413, 'too_big', tr('competitions.refusal.tooBig', { count: Math.round(LIMITS.notebookBytes / (1024 * 1024)) }))
    }
    if (!fileName || chunks.length === 0) return say(400, 'invalid', tr('competitions.refusal.noFile'))
    if (!fileName.toLowerCase().endsWith('.ipynb')) {
      return say(400, 'invalid', tr('competitions.refusal.notIpynb'))
    }
    /*
     * Parsing BEFORE the queue. Broken JSON in a one-off container becomes
     * "the notebook failed": a verdict on code the person never wrote, and a
     * spent submission out of the five per day on top of that
     * (@shared/competitions · whyNotebookRefused). What is stored is the body
     * the check read, a byte order mark already cut off (intake ·
     * intakeNotebook).
     */
    const { body, refusal } = intakeNotebook(Buffer.concat(chunks))
    if (refusal) return say(400, 'invalid', refusal)
    answered = true
    void Promise.resolve().then(() => done(fileName, body, bundleId)).catch((error: unknown) => {
      if (res.headersSent) return
      if (error instanceof DependencyStoreError) {
        const intake = INTAKE_REFUSALS[error.code]
        if (intake) refuse(res, error.status, intake.reason, intake.say())
        // With its numbers: "the set needs 379 MB of the 1.0 GB a submission gets".
        else refuse(res, error.status, 'invalid', dependencyRefusal(error.code, error.detail))
      } else {
        console.error('[competitions] accepting notebook failed', error)
        refuse(res, 503, 'unavailable', tr('common.requestFailed', { status: 503 }))
      }
    })
  })

  req.pipe(bb)
}
