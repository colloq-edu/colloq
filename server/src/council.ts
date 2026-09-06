/**
 * Консилиум: попытки студентов по ячейке × человеку — хранение и снимки.
 *
 * Попытки НЕ живут в общей тетради (CRDT): пятьсот человек в одном Y.Text — шум,
 * и, что важнее, чужую попытку студент не должен видеть никогда. Поэтому текст
 * приезжает снимком по управляющему сокету (control.ts · council:draft),
 * ложится сюда — в SQLite, чтобы пережить перезапуск сервера, — и отсюда
 * собираются два взгляда: `mineFor` автору и `boardFor` преподавателю.
 *
 * Здесь только хранение и сборка снимков. Право («кто может») спрашивает
 * control.ts по shared/rules.ts (mayWriteCouncil/mayRunCouncil/mayLeadCouncil);
 * рассылка по сокетам — тоже его. Запуск попытки в ядре — kernel/ через
 * control.ts, вывод возвращается сюда `recordRun`. Оракул о решениях — ai/,
 * состояние хранится здесь `setOracle`.
 *
 * Таблица council_attempts (session_id, cell_id, participant_id, text,
 * submitted_at, updated_at, run_json, reply_json, correct, shown) с ключом
 * (session_id, cell_id, participant_id); council_oracle (session_id, cell_id,
 * oracle_json). Схему заводит `ensureCouncilSchema` при импорте модуля —
 * как lecture_notes в db.ts, только рядом с запросами к ней.
 *
 * Кэш в памяти — на комнату целиком, с записью насквозь: снимок приходит на
 * каждую паузу в наборе от каждого из пятисот, и на каждый из них хосту
 * собирается вся стопка. Читать её из SQLite пятьсот раз в секунду — это
 * JSON.parse пятисот строк на каждый кадр; читать из карты — ничего. База при
 * этом — правда: перезапуск читает её заново (`resetCouncilCache` в тесте
 * делает то же руками).
 */
import type {
  CouncilAttempt,
  CouncilBoard,
  CouncilGroup,
  CouncilMine,
  CouncilOracle,
  CouncilReply,
  CouncilRun,
  CouncilStatus,
} from '@shared/protocol'
import { groupStatus } from '@shared/protocol'
import { normalizeAttempt } from '@shared/notebook'
import { db, getParticipant } from './db.js'

export { normalizeAttempt }

/** Строка таблицы — то, из чего собираются `CouncilMine` и `CouncilAttempt`. */
export interface StoredAttempt {
  sessionId: string
  cellId: string
  participantId: string
  text: string
  submittedAt: number | null
  updatedAt: number
  run: CouncilRun | null
  reply: CouncilReply | null
  correct: boolean | null
  shown: boolean
}

/** CREATE TABLE IF NOT EXISTS — идемпотентно, при старте. */
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
      reply_json     TEXT,
      correct        INTEGER,
      shown          INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, cell_id, participant_id)
    );
    /* Бан спрашивает «всё этого человека в комнате» — по всем ячейкам сразу. */
    CREATE INDEX IF NOT EXISTS council_attempts_person
      ON council_attempts(session_id, participant_id);

    CREATE TABLE IF NOT EXISTS council_oracle (
      session_id  TEXT NOT NULL,
      cell_id     TEXT NOT NULL,
      oracle_json TEXT NOT NULL,
      PRIMARY KEY (session_id, cell_id)
    );
  `)
}

ensureCouncilSchema()

/* ----------------------------------------------------------------- база */

interface AttemptRow {
  session_id: string
  cell_id: string
  participant_id: string
  text: string
  submitted_at: number | null
  updated_at: number
  run_json: string | null
  reply_json: string | null
  correct: number | null
  shown: number
}

const selectRoom = db.prepare('SELECT * FROM council_attempts WHERE session_id = ?')
const upsertAttempt = db.prepare(`
  INSERT INTO council_attempts
    (session_id, cell_id, participant_id, text, submitted_at, updated_at,
     run_json, reply_json, correct, shown)
  VALUES (@session_id, @cell_id, @participant_id, @text, @submitted_at, @updated_at,
          @run_json, @reply_json, @correct, @shown)
  ON CONFLICT(session_id, cell_id, participant_id) DO UPDATE SET
    text = excluded.text,
    submitted_at = excluded.submitted_at,
    updated_at = excluded.updated_at,
    run_json = excluded.run_json,
    reply_json = excluded.reply_json,
    correct = excluded.correct,
    shown = excluded.shown
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

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Запуск, который пережил перезапуск сервера, — призрак.
 *
 * Очередь ядра живёт в памяти процесса (см. kernel/index.ts), и «в очереди» из
 * прошлой жизни означает, что запуска не будет: попытка возвращается к «не
 * запускали». «Считается» — хуже: процесс, в котором она шла, ушёл вместе с
 * выводом, и честнее сказать это на карточке, чем показывать секундомер,
 * который никогда не остановится.
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
          evalue: 'Сервер перезапустился, пока попытка считалась; вывод не доехал.',
          traceback: [],
        },
      ],
    }
  }
  return run
}

/**
 * Оракул, который «читает» после перезапуска сервера, — тот же призрак.
 *
 * Запрос к модели жил в памяти процесса (ai/council.ts · reading) и ушёл вместе
 * с ним: ответа не будет, `settle` не позовут, а состояние в базе так и
 * осталось бы «читает» — спиннер до конца пары, «Стоп», которому нечего
 * останавливать, и ни одной кнопки спросить заново. Прежняя сводка, если была,
 * возвращается готовой с причиной рядом; не было — пустое место с той же
 * причиной, и кнопка «Спросить» на месте.
 */
const ORACLE_RESTARTED = 'Сервер перезапустился, пока оракул читал, — спросите ещё раз.'

function settleGhostOracle(oracle: CouncilOracle): CouncilOracle {
  if (oracle.state !== 'reading') return oracle
  return oracle.summary.length > 0
    ? { ...oracle, state: 'ready', error: ORACLE_RESTARTED }
    : { ...oracle, state: 'idle', askedAt: null, basedOn: 0, staleBy: 0, error: ORACLE_RESTARTED }
}

function fromRow(row: AttemptRow): StoredAttempt {
  return {
    sessionId: row.session_id,
    cellId: row.cell_id,
    participantId: row.participant_id,
    text: row.text,
    submittedAt: row.submitted_at ?? null,
    updatedAt: row.updated_at,
    run: settleGhostRun(parseJson<CouncilRun>(row.run_json)),
    reply: parseJson<CouncilReply>(row.reply_json),
    correct: row.correct === null ? null : row.correct === 1,
    shown: row.shown === 1,
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
    reply_json: attempt.reply ? JSON.stringify(attempt.reply) : null,
    correct: attempt.correct === null ? null : attempt.correct ? 1 : 0,
    shown: attempt.shown ? 1 : 0,
  })
}

/* ------------------------------------------------------------------ кэш */

/** Комната → ячейка → человек. */
type CellMap = Map<string, StoredAttempt>
interface RoomCache {
  cells: Map<string, CellMap>
  oracles: Map<string, CouncilOracle>
}

const cache = new Map<string, RoomCache>()

function roomOf(sessionId: string): RoomCache {
  const cached = cache.get(sessionId)
  if (cached) return cached
  const room: RoomCache = { cells: new Map(), oracles: new Map() }
  for (const row of selectRoom.all(sessionId) as AttemptRow[]) {
    const attempt = fromRow(row)
    cellOf(room, attempt.cellId).set(attempt.participantId, attempt)
  }
  for (const row of selectOracles.all(sessionId) as { cell_id: string; oracle_json: string }[]) {
    const oracle = parseJson<CouncilOracle>(row.oracle_json)
    if (oracle) room.oracles.set(row.cell_id, settleGhostOracle(oracle))
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
 * Забыть кэш — комнаты или всех.
 *
 * В работе это не нужно: кэш пишется насквозь. Нужно тесту, который проверяет,
 * что попытки переживают перезапуск: он и есть перезапуск без процесса.
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

/* ------------------------------------------------------------- свой лист */

/**
 * Снимок текста при паузе в наборе. Заводит попытку, если её не было; «сдано»
 * не снимает (для этого `withdrawAttempt`). Возвращает строку после записи.
 *
 * Со сменой текста уходит всё, что было сказано о ПРЕЖНЕМ тексте: вывод
 * запуска, отметка «верно» и «на экране». Они приклеены к тексту, а не к
 * человеку: «На экране · преподаватель показал ваш вариант» над кодом,
 * которого в общей ячейке нет, и зелёное «верно» над непроверенным — ложь на
 * обоих экранах. Ответ преподавателя остаётся — это письмо человеку, и оно
 * не устаревает от правки.
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
  return save({
    sessionId,
    cellId,
    participantId,
    text,
    submittedAt: prior?.submittedAt ?? null,
    updatedAt: now,
    run: null,
    reply: prior?.reply ?? null,
    correct: null,
    shown: false,
  })
}

/** «Сдать»: ставит submittedAt. `null` — попытки нет (нечего сдавать). */
export function submitAttempt(
  sessionId: string,
  cellId: string,
  participantId: string,
  now: number,
): StoredAttempt | null {
  const prior = attemptOf(sessionId, cellId, participantId)
  if (!prior) return null
  // Второе нажатие — не новое время: «сдала 14:32» не переезжает на 14:40.
  if (prior.submittedAt !== null) return prior
  return save({ ...prior, submittedAt: now })
}

/** «Изменить»: снимает submittedAt, текст остаётся. */
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

/** Ячейки комнаты, у которых есть попытки, — для приветственной пачки хоста. */
export function cellsWithAttempts(sessionId: string): string[] {
  const out: string[] = []
  for (const [cellId, cell] of roomOf(sessionId).cells) if (cell.size > 0) out.push(cellId)
  return out
}

/** Ячейки, где у этого человека есть попытка, — для его приветственной пачки. */
export function cellsOfParticipant(sessionId: string, participantId: string): string[] {
  const out: string[] = []
  for (const [cellId, cell] of roomOf(sessionId).cells)
    if (cell.has(participantId)) out.push(cellId)
  return out
}

/* ------------------------------------------------------ действия ведущего */

/** Вывод запуска — к попытке, не в общую ячейку. `null` — стереть. */
export function recordRun(
  sessionId: string,
  cellId: string,
  participantId: string,
  run: CouncilRun | null,
): void {
  const prior = attemptOf(sessionId, cellId, participantId)
  // Попытку успели убрать (бан) — вывод её не воскрешает.
  if (!prior) return
  save({ ...prior, run })
}

/**
 * Ответ автору или всей группе (все сданные попытки с этим ключом группы).
 * Возвращает participantId адресатов — им control.ts шлёт `council:mine`.
 */
export function setReply(
  sessionId: string,
  cellId: string,
  to: { participantId: string } | { groupKey: string },
  reply: CouncilReply,
): string[] {
  const targets: StoredAttempt[] = []
  if ('participantId' in to) {
    const one = attemptOf(sessionId, cellId, to.participantId)
    if (one) targets.push(one)
  } else {
    for (const attempt of attemptsOf(sessionId, cellId)) {
      if (attempt.submittedAt !== null && normalizeAttempt(attempt.text) === to.groupKey) {
        targets.push(attempt)
      }
    }
  }
  for (const attempt of targets) save({ ...attempt, reply })
  return targets.map((attempt) => attempt.participantId)
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
 * «Показать классу» уже положил текст в общую ячейку; здесь — отметка на попытке.
 *
 * На экране один вариант: отметка снимается с того, кого показывали до этого.
 * Возвращает, у кого она сменилась (включая нового), — им нужен `council:mine`.
 */
export function setShown(sessionId: string, cellId: string, participantId: string): string[] {
  const changed: string[] = []
  for (const attempt of attemptsOf(sessionId, cellId)) {
    const shown = attempt.participantId === participantId
    if (attempt.shown === shown) continue
    save({ ...attempt, shown })
    changed.push(attempt.participantId)
  }
  return changed
}

/* ------------------------------------------------------------ бан и снос */

/**
 * Убрать всё этого человека — из всех ячеек консилиума комнаты.
 * Вызывается из routes/bans.ts рядом с purgeQuestions. Возвращает, сколько убрали.
 */
export function purgeAttempts(sessionId: string, participantId: string): number {
  const room = roomOf(sessionId)
  let gone = 0
  for (const cell of room.cells.values()) if (cell.delete(participantId)) gone++
  deleteOfPerson.run(sessionId, participantId)
  return gone
}

/** Комнату снесли — вместе с попытками и сводками оракула. */
export function discardCouncil(sessionId: string): void {
  cache.delete(sessionId)
  deleteOfRoom.run(sessionId)
  deleteOraclesOfRoom.run(sessionId)
}

/* -------------------------------------------------------------- снимки */

/**
 * Состояние одним словом. Отметка преподавателя сильнее запуска: решение о
 * верности — его, а не ядра (protocol.ts · CouncilStatus).
 */
function statusOf(attempt: StoredAttempt): CouncilStatus {
  if (attempt.correct === true) return 'correct'
  if (attempt.correct === false) return 'wrong'
  if (attempt.run?.state === 'error') return 'failed'
  if (attempt.run?.state === 'ok') return 'ran'
  return 'unrun'
}

/**
 * Что видит автор. `closed` — консилиум на ячейке сейчас не идёт
 * (`cellLock(cell) !== 'council'`); ячейку читает control.ts, не этот модуль.
 * `null` — попытки нет и консилиум закрыт: сказать нечего.
 *
 * `queue` — место в очереди на запуск, если попытка ждёт; его знает ядро, и
 * control.ts передаёт его сюда, чтобы снимок собирался в одном месте.
 */
export function mineFor(
  sessionId: string,
  cellId: string,
  participantId: string,
  closed: boolean,
  queue: number | null = null,
): CouncilMine | null {
  const attempt = attemptOf(sessionId, cellId, participantId)
  if (!attempt) {
    if (closed) return null
    // Консилиум открыт, а попытки ещё нет: пустой лист, чтобы клиент знал,
    // что писать можно, и ничего не показывал как «сдано».
    return {
      text: '',
      submittedAt: null,
      updatedAt: 0,
      shown: false,
      correct: null,
      reply: null,
      run: null,
      queue: null,
      closed,
    }
  }
  return {
    text: attempt.text,
    submittedAt: attempt.submittedAt,
    updatedAt: attempt.updatedAt,
    shown: attempt.shown,
    correct: attempt.correct,
    reply: attempt.reply,
    run: attempt.run,
    queue,
    closed,
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
    /* строки участника нет — карточка без имени лучше, чем без карточки */
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
    reply: attempt.reply,
    correct: attempt.correct,
    shown: attempt.shown,
    groupKey: normalizeAttempt(attempt.text),
  }
}

/**
 * Группы одинаковых решений — только среди сданных, тем же ключом, что стоит на
 * попытке. Представитель — самый ранний сдавший; состояние и «на экране» — по
 * всем членам (protocol.ts · groupStatus); порядок групп — от большой к малой,
 * при равенстве раньше та, что раньше сдана.
 */
function bySubmission(a: CouncilAttempt, b: CouncilAttempt): number {
  return (
    (a.submittedAt ?? 0) - (b.submittedAt ?? 0) ||
    a.updatedAt - b.updatedAt ||
    a.participantId.localeCompare(b.participantId)
  )
}

function groupsOf(attempts: CouncilAttempt[], labels: Record<string, string>): CouncilGroup[] {
  const byKey = new Map<string, CouncilAttempt[]>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) continue
    const list = byKey.get(attempt.groupKey)
    if (list) list.push(attempt)
    else byKey.set(attempt.groupKey, [attempt])
  }
  const groups: CouncilGroup[] = []
  for (const [key, members] of byKey) {
    // При равном времени сдачи — кто раньше написал, потом по id: тем же
    // разрывом, что на пульте (council-board.ts · bySubmission), иначе у одной
    // группы на сервере и на клиенте были бы два разных представителя.
    members.sort(bySubmission)
    const representative = members[0]
    groups.push({
      key,
      count: members.length,
      label: labels[key] ?? null,
      sample: representative.text,
      status: groupStatus(members.map((m) => m.status)),
      shown: members.some((m) => m.shown),
      representative: representative.participantId,
      members: members.map((m) => m.participantId),
    })
  }
  groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    const at = (g: CouncilGroup) =>
      attempts.find((x) => x.participantId === g.representative)?.submittedAt ?? 0
    return at(a) - at(b)
  })
  return groups
}

/** Одна попытка глазами преподавателя — для `council:patch`. `null` — её больше нет. */
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

/** Числа полосы режима без самой стопки — то, что едет с каждым `council:patch`. */
export function countsFor(sessionId: string, cellId: string): CouncilBoard['counts'] {
  const attempts = attemptsOf(sessionId, cellId).map(toAttempt)
  return countsOf(attempts, groupsOf(attempts, {}).length)
}

/**
 * Стопка целиком для преподавателя. Имена, цвета и аватары — из participants
 * (db.ts · getParticipant); группы — по `normalizeAttempt` только среди сданных;
 * `lock` и `settings` control.ts даёт снаружи, потому что читает ячейку он.
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
  const groups = groupsOf(attempts, oracle?.groupLabels ?? {})
  return {
    lock: cell.lock,
    settings: cell.settings,
    counts: countsOf(attempts, groups.length),
    attempts,
    groups,
    oracle,
  }
}

/** «N сдали из M» — для `council:count` всей комнате. */
export function countFor(sessionId: string, cellId: string): { submitted: number; total: number } {
  const attempts = attemptsOf(sessionId, cellId)
  return {
    submitted: attempts.filter((a) => a.submittedAt !== null).length,
    total: attempts.length,
  }
}

/* ------------------------------------------------------------- оракул */

export function oracleOf(sessionId: string, cellId: string): CouncilOracle | null {
  return roomOf(sessionId).oracles.get(cellId) ?? null
}

export function setOracle(sessionId: string, cellId: string, oracle: CouncilOracle): void {
  roomOf(sessionId).oracles.set(cellId, oracle)
  upsertOracle.run(sessionId, cellId, JSON.stringify(oracle))
}
