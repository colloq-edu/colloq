import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { basename } from 'node:path'
import busboy from 'busboy'
import { Router } from 'express'
import { config } from '../config.js'
import { getSession } from '../db.js'
import { baseOf, joinPath, normalizePath, safeSegment, whySegmentRefused } from '@shared/paths'
import { forgetFile } from '../collab/files.js'
import { dropBook, isBookFile } from '../collab/books.js'
import {
  deleteFile,
  listTree,
  resolveInSession,
  sessionBytes,
  statPath,
  sweepStaleUploads,
} from '../workspace.js'
import { broadcastFiles } from '../control.js'
import { signDownloadToken, verifyDownloadToken } from '../auth.js'
import { currentStaff } from '../admin/auth.js'
import { sessionAuth } from './sessions.js'
import { allows, CLASS_IS_OVER } from '@shared/rules'
import { getRules, isFinished } from '../db.js'

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
    // Вместе с признаком обрезки: список, упёршийся в потолок, — это не «в
    // комнате столько файлов», и решать по нему, что чего-то не стало, нельзя.
    res.json(listTree(req.params.id))
  })

  router.post('/api/sessions/:id/files', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    /*
     * Либо участник комнаты, либо преподаватель этого инстанса.
     *
     * Второе понадобилось, когда материалы стало можно прикреплять при
     * создании семинара: панель ходит с печеньем преподавателя и токена
     * участника у неё нет — она в комнату не заходила. Печенье при этом
     * credential не слабее, а сильнее: оно отзывается удалением из списка
     * преподавателей, а токен участника живёт своей жизнью. Ровно тот же довод
     * записан в sessions.ts над проверкой роли.
     */
    const joined = sessionAuth(req)
    if (!joined && !currentStaff(req)) {
      return res.status(401).json({ error: 'join the session first' })
    }
    // Роль решается тут же: печенье преподавателя сильнее токена участника, и
    // человек, вошедший в комнату до входа в панель, — всё равно преподаватель.
    const role = currentStaff(req) ? 'host' : (joined?.role ?? 'participant')
    if (!allows(getRules(sessionId).files, role)) {
      // Законченное занятие ужесточает `files` само (db.getRules); отдельная тут
      // только фраза — человеку важно не правило, а то, что пара кончилась.
      // Скачивание и чтение ниже не трогаются: после пары в файлы и ходят.
      return res.status(403).json({
        error: isFinished(sessionId)
          ? CLASS_IS_OVER
          : 'Файлы в эту комнату добавляет преподаватель.',
      })
    }

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
        limits: {
          fileSize: config.maxUploadBytes,
          files: MAX_FILES_PER_UPLOAD,
          fields: 4,
          fieldSize: 4096,
        },
      })
    } catch {
      return res.status(400).json({ error: 'malformed upload' })
    }

    /*
     * В какую папку кладём. Поле формы, а не часть имени файла: имя приходит из
     * файловой системы того, кто перетаскивает, и дописывать в него путь значит
     * зависеть от того, что браузер положил в `filename`. Приходит раньше самих
     * файлов, потому что панель добавляет его в форму первым; клиент, который
     * так не делает, кладёт в корень — и это честный ответ, а не тихая ошибка.
     */
    let intoDir = ''
    bb.on('field', (name, value) => {
      if (name !== 'dir') return
      const wanted = normalizePath(typeof value === 'string' ? value : '')
      if (wanted !== null) intoDir = wanted
    })

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
     * Потолок закрывает загрузку, но не ячейку.
     *
     * Ячейка пишет в тот же каталог напрямую из ядра — `open('big.bin','wb')`
     * мимо этой проверки, — и настоящая граница у диска одна: лимит на том
     * рядом с mem_limit и pids_limit, которых у /workspace нет. Здесь мы
     * останавливаем то, что можем остановить: случайную папку, уроненную в
     * окно, а не злой умысел.
     */

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
      if (failure)
        return res.status(failure.code).json({ error: failure.message, ...listTree(sessionId) })
      res.json({ ...listTree(sessionId), replaced })
    }

    bb.on('file', (_field, stream, info) => {
      /*
       * Имя меряется той же меркой, что и всё остальное в дереве.
       *
       * Раньше загрузка спрашивала свою мерку (двести символов, пробел с краю
       * можно), а `resolveInSession` следом — `safeSegment` (сто двадцать,
       * нельзя): имя в сто пятьдесят символов, каких полно в выгрузках из LMS,
       * отвергалось фразой «cannot be used as a file name here», не называвшей
       * ни причины, ни потолка. Папку из `filename` браузера по-прежнему
       * срезаем: путь приходит полем `dir`, а не именем файла.
       */
      const name = basename(info.filename ?? '')
      if (!safeSegment(name)) {
        failure ??= { code: 400, message: whySegmentRefused(name) }
        stream.resume()
        return
      }
      const rel = joinPath(intoDir, name)
      const target = resolveInSession(sessionId, rel)
      if (!target) {
        failure ??= {
          code: 400,
          message: `${name} некуда положить: «${rel}» слишком длинный путь.`,
        }
        stream.resume()
        return
      }
      const folder = target.slice(0, target.lastIndexOf('/'))
      /*
       * Папка могла не существовать — панель умеет перетащить файл на новую. А
       * могла быть занята файлом: `dir=data.csv` при лежащем `data.csv` — это
       * EEXIST (а `data.csv/sub` — ENOTDIR) прямо из обработчика потока, мимо
       * express, то есть `uncaughtException` и `process.exit(1)` на весь
       * инстанс со всеми его семинарами. Любой отказ файловой системы здесь —
       * это `failure` с кодом, а не исключение.
       */
      const at = intoDir ? statPath(sessionId, intoDir) : null
      if (at && !at.dir) {
        failure ??= {
          code: 400,
          message: `«${intoDir}» — файл, а не папка: положить в него ${name} нельзя.`,
        }
        stream.resume()
        return
      }
      try {
        fs.mkdirSync(folder, { recursive: true })
      } catch {
        failure ??= { code: 400, message: `Не удалось завести папку «${intoDir}» под ${name}.` }
        stream.resume()
        return
      }
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
      const tmp = `${folder}/.${name}.uploading-${randomBytes(6).toString('hex')}`
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
            /*
             * Поверх тетради комнаты не ложится ничто.
             *
             * Файл тетради — проекция документа: он переписывается из комнаты
             * через секунду после любой правки. Принять загрузку значило бы
             * показать «загружено» и молча вернуть прежнее содержимое — худший
             * вид отказа. Внести тетрадь заново можно, убрав её из комнаты.
             */
            if (isBookFile(sessionId, rel)) {
              fs.rmSync(tmp, { force: true })
              failure ??= {
                code: 409,
                message: `${name} — тетрадь этой комнаты. Её правят в ней самой, а не загрузкой.`,
              }
              resolve()
              return
            }
            /*
             * Заменить чужой файл — это удалить его, а удаление уже
             * преподавательское. Дыра была ровно такой ширины: DELETE
             * спрашивал роль, а загрузка файла с тем же именем — нет.
             */
            if (existed && role !== 'host') {
              fs.rmSync(tmp, { force: true })
              failure ??= {
                code: 403,
                message: `${name} уже есть в этой комнате — заменить его может преподаватель.`,
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

  /**
   * Скачать файл.
   *
   * Путь — в строке запроса, а не в адресе, и это единственный способ адресовать
   * файл во всём продукте. Косая черта внутри имени в адресе живёт только в
   * виде `%2F`, а его по дороге разворачивает то один прокси, то другой — и
   * `src/model.py` превращается либо в две части пути, либо в 404 в
   * зависимости от того, что стоит перед сервером. Строка запроса не
   * нормализуется никем.
   */
  router.get('/api/sessions/:id/file', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    const wanted = normalizePath(typeof req.query.path === 'string' ? req.query.path : '')
    if (!wanted) return res.status(400).json({ error: 'bad path' })
    /*
     * Either a header from a fetch, or the file's own short-lived token in the
     * query string — the anchor case. What is not accepted here is the session
     * token in a URL: it opens the control socket, and a link with it in is a
     * link that hands Restart to whoever it is forwarded to.
     */
    const ticket = typeof req.query.token === 'string' ? req.query.token : ''
    const allowed = sessionAuth(req) !== null || verifyDownloadToken(sessionId, wanted, ticket)
    if (!allowed) return res.status(401).json({ error: 'join the session first' })
    const full = resolveInSession(sessionId, wanted)
    if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'file not found' })
    res.download(full, baseOf(wanted), (err) => {
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
  router.get('/api/sessions/:id/file/ticket', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    if (!sessionAuth(req)) return res.status(401).json({ error: 'join the session first' })
    const wanted = normalizePath(typeof req.query.path === 'string' ? req.query.path : '')
    if (!wanted) return res.status(400).json({ error: 'bad path' })
    const full = resolveInSession(sessionId, wanted)
    if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'file not found' })
    res.json({ token: signDownloadToken(sessionId, wanted) })
  })

  /**
   * Убрать файл или папку.
   *
   * Право преподавателя, и было им и раньше: папка общая в обе стороны, и любой
   * в комнате мог убрать раздатку, по которой класс работает. Добавить — прибавка
   * и остаётся открытой всем; убрать — нет.
   */
  router.delete('/api/sessions/:id/file', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })
    const who = sessionAuth(req)
    if (!who) return res.status(401).json({ error: 'join the session first' })
    if (who.role !== 'host') {
      return res.status(403).json({ error: 'Only the teacher can remove a file from the room.' })
    }
    const wanted = normalizePath(typeof req.query.path === 'string' ? req.query.path : '')
    if (!wanted) return res.status(400).json({ error: 'bad path' })
    if (!deleteFile(sessionId, wanted)) {
      return res.status(404).json({ error: 'file not found' })
    }
    forgetFile(sessionId, wanted)
    dropBook(sessionId, wanted)
    broadcastFiles(sessionId)
    res.json(listTree(sessionId))
  })

  return router
}
