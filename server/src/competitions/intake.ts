/**
 * Parsing what the teacher puts into a competition: tables and notebooks.
 *
 * Pure functions over bytes, with no disk and no database. They live here
 * because both doors — the open data and the answers — show the same things
 * about a file ("397 rows · id, orders"), and counting this with two copies
 * would mean one day counting the answer rows differently from the test rows:
 * the split into the public and private part rests on exactly this number.
 */

import { splitByUsage } from '@shared/competitions'

/** What is shown about a CSV on the file card. */
export interface CsvShape {
  /** DATA rows, without the header. This is the number that is split into two parts. */
  rows: number
  columns: string[]
}

/** A null byte at the start is a sure sign this was put here as a table by mistake. */
const SNIFF = 8192

/**
 * Count the rows and read the header.
 *
 * Quotes are respected: in an honest CSV a line break inside `"..."` is part
 * of the value, and a naive `split('\n')` would count twice as many rows in
 * such a file as there are. The error is quiet: the share of the public part
 * is computed from this number, and "119 of 397" would turn into "238 of 794"
 * without a single refusal.
 *
 * `null` means it is not a table: empty or binary.
 */
export function csvShape(bytes: Uint8Array): CsvShape | null {
  if (bytes.length === 0) return null
  const sniff = Math.min(bytes.length, SNIFF)
  for (let i = 0; i < sniff; i++) if (bytes[i] === 0) return null

  const QUOTE = 0x22
  const LF = 0x0a
  const CR = 0x0d
  let inQuote = false
  let records = 0
  let headerEnd = -1
  /** Does the current record have any byte yet: a trailing line break is not a record. */
  let started = false

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === QUOTE) {
      // A doubled quote inside a value is escaped, not the end of the field.
      if (inQuote && bytes[i + 1] === QUOTE) {
        i += 1
        started = true
        continue
      }
      inQuote = !inQuote
      started = true
      continue
    }
    if (!inQuote && byte === LF) {
      // An empty line is not a row: `pandas.read_csv` skips them, and the
      // number under the file name must match what the notebook will see.
      if (started) {
        if (headerEnd < 0) headerEnd = bytes[i - 1] === CR ? i - 1 : i
        else records += 1
      }
      started = false
      continue
    }
    if (byte !== CR) started = true
  }
  // A last line without a trailing line break is a row too.
  if (started) {
    if (headerEnd < 0) headerEnd = bytes.length
    else records += 1
  }
  if (headerEnd < 0) return null

  return {
    rows: records,
    columns: splitRecord(Buffer.from(bytes.subarray(0, headerEnd)).toString('utf8')),
  }
}

/** The header as one line: `id, orders` — exactly how the mockup captions it. */
export function columnsLine(columns: readonly string[]): string {
  return columns.join(', ')
}

/** Count the same Usage values that the Python scoring harness accepts.
 * Records may contain quoted commas and newlines; splitting on lines loses
 * alignment as soon as a descriptive column contains a paragraph. */
export function csvUsageSplit(bytes: Uint8Array): { publicRows: number; privateRows: number } | null {
  const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')
  let column: number | null = null
  let start = 0
  let quoted = false
  const usage: string[] = []
  for (let i = 0; i <= text.length; i++) {
    if (text[i] === '"') {
      if (quoted && text[i + 1] === '"') i += 1
      else quoted = !quoted
    }
    if (i !== text.length && (text[i] !== '\n' || quoted)) continue
    const record = text.slice(start, i)
    start = i + 1
    if (!record.trim()) continue
    const fields = splitRecord(record)
    if (column === null) {
      column = fields.indexOf('Usage')
      if (column < 0) return null
    } else {
      usage.push(fields[column] ?? '')
    }
  }
  const parts = splitByUsage(usage)
  if (!parts) return null
  const publicRows = parts.filter((part) => part === 'public').length
  return { publicRows, privateRows: parts.length - publicRows }
}

/**
 * Split a CSV record into fields.
 *
 * Separate from counting rows: that needs one pass over the bytes of the
 * whole file, this needs one short line, and merging them would mean holding
 * in memory a parse of two hundred megabytes for the sake of the header.
 */
function splitRecord(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        field += '"'
        i += 1
        continue
      }
      inQuote = !inQuote
      continue
    }
    if (ch === ',' && !inQuote) {
      out.push(field.trim())
      field = ''
      continue
    }
    field += ch
  }
  out.push(field.trim())
  // A single field with no commas is not a table but just a line; let it look
  // like that rather than pretend to be a column with an empty name.
  return out.length === 1 && out[0] === '' ? [] : out
}

/**
 * How many cells the notebook has; `null` means it is not a notebook.
 *
 * Checked here, not in the container: a file that `nbformat` cannot parse
 * would take a place in the queue, start a container and come back a minute
 * later with "the notebook crashed" — when the participant simply dragged in
 * the wrong file.
 */
export function notebookCells(bytes: Uint8Array): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return null
  }
  const cells = (parsed as { cells?: unknown } | null)?.cells
  if (!Array.isArray(cells)) return null
  return cells.length
}

/**
 * The file name without the path.
 *
 * The browser puts into the form whatever the file system of the person
 * dragging gave it: `C:\Users\...\train.csv` from old Windows builds and
 * `data/train.csv` from dragging a folder. This name then travels into the
 * container's `data/`, and the participant writes it in their notebook — so a
 * path segment in it is not a vulnerability (the anchored file system catches
 * that) but a file nobody will be able to read.
 */
export function baseName(raw: string): string {
  const cut = String(raw ?? '')
    .split(/[\\/]/)
    .pop()
  return (cut ?? '').trim()
}
