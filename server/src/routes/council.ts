import { tr } from '@shared/i18n'
/**
 * Единственная REST-дверь консилиума: спросить оракула о решениях.
 *
 * Всё остальное в консилиуме ходит по управляющему сокету (control.ts ·
 * council:*): попытки, показ, ответы, отметки. Оракул — здесь, потому что он
 * ходит к той же модели и тратит тот же лимит вопросов комнаты, что и
 * `/api/sessions/:id/ai/ask` (routes/ai.ts · countRoomQuestions/recordQuestion),
 * и право у него то же: только преподаватель (`sessionAuth`, роль по куке
 * штата, а не из токена).
 *
 *   POST   /api/sessions/:id/council/:cellId/oracle  — «Спросить»/«Обновить»:
 *          один вопрос из лимита; ответ уходит сокетом (`council:oracle`),
 *          здесь — 202 с текущим `CouncilOracle` (state: 'reading') или отказ
 *          словами: 403 выключен / 503 нет ключа / 429 лимит / 409 уже читает
 *   DELETE /api/sessions/:id/council/:cellId/oracle  — «Стоп»
 *
 * Модель видит тексты по группам с числами, задание (текст общей ячейки) и
 * эталон, если есть; имён не видит — их подставляет пульт по ключам групп.
 * Сборка кадра, разбор ответа и состояние — ai/council.ts; здесь только
 * право, лимит и ячейка.
 *
 * Хранение — council.ts, но через `deps`, а не напрямую: тесты подменяют его
 * списком в памяти, и маршрут проверяется без таблицы попыток — она живёт у
 * другого модуля и меняется отдельно от этого.
 */
import { Router, type Request, type Response } from 'express'
import { cellSource, findCell } from '@shared/notebook'
import { mayLeadCouncil, oracleLimitsIn, oracleModeIn } from '@shared/rules'
import { SESSION_MISSING, type CouncilOracle } from '@shared/protocol'
import { getOracleSettings } from '../admin/settings.js'
import { countRoomQuestions, recordQuestion } from '../admin/usage.js'
import {
  askCouncilOracle,
  idleOracle,
  isOracleReading,
  stopCouncilOracle,
  type OracleAttempt,
  type OracleStore,
} from '../ai/council.js'
import { aiReady } from '../ai/index.js'
import { visitSessionDoc } from './doc-visit.js'
import { attemptsOf, oracleOf, setOracle } from '../council.js'
import { getRules, getSession } from '../db.js'
/*
 * Потолок комнаты — тот же самый, а не такое же число.
 *
 * Здесь стояло собственное `ROOM_MULTIPLIER = 30` с комментарием «то же число,
 * что в routes/ai.ts», и это признание было единственным, что их связывало:
 * правка одного тихо разводила лимиты, хотя оракул сводки и оракул вопросов
 * тратят один ключ и считаются в одну таблицу. Теперь функция одна на обоих —
 * и она же знает, что потолок считается от размера комнаты.
 */
import { roomQuestionCeiling } from './ai.js'
import { banDoor, sessionAuth } from './sessions.js'

const HOUR_MS = 3_600_000

/** Откуда маршрут берёт попытки и куда кладёт оракула. По умолчанию — council.ts. */
export interface CouncilOracleDeps extends OracleStore {
  attemptsOf(sessionId: string, cellId: string): OracleAttempt[]
}

const live: CouncilOracleDeps = { attemptsOf, oracleOf, setOracle }

export function councilRoutes(deps: CouncilOracleDeps = live): Router {
  const router = Router()

  // Та же дверь, что у остальных маршрутов комнаты (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  /**
   * Кто и о какой ячейке. Три отказа, общие обоим маршрутам: не вошёл, нет
   * комнаты, не преподаватель. Слова отказа — те же, что у признака в пульте
   * (web/src/lib/may.ts · councilWhy), чтобы кнопка и сервер говорили одно.
   */
  const lead = (
    req: Request,
    res: Response,
  ): { sessionId: string; cellId: string; participantId: string } | null => {
    const sessionId = req.params.id
    const auth = sessionAuth(req)
    if (!auth) {
      res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
      return null
    }
    if (!getSession(sessionId)) {
      res.status(404).json({ error: SESSION_MISSING })
      return null
    }
    if (!mayLeadCouncil(auth.role)) {
      res.status(403).json({ error: tr("server.onlyTheTeacherMayLeadCouncil.9554ff") })
      return null
    }
    return { sessionId, cellId: req.params.cellId, participantId: auth.participantId }
  }

  router.post('/api/sessions/:id/council/:cellId/oracle', (req, res) => {
    const who = lead(req, res)
    if (!who) return
    const { sessionId, cellId } = who

    /*
     * Выключен, нет ключа, нет вопросов — те же три двери, что у /ai/ask, и
     * в том же порядке; слова по-русски, потому что читает их преподаватель с
     * пульта, а не студент из панели. Режим подсказок сюда пускает: сводка —
     * для ведущего, и решений за студентов она не пишет.
     */
    const settings = getOracleSettings()
    const mode = oracleModeIn(getRules(sessionId), settings.defaultMode)
    if (mode === 'off') {
      return res.status(403).json({
        error:
          settings.defaultMode === 'off'
            ? tr("server.theOracleIsDisabledOnThisColloq.e47e9a")
            : tr("server.theOracleIsDisabledForThisSeminar.48f5c6"),
      })
    }
    if (settings.questionsPerHour === 0) {
      return res
        .status(403)
        .json({ error: tr("server.theOracleIsDisabledOnThisColloq.395e3a") })
    }
    if (!aiReady()) {
      return res.status(503).json({
        error: tr("server.noModelIsConfiguredOnThisColloq.c1d63b"),
      })
    }

    /*
     * Ячейка — из документа комнаты, а не из тела запроса: задание для модели
     * — это текст общей ячейки, каким он сейчас есть у всех, и предыдущая
     * ячейка над ним как условие.
     *
     * Через `visitSessionDoc`: у идущего консилиума документ и так поднят, и
     * тогда это просто чтение; а вот «Обновить» в комнате, из которой все
     * вышли, поднимает её тетрадь, и без визита она лежала бы в памяти до
     * уборки простаивающих комнат (routes/doc-visit.ts). Из документа берутся
     * строки, а не ссылки на `Y.Text`: за границей визита документа может уже
     * не быть.
     */
    const task = visitSessionDoc(sessionId, (doc) => {
      const found = findCell(doc, cellId)
      if (!found) return null
      const before = found.index > 0 ? found.cells.get(found.index - 1) : null
      return {
        source: cellSource(found.cell).toString(),
        before: before ? cellSource(before).toString() : null,
        // Эталона в тетради пока нет: когда появится поле у ячейки — сюда.
        reference: null,
      }
    })
    if (!task) return res.status(404).json({ error: tr("server.thisCellIsNotInTheRoom.b481d9") })

    if (isOracleReading(sessionId, cellId)) {
      return res.status(409).json({
        error: tr("server.aSummaryIsAlreadyBeingPreparedWait.80427e"),
        oracle: deps.oracleOf(sessionId, cellId) ?? idleOracle(),
      })
    }

    /*
     * Потолок комнаты — и для преподавателя.
     *
     * У /ai/ask ведущего потолки не держат: его вопросы — это разбор, а в
     * комнатный предел его привёл бы класс. Здесь иначе: сводка — самый
     * дорогой вопрос в комнате, она везёт модели все решения разом, и
     * «Обновить» на каждую сдачу — ровно тот расход, от которого потолок
     * держит инстанс. Личный предел и слоу-мод ведущего не касаются и тут.
     */
    const limit = oracleLimitsIn(getRules(sessionId), settings).questionsPerHour
    const roomLimit = roomQuestionCeiling(sessionId, limit)
    const roomUsed = countRoomQuestions(sessionId, HOUR_MS)
    if (roomUsed >= roomLimit) {
      res.setHeader('Retry-After', '600')
      return res.status(429).json({
        error: tr("server.thisSeminarHasReachedItsHourlyLimit.7638ce", { p0: roomLimit }),
      })
    }

    const attempts = deps.attemptsOf(sessionId, cellId)
    if (!attempts.some((a) => a.submittedAt !== null)) {
      return res.status(400).json({ error: tr("server.thereAreNoSubmittedAttemptsToSummarize.64f4fd") })
    }

    /*
     * Строка расхода — при приёме, как у /ai/ask: запрос к провайдеру уйдёт,
     * чем бы он ни кончился. Своё действие в учёте: сводка в разбивке панели
     * не должна прятаться среди «спросили».
     */
    const usageId = recordQuestion({
      sessionId,
      participantId: who.participantId,
      action: 'council',
    })

    const oracle = askCouncilOracle({
      sessionId,
      cellId,
      task,
      attempts,
      store: deps,
      usageId,
    })
    // 202: вопрос ушёл, ответ приедет сокетом (`council:oracle`) — как у /ai/ask.
    res.status(202).json(oracle satisfies CouncilOracle)
  })

  router.delete('/api/sessions/:id/council/:cellId/oracle', (req, res) => {
    const who = lead(req, res)
    if (!who) return
    // Остановить нечего — тоже не ошибка: кнопка «Стоп» и опоздавший ответ
    // встречаются постоянно, и красить это красным незачем.
    stopCouncilOracle(who.sessionId, who.cellId)
    res.json({ ok: true })
  })

  return router
}
