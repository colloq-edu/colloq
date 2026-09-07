/**
 * Reading a room's history, and putting an old version back.
 *
 * Everyone in the seminar can read it: the notebook is shared, so who changed
 * what is not a secret from the people it was changed in front of. Restoring is
 * narrower — it rewrites what the whole room is looking at, so it belongs to
 * whoever is teaching.
 */
import { Router, type Request, type Response } from 'express'
import type { CellDiff, Version, VersionKind, VersionList } from '@shared/history'
import { SESSION_MISSING } from '@shared/protocol'
import { banDoor, sessionAuth } from './sessions.js'
import { allows } from '@shared/rules'
import { cellsWithCarets } from '../collab/index.js'
import { visitSessionDoc } from './doc-visit.js'
import { cellsAt, cellsOf, mark, restoreInto } from '../collab/history.js'
import { diffLines } from '@shared/diff'
import {
  getRules,
  getVersion,
  historyTrimmed,
  listParticipants,
  listStoryVersions,
  getSession,
} from '../db.js'

/**
 * Everyone in the room may read the history — the notebook is shared, so who
 * changed what is not a secret from the people it changed in front of. The two
 * writing routes below check for the host on top of this.
 */
function whoever(req: Request, res: Response): ReturnType<typeof sessionAuth> {
  /*
   * The room has to still exist. Without this the history routes were the one
   * door a deleted seminar was still open through: visitSessionDoc() below
   * builds a document for any id it is handed, so a stale token fetched the
   * notebook of a room the panel had already reported gone — rebuilding it in
   * memory to do so.
   */
  if (!getSession(req.params.id)) {
    res.status(404).json({ error: SESSION_MISSING })
    return null
  }
  const payload = sessionAuth(req)
  if (!payload) {
    res.status(401).json({ error: 'this history belongs to a seminar you are not in' })
    return null
  }
  /*
   * Лента — по правилу комнаты. По умолчанию её видит вся комната: тетрадь
   * общая, и кто что менял — не секрет от тех, при ком это менялось. Но
   * семинар, где тетрадь показывают, а не пишут вместе, вправе её закрыть:
   * там лента — это черновики преподавателя, которые он не показывал.
   *
   * Конец занятия это правило намеренно не трогает (shared/rules.ts ·
   * rulesAfterClass): история — чтение, а после пары за ней и приходят —
   * посмотреть, что было в ячейке до того, как её переписали. Закрываются
   * восстановление и чекпоинт, но они и так преподавательские.
   */
  if (!allows(getRules(req.params.id).history, payload.role)) {
    res.status(403).json({ error: 'Лента версий в этом семинаре — преподавательская.' })
    return null
  }
  return payload
}

/**
 * The timeline is read whole; a seminar that produced more than this is an outlier.
 *
 * Столько же берётся и названных моментов, отдельным окном: чекпоинт нельзя
 * вытеснить правками (см. listStoryVersions).
 */
const MAX_VERSIONS = 400

/**
 * Кто это написал — из одной карты на запрос, а не запросом на строку.
 *
 * `getParticipant` на каждую из четырёхсот строк — четыреста синхронных SELECT
 * на один GET, и лента открывается у всей комнаты разом: преподаватель сказал
 * «посмотрите историю», пятьсот человек нажали. Список участников комнаты —
 * один запрос, и дальше это поиск по Map.
 */
type People = Map<string, { name: string; color: string }>

function peopleOf(sessionId: string): People {
  const people: People = new Map()
  for (const person of listParticipants(sessionId)) {
    people.set(person.id, { name: person.name, color: person.color })
  }
  return people
}

function toVersion(
  people: People,
  row: {
    seq: number
    kind: string
    author_id: string | null
    created_at: number
    label: string | null
    summary: string
    added: number
    removed: number
    cells: string
    target_seq: number | null
  },
): Version {
  const person = row.author_id ? (people.get(row.author_id) ?? null) : null
  return {
    seq: row.seq,
    kind: row.kind as VersionKind,
    authorId: row.author_id,
    authorName: person?.name ?? null,
    authorColor: person?.color ?? null,
    createdAt: row.created_at,
    label: row.label,
    summary: row.summary,
    added: row.added,
    removed: row.removed,
    cells: JSON.parse(row.cells) as string[],
    targetSeq: row.target_seq,
  }
}

export function historyRoutes(): Router {
  const router = Router()

  // Лента — тоже комната: закрытый доступ закрывает и её (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  /**
   * The timeline.
   *
   * НЕ сбрасывает открытый всплеск, хотя когда-то сбрасывал и комментарий об
   * этом пережил правку на несколько месяцев. Сбрасывать нельзя: чтение
   * истории — это чтение, а закрытие всплеска пишет версию, и панель, открытая
   * посреди набора, разрезала бы чужую строку пополам (коммит 862ca42).
   *
   * Последняя минута появляется не здесь, а у того, кто смотрит: панель
   * перечитывает список ещё раз через BURST_IDLE_MS после последней правки —
   * ровно тогда, когда сервер её и запишет.
   */
  router.get('/api/sessions/:id/history', (req: Request, res: Response) => {
    if (!whoever(req, res)) return
    const sessionId = req.params.id
    /*
     * Load the room before reading its history.
     *
     * A seminar nobody has opened since the server started has no live
     * document, and therefore no base row — the one carrying a whole notebook
     * that every rebuild replays from. Without this the panel opens on an empty
     * list for a room full of work, which is exactly the moment somebody is
     * looking for something they lost. Binding it is what the first person
     * through the door would have done anyway.
     *
     * И тем же движением отпускаем: чужую тетрадь, поднятую ради одного
     * чтения, незачем держать в памяти до уборки простаивающих комнат
     * (routes/doc-visit.ts).
     */
    visitSessionDoc(sessionId, () => {})
    /*
     * Служебные строки отсеивает SQL, а не этот обработчик.
     *
     * Два вида — бухгалтерия, а не история: keyframe, с которого начинается
     * повтор, и quiet, байты которого повтору нельзя пропустить. Пока окно в
     * четыреста строк резалось до фильтра, их было столько, что окно уходило
     * на них целиком: пара с работающими ячейками писала тихую строку каждые
     * несколько секунд, и панель показывала горстку правок или пустоту — при
     * сотне правок и чекпоинте «до упражнения» в базе.
     *
     * И названные моменты запрос берёт своим окном: даже из одних правок
     * четыреста строк на активной паре набираются за час, а чекпоинт ставят,
     * чтобы к нему вернуться в конце.
     */
    const people = peopleOf(sessionId)
    const versions = listStoryVersions(sessionId, MAX_VERSIONS).map((r) => toVersion(people, r))

    /*
     * Признак неполноты едет вместе со строками, потому что по самим строкам
     * его не видно: обрезка по объёму (db.ts · trimHistory) убирает начало
     * ленты целиком, и остаток выглядит как полная история короткой пары.
     *
     * Он ровно про удалённое. Окно `MAX_VERSIONS` выше тоже отдаёт не всё, но
     * те версии в базе есть и открываются по ссылке — смешивать эти два вида
     * неполноты в одном слове нельзя.
     */
    const body: VersionList = { versions, trimmed: historyTrimmed(sessionId) }
    res.json(body)
  })

  /** The notebook as it stood at one version, and what that version changed. */
  router.get('/api/sessions/:id/history/:seq', (req: Request, res: Response) => {
    if (!whoever(req, res)) return
    const sessionId = req.params.id
    const seq = Number(req.params.seq)
    if (!Number.isInteger(seq)) return res.status(400).json({ error: 'bad version' })
    const row = getVersion(sessionId, seq)
    if (!row) return res.status(404).json({ error: 'no such version' })

    const after = cellsAt(sessionId, seq)
    // seq - 1 is not necessarily a row, but updatesUpTo takes a ceiling rather
    // than an exact address, so it resolves to the state just before this one.
    const before = cellsAt(sessionId, seq - 1)
    const wasById = new Map(before.map((c) => [c.id, c]))
    const nowById = new Map(after.map((c) => [c.id, c]))

    const touched: string[] = JSON.parse(row.cells)
    const diffs: CellDiff[] = touched.map((cellId) => {
      const was = wasById.get(cellId)?.source ?? null
      const now = nowById.get(cellId)?.source ?? null
      return {
        cellId,
        before: was,
        after: now,
        lines: diffLines(was ?? '', now ?? ''),
      }
    })

    res.json({ version: toVersion(peopleOf(sessionId), row), cells: after, diffs })
  })

  /**
   * Put a version back.
   *
   * The CRDT is not rewound. Rewinding would mean rolling back state vectors
   * that every browser in the room is holding, and the next keystroke from any
   * of them would arrive against a document that no longer matches — the room
   * would tear. Instead the old content is written into the live document as an
   * ordinary edit: it merges the way any edit merges, everybody sees it at
   * once, and because it is an edit it is itself a version, so a restore can be
   * undone by restoring what came before it.
   */
  router.post('/api/sessions/:id/history/:seq/restore', (req: Request, res: Response) => {
    const identity = whoever(req, res)
    if (!identity) return
    if (identity.role !== 'host') {
      return res.status(403).json({ error: 'only the host can restore a version' })
    }
    const sessionId = req.params.id
    const seq = Number(req.params.seq)
    const row = getVersion(sessionId, seq)
    if (!row) return res.status(404).json({ error: 'no such version' })

    const onlyCell = typeof req.body?.cellId === 'string' ? req.body.cellId : null
    /*
     * Время здесь не собирается. Сервер форматировал его по своему поясу — в
     * образе node это UTC, — а строки ленты рисует браузер по своему: в
     * аудитории UTC+3 подпись «restored the version from 15:04» указывала на
     * строку, которой в списке нет. Версия называется адресом (`targetSeq`),
     * а часы рисует тот, кто смотрит.
     */
    const changed = visitSessionDoc(sessionId, (doc) =>
      restoreInto(
        sessionId,
        doc,
        seq,
        identity.participantId,
        onlyCell,
        // Кто сейчас печатает — перестановке ячеек: подвинуть ячейку она может
        // только пересоздав её клоном, а клон уносит нажатия, ушедшие в старый
        // `Y.Text` за круг до сервера. Где выбор есть, останется та, где курсор.
        cellsWithCarets(doc),
      ),
    )

    res.json({ restored: changed })
  })

  /** Name this moment, so it can be found later without reading the whole list. */
  router.post('/api/sessions/:id/history/checkpoint', (req: Request, res: Response) => {
    const identity = whoever(req, res)
    if (!identity) return
    if (identity.role !== 'host') {
      return res.status(403).json({ error: 'only the host can set a checkpoint' })
    }
    const sessionId = req.params.id
    const label = String(req.body?.label ?? '')
      .trim()
      .slice(0, 80)
    if (!label) return res.status(400).json({ error: 'a checkpoint needs a name' })

    const marked = visitSessionDoc(sessionId, (doc) => ({
      seq: mark(sessionId, doc, 'checkpoint', identity.participantId, label, label),
      cells: cellsOf(doc).length,
    }))
    res.status(201).json(marked)
  })

  return router
}
