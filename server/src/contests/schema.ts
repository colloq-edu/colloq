/**
 * Contests: the tables (docs/architecture/contests.md §1), created when this
 * module loads.
 *
 * A MODULE OF ITS OWN, AND IMPORTED FIRST BY competitions/store.ts. The
 * participant of a contest is the competitions' instance-level entrant (the
 * same key, the same cookie, the same `/k` list), and the competitions' store
 * decides when a person may be deleted as a whole: only when nothing holds
 * them any more. That question now has two more answers — an enrollment in a
 * contest and a contest submission — so the statement that asks it must be
 * prepared with these tables already in place. Hence a side-effect module
 * that touches nothing but `db`: competitions/store.ts imports it before it
 * prepares that statement, and neither module has to load the other's rows.
 *
 * New tables only, `CREATE TABLE IF NOT EXISTS`, and no data schema bump
 * (data-schema.ts): an older server never reads them and keeps working on a
 * database that has them. Nothing here is a trigger or a column on someone
 * else's table for the same reason — a rollback must find the competitions'
 * tables exactly as that release left them.
 */
import { db } from '../db.js'

db.exec(`
  /*
   * A contest. The stored state moves only by a hand (open, finish, reopen);
   * the phase a page names is worked out from it and the dates
   * (@shared/contests · contestPhase), so a deadline moved later reopens it
   * with no second press.
   */
  CREATE TABLE IF NOT EXISTS contests (
    id                   TEXT PRIMARY KEY,
    slug                 TEXT NOT NULL,
    title                TEXT NOT NULL,
    blurb                TEXT NOT NULL DEFAULT '',
    description          TEXT NOT NULL DEFAULT '',
    state                TEXT NOT NULL DEFAULT 'draft',
    rules                TEXT NOT NULL DEFAULT 'icpc',
    penalty_minutes      INTEGER NOT NULL DEFAULT 20,
    freeze_minutes       INTEGER NOT NULL DEFAULT 0,
    unfrozen_at          INTEGER,
    attempts_per_problem INTEGER NOT NULL DEFAULT 0,
    /* A JSON array of ContestLanguage ids, in the order the editor offers them. */
    languages            TEXT NOT NULL DEFAULT '["python3","cpp20"]',
    environment          TEXT NOT NULL DEFAULT 'base',
    starts_at            INTEGER,
    ends_at              INTEGER,
    upsolving            INTEGER NOT NULL DEFAULT 0,
    board_visibility     TEXT NOT NULL DEFAULT 'public',
    course_id            TEXT,
    created_by           TEXT,
    hidden_at            INTEGER,
    /* Bumps on every change a participant's page can see: the streams compare it. */
    revision             INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  /* The /a/<slug> address: the unique index decides a clash, not a SELECT before the insert. */
  CREATE UNIQUE INDEX IF NOT EXISTS contests_slug ON contests(slug);

  /*
   * A problem. Its letter is not stored: it is the position's
   * (@shared/contests · problemLetter), so a reorder renames nothing.
   *
   * tests_revision names the directory its tests live in on disk
   * (contests/storage.ts · r<rev>): every change of the tests writes a whole
   * new directory and then moves this number, so a run that started on the
   * old one keeps reading the old one to its end.
   */
  CREATE TABLE IF NOT EXISTS contest_problems (
    id                 TEXT PRIMARY KEY,
    contest_id         TEXT NOT NULL,
    position           INTEGER NOT NULL,
    title              TEXT NOT NULL,
    statement          TEXT NOT NULL DEFAULT '',
    time_limit_ms      INTEGER NOT NULL DEFAULT 1000,
    memory_mb          INTEGER NOT NULL DEFAULT 256,
    checker            TEXT NOT NULL DEFAULT 'tokens',
    checker_epsilon    REAL NOT NULL DEFAULT 0.000001,
    checker_code       TEXT NOT NULL DEFAULT '',
    points             TEXT NOT NULL DEFAULT 'tests',
    reference_language TEXT NOT NULL DEFAULT 'python3',
    reference_source   TEXT NOT NULL DEFAULT '',
    tests_revision     INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS contest_problems_of ON contest_problems(contest_id, position);

  /*
   * The tests of a problem's CURRENT revision — sizes and marks only, the
   * bytes are files (contests/storage.ts). Replaced as a whole together with
   * the revision they describe.
   */
  CREATE TABLE IF NOT EXISTS contest_tests (
    problem_id   TEXT NOT NULL,
    ordinal      INTEGER NOT NULL,
    sample       INTEGER NOT NULL DEFAULT 0,
    test_group   INTEGER NOT NULL DEFAULT 0,
    input_bytes  INTEGER NOT NULL,
    /* NULL: no answer yet — the reference solution is to write it. */
    answer_bytes INTEGER,
    answer_from  TEXT NOT NULL DEFAULT 'upload',
    PRIMARY KEY (problem_id, ordinal)
  );

  /* IOI groups: what a group pays when every one of its tests passes. */
  CREATE TABLE IF NOT EXISTS contest_groups (
    problem_id TEXT NOT NULL,
    test_group INTEGER NOT NULL,
    points     INTEGER NOT NULL,
    PRIMARY KEY (problem_id, test_group)
  );

  /*
   * Who is in which contest — the competitions' competition_entrants, for
   * contests: a row of its own rather than "sent a submission" (the board
   * lists a person from the moment they join), and the namesake rule held by
   * a unique index, not by a query two people pressing «Участвовать» in the
   * same second would both pass.
   */
  CREATE TABLE IF NOT EXISTS contest_entrants (
    contest_id TEXT NOT NULL,
    entrant_id TEXT NOT NULL,
    /* The name brought to the form namesakes are compared in (@shared/competitions · entrantNameKey). */
    name_key   TEXT NOT NULL,
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (contest_id, entrant_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS contest_entrants_name ON contest_entrants(contest_id, name_key);
  CREATE INDEX IF NOT EXISTS contest_entrants_person ON contest_entrants(entrant_id);

  /*
   * Submissions — and the judge's queue: a row 'queued' is waiting, 'running'
   * is in a container, and the process life that started it is \`boot\`. In the
   * database, not in memory: a restart in the middle of a class period must
   * not mean thirty submissions judged into the void.
   *
   * \`attempt\` counts every start of the row and never goes back: it names the
   * judge's container and the run's directory, and a name used once is never
   * used again (a directory removed and made again under the same name is the
   * one thing virtiofs serves stale, competitions/storage.ts). \`starts\` counts
   * the starts since the row was last queued by a person: three starts cut
   * short by restarts end it as the judge's failure (SE), and a rejudge is new
   * work that starts the count over.
   *
   * \`report\` is JSON, every test's result with the judge's snippets: stored
   * whole, and filtered on the way out by who reads it.
   */
  CREATE TABLE IF NOT EXISTS contest_submissions (
    id             TEXT PRIMARY KEY,
    contest_id     TEXT NOT NULL,
    problem_id     TEXT NOT NULL,
    entrant_id     TEXT,
    kind           TEXT NOT NULL,
    number         INTEGER NOT NULL DEFAULT 0,
    language       TEXT NOT NULL,
    source         TEXT NOT NULL,
    source_bytes   INTEGER NOT NULL,
    submitted_at   INTEGER NOT NULL,
    late           INTEGER NOT NULL DEFAULT 0,
    state          TEXT NOT NULL DEFAULT 'queued',
    verdict        TEXT,
    failed_test    INTEGER,
    passed         INTEGER,
    total          INTEGER,
    score          INTEGER,
    time_ms        INTEGER,
    memory_kb      INTEGER,
    progress       INTEGER,
    compile_log    TEXT NOT NULL DEFAULT '',
    report         TEXT,
    system_detail  TEXT,
    tests_revision INTEGER,
    judged_at      INTEGER,
    attempt        INTEGER NOT NULL DEFAULT 0,
    starts         INTEGER NOT NULL DEFAULT 0,
    boot           TEXT,
    started_at     INTEGER
  );
  /* «#12» — a number within a contest, entrants only (the teacher's runs are 0). */
  CREATE UNIQUE INDEX IF NOT EXISTS contest_submissions_number
    ON contest_submissions(contest_id, number) WHERE number > 0;
  CREATE INDEX IF NOT EXISTS contest_submissions_mine
    ON contest_submissions(contest_id, entrant_id, submitted_at);
  CREATE INDEX IF NOT EXISTS contest_submissions_problem
    ON contest_submissions(problem_id, kind, submitted_at);
  CREATE INDEX IF NOT EXISTS contest_submissions_queue
    ON contest_submissions(state, submitted_at);
  CREATE INDEX IF NOT EXISTS contest_submissions_person
    ON contest_submissions(entrant_id, state);

  /*
   * Questions and announcements. An announcement is a row with no question
   * and no asker, public from birth; a question answered «всем» becomes one.
   */
  CREATE TABLE IF NOT EXISTS contest_questions (
    id          TEXT PRIMARY KEY,
    contest_id  TEXT NOT NULL,
    problem_id  TEXT,
    entrant_id  TEXT,
    question    TEXT NOT NULL DEFAULT '',
    answer      TEXT,
    answered_by TEXT,
    public      INTEGER NOT NULL DEFAULT 0,
    asked_at    INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS contest_questions_of ON contest_questions(contest_id, asked_at);

  /* When a person last read the questions' page: «2 новых ответа» counts from here. */
  CREATE TABLE IF NOT EXISTS contest_seen (
    contest_id        TEXT NOT NULL,
    entrant_id        TEXT NOT NULL,
    questions_seen_at INTEGER NOT NULL,
    PRIMARY KEY (contest_id, entrant_id)
  );
`)

/*
 * The revision moves by itself on every change a participant's page can see
 * — a trigger, not a line in each write, so no future write can forget it
 * (the competitions' lesson: store.ts · competition_changed). The contest's
 * own row on any update; a problem on what its page shows (not its
 * reference, which no participant reads); the IOI groups, which are the
 * problem's points. The tests change only together with the problem's
 * tests_revision (contests/store.ts · switchTests), so the problem's trigger
 * covers them. Each trigger only touches the revision, so none of them fires
 * the first one again (its WHEN sees the revision moved).
 */
db.exec(`
  CREATE TRIGGER IF NOT EXISTS contest_changed AFTER UPDATE ON contests
  WHEN NEW.revision = OLD.revision
  BEGIN UPDATE contests SET revision = revision + 1 WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS contest_problem_added AFTER INSERT ON contest_problems
  BEGIN UPDATE contests SET revision = revision + 1 WHERE id = NEW.contest_id; END;
  CREATE TRIGGER IF NOT EXISTS contest_problem_removed AFTER DELETE ON contest_problems
  BEGIN UPDATE contests SET revision = revision + 1 WHERE id = OLD.contest_id; END;
  CREATE TRIGGER IF NOT EXISTS contest_problem_changed
  AFTER UPDATE OF position, title, statement, time_limit_ms, memory_mb, checker, checker_epsilon, points, tests_revision
  ON contest_problems
  BEGIN UPDATE contests SET revision = revision + 1 WHERE id = NEW.contest_id; END;

  CREATE TRIGGER IF NOT EXISTS contest_group_added AFTER INSERT ON contest_groups
  BEGIN UPDATE contests SET revision = revision + 1
    WHERE id = (SELECT contest_id FROM contest_problems WHERE id = NEW.problem_id); END;
  CREATE TRIGGER IF NOT EXISTS contest_group_changed AFTER UPDATE ON contest_groups
  BEGIN UPDATE contests SET revision = revision + 1
    WHERE id = (SELECT contest_id FROM contest_problems WHERE id = NEW.problem_id); END;
  CREATE TRIGGER IF NOT EXISTS contest_group_removed AFTER DELETE ON contest_groups
  BEGIN UPDATE contests SET revision = revision + 1
    WHERE id = (SELECT contest_id FROM contest_problems WHERE id = OLD.problem_id); END;
`)

export {}
