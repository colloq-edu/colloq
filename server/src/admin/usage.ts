/**
 * What the room actually asked the oracle.
 *
 * One row per accepted question, counted on our own server rather than read
 * back from the provider: the provider knows what an API key spent, this knows
 * what a seminar did — and it is also what the per-student rate limit is
 * enforced against, which has to be true even for an endpoint that reports no
 * usage at all (every local runtime).
 *
 * Deliberately not stored: the question text. A usage table that quietly
 * becomes a transcript of what students asked is a different product, and the
 * thread already lives in the seminar document where the room can see it.
 */
import { db } from '../db.js'
import type { OracleUsage } from '@shared/admin'

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    participant_id  TEXT NOT NULL,
    action          TEXT NOT NULL,
    tokens          INTEGER,
    created_at      INTEGER NOT NULL
  );
  -- The rate limiter runs on every question, and it asks exactly this question.
  CREATE INDEX IF NOT EXISTS ai_usage_window
    ON ai_usage(session_id, participant_id, created_at);
  CREATE INDEX IF NOT EXISTS ai_usage_created ON ai_usage(created_at);
`)

const insertUsage = db.prepare(
  'INSERT INTO ai_usage (session_id, participant_id, action, tokens, created_at) VALUES (?, ?, ?, ?, ?)',
)
/** Questions from one student in one seminar inside the trailing `windowMs`. */
const countWindow = db.prepare(
  'SELECT COUNT(*) AS n FROM ai_usage WHERE session_id = ? AND participant_id = ? AND created_at >= ?',
)
const windowRows = db.prepare(`
  SELECT created_at FROM ai_usage
  WHERE session_id = ? AND participant_id = ? AND created_at >= ?
  ORDER BY created_at ASC
  LIMIT 1 OFFSET ?
`)
const totals = db.prepare(`
  SELECT COUNT(*)                  AS questions,
         SUM(tokens)               AS tokens,
         COUNT(tokens)             AS reported,
         COUNT(DISTINCT session_id) AS seminars
  FROM ai_usage WHERE created_at >= ?
`)
const byActionRows = db.prepare(
  'SELECT action, COUNT(*) AS n FROM ai_usage WHERE created_at >= ? GROUP BY action',
)

export interface QuestionRecord {
  sessionId: string
  participantId: string
  /**
   * The AiAction that was actually run, or 'ask' for a free-form question.
   * 'work' — не AiAction: это ход режима «сделать», поручение агенту, и самая
   * дорогая строка в таблице.
   */
  action: string
  /** Only when the endpoint reported it; most do not on a stream. */
  tokens?: number | null
}

/** Returns the row's id, so the token count can land on it when the answer ends. */
export function recordQuestion(question: QuestionRecord): number {
  const res = insertUsage.run(
    question.sessionId,
    question.participantId,
    question.action,
    question.tokens ?? null,
    Date.now(),
  )
  return Number(res.lastInsertRowid)
}

const addTokens = db.prepare('UPDATE ai_usage SET tokens = COALESCE(tokens, 0) + ? WHERE id = ?')

/**
 * Сколько на самом деле стоил вопрос.
 *
 * Считается вопрос при приёме, а токены известны только в конце ответа — и до
 * сих пор не были известны никогда: `stream_options.include_usage` никто не
 * просил, столбец оставался пустым, а плитка в панели писала «tokens — not
 * reported by this endpoint». На инстансе с чужим ключом это единственное
 * место, где видно, во что обошёлся семестр.
 *
 * Прибавляется, а не записывается. Перезапись была верна ровно для одного
 * потока на вопрос; режим «сделать» ходит к модели до двенадцати раз, каждый
 * ход отчитывается только за себя, и в строке оставался последний — самый
 * большой, потому что контекст растёт, но всё же доля. Самый дорогой режим
 * учитывался в разы дешевле, чем стоил.
 */
export function noteTokens(id: number, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  addTokens.run(Math.round(tokens), id)
}

/** Questions from EVERYONE in one seminar inside the trailing `windowMs`. */
const countRoomWindow = db.prepare(
  'SELECT COUNT(*) AS n FROM ai_usage WHERE session_id = ? AND created_at >= ?',
)

/**
 * Questions the whole room has asked in the window.
 *
 * The per-person cap is trivially escaped: a private window is a new
 * participantId and a fresh allowance, and nothing about a seminar link stops
 * anyone opening ten. A second ceiling over the room is what actually bounds
 * what an hour of oracle can cost, and it is the number a teacher who set
 * "5 per student" thought they were setting.
 */
export function countRoomQuestions(sessionId: string, windowMs: number): number {
  const row = countRoomWindow.get(sessionId, Date.now() - windowMs) as { n: number }
  return row.n
}

export function countRecentQuestions(
  sessionId: string,
  participantId: string,
  windowMs: number,
): number {
  const row = countWindow.get(sessionId, participantId, Date.now() - windowMs) as { n: number }
  return row.n
}

/**
 * When the next question would be allowed, for a limit of `limit` per window.
 * The window slides, so that is the moment the oldest question still counting
 * against the student falls out of it — not the top of the next hour.
 */
export function windowResetAt(
  sessionId: string,
  participantId: string,
  windowMs: number,
  limit: number,
): number | null {
  const cutoff = Date.now() - windowMs
  const used = countWindow.get(sessionId, participantId, cutoff) as { n: number }
  if (used.n < limit) return null
  const row = windowRows.get(sessionId, participantId, cutoff, used.n - limit) as
    | { created_at: number }
    | undefined
  return row ? row.created_at + windowMs : null
}

export function summariseUsage(sinceMs: number): OracleUsage {
  const row = totals.get(sinceMs) as {
    questions: number
    tokens: number | null
    reported: number
    seminars: number
  }
  const byAction: Record<string, number> = {}
  for (const entry of byActionRows.all(sinceMs) as { action: string; n: number }[]) {
    byAction[entry.action] = entry.n
  }
  return {
    since: sinceMs,
    questions: row.questions,
    // null, not 0: "no endpoint told us" and "nothing was spent" are different
    // sentences, and only one of them is safe to print next to a token count.
    tokens: row.reported > 0 ? (row.tokens ?? 0) : null,
    byAction,
    seminarsWithQuestions: row.seminars,
  }
}
