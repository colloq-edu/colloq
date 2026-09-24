/**
 * pdf.js arrives only when a PDF is opened in the room.
 *
 * One and a half megabytes: 448 KB of the library itself and 1.2 MB of the
 * worker. That is more than the rest of the room's interface, and only whoever
 * actually opened a document should pay for it — not thirty people on the
 * sign-in screen. The same trick as `render.svelte.ts` and `syntax.svelte.ts`,
 * and for the same reason.
 *
 * Rendering happens in a worker, not on the main thread: an A4 page with
 * vector graphics takes tens of milliseconds, and doing that where the
 * notebook and the sockets live means stalling other people's presses.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface Pdf {
  /**
   * Open a document by address.
   *
   * By address precisely, not by bytes: pdf.js can do range requests, and a
   * forty-megabyte lecture shows its first page without waiting for the last.
   * The token goes in a header — in the query string it would stay in proxy
   * logs.
   */
  open(url: string, token: string): Promise<PDFDocumentProxy>
}

let loaded: Pdf | null = null
let inFlight: Promise<Pdf> | null = null

async function importPdf(): Promise<Pdf> {
  /*
   * The narrowing happens in the `.then` parameter, as in render.svelte.ts:
   * handing Rollup the whole module means making it treat every export of the
   * package as live.
   */
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist').then(
    ({ getDocument, GlobalWorkerOptions }) => ({
      getDocument,
      GlobalWorkerOptions,
    }),
  )
  /*
   * The worker lies as a separate file in public/ and does not go through the
   * bundler.
   *
   * It weighs 365 KB gzipped, and the performance gate (`scripts/perf.mts`)
   * holds a 250 KB ceiling on the largest chunk in `dist/assets` — over ALL
   * chunks, laziness does not save it. A worker put through the bundler would
   * turn the gate red forever.
   *
   * The copy is refreshed by a build step (`npm run pdf:worker`), not by a
   * one-off copy: once it drifts from the library by version, pdf.js fails in
   * the console, and an empty area is left on screen.
   */
  GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs'

  return {
    open(url, token) {
      return getDocument({
        url,
        // In a header, not the query string: in the query string it would
        // settle in proxy logs. The files route accepts both.
        httpHeaders: { Authorization: `Bearer ${token}` },
        /*
         * Do not pull the whole document in advance: a forty-megabyte lecture
         * must show its first page at once and fetch the rest as the reader
         * gets to it.
         */
        disableAutoFetch: true,
      }).promise
    },
  }
}

/**
 * Idempotent: opening a second document does not pull the library again.
 *
 * But a failure is not cached: one and a half megabytes over seminar Wi-Fi do
 * get cut off — and a cached rejection would mean the reader in this tab would
 * NEVER open again, not even for another file. The next opening tries again.
 */
export function loadPdf(): Promise<Pdf> {
  return (inFlight ??= importPdf()
    .then((ready) => {
      loaded = ready
      return ready
    })
    .catch((err: unknown) => {
      inFlight = null
      throw err
    }))
}

/** The library, if it is already here. A read inside `$derived` redraws on arrival. */
export function pdf(): Pdf | null {
  return loaded
}
