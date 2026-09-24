/**
 * Competitions: tables and queries over them.
 *
 * THE SCHEMA IS HERE, and it has one owner. These are not shared product
 * tables: no other module writes to them or adds columns to them, so the
 * `CREATE TABLE` sits next to the only queries — unlike `sessions`, which
 * three parties edit, and so its schema lives in `db.ts` (see the header of
 * publish/store.ts, where this boundary is drawn out loud).
 *
 * WHAT IS HERE AND WHAT IS NOT. Here are the rows: competitions, their files,
 * the instance's participants, submissions, runs and the queue. The rules are
 * in `@shared/competitions`, and this module CALLS them rather than repeating
 * them: how many submissions are left today and which one counts, the web and
 * the server must compute identically. The disk is in `storage.ts`; from here
 * there is one call to it, deleting a competition, and it is deliberately not
 * quiet.
 *
 * THE QUEUE is instance-level and in the database, not in process memory. A
 * class period lasts an hour and a half, submissions pile up all that time,
 * and `npm run build` on the server or a process crash must not mean "thirty
 * people submitted into the void". So the queue row holds everything needed
 * to pick the work up again: whose run it is, what kind, how many times it
 * has already started, which container it runs in and — most importantly —
 * which LIFE OF THE PROCESS started it (`boot`). A "running" row marked with
 * another life is an orphaned run: the container is gone, and nobody but
 * `orphanedRuns` will find out.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { entrantKeyDigest, newEntrantKey, sealEntrantKey, unsealEntrantKey } from './key.js'
import { removeCompetition as removeCompetitionFiles, pruneSubmissions } from './storage.js'
import {
  boardOf,
  countsTowardDailyQuota,
  dayStart,
  entrantNameKey,
  LIMITS,
  submissionsLeftToday,
  type BoardEntry,
  type Competition,
  type CompetitionFile,
  type CompetitionState,
  type Entrant,
  type FileVisibility,
  type MintedEntrant,
  type MetricDirection,
  type PrivateRelease,
  type RankedRow,
  type RunKind,
  type RunVerdict,
  type ScoringRule,
  type Submission,
  type SubmissionRun,
  type SubmissionStage,
  type SubmissionState,
} from '@shared/competitions'

/* ----------------------------------------------------------------- schema */

/**
 * The participant key moved from a column to a fingerprint — BEFORE the
 * schema is read.
 *
 * For anyone who ran this branch earlier, `entrants` was created with a
 * `link_key` column that holds the key as is. `CREATE TABLE IF NOT EXISTS`
 * knows nothing about this and stays silent, and right after it comes
 * `CREATE UNIQUE INDEX … (key_hash)` — on a column that table does not have,
 * that is, a failure on module import and a server that does not come up at
 * all. Hence the placement: before the schema.
 *
 * The rows survive the move: keys people have already written down keep
 * working — their fingerprint is computed and a sealed copy is made. The old
 * column is emptied in the same transaction, because that is exactly what the
 * whole exercise is about.
 */
function liftEntrantKeys(): void {
  const columns = db.prepare('PRAGMA table_info(entrants)').all() as { name: string }[]
  // No table at all — the schema below will create it, already correct.
  if (columns.length === 0 || columns.some((column) => column.name === 'key_hash')) return
  db.exec("ALTER TABLE entrants ADD COLUMN key_hash TEXT NOT NULL DEFAULT ''")
  db.exec("ALTER TABLE entrants ADD COLUMN key_sealed TEXT NOT NULL DEFAULT ''")
  // The old index carries the same name and sits on the old column; the
  // `IF NOT EXISTS` below would see it and leave the uniqueness where it no
  // longer is.
  db.exec('DROP INDEX IF EXISTS entrants_key')
  const rows = db.prepare('SELECT id, link_key FROM entrants').all() as {
    id: string
    link_key: string
  }[]
  const write = db.prepare("UPDATE entrants SET key_hash = ?, key_sealed = ?, link_key = '' WHERE id = ?")
  db.transaction(() => {
    for (const row of rows) {
      write.run(entrantKeyDigest(row.link_key), sealEntrantKey(row.link_key), row.id)
    }
  })()
  try {
    db.exec('ALTER TABLE entrants DROP COLUMN link_key')
  } catch {
    // SQLite older than 3.35 cannot drop columns. The column is already
    // empty, and that is what matters.
  }
}
liftEntrantKeys()

db.exec(`
  CREATE TABLE IF NOT EXISTS competitions (
    id                     TEXT PRIMARY KEY,
    slug                   TEXT NOT NULL,
    title                  TEXT NOT NULL,
    blurb                  TEXT NOT NULL DEFAULT '',
    description            TEXT NOT NULL DEFAULT '',
    state                  TEXT NOT NULL DEFAULT 'draft',
    metric_name            TEXT NOT NULL DEFAULT '',
    metric_direction       TEXT NOT NULL DEFAULT 'lower',
    metric_code            TEXT NOT NULL DEFAULT '',
    public_percent         INTEGER NOT NULL DEFAULT 30,
    /*
     * The row-split seed, written at creation and never changed afterwards.
     * Regenerating it means changing which rows were public — that is,
     * making yesterday's leaderboard incomparable with today's.
     */
    split_seed             TEXT NOT NULL,
    wall_seconds           INTEGER NOT NULL DEFAULT 600,
    memory_mb              INTEGER NOT NULL DEFAULT 4096,
    cpus                   INTEGER NOT NULL DEFAULT 2,
    per_day                INTEGER NOT NULL DEFAULT 5,
    environment            TEXT NOT NULL DEFAULT 'base',
    starts_at              INTEGER,
    deadline_at            INTEGER,
    private_release        TEXT NOT NULL DEFAULT 'auto',
    scoring                TEXT NOT NULL DEFAULT 'chosen',
    private_opened_at      INTEGER,
    baseline_submission_id TEXT,
    created_by             TEXT,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  );
  /* The /k/<slug> address: the database holds uniqueness, not a pre-insert check. */
  CREATE UNIQUE INDEX IF NOT EXISTS competitions_slug ON competitions(slug);

  /*
   * Competition files — a row per file, the bytes on disk (storage.ts).
   *
   * Visibility as a column rather than two tables: the participant's list and
   * the teacher's list are the same query with a different WHERE, and if you
   * split the table in two, one day you will get answers added to the open
   * list.
   */
  CREATE TABLE IF NOT EXISTS competition_files (
    competition_id TEXT NOT NULL,
    name           TEXT NOT NULL,
    bytes          INTEGER NOT NULL,
    row_count      INTEGER,
    visibility     TEXT NOT NULL,
    uploaded_at    INTEGER NOT NULL,
    PRIMARY KEY (competition_id, name)
  );
  CREATE INDEX IF NOT EXISTS competition_files_of
    ON competition_files(competition_id, visibility);

  /*
   * A competition participant — INSTANCE-level, not room-level.
   *
   * A student's identity in a class is bound to session_id and lives in the
   * browser's localStorage: come in from a phone and you are a different
   * person. Submissions and standing must come back from another device, so a
   * separate entity with a sign-in key is created here — exactly the same
   * mechanics as the teachers' personal links.
   */
  CREATE TABLE IF NOT EXISTS entrants (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    /*
     * The key itself is not in any column here — see competitions/key.ts.
     * key_hash finds the person on sign-in and signs their cookie, key_sealed
     * shows the key to its owner on card P1. A leaked database without the
     * instance secret gives away not a single sign-in.
     */
    key_hash     TEXT NOT NULL,
    key_sealed   TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    disabled     INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS entrants_key ON entrants(key_hash);

  /*
   * Who is in which competition — a row of its own, not "sent a submission".
   *
   * Mockup P1 tells "taking part" apart from "not taking part yet" BEFORE the
   * first submission: the "JOIN" button puts the person into the table, and
   * only after that do they get an upload area. The second reason the table is
   * needed is name uniqueness: there must be no namesakes on the leaderboard,
   * and only a unique index can hold that rule. A check by query would let
   * through two people who pressed "JOIN" in the same second.
   */
  CREATE TABLE IF NOT EXISTS competition_entrants (
    competition_id TEXT NOT NULL,
    entrant_id     TEXT NOT NULL,
    /** The name reduced to the form in which namesakes are compared (@shared). */
    name_key       TEXT NOT NULL,
    joined_at      INTEGER NOT NULL,
    PRIMARY KEY (competition_id, entrant_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS competition_entrants_name
    ON competition_entrants(competition_id, name_key);

  CREATE TABLE IF NOT EXISTS submissions (
    id                TEXT PRIMARY KEY,
    competition_id    TEXT NOT NULL,
    entrant_id        TEXT NOT NULL,
    number            INTEGER NOT NULL,
    file_name         TEXT NOT NULL,
    bytes             INTEGER NOT NULL DEFAULT 0,
    accepted_at       INTEGER NOT NULL,
    state             TEXT NOT NULL,
    stage             TEXT NOT NULL,
    public_score      REAL,
    private_score     REAL,
    duration_ms       INTEGER,
    cells_done        INTEGER NOT NULL DEFAULT 0,
    cells_total       INTEGER NOT NULL DEFAULT 0,
    participant_error TEXT,
    teacher_error     TEXT,
    chosen            INTEGER NOT NULL DEFAULT 0
  );
  /* "#12" — the number within a competition, and there cannot be two alike. */
  CREATE UNIQUE INDEX IF NOT EXISTS submissions_number
    ON submissions(competition_id, number);
  /* "My submissions" and the daily quota count — one and the same reading order. */
  CREATE INDEX IF NOT EXISTS submissions_mine
    ON submissions(competition_id, entrant_id, accepted_at);
  /* The leaderboard reads only those that reached a number, right in score order. */
  CREATE INDEX IF NOT EXISTS submissions_board
    ON submissions(competition_id, state, public_score);

  /*
   * A run is one trip into a container, and a submission has several.
   *
   * For the one thing the mockup promises: "after a metric fix everything is
   * rescored without executing the notebooks again". Rescoring creates a new
   * run of kind metric next to the earlier notebook one, and the notebook is
   * not started a second time.
   */
  CREATE TABLE IF NOT EXISTS submission_runs (
    id                TEXT PRIMARY KEY,
    submission_id     TEXT NOT NULL,
    seq               INTEGER NOT NULL,
    kind              TEXT NOT NULL,
    started_at        INTEGER NOT NULL,
    finished_at       INTEGER,
    verdict           TEXT,
    container         TEXT,
    exit_code         INTEGER,
    oom               INTEGER NOT NULL DEFAULT 0,
    cells_done        INTEGER NOT NULL DEFAULT 0,
    cells_total       INTEGER NOT NULL DEFAULT 0,
    public_score      REAL,
    private_score     REAL,
    participant_error TEXT,
    teacher_error     TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS submission_runs_seq
    ON submission_runs(submission_id, seq);

  /*
   * The execution queue — one per instance.
   *
   * In the database, not in memory: a server restart in the middle of a class
   * period must not mean "thirty submissions vanished". The boot column names
   * the life of the process that started the run — by it and only by it is
   * orphaned work visible. The container name lies next to it, so that there
   * is something to kill: the container outlives the process that started it.
   */
  CREATE TABLE IF NOT EXISTS competition_queue (
    submission_id  TEXT PRIMARY KEY,
    competition_id TEXT NOT NULL,
    entrant_id     TEXT NOT NULL,
    kind           TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'waiting',
    enqueued_at    INTEGER NOT NULL,
    started_at     INTEGER,
    attempts       INTEGER NOT NULL DEFAULT 0,
    resource_retries INTEGER NOT NULL DEFAULT 0,
    not_before     INTEGER NOT NULL DEFAULT 0,
    /*
     * Which attempt of THIS person it is — computed at enqueue time and never
     * changed afterwards. The column exists for its sake: without it "fair per
     * person" would rest on the other submission still being visible in the
     * queue, and would fall apart the very second the same person's previous
     * work left the queue (see the selection order below).
     */
    turn           INTEGER NOT NULL DEFAULT 0,
    boot           TEXT,
    container      TEXT
  );
  CREATE INDEX IF NOT EXISTS competition_queue_order
    ON competition_queue(state, enqueued_at);
  CREATE INDEX IF NOT EXISTS competition_queue_person
    ON competition_queue(entrant_id, state);

  /*
   * The queue pause — one row per instance.
   *
   * A table of its own, not a key in instance_settings: that one is created by
   * admin/settings, and a second owner of someone else's schema is exactly
   * what this code avoids (see the header). There is exactly one row, and
   * CHECK says so, not a convention.
   */
  CREATE TABLE IF NOT EXISTS competition_queue_state (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    paused    INTEGER NOT NULL DEFAULT 0,
    paused_at INTEGER,
    paused_by TEXT
  );
  INSERT OR IGNORE INTO competition_queue_state (id, paused) VALUES (1, 0);
`)

/**
 * A column that does not exist yet. SQLite has no ADD COLUMN IF NOT EXISTS,
 * and the tables above may already have been created by someone who updated
 * a day earlier. The same function lives in db.ts and routes/admin-instance.ts
 * for the same reason.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}
/**
 * Which attempt of the person it is — appeared later than the queue itself.
 *
 * For anyone who ran this branch earlier, the table was already created
 * without it, and `CREATE TABLE IF NOT EXISTS` does not know about the new
 * column. Zero by default means "all earlier rows are equal", that is, the
 * queue works on them the way it did before per-person fairness appeared —
 * and the very first new submission gets a real attempt number.
 */
ensureColumn('competition_queue', 'turn', 'turn INTEGER NOT NULL DEFAULT 0')
ensureColumn('competition_queue', 'attempt_id', 'attempt_id TEXT')
ensureColumn('competition_queue', 'pending_kind', 'pending_kind TEXT')
ensureColumn('competition_queue', 'resource_retries', 'resource_retries INTEGER NOT NULL DEFAULT 0')
ensureColumn('competition_queue', 'not_before', 'not_before INTEGER NOT NULL DEFAULT 0')

// Revisions are durable database state, so direct runner/queue mutations cannot
// bypass the live feed invalidation contract. Legacy scores have unknown inputs
// and must be checked again before a draft can open.
ensureColumn('competitions', 'revision', 'revision INTEGER NOT NULL DEFAULT 0')
ensureColumn('competitions', 'input_revision', 'input_revision INTEGER NOT NULL DEFAULT 0')
ensureColumn('competitions', 'baseline_entrant_id', 'baseline_entrant_id TEXT')
ensureColumn('submissions', 'input_revision', 'input_revision INTEGER')
ensureColumn('competitions', 'notebook_input_revision', 'notebook_input_revision INTEGER NOT NULL DEFAULT 0')
ensureColumn('submissions', 'notebook_input_revision', 'notebook_input_revision INTEGER')
ensureColumn('submission_runs', 'attempt_id', 'attempt_id TEXT')
ensureColumn('submission_runs', 'input_revision', 'input_revision INTEGER')
db.exec(`
  UPDATE competitions SET baseline_entrant_id =
    (SELECT entrant_id FROM submissions WHERE id = baseline_submission_id)
    WHERE baseline_entrant_id IS NULL AND baseline_submission_id IS NOT NULL;
  CREATE TRIGGER IF NOT EXISTS competition_baseline_identity
  AFTER UPDATE OF baseline_submission_id ON competitions
  WHEN NEW.baseline_submission_id IS NOT NULL
  BEGIN
    UPDATE competitions SET baseline_entrant_id = COALESCE(baseline_entrant_id,
      (SELECT entrant_id FROM submissions WHERE id = NEW.baseline_submission_id)) WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS competition_changed AFTER UPDATE ON competitions
  WHEN NEW.revision = OLD.revision
  BEGIN UPDATE competitions SET revision = revision + 1 WHERE id = NEW.id; END;
  CREATE TRIGGER IF NOT EXISTS competition_notebook_inputs_changed
  AFTER UPDATE OF environment, wall_seconds, memory_mb, cpus ON competitions
  WHEN NEW.environment IS NOT OLD.environment OR NEW.wall_seconds IS NOT OLD.wall_seconds
    OR NEW.memory_mb IS NOT OLD.memory_mb OR NEW.cpus IS NOT OLD.cpus
  BEGIN UPDATE competitions SET notebook_input_revision = notebook_input_revision + 1 WHERE id = NEW.id; END;
  CREATE TRIGGER IF NOT EXISTS competition_inputs_changed
  AFTER UPDATE OF metric_code, metric_direction, public_percent, split_seed,
    environment, wall_seconds, memory_mb, cpus ON competitions
  WHEN NEW.metric_code IS NOT OLD.metric_code OR NEW.metric_direction IS NOT OLD.metric_direction
    OR NEW.public_percent IS NOT OLD.public_percent OR NEW.split_seed IS NOT OLD.split_seed
    OR NEW.environment IS NOT OLD.environment OR NEW.wall_seconds IS NOT OLD.wall_seconds
    OR NEW.memory_mb IS NOT OLD.memory_mb OR NEW.cpus IS NOT OLD.cpus
  BEGIN UPDATE competitions SET input_revision = input_revision + 1 WHERE id = NEW.id; END;
`)
for (const table of ['submissions', 'competition_queue', 'competition_entrants', 'competition_files']) {
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW'
    if (table === 'competition_files') db.exec(`CREATE TRIGGER IF NOT EXISTS competition_files_${operation.toLowerCase()}_notebook_revision
      AFTER ${operation} ON competition_files
      WHEN ${operation === 'UPDATE' ? "OLD.visibility = 'open' OR NEW.visibility = 'open'" : `${row}.visibility = 'open'`}
      BEGIN UPDATE competitions SET notebook_input_revision = notebook_input_revision + 1 WHERE id = ${row}.competition_id; END;`)
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()}_revision
      AFTER ${operation} ON ${table}
      BEGIN UPDATE competitions SET revision = revision + 1
        ${table === 'competition_files' ? ', input_revision = input_revision + 1' : ''}
        WHERE id = ${row}.competition_id; END;`)
  }
}

/** Replacing an artifact without a competition_files row (the baseline). */
export function invalidateCompetitionInputs(id: string, notebook = true): void {
  db.prepare('UPDATE competitions SET input_revision = input_revision + 1, notebook_input_revision = notebook_input_revision + ? WHERE id = ?').run(notebook ? 1 : 0, id)
}


/* ------------------------------------------------------------------ names */

/**
 * Eight characters from an alphabet meant to be read aloud — as for seminars
 * and publications. The competition id goes into a path on disk, so its
 * letters were chosen not only for the eyes.
 */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newId(): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)]
  return out
}

/**
 * The life of this process — the mark by which orphaned runs are visible.
 *
 * Random on every start and deliberately not the pid: the system reuses pids,
 * and one unlucky day a dead run's row would look like our own.
 */
export const BOOT = randomUUID()

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

/* ------------------------------------------------------------ competitions */

interface CompetitionRow {
  id: string
  slug: string
  title: string
  blurb: string
  description: string
  state: string
  metric_name: string
  metric_direction: string
  metric_code: string
  public_percent: number
  split_seed: string
  wall_seconds: number
  memory_mb: number
  cpus: number
  per_day: number
  environment: string
  starts_at: number | null
  deadline_at: number | null
  private_release: string
  scoring: string
  private_opened_at: number | null
  baseline_submission_id: string | null
  baseline_entrant_id: string | null
  revision: number
  input_revision: number
  notebook_input_revision: number
  created_by: string | null
  created_at: number
  updated_at: number
}

function toCompetition(row: CompetitionRow): Competition {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    blurb: row.blurb,
    description: row.description,
    state: row.state as CompetitionState,
    metric: {
      name: row.metric_name,
      direction: row.metric_direction as MetricDirection,
      code: row.metric_code,
    },
    publicPercent: row.public_percent,
    splitSeed: row.split_seed,
    limits: {
      wallSeconds: row.wall_seconds,
      memoryMb: row.memory_mb,
      cpus: row.cpus,
      perDay: row.per_day,
    },
    environment: row.environment,
    startsAt: row.starts_at,
    deadlineAt: row.deadline_at,
    privateRelease: row.private_release as PrivateRelease,
    scoring: row.scoring as ScoringRule,
    privateOpenedAt: row.private_opened_at,
    baselineSubmissionId: row.baseline_submission_id,
    baselineEntrantId: row.baseline_entrant_id,
    revision: row.revision,
    inputRevision: row.input_revision,
    notebookInputRevision: row.notebook_input_revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const insertCompetition = db.prepare(`
  INSERT INTO competitions
    (id, slug, title, blurb, description, state, metric_name, metric_direction, metric_code,
     public_percent, split_seed, wall_seconds, memory_mb, cpus, per_day, environment,
     starts_at, deadline_at, private_release, scoring, created_by, created_at, updated_at)
  VALUES
    (@id, @slug, @title, @blurb, @description, 'draft', @metric_name, @metric_direction,
     @metric_code, @public_percent, @split_seed, @wall_seconds, @memory_mb, @cpus, @per_day,
     @environment, @starts_at, @deadline_at, @private_release, @scoring, @created_by, @at, @at)
`)
const selectCompetition = db.prepare('SELECT * FROM competitions WHERE id = ?')
const selectBySlug = db.prepare('SELECT * FROM competitions WHERE slug = ?')
const selectCompetitions = db.prepare('SELECT * FROM competitions ORDER BY created_at DESC')
const selectLiveIds = db.prepare('SELECT id FROM competitions')
const deleteCompetitionRow = db.prepare('DELETE FROM competitions WHERE id = ?')

export interface NewCompetition {
  slug: string
  title: string
  blurb?: string
  description?: string
  metric?: { name?: string; direction?: MetricDirection; code?: string }
  publicPercent?: number
  limits?: Partial<Competition['limits']>
  environment?: string
  startsAt?: number | null
  deadlineAt?: number | null
  privateRelease?: PrivateRelease
  scoring?: ScoringRule
  createdBy?: string | null
}

/**
 * Create a competition. `null` means the address is taken.
 *
 * Whether it is taken is decided by the unique index, not by a SELECT before
 * the insert: two teachers who saved a draft in the same second would both
 * pass the check. A competition is always born a draft — it is opened by a
 * separate action that has something to check (whether the sample notebook
 * went all the way to a number).
 */
export function createCompetition(input: NewCompetition): Competition | null {
  const at = Date.now()
  const id = newId()
  try {
    insertCompetition.run({
      id,
      slug: input.slug,
      title: clip(input.title, LIMITS.title),
      blurb: clip(input.blurb ?? '', LIMITS.blurb),
      description: clip(input.description ?? '', LIMITS.description),
      metric_name: clip(input.metric?.name ?? '', LIMITS.metricName),
      metric_direction: input.metric?.direction ?? 'lower',
      metric_code: clip(input.metric?.code ?? '', LIMITS.metricCode),
      public_percent: input.publicPercent ?? LIMITS.publicPercent.default,
      // The seed is born with the competition and is never touched again.
      split_seed: randomUUID(),
      wall_seconds: input.limits?.wallSeconds ?? LIMITS.wallSeconds.default,
      memory_mb: input.limits?.memoryMb ?? LIMITS.memoryMb.default,
      cpus: input.limits?.cpus ?? LIMITS.cpus.default,
      per_day: input.limits?.perDay ?? LIMITS.perDay.default,
      environment: input.environment ?? 'base',
      starts_at: input.startsAt ?? null,
      deadline_at: input.deadlineAt ?? null,
      private_release: input.privateRelease ?? 'auto',
      scoring: input.scoring ?? 'chosen',
      created_by: input.createdBy ?? null,
      at,
    })
  } catch (error) {
    if (isUniqueViolation(error)) return null
    throw error
  }
  return getCompetition(id)!
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE'
}

export function getCompetition(id: string): Competition | null {
  const row = selectCompetition.get(id) as CompetitionRow | undefined
  return row ? toCompetition(row) : null
}

/** By address or by identifier — the way the `/k/<slug>` link is opened. */
export function findCompetition(slugOrId: string): Competition | null {
  const row = (selectBySlug.get(slugOrId) ?? selectCompetition.get(slugOrId)) as
    | CompetitionRow
    | undefined
  return row ? toCompetition(row) : null
}

export function listCompetitions(): Competition[] {
  return (selectCompetitions.all() as CompetitionRow[]).map(toCompetition)
}

/** The fields the editor edits. Everything not in the patch stays as it was. */
export type CompetitionPatch = Partial<
  Pick<
    Competition,
    | 'slug'
    | 'title'
    | 'blurb'
    | 'description'
    | 'publicPercent'
    | 'environment'
    | 'startsAt'
    | 'deadlineAt'
    | 'privateRelease'
    | 'scoring'
    | 'baselineSubmissionId'
  >
> & { metric?: Partial<CompetitionMetricPatch>; limits?: Partial<Competition['limits']> }

type CompetitionMetricPatch = { name: string; direction: MetricDirection; code: string }

const COLUMN_OF: Record<string, string> = {
  slug: 'slug',
  title: 'title',
  blurb: 'blurb',
  description: 'description',
  publicPercent: 'public_percent',
  environment: 'environment',
  startsAt: 'starts_at',
  deadlineAt: 'deadline_at',
  privateRelease: 'private_release',
  scoring: 'scoring',
  baselineSubmissionId: 'baseline_submission_id',
  'metric.name': 'metric_name',
  'metric.direction': 'metric_direction',
  'metric.code': 'metric_code',
  'limits.wallSeconds': 'wall_seconds',
  'limits.memoryMb': 'memory_mb',
  'limits.cpus': 'cpus',
  'limits.perDay': 'per_day',
}

const CLIP_OF: Record<string, number> = {
  title: LIMITS.title,
  blurb: LIMITS.blurb,
  description: LIMITS.description,
  'metric.name': LIMITS.metricName,
  'metric.code': LIMITS.metricCode,
}

/**
 * Edit a competition. `null` means there is no such competition; `'taken'`
 * means the new address is taken.
 *
 * Assembled as one UPDATE over the fields that arrived: "save everything"
 * would overwrite fields the editor did not show this time — and panel A3
 * does not show the same form as A2.
 */
export function updateCompetition(id: string, patch: CompetitionPatch): Competition | null | 'taken' {
  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'metric' || key === 'limits') {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue !== undefined) flat[`${key}.${inner}`] = innerValue
      }
      continue
    }
    flat[key] = value
  }
  const sets: string[] = []
  const params: Record<string, unknown> = { id, at: Date.now() }
  for (const [key, value] of Object.entries(flat)) {
    const column = COLUMN_OF[key]
    if (!column) continue
    sets.push(`${column} = @${column}`)
    params[column] = CLIP_OF[key] ? clip(value, CLIP_OF[key]) : value
  }
  if (sets.length === 0) return getCompetition(id)
  try {
    const result = db
      .prepare(`UPDATE competitions SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`)
      .run(params)
    if (result.changes === 0) return null
  } catch (error) {
    if (isUniqueViolation(error)) return 'taken'
    throw error
  }
  return getCompetition(id)
}

const updateState = db.prepare(
  'UPDATE competitions SET state = ?, updated_at = ? WHERE id = ?',
)
const openPrivate = db.prepare(
  'UPDATE competitions SET private_opened_at = ?, updated_at = ? WHERE id = ?',
)

export function setCompetitionState(id: string, state: CompetitionState, at = Date.now()): boolean {
  return updateState.run(state, at, id).changes > 0
}

/**
 * Open the private leaderboard by hand.
 *
 * A time, not a flag: "the results were opened at 14:20" is the answer to a
 * question people ask after the review, and there would be nowhere else to
 * keep it.
 */
export function openPrivateBoard(id: string, at = Date.now()): boolean {
  return openPrivate.run(at, at, id).changes > 0
}

/**
 * Delete a competition — with its rows and its disk.
 *
 * The files are removed AFTER the transaction, and deliberately out loud: a
 * directory left behind quietly means the answers of a deleted competition
 * lying on disk for an unlimited time, with nobody to notice.
 */
export function deleteCompetition(id: string): boolean {
  const rows = db.transaction((competitionId: string) => {
    db.prepare(
      `DELETE FROM submission_runs WHERE submission_id IN
         (SELECT id FROM submissions WHERE competition_id = ?)`,
    ).run(competitionId)
    db.prepare('DELETE FROM competition_queue WHERE competition_id = ?').run(competitionId)
    db.prepare('DELETE FROM submissions WHERE competition_id = ?').run(competitionId)
    db.prepare('DELETE FROM competition_files WHERE competition_id = ?').run(competitionId)
    // The participants themselves stay: a person lives on the instance, not
    // in a competition, and their key must still let them into the others.
    db.prepare('DELETE FROM competition_entrants WHERE competition_id = ?').run(competitionId)
    return deleteCompetitionRow.run(competitionId).changes
  })(id)
  if (rows === 0) return false
  removeCompetitionFiles(id)
  return true
}

/** Names of live competitions — the cleanup of orphaned directories asks for them. */
export function liveCompetitionIds(): Set<string> {
  return new Set((selectLiveIds.all() as { id: string }[]).map((row) => row.id))
}

/* ------------------------------------------------------------------ files */

interface FileRow {
  competition_id: string
  name: string
  bytes: number
  row_count: number | null
  visibility: string
  uploaded_at: number
}

function toFile(row: FileRow): CompetitionFile {
  return {
    competitionId: row.competition_id,
    name: row.name,
    bytes: row.bytes,
    rows: row.row_count,
    visibility: row.visibility as FileVisibility,
    uploadedAt: row.uploaded_at,
  }
}

const upsertFile = db.prepare(`
  INSERT INTO competition_files (competition_id, name, bytes, row_count, visibility, uploaded_at)
  VALUES (@competition_id, @name, @bytes, @row_count, @visibility, @uploaded_at)
  ON CONFLICT(competition_id, name) DO UPDATE SET
    bytes = excluded.bytes,
    row_count = excluded.row_count,
    visibility = excluded.visibility,
    uploaded_at = excluded.uploaded_at
`)
const selectFiles = db.prepare(
  'SELECT * FROM competition_files WHERE competition_id = ? ORDER BY name',
)
const selectFilesOf = db.prepare(
  'SELECT * FROM competition_files WHERE competition_id = ? AND visibility = ? ORDER BY name',
)
const selectFile = db.prepare(
  'SELECT * FROM competition_files WHERE competition_id = ? AND name = ?',
)
const deleteFileRow = db.prepare(
  'DELETE FROM competition_files WHERE competition_id = ? AND name = ?',
)
const sumOpenBytes = db.prepare(
  `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM competition_files
   WHERE competition_id = ? AND visibility = 'open'`,
)

export function putFile(input: {
  competitionId: string
  name: string
  bytes: number
  rows?: number | null
  visibility: FileVisibility
  at?: number
}): CompetitionFile {
  const name = clip(input.name, LIMITS.fileName)
  upsertFile.run({
    competition_id: input.competitionId,
    name,
    bytes: input.bytes,
    row_count: input.rows ?? null,
    visibility: input.visibility,
    uploaded_at: input.at ?? Date.now(),
  })
  return toFile(selectFile.get(input.competitionId, name) as FileRow)
}

export function listFiles(id: string, visibility?: FileVisibility): CompetitionFile[] {
  const rows = (
    visibility ? selectFilesOf.all(id, visibility) : selectFiles.all(id)
  ) as FileRow[]
  return rows.map(toFile)
}

export function dropFile(id: string, name: string): boolean {
  return deleteFileRow.run(id, name).changes > 0
}

/** What the open files weigh — against the "up to 200 MB per competition" ceiling. */
export function openFileBytes(id: string): number {
  return (sumOpenBytes.get(id) as { bytes: number }).bytes
}

/* ------------------------------------------------------------ participants */

interface EntrantRow {
  id: string
  name: string
  key_hash: string
  key_sealed: string
  created_at: number
  last_seen_at: number | null
  disabled: number
}

/**
 * Row → record. The record has no key — neither the plain one nor the
 * fingerprint.
 *
 * `Entrant` travels to the browser in the participant list and in a
 * leaderboard row, and a field that is not there cannot be given away by
 * oversight. Whoever needs the key calls `entrantKeyOf` — a door that shows up
 * in grep output.
 */
function toEntrant(row: EntrantRow): Entrant {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    disabled: row.disabled === 1,
  }
}

const insertEntrant = db.prepare(
  'INSERT INTO entrants (id, name, key_hash, key_sealed, created_at) VALUES (?, ?, ?, ?, ?)',
)
const selectEntrant = db.prepare('SELECT * FROM entrants WHERE id = ?')
const selectEntrantByHash = db.prepare('SELECT * FROM entrants WHERE key_hash = ?')
const selectEntrants = db.prepare('SELECT * FROM entrants ORDER BY created_at')
const selectEntrantSecret = db.prepare('SELECT key_hash, key_sealed FROM entrants WHERE id = ?')
const updateEntrantKey = db.prepare(
  'UPDATE entrants SET key_hash = ?, key_sealed = ?, disabled = 0 WHERE id = ?',
)
const updateEntrantSeen = db.prepare('UPDATE entrants SET last_seen_at = ? WHERE id = ?')
const updateEntrantName = db.prepare('UPDATE entrants SET name = ? WHERE id = ?')
const updateEntrantDisabled = db.prepare('UPDATE entrants SET disabled = ? WHERE id = ?')

/**
 * Create a participant with a new key. The key is returned ONCE — from right
 * here.
 *
 * A key collision is practically impossible, but the database checks it, not
 * arithmetic: a retry on the unique index costs one more turn of the loop,
 * while someone else's key handed out silently costs someone's results.
 */
export function createEntrant(name: string): MintedEntrant {
  const at = Date.now()
  const id = newId()
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = newEntrantKey()
    try {
      insertEntrant.run(id, clip(name, LIMITS.entrantName), entrantKeyDigest(key), sealEntrantKey(key), at)
      return { entrant: getEntrant(id)!, key }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }
  throw new Error('Could not mint a unique entrant key')
}

export function getEntrant(id: string): Entrant | null {
  const row = selectEntrant.get(id) as EntrantRow | undefined
  return row ? toEntrant(row) : null
}

/**
 * Who this is — by sign-in key.
 *
 * A disabled key is NOT filtered out here: the refusal "key disabled" and the
 * refusal "no such key" are different words on screen, and only whoever sees
 * the row can tell them apart.
 */
export function entrantByKey(key: string): Entrant | null {
  if (!key) return null
  const row = selectEntrantByHash.get(entrantKeyDigest(key)) as EntrantRow | undefined
  return row ? toEntrant(row) : null
}

export function listEntrants(): Entrant[] {
  return (selectEntrants.all() as EntrantRow[]).map(toEntrant)
}

/**
 * The person's key — unsealed for the "YOUR SIGN-IN KEY" card (P1).
 *
 * The only door that returns the secret from the database, and it is named so
 * that it is visible: the teachers' `linkKeyOf` is built exactly the same way.
 * Two places call it — the answer to the person themselves and the link they
 * copy. `null` means "the instance secret was changed": in that case the key
 * really does not work any more.
 */
export function entrantKeyOf(id: string): string | null {
  const row = selectEntrantSecret.get(id) as { key_hash: string; key_sealed: string } | undefined
  if (!row?.key_sealed) return null
  return unsealEntrantKey(row.key_sealed)
}

/**
 * The key's fingerprint — what the participant's cookie is signed with.
 *
 * The same trick as the panel cookie (`admin/auth.ts` · sign): the
 * fingerprint is part of the signed message, so issuing a new key also cuts
 * off all previous sign-ins — without a sessions table that nobody would clean
 * anyway.
 */
export function entrantKeyHash(id: string): string | null {
  const row = selectEntrantSecret.get(id) as { key_hash: string } | undefined
  return row ? row.key_hash : null
}

/**
 * Issue a new key. The old one stops working that very second — this is the
 * answer to "I lost my key": there is no other way to take back a string that
 * has been handed out.
 */
export function rotateEntrantKey(id: string): MintedEntrant | null {
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = newEntrantKey()
    try {
      if (updateEntrantKey.run(entrantKeyDigest(key), sealEntrantKey(key), id).changes === 0) return null
      return { entrant: getEntrant(id)!, key }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }
  throw new Error('Could not mint a unique entrant key')
}

export function touchEntrant(id: string, at = Date.now()): void {
  updateEntrantSeen.run(at, id)
}

export function renameEntrant(id: string, name: string): boolean {
  return updateEntrantName.run(clip(name, LIMITS.entrantName), id).changes > 0
}

export function setEntrantDisabled(id: string, disabled: boolean): boolean {
  return updateEntrantDisabled.run(disabled ? 1 : 0, id).changes > 0
}

const selectCompetitionEntrants = db.prepare(`
  SELECT e.* FROM entrants e
  WHERE EXISTS (SELECT 1 FROM competition_entrants ce
                WHERE ce.entrant_id = e.id AND ce.competition_id = ?)
     OR EXISTS (SELECT 1 FROM submissions s
                WHERE s.entrant_id = e.id AND s.competition_id = ?)
  ORDER BY e.created_at
`)

/**
 * Who takes part in this competition.
 *
 * Those who joined OR sent at least one submission. The second condition is
 * not overcaution: competitions older than this table (and the runner in
 * tests) create submissions without going through "JOIN", and a person with a
 * submission on the leaderboard is a participant by any count, however you
 * count.
 */
export function listCompetitionEntrants(competitionId: string): Entrant[] {
  return (selectCompetitionEntrants.all(competitionId, competitionId) as EntrantRow[]).map(toEntrant)
}

/* ------------------------------------------------------------------ joining */

const insertEnrollment = db.prepare(`
  INSERT INTO competition_entrants (competition_id, entrant_id, name_key, joined_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(competition_id, entrant_id) DO UPDATE SET name_key = excluded.name_key
`)
const selectEnrollment = db.prepare(
  'SELECT joined_at FROM competition_entrants WHERE competition_id = ? AND entrant_id = ?',
)
const selectMyEnrollments = db.prepare(
  'SELECT competition_id FROM competition_entrants WHERE entrant_id = ?',
)
const updateEnrollmentName = db.prepare(
  'UPDATE competition_entrants SET name_key = ? WHERE entrant_id = ?',
)

/**
 * Join a competition under this name.
 *
 * `'taken'` means a namesake: this competition already has a person with that
 * name, and there would be nothing to tell them apart by on the leaderboard.
 * The unique index decides this, not a query before the insert: two people
 * who pressed "JOIN" in the same second would both pass the check.
 *
 * A person has ONE name per instance, so joining also renames them everywhere
 * — and this is checked by the same index in all their competitions at once.
 * Otherwise "Anna Kim", having renamed herself, would become a namesake of
 * another Anna in a competition she opened a week ago, and the leaderboard
 * would lie where nobody was looking.
 */
const writeEnrollment = db.transaction(
  (competitionId: string, entrantId: string, clipped: string, key: string, at: number): void => {
    updateEntrantName.run(clipped, entrantId)
    updateEnrollmentName.run(key, entrantId)
    insertEnrollment.run(competitionId, entrantId, key, at)
  },
)

export function joinCompetition(
  competitionId: string,
  entrantId: string,
  name: string,
  at = Date.now(),
): 'ok' | 'taken' {
  const clipped = clip(name, LIMITS.entrantName)
  try {
    writeEnrollment(competitionId, entrantId, clipped, entrantNameKey(clipped), at)
    return 'ok'
  } catch (error) {
    /*
     * Caught OUTSIDE the transaction on purpose: better-sqlite3 rolls it back
     * only if the function threw. A refusal caught inside would give "taken"
     * and a commit at the same time — that is, a person renamed by a refusal,
     * which is what happened in the first version of this code.
     */
    if (isUniqueViolation(error)) return 'taken'
    throw error
  }
}

/** Whether the person has joined — and when. `null` means "not yet". */
export function joinedAt(competitionId: string, entrantId: string): number | null {
  const row = selectEnrollment.get(competitionId, entrantId) as { joined_at: number } | undefined
  return row ? row.joined_at : null
}

/** Which competitions the person belongs to — for the "Taking part" list (P1). */
export function myCompetitionIds(entrantId: string): Set<string> {
  const rows = selectMyEnrollments.all(entrantId) as { competition_id: string }[]
  return new Set(rows.map((row) => row.competition_id))
}

/* ------------------------------------------------------------ submissions */

interface SubmissionRow {
  id: string
  competition_id: string
  entrant_id: string
  number: number
  file_name: string
  bytes: number
  accepted_at: number
  state: string
  stage: string
  public_score: number | null
  private_score: number | null
  duration_ms: number | null
  cells_done: number
  cells_total: number
  participant_error: string | null
  teacher_error: string | null
  chosen: number
  input_revision: number | null
  notebook_input_revision: number | null
}

function toSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    competitionId: row.competition_id,
    entrantId: row.entrant_id,
    number: row.number,
    fileName: row.file_name,
    bytes: row.bytes,
    acceptedAt: row.accepted_at,
    state: row.state as SubmissionState,
    stage: row.stage as SubmissionStage,
    publicScore: row.public_score,
    privateScore: row.private_score,
    durationMs: row.duration_ms,
    cellsDone: row.cells_done,
    cellsTotal: row.cells_total,
    participantError: row.participant_error,
    teacherError: row.teacher_error,
    chosen: row.chosen === 1,
    inputRevision: row.input_revision,
    notebookInputRevision: row.notebook_input_revision,
  }
}

const insertSubmission = db.prepare(`
  INSERT INTO submissions
    (id, competition_id, entrant_id, number, file_name, bytes, accepted_at, state, stage, input_revision, notebook_input_revision)
  VALUES (@id, @competition_id, @entrant_id, @number, @file_name, @bytes, @at, 'queued', 'accepted',
    (SELECT input_revision FROM competitions WHERE id = @competition_id),
    (SELECT notebook_input_revision FROM competitions WHERE id = @competition_id))
`)
const nextNumber = db.prepare(
  'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM submissions WHERE competition_id = ?',
)
const selectSubmission = db.prepare('SELECT * FROM submissions WHERE id = ?')
const selectSubmissions = db.prepare(
  'SELECT * FROM submissions WHERE competition_id = ? ORDER BY accepted_at DESC, number DESC',
)
const selectMine = db.prepare(
  `SELECT * FROM submissions WHERE competition_id = ? AND entrant_id = ?
   ORDER BY accepted_at DESC, number DESC`,
)
const selectSince = db.prepare(
  `SELECT accepted_at, state, cells_done FROM submissions
   WHERE competition_id = ? AND entrant_id = ? AND accepted_at >= ?`,
)
/**
 * Which attempt of this person it is — as many of their works as are already
 * in the queue.
 *
 * Computed once, at enqueue time, and that is the whole point: the queue must
 * remember that the person already occupied the executor AFTER that work has
 * left it.
 */
const TURN = `(SELECT COUNT(*) FROM competition_queue q
               WHERE q.entrant_id = @entrant_id AND q.submission_id != @submission_id)`

const insertQueueRow = db.prepare(`
  INSERT INTO competition_queue
    (submission_id, competition_id, entrant_id, kind, state, enqueued_at, turn)
  VALUES (@submission_id, @competition_id, @entrant_id, @kind, 'waiting', @at, ${TURN})
`)

/**
 * Accept a submission: the row, the number and a place in the queue — in one
 * transaction.
 *
 * The number is computed right here, under the same transaction: otherwise
 * two people who sent a notebook in the same second would get one "#12"
 * between them, and the unique index would refuse the second one after their
 * file had already landed on disk.
 */
export const acceptSubmission = db.transaction(
  (input: {
    competitionId: string
    entrantId: string
    fileName: string
    bytes: number
    at?: number
  }): Submission => {
    const at = input.at ?? Date.now()
    const id = newId()
    const number = (nextNumber.get(input.competitionId) as { n: number }).n
    insertSubmission.run({
      id,
      competition_id: input.competitionId,
      entrant_id: input.entrantId,
      number,
      file_name: clip(input.fileName, LIMITS.fileName),
      bytes: input.bytes,
      at,
    })
    insertQueueRow.run({
      submission_id: id,
      competition_id: input.competitionId,
      entrant_id: input.entrantId,
      kind: 'notebook',
      at,
    })
    return toSubmission(selectSubmission.get(id) as SubmissionRow)
  },
)

export function getSubmission(id: string): Submission | null {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  return row ? toSubmission(row) : null
}

export function listSubmissions(competitionId: string): Submission[] {
  return (selectSubmissions.all(competitionId) as SubmissionRow[]).map(toSubmission)
}

export function listEntrantSubmissions(competitionId: string, entrantId: string): Submission[] {
  return (selectMine.all(competitionId, entrantId) as SubmissionRow[]).map(toSubmission)
}

const countInFlight = db.prepare(
  `SELECT COUNT(*) AS n FROM submissions
   WHERE competition_id = ? AND entrant_id = ? AND state IN ('queued', 'running')`,
)

/**
 * How many of the person's works are in flight right now — waiting or
 * running.
 *
 * By the submission row, not by the queue: the row leaves the queue as soon as
 * the run ends, while the submission stays — and it is the source of truth
 * about what the executor is busy with on this person's behalf.
 */
export function inFlightCount(competitionId: string, entrantId: string): number {
  return (countInFlight.get(competitionId, entrantId) as { n: number }).n
}

const selectCounts = db.prepare(
  'SELECT entrant_id, COUNT(*) AS n FROM submissions WHERE competition_id = ? GROUP BY entrant_id',
)

/**
 * How many submissions each person has — the "SUBMISSIONS" column in the final
 * leaderboard (P3).
 */
export function submissionCounts(competitionId: string): Map<string, number> {
  const rows = selectCounts.all(competitionId) as { entrant_id: string; n: number }[]
  return new Map(rows.map((row) => [row.entrant_id, row.n]))
}

/**
 * How many submissions the person has left today; `null` means there is no
 * limit.
 *
 * The rule from `@shared/competitions` computes it, not SQL: the browser draws
 * the same number for the participant ("You can send 3 more submissions
 * today, out of 5"), and this count must not have a second copy. The database
 * only returns the rows for the day.
 */
export function leftToday(
  competition: Pick<Competition, 'id' | 'limits'>,
  entrantId: string,
  now = Date.now(),
  offsetMinutes = 0,
): number | null {
  const since = dayStart(now, offsetMinutes)
  const rows = selectSince.all(competition.id, entrantId, since) as {
    accepted_at: number
    state: string
    cells_done: number
  }[]
  return submissionsLeftToday(
    competition.limits.perDay,
    rows.map((row) => ({
      acceptedAt: row.accepted_at,
      state: row.state as SubmissionState,
      cellsDone: row.cells_done,
    })),
    now,
    offsetMinutes,
  )
}

/** How many of the person's submissions counted toward today's quota. */
export function usedToday(
  competitionId: string,
  entrantId: string,
  now = Date.now(),
  offsetMinutes = 0,
): number {
  const since = dayStart(now, offsetMinutes)
  const rows = selectSince.all(competitionId, entrantId, since) as {
    accepted_at: number
    state: string
    cells_done: number
  }[]
  return rows.filter(
    (row) =>
      row.accepted_at <= now &&
      countsTowardDailyQuota({
        acceptedAt: row.accepted_at,
        state: row.state as SubmissionState,
        cellsDone: row.cells_done,
      }),
  ).length
}

/** What the runner writes into a submission as it goes. */
export interface SubmissionPatch {
  notebookInputRevision?: number | null
  inputRevision?: number | null
  state?: SubmissionState
  stage?: SubmissionStage
  publicScore?: number | null
  privateScore?: number | null
  durationMs?: number | null
  cellsDone?: number
  cellsTotal?: number
  participantError?: string | null
  teacherError?: string | null
}

const SUBMISSION_COLUMN: Record<keyof SubmissionPatch, string> = {
  inputRevision: 'input_revision',
  notebookInputRevision: 'notebook_input_revision',
  state: 'state',
  stage: 'stage',
  publicScore: 'public_score',
  privateScore: 'private_score',
  durationMs: 'duration_ms',
  cellsDone: 'cells_done',
  cellsTotal: 'cells_total',
  participantError: 'participant_error',
  teacherError: 'teacher_error',
}

export function updateSubmission(id: string, patch: SubmissionPatch): Submission | null {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const column = SUBMISSION_COLUMN[key as keyof SubmissionPatch]
    sets.push(`${column} = @${column}`)
    params[column] =
      key === 'participantError'
        ? clip(value ?? '', LIMITS.participantError) || null
        : key === 'teacherError'
          ? clip(value ?? '', LIMITS.teacherError) || null
          : value
  }
  if (sets.length === 0) return getSubmission(id)
  const result = db
    .prepare(`UPDATE submissions SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
  return result.changes === 0 ? null : getSubmission(id)
}

/**
 * Choose the submission that counts.
 *
 * In one transaction with removing the previous choice: two "counted" marks
 * for one person make a leaderboard that disagrees with itself, and such a
 * thing can then only be caught by hand.
 *
 * Only one's own submission can be chosen, and only one that reached a
 * number: a failed one has no number to put in the table.
 */
export const chooseSubmission = db.transaction(
  (competitionId: string, entrantId: string, submissionId: string): boolean => {
    const row = selectSubmission.get(submissionId) as SubmissionRow | undefined
    if (!row || getCompetition(competitionId)?.scoring !== 'chosen') return false
    if (row.competition_id !== competitionId || row.entrant_id !== entrantId) return false
    if (row.state !== 'scored') return false
    db.prepare(
      'UPDATE submissions SET chosen = 0 WHERE competition_id = ? AND entrant_id = ?',
    ).run(competitionId, entrantId)
    db.prepare('UPDATE submissions SET chosen = 1 WHERE id = ?').run(submissionId)
    return true
  },
)

const selectBoardRows = db.prepare(`
  SELECT id, entrant_id, number, accepted_at, state, public_score, private_score, chosen
  FROM submissions
  WHERE competition_id = ? AND state = 'scored' AND public_score IS NOT NULL
  ORDER BY entrant_id, accepted_at
`)

/**
 * The leaderboard of one part of the test.
 *
 * Sorting and picking the counted submission are computed by
 * `@shared/competitions`, not SQL: the rule "on a tie, whoever submitted
 * earlier ranks higher" and the proviso "did not choose — the best on the
 * public part" must work the same on the server and in the browser, which
 * draws the same table from the same answer.
 */
export function leaderboard(competitionId: string, part: 'public' | 'private'): RankedRow[] {
  const competition = getCompetition(competitionId)
  if (!competition) return []
  const rows = selectBoardRows.all(competitionId) as {
    id: string
    entrant_id: string
    number: number
    accepted_at: number
    state: string
    public_score: number | null
    private_score: number | null
    chosen: number
  }[]
  const byPerson = new Map<string, BoardEntry[]>()
  for (const row of rows) {
    const list = byPerson.get(row.entrant_id) ?? []
    list.push({
      id: row.id,
      number: row.number,
      acceptedAt: row.accepted_at,
      state: row.state as SubmissionState,
      publicScore: row.public_score,
      privateScore: row.private_score,
      chosen: row.chosen === 1,
    })
    byPerson.set(row.entrant_id, list)
  }
  const people = [...byPerson].map(([entrantId, entries]) => ({ entrantId, entries }))
  return boardOf(people, competition.scoring, competition.metric.direction, part)
}

const selectSummary = db.prepare(`
  SELECT state, COUNT(*) AS n FROM submissions WHERE competition_id = ? GROUP BY state
`)
const selectBest = db.prepare(`
  SELECT MIN(public_score) AS low, MAX(public_score) AS high FROM submissions
  WHERE competition_id = ? AND state = 'scored' AND public_score IS NOT NULL
`)

export interface CompetitionSummary {
  submissions: number
  /** "REACHED A NUMBER" in the A3 summary. */
  scored: number
  notebookFailed: number
  rejected: number
  timedOut: number
  outOfMemory: number
  metricFailed: number
  cancelled: number
  entrants: number
  /** The best public result — taking the metric's direction into account. */
  bestPublic: number | null
}

/** The five numbers of the A3 summary and what the A1 competition list shows. */
export function competitionSummary(id: string): CompetitionSummary {
  const counts = selectSummary.all(id) as { state: string; n: number }[]
  const of = (state: SubmissionState) => counts.find((row) => row.state === state)?.n ?? 0
  const range = selectBest.get(id) as { low: number | null; high: number | null }
  const direction = getCompetition(id)?.metric.direction ?? 'lower'
  return {
    submissions: counts.reduce((sum, row) => sum + row.n, 0),
    scored: of('scored'),
    notebookFailed: of('notebookFailed'),
    rejected: of('rejected'),
    timedOut: of('timedOut'),
    outOfMemory: of('outOfMemory'),
    metricFailed: of('metricFailed'),
    cancelled: of('cancelled'),
    entrants: listCompetitionEntrants(id).length,
    bestPublic: direction === 'lower' ? range.low : range.high,
  }
}

/* ------------------------------------------------------------------- runs */

interface RunRow {
  attempt_id: string | null
  input_revision: number | null
  id: string
  submission_id: string
  seq: number
  kind: string
  started_at: number
  finished_at: number | null
  verdict: string | null
  container: string | null
  exit_code: number | null
  oom: number
  cells_done: number
  cells_total: number
  public_score: number | null
  private_score: number | null
  participant_error: string | null
  teacher_error: string | null
}

function toRun(row: RunRow): SubmissionRun {
  return {
    attemptId: row.attempt_id,
    inputRevision: row.input_revision,
    id: row.id,
    submissionId: row.submission_id,
    seq: row.seq,
    kind: row.kind as RunKind,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    verdict: row.verdict as RunVerdict | null,
    container: row.container,
    exitCode: row.exit_code,
    oom: row.oom === 1,
    cellsDone: row.cells_done,
    cellsTotal: row.cells_total,
    publicScore: row.public_score,
    privateScore: row.private_score,
    participantError: row.participant_error,
    teacherError: row.teacher_error,
  }
}

const insertRun = db.prepare(`
  INSERT INTO submission_runs (id, submission_id, seq, kind, started_at, container, attempt_id, input_revision)
  VALUES (@id, @submission_id, @seq, @kind, @at, @container, @attempt_id, @input_revision)
`)
const nextRunSeq = db.prepare(
  'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM submission_runs WHERE submission_id = ?',
)
const selectRun = db.prepare('SELECT * FROM submission_runs WHERE id = ?')
const selectRuns = db.prepare(
  'SELECT * FROM submission_runs WHERE submission_id = ? ORDER BY seq',
)

export const startRun = db.transaction(
  (input: {
    attemptId?: string
    inputRevision?: number
    submissionId: string
    kind: RunKind
    container?: string | null
    at?: number
  }): SubmissionRun => {
    const id = newId()
    insertRun.run({
      id,
      submission_id: input.submissionId,
      seq: (nextRunSeq.get(input.submissionId) as { n: number }).n,
      kind: input.kind,
      at: input.at ?? Date.now(),
      container: input.container ?? null,
      attempt_id: input.attemptId ?? null,
      input_revision: input.inputRevision ?? null,
    })
    return toRun(selectRun.get(id) as RunRow)
  },
)

export interface RunPatch {
  finishedAt?: number
  verdict?: RunVerdict
  container?: string | null
  exitCode?: number | null
  oom?: boolean
  cellsDone?: number
  cellsTotal?: number
  publicScore?: number | null
  privateScore?: number | null
  participantError?: string | null
  teacherError?: string | null
}

const RUN_COLUMN: Record<keyof RunPatch, string> = {
  finishedAt: 'finished_at',
  verdict: 'verdict',
  container: 'container',
  exitCode: 'exit_code',
  oom: 'oom',
  cellsDone: 'cells_done',
  cellsTotal: 'cells_total',
  publicScore: 'public_score',
  privateScore: 'private_score',
  participantError: 'participant_error',
  teacherError: 'teacher_error',
}

export function finishRun(id: string, patch: RunPatch): SubmissionRun | null {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const column = RUN_COLUMN[key as keyof RunPatch]
    sets.push(`${column} = @${column}`)
    params[column] =
      key === 'oom'
        ? value
          ? 1
          : 0
        : key === 'participantError'
          ? clip(value ?? '', LIMITS.participantError) || null
          : key === 'teacherError'
            ? clip(value ?? '', LIMITS.teacherError) || null
            : value
  }
  if (sets.length === 0) {
    const row = selectRun.get(id) as RunRow | undefined
    return row ? toRun(row) : null
  }
  const result = db
    .prepare(`UPDATE submission_runs SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
  if (result.changes === 0) return null
  return toRun(selectRun.get(id) as RunRow)
}

export function listRuns(submissionId: string): SubmissionRun[] {
  return (selectRuns.all(submissionId) as RunRow[]).map(toRun)
}

/** A broker Pod that never scheduled did not execute code or earn a run verdict. */
export function discardUnstartedRun(id:string,attemptId:string):boolean {
  return db.prepare('DELETE FROM submission_runs WHERE id=? AND attempt_id=? AND finished_at IS NULL').run(id,attemptId).changes>0
}

/** The last run of this kind — what the submission row shows. */
export function lastRun(submissionId: string, kind?: RunKind): SubmissionRun | null {
  const runs = listRuns(submissionId).filter((run) => !kind || run.kind === kind)
  return runs.length ? runs[runs.length - 1] : null
}

/* ------------------------------------------------------------------- queue */

export interface QueueRow {
  submissionId: string
  competitionId: string
  entrantId: string
  kind: RunKind
  state: 'waiting' | 'running'
  enqueuedAt: number
  startedAt: number | null
  attempts: number
  resourceRetries: number
  notBefore: number
  /** Which attempt of this person it is — see the selection order. */
  turn: number
  /** The process life that started the run. Another one means the run is orphaned. */
  boot: string | null
  container: string | null
  attemptId: string | null
  pendingKind: RunKind | null
}

interface QueueRowRaw {
  submission_id: string
  competition_id: string
  entrant_id: string
  kind: string
  state: string
  enqueued_at: number
  started_at: number | null
  attempts: number
  resource_retries: number
  not_before: number
  turn: number
  boot: string | null
  container: string | null
  attempt_id: string | null
  pending_kind: string | null
}

function toQueueRow(row: QueueRowRaw): QueueRow {
  return {
    submissionId: row.submission_id,
    competitionId: row.competition_id,
    entrantId: row.entrant_id,
    kind: row.kind as RunKind,
    state: row.state as 'waiting' | 'running',
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    attempts: row.attempts,
    resourceRetries: row.resource_retries,
    notBefore: row.not_before,
    turn: row.turn,
    boot: row.boot,
    container: row.container,
    attemptId: row.attempt_id,
    pendingKind: row.pending_kind as RunKind | null,
  }
}

const upsertQueue = db.prepare(`
  INSERT INTO competition_queue
    (submission_id, competition_id, entrant_id, kind, state, enqueued_at, turn)
  VALUES (@submission_id, @competition_id, @entrant_id, @kind, 'waiting', @at, ${TURN})
  ON CONFLICT(submission_id) DO UPDATE SET
    kind = excluded.kind,
    state = 'waiting',
    enqueued_at = excluded.enqueued_at,
    turn = excluded.turn,
    started_at = NULL,
    attempts = 0,
    resource_retries = 0,
    not_before = 0,
    boot = NULL,
    container = NULL,
    attempt_id = NULL,
    pending_kind = NULL
  WHERE competition_queue.state != 'running'
`)
/* Running on top, the waiting after it in arrival order — as the panel reads it. */
const selectQueue = db.prepare(`
  SELECT * FROM competition_queue
  ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, enqueued_at, submission_id
`)
const selectQueueRow = db.prepare('SELECT * FROM competition_queue WHERE submission_id = ?')
const selectRunning = db.prepare(`SELECT * FROM competition_queue WHERE state = 'running'`)
const deleteQueueRow = db.prepare('DELETE FROM competition_queue WHERE submission_id = ?')
const countWaiting = db.prepare(
  `SELECT COUNT(*) AS n FROM competition_queue WHERE state = 'waiting'`,
)
const markRunning = db.prepare(`
  UPDATE competition_queue
  SET state = 'running', started_at = @at, attempts = attempts + 1, boot = @boot,
      container = @container, attempt_id = @attempt_id
  WHERE submission_id = @submission_id
`)
const markWaiting = db.prepare(`
  UPDATE competition_queue
  SET state = 'waiting', started_at = NULL, boot = NULL, container = NULL, attempt_id = NULL, not_before = 0
  WHERE submission_id = ?
`)
const noteContainer = db.prepare(
  'UPDATE competition_queue SET container = ? WHERE submission_id = ?',
)

/**
 * Put work in the queue — a new submission or a metric rescore.
 *
 * Entering again with the same identifier puts the row back into waiting:
 * "run again" from the row menu and "fix the metric and rescore everyone" are
 * the same submission, not a new one.
 */
export function enqueue(input: {
  submissionId: string
  competitionId: string
  entrantId: string
  kind: RunKind
  at?: number
}): void {
  if (queueRow(input.submissionId)?.state === 'running') {
    db.prepare('UPDATE competition_queue SET pending_kind = ? WHERE submission_id = ? AND state = ?').run(input.kind, input.submissionId, 'running')
    return
  }
  upsertQueue.run({
    submission_id: input.submissionId,
    competition_id: input.competitionId,
    entrant_id: input.entrantId,
    kind: input.kind,
    at: input.at ?? Date.now(),
  })
}

export function queueRows(): QueueRow[] {
  return (selectQueue.all() as QueueRowRaw[]).map(toQueueRow)
}

export function queueRow(submissionId: string): QueueRow | null {
  const row = selectQueueRow.get(submissionId) as QueueRowRaw | undefined
  return row ? toQueueRow(row) : null
}

export function runningRows(): QueueRow[] {
  return (selectRunning.all() as QueueRowRaw[]).map(toQueueRow)
}

export function waitingCount(): number {
  return (countWaiting.get() as { n: number }).n
}

/**
 * Who is next — fairly per person.
 *
 * Three keys, and each closes its own way for one person to occupy the
 * executor.
 *
 * The first is "whoever already has something running lets the others go
 * ahead": the caption under the queue in A3 promises exactly that.
 *
 * The second is `turn`: one's own k-th submission gets in line behind
 * everyone else's (k−1)-th. Without it a person who sent ten notebooks in a
 * row would occupy the executor for half an hour — and INVISIBLY at that:
 * while their first one runs, the first key still keeps the queue fair, and
 * the second their first one leaves the queue, their second overtakes someone
 * else's by arrival time. So the attempt count is written into the row rather
 * than derived from what is still visible in the queue.
 *
 * The third is arrival time, and it is also the last: with equal attempt
 * counts, whoever submitted earlier goes first.
 *
 * Computed in SQL, not in memory, because the queue is database state, and
 * two processes (the server and, one day, a separate runner) must see one and
 * the same answer.
 */
const selectNext = db.prepare(`
  SELECT q.* FROM competition_queue q
  WHERE q.state = 'waiting' AND q.not_before <= @at
  ORDER BY
    (SELECT COUNT(*) FROM competition_queue r
      WHERE r.state = 'running' AND r.entrant_id = q.entrant_id) ASC,
    q.turn ASC,
    q.enqueued_at ASC,
    q.submission_id ASC
  LIMIT 1
`)

export function nextQueueRow(at=Date.now()): QueueRow | null {
  const row = selectNext.get({at}) as QueueRowRaw | undefined
  return row ? toQueueRow(row) : null
}

/**
 * Take the next work and mark it as ours.
 *
 * `null` means there is nothing to take: the queue is empty, paused or all
 * slots are taken. One submission at a time by default: a class is running
 * next to it on the teacher's machine, and a second submission takes memory
 * away from the class rather than speeding up the queue.
 *
 * In a transaction, because "look and take" as two queries means two copies
 * of one run on the day there are two runners.
 */
export const takeNext = db.transaction(
  (opts: { boot?: string; at?: number; slots?: number } = {}): QueueRow | null => {
    if (queuePaused()) return null
    const slots = opts.slots ?? 1
    if ((selectRunning.all() as QueueRowRaw[]).length >= slots) return null
    const at = opts.at ?? Date.now()
    const row = selectNext.get({at}) as QueueRowRaw | undefined
    if (!row) return null
    markRunning.run({
      submission_id: row.submission_id,
      at,
      boot: opts.boot ?? BOOT,
      container: null,
      attempt_id: randomUUID(),
    })
    return toQueueRow(selectQueueRow.get(row.submission_id) as QueueRowRaw)
  },
)

/** Remember the container of a running run — it is what the run is killed by. */
export function noteQueueContainer(submissionId: string, container: string | null, attemptId?: string): void {
  if (attemptId) db.prepare('UPDATE competition_queue SET container = ? WHERE submission_id = ? AND attempt_id = ?').run(container, submissionId, attemptId)
  else noteContainer.run(container, submissionId)
}

/** A completion may touch only the immutable lease that started it. */
export function ownsQueueAttempt(row: QueueRow): boolean {
  const current = queueRow(row.submissionId)
  return !!row.attemptId && current?.state === 'running' && current.attemptId === row.attemptId
}

/** A Pod denied by the scheduler has not executed user code. Keep the durable
 * queue row, postpone its next claim, and leave restart attempt accounting
 * unchanged. A newly requested pending kind starts immediately. */
export const deferResourceAttempt=db.transaction((row:QueueRow,reason:string,at=Date.now(),teacherReason=reason,nextKind:RunKind=row.kind):number|null=>{
  if(!ownsQueueAttempt(row))return null
  const current=queueRow(row.submissionId)!
  const fresh=!!current.pendingKind
  const delay=fresh?0:Math.min(60_000,5_000*2**Math.min(4,current.resourceRetries))
  const notBefore=at+delay
  db.prepare(`UPDATE competition_queue SET kind=COALESCE(pending_kind,?),pending_kind=NULL,state='waiting',
    started_at=NULL,boot=NULL,container=NULL,attempt_id=NULL,attempts=?,resource_retries=?,not_before=?
    WHERE submission_id=? AND attempt_id=?`).run(nextKind,fresh?0:Math.max(0,current.attempts-1),fresh?0:current.resourceRetries+1,notBefore,row.submissionId,row.attemptId)
  updateSubmission(row.submissionId,{state:'queued',stage:'queue',participantError:reason,teacherError:teacherReason})
  return notBefore
})

export const finishQueueAttempt = db.transaction((row: QueueRow): boolean => {
  if (!ownsQueueAttempt(row)) return false
  const current = queueRow(row.submissionId)!
  if (current.pendingKind) {
    db.prepare("UPDATE competition_queue SET kind = pending_kind, pending_kind = NULL, state = 'waiting', started_at = NULL, container = NULL, boot = NULL, attempt_id = NULL, attempts = 0,resource_retries=0,not_before=0 WHERE submission_id = ? AND attempt_id = ?").run(row.submissionId, row.attemptId)
    updateSubmission(row.submissionId, { state: 'queued', stage: 'queue', publicScore: null, privateScore: null })
  } else db.prepare('DELETE FROM competition_queue WHERE submission_id = ? AND attempt_id = ?').run(row.submissionId, row.attemptId)
  return true
})

/** The work ended (in whatever way) — the row leaves the queue. */
export function leaveQueue(submissionId: string): boolean {
  return deleteQueueRow.run(submissionId).changes > 0
}

/** Return work to waiting: cancelled by a pause, killed by hand, did not get through. */
export function requeue(submissionId: string): boolean {
  return markWaiting.run(submissionId).changes > 0
}

/**
 * Runs started by the PREVIOUS life of the process.
 *
 * A "running" row marked with someone else's `boot` means exactly one thing:
 * the server was restarted while the submission was running. The container
 * is most likely gone already — and if it is there, its name lies next to it,
 * and whoever read this must kill it. Previously such work would have stayed
 * "running" forever, and the participant would have watched a timer that does
 * not move until the end of the competition.
 */
export function orphanedRuns(boot = BOOT): QueueRow[] {
  return (
    db
      .prepare(`SELECT * FROM competition_queue WHERE state = 'running' AND (boot IS NULL OR boot != ?)`)
      .all(boot) as QueueRowRaw[]
  ).map(toQueueRow)
}

/**
 * How many times a run is picked up again before it is declared cut off.
 *
 * Two: one server restart in the middle of a class period is ordinary, two in
 * a row on the same submission mean the problem is the submission, and
 * spinning it a third time means occupying the executor with something that
 * does not count.
 */
const MAX_ATTEMPTS = 2

/**
 * Pick up the previous life's work again or honestly mark it as cut off.
 *
 * Called once at process startup. A cut-off submission is marked
 * `metricFailed`, not "the notebook crashed": the participant has nothing to
 * do with it, and the word must name the culprit correctly — they will see
 * the sentence "the checking code crashed, the submission will be rescored",
 * and the teacher will read in their column that a restart cut the run off.
 */
export const reclaimQueue = db.transaction(
  (boot = BOOT, at = Date.now()): { requeued: QueueRow[]; abandoned: QueueRow[] } => {
    const requeued: QueueRow[] = []
    const abandoned: QueueRow[] = []
    for (const row of orphanedRuns(boot)) {
      if (row.attempts < MAX_ATTEMPTS) {
        markWaiting.run(row.submissionId)
        requeued.push(row)
        continue
      }
      deleteQueueRow.run(row.submissionId)
      updateSubmission(row.submissionId, {
        state: 'metricFailed',
        teacherError: `Прогон оборван перезапуском сервера (попыток: ${row.attempts}).`,
        durationMs: row.startedAt === null ? null : at - row.startedAt,
      })
      abandoned.push(row)
    }
    return { requeued, abandoned }
  },
)

const selectPause = db.prepare('SELECT paused, paused_at, paused_by FROM competition_queue_state WHERE id = 1')
const updatePause = db.prepare(
  'UPDATE competition_queue_state SET paused = ?, paused_at = ?, paused_by = ? WHERE id = 1',
)

export function queuePaused(): boolean {
  return (selectPause.get() as { paused: number } | undefined)?.paused === 1
}

export function queuePause(): { paused: boolean; at: number | null; by: string | null } {
  const row = selectPause.get() as
    | { paused: number; paused_at: number | null; paused_by: string | null }
    | undefined
  return {
    paused: row?.paused === 1,
    at: row?.paused_at ?? null,
    by: row?.paused_by ?? null,
  }
}

/**
 * Pause the queue or let it go again.
 *
 * The pause does not touch a running run: killing it is a separate action
 * with a separate button ("Kill"), and merging them would mean losing someone
 * else's minute of work to a click that only promised "do not start new
 * ones".
 */
export function setQueuePaused(paused: boolean, by: string | null = null, at = Date.now()): void {
  updatePause.run(paused ? 1 : 0, paused ? at : null, paused ? by : null)
}

/* -------------------------------------------------------------- cleanup */

/**
 * Which parts of submissions are worth keeping on disk.
 *
 * The numbers live in the database forever — the leaderboard must add up even
 * a year later. The heavy stuff (the submitted notebook, the executed notebook
 * with output, the answer) is needed while the participant is dealing with a
 * failure, and may go for a competition closed long ago. The decision is made
 * here, because it is a question for the database; `storage.ts` removes the
 * files.
 */
export function pruneCompetitionFiles(competitionId: string, keepPerEntrant = 10): number {
  const rows = db
    .prepare(
      `SELECT id, entrant_id FROM submissions WHERE competition_id = ?
       ORDER BY entrant_id, accepted_at DESC`,
    )
    .all(competitionId) as { id: string; entrant_id: string }[]
  const seen = new Map<string, number>()
  const keep = new Set<string>()
  for (const row of rows) {
    const used = seen.get(row.entrant_id) ?? 0
    if (used >= keepPerEntrant) continue
    seen.set(row.entrant_id, used + 1)
    keep.add(row.id)
  }
  return pruneSubmissions(competitionId, keep)
}
