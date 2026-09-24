import { tr } from '@shared/i18n'
/**
 * The council: students' attempts per cell × person — storage and snapshots.
 *
 * Attempts do NOT live in the shared notebook (CRDT): five hundred people in
 * one Y.Text is noise, and, more importantly, a student must never see
 * someone else's attempt. So the text arrives as a snapshot over the control
 * socket (control.ts · council:draft), lands here — in SQLite, to survive a
 * server restart — and two views are assembled from here: `mineFor` for the
 * author and `boardFor` for the teacher.
 *
 * Only storage and snapshot assembly live here. The right ("who may") is
 * asked by control.ts via shared/rules.ts
 * (mayWriteCouncil/mayRunCouncil/mayLeadCouncil); fan-out over sockets is its
 * job too. Running an attempt in the kernel is kernel/ via control.ts, and
 * the output comes back here through `recordRun`. The Oracle on solutions is
 * ai/, and its state is stored here by `setOracle`.
 *
 * Table council_attempts (session_id, cell_id, participant_id, text,
 * submitted_at, updated_at, run_json, reply_json, correct, shown, shown_by,
 * shown_at, shown_no) keyed by (session_id, cell_id, participant_id);
 * council_oracle (session_id, cell_id, oracle_json). The schema is created by
 * `ensureCouncilSchema` on module import — like lecture_notes in db.ts, only
 * next to the queries against it.
 *
 * "On screen" lives HERE, on the attempt, not in the notebook cell: showing
 * is a link to someone's attempt, not text (shared/protocol.ts ·
 * CouncilShown). A cell has at most one shown attempt, and `shownFor`
 * assembles from it what goes to the whole room.
 *
 * The in-memory cache covers the whole room, write-through: a snapshot
 * arrives on every pause in typing from each of five hundred people, and for
 * each of them the whole pile is assembled for the host. Reading it from
 * SQLite five hundred times a second means JSON.parse of five hundred rows per
 * frame; reading it from a map costs nothing. The database is still the
 * truth: a restart reads it again (`resetCouncilCache` in a test does the same
 * by hand).
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  CouncilAttempt,
  CouncilBoard,
  CouncilGroup,
  CouncilMine,
  CouncilOracle,
  CouncilReply,
  CouncilRun,
  CouncilRunRequest,
  CouncilShown,
  CouncilStatus,
} from '@shared/protocol'
import { attemptStatus, groupAttempts } from '@shared/protocol'
import { normalizeAttempt } from '@shared/notebook'
import { normalizeOracle, stopRoomOracles } from './ai/council.js'
import { db, getParticipant, getSession } from './db.js'

export { normalizeAttempt }

/** A table row — what `CouncilMine` and `CouncilAttempt` are assembled from. */
export interface StoredAttempt {
  sessionId: string
  cellId: string
  participantId: string
  text: string
  submittedAt: number | null
  updatedAt: number
  run: CouncilRun | null
  runRequest: CouncilRunRequest | null
  /**
   * The teacher's letters: the personal one and the group one side by side,
   * not one on top of the other.
   *
   * There are at most two (`keeping`), in the order they were sent. One field
   * for both was a silent loss: a message to the group landed on top of the
   * personal answer, and there was nothing to bring it back with — attempts
   * have no version history.
   */
  replies: CouncilReply[]
  correct: boolean | null
  shown: boolean
  /** Who put it on screen (the teacher's participantId); `null` means nobody did. */
  shownBy: string | null
  shownAt: number | null
  /**
   * The variant number assigned AT SHOWING.
   *
   * Computed by submission time (`variantOf`) once, and it does not move
   * afterwards: submission times are live — a neighbour submitted, changed
   * their mind, submitted again — and the number on the projector would change
   * from someone else's click while the class is looking at it.
   */
  shownNo: number | null
  /**
   * The group key — `normalizeAttempt(text)`, computed ONCE per text change.
   *
   * There is no column for it and there should not be: it is derived from the
   * text, and storing a derived value means one day diverging from it. But
   * computing it anew for every frame is expensive: the bar's numbers travel
   * to the host on every pause in typing of each of five hundred people, and
   * `normalizeAttempt` is a character-by-character loop over the whole
   * attempt. Five hundred attempts of eight kilobytes three times a second is
   * four megabytes of traversal per second for the sake of two numbers.
   */
  groupKey: string
}

/** CREATE TABLE IF NOT EXISTS — idempotent, at startup. */
export function ensureCouncilSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_attempts (
      session_id     TEXT NOT NULL,
      cell_id        TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      text           TEXT NOT NULL,
      submitted_at   INTEGER,
      updated_at     INTEGER NOT NULL,
      run_json       TEXT,
      run_request_json TEXT,
      /* The teacher's letters as a list — personal and group (see repliesFrom). */
      reply_json     TEXT,
      correct        INTEGER,
      shown          INTEGER NOT NULL DEFAULT 0,
      /* Caption of a shown attempt: who showed it, when, under which variant number. */
      shown_by       TEXT,
      shown_at       INTEGER,
      shown_no       INTEGER,
      PRIMARY KEY (session_id, cell_id, participant_id)
    );
    /* A ban asks for "everything this person has in the room" — all cells at once. */
    CREATE INDEX IF NOT EXISTS council_attempts_person
      ON council_attempts(session_id, participant_id);

    CREATE TABLE IF NOT EXISTS council_oracle (
      session_id  TEXT NOT NULL,
      cell_id     TEXT NOT NULL,
      oracle_json TEXT NOT NULL,
      PRIMARY KEY (session_id, cell_id)
    );

    /*
     * The task — the cell's shared text at the second the lock was switched to
     * council. A separate row, because by then it may no longer be in the cell
     * itself: "Show the class" puts someone's solution into the shared text,
     * and a latecomer would seed their sheet with it (shared/protocol.ts ·
     * CouncilMine.seed).
     */
    CREATE TABLE IF NOT EXISTS council_seed (
      session_id TEXT NOT NULL,
      cell_id    TEXT NOT NULL,
      seed       TEXT NOT NULL,
      PRIMARY KEY (session_id, cell_id)
    );
  `)
  // Existing installations keep their attempts; add only the new nullable fields.
  const columns = db.pragma('table_info(council_attempts)') as { name: string }[]
  const has = (name: string) => columns.some((column) => column.name === name)
  if (!has('run_request_json')) {
    db.exec('ALTER TABLE council_attempts ADD COLUMN run_request_json TEXT')
  }
  /*
   * The caption of the shown attempt — three columns added to a live table.
   *
   * For a room that ran on the previous version, showing was a text swap: the
   * cell already holds someone's solution, but there is no caption for it and
   * nowhere for one to come from (who pressed and when is not recorded
   * anywhere). There is nothing to migrate: such an attempt keeps `shown`, and
   * the badge will be assembled without the time of showing — or the teacher
   * will show it again, and it will be complete.
   */
  if (!has('shown_by')) db.exec('ALTER TABLE council_attempts ADD COLUMN shown_by TEXT')
  if (!has('shown_at')) db.exec('ALTER TABLE council_attempts ADD COLUMN shown_at INTEGER')
  if (!has('shown_no')) db.exec('ALTER TABLE council_attempts ADD COLUMN shown_no INTEGER')
}

ensureCouncilSchema()

/* ------------------------------------------------------------- database */

interface AttemptRow {
  session_id: string
  cell_id: string
  participant_id: string
  text: string
  submitted_at: number | null
  updated_at: number
  run_json: string | null
  run_request_json: string | null
  reply_json: string | null
  correct: number | null
  shown: number
  shown_by: string | null
  shown_at: number | null
  shown_no: number | null
}

const selectRoom = db.prepare('SELECT * FROM council_attempts WHERE session_id = ?')
const upsertAttempt = db.prepare(`
  INSERT INTO council_attempts
    (session_id, cell_id, participant_id, text, submitted_at, updated_at,
     run_json, run_request_json, reply_json, correct, shown, shown_by, shown_at, shown_no)
  VALUES (@session_id, @cell_id, @participant_id, @text, @submitted_at, @updated_at,
          @run_json, @run_request_json, @reply_json, @correct, @shown,
          @shown_by, @shown_at, @shown_no)
  ON CONFLICT(session_id, cell_id, participant_id) DO UPDATE SET
    text = excluded.text,
    submitted_at = excluded.submitted_at,
    updated_at = excluded.updated_at,
    run_json = excluded.run_json,
    run_request_json = excluded.run_request_json,
    reply_json = excluded.reply_json,
    correct = excluded.correct,
    shown = excluded.shown,
    shown_by = excluded.shown_by,
    shown_at = excluded.shown_at,
    shown_no = excluded.shown_no
`)
const deleteOfPerson = db.prepare(
  'DELETE FROM council_attempts WHERE session_id = ? AND participant_id = ?',
)
const deleteOfRoom = db.prepare('DELETE FROM council_attempts WHERE session_id = ?')
const selectOracles = db.prepare(
  'SELECT cell_id, oracle_json FROM council_oracle WHERE session_id = ?',
)
const upsertOracle = db.prepare(`
  INSERT INTO council_oracle (session_id, cell_id, oracle_json) VALUES (?, ?, ?)
  ON CONFLICT(session_id, cell_id) DO UPDATE SET oracle_json = excluded.oracle_json
`)
const deleteOraclesOfRoom = db.prepare('DELETE FROM council_oracle WHERE session_id = ?')
const selectSeeds = db.prepare('SELECT cell_id, seed FROM council_seed WHERE session_id = ?')
const upsertSeed = db.prepare(`
  INSERT INTO council_seed (session_id, cell_id, seed) VALUES (?, ?, ?)
  ON CONFLICT(session_id, cell_id) DO UPDATE SET seed = excluded.seed
`)
const deleteSeedsOfRoom = db.prepare('DELETE FROM council_seed WHERE session_id = ?')

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * A run that survived a server restart is a ghost.
 *
 * The kernel queue lives in process memory (see kernel/index.ts), and
 * "queued" from a previous life means the run will not happen: the attempt
 * goes back to "not run". "Running" is worse: the process it ran in is gone
 * along with the output, and it is more honest to say so on the card than to
 * show a stopwatch that will never stop.
 */
function settleGhostRun(run: CouncilRun | null): CouncilRun | null {
  if (!run) return null
  if (run.state === 'queued') return null
  if (run.state === 'running') {
    return {
      ...run,
      state: 'error',
      ranMs: null,
      outputs: [
        ...run.outputs,
        {
          kind: 'error',
          ename: 'ServerRestarted',
          evalue: tr("server.theServerRestartedWhileTheAttemptWas.0dc824"),
          traceback: [],
        },
      ],
    }
  }
  return run
}

/**
 * An Oracle that is "reading" after a server restart is the same ghost.
 *
 * The request to the model lived in process memory (ai/council.ts · reading)
 * and went away with it: there will be no answer, `settle` will not be
 * called, and the state in the database would stay "reading" — a spinner
 * until the end of the class period, a "Stop" with nothing to stop, and not a
 * single button to ask again. The previous summary, if there was one, comes
 * back ready with the reason next to it; if there was none, an empty space
 * with the same reason, and the "Ask" button in place.
 */
const ORACLE_RESTARTED = () => tr("server.private.oracleRestart")

function settleGhostOracle(oracle: CouncilOracle): CouncilOracle {
  if (oracle.state !== 'reading') return oracle
  /*
   * `pending` is cleared along with the spinner: it is the question BEING
   * READ, and having survived a restart it would draw an eternal answer
   * skeleton in the feed under a question asked long ago. The feed itself
   * (`answers`) stays — it is about the conversation, not the request, and a
   * server restart does not touch it.
   */
  return oracle.answers.length > 0
    ? { ...oracle, state: 'ready', pending: null, error: ORACLE_RESTARTED() }
    : { ...oracle, state: 'idle', askedAt: null, basedOn: 0, pending: null, error: ORACLE_RESTARTED() }
}

/**
 * Letters from `reply_json` — as a list, whatever the row holds.
 *
 * The column holds either a list (that is how we write it) or one letter as
 * an object — that is how it was written while the attempt had one field. No
 * separate column for the list was added on purpose: ALTER TABLE for the same
 * value would give two columns about one letter, and one day they would
 * diverge. Empty letters are thrown out: a row without text is drawn as a
 * caption in a void.
 */
function repliesFrom(raw: string | null): CouncilReply[] {
  const parsed = parseJson<CouncilReply | CouncilReply[]>(raw)
  if (!parsed) return []
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter((one) => typeof one?.text === 'string' && one.text.trim() !== '')
}

function requestFromRow(row: AttemptRow): CouncilRunRequest | null {
  const value = parseJson<CouncilRunRequest & { sourceHash?: string }>(row.run_request_json)
  // Older application versions can change text without updating this column.
  // A persisted request must still name the exact bytes that were requested.
  if (!value || typeof value.id !== 'string' || !value.id ||
      !Number.isFinite(value.requestedAt) ||
      (value.status !== 'pending' && value.status !== 'declined') ||
      value.sourceHash !== createHash('sha256').update(row.text).digest('hex')) return null
  return { id: value.id, requestedAt: value.requestedAt, status: value.status }
}

function fromRow(row: AttemptRow): StoredAttempt {
  return {
    sessionId: row.session_id,
    cellId: row.cell_id,
    participantId: row.participant_id,
    text: row.text,
    groupKey: normalizeAttempt(row.text),
    submittedAt: row.submitted_at ?? null,
    updatedAt: row.updated_at,
    run: settleGhostRun(parseJson<CouncilRun>(row.run_json)),
    runRequest: requestFromRow(row),
    replies: repliesFrom(row.reply_json),
    correct: row.correct === null ? null : row.correct === 1,
    shown: row.shown === 1,
    shownBy: row.shown_by ?? null,
    shownAt: row.shown_at ?? null,
    shownNo: row.shown_no ?? null,
  }
}

function persist(attempt: StoredAttempt): void {
  upsertAttempt.run({
    session_id: attempt.sessionId,
    cell_id: attempt.cellId,
    participant_id: attempt.participantId,
    text: attempt.text,
    submitted_at: attempt.submittedAt,
    updated_at: attempt.updatedAt,
    run_json: attempt.run ? JSON.stringify(attempt.run) : null,
    run_request_json: attempt.runRequest ? JSON.stringify({
      ...attempt.runRequest,
      sourceHash: createHash('sha256').update(attempt.text).digest('hex'),
    }) : null,
    // A list, not a single letter: see `repliesFrom`. Empty means `null`, as before.
    reply_json: attempt.replies.length > 0 ? JSON.stringify(attempt.replies) : null,
    correct: attempt.correct === null ? null : attempt.correct ? 1 : 0,
    shown: attempt.shown ? 1 : 0,
    shown_by: attempt.shownBy,
    shown_at: attempt.shownAt,
    shown_no: attempt.shownNo,
  })
}

/* ---------------------------------------------------------------- cache */

/** Room → cell → person. */
type CellMap = Map<string, StoredAttempt>
interface RoomCache {
  cells: Map<string, CellMap>
  oracles: Map<string, CouncilOracle>
  /** Cell → the task a blank sheet is seeded from. */
  seeds: Map<string, string>
}

const cache = new Map<string, RoomCache>()

function roomOf(sessionId: string): RoomCache {
  const cached = cache.get(sessionId)
  if (cached) return cached
  const room: RoomCache = { cells: new Map(), oracles: new Map(), seeds: new Map() }
  for (const row of selectRoom.all(sessionId) as AttemptRow[]) {
    const attempt = fromRow(row)
    cellOf(room, attempt.cellId).set(attempt.participantId, attempt)
  }
  for (const row of selectOracles.all(sessionId) as { cell_id: string; oracle_json: string }[]) {
    const oracle = parseJson<CouncilOracle>(row.oracle_json)
    // `normalizeOracle` comes before everything else: the row may have been
    // written by a version without the question feed, and `settleGhostOracle`
    // would read fields it does not have (ai/council.ts · normalizeOracle).
    if (oracle) room.oracles.set(row.cell_id, settleGhostOracle(normalizeOracle(oracle)))
  }
  for (const row of selectSeeds.all(sessionId) as { cell_id: string; seed: string }[]) {
    room.seeds.set(row.cell_id, row.seed)
  }
  cache.set(sessionId, room)
  return room
}

function cellOf(room: RoomCache, cellId: string): CellMap {
  let cell = room.cells.get(cellId)
  if (!cell) {
    cell = new Map()
    room.cells.set(cellId, cell)
  }
  return cell
}

/**
 * Forget the cache — of one room or of all.
 *
 * This is not needed in operation: the cache is write-through. It is needed
 * by the test that checks that attempts survive a restart: the test is a
 * restart without the process.
 */
export function resetCouncilCache(sessionId?: string): void {
  if (sessionId === undefined) cache.clear()
  else cache.delete(sessionId)
}

function save(attempt: StoredAttempt): StoredAttempt {
  cellOf(roomOf(attempt.sessionId), attempt.cellId).set(attempt.participantId, attempt)
  persist(attempt)
  return attempt
}

/* ------------------------------------------------------------- own sheet */

/**
 * A snapshot of the text on a pause in typing. Creates the attempt if there
 * was none; does not clear "submitted" (that is what `withdrawAttempt` is
 * for). Returns the row after the write.
 *
 * A change of text takes away everything that was said about the PREVIOUS
 * text: the run output, the "correct" mark and "on screen". They are glued to
 * the text, not to the person: "On screen · the teacher showed your answer"
 * over code that is not in the shared cell, and a green "correct" over
 * something unchecked, are lies on both screens. The teacher's answer stays —
 * it is a letter to the person, and it does not go stale from an edit.
 */
export function saveDraft(
  sessionId: string,
  cellId: string,
  participantId: string,
  text: string,
  now: number,
): StoredAttempt {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (prior && prior.text === text) return prior
  // The text changed — so the run that is now going or waiting in the queue
  // is computing something that is NOT THIS. Its future frames will not land
  // here (see recordRun).
  runFor.delete(runKey(sessionId, cellId, participantId))
  return save({
    sessionId,
    cellId,
    participantId,
    text,
    groupKey: normalizeAttempt(text),
    submittedAt: prior?.submittedAt ?? null,
    updatedAt: now,
    run: null,
    runRequest: null,
    replies: prior?.replies ?? [],
    correct: null,
    shown: false,
    shownBy: null,
    shownAt: null,
    shownNo: null,
  })
}

/** "Submit": sets submittedAt. `null` means there is no attempt (nothing to submit). */
export function submitAttempt(
  sessionId: string,
  cellId: string,
  participantId: string,
  now: number,
): StoredAttempt | null {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (!prior) return null
  // A second press is not a new time: "submitted 14:32" does not move to 14:40.
  if (prior.submittedAt !== null) return prior
  return save({ ...prior, submittedAt: now })
}

/** "Edit": clears submittedAt, the text stays. */
export function withdrawAttempt(
  sessionId: string,
  cellId: string,
  participantId: string,
): StoredAttempt | null {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (!prior) return null
  if (prior.submittedAt === null) return prior
  return save({ ...prior, submittedAt: null })
}

/** A request belongs to this draft, independently of whether it was submitted. */
export function requestAttemptRun(
  sessionId: string,
  cellId: string,
  participantId: string,
  now: number,
): CouncilRunRequest | null {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (!prior?.text.trim() || prior.run?.state === 'queued' || prior.run?.state === 'running') {
    return null
  }
  if (prior.runRequest?.status === 'pending') return prior.runRequest
  const request: CouncilRunRequest = { id: randomUUID(), requestedAt: now, status: 'pending' }
  save({ ...prior, runRequest: request })
  return request
}

/** Only a decision for the current pending request can change its state. */
export function resolveRunRequest(
  sessionId: string,
  cellId: string,
  participantId: string,
  requestId: string,
  decision: 'decline' | 'clear',
): boolean {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (prior?.runRequest?.status !== 'pending' || prior.runRequest.id !== requestId) return false
  save({
    ...prior,
    runRequest: decision === 'decline' ? { ...prior.runRequest, status: 'declined' } : null,
  })
  return true
}

/** Clear request state when the classroom context changes; callers notify affected authors. */
export function clearRunRequests(
  sessionId: string,
  cellId?: string,
): Array<{ cellId: string; participantId: string }> {
  const affected: Array<{ cellId: string; participantId: string }> = []
  db.transaction(() => {
    for (const [id, attempts] of roomOf(sessionId).cells) {
      if (cellId !== undefined && id !== cellId) continue
      for (const attempt of attempts.values()) {
        if (!attempt.runRequest) continue
        save({ ...attempt, runRequest: null })
        affected.push({ cellId: id, participantId: attempt.participantId })
      }
    }
  })()
  return affected
}

export function attemptOf(
  sessionId: string,
  cellId: string,
  participantId: string,
): StoredAttempt | null {
  return roomOf(sessionId).cells.get(cellId)?.get(participantId) ?? null
}

export function attemptsOf(sessionId: string, cellId: string): StoredAttempt[] {
  const cell = roomOf(sessionId).cells.get(cellId)
  return cell ? [...cell.values()] : []
}

/** Room cells that have attempts — for the host's welcome batch. */
export function cellsWithAttempts(sessionId: string): string[] {
  const out: string[] = []
  for (const [cellId, cell] of roomOf(sessionId).cells) if (cell.size > 0) out.push(cellId)
  return out
}

/** Cells where this person has an attempt — for their welcome batch. */
export function cellsOfParticipant(sessionId: string, participantId: string): string[] {
  const out: string[] = []
  for (const [cellId, cell] of roomOf(sessionId).cells)
    if (cell.has(participantId)) out.push(cellId)
  return out
}

/* --------------------------------------------------------- leader actions */

/**
 * Under which text the run that is now in flight was started.
 *
 * The key is room, cell, person; the value is the attempt's text at the
 * moment "Run" was pressed. In memory, not in the database, and that is
 * enough: the kernel queue lives in process memory too, and a run that
 * survived a restart is a ghost anyway (`settleGhostRun`).
 */
const runFor = new Map<string, string>()

/**
 * A running run that is the attempt author's OWN.
 *
 * Two count as their own: the student's direct press and their approved
 * request. The second cannot be recognised by `CouncilRun.by` — that records
 * whoever PRESSED, and "approve" is pressed by the teacher — but in both
 * cases the kernel spent time on this person, and the pause between runs
 * (notebook.ts · rerunPauseSec) must be counted the same way. Otherwise the
 * "on request" mode would be the only one with no pause at all, while it is
 * needed there just as everywhere else.
 *
 * A run the teacher started on their own while looking at someone's solution
 * sets no pause for the author: the author did not ask for it and may not
 * have known about it.
 */
const ownRun = new Set<string>()

/**
 * When the last own run ended — the pause counts from this mark.
 *
 * In memory, not in the database, and deliberately so: a server restart will
 * forget a thirty-second pause for fifty people, and nothing will happen —
 * the queue is empty by then, and the kernel comes up anew anyway. It is not
 * worth a table column and a write at the end of every run.
 *
 * What is stored is the END of the run, not the time until which running is
 * forbidden: the teacher changes the pause in the middle of the class period,
 * and "the rules apply at once" means that those who have already waited are
 * counted by the new number, not by the one once recorded for them.
 */
const ownRunEnded = new Map<string, number>()

function runKey(sessionId: string, cellId: string, participantId: string): string {
  return `${sessionId}\u0000${cellId}\u0000${participantId}`
}

/**
 * From which second the author may run again; `null` means right now.
 *
 * Computed on every question from the end of the last run and the CURRENT
 * pause: a knob removed by the teacher releases everyone at once, and one that
 * is set also reaches those who have already had their go.
 */
export function nextRunAtFor(
  sessionId: string,
  cellId: string,
  participantId: string,
  pauseSec: number,
  now: number = Date.now(),
): number | null {
  if (pauseSec <= 0) return null
  const ended = ownRunEnded.get(runKey(sessionId, cellId, participantId))
  if (ended === undefined) return null
  const at = ended + pauseSec * 1000
  return at > now ? at : null
}

/**
 * A run's output — to the attempt, not to the shared cell. `null` means
 * erase.
 *
 * Returns whether the frame landed. `false` means the attempt is gone OR the
 * frame is late: while it was being computed, the author changed the text,
 * and the output belongs to the previous one.
 *
 * The late frame deserves a word of its own, because its price is high. There
 * is one queue for five hundred people, waiting a minute is ordinary, and an
 * edit during that time is ordinary too. `saveDraft` honestly clears from the
 * attempt everything that was said about the PREVIOUS text — but the kernel
 * finished reading the old source and put its traceback under the new code:
 * the student's card and the teacher's pile showed the output of a program
 * that was not on them, with the status "failed" or "completed". The teacher
 * marked "correct" going by someone else's output.
 *
 * The fingerprint is the text itself, not a hash: the attempt is lying right
 * there in memory anyway, and a hash would add one more way to get the
 * comparison wrong.
 */
export function recordRun(
  sessionId: string,
  cellId: string,
  participantId: string,
  run: CouncilRun | null,
): boolean {
  const prior = attemptOf(sessionId, cellId, participantId)
  // The attempt has been removed already (a ban) — output does not resurrect it.
  if (!prior) return false
  const key = runKey(sessionId, cellId, participantId)
  if (run === null) {
    runFor.delete(key)
    save({ ...prior, run: null })
    return true
  }
  /*
   * A run's first frame is "queued": it is the request itself, and the text
   * under it is the one at the time of the press. Everything else is frames of
   * the same run, and they are valid only while the text has not changed.
   */
  if (run.state === 'queued') {
    runFor.set(key, prior.text)
    // Whose run it is gets decided here, while the request is still visible:
    // a line below `runRequest` is cleared, and by the run's own frames an
    // approved request can no longer be told apart from the teacher's
    // curiosity (see `ownRun`).
    if (run.by === 'author' || prior.runRequest?.status === 'pending') ownRun.add(key)
    else ownRun.delete(key)
    save({ ...prior, run, runRequest: null })
    return true
  }
  /*
   * The mark for the pause is set BEFORE the late-frame check: the kernel
   * spent its time on this person regardless of whether they managed to
   * rewrite the sheet during the minute of waiting. Otherwise the pause would
   * be lifted by one text edit — that is, by exactly the move people make
   * before a new run.
   */
  if ((run.state === 'ok' || run.state === 'error') && ownRun.delete(key)) {
    ownRunEnded.set(key, Date.now())
  }
  if (runFor.get(key) !== prior.text) return false
  save({ ...prior, run })
  return true
}

/**
 * The answer to the AUTHOR. Returns the participantIds of the recipients —
 * control.ts sends them `council:mine`; a list, not a single name, because
 * the recipient may already be gone.
 *
 * Sending to a group of identical solutions is no longer here. It was keyed
 * by the group key (`normalizeAttempt`), that is, by text that matched after
 * throwing out spaces and comments — and the letter "look at the accumulator"
 * reached five people, four of whom had not written that accumulator. It went
 * away together with all of the grouping: the teacher reads the class by
 * name.
 */
export function setReply(
  sessionId: string,
  cellId: string,
  to: { participantId: string },
  reply: CouncilReply,
): string[] {
  const one = attemptOf(sessionId, cellId, to.participantId)
  if (!one) return []
  save({ ...one, replies: keeping(one.replies, { ...reply, to: 'person' }) })
  return [one.participantId]
}

/**
 * An Oracle hint — to whoever asked for it, and in their own attempt.
 *
 * A separate function from `setReply`, not a flag in it: that one sets `to` by
 * the recipient (personal or group) and can fan out, while here the recipient
 * is always one — the author — and there cannot be two kinds of letter. A
 * shared path would cost a branch in each of these three decisions to save
 * four lines.
 *
 * Stored in the same place as the teacher's letters, and for the same reason:
 * it is a conversation about THIS attempt, it survives a reload and is
 * visible to exactly two people.
 */
export function setHint(
  sessionId: string,
  cellId: string,
  participantId: string,
  hint: CouncilReply,
): boolean {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (!prior) return false
  save({ ...prior, replies: keeping(prior.replies, { ...hint, to: 'oracle' }) })
  return true
}

/** Personal, group or hint — this is how letters are told apart in storage. */
function kindOf(reply: CouncilReply): 'person' | 'group' | 'oracle' {
  // A letter written before `to` appeared counts as personal: keeping too much
  // is cheaper than losing what is needed.
  if (reply.to === 'group') return 'group'
  if (reply.to === 'oracle') return 'oracle'
  return 'person'
}

/**
 * A new letter goes into ITS OWN place: personal to personal, group to group.
 *
 * The attempt had one `reply` field, and writing on top was a silent loss:
 * you answered Petya "Check the sign", a minute later sent the Oracle's draft
 * to the whole group — and the personal line vanished, whether he had read it
 * or not. It is no longer on the console or with the student, and there is
 * nothing to bring it back with: attempts have no version history.
 *
 * Gluing the texts together did not close this hole: the very next letter to
 * the same group landed on top of the glued text and carried the personal one
 * away with it — and a correction following a group message is common. So
 * there are two letters, each in its own slot: a replacement overwrites only
 * the same kind — personal over personal means the teacher rewrote their own
 * letter to one person, group over group means they rewrote the group
 * message. There are never more than two here, and the order is the order of
 * sending: that is how they are read.
 */
function keeping(prior: readonly CouncilReply[], next: CouncilReply): CouncilReply[] {
  const kind = kindOf(next)
  return [...prior.filter((one) => kindOf(one) !== kind), next]
}

/**
 * The letters as one line — for clients that do not know about `replies` yet.
 *
 * The caption and the time are those of the last letter: it is what the
 * teacher has just said. The texts go in the order of sending, with an empty
 * line between them: in one paragraph this is worse than two lines, but
 * better than a lost personal answer.
 */
function mergeReplies(replies: readonly CouncilReply[]): CouncilReply | null {
  const last = replies[replies.length - 1]
  if (!last) return null
  if (replies.length === 1) return last
  return { ...last, text: replies.map((one) => one.text).join('\n\n') }
}

export function setMark(
  sessionId: string,
  cellId: string,
  participantId: string,
  correct: boolean | null,
): void {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (!prior || prior.correct === correct) return
  save({ ...prior, correct })
}

/**
 * The variant number in a cell — by submission time, ties broken by
 * identifier.
 *
 * Needed as a caption when names on the projector are turned off: "Answer 12"
 * instead of "Anya Sokolova". Computed ONCE — at showing (`setShown` puts it
 * into `shownNo`), and from then on it lives as a number: the submission
 * order changes under other people's hands (submitted, changed their mind,
 * submitted again), and otherwise the number on the projector would move
 * while the class is looking at it.
 *
 * Those still writing are ordered by identifier and end up at the tail: they
 * have no submission time, but a shown attempt needs a number in any case —
 * the teacher is free to put an unsubmitted one on screen too.
 */
function variantOf(attempts: readonly StoredAttempt[], participantId: string): number {
  const order = [...attempts].sort((a, b) => {
    const left = a.submittedAt
    const right = b.submittedAt
    if (left !== null && right !== null) return left - right || a.participantId.localeCompare(b.participantId)
    if (left !== null) return -1
    if (right !== null) return 1
    return a.participantId.localeCompare(b.participantId)
  })
  return order.findIndex((attempt) => attempt.participantId === participantId) + 1
}

/**
 * "Show the class" — a mark on the attempt, and nothing more.
 *
 * The shared text of the cell is not touched: showing is a link to someone's
 * attempt (shared/protocol.ts · CouncilShown), not a swap. The second half of
 * the swap used to stand here, and there was nothing to undo it with.
 *
 * One variant is on screen: the mark is taken off whoever was shown before.
 * `participantId: null` means "take off the screen": it is removed from
 * everyone. Returns whose mark changed (including the new one) — they need
 * `council:mine`.
 */
export function setShown(
  sessionId: string,
  cellId: string,
  participantId: string | null,
  by: string | null,
  at: number,
): string[] {
  const attempts = attemptsOf(sessionId, cellId)
  const no = participantId === null ? null : variantOf(attempts, participantId)
  const changed: string[] = []
  for (const attempt of attempts) {
    const shown = attempt.participantId === participantId
    const next = shown
      ? { shown, shownBy: by, shownAt: at, shownNo: no }
      : { shown, shownBy: null, shownAt: null, shownNo: null }
    if (
      attempt.shown === next.shown &&
      attempt.shownBy === next.shownBy &&
      attempt.shownAt === next.shownAt &&
      attempt.shownNo === next.shownNo
    ) {
      continue
    }
    save({ ...attempt, ...next })
    changed.push(attempt.participantId)
  }
  return changed
}

/* ------------------------------------------------------- ban and removal */

/**
 * Remove everything of this person — from all council cells of the room.
 * Called from routes/bans.ts next to purgeQuestions. Returns how many were
 * removed.
 */
export function purgeAttempts(sessionId: string, participantId: string): number {
  const room = roomOf(sessionId)
  let gone = 0
  for (const [cellId, cell] of room.cells) {
    if (cell.delete(participantId)) gone++
    // There is no row — so a run frame has nowhere to land either: the
    // fingerprint can be forgotten along with it. control.ts removes the entry
    // in the kernel queue itself. The pause until the next run goes too: the
    // person is no longer in the room, and coming back after the ban is lifted
    // they start with a clean slate.
    const key = runKey(sessionId, cellId, participantId)
    runFor.delete(key)
    ownRun.delete(key)
    ownRunEnded.delete(key)
  }
  deleteOfPerson.run(sessionId, participantId)
  return gone
}

/** The room was torn down — together with its attempts and Oracle summaries. */
export function discardCouncil(sessionId: string): void {
  /*
   * A reading in progress is cut off HERE, not left to finish.
   *
   * The summary Oracle lives in memory (ai/council.ts · reading), and the
   * answer to a question asked a minute before the seminar was torn down
   * arrived in `setOracle` — which created the room's cache anew and did an
   * INSERT into `council_oracle` for a session that no longer exists. A row of
   * a deleted seminar was resurrected out of nowhere and lay there until the
   * next teardown.
   */
  stopRoomOracles(sessionId)
  cache.delete(sessionId)
  const prefix = `${sessionId}\u0000`
  for (const key of runFor.keys()) if (key.startsWith(prefix)) runFor.delete(key)
  for (const key of ownRun) if (key.startsWith(prefix)) ownRun.delete(key)
  for (const key of ownRunEnded.keys()) if (key.startsWith(prefix)) ownRunEnded.delete(key)
  deleteOfRoom.run(sessionId)
  deleteOraclesOfRoom.run(sessionId)
  deleteSeedsOfRoom.run(sessionId)
}

/* ----------------------------------------------------------- snapshots */

/**
 * The state in one word — a shared function for the console, the server and
 * the Oracle (protocol.ts · attemptStatus). This used to hold its own copy of
 * the same rule.
 */
function statusOf(attempt: StoredAttempt): CouncilStatus {
  return attemptStatus(attempt)
}

/**
 * What the author sees. `closed` means the council on the cell is not running
 * now (`cellLock(cell) !== 'council'`); control.ts reads the cell, not this
 * module. `null` means there is no attempt and the council is closed: there is
 * nothing to say.
 *
 * `queue` is the place in the run queue if the attempt is waiting; the kernel
 * knows it, and control.ts passes it here so that the snapshot is assembled
 * in one place. `pauseSec` is the knob for the pause between runs on the same
 * cell, and it comes from the same place for the same reason: control.ts
 * reads the cell.
 *
 * `seed` is the task (`rememberSeed`), and it travels in BOTH branches. In the
 * first, it is what all of this was written for: a blank sheet is seeded with
 * the task, not with whatever the cell holds now. In the second — for the
 * case when the person's sheet has not been created yet but the attempt
 * already exists (they reloaded the page, came in from a second device). No
 * task row — no field at all: an empty string means "the council was opened
 * on an empty cell", absence means "an old server", and the client seeds the
 * old way.
 */
export function mineFor(
  sessionId: string,
  cellId: string,
  participantId: string,
  closed: boolean,
  queue: number | null = null,
  pauseSec = 0,
): CouncilMine | null {
  const attempt = attemptOf(sessionId, cellId, participantId)
  const seed = seedOf(sessionId, cellId)
  const task = seed === null ? {} : { seed }
  /*
   * The countdown to the next run is a field, not a right: the server holds
   * the right itself and will refuse without any field. This is so that a
   * countdown stands in place of the button, rather than a button that
   * answers with a refusal. No pause — no field: an empty string in each of
   * five hundred sheets on every frame tells nothing.
   */
  const nextRunAt = nextRunAtFor(sessionId, cellId, participantId, pauseSec)
  const wait = nextRunAt === null ? {} : { nextRunAt }
  if (!attempt) {
    if (closed) return null
    // The council is open, but there is no attempt yet: a blank sheet, so that
    // the client knows it may write and shows nothing as "submitted".
    return {
      text: '',
      submittedAt: null,
      updatedAt: 0,
      shown: false,
      correct: null,
      reply: null,
      replies: [],
      run: null,
      queue: null,
      closed,
      ...task,
      ...wait,
    }
  }
  return {
    text: attempt.text,
    submittedAt: attempt.submittedAt,
    updatedAt: attempt.updatedAt,
    shown: attempt.shown,
    correct: attempt.correct,
    // Both kinds side by side: glued for old clients, separate letters for
    // new ones.
    reply: mergeReplies(attempt.replies),
    replies: attempt.replies,
    run: attempt.run,
    ...(attempt.runRequest ? { runRequest: attempt.runRequest } : {}),
    queue,
    closed,
    ...task,
    ...wait,
  }
}

function toAttempt(attempt: StoredAttempt): CouncilAttempt {
  let name = 'Someone'
  let color = '#888888'
  let avatar: string | null = null
  try {
    const participant = getParticipant(attempt.sessionId, attempt.participantId)
    if (participant) {
      name = participant.name || name
      color = participant.color || color
      avatar = participant.avatar
    }
  } catch {
    /* no participant row — a card without a name is better than no card */
  }
  return {
    participantId: attempt.participantId,
    name,
    color,
    avatar,
    text: attempt.text,
    submittedAt: attempt.submittedAt,
    updatedAt: attempt.updatedAt,
    status: statusOf(attempt),
    run: attempt.run,
    ...(attempt.runRequest ? { runRequest: attempt.runRequest } : {}),
    reply: mergeReplies(attempt.replies),
    replies: attempt.replies,
    correct: attempt.correct,
    shown: attempt.shown,
    groupKey: attempt.groupKey,
  }
}

/**
 * Groups of identical solutions — a shared function
 * (protocol.ts · groupAttempts).
 *
 * A third copy of it used to lie here: its own tie-break, its own order and
 * an `attempts.find` inside the comparator. The console and the Oracle
 * computed the same thing slightly differently, and one day that would have
 * given them different representatives of the same group.
 */
function groupsOf(attempts: CouncilAttempt[]): CouncilGroup[] {
  return groupAttempts(attempts)
}

/**
 * One attempt through the teacher's eyes — for `council:patch`. `null` means
 * it is gone.
 */
export function attemptFor(
  sessionId: string,
  cellId: string,
  participantId: string,
): CouncilAttempt | null {
  const attempt = attemptOf(sessionId, cellId, participantId)
  return attempt ? toAttempt(attempt) : null
}

function countsOf(attempts: CouncilAttempt[], groups: number): CouncilBoard['counts'] {
  const submitted = attempts.filter((a) => a.submittedAt !== null).length
  return { attempts: attempts.length, submitted, writing: attempts.length - submitted, groups }
}

/**
 * The mode bar's numbers without the pile itself — what travels with every
 * `council:patch`.
 *
 * Counted from the rows, not from the assembled pile. The old code called
 * `toAttempt` for every attempt — that is, a participant SELECT in SQLite and
 * character-by-character normalization of the whole text — then put groups
 * together with sorting; and all of that three times a second per cell while
 * the class types, for the sake of four numbers that have neither names nor
 * colours. On five hundred attempts that is fifteen hundred queries and
 * megabytes of traversal per second in the same event loop as the sync
 * frames.
 */
export function countsFor(sessionId: string, cellId: string): CouncilBoard['counts'] {
  let attempts = 0
  let submitted = 0
  const keys = new Set<string>()
  for (const attempt of attemptsOf(sessionId, cellId)) {
    attempts += 1
    if (attempt.submittedAt === null) continue
    submitted += 1
    keys.add(attempt.groupKey)
  }
  return { attempts, submitted, writing: attempts - submitted, groups: keys.size }
}

/**
 * The whole pile for the teacher. Names, colours and avatars come from
 * participants (db.ts · getParticipant); groups are by `normalizeAttempt`
 * among submitted ones only; `lock` and `settings` are given by control.ts
 * from outside, because it is the one that reads the cell.
 */
export function boardFor(
  sessionId: string,
  cellId: string,
  cell: Pick<CouncilBoard, 'lock' | 'settings'>,
): CouncilBoard {
  const attempts = attemptsOf(sessionId, cellId)
    .map(toAttempt)
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const oracle = oracleOf(sessionId, cellId)
  // No captions from the Oracle: it no longer names groups — that was removed
  // together with the grouping itself, and the pile is now captioned by the
  // first line of code.
  const groups = groupsOf(attempts)
  return {
    lock: cell.lock,
    settings: cell.settings,
    counts: countsOf(attempts, groups.length),
    attempts,
    groups,
    oracle,
  }
}

/**
 * What is on screen for this cell right now — a frame for the whole room.
 *
 * `null` means nothing is shown (or the shown attempt was carried off: the
 * author rewrote the text, the author was banned). A cell has one shown
 * attempt: `setShown` takes the mark off all the others, and `find` here is
 * that one.
 *
 * `names` is the cell's `namesOnProjector` knob. When it is off there is no
 * name, colour or avatar in the frame AT ALL, and the variant number is the
 * caption: a name that has reached someone else's browser counts as shown,
 * and "it arrived, but we do not draw it" holds exactly until the first F12.
 *
 * The output is only the teacher's and only a finished one: under the code on
 * screen the class reads what the presenter answers for. The author's own run
 * stays on their sheet, and a stopwatch in the middle of someone's run on the
 * projector is of no use to anyone.
 */
export function shownFor(sessionId: string, cellId: string, names: boolean): CouncilShown | null {
  const attempts = attemptsOf(sessionId, cellId)
  const shown = attempts.find((attempt) => attempt.shown)
  if (!shown) return null
  const card = toAttempt(shown)
  const run = shown.run
  let by: string | null = null
  if (shown.shownBy !== null) {
    try {
      by = getParticipant(sessionId, shown.shownBy)?.name ?? null
    } catch {
      /* no participant row — a badge without a caption is better than no badge */
    }
  }
  return {
    participantId: shown.participantId,
    // Shown before numbers appeared (or in a room that survived an update) —
    // compute it now: a caption without a number is worse than a number by
    // the current order.
    variant: shown.shownNo ?? variantOf(attempts, shown.participantId),
    name: names ? card.name : null,
    color: names ? card.color : null,
    avatar: names ? card.avatar : null,
    shownBy: by,
    shownAt: shown.shownAt,
    text: shown.text,
    run: run && run.by === 'host' && (run.state === 'ok' || run.state === 'error') ? run : null,
    // "K more wrote the same" — among SUBMITTED ones and without the author:
    // the number under the caption answers "is this one of a kind or half the
    // class".
    alsoWrote: attempts.filter(
      (attempt) =>
        attempt.participantId !== shown.participantId &&
        attempt.submittedAt !== null &&
        attempt.groupKey === shown.groupKey,
    ).length,
    correct: shown.correct,
  }
}

/** "N of M submitted" — for `council:count` to the whole room. */
export function countFor(sessionId: string, cellId: string): { submitted: number; total: number } {
  const attempts = attemptsOf(sessionId, cellId)
  return {
    submitted: attempts.filter((a) => a.submittedAt !== null).length,
    total: attempts.length,
  }
}

/* ------------------------------------------------------------- oracle */

export function oracleOf(sessionId: string, cellId: string): CouncilOracle | null {
  return roomOf(sessionId).oracles.get(cellId) ?? null
}

export function setOracle(sessionId: string, cellId: string, oracle: CouncilOracle): void {
  /*
   * A second lock on the same door as `stopRoomOracles` in `discardCouncil`.
   *
   * Cutting off the reading is about there being no answer; this is about
   * even an answer that did arrive not creating the room anew. Between the
   * two actions there is always a one-tick gap, and `roomOf` creates a room's
   * cache at the mere mention of its name. No seminar — nowhere to write, and
   * that is not an error: the answer was simply late.
   */
  if (!getSession(sessionId)) return
  roomOf(sessionId).oracles.set(cellId, oracle)
  upsertOracle.run(sessionId, cellId, JSON.stringify(oracle))
}

/* ---------------------------------------------------------------- task */

/**
 * The cell's task — the shared text at the second the lock was switched to
 * council.
 *
 * Called from control.ts (`cell:lock`) EXACTLY on the switch to council, not
 * on every press: a repeated `cell:lock` to the same position is a knob
 * toggle, and it must not rewrite the task. After "Show the class" the cell's
 * shared text is already someone's solution, and a "task" written over it
 * would become that very solution; a latecomer would get someone else's
 * answer in their sheet and submit it as their own with one click
 * (shared/protocol.ts · CouncilMine.seed).
 *
 * An empty string is a legitimate value: the council was opened on an empty
 * cell, and everyone's sheet is empty.
 */
export function rememberSeed(sessionId: string, cellId: string, text: string): void {
  roomOf(sessionId).seeds.set(cellId, text)
  upsertSeed.run(sessionId, cellId, text)
}

/** The cell's task, or `null` — the council was opened before tasks were remembered. */
export function seedOf(sessionId: string, cellId: string): string | null {
  return roomOf(sessionId).seeds.get(cellId) ?? null
}
