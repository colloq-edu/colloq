import { usingRuntimeBroker, runtimeEnvironment, imageRevision } from './kernel/runtime-client.js'
import { RUNTIME_REVISION } from '@shared/runtime'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config, ensureDataDir } from './config.js'
import { colorForId, type Participant, type SessionInfo } from '@shared/protocol'
import { OPEN_ROOM, readRules, rulesAfterClass, type RoomRules } from '@shared/rules'

// 0700 — one rule for everyone, see config.ensureDataDir: mkdirSync with a mode
// does not change the mode of an existing directory, and the promise below did
// not always hold.
ensureDataDir()

const dbPath = path.join(config.dataDir, 'colloq.db')
export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

/*
 * The file holds the sign-in keys of every teacher and the instance's model
 * key, in clear text — which is fine while only this process can read it, and
 * was not: SQLite creates by umask, so on a shared machine it landed 0644 next
 * to the 0600 session secret. WAL and shm are the same data and get the same
 * treatment.
 */
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.chmodSync(`${dbPath}${suffix}`, 0o600)
  } catch {
    // -wal and -shm may not exist yet; the next open makes them under the
    // directory's 0700, which is already closed to everyone else.
  }
}

/*
 * Checkpoint the journal into the database itself — every five minutes and on
 * exit.
 *
 * In WAL mode writes pile up in a separate file and move into the main one
 * when SQLite sees fit. A seminar writes a lot and reads almost nothing, so
 * that moment may not come for hours: `colloq.db` looks like yesterday, while
 * the whole day lies in the `-wal` next to it. Copying "the database" at that
 * moment means copying yesterday, and that is exactly what everyone who
 * copies one file does.
 *
 * On the timer — PASSIVE: it checkpoints everything it can and waits for
 * nobody. TRUNCATE waits for readers through the busy handler, and
 * better-sqlite3 is synchronous: `make backup` (that is `VACUUM INTO` in a
 * neighbouring process, reading the database for seconds) stalled the event
 * loop along with every socket of every room — for up to five seconds in the
 * middle of a class period, while the README promises a live backup. An
 * empty journal is needed exactly once — on exit, where there are no readers
 * any more; that is where TRUNCATE goes.
 */
const CHECKPOINT_EVERY_MS = 5 * 60 * 1000

/**
 * Take a copy of the database without stopping the seminar.
 *
 * `VACUUM INTO` reads a consistent snapshot and writes one finished file —
 * with no `-wal` next to it and no question of "did everything make it".
 * Copying `colloq.db` on the fly does not give that: half the day lies in the
 * journal, and the copy lags by hours.
 *
 * The path must not exist — SQLite refuses to write over it, and that is
 * right: silently overwriting someone else's copy is worse than not making a
 * new one.
 */
export function backupTo(file: string): void {
  db.exec(`VACUUM INTO ${quote(file)}`)
}

/** SQLite does not accept a parameter in VACUUM INTO, so the path is escaped by hand. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function checkpoint(mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): void {
  try {
    db.pragma(`wal_checkpoint(${mode})`)
  } catch (err) {
    // Busy with a reader — no trouble: the next pass is in five minutes.
    console.error('[db] checkpoint failed:', err instanceof Error ? err.message : err)
  }
}

const checkpointTimer = setInterval(checkpoint, CHECKPOINT_EVERY_MS)
// No reason to keep the process alive.
checkpointTimer.unref?.()

/**
 * Checkpoint the journal and close the file — on exit.
 *
 * `process.exit` does not close the database: the WAL journal stays next to
 * it, and the `colloq.db` of a stopped instance is yesterday, while today is
 * in a file nobody copies. better-sqlite3 does a checkpoint by itself on
 * close().
 */
export function closeDatabase(): void {
  clearInterval(checkpointTimer)
  // TRUNCATE here: there are no rooms any more, nobody to wait for, and the
  // journal must leave empty — a stopped instance is copied as one file.
  checkpoint('TRUNCATE')
  db.close()
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    avatar      TEXT,
    color       TEXT NOT NULL,
    role        TEXT NOT NULL,
    last_seen   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS participants_session ON participants(session_id);

  /*
   * Whom the teacher has closed out of the room, and until when.
   *
   * The product has no accounts, so a ban rests on the two marks that exist:
   * the participant id (it is in the browser's localStorage) and the device
   * mark in a cookie. A match on EITHER of them is a ban; this does not give
   * airtightness and does not promise it — incognito gives a clean browser.
   *
   * "ip" NEVER takes part in the check: the whole audience sits behind one
   * NAT, and a ban by address would close the room to the entire cohort. It
   * lies here only as a hint to the teacher: "looks like this one came back".
   *
   * "name" is a copy of its own: a person comes back under another name, and
   * the teacher must recognise the ban row — it names the one they banned.
   *
   * The schema is here, next to the other room tables, which are read together
   * and deleted together. The queries, the cookie and the rule about expired
   * rows are in server/src/bans.ts.
   */
  CREATE TABLE IF NOT EXISTS bans (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    participant_id TEXT,
    device         TEXT,
    ip             TEXT,
    name           TEXT NOT NULL,
    until          INTEGER NOT NULL,
    by_teacher     TEXT,
    created_at     INTEGER NOT NULL
  );
  /* Every read is "this room, in effect now", and that is exactly the index. */
  CREATE INDEX IF NOT EXISTS bans_session ON bans(session_id, until);

  CREATE TABLE IF NOT EXISTS doc_snapshots (
    session_id  TEXT PRIMARY KEY,
    data        BLOB NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  /*
   * Every version of every notebook, as the bytes that produced it.
   *
   * One row is one *edit* — a burst of typing by one person — not one
   * keystroke: the recorder merges a burst in memory and writes it once. A
   * ninety-minute seminar produces a few dozen rows, not a few thousand.
   *
   * update_blob is a Yjs update. For an edit row it carries only that burst;
   * for a keyframe row it carries the whole document, so materialising an
   * old version replays a bounded number of updates onto the nearest keyframe
   * instead of the entire history.
   *
   * Kept separate from doc_snapshots on purpose. That table answers "what is
   * the notebook now" and is overwritten constantly; this one is append-only
   * and answers "what was it then". A single table would have to be both.
   */
  /*
   * A course is a permanent public page that collects a semester of seminars
   * in the order in which they were taught. The only address in Colloq a
   * person would want to bookmark.
   *
   * The SCHEMA of these tables (courses, publications, publication_steps,
   * blobs) is here, together with the migrations below; the QUERIES against
   * them are in publish/store.ts, and that is also where its own
   * publish_addresses is created. The schema has one owner, and that is
   * important to remember both ways: the header of store.ts once promised
   * "its own tables here and nobody else writes to them" — about tables it
   * does not create.
   *
   * Membership and order as one fact, a JSON array: both are only ever read
   * whole, nobody asks "which courses does this seminar belong to", and
   * storing the order as separate numbers means letting them drift apart.
   * This code already stores "shape" exactly the same way in
   * collab/history.ts.
   */
  CREATE TABLE IF NOT EXISTS courses (
    id         TEXT PRIMARY KEY,
    slug       TEXT UNIQUE,
    name       TEXT NOT NULL,
    blurb      TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    items      TEXT NOT NULL DEFAULT '[]',
    rev        INTEGER NOT NULL DEFAULT 0
  );

  /*
   * A publication is the second thing derived from what the room recorded.
   *
   * "session_id" is set to null when the seminar is deleted but the reading is
   * kept: the pages are already assembled and lie here, nothing stands behind
   * them. For the same reason "title" is a copy of its own — the seminar may
   * no longer exist, but the page must have a name.
   */
  CREATE TABLE IF NOT EXISTS publications (
    id           TEXT PRIMARY KEY,
    slug         TEXT UNIQUE,
    session_id   TEXT UNIQUE,
    title        TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'published',
    published_at INTEGER NOT NULL,
    published_by TEXT,
    revision     INTEGER NOT NULL DEFAULT 1,
    orphaned_at  INTEGER
  );

  /*
   * A step is a moment the teacher named, and the notebook at that moment.
   *
   * "page" is an already projected page, not a link to a history row. A link
   * would mean unfolding a multi-megabyte Yjs document on every public request
   * — in the same process that is running the class at that minute, and with
   * no rate limit at all. Plus an assembled page survives the deletion of the
   * seminar, which is what makes "keep the reading" a possible choice.
   */
  CREATE TABLE IF NOT EXISTS publication_steps (
    pub   TEXT NOT NULL,
    seq   INTEGER NOT NULL,
    ord   INTEGER NOT NULL,
    label TEXT NOT NULL,
    at    INTEGER NOT NULL,
    page  TEXT NOT NULL,
    PRIMARY KEY (pub, seq)
  );

  /*
   * Large output content — once per publication.
   *
   * A matplotlib chart weighs hundreds of kilobytes and is the same in every
   * step where its cell did not change. By hash it is stored once and served
   * with an eternal cache — the page is opened from phones.
   */
  CREATE TABLE IF NOT EXISTS publication_blobs (
    pub  TEXT NOT NULL,
    hash TEXT NOT NULL,
    mime TEXT NOT NULL,
    body BLOB NOT NULL,
    PRIMARY KEY (pub, hash)
  );

  CREATE TABLE IF NOT EXISTS doc_history (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    update_blob BLOB NOT NULL,
    kind        TEXT NOT NULL,
    author_id   TEXT,
    created_at  INTEGER NOT NULL,
    label       TEXT,
    summary     TEXT NOT NULL DEFAULT '',
    added       INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    cells       TEXT NOT NULL DEFAULT '[]'
  );
  /* Every read is "this session, in order", which is exactly this index. */
  CREATE INDEX IF NOT EXISTS doc_history_session ON doc_history(session_id, seq);

  -- The oracle thread moved into the session document, where the whole room
  -- can read it; doc_snapshots persists it now. Installs from before that keep
  -- a private per-person transcript on disk until this runs.
  DROP TABLE IF EXISTS ai_messages;
`)

/**
 * The environment a seminar was created with.
 *
 * Chosen once, at creation, and then it is that room's Python for good: a
 * seminar whose packages changed under it mid-class is worse than one that
 * never had the newest ones. Null means "whatever the instance runs", which is
 * what every seminar made before environments existed has.
 *
 * Guarded by table_info rather than a migration framework — one ALTER, and
 * SQLite has no ADD COLUMN IF NOT EXISTS.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}
ensureColumn('sessions', 'environment', 'environment TEXT')
ensureColumn('sessions', 'kernel_revision', 'kernel_revision TEXT')
/*
 * How much memory to give the kernel of THIS room, in megabytes.
 *
 * NULL means "as the environment has it", that is `KERNEL_MEM` and the pool
 * defaults (kernel/pool.ts · memoryLimit), and so are all seminars created
 * before this field appeared. The number is here for the sake of one day: on
 * 13 Sep 2026 the seminar kernel was killed for memory sixteen times in a row,
 * and the only knob was an environment variable for the whole machine —
 * raising it for one room was impossible, and raising it for everyone meant
 * handing memory to ten rooms that did not need it.
 *
 * In megabytes, not as a docker string: the number is compared with what the
 * machine has and summed across rooms. The string "4g" would have to be
 * parsed for that in every place that reads it.
 */
ensureColumn('sessions', 'memory_mb', 'memory_mb INTEGER')
/*
 * How many cores to give this room.
 *
 * NULL means "as set for the instance" (`KERNEL_CPUS`, two by default), and
 * so are all seminars before the field appeared. A separate column next to
 * memory and for the same reason: a vision class and a statistics seminar
 * live on the same image, and the whole difference between them is how much
 * machine they need. The number here decides not only `--cpus` but also the
 * number of numpy and torch threads inside the container (kernel/pool.ts ·
 * threadLimit).
 */
ensureColumn('sessions', 'cpus', 'cpus INTEGER')
/*
 * Which version a rollback brought back.
 *
 * `summary` used to hold "restored the version from 15:04", and the server
 * formatted that time in its own time zone: in the container that is UTC,
 * while the browser draws the feed rows in its own — in a UTC+3 classroom the
 * caption pointed at a row that is not in the list. Time is no longer
 * assembled on the server; the version's address lies here, and the clock is
 * drawn by whoever looks.
 */
ensureColumn('doc_history', 'target_seq', 'target_seq INTEGER')

/**
 * Whether this participant became a host through the host token.
 *
 * The role in the row next to it does not answer this question: "host by
 * cookie" is written there too, and the whole point of a cookie is that it
 * can be taken away. A teacher removed from the list must lose Restart in
 * every room they have ever opened; a row with role='host' would bring them
 * back forever.
 *
 * A token is another matter: it is the only key to a seminar created by a
 * script bypassing the panel, it cannot be taken away, and it must survive a
 * restart. This set used to live in process memory — and after `make stop`
 * the room's author came into it as a guest, with no explanation.
 */
ensureColumn('participants', 'token_host', 'token_host INTEGER NOT NULL DEFAULT 0')

/**
 * Which browser this person came in from last time.
 *
 * The mark from the `colloq_device` cookie (server/src/bans.ts). It lies in
 * the participant row because a ban is created by a single identifier — but
 * what has to be closed is also the browser that a minute later will come
 * back as "a new person" with a clean localStorage. There is nowhere to take
 * the mark from at that moment: the request is sent by the teacher, and the
 * cookie in it is the teacher's own.
 *
 * NULL is normal: in development Vite serves the page, there is nobody to set
 * the cookie, and such a person is banned by the identifier alone. This field
 * does not get into Participant: that goes to the whole room, and a browser
 * mark is not something members of the room should know about each other.
 */
ensureColumn('participants', 'device', 'device TEXT')

/**
 * The room's rules, as JSON.
 *
 * One column rather than eight, because these are read as a unit — a room opens
 * and needs all of them — and never queried across seminars: nobody asks "which
 * seminars let students run cells". A blob also lets a rule be added without an
 * ALTER, which matters while the set is still settling.
 *
 * NULL means the room has never been configured, and readRules turns that into
 * the permissive default. Every seminar that existed before this column reads as
 * exactly what it has always been.
 */
ensureColumn('sessions', 'rules', 'rules TEXT')

/**
 * When the teacher ended the class.
 *
 * NULL means the class is in progress, and that is how every seminar created
 * before this column reads. A time, not a flag: the room and the panel show
 * "ended at 15:40", and the same time answers "when did the class period
 * end", which would otherwise have to be dug out of the history.
 *
 * A column, not a field in `rules`: the rules are a setting the teacher
 * chose, while the end of class is a state that must pass over any setting
 * and step back without rewriting it (shared/rules.ts · rulesAfterClass).
 */
ensureColumn('sessions', 'finished_at', 'finished_at INTEGER')

/*
 * A name in the address, chosen by a person.
 *
 * An eight-character identifier is fine for a room opened once from a link
 * in a chat. A course is given to a class for a year, and
 * `colloq.ru/c/ml-strong` is remembered, dictated aloud and survives a lost
 * message, while `/c/vspnrgt5` does none of that.
 *
 * Columns, not JSON: the database must hold the address's uniqueness,
 * otherwise two courses will one day end up at the same path. Both are added
 * by migration, because the tables may already have been created by someone
 * who updated a day earlier.
 */
ensureColumn('courses', 'slug', 'slug TEXT')
ensureColumn('publications', 'slug', 'slug TEXT')
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS courses_slug ON courses(slug) WHERE slug IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS publications_slug ON publications(slug) WHERE slug IS NOT NULL;
`)

/* ------------------------------------------------------------- sessions */

const insertSession = db.prepare(
  'INSERT INTO sessions (id, name, created_at, environment, kernel_revision) VALUES (?, ?, ?, ?, ?)',
)
const selectEnvironment = db.prepare('SELECT environment FROM sessions WHERE id = ?')
const selectSession = db.prepare(
  'SELECT id, name, created_at, rules, finished_at FROM sessions WHERE id = ?',
)
/** Bypassing the cache, on purpose — see `sessionRowExists`. */
const selectSessionRow = db.prepare('SELECT 1 FROM sessions WHERE id = ?')

interface SessionRow {
  id: string
  name: string
  created_at: number
  /** JSON, or NULL for a room nobody has configured. */
  rules: string | null
  /** When the class ended, or NULL while it is in progress. */
  finished_at: number | null
}

export function createSession(id: string, name: string, environment?: string | null): SessionInfo {
  const createdAt = Date.now()
  const pinned = usingRuntimeBroker() ? runtimeEnvironment(environment) : null
  insertSession.run(id, name, createdAt, pinned?.name ?? environment ?? null, pinned ? imageRevision(pinned.image) : null)
  // Someone may have asked about this id before it existed: "no such room"
  // lies in the cache next to the found ones and would outlive its birth.
  forgetRoom(id)
  // A brand-new room is the open room: nothing has been decided about it yet,
  // and the default is what Colloq has always been.
  return {
    id,
    name,
    createdAt,
    rules: { ...OPEN_ROOM },
    finishedAt: null,
    published: null,
    course: null,
    // A property of the instance, read from config every time the card is
    // assembled rather than written into the seminar row: by changing
    // INSTITUTION the operator changes the caption in all rooms at once,
    // including last year's.
    institution: config.institution,
  }
}

/**
 * Which environment this room asked for, or null for "whatever the instance
 * runs". Read on every kernel start rather than cached: an operator can change
 * the row, and the answer decides which container the room talks to.
 */
/** Immutable image choice. Legacy rooms resolve once on their first broker launch. */
export function sessionKernelRevision(id: string): string | null {
  const row = db.prepare('SELECT kernel_revision FROM sessions WHERE id = ?').get(id) as {kernel_revision:string|null}|undefined
  return row?.kernel_revision ?? null
}
export function pinSessionKernelRevision(id: string, environment: string, revision: string): string {
  if (!RUNTIME_REVISION.test(revision)) throw new Error('Invalid kernel image revision')
  db.prepare('UPDATE sessions SET environment = ?, kernel_revision = ? WHERE id = ? AND kernel_revision IS NULL').run(environment,revision,id)
  const pinned = sessionKernelRevision(id)
  if (!pinned) throw new Error('Cannot pin kernel image: seminar does not exist')
  return pinned
}

export function sessionEnvironment(id: string): string | null {
  const row = selectEnvironment.get(id) as { environment: string | null } | undefined
  return row?.environment ?? null
}

const selectMemoryMb = db.prepare('SELECT memory_mb FROM sessions WHERE id = ?')
const updateMemoryMb = db.prepare('UPDATE sessions SET memory_mb = ? WHERE id = ?')

/**
 * The room's memory limit, or null — "as the environment has it".
 *
 * Read on every container start, like the environment next to it: the
 * teacher changes the number between class periods, and the answer decides
 * which `--memory` the kernel comes up with. No cache on purpose — it is
 * asked once in the life of a container.
 */
export function sessionMemoryMb(id: string): number | null {
  const row = selectMemoryMb.get(id) as { memory_mb: number | null } | undefined
  const mb = row?.memory_mb ?? null
  return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? Math.floor(mb) : null
}

/** Set the room's limit; null returns it to the environment's default. */
export function setSessionMemoryMb(id: string, mb: number | null): void {
  updateMemoryMb.run(mb === null ? null : Math.floor(mb), id)
}

const selectCpus = db.prepare('SELECT cpus FROM sessions WHERE id = ?')
const updateCpus = db.prepare('UPDATE sessions SET cpus = ? WHERE id = ?')

/**
 * How many cores the room has, or null — "as set for the instance".
 *
 * Read on every container start, next to memory and the environment: the
 * answer decides both `--cpus` and the number of threads numpy and torch will
 * see inside.
 */
export function sessionCpus(id: string): number | null {
  const row = selectCpus.get(id) as { cpus: number | null } | undefined
  const cpus = row?.cpus ?? null
  return typeof cpus === 'number' && Number.isFinite(cpus) && cpus > 0 ? Math.floor(cpus) : null
}

/** Set the room's core count; null returns it to the instance default. */
export function setSessionCpus(id: string, cpus: number | null): void {
  updateCpus.run(cpus === null ? null : Math.floor(cpus), id)
}

const selectByEnvironment = db.prepare(
  'SELECT id, name FROM sessions WHERE environment = ? ORDER BY created_at DESC',
)

/**
 * Seminars bound to an environment.
 *
 * Deleting an environment only checked "is this not the one the instance is
 * running on right now". A seminar whose environment was chosen at creation
 * keeps its name in its row — and after the deletion it woke up in a room
 * where the kernel does not come up at all: the name is there, the image is
 * not. This was discovered on the first Run in the middle of a class period.
 */
export function sessionsOnEnvironment(name: string): { id: string; name: string }[] {
  return selectByEnvironment.all(name) as { id: string; name: string }[]
}

const renameSessionStmt = db.prepare('UPDATE sessions SET name = ? WHERE id = ?')

/**
 * Keeps the row in step with the room's own title.
 *
 * The seminar's name lives in two places — this row, which the admin list reads,
 * and `meta.title` in the shared document, which the header shows and the host
 * can edit in place. They used to drift in both directions: renaming in the
 * panel never reached the room, and renaming in the room never reached the
 * panel, so one seminar quietly had two names.
 *
 * The document is the source of truth and this mirrors it. One writer, one
 * direction.
 */
export function renameSession(id: string, name: string): void {
  renameSessionStmt.run(name, id)
  // The room's name lies in the row cache — the only field of it that changes
  // at all. Forget it here, otherwise the panel would rename the seminar while
  // the room kept answering with the old name until a restart.
  forgetRoom(id)
}

/**
 * The room's row in memory: whether it exists at all, and the parts of it
 * that do not change on every frame.
 *
 * A per-room cache, like `rulesCache` below and `liveBans` in bans.ts, and it
 * exists for the same storm: "is the seminar the token named still alive" is
 * the only thing the socket handshake asks (index.ts), a tab has two sockets,
 * and after a server restart or a relay blink five hundred tabs come back
 * within a second or two. A thousand primary-key SELECTs cost microseconds
 * each and are paid exactly where the event loop is fully busy and everyone
 * is waiting for the room to come back.
 *
 * `null` is cached on a par with a found row: a browser left behind on a
 * deleted seminar knocks on this door until its token expires, and "no such
 * room" is an answer like any other.
 *
 * The rules and the end of class are not here on purpose: they live in
 * `rulesCache`, and there must not be a second copy of them in the same
 * process — the two would diverge. The first read of the row puts them there
 * too, so that the same row is not fetched twice.
 *
 * The cache is forgotten where the room changes: `createSession`,
 * `renameSession`, `forgetRoom` (called by seminar deletion). There is no
 * lifetime — it would hide a forgotten invalidation until a restart. A row
 * written bypassing this module (by hand in sqlite3, by someone else's
 * prepare) the cache will not see: the product has one door for writes, and
 * it is here.
 */
interface RoomIdentity {
  name: string
  createdAt: number
}

const roomCache = new Map<string, RoomIdentity | null>()

function identityOf(id: string): RoomIdentity | null {
  const known = roomCache.get(id)
  if (known !== undefined) return known
  const row = selectSession.get(id) as SessionRow | undefined
  const identity = row ? { name: row.name, createdAt: row.created_at } : null
  roomCache.set(id, identity)
  // The same row carries the rules and the end of class — putting them into
  // their own cache here is cheaper than reading the row a second time on the
  // very first rights question.
  if (row) rememberRoom(id, row.rules ?? null, row.finished_at ?? null)
  return identity
}

export function getSession(id: string): SessionInfo | null {
  const identity = identityOf(id)
  if (!identity) return null
  const room = roomOf(id)
  /*
   * `published` and `course` are always empty here, and that is not
   * forgetfulness: they live in the publication tables, and those import this
   * module. The `/api/sessions/:id` route fills them in — the only place they
   * are needed.
   */
  return {
    id,
    name: identity.name,
    createdAt: identity.createdAt,
    // A copy of its own: the rules go outside, while the cache holds one for
    // the whole room, and an edit in someone else's hands would become an
    // edit for everyone at once.
    rules: { ...room.rules },
    /*
     * The stored rules and the end of class travel separately, and the client
     * reads them separately too: it lays one over the other itself
     * (shared/rules.ts · rulesAfterClass), so that in the room settings the
     * teacher sees what they chose, not what the end of the class period
     * turned it into.
     */
    finishedAt: room.finishedAt,
    published: null,
    course: null,
    // From config, not from the table row — see createSession().
    institution: config.institution,
  }
}

/**
 * Forget everything this module remembers about a room: the row, the rules
 * and the token rights of its people.
 *
 * Called by seminar deletion (through `forgetRules`) and by room creation:
 * the id may have been asked about before the room appeared, and "no such
 * room" would outlive its birth.
 */
export function forgetRoom(sessionId: string): void {
  roomCache.delete(sessionId)
  hostCache.delete(sessionId)
  rulesCache.delete(sessionId)
}

/**
 * Whether the room's row is alive — a question to the database, bypassing the
 * cache.
 *
 * Exactly for the places where a mistake costs more than a trip to the
 * database: the last line of defence against a resurrected seminar is the
 * document snapshot flush (`collab/persistence.ts`), which does not write the
 * room's notebook if the room's row is already gone. `getSession` would
 * answer there from memory, and the protection would rest not on the
 * database but on EVERY deletion path remembering `forgetRoom`; the price of
 * one forgotten invalidation is the class's notebook coming back to disk a
 * few seconds after the seminar was deleted, and a snapshot without a seminar
 * row that can no longer be reached.
 *
 * A cache saves nothing here: this is asked once every few seconds per room,
 * on a snapshot flush, not on every handshake — which is where the cache
 * exists.
 */
export function sessionRowExists(id: string): boolean {
  return selectSessionRow.get(id) !== undefined
}

/* --------------------------------------------------------- participants */

const upsertParticipantStmt = db.prepare(`
  INSERT INTO participants (id, session_id, name, avatar, color, role, token_host, device, last_seen)
  VALUES (@id, @session_id, @name, @avatar, @color, @role, @token_host, @device, @last_seen)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    avatar = excluded.avatar,
    role = excluded.role,
    token_host = excluded.token_host,
    -- A sign-in that did not bring the mark does not erase it: from the tablet
    -- console a person signs in with an exchange key, and there may be no
    -- cookie there at all. The browser the person sits at during class must
    -- not be forgotten because of that.
    device = COALESCE(excluded.device, participants.device),
    last_seen = excluded.last_seen
`)
const selectParticipant = db.prepare('SELECT * FROM participants WHERE id = ? AND session_id = ?')
const selectParticipants = db.prepare(
  'SELECT * FROM participants WHERE session_id = ? ORDER BY last_seen DESC',
)
const touchParticipant = db.prepare('UPDATE participants SET last_seen = ? WHERE id = ?')

interface ParticipantRow {
  id: string
  session_id: string
  name: string
  avatar: string | null
  color: string
  role: string
  token_host?: number
  /** The browser mark — see the device column. Not handed outside. */
  device?: string | null
  last_seen: number
}

function toParticipant(row: ParticipantRow): Participant {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    color: row.color,
    role: row.role === 'host' ? 'host' : 'participant',
  }
}

export function upsertParticipant(p: {
  id: string
  sessionId: string
  name: string
  avatar: string | null
  role: Participant['role']
  /** Host by token — see the token_host column. A cookie must not be passed here. */
  tokenHost?: boolean
  /** The browser mark from the cookie, if there is one — see the device column. */
  device?: string | null
}): Participant {
  const existing = selectParticipant.get(p.id, p.sessionId) as ParticipantRow | undefined
  const color = existing?.color ?? colorForId(p.id)
  // What a token once granted is not taken away later by a sign-in without
  // the token: the key to the room stays a key, even if the owner opened it
  // from a second tab.
  const tokenHost = p.tokenHost || existing?.token_host === 1
  upsertParticipantStmt.run({
    id: p.id,
    session_id: p.sessionId,
    name: p.name,
    avatar: p.avatar,
    color,
    role: p.role,
    token_host: tokenHost ? 1 : 0,
    device: p.device ?? null,
    last_seen: Date.now(),
  })
  // Not forget but record: the token right has just been decided here, and
  // the very first handshake will ask exactly that.
  rememberTokenHost(p.sessionId, p.id, tokenHost)
  return { id: p.id, name: p.name, avatar: p.avatar, color, role: p.role }
}

/**
 * The mark of the browser this person last came in from — or null.
 *
 * The ban asks for it: what has to be closed is not only the identifier but
 * also the browser it came from. A separate function, not a Participant
 * field: that one goes to the whole room.
 */
export function deviceOfParticipant(sessionId: string, participantId: string): string | null {
  const row = selectParticipant.get(participantId, sessionId) as ParticipantRow | undefined
  return row?.device ?? null
}

/**
 * Token rights in memory: room → participant → whether they had the host
 * token.
 *
 * `roleFor` (routes/sessions.ts) asks this on EVERY handshake — two sockets
 * per tab — while exactly one writer changes it, `upsertParticipant`, and it
 * puts the new value here too. An entry leaves together with the room
 * (`forgetRoom`); nobody else touches the `participants` row, except seminar
 * deletion, which removes it entirely.
 *
 * A map per room rather than a shared "room:participant" key: that way
 * deleting a seminar is one `delete`, not a pass over everyone who ever came
 * in.
 */
const hostCache = new Map<string, Map<string, boolean>>()

/**
 * How many people a room remembers. The cache is an accelerator, not a
 * registry: a room that thousands of identifiers passed through over a
 * semester starts counting anew rather than growing until a restart. A
 * lecture hall (500) does not come close to this limit.
 */
const HOST_CACHE_MAX = 2048

function rememberTokenHost(sessionId: string, participantId: string, host: boolean): void {
  let room = hostCache.get(sessionId)
  if (!room) {
    room = new Map()
    hostCache.set(sessionId, room)
  }
  if (room.size >= HOST_CACHE_MAX && !room.has(participantId)) room.clear()
  room.set(participantId, host)
}

/**
 * Whether this participant presented the host token — the only thing that
 * survives a restart and is not taken away by a cookie. See the token_host
 * column.
 */
export function isTokenHost(sessionId: string, participantId: string): boolean {
  const known = hostCache.get(sessionId)?.get(participantId)
  if (known !== undefined) return known
  const row = selectParticipant.get(participantId, sessionId) as ParticipantRow | undefined
  const host = row?.token_host === 1
  rememberTokenHost(sessionId, participantId, host)
  return host
}

export function getParticipant(sessionId: string, participantId: string): Participant | null {
  const row = selectParticipant.get(participantId, sessionId) as ParticipantRow | undefined
  return row ? toParticipant(row) : null
}

export function listParticipants(sessionId: string): Participant[] {
  return (selectParticipants.all(sessionId) as ParticipantRow[]).map(toParticipant)
}

export function touchLastSeen(participantId: string): void {
  touchParticipant.run(Date.now(), participantId)
}

/**
 * "Was here" as a batch — in one transaction for everyone.
 *
 * The mark is set on every socket handshake, a tab has two sockets, and after
 * a server restart or a relay blink five hundred tabs come back within one
 * second: a thousand separate UPDATEs, each with its own transaction and its
 * own fsync of the journal. Nobody needs the mark to be more precise than a
 * few seconds — it is read by the people list, not by access rights.
 *
 * The time is one for the whole batch and comes from outside: it is the
 * moment the people came, not the moment the write reached them.
 */
const touchAll = db.transaction((ids: readonly string[], at: number) => {
  for (const id of ids) touchParticipant.run(at, id)
})

export function touchLastSeenAll(participantIds: readonly string[], at = Date.now()): void {
  if (participantIds.length === 0) return
  touchAll(participantIds, at)
}

/* ------------------------------------------------------- doc snapshots */

const upsertSnapshot = db.prepare(`
  INSERT INTO doc_snapshots (session_id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`)
const selectSnapshot = db.prepare('SELECT data FROM doc_snapshots WHERE session_id = ?')

export function saveDocSnapshot(sessionId: string, update: Uint8Array): void {
  upsertSnapshot.run(sessionId, Buffer.from(update), Date.now())
}

export function loadDocSnapshot(sessionId: string): Uint8Array | null {
  const row = selectSnapshot.get(sessionId) as { data: Buffer } | undefined
  return row ? new Uint8Array(row.data) : null
}

/* ------------------------------------------------------------------ rules */

const selectRules = db.prepare(`SELECT rules, finished_at FROM sessions WHERE id = ?`)
const updateRules = db.prepare(`UPDATE sessions SET rules = ? WHERE id = ?`)
const updateFinished = db.prepare(`UPDATE sessions SET finished_at = ? WHERE id = ?`)

/** The rules of one room, with everything unset filled in from the open default. */
/**
 * The room's rules in memory.
 *
 * The cache appeared when the rules got onto the keystroke path: the
 * classifier asks for them on every sync frame, and that is a SQLite read and
 * a `JSON.parse` — twenty typists give a hundred and fifty of those a second
 * for nothing. Invalidated in `setRules` and on seminar deletion; nobody else
 * changes the rules.
 */
const rulesCache = new Map<string, { rules: RoomRules; finishedAt: number | null }>()

function roomOf(sessionId: string): { rules: RoomRules; finishedAt: number | null } {
  const cached = rulesCache.get(sessionId)
  if (cached) return cached
  const row = selectRules.get(sessionId) as
    | { rules: string | null; finished_at: number | null }
    | undefined
  const room = { rules: readRules(row?.rules ?? null), finishedAt: row?.finished_at ?? null }
  rulesCache.set(sessionId, room)
  return room
}

/**
 * Remember the room's rules from an already read row.
 *
 * `identityOf` calls this: the `sessions` row carries both the rules and the
 * end of class, so reading it a second time for `roomOf` would mean paying
 * twice for the same thing. The parsing here is the same, `readRules`, so the
 * two paths have nowhere to diverge.
 */
function rememberRoom(sessionId: string, rules: string | null, finishedAt: number | null): void {
  rulesCache.set(sessionId, { rules: readRules(rules), finishedAt })
}

/**
 * The rules the room lives by RIGHT NOW.
 *
 * Every rights check takes them from here, and so the end of class is laid
 * over them here, in one place: a rule someone starts asking about tomorrow
 * will arrive tightened by itself, without the line "and also check whether
 * the class has ended" — the very line that gets forgotten.
 */
export function getRules(sessionId: string): RoomRules {
  const room = roomOf(sessionId)
  return room.finishedAt === null ? room.rules : rulesAfterClass(room.rules)
}

/**
 * The rules the teacher CHOSE.
 *
 * They are shown in the settings, and the patch is applied to them. Asking
 * for the effective ones here would mean losing the setting: PATCH applies a
 * change on top of the current value, so one click in the middle of a
 * finished class would write the tightening into the database for good, and
 * there would be nothing left to reopen the class into.
 */
export function storedRules(sessionId: string): RoomRules {
  return roomOf(sessionId).rules
}

/** When the class was ended, or null while it is in progress. */
export function finishedAt(sessionId: string): number | null {
  return roomOf(sessionId).finishedAt
}

/** Whether the class in this room has ended. */
export function isFinished(sessionId: string): boolean {
  return roomOf(sessionId).finishedAt !== null
}

/**
 * End the class or open it again.
 *
 * Writes both the time and the cache: the rules are asked for on every sync
 * frame, and a forgotten cache reset would mean the end of class takes effect
 * only after a server restart.
 */
export function setFinished(sessionId: string, at: number | null): void {
  updateFinished.run(at, sessionId)
  rulesCache.set(sessionId, { rules: roomOf(sessionId).rules, finishedAt: at })
}

/**
 * Forget the room's rules: they have changed, or the room is gone.
 *
 * It is called from one place — seminar deletion — and there more than the
 * rules has to be forgotten: the row cache would outlive the room, and an old
 * token would keep opening a socket for another day into a door that no
 * longer exists. Hence the whole `forgetRoom` here; new places had better
 * call that directly.
 */
export function forgetRules(sessionId: string): void {
  forgetRoom(sessionId)
}

/** Rule changes invalidate accepted work synchronously after durable storage. */
const rulesChangedListeners = new Set<(sessionId: string, rules: RoomRules) => void>()
export function onRulesChanged(listener: (sessionId: string, rules: RoomRules) => void): () => void {
  rulesChangedListeners.add(listener)
  return () => { rulesChangedListeners.delete(listener) }
}

/**
 * Write a room's rules.
 *
 * Stored through readRules rather than as handed in: whatever reaches the
 * database is then a complete, valid set, and a later read cannot be surprised
 * by a field that a caller forgot or a value nobody recognises.
 */
export function setRules(sessionId: string, rules: RoomRules): RoomRules {
  const clean = readRules(rules)
  updateRules.run(JSON.stringify(clean), sessionId)
  rulesCache.set(sessionId, { rules: clean, finishedAt: roomOf(sessionId).finishedAt })
  for (const listener of rulesChangedListeners) listener(sessionId, clean)
  return clean
}

/* ---------------------------------------------------------------- history */

const insertVersion = db.prepare(`
  INSERT INTO doc_history
    (session_id, update_blob, kind, author_id, created_at, label, summary, added, removed, cells,
     target_seq)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export interface VersionRow {
  seq: number
  kind: string
  author_id: string | null
  created_at: number
  label: string | null
  summary: string
  added: number
  removed: number
  cells: string
  /** Only for a rollback: the version it brought back. */
  target_seq: number | null
}

export function appendVersion(input: {
  sessionId: string
  update: Uint8Array
  kind: string
  authorId: string | null
  createdAt: number
  label: string | null
  summary: string
  added: number
  removed: number
  cells: string[]
  targetSeq?: number | null
}): number {
  const result = insertVersion.run(
    input.sessionId,
    Buffer.from(input.update),
    input.kind,
    input.authorId,
    input.createdAt,
    input.label,
    input.summary,
    input.added,
    input.removed,
    JSON.stringify(input.cells),
    input.targetSeq ?? null,
  )
  return Number(result.lastInsertRowid)
}

const COLUMNS = `seq, kind, author_id, created_at, label, summary, added, removed, cells, target_seq`

const selectVersions = db.prepare(`
  SELECT ${COLUMNS}
  FROM doc_history WHERE session_id = ? ORDER BY seq DESC LIMIT ?
`)

export function listVersions(sessionId: string, limit: number): VersionRow[] {
  return selectVersions.all(sessionId, limit) as VersionRow[]
}

/*
 * The feed is what someone did, and it has to be selected here, not after the
 * LIMIT.
 *
 * `keyframe` and `quiet` are replay bookkeeping, and in a seminar with
 * running cells there are more of them than edits: every four kilobytes of
 * output or ninety seconds give a quiet row. When the four-hundred-row window
 * was cut before the filter, they ate it up — the panel showed a handful of
 * edits or "Nothing has been written in this room yet" with a hundred edits
 * and a "before the exercise" checkpoint in the database.
 */
const selectStory = db.prepare(`
  SELECT ${COLUMNS}
  FROM doc_history WHERE session_id = ? AND kind NOT IN ('keyframe', 'quiet')
  ORDER BY seq DESC LIMIT ?
`)

/*
 * Named moments get a window of their own, not a place in the common queue
 * with edits.
 *
 * Filtering out the service rows is not enough. An edit burst is closed every
 * four kilobytes of updates, on any change of the notebook's structure and
 * after twelve seconds of silence — a room of thirty people produces hundreds
 * of them per class period, and a "before the exercise" checkpoint set at the
 * fifteenth minute fell out of the four-hundred-row window along with them.
 * The row was still alive in the database: what was lost was exactly the
 * function the checkpoint was set for. The same trick is used for publication
 * steps (publish/candidates.ts).
 */
const selectNamed = db.prepare(`
  SELECT ${COLUMNS}
  FROM doc_history WHERE session_id = ? AND kind IN ('opened', 'checkpoint', 'restore')
  ORDER BY seq DESC LIMIT ?
`)

/** The latest feed rows plus all named moments, newest on top. */
export function listStoryVersions(sessionId: string, limit: number): VersionRow[] {
  const rows = new Map<number, VersionRow>()
  for (const row of selectStory.all(sessionId, limit) as VersionRow[]) rows.set(row.seq, row)
  for (const row of selectNamed.all(sessionId, limit) as VersionRow[]) rows.set(row.seq, row)
  return [...rows.values()].sort((a, b) => b.seq - a.seq)
}

const selectOneVersion = db.prepare(`
  SELECT ${COLUMNS}
  FROM doc_history WHERE session_id = ? AND seq = ?
`)

export function getVersion(sessionId: string, seq: number): VersionRow | null {
  return (selectOneVersion.get(sessionId, seq) as VersionRow | undefined) ?? null
}

/*
 * The bytes needed to rebuild the state as of `seq`: the newest keyframe at or
 * below it, then every update after that keyframe up to and including it. The
 * keyframe row's own blob is a whole document, so the replay starts there
 * rather than at the beginning of the seminar.
 */
const selectKeyframeAt = db.prepare(`
  SELECT seq FROM doc_history
  WHERE session_id = ? AND seq <= ? AND kind = 'keyframe'
  ORDER BY seq DESC LIMIT 1
`)

const selectRange = db.prepare(`
  SELECT update_blob FROM doc_history
  WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC
`)

export function updatesUpTo(sessionId: string, seq: number): Uint8Array[] {
  const keyframe = selectKeyframeAt.get(sessionId, seq) as { seq: number } | undefined
  const from = keyframe ? keyframe.seq : 0
  const rows = selectRange.all(sessionId, from, seq) as { update_blob: Buffer }[]
  return rows.map((row) => new Uint8Array(row.update_blob))
}

/* -------------------------------------------------------- lecture notes */

/*
 * Speaker notes: what to say on this page.
 *
 * In the database, not in the room document, and this is not about
 * convenience. The room document is synced WHOLE to everyone who enters — the
 * notebook, the chat, everything — and the note "ask here who remembers
 * Bayes' formula; if they are silent, derive it on the board" would reach the
 * whole class along with the first page. The teacher's words to themselves
 * are the only thing in this product the room is not supposed to see.
 *
 * And not in process memory, unlike ink: ink lives for an hour, while notes
 * are written the evening before. They must survive a server restart.
 *
 * The key is seminar, file and page: notes are bound to a page of the
 * document, not to the lecture, so they survive both its end and a second
 * lecture on the same file a week later.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS lecture_notes (
    session_id  TEXT NOT NULL,
    file        TEXT NOT NULL,
    page        INTEGER NOT NULL,
    text        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, file, page)
  );
`)

const selectNotes = db.prepare(
  'SELECT page, text FROM lecture_notes WHERE session_id = ? AND file = ? ORDER BY page',
)
const upsertNote = db.prepare(
  `INSERT INTO lecture_notes (session_id, file, page, text, updated_at)
   VALUES (@session_id, @file, @page, @text, @updated_at)
   ON CONFLICT(session_id, file, page) DO UPDATE SET text = @text, updated_at = @updated_at`,
)
const dropNote = db.prepare(
  'DELETE FROM lecture_notes WHERE session_id = ? AND file = ? AND page = ?',
)
const dropNotesOf = db.prepare('DELETE FROM lecture_notes WHERE session_id = ?')
const dropNotesFile = db.prepare('DELETE FROM lecture_notes WHERE session_id = ? AND file = ?')
/*
 * `OR REPLACE`, not a bare UPDATE, and that is the difference between "moved"
 * and "lost".
 *
 * The key here is (room, file, page), and notes are not deleted when the file
 * is deleted — on purpose: re-uploading a corrected PDF under the same name
 * the day before class is more common than starting the talk from scratch.
 * So a path easily keeps a tail from a previous document, and a move onto
 * such a path runs into a taken key. In SQLite that rolls back the WHOLE
 * statement: not a single page moves, and the caller catches the exception
 * and keeps quiet — an evening spent on the talk for twenty-four pages stays
 * under a path that is no longer on disk.
 *
 * REPLACE settles the dispute in favour of what is moving: notes to a live
 * file outrank notes to a path the file was removed from long ago. The
 * opposite choice means quietly losing a fresh talk for the sake of someone
 * else's from last year.
 */
const moveNotes = db.prepare(
  'UPDATE OR REPLACE lecture_notes SET file = ? WHERE session_id = ? AND file = ?',
)

/** All notes for one document: page → text. */
export function notesOf(sessionId: string, file: string): Record<number, string> {
  const rows = selectNotes.all(sessionId, file) as { page: number; text: string }[]
  const out: Record<number, string> = {}
  for (const row of rows) out[row.page] = row.text
  return out
}

/** An empty note is its absence, not a string of spaces. */
export function setNote(sessionId: string, file: string, page: number, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) {
    dropNote.run(sessionId, file, page)
    return
  }
  upsertNote.run({
    session_id: sessionId,
    file,
    page,
    text: trimmed,
    updated_at: Date.now(),
  })
}

/**
 * A file was renamed — the notes move after it, pushing out the tail at the
 * new path.
 *
 * Moving "onto itself" is a separate case: `WHERE file = to` and
 * `SET file = to` is a row conflicting with itself, and REPLACE does not
 * count it as a conflict, but relying on such a subtlety in a statement that
 * can delete is not worth it.
 */
export function moveNotesTo(sessionId: string, from: string, to: string): void {
  if (from === to) return
  moveNotes.run(to, sessionId, from)
}

/** The talk for one document is scrapped (the file was replaced whole, not renamed). */
export function discardNotesOf(sessionId: string, file: string): void {
  dropNotesFile.run(sessionId, file)
}

/** The seminar was deleted — the notes go with it. */
export function discardNotes(sessionId: string): void {
  dropNotesOf.run(sessionId)
}

const countVersions = db.prepare(`SELECT COUNT(*) AS n FROM doc_history WHERE session_id = ?`)

export function versionCount(sessionId: string): number {
  return (countVersions.get(sessionId) as { n: number }).n
}

const countBases = db.prepare(
  `SELECT COUNT(*) AS n FROM doc_history
   WHERE session_id = ? AND kind IN ('opened', 'keyframe')`,
)

/**
 * Does this room's history have anything to replay *from*?
 *
 * Every other row is a delta. Without at least one row carrying a whole
 * document, rebuilding any version applies changes to an empty notebook and
 * returns an empty notebook — quietly, with no error anywhere.
 */
export function hasHistoryBase(sessionId: string): boolean {
  return (countBases.get(sessionId) as { n: number }).n > 0
}

const dropHistory = db.prepare(`DELETE FROM doc_history WHERE session_id = ?`)

/** A deleted seminar takes its history with it. */
export function discardHistory(sessionId: string): void {
  dropHistory.run(sessionId)
}

/**
 * How many bytes of history are kept per seminar.
 *
 * It used to be however much accumulated: the only DELETE in the whole file
 * stood in `discardHistory`, that is, history grew until the seminar was
 * deleted. The arithmetic is easy: in a lively class period a burst closes
 * several times a second, a row is kilobytes of delta, and a keyframe the
 * size of the notebook arrives every time the deltas catch up with its
 * volume. A semester-long room with a three-megabyte notebook writes hundreds
 * of megabytes into a database that lies on the same disk as the files of all
 * rooms, and that disk runs out silently and for everyone at once.
 *
 * Sixty-four megabytes is a couple of dozen full snapshots of a
 * three-megabyte notebook with deltas between them, that is, the whole class
 * period and some headroom. An ordinary room never comes near it.
 */
const HISTORY_MAX_BYTES = 64 * 1024 * 1024

const historyWeights = db.prepare(`
  SELECT seq, kind, LENGTH(update_blob) AS bytes
  FROM doc_history WHERE session_id = ? ORDER BY seq DESC
`)

const trimBefore = db.prepare(`DELETE FROM doc_history WHERE session_id = ? AND seq < ?`)

/**
 * Trim a seminar's history from the old end, down to the byte ceiling.
 *
 * It is cut in WHOLE segments — everything older than some keyframe — and
 * this is not fussiness. Replaying any version starts from the nearest
 * keyframe NOT LATER than it and rolls forward all rows between them
 * (`updatesUpTo`), so a dropped row breaks the restore not of itself but of
 * everything standing behind it up to the next snapshot. Dropping the "quiet"
 * rows older than the last keyframe, as it seemed at first glance, would
 * break the chain under every visible version of the previous segment: the
 * "Restore" button would stay in place and write over the live notebook
 * something other than what it promised.
 *
 * So the boundary is set exactly on a keyframe: everything that remains
 * replays without a single missing row, and what is gone is gone whole, from
 * the feed too — the seminar's history starts later, and that is visible,
 * not faked.
 *
 * The last segment is never cut, even if on its own it is over the ceiling:
 * a room needs at least one point from which replaying is possible at all
 * (`hasHistoryBase`).
 *
 * Returns how many rows were removed. It is called not by the database but by
 * `collab/history.ts` right after a successful keyframe — the only moment
 * when a whole snapshot is guaranteed to be ahead.
 */
export function trimHistory(sessionId: string, keepBytes = HISTORY_MAX_BYTES): number {
  const rows = historyWeights.all(sessionId) as { seq: number; kind: string; bytes: number }[]
  if (rows.length === 0) return 0
  let bytes = 0
  /** The oldest snapshot down to which the history still fits under the ceiling. */
  let cut: number | null = null
  let over = false
  for (const row of rows) {
    bytes += row.bytes
    // The ceiling is measured over all rows, while the boundary is set only on
    // a snapshot: any number of deltas may lie between two snapshots, and they
    // count toward "we hit it" too.
    if (bytes > keepBytes) over = true
    if (row.kind !== 'keyframe') continue
    if (!over) {
      cut = row.seq
      continue
    }
    // Nothing more fits. The freshest snapshot is always kept, even if on its
    // own it is over the ceiling: without it nothing at all can be replayed.
    cut ??= row.seq
    break
  }
  // We did not hit the ceiling, so there is nothing to cut: trimming by age is
  // not the goal here but the price of space. The same goes when there is no
  // snapshot at all or it is itself the oldest row.
  if (!over || cut === null || cut <= rows[rows.length - 1].seq) return 0
  return trimBefore.run(sessionId, cut).changes
}

const oldestVersion = db.prepare(
  `SELECT kind FROM doc_history WHERE session_id = ? ORDER BY seq ASC LIMIT 1`,
)

/**
 * Whether the feed starts later than the room did.
 *
 * `trimHistory` above cuts the beginning in whole segments, and without this
 * flag the history panel shows the remainder as if there had been no early
 * edits: the list simply starts in the middle of the class period, and from
 * it one cannot tell "nothing was written here" from "nothing before this
 * point was kept".
 *
 * Measured by state, not by memory of an event: trimming sets the boundary
 * exactly on a keyframe, while the very first row of a room is always written
 * as `opened` (collab/history.ts · beginHistory), and it will not appear a
 * second time — after trimming `hasHistoryBase` is already true because of
 * the remaining snapshot. So "the oldest row is not `opened`" is exactly "the
 * beginning was not kept", and the answer survives a server restart and needs
 * no extra column.
 *
 * An empty history is not a trimmed one: for a room where nothing has been
 * recorded yet the panel speaks in its own words.
 */
export function historyTrimmed(sessionId: string): boolean {
  const row = oldestVersion.get(sessionId) as { kind: string } | undefined
  return row !== undefined && row.kind !== 'opened'
}
