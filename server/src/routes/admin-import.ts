/**
 * Creating a seminar from a link to GitHub.
 *
 * The teacher's material is already written — one notebook per week, in a
 * course repository, with the CSV it reads sitting next to it. This turns that
 * into a room: paste the link, get a seminar whose cells are already there and
 * whose workspace already holds the data.
 *
 * Staff-only, like everything on this surface. It reaches out to the public
 * internet on the caller's behalf, so it is deliberately narrow: github.com
 * only, public repositories only, no token, one folder deep.
 */
import fs from 'node:fs'
import { Router, type NextFunction, type Request, type Response } from 'express'
import * as Y from 'yjs'
import { createCell, getCells, getMeta } from '@shared/notebook'
import { currentStaff, requireStaff } from '../admin/auth.js'
import { setSeminarCreator } from './admin-instance.js'
import { newSessionId } from '../auth.js'
import { getSessionDoc } from '../collab/index.js'
import { flushPersistence } from '../collab/persistence.js'
import { config } from '../config.js'
import { readRules } from '@shared/rules'
import { createSession, setRules } from '../db.js'
import { activeName, exists as environmentExists } from '../environments.js'
import {
  fetchRaw,
  filesToTake,
  listDirectory,
  notebookCells,
  parseGithubUrl,
  pickNotebook,
  rawUrlFor,
  seminarNameFor,
  type GithubTarget,
  type RepoEntry,
} from '../github.js'
import { safeSegment } from '@shared/paths'
import { resolveInSession } from '../workspace.js'
import { ENVIRONMENT_NAME, LIMITS, type AdminErrorBody } from '@shared/admin'

function fail(res: Response, status: number, reason: AdminErrorBody['reason'], message: string): void {
  res.status(status).json({ error: message, reason } satisfies AdminErrorBody)
}

/** A committed notebook can be megabytes of base64 output; the JSON still parses. */
const MAX_NOTEBOOK = 25 * 1024 * 1024

/**
 * Отклонённое обещание — в обработчик ошибок, а не в пустоту.
 *
 * Express 4 не знает про async: брошенное после первого `await` не доходит до
 * error-middleware вовсе, `unhandledRejection` пишет строку в журнал, а запрос
 * не отвечает никогда — превью крутится, пока браузер не сдастся.
 */
const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }

export function adminImportRoutes(): Router {
  const router = Router()

  /**
   * A dry run: what would this link produce?
   *
   * Separate from the import itself because the answer is worth showing before
   * anything is created. A teacher pasting a folder link wants to see "twelve
   * cells and train.csv" before a room exists, not after.
   */
  router.post(
    '/api/admin/import/preview',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const target = parseGithubUrl(String(req.body?.url ?? ''))
      if (!target) {
        return fail(
          res,
          400,
          'invalid',
          'That is not a GitHub link. Paste the address of a notebook or of the week\'s folder.',
        )
      }
      try {
        const plan = await planFor(target)
        res.json({
          name: seminarNameFor(plan.notebookTarget ?? target),
          notebook: plan.notebookName,
          cells: plan.cells.length,
          files: plan.files.map((f) => ({ name: f.name, size: f.size })),
          source: `${target.owner}/${target.repo}${target.path ? '/' + target.path : ''}`,
        })
      } catch (err) {
        fail(res, 400, 'invalid', err instanceof Error ? err.message : 'Could not read that link.')
      }
    }),
  )

  router.post('/api/admin/import', requireStaff, wrap(async (req: Request, res: Response) => {
    const target = parseGithubUrl(String(req.body?.url ?? ''))
    if (!target) {
      return fail(res, 400, 'invalid', 'That is not a GitHub link.')
    }

    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return fail(res, 400, 'invalid', `there is no environment called "${wanted}"`)
    }

    let plan: Plan
    try {
      plan = await planFor(target)
    } catch (err) {
      return fail(res, 400, 'invalid', err instanceof Error ? err.message : 'Could not read that link.')
    }
    if (plan.cells.length === 0) {
      return fail(res, 400, 'invalid', 'There is no notebook with any cells at that link.')
    }

    const asked = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const name = (asked || seminarNameFor(plan.notebookTarget ?? target)).slice(0, LIMITS.seminarName)

    const staff = currentStaff(req)
    /*
     * Одна общая функция на все двери — см. seedSeminar.
     *
     * Здесь когда-то стоял свой список: создать сессию, записать правила,
     * подписать автора, положить ячейки. Правила из него однажды выпали, и
     * «из GitHub» с «только преподаватель» и выключенным оракулом делало
     * комнату, где запускать мог каждый. Правила пишутся при создании, так что
     * чинить это было уже негде.
     *
     * Документ раньше файлов: комната с пустой тетрадью выглядит сломанной, а
     * комната, куда ещё не доехали данные, — просто медленной.
     */
    const id = seedSeminar({
      name,
      environment: wanted || activeName(),
      rules: req.body?.rules,
      cells: plan.cells,
      author: staff?.name ?? null,
    })

    const written: string[] = []
    const skipped: string[] = []
    for (const file of plan.files) {
      /*
       * Имя меряется той же меркой, что и всё остальное в дереве комнаты.
       *
       * Здесь спрашивали `safeName` — двести символов, пробел с краю можно, — а
       * панель, загрузка и переименование спрашивают `safeSegment`: сто двадцать
       * и нельзя. Имя из середины этой щели ложилось на диск и было видно в
       * дереве, но открыть, скачать или переименовать его было уже нечем:
       * `normalizePath` такой путь не пропускает. Файл, до которого не
       * дотянуться, хуже непривезённого — такие уезжают в `skipped`, где
       * преподаватель их видит списком.
       */
      const target = safeSegment(file.name) ? resolveInSession(id, file.name) : null
      if (!target || !file.downloadUrl) {
        skipped.push(file.name)
        continue
      }
      try {
        const buf = await fetchRaw(file.downloadUrl, config.maxUploadBytes)
        fs.writeFileSync(target, buf)
        written.push(file.name)
      } catch {
        // One unreadable file must not cost the whole import: the notebook is
        // already in the room and the teacher can drag the rest in by hand.
        skipped.push(file.name)
      }
    }

    res.status(201).json({
      id,
      name,
      url: `${config.publicUrl}/s/${id}`,
      cells: plan.cells.length,
      files: written,
      skipped,
      createdBy: staff?.name ?? null,
    })
  }))

  /*
   * Третья дверь: тетрадь с диска.
   *
   * Ровно тот же путь, что и импорт с GitHub, минус сеть: файл уже у нас, и
   * разбирает его тот же `notebookCells`. Отдельный маршрут, а не поле у
   * общего создания, потому что здесь есть чему не получиться по-своему —
   * файл может оказаться не тетрадью, а тетрадь может оказаться пустой, и об
   * этом надо сказать разными словами.
   *
   * Тело JSON, а не multipart: .ipynb — это и есть JSON, читать его в браузере
   * и слать текстом дешевле, чем поднимать busboy ради одного поля.
   *
   * Приезжают только ячейки — `cell_type` и `source`, — а не файл целиком.
   * Предел на тело общий, 1 МБ (см. express.json в index.ts), и сохранённая
   * тетрадь с парой графиков его пробивает: выводы в ней — это мегабайты
   * base64, которые здесь всё равно выбрасываются. Разбирает их тот же
   * `notebookCells`, что и импорт с GitHub: второй разбор, расходящийся во
   * мнениях о том, что такое ячейка, однажды потерял бы половину чужой
   * тетради. Поле `notebook` с текстом файла принимается по-прежнему — для
   * тетради, которая в предел укладывается.
   */
  router.post('/api/admin/import/notebook', requireStaff, (req: Request, res: Response) => {
    const sent: unknown = req.body?.cells
    const raw = typeof req.body?.notebook === 'string' ? req.body.notebook : ''

    let parsed: unknown
    if (Array.isArray(sent)) {
      parsed = { cells: sent }
    } else {
      if (!raw.trim()) return fail(res, 400, 'invalid', 'no notebook was sent')
      try {
        parsed = JSON.parse(raw)
      } catch {
        return fail(res, 400, 'invalid', 'That file is not a notebook — .ipynb is JSON, and this would not parse.')
      }
    }

    const cells = notebookCells(parsed)
    if (cells.length === 0) {
      return fail(res, 400, 'invalid', 'That notebook has no cells with anything in them.')
    }

    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return fail(res, 400, 'invalid', `there is no environment called "${wanted}"`)
    }

    const asked = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const fallback = typeof req.body?.filename === 'string' ? req.body.filename : ''
    const name = (asked || tidyNotebookName(fallback) || 'Untitled seminar').slice(0, LIMITS.seminarName)

    const staff = currentStaff(req)
    const id = seedSeminar({
      name,
      environment: wanted || activeName(),
      rules: req.body?.rules,
      cells,
      author: staff?.name ?? null,
    })

    res.status(201).json({
      id,
      name,
      url: `${config.publicUrl}/s/${id}`,
      cells: cells.length,
      files: [],
      skipped: [],
      createdBy: staff?.name ?? null,
    })
  })

  return router
}

/**
 * Завести комнату и положить в неё тетрадь.
 *
 * Общая часть двух дверей — с GitHub и с диска. Была написана дважды подряд в
 * одном маршруте, и второй раз в ней уже потерялись правила комнаты; вынесена,
 * чтобы третья дверь не потеряла что-нибудь своё.
 */
function seedSeminar(input: {
  name: string
  environment: string | null
  rules: unknown
  cells: ReturnType<typeof notebookCells>
  author: string | null
}): string {
  const id = newSessionId()
  createSession(id, input.name, input.environment)
  if (input.rules && typeof input.rules === 'object') setRules(id, readRules(input.rules))
  if (input.author) setSeminarCreator(id, input.author)

  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    const cells = getCells(doc)
    // Стартовая тетрадь, которую сервер сеет свежей комнате, здесь только мешает.
    if (cells.length > 0) cells.delete(0, cells.length)
    cells.push(input.cells.map((c) => createCell(c.type, c.source)))
    getMeta(doc).set('title', input.name)
  }, 'import')
  flushPersistence(id)
  return id
}

/**
 * Имя семинара из имени файла: `01_HSE_Intro_to_Python.ipynb` → «HSE Intro to
 * Python». Та же чистка, что и у ссылки с GitHub, и по той же причине —
 * порядковый номер и подчёркивания в заголовке комнаты не нужны никому.
 */
function tidyNotebookName(filename: string): string {
  const bare = filename.replace(/\.ipynb$/i, '').replace(/^[0-9]+[-_. ]*/, '')
  return bare.replace(/[-_]+/g, ' ').trim()
}

/* ------------------------------------------------------------------ plan */

interface Plan {
  cells: ReturnType<typeof notebookCells>
  files: RepoEntry[]
  notebookName: string
  notebookTarget: GithubTarget | null
}

/**
 * What a link would turn into, without creating anything.
 *
 * A file link is one request; a folder link is two — list, then fetch the
 * notebook. Files next to the notebook come along; subfolders do not, because
 * walking somebody's course repository is a surprise rather than a feature.
 */
async function planFor(target: GithubTarget): Promise<Plan> {
  if (target.kind === 'file') {
    if (!target.path.toLowerCase().endsWith('.ipynb')) {
      throw new Error('That link is not a notebook. Point it at an .ipynb file or at a folder.')
    }
    const raw = await fetchRaw(rawUrlFor(target), MAX_NOTEBOOK)
    return {
      cells: notebookCells(JSON.parse(raw.toString('utf8'))),
      files: [],
      notebookName: target.path.split('/').pop() ?? 'notebook.ipynb',
      notebookTarget: target,
    }
  }

  const entries = await listDirectory(target)
  const book = pickNotebook(entries)
  if (!book || !book.downloadUrl) {
    throw new Error('There is no .ipynb in that folder.')
  }
  const raw = await fetchRaw(book.downloadUrl, MAX_NOTEBOOK)
  return {
    cells: notebookCells(JSON.parse(raw.toString('utf8'))),
    files: filesToTake(entries, config.maxUploadBytes),
    notebookName: book.name,
    notebookTarget: { ...target, path: book.path, kind: 'file' },
  }
}
