/**
 * How to show an output record — as an image, as markup or as text.
 *
 * Moved out of CellOutputs for the sake of one line: the set of raster types is
 * no longer a second literal but the very `BLOB_MIMES` that publishing uses to
 * decide what to move out into separate records. The comment next to the old
 * list promised that the sets matched ("and that is no coincidence"), but
 * nothing tied them together: a type added to `BLOB_MIMES` would arrive on a
 * published page as an address and be drawn, while in a live room it would
 * arrive as base64 and stop being drawn at all — `pickMime` would not choose
 * it.
 */
import { BLOB_MIMES } from '@shared/publish'
import { PLOTLY_MIME } from '@shared/plotly'
import type { CellOutput, OutputBlob } from '@shared/notebook'

/**
 * Raster images — the ones `<img>` shows.
 *
 * The order is the order of `BLOB_MIMES`, and it also becomes the start of
 * `MIME_ORDER`: the set is spelled out there, and the `content-type` of a blob
 * response is built from it as well, so there is exactly one list in the
 * product.
 */
export const IMG_MIMES: readonly string[] = [...BLOB_MIMES]

/*
 * Preference order for a rich result. The second list is what we can show
 * before the sanitizer exists: a data URI needs no sanitizing, and text/plain
 * goes out as text — SVG, HTML and markdown wait, because rendering any of
 * them unsanitized is not a trade worth one frame.
 *
 * `text/markdown` sits between markup and text, and both sides matter.
 *
 * `display(Markdown("**Solution**: …"))` is the usual way to caption an output
 * in a teaching notebook, and the kernel sends TWO representations: the markup
 * itself and `text/plain` with the repr
 * `<IPython.core.display.Markdown object>`. While markdown was not in this
 * list, `text/plain` won, and in place of the output the person read a class
 * name — the output was there and at the same time was not.
 *
 * Below `text/html`: if a library sent both, the ready-made markup is more
 * precise — it was assembled by someone who knows how it should look.
 */
/*
 * The plotly figure comes before everything, and this is not "interactive beats
 * static".
 *
 * The kernel sends it ALONE: the bundle from current plotly has neither
 * `text/plain` nor an image — only `application/vnd.plotly.v1+json`. Until this
 * line was here, `pickMime` found nothing familiar and returned `null`, and
 * `null` is drawn as empty space: a cell with `px.histogram(...)` output
 * nothing.
 *
 * It stands ahead of images for the case of a bundle that has both
 * (`pio.renderers.default = "plotly_mimetype+png"`): a chart that can be turned
 * around is what it was written for, and a snapshot of the same chart shows
 * less.
 */
const MIME_ORDER = [PLOTLY_MIME, ...IMG_MIMES, 'image/svg+xml', 'text/html', 'text/markdown', 'text/plain']
const MIME_ORDER_PLAIN = [PLOTLY_MIME, ...IMG_MIMES, 'text/plain']

export function pickMime(data: Record<string, string>, rich: boolean): string | null {
  for (const mime of rich ? MIME_ORDER : MIME_ORDER_PLAIN) if (data[mime]) return mime
  return Object.keys(data).find((mime) => mime.startsWith('text/')) ?? null
}

/**
 * An output whose moved-out images are replaced with addresses.
 *
 * A large image in a live room does not lie in the document — there is a link
 * there (`shared/notebook.ts · OutputBlob`), and the bytes are served by the
 * server. It is shown exactly like moved-out content on a published page: an
 * address in the mime bundle, and from there everything as usual — `pickMime`,
 * `asImage`, `imageSrc`.
 *
 * No key yet (the first image arrived before the answer to the key request) —
 * the record is simply not substituted: the choice gets down to `text/plain`,
 * that is, to "<Figure size 640x480>", not to a broken frame. As soon as the
 * key appears, a re-render puts the address in.
 */
export function withBlobs(
  output: CellOutput,
  src: (blob: OutputBlob) => string | null,
): CellOutput {
  if (output.kind !== 'data' || !output.blobs || output.blobs.length === 0) return output
  const data: Record<string, string> = { ...output.data }
  let put = false
  for (const blob of output.blobs) {
    // The mime's own value in the bundle outranks the link: if the kernel sent
    // both, what should be shown is what has already arrived.
    if (data[blob.mime] !== undefined) continue
    const address = src(blob)
    if (!address) continue
    data[blob.mime] = address
    put = true
  }
  return put ? { ...output, data } : output
}

/**
 * Not the content itself, but the address where it lies.
 *
 * The third case after base64 and data URI: on a published page large images
 * are moved out into separate records, and the bundle holds
 * `/api/p/<pub>/blob/<hash>`.
 *
 * Recognised by `/api/`, not by a single slash: the base64 of any JPEG starts
 * with "/9j/" — that is how SOI FF D8 FF is encoded — and going by the slash, a
 * photo from the CV seminar went into src as a raw payload, that is, as a
 * broken icon for the whole room. PNG was saved only by its own first letter.
 */
export function isAddress(payload: string): boolean {
  return payload.startsWith('/api/')
}

/**
 * Whether to show this record as an image.
 *
 * Not only by mime. The neighbouring branches render the value as markup (SVG,
 * HTML) or as text, so an address that got into either of them would be printed
 * as the line "/api/p/…/blob/…" in place of the chart. What exactly a
 * publication moves out into records is decided by the server, and that list
 * may grow — while anything that was moved out can be shown as an image fetched
 * by address.
 */
export function asImage(mime: string, payload: string): boolean {
  // The plotly figure also travels by link (`SPILL_MIMES`), and its address
  // looks exactly the same. There is nothing to show it with as an image: what
  // lies at the address is JSON, and `<img>` would draw a broken frame in place
  // of the chart. The type outranks the shape of the value.
  if (mime === PLOTLY_MIME) return false
  return IMG_MIMES.includes(mime) || isAddress(payload)
}

/** Kernels send bare base64; a few libraries send a full data URI already. */
export function imageSrc(mime: string, payload: string): string {
  if (payload.startsWith('data:') || isAddress(payload)) return payload
  return `data:${mime};base64,${payload.replace(/\s/g, '')}`
}

/**
 * An image is not clipped.
 *
 * The threshold is counted in lines of text, and an image is not lines: a
 * clipped chart keeps its bottom axis and labels under the edge, and the button
 * promises "Show more" — as if there were more output below, rather than the
 * rest of the same image. A grid from make_grid and a retina figure taller than
 * 460 pixels are routine at a seminar. Tables and text still collapse: for them
 * there really is a continuation below the edge.
 */
export function isPicture(output: CellOutput, rich: boolean): boolean {
  if (output.kind !== 'data') return false
  const mime = pickMime(output.data, rich)
  if (mime === null) return false
  // A plotly chart is not lines either: clipping it at the edge means hiding
  // the bottom axis under a "Show more" button that supposedly has more output
  // behind it.
  if (mime === PLOTLY_MIME) return true
  return IMG_MIMES.includes(mime) || mime === 'image/svg+xml'
}

/**
 * Whether anything that the person will SEE is left after the sanitizer.
 *
 * The question is not idle, and not about plotly alone. Bokeh, folium, altair
 * without an image, ipywidgets, plotly with an old renderer — all of them send
 * `text/html` whose entire content lies in `<script>`, and Colloq does not
 * execute scripts from outputs (SECURITY.md: a cell's output is produced by
 * anyone who is allowed to run). After the sanitizer, such a record leaves an
 * empty `<div>` — and on screen an empty space that reads as "the cell printed
 * nothing".
 *
 * An empty space is the one answer that must not appear here; what exactly to
 * say instead is decided by CellOutputs.
 *
 * Computed by the same rule as on the published page
 * (`server/src/publish/render.ts · hasVisible`), plus tags that are visible
 * even without text inside.
 */
const VISIBLE_TAGS = /<(?:img|svg|canvas|video|audio|iframe|table|hr|input|object|embed)\b/i

export function hasVisibleMarkup(markup: string): boolean {
  if (VISIBLE_TAGS.test(markup)) return true
  return /\S/.test(markup.replace(/<[^>]*>/g, ''))
}
