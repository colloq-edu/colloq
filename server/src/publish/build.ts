/**
 * Building the public page from what the room recorded.
 *
 * There are two promises here, and both are kept by enumeration, not by
 * subtraction.
 *
 * WHAT GOES OUT is a whitelist of fields. The document has four roots, and
 * the notebook is only one of them: `chat` carries the names of everyone who
 * asked the Oracle, `terminal` everything anyone typed into the shell. The
 * same inside a cell: `runBy` and `runById` sit on every cell that ran. A
 * field added to the notebook tomorrow must not end up on the public page by
 * itself, which is why the list of fields here is spelled out.
 *
 * WHAT CAN BE A STEP is only a version that unfolds into at least one cell.
 * That is not caution: for rooms recorded by an old build the history base
 * was taken from an empty document, and everything before the fix unfolds
 * into nothing. An empty page for a student is impossible not because someone
 * took care of it, but because such a step does not build.
 */
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { readNotebook, type CellOutput, type CellSnapshot } from '@shared/notebook'
import {
  BLOB_MIN_BYTES,
  BLOB_PREFIX,
  SPILL_MIMES,
  spillEncoding,
  type PublicCell,
  type SkipReason,
} from '@shared/publish'
import { readBlob, roomOfDoc } from '../blobs.js'
import {
  applyEdits,
  findAttachmentRefs,
  findWorkspaceImages,
  shaOfAttachment,
  type TextEdit,
} from '@shared/images'
import { readBytes } from '../workspace.js'
import { openReplay } from './replay.js'

/** Large pieces of outputs, moved out by hash. Filled as the build goes. */
export interface BlobBag {
  /**
   * A piece of an output bundle, in the form the kernel sent it.
   *
   * The encoding comes from `spillEncoding`: an image arrives as base64, a
   * plotly figure as JSON text. Parsing text as base64 means garbage in the
   * record and an empty frame on the page, the very trouble that keeps SVG
   * out of here.
   */
  put(mime: string, value: string): string
  /** The same, but as bytes: the room already has the image decoded. */
  putBytes(mime: string, body: Buffer): string
  all(): { hash: string; mime: string; body: Buffer }[]
}

export function newBlobBag(): BlobBag {
  const seen = new Map<string, { mime: string; body: Buffer }>()
  const keep = (mime: string, body: Buffer): string => {
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 32)
    if (!seen.has(hash)) seen.set(hash, { mime, body })
    return `${BLOB_PREFIX}${hash}`
  }
  return {
    put(mime, value) {
      return keep(mime, Buffer.from(value, spillEncoding(mime)))
    },
    putBytes: keep,
    all() {
      return [...seen].map(([hash, v]) => ({
        hash,
        mime: v.mime,
        body: v.body,
      }))
    },
  }
}

/**
 * An output in the form it will take on the page.
 *
 * Large content moves into a separate record: a matplotlib chart is hundreds
 * of kilobytes of base64, identical in every step where its cell did not
 * change. Six steps would give six copies of one image.
 *
 * Only what is listed in `SPILL_MIMES` moves out: raster images and the
 * plotly figure. `image/svg+xml` is deliberately not in the list: it already
 * weighs less than the image the spilling was introduced for.
 */
function projectOutput(output: CellOutput, blobs: BlobBag, sessionId: string | null): CellOutput {
  if (output.kind === 'stream') return { kind: 'stream', name: output.name, text: output.text }
  if (output.kind === 'error') {
    return {
      kind: 'error',
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback,
    }
  }
  const data: Record<string, string> = {}
  for (const [mime, value] of Object.entries(output.data)) {
    data[mime] =
      typeof value === 'string' && value.length >= BLOB_MIN_BYTES && SPILL_MIMES.has(mime)
        ? blobs.put(mime, value)
        : value
  }
  /*
   * An image moved out of the room's document moves into the publication
   * itself.
   *
   * A publication is a separate object with its own lifetime: it survives both
   * the deletion of the seminar (`orphanPublication`) and export to static
   * hosting, where there is no room shelf at all. So the bytes do not stay
   * where they were taken from but are copied into the publication's records,
   * exactly as a base64 image lying in the document would be copied.
   *
   * If they are not found (the room was deleted between the reference and the
   * build), the bundle simply has no entry: the page shows `text/plain`, not a
   * broken frame.
   */
  for (const blob of output.blobs ?? []) {
    if (data[blob.mime] !== undefined) continue
    const body = sessionId ? readBlob(sessionId, blob.sha) : null
    if (body) data[blob.mime] = blobs.putBytes(blob.mime, body)
  }
  /*
   * By enumeration, not by spread: outputs gain fields over time too (who got
   * it, which council attempt it came from), and `{ ...output }` would silently
   * carry each of them onto the public page, exactly against the file header.
   * The list is spelled out here for the same reason as for the cell.
   */
  return { kind: 'data', data, execCount: output.execCount }
}

/**
 * A note on the public page: its images go into the publication's records.
 *
 * In the room's document a note's image is a reference to the room's shelf
 * (`attachment:<sha>.<ext>`, see shared/images.ts), and the room's shelf is
 * not reachable from the public page and will not necessarily outlive it. So
 * the bytes are copied into the publication's records, exactly as an output
 * image is copied a line below, and the text keeps its address there.
 *
 * The extension in the address comes from the mime, not from the reference
 * name: the directory export names the file on disk by it
 * (`render.ts · blobHref`), and the two must not diverge.
 */
function projectNote(source: string, blobs: BlobBag, sessionId: string | null): string {
  const edits: TextEdit[] = []
  for (const ref of findAttachmentRefs(source)) {
    const sha = shaOfAttachment(ref.name)
    if (!sha) continue
    const body = sessionId ? readBlob(sessionId, sha) : null
    if (!body) continue
    const mime = mimeOfAttachment(ref.name)
    const value = blobs.putBytes(mime, body)
    edits.push({ start: ref.start, end: ref.end, text: `${value}.${extOfMime(mime)}` })
  }
  /*
   * And an image lying as a FILE in the seminar folder:
   * `![diagram](assets/fig01.png)`.
   *
   * It moves here for the same reason everything else does: the page has to
   * open on Wednesday evening, when the teacher's laptop is closed, and the
   * seminar folder lives exactly as long as the room. Leaving the path as is
   * would mean exporting a page with a dead link to `assets/fig01.png`, which
   * is not next to it and never will be.
   *
   * Only what is surely an image (`NOTE_MIMES`) and fits under the cap is
   * read: `![](data/train.csv.gz)` in a note is not an image but a gigabyte
   * and a half into memory in the middle of building a publication. Whatever
   * was not read stays a path, just as before this change.
   */
  for (const ref of findWorkspaceImages(source)) {
    const mime = mimeOfNotePath(ref.path)
    if (!mime) continue
    const body = sessionId ? readBytes(sessionId, ref.path, MAX_NOTE_IMAGE_BYTES) : null
    if (!body) continue
    const value = blobs.putBytes(mime, body)
    edits.push({ start: ref.start, end: ref.end, text: `${value}.${extOfMime(mime)}` })
  }
  return applyEdits(source, edits)
}

const NOTE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

function mimeOfAttachment(name: string): string {
  return NOTE_MIMES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'image/png'
}

/**
 * The type of a file from the seminar folder, or `null` if it is not an image
 * at all.
 *
 * It differs from `mimeOfAttachment` in its default, and deliberately: the
 * attachment name was issued by the product itself, and "unknown extension
 * means png" is a correct guess there. A path in a note is written by a
 * person, and an unfamiliar extension there means exactly what it says: it is
 * not an image, and there is no reason to take it into the publication.
 */
function mimeOfNotePath(path: string): string | null {
  return NOTE_MIMES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? null
}

/**
 * The cap for a note image. Eight megabytes is enough for any diagram;
 * anything bigger is no longer an illustration but a dataset that has no
 * place in a page.
 */
const MAX_NOTE_IMAGE_BYTES = 8 * 1024 * 1024

const extOfMime = (mime: string): string => mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'

/** A cell on the public page. A whitelist; see the file header. */
function projectCell(cell: CellSnapshot, blobs: BlobBag, sessionId: string | null): PublicCell {
  return {
    id: cell.id,
    type: cell.type,
    source: cell.type === 'markdown' ? projectNote(cell.source, blobs, sessionId) : cell.source,
    outputs: cell.outputs.map((o) => projectOutput(o, blobs, sessionId)),
    /*
     * The execution count is carried over as is, including `null` with a
     * non-empty output. That is not missing data but a fact: the result is on
     * the screen, while the execution responsible for it is gone, the kernel
     * was restarted or a version restored. The page says "Out [—]" about it,
     * and lying here is worse than staying silent.
     */
    execCount: cell.execCount,
    ranMs: cell.ranMs,
  }
}

/**
 * The notebook as of version `seq`, or the reason it is not there.
 *
 * There are two reasons, and they differ. "Empty" is a fact about the class:
 * the notebook had no cells at that moment, and no step can come of it.
 * "Unreadable" is a breakage: the history row exists, but nothing can unfold
 * it. Both used to give `null`, the route silently skipped the step, and a
 * teacher who marked seven moments got a page with six, without a word about
 * which one went missing and why, and without a trace in the server log.
 */
export type BuiltPage = { ok: true; cells: PublicCell[] } | { ok: false; reason: SkipReason }

function* walkPages(
  sessionId: string,
  seqs: number[],
  blobs: BlobBag,
): Generator<[number, BuiltPage]> {
  const replay = openReplay(sessionId)
  try {
    // In ascending order: only then does the pass go through one document. The
    // rail's order is chosen by the teacher, and whoever asked puts it back
    // together.
    for (const seq of [...new Set(seqs)].sort((a, b) => a - b)) {
      let page: BuiltPage
      try {
        const cells = readNotebook(replay.at(seq))
        page =
          cells.length === 0
            ? { ok: false, reason: 'empty' }
            : { ok: true, cells: cells.map((c) => projectCell(c, blobs, sessionId)) }
      } catch (err) {
        // Into the log, not into silence: a corrupted history row is
        // indistinguishable from an empty notebook only until someone says so
        // out loud.
        console.error(`publish: step ${sessionId}#${seq} did not build`, err)
        page = { ok: false, reason: 'broken' }
      }
      yield [seq, page]
    }
  } finally {
    replay.close()
  }
}

/**
 * Pages of several versions at once, with one document for the whole
 * publication.
 *
 * A publication has up to forty steps (`MAX_STEPS`), and each used to unfold
 * in its own `Y.Doc` from the nearest keyframe: a notebook with images is
 * megabytes per step, that is, up to forty full replays of the history in a
 * row. Synchronously, and in the same process where a colleague is teaching a
 * lesson at that minute: their clicks waited.
 *
 * Here the history is replayed once (`replay.ts`), and only the rows between
 * the previous step and the next are applied on top of the previous step's
 * state. The answer is a page for every requested `seq`, including those that
 * will not become a step: `BuiltPage` names the reason for skipping, not
 * silence.
 */
export function pagesAt(sessionId: string, seqs: number[], blobs: BlobBag): Map<number, BuiltPage> {
  return new Map(walkPages(sessionId, seqs, blobs))
}

/**
 * The same, yielding the event loop between steps.
 *
 * After this change the history is replayed once, but page projection is
 * still done per step: a hash of every image, base64 to bytes, a walk over
 * every output. Over forty steps that alone holds the loop for seconds, and a
 * class is running next to it. The database is read exactly the same way: the
 * pass queries it itself, a row per step, and notices a history trimmed
 * mid-way by its keyframe (see `replay.ts`).
 */
export async function pagesAtAsync(
  sessionId: string,
  seqs: number[],
  blobs: BlobBag,
): Promise<Map<number, BuiltPage>> {
  const pages = new Map<number, BuiltPage>()
  for (const [seq, page] of walkPages(sessionId, seqs, blobs)) {
    pages.set(seq, page)
    await new Promise<void>((resume) => setImmediate(resume))
  }
  return pages
}

/** One page. The same pass as the publication's, one step long. */
export function buildPageAt(sessionId: string, seq: number, blobs: BlobBag): BuiltPage {
  return pagesAt(sessionId, [seq], blobs).get(seq) ?? { ok: false, reason: 'broken' }
}

/** The same, in short: a page or nothing. */
export function pageAt(sessionId: string, seq: number, blobs: BlobBag): PublicCell[] | null {
  const built = buildPageAt(sessionId, seq, blobs)
  return built.ok ? built.cells : null
}

/** The notebook as it is right now: the publication's last page. */
export function pageOfDoc(doc: Y.Doc, blobs: BlobBag): PublicCell[] {
  /*
   * The room comes from the document, not from a parameter.
   *
   * Images live on the room's shelf (server/blobs.ts), and to put them into the
   * publication we need to know whose they are. Asking the caller would mean
   * dragging the id through every call for the sake of one branch; the room's
   * document knows its own name from the moment it is bound to disk.
   */
  return readNotebook(doc).map((c) => projectCell(c, blobs, roomOfDoc(doc)))
}
