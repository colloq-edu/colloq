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
 * `orphanedRuns` will find out. A running row a machine holds (`holder`) is
 * no orphan of anyone here: the machine runs it, and this server counts it
 * only in the fair order.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { tr } from '@shared/i18n'
import { db } from '../db.js'
import { entrantKeyDigest, newEntrantKey, sealEntrantKey, unsealEntrantKey } from './key.js'
import { removeCompetition as removeCompetitionFiles, openFileSha256, pruneSubmissions, sealedFileSha256 } from './storage.js'
import { competitionDefaults } from './settings.js'
/*
 * The rule by which a GPU run picks its card, called inside `takeNext`'s
 * transaction with the counts read there. gpu.ts reaches nothing of this
 * module, so the import closes no cycle.
 */
import { cardsInUse, pickRunnerGpu } from './gpu.js'
import { putSettingRow, settingRows } from '../admin/settings.js'
import { instanceTimeZone } from '../time-zone.js'
import {
  attemptsLeftToday,
  boardOf,
  countsTowardDailyQuota,
  dayStart,
  failedAttemptsToday,
  entrantNameKey,
  LIMITS,
  quotaDayStart,
  submissionsLeftToday,
  type BoardEntry,
  type BoardVisibility,
  type Competition,
  type CompetitionFile,
  type CompetitionState,
  type Entrant,
  type FileVisibility,
  type MintedEntrant,
  type MetricDirection,
  type OutputPolicy,
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

/** competition_files' shape, one copy for the table and for its rekeying below. */
const FILE_COLUMNS = `
    competition_id TEXT NOT NULL,
    name           TEXT NOT NULL,
    bytes          INTEGER NOT NULL,
    row_count      INTEGER,
    visibility     TEXT NOT NULL,
    uploaded_at    INTEGER NOT NULL,
    sha256         TEXT,
    PRIMARY KEY (competition_id, visibility, name)`

/*
 * The columns that say WHAT a file is — every column of competition_files but
 * its hash. An update of any of these is a change of the competition's inputs
 * (the revision triggers below fire on them alone); an update of the hash
 * alone is a fact learned about bytes that did not change, and must bump
 * nothing: the lazy backfill (competitionFileHashes) would otherwise make
 * every baseline check stale and send the teacher to run the sample notebook
 * again for nothing. A column added to the table later belongs here unless it
 * too only describes what is already there.
 */
const FILE_CONTENT_COLUMNS = 'competition_id, name, bytes, row_count, visibility, uploaded_at'

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
   * list. Keyed by the visibility too: the hidden test's test.csv and the
   * open example test.csv are two files with one name (rekeyCompetitionFiles).
   */
  CREATE TABLE IF NOT EXISTS competition_files (${FILE_COLUMNS});
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
/*
 * The runner card a running row holds (a KERNEL_GPUS entry), written by the
 * transaction that takes the row and cleared by every way out of 'running'.
 * In the row and not in the runner's memory for the same reason as the queue
 * itself: which card is busy must survive a restart in the middle of a run,
 * and the next card is chosen by counting these (takeNext). NULL for every
 * existing row and for every run without a card — and for a GPU run on the
 * cluster, which places the Pod itself.
 */
ensureColumn('competition_queue', 'gpu', 'gpu TEXT')
/*
 * What that run was promised on its card, written with the card and cleared
 * with it: how many runs shared the card when it was taken (`gpu_per_device`,
 * 1 — the whole card) and the share in MB that makes there (`gpu_slice_mb`,
 * filled in once the card has said its size, runner.ts · runGpu). In the row
 * because the owner may change «посылок на карту» while runs hold a card: a
 * share read from the live setting gave the runs taken after the change a
 * share the card no longer had room for (36 GB promised on a 24 GB card), and
 * the console showed the old runs with the new, smaller one. The run is built
 * from these, and the queue weighs a card's load by them (gpu.ts · cardsInUse).
 */
ensureColumn('competition_queue', 'gpu_per_device', 'gpu_per_device INTEGER')
ensureColumn('competition_queue', 'gpu_slice_mb', 'gpu_slice_mb INTEGER')
/*
 * Who holds a running row: NULL — this server, which is every row from
 * before machines ran submissions and every row this server takes; otherwise
 * the machine whose lease it is (docs/architecture/remote-runners.md §5.1).
 * Whatever this server counts as ITS running work reads only its own rows —
 * the slots it takes by, the card shares it hands out, the orphans of its
 * previous life (selectRunning, selectCardLoad, countClusterGpuRuns,
 * orphanedRuns) — because a machine's run holds none of this server's
 * memory, cards or containers, and a restart here must not reclaim a run
 * that is still going there. One thing counts every holder: the fair order
 * (selectNext), so a person whose notebook runs on a machine lets the others
 * go ahead exactly as one whose notebook runs here. A waiting row has no
 * holder, whoever ran it last.
 *
 * `lost`: how many times a machine lost the row after its container had
 * started; the third loss ends the submission as our failure, with no quota
 * spent (decision 6). A new enqueue starts it over (upsertQueue): a rerun or
 * a rescore is new work, not the same run lost again.
 */
ensureColumn('competition_queue', 'holder', 'holder TEXT')
ensureColumn('competition_queue', 'lost', 'lost INTEGER NOT NULL DEFAULT 0')

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
/*
 * Which submission took this one's place in the queue before it started — the
 * number the participant sees ("replaced by #13"). A replaced submission is
 * `cancelled`: it never ran and does not count against the day.
 */
ensureColumn('submissions', 'replaced_by', 'replaced_by INTEGER')
ensureColumn('submission_runs', 'input_revision', 'input_revision INTEGER')
/*
 * Who may see the leaderboard (@shared/competitions · BoardVisibility). The
 * default fills every existing row with `public`, exactly what those
 * competitions did before the setting existed: nobody's board closes by
 * itself on an update.
 */
ensureColumn('competitions', 'board_visibility', "board_visibility TEXT NOT NULL DEFAULT 'public'")
/*
 * «Поздние посылки» and the hidden test's output policy. The defaults are what
 * every existing competition did: intake closes at the deadline, and a run on
 * a hidden test (which none of them has) would be shown briefly.
 */
ensureColumn('competitions', 'late_submissions', 'late_submissions INTEGER NOT NULL DEFAULT 0')
ensureColumn('competitions', 'output_policy', "output_policy TEXT NOT NULL DEFAULT 'brief'")
/*
 * «Видеокарта» (CompetitionLimits.gpu): the notebook runs with a share of a
 * runner card. Zero for every existing row: a competition made on a GPU
 * environment before this switch ran on the CPU, and keeps doing so until its
 * teacher turns the card on — its submissions must not change speed by
 * themselves in the middle of the competition.
 */
ensureColumn('competitions', 'gpu', 'gpu INTEGER NOT NULL DEFAULT 0')
/*
 * A late submission and the moment its upload began (Submission.late,
 * Submission.sentAt). Every older row reads on time and without a start: late
 * intake did not exist, and when an upload began was never recorded.
 */
ensureColumn('submissions', 'late', 'late INTEGER NOT NULL DEFAULT 0')
ensureColumn('submissions', 'sent_at', 'sent_at INTEGER')
ensureColumn('competition_queue', 'late', 'late INTEGER NOT NULL DEFAULT 0')
/* A run on the hidden test, and what its participant reads then (Submission.briefError). */
ensureColumn('submissions', 'sealed_inputs', 'sealed_inputs INTEGER NOT NULL DEFAULT 0')
ensureColumn('submissions', 'brief_error', 'brief_error TEXT')
ensureColumn('submissions', 'error_type', 'error_type TEXT')
ensureColumn('submission_runs', 'sealed_inputs', 'sealed_inputs INTEGER NOT NULL DEFAULT 0')
/*
 * The environment revision a METRIC run scored in (SubmissionRun.revisionId):
 * the submission's pinned one, or, for a competition with a card, the light
 * kaggle-base revision this server had ready (runner.ts · gpuScoringImage,
 * decision 2) — so a score can always be traced to the image that computed
 * it. NULL for every notebook run (its revision is the submission's own pin,
 * submission_environments), for a metric under the stand-in runner without
 * a pin, and for every row from before it.
 */
ensureColumn('submission_runs', 'revision_id', 'revision_id TEXT')
/*
 * The sha256 of an open or hidden-test file (the content address a machine
 * that runs submissions asks for it by), written at upload from the bytes in
 * hand (storage.ts · putOpenFile). NULL for every row uploaded before it and
 * for the answers, which are never handed out by hash; the open and hidden
 * rows get theirs lazily (competitionFileHashes). A new nullable column, which
 * older code never reads; what an older server's re-upload would leave in it
 * is cleared by a trigger (fileHashTriggers).
 */
ensureColumn('competition_files', 'sha256', 'sha256 TEXT')
/*
 * The course a competition belongs to (Competition.courseId). Null for every
 * existing row: a competition made before courses had teachers belongs to no
 * course, and stays visible to its creator and the owners
 * (competitions/scope.ts). No foreign key: courses live in the publish store,
 * and a deleted course simply stops granting anyone anything.
 */
ensureColumn('competitions', 'course_id', 'course_id TEXT')
/*
 * Who ran a competition before 0.19: every member of staff.
 *
 * Until competitions had courses, every teacher saw and ran every one, and
 * the scope rule that replaced that (competitions/scope.ts) grants a
 * competition outside courses to its creator alone. Applied as is on an
 * update, it took a running competition away mid-term from the teacher who
 * co-ran it, and made rows copied from another instance (whose `created_by`
 * names nobody here) the owners' only — with nothing telling anyone. So the
 * first boot with courses on competitions stamps every existing competition
 * with the moment: whoever was on the staff list by then keeps running it
 * (scope.ts · canSeeCompetition) until it is given a course, which is the
 * explicit scoping that replaces the stamp (`updateCompetition` clears it). A
 * teacher who arrives later starts with what they create and what their
 * courses hold, like anyone on a fresh install.
 *
 * Once, by a marker, the way admin/access.ts seeds the memberships: a
 * competition an owner later scoped must not be shared again on a restart.
 */
ensureColumn('competitions', 'staff_shared_at', 'staff_shared_at INTEGER')
const SHARED_MARKER = 'access.competitionsShared'
if (!settingRows('access.').has(SHARED_MARKER)) {
  const now = Date.now()
  db.transaction(() => {
    const stamped = db
      .prepare('UPDATE competitions SET staff_shared_at = ? WHERE course_id IS NULL AND staff_shared_at IS NULL')
      .run(now).changes
    putSettingRow(SHARED_MARKER, String(now))
    if (stamped > 0) {
      console.log(`[access] kept today's visibility: ${stamped} competitions stay with everyone on the staff list today`)
    }
  })()
}

const selectSharedAt = db.prepare('SELECT staff_shared_at FROM competitions WHERE id = ?')

/**
 * When this competition was shared with the staff of that moment (see the
 * stamp above), or null: a competition made since, or one given a course.
 */
export function staffSharedAt(competitionId: string): number | null {
  return (selectSharedAt.get(competitionId) as { staff_shared_at: number | null } | undefined)?.staff_shared_at ?? null
}

/**
 * For the migration test: stamp these competitions as the first boot would
 * have (only these — the test file's other competitions are "made since").
 */
export function restampSharedCompetitionsForTest(ids: readonly string[]): number {
  const stamp = db.prepare(
    'UPDATE competitions SET staff_shared_at = ? WHERE id = ? AND course_id IS NULL AND staff_shared_at IS NULL',
  )
  const now = Date.now()
  return ids.reduce((n, id) => n + stamp.run(now, id).changes, 0)
}

/**
 * The files' key gains the visibility — a table rebuild, in one transaction.
 *
 * Keyed by (competition, name), a hidden test `test.csv` and its open example
 * `test.csv` could not both have a row: the upsert of one flipped the other's
 * visibility, and the open list quietly lost the example (or gained the
 * test). It already happened to the answers: an open `solution.csv` upload
 * turned the answers' row into an open one. SQLite cannot change a primary
 * key in place, so the rows move to a new table; dropping the old one takes
 * its index and triggers along, and both are made again here. Nothing fires
 * on the way: the triggers belong to the table being dropped.
 *
 * Returns whether it rebuilt anything; a table already keyed so is left alone.
 *
 * Older code cannot live with the result: its upsert names the old key, and
 * SQLite refuses to prepare it, so that server would not even start. Hence
 * data schema 2 (data-schema.ts), which refuses the rollback before it runs.
 */
export function rekeyCompetitionFiles(): boolean {
  const columns = db.prepare('PRAGMA table_info(competition_files)').all() as { name: string; pk: number }[]
  const visibility = columns.find((column) => column.name === 'visibility')
  if (!visibility || visibility.pk > 0) return false
  db.transaction(() => {
    db.exec(`
      CREATE TABLE competition_files_rekeyed (${FILE_COLUMNS});
      INSERT INTO competition_files_rekeyed (competition_id, name, bytes, row_count, visibility, uploaded_at)
        SELECT competition_id, name, bytes, row_count, visibility, uploaded_at FROM competition_files;
      DROP TABLE competition_files;
      ALTER TABLE competition_files_rekeyed RENAME TO competition_files;
      CREATE INDEX IF NOT EXISTS competition_files_of ON competition_files(competition_id, visibility);
    `)
    competitionTriggers()
  })()
  return true
}

/*
 * The moment this instance began counting daily limits in its own time zone.
 *
 * Until then the limit reset at UTC midnight, and a submission accepted before
 * this moment is also held to that day (@shared/competitions · quotaDayStart),
 * so an update in the middle of a competition changes nobody's count. Written
 * once, on the first start that knows about it, and never again: on a new
 * instance it is simply earlier than any submission. One row, and CHECK says
 * so, as for the queue pause.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS competition_day_rule (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    zone_since INTEGER NOT NULL
  );
`)
db.prepare('INSERT OR IGNORE INTO competition_day_rule (id, zone_since) VALUES (1, ?)').run(Date.now())
const zoneSinceMoment = (db.prepare('SELECT zone_since FROM competition_day_rule WHERE id = 1').get() as { zone_since: number }).zone_since

/** When days began to be counted in the instance's zone — see the table above. */
export function zoneDaysSince(): number {
  return zoneSinceMoment
}
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
/*
 * The card is a limit like the CPUs: a sample notebook that passed on the CPU
 * says nothing about the same notebook with a card (a `.cuda()` that had no
 * device to fail on, a time limit met only with one), so turning the card on
 * or off makes the check stale exactly as a changed CPU count does — both
 * revisions, the notebook's and the whole input's. A trigger of its own, with
 * a name of its own: the two above were created with IF NOT EXISTS on every
 * existing database and cannot learn a new column.
 */
db.exec(`
  CREATE TRIGGER IF NOT EXISTS competition_gpu_inputs_changed
  AFTER UPDATE OF gpu ON competitions
  WHEN NEW.gpu IS NOT OLD.gpu
  BEGIN UPDATE competitions SET notebook_input_revision = notebook_input_revision + 1,
    input_revision = input_revision + 1 WHERE id = NEW.id; END;
`)
/*
 * What the notebook reads is the open files AND the hidden test: a change to
 * either makes the sample notebook's check stale. The triggers carry new names
 * because `CREATE TRIGGER IF NOT EXISTS` cannot change an existing one, and the
 * old ones (open files only) are dropped wherever they still are.
 *
 * A file's UPDATE fires only on the columns that say what the file is
 * (FILE_CONTENT_COLUMNS), not on its hash. Those two triggers keep their names
 * and are replaced where an older start made them fire on any update: an
 * older server rolled back to finds them under the names it knows and leaves
 * them, and its upsert names `bytes`, so they fire for it as they always did.
 */
function revisionTriggers(): void {
  const NOTEBOOK_FILE = "IN ('open', 'sealed')"
  for (const table of ['submissions', 'competition_queue', 'competition_entrants', 'competition_files']) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW'
      const event = table === 'competition_files' && operation === 'UPDATE' ? `UPDATE OF ${FILE_CONTENT_COLUMNS}` : operation
      if (table === 'competition_files') {
        const name = `competition_files_${operation.toLowerCase()}_notebook_inputs`
        db.exec(`DROP TRIGGER IF EXISTS competition_files_${operation.toLowerCase()}_notebook_revision`)
        if (operation === 'UPDATE') dropUnlessColumnScoped(name)
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}
        AFTER ${event} ON competition_files
        WHEN ${operation === 'UPDATE' ? `OLD.visibility ${NOTEBOOK_FILE} OR NEW.visibility ${NOTEBOOK_FILE}` : `${row}.visibility ${NOTEBOOK_FILE}`}
        BEGIN UPDATE competitions SET notebook_input_revision = notebook_input_revision + 1 WHERE id = ${row}.competition_id; END;`)
      }
      if (table === 'competition_files' && operation === 'UPDATE') dropUnlessColumnScoped(`${table}_update_revision`)
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()}_revision
        AFTER ${event} ON ${table}
        BEGIN UPDATE competitions SET revision = revision + 1
          ${table === 'competition_files' ? ', input_revision = input_revision + 1' : ''}
          WHERE id = ${row}.competition_id; END;`)
    }
  }
}

/** Drop a trigger of competition_files made by an older start, one that fires on any update. */
function dropUnlessColumnScoped(name: string): void {
  const found = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined
  if (found && !/\bUPDATE\s+OF\b/i.test(found.sql)) db.exec(`DROP TRIGGER ${name}`)
}

/*
 * A file's hash belongs to the bytes of the upload that wrote it. A re-upload
 * that does not set a new one (an older server's upsert, which knows nothing
 * of the column, or ours before it writes the hash it took: putFile) leaves
 * the old hash naming bytes that are gone, so it is forgotten, and the file
 * gets its own from the disk lazily (competitionFileHashes). Only the hash is
 * touched, so nothing above fires again.
 */
function fileHashTriggers(): void {
  db.exec(`CREATE TRIGGER IF NOT EXISTS competition_files_hash_forgotten
    AFTER UPDATE OF bytes, uploaded_at ON competition_files
    WHEN NEW.sha256 IS OLD.sha256 AND NEW.sha256 IS NOT NULL
    BEGIN UPDATE competition_files SET sha256 = NULL
      WHERE competition_id = NEW.competition_id AND visibility = NEW.visibility AND name = NEW.name; END;`)
}

/**
 * The triggers of the competition tables, made where missing and brought up
 * to date where an older start made them: at startup, after the files table
 * is rebuilt (rekeyCompetitionFiles), and by the migration test. Idempotent.
 */
export function competitionTriggers(): void {
  revisionTriggers()
  fileHashTriggers()
}
competitionTriggers()
rekeyCompetitionFiles()

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
  gpu: number
  environment: string
  starts_at: number | null
  deadline_at: number | null
  private_release: string
  scoring: string
  board_visibility: string
  late_submissions: number
  output_policy: string
  private_opened_at: number | null
  baseline_submission_id: string | null
  baseline_entrant_id: string | null
  revision: number
  input_revision: number
  notebook_input_revision: number
  created_by: string | null
  course_id: string | null
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
      gpu: row.gpu === 1,
    },
    environment: row.environment,
    startsAt: row.starts_at,
    deadlineAt: row.deadline_at,
    privateRelease: row.private_release as PrivateRelease,
    scoring: row.scoring as ScoringRule,
    boardVisibility: row.board_visibility === 'entrants' ? 'entrants' : 'public',
    lateSubmissions: row.late_submissions === 1,
    outputPolicy: row.output_policy === 'full' ? 'full' : 'brief',
    privateOpenedAt: row.private_opened_at,
    baselineSubmissionId: row.baseline_submission_id,
    baselineEntrantId: row.baseline_entrant_id,
    revision: row.revision,
    inputRevision: row.input_revision,
    notebookInputRevision: row.notebook_input_revision,
    createdBy: row.created_by,
    courseId: row.course_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const insertCompetition = db.prepare(`
  INSERT INTO competitions
    (id, slug, title, blurb, description, state, metric_name, metric_direction, metric_code,
     public_percent, split_seed, wall_seconds, memory_mb, cpus, per_day, gpu, environment,
     starts_at, deadline_at, private_release, scoring, board_visibility, late_submissions, output_policy,
     created_by, course_id, created_at, updated_at)
  VALUES
    (@id, @slug, @title, @blurb, @description, 'draft', @metric_name, @metric_direction,
     @metric_code, @public_percent, @split_seed, @wall_seconds, @memory_mb, @cpus, @per_day, @gpu,
     @environment, @starts_at, @deadline_at, @private_release, @scoring, @board_visibility,
     @late_submissions, @output_policy, @created_by, @course_id, @at, @at)
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
  boardVisibility?: BoardVisibility
  lateSubmissions?: boolean
  outputPolicy?: OutputPolicy
  createdBy?: string | null
  courseId?: string | null
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
  // The instance's defaults, not the editor's constants: the owner sets them
  // once for the machine (settings.ts), and every new competition starts there.
  const defaults = competitionDefaults().limits
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
      wall_seconds: input.limits?.wallSeconds ?? defaults.wallSeconds,
      memory_mb: input.limits?.memoryMb ?? defaults.memoryMb,
      cpus: input.limits?.cpus ?? defaults.cpus,
      per_day: input.limits?.perDay ?? defaults.perDay,
      // Never an instance default: a card is the teacher's switch, on a GPU environment.
      gpu: input.limits?.gpu ? 1 : 0,
      environment: input.environment ?? 'base',
      starts_at: input.startsAt ?? null,
      deadline_at: input.deadlineAt ?? null,
      private_release: input.privateRelease ?? 'auto',
      scoring: input.scoring ?? 'chosen',
      board_visibility: input.boardVisibility ?? 'public',
      late_submissions: input.lateSubmissions ? 1 : 0,
      output_policy: input.outputPolicy ?? 'brief',
      created_by: input.createdBy ?? null,
      course_id: input.courseId ?? null,
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
    | 'boardVisibility'
    | 'lateSubmissions'
    | 'outputPolicy'
    | 'baselineSubmissionId'
    | 'courseId'
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
  boardVisibility: 'board_visibility',
  lateSubmissions: 'late_submissions',
  outputPolicy: 'output_policy',
  baselineSubmissionId: 'baseline_submission_id',
  courseId: 'course_id',
  'metric.name': 'metric_name',
  'metric.direction': 'metric_direction',
  'metric.code': 'metric_code',
  'limits.wallSeconds': 'wall_seconds',
  'limits.memoryMb': 'memory_mb',
  'limits.cpus': 'cpus',
  'limits.perDay': 'per_day',
  'limits.gpu': 'gpu',
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
    // SQLite binds no booleans: a switch is stored as 0 or 1.
    params[column] = CLIP_OF[key] ? clip(value, CLIP_OF[key]) : typeof value === 'boolean' ? (value ? 1 : 0) : value
  }
  if (sets.length === 0) return getCompetition(id)
  // A course given (or taken) is the explicit scoping that replaces the
  // pre-0.19 sharing with the whole staff list (see `staff_shared_at`).
  if (flat.courseId !== undefined) sets.push('staff_shared_at = NULL')
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

const forgiveLateRows = db.prepare(`
  UPDATE submissions SET late = 0
  WHERE competition_id = @id AND late = 1
    AND (@deadline IS NULL
      OR (COALESCE(sent_at, accepted_at) <= @deadline AND accepted_at <= @deadline + @grace))
`)
const forgiveLateQueue = db.prepare(`
  UPDATE competition_queue SET late = 0
  WHERE competition_id = ? AND late = 1
    AND submission_id IN (SELECT id FROM submissions WHERE competition_id = ? AND late = 0)
`)

/**
 * After the deadline moved, take the late mark off what the new deadline
 * would have accepted on time; returns how many submissions it freed.
 *
 * The teacher's decision of 4 Oct 2026: a deadline moved LATER means the class
 * had more time, so a notebook sent before the new deadline is on time — it
 * joins the boards, can be chosen, and the final results wait for it. The test
 * is the acceptance rule itself (dependencies/service.ts ·
 * acceptPinnedSubmission) against the new deadline: the upload began by it,
 * and its body arrived within `graceMs` after it. No deadline at all means
 * intake never ended, so nothing is late.
 *
 * It only ever clears the mark. A deadline moved EARLIER does not make an
 * on-time submission late: that would take a place away from someone after
 * the fact, for a rule that did not exist when they pressed «Отправить». No
 * one can be penalised retroactively. That is also what makes this safe to
 * run on every save of the deadline: a row still late under the deadline it
 * was judged by is late under any earlier one.
 *
 * Only a live competition: after «Завершить сейчас» intake ended at the
 * finish, not at the deadline, and moving the date does not reopen standings
 * the teacher closed by hand.
 *
 * The waiting queue row carries its own copy of the mark (the on-time-first
 * order and the replace rule read it), so it is cleared in the same
 * transaction.
 */
export const forgiveLateSubmissions = db.transaction((competitionId: string, graceMs: number): number => {
  const c = getCompetition(competitionId)
  if (!c || c.state !== 'live') return 0
  const freed = forgiveLateRows.run({ id: competitionId, deadline: c.deadlineAt, grace: graceMs }).changes
  if (freed > 0) forgiveLateQueue.run(competitionId, competitionId)
  return freed
})

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
 *
 * `'running'` — a run of it is still going, and nothing is deleted. Its
 * queue row is what holds its slot and its share of a runner card; deleted
 * under a live container, it let the next GPU notebook onto a card the
 * container still filled, promised a share nobody had. The door stops the
 * runs first (runner.ts · stopCompetitionRuns); this is the last check, in
 * the same transaction as the delete, so a run that started in between
 * refuses the whole of it.
 */
export function deleteCompetition(id: string): boolean | 'running' {
  const rows = db.transaction((competitionId: string): number | 'running' => {
    if (db.prepare("SELECT 1 FROM competition_queue WHERE competition_id = ? AND state = 'running' LIMIT 1").get(competitionId)) {
      return 'running'
    }
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
  if (rows === 'running') return 'running'
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
  sha256: string | null
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

/*
 * The hash is not in the DO UPDATE: a re-upload forgets the old one by trigger
 * (fileHashTriggers), whoever's upsert it is, and putFile then writes the new
 * one, alone, which fires nothing.
 */
const upsertFile = db.prepare(`
  INSERT INTO competition_files (competition_id, name, bytes, row_count, visibility, uploaded_at, sha256)
  VALUES (@competition_id, @name, @bytes, @row_count, @visibility, @uploaded_at, @sha256)
  ON CONFLICT(competition_id, visibility, name) DO UPDATE SET
    bytes = excluded.bytes,
    row_count = excluded.row_count,
    uploaded_at = excluded.uploaded_at
`)
const writeFileHash = db.prepare(
  'UPDATE competition_files SET sha256 = @sha256 WHERE competition_id = @competition_id AND visibility = @visibility AND name = @name',
)
/*
 * The backfill's write, for the upload it read and no other: a row re-uploaded
 * while the file was being hashed has a new uploaded_at (and, from this door, a
 * hash of its own already), and the hash taken is of bytes that are gone.
 */
const fillFileHash = db.prepare(`
  UPDATE competition_files SET sha256 = @sha256
  WHERE competition_id = @competition_id AND visibility = @visibility AND name = @name
    AND sha256 IS NULL AND uploaded_at = @uploaded_at AND bytes = @bytes
`)
const SHA256 = /^[a-f0-9]{64}$/
const writeFileRow = db.transaction((row: Record<string, unknown> & { sha256: string | null }) => {
  upsertFile.run(row)
  // After the upsert, alone: a re-upload of the same bytes forgot the hash it
  // brings back (fileHashTriggers), and a write of the hash bumps no revision.
  if (row.sha256) writeFileHash.run({ competition_id: row.competition_id, visibility: row.visibility, name: row.name, sha256: row.sha256 })
})
const selectFiles = db.prepare(
  'SELECT * FROM competition_files WHERE competition_id = ? ORDER BY name',
)
const selectFilesOf = db.prepare(
  'SELECT * FROM competition_files WHERE competition_id = ? AND visibility = ? ORDER BY name',
)
const selectFile = db.prepare(
  'SELECT * FROM competition_files WHERE competition_id = ? AND visibility = ? AND name = ?',
)
const deleteFileRow = db.prepare(
  'DELETE FROM competition_files WHERE competition_id = ? AND visibility = ? AND name = ?',
)
const sumBytesOf = db.prepare(
  `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM competition_files
   WHERE competition_id = ? AND visibility = ?`,
)

/**
 * Record a file the disk now holds (storage.ts · putOpenFile and its kin).
 *
 * `sha256` is the hash the upload took of the bytes it wrote; without one the
 * row has none, and an open or hidden-test file gets it from the disk when it
 * is first asked for (competitionFileHashes). The answers never keep one, even
 * if handed one: a row with a hash is a row that may be asked for by it, and
 * no door hands the answers out.
 */
export function putFile(input: {
  competitionId: string
  name: string
  bytes: number
  rows?: number | null
  visibility: FileVisibility
  at?: number
  sha256?: string | null
}): CompetitionFile {
  const name = clip(input.name, LIMITS.fileName)
  writeFileRow({
    competition_id: input.competitionId,
    name,
    bytes: input.bytes,
    row_count: input.rows ?? null,
    visibility: input.visibility,
    uploaded_at: input.at ?? Date.now(),
    sha256: input.visibility !== 'hidden' && typeof input.sha256 === 'string' && SHA256.test(input.sha256) ? input.sha256 : null,
  })
  return toFile(selectFile.get(input.competitionId, input.visibility, name) as FileRow)
}

/** A data file as a machine that runs submissions asks for it: its name, size and content hash. */
export interface HashedFile {
  name: string
  bytes: number
  /** The sha256 of its bytes (hex); `null` — the file is not on disk as its row describes it. */
  sha256: string | null
}

/**
 * The competition's open files, or its hidden test, each with the sha256 of
 * its bytes, filling in the hashes rows uploaded before 0.23 lack.
 *
 * Lazily, and once: the first ask reads such a file from the disk (storage.ts
 * · openFileSha256, which a repeated ask about the same unchanged file costs
 * one stat) and writes the hash into the row, so the next one reads only the
 * row. The write is a fact about bytes that did not change: it bumps no
 * revision (FILE_CONTENT_COLUMNS), and the sample notebook's check stays
 * valid. A file whose size disagrees with its row, that is gone, or that
 * cannot be read gets no hash: whatever is on disk is not what the row lists,
 * and the next ask tries again. The answers are not asked for here: there is
 * no door that hands them out by hash.
 *
 * Each row is read again right before its file is opened, in the same tick: an
 * upload writes the disk and the row in one synchronous step
 * (routes/admin-competitions.ts), so the pair is one upload's, and the guarded
 * write (fillFileHash) refuses a hash whose upload has been replaced since. The
 * answer is what the rows say once the pass is done.
 */
export async function competitionFileHashes(competitionId: string, visibility: 'open' | 'sealed'): Promise<HashedFile[]> {
  const hashOf = visibility === 'open' ? openFileSha256 : sealedFileSha256
  const out: HashedFile[] = []
  for (const { name } of selectFilesOf.all(competitionId, visibility) as FileRow[]) {
    let row = selectFile.get(competitionId, visibility, name) as FileRow | undefined
    if (row && !row.sha256) {
      const found = await hashOf(competitionId, name).catch(() => null)
      if (found && found.bytes === row.bytes) {
        fillFileHash.run({ competition_id: competitionId, visibility, name, sha256: found.sha256, uploaded_at: row.uploaded_at, bytes: row.bytes })
      }
      row = selectFile.get(competitionId, visibility, name) as FileRow | undefined
    }
    if (row) out.push({ name: row.name, bytes: row.bytes, sha256: row.sha256 ?? null })
  }
  return out
}

/**
 * The same list as the rows say it NOW, without reading a byte: for the take
 * of a machine that runs submissions (competitions/remote/lease.ts), which is
 * one synchronous transaction and builds a lease's data manifest from these.
 * A row still without its hash reads `null`, and its competition is not
 * leased until competitionFileHashes has filled it in.
 */
export function fileHashesNow(competitionId: string, visibility: 'open' | 'sealed'): HashedFile[] {
  return (selectFilesOf.all(competitionId, visibility) as FileRow[]).map((row) => ({ name: row.name, bytes: row.bytes, sha256: row.sha256 ?? null }))
}

export function listFiles(id: string, visibility?: FileVisibility): CompetitionFile[] {
  const rows = (
    visibility ? selectFilesOf.all(id, visibility) : selectFiles.all(id)
  ) as FileRow[]
  return rows.map(toFile)
}

/**
 * Remove a file's row. The visibility is part of the name now: dropping the
 * open example must leave the hidden test of the same name where it is.
 */
export function dropFile(id: string, name: string, visibility: FileVisibility = 'open'): boolean {
  return deleteFileRow.run(id, visibility, name).changes > 0
}

/** What the open files weigh — against the "up to 200 MB per competition" ceiling. */
export function openFileBytes(id: string): number {
  return (sumBytesOf.get(id, 'open') as { bytes: number }).bytes
}

/** What the hidden test weighs — against its own `LIMITS.sealedBytes`. */
export function sealedFileBytes(id: string): number {
  return (sumBytesOf.get(id, 'sealed') as { bytes: number }).bytes
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

/**
 * The teacher's rename — the name and every per-competition name key at once,
 * or nothing.
 *
 * It used to write `entrants.name` alone. The key a namesake is refused by
 * lives in `competition_entrants`, so after a rename the OLD name stayed
 * reserved in each of the person's competitions and the new one stayed free:
 * a newcomer could join under exactly the name the teacher had just given,
 * and the leaderboard would show two identical rows. Now it is the same move
 * as joining under a new name (`writeEnrollment`), checked by the same unique
 * index in all the person's competitions at once; a clash in any of them
 * rolls the whole rename back.
 *
 * The rule of what a name may be is at the door (admin-competitions ·
 * entrantHandle), not here: the store also names the baseline notebook's
 * service entrant, by a localized phrase that is no handle.
 */
const writeRename = db.transaction((id: string, clipped: string, key: string): boolean => {
  if (updateEntrantName.run(clipped, id).changes === 0) return false
  updateEnrollmentName.run(key, id)
  return true
})

export function renameEntrant(id: string, name: string): 'ok' | 'taken' | 'missing' {
  const clipped = clip(name, LIMITS.entrantName)
  try {
    return writeRename(id, clipped, entrantNameKey(clipped)) ? 'ok' : 'missing'
  } catch (error) {
    // Outside the transaction, as in `joinCompetition`: caught inside, the
    // refusal would commit the half that had already been written.
    if (isUniqueViolation(error)) return 'taken'
    throw error
  }
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
const selectNameHolder = db.prepare(
  'SELECT 1 FROM competition_entrants WHERE competition_id = ? AND name_key = ?',
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

/**
 * A newcomer joins under this name: a new identity with its key and the
 * enrollment, or nothing at all.
 *
 * Names are Telegram usernames or email addresses, so a newcomer whose name
 * the competition already has is most likely that same person on a new
 * device. An identity minted for them anyway is a second key, which the rules
 * forbid, and a row nobody can remove; the refusal sends them to their key
 * instead. So the name is looked up BEFORE anything is minted, and the unique
 * index stays the final word (see `joinCompetition`): a namesake who gets in
 * between the look-up and the insert rolls the new identity back together
 * with the enrollment.
 */
const writeNewcomer = db.transaction((competitionId: string, name: string, at: number): MintedEntrant => {
  const minted = createEntrant(name)
  const clipped = clip(name, LIMITS.entrantName)
  writeEnrollment(competitionId, minted.entrant.id, clipped, entrantNameKey(clipped), at)
  return minted
})

export function joinAsNewcomer(competitionId: string, name: string, at = Date.now()): MintedEntrant | 'taken' {
  if (selectNameHolder.get(competitionId, entrantNameKey(clip(name, LIMITS.entrantName)))) return 'taken'
  try {
    return writeNewcomer(competitionId, name, at)
  } catch (error) {
    // Outside the transaction, as in `joinCompetition`: caught inside, the
    // refusal would commit the identity it exists to undo.
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

const selectTakesPart = db.prepare(`
  SELECT 1 FROM competition_entrants WHERE competition_id = @c AND entrant_id = @e
  UNION ALL
  SELECT 1 FROM submissions WHERE competition_id = @c AND entrant_id = @e
  LIMIT 1
`)

/**
 * Whether the person takes part in this competition: joined it, or has a
 * submission in it (the same two conditions as `listCompetitionEntrants` —
 * a competition older than joining has entrants who never pressed "JOIN").
 */
export function takesPart(competitionId: string, entrantId: string): boolean {
  return selectTakesPart.get({ c: competitionId, e: entrantId }) !== undefined
}

const selectElsewhere = db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT competition_id FROM competition_entrants WHERE entrant_id = @e AND competition_id != @c
    UNION
    SELECT competition_id FROM submissions WHERE entrant_id = @e AND competition_id != @c
  )
`)

/**
 * In how many OTHER competitions the person takes part — what removing them
 * from this one leaves: their key keeps working there, and their identity
 * stays with it.
 */
export function competitionsElsewhere(entrantId: string, competitionId: string): number {
  return (selectElsewhere.get({ e: entrantId, c: competitionId }) as { n: number }).n
}

const selectEveryCompetitionOf = db.prepare(`
  SELECT competition_id FROM competition_entrants WHERE entrant_id = ?
  UNION
  SELECT competition_id FROM submissions WHERE entrant_id = ?
`)

/**
 * Every competition the person takes part in, by the same two conditions as
 * `takesPart` — the reach of anything done to the person as a whole (a
 * rename, switching them off, their key), which the panel's scope rule weighs
 * against the competitions the teacher runs.
 */
export function entrantCompetitionIds(entrantId: string): string[] {
  return (selectEveryCompetitionOf.all(entrantId, entrantId) as { competition_id: string }[]).map((row) => row.competition_id)
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
  replaced_by: number | null
  late: number
  sent_at: number | null
  sealed_inputs: number
  brief_error: string | null
  error_type: string | null
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
    replacedBy: row.replaced_by ?? null,
    late: row.late === 1,
    sentAt: row.sent_at ?? null,
    sealedInputs: row.sealed_inputs === 1,
    briefError: row.brief_error ?? null,
    errorType: row.error_type ?? null,
  }
}

const insertSubmission = db.prepare(`
  INSERT INTO submissions
    (id, competition_id, entrant_id, number, file_name, bytes, accepted_at, state, stage, late, sent_at,
     input_revision, notebook_input_revision)
  VALUES (@id, @competition_id, @entrant_id, @number, @file_name, @bytes, @at, 'queued', 'accepted', @late, @sent_at,
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
  `SELECT id, accepted_at, state FROM submissions
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
/*
 * A queue row is late when its submission is: read off the submission row
 * itself, so a rerun or a rescore of a late one keeps waiting behind on-time
 * work too (see the selection order below).
 */
const LATE = `COALESCE((SELECT late FROM submissions WHERE id = @submission_id), 0)`

const insertQueueRow = db.prepare(`
  INSERT INTO competition_queue
    (submission_id, competition_id, entrant_id, kind, state, enqueued_at, turn, late)
  VALUES (@submission_id, @competition_id, @entrant_id, @kind, 'waiting', @at, ${TURN}, ${LATE})
`)
/* A replacement inherits the place it takes: the same arrival time and turn. */
const insertQueueRowAt = db.prepare(`
  INSERT INTO competition_queue
    (submission_id, competition_id, entrant_id, kind, state, enqueued_at, turn, late)
  VALUES (@submission_id, @competition_id, @entrant_id, 'notebook', 'waiting', @enqueued_at, @turn, ${LATE})
`)
const markReplaced = db.prepare(`
  UPDATE submissions SET state = 'cancelled', stage = 'queue', replaced_by = @number,
    participant_error = NULL, brief_error = NULL, teacher_error = @note
  WHERE id = @id
`)

/**
 * Accept a submission: the row, the number and a place in the queue — in one
 * transaction.
 *
 * The number is computed right here, under the same transaction: otherwise
 * two people who sent a notebook in the same second would get one "#12"
 * between them, and the unique index would refuse the second one after their
 * file had already landed on disk.
 *
 * `replaces` names the person's submission that is still WAITING: it leaves
 * the queue as `cancelled` (it never ran, so it does not count against the
 * day), and the new one takes its place — the same arrival time and turn, so
 * a fixed typo does not send its author to the end of a queue of thirty.
 * Whoever calls this has checked that the old one is replaceable
 * (`intakePlan`); here it is checked again under the same transaction, and a
 * job the pump took a millisecond ago refuses the whole acceptance.
 */
export const acceptSubmission = db.transaction(
  (input: {
    competitionId: string
    entrantId: string
    fileName: string
    bytes: number
    at?: number
    replaces?: string | null
    /** Accepted after intake ended (Submission.late) — decided by the caller, once. */
    late?: boolean
    /** When the upload began (Submission.sentAt); defaults to `at`. */
    sentAt?: number | null
  }): Submission => {
    const at = input.at ?? Date.now()
    const late = input.late === true
    /*
     * A person removed by the teacher while their upload was still arriving
     * must not come back as a submission without a name: the removal took the
     * row, and this transaction is the last place that can notice.
     */
    if (!selectEntrant.get(input.entrantId)) throw new Error('The entrant no longer exists')
    const id = newId()
    const number = (nextNumber.get(input.competitionId) as { n: number }).n
    const old = input.replaces ? queueRow(input.replaces) : null
    if (input.replaces && (!old || !replaceableRow(old, input.competitionId, input.entrantId, late))) {
      throw new Error('The replaced submission is no longer waiting')
    }
    insertSubmission.run({
      id,
      competition_id: input.competitionId,
      entrant_id: input.entrantId,
      number,
      file_name: clip(input.fileName, LIMITS.fileName),
      bytes: input.bytes,
      at,
      late: late ? 1 : 0,
      sent_at: input.sentAt ?? at,
    })
    if (old) {
      deleteQueueRow.run(old.submissionId)
      markReplaced.run({ id: old.submissionId, number, note: tr('competitions.answer.replaced', { number }) })
      insertQueueRowAt.run({
        submission_id: id,
        competition_id: input.competitionId,
        entrant_id: input.entrantId,
        enqueued_at: old.enqueuedAt,
        turn: old.turn,
      })
    } else {
      insertQueueRow.run({
        submission_id: id,
        competition_id: input.competitionId,
        entrant_id: input.entrantId,
        kind: 'notebook',
        at,
      })
    }
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

const selectInFlight = db.prepare(
  `SELECT * FROM submissions
   WHERE competition_id = ? AND entrant_id = ? AND state IN ('queued', 'running')`,
)

const selectAnyRun = db.prepare('SELECT 1 FROM submission_runs WHERE submission_id = ? LIMIT 1')

/**
 * A queue row a new upload may take over: the person's own notebook run,
 * still waiting, with no rescore stacked on it — and never run before. A
 * teacher's "run again" waits exactly like a fresh upload, but it belongs to
 * a submission that already has a result (and maybe the scoring choice), and
 * cancelling it would throw both away.
 *
 * And of the same lateness: a late upload taking the place of an ON-TIME one
 * still waiting would cancel a notebook sent at 23:59:50 that is in the
 * standings for one sent at 00:00:10 that is not.
 */
function replaceableRow(row: QueueRow, competitionId: string, entrantId: string, late = false): boolean {
  return row.competitionId === competitionId && row.entrantId === entrantId
    && row.state === 'waiting' && row.kind === 'notebook' && row.pendingKind === null
    && row.late === late
    && selectAnyRun.get(row.submissionId) === undefined
}

/**
 * What a new upload from this person would do right now.
 *
 * Nothing in flight — a plain new submission. Exactly one submission still
 * WAITING for its notebook run — the upload takes its place: the person fixed
 * a typo, and making them wait for a notebook they no longer want (or cancel
 * it by hand first) only lengthens everyone's queue. Anything running, a
 * rescore or a re-run waiting, or more than one in flight — refused, one at a
 * time: that one is already taking a slot or holds a result, and replacing it
 * would throw away the work.
 *
 * `late` is the new upload's lateness. A late one meeting a waiting ON-TIME
 * submission is refused with its own word (`on_time_waiting`): the on-time one
 * keeps its place, and the person is told why the fix was not taken.
 */
export function intakePlan(
  competitionId: string,
  entrantId: string,
  late = false,
): { replaces: Submission | null } | 'in_flight' | 'on_time_waiting' {
  const flying = selectInFlight.all(competitionId, entrantId) as SubmissionRow[]
  if (flying.length === 0) return { replaces: null }
  if (flying.length > 1) return 'in_flight'
  const only = flying[0]
  const row = queueRow(only.id)
  if (late && row && !row.late && replaceableRow(row, competitionId, entrantId, false)) return 'on_time_waiting'
  if (only.state !== 'queued' || !row || !replaceableRow(row, competitionId, entrantId, late)) return 'in_flight'
  return { replaces: toSubmission(only) }
}

const selectSpendable = db.prepare(
  'SELECT entrant_id, state FROM submissions WHERE competition_id = ? AND late = 0',
)

/**
 * How many submissions each person has spent — the "SUBMISSIONS" column of the
 * leaderboard (P3).
 *
 * Counted by the daily quota's own rule (`countsTowardDailyQuota`), not by
 * `COUNT(*)`. The column used to count every row: replaced ones, cancelled
 * ones, notebooks that died before their first cell. At the rehearsal on
 * 29 Sep 2026 it showed "6" next to a limit of 5, and three classmates took it
 * for cheating. The number the class sees there and the "left today" its owner
 * reads must be one count, so the rule is called here, not copied into SQL.
 *
 * On-time rows only: the board is the standings as intake left them, and a
 * late submission (Submission.late) is outside them, here as everywhere else
 * on the board.
 */
export function submissionCounts(competitionId: string): Map<string, number> {
  const rows = selectSpendable.all(competitionId) as { entrant_id: string; state: string }[]
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (countsTowardDailyQuota({ state: row.state as SubmissionState })) {
      counts.set(row.entrant_id, (counts.get(row.entrant_id) ?? 0) + 1)
    }
  }
  return counts
}

/** Today's rows of one person, the window either day rule can begin at. */
function todayRows(competitionId: string, entrantId: string, now: number, timeZone: string, except: string | null = null) {
  // Today's start in the zone is the earliest either day can begin: the rule
  // in @shared narrows it for older rows, never widens it.
  const since = dayStart(now, timeZone)
  return (selectSince.all(competitionId, entrantId, since) as { id: string; accepted_at: number; state: string }[])
    .filter((row) => row.id !== except)
    .map((row) => ({ acceptedAt: row.accepted_at, state: row.state as SubmissionState }))
}

/**
 * How many submissions the person has left today; `null` means there is no
 * limit.
 *
 * The rule from `@shared/competitions` computes it, not SQL: the browser draws
 * the same number for the participant ("You can send 3 more submissions
 * today, out of 5"), and this count must not have a second copy. The database
 * only returns the rows for the day.
 *
 * The day is the instance's (server/src/time-zone.ts), the one every other
 * "today" on the server is counted in; it used to be UTC here while the panel
 * counted the server's own zone, so the limit reset at three in the morning
 * Moscow time. Submissions from before the switch are also held to the old
 * day (`zoneSince`, see quotaDayStart), so the update took nothing from
 * anyone mid-competition.
 */
export function leftToday(
  competition: Pick<Competition, 'id' | 'limits'>,
  entrantId: string,
  now = Date.now(),
  /** A submission to leave out — the waiting one a replacement would cancel. */
  except: string | null = null,
  timeZone = instanceTimeZone(),
  zoneSince: number | null = zoneDaysSince(),
): number | null {
  return submissionsLeftToday(competition.limits.perDay, todayRows(competition.id, entrantId, now, timeZone, except), now, timeZone, zoneSince)
}

/** How many of the person's submissions counted toward today's quota — by the same day as `leftToday`. */
export function usedToday(
  competitionId: string,
  entrantId: string,
  now = Date.now(),
  timeZone = instanceTimeZone(),
  zoneSince: number | null = zoneDaysSince(),
): number {
  return todayRows(competitionId, entrantId, now, timeZone)
    .filter((row) => row.acceptedAt <= now && row.acceptedAt >= quotaDayStart(row.acceptedAt, now, timeZone, zoneSince))
    .filter((row) => countsTowardDailyQuota(row)).length
}

/**
 * How many failed submissions the person still may have today before the
 * ceiling refuses (@shared/competitions · failedAttemptsCeiling); null — there
 * is no ceiling. The same day and the same rows as `leftToday`.
 */
export function attemptsLeft(
  competition: Pick<Competition, 'id' | 'limits'>,
  entrantId: string,
  now = Date.now(),
  timeZone = instanceTimeZone(),
  zoneSince: number | null = zoneDaysSince(),
): number | null {
  return attemptsLeftToday(competition.limits.perDay, todayRows(competition.id, entrantId, now, timeZone), now, timeZone, zoneSince)
}

/** How many of the person's submissions failed today, by the ceiling's rule. */
export function failedToday(
  competitionId: string,
  entrantId: string,
  now = Date.now(),
  timeZone = instanceTimeZone(),
  zoneSince: number | null = zoneDaysSince(),
): number {
  return failedAttemptsToday(todayRows(competitionId, entrantId, now, timeZone), now, timeZone, zoneSince)
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
  /** What a blind participant reads instead (Submission.briefError); cut like participantError. */
  briefError?: string | null
  errorType?: string | null
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
  briefError: 'brief_error',
  errorType: 'error_type',
}

export function updateSubmission(id: string, patch: SubmissionPatch): Submission | null {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const column = SUBMISSION_COLUMN[key as keyof SubmissionPatch]
    sets.push(`${column} = @${column}`)
    params[column] =
      key === 'participantError' || key === 'briefError'
        ? clip(value ?? '', LIMITS.participantError) || null
        : key === 'teacherError'
          ? clip(value ?? '', LIMITS.teacherError) || null
          : value
  }
  /*
   * A new participant text without its blind twin clears the twin: a stale
   * brief sentence from an earlier run must not stand for this one, and a
   * blind participant reading nothing is the safe way to be wrong. Whoever
   * writes words that are safe to show blind passes them as `briefError`.
   */
  if (patch.participantError !== undefined && patch.briefError === undefined) sets.push('brief_error = NULL')
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
    // A late one is outside the standings: picking it would count it.
    if (row.state !== 'scored' || row.late === 1) return false
    db.prepare(
      'UPDATE submissions SET chosen = 0 WHERE competition_id = ? AND entrant_id = ?',
    ).run(competitionId, entrantId)
    db.prepare('UPDATE submissions SET chosen = 1 WHERE id = ?').run(submissionId)
    return true
  },
)

/*
 * On-time rows only. A late submission is scored like any other, and this is
 * the one place that keeps it off every board at once: the public and the
 * final one, places, "your place", the teacher's board and the entrants tab,
 * the class's best result and what the sweep keeps. countedSubmission ignores
 * late entries as well, for boards built elsewhere (the panel's feed).
 */
const selectBoardRows = db.prepare(`
  SELECT id, entrant_id, number, accepted_at, state, public_score, private_score, chosen
  FROM submissions
  WHERE competition_id = ? AND state = 'scored' AND public_score IS NOT NULL AND late = 0
  ORDER BY entrant_id, accepted_at
`)

/**
 * The leaderboard of one part of the test.
 *
 * Sorting, places and picking the counted submission are computed by
 * `@shared/competitions`, not SQL: the rule "on a tie, whoever submitted
 * earlier ranks higher" and the proviso "did not choose — the best on the
 * public part" must work the same on the server and in the browser, which
 * draws the same table from the same answer.
 *
 * The baseline is a row here like anyone, and the places count it: every
 * door that shows a place counts it again among people only
 * (`placesByScore`, `placesAmongPeople`).
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

/* The summary is about the standings: late submissions are counted apart. */
const selectSummary = db.prepare(`
  SELECT state, COUNT(*) AS n FROM submissions WHERE competition_id = ? AND late = 0 GROUP BY state
`)
const selectLateCount = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE competition_id = ? AND late = 1')
const selectBest = db.prepare(`
  SELECT MIN(public_score) AS low, MAX(public_score) AS high FROM submissions
  WHERE competition_id = ? AND state = 'scored' AND public_score IS NOT NULL AND late = 0
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
  /** Late submissions, which none of the numbers above count. */
  late: number
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
    late: (selectLateCount.get(id) as { n: number }).n,
  }
}

const countPendingResults = db.prepare(`
  SELECT COUNT(*) AS n FROM submissions
  WHERE competition_id = ? AND state IN ('queued', 'running') AND accepted_at <= ? AND late = 0
`)

/**
 * Submissions accepted by `cutoff` that have no result yet — what the
 * automatic private release waits for (results.ts).
 *
 * On-time ones only: a late submission is in no table, and waiting for it
 * would hold the final results back for as long as late intake stays open —
 * forever after "Finish now" without a deadline, where the cutoff is
 * MAX_SAFE_INTEGER.
 */
export function pendingResultsCount(competitionId: string, cutoff: number): number {
  return (countPendingResults.get(competitionId, cutoff) as { n: number }).n
}

/*
 * Durations of finished runs, newest first — what the queue estimate is made
 * of (forecast.ts). A cancelled submission is left out: its duration is the
 * moment someone pressed a button, not how long the notebook runs.
 */
const selectRecentDurations = db.prepare(`
  SELECT duration_ms FROM submissions
  WHERE competition_id = ? AND duration_ms > 0 AND state NOT IN ('queued', 'running', 'cancelled')
  ORDER BY accepted_at DESC, number DESC LIMIT ?
`)
const selectRecentDurationsAll = db.prepare(`
  SELECT duration_ms FROM submissions
  WHERE duration_ms > 0 AND state NOT IN ('queued', 'running', 'cancelled')
  ORDER BY accepted_at DESC LIMIT ?
`)
const selectRecentMetricRuns = db.prepare(`
  SELECT finished_at - started_at AS ms FROM submission_runs
  WHERE kind = 'metric' AND finished_at IS NOT NULL AND finished_at > started_at
  ORDER BY started_at DESC LIMIT ?
`)

/** Recent durations of one competition's runs, or of the whole instance's with `null`. */
export function recentDurations(competitionId: string | null, limit: number): number[] {
  const rows = (competitionId === null
    ? selectRecentDurationsAll.all(limit)
    : selectRecentDurations.all(competitionId, limit)) as { duration_ms: number }[]
  return rows.map((row) => row.duration_ms)
}

/** Recent metric-only runs across the instance — what a rescore takes. */
export function recentMetricRuns(limit: number): number[] {
  return (selectRecentMetricRuns.all(limit) as { ms: number }[]).map((row) => row.ms)
}

const selectLastLate = db.prepare(
  'SELECT MAX(COALESCE(sent_at, accepted_at)) AS at FROM submissions WHERE competition_id = ? AND late = 1',
)

/** When the competition's latest late submission arrived; null — it has none (housekeeping.ts). */
export function lastLateSubmissionAt(competitionId: string): number | null {
  return (selectLastLate.get(competitionId) as { at: number | null }).at ?? null
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
  revision_id?: string | null
}

function toRun(row: RunRow): SubmissionRun {
  return {
    attemptId: row.attempt_id,
    inputRevision: row.input_revision,
    // Only where one is recorded (a metric run): every other run reads as it always did.
    ...(row.revision_id ? { revisionId: row.revision_id } : {}),
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
  INSERT INTO submission_runs (id, submission_id, seq, kind, started_at, container, attempt_id, input_revision, sealed_inputs, revision_id)
  VALUES (@id, @submission_id, @seq, @kind, @at, @container, @attempt_id, @input_revision, @sealed_inputs, @revision_id)
`)
/* Sticky: once a run of the submission has read the hidden test, it stays blind (Submission.sealedInputs). */
const markSealed = db.prepare('UPDATE submissions SET sealed_inputs = 1 WHERE id = ?')
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
    /** The notebook reads the hidden test in this run. */
    sealedInputs?: boolean
    /** The environment revision a metric run scores in (submission_runs.revision_id). */
    revisionId?: string | null
  }): SubmissionRun => {
    const id = newId()
    if (input.sealedInputs) markSealed.run(input.submissionId)
    insertRun.run({
      id,
      submission_id: input.submissionId,
      seq: (nextRunSeq.get(input.submissionId) as { n: number }).n,
      kind: input.kind,
      at: input.at ?? Date.now(),
      container: input.container ?? null,
      attempt_id: input.attemptId ?? null,
      input_revision: input.inputRevision ?? null,
      sealed_inputs: input.sealedInputs ? 1 : 0,
      revision_id: input.revisionId ?? null,
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
  /** Its submission is late: on-time work goes first (see the selection order). */
  late: boolean
  /**
   * The runner card this run holds, from the moment it was taken until the
   * attempt ends, metric step included; `null` — no card of ours: a run on
   * the CPU, a waiting row, or a GPU run the cluster places itself.
   */
  gpu: string | null
  /**
   * How many runs shared that card when this one took it — its share is one
   * of them (1: the whole card, uncapped). Pinned at the take, whatever the
   * owner sets afterwards; `null` with no card.
   */
  gpuPerDevice: number | null
  /**
   * The share in MB that makes on that card; `null` with no card, until the
   * card has said its size (runner.ts · runGpu), or when it cannot.
   */
  gpuSliceMb: number | null
  /**
   * The machine whose lease this running row is (competition_queue.holder);
   * `null` — this server's own run, and every waiting row.
   */
  holder: string | null
  /** Losses on machines after the container started (competition_queue.lost). */
  lost: number
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
  late: number
  gpu: string | null
  gpu_per_device?: number | null
  gpu_slice_mb?: number | null
  holder?: string | null
  lost?: number
  /** Only from `selectNext`: whether this work needs a card share (NEEDS_CARD). */
  needs_gpu?: number
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
    late: row.late === 1,
    gpu: row.gpu ?? null,
    gpuPerDevice: row.gpu_per_device ?? null,
    gpuSliceMb: row.gpu_slice_mb ?? null,
    holder: row.holder ?? null,
    lost: row.lost ?? 0,
  }
}

/** A row letting its card go: the card and what was promised on it go together. */
const NO_CARD = 'gpu = NULL, gpu_per_device = NULL, gpu_slice_mb = NULL'

// A waiting row never holds a card, nor has a holder: a row put back into waiting lets both go.
// New work starts its losses over (competition_queue.lost).
const upsertQueue = db.prepare(`
  INSERT INTO competition_queue
    (submission_id, competition_id, entrant_id, kind, state, enqueued_at, turn, late)
  VALUES (@submission_id, @competition_id, @entrant_id, @kind, 'waiting', @at, ${TURN}, ${LATE})
  ON CONFLICT(submission_id) DO UPDATE SET
    kind = excluded.kind,
    late = excluded.late,
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
    pending_kind = NULL,
    holder = NULL,
    lost = 0,
    ${NO_CARD}
  WHERE competition_queue.state != 'running'
`)
/* Running on top, the waiting after it in arrival order — as the panel reads it. */
const selectQueue = db.prepare(`
  SELECT * FROM competition_queue
  ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, enqueued_at, submission_id
`)
const selectQueueRow = db.prepare('SELECT * FROM competition_queue WHERE submission_id = ?')
/*
 * The rows THIS server runs (competition_queue.holder): what its slots, its
 * cards, its neighbour checks and «Работают сейчас» count. A machine's running
 * row stays in the queue — in queueRows, in the fair order — and takes none
 * of this.
 */
const selectRunning = db.prepare(`SELECT * FROM competition_queue WHERE state = 'running' AND holder IS NULL`)
/* How many of them, in one lane or all together (QueueLane): what a take compares with its places. */
const countRunningHere = db.prepare(`
  SELECT COUNT(*) AS n FROM competition_queue
  WHERE state = 'running' AND holder IS NULL AND (@kind IS NULL OR kind = @kind)
`)
const deleteQueueRow = db.prepare('DELETE FROM competition_queue WHERE submission_id = ?')
const countWaiting = db.prepare(
  `SELECT COUNT(*) AS n FROM competition_queue WHERE state = 'waiting'`,
)
const countWaitingOf = db.prepare(
  `SELECT COUNT(*) AS n FROM competition_queue WHERE state = 'waiting' AND kind = ?`,
)
const markRunning = db.prepare(`
  UPDATE competition_queue
  SET state = 'running', started_at = @at, attempts = attempts + 1, boot = @boot,
      container = @container, attempt_id = @attempt_id, gpu = @gpu,
      gpu_per_device = @gpu_per_device, gpu_slice_mb = NULL, holder = @holder
  WHERE submission_id = @submission_id
`)
const markWaiting = db.prepare(`
  UPDATE competition_queue
  SET state = 'waiting', started_at = NULL, boot = NULL, container = NULL, attempt_id = NULL, not_before = 0, holder = NULL, ${NO_CARD}
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

/** This server's running rows (selectRunning); a machine's are not among them. */
export function runningRows(): QueueRow[] {
  return (selectRunning.all() as QueueRowRaw[]).map(toQueueRow)
}

/**
 * The two lanes of this server's pump (runner.ts · pumpOnce,
 * docs/architecture/remote-runners.md §5.3).
 *
 * `notebook` — notebook runs; a notebook run here keeps its metric under the
 * same lease, so the row stays `notebook` until both steps end, exactly as
 * before the lanes. `metric` — metric-only work: a rescore, and the metric of
 * a notebook a machine ran (runner.ts · continueAsMetric). Each lane takes
 * only its own kind and counts only its own running rows against its own
 * places, so a hundred rescores never hold a notebook's slot, and no notebook
 * keeps a fresh result's metric waiting.
 *
 * No lane — any work, against every running row of this server: how the
 * queue took work before the lanes, kept for the callers from before them.
 */
export type QueueLane = 'notebook' | 'metric'

/** This server's running rows in one lane, or all of them: what a take compares with its places. */
export function runningCount(lane?: QueueLane): number {
  return (countRunningHere.get({ kind: lane ?? null }) as { n: number }).n
}

/** Waiting work, of one lane's kind or of any (QueueLane). */
export function waitingCount(lane?: QueueLane): number {
  if (!lane) return (countWaiting.get() as { n: number }).n
  return (countWaitingOf.get(lane) as { n: number }).n
}

/*
 * Work that needs a share of a runner card: a NOTEBOOK run of a competition
 * whose card is on (CompetitionLimits.gpu). A rescore runs only the metric,
 * and the metric never gets a card — it holds the hidden answers — so it
 * waits for none. Read from the competition at the take, like everything the
 * order reads: a teacher who turns the card off lets the waiting notebooks go
 * on the CPU at once.
 */
const NEEDS_CARD = `(q.kind = 'notebook' AND EXISTS
  (SELECT 1 FROM competitions c WHERE c.id = q.competition_id AND c.gpu = 1))`

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
 * Before all three, on-time work goes ahead of late work: a late submission
 * is outside the standings, and the final results wait for every on-time
 * notebook and every rescore of one, not for fixes sent after the deadline.
 *
 * And one filter, which is not a key: work that needs a share of a runner
 * card (NEEDS_CARD) is passed over while no share is free (`@card_free`), and
 * the next work in the order is taken instead. Passed over, not waited for:
 * a GPU notebook waiting for a card must not hold up the CPU work behind it,
 * and CPU work never makes a GPU notebook wait for anything but a general
 * slot — the moment a share frees, the GPU notebook is first again in the
 * place the keys give it. panel.ts · queueEtas simulates exactly this.
 *
 * Computed in SQL, not in memory, because the queue is database state, and
 * two processes (the server and, one day, a separate runner) must see one and
 * the same answer.
 *
 * "Something running" counts the person's running rows WHEREVER they run —
 * here or on a machine that runs submissions (competition_queue.holder): a
 * person whose notebook is on a machine occupies the executor just as much.
 * panel.ts · fairOrder copies this count, and the two must not part.
 *
 * `@kind` keeps the selection to one lane's work (QueueLane); NULL — any.
 */
const FAIR_ORDER = `
    q.late ASC,
    (SELECT COUNT(*) FROM competition_queue r
      WHERE r.state = 'running' AND r.entrant_id = q.entrant_id) ASC,
    q.turn ASC,
    q.enqueued_at ASC,
    q.submission_id ASC`
const selectNext = db.prepare(`
  SELECT q.*, ${NEEDS_CARD} AS needs_gpu FROM competition_queue q
  WHERE q.state = 'waiting' AND q.not_before <= @at
    AND (@card_free = 1 OR NOT ${NEEDS_CARD})
    AND (@kind IS NULL OR q.kind = @kind)
  ORDER BY ${FAIR_ORDER}
  LIMIT 1
`)

/*
 * The metric lane's order (QueueLane `metric`): a fresh result before a
 * rescore, then the fair order above within each. A fresh result is the
 * metric of a notebook that has just run on a machine, and its submission
 * still reads «running» at its score stage (runner.ts · continueAsMetric); a
 * rescore's waits as «queued». A rescore after a metric fix is a hundred rows
 * at once, and behind them a participant who has just watched their notebook
 * finish would wait minutes for a number the machine has already earned.
 * panel.ts · scoreOrder is the same order for the screens. No card filter: a
 * metric never gets a card (NEEDS_CARD is only ever a notebook's).
 */
const selectNextScore = db.prepare(`
  SELECT q.*, 0 AS needs_gpu FROM competition_queue q
  WHERE q.state = 'waiting' AND q.not_before <= @at AND q.kind = 'metric'
  ORDER BY
    EXISTS (SELECT 1 FROM submissions s WHERE s.id = q.submission_id AND s.state = 'running') DESC,
    ${FAIR_ORDER}
  LIMIT 1
`)

/**
 * The runner cards, as the queue takes work that needs one
 * (competitions/gpu.ts · runnerGpuState): each card with how many runs it may
 * hold now — none while a class still holds it — and the containers the
 * runner still has to remove, card → how many (Capacity.heldGpus): such a
 * container keeps its share until it is gone.
 *
 * A card's `capacity` is the runs per card a new run is taken at, and the
 * take writes it into the row (QueueRow.gpuPerDevice): what the card already
 * holds is weighed by the shares its runs were given, not counted by heads
 * (gpu.ts · cardsInUse), so a card whose runs were taken at one run per card
 * stays full after the owner raises the number, until they end.
 *
 * `cluster` — under the cluster: how many GPU notebooks of this instance may
 * run at once (the broker's competition.gpuSlots, runner.ts · queueCards).
 * The queue keeps no card there, and counts its running GPU notebooks
 * instead: a GPU notebook taken past that number held a general slot for half
 * a minute while its Pod waited for a unit, and came back to the head of the
 * queue, over and over, while the CPU work behind it waited.
 *
 * Absent, the queue takes GPU work like any other and gives it no card: for
 * callers from before cards.
 */
export interface QueueGpu {
  cards: ReadonlyArray<{ id: string; capacity: number }>
  held?: Readonly<Record<string, number>>
  cluster?: number
}

/*
 * The shares of THIS server's cards its running rows hold, and under the
 * cluster its own GPU notebooks — never a machine's (competition_queue.holder).
 * A machine's cards are its own, and never enter competition_queue.gpu; but a
 * machine's GPU notebook has no card here (gpu NULL) and needs one by
 * NEEDS_CARD, so without the holder it would count as one of the cluster's
 * places, and take one from this server.
 */
const selectCardLoad = db.prepare(`
  SELECT gpu, gpu_per_device FROM competition_queue
  WHERE state = 'running' AND gpu IS NOT NULL AND holder IS NULL
`)

const countClusterGpuRuns = db.prepare(`
  SELECT COUNT(*) AS n FROM competition_queue q
  WHERE q.state = 'running' AND q.gpu IS NULL AND q.holder IS NULL AND ${NEEDS_CARD}
`)

/**
 * Where the next GPU run would go right now: a card and the runs per card it
 * is taken at, or — under the cluster — no card of ours (`device: null`);
 * `null` — no share is free. Counted from the running rows at this very
 * moment, not from the pump's picture at the start of its pass: each take
 * writes its card into its row, so the second take of a pass already sees
 * the first.
 */
function freeShare(gpu: QueueGpu): { device: string | null; perDevice: number | null } | null {
  if (gpu.cluster !== undefined) {
    return (countClusterGpuRuns.get() as { n: number }).n < gpu.cluster ? { device: null, perDevice: null } : null
  }
  const runs = (selectCardLoad.all() as Array<{ gpu: string; gpu_per_device: number | null }>)
    .map((row) => ({ device: row.gpu, perDevice: row.gpu_per_device }))
  const device = pickRunnerGpu(gpu.cards, cardsInUse(gpu.cards, runs, gpu.held))
  if (device === null) return null
  return { device, perDevice: gpu.cards.find((card) => card.id === device)?.capacity ?? null }
}

/** `@card_free` of the selection: without cards to count there is nothing to filter by. */
function cardFree(gpu: QueueGpu | undefined, share: unknown): 0 | 1 {
  return gpu === undefined || share !== null ? 1 : 0
}

/**
 * The next work of a lane (QueueLane; any work without one), and the card
 * share it would be given. The metric lane has its own order and no card: a
 * metric never gets one, whatever is free.
 */
function pickNext(at: number, gpu: QueueGpu | undefined, lane: QueueLane | undefined): { row: QueueRowRaw; share: ReturnType<typeof freeShare> } | null {
  if (lane === 'metric') {
    const row = selectNextScore.get({ at }) as QueueRowRaw | undefined
    return row ? { row, share: null } : null
  }
  const share = gpu ? freeShare(gpu) : null
  const row = selectNext.get({ at, card_free: cardFree(gpu, share), kind: lane ?? null }) as QueueRowRaw | undefined
  return row ? { row, share } : null
}

/**
 * The work the next take would start, without taking it — what the pump
 * admits for memory before it takes. `gpu` and `lane` must be the ones the
 * take gets: the same filter over the same rows names the same work, and an
 * admission for one job followed by the take of another is a reservation
 * sized for the wrong submission.
 */
export function nextQueueRow(at = Date.now(), gpu?: QueueGpu, lane?: QueueLane): QueueRow | null {
  const next = pickNext(at, gpu, lane)
  return next ? toQueueRow(next.row) : null
}

const selectCardWork = db.prepare(`
  SELECT 1 FROM competition_queue q
  WHERE q.state = 'waiting' AND q.not_before <= @at AND ${NEEDS_CARD}
  LIMIT 1
`)

/**
 * Whether any work that may be taken now needs a card share. The pump asks
 * before it counts the cards: the count is a census of the rooms' containers
 * (docker ps), and a queue of CPU work has no use for it.
 */
export function cardWorkWaiting(at = Date.now()): boolean {
  return selectCardWork.get({ at }) !== undefined
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
 * of one run on the day there are two runners. The card is chosen in it for
 * the same reason (`gpu`, see QueueGpu): with the counts read here, by the
 * one rule (competitions/gpu.ts · pickRunnerGpu) — two takes that each saw
 * "one share left" on a card would otherwise both put a run on it. The card
 * goes only to work that needs one; any other work takes none, whatever is
 * free.
 *
 * `lane` — one lane of the pump (QueueLane): its own work against its own
 * places (`slots`), counted over this server's running rows of that lane
 * only. A row a machine holds is neither taken (it is running) nor counted
 * (it holds nothing here); the row taken here has no holder.
 */
export const takeNext = db.transaction(
  (opts: { boot?: string; at?: number; slots?: number; gpu?: QueueGpu; lane?: QueueLane } = {}): QueueRow | null => {
    if (queuePaused()) return null
    const slots = opts.slots ?? 1
    if (runningCount(opts.lane) >= slots) return null
    const at = opts.at ?? Date.now()
    const next = pickNext(at, opts.gpu, opts.lane)
    if (!next) return null
    const { row, share } = next
    const card = opts.gpu && row.needs_gpu === 1 ? share : null
    markRunning.run({
      submission_id: row.submission_id,
      at,
      boot: opts.boot ?? BOOT,
      container: null,
      // 32 hex digits, the only attempt the Kubernetes broker takes
      // (shared/competition-runtime.ts · COMPETITION_ATTEMPT_ID). A dashed UUID
      // made every submission on the broker fail at once as "Invalid submission
      // job identity"; the k3s smoke named its attempts itself and never saw it.
      attempt_id: randomUUID().replaceAll('-', ''),
      gpu: card?.device ?? null,
      // The share is pinned with the card: the run is built from it, whatever the owner sets next.
      gpu_per_device: card?.device ? card.perDevice : null,
      holder: null,
    })
    return toQueueRow(selectQueueRow.get(row.submission_id) as QueueRowRaw)
  },
)

/**
 * The share in MB a running row's card makes of its pinned runs per card,
 * once the card has said its size (runner.ts · runGpu): what the console
 * shows next to the run, and what the run itself was capped to.
 */
export function noteQueueGpuShare(row: QueueRow, sliceMb: number | null): void {
  if (!row.attemptId) return
  db.prepare('UPDATE competition_queue SET gpu_slice_mb = ? WHERE submission_id = ? AND attempt_id = ? AND gpu IS NOT NULL')
    .run(sliceMb, row.submissionId, row.attemptId)
}

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
  // A waiting row has no holder: a machine's run crowded off its card (crowded) waits like one of ours.
  db.prepare(`UPDATE competition_queue SET kind=COALESCE(pending_kind,?),pending_kind=NULL,state='waiting',
    started_at=NULL,boot=NULL,container=NULL,attempt_id=NULL,holder=NULL,${NO_CARD},attempts=?,resource_retries=?,not_before=?
    WHERE submission_id=? AND attempt_id=?`).run(nextKind,fresh?0:Math.max(0,current.attempts-1),fresh?0:current.resourceRetries+1,notBefore,row.submissionId,row.attemptId)
  // Our own words about the queue: safe to show a blind participant as they are.
  updateSubmission(row.submissionId,{state:'queued',stage:'queue',participantError:reason,briefError:reason,teacherError:teacherReason})
  return notBefore
})

export const finishQueueAttempt = db.transaction((row: QueueRow): boolean => {
  if (!ownsQueueAttempt(row)) return false
  const current = queueRow(row.submissionId)!
  if (current.pendingKind) {
    // Back to waiting for the work asked meanwhile: the card goes with the attempt that held it.
    db.prepare(`UPDATE competition_queue SET kind = pending_kind, pending_kind = NULL, state = 'waiting', started_at = NULL, container = NULL, boot = NULL, attempt_id = NULL, holder = NULL, ${NO_CARD}, attempts = 0,resource_retries=0,not_before=0 WHERE submission_id = ? AND attempt_id = ?`).run(row.submissionId, row.attemptId)
    updateSubmission(row.submissionId, { state: 'queued', stage: 'queue', publicScore: null, privateScore: null })
  } else db.prepare('DELETE FROM competition_queue WHERE submission_id = ? AND attempt_id = ?').run(row.submissionId, row.attemptId)
  return true
})

/**
 * A notebook a machine ran is over, its answer promoted (runner.ts ·
 * continueAsMetric): the row becomes this server's metric work, in the
 * metric lane, and the submission says how long the notebook took. One
 * transaction, fenced on the attempt and its holder, so a late or repeated
 * outcome changes nothing; `null` — the attempt is not this row's any more.
 *
 * The row keeps its place: its turn, its arrival and its lateness are the
 * submission's, not the machine's, and a result that comes back must not go
 * behind every upload sent while its notebook ran. It starts over as new
 * work of this server: no holder, no attempts, no retries — a metric lost to
 * a restart here is this server's to reclaim (reclaimQueue), as any rescore.
 * `durationMs` is the notebook's wall: the metric adds its own to it
 * (runner.ts · scoreOnly → scoreStep), so the total reads as for a run here.
 * The submission stays «running», at its score stage: that is what puts a
 * fresh result ahead of a rescore (selectNextScore).
 *
 * Work asked for meanwhile — a rerun, a rescore (`pending_kind`) — replaces
 * the metric, exactly as finishQueueAttempt lets it replace the rest of a
 * run here, and the submission waits for it as «queued». Returns the kind
 * the row now waits for.
 */
export const continueQueueAsMetric = db.transaction(
  (row: QueueRow, notebook: { durationMs: number; cellsDone: number; cellsTotal: number }): RunKind | null => {
    if (!ownsQueueAttempt(row)) return null
    const current = queueRow(row.submissionId)!
    if (current.holder !== row.holder) return null
    const next: RunKind = current.pendingKind ?? 'metric'
    db.prepare(`UPDATE competition_queue SET kind = ?, pending_kind = NULL, state = 'waiting', started_at = NULL, container = NULL,
      boot = NULL, attempt_id = NULL, holder = NULL, ${NO_CARD}, attempts = 0, resource_retries = 0, not_before = 0
      WHERE submission_id = ? AND attempt_id = ?`).run(next, row.submissionId, row.attemptId)
    updateSubmission(row.submissionId, current.pendingKind
      ? { state: 'queued', stage: 'queue', publicScore: null, privateScore: null, ...notebook }
      : { stage: 'score', ...notebook })
    return next
  },
)

/** The work ended (in whatever way) — the row leaves the queue. */
export function leaveQueue(submissionId: string): boolean {
  return deleteQueueRow.run(submissionId).changes > 0
}

/** Return work to waiting: cancelled by a pause, killed by hand, did not get through. */
export function requeue(submissionId: string): boolean {
  return markWaiting.run(submissionId).changes > 0
}

/* -------------------------------------------- rows a machine holds (holder) */

/**
 * The waiting notebook rows in the order `selectNext` takes them (FAIR_ORDER),
 * each with whether it needs a card share (NEEDS_CARD): what the take for a
 * machine that runs submissions walks (competitions/remote/lease.ts ·
 * takeForRunner). One query, one order: the machine skips the rows it cannot
 * run, but never reorders the rest, so a person's place is the same whoever
 * takes their notebook.
 */
const selectWaitingNotebooks = db.prepare(`
  SELECT q.*, ${NEEDS_CARD} AS needs_gpu FROM competition_queue q
  WHERE q.state = 'waiting' AND q.not_before <= @at AND q.kind = 'notebook'
  ORDER BY ${FAIR_ORDER}
`)

export function waitingNotebookOrder(at = Date.now()): Array<QueueRow & { needsGpu: boolean }> {
  return (selectWaitingNotebooks.all({ at }) as QueueRowRaw[]).map((row) => ({ ...toQueueRow(row), needsGpu: row.needs_gpu === 1 }))
}

/*
 * The take's own write for a machine (markRunning with a holder), fenced on
 * the row still waiting: inside the take's transaction nothing else can have
 * moved it, and the fence keeps it so should the take ever be called outside
 * one. The card is never written: a machine's cards are its own and never
 * enter competition_queue.gpu (§5.1), and `boot` is this server's life, which
 * a machine's row never needs and reclaimQueue never reads for it.
 */
const markHeld = db.prepare(`
  UPDATE competition_queue
  SET state = 'running', started_at = @at, attempts = attempts + 1, boot = @boot,
      container = NULL, attempt_id = @attempt_id, gpu = NULL, gpu_per_device = NULL, gpu_slice_mb = NULL, holder = @holder
  WHERE submission_id = @submission_id AND state = 'waiting' AND kind = 'notebook'
`)

/**
 * Mark a waiting notebook row as the machine `holder`'s run, under a new
 * attempt; `null` — it is not waiting any more. A `null` holder takes it as
 * this server's own run of this life (BOOT), for one that never reaches a
 * container: a package set that cannot fit, settled here when this server
 * runs no notebooks (competitions/remote/liveness.ts · settleUnfit).
 */
export function holdQueueRow(submissionId: string, holder: string | null, at = Date.now()): QueueRow | null {
  const attemptId = randomUUID().replaceAll('-', '')
  const changed = markHeld.run({ submission_id: submissionId, at, boot: BOOT, attempt_id: attemptId, holder }).changes
  return changed > 0 ? queueRow(submissionId) : null
}

/*
 * A machine's run goes back to waiting (markWaiting), fenced on its attempt
 * and holder: a loss, a withdrawn offer, a decline. The row keeps its
 * arrival, its turn and its lateness — the machine's trouble is no reason to
 * send a person to the end of the queue — and `lost` counts a loss after the
 * container started (`lost` 1), toward the third that ends the submission as
 * our failure (decision 6). The attempt is refunded either way: `attempts`
 * counts this server's restarts (reclaimQueue), never a machine's losses.
 */
const requeueHeld = db.prepare(`
  UPDATE competition_queue
  SET state = 'waiting', started_at = NULL, boot = NULL, container = NULL, attempt_id = NULL, not_before = 0, holder = NULL,
      attempts = MAX(0, attempts - 1), lost = lost + @lost, ${NO_CARD}
  WHERE submission_id = @submission_id AND attempt_id = @attempt_id AND holder = @holder AND state = 'running'
`)

export function requeueHeldRow(row: Pick<QueueRow, 'submissionId' | 'attemptId' | 'holder'>, lost: boolean): boolean {
  if (!row.attemptId || !row.holder) return false
  return requeueHeld.run({ submission_id: row.submissionId, attempt_id: row.attemptId, holder: row.holder, lost: lost ? 1 : 0 }).changes > 0
}

/** The row of a machine's run leaves the queue, fenced on its attempt and holder: a cancel, a third loss. */
export function leaveHeldRow(row: Pick<QueueRow, 'submissionId' | 'attemptId' | 'holder'>): boolean {
  if (!row.attemptId || !row.holder) return false
  return db.prepare("DELETE FROM competition_queue WHERE submission_id = ? AND attempt_id = ? AND holder = ? AND state = 'running'")
    .run(row.submissionId, row.attemptId, row.holder).changes > 0
}

/**
 * When a machine's container really started, on this server's clock (now
 * less what the machine says it has run): the console's clock and the
 * forecast's elapsed time count from here, so pulls and downloads never eat
 * the participant's time (§2, step 5). Written once per attempt, and only
 * while the attempt is still this row's.
 */
export function noteHeldStart(row: Pick<QueueRow, 'submissionId' | 'attemptId' | 'holder'>, startedAt: number): boolean {
  if (!row.attemptId || !row.holder) return false
  return db.prepare("UPDATE competition_queue SET started_at = ? WHERE submission_id = ? AND attempt_id = ? AND holder = ? AND state = 'running'")
    .run(startedAt, row.submissionId, row.attemptId, row.holder).changes > 0
}

/** Every running row a machine holds (holder NOT NULL), for the console and «Работают сейчас». */
export function heldRows(): QueueRow[] {
  return (db.prepare("SELECT * FROM competition_queue WHERE state = 'running' AND holder IS NOT NULL ORDER BY started_at, submission_id").all() as QueueRowRaw[]).map(toQueueRow)
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
 *
 * Only this server's own (competition_queue.holder): a row a machine holds
 * is a run that outlives this process by design — its container is the
 * machine's, and the machine keeps it going and reports it once the tunnel
 * is back. Reclaiming it here would requeue a run still in progress and run
 * the notebook twice; its fate is the lease's (remote_leases), not the boot's.
 */
export function orphanedRuns(boot = BOOT): QueueRow[] {
  return (
    db
      .prepare(`SELECT * FROM competition_queue WHERE state = 'running' AND holder IS NULL AND (boot IS NULL OR boot != ?)`)
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
        teacherError: tr('competitions.answer.restartAbandoned', { attempts: row.attempts }),
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

/* ------------------------------------------------ removing a participant */

export interface EntrantRemoval {
  /** The removed submissions: their directories on disk are the caller's to remove. */
  submissionIds: string[]
  /**
   * The person's identity went too, and with it their key: they took part in
   * no other competition. Otherwise it stays, and the key keeps working there.
   */
  identityRemoved: boolean
}

const selectRunningOf = db.prepare(`
  SELECT 1 FROM competition_queue
  WHERE competition_id = ? AND entrant_id = ? AND state = 'running' LIMIT 1
`)
const selectSubmissionIdsOf = db.prepare(
  'SELECT id FROM submissions WHERE competition_id = ? AND entrant_id = ?',
)
const deleteRunsOf = db.prepare(`
  DELETE FROM submission_runs WHERE submission_id IN
    (SELECT id FROM submissions WHERE competition_id = ? AND entrant_id = ?)
`)
const deleteQueueOf = db.prepare(`
  DELETE FROM competition_queue WHERE submission_id IN
    (SELECT id FROM submissions WHERE competition_id = ? AND entrant_id = ?)
`)
const deleteSubmissionsOf = db.prepare('DELETE FROM submissions WHERE competition_id = ? AND entrant_id = ?')
const deleteEnrollment = db.prepare('DELETE FROM competition_entrants WHERE competition_id = ? AND entrant_id = ?')
const selectAnywhere = db.prepare(`
  SELECT 1 FROM competition_entrants WHERE entrant_id = @e
  UNION ALL SELECT 1 FROM submissions WHERE entrant_id = @e
  UNION ALL SELECT 1 FROM competitions WHERE baseline_entrant_id = @e
  LIMIT 1
`)
const deleteEntrantRow = db.prepare('DELETE FROM entrants WHERE id = ?')

/**
 * Remove one person from one competition: every submission with its runs and
 * queue rows, the enrollment, and — when they take part nowhere else — the
 * person themselves with their key. `'running'` means one of their
 * submissions is in a container right now, and nothing was touched: its run
 * would go on writing into a directory this removal is about to take away.
 *
 * Rows only. The disk is the caller's (competitions/erase.ts), after the
 * commit and out loud, the same order `deleteCompetition` keeps; so are the
 * rows of prepared package sets, which live under another owner
 * (dependencies/store.ts) and go in the caller's transaction around this one.
 *
 * The boards are not stored anywhere, so there is nothing to recompute: every
 * door counts them from the submissions table (`leaderboard`), and the
 * places of everyone below close up by themselves, one per row. The triggers
 * bump the competition's revision, and the teacher's live screen re-reads.
 */
export const removeEntrantRows = db.transaction(
  (competitionId: string, entrantId: string): EntrantRemoval | 'running' => {
    if (selectRunningOf.get(competitionId, entrantId)) return 'running'
    const submissionIds = (selectSubmissionIdsOf.all(competitionId, entrantId) as { id: string }[]).map((row) => row.id)
    deleteRunsOf.run(competitionId, entrantId)
    deleteQueueOf.run(competitionId, entrantId)
    deleteSubmissionsOf.run(competitionId, entrantId)
    deleteEnrollment.run(competitionId, entrantId)
    // A person is instance-wide: they go only when nothing else holds them.
    // The service entrant of a sample notebook is held by its competition.
    const identityRemoved = selectAnywhere.get({ e: entrantId }) === undefined
      && deleteEntrantRow.run(entrantId).changes > 0
    return { submissionIds, identityRemoved }
  },
)

/* -------------------------------------------------------------- cleanup */

/**
 * Which parts of submissions are worth keeping on disk.
 *
 * The numbers live in the database forever — the leaderboard must add up even
 * a year later. The heavy stuff (the submitted notebook, the executed notebook
 * with output, the answer) is needed while the participant is dealing with a
 * failure, and may go for a competition closed long ago. The decision is made
 * here, because it is a question for the database; `storage.ts` removes the
 * files. WHEN it is asked is competitions/housekeeping.ts's business.
 *
 * Kept, whatever their age:
 *
 * - a submission still waiting or running: its run reads `in/` and writes
 *   `out/` (a rescore queued for an old one reads its answer);
 * - every submission that counts on a board, public or final: "rescore
 *   everyone" after a metric fix at the review needs exactly their answers,
 *   and one without an answer would keep a number computed by the old metric
 *   next to numbers from the new one;
 * - one its author chose to count, for the same reason, and the competition's
 *   current sample-notebook run, which "check the metric" scores again;
 * - each person's `keepPerEntrant` latest, whose notebooks they still open.
 *
 * Returns what went: how many submission directories and how many bytes.
 */
export function pruneCompetitionFiles(competitionId: string, keepPerEntrant = 10): { removed: number; bytes: number } {
  const competition = getCompetition(competitionId)
  if (!competition) return { removed: 0, bytes: 0 }
  const rows = db
    .prepare(
      `SELECT id, entrant_id, state, chosen FROM submissions WHERE competition_id = ?
       ORDER BY entrant_id, accepted_at DESC, number DESC`,
    )
    .all(competitionId) as { id: string; entrant_id: string; state: string; chosen: number }[]
  const keep = new Set<string>()
  for (const row of queueRows()) if (row.competitionId === competitionId) keep.add(row.submissionId)
  for (const part of ['public', 'private'] as const) {
    for (const row of leaderboard(competitionId, part)) keep.add(row.submissionId)
  }
  if (competition.baselineSubmissionId) keep.add(competition.baselineSubmissionId)
  const seen = new Map<string, number>()
  for (const row of rows) {
    if (row.state === 'queued' || row.state === 'running' || row.chosen === 1) keep.add(row.id)
    const used = seen.get(row.entrant_id) ?? 0
    if (used >= keepPerEntrant) continue
    seen.set(row.entrant_id, used + 1)
    keep.add(row.id)
  }
  return pruneSubmissions(competitionId, keep)
}
