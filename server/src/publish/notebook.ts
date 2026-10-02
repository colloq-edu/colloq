/**
 * A published notebook as an .ipynb file, WITH its outputs.
 *
 * The room has no export at all, and selecting across cells is impossible
 * (each is its own editor), so this download is how a student takes a
 * seminar home. It used to carry the code only, on the argument that the
 * first thing anyone does is press "Run" anyway. A student on a phone, or
 * one without the data, or the same student a month later, wants exactly
 * what the class saw: the tables, the plots, the traceback the teacher
 * explained. So outputs go in, as nbformat has them: stream, display_data,
 * execute_result and error, with execution counts.
 *
 * Images that the page keeps out of line (`blob:<hash>`, publication_blobs)
 * are put back inline as base64, and note images become nbformat
 * attachments: the file has to open with every picture in place on a laptop
 * that never saw the server.
 *
 * The file itself is written by the shared `writeIpynb` (shared/ipynb.ts),
 * the same writer the room uses, so the two cannot drift apart.
 */
import { writeIpynb, type FlatCell } from '@shared/ipynb'
import { BLOB_MIMES, SPILL_MIMES, type PublicCell } from '@shared/publish'
import { PLOTLY_MIME } from '@shared/plotly'

/** Where the bytes behind a `blob:<hash>` reference come from. */
export type BlobSource = (hash: string) => { mime: string; body: Buffer } | null

const NOTE_BLOB = /blob:([0-9a-f]{32})\.([a-z0-9]+)/g
const OUTPUT_BLOB = /^blob:([0-9a-f]{32})$/

/** A note's `blob:<hash>.<ext>` images as attachments, and the text pointing at them. */
function noteCell(cell: PublicCell, blob: BlobSource): FlatCell {
  const attachments: Record<string, Record<string, string>> = {}
  const source = cell.source.replace(NOTE_BLOB, (whole, hash: string, ext: string) => {
    const found = blob(hash)
    if (!found) return whole
    const name = `${hash}.${ext}`
    attachments[name] = { [found.mime]: found.body.toString('base64') }
    return `attachment:${name}`
  })
  return {
    id: cell.id,
    type: 'markdown',
    source,
    ...(Object.keys(attachments).length > 0 ? { attachments } : {}),
  }
}

const isJsonMime = (mime: string): boolean =>
  mime === 'application/json' || mime.endsWith('+json')

/**
 * One value of a mime bundle as nbformat wants it: images as base64, JSON
 * types as JSON, everything else as text. `undefined` drops the entry: a
 * reference whose bytes are gone is better absent than a broken picture.
 */
function bundleValue(mime: string, value: string, blob: BlobSource): unknown {
  // Only what the build moves out can be a reference: a printed "blob:…" is text.
  const ref = SPILL_MIMES.has(mime) ? OUTPUT_BLOB.exec(value) : null
  if (ref) {
    const found = blob(ref[1])
    if (!found) return undefined
    if (BLOB_MIMES.has(mime)) return found.body.toString('base64')
    const text = found.body.toString('utf8')
    if (mime === PLOTLY_MIME || isJsonMime(mime)) return parseOr(text)
    return text
  }
  return isJsonMime(mime) ? parseOr(value) : value
}

function parseOr(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function codeCell(cell: PublicCell, blob: BlobSource): FlatCell {
  const outputs: unknown[] = []
  for (const output of cell.outputs) {
    if (output.kind === 'stream') {
      outputs.push({ output_type: 'stream', name: output.name, text: output.text })
    } else if (output.kind === 'error') {
      outputs.push({
        output_type: 'error',
        ename: output.ename,
        evalue: output.evalue,
        traceback: output.traceback,
      })
    } else {
      const data: Record<string, unknown> = {}
      for (const [mime, value] of Object.entries(output.data)) {
        if (typeof value !== 'string') continue
        const converted = bundleValue(mime, value, blob)
        if (converted !== undefined) data[mime] = converted
      }
      if (Object.keys(data).length === 0) continue
      outputs.push(
        output.execCount !== null && output.execCount !== undefined
          ? { output_type: 'execute_result', execution_count: output.execCount, data, metadata: {} }
          : { output_type: 'display_data', data, metadata: {} },
      )
    }
  }
  return { id: cell.id, type: 'code', source: cell.source, outputs, executionCount: cell.execCount }
}

/** The notebook as a student downloads it from the class page. */
export function notebookWithOutputs(cells: readonly PublicCell[], blob: BlobSource): string {
  return writeIpynb(
    cells.map((cell) => (cell.type === 'markdown' ? noteCell(cell, blob) : codeCell(cell, blob))),
  )
}
