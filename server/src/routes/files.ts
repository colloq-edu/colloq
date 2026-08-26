import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import busboy from 'busboy'
import { Router } from 'express'
import { config } from '../config.js'
import { getSession } from '../db.js'
import {
  deleteFile,
  listFiles,
  resolveInSession,
  sweepStaleUploads,
  whyRefused,
} from '../workspace.js'
import { broadcastFiles } from '../control.js'
import { sessionAuth } from './sessions.js'

interface UploadFailure {
  code: number
  message: string
}

/** One drop, one armful. Past this the panel's progress rows stop being readable. */
const MAX_FILES_PER_UPLOAD = 8

export function fileRoutes(): Router {
  const router = Router()

  router.get('/api/sessions/:id/files', (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: 'session not found' })
    res.json({ files: listFiles(req.params.id) })
  })

  router.post('/api/sessions/:id/files', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    if (!sessionAuth(req)) return res.status(401).json({ error: 'join the session first' })

    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'expected a multipart/form-data upload' })
    }

    // Before anything is written: an interrupted upload leaves a hidden temp
    // that nothing else will ever remove.
    sweepStaleUploads(sessionId)

    let bb: ReturnType<typeof busboy>
    try {
      bb = busboy({
        headers: req.headers,
        /*
         * Without this busboy reads a filename as latin-1, and a student at a
         * Russian university who uploads `данные.csv` gets `Ð´Ð°Ð½Ð½ÑÐµ.csv`
         * on disk — after which `pd.read_csv('данные.csv')` cannot find their
         * own file. RFC 7578 says the field is UTF-8; this says so too.
         */
        defParamCharset: 'utf8',
        limits: { fileSize: config.maxUploadBytes, files: MAX_FILES_PER_UPLOAD, fields: 4, fieldSize: 4096 },
      })
    } catch {
      return res.status(400).json({ error: 'malformed upload' })
    }

    const saved: string[] = []
    const writes: Promise<void>[] = []
    let failure: UploadFailure | null = null
    let answered = false

    const finish = () => {
      if (answered) return
      answered = true
      if (saved.length > 0) broadcastFiles(sessionId)
      if (failure) return res.status(failure.code).json({ error: failure.message, files: listFiles(sessionId) })
      res.json({ files: listFiles(sessionId) })
    }

    bb.on('file', (_field, stream, info) => {
      const target = resolveInSession(sessionId, info.filename ?? '')
      if (!target) {
        failure ??= { code: 400, message: whyRefused(info.filename ?? '') }
        stream.resume()
        return
      }
      const name = target.slice(target.lastIndexOf('/') + 1)
      /*
       * Written beside the file and renamed over it, never into it.
       *
       * `createWriteStream(target)` truncates first and fills afterwards, so a
       * cell already reading that CSV watched it shrink to nothing and grow
       * again: it read half the rows, finished without an error, and went on
       * with half the data. The same window swallowed the old file whenever an
       * upload was cut off midway — the good copy was gone before the bad one
       * had arrived. A rename inside one directory is atomic: a reader holding
       * the old file reads all of it, and everybody after sees the new one
       * whole. It is the rule the size check below already worked by.
       *
       * The temp name starts with a dot, so a half-finished upload never shows
       * up in the room's file list.
       */
      const tmp = `${target.slice(0, target.lastIndexOf('/'))}/.${name}.uploading-${randomBytes(6).toString('hex')}`
      const out = fs.createWriteStream(tmp)
      writes.push(
        new Promise<void>((resolve) => {
          let truncated = false
          stream.on('limit', () => {
            truncated = true
          })
          stream.on('error', () => {
            failure ??= { code: 400, message: `upload of ${name} failed` }
          })
          out.on('error', () => {
            fs.rmSync(tmp, { force: true })
            failure ??= { code: 500, message: `could not write ${name}` }
            resolve()
          })
          out.on('close', () => {
            // A truncated file is worse than no file: pandas would happily read
            // half a CSV and nobody would notice until the numbers were wrong.
            // Whatever the reason, the half stays in the temp file and the copy
            // the room already had is never touched.
            if (truncated) {
              fs.rmSync(tmp, { force: true })
              failure ??= {
                code: 413,
                message: `${name} is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`,
              }
              resolve()
              return
            }
            try {
              fs.renameSync(tmp, target)
              saved.push(name)
            } catch {
              fs.rmSync(tmp, { force: true })
              failure ??= { code: 500, message: `could not write ${name}` }
            }
            resolve()
          })
          stream.pipe(out)
        }),
      )
    })

    bb.on('filesLimit', () => {
      failure ??= {
        code: 400,
        message: `Up to ${MAX_FILES_PER_UPLOAD} files at a time — drop the rest in a second go.`,
      }
    })

    bb.on('error', () => {
      failure ??= { code: 400, message: 'malformed upload' }
      void Promise.all(writes).then(finish)
    })

    bb.on('close', () => {
      void Promise.all(writes).then(finish)
    })

    req.pipe(bb)
  })

  router.get('/api/sessions/:id/files/:name', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    const full = resolveInSession(sessionId, req.params.name)
    if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'file not found' })
    res.download(full, req.params.name, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'file not found' })
    })
  })

  router.delete('/api/sessions/:id/files/:name', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    if (!sessionAuth(req)) return res.status(401).json({ error: 'join the session first' })
    if (!deleteFile(sessionId, req.params.name)) {
      return res.status(404).json({ error: 'file not found' })
    }
    broadcastFiles(sessionId)
    res.json({ files: listFiles(sessionId) })
  })

  return router
}
