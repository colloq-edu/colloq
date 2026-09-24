/**
 * Note images come from the room's shelf, not from the document.
 *
 * Parsing the text lives in `shared/images.ts` (both sides read it); this is
 * the disk side: put the bytes on the shelf (`blobs.ts`) when a notebook is
 * brought into the room, take them back when a file is exported, and once
 * unload a room document that had gathered images before this machinery
 * existed.
 *
 * WHY. The room document travels whole to everyone who joins and lands whole
 * in every snapshot. A lecture notebook whose problem statements are drawn as
 * images is 9.4 MB of base64 in the sources of markdown cells (measured on a
 * snapshot of the live room `pvhu2h7f`: a 10.5 MB document, of which 9.09 MB
 * are images in the text of one notebook). At that weight the server closed
 * lagging sockets, and a student on a slow connection never caught up with
 * the room at all.
 *
 * THE PRICE. A link instead of an image means a second request for the bytes
 * and a key to the shelf (routes/blobs.ts), that is, the room has to be able
 * to show them. For the same reason the export has to put them back as
 * attachments: a file taken home opens without our server.
 */
import { Buffer } from 'node:buffer'
import * as Y from 'yjs'
import {
  applyEdits,
  attachmentName,
  findAttachmentRefs,
  findInlineImages,
  INLINE_IMAGE_FROM_CHARS,
  shaOfAttachment,
  type TextEdit,
} from '@shared/images'
import type { FlatCell } from '@shared/ipynb'
import { allCellArrays } from '@shared/notebook'
import { putBlob, readBlob } from './blobs.js'
import { seldom } from './log.js'

/** The content type by the tail of an attachment name: the inverse of `extForMime`. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

function mimeOfName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Put this cell's images on the shelf, leaving links in the text.
 *
 * Both forms at once, because both occur in the same file: an nbformat
 * attachment (`attachments` + `![](attachment:name.png)`) and an image right
 * in the text (`![](data:image/png;base64,…)`). On the shelf they become the
 * same thing: bytes by their hash.
 *
 * Returns the cell without `attachments`: the bytes are already on the shelf,
 * and there must be no second copy of them in the document; that is what all
 * this was started for.
 */
export function shelveCellImages(sessionId: string, cell: FlatCell): FlatCell {
  if (cell.type !== 'markdown') return cell
  let source = cell.source
  source = shelveAttachments(sessionId, source, cell.attachments)
  source = shelveInline(sessionId, source)
  const out: FlatCell = { ...cell, source }
  delete out.attachments
  return out
}

/** nbformat attachments: the bytes go on the shelf, the link to their name there. */
function shelveAttachments(
  sessionId: string,
  source: string,
  attachments: FlatCell['attachments'],
): string {
  if (!attachments) return source
  const edits: TextEdit[] = []
  for (const ref of findAttachmentRefs(source)) {
    // Already our name: the file came from our own export, and the bytes are on the shelf.
    if (shaOfAttachment(ref.name)) continue
    const bundle = attachments[ref.name]
    if (!bundle) continue
    const picked = Object.entries(bundle).find(([mime]) => mime.startsWith('image/'))
    if (!picked) continue
    const [mime, base64] = picked
    const body = Buffer.from(base64, 'base64')
    if (body.length === 0) continue
    const stored = putBlob(sessionId, body)
    // It did not make it to disk, so let the link stay as it was: a broken
    // image is better than losing the text around it, and we deliver the
    // attachment with the file anyway.
    if (!stored) continue
    edits.push({
      start: ref.start,
      end: ref.end,
      text: `attachment:${attachmentName(stored.sha, mime)}`,
    })
  }
  return applyEdits(source, edits)
}

/** An image lying in the text as content goes on the shelf. */
function shelveInline(sessionId: string, source: string): string {
  const edits: TextEdit[] = []
  for (const image of findInlineImages(source, INLINE_IMAGE_FROM_CHARS)) {
    const body = Buffer.from(image.base64, 'base64')
    if (body.length === 0) continue
    const stored = putBlob(sessionId, body)
    if (!stored) continue
    edits.push({
      start: image.start,
      end: image.end,
      text: `attachment:${attachmentName(stored.sha, image.mime)}`,
    })
  }
  return applyEdits(source, edits)
}

/**
 * Put the images back into the cell, as attachments, the way nbformat keeps
 * them.
 *
 * This is exactly what makes the file portable: Jupyter understands an
 * `attachment:<sha>.png` link by itself if an attachment with the same name
 * lies next to it. A link with nothing on the shelf for it (the image was put
 * there by another room, from which the notebook was brought as a file) stays
 * in the text as is: it is visible, and that is more honest than erasing it
 * silently.
 */
export function inlineCellImages(sessionId: string, cell: FlatCell): FlatCell {
  if (cell.type !== 'markdown') return cell
  const attachments: Record<string, Record<string, string>> = { ...(cell.attachments ?? {}) }
  let found = false
  for (const ref of findAttachmentRefs(cell.source)) {
    if (attachments[ref.name]) continue
    const sha = shaOfAttachment(ref.name)
    if (!sha) continue
    const body = readBlob(sessionId, sha)
    if (!body) continue
    attachments[ref.name] = { [mimeOfName(ref.name)]: body.toString('base64') }
    found = true
  }
  if (!found && !cell.attachments) return cell
  return { ...cell, attachments }
}

/* -------------------------------------------------------- unloading a room */

/**
 * Unload the room's document once, on open.
 *
 * The import puts images on the shelf from now on, but rooms created earlier
 * carry them inside and will carry them until the end of the semester: the
 * document lives in the database, not in a file. Hence at room start, before
 * the history begins (collab/index.ts), so that the edit lands in the base
 * point instead of showing up to the room as someone else's version.
 *
 * Idempotent by construction: after the first pass the text holds links, and
 * `findInlineImages` finds nothing; a second pass does not write to the
 * document at all, and so wakes neither the snapshot nor the notebook's
 * projection to disk.
 *
 * Silent if there is nothing to change, and once to the log if there was: a
 * line on every room open is noise that makes people stop reading the log.
 */
export function shelveRoomImages(sessionId: string, doc: Y.Doc): number {
  let moved = 0
  let bytes = 0
  doc.transact(() => {
    for (const cells of allCellArrays(doc)) {
      cells.forEach((cell: Y.Map<any>) => {
        if (cell.get('type') !== 'markdown') return
        const text = cell.get('source')
        if (!(text instanceof Y.Text)) return
        const source = text.toString()
        const images = findInlineImages(source, INLINE_IMAGE_FROM_CHARS)
        if (images.length === 0) return
        /*
         * From the end: an edit changes the text's length, and the bounds
         * computed on the source would shift after the very first replacement.
         */
        for (const image of [...images].reverse()) {
          const body = Buffer.from(image.base64, 'base64')
          if (body.length === 0) continue
          const stored = putBlob(sessionId, body)
          if (!stored) continue
          text.delete(image.start, image.end - image.start)
          text.insert(image.start, `attachment:${attachmentName(stored.sha, image.mime)}`)
          moved += 1
          bytes += image.base64.length
        }
      })
    }
  }, 'server')
  if (moved > 0 && seldom(`shelve-images-${sessionId}`, 60 * 60_000)) {
    console.log(
      `[blobs ${sessionId}] images moved from cell text to the shelf: ${moved}, ` +
        `document lighter by ${Math.round(bytes / 1024)} KB`,
    )
  }
  return moved
}

/** Notebook cells with links unfolded into attachments, for export as a file. */
export function withInlinedImages(sessionId: string, cells: readonly FlatCell[]): FlatCell[] {
  return cells.map((cell) => inlineCellImages(sessionId, cell))
}
