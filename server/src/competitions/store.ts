/**
 * Соревнования: таблицы и запросы к ним.
 *
 * СХЕМА ЗДЕСЬ, и владелец у неё один. Это не общие таблицы продукта: ни один
 * другой модуль в них не пишет и столбцов им не добавляет, поэтому `CREATE
 * TABLE` стоит рядом с единственными запросами — в отличие от `sessions`,
 * которую правят трое, и поэтому её схема живёт в `db.ts` (см. шапку
 * publish/store.ts, где эта граница проведена вслух).
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Здесь — строки: соревнования, их файлы, участники
 * инстанса, посылки, прогоны и очередь. Правила — в `@shared/competitions`, и
 * этот модуль их ЗОВЁТ, а не повторяет: сколько посылок осталось сегодня и
 * какая идёт в зачёт, веб и сервер обязаны считать одинаково. Диск — в
 * `storage.ts`; отсюда к нему одно обращение, удаление соревнования, и оно
 * нарочно не тихое.
 *
 * ОЧЕРЕДЬ — уровня инстанса и в базе, а не в памяти процесса. Пара идёт
 * полтора часа, посылки копятся всё это время, а `npm run build` на сервере
 * или падение процесса не должны означать «тридцать человек прислали в пустоту».
 * Поэтому в строке очереди лежит всё, чем можно поднять работу заново: чей это
 * прогон, какого он вида, сколько раз уже начинался, в каком контейнере идёт и
 * — главное — какая ЖИЗНЬ ПРОЦЕССА его начала (`boot`). Строка «исполняется»,
 * помеченная чужой жизнью, — это осиротевший прогон: контейнера больше нет, и
 * никто, кроме `orphanedRuns`, об этом не узнает.
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

/* ------------------------------------------------------------------ схема */

/**
 * Ключ участника переехал из столбца в отпечаток — ДО того, как читается схема.
 *
 * У того, кто поднимал эту ветку раньше, `entrants` заведена со столбцом
 * `link_key`, в котором ключ лежит как есть. `CREATE TABLE IF NOT EXISTS` про
 * это не знает и молчит, а следом за ним идёт `CREATE UNIQUE INDEX … (key_hash)`
 * — по столбцу, которого в той таблице нет, то есть отказ на импорте модуля и
 * сервер, который не поднимается вовсе. Отсюда и место: раньше схемы.
 *
 * Строки переживают переезд: ключи, которые люди уже записали, остаются
 * рабочими — считается их отпечаток и запечатывается копия. Старый столбец
 * опустошается в той же транзакции, потому что вся затея ровно об этом.
 */
function liftEntrantKeys(): void {
  const columns = db.prepare('PRAGMA table_info(entrants)').all() as { name: string }[]
  // Таблицы нет вовсе — её заведёт схема ниже, уже правильной.
  if (columns.length === 0 || columns.some((column) => column.name === 'key_hash')) return
  db.exec("ALTER TABLE entrants ADD COLUMN key_hash TEXT NOT NULL DEFAULT ''")
  db.exec("ALTER TABLE entrants ADD COLUMN key_sealed TEXT NOT NULL DEFAULT ''")
  // Прежний индекс носит то же имя и стоит на прежнем столбце: `IF NOT EXISTS`
  // ниже увидел бы его и оставил уникальность там, где её больше нет.
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
    // SQLite старше 3.35 сносить столбцы не умеет. Он уже пуст, и это главное.
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
     * Зерно деления строк, записанное при создании и больше не меняемое.
     * Перегенерировать его значит поменять, какие строки были публичными, —
     * то есть сделать вчерашний лидерборд несравнимым с сегодняшним.
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
  /* Адрес /k/<slug> — единственность держит база, а не проверка перед вставкой. */
  CREATE UNIQUE INDEX IF NOT EXISTS competitions_slug ON competitions(slug);

  /*
   * Файлы соревнования — строка на файл, байты на диске (storage.ts).
   *
   * Видимость столбцом, а не двумя таблицами: список у участника и список у
   * преподавателя — один и тот же запрос с разным WHERE, и раздвоив таблицу,
   * однажды получишь ответы, добавленные в открытый список.
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
   * Участник соревнований — уровня ИНСТАНСА, а не комнаты.
   *
   * Личность студента в занятии привязана к session_id и живёт в localStorage
   * браузера: зашёл с телефона — другой человек. Посылки и место обязаны
   * возвращаться с другого устройства, поэтому здесь заводится своя сущность с
   * ключом входа — ровно та же механика, что у личных ссылок преподавателей.
   */
  CREATE TABLE IF NOT EXISTS entrants (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    /*
     * Самого ключа здесь нет ни в одном столбце — см. competitions/key.ts.
     * key_hash ищет человека на входе и подписывает его печенье, key_sealed
     * показывает ключ хозяину в карточке P1. Утёкшая база без секрета инстанса
     * не отдаёт ни одного входа.
     */
    key_hash     TEXT NOT NULL,
    key_sealed   TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    disabled     INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS entrants_key ON entrants(key_hash);

  /*
   * Кто в каком соревновании — отдельной строкой, а не «прислал посылку».
   *
   * Макет P1 различает «Участвую» и «ещё не участвуете» ДО первой посылки:
   * кнопка «УЧАСТВОВАТЬ» заводит человека в таблицу, и только после этого у
   * него появляется зона загрузки. Второе, ради чего таблица нужна, —
   * уникальность имени: тёзок в лидерборде быть не должно, а держать это
   * правило может только уникальный индекс. Проверка выборкой пропустила бы
   * двоих, нажавших «УЧАСТВОВАТЬ» в одну секунду.
   */
  CREATE TABLE IF NOT EXISTS competition_entrants (
    competition_id TEXT NOT NULL,
    entrant_id     TEXT NOT NULL,
    /** Имя, приведённое к виду, в котором сравнивают тёзок (@shared). */
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
  /* «#12» — номер в пределах соревнования, и двух одинаковых быть не может. */
  CREATE UNIQUE INDEX IF NOT EXISTS submissions_number
    ON submissions(competition_id, number);
  /* «Мои посылки» и счёт дневной нормы — один и тот же порядок чтения. */
  CREATE INDEX IF NOT EXISTS submissions_mine
    ON submissions(competition_id, entrant_id, accepted_at);
  /* Лидерборд читает только дошедшие до числа, и сразу в порядке результата. */
  CREATE INDEX IF NOT EXISTS submissions_board
    ON submissions(competition_id, state, public_score);

  /*
   * Прогон — один заход в контейнер, и их у посылки несколько.
   *
   * Ради единственной вещи, обещанной макетом: «после правки метрики всё
   * пересчитывается без повторного исполнения тетрадей». Пересчёт заводит
   * новый прогон вида metric рядом с прежним notebook, и тетрадь второй раз не
   * запускается.
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
   * Очередь исполнения — одна на инстанс.
   *
   * В базе, а не в памяти: перезапуск сервера посреди пары не должен означать
   * «тридцать посылок исчезли». Столбец boot называет жизнь процесса, которая
   * начала прогон, — по нему и только по нему видно осиротевшую работу. Имя
   * контейнера лежит рядом, чтобы было что убить: контейнер переживает
   * процесс, который его запустил.
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
    /*
     * Который по счёту заход ЭТОГО человека — считается в момент постановки в
     * очередь и больше не меняется. Ради него столбец и заведён: без него
     * «честно по людям» держалось бы на том, что чужая посылка ещё видна в
     * очереди, и разваливалось ровно в ту секунду, когда предыдущая работа
     * того же человека из очереди ушла (см. порядок выборки ниже).
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
   * Пауза очереди — одна строка на инстанс.
   *
   * Своей таблицей, а не ключом в instance_settings: ту заводит admin/settings,
   * и второй владелец у чужой схемы — ровно то, чего этот код избегает
   * (см. шапку). Строка ровно одна, и это сказано CHECK, а не соглашением.
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
 * Столбец, которого ещё нет. SQLite не умеет ADD COLUMN IF NOT EXISTS, а
 * таблицы выше уже могли завестись у того, кто обновился на день раньше.
 * Та же функция и по той же причине живёт в db.ts и в routes/admin-instance.ts.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}
/**
 * Который по счёту заход человека — появился позже самой очереди.
 *
 * У того, кто поднимал эту ветку раньше, таблица уже заведена без него, и
 * `CREATE TABLE IF NOT EXISTS` про новый столбец не знает. Ноль по умолчанию
 * означает «все прежние строки равны», то есть очередь на них работает так,
 * как работала до появления честности по людям, — и первая же новая посылка
 * получает настоящий номер захода.
 */
ensureColumn('competition_queue', 'turn', 'turn INTEGER NOT NULL DEFAULT 0')
ensureColumn('competition_queue', 'attempt_id', 'attempt_id TEXT')
ensureColumn('competition_queue', 'pending_kind', 'pending_kind TEXT')

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


/* ------------------------------------------------------------------ имена */

/**
 * Восемь символов из алфавита, который читают вслух, — как у семинаров и
 * публикаций. Идентификатор соревнования едет в путь на диске, так что
 * буквы в нём выбраны не только ради глаз.
 */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newId(): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)]
  return out
}

/**
 * Жизнь этого процесса — метка, по которой видно осиротевшие прогоны.
 *
 * Случайная на каждый запуск и нарочно не pid: pid переиспользуется системой,
 * и в один несчастливый день строка мёртвого прогона выглядела бы своей.
 */
export const BOOT = randomUUID()

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

/* ------------------------------------------------------------ соревнования */

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
 * Завести соревнование. `null` — адрес занят.
 *
 * Занятость решает уникальный индекс, а не SELECT перед вставкой: два
 * преподавателя, сохранившие черновик в одну секунду, прошли бы проверку оба.
 * Родится соревнование всегда черновиком — открывает его отдельное действие,
 * которому есть что проверить (прошла ли сэмпл-тетрадь весь путь до числа).
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
      // Зерно рождается вместе с соревнованием и не трогается больше никогда.
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

/** По адресу или по идентификатору — как открывают ссылку `/k/<slug>`. */
export function findCompetition(slugOrId: string): Competition | null {
  const row = (selectBySlug.get(slugOrId) ?? selectCompetition.get(slugOrId)) as
    | CompetitionRow
    | undefined
  return row ? toCompetition(row) : null
}

export function listCompetitions(): Competition[] {
  return (selectCompetitions.all() as CompetitionRow[]).map(toCompetition)
}

/** Поля, которые правит редактор. Всё, чего нет в патче, остаётся как было. */
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
 * Правка соревнования. `null` — такого нет; `'taken'` — новый адрес занят.
 *
 * Собирается одним UPDATE по тем полям, что пришли: «сохранить всё» переписало
 * бы поля, которых редактор в этот раз не показывал, — а панель A3 показывает
 * не ту же форму, что A2.
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
 * Открыть приватный лидерборд рукой.
 *
 * Время, а не флаг: «итоги открыли в 14:20» — это ответ на вопрос, который
 * задают после разбора, и хранить его отдельно было бы негде.
 */
export function openPrivateBoard(id: string, at = Date.now()): boolean {
  return openPrivate.run(at, at, id).changes > 0
}

/**
 * Удалить соревнование — со строками и с диском.
 *
 * Файлы сносятся ПОСЛЕ транзакции и нарочно вслух: тихо оставленный каталог
 * означает ответы удалённого соревнования, лежащие на диске неограниченно
 * долго, и заметить это некому.
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
    // Сами участники остаются: человек живёт на инстансе, а не в соревновании,
    // и его ключ обязан пускать в остальные.
    db.prepare('DELETE FROM competition_entrants WHERE competition_id = ?').run(competitionId)
    return deleteCompetitionRow.run(competitionId).changes
  })(id)
  if (rows === 0) return false
  removeCompetitionFiles(id)
  return true
}

/** Имена живых соревнований — их спрашивает уборка осиротевших каталогов. */
export function liveCompetitionIds(): Set<string> {
  return new Set((selectLiveIds.all() as { id: string }[]).map((row) => row.id))
}

/* ------------------------------------------------------------------ файлы */

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

/** Сколько весят открытые файлы — против потолка «до 200 МБ на соревнование». */
export function openFileBytes(id: string): number {
  return (sumOpenBytes.get(id) as { bytes: number }).bytes
}

/* --------------------------------------------------------------- участники */

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
 * Строка → запись. Ключа в записи нет — ни открытого, ни отпечатка.
 *
 * `Entrant` уезжает в браузер списком участников и строкой лидерборда, и
 * поля, которого там нет, нельзя отдать по недосмотру. Кому ключ нужен, тот
 * зовёт `entrantKeyOf` — дверь, которую видно в выдаче grep.
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
 * Завести участника с новым ключом. Ключ возвращается ОДИН раз — вот отсюда.
 *
 * Столкновение ключей невозможно практически, но проверяет его база, а не
 * арифметика: повтор на уникальном индексе стоит ещё одного оборота цикла, а
 * молча выданный чужой ключ стоит чужих результатов.
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
 * Кто это — по ключу входа.
 *
 * Отключённый ключ здесь НЕ отсеивается: отказ «ключ отключён» и отказ «такого
 * ключа нет» — разные слова на экране, и разделить их может только тот, кто
 * видит строку.
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
 * Ключ человека — распечатанный ради карточки «ВАШ КЛЮЧ ВХОДА» (P1).
 *
 * Единственная дверь, возвращающая секрет из базы, и названа она так, чтобы её
 * было видно: у преподавателей ровно так же устроен `linkKeyOf`. Зовут её два
 * места — ответ самому человеку и ссылка, которую он копирует. `null` значит
 * «секрет инстанса сменили»: ключ в этом случае и правда больше не работает.
 */
export function entrantKeyOf(id: string): string | null {
  const row = selectEntrantSecret.get(id) as { key_hash: string; key_sealed: string } | undefined
  if (!row?.key_sealed) return null
  return unsealEntrantKey(row.key_sealed)
}

/**
 * Отпечаток ключа — то, чем подписано печенье участника.
 *
 * Тот же приём, что у печенья панели (`admin/auth.ts` · sign): отпечаток
 * входит в подписываемое сообщение, поэтому выдача нового ключа обрывает и все
 * прежние входы — без таблицы сессий, которую всё равно никто не чистит.
 */
export function entrantKeyHash(id: string): string | null {
  const row = selectEntrantSecret.get(id) as { key_hash: string } | undefined
  return row ? row.key_hash : null
}

/**
 * Выдать новый ключ. Старый перестаёт действовать в ту же секунду — это и есть
 * ответ на «потерял ключ»: другого способа отобрать розданную строку нет.
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
 * Кто участвует в этом соревновании.
 *
 * Вступившие ИЛИ приславшие хоть одну посылку. Второе условие — не
 * перестраховка: соревнования старше этой таблицы (и прогонщик в тестах)
 * заводят посылки, не проходя через «УЧАСТВОВАТЬ», а человек с посылкой в
 * лидерборде — участник по любому счёту, каким его ни считай.
 */
export function listCompetitionEntrants(competitionId: string): Entrant[] {
  return (selectCompetitionEntrants.all(competitionId, competitionId) as EntrantRow[]).map(toEntrant)
}

/* --------------------------------------------------------------- вступление */

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
 * Вступить в соревнование под этим именем.
 *
 * `'taken'` — тёзка: в этом соревновании уже есть человек с таким именем, и
 * различать их в лидерборде будет нечем. Решает это уникальный индекс, а не
 * выборка перед вставкой: двое, нажавшие «УЧАСТВОВАТЬ» в одну секунду, прошли
 * бы проверку оба.
 *
 * Имя у человека ОДНО на инстанс, поэтому вступление заодно переименовывает
 * его везде — и проверяется это тем же индексом во всех его соревнованиях
 * сразу. Иначе «Анна Ким», переименовавшись, стала бы тёзкой другой Анны в
 * соревновании, которое она открывала неделю назад, и лидерборд соврал бы
 * там, куда никто не смотрел.
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
     * Ловится СНАРУЖИ транзакции нарочно: better-sqlite3 откатывает её только
     * если функция бросила. Пойманный внутри отказ дал бы «taken» и при этом
     * коммит — то есть человека, переименованного отказом, что и случилось в
     * первой версии этого кода.
     */
    if (isUniqueViolation(error)) return 'taken'
    throw error
  }
}

/** Вступил ли человек — и когда. `null` значит «ещё нет». */
export function joinedAt(competitionId: string, entrantId: string): number | null {
  const row = selectEnrollment.get(competitionId, entrantId) as { joined_at: number } | undefined
  return row ? row.joined_at : null
}

/** В каких соревнованиях человек состоит — для списка «Участвую» (P1). */
export function myCompetitionIds(entrantId: string): Set<string> {
  const rows = selectMyEnrollments.all(entrantId) as { competition_id: string }[]
  return new Set(rows.map((row) => row.competition_id))
}

/* ---------------------------------------------------------------- посылки */

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
 * Который по счёту заход этого человека — столько его работ уже в очереди.
 *
 * Считается один раз, при постановке, и в этом вся соль: очередь обязана
 * помнить, что человек уже занимал исполнителя, ПОСЛЕ того как та работа из
 * неё ушла.
 */
const TURN = `(SELECT COUNT(*) FROM competition_queue q
               WHERE q.entrant_id = @entrant_id AND q.submission_id != @submission_id)`

const insertQueueRow = db.prepare(`
  INSERT INTO competition_queue
    (submission_id, competition_id, entrant_id, kind, state, enqueued_at, turn)
  VALUES (@submission_id, @competition_id, @entrant_id, @kind, 'waiting', @at, ${TURN})
`)

/**
 * Принять посылку: строка, номер и место в очереди — одной транзакцией.
 *
 * Номер считается здесь же, под той же транзакцией: два человека, приславшие
 * тетрадь в одну секунду, иначе получили бы один «#12» на двоих, и уникальный
 * индекс отказал бы второму уже после того, как его файл лёг на диск.
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
 * Сколько работ человека сейчас в полёте — ждут или исполняются.
 *
 * По строке посылки, а не по очереди: из очереди строка уходит, как только
 * прогон кончился, а посылка остаётся — и именно она источник правды о том,
 * чем занят исполнитель от имени этого человека.
 */
export function inFlightCount(competitionId: string, entrantId: string): number {
  return (countInFlight.get(competitionId, entrantId) as { n: number }).n
}

const selectCounts = db.prepare(
  'SELECT entrant_id, COUNT(*) AS n FROM submissions WHERE competition_id = ? GROUP BY entrant_id',
)

/** Сколько посылок у каждого — колонка «ПОСЫЛОК» в итоговом лидерборде (P3). */
export function submissionCounts(competitionId: string): Map<string, number> {
  const rows = selectCounts.all(competitionId) as { entrant_id: string; n: number }[]
  return new Map(rows.map((row) => [row.entrant_id, row.n]))
}

/**
 * Сколько посылок человеку осталось сегодня; `null` — предела нет.
 *
 * Считает правило из `@shared/competitions`, а не SQL: то же число рисует
 * участнику браузер («Сегодня можно отправить ещё 3 посылки из 5»), и второй
 * копии у этого счёта быть не должно. База отдаёт только строки за сутки.
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

/** Сколько посылок человека ушло сегодня в счёт нормы. */
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

/** Что прогонщик записывает в посылку по ходу дела. */
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
 * Выбрать посылку в зачёт.
 *
 * Одной транзакцией со снятием прежнего выбора: две отметки «в зачёт» у одного
 * человека — это лидерборд, который не сходится сам с собой, и поймать такое
 * потом можно только вручную.
 *
 * Выбрать можно только свою и только дошедшую до числа: у упавшей нет числа,
 * которое можно поставить в таблицу.
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
 * Лидерборд одной части теста.
 *
 * Сортировку и выбор зачётной посылки считает `@shared/competitions`, а не
 * SQL: правило «при равенстве выше тот, кто прислал раньше» и оговорка «не
 * выбрал — лучшая по публичной» обязаны одинаково работать и на сервере, и в
 * браузере, который рисует ту же таблицу из того же ответа.
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
  /** «ДОШЛИ ДО ЧИСЛА» в сводке A3. */
  scored: number
  notebookFailed: number
  rejected: number
  timedOut: number
  outOfMemory: number
  metricFailed: number
  cancelled: number
  entrants: number
  /** Лучший публичный результат — с учётом направления метрики. */
  bestPublic: number | null
}

/** Пять чисел сводки A3 и то, что показывает список соревнований A1. */
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

/* ---------------------------------------------------------------- прогоны */

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

/** Последний прогон этого вида — то, что показывает строка посылки. */
export function lastRun(submissionId: string, kind?: RunKind): SubmissionRun | null {
  const runs = listRuns(submissionId).filter((run) => !kind || run.kind === kind)
  return runs.length ? runs[runs.length - 1] : null
}

/* ----------------------------------------------------------------- очередь */

export interface QueueRow {
  submissionId: string
  competitionId: string
  entrantId: string
  kind: RunKind
  state: 'waiting' | 'running'
  enqueuedAt: number
  startedAt: number | null
  attempts: number
  /** Который по счёту заход этого человека — см. порядок выборки. */
  turn: number
  /** Жизнь процесса, которая начала прогон. Чужая — значит прогон осиротел. */
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
    boot = NULL,
    container = NULL,
    attempt_id = NULL,
    pending_kind = NULL
  WHERE competition_queue.state != 'running'
`)
/* Идущее сверху, ждущие следом в порядке прихода — так это читает панель. */
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
  SET state = 'waiting', started_at = NULL, boot = NULL, container = NULL, attempt_id = NULL
  WHERE submission_id = ?
`)
const noteContainer = db.prepare(
  'UPDATE competition_queue SET container = ? WHERE submission_id = ?',
)

/**
 * Поставить работу в очередь — новую посылку или пересчёт метрики.
 *
 * Повторный заход по тому же идентификатору возвращает строку в ожидание:
 * «исполнить заново» из меню строки и «исправить метрику и пересчитать всех» —
 * это та же посылка, а не новая.
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
 * Кто следующий — честно по людям.
 *
 * Три ключа, и каждый закрывает свой способ занять исполнителя одному.
 *
 * Первый — «у кого уже что-то исполняется, тот пропускает остальных вперёд»:
 * это прямо обещано подписью под очередью в A3.
 *
 * Второй — `turn`: своя k-я по счёту посылка встаёт позади всех чужих (k−1)-х.
 * Без него человек, приславший десять тетрадей подряд, занимал бы исполнителя
 * на полчаса — причём НЕЗАМЕТНО: пока его первая идёт, первый ключ ещё держит
 * очередь честной, а в ту секунду, когда она уходит из очереди, его вторая
 * обгоняет чужую по времени прихода. Поэтому счёт заходов записан в строке, а
 * не выводится из того, что ещё видно в очереди.
 *
 * Третий — время прихода, и он же последний: при равном счёте заходов раньше
 * тот, кто раньше прислал.
 *
 * Считается в SQL, а не в памяти, потому что очередь — это состояние базы, и
 * два процесса (сервер и, однажды, отдельный прогонщик) должны видеть один и
 * тот же ответ.
 */
const selectNext = db.prepare(`
  SELECT q.* FROM competition_queue q
  WHERE q.state = 'waiting'
  ORDER BY
    (SELECT COUNT(*) FROM competition_queue r
      WHERE r.state = 'running' AND r.entrant_id = q.entrant_id) ASC,
    q.turn ASC,
    q.enqueued_at ASC,
    q.submission_id ASC
  LIMIT 1
`)

export function nextQueueRow(): QueueRow | null {
  const row = selectNext.get() as QueueRowRaw | undefined
  return row ? toQueueRow(row) : null
}

/**
 * Взять следующую работу и пометить её своей.
 *
 * `null` — брать нечего: очередь пуста, приостановлена или все места заняты.
 * Одна посылка за раз по умолчанию: на машине преподавателя рядом идёт
 * занятие, и вторая посылка отнимает у него память, а не ускоряет очередь.
 *
 * Транзакцией, потому что «посмотреть и взять» двумя запросами — это две
 * копии одного прогона в тот день, когда прогонщиков станет два.
 */
export const takeNext = db.transaction(
  (opts: { boot?: string; at?: number; slots?: number } = {}): QueueRow | null => {
    if (queuePaused()) return null
    const slots = opts.slots ?? 1
    if ((selectRunning.all() as QueueRowRaw[]).length >= slots) return null
    const row = selectNext.get() as QueueRowRaw | undefined
    if (!row) return null
    const at = opts.at ?? Date.now()
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

/** Запомнить контейнер идущего прогона — по нему его убивают. */
export function noteQueueContainer(submissionId: string, container: string | null, attemptId?: string): void {
  if (attemptId) db.prepare('UPDATE competition_queue SET container = ? WHERE submission_id = ? AND attempt_id = ?').run(container, submissionId, attemptId)
  else noteContainer.run(container, submissionId)
}

/** A completion may touch only the immutable lease that started it. */
export function ownsQueueAttempt(row: QueueRow): boolean {
  const current = queueRow(row.submissionId)
  return !!row.attemptId && current?.state === 'running' && current.attemptId === row.attemptId
}

export const finishQueueAttempt = db.transaction((row: QueueRow): boolean => {
  if (!ownsQueueAttempt(row)) return false
  const current = queueRow(row.submissionId)!
  if (current.pendingKind) {
    db.prepare("UPDATE competition_queue SET kind = pending_kind, pending_kind = NULL, state = 'waiting', started_at = NULL, container = NULL, boot = NULL, attempt_id = NULL, attempts = 0 WHERE submission_id = ? AND attempt_id = ?").run(row.submissionId, row.attemptId)
    updateSubmission(row.submissionId, { state: 'queued', stage: 'queue', publicScore: null, privateScore: null })
  } else db.prepare('DELETE FROM competition_queue WHERE submission_id = ? AND attempt_id = ?').run(row.submissionId, row.attemptId)
  return true
})

/** Работа кончилась (чем угодно) — строка уходит из очереди. */
export function leaveQueue(submissionId: string): boolean {
  return deleteQueueRow.run(submissionId).changes > 0
}

/** Вернуть работу в ожидание: отменили паузой, убили руками, не доехала. */
export function requeue(submissionId: string): boolean {
  return markWaiting.run(submissionId).changes > 0
}

/**
 * Прогоны, начатые ПРОШЛОЙ жизнью процесса.
 *
 * Строка «исполняется», помеченная чужим `boot`, означает ровно одно: сервер
 * перезапустили, пока посылка шла. Контейнера, скорее всего, уже нет — а если
 * есть, его имя лежит рядом, и убить его должен тот, кто это прочитал.
 * Раньше такая работа оставалась бы «выполняется» навсегда, и участник до
 * конца соревнования смотрел бы на таймер, который не движется.
 */
export function orphanedRuns(boot = BOOT): QueueRow[] {
  return (
    db
      .prepare(`SELECT * FROM competition_queue WHERE state = 'running' AND (boot IS NULL OR boot != ?)`)
      .all(boot) as QueueRowRaw[]
  ).map(toQueueRow)
}

/**
 * Сколько раз прогон поднимают заново, прежде чем признать его оборванным.
 *
 * Два: один перезапуск сервера посреди пары — обычное дело, два подряд на
 * одной и той же посылке означают, что дело в ней, и крутить её третий раз
 * значит занимать исполнителя тем, что не считается.
 */
const MAX_ATTEMPTS = 2

/**
 * Поднять работу прошлой жизни заново или честно пометить её оборванной.
 *
 * Зовётся один раз при старте процесса. Оборванная посылка помечается
 * `metricFailed`, а не «упала тетрадь»: участник тут ни при чём, и слово
 * должно называть виноватого правильно — он увидит фразу «проверяющий код
 * упал, посылка будет пересчитана», а преподаватель прочтёт в своей колонке,
 * что прогон оборвал перезапуск.
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
 * Приостановить очередь или пустить её снова.
 *
 * Пауза не трогает идущий прогон: убить его — отдельное действие с отдельной
 * кнопкой («Убить»), и склеивать их значило бы терять чужую минуту работы
 * нажатием, которое обещало только «не начинай новых».
 */
export function setQueuePaused(paused: boolean, by: string | null = null, at = Date.now()): void {
  updatePause.run(paused ? 1 : 0, paused ? at : null, paused ? by : null)
}

/* --------------------------------------------------------------- уборка */

/**
 * Что из посылок стоит держать на диске.
 *
 * Числа живут в базе вечно — лидерборд обязан сойтись и через год. Тяжёлое
 * (присланная тетрадь, исполненная тетрадь с выводом, ответ) нужно, пока
 * участник разбирается с неудачей, и может уйти у давно закрытого
 * соревнования. Решение принимается здесь, потому что это вопрос к базе;
 * снимает файлы `storage.ts`.
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
