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
import { attemptStatus, groupAttempts } from '@shared/protocol'
import { normalizeAttempt } from '@shared/notebook'
import { stopRoomOracles } from './ai/council.js'
import { db, getParticipant, getSession } from './db.js'

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
  /**
   * Письма преподавателя: личное и групповое — рядом, а не одно поверх другого.
   *
   * Их не больше двух (`keeping`), в порядке отправки. Одно поле на двоих было
   * молчаливой потерей: рассылка группе ложилась поверх личного ответа, и
   * вернуть его нечем — истории версий у попыток нет.
   */
  replies: CouncilReply[]
  correct: boolean | null
  shown: boolean
  /**
   * Ключ группы — `normalizeAttempt(text)`, посчитанный ОДИН РАЗ на смену текста.
   *
   * В столбце его нет и не надо: он выводится из текста, и хранить выведенное
   * значит однажды разойтись с ним. А вот считать его заново на каждый кадр —
   * дорого: числа полосы едут хосту на каждую паузу в наборе у каждого из
   * пятисот, и `normalizeAttempt` — посимвольный цикл по всей попытке. Пятьсот
   * попыток по восемь килобайт трижды в секунду — четыре мегабайта обхода в
   * секунду ради двух чисел.
   */
  groupKey: string
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
      /* Письма преподавателя списком — личное и групповое (см. repliesFrom). */
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

    /*
     * Задание — общий текст ячейки на ту секунду, когда замок перевели в
     * консилиум. Отдельной строкой, потому что в самой ячейке его к тому
     * времени может уже не быть: «Показать классу» кладёт в общий текст чьё-то
     * решение, и опоздавший засевал бы им свой лист (shared/protocol.ts ·
     * CouncilMine.seed).
     */
    CREATE TABLE IF NOT EXISTS council_seed (
      session_id TEXT NOT NULL,
      cell_id    TEXT NOT NULL,
      seed       TEXT NOT NULL,
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
          evalue: 'Сервер перезапустился во время выполнения попытки. Вывод недоступен.',
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
const ORACLE_RESTARTED = 'Сервер перезапустился во время подготовки сводки. Повторите запрос.'

function settleGhostOracle(oracle: CouncilOracle): CouncilOracle {
  if (oracle.state !== 'reading') return oracle
  return oracle.summary.length > 0
    ? { ...oracle, state: 'ready', error: ORACLE_RESTARTED }
    : { ...oracle, state: 'idle', askedAt: null, basedOn: 0, error: ORACLE_RESTARTED }
}

/**
 * Письма из `reply_json` — списком, каким бы ни была строка.
 *
 * В столбце лежит либо список (пишем так), либо одно письмо объектом — так
 * писали, пока поле на попытке было одно. Отдельного столбца под список не
 * завели нарочно: ALTER TABLE ради того же самого значения дал бы две колонки
 * про одно письмо, и однажды они разошлись бы. Пустые письма выкидываются:
 * строка без текста рисуется подписью в пустоте.
 */
function repliesFrom(raw: string | null): CouncilReply[] {
  const parsed = parseJson<CouncilReply | CouncilReply[]>(raw)
  if (!parsed) return []
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter((one) => typeof one?.text === 'string' && one.text.trim() !== '')
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
    replies: repliesFrom(row.reply_json),
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
    // Список, а не одно письмо: см. `repliesFrom`. Пусто — `null`, как и было.
    reply_json: attempt.replies.length > 0 ? JSON.stringify(attempt.replies) : null,
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
  /** Ячейка → задание, с которого сеется пустой лист. */
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
    if (oracle) room.oracles.set(row.cell_id, settleGhostOracle(oracle))
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
  // Текст сменился — значит, запуск, который сейчас идёт или ждёт в очереди,
  // считает уже НЕ ЭТО. Его будущие кадры сюда не лягут (см. recordRun).
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
    replies: prior?.replies ?? [],
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

/**
 * Под каким текстом завели запуск, который сейчас в полёте.
 *
 * Ключ — комната, ячейка, человек; значение — текст попытки на момент нажатия
 * «Запустить». В памяти, а не в базе, и этого достаточно: очередь ядра тоже
 * живёт в памяти процесса, и запуск, переживший перезапуск, всё равно призрак
 * (`settleGhostRun`).
 */
const runFor = new Map<string, string>()

function runKey(sessionId: string, cellId: string, participantId: string): string {
  return `${sessionId}\u0000${cellId}\u0000${participantId}`
}

/**
 * Вывод запуска — к попытке, не в общую ячейку. `null` — стереть.
 *
 * Возвращает, лёг ли кадр. `false` — попытки уже нет ИЛИ кадр опоздал: пока он
 * считался, автор сменил текст, и вывод относится к прежнему.
 *
 * Про опоздавший кадр стоит сказать отдельно, потому что цена у него высокая.
 * Очередь на пятьсот человек одна, ждать минуту — обычное дело, и правка за
 * это время тоже обычна. `saveDraft` честно снимает с попытки всё, что было
 * сказано о ПРЕЖНЕМ тексте, — но ядро дочитывало старый исходник и клало его
 * трейсбек под новый код: на карточке студента и в стопке преподавателя стоял
 * вывод программы, которой на них нет, со статусом «упало» или «выполнена».
 * Преподаватель ставил «верно» по чужому выводу.
 *
 * Отпечаток — сам текст, а не хеш: попытка и так лежит рядом в памяти, а хеш
 * добавил бы к сверке ещё один способ ошибиться.
 */
export function recordRun(
  sessionId: string,
  cellId: string,
  participantId: string,
  run: CouncilRun | null,
): boolean {
  const prior = attemptOf(sessionId, cellId, participantId)
  // Попытку успели убрать (бан) — вывод её не воскрешает.
  if (!prior) return false
  const key = runKey(sessionId, cellId, participantId)
  if (run === null) {
    runFor.delete(key)
    save({ ...prior, run: null })
    return true
  }
  /*
   * Первый кадр запуска — «в очереди»: он и есть заявка, и текст под ним тот,
   * что был при нажатии. Всё остальное — кадры того же запуска, и они годятся,
   * только пока текст не сменился.
   */
  if (run.state === 'queued') {
    runFor.set(key, prior.text)
    save({ ...prior, run })
    return true
  }
  if (runFor.get(key) !== prior.text) return false
  save({ ...prior, run })
  return true
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
  const personal = 'participantId' in to
  if (personal) {
    const one = attemptOf(sessionId, cellId, to.participantId)
    if (one) targets.push(one)
  } else {
    for (const attempt of attemptsOf(sessionId, cellId)) {
      if (attempt.submittedAt !== null && attempt.groupKey === to.groupKey) targets.push(attempt)
    }
  }
  const addressed: CouncilReply = { ...reply, to: personal ? 'person' : 'group' }
  for (const attempt of targets) save({ ...attempt, replies: keeping(attempt.replies, addressed) })
  return targets.map((attempt) => attempt.participantId)
}

/** Личное или групповое — по этому письма и различаются в хранении. */
function kindOf(reply: CouncilReply): 'person' | 'group' {
  // Письмо, записанное до появления `to`, считается личным: сберечь лишнее
  // дешевле, чем потерять нужное.
  return reply.to === 'group' ? 'group' : 'person'
}

/**
 * Новое письмо ложится в СВОЁ место: личное к личному, групповое к групповому.
 *
 * Поле `reply` на попытке было одно, и запись поверх была молчаливой потерей:
 * ответил Пете «Проверьте знак», через минуту отправил всей группе черновик
 * оракула — и личная строка исчезла, прочитал он её или нет. Ни на пульте, ни у
 * студента её больше нет, и вернуть нечем: у попыток истории версий не бывает.
 *
 * Склейка текстов эту дыру не закрывала: следующее же письмо той же группе
 * ложилось поверх склейки и уносило личное вместе с ней — а поправка вслед
 * рассылке дело обычное. Поэтому писем два, каждое в своей ячейке: замена
 * переписывает только однородное — личное поверх личного значит, что
 * преподаватель переписал своё же письмо одному человеку, групповое поверх
 * группового — что он переписал рассылку. Больше двух здесь не бывает, и
 * порядок — по отправке: так их и читают.
 */
function keeping(prior: readonly CouncilReply[], next: CouncilReply): CouncilReply[] {
  const kind = kindOf(next)
  return [...prior.filter((one) => kindOf(one) !== kind), next]
}

/**
 * Письма одной строкой — для клиентов, которые про `replies` ещё не знают.
 *
 * Подпись и время — у последнего письма: оно и есть то, что преподаватель
 * сказал только что. Тексты идут в порядке отправки, пустой строкой между: в
 * одном абзаце это хуже двух строк, но лучше, чем потерянный личный ответ.
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
  for (const [cellId, cell] of room.cells) {
    if (cell.delete(participantId)) gone++
    // Строки нет — значит, и кадру запуска ложиться некуда: отпечаток можно
    // забыть вместе с ней. Саму запись в очереди ядра снимает control.ts.
    runFor.delete(runKey(sessionId, cellId, participantId))
  }
  deleteOfPerson.run(sessionId, participantId)
  return gone
}

/** Комнату снесли — вместе с попытками и сводками оракула. */
export function discardCouncil(sessionId: string): void {
  /*
   * Идущее чтение обрывается ЗДЕСЬ, а не оставляется дочитывать.
   *
   * Оракул сводки живёт в памяти (ai/council.ts · reading), и ответ на вопрос,
   * заданный за минуту до сноса семинара, приходил в `setOracle` — тот заводил
   * кэш комнаты заново и делал INSERT в `council_oracle` для сессии, которой
   * больше нет. Строка удалённого семинара воскресала из ниоткуда и лежала до
   * следующего сноса.
   */
  stopRoomOracles(sessionId)
  cache.delete(sessionId)
  const prefix = `${sessionId}\u0000`
  for (const key of runFor.keys()) if (key.startsWith(prefix)) runFor.delete(key)
  deleteOfRoom.run(sessionId)
  deleteOraclesOfRoom.run(sessionId)
  deleteSeedsOfRoom.run(sessionId)
}

/* -------------------------------------------------------------- снимки */

/**
 * Состояние одним словом — общей функцией на пульт, сервер и оракула
 * (protocol.ts · attemptStatus). Здесь стояла своя копия того же правила.
 */
function statusOf(attempt: StoredAttempt): CouncilStatus {
  return attemptStatus(attempt)
}

/**
 * Что видит автор. `closed` — консилиум на ячейке сейчас не идёт
 * (`cellLock(cell) !== 'council'`); ячейку читает control.ts, не этот модуль.
 * `null` — попытки нет и консилиум закрыт: сказать нечего.
 *
 * `queue` — место в очереди на запуск, если попытка ждёт; его знает ядро, и
 * control.ts передаёт его сюда, чтобы снимок собирался в одном месте.
 *
 * `seed` — задание (`rememberSeed`), и едет оно в ОБЕИХ ветках. В первой ради
 * него всё и написано: пустой лист засевается заданием, а не тем, что в ячейке
 * лежит сейчас. Во второй — на случай, когда лист у человека ещё не заведён, а
 * попытка уже есть (перезагрузил страницу, вошёл со второго устройства). Нет
 * строки задания — поля нет вовсе: пустая строка значит «консилиум открыли на
 * пустой ячейке», а отсутствие — «старый сервер», и клиент сеет по-старому.
 */
export function mineFor(
  sessionId: string,
  cellId: string,
  participantId: string,
  closed: boolean,
  queue: number | null = null,
): CouncilMine | null {
  const attempt = attemptOf(sessionId, cellId, participantId)
  const seed = seedOf(sessionId, cellId)
  const task = seed === null ? {} : { seed }
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
      replies: [],
      run: null,
      queue: null,
      closed,
      ...task,
    }
  }
  return {
    text: attempt.text,
    submittedAt: attempt.submittedAt,
    updatedAt: attempt.updatedAt,
    shown: attempt.shown,
    correct: attempt.correct,
    // Оба вида рядом: склейка старым клиентам, письма по отдельности — новым.
    reply: mergeReplies(attempt.replies),
    replies: attempt.replies,
    run: attempt.run,
    queue,
    closed,
    ...task,
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
    reply: mergeReplies(attempt.replies),
    replies: attempt.replies,
    correct: attempt.correct,
    shown: attempt.shown,
    groupKey: attempt.groupKey,
  }
}

/**
 * Группы одинаковых решений — общей функцией (protocol.ts · groupAttempts).
 *
 * Здесь лежала третья её копия: своя ничья, свой порядок и `attempts.find`
 * внутри компаратора. Пульт и оракул считали то же самое чуть иначе, и однажды
 * это дало бы им разных представителей одной группы.
 */
function groupsOf(attempts: CouncilAttempt[], labels: Record<string, string>): CouncilGroup[] {
  return groupAttempts(attempts, labels)
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

/**
 * Числа полосы режима без самой стопки — то, что едет с каждым `council:patch`.
 *
 * Считаются по строкам, а не по собранной стопке. Прежний код звал `toAttempt`
 * на каждую попытку — то есть SELECT участника в SQLite и посимвольную
 * нормализацию всего текста, — потом складывал группы с сортировкой; и всё это
 * трижды в секунду на ячейку, пока класс печатает, ради четырёх чисел, в
 * которых нет ни имён, ни цветов. На пятистах попытках это полторы тысячи
 * запросов и мегабайты обхода в секунду в том же цикле событий, что и кадры
 * синхронизации.
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
  /*
   * Второй замок на ту же дверь, что и `stopRoomOracles` в `discardCouncil`.
   *
   * Обрыв чтения — про то, чтобы ответа не было; это — про то, что даже
   * пришедший ответ не заводит комнату заново. Между двумя действиями всегда
   * остаётся щель в один тик, а `roomOf` создаёт кэш комнаты по одному
   * упоминанию имени. Семинара нет — писать некуда, и это не ошибка: просто
   * ответ опоздал.
   */
  if (!getSession(sessionId)) return
  roomOf(sessionId).oracles.set(cellId, oracle)
  upsertOracle.run(sessionId, cellId, JSON.stringify(oracle))
}

/* ------------------------------------------------------------- задание */

/**
 * Задание ячейки — общий текст на ту секунду, когда замок перевели в консилиум.
 *
 * Зовётся из control.ts (`cell:lock`) РОВНО на переходе в консилиум, а не на
 * каждом нажатии: повторный `cell:lock` в то же положение — это переключение
 * ручки, и переписывать задание им нельзя. После «Показать классу» общий текст
 * ячейки — уже чьё-то решение, и записанное поверх «задание» стало бы им же;
 * опоздавший получал бы в свой лист чужой ответ и одним нажатием сдавал его
 * как свой (shared/protocol.ts · CouncilMine.seed).
 *
 * Пустая строка — законное значение: консилиум открыли на пустой ячейке, и
 * лист у всех пустой.
 */
export function rememberSeed(sessionId: string, cellId: string, text: string): void {
  roomOf(sessionId).seeds.set(cellId, text)
  upsertSeed.run(sessionId, cellId, text)
}

/** Задание ячейки, или `null` — консилиум открывали до того, как их стали помнить. */
export function seedOf(sessionId: string, cellId: string): string | null {
  return roomOf(sessionId).seeds.get(cellId) ?? null
}
