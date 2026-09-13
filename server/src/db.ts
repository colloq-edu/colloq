import { usingRuntimeBroker, runtimeEnvironment, imageRevision } from './kernel/runtime-client.js'
import { RUNTIME_REVISION } from '@shared/runtime'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config, ensureDataDir } from './config.js'
import { colorForId, type Participant, type SessionInfo } from '@shared/protocol'
import { OPEN_ROOM, readRules, rulesAfterClass, type RoomRules } from '@shared/rules'

// 0700 — одним правилом на всех, см. config.ensureDataDir: mkdirSync с mode на
// уже заведённом каталоге режим не меняет, и обещание ниже держалось не всегда.
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
 * Свести журнал в саму базу — раз в пять минут и на выходе.
 *
 * В режиме WAL записи копятся в отдельном файле и переезжают в основной, когда
 * SQLite сочтёт нужным. Семинар пишет много и почти не читает, так что момент
 * может не наступать часами: `colloq.db` выглядит вчерашним, а весь день лежит
 * в `-wal` рядом. Скопировать «базу» в этот момент — значит скопировать
 * вчерашний день, и именно так делают все, кто копирует один файл.
 *
 * По таймеру — PASSIVE: он сводит всё, что может, и не ждёт никого. TRUNCATE
 * ждёт читателей через busy-handler, а better-sqlite3 синхронный: `make
 * backup` (это `VACUUM INTO` в соседнем процессе, читающий базу секунды)
 * останавливал цикл событий вместе со всеми сокетами всех комнат — до пяти
 * секунд посреди пары, при том что README обещает бэкап на ходу. Пустой журнал
 * нужен ровно один раз — на выходе, где читателей уже нет; там и TRUNCATE.
 */
const CHECKPOINT_EVERY_MS = 5 * 60 * 1000

/**
 * Снять копию базы, не останавливая семинар.
 *
 * `VACUUM INTO` читает согласованный снимок и пишет один готовый файл — без
 * `-wal` рядом и без вопроса «а всё ли доехало». Копирование `colloq.db` на
 * ходу этого не даёт: половина дня лежит в журнале, и копия отстаёт на часы.
 *
 * Путь не должен существовать — SQLite отказывается писать поверх, и это
 * правильно: перезаписать чужую копию молча хуже, чем не сделать новую.
 */
export function backupTo(file: string): void {
  db.exec(`VACUUM INTO ${quote(file)}`)
}

/** SQLite не принимает параметр в VACUUM INTO, так что путь экранируется руками. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function checkpoint(mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): void {
  try {
    db.pragma(`wal_checkpoint(${mode})`)
  } catch (err) {
    // Занят читателем — не беда: следующий заход через пять минут.
    console.error('[db] checkpoint failed:', err instanceof Error ? err.message : err)
  }
}

const checkpointTimer = setInterval(checkpoint, CHECKPOINT_EVERY_MS)
// Не повод держать процесс живым.
checkpointTimer.unref?.()

/**
 * Свести журнал и закрыть файл — на выходе.
 *
 * `process.exit` не закрывает базу: журнал WAL остаётся лежать рядом, и
 * `colloq.db` остановленного инстанса — это вчерашний день, а сегодняшний в
 * файле, который никто не копирует. better-sqlite3 при close() сам делает
 * контрольную точку.
 */
export function closeDatabase(): void {
  clearInterval(checkpointTimer)
  // Здесь TRUNCATE: комнат больше нет, ждать некого, а журнал должен уйти
  // пустым — остановленный инстанс копируют одним файлом.
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
   * Кого преподаватель закрыл из комнаты и до какого времени.
   *
   * Аккаунтов в продукте нет, поэтому бан опирается на те две метки, которые
   * есть: идентификатор участника (он в localStorage браузера) и метку
   * устройства в куке. Совпадение по ЛЮБОЙ из них — бан; герметичности это не
   * даёт и не обещает, инкогнито даёт чистый браузер.
   *
   * «ip» не участвует в проверке НИКОГДА: за одним NAT сидит вся аудитория, и
   * бан по адресу закрыл бы комнату всему потоку. Он лежит здесь только как
   * подсказка преподавателю «кажется, этот вернулся».
   *
   * «name» своей копией: человек возвращается под другим именем, а строку
   * бана преподаватель обязан узнать — она называет того, кого он банил.
   *
   * Схема — здесь, рядом с прочими таблицами комнаты, которые вместе читают и
   * вместе удаляют. Запросы, кука и правило про просроченные строки — в
   * server/src/bans.ts.
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
  /* Каждое чтение — «эта комната, действующие сейчас», и это ровно индекс. */
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
   * Курс — постоянная публичная страница, собирающая семестр семинаров в том
   * порядке, в каком их вели. Единственный адрес в Colloq, который человек
   * стал бы сохранить в закладки.
   *
   * СХЕМА этих таблиц (courses, publications, publication_steps, blobs) —
   * здесь, вместе с миграциями ниже; ЗАПРОСЫ к ним — в publish/store.ts, и
   * там же заводится своя publish_addresses. Владелец схемы один, и это
   * важно помнить в обе стороны: шапка store.ts когда-то обещала «здесь свои
   * таблицы и никто больше в них не пишет» — про таблицы, которых он не
   * создаёт.
   *
   * Состав и порядок — одним фактом, JSON-массивом: и то и другое читается
   * только целиком, «в каких курсах состоит этот семинар» никто не спрашивает,
   * а хранить порядок отдельными числами значит уметь их разъезжаться. Ровно
   * так же в этом коде уже хранится «shape» в collab/history.ts.
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
   * Публикация — второй предмет, выведенный из того, что записала комната.
   *
   * «session_id» обнуляется, когда семинар удаляют, а чтение решили оставить:
   * страницы уже собраны и лежат здесь, за ними ничего не стоит. Поэтому же
   * «title» своя копия — семинара может уже не быть, а страница обязана
   * называться.
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
   * Шаг — момент, который назвал преподаватель, и тетрадь на этот момент.
   *
   * «page» — уже спроецированная страница, а не ссылка на строку истории.
   * Ссылка означала бы разворачивать многомегабайтный документ Yjs на каждый
   * публичный запрос — в том же процессе, который в эту минуту ведёт занятие,
   * и без всякого ограничения частоты. Плюс собранная страница переживает
   * удаление семинара, что и делает «оставить чтение» возможным выбором.
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
   * Крупное содержимое выводов — по одному разу на публикацию.
   *
   * График matplotlib весит сотни килобайт и одинаков во всех шагах, где его
   * ячейка не менялась. По хэшу он лежит один раз и раздаётся с вечным
   * кэшем — страницу открывают с телефона.
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
 * Сколько памяти выдать ядру ЭТОЙ комнаты, в мегабайтах.
 *
 * NULL — «как у окружения», то есть `KERNEL_MEM` и умолчания пула
 * (kernel/pool.ts · memoryLimit), и таковы все семинары, заведённые до того,
 * как это поле появилось. Число здесь заводится ради одного дня: 13.09 ядро
 * семинара убили по памяти шестнадцать раз подряд, и единственной ручкой была
 * переменная окружения на всю машину — поднять её одной комнате было нельзя,
 * а поднять всем значило отдать память десяти комнатам, которым она не нужна.
 *
 * В мегабайтах, а не строкой docker: число сравнивается с тем, что есть на
 * машине, и складывается по комнатам. Строку «4g» для этого пришлось бы
 * разбирать в каждом месте, где её читают.
 */
ensureColumn('sessions', 'memory_mb', 'memory_mb INTEGER')
/*
 * Сколько ядер выдать этой комнате.
 *
 * NULL — «как задано инстансу» (`KERNEL_CPUS`, по умолчанию два), и таковы все
 * семинары до появления поля. Отдельным столбцом рядом с памятью и по той же
 * причине: занятие по зрению и семинар по статистике живут на одном образе, и
 * вся разница между ними — сколько машины им надо. Число здесь решает не
 * только `--cpus`, но и число потоков numpy и torch внутри контейнера
 * (kernel/pool.ts · threadLimit).
 */
ensureColumn('sessions', 'cpus', 'cpus INTEGER')
/*
 * Какую версию вернул откат.
 *
 * Раньше в `summary` лежало «restored the version from 15:04», и время это
 * сервер форматировал по своему поясу: в контейнере это UTC, а строки ленты
 * рисует браузер по своему — в аудитории UTC+3 подпись указывала на строку,
 * которой в списке нет. Время на сервере больше не собирается; здесь лежит
 * адрес версии, а часы рисует тот, кто смотрит.
 */
ensureColumn('doc_history', 'target_seq', 'target_seq INTEGER')

/**
 * Проведён ли этот участник в ведущие хост-токеном.
 *
 * Роль в строке рядом — не ответ на этот вопрос: туда пишется и «ведущий по
 * куке», а кука тем и хороша, что её можно отобрать. Преподаватель, убранный
 * из списка, обязан потерять Restart во всех комнатах, которые когда-либо
 * открывал; строка с role='host' вернула бы его навсегда.
 *
 * Токен — другое дело: он и есть единственный ключ от семинара, заведённого
 * скриптом мимо панели, отобрать его нельзя, и переживать перезапуск он
 * обязан. Раньше это множество жило в памяти процесса — и после `make stop`
 * автор комнаты приходил в неё гостем, без объяснений.
 */
ensureColumn('participants', 'token_host', 'token_host INTEGER NOT NULL DEFAULT 0')

/**
 * С какого браузера этот человек заходил в последний раз.
 *
 * Метка из куки `colloq_device` (server/src/bans.ts). Лежит в строке участника
 * потому, что бан заводят по одному идентификатору — а закрыть надо и
 * браузер, который через минуту придёт «новым человеком» с чистым
 * localStorage. Взять метку в тот момент неоткуда: запрос присылает
 * преподаватель, и кука в нём его собственная.
 *
 * NULL — обычное дело: в разработке страницу отдаёт Vite, куку ставить некому,
 * и такой человек банится по одному идентификатору. В Participant это поле не
 * попадает: тот уезжает всей комнате, а метка браузера — не то, что комната
 * должна знать друг о друге.
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
 * Когда преподаватель закончил занятие.
 *
 * NULL — занятие идёт, и так читается каждый семинар, заведённый до этой
 * колонки. Время, а не флаг: комната и панель показывают «закончено в 15:40», и
 * это же время отвечает на вопрос «когда пара кончилась», который иначе
 * пришлось бы искать по истории.
 *
 * Колонкой, а не полем в `rules`: правила — это настройка, которую
 * преподаватель выбрал, а конец занятия — состояние, которое обязано пройти
 * поверх любой настройки и отступить, не переписав её (shared/rules.ts ·
 * rulesAfterClass).
 */
ensureColumn('sessions', 'finished_at', 'finished_at INTEGER')

/*
 * Имя в адресе, выбранное человеком.
 *
 * Восьмисимвольный идентификатор годится для комнаты, которую открывают один
 * раз по ссылке из чата. Курс дают классу на год, и `colloq.ru/c/ml-strong`
 * запоминается, диктуется вслух и переживает потерю сообщения, а
 * `/c/vspnrgt5` не делает ничего из этого.
 *
 * Столбцами, а не в JSON: единственность адреса должна держать база, иначе два
 * курса однажды окажутся по одному пути. Оба добавляются миграцией, потому что
 * таблицы уже могли завестись у того, кто обновился на день раньше.
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
/** Мимо кэша, нарочно — см. `sessionRowExists`. */
const selectSessionRow = db.prepare('SELECT 1 FROM sessions WHERE id = ?')

interface SessionRow {
  id: string
  name: string
  created_at: number
  /** JSON, or NULL for a room nobody has configured. */
  rules: string | null
  /** Время конца занятия, или NULL, пока оно идёт. */
  finished_at: number | null
}

export function createSession(id: string, name: string, environment?: string | null): SessionInfo {
  const createdAt = Date.now()
  const pinned = usingRuntimeBroker() ? runtimeEnvironment(environment) : null
  insertSession.run(id, name, createdAt, pinned?.name ?? environment ?? null, pinned ? imageRevision(pinned.image) : null)
  // Про этот id могли спросить до того, как он появился: «нет такой комнаты»
  // лежит в кэше рядом с найденными и пережило бы её рождение.
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
    // Свойство инстанса, читается из конфига на каждой сборке карточки, а не
    // пишется в строку семинара: сменив INSTITUTION, оператор меняет надпись
    // сразу во всех комнатах, включая прошлогодние.
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
 * Лимит памяти комнаты, или null — «как у окружения».
 *
 * Читается на каждом пуске контейнера, как и окружение рядом: преподаватель
 * меняет число между парами, и ответ решает, с каким `--memory` поднимется
 * ядро. Кэша нет намеренно — спрашивают его раз в жизни контейнера.
 */
export function sessionMemoryMb(id: string): number | null {
  const row = selectMemoryMb.get(id) as { memory_mb: number | null } | undefined
  const mb = row?.memory_mb ?? null
  return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? Math.floor(mb) : null
}

/** Задать лимит комнате; null возвращает её к умолчанию окружения. */
export function setSessionMemoryMb(id: string, mb: number | null): void {
  updateMemoryMb.run(mb === null ? null : Math.floor(mb), id)
}

const selectCpus = db.prepare('SELECT cpus FROM sessions WHERE id = ?')
const updateCpus = db.prepare('UPDATE sessions SET cpus = ? WHERE id = ?')

/**
 * Сколько ядер у комнаты, или null — «как задано инстансу».
 *
 * Читается на каждом пуске контейнера, рядом с памятью и окружением: ответ
 * решает и `--cpus`, и число потоков, которое увидят numpy с торчем внутри.
 */
export function sessionCpus(id: string): number | null {
  const row = selectCpus.get(id) as { cpus: number | null } | undefined
  const cpus = row?.cpus ?? null
  return typeof cpus === 'number' && Number.isFinite(cpus) && cpus > 0 ? Math.floor(cpus) : null
}

/** Задать число ядер комнате; null возвращает её к умолчанию инстанса. */
export function setSessionCpus(id: string, cpus: number | null): void {
  updateCpus.run(cpus === null ? null : Math.floor(cpus), id)
}

const selectByEnvironment = db.prepare(
  'SELECT id, name FROM sessions WHERE environment = ? ORDER BY created_at DESC',
)

/**
 * Семинары, привязанные к окружению.
 *
 * Удаление окружения проверяло только «не то ли это, на котором сейчас
 * работает инстанс». Семинар, которому окружение выбрали при создании, хранит
 * его имя в своей строке — и после удаления просыпался в комнате, где ядро не
 * поднимается вовсе: имя есть, образа нет. Обнаруживалось это на первом Run
 * посреди пары.
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
  // Имя комнаты лежит в кэше строки — единственное её поле, которое вообще
  // меняется. Забыть здесь, иначе панель переименовала бы семинар, а комната
  // отвечала бы прежним именем до перезапуска.
  forgetRoom(id)
}

/**
 * Строка комнаты в памяти: есть ли она вообще и то из неё, что не меняется на
 * каждом кадре.
 *
 * Кэш на комнату, как `rulesCache` ниже и `liveBans` в bans.ts, и заведён он
 * ради того же шторма: «жив ли ещё семинар, который назвал токен» —
 * единственное, что спрашивает рукопожатие сокета (index.ts), а сокетов у
 * вкладки два, и после перезапуска сервера или моргания ретранслятора пятьсот
 * вкладок возвращаются за одну-две секунды. Тысяча SELECT по первичному ключу
 * стоит микросекунды каждый и платится ровно там, где цикл событий занят
 * целиком и все ждут возврата комнаты.
 *
 * `null` кэшируется наравне с найденным: браузер, забытый на удалённом
 * семинаре, стучится в эту дверь до истечения токена, и «нет такой комнаты» —
 * такой же ответ, как остальные.
 *
 * Правил и конца занятия здесь нет намеренно: они лежат в `rulesCache`, и
 * второй их копии в этом же процессе быть не должно — разошлись бы. Первое
 * чтение строки кладёт их туда же, чтобы за той же строкой не ходить дважды.
 *
 * Забывается кэш там же, где комната меняется: `createSession`,
 * `renameSession`, `forgetRoom` (её зовёт удаление семинара). Срока жизни нет
 * — он прятал бы забытую инвалидацию до перезапуска. Строку, написанную мимо
 * этого модуля (руками в sqlite3, чужим prepare), кэш не увидит: у продукта
 * одна дверь на запись, и она здесь.
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
  // Та же строка несёт правила и конец занятия — положить их в свой кэш здесь
  // дешевле, чем прочитать её второй раз первым же вопросом о правах.
  if (row) rememberRoom(id, row.rules ?? null, row.finished_at ?? null)
  return identity
}

export function getSession(id: string): SessionInfo | null {
  const identity = identityOf(id)
  if (!identity) return null
  const room = roomOf(id)
  /*
   * `published` и `course` здесь всегда пусты, и это не забывчивость: они
   * живут в таблицах публикаций, а те импортируют этот модуль. Заполняет их
   * маршрут `/api/sessions/:id` — единственное место, где они нужны.
   */
  return {
    id,
    name: identity.name,
    createdAt: identity.createdAt,
    // Своей копией: правила уезжают наружу, а в кэше лежит одна на всю
    // комнату, и правка в чужих руках стала бы правкой для всех сразу.
    rules: { ...room.rules },
    /*
     * Хранимые правила и конец занятия едут порознь, и порознь же читаются
     * клиентом: он накладывает одно на другое сам (shared/rules.ts ·
     * rulesAfterClass), чтобы в настройках комнаты преподаватель видел то,
     * что выбрал, а не то, во что это превратил конец пары.
     */
    finishedAt: room.finishedAt,
    published: null,
    course: null,
    // Из конфига, а не из строки таблицы — см. createSession().
    institution: config.institution,
  }
}

/**
 * Забыть о комнате всё, что этот модуль помнит: строку, правила и права её
 * людей по токену.
 *
 * Зовут её удаление семинара (через `forgetRules`) и создание комнаты: id
 * могли спросить до того, как она появилась, и «нет такой» пережило бы её
 * рождение.
 */
export function forgetRoom(sessionId: string): void {
  roomCache.delete(sessionId)
  hostCache.delete(sessionId)
  rulesCache.delete(sessionId)
}

/**
 * Жива ли строка комнаты — вопрос базе, мимо кэша.
 *
 * Ровно для тех мест, где ошибиться дороже, чем сходить в базу: последняя линия
 * обороны против воскресшего семинара — сброс снимка документа
 * (`collab/persistence.ts`), который не пишет тетрадь комнаты, если строки
 * комнаты уже нет. `getSession` там ответил бы из памяти, и защита держалась бы
 * не на базе, а на том, что КАЖДЫЙ путь удаления помнит про `forgetRoom`; цена
 * одной забытой инвалидации — тетрадь класса, вернувшаяся на диск через
 * несколько секунд после того, как семинар удалили, и снимок без строки
 * семинара, до которого больше не дотянуться.
 *
 * Кэш здесь ничего не экономит: спрашивают это раз в несколько секунд на
 * комнату, при сбросе снимка, а не на каждом рукопожатии — там, где кэш и
 * заведён.
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
    -- Метку не стирает вход, который её не принёс: пультом с планшета человек
    -- входит по ключу обмена, и куки там может не быть вовсе. Забыть браузер,
    -- за которым человек сидит на паре, из-за этого нельзя.
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
  /** Метка браузера — см. столбец device. Наружу не отдаётся. */
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
  /** Ведущий по токену — см. столбец token_host. Куку сюда передавать нельзя. */
  tokenHost?: boolean
  /** Метка браузера из куки, если она есть, — см. столбец device. */
  device?: string | null
}): Participant {
  const existing = selectParticipant.get(p.id, p.sessionId) as ParticipantRow | undefined
  const color = existing?.color ?? colorForId(p.id)
  // Единожды выданное токеном не отбирается позже входом без токена: ключ от
  // комнаты остаётся ключом, даже если владелец открыл её со второй вкладки.
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
  // Не забыть, а записать: право по токену только что решено здесь, и первое
  // же рукопожатие спросит именно его.
  rememberTokenHost(p.sessionId, p.id, tokenHost)
  return { id: p.id, name: p.name, avatar: p.avatar, color, role: p.role }
}

/**
 * Метка браузера, с которого этот человек заходил последним, — или null.
 *
 * Спрашивает её бан: закрывать надо не только идентификатор, но и браузер, из
 * которого он приехал. Отдельной функцией, а не полем Participant: тот уезжает
 * всей комнате.
 */
export function deviceOfParticipant(sessionId: string, participantId: string): string | null {
  const row = selectParticipant.get(participantId, sessionId) as ParticipantRow | undefined
  return row?.device ?? null
}

/**
 * Права по токену в памяти: комната → участник → был ли у него хост-токен.
 *
 * Спрашивает это `roleFor` (routes/sessions.ts) на КАЖДОМ рукопожатии — по два
 * сокета на вкладку, — а меняет ровно один писатель, `upsertParticipant`, и он
 * же кладёт сюда новое значение. Уходит запись вместе с комнатой
 * (`forgetRoom`); больше строку `participants` не трогает никто, кроме
 * удаления семинара, которое сносит её целиком.
 *
 * Карта на комнату, а не общий ключ «комната:участник»: так удаление семинара
 * — один `delete`, а не обход всех, кто когда-либо заходил.
 */
const hostCache = new Map<string, Map<string, boolean>>()

/**
 * Сколько человек комната помнит. Кэш — ускоритель, а не реестр: комната, через
 * которую за семестр прошли тысячи идентификаторов, начинает считать заново,
 * вместо того чтобы расти до перезапуска. Лекционный зал (500) не приближается
 * к этой границе.
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
 * Проводил ли этот участник хост-токен — единственное, что переживает
 * перезапуск и не отбирается кукой. См. столбец token_host.
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
 * «Был здесь» пачкой — одной транзакцией на всех.
 *
 * Отметка ставится на каждом рукопожатии сокета, а сокетов у вкладки два, и
 * после перезапуска сервера или моргания ретранслятора пятьсот вкладок
 * возвращаются в одну секунду: тысяча отдельных UPDATE, каждый со своей
 * транзакцией и своим fsync по журналу. Точность отметки при этом никому не
 * нужна ближе нескольких секунд — её читает список людей, а не право доступа.
 *
 * Время — одно на всю пачку и приходит снаружи: это момент, когда люди пришли,
 * а не момент, когда до них дошла запись.
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
 * Правила комнаты в памяти.
 *
 * Кэш появился, когда правила встали на путь нажатия клавиши: классификатор
 * спрашивает их на каждый кадр синхронизации, а это чтение SQLite и
 * `JSON.parse` — двадцать печатающих дают полторы сотни таких в секунду за
 * ничто. Инвалидируется в `setRules` и при удалении семинара; больше правила
 * не меняет никто.
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
 * Запомнить правила комнаты по уже прочитанной строке.
 *
 * Зовёт это `identityOf`: строка `sessions` несёт и правила, и конец занятия,
 * так что читать её второй раз ради `roomOf` — платить дважды за одно и то же.
 * Разбор здесь один и тот же, `readRules`, поэтому разойтись двум путям негде.
 */
function rememberRoom(sessionId: string, rules: string | null, finishedAt: number | null): void {
  rulesCache.set(sessionId, { rules: readRules(rules), finishedAt })
}

/**
 * Правила, по которым комната живёт СЕЙЧАС.
 *
 * Отсюда их берут все проверки прав, и поэтому конец занятия наложен здесь, в
 * одном месте: правило, которое кто-нибудь начнёт спрашивать завтра, приедет
 * ужесточённым само, без строчки «а ещё проверь, не кончилось ли занятие» —
 * той самой строчки, которую забывают.
 */
export function getRules(sessionId: string): RoomRules {
  const room = roomOf(sessionId)
  return room.finishedAt === null ? room.rules : rulesAfterClass(room.rules)
}

/**
 * Правила, которые преподаватель ВЫБРАЛ.
 *
 * Их показывают в настройках и на них накладывают патч. Спрашивать здесь
 * действующие было бы потерей настройки: PATCH накладывает изменение на
 * текущее, так что одно нажатие посреди законченного занятия записало бы
 * ужесточение в базу навсегда, и открывать занятие было бы уже не во что.
 */
export function storedRules(sessionId: string): RoomRules {
  return roomOf(sessionId).rules
}

/** Когда занятие закончили, или null, пока оно идёт. */
export function finishedAt(sessionId: string): number | null {
  return roomOf(sessionId).finishedAt
}

/** Закончено ли занятие в этой комнате. */
export function isFinished(sessionId: string): boolean {
  return roomOf(sessionId).finishedAt !== null
}

/**
 * Закончить занятие или открыть его снова.
 *
 * Пишет и время, и кэш: правила спрашиваются на каждый кадр синхронизации, и
 * забытый сброс кэша означал бы, что конец занятия вступает в силу после
 * перезапуска сервера.
 */
export function setFinished(sessionId: string, at: number | null): void {
  updateFinished.run(at, sessionId)
  rulesCache.set(sessionId, { rules: roomOf(sessionId).rules, finishedAt: at })
}

/**
 * Забыть правила комнаты: они изменились или комнаты больше нет.
 *
 * Зовут её из одного места — удаления семинара, — и там забыть надо не только
 * правила: кэш строки пережил бы комнату, и старый токен ещё сутки открывал бы
 * сокет в дверь, которой уже нет. Поэтому здесь `forgetRoom` целиком; новым
 * местам звать лучше сразу его.
 */
export function forgetRules(sessionId: string): void {
  forgetRoom(sessionId)
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
  /** Только у отката: версия, которую он вернул. */
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
 * Лента — это то, что кто-то сделал, и отбирать её надо здесь, а не после
 * LIMIT.
 *
 * `keyframe` и `quiet` — бухгалтерия повтора, и их в семинаре с работающими
 * ячейками больше, чем правок: каждые четыре килобайта вывода или девяносто
 * секунд дают тихую строку. Когда окно в четыреста строк резалось до фильтра,
 * они его и съедали — панель показывала горстку правок или «Nothing has been
 * written in this room yet» при сотне правок и чекпоинте «до упражнения» в
 * базе.
 */
const selectStory = db.prepare(`
  SELECT ${COLUMNS}
  FROM doc_history WHERE session_id = ? AND kind NOT IN ('keyframe', 'quiet')
  ORDER BY seq DESC LIMIT ?
`)

/*
 * Названные моменты — своим окном, а не в общей очереди с правками.
 *
 * Отсева служебных строк мало. Всплеск правок закрывается каждые четыре
 * килобайта обновлений, на любую смену состава тетради и по двенадцати
 * секундам тишины — комната на тридцать человек выдаёт их сотнями за пару, и
 * чекпоинт «до упражнения», поставленный на пятнадцатой минуте, из окна на
 * четыреста строк вылетал вместе с ними. Строка при этом жива в базе:
 * терялась ровно та функция, ради которой чекпоинт ставили. Тот же приём — у
 * шагов публикации (publish/candidates.ts).
 */
const selectNamed = db.prepare(`
  SELECT ${COLUMNS}
  FROM doc_history WHERE session_id = ? AND kind IN ('opened', 'checkpoint', 'restore')
  ORDER BY seq DESC LIMIT ?
`)

/** Свежие строки ленты плюс все названные моменты, новые сверху. */
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

/* ------------------------------------------------------- заметки лекции */

/*
 * Заметки спикера: что сказать на этой странице.
 *
 * В базе, а не в документе комнаты, и это не про удобство. Документ комнаты
 * синхронизируется ЦЕЛИКОМ каждому вошедшему — тетрадь, чат, всё, — и заметка
 * «здесь спросить, кто помнит формулу Байеса; если молчат, вывести на доске»
 * приехала бы всему классу вместе с первой страницей. Речь преподавателя себе
 * самому — единственное в этом продукте, что комнате видеть не полагается.
 *
 * И не в памяти процесса, в отличие от чернил: чернила живут час, а заметки
 * пишут накануне вечером. Перезапуск сервера обязан их пережить.
 *
 * Ключ — семинар, файл и страница: заметки привязаны к странице документа, а не
 * к лекции, поэтому переживают и её конец, и вторую лекцию по тому же файлу
 * через неделю.
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
 * `OR REPLACE`, а не голый UPDATE, и это разница между «переехало» и «пропало».
 *
 * Ключ здесь (комната, файл, страница), а заметки не удаляются при удалении
 * файла — намеренно: перезалить исправленный PDF под тем же именем накануне
 * пары обычнее, чем начать речь с нуля. Значит у пути легко остаётся хвост от
 * прошлого документа, и переезд на такой путь бьётся о занятый ключ. В SQLite
 * это откатывает ВЕСЬ оператор: не переезжает ни одна страница, а вызывающий
 * ловит исключение и молчит — вечер, потраченный на речь к двадцати четырём
 * страницам, остаётся под путём, которого на диске больше нет.
 *
 * REPLACE решает спор в пользу того, что переезжает: заметки к живому файлу
 * старше заметок к пути, с которого файл давно убрали. Обратный выбор — тихо
 * потерять свежую речь ради чужой прошлогодней.
 */
const moveNotes = db.prepare(
  'UPDATE OR REPLACE lecture_notes SET file = ? WHERE session_id = ? AND file = ?',
)

/** Все заметки к одному документу: страница → текст. */
export function notesOf(sessionId: string, file: string): Record<number, string> {
  const rows = selectNotes.all(sessionId, file) as { page: number; text: string }[]
  const out: Record<number, string> = {}
  for (const row of rows) out[row.page] = row.text
  return out
}

/** Пустая заметка — это её отсутствие, а не строка из пробелов. */
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
 * Файл переименовали — заметки переезжают за ним, вытесняя хвост на новом пути.
 *
 * Переезд «на себя» отдельным случаем: `WHERE file = to` и `SET file = to` —
 * это конфликт строки с самой собой, и REPLACE его не считает конфликтом, но
 * полагаться на такую тонкость в операторе, который умеет удалять, не стоит.
 */
export function moveNotesTo(sessionId: string, from: string, to: string): void {
  if (from === to) return
  moveNotes.run(to, sessionId, from)
}

/** Речь к одному документу — под нож (файл заменили целиком, не переименовали). */
export function discardNotesOf(sessionId: string, file: string): void {
  dropNotesFile.run(sessionId, file)
}

/** Семинар удалили — заметки уходят с ним. */
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
 * Сколько байт истории держится на один семинар.
 *
 * Раньше — сколько накопится: единственный DELETE во всём файле стоял в
 * `discardHistory`, то есть история росла до удаления семинара. Считать легко:
 * на оживлённой паре всплеск закрывается несколько раз в секунду, строка — это
 * килобайты дельты, а keyframe размером с тетрадь приходит всякий раз, когда
 * дельты догоняют её объём. Семестровая комната с тремя мегабайтами тетради
 * пишет сотни мегабайт в базу, лежащую на том же диске, что и файлы всех
 * комнат, и кончается он молча и сразу для всех.
 *
 * Шестьдесят четыре мегабайта — это два десятка полных снимков трёхмегабайтной
 * тетради с дельтами между ними, то есть вся пара и запас. Обычная комната
 * сюда не упирается вовсе.
 */
const HISTORY_MAX_BYTES = 64 * 1024 * 1024

const historyWeights = db.prepare(`
  SELECT seq, kind, LENGTH(update_blob) AS bytes
  FROM doc_history WHERE session_id = ? ORDER BY seq DESC
`)

const trimBefore = db.prepare(`DELETE FROM doc_history WHERE session_id = ? AND seq < ?`)

/**
 * Обрезать историю семинара сверху по возрасту, до потолка байтов.
 *
 * Режется ЦЕЛЫМИ отрезками — всё, что старше некоторого keyframe, — и это не
 * придирка к аккуратности. Повтор любой версии начинается с ближайшего
 * keyframe НЕ ПОЗЖЕ неё и накатывает все строки между ними (`updatesUpTo`), так
 * что выброшенная строка ломает возврат не себя, а всех, кто стоит за ней до
 * следующего снимка. Выбросить «тихие» строки старше последнего keyframe, как
 * просилось на первый взгляд, значило бы разорвать цепочку под каждой видимой
 * версией предыдущего отрезка: кнопка «Вернуть» осталась бы на месте и
 * записала бы поверх живой тетради не то, что обещала.
 *
 * Поэтому граница ставится ровно на keyframe: всё, что осталось, replay'ится
 * без единой недостающей строки, а то, что ушло, ушло целиком и из ленты тоже
 * — история семинара начинается позже, и это видно, а не подстроено.
 *
 * Последний отрезок не режется никогда, даже если он один больше потолка:
 * комнате нужна хотя бы одна точка, с которой вообще можно повторить
 * (`hasHistoryBase`).
 *
 * Возвращает, сколько строк убрано. Зовёт не база, а `collab/history.ts` сразу
 * после удачного keyframe — единственный момент, когда впереди гарантированно
 * есть целый снимок.
 */
export function trimHistory(sessionId: string, keepBytes = HISTORY_MAX_BYTES): number {
  const rows = historyWeights.all(sessionId) as { seq: number; kind: string; bytes: number }[]
  if (rows.length === 0) return 0
  let bytes = 0
  /** Самый старый снимок, до которого история ещё влезает в потолок. */
  let cut: number | null = null
  let over = false
  for (const row of rows) {
    bytes += row.bytes
    // Потолок мерится по всем строкам, а граница ставится только на снимке:
    // между двумя снимками может лежать сколько угодно дельт, и «упёрлись» они
    // тоже считают.
    if (bytes > keepBytes) over = true
    if (row.kind !== 'keyframe') continue
    if (!over) {
      cut = row.seq
      continue
    }
    // Дальше не влезает. Самый свежий снимок держится всегда, даже если он
    // один больше потолка: без него повторить нельзя вообще ничего.
    cut ??= row.seq
    break
  }
  // В потолок не упёрлись — значит и резать нечего: обрезка по возрасту тут не
  // цель, а плата за место. Так же и когда снимка нет вовсе или он и есть самая
  // старая строка.
  if (!over || cut === null || cut <= rows[rows.length - 1].seq) return 0
  return trimBefore.run(sessionId, cut).changes
}

const oldestVersion = db.prepare(
  `SELECT kind FROM doc_history WHERE session_id = ? ORDER BY seq ASC LIMIT 1`,
)

/**
 * Начинается ли лента позже, чем началась комната.
 *
 * `trimHistory` выше режет начало целыми отрезками, и панель истории без этого
 * признака показывает остаток так, будто ранних правок и не было: список
 * просто начинается с середины пары, и по нему нельзя отличить «тут ничего не
 * писали» от «до этого места не сохранилось».
 *
 * Меряется состоянием, а не памятью о событии: обрезка ставит границу ровно на
 * keyframe, а самой первой строкой комнаты всегда пишется `opened`
 * (collab/history.ts · beginHistory), и второй раз она не появится — после
 * обрезки `hasHistoryBase` уже истинно из-за оставшегося снимка. Значит «самая
 * старая строка не `opened`» и есть «начало не сохранилось», причём ответ
 * переживает перезапуск сервера и не требует лишнего столбца.
 *
 * Пустая история — не обрезанная: комнате, где ещё ничего не записано, панель
 * говорит своими словами.
 */
export function historyTrimmed(sessionId: string): boolean {
  const row = oldestVersion.get(sessionId) as { kind: string } | undefined
  return row !== undefined && row.kind !== 'opened'
}
