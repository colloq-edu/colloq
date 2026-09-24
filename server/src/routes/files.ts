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
import { dropBook, isBookFile, ownsBookAt } from '../collab/books.js'
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
 * The space a room takes, as a per-room counter rather than a walk per
 * request.
 *
 * `sessionBytes` is a recursive walk over the whole folder with an lstat per
 * entry, with no cap on the number of entries. After `!pip install -t .` or an
 * unpacked dataset that is tens of thousands of synchronous lstats, in the
 * very event loop that serves the CRDT of every room, and they were done on
 * EVERY upload. Five hundred students handing in a CSV in the same minute
 * gave five hundred such walks in a row.
 *
 * We count once and then adjust for our own writes and deletions. Freshness
 * is limited to ten seconds, because a cell writes into the same folder behind
 * our back (`open('big.bin','wb')`); that is beyond the cap anyway, see the
 * comment below, and ten seconds of drift change nothing here.
 *
 * This also makes the cap shared by concurrent uploads: each request used to
 * read the sum once at the start, so N students pressing "Hand in" in the
 * same second saw the same old number and together exceeded the room's cap N
 * times over.
 */
const FRESH_MS = 10_000
const measured = new Map<string, { bytes: number; at: number }>()
/** How many streams are writing into the room right now; see usedBytes. */
const writing = new Map<string, number>()

function usedBytes(sessionId: string): number {
  const known = measured.get(sessionId)
  /*
   * While OUR unfinished files are in the folder, recounting is not allowed:
   * the walk would count half of the arriving file, and we add its whole size
   * ourselves when the stream closes, so the room's space would go twice.
   * While an upload is running, increments keep the sum; we measure afresh
   * when everything is written.
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

/** Our own write or our own deletion: the counter is adjusted, not reset. */
function noteBytes(sessionId: string, delta: number): void {
  const known = measured.get(sessionId)
  if (known) known.bytes += delta
}

/** Count afresh: the folder was changed by someone else (a deletion, a temp-file sweep). */
function forgetBytes(sessionId: string): void {
  measured.delete(sessionId)
}

/**
 * Sweeping abandoned temp files, no more often than once every five minutes
 * per room.
 *
 * The sweep's own threshold is an hour (`sweepStaleUploads`), so there is no
 * point doing it more often, and it costs the same full walk of the folder as
 * counting the bytes.
 */
const SWEEP_EVERY_MS = 5 * 60_000
const sweptAt = new Map<string, number>()

function sweepSometimes(sessionId: string): void {
  const now = Date.now()
  if (now - (sweptAt.get(sessionId) ?? 0) < SWEEP_EVERY_MS) return
  sweptAt.set(sessionId, now)
  sweepStaleUploads(sessionId)
  // The sweep may have taken others' unfinished files, so the sum is different after it.
  forgetBytes(sessionId)
}

/** Remove our own temp file and give its bytes back to the room. */
function removeTemp(sessionId: string, tmp: string): void {
  let size = 0
  try {
    size = workspaceFs.statSync(tmp).size
  } catch {
    /* it is already gone: nothing to subtract */
  }
  try { workspaceFs.rmSync(tmp, { force: true }) } catch { /* untrusted parent changed */ }
  if (size > 0) noteBytes(sessionId, -size)
}

export function fileRoutes(): Router {
  const router = Router()

  // Blocked access is blocked here too: the handouts, downloads and, above
  // all, uploads, the very spam the person was blocked for
  // (routes/sessions.ts · banDoor).
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
    // Together with the truncation flag: a list that hit the cap does not mean
    // "the room has this many files", and it cannot be used to decide that
    // something is gone.
    res.json(listTree(req.params.id))
  })

  /*
   * The only write outside /api/admin that a cookie alone authorizes.
   *
   * The `sameOrigin` check hung only on the /api/admin prefix, and the comment
   * above it justifies it exactly by "remembering it on every new route" not
   * working out. This route did not remember: the teacher cookie lets one in
   * here without a participant token, so a cross-site POST from someone
   * else's page would put a file into the seminar folder, held back only by
   * the browser's SameSite=Lax. A request without an Origin header (curl, a
   * script) passes as before: it is never cross-site.
   */
  router.post('/api/sessions/:id/files', sameOrigin, (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    /*
     * Either a participant of the room or a teacher of this instance.
     *
     * The second became necessary when materials could be attached while
     * creating a seminar: the panel goes with the teacher cookie and has no
     * participant token, since it never entered the room. The cookie is not a
     * weaker credential but a stronger one: it is revoked by removal from the
     * teacher list, while a participant token lives a life of its own. The
     * very same argument is written in sessions.ts above the role check.
     */
    const joined = sessionAuth(req)
    if (!joined && !currentStaff(req)) {
      return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    }
    // The role is decided right here: the teacher cookie beats a participant
    // token, and a person who entered the room before signing into the panel
    // is still a teacher.
    const role = currentStaff(req) ? 'host' : (joined?.role ?? 'participant')
    if (!allows(getRules(sessionId).files, role)) {
      // A finished class tightens `files` by itself (db.getRules); only the
      // sentence is separate here: what matters to a person is not the rule
      // but that the lesson is over. Download and reading below are untouched:
      // after the lesson is exactly when people go to the files.
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
    // that nothing else will ever remove. Once every few minutes per room: the
    // sweep's own threshold is an hour, and it costs a walk of the whole folder.
    sweepSometimes(sessionId)
    // And the room's space, before this request creates its own temp files:
    // from then on increments keep the sum, not a walk (see usedBytes).
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
     * Which folder we put things in. A form field, not part of the file name:
     * the name comes from the file system of whoever is dragging, and adding a
     * path to it means depending on what the browser put into `filename`. It
     * arrives before the files themselves, because the panel adds it to the
     * form first; a client that does not puts things in the root, and that is
     * an honest answer, not a silent error.
     */
    let intoDir = ''
    bb.on('field', (name, value) => {
      if (name !== 'dir') return
      const wanted = normalizePath(typeof value === 'string' ? value : '')
      if (wanted !== null) intoDir = wanted
    })

    const saved: string[] = []
    /** Names that landed over files already there: that has to be said out loud. */
    const replaced: string[] = []
    const writes: Promise<void>[] = []
    /** All of this request's unfinished files: they must be removed however it ends. */
    const temps = new Set<string>()
    /** The write streams open right now: a cut-off closes them by hand, see below. */
    const open = new Set<fs.WriteStream>()
    let failure: UploadFailure | null = null
    let answered = false
    /*
     * The cap is for the whole room and shared by everyone writing into it
     * right now (see usedBytes): the space is counted by the room's counter,
     * and a temp file already lies in its folder, so two concurrent uploads
     * see each other.
     *
     * The cap closes the upload, not the cell.
     *
     * A cell writes into the same directory straight from the kernel
     * (`open('big.bin','wb')` bypasses this check), and the real disk boundary
     * is only one: a volume limit next to mem_limit and pids_limit, which
     * /workspace does not have. Here we stop what we can stop: a random folder
     * dropped into the window, not malice.
     */

    /*
     * A cut-off upload must not land over a whole file.
     *
     * A client that leaves midway does not raise 'limit' (that one is about
     * size), and the file stream in busboy simply ends. Then the ordinary path
     * fired: rename the temp into place. Half a CSV landed over the whole one,
     * pandas read it without an error, and the loss was noticed by the
     * numbers.
     */
    let aborted = false
    /*
     * We close a cut-off ourselves, otherwise nobody will.
     *
     * There used to be "wait for Promise.all(writes) and remove the temps"
     * here, and that moment never came: on a cut-off busboy does not get
     * 'end', the file stream does not end, `out.on('close')` does not fire,
     * and the promise never resolves. The result: `.name.uploading-*` lay in
     * the folder until the next sweep (threshold: an hour), all that time
     * counted towards the room's space and took it from the next uploads, the
     * write descriptor stayed open, and files that made it into place in the
     * same request were not broadcast to the room: the panel did not see them
     * until the next tree change.
     *
     * `bb.destroy()` and `out.destroy()` bring the streams to 'close', after
     * which the ordinary path below removes the unfinished parts and gives the
     * bytes back by itself.
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
    // The request's 'aborted' is deprecated, and 'close' also comes for a body
    // read to the end honestly; `req.complete` tells them apart.
    req.on('close', () => {
      if (!req.complete) cutOff()
    })

    function finish(): void {
      if (answered) return
      answered = true
      // Whatever did not make it into place is removed here: a cut-off in the
      // middle of the request lets none of the paths above fire.
      for (const tmp of temps) removeTemp(sessionId, tmp)
      /*
       * We reset the walk's short memory ourselves: the files landed by
       * rename, through our own streams, bypassing workspace.ts. `renameSync`
       * above already did this, but between it and this line another request
       * manages to walk the folder and put into memory a tree without our
       * file, and that tree would go both to the room and into the response.
       */
      if (saved.length > 0) forgetTree(sessionId)
      // There is nobody to answer for a cut-off request, but the room is there:
      // files that made it into place are broadcast even on a cut-off. The
      // broadcast builds the tree for that itself; the response it is computed
      // for below will not happen here.
      if (aborted) {
        if (saved.length > 0) broadcastFiles(sessionId)
        return
      }
      /*
       * One tree for the whole request: for the room and for whoever pressed.
       *
       * A walk is readdir plus an lstat for each of two thousand entries,
       * synchronously and in the same loop where the class is running; there
       * is no point doing it twice per upload, and the broadcast accepts a
       * ready tree (control.ts · broadcastFiles). It is computed BEFORE the
       * broadcast, because the broadcast resets that very walk memory;
       * otherwise the second walk would fall to exactly the request the memory
       * exists for.
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
       * The name is measured by the same measure as everything else in the
       * tree.
       *
       * The upload used to apply its own measure (two hundred characters, a
       * space at the edge allowed), and `resolveInSession` right after it
       * applied `safeSegment` (a hundred and twenty, not allowed): a name of a
       * hundred and fifty characters, of which LMS exports are full, was
       * rejected with "cannot be used as a file name here", naming neither the
       * reason nor the limit. We still cut the folder off the browser's
       * `filename`: the path comes in the `dir` field, not in the file name.
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
       * The folder may not have existed: the panel can drag a file onto a new
       * one. Or it may be taken by a file: `dir=data.csv` with a `data.csv`
       * already there is EEXIST (and `data.csv/sub` is ENOTDIR) right from the
       * stream handler, bypassing express, that is, `uncaughtException` and
       * `process.exit(1)` for the whole instance with all its seminars. Any
       * file system refusal here is a `failure` with a code, not an exception.
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
      const tmp = `${folder}/.colloq.uploading-${randomBytes(6).toString('hex')}`
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
             * What was written counts as the room's space at once, before all
             * the checks: the temp file already lies in its folder, and a
             * second upload running in the same second must see it. Every path
             * below that removes the temp file gives the bytes back
             * (removeTemp).
             */
            let written = 0
            try {
              written = workspaceFs.statSync(tmp).size
            } catch {
              /* it vanished: the branch below will sort it out */
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
             * The cap is for the whole room, not for one file.
             *
             * It is checked after the write, not before: the size of an
             * arriving file is unknown until the end of the stream, and
             * Content-Length describes the whole multipart request, boundaries
             * included. A temp that was written but not renamed is deleted
             * right here, so a refusal costs no space.
             */
            /*
             * Whether the name is taken is asked HERE, a line before the
             * rename, not at the start of receiving the file. Two students
             * putting `a.csv` in the same second both saw "no such file" and
             * both passed the "only a teacher may replace someone else's"
             * check: the second silently landed over the first, and both got
             * "uploaded". There is no await between this line and `renameSync`
             * below, so the second will see the first one's file.
             */
            let already = 0
            let existed = false
            try {
              already = workspaceFs.statSync(target).size
              existed = true
            } catch {
              // No file with this name yet: no space will be freed for it.
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
             * Nothing lands over a room notebook.
             *
             * A notebook file is a projection of the document: the room
             * rewrites it a second after any edit. Accepting the upload would
             * mean showing "uploaded" and silently bringing back the previous
             * content, the worst kind of refusal. A notebook can be brought in
             * again after removing it from the room.
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
             * Replacing someone else's file means deleting it, and deletion is
             * already teacher-only. The hole was exactly that wide: DELETE
             * asked for the role, while uploading a file with the same name
             * did not.
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
              // The upload writes through its own streams, bypassing
              // workspace.ts, so it resets the walk's short memory itself: the
              // response to this very request returns the tree, and the file
              // would otherwise be missing from it.
              forgetTree(sessionId)
              // The file that took its place takes the previous one with it:
              // its bytes go back to the room, and the temp's bytes were
              // already counted above.
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
   * Download a file.
   *
   * The path is in the query string, not in the address, and this is the only
   * way to address a file in the whole product. A slash inside a name lives in
   * the address only as `%2F`, and one proxy or another unfolds it on the
   * way, so `src/model.py` turns either into two path segments or into a 404,
   * depending on what stands in front of the server. Nobody normalizes a query
   * string.
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
   * Remove a file or a folder.
   *
   * A teacher's right, and it was meant to be one all along: the folder is
   * shared both ways, and anyone in the room could remove the handout the
   * class works from. Adding is an addition and stays open to everyone;
   * removing is not.
   */
  router.delete('/api/sessions/:id/file', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const who = sessionAuth(req)
    if (!who) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    const wanted = normalizePath(typeof req.query.path === 'string' ? req.query.path : '')
    if (!wanted) return res.status(400).json({ error: tr("server.badPath.95c1aa") })
    /*
     * And the same exception as at the socket door (control.ts ·
     * `tree:remove`): an author removes their own personal notebook. Two doors
     * for one action (the panel comes here, the tree sends a frame), and they
     * must have one rule, otherwise it exists on only one of them.
     */
    if (who.role !== 'host' && !ownsBookAt(sessionId, wanted, who.participantId)) {
      return res.status(403).json({ error: tr("server.onlyTheTeacherCanRemoveAFile.289f45") })
    }
    if (!deleteFile(sessionId, wanted)) {
      return res.status(404).json({ error: tr("server.fileNotFound.3e2256") })
    }
    // The removal did not go through our counter, and how much was there
    // cannot be asked afterwards: count afresh. A teacher deletes a dataset
    // precisely so that the space frees up at once.
    forgetBytes(sessionId)
    forgetFile(sessionId, wanted)
    dropBook(sessionId, wanted)
    /*
     * And the shared screen, if this document was on it.
     *
     * The socket deletion door does this (control.ts · `tree:remove`), and
     * this one did not: a PDF deleted through the panel stayed on the
     * projection for the whole room until a page reload. The client-side
     * safety net based on the file list no longer works for this case: it
     * considers a disappearance proven only on a FULL list
     * (web/src/lib/board.ts), and the list can be truncated.
     */
    forgetMissingBoard(sessionId)
    // One tree for both: `deleteFile` already reset the walk's short memory
    // (workspace.ts), so this is a fresh walk, and the broadcast takes it
    // ready-made.
    const tree = listTree(sessionId)
    broadcastFiles(sessionId, tree)
    res.json(tree)
  })

  return router
}
