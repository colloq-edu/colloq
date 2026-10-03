/**
 * A SLIDE'S TITLE, read from the PDF itself.
 *
 * The console answers "what comes next" in words as well as with a picture:
 * the notes footer and the teleprompter bar say "NEXT · 15 X-ray: lying or
 * standing". A thumbnail answers it only for someone who looks at it long
 * enough to read it, and the presenter glances.
 *
 * There is no title field in a PDF page, so the title is what a slide makes
 * a title: the run of text set in the largest type on the page. Slides out of
 * Keynote, PowerPoint, Beamer and Google Slides all keep their text as text,
 * and their heading is the biggest type there; a scanned deck has no text at
 * all, and then there is no title rather than a wrong one.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { acquirePage, releasePage } from '@/lib/pdf-pages'

/** What pdf.js gives per text run; only these fields are read. */
export interface TextRun {
  str: string
  /** The text matrix: [a, b, c, d, e, f]; the type size is the length of (c, d). */
  transform: number[]
  height?: number
}

/** Runs within this share of the largest size count as the same title type. */
const SAME_SIZE = 0.88
/** A title longer than this is a paragraph that happened to be large. */
const MAX_CHARS = 140

function sizeOf(run: TextRun): number {
  const [, , c = 0, d = 0] = run.transform
  const fromMatrix = Math.hypot(c, d)
  return fromMatrix > 0 ? fromMatrix : (run.height ?? 0)
}

/**
 * The title out of a page's text runs: the largest type, in reading order.
 *
 * Page numbers and footers are small type, so they drop out by size alone; a
 * lone digit set large (a section number) is skipped as well, since "3" read
 * as the next slide's title says nothing.
 */
export function titleFromRuns(runs: readonly TextRun[]): string {
  const words = runs.filter((run) => run.str.trim() !== '')
  if (words.length === 0) return ''
  const largest = Math.max(...words.map(sizeOf))
  if (!(largest > 0)) return ''
  const title = words
    .filter((run) => sizeOf(run) >= largest * SAME_SIZE)
    .map((run) => run.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^[\d\s.·/|-]*$/.test(title)) return ''
  return title.length > MAX_CHARS ? `${title.slice(0, MAX_CHARS - 1).trimEnd()}…` : title
}

/*
 * Per document, per page: a deck is read once per lecture, and the footer
 * asks for the same "next" on every render. A WeakMap so a closed document
 * takes its titles with it.
 */
const known = new WeakMap<PDFDocumentProxy, Map<number, Promise<string>>>()

/**
 * The title of `page`, or '' when the page has no text or does not exist.
 *
 * The page is borrowed from the shared cache (lib/pdf-pages.ts) and given back
 * at once: the text is all that is needed, and a page kept decoded for a title
 * is the memory leak the cache exists to prevent.
 */
export function slideTitle(doc: PDFDocumentProxy, page: number): Promise<string> {
  if (page < 1 || page > doc.numPages) return Promise.resolve('')
  let pages = known.get(doc)
  if (!pages) {
    pages = new Map()
    known.set(doc, pages)
  }
  const cached = pages.get(page)
  if (cached) return cached
  const read = (async (): Promise<string | null> => {
    const sheet = await acquirePage(doc, page)
    if (!sheet) return null
    try {
      const text = await sheet.getTextContent()
      // Marked-content entries carry no text; only the runs are titles' stuff.
      return titleFromRuns(text.items.filter((item) => 'str' in item) as TextRun[])
    } catch {
      return null
    } finally {
      releasePage(doc, page)
    }
  })()
  /*
   * A page that did not arrive is not remembered (the next ask tries again),
   * while a page with no text is: a scanned deck has no titles, and asking
   * it again on every page turn would only cost a text extraction.
   */
  const asked = read.then((title) => {
    if (title === null) pages.delete(page)
    return title ?? ''
  })
  pages.set(page, asked)
  return asked
}
