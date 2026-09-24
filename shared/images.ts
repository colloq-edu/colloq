/**
 * Pictures inside a text cell — by the same trick as pictures in outputs.
 *
 * For outputs this was solved long ago: a matplotlib chart goes to the shelf
 * next to the room, and the document keeps a link of about a hundred and
 * fifty bytes (server/src/blobs.ts · `shared/notebook.ts · OutputBlob`). For a
 * NOTE it was not solved, and that cost more: a lecture notebook whose
 * problems are drawn as pictures arrives in the room as a .ipynb file, and in
 * the file the picture sits right in the cell's text —
 * `![](data:image/png;base64,…)` or as an nbformat attachment
 * (`attachments`). Measured on a live room: a 10.5 MB document, 9.4 MB of
 * which was base64 in the sources of markdown cells. That document travels
 * WHOLE to everyone who comes in, and a student on a slow link never caught
 * up with the room.
 *
 * Here is only the parsing of text, with no disk and no network: the browser
 * and the server must agree on where a note has a picture and what it is
 * called.
 *
 * THE LINK FORM is `attachment:<sha256>.<ext>`, and it is deliberately
 * nbformat's own form, not our address. First, the file on disk stays a
 * notebook Jupyter will open: the export puts `attachments` with the same
 * names next to it (see server/src/notebook-images.ts). Second, the room's
 * address (`/api/sessions/<id>/blobs/<sha>`) cannot live in a cell's text: a
 * notebook moves between rooms, and every room has its own shelf — the link
 * would survive the move broken.
 *
 * MARKDOWN ONLY. In code, `data:image/png;base64,…` is a string a person
 * wrote, and replacing it with a link would mean silently rewriting someone
 * else's program. So everything here is called only for text cells.
 */

import { normalizePath } from './paths.js'

/**
 * Pictures smaller than this stay in the document.
 *
 * The same threshold as for outputs (`BLOB_FROM_CHARS` in
 * server/src/kernel/outputs.ts): an icon of a couple of kilobytes is cheaper
 * in the document than a second request for it.
 */
export const INLINE_IMAGE_FROM_CHARS = 16 * 1024

/** A piece of text to replace. */
export interface TextEdit {
  start: number
  end: number
  text: string
}

/** A picture that sits in the text as its own content. */
export interface InlineImage {
  /** The bounds of the whole `data:…;base64,…` in the source. */
  start: number
  end: number
  mime: string
  base64: string
}

/*
 * Whitespace inside base64 is NOT matched, ON PURPOSE.
 *
 * In a cell's text a picture stands on one line — that is how both Jupyter
 * and editors write it; a line break in the middle of the address would mean
 * that what follows is no longer the address, and a greedy parse would eat
 * the neighboring paragraph.
 */
const DATA_URI = /data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})/g

/**
 * `attachment:<name>` links — in the form nbformat writes them.
 *
 * An attachment's name is the name of the file a person dragged into the
 * cell, and it can be anything: "схема.png", "Рис 1.png". So there is no list
 * of allowed characters (every Cyrillic name broke on it) but a list of those
 * at which a name has certainly ended: a markdown bracket, an attribute
 * quote, a space.
 */
const ATTACHMENT_REF = /attachment:([^\s)\]"'<>]+)/g

/** The file extension for a content type — for the attachment's name. */
export function extForMime(mime: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  return known[mime] ?? 'bin'
}

/** An attachment's name from the hash of its content. It is also the name of the shelf entry. */
export function attachmentName(sha: string, mime: string): string {
  return `${sha}.${extForMime(mime)}`
}

/** The hash from an attachment's name — or `null` if the name is not ours. */
export function shaOfAttachment(name: string): string | null {
  const sha = /^([0-9a-f]{64})\.[A-Za-z0-9]+$/.exec(name)
  return sha ? sha[1] : null
}

/**
 * Pictures that sit in the text as content.
 *
 * `minChars` is about the length of the base64, not the weight of the
 * picture: the decision is made before decoding, because decoding a megabyte
 * to decide "is it worth it" is exactly the work we are getting away from.
 */
export function findInlineImages(source: string, minChars = 0): InlineImage[] {
  const found: InlineImage[] = []
  for (const match of source.matchAll(DATA_URI)) {
    const base64 = match[2]
    if (base64.length < minChars) continue
    const start = match.index ?? 0
    found.push({ start, end: start + match[0].length, mime: match[1], base64 })
  }
  return found
}

/** Names of the attachments the text refers to. */
export function findAttachmentRefs(source: string): { start: number; end: number; name: string }[] {
  const found: { start: number; end: number; name: string }[] = []
  for (const match of source.matchAll(ATTACHMENT_REF)) {
    const start = match.index ?? 0
    found.push({ start, end: start + match[0].length, name: match[1] })
  }
  return found
}

/**
 * Apply the replacements all at once.
 *
 * From the end: a replacement changes the length of the string, and an edit
 * computed against the source would shift after the very first one before it.
 */
export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = source
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/**
 * A picture lying as a FILE in the seminar folder: `![diagram](assets/fig01.png)`.
 *
 * The third way to put a picture into a note, and until now the only one that
 * did not work. The first two arrive here from a .ipynb and go to the shelf —
 * `data:` in the text and an nbformat attachment (see the file header). This
 * one never arrives from a .ipynb at all: the notebook file does not contain
 * it, only a path to a neighboring file that Jupyter reads from disk next to
 * the notebook.
 *
 * In the room such a path stayed as written, and the browser resolved it
 * against the page address: `/s/<room>/assets/fig01.png`. The app sits there,
 * and it answers any path with its `index.html` — that is, 200 and
 * `text/html`. The picture was not drawn, and the network did not even show a
 * 404: a success with nothing to show for it.
 *
 * The path is NOT rewritten in the cell's text — unlike the shelf. The shelf
 * gets an `attachment:<sha>` link because the content moved and the old link
 * no longer exists; here the file lies next to the notebook just as it did,
 * and a `.ipynb` with `assets/fig01.png` inside must open in Jupyter exactly
 * the same. The address is substituted only while the note is displayed.
 */
export interface WorkspaceImage {
  /** The bounds of the PATH in the source — without brackets, quotes or the `![…]` itself. */
  start: number
  end: number
  /** The same path, brought to the `shared/paths` canon. */
  path: string
}

/*
 * Two ways to write a picture, and both are needed: `![…](path)` from markdown
 * and `<img src="…">` from the markup notes now render. In both, the group
 * captures what stands BEFORE the path — so its start is computed by adding
 * lengths rather than by searching for a substring:
 * `![assets/x.png](assets/x.png)` would otherwise find the first occurrence,
 * that is, the caption instead of the address.
 */
const MD_IMAGE = /(!\[[^\]]*\]\(\s*)([^)\s]+)/g
const IMG_SRC = /(<img\b[^<>]*?\bsrc\s*=\s*)("[^"]*"|'[^']*'|[^\s"'<>]+)/gi

/** An address that does not lead to us: another scheme, the site root, an anchor. */
const NOT_A_FILE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\/|#)/

/**
 * A path to a seminar file — or `null` if it is not one at all.
 *
 * A leading `./` is stripped, but `..` is not forgiven: the first is the same
 * folder written differently (half of all notebooks write it that way), the
 * second is a way out of it, and the `shared/paths` canon rejects it outright.
 */
export function workspacePathOf(raw: string): string | null {
  if (!raw || NOT_A_FILE.test(raw)) return null
  let value = raw.replace(/^(?:\.\/)+/, '')
  // Markdown writes a space in a file name as `%20`; an attribute, as a space.
  try {
    value = decodeURIComponent(value)
  } catch {
    /* It does not decode — so it is not escaping but the text itself. */
  }
  return normalizePath(value) || null
}

export function findWorkspaceImages(source: string): WorkspaceImage[] {
  const found: WorkspaceImage[] = []
  const add = (start: number, raw: string): void => {
    const path = workspacePathOf(raw)
    if (path) found.push({ start, end: start + raw.length, path })
  }
  for (const match of source.matchAll(MD_IMAGE)) {
    add((match.index ?? 0) + match[1].length, match[2])
  }
  for (const match of source.matchAll(IMG_SRC)) {
    const value = match[2]
    const quoted = value.startsWith('"') || value.startsWith("'")
    const at = (match.index ?? 0) + match[1].length + (quoted ? 1 : 0)
    add(at, quoted ? value.slice(1, -1) : value)
  }
  return found
}
