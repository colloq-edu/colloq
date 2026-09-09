import { tr } from '@shared/i18n'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { downloadHeldFile } from '../secure-files.js'
import { basename } from 'node:path'
import busboy from 'busboy'
import { Router } from 'express'
import { config } from '../config.js'
import { getSession } from '../db.js'
import { baseOf, joinPath, normalizePath, safeSegment, whySegmentRefused } from '@shared/paths'
import { forgetFile } from '../collab/files.js'
import { dropBook, isBookFile } from '../collab/books.js'
import {
  workspaceFs,
  deleteFile,
  forgetTree,
  listTree,
  resolveInSession,
  sessionBytes,
  statPath,
  sweepStaleUploads,
} from '../workspace.js'
import { broadcastFiles, forgetMissingBoard } from '../control.js'
import { signDownloadToken, verifyDownloadToken } from '../auth.js'
import { currentStaff, sameOrigin } from '../admin/auth.js'
import { banDoor, sessionAuth } from './sessions.js'
import { allows, CLASS_IS_OVER } from '@shared/rules'
import { SESSION_MISSING } from '@shared/protocol'
import { getRules, isFinished } from '../db.js'

interface UploadFailure {
  code: number
  message: string
}

/** One drop, one armful. Past this the panel's progress rows stop being readable. */
const MAX_FILES_PER_UPLOAD = 8

/**
 * Место, занятое комнатой, — счётчиком на комнату, а не обходом на запрос.
 *
 * `sessionBytes` — рекурсивный обход всей папки с lstat на каждую запись, без
 * потолка на число записей. После `!pip install -t .` или распакованного
 * датасета это десятки тысяч синхронных lstat — в том самом цикле событий,
 * который обслуживает CRDT всех комнат, — и делались они на КАЖДУЮ загрузку.
 * Пятьсот студентов, сдающих CSV в одну минуту, давали пятьсот таких обходов
 * подряд.
 *
 * Считаем один раз и дальше правим на свои же записи и удаления. Свежесть
 * ограничена десятью секундами, потому что ячейка пишет в ту же папку мимо нас
 * (`open('big.bin','wb')`) — это и так за границей потолка, см. комментарий
 * ниже, и десять секунд расхождения тут ничего не меняют.
 *
 * И это же делает потолок общим для одновременных загрузок: раньше каждый
 * запрос читал сумму один раз в начале, поэтому N студентов, нажавших «Отдать»
 * в одну секунду, видели одно и то же старое число и вместе перебирали потолок
 * комнаты в N раз.
 */
const FRESH_MS = 10_000
const measured = new Map<string, { bytes: number; at: number }>()
/** Сколько потоков пишет в комнату прямо сейчас — см. usedBytes. */
const writing = new Map<string, number>()

function usedBytes(sessionId: string): number {
  const known = measured.get(sessionId)
  /*
   * Пока в папке лежат НАШИ недописанные файлы, пересчитывать нельзя: обход
   * посчитает половину приезжающего файла, а целый его размер мы прибавим сами,
   * когда поток закроется, — и место комнаты уехало бы дважды. Пока идёт
   * загрузка, сумму ведут прибавки; заново меряем, когда всё дописано.
   */
  if (known && (Date.now() - known.at < FRESH_MS || writing.has(sessionId))) return known.bytes
  const bytes = sessionBytes(sessionId)
  measured.set(sessionId, { bytes, at: Date.now() })
  return bytes
}

function beganWriting(sessionId: string): void {
  writing.set(sessionId, (writing.get(sessionId) ?? 0) + 1)
}

function endedWriting(sessionId: string): void {
  const left = (writing.get(sessionId) ?? 1) - 1
  if (left > 0) writing.set(sessionId, left)
  else writing.delete(sessionId)
}

/** Своя запись или своё удаление: счётчик правится, а не сбрасывается. */
function noteBytes(sessionId: string, delta: number): void {
  const known = measured.get(sessionId)
  if (known) known.bytes += delta
}

/** Считать заново: папку изменили не мы (удаление, уборка временных). */
function forgetBytes(sessionId: string): void {
  measured.delete(sessionId)
}

/**
 * Уборка брошенных временных файлов — не чаще раза в пять минут на комнату.
 *
 * Порог у самой уборки — час (`sweepStaleUploads`), так что чаще незачем, а
 * стоит она такого же полного обхода папки, как и подсчёт байтов.
 */
const SWEEP_EVERY_MS = 5 * 60_000
const sweptAt = new Map<string, number>()

function sweepSometimes(sessionId: string): void {
  const now = Date.now()
  if (now - (sweptAt.get(sessionId) ?? 0) < SWEEP_EVERY_MS) return
  sweptAt.set(sessionId, now)
  sweepStaleUploads(sessionId)
  // Уборка могла унести чужие недописанные — сумма после неё другая.
  forgetBytes(sessionId)
}

/** Убрать свой временный файл и вернуть комнате его байты. */
function removeTemp(sessionId: string, tmp: string): void {
  let size = 0
  try {
    size = workspaceFs.statSync(tmp).size
  } catch {
    /* его уже нет — вычитать нечего */
  }
  try { workspaceFs.rmSync(tmp, { force: true }) } catch { /* untrusted parent changed */ }
  if (size > 0) noteBytes(sessionId, -size)
}

export function fileRoutes(): Router {
  const router = Router()

  // Закрытый доступ закрыт и здесь: раздатка, скачивание и — главное —
  // загрузка, тот самый спам, за который человека и закрыли (routes/sessions.ts
  // · banDoor).
  router.use('/api/sessions/:id', banDoor)

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
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })
    if (!sessionAuth(req)) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    // Вместе с признаком обрезки: список, упёршийся в потолок, — это не «в
    // комнате столько файлов», и решать по нему, что чего-то не стало, нельзя.
    res.json(listTree(req.params.id))
  })

  /*
   * Единственная запись вне /api/admin, которую авторизует одно печенье.
   *
   * Проверка `sameOrigin` висела только на префиксе /api/admin — и комментарий
   * над ней объясняет её ровно тем, что «помнить про неё на каждом новом
   * маршруте» не выйдет. Этот маршрут и не вспомнил: печенье преподавателя
   * пускает сюда без токена участника, то есть межсайтовый POST с чужой
   * страницы клал бы файл в папку семинара, и держал бы его только SameSite=Lax
   * браузера. Запрос без заголовка Origin (curl, скрипт) проходит как и раньше:
   * межсайтовым он не бывает.
   */
  router.post('/api/sessions/:id/files', sameOrigin, (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
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
      return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
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
          ? tr(CLASS_IS_OVER)
          : tr("server.onlyTheTeacherMayAddFilesTo.2b4b09"),
      })
    }

    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: tr("server.expectedAMultipartFormDataUpload.ccb3d0") })
    }

    // Before anything is written: an interrupted upload leaves a hidden temp
    // that nothing else will ever remove. Раз в несколько минут на комнату —
    // порог у самой уборки час, а стоит она обхода всей папки.
    sweepSometimes(sessionId)
    // И место комнаты — до того, как этот запрос заведёт свои временные файлы:
    // дальше сумму ведут прибавки, а не обход (см. usedBytes).
    usedBytes(sessionId)

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
      return res.status(400).json({ error: tr("server.malformedUpload.084748") })
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
    /** Открытые сейчас потоки записи: обрыв закрывает их руками, см. ниже. */
    const open = new Set<fs.WriteStream>()
    let failure: UploadFailure | null = null
    let answered = false
    /*
     * Потолок — на комнату целиком и общий для всех, кто пишет в неё сейчас
     * (см. usedBytes): место считается счётчиком комнаты, а временный файл уже
     * лежит в её папке, поэтому две одновременные загрузки видят друг друга.
     *
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
    /*
     * Обрыв закрываем сами — иначе не закроется никто.
     *
     * Здесь стояло «дождаться Promise.all(writes) и убрать временные», и этот
     * момент не наступал никогда: busboy при обрыве не получает 'end', поток
     * файла не кончается, `out.on('close')` не срабатывает — обещание не
     * разрешается вовсе. Итог: `.имя.uploading-*` лежал в папке до ближайшей
     * уборки (порог — час), всё это время считался в место комнаты и отнимал
     * его у следующих загрузок, дескриптор записи оставался открытым, а файлы,
     * успевшие лечь на место в том же запросе, не рассылались комнате — панель
     * не видела их до следующего изменения дерева.
     *
     * `bb.destroy()` и `out.destroy()` доводят потоки до 'close', после чего
     * обычный путь ниже сам убирает недописанное и отдаёт байты обратно.
     */
    const cutOff = () => {
      if (aborted || answered) return
      aborted = true
      failure ??= { code: 400, message: tr("server.theUploadWasCutOff.7fff95") }
      bb.destroy()
      for (const out of open) out.destroy()
      void Promise.all(writes).then(finish)
    }
    req.on('aborted', cutOff)
    // 'aborted' у запроса объявлен устаревшим, а 'close' приходит и на честно
    // дочитанном теле — различает их `req.complete`.
    req.on('close', () => {
      if (!req.complete) cutOff()
    })

    function finish(): void {
      if (answered) return
      answered = true
      // Всё, что не доехало до места, убирается здесь: обрыв на середине
      // запроса не даёт сработать ни одному из путей выше.
      for (const tmp of temps) removeTemp(sessionId, tmp)
      /*
       * Короткую память обхода сбрасываем сами: файлы легли переименованием,
       * своими потоками, мимо workspace.ts. `renameSync` выше это уже сделал,
       * но между ним и этой строкой чужой запрос успевает обойти папку и
       * положить в память дерево без нашего файла — а уедет оно и в комнату, и
       * в ответ.
       */
      if (saved.length > 0) forgetTree(sessionId)
      // Отвечать оборванному запросу некому; комнате — есть кому: файлы,
      // успевшие лечь на место, рассылаются и с обрыва. Дерево на это строит
      // сама рассылка — ответа, ради которого его считают ниже, здесь не будет.
      if (aborted) {
        if (saved.length > 0) broadcastFiles(sessionId)
        return
      }
      /*
       * Одно дерево на весь запрос: и комнате, и тому, кто нажал.
       *
       * Обход — readdir плюс lstat на каждую из двух тысяч записей, синхронно и
       * в том же цикле, где идёт занятие; делать его дважды на одну загрузку
       * незачем, и готовое дерево рассылка принимает (control.ts ·
       * broadcastFiles). Считается ДО неё, потому что рассылка сбрасывает ту
       * самую память обхода, — иначе второй обход достался бы ровно тому
       * запросу, ради которого она и заведена.
       */
      const tree = listTree(sessionId)
      if (saved.length > 0) broadcastFiles(sessionId, tree)
      if (failure) {
        res.status(failure.code).json({ error: failure.message, ...tree })
        return
      }
      res.json({ ...tree, replaced })
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
          message: tr("server.wasNotUploadedThePathIsToo.f1300d", { p0: name, p1: rel }),
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
          message: tr("server.isAFileNotAFolderIt.8e6810", { p0: intoDir, p1: name }),
        }
        stream.resume()
        return
      }
      try {
        workspaceFs.mkdirSync(folder, { recursive: true })
      } catch {
        failure ??= { code: 400, message: tr("server.couldNotCreateFolderFor.1dcce8", { p0: intoDir, p1: name }) }
        stream.resume()
        return
      }
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
      let out: fs.WriteStream
      try { out = workspaceFs.createWriteStream(tmp, { flags: 'wx' }) }
      catch { temps.delete(tmp); failure ??= { code: 400, message: tr("server.uploadDirectoryChangedOrIsNotWritable.3c0d96") }; stream.resume(); return }
      open.add(out)
      beganWriting(sessionId)
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
            open.delete(out)
            removeTemp(sessionId, tmp)
            failure ??= { code: 500, message: tr("server.couldNotWrite.2758e3", { p0: name }) }
            resolve()
          })
          out.on('close', () => {
            open.delete(out)
            /*
             * Записанное считается местом комнаты сразу, до всех проверок:
             * временный файл уже лежит в её папке, и вторая загрузка, идущая в
             * эту же секунду, обязана его видеть. Каждый путь ниже, который
             * временный файл убирает, отдаёт байты обратно (removeTemp).
             */
            let written = 0
            try {
              written = workspaceFs.statSync(tmp).size
            } catch {
              /* исчез — разберётся ветка ниже */
            }
            noteBytes(sessionId, written)
            endedWriting(sessionId)
            // A truncated file is worse than no file: pandas would happily read
            // half a CSV and nobody would notice until the numbers were wrong.
            // Whatever the reason, the half stays in the temp file and the copy
            // the room already had is never touched.
            if (truncated) {
              removeTemp(sessionId, tmp)
              failure ??= {
                code: 413,
                message: tr("server.isLargerThanMb.28d7e5", { p0: name, p1: Math.round(config.maxUploadBytes / 1024 / 1024) }),
              }
              resolve()
              return
            }
            if (aborted) {
              removeTemp(sessionId, tmp)
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
            /*
             * Занято ли имя — спрашивается ЗДЕСЬ, за строку до переименования, а
             * не в начале приёма файла. Два студента, кладущие `a.csv` в одну
             * секунду, оба видели «такого файла нет» и оба проходили проверку
             * «заменять чужое может преподаватель»: второй ложился поверх
             * первого молча, и оба получали «загружено». Между этой строкой и
             * `renameSync` ниже нет ни одного await, так что второй увидит файл
             * первого.
             */
            let already = 0
            let existed = false
            try {
              already = workspaceFs.statSync(target).size
              existed = true
            } catch {
              // Файла с таким именем ещё нет: место под него не освободится.
            }
            if (usedBytes(sessionId) - already > config.maxSessionBytes) {
              removeTemp(sessionId, tmp)
              failure ??= {
                code: 413,
                message:
                  tr("server.thisSeminarHasRoomForMbOf.66f8a7", { p0: Math.round(config.maxSessionBytes / 1024 / 1024) }) +
                  tr("server.andExceedsThatLimitAskTheTeacher.1f472f", { p0: name }),
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
              removeTemp(sessionId, tmp)
              failure ??= {
                code: 409,
                message: tr("server.isAnOpenRoomNotebookEditIts.eaabdd", { p0: name }),
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
              removeTemp(sessionId, tmp)
              failure ??= {
                code: 403,
                message: tr("server.alreadyExistsInThisRoomOnlyThe.2ac397", { p0: name }),
              }
              resolve()
              return
            }
            try {
              workspaceFs.renameSync(tmp, target)
              // Загрузка пишет своими потоками, мимо workspace.ts, — значит и
              // короткую память обхода сбрасывает сама: ответ на этот же запрос
              // отдаёт дерево, и файла в нём иначе не было бы.
              forgetTree(sessionId)
              // Файл, который лёг на место, уносит с собой прежний: его байты
              // комнате возвращаются, байты временного уже посчитаны выше.
              noteBytes(sessionId, -already)
              temps.delete(tmp)
              saved.push(name)
              if (existed) replaced.push(name)
            } catch {
              removeTemp(sessionId, tmp)
              failure ??= { code: 500, message: tr("server.couldNotWrite.2758e3", { p0: name }) }
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
        message: tr("server.upToFilesPerUploadUploadThe.0987d4", { p0: MAX_FILES_PER_UPLOAD }),
      }
    })

    bb.on('error', () => {
      failure ??= { code: 400, message: tr("server.malformedUpload.084748") }
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
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const wanted = normalizePath(typeof req.query.path === 'string' ? req.query.path : '')
    if (!wanted) return res.status(400).json({ error: tr("server.badPath.95c1aa") })
    /*
     * Either a header from a fetch, or the file's own short-lived token in the
     * query string — the anchor case. What is not accepted here is the session
     * token in a URL: it opens the control socket, and a link with it in is a
     * link that hands Restart to whoever it is forwarded to.
     */
    const ticket = typeof req.query.token === 'string' ? req.query.token : ''
    const allowed = sessionAuth(req) !== null || verifyDownloadToken(sessionId, wanted, ticket)
    if (!allowed) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    const full = resolveInSession(sessionId, wanted)
    if (!full || !workspaceFs.existsSync(full)) return res.status(404).json({ error: tr("server.fileNotFound.3e2256") })
    let file: ReturnType<typeof workspaceFs.openRead>
    try { file = workspaceFs.openRead(full) }
    catch { return res.status(404).json({ error: tr("server.fileNotFound.3e2256") }) }
    // Send uses the held file descriptor, not the attacker-controlled pathname.
    // Preserve the original MIME/name and Express range/conditional responses.
    downloadHeldFile(res, file, baseOf(wanted))
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
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    if (!sessionAuth(req)) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    const wanted = normalizePath(typeof req.query.path === 'string' ? req.query.path : '')
    if (!wanted) return res.status(400).json({ error: tr("server.badPath.95c1aa") })
    const full = resolveInSession(sessionId, wanted)
    if (!full || !workspaceFs.existsSync(full)) return res.status(404).json({ error: tr("server.fileNotFound.3e2256") })
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
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const who = sessionAuth(req)
    if (!who) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (who.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherCanRemoveAFile.289f45") })
    }
    const wanted = normalizePath(typeof req.query.path === 'string' ? req.query.path : '')
    if (!wanted) return res.status(400).json({ error: tr("server.badPath.95c1aa") })
    if (!deleteFile(sessionId, wanted)) {
      return res.status(404).json({ error: tr("server.fileNotFound.3e2256") })
    }
    // Убрали не мы, а сколько там было — не спросишь после: считаем заново.
    // Преподаватель удаляет датасет ровно затем, чтобы место сразу освободилось.
    forgetBytes(sessionId)
    forgetFile(sessionId, wanted)
    dropBook(sessionId, wanted)
    /*
     * И общий экран, если на нём был этот документ.
     *
     * Сокетная дверь удаления это делает (control.ts · `tree:remove`), а эта —
     * не делала: удалённый через панель PDF оставался на проекции у всей
     * комнаты до перезагрузки страницы. Клиентская страховка по списку файлов
     * с этим случаем больше не работает — она считает пропажу доказанной
     * только на ПОЛНОМ списке (web/src/lib/board.ts), а список бывает обрезан.
     */
    forgetMissingBoard(sessionId)
    // Одно дерево на обоих: `deleteFile` короткую память обхода уже сбросил
    // (workspace.ts), так что это свежий обход, а рассылка берёт его готовым.
    const tree = listTree(sessionId)
    broadcastFiles(sessionId, tree)
    res.json(tree)
  })

  return router
}
