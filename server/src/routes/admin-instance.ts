import { tr } from '@shared/i18n'
/**
 * The instance's own routes: the seminars a teacher is running, and the
 * oracle that answers in them.
 *
 * Everything here is staff-only. The split between staff and owner is
 * deliberate and narrow: a teacher can create, rename and archive rooms all
 * day, but only the owner can destroy one, because that is the only action on
 * this surface that takes work away from people who are not in the request.
 */
import fs from 'node:fs'
import { Router, type Request, type Response } from 'express'
import * as Y from 'yjs'
import { getCells, getMeta } from '@shared/notebook'
import { currentStaff, ownerOnly, requireStaff } from '../admin/auth.js'
import { getOracleSettings, parseOraclePatch, updateOracleSettings } from '../admin/settings.js'
import { summariseUsage } from '../admin/usage.js'
import { discardBans } from '../bans.js'
import { stopAll } from '../ai/agent.js'
import { testConnection } from '../ai/provider.js'
import { newSessionId } from '../auth.js'
import { dropSessionDoc, getSessionDoc, liveSince, onlineCount } from '../collab/index.js'
import { visitSessionDoc } from './doc-visit.js'
import { config } from '../config.js'
import { broadcast, closeControlRoom, setClassFinished } from '../control.js'
import { COUNCIL_ROOM, LECTURE_ROOM, OPEN_ROOM, readRules } from '@shared/rules'
import { normalizeLabel } from '@shared/text'
import {
  createSession,
  db,
  discardHistory,
  discardNotes,
  finishedAt,
  forgetRoom,
  loadDocSnapshot,
  renameSession,
  sessionEnvironment,
  sessionCpus,
  sessionMemoryMb,
  setRules,
  setSessionCpus,
  setSessionMemoryMb,
  storedRules,
} from '../db.js'
import { forgetCache } from '../collab/history.js'
import { deleteRoomBlobs } from '../blobs.js'
import {
  deletePublication,
  entombSeminar,
  listCourses,
  orphanPublication,
  publicationOf,
  stepCount,
} from '../publish/store.js'
import { environmentOf, shutdownSession } from '../kernel/index.js'
import { applyCpuLimit, applyMemoryLimit, defaultCpus } from '../kernel/pool.js'
import {
  cpuBounds,
  forgetResources,
  memoryBounds,
  readCpuInput,
  readMemoryInput,
} from '../kernel/resources.js'
import { blockKernelStarts, kernelRetirementInProgress } from '../kernel/retirement.js'
import { activeName, exists as environmentExists } from '../environments.js'
import { forgetTree, listFiles, sessionDir, workspaceFs } from '../workspace.js'
import type { Course } from '@shared/publish'
import {
  ENVIRONMENT_NAME,
  LIMITS,
  type AdminErrorBody,
  type AdminSeminar,
  type OracleTestResult,
  type SeminarStatus,
} from '@shared/admin'

/**
 * The two columns the panel adds to a table db.ts already owns. Guarded by
 * table_info rather than a migrations framework: this is one ALTER per column,
 * SQLite has no ADD COLUMN IF NOT EXISTS, and an instance that has run once
 * must come up unchanged the next time.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

ensureColumn('sessions', 'created_by', 'created_by TEXT')
ensureColumn('sessions', 'archived_at', 'archived_at INTEGER')

const selectSeminars = db.prepare(`
  SELECT s.id, s.name, s.created_at, s.created_by, s.archived_at,
         (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participants
  FROM sessions s
  ORDER BY s.created_at DESC
`)
const selectSeminar = db.prepare(`
  SELECT s.id, s.name, s.created_at, s.created_by, s.archived_at,
         (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participants
  FROM sessions s
  WHERE s.id = ?
`)
const updateCreator = db.prepare('UPDATE sessions SET created_by = ? WHERE id = ?')
const setArchived = db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
const selectArchived = db.prepare('SELECT archived_at FROM sessions WHERE id = ?')
const deleteSeminarRow = db.prepare('DELETE FROM sessions WHERE id = ?')
const deleteParticipants = db.prepare('DELETE FROM participants WHERE session_id = ?')
const deleteSnapshot = db.prepare('DELETE FROM doc_snapshots WHERE session_id = ?')

interface SeminarRow {
  id: string
  name: string
  created_at: number
  created_by: string | null
  archived_at: number | null
  participants: number
}

/**
 * Attribution for a seminar created through POST /api/sessions rather than
 * through the panel. Exported for routes/sessions.ts, which owns that path.
 */
export function setSeminarCreator(sessionId: string, createdBy: string): void {
  updateCreator.run(createdBy, sessionId)
}

/**
 * Убран ли семинар из списка. Столбец заводится здесь, поэтому и спрашивается
 * здесь; читает это `/join`, чтобы не греть ядро комнате, в которую заходят
 * перечитать разбор.
 */
export function isArchived(sessionId: string): boolean {
  const row = selectArchived.get(sessionId) as { archived_at: number | null } | undefined
  return row?.archived_at != null
}

/* ----------------------------------------------------------------- counts */

/**
 * Cells, without dragging every notebook in the instance back into memory.
 *
 * getSessionDoc() creates and seeds a document as a side effect, so calling it
 * for each row would give a teacher who opened this list a resident Y.Doc per
 * seminar — and would seed starter cells into rooms nobody has ever opened.
 * A live room is read from the doc that is already there; everything else is
 * decoded from its stored snapshot, which for a room with nobody in it is what
 * the next visitor would load anyway.
 *
 * И пересчитывается, только когда снимок изменился. Список запрашивается при
 * каждой смене вкладки и раз в двадцать секунд на экране семинаров, а
 * декодирование чужой тетради с картинками — это миллисекунды блокировки того
 * же цикла событий, который обслуживает CRDT живых комнат. Ключ — отметка
 * времени снимка: поменяться ей неоткуда, кроме записи снимка.
 */
const cellCounts = new Map<string, { at: number; count: number }>()
const snapshotStamp = db.prepare('SELECT updated_at FROM doc_snapshots WHERE session_id = ?')

function cellCount(sessionId: string, live: boolean): number {
  try {
    if (live) return getCells(getSessionDoc(sessionId).doc).length
    const at = (snapshotStamp.get(sessionId) as { updated_at: number } | undefined)?.updated_at ?? 0
    const cached = cellCounts.get(sessionId)
    if (cached && cached.at === at) return cached.count
    const snapshot = loadDocSnapshot(sessionId)
    if (!snapshot) return 0
    const doc = new Y.Doc()
    Y.applyUpdate(doc, snapshot)
    const count = getCells(doc).length
    doc.destroy()
    cellCounts.set(sessionId, { at, count })
    return count
  } catch {
    // A card with a zero on it is better than a list that will not load.
    return 0
  }
}

/**
 * listFiles, not a bare readdir: the number on the card has to be the number the
 * Files panel shows.
 *
 * И тоже по отметке времени, а не обходом на каждую строку. `listFiles` читает
 * комнату целиком — readdir и lstat на каждую запись, до двух тысяч, синхронно
 * и в том же цикле событий, что обслуживает живые комнаты, — а список
 * запрашивается при каждой смене вкладки и раз в двадцать секунд. Ключ — mtime
 * корня комнаты: туда падают и загрузки, и удаления, и всё, что ядро кладёт
 * рядом с тетрадью. Файл, записанный вглубь подпапки, оставит на карточке
 * прежнее число до следующего изменения корня — это число на карточке, а не
 * список файлов.
 *
 * Считать заново — значит и обойти заново: у самого `listFiles` своя короткая
 * память (workspace.ts · TREE_MEMO_MS), и она бывает СТАРШЕ той отметки
 * времени, на которую мы ключуемся. Тогда к новому mtime прибивалось число,
 * посчитанное по прежнему дереву, и карточка показывала «0 файлов» не триста
 * миллисекунд, а до следующего изменения папки: в комнату положили файл мимо
 * workspace.ts (ядро, сохранение открытого), и на карточке этого не видно
 * вовсе. Папка изменилась — обходим её, а не вспоминаем.
 */
const fileCounts = new Map<string, { at: number; count: number }>()

function fileCount(sessionId: string): number {
  try {
    const at = workspaceFs.statSync(sessionDir(sessionId)).mtimeMs
    const cached = fileCounts.get(sessionId)
    if (cached && cached.at === at) return cached.count
    forgetTree(sessionId)
    const count = listFiles(sessionId).filter((entry) => !entry.dir).length
    fileCounts.set(sessionId, { at, count })
    return count
  } catch {
    return 0
  }
}

/**
 * Одно слово о семинаре — и решение преподавателя сильнее подсчёта.
 *
 * Пока звонка не было, слово отвечает на «что там сейчас»: кто-то в комнате,
 * ссылку не давали, пусто. После звонка отвечать на это бессмысленно: комната
 * закончена, и то, что в ней трое перечитывают разбор, не делает пару идущей.
 */
function statusOf(
  liveCount: number,
  totalParticipants: number,
  finishedAt: number | null,
): SeminarStatus {
  if (finishedAt !== null) return 'finished'
  if (liveCount > 0) return 'live'
  // Nobody has ever joined: the link was made and never used.
  return totalParticipants === 0 ? 'draft' : 'idle'
}

function toSeminar(row: SeminarRow, courses = listCourses()): AdminSeminar {
  // Open collab sockets, which is the only "who is here right now" the server
  // actually holds (collab/index.ts). A second tab counts twice; the control
  // socket keeps no per-session tally to cross-check against.
  const liveCount = onlineCount(row.id)
  const publication = publicationOf(row.id)
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    status: statusOf(liveCount, row.participants, finishedAt(row.id)),
    liveCount,
    /*
     * Часы занятия, а не часы комнаты: строка «Running now · started 25 min
     * ago» про то, сколько идёт ЭТА пара. Комнату завели за неделю, и её
     * `createdAt` отвечал на другой вопрос (collab/index.ts · liveSince).
     */
    liveSince: liveSince(row.id),
    totalParticipants: row.participants,
    cellCount: cellCount(row.id, liveCount > 0),
    fileCount: fileCount(row.id),
    url: `${config.publicUrl}/s/${row.id}`,
    /*
     * Что комната РЕАЛЬНО запустила, если ядро уже поднялось; иначе — что она
     * попросила при создании. Разница видна ровно тогда, когда она важна:
     * семинар, переживший переключение, продолжает работать на старом образе.
     */
    environment: environmentOf(row.id) ?? sessionEnvironment(row.id),
    createdBy: row.created_by,
    archivedAt: row.archived_at,
    /*
     * Выбранные правила, а не действующие: в форме редактирования человек
     * обязан видеть то, что он выбрал. Законченное занятие ужесточает права
     * поверх них (shared/rules.ts · rulesAfterClass) и отступает, не тронув
     * настройку, — а `finishedAt` рядом говорит, идёт ли оно сейчас.
     */
    rules: storedRules(row.id),
    /*
     * Сколько памяти выдано ЭТОЙ комнате, или null — «как у окружения».
     *
     * Своё число, а не действующее: в форме настроек человек обязан видеть то,
     * что он задал, и отличать «я поставил 4 ГБ» от «столько даёт окружение».
     * Умолчание окружения панель берёт из /api/instance/resources — оно одно
     * на все комнаты и меняется без них.
     */
    memoryMb: sessionMemoryMb(row.id),
    /** И ядра тем же правилом: своё число комнаты, а не действующее. */
    cpus: sessionCpus(row.id),
    finishedAt: finishedAt(row.id),
    publication: publication
      ? {
          id: publication.id,
          slug: publication.slug,
          state: publication.state,
          steps: stepCount(publication.id),
        }
      : null,
    courses: coursesWith(row.id, courses),
  }
}

/**
 * Курсы, в которых состоит семинар. Строка списка показывает их ссылками.
 *
 * Список курсов передаётся, а не запрашивается заново: на семестре в шестьдесят
 * семинаров это было шестьдесят одинаковых чтений на один ответ.
 */
function coursesWith(sessionId: string, courses: Course[]): { id: string; name: string }[] {
  return courses
    .filter((course) =>
      course.items.some((item) => item.kind === 'seminar' && item.sessionId === sessionId),
    )
    .map((course) => ({ id: course.id, name: course.name }))
}

/* ------------------------------------------------------------------ input */

/**
 * Collapse whitespace and drop control characters so a name cannot break the
 * list layout. Одна мерка на все четыре двери — shared/text.ts.
 */
const normalize = normalizeLabel

function invalid(res: Response, error: string): Response {
  const body: AdminErrorBody = { error, reason: 'invalid' }
  return res.status(400).json(body)
}

/**
 * Почему число не взяли — числами же.
 *
 * Границы называются вслух: «должно быть числом» на поле, куда форма шлёт
 * мегабайты, ничего не говорит тому, кто прислал гигабайты, а «от 512 до
 * 71 680 МБ» говорит всё сразу.
 */
function memoryRefusal(why: 'type' | 'range'): string {
  const { min, max } = memoryBounds()
  return why === 'type'
    ? tr('server.memoryMustBeWholeMegabytes')
    : tr('server.memoryOutOfRange', { p0: min, p1: max })
}

/** То же, что и у памяти: границы называются числами, а не «неверно». */
function cpuRefusal(why: 'type' | 'range'): string {
  const { min, max } = cpuBounds()
  return why === 'type'
    ? tr('server.cpusMustBeWholeCores')
    : tr('server.cpusOutOfRange', { p0: min, p1: max })
}

function notFound(res: Response): Response {
  const body: AdminErrorBody = { error: tr("server.thatSeminarNoLongerExists.b346fe"), reason: 'invalid' }
  return res.status(404).json(body)
}

function seminarOr404(req: Request, res: Response): SeminarRow | null {
  const row = selectSeminar.get(req.params.id) as SeminarRow | undefined
  if (!row) {
    notFound(res)
    return null
  }
  return row
}

/** A week, which is the window a teacher is actually asking about after a class. */
const DEFAULT_USAGE_WINDOW_MS = 7 * 24 * 3_600_000
const MAX_USAGE_WINDOW_MS = 365 * 24 * 3_600_000

export function adminInstanceRoutes(): Router {
  const router = Router()

  /* --------------------------------------------------------- seminars */

  router.get('/api/admin/seminars', requireStaff, (_req, res) => {
    const rows = selectSeminars.all() as SeminarRow[]
    const courses = listCourses()
    res.json(rows.map((row) => toSeminar(row, courses)))
  })

  router.post('/api/admin/seminars', requireStaff, (req, res) => {
    const name = normalize(req.body?.name)
    if (!name) return invalid(res, tr("server.aSeminarNameIsRequired.f10426"))
    if (name.length > LIMITS.seminarName) {
      return invalid(res, tr("server.aSeminarNameMustBeCharactersOr.c9d56a", { p0: LIMITS.seminarName }))
    }

    /*
     * Окружение проверяется, а не принимается на слово: имя становится тегом
     * образа и именем контейнера, и оно приходит из браузера. Несуществующее
     * имя лучше отвергнуть здесь, чем обнаружить, когда комната уже полна.
     */
    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return invalid(res, tr("server.thereIsNoEnvironmentCalled.a8903e", { p0: wanted }))
    }

    /*
     * A concrete name is always recorded, never "follow the instance".
     *
     * There used to be a third state — null meaning "whatever the instance is
     * set to" — and it quietly contradicted the promise this feature makes: a
     * seminar's Python is decided once, so that a room's packages cannot change
     * under it mid-class. A room left on "follow" would have moved the next
     * time somebody changed the default. Resolving the default HERE, at
     * creation, keeps one rule instead of two.
     */
    const environment = wanted || activeName()

    /*
     * Лимит памяти проверяется той же меркой, что и при изменении: граница у
     * машины одна, и форма создания не то место, где комнате можно пообещать
     * больше, чем есть.
     */
    const memory = readMemoryInput(req.body?.memoryMb)
    if (!memory.ok) return invalid(res, memoryRefusal(memory.error))
    const cpu = readCpuInput(req.body?.cpus)
    if (!cpu.ok) return invalid(res, cpuRefusal(cpu.error))

    const id = newSessionId()
    createSession(id, name, environment)
    /*
     * Rules are written at creation and not before: there is no draft row to
     * hold them, so a seminar exists the moment it is created and it exists
     * with the rules it was created under. readRules() inside setRules fills in
     * anything the form did not send, so a caller that knows nothing about
     * rules — a script, an older client — still produces the open room the
     * product has always been.
     *
     * Режим — это ПРЕСЕТ правил, и записывается он ими же. Отдельным состоянием
     * комнаты («эта — лекционная») он завёл бы второй источник правды о том,
     * что в ней можно: сервер спрашивает права у правил, а настройки показывают
     * их же, и первый переключатель в настройках развёл бы слово и дело.
     * Поэтому 'lecture' — это `LECTURE_ROOM`, 'lab' и отсутствие поля — это
     * `OPEN_ROOM`, и дальше комната живёт одними правилами.
     *
     * Присланные правила ложатся ПОВЕРХ пресета: человек выбрал режим и
     * подкрутил в нём одну строку, и подкрученное должно быть сильнее
     * выбранного, а не наоборот.
     */
    const mode = req.body?.mode
    // Консилиум — та же лекция, у которой замок открывает каждому свой лист.
    const preset = mode === 'council' ? COUNCIL_ROOM : mode === 'lecture' ? LECTURE_ROOM : null
    const asked =
      req.body?.rules && typeof req.body.rules === 'object' ? (req.body.rules as object) : null
    if (preset || asked) {
      setRules(id, readRules({ ...(preset ?? OPEN_ROOM), ...asked }))
    }
    /*
     * Память — сразу в строку, до первого пуска ядра.
     *
     * Занятие по зрению заводят накануне, и выбор «шесть гигабайт» должен
     * дожить до пары, а не быть отдельным походом в настройки утром. Контейнера
     * ещё нет, менять нечего — число просто лежит и ждёт своего `docker run`.
     */
    if (memory.ok && memory.mb !== null) {
      setSessionMemoryMb(id, memory.mb)
      forgetResources()
    }
    if (cpu.ok && cpu.cpus !== null) {
      setSessionCpus(id, cpu.cpus)
      forgetResources()
    }

    const staff = currentStaff(req)
    if (staff) setSeminarCreator(id, staff.name)

    const row = selectSeminar.get(id) as SeminarRow
    res.status(201).json(toSeminar(row))
  })

  router.patch('/api/admin/seminars/:id', requireStaff, (req, res) => {
    const row = seminarOr404(req, res)
    if (!row) return

    const body = req.body as
      | {
          name?: unknown
          archived?: unknown
          finished?: unknown
          rules?: unknown
          memoryMb?: unknown
          cpus?: unknown
        }
      | undefined
    if (body?.name !== undefined) {
      const name = normalize(body.name)
      if (!name) return invalid(res, tr("server.aSeminarNameIsRequired.f10426"))
      if (name.length > LIMITS.seminarName) {
        return invalid(res, tr("server.aSeminarNameMustBeCharactersOr.c9d56a", { p0: LIMITS.seminarName }))
      }
      /*
       * В строку — через `renameSession`, а не своим UPDATE.
       *
       * Здесь стоял второй такой же `UPDATE sessions SET name`, и с тех пор как
       * имя комнаты легло в кэш строки (db.ts · roomCache), он писал мимо него:
       * панель переименовывала семинар, а `getSession` до перезапуска отдавал
       * прежнее имя — той же карточке комнаты, публикации и списку курса. У
       * строки имени одна дверь, и она забывает кэш за собой.
       */
      renameSession(row.id, name)
      // ...and into the room, whose header reads the document rather than this
      // row. Without it a rename in the panel never reached the people inside,
      // and the seminar quietly had two names.
      //
      // Через visitSessionDoc: переименование прошлогоднего семинара поднимает
      // его тетрадь со всеми картинками, и без визита она лежала бы в памяти до
      // ближайшей уборки простаивающих комнат — а переименовывают их пачкой,
      // разбирая семестр (routes/doc-visit.ts).
      visitSessionDoc(row.id, (doc) => getMeta(doc).set('title', name))
    }
    if (body?.archived !== undefined) {
      if (typeof body.archived !== 'boolean') return invalid(res, tr("server.archivedMustBeTrueOrFalse.db6c12"))
      // Archiving is a label on the list, not a lock: a room with people still
      // in it keeps working, which is why nothing here touches the document.
      setArchived.run(body.archived ? Date.now() : null, row.id)
    }

    if (body?.finished !== undefined) {
      if (typeof body.finished !== 'boolean') return invalid(res, tr("server.finishedMustBeTrueOrFalse.f9f3c0"))
      /*
       * Та же дверь, что кнопка в комнате: преподаватель, закрывший вкладку и
       * вспомнивший про занятие в метро, не должен возвращаться в семинар ради
       * одного нажатия.
       *
       * Уже законченному время не переписывается: панель шлёт форму целиком, и
       * переименование семинара сдвигало бы «закончено в 15:40» на сейчас —
       * час, который спрашивают потом, чтобы узнать, когда кончилась пара.
       */
      const was = finishedAt(row.id)
      const at = body.finished ? (was ?? Date.now()) : null
      if (at !== was) {
        setClassFinished(row.id, at)
        // Комната узнаёт сейчас, а не при перезагрузке: иначе у студента ещё
        // горят кнопки, которые сервер уже не примет, и отказ читается как
        // поломка. Тем же кадром она и открывается обратно.
        broadcast(row.id, { t: 'class', finishedAt: at })
        // И ход агента обрывается — ровно как у кнопки в комнате
        // (control.ts · class:finish). Иначе «Закончить занятие» из панели
        // оставляет оракула править файлы там, где всем остальным уже только
        // читать.
        if (at !== null) stopAll(row.id)
      }
    }

    if (body?.rules !== undefined) {
      /*
       * Rules can be changed after the fact, and could always have been: the
       * server reads them fresh on every request, so a change takes effect at
       * once. Only the panel had no way to send one — a seminar created with
       * "everyone may run" stayed that way for its whole life, and the teacher
       * who wanted a lecture had to make a second room.
       */
      if (typeof body.rules !== 'object' || body.rules === null) {
        return invalid(res, tr("server.rulesMustBeAnObject.c2a9d1"))
      }
      setRules(row.id, readRules({ ...storedRules(row.id), ...(body.rules as object) }))
      // The room finds out now, not on its next reload: the panel greys its
      // controls from this, and a rule nobody was told about is a rule that
      // looks like a bug when a button stops working.
      broadcast(row.id, { t: 'rules', rules: storedRules(row.id) })
    }

    if (body?.memoryMb !== undefined) {
      const memory = readMemoryInput(body.memoryMb)
      if (!memory.ok) return invalid(res, memoryRefusal(memory.error))
      setSessionMemoryMb(row.id, memory.mb)
      forgetResources()
      /*
       * Живой комнате — прямо сейчас, и БЕЗ перезапуска ядра.
       *
       * Ради этого всё и затевалось: преподаватель, чьё ядро только что убили
       * по памяти, добавляет гигабайты и запускает ту же ячейку заново, не
       * потеряв ни переменных семинара, ни открытого терминала. Ответ не
       * ждётся: `docker update` на занятой машине занимает сотни миллисекунд,
       * а число уже записано — контейнера нет или docker отказал, и его
       * возьмёт следующий пуск. Что именно случилось, скажет журнал ядра.
       */
      if (memory.mb !== null) {
        void applyMemoryLimit(row.id, memory.mb).catch((err: unknown) => {
          console.error(`[kernel] лимит памяти для ${row.id} не доехал:`, err)
        })
      }
    }

    if (body?.cpus !== undefined) {
      const cpu = readCpuInput(body.cpus)
      if (!cpu.ok) return invalid(res, cpuRefusal(cpu.error))
      setSessionCpus(row.id, cpu.cpus)
      forgetResources()
      /*
       * Живой комнате — сразу, как и память. Оговорка одна и честная: потоки
       * numpy и torch считаются при старте интерпретатора, так что уже
       * запущенное ядро будет считать прежним их числом до перезапуска. Форма
       * об этом говорит вслух, поэтому здесь ядро не трогается.
       */
      // Сброс к умолчанию тоже меняет квоту уже работающего контейнера.
      void applyCpuLimit(row.id, cpu.cpus ?? defaultCpus()).catch((err: unknown) => {
        console.error(`[kernel] число ядер для ${row.id} не доехало:`, err)
      })
    }

    res.json(toSeminar(selectSeminar.get(row.id) as SeminarRow))
  })

  /**
   * Destructive, and owner-only for exactly that reason: this is not "hide the
   * card". It drops the roster, the notebook snapshot and every file the room
   * uploaded or wrote, none of which Colloq keeps a second copy of — a student
   * may be standing in the room as it goes. Archiving is the reversible action;
   * this one is for a seminar that must actually be gone.
   *
   * The ai_usage rows survive on purpose: they are anonymous counters of what
   * the instance's key really spent, and deleting a room should not quietly
   * rewrite that history.
   *
   * The live room is torn down before the rows go: the sockets are closed and
   * the document is evicted without a final flush, so nothing writes a snapshot
   * back for a seminar that no longer exists.
   *
   * New joins and kernel starts are blocked while the runtime is stopped.
   * If stopping fails, all persistent room data stays available for a retry.
   * After confirmation, sockets, documents and rows are removed synchronously.
   */
  router.delete('/api/admin/seminars/:id', ownerOnly('delete a seminar'), (req, res) => {
    const row = seminarOr404(req, res)
    if (!row) return
    if (kernelRetirementInProgress(row.id)) {
      res.status(503).json({ error: tr("server.theSeminarIsAlreadyStoppingTryAgain.ca0fd7"), reason: 'invalid' } satisfies AdminErrorBody)
      return
    }
    const release = blockKernelStarts(row.id)
    // `?reading=drop` — «удалить и то и другое». Умолчание сохраняет чтение.
    const keepReading = req.query.reading !== 'drop'
    void (async () => {
      try {
        // Keep the complete room until the broker confirms that its Pod is gone.
        // The gate rejects new joins/starts while existing ensure requests drain.
        stopAll(row.id)
        try {
          await shutdownSession(row.id, true)
        } catch (err) {
          console.warn(`[admin] could not stop the kernel for ${row.id}:`, err instanceof Error ? err.message : err)
          res.status(503).json({
            error: tr("server.deletionCouldNotFinishBecauseTheKernel.c885fc"),
            reason: 'invalid',
          } satisfies AdminErrorBody)
          return
        }
        closeControlRoom(row.id)
        dropSessionDoc(row.id)

        try {
          workspaceFs.rmSync(sessionDir(row.id), { recursive: true, force: true })
        } catch (err) {
          console.warn(`[admin] workspace cleanup for ${row.id} is incomplete:`, err instanceof Error ? err.message : err)
          forgetTree(row.id)
          res.status(503).json({
            error: tr("server.deletionCouldNotFinishBecauseSomeFiles.81f721"),
            reason: 'invalid',
          } satisfies AdminErrorBody)
          return
        }

        // И картинки вывода: они лежат не в папке комнаты, а на своей полке
        // рядом с базой (server/src/blobs.ts). Без этой строки папка дожила бы
        // до ближайшего подметания — оно есть, но час лишний.
        deleteRoomBlobs(row.id)

        const purge = db.transaction((id: string) => {
          deleteParticipants.run(id)
          deleteSnapshot.run(id)
          // The history is the notebook, in full, one keyframe at a time. A
          // seminar deleted with it left behind is a seminar the dialog said
          // was gone and whose every cell is still on disk — and still served
          // over HTTP to anyone holding an old token.
          discardHistory(id)
          // И заметки лекции: это единственное, что преподаватель писал себе
          // сам, и оставлять их в базе удалённой комнаты не за чем.
          discardNotes(id)
          // И баны: в строке бана лежит адрес человека, и переживать комнату,
          // которой больше нет, он не должен.
          discardBans(id)
          deleteSeminarRow.run(id)
        })
        purge(row.id)
        forgetCache(row.id)
        /*
         * И всё, что db.ts помнит о комнате: строку, правила и права её людей
         * по токену.
         *
         * Здесь звалось `forgetRules`, и пока в памяти лежали одни правила,
         * этого хватало. Теперь там же лежит и сама строка — то самое «жив ли
         * ещё семинар», которым дверь сокета встречает забытый в браузере
         * токен: не забыть её значило бы пускать в удалённую комнату до
         * перезапуска сервера.
         */
        forgetRoom(row.id)
        cellCounts.delete(row.id)
        fileCounts.delete(row.id)
        /*
         * Опубликованная страница — отдельный предмет, и её судьба спрашивается
         * отдельно. Она собрана целиком и лежит своими строками: за ней не
         * стоит ни комнаты, ни документа, так что «удалить комнату, чтение
         * оставить» — это выбор, а не отговорка. По умолчанию оставляется:
         * ссылку у студентов не отозвать, и страница, отвечающая 404 там, где
         * вчера был семинар, — худшее из двух.
         */
        const pub = publicationOf(row.id)
        if (pub) {
          if (keepReading) orphanPublication(row.id)
          else deletePublication(pub.id)
        }
        // В курсах остаётся надгробие: пропавшая четвёртая неделя ломает курс
        // для того, кто на ней сидел, и сдвигает нумерацию остальных.
        entombSeminar(row.id, row.name)

        /*
         * Второй проход — по тому, что могло воскреснуть, пока гасло ядро.
         *
         * Опоздавший вывод ячейки или пульт, дошедший до `getSessionDoc`
         * миллисекундой раньше сноса строк, поднимают документ заново, а он
         * пишет снимок и строку в ленту. Это дешёвые DELETE по ключу, и повтор
         * их ничего не стоит; зато комната после удаления действительно
         * удалена, а не возвращается на следующем перезапуске.
         */
        dropSessionDoc(row.id)
        deleteSnapshot.run(row.id)
        discardHistory(row.id)


        res.status(204).end()
      } catch (err) {
        console.error(
          `[admin] deleting ${row.id} failed:`,
          err instanceof Error ? err.message : err,
        )
        if (!res.headersSent)
          res.status(500).json({
            error: tr("server.theSeminarCouldNotBeDeleted.e7f27d"),
            reason: 'invalid',
          } satisfies AdminErrorBody)
      } finally { release() }
    })()
  })

  /* -------------------------------------------------------- oracle */

  router.get('/api/admin/oracle', requireStaff, (_req, res) => {
    res.json(getOracleSettings())
  })

  /*
   * Owner-only, and the reason is not tidiness. baseUrl is attacker-controlled
   * input that the provider then receives the instance's API key on: point it
   * at a host you own, press Test, and the key walks out in an Authorization
   * header — including a key that only ever lived in OPENAI_API_KEY and was
   * never typed into this panel. The same rewrite silently routes every
   * student's question and notebook context through that host until someone
   * notices. shared/admin.ts scopes a teacher to READING settings; the GET
   * below is that read, and it is masked.
   */
  router.put('/api/admin/oracle', ownerOnly('server.ownerAction.6'), (req, res) => {
    const parsed = parseOraclePatch(req.body)
    if ('error' in parsed) return invalid(res, parsed.error)
    // The response is the masked settings, like the GET: the key goes in and is
    // never handed back, not even to the teacher who just typed it.
    res.json(updateOracleSettings(parsed.patch))
  })

  // Owner-only for the same reason: this is the button that makes the server
  // send a request, with the key attached, to whatever host is configured.
  router.post('/api/admin/oracle/test', ownerOnly('server.ownerAction.7'), (_req, res) => {
    void testConnection().then(
      (result) => res.json(result),
      (err: unknown) => {
        // testConnection turns failures into results; reaching here means the
        // call itself broke, which is still a sentence and not a 500.
        console.error('[admin] oracle test failed:', err instanceof Error ? err.message : err)
        const broke: OracleTestResult = {
          ok: false,
          ms: null,
          message: tr("server.theTestCouldNotBeRunCheck.4fcf49"),
          model: null,
        }
        res.json(broke)
      },
    )
  })

  router.get('/api/admin/oracle/usage', requireStaff, (req, res) => {
    const now = Date.now()
    const asked = Number(req.query.since)
    const since =
      Number.isFinite(asked) && asked > 0
        ? Math.min(Math.max(asked, now - MAX_USAGE_WINDOW_MS), now)
        : now - DEFAULT_USAGE_WINDOW_MS
    res.json(summariseUsage(since))
  })

  return router
}
