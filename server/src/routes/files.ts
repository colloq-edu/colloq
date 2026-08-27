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
  sessionBytes,
  sweepStaleUploads,
  whyRefused,
} from '../workspace.js'
import { broadcastFiles } from '../control.js'
import { signDownloadToken, verifyDownloadToken } from '../auth.js'
import { sessionAuth } from './sessions.js'

interface UploadFailure {
  code: number
  message: string
}

/** One drop, one armful. Past this the panel's progress rows stop being readable. */
const MAX_FILES_PER_UPLOAD = 8

export function fileRoutes(): Router {
  const router = Router()

  /*
   * Reading the room's folder needs the same credential as writing to it.
   *
   * These two GETs used to need nothing at all: anybody who knew a seminar id
   * could list every file in it and download them. And a seminar id is eight
   * characters — short on purpose, because the link gets read aloud — so it is
   * guessable, not secret. The folder holds whatever the teacher dropped in for
   * the class and whatever the class uploaded, which is exactly the material
   * that should not leave the room.
   */
  router.get('/api/sessions/:id/files', (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: 'session not found' })
    if (!sessionAuth(req)) return res.status(401).json({ error: 'join the session first' })
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
    /** Имена, которые легли поверх уже лежавших: об этом надо сказать вслух. */
    const replaced: string[] = []
    const writes: Promise<void>[] = []
    /** Все недописанные файлы этого запроса — их надо убрать, чем бы он ни кончился. */
    const temps = new Set<string>()
    let failure: UploadFailure | null = null
    let answered = false
    /*
     * Место, занятое комнатой до этой загрузки.
     *
     * Считается один раз: пока идёт запрос, растёт оно только от него самого, а
     * пересчёт каталога на каждый файл — это лишний readdir на каждый файл.
     * Дальше к нему прибавляется то, что уже записано в этом же заходе.
     */
    let budgetUsed = sessionBytes(sessionId)

    /*
     * Оборванная загрузка не должна лечь поверх целого файла.
     *
     * Клиент, ушедший на середине, не поднимает 'limit' — это про размер, — и
     * поток файла в busboy при этом просто кончается. Дальше срабатывал
     * обычный путь: переименовать temp на место. Половина CSV ложилась поверх
     * целого, pandas читал её без ошибки, и о потере узнавали по числам.
     */
    let aborted = false
    req.on('aborted', () => {
      aborted = true
      failure ??= { code: 400, message: 'the upload was cut off' }
      // Отвечать некому, но временные файлы убрать всё равно надо.
      void Promise.all(writes).then(() => {
        for (const tmp of temps) fs.rmSync(tmp, { force: true })
      })
    })

    const finish = () => {
      if (answered) return
      answered = true
      if (saved.length > 0) broadcastFiles(sessionId)
      // Всё, что не доехало до места, убирается здесь: обрыв на середине
      // запроса не даёт сработать ни одному из путей выше.
      for (const tmp of temps) fs.rmSync(tmp, { force: true })
      if (failure) return res.status(failure.code).json({ error: failure.message, files: listFiles(sessionId) })
      res.json({ files: listFiles(sessionId), replaced })
    }

    bb.on('file', (_field, stream, info) => {
      const target = resolveInSession(sessionId, info.filename ?? '')
      if (!target) {
        failure ??= { code: 400, message: whyRefused(info.filename ?? '') }
        stream.resume()
        return
      }
      const name = target.slice(target.lastIndexOf('/') + 1)
      // Заметить, что имя занято, до того как его займут: после rename не отличить.
      const existed = fs.existsSync(target)
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
      temps.add(tmp)
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
            if (aborted) {
              fs.rmSync(tmp, { force: true })
              resolve()
              return
            }
            /*
             * Потолок на комнату целиком, а не на один файл.
             *
             * Проверяется после записи, а не до: размер приходящего файла до
             * конца потока неизвестен, а Content-Length говорит про весь
             * многочастный запрос вместе с границами. Написанный, но не
             * переименованный temp здесь же и удаляется, так что за отказ
             * место не платят.
             */
            let written = 0
            try {
              written = fs.statSync(tmp).size
            } catch {
              /* исчез — разберётся ветка ниже */
            }
            let already = 0
            try {
              already = fs.statSync(target).size
            } catch {
              // Файла с таким именем ещё нет: место под него не освободится.
            }
            if (budgetUsed + written - already > config.maxSessionBytes) {
              fs.rmSync(tmp, { force: true })
              failure ??= {
                code: 413,
                message:
                  `This seminar has room for ${Math.round(config.maxSessionBytes / 1024 / 1024)} MB of files ` +
                  `and ${name} does not fit. Delete something first.`,
              }
              resolve()
              return
            }
            try {
              fs.renameSync(tmp, target)
              budgetUsed += written - already
              saved.push(name)
              if (already > 0 || existed) replaced.push(name)
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
    /*
     * The credential arrives in the query string here rather than in a header,
     * and that is not laziness: a download is an <a href>, and an anchor cannot
     * carry an Authorization header. sessionAuth already accepts either. The
     * token is scoped to this one seminar and the instance sends
     * Referrer-Policy: strict-origin-when-cross-origin, so it does not travel
     * anywhere the link itself does not already go.
     */
    /*
     * Either a header from a fetch, or the file's own short-lived token in the
     * query string — the anchor case. What is no longer accepted here is the
     * session token in a URL: it opens the control socket, and a link with it
     * in is a link that hands Restart to whoever it is forwarded to.
     */
    const ticket = typeof req.query.token === 'string' ? req.query.token : ''
    const allowed = sessionAuth(req) !== null || verifyDownloadToken(sessionId, req.params.name, ticket)
    if (!allowed) return res.status(401).json({ error: 'join the session first' })
    const full = resolveInSession(sessionId, req.params.name)
    if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'file not found' })
    res.download(full, req.params.name, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'file not found' })
    })
  })

  /**
   * A ticket to download one file.
   *
   * The panel asks for it with a header, then puts the ticket in the anchor —
   * so the credential that travels in a URL is good for one file for five
   * minutes, and for nothing else at all.
   */
  router.get('/api/sessions/:id/files/:name/ticket', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    if (!sessionAuth(req)) return res.status(401).json({ error: 'join the session first' })
    const full = resolveInSession(sessionId, req.params.name)
    if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'file not found' })
    res.json({ token: signDownloadToken(sessionId, req.params.name) })
  })

  router.delete('/api/sessions/:id/files/:name', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    const who = sessionAuth(req)
    if (!who) return res.status(401).json({ error: 'join the session first' })
    /*
     * Host only. The folder is shared in both directions — anyone in the room
     * could delete the handout the class was working from, and the trash icon
     * sat in everyone's panel with one confirmation behind it. Adding a file is
     * additive and stays open to all; removing one is not.
     */
    if (who.role !== 'host') {
      return res.status(403).json({ error: 'Only the teacher can remove a file from the room.' })
    }
    if (!deleteFile(sessionId, req.params.name)) {
      return res.status(404).json({ error: 'file not found' })
    }
    broadcastFiles(sessionId)
    res.json({ files: listFiles(sessionId) })
  })

  return router
}
