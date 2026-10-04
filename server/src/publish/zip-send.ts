/**
 * Sending an archive: the class page's «Скачать всё», a folder of it, and a
 * competition's open data. One door for all of them, because all of them read
 * the same disk on the class's process and stand in the same line
 * (zip.ts · waitForZip).
 */
import { pipeline } from 'node:stream/promises'
import type { NextFunction, Response } from 'express'
import { tr } from '@shared/i18n'
import { ROBOTS_TAG } from '@shared/publish'
import { leaveZip, waitForZip, ZIP_IDLE_MS, zipStream, type ZipPlan } from './zip.js'

/**
 * `filename*` per RFC 5987, plus a plain `filename` for clients that know
 * only that one: «Слайды лекции.pdf» must not arrive as `download`.
 */
export function disposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'download'
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * An archive, through the line (zip.ts · waitForZip): three at a time per
 * key and six per instance, the rest wait for a slot, and only one that
 * waited too long hears «через минуту». A stream that stops moving is
 * dropped, so a paused download cannot keep a slot from the class.
 *
 * `plan` is asked after the wait, against things as they are then: a page
 * may have been rebuilt or withdrawn, a competition's files replaced, while
 * the download waited. An `error` from it is a 404 in those words.
 */
export function sendArchive(
  res: Response,
  next: NextFunction,
  key: string,
  plan: () => Promise<{ plan: ZipPlan } | { error: string }> | { plan: ZipPlan } | { error: string },
  label = 'pages',
): void {
  const gone = new AbortController()
  let entered = false
  let left = false
  const leave = () => {
    if (!entered || left) return
    left = true
    leaveZip(key)
  }
  // Before the answer this means the client left the line; after it, the download ended.
  res.on('close', () => {
    gone.abort()
    leave()
  })
  waitForZip(key, { signal: gone.signal })
    .then(async (admitted) => {
      if (!admitted) {
        if (gone.signal.aborted) return
        res.setHeader('retry-after', '60')
        res.status(429).json({ error: tr('server.zip.busy') })
        return
      }
      entered = true
      if (gone.signal.aborted) return leave()
      const made = await plan()
      if (gone.signal.aborted) return leave()
      if ('error' in made) {
        leave()
        res.status(404).json({ error: made.error })
        return
      }
      const archive = made.plan
      res.setHeader('content-type', 'application/zip')
      res.setHeader('content-length', String(archive.bytes))
      res.setHeader('content-disposition', disposition('attachment', `${archive.top}.zip`))
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('x-robots-tag', ROBOTS_TAG)
      res.setHeader('cache-control', 'no-cache')
      /*
       * The socket's idle timer: it fires when no bytes have moved for the
       * whole span, which is exactly a reader that stopped reading
       * (backpressure leaves the writes pending). Destroying the response
       * fires 'close' above, which frees the slot.
       */
      res.setTimeout(ZIP_IDLE_MS, () => res.destroy())
      pipeline(zipStream(archive), res).catch((err: unknown) => {
        if (!res.writableEnded) {
          const why = err instanceof Error ? err.message : err
          console.error(`[${label}] archive ${archive.top}.zip of ${key} broke off:`, why)
        }
        res.destroy()
      })
    })
    .catch((err: unknown) => {
      leave()
      next(err)
    })
}
