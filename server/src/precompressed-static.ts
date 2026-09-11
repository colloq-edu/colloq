import path from 'node:path'
import { stat } from 'node:fs/promises'
import type { RequestHandler } from 'express'
import { preferredEncodings } from './http-encoding.js'

async function fileInfo(file: string) {
  try {
    const info = await stat(file)
    return info.isFile() ? info : null
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

/** Serve optional build artifacts at the original URL, with ordinary static fallback. */
export function precompressedStatic(directory: string): RequestHandler {
  const root = path.resolve(directory)
  return (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || req.headers.range) return next()
    let relative: string
    try { relative = decodeURIComponent(req.path).replace(/^\/+/, '') } catch { return next() }
    // Only application assets, never API responses, workspace files or the SPA HTML.
    if (!(relative.startsWith('assets/') || relative === 'pdf/pdf.worker.min.mjs')) return next()
    if (!/\.(?:m?js|css|svg|json)$/.test(relative) || relative.includes('\0')) return next()
    if (relative.split(/[\\/]/).some(part => part === '..' || part === '.')) return next()
    const encodings = preferredEncodings(req.headers['accept-encoding'])
    if (encodings.length === 0) return next()
    const original = path.resolve(root, relative)
    if (!original.startsWith(root + path.sep)) return next()

    void (async () => {
      const source = await fileInfo(original)
      if (!source) return next()
      for (const encoding of encodings) {
        const file = original + (encoding === 'br' ? '.br' : '.gz')
        const compressed = await fileInfo(file)
        // An ordinary rebuild or manually updated worker must not use stale bytes.
        if (!compressed || compressed.mtimeMs < source.mtimeMs) continue
        res.vary('Accept-Encoding')
        res.type(path.extname(original))
        res.setHeader('Content-Encoding', encoding)
        res.setHeader('Cache-Control', relative.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600')
        res.sendFile(file, { acceptRanges: false, cacheControl: false }, error => {
          if (!error) return
          if (!res.headersSent) {
            res.removeHeader('Content-Encoding')
            res.removeHeader('Content-Length')
          }
          next(error)
        })
        return
      }
      next()
    })().catch(next)
  }
}
