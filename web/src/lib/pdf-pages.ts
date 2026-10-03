/**
 * Pages of a lecture document, handed out with a count and given back.
 *
 * pdf.js keeps everything a page has rendered (its operator list and the
 * decoded images, ImageBitmaps included) until somebody calls
 * `page.cleanup()`. Nothing in the room ever did, so every slide the main
 * sheet, the "next" thumbnail or the page strip touched stayed decoded for the
 * whole lecture. On a hundred-slide deck full of photos that is how an iPad
 * tab reaches Safari's memory ceiling and reloads mid-class, losing the tool
 * the presenter held; the laptop at the projector piles up the same way.
 *
 * Why one shared cache and not "clean up the page you leave": the main
 * sheet, the "next" thumbnail and the strip render THE SAME page proxies. A
 * sheet that cleaned up the slide it left would throw away the operator list
 * the thumbnail had just built for the slide it is turning to, and the next
 * turn would parse it again. So every holder takes a page with `acquirePage`
 * and gives it back with `releasePage`; a page nobody holds waits in a short
 * line (the current one, its neighbours and "next"), and only the one pushed
 * out of that line is cleaned up.
 *
 * `cleanup()` is safe at any moment: it refuses while a render of that page
 * is in flight and finishes by itself when the render ends.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/**
 * How many pages nobody holds stay decoded.
 *
 * Six covers what the console flips between in practice: the current page,
 * one or two back, "next", and the page after it once "next" is reached.
 * More is memory, less is re-parsing a slide the presenter just stepped back
 * to.
 */
export const IDLE_PAGES = 6

/** The part of PDFDocumentProxy this module uses: tests hand in a fake. */
type Source = Pick<PDFDocumentProxy, 'getPage'>
/** The part of PDFPageProxy this module uses. */
type Page = Pick<PDFPageProxy, 'cleanup'>

interface Entry {
  page: Promise<PDFPageProxy>
  users: number
}

interface Cache {
  entries: Map<number, Entry>
  /** Pages nobody holds, oldest first. */
  idle: number[]
}

/*
 * Keyed by the document object itself and weakly: a document is destroyed
 * on a switch (`loadingTask.destroy()`), and its cache must go with it
 * without anyone remembering to drop it.
 */
const caches = new WeakMap<Source, Cache>()

function cacheOf(source: Source): Cache {
  let cache = caches.get(source)
  if (!cache) {
    cache = { entries: new Map(), idle: [] }
    caches.set(source, cache)
  }
  return cache
}

function forget(cache: Cache, index: number): void {
  const at = cache.idle.indexOf(index)
  if (at >= 0) cache.idle.splice(at, 1)
}

/**
 * Take a page and hold it. `null` when the page did not come (the document
 * is still downloading that chunk, or it was destroyed): then nothing is held
 * and nothing must be given back.
 *
 * A failure is not remembered: the next call asks pdf.js again, which is
 * what the callers' retries rely on (see `sheetOf` in LecturePage).
 */
export async function acquirePage(source: Source, index: number): Promise<PDFPageProxy | null> {
  const cache = cacheOf(source)
  let entry = cache.entries.get(index)
  if (!entry) {
    entry = { page: source.getPage(index), users: 0 }
    cache.entries.set(index, entry)
  }
  entry.users += 1
  forget(cache, index)
  const held = entry
  try {
    return await held.page
  } catch {
    held.users -= 1
    if (cache.entries.get(index) === held) cache.entries.delete(index)
    return null
  }
}

/**
 * Give a page back. Called exactly once for every `acquirePage` that
 * returned a page, including when the caller was dropped while waiting.
 */
export function releasePage(source: Source, index: number): void {
  const cache = caches.get(source)
  const entry = cache?.entries.get(index)
  if (!cache || !entry || entry.users === 0) return
  entry.users -= 1
  if (entry.users > 0) return
  forget(cache, index)
  cache.idle.push(index)
  while (cache.idle.length > IDLE_PAGES) {
    const oldest = cache.idle.shift()
    if (oldest === undefined) break
    const gone = cache.entries.get(oldest)
    if (!gone || gone.users > 0) continue
    cache.entries.delete(oldest)
    void gone.page.then(drop, () => {})
  }
}

function drop(page: Page): void {
  try {
    page.cleanup()
  } catch {
    // The document was destroyed under us: its worker already freed everything.
  }
}

/** How many pages of this document are held and decoded: for tests. */
export function pagesHeld(source: Source): { held: number[]; idle: number[] } {
  const cache = caches.get(source)
  if (!cache) return { held: [], idle: [] }
  const held = [...cache.entries].filter(([, entry]) => entry.users > 0).map(([index]) => index)
  return { held: held.sort((a, b) => a - b), idle: [...cache.idle] }
}
