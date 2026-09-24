/**
 * A .ipynb file: reading and writing it.
 *
 * The room's notebooks are files, and this is the only place that knows what
 * they look like on disk. Parsing used to live in github.ts (import from a
 * repository), writing in publish/notebook.ts (export of a published step);
 * the two halves lived apart and knew nothing of each other. They would have
 * drifted apart silently: a file written by one and read by the other would
 * lose exactly what they had not agreed on. And they did drift: the half from
 * publishing gave cells an `id` and the half from the room did not, although
 * both declared the same schema 4.5, which requires it. Now only one writes,
 * `writeIpynb`; the publishing export calls it too
 * (publish/notebook.ts · `notebookFrom`).
 *
 * The format is nbformat 4.5, the same one Jupyter itself writes. It differs
 * from Jupyter in two ways, both deliberate:
 *
 * **Outputs are not written.** A notebook without them opens anywhere and
 * weighs kilobytes; with them it is megabytes of base64 in a file people take
 * home to run again. The same argument as for the publishing export, and it
 * also means that the file on disk is the notebook's SOURCE, not a snapshot
 * of it.
 *
 * **`source` is an array of strings with the line breaks kept.** That is how
 * Jupyter writes it, and that way a git diff of the file reads line by line
 * rather than as one line for the whole cell.
 */
import type { CellType } from './notebook'

export interface FlatCell {
  type: CellType
  source: string
  /**
   * The cell's id, if the writer has one.
   *
   * Optional because parsing does not return it: the room brings in someone
   * else's notebook with cells and ids of its own. On writing, though, it is
   * always needed (see `cellIdFor`), and whoever has it must pass it on —
   * otherwise a file rewritten after cells were reordered renames them.
   */
  id?: string
  /**
   * The cell's attachments in the form nbformat keeps them: name → a set of
   * "type → base64".
   *
   * A picture in a note lives in the file in two ways — as an attachment and
   * right in the text (`data:image/png;base64,…`) — and parsing LOST the first
   * of them: the field was skipped, a `![](attachment:diagram.png)` link
   * reached the room without its bytes and was drawn as a broken frame. Now it
   * gets through, and both kinds land on the room's shelf
   * (server/src/notebook-images.ts).
   *
   * Optional: code never has attachments, and a note almost never does.
   */
  attachments?: Record<string, Record<string, string>>
}

interface RawCell {
  cell_type?: unknown
  source?: unknown
  attachments?: unknown
}

/** Jupyter writes `source` either as a string or as an array of strings — as the mood takes it. */
function sourceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === 'string' ? line : '')).join('')
  }
  return ''
}

/**
 * The cell's attachments — if they are there and look like attachments.
 *
 * Anyone can write the file, and Jupyter keeps the base64 in it either as a
 * string or as an array of strings, just like `source`. Anything that does not
 * fit "name → type → string" is dropped silently: a broken attachment is a
 * picture that will not be there, not a reason to refuse the whole notebook.
 */
function readAttachments(value: unknown): Record<string, Record<string, string>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, Record<string, string>> = {}
  for (const [name, bundle] of Object.entries(value as Record<string, unknown>)) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) continue
    const parts: Record<string, string> = {}
    for (const [mime, body] of Object.entries(bundle as Record<string, unknown>)) {
      const text = sourceText(body)
      if (text) parts[mime] = text
    }
    if (Object.keys(parts).length > 0) out[name] = parts
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Cells from a .ipynb.
 *
 * `raw` becomes markdown: in course notebooks it is prose, and a cell type
 * the product cannot draw would otherwise vanish silently — losing the
 * teacher's text is worse than showing it in the wrong font.
 *
 * Empty cells at the end are dropped: they are a trace of the editor that
 * saved the file, not something somebody wrote. Empty cells IN THE MIDDLE
 * stay, and that matters more than it seems: a template "# Task 1 → an empty
 * cell for the answer → # Task 2 → …" is half made of them. Dropping them all
 * would silently bring into the room nothing but problem statements with no
 * place for a solution, and in a lecture (structure: host) the student has no
 * way to add the cell back.
 */
export function readIpynb(json: unknown): FlatCell[] {
  const doc = json as { cells?: unknown } | null
  const cells = Array.isArray(doc?.cells) ? doc.cells : []
  const all: FlatCell[] = (cells as RawCell[]).map((raw) => {
    const attachments = readAttachments(raw?.attachments)
    return {
      type: raw?.cell_type === 'code' ? 'code' : 'markdown',
      source: sourceText(raw?.source),
      ...(attachments ? { attachments } : {}),
    }
  })
  let end = all.length
  while (end > 0 && all[end - 1].source.trim().length === 0) end -= 1
  return all.slice(0, end)
}

/** Parse the file's text. `null` — this is not a .ipynb, whatever the name says. */
export function parseIpynb(text: string): FlatCell[] | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object' || !Array.isArray((json as { cells?: unknown }).cells)) {
    return null
  }
  return readIpynb(json)
}

/**
 * A cell id in the form schema 4.5 accepts.
 *
 * `nbformat_minor: 5` requires an `id` on every cell — without one
 * `nbformat.read` complains with MissingIDFieldWarning and adds its own, and
 * `nbformat.validate` (autograding, a student's CI) simply fails. The schema
 * allows `^[a-zA-Z0-9-_]{1,64}$`: ours fit, but they come from the room's
 * document, that is, from anyone — whatever does not fit is replaced with the
 * cell's ordinal number.
 */
const ID_OK = /^[a-zA-Z0-9-_]{1,64}$/
const cellIdFor = (cell: FlatCell, index: number): string =>
  cell.id !== undefined && ID_OK.test(cell.id) ? cell.id : `cell-${index + 1}`

export function writeIpynb(cells: readonly FlatCell[]): string {
  const notebook = {
    cells: cells.map((cell, index) => ({
      id: cellIdFor(cell, index),
      cell_type: cell.type,
      metadata: {},
      /*
       * Attachments go next to the text that refers to them.
       *
       * Otherwise a notebook taken out of the room would open for the student
       * with empty frames instead of the problem statement: in the room's
       * document the picture is a link to the shelf (shared/images.ts), and
       * the shelf stayed on the server. Schema 4.5 keeps attachments only on
       * markdown — code never has them.
       */
      ...(cell.type === 'markdown' && cell.attachments && Object.keys(cell.attachments).length > 0
        ? { attachments: cell.attachments }
        : {}),
      source: cell.source.split(/(?<=\n)/),
      ...(cell.type === 'code' ? { execution_count: null, outputs: [] } : {}),
    })),
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
  return JSON.stringify(notebook, null, 1) + '\n'
}
