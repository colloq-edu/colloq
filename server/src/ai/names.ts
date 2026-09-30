import { tr } from '@shared/i18n'
/**
 * How the people of a room are called in a request to the model.
 *
 * One instance switch decides it — "Student names in model requests"
 * (OracleSettings.sendNames) — and until 0.9 only the council read it: an
 * ordinary question still carried the asker's name, every earlier asker's
 * name and "run by <name>" on each cell, whatever the switch said. A
 * university's data-protection officer asks exactly "what leaves the server",
 * and a switch that governs one door out of three is not an answer. So every
 * prompt path asks this module how to call a person, and nothing else puts a
 * participant's name into a prompt. The council keeps its own labels S1…SN
 * (ai/council.ts): they are mapped back to names in the teacher's console
 * answer by answer, and it already obeys the same switch.
 *
 * Off, a person is a stable pseudonym of the room. "Student 3" is the third
 * person who ever joined THIS room: join order is the participants table's
 * rowid, which rows keep for the life of the room (they are deleted only
 * together with it), so the same person keeps the same label from one
 * question to the next and through the whole thread. A host is "Teacher": the
 * role is not personal, and "Student 1 asked to check everyone's work" would
 * mislead the model about who is asking. The numbering counts hosts too, so a
 * teacher who first came in as a student and signed in later does not shift
 * every classmate's number by one.
 *
 * The labels are not mapped back to names in the answer. The model is told
 * they only tell turns apart and to address the asker as "you"; the room reads
 * the answer right under the question, whose real name the thread shows.
 * Mapping back would mean rewriting a streamed text across chunk boundaries
 * (and Russian declensions), and then scrubbing those names out again when
 * the thread is replayed — more machinery than a label that slipped through
 * is worth: "Student 3" is not personal data and names nobody.
 *
 * What this does NOT touch, on purpose: what people typed. A question, a
 * cell, a file name or the room's title travel as written — people wrote them,
 * and no switch can know which of their words are names. The one exception is
 * the model's own earlier answers: written while the switch was on, they may
 * quote names, and replaying them after it was turned off would send those
 * names again. Exact room names in them are replaced (`scrub`).
 */
import { getOracleSettings } from '../admin/settings.js'
import { db } from '../db.js'

export interface ModelNames {
  /** Whether real names go to the model: the instance switch at the time of the request. */
  readonly real: boolean
  /**
   * How to call a participant in the request.
   *
   * With names on it is `name` exactly as the room shows it (the thread
   * entry's, the cell's `runBy`); with them off, the participant's pseudonym,
   * looked up by id — the name is not even read. `null` when there is nothing
   * honest to say: no name, or an id the room does not know.
   */
  call(participantId: string | null | undefined, name?: string | null): string | null
  /** The model's earlier words with exact room names replaced; unchanged when names are on. */
  scrub(text: string): string
}

/** "Student 3" in the instance language: the same language the model answers in. */
export function studentLabel(n: number): string {
  return tr('server.ai.studentLabel', { p0: n })
}

export function teacherLabel(): string {
  return tr('server.ai.teacherLabel')
}

/** For a thread entry whose asker the room no longer knows: never a guessed name. */
export function someoneLabel(): string {
  return tr('server.ai.someoneLabel')
}

const REAL_NAMES: ModelNames = {
  real: true,
  call: (_participantId, name) => name?.trim() || null,
  scrub: (text) => text,
}

/** The room in join order. The index is `participants_session`; the order is the rowid. */
const selectRoster = db.prepare(
  'SELECT id, name, role FROM participants WHERE session_id = ? ORDER BY rowid',
)

interface RosterRow {
  id: string
  name: string
  role: string
}

/**
 * The shortest name `scrub` replaces, and which single words it leaves alone.
 *
 * A name is replaced wherever it stands as a whole word, and a room's names are
 * whatever people typed at the door: "Ли" is also a Russian particle, "Ян" a
 * syllable, and "numpy" a library the answer is about. Three characters and a
 * capital letter for a one-word name keep the replacement on names; a name of
 * two words is specific enough in any case.
 */
const MIN_SCRUBBED = 3

function scrubbable(name: string): boolean {
  if (name.length < MIN_SCRUBBED) return false
  return /\s/.test(name) || /^\p{Lu}/u.test(name)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The names for one request, decided once: every part of the request — the
 * frame, the thread, the question — must call a person the same way, and
 * reading the switch per line would let a flip in the middle split them.
 *
 * `real` is passed only by tests; everyone else gets the instance switch.
 */
export function modelNames(sessionId: string, real: boolean = getOracleSettings().sendNames): ModelNames {
  if (real) return REAL_NAMES

  // Read once, and only when a name is actually needed: a question in a room
  // with nobody else in the thread costs no roster at all.
  let roster: RosterRow[] | null = null
  let labels: Map<string, string> | null = null
  let replacer: ((text: string) => string) | null = null

  const rows = (): RosterRow[] => (roster ??= selectRoster.all(sessionId) as RosterRow[])
  const labelled = (): Map<string, string> => {
    if (labels) return labels
    labels = new Map()
    for (const [at, row] of rows().entries()) {
      labels.set(row.id, row.role === 'host' ? teacherLabel() : studentLabel(at + 1))
    }
    return labels
  }
  const replace = (): ((text: string) => string) => {
    if (replacer) return replacer
    const byName = new Map<string, string>()
    for (const row of rows()) {
      const name = row.name.trim()
      // Namesakes share the first one's label: the point is that the name does
      // not leave, and which of two Annas an old answer meant is not recoverable.
      if (scrubbable(name) && !byName.has(name)) byName.set(name, labelled().get(row.id)!)
    }
    if (byName.size === 0) return (replacer = (text) => text)
    // Longest first, so "Анна Белая" goes whole before "Анна" could split it.
    const alternatives = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
    return (replacer = (text) => text.replace(pattern, (hit) => byName.get(hit) ?? hit))
  }

  return {
    real: false,
    call: (participantId) => (participantId ? (labelled().get(participantId) ?? null) : null),
    scrub: (text) => (text ? replace()(text) : text),
  }
}
