import fs from 'node:fs'
import busboy from 'busboy'
import { Router } from 'express'
import { config } from '../config.js'
import { getSession } from '../db.js'
import { deleteFile, listFiles, resolveInSession } from '../workspace.js'
import { broadcastFiles } from '../control.js'
import { sessionAuth } from './sessions.js'

interface UploadFailure {
  code: number
  message: string
}

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

    let bb: ReturnType<typeof busboy>
    try {
      bb = busboy({
        headers: req.headers,
        limits: { fileSize: config.maxUploadBytes, files: 8, fields: 4, fieldSize: 4096 },
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
        failure ??= { code: 400, message: 'unusable file name' }
        stream.resume()
        return
      }
      const name = target.slice(target.lastIndexOf('/') + 1)
      const out = fs.createWriteStream(target)
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
            failure ??= { code: 500, message: `could not write ${name}` }
            resolve()
          })
          out.on('close', () => {
            // A truncated file is worse than no file: pandas would happily read
            // half a CSV and nobody would notice until the numbers were wrong.
            if (truncated) {
              fs.rmSync(target, { force: true })
              failure ??= {
                code: 413,
                message: `${name} is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`,
              }
            } else {
              saved.push(name)
            }
            resolve()
          })
          stream.pipe(out)
        }),
      )
    })

    bb.on('filesLimit', () => {
      failure ??= { code: 400, message: 'too many files in one upload' }
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
