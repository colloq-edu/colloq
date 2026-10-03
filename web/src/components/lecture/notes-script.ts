/**
 * HOW THE CONSOLE READS A SPEAKER NOTE, and the one place that says it.
 *
 * A note is plain markdown with two conventions of a speaker script on top,
 * and every part of the product that touches notes reads them from here: the
 * console's reader (NotesReader) folds them, the editor's field (NotesField)
 * marks what will fold, and the script import (shared/speaker-notes.ts)
 * carries notes through untouched. Two copies of the rule would mean a card
 * the editor drew that the console shows as a bold line.
 *
 *  • "IF ASKED". A paragraph (or a blockquote) that opens with the label is
 *    an answer kept in reserve, not something to say. The console folds it
 *    to the question WHERE IT STANDS: "after this sentence, expect this
 *    question" is part of the script. The label is bold (`**Если спросят:**`,
 *    as the toolbar writes it, the colon inside or outside the bold, or the
 *    whole question bold with it) or plain with a colon (`Если спросят: …`,
 *    as people type it by hand). Without bold AND without a colon ("Если
 *    спросят, что…") it is a sentence the teacher means to say, and it stays
 *    one: a false callout hides a line of the talk, which is worse than a
 *    missed one.
 *  • THE TIMING REMARK. An italic line like `*≈ 1.2 мин*` is the planned
 *    time of the slide. The console lifts it out of the text into the
 *    reader's header ("SLIDE 14 · ≈ 1.2 MIN") and into the plan under the
 *    slide: a number is read where numbers live. Whatever follows it on the
 *    same line (`*≈ 1.2 мин · не торопиться*`) stays in the text as a
 *    remark. The unit is required for the same reason as above: "≈ half the
 *    room" is not a number of minutes.
 *
 * No runes and no DOM: text in, structure out, tested as such
 * (tests/lecture-notes-script.test.mts).
 */
import { countWords, speakingMinutes } from '@shared/speaker-notes'

/**
 * The words that open an "if asked" block, in every interface language.
 *
 * All of them are recognised whatever the interface says right now: a
 * teacher who wrote the talk in Russian and switched the interface to English
 * must not watch every card in it turn back into a bold line.
 */
export const ASK_LABELS = ['Если спросят', 'If asked'] as const

/** A piece of the note: ordinary markdown, or a folded "if asked" answer. */
export type NoteBlock =
  | { kind: 'text'; source: string }
  | { kind: 'ask'; question: string; answer: string }

/** The planned time of one slide, as written in the note. */
export interface Timing {
  seconds: number
  /** The way the teacher wrote it, normalised: `≈ 1.2 мин`, `≈ 40 s`. */
  label: string
}

export interface NoteScript {
  timing: Timing | null
  blocks: NoteBlock[]
}

const LABELS = ASK_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
/* The bold opening: `**Если спросят:**`, `**Если спросят**:`, `__If asked__ —`. */
const ASK_BOLD = new RegExp(`^(\\*\\*|__)\\s*(?:${LABELS})\\s*[:：]?\\s*\\1\\s*[:：—–-]?\\s*(.*)$`, 'iu')
/* The hand-typed opening: no bold, so the colon is what makes it a label. */
const ASK_PLAIN = new RegExp(`^(?:${LABELS})\\s*[:：]\\s*(.*)$`, 'iu')
/* The whole question in bold together with its label: `**Если спросят: а метка?**`. */
const ASK_WRAPPED = new RegExp(`^(\\*\\*|__)\\s*(?:${LABELS})\\s*[:：]\\s*(.+?)\\s*\\1\\s*$`, 'iu')

/*
 * `*≈ 1.2 мин*`, `_~ 40 сек_`, `≈ 2 min · slowly`. The tilde counts as
 * "about" too: it is what a keyboard without ≈ types.
 */
const TIMING =
  /^([*_]?)\s*[≈~]\s*(\d+(?:[.,]\d+)?)\s*(минуты|минута|минут|мин|min(?:utes?)?|м|m|секунды|секунда|секунд|сек|sec(?:onds?)?|с|s)\.?(?![\p{L}\d])\s*(?:[·•—–,;:-]\s*(.*?))?\s*\1\s*$/iu

const SECONDS_UNIT = /^(с|сек|секунд|секунда|секунды|s|sec|second|seconds)$/iu

/** A fenced code block opens or closes on this line. */
const FENCE = /^\s{0,3}(```|~~~)/

/**
 * Split into paragraphs by blank lines, never inside a fenced code block: a
 * blank line in a code sample is part of the sample.
 */
function paragraphs(note: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fenced = false
  for (const line of note.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced
    if (!fenced && line.trim() === '') {
      if (current.length) out.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length) out.push(current.join('\n'))
  return out
}

/** A blockquote whose every line starts with `>`, without the markers; otherwise null. */
function unquote(paragraph: string): string | null {
  const lines = paragraph.split('\n')
  if (!lines.every((line) => /^\s*>/.test(line))) return null
  return lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n')
}

/** The "if asked" callout this paragraph is, or null. A quoted one counts too. */
export function askOf(paragraph: string): { question: string; answer: string } | null {
  const body = unquote(paragraph) ?? paragraph
  const [first, ...rest] = body.split('\n')
  const head = first.trim()
  const bold = ASK_BOLD.exec(head) ?? ASK_WRAPPED.exec(head)
  const plain = bold ? null : ASK_PLAIN.exec(head)
  if (!bold && !plain) return null
  let question = (bold ? bold[2] : plain![1]).trim()
  let lines = rest
  // The question may sit on its own line under the label.
  if (!question && lines.length > 0) {
    question = lines[0].trim()
    lines = lines.slice(1)
  }
  return { question, answer: lines.join('\n').trim() }
}

/** The timing remark this line is, or null. */
export function timingOf(line: string): (Timing & { rest: string }) | null {
  const match = TIMING.exec(line.trim())
  if (!match) return null
  const amount = Number(match[2].replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = match[3].toLowerCase()
  const seconds = SECONDS_UNIT.test(unit) ? amount : amount * 60
  return {
    seconds: Math.round(seconds),
    label: `≈ ${match[2]} ${unit}`,
    rest: (match[4] ?? '').trim(),
  }
}

/**
 * The note as the console shows it: the first timing lifted out, "if asked"
 * paragraphs folded where they stand, and every run of ordinary paragraphs
 * kept as ONE markdown text, so a loose list or a numbered list across blank
 * lines renders exactly as it would anywhere else.
 */
export function readNote(note: string): NoteScript {
  let timing: Timing | null = null
  const blocks: NoteBlock[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length) blocks.push({ kind: 'text', source: run.join('\n\n') })
    run = []
  }
  for (const raw of paragraphs(note)) {
    let paragraph = raw
    if (timing === null) {
      const [first, ...rest] = paragraph.split('\n')
      const found = timingOf(first)
      if (found) {
        timing = { seconds: found.seconds, label: found.label }
        // The remark after the number stays where it was, still a remark.
        paragraph = (found.rest ? [`*${found.rest}*`, ...rest] : rest).join('\n')
        if (!paragraph.trim()) continue
      }
    }
    const ask = askOf(paragraph)
    if (ask) {
      flush()
      blocks.push({ kind: 'ask', ...ask })
      continue
    }
    run.push(paragraph)
  }
  flush()
  return { timing, blocks }
}

/**
 * The words of a note that are said aloud: its text blocks, without the
 * timing and without the answers in reserve, which are said only if somebody
 * asks.
 */
export function spokenWords(note: string): number {
  return readNote(note)
    .blocks.filter((block) => block.kind === 'text')
    .reduce((sum, block) => sum + countWords(block.kind === 'text' ? block.source : ''), 0)
}

/**
 * How long a slide is meant to take, in seconds: the written timing if the
 * note has one, otherwise the speaking estimate (shared/speaker-notes.ts,
 * 150 words a minute). Zero for an empty note.
 */
export function budgetOf(note: string): { seconds: number; written: Timing | null } {
  const written = readNote(note).timing
  if (written) return { seconds: written.seconds, written }
  return { seconds: Math.round(speakingMinutes(spokenWords(note)) * 60), written: null }
}

/**
 * The plan at this point of the lecture: how far into the class the end of
 * page `through` is meant to be, in seconds.
 *
 * Null unless the teacher timed the script: at least one note of the
 * document carries a written timing. A plan made up entirely of word-count
 * estimates would be a schedule nobody set, shown under the slide as if they
 * had. Once there is one, the pages without a timing count by their estimate,
 * so a partly timed script still tells whether the lecture runs late.
 */
export function plannedSeconds(notes: Readonly<Record<number, string>>, through: number): number | null {
  let total = 0
  let timed = false
  for (const [key, text] of Object.entries(notes)) {
    if (!text) continue
    const page = Number(key)
    if (!Number.isInteger(page) || page < 1) continue
    const budget = budgetOf(text)
    if (budget.written) timed = true
    if (page <= through) total += budget.seconds
  }
  return timed ? total : null
}

/**
 * Markdown down to the words, for one line of preview ("next: …").
 *
 * Not a parser: the preview is clamped to a line, and what matters is that
 * `**`, `#` and `[text](url)` do not show as punctuation.
 */
export function plainLine(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\p{L}\d])[*_]([^*_]+)[*_](?![\p{L}\d])/gu, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The line that stands for a note in a list or a preview: the first line of
 * its first text block, without markup. Neither the timing nor a folded
 * answer is announced as what the slide says: the console's "next" footer
 * and the editor's slide list both want the talk, not its stage directions.
 */
export function firstLine(note: string): string {
  for (const block of readNote(note).blocks) {
    if (block.kind !== 'text') continue
    for (const line of block.source.split('\n')) {
      const words = plainLine(line)
      if (words) return words
    }
  }
  return ''
}
