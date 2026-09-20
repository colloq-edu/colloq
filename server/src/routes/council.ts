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
 * У POST один вид: вопрос о классе. Тело `{ question?: string }` — свои слова
 * преподавателя, а пустое тело значит заготовку, которую ставит СЕРВЕР
 * (`server.council.statusQuestion`): она едет модели в промпте и должна быть
 * одна для любого клиента, включая тот, что откроют через полгода.
 *
 * Спросить можно ВСЕГДА. 400 «в этой ячейке ещё никто ничего не написал» здесь
 * был и снят: на пустой ячейке кадр всё равно несёт текст общей ячейки и
 * markdown над ней, а «что это вообще за задание и как им действовать» —
 * законный вопрос ровно в те минуты, когда ещё никто ничего не написал.
 *
 * Модель видит задание, весь класс — черновики, запуски, отметки, тишину — и
 * решения поимённо. Имена настоящие, если инстанс это разрешает
 * (`OracleSettings.sendNames`, по умолчанию да); выключено — едут метки, и
 * соответствие «метка → человек» остаётся на сервере
 * (`CouncilOracleAnswer.people`). Сборка кадра и состояние — ai/council.ts;
 * здесь только право, лимит и ячейка.
 *
 * Хранение — council.ts, но через `deps`, а не напрямую: тесты подменяют его
 * списком в памяти, и маршрут проверяется без таблицы попыток — она живёт у
 * другого модуля и меняется отдельно от этого.
 */
import { json, Router, type Request, type Response } from 'express'
import { cellSource, findCell } from '@shared/notebook'
import { mayLeadCouncil, oracleLimitsIn, oracleModeIn } from '@shared/rules'
import { MAX_ORACLE_QUESTION, SESSION_MISSING, type CouncilOracle } from '@shared/protocol'
import { effortRank, isReasoningEffort, type ReasoningEffort } from '@shared/admin'
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
import { getParticipant, getRules, getSession } from '../db.js'
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

/**
 * Имя к попытке — здесь, а не в council.ts.
 *
 * Стопка преподавателя и так собирает имена (`toAttempt`), но оракулу едет не
 * стопка, а голые строки: подтягивать участника имеет смысл ровно на тех
 * попытках, которые сейчас уезжают в кадр, и ровно тогда, когда инстанс
 * разрешил слать имена. Строки участника может не быть вовсе — человек вышел,
 * его сняли, — и тогда кадр зовёт его меткой (ai/council.ts · namesFor).
 */
function named(sessionId: string, cellId: string): OracleAttempt[] {
  return attemptsOf(sessionId, cellId).map((attempt) => {
    let name: string | null = null
    try {
      name = getParticipant(sessionId, attempt.participantId)?.name ?? null
    } catch {
      /* строки участника нет — кадр обойдётся меткой */
    }
    return { ...attempt, name }
  })
}

const live: CouncilOracleDeps = { attemptsOf: named, oracleOf, setOracle }

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

  /*
   * Разбор тела — свой, а не только общий из app.ts.
   *
   * Общий `express.json` стоит на приложении и до этого маршрута доходит; но
   * роутер собирается и в тестах, где приложения нет вовсе, и вопрос о классе
   * там молча превращался бы в сводку — то есть проверялся бы не тот путь.
   * Повторный разбор ничего не стоит: body-parser пропускает тело, которое уже
   * прочитано (`req._body`).
   */
  router.post('/api/sessions/:id/council/:cellId/oracle', json({ limit: '8kb' }), (req, res) => {
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

    /*
     * Вопрос. Пустая строка — это «вопроса нет», а не «вопрос из пробелов»:
     * поле ввода пульта отправляет то, что в нём лежит, и Enter на пробеле
     * уезжать к модели не должен.
     *
     * Ни одного листа в ячейке — тоже законный случай, и раньше он был
     * единственным 400. Спросить «что это за задание и как им действовать»
     * хочется ровно тогда, когда никто ещё ничего не написал; кадр в этот
     * момент несёт текст общей ячейки и markdown над ней — этого хватает.
     */
    const body = (req.body ?? {}) as { question?: unknown; effort?: unknown }
    const asked =
      typeof body.question === 'string' ? body.question.trim().slice(0, MAX_ORACLE_QUESTION) : ''
    const question = asked !== '' ? asked : tr('server.council.statusQuestion')

    /*
     * Уровень размышлений — понизить может любой, поднять выше инстансового
     * может только преподаватель. Сюда доходит только преподаватель
     * (`mayLeadCouncil` выше), так что здесь проверяется лишь само значение;
     * права разбирает дверь /ai/ask, куда ходит вся комната.
     */
    const effort: ReasoningEffort | undefined = isReasoningEffort(body.effort)
      ? body.effort
      : undefined

    const attempts = deps.attemptsOf(sessionId, cellId)

    /*
     * Строка расхода — при приёме, как у /ai/ask: запрос к провайдеру уйдёт,
     * чем бы он ни кончился. Своё действие в учёте: оракул консилиума в
     * разбивке панели не должен прятаться среди «спросили». Кончится запрос
     * ничем — строка снимается (ai/council.ts · wasted).
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
      question,
      effort,
    })
    // 202: вопрос ушёл, ответ приедет сокетом (`council:oracle`) — как у /ai/ask.
    res.status(202).json(oracle satisfies CouncilOracle)
  })

  router.delete('/api/sessions/:id/council/:cellId/oracle', (req, res) => {
    const who = lead(req, res)
    if (!who) return
    /*
     * «Стоп» обязан работать ВСЕГДА, и «остановить нечего» — не ошибка.
     *
     * Кнопка и опоздавший ответ встречаются постоянно, и красить это красным
     * незачем. Но есть случай хуже: ячейка, застрявшая в `reading` без живого
     * чтения. Тогда «Стоп» раньше не делал ничего, а следующий вопрос получал
     * 409 «уже готовится» — до перезапуска сервера. Поэтому store едет внутрь:
     * не нашлось, что обрывать, а состояние всё ещё «читает» — привести в
     * порядок и ответить успехом.
     */
    stopCouncilOracle(who.sessionId, who.cellId, deps)
    res.json({ ok: true })
  })

  return router
}
