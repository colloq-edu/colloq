/**
 * A lecture script: speaker notes for a whole deck as one markdown file.
 *
 * The import cuts a script into pages by its "## 14 · …" headings, and the
 * export writes the notes back under the same headings. One module for both
 * directions, and that is the point of it: if each kept its own idea of the
 * format, a script exported on Monday would come back on Tuesday as one note
 * glued onto slide 1. Nothing here touches the DOM or the network, so the
 * browser and the tests import it as is.
 *
 * What a note itself means (the "if asked" callouts, the timing remark) is
 * the console's reading and lives with the reader (web · lecture/
 * notes-script.ts); a script carries notes through untouched.
 */
import { MAX_NOTE_CHARS } from './lecture.js'

/**
 * Words in a piece of note text, without its markup.
 *
 * The caller decides which text is said aloud: the console's reading of a
 * note (web · lecture/notes-script.ts) folds the "if asked" answers away and
 * lifts the timing out, and only what is left is counted.
 */
export function countWords(text: string): number {
  const plain = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\$[^$]*\$/g, ' x ')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)]|>|#{1,6})\s+/gmu, '')
  return plain.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length
}

/**
 * Speaking pace for the minutes estimate: a lecture, not a radio host.
 *
 * 150 words a minute is the middle of what lecturers are measured at
 * (130–170) with pauses for the board included; the estimate is a "≈" next
 * to the slide number, there to tell a two-minute slide from a ten-second
 * one, not to time the class.
 */
export const WORDS_PER_MINUTE = 150

/** Minutes to say this many words, to one decimal. */
export function speakingMinutes(words: number): number {
  return Math.round((words / WORDS_PER_MINUTE) * 10) / 10
}

/* ------------------------------------------------------------ the script */

/** One `## …` section of a lecture script. */
export interface ScriptSection {
  /** 1-based order in the file. */
  index: number
  /** The slide number the heading names; `null` when it names none. */
  number: number | null
  /** The page the section lands on: the number named, or the order. */
  page: number
  /** The heading without its number. */
  title: string
  /** The note: everything under the heading, edges trimmed. */
  body: string
  /** The heading's line in the file, 1-based — for saying where something is. */
  line: number
}

/*
 * A heading names a slide when it starts with a number followed by a
 * separator or the end: "01 · Title", "01. Title", "1) Title", "14 — Title",
 * "Слайд 1", "Slide 3: Title". "3D-модели" does not: a digit glued to a
 * letter is a word, not a number.
 */
const SEPARATOR = '[\\s.·:)\\]|—–\\-,•]'
const PREFIX = '(?:(?:слайд|slide|стр\\.?|страница|page|p\\.)\\s*)?№?\\s*'
const NUMBERED = new RegExp(`^${PREFIX}(\\d{1,4})(?=$|${SEPARATOR})${SEPARATOR}*(.*)$`, 'iu')

const FENCE = /^\s{0,3}(?:```|~~~)/u
/*
 * A note line the export had to escape: `## Foo` inside a note would read as
 * a new section on the way back, so the export writes `\## Foo`, and the
 * import takes the backslash off again. Only the levels that cut sections.
 */
const ESCAPED_HEADING = /^( {0,3})\\(#{1,2})(?=[ \t]|$)/u
const CUTTING_HEADING = /^( {0,3})(#{1,2})(?=[ \t]|$)/u

function headingOf(line: string): { level: number; text: string } | null {
  const match = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/u.exec(line)
  if (match) return { level: match[1].length, text: match[2].trim() }
  return /^ {0,3}(#{1,6})[ \t]*$/u.test(line) ? { level: line.trim().length, text: '' } : null
}

/**
 * Cut a script into sections.
 *
 * Sections are `##` headings. A script with no `##` at all falls back to `#`:
 * some people write one heading level and nothing else, and refusing them
 * would be pedantry. With `##` sections a `#` line is a chapter title
 * ("# Part 2"), and it closes the section above rather than ending up in its
 * note. Whatever comes before the first section (a `# Title` line, a
 * preface) belongs to no slide and is left out. Headings inside a fenced code
 * block are code, not sections.
 */
export function parseScript(source: string): ScriptSection[] {
  const lines = source.replace(/^﻿/u, '').replace(/\r\n?/g, '\n').split('\n')
  let fenced = false
  let anyH2 = false
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced && headingOf(line)?.level === 2) anyH2 = true
  }
  const level = anyH2 ? 2 : 1

  const sections: ScriptSection[] = []
  let open: { title: string; number: number | null; line: number; body: string[] } | null = null
  const close = () => {
    if (!open) return
    const previous = sections.at(-1)
    const page = open.number ?? (previous ? previous.page + 1 : 1)
    sections.push({
      index: sections.length + 1,
      number: open.number,
      page,
      title: open.title,
      body: open.body
        .map((line) => line.replace(ESCAPED_HEADING, '$1$2'))
        .join('\n')
        .trim(),
      line: open.line,
    })
    open = null
  }

  fenced = false
  lines.forEach((line, at) => {
    if (FENCE.test(line)) fenced = !fenced
    const heading = fenced ? null : headingOf(line)
    if (heading && heading.level === level) {
      close()
      const numbered = NUMBERED.exec(heading.text)
      open = numbered
        ? { number: Number(numbered[1]), title: numbered[2].trim(), line: at + 1, body: [] }
        : { number: null, title: heading.text, line: at + 1, body: [] }
      return
    }
    if (heading && heading.level < level) {
      // A chapter line: it ends the section above and belongs to none.
      close()
      return
    }
    open?.body.push(line)
  })
  close()
  return sections
}

/** What applying one section would do. */
export type ImportStatus =
  /** The slide has no note yet: the section becomes it. */
  | 'new'
  /** The slide has a different note: the section replaces it. */
  | 'replace'
  /** The slide already says exactly this: nothing to write. */
  | 'same'
  /** Longer than a note may be: skipped whole, never cut. */
  | 'too-long'
  /** Points past the last page (or before the first): there is no such slide. */
  | 'no-slide'
  /** A heading with nothing under it: skipped, the slide keeps what it has. */
  | 'empty'
  /** A second section for a slide an earlier one already took: skipped. */
  | 'duplicate'

export interface ImportRow extends ScriptSection {
  status: ImportStatus
  /** Characters of the body, counted the way the server counts them. */
  chars: number
}

export interface ImportPlan {
  rows: ImportRow[]
  /** What goes to the server: page → text. Only new and replacing sections. */
  writes: Record<number, string>
  counts: Record<ImportStatus, number>
}

/**
 * Lay a script over the document: what each section would do.
 *
 * Nothing is cut and nothing is guessed. A section longer than a note may be
 * is skipped with its length shown, and the slide keeps the note it had: a
 * talk cut off mid-sentence looks saved and is discovered in class, reading
 * the stump. An empty section is skipped rather than read as "delete": a
 * script downloaded from here lists every slide, including the ones without
 * notes, and loading it back must not wipe a note written in between.
 */
export function planImport(
  sections: readonly ScriptSection[],
  pages: number,
  existing: Readonly<Record<number, string>>,
): ImportPlan {
  const counts: Record<ImportStatus, number> = {
    new: 0,
    replace: 0,
    same: 0,
    'too-long': 0,
    'no-slide': 0,
    empty: 0,
    duplicate: 0,
  }
  const writes: Record<number, string> = {}
  const taken = new Set<number>()
  const rows = sections.map((section): ImportRow => {
    const chars = section.body.length
    let status: ImportStatus
    if (section.page < 1 || section.page > pages) status = 'no-slide'
    else if (taken.has(section.page)) status = 'duplicate'
    else if (!section.body) status = 'empty'
    else if (chars > MAX_NOTE_CHARS) status = 'too-long'
    else {
      const before = (existing[section.page] ?? '').trim()
      status = !before ? 'new' : before === section.body ? 'same' : 'replace'
    }
    if (section.page >= 1 && section.page <= pages) taken.add(section.page)
    if (status === 'new' || status === 'replace') writes[section.page] = section.body
    counts[status] += 1
    return { ...section, status, chars }
  })
  return { rows, writes, counts }
}

/**
 * Write the notes out as a script the import reads back.
 *
 * Every slide gets a section, the empty ones too: the file is meant to be
 * written in, in an editor of one's choice, and a missing "## 17" is a slide
 * one forgets. The numbers are zero-padded to the width of the last one, so
 * the headings line up and sort.
 */
export function buildScript(options: {
  notes: Readonly<Record<number, string>>
  pages: number
  /** Slide titles to put after the numbers, when known. */
  titles?: Readonly<Record<number, string>>
  /** The `# …` line at the top: the document's name. */
  heading?: string
}): string {
  const { notes, pages, titles = {}, heading } = options
  const width = Math.max(2, String(Math.max(1, pages)).length)
  const out: string[] = []
  if (heading) out.push(`# ${oneLine(heading)}`, '')
  for (let page = 1; page <= pages; page += 1) {
    const title = oneLine(titles[page] ?? '')
    out.push(`## ${String(page).padStart(width, '0')}${title ? ` · ${title}` : ''}`, '')
    const text = (notes[page] ?? '').replace(/\r\n?/g, '\n').trim()
    if (!text) continue
    const lines = text.split('\n').map((line) => line.replace(CUTTING_HEADING, '$1\\$2'))
    /*
     * A code fence left open would swallow every section after it on the way
     * back (headings inside a fence are code). Closing it at the end changes
     * nothing on screen: an open fence runs to the end of the note anyway.
     */
    if (lines.filter((line) => FENCE.test(line)).length % 2 === 1) lines.push('```')
    out.push(lines.join('\n'), '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** A heading is one line: a title with a line break would end the heading early. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}
