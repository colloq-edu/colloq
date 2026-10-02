import { tr } from '@shared/i18n'
/**
 * What must not go out on a class page by accident, and what the teacher
 * should look at before it does.
 *
 * Two different treatments, on purpose:
 *
 * THE ROOM ADDRESS is removed, always and silently (the panel only counts
 * it). Eight characters of a room id are the whole right to write into it,
 * and a page is a permanent link anyone can forward; there is no case where
 * a student needs it. Kernel paths carry it too (`/workspace/<id>/data.csv`
 * in every traceback), and those become plain relative paths.
 *
 * SECRETS AND NAMES are reported, never rewritten. A string that looks like
 * an API key may be a placeholder the lesson is about, and a full name in a
 * cell may be a scientist the notebook cites. Only the teacher can tell, so
 * the page waits for «Проверил(а) — публиковать как есть». The ids are a hash
 * of what and where, so a confirmation survives a rebuild as long as the
 * finding is the same; a new key typed into a cell is a new finding.
 */
import { createHash } from 'node:crypto'
import type { CellOutput } from '@shared/notebook'
import {
  BLOB_MIMES,
  BLOB_PREFIX,
  SPILL_MIMES,
  spillEncoding,
  type PublicCell,
  type PublishCheck,
} from '@shared/publish'

/* ----------------------------------------------------------- the room id */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A `blob:<hash>` reference the build put in place of a moved-out image or figure. */
const isBlobRef = (mime: string, value: string): boolean =>
  SPILL_MIMES.has(mime) && /^blob:[0-9a-f]{32}$/.test(value)

/** Whether a text-like mime: what a person could read, so what an id could hide in. */
function isTextMime(mime: string): boolean {
  return mime === 'image/svg+xml' || (!BLOB_MIMES.has(mime) && !mime.startsWith('image/'))
}

export function roomIdPattern(roomId: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escape(roomId)}(?![A-Za-z0-9])`, 'g')
}

/**
 * The text without the room: `/workspace/<id>/x` becomes `x`, a bare
 * `/workspace/<id>` becomes `.`, and the id anywhere else becomes `…`.
 */
export function scrubText(text: string, roomId: string): string {
  if (!roomId || !text.includes(roomId)) return text
  return text
    .replace(new RegExp(`/workspace/${escape(roomId)}/`, 'g'), '')
    .replace(new RegExp(`/workspace/${escape(roomId)}(?![A-Za-z0-9])`, 'g'), '.')
    .replace(roomIdPattern(roomId), '…')
}

function scrubOutput(output: CellOutput, roomId: string): CellOutput {
  if (output.kind === 'stream') return { ...output, text: scrubText(output.text, roomId) }
  if (output.kind === 'error') {
    return {
      ...output,
      ename: scrubText(output.ename, roomId),
      evalue: scrubText(output.evalue, roomId),
      traceback: output.traceback.map((line) => scrubText(line, roomId)),
    }
  }
  const data: Record<string, string> = {}
  for (const [mime, value] of Object.entries(output.data)) {
    data[mime] =
      typeof value === 'string' && isTextMime(mime) && !isBlobRef(mime, value)
        ? scrubText(value, roomId)
        : value
  }
  return { ...output, data }
}

/**
 * The cells without the room id, and how many cells it was removed from.
 * Images are left as they are: base64 does not hide an id, and rewriting it
 * would break the picture.
 */
export function scrubCells(
  cells: readonly PublicCell[],
  roomId: string,
): { cells: PublicCell[]; scrubbed: number } {
  let scrubbed = 0
  const out = cells.map((cell) => {
    const next: PublicCell = {
      ...cell,
      source: scrubText(cell.source, roomId),
      outputs: cell.outputs.map((o) => scrubOutput(o, roomId)),
    }
    if (JSON.stringify(next) !== JSON.stringify(cell)) scrubbed++
    return next
  })
  return { cells: out, scrubbed }
}

/* ---------------------------------------------------------------- checks */

export function checkId(
  kind: PublishCheck['kind'],
  root: string | null,
  path: string | null,
  cellId: string | null,
  sample: string,
): string {
  return createHash('sha1')
    .update(`${kind}|${root ?? ''}|${path ?? ''}|${cellId ?? ''}|${sample}`)
    .digest('hex')
    .slice(0, 12)
}

/** «sk-p…3f»: enough to recognise, not enough to use. */
export function maskSecret(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-2)}` : `${value.slice(0, 2)}…`
}

/**
 * Reads a moved-out TEXT piece (a plotly figure) back, so the checks see it.
 *
 * A figure of 2 KB or more never sits in the bundle as text: in a room it
 * lies on the room's shelf (`output.blobs`), and on a page behind a
 * `blob:<hash>`. Both are JSON a person reads as hover labels and axis
 * ticks, so a `px.bar(df, x='student')` over quiz results carries every
 * name. Images are never read back: base64 hides neither a name nor a key.
 */
export interface SpillReader {
  /** The text behind `blob:<hash>` in a projected output's bundle. */
  ref?: (hash: string) => string | null
  /** The text of an `output.blobs` entry, from the room's shelf. */
  shelf?: (sha: string) => string | null
}

/** Everything a person could read in a cell: its source and its text outputs. */
export function cellTexts(
  cell: { source: string; outputs: readonly CellOutput[] },
  read: SpillReader = {},
): string[] {
  const texts = [cell.source]
  const push = (text: string | null) => {
    if (text) texts.push(text)
  }
  for (const output of cell.outputs) {
    if (output.kind === 'stream') texts.push(output.text)
    else if (output.kind === 'error') texts.push(output.ename, output.evalue, ...output.traceback)
    else {
      for (const [mime, value] of Object.entries(output.data)) {
        if (typeof value !== 'string' || !isTextMime(mime)) continue
        if (!isBlobRef(mime, value)) texts.push(value)
        else if (spillEncoding(mime) === 'utf8' && read.ref) {
          push(read.ref(value.slice(BLOB_PREFIX.length)))
        }
      }
      for (const blob of output.blobs ?? []) {
        if (output.data[blob.mime] !== undefined || spillEncoding(blob.mime) !== 'utf8') continue
        if (read.shelf) push(read.shelf(blob.sha))
      }
    }
  }
  return texts
}

/*
 * Shapes of real credentials. Each is a vendor's documented prefix with
 * enough random characters after it that prose does not match: OpenAI and
 * Anthropic (`sk-`), GitHub (`ghp_`, `github_pat_`), AWS access keys
 * (`AKIA`), Slack (`xox?-`), Google (`AIza`), Hugging Face (`hf_`) and
 * Telegram bot tokens.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
]

/**
 * A long random-looking value assigned to something called a key, a token,
 * a secret or a password: `API_KEY = "Zx81…"`. Random-looking means letters
 * and digits mixed and no spaces, so `key = "sepal_length"` stays quiet.
 */
const NEAR_KEY =
  /[\w-]*(?:key|token|secret|passw(?:or)?d|pwd)[\w-]*["']?\s*[:=]\s*["']([A-Za-z0-9+/_=.-]{24,})["']/gi

function secretsIn(text: string): string[] {
  const found: string[] = []
  for (const shape of SECRET_SHAPES) for (const m of text.matchAll(shape)) found.push(m[0])
  for (const m of text.matchAll(NEAR_KEY)) {
    const value = m[1]
    if (/[A-Za-z]/.test(value) && /\d/.test(value) && new Set(value).size > 8) found.push(value)
  }
  return found
}

/** The roster's full names as patterns; a single-word name matches nothing. */
function rosterRegexes(roster: readonly string[]): RegExp[] {
  return roster.map(nameRegex).filter((re): re is RegExp => re !== null)
}

function nameRegex(name: string): RegExp | null {
  const words = name.trim().split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w))
  if (words.length < 2) return null
  const forward = words.map(escape).join('\\s+')
  const backward = [...words].reverse().map(escape).join('\\s+')
  return new RegExp(`(?<!\\p{L})(?:${forward}|${backward})(?!\\p{L})`, 'giu')
}

/** One notebook as the checks see it. */
export interface CheckedBook {
  root: string
  /** The tab name the teacher sees, for «"Семинар", ячейка 14». */
  name: string
  cells: readonly { id: string; source: string; outputs: readonly CellOutput[] }[]
}

/**
 * Secret-like strings and full names of the room's students, cell by cell.
 *
 * `roster` is every participant except the hosts. A full name counts; a lone
 * first name does not, because «Аким» alone is as likely a word in a task as
 * a person.
 */
export function cellChecks(
  book: CheckedBook,
  roster: readonly string[],
  read: SpillReader = {},
): PublishCheck[] {
  const checks: PublishCheck[] = []
  const seen = new Set<string>()
  const names = rosterRegexes(roster)
  book.cells.forEach((cell, index) => {
    const where = tr('server.publish.checkInCell', { name: book.name, n: index + 1 })
    const add = (kind: PublishCheck['kind'], sample: string) => {
      const id = checkId(kind, book.root, null, cell.id, sample)
      if (seen.has(id)) return
      seen.add(id)
      checks.push({ id, kind, where, root: book.root, cellId: cell.id, path: null, sample })
    }
    for (const text of cellTexts(cell, read)) {
      for (const secret of secretsIn(text)) add('secret', maskSecret(secret))
      for (const re of names) {
        for (const m of text.matchAll(re)) add('name', m[0].replace(/\s+/g, ' '))
      }
    }
  })
  return checks
}

/**
 * What a picked room file would carry out: the room id, a secret-like
 * string, a student's full name.
 *
 * Files are copied byte for byte (a CSV is data, not a page), so nothing is
 * rewritten, and every finding waits for the teacher, the room id included.
 * They need the same look as cells: a `utils.py` the seminar imports with an
 * `OPENAI_API_KEY = "sk-…"` in it, the `kaggle.json` an ML seminar copies
 * into `~/.kaggle`, a `data/students.csv` a notebook reads, all come up
 * ticked by default and would otherwise go out on a forwardable link, and a
 * refresh at the bell would re-read them from disk unchecked.
 *
 * The ids carry the path and the sample but no cell, so a confirmation
 * survives rebuilds while the file says the same thing.
 */
export function fileChecks(
  path: string,
  text: string,
  roomId: string,
  roster: readonly string[],
): PublishCheck[] {
  const checks: PublishCheck[] = []
  const seen = new Set<string>()
  const add = (kind: PublishCheck['kind'], sample: string) => {
    const id = checkId(kind, null, path, null, sample)
    if (seen.has(id)) return
    seen.add(id)
    const where = kind === 'roomId' ? path : tr('server.publish.checkInFile', { path })
    checks.push({ id, kind, where, root: null, cellId: null, path, sample })
  }
  if (roomId && roomIdPattern(roomId).test(text)) add('roomId', maskSecret(roomId))
  for (const secret of secretsIn(text)) add('secret', maskSecret(secret))
  for (const re of rosterRegexes(roster)) {
    for (const m of text.matchAll(re)) add('name', m[0].replace(/\s+/g, ' '))
  }
  return checks
}
