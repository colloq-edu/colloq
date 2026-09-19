import { tr, formatNumber } from '@shared/i18n'
import { appendActivity } from '../activity.js'
/**
 * The oracle's REST surface.
 *
 * There is no response stream here any more. Asking is fire-and-forget: the
 * server appends the question to the session document and streams the answer
 * into it, so the reply reaches the whole room through the CRDT that already
 * carries cell outputs. The asker's own browser is just another reader of it.
 *
 * This is also where the instance's guardrails are enforced. They are checked
 * here rather than deeper in ai/index.ts on purpose: a refusal has to reach the
 * student as an HTTP status their panel can explain, not as an error bubble the
 * whole room watches the model appear to produce.
 */
import { Router } from 'express'
import { getOracleSettings } from '../admin/settings.js'
import {
  countRecentQuestions,
  countRoomQuestions,
  recordQuestion,
  windowResetAt,
} from '../admin/usage.js'
import { aiModel, aiReady, ask, cancel, clearThread } from '../ai/index.js'
import { stopAll, stopWork, turnsInRoom, work } from '../ai/agent.js'
import { seconds } from '../ai/text.js'
import { addressOf } from '../bans.js'
import {
  applyOnBehalf,
  getSessionDoc,
  onlineParticipantIds,
  peekSessionDoc,
} from '../collab/index.js'
import { mark } from '../collab/history.js'
import { cellLock, findCell, findChatEntry, getChat, rootOfCell, type CellLock } from '@shared/notebook'
import {
  actsAfterClass,
  allows,
  allowsAgent,
  CLASS_IS_OVER,
  mayEditCell,
  mayLeadCouncil,
  oracleLimitsIn,
  oracleModeIn,
  rulesForBook,
} from '@shared/rules'
import { getParticipant, getRules, getSession, isFinished } from '../db.js'
import { banDoor, sessionAuth } from './sessions.js'
import {
  actionAllowedIn,
  colorForId,
  SESSION_MISSING,
  type AiAction,
  type AiAskRequest,
  type AiAskResponse,
} from '@shared/protocol'

/*
 * Written out rather than derived from the type, so adding an action is a
 * deliberate act on both sides. It is also the list that silently swallowed
 * 'edit' the first time: the request carried it, this filter dropped it to
 * undefined, and the turn arrived as a plain question whose answer nobody could
 * apply — no error anywhere, just a feature that did nothing.
 */
const ACTIONS: readonly AiAction[] = ['explain', 'fix', 'debug', 'improve', 'hint', 'ask', 'edit']
/*
 * A question, not a document. Eight thousand characters is several screens of
 * typing — past that somebody is pasting a file in, and the notebook itself is
 * already travelling with the question.
 */
const MAX_MESSAGE = 8000
/**
 * Длина имени записи, ячейки и всего, что приезжает идентификатором.
 *
 * Сто двадцать восемь знаков — вчетверо больше самого длинного, какой этот
 * продукт выдаёт (`c_` плюс восемь шестнадцатеричных). Потолок стоит не ради
 * красоты: `cellId` и двадцать `cellIds` уходили в общий документ комнаты как
 * есть, а тело запроса — до мегабайта, так что один вопрос мог унести мегабайт
 * мусора в CRDT — с записью на диск, рассылкой всем пятистам сокетам и вечной
 * жизнью в снимках истории. Слишком длинное не режется, а отбрасывается: имя
 * ячейки — это ключ, и обрезанный ключ уже не тот, что просили.
 */
const MAX_ENTRY_ID = 128

const HOUR_MS = 3_600_000

/*
 * Потолок комнаты переехал в общую дверь к модели (ai/door.ts): его зовут уже
 * трое — вопрос, сводка консилиума и подсказка студенту, — и место ему там, а
 * не в одном из троих. Имя остаётся здесь ре-экспортом: на него ссылаются
 * routes/council.ts и тесты, и переименовывать их ради переезда незачем.
 */
export { roomQuestionCeiling } from '../ai/door.js'
import { oracleCapacity, roomQuestionCeiling } from '../ai/door.js'

/**
 * Сколько ответов оракул пишет в одной комнате разом.
 *
 * Потолки в час считают расход, а этот — цикл событий. Каждый идущий ответ
 * дописывается в общий документ несколько раз в секунду, и каждая такая правка
 * уезжает всем сокетам комнаты; ход агента вдобавок держит запрос к провайдеру
 * и правит файлы. Без границы слова преподавателя «спросите оракула» хватало,
 * чтобы двести человек начали двести потоков разом — а это сотни тысяч кадров
 * в секунду на пятистах сокетах, пропущенные пинги и разошедшаяся комната.
 *
 * Двенадцать — это «спросили и ждут» у дюжины человек одновременно; при ответе
 * секунд на десять комната переваривает больше вопроса в секунду, то есть
 * очередь рассасывается быстрее, чем класс успевает её создать. Отказ — не
 * ошибка, а ожидание: панель показывает его обратным отсчётом, как слоу-мод.
 */

/**
 * The mode this seminar actually runs in.
 *
 * `inherit` is what every room is until somebody says otherwise. A room may
 * tighten — full down to hints, hints down to off — and may not loosen: an
 * instance that is off cannot be talked back on by a seminar's own settings,
 * because that decision belongs to whoever pays for the model rather than to
 * whoever booked the room. The one rule, shared with the panel.
 */
function oracleModeFor(
  sessionId: string,
  instance: 'off' | 'hints' | 'full',
): 'off' | 'hints' | 'full' {
  return oracleModeIn(getRules(sessionId), instance)
}

/**
 * Своя ли это запись в треде — та, которую спросил он сам.
 *
 * `peekSessionDoc`, а не `getSessionDoc`: спрашиваем ради отказа, а отказ —
 * не повод заводить комнату заново (та же причина написана над самим
 * `peekSessionDoc`). Незнакомая запись считается чужой: останавливать в ней
 * нечего, и лучше пусть об этом скажет отказ, чем молчание.
 */
/**
 * Положение замка на ячейке — открыта, заперта, консилиум.
 *
 * Тем же `peekSessionDoc` и по той же причине: спрашиваем ради отказа, а отказ
 * — не повод поднимать тетрадь остывшей комнаты. Документа нет или ячейки в
 * нём нет — считаем запертой: право по догадке не раздаётся.
 */
function cellLockIn(sessionId: string, cellId: string | null): CellLock {
  if (!cellId) return 'closed'
  const doc = peekSessionDoc(sessionId)?.doc
  const found = doc ? findCell(doc, cellId) : null
  return found ? cellLock(found.cell) : 'closed'
}

/**
 * Корень тетради, в которой лежит эта ячейка, — для её собственного доступа.
 *
 * `null` — ячейки в комнате нет; тогда правила комнаты, как и раньше.
 */
function bookRootOf(sessionId: string, cellId: string | null): string | null {
  if (!cellId) return null
  const doc = peekSessionDoc(sessionId)?.doc
  return doc ? rootOfCell(doc, cellId) : null
}

function askedBy(sessionId: string, entryId: string, participantId: string): boolean {
  const doc = peekSessionDoc(sessionId)?.doc
  const entry = doc ? findChatEntry(doc, entryId) : null
  return entry ? (entry.get('participantId') as string) === participantId : false
}

/**
 * Убрать из ленты вопросы одного человека — и остановить то, что ему пишется.
 *
 * Живёт здесь, рядом с двумя другими ластиками ленты: тред стирают в этом
 * файле, и третий способ стереть его же в другом месте разошёлся бы с ними на
 * первой правке. Зовёт это бан (routes/bans.ts): спам в общей ленте — обычно
 * ровно то, за что банят, и оставить его висеть перед всей комнатой значит
 * наказать всех, кроме автора.
 *
 * Отметка в истории — ПЕРЕД удалением, и не для порядка. Лента живёт в
 * документе комнаты, а стёртое из документа возвращается только версией:
 * названный момент — единственное, чем преподаватель вернёт вычищенное, если
 * промахнулся человеком. Имя в отметке — забаненного, автор — того, кто банил.
 *
 * Идущий ответ обрывается той же парой, что и кнопка «Стоп» ниже: у хода агента
 * свой способ, у потока свой. Иначе модель ещё минуту дописывает ответ в
 * запись, которой в ленте уже нет.
 *
 * Возвращает, сколько записей убрали.
 */
export function purgeQuestions(
  sessionId: string,
  banned: { participantId: string; name: string },
  byTeacher: string,
): number {
  return purgeQuestionsOf(
    sessionId,
    new Set([banned.participantId]),
    byTeacher,
    tr("server.beforeBlocking.d2153d", { p0: banned.name }),
  )
}

/**
 * Снять из общего треда записи нескольких участников разом.
 *
 * Появилось 13.09.2026: скрипт с одного адреса завёл пятьсот «участников» по
 * одному вопросу на каждого — обход медленного режима, который считает по
 * человеку. Банить их по одному значило бы пятьсот контрольных точек в ленте
 * версий и пятьсот правок; здесь одна точка и одна правка на всех.
 */
export function purgeQuestionsOf(
  sessionId: string,
  participantIds: ReadonlySet<string>,
  byTeacher: string,
  label: string,
): number {
  /*
   * `getSessionDoc`, а не `peekSessionDoc`: вычистка — это правка, и правка
   * должна лечь в документ комнаты, а не мимо неё. Комнату, которую никто не
   * открывал с перезапуска, поднять придётся — иначе стёртое вернулось бы к
   * первому вошедшему с диска.
   *
   * И не `visitSessionDoc`, которым поднимает документ лента версий: гость
   * тетради тем же движением её отпускает (routes/doc-visit.ts), а здесь
   * отпускать нечего и незачем. Банят в идущей комнате — её документ поднят
   * теми, кто в ней сидит, — и сразу за вычисткой в том же запросе идут ещё два
   * шага по той же комнате: стопки консилиума без забаненного и закрытие его
   * сокетов (routes/bans.ts). А поднятую вхолостую — бан сразу после
   * перезапуска, пока никто не переподключился, — отпустит уборка
   * простаивающих комнат (collab/index.ts · sweepIdleRooms).
   */
  const { doc } = getSessionDoc(sessionId)
  const chat = getChat(doc)
  const at: number[] = []
  const ids: string[] = []
  for (let i = 0; i < chat.length; i++) {
    const entry = chat.get(i)
    const author: unknown = entry.get('participantId')
    if (typeof author !== 'string' || !participantIds.has(author)) continue
    at.push(i)
    const id: unknown = entry.get('id')
    if (typeof id === 'string') ids.push(id)
  }
  if (at.length === 0) return 0

  mark(sessionId, doc, 'checkpoint', byTeacher, label, label)

  for (const id of ids) if (!stopWork(sessionId, id)) cancel(sessionId, id)

  /*
   * От имени преподавателя, а не «комнаты»: в ленте версий у этой строки должно
   * стоять имя того, кто банил, — иначе рядом с названным моментом «до бана
   * Пети» стоит ничья правка на двенадцать записей.
   *
   * С конца: индексы посчитаны до удаления, и снятие первого сдвинуло бы все
   * следующие.
   */
  applyOnBehalf(sessionId, byTeacher, () => {
    for (let i = at.length - 1; i >= 0; i--) chat.delete(at[i], 1)
  })
  return at.length
}

/** Сколько имён можно снять из треда одним запросом. */
const MAX_PRUNE_IDS = 2000
/** Длина id участника — та же, что у routes/bans.ts. */
const MAX_ID = 128
/** Новичок молчит: токену участника должно быть хотя бы столько. */
const NEWCOMER_MS = 2 * 60_000
/**
 * Вопросов оракулу с одного адреса за окно — на все имена сразу.
 *
 * Больше дюжины одновременных в комнате (см. ниже, IN_FLIGHT): очередь
 * комнаты должна отказывать первой, иначе класс за одним NAT, упёршийся в
 * очередь, читал бы «с вашего адреса» вместо «подождите пять секунд».
 */
const ADDRESS_ASKS = 20
const ADDRESS_WINDOW_MS = 60_000
const asksByAddress = new Map<string, number[]>()

function addressMayAsk(sessionId: string, address: string): boolean {
  const key = `${sessionId} ${address}`
  const now = Date.now()
  const recent = (asksByAddress.get(key) ?? []).filter((at) => now - at < ADDRESS_WINDOW_MS)
  if (recent.length >= ADDRESS_ASKS) {
    asksByAddress.set(key, recent)
    return false
  }
  recent.push(now)
  asksByAddress.set(key, recent)
  // Карта не растёт без предела: адреса, замолчавшие на окно, уносятся здесь же.
  if (asksByAddress.size > 5000) {
    for (const [k, v] of asksByAddress) if (v.every((at) => now - at >= ADDRESS_WINDOW_MS)) asksByAddress.delete(k)
  }
  return true
}

export function aiRoutes(): Router {
  const router = Router()

  // Забаненный не пишет в общий тред и не тратит ключ инстанса: purgeQuestions
  // убирает написанное, а это — закрывает дверь (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  router.get('/api/ai/status', (_req, res) => {
    const settings = getOracleSettings()
    // A student's panel asks one question — "is there an oracle here?" — and
    // a mode of 'off' or a limit of zero is the same answer as no API key.
    const enabled = aiReady() && settings.defaultMode !== 'off' && settings.questionsPerHour > 0
    res.json({
      enabled,
      model: aiModel(),
      mode: settings.defaultMode,
      /*
       * Потолки инстанса — чтобы «как на инстансе» в пульте правил называло
       * число, а не оставалось обещанием: строка «не ниже инстансового», под
       * которой не написано какого, не говорит преподавателю ничего. Не тайна:
       * то же число студент читает в отказе, когда в него упирается.
       */
      questionsPerHour: settings.questionsPerHour,
      slowModeSeconds: settings.slowModeSeconds,
      agentSteps: settings.agentSteps,
    })
  })

  router.post('/api/sessions/:id/ai/ask', (req, res) => {
    const sessionId = req.params.id
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })

    /*
     * Занятие закончено — спрашивает один преподаватель.
     *
     * Правилом это не выразить: у `oracle` нет измерения «кто» — он про
     * подробность ответа для всей комнаты, включая ведущего. Отказ стоит раньше
     * всех остальных, потому что вопрос ложится в общий тред: запись «объясни
     * это», под которой никогда не появится ответ, читается как поломка, а не
     * как конец пары. Режим «сделать» этой же проверкой и закрыт — участник до
     * него не доходит.
     */
    if (!actsAfterClass(isFinished(sessionId), auth.role)) {
      return res.status(403).json({ error: tr(CLASS_IS_OVER) })
    }

    const settings = getOracleSettings()
    /*
     * The room may say something different from the instance, and when it does
     * the room wins — but only downwards. One class is an exercise and the next
     * is a demonstration, and they should not have to share a setting.
     */
    const mode = oracleModeFor(sessionId, settings.defaultMode)
    if (mode === 'off') {
      return res.status(403).json({
        error:
          settings.defaultMode === 'off'
            ? tr("server.theOracleIsSwitchedOffForThis.2c2849")
            : tr("server.theOracleIsSwitchedOffForThis.9dc39a"),
      })
    }
    if (settings.questionsPerHour === 0) {
      return res
        .status(403)
        .json({ error: tr("server.theOracleIsDisabledInThisColloq.e3d7f7") })
    }
    if (!aiReady()) {
      /*
       * Where to fix it is staff information. A student who cannot open the
       * panel is not helped by being sent to it, and an instance that names its
       * own admin surface to everyone who asks is telling strangers where to
       * knock. The panel splits this the same way — see AiPanel.
       */
      return res.status(503).json({
        error:
          auth.role === 'host'
            ? tr("server.noModelIsSetUpOnThis.9957d2")
            : tr("server.noModelIsConfiguredForThisColloq.112833"),
      })
    }

    const body = req.body as Partial<AiAskRequest> | undefined
    const raw = typeof body?.message === 'string' ? body.message : ''
    if (raw.length > MAX_MESSAGE) {
      return res.status(400).json({
        error: tr("server.thatQuestionIsLongerThanCharactersShorten.a8c280", { p0: formatNumber(MAX_MESSAGE) }),
      })
    }
    const message = raw.trim()
    const requested = ACTIONS.includes(body?.action as AiAction)
      ? (body?.action as AiAction)
      : undefined
    /*
     * Имена ячеек — с потолком длины, и слишком длинное отбрасывается целиком.
     *
     * Оба поля ложатся в запись треда как есть, а запись — в общий документ
     * комнаты: он персистится, уезжает всем сокетам и остаётся в снимках
     * истории, откуда его достаёт только удаление треда преподавателем. Пока
     * потолка не было, один вопрос мог унести туда почти мегабайт (тело
     * запроса — express.json), а по часовому пределу — сотни мегабайт с одного
     * участника. См. MAX_ENTRY_ID.
     */
    const asked = typeof body?.cellId === 'string' ? body.cellId : ''
    const cellId = asked && asked.length <= MAX_ENTRY_ID ? asked : null
    /*
     * Выделение спрашивающего. Потолок на число — не про безопасность, а про
     * смысл: «сосредоточься на сорока ячейках» значит «ни на чём», а место в
     * кадре они займут за счёт остальной тетради.
     */
    const cellIds = Array.isArray(body?.cellIds)
      ? body.cellIds
          .filter(
            (id): id is string =>
              typeof id === 'string' && id.length > 0 && id.length <= MAX_ENTRY_ID,
          )
          .slice(0, 20)
      : []
    if (!message && !requested) return res.status(400).json({ error: tr("server.nothingToAsk.d85713") })

    // Hints mode: the allowed action set is exactly {hint}. The quick actions
    // that exist to produce a solution — fix, improve, explain, debug — are
    // refused outright, and a typed question is answered as a nudge instead of
    // being bounced, so the composer still works during an exercise.
    let action = requested
    if (mode === 'hints') {
      if (action && !actionAllowedIn('hints', action)) {
        return res.status(403).json({
          error:
            tr("server.hintsModeIsEnabledAskForA.ec9c2a"),
        })
      }
      action = 'hint'
    }

    /*
     * «Переписать ячейку» — правка, а не ответ, и правило у неё от ЯЧЕЙКИ.
     *
     * `edit` — единственное действие, которое кончается предложением с кнопкой
     * «Применить» (ai/index.ts · patchBase), то есть правкой общей тетради.
     * Остальные — `explain`, `fix`, `debug`, `improve`, `hint`, `ask` — про
     * ячейку РАССКАЗЫВАЮТ, и в лекции они студенту не заказаны: спрашивать про
     * запертую ячейку можно и нужно.
     *
     * Проверка здесь, а не только у «Применить»: иначе участник в лекции пишет
     * фразу, тратит вопрос из часового лимита комнаты и получает предложение,
     * которое сам же принять не может, — а вопрос уже потрачен.
     *
     * Консилиум отдельным слагаемым: правило `edit` в открытой комнате
     * разрешает участнику править ячейки, но общая ячейка консилиума — это
     * задание, и переписать её под себя значило бы переписать его всему классу.
     * Свой лист у него есть, и у листа есть своя подсказка оракула.
     */
    if (action === 'edit') {
      const lock = cellLockIn(sessionId, cellId)
      /*
       * И по правилам ТОЙ ТЕТРАДИ, где ячейка лежит: «переписать» кончается
       * правкой, а правку спрашивают у тетради (shared/rules.ts · rulesForBook).
       * Иначе студент в лекции не мог бы попросить переписать ячейку в
       * собственной тетради — той самой, где он и сидит.
       */
      const here = rulesForBook(getRules(sessionId), bookRootOf(sessionId, cellId), {
        role: auth.role,
        participantId: auth.participantId,
      })
      const mayHere =
        mayEditCell(here, auth.role, lock === 'open', isFinished(sessionId)) &&
        (lock !== 'council' || mayLeadCouncil(auth.role))
      if (!mayHere) {
        return res.status(403).json({ error: tr('server.ai.cellIsTheTeachers') })
      }
    }

    /*
     * «Сделать» — не вопрос, и правило у него своё.
     *
     * Проверяется здесь, а не в агенте: отказ должен прийти до того, как в
     * тред ляжет поручение, — иначе комната увидит запись «сделай то-то», за
     * которой ничего не последует, и это читается как поломка, а не как
     * правило. Режим подсказок сюда не пускает никого: оракул, который не
     * пишет ответ за студента, тем более не пишет его в файл.
     */
    const doing = body?.mode === 'agent'
    if (doing) {
      if (mode === 'hints') {
        return res.status(403).json({
          error:
            tr("server.fileEditsAreUnavailableInHintsMode.29ff63"),
        })
      }
      if (!allowsAgent(getRules(sessionId).agent, auth.role)) {
        return res.status(403).json({
          error:
            getRules(sessionId).agent === 'off'
              ? tr("server.oracleFileEditingIsDisabledInThis.9b1999")
              : tr("server.onlyTheTeacherMayAskTheOracle.441f53"),
        })
      }
      /*
       * Один ход на комнату — и преподавателя это касается тоже.
       *
       * Потолок ниже (`oracleCapacity`) считает нагрузку и ведущего мимо себя
       * пропускает: его единственный вопрос среди дюжины студенческих ничего
       * не решает. С ходом это неправда, и дело не в нагрузке. Два хода в одной
       * комнате правят одну тетрадь и одни файлы наперегонки: у каждого свой
       * снимок «как было до хода», и отмена второго возвращает файл к тому, что
       * оставил первый, — то есть молча стирает его работу. Отметка в истории
       * версий ставится тоже дважды и указывает не туда. Ведущий здесь как раз
       * тот, кто попадает в это чаще всех: он единственный, кому режим доступен
       * во всякой комнате, и «нажал ещё раз, потому что долго думает» — его
       * обычное движение.
       *
       * 409, а не 429: это не «подождите очереди», а «так нельзя, пока идёт
       * тот». Кнопка «Стоп» под ходом — рядом, в той же панели.
       */
      if (turnsInRoom(sessionId) > 0) {
        return res.status(409).json({ error: tr('server.agent.busyTurn') })
      }
    }

    /*
     * Потолки — настройка инстанса, ужесточённая правилами комнаты: одна
     * функция на сервер и на пульт, и она же держит границу «комната
     * ужесточает, но не ослабляет» (shared/rules.ts · oracleLimitsIn).
     */
    const limits = oracleLimitsIn(getRules(sessionId), settings)
    const limit = limits.questionsPerHour

    /*
     * Потолки — про класс, а не про ведущего.
     *
     * Оба счёта ниже держат инстанс от комнаты: от человека, спросившего
     * лишнего, и от вкладок, открываемых в цикле. Преподаватель — не тот, от
     * кого это стоит держать: он ведёт занятие, и вопросы у него идут подряд
     * потому, что подряд идёт разбор. Упереться посреди пары в собственный
     * потолок он не должен, а в общий по комнате — тем более: туда его привёл
     * бы не он, а класс, и молчал бы тогда как раз тот, кто эту пару ведёт.
     *
     * Роль здесь та же, по которой маршрут уже пропускает ведущего мимо
     * слоу-мода ниже. Из счёта его вопросы не вычитаются: расход инстанса —
     * это расход, и в панели он виден как есть.
     */
    if (auth.role !== 'host') {
      /*
       * Потолок на комнату, а не только на человека.
       *
       * Личный предел обходится перезаходом: имя в этой комнате ничем не
       * подтверждено — в этом весь смысл «одна ссылка, и всё», — так что новая
       * вкладка инкогнито даёт нового участника и свежие N вопросов. Настоящей
       * границы у счёта не было вовсе, а панель обещала защиту.
       *
       * Тридцать личных пределов на всю комнату — или по половине на человека,
       * если людей больше шестидесяти: класс из двадцати, где каждый спросил
       * вдвое больше положенного, укладывается в первое, поток на пятьсот — во
       * второе, а один человек, открывающий вкладки в цикле, не укладывается ни
       * во что (roomQuestionCeiling).
       */
      const roomLimit = roomQuestionCeiling(sessionId, limit)
      const roomUsed = countRoomQuestions(sessionId, HOUR_MS)
      if (roomUsed >= roomLimit) {
        res.setHeader('Retry-After', '600')
        /*
         * Куда идти — правда, а не вежливость.
         *
         * Здесь стояло «попросите преподавателя, он поднимет предел в панели».
         * Поднять его преподаватель не может: правила комнаты потолок только
         * ужесточают (shared/rules.ts · oracleLimitsIn), а ручка живёт в
         * админке инстанса, куда преподаватель обычно и не вхож. Двадцать
         * человек шли к нему, он шёл в пульт и не находил там ничего. Читает
         * это только участник — ведущего потолки не держат, — так что сказать
         * надо ровно то, что ему поможет: ждать или спрашивать сообща.
         */
        return res.status(429).json({
          error: tr("server.thisSeminarHasUsedAllOracleQuestions.5ff314", { p0: roomLimit }),
        })
      }

      const used = countRecentQuestions(sessionId, auth.participantId, HOUR_MS)
      if (used >= limit) {
        const resetAt = windowResetAt(sessionId, auth.participantId, HOUR_MS, limit)
        const minutes = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000)) : 60
        if (resetAt)
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))))
        // "all 1 oracle question" is not a sentence. A cap of one is the one
        // case a teacher is most likely to set deliberately, so it gets its own.
        const spent =
          limit === 1
            ? tr("server.youHaveUsedYourOneOracleQuestion.61ab29")
            : tr("server.youHaveUsedAllOfYourOracle.7a4f7f", { count: limit })
        return res.status(429).json({
          error: tr('server.askAgain', { spent, count: minutes }),
        })
      }
    }

    /*
     * Слоу-мод: не сколько вопросов, а как часто.
     *
     * Потолок в час ловит расход, а не спам: двадцать вопросов можно выкрикнуть
     * за двадцать секунд, и наказан будет не выкрик, а следующий настоящий
     * вопрос — через час без оракула. Промежуток стоит ровно там, где спам, и
     * стоит секунды.
     *
     * Стоит ПОСЛЕ потолков, а не перед ними: у кого вопросы на час кончились,
     * тот должен услышать про час, а не про десять секунд, после которых его
     * всё равно развернут.
     *
     * Преподавателя не касается. Он не спамит — он ведёт занятие, и его вопросы
     * идут подряд потому, что подряд идёт разбор; роль здесь та же, по которой
     * этот маршрут уже различает ведущего выше.
     *
     * Тот же `windowResetAt`, что и у потолка в час: с пределом в один вопрос
     * «когда окно отпустит» и означает «когда пройдёт промежуток после
     * последнего». Второго счётчика заводить не за что.
     */
    /*
     * Две защиты от скрипта, а не от человека (13.09.2026, открытое занятие: с
     * одного адреса за два часа пятьсот «участников» по одному вопросу каждый).
     *
     * Медленный режим и потолок в час считаются по человеку, и обходятся
     * ровно так: новый участник — новый счётчик. Поэтому первое — новичок
     * ждёт: вопрос оракулу принимается, когда токену участника хотя бы две
     * минуты. Студент входит по звонку и спрашивает позже; скрипт входит и
     * спрашивает в ту же секунду. Второе — адрес: сколько бы ни было имён,
     * провод один, и с одного адреса больше ADDRESS_ASKS за минуту не бывает
     * даже у класса за одним NAT — двенадцать вопросов оракулу в минуту с
     * одной школы это уже не вопросы. Преподавателя не касается ни то, ни
     * другое: он разбирает, и разбирает подряд.
     */
    if (auth.role !== 'host') {
      const age = typeof auth.iat === 'number' ? Date.now() - auth.iat : Infinity
      if (age < NEWCOMER_MS) {
        const left = Math.ceil((NEWCOMER_MS - age) / 1000)
        res.setHeader('Retry-After', String(left))
        return res.status(429).json({
          error: tr("server.theOracleAnswersThoseWhoHaveBeen.91d4c0", { p0: seconds(left) }),
          retryAfter: left,
        })
      }
      const address = addressOf(req)
      if (address && !addressMayAsk(sessionId, address)) {
        res.setHeader('Retry-After', '60')
        return res.status(429).json({
          error: tr("server.tooManyQuestionsFromYourAddress.5e2b8d"),
          retryAfter: 60,
        })
      }
    }

    const gap = limits.slowModeSeconds
    if (gap > 0 && auth.role !== 'host') {
      const freeAt = windowResetAt(sessionId, auth.participantId, gap * 1000, 1)
      const left = freeAt === null ? 0 : Math.ceil((freeAt - Date.now()) / 1000)
      if (left > 0) {
        res.setHeader('Retry-After', String(left))
        return res.status(429).json({
          error: tr("server.waitBetweenQuestionsTryAgainIn.f64333", { p0: seconds(gap), p1: seconds(left) }),
          /*
           * Число, а не только заголовок. Retry-After — для машины, а панели
           * этим числом ещё и решать, как показать отказ: ожидание — спокойная
           * строка с обратным отсчётом, а не красная ошибка, которой она
           * встречает всё остальное. Отличить одно от другого по тексту 429
           * она не может.
           */
          retryAfter: left,
        })
      }
    }

    /*
     * Сколько ответов пишется в комнате прямо сейчас.
     *
     * Стоит последним из отказов и последним по смыслу: это не про расход и не
     * про спам, а про то, что цикл событий у комнаты один. Считаются и потоки,
     * и ходы агента — второй дороже, но нагружает то же место.
     *
     * Преподавателя не касается, как и потолки выше: он ведёт занятие, и его
     * единственный вопрос среди дюжины студенческих ничего не решает — а вот
     * молчащий посреди разбора оракул решает многое.
     */
    const capacity = oracleCapacity(sessionId, auth.role)
    if (capacity) {
      res.setHeader('Retry-After', String(capacity.retryAfter))
      return res.status(429).json(capacity)
    }

    // Name and colour are resolved server-side: the bubble in everyone's panel
    // must say who really asked, not who the client claims to be.
    const participant = getParticipant(sessionId, auth.participantId)
    /*
     * Строка расхода заводится до вопроса, а не после.
     *
     * Считать при приёме — старое и правильное решение: запрос к провайдеру
     * уже ушёл, чем бы он ни кончился, и предел, считающий только удачи,
     * позволял бы бесконечно долбить сломанную ручку. Изменилось одно: строка
     * теперь возвращает свой номер, и последний кадр потока кладёт на неё
     * настоящий расход вместо вечного NULL.
     */
    const usageId = recordQuestion({
      sessionId,
      participantId: auth.participantId,
      /*
       * У режима «сделать» своё действие в учёте.
       *
       * Под 'ask' он был неотличим от обычного вопроса, а это самая дорогая
       * строка в таблице: один ход ходит к модели до двенадцати раз и тащит с
       * собой файлы. Разбивка в панели — единственное место, где владелец
       * ключа видит, на что ушёл семестр, и слить туда «спросили» и «сделали»
       * значит спрятать от него главную статью расхода.
       */
      action: doing ? 'work' : (action ?? 'ask'),
    })

    const entryId = doing
      ? work({
          sessionId,
          participantId: auth.participantId,
          participantName: participant?.name ?? 'Someone',
          participantColor: participant?.color ?? colorForId(auth.participantId),
          // Роль — та, с которой человек действует прямо сейчас, а не та, с
          // которой он входил: ход правит тетрадь его руками и по его правам.
          role: auth.role,
          message,
          usageId,
        })
      : ask({
          sessionId,
          participantId: auth.participantId,
          participantName: participant?.name ?? 'Someone',
          participantColor: participant?.color ?? colorForId(auth.participantId),
          message,
          action,
          cellId,
          cellIds,
          usageId,
        })

    // 202: the question is in the document, the answer is still being written.
    const accepted: AiAskResponse = { entryId }
    res.status(202).json(accepted)
  })

  router.post('/api/sessions/:id/ai/cancel', (req, res) => {
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    /*
     * 404 до того, как кто-нибудь тронет документ.
     *
     * `cancel` идёт в `docOf`, а тот в `getSessionDoc`, который поднимает
     * комнату: заводит историю строкой «opened», сеет стартовую тетрадь и
     * пишет снимок. Для удалённого семинара это воскрешение — по старому
     * токену, из строки, которой в списке уже нет.
     */
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })

    const entryId = typeof req.body?.entryId === 'string' ? req.body.entryId : ''
    if (!entryId || entryId.length > MAX_ENTRY_ID) {
      return res.status(400).json({ error: tr("server.entryidIsRequired.a5742a") })
    }
    /*
     * Свою запись — автор, чужую — преподаватель. Больше никто.
     *
     * Здесь стояло «останавливать может кто угодно: ничего не разрушает» — и
     * это неправда ровно для чужой записи. Оборвать чужой ответ — это стереть
     * работу, которую человек ждёт, а оборвать чужой ход агента — остановить
     * его посреди правки файлов: половина тетради переписана, половина нет, и
     * такого состояния никто не просил. Своя запись — другое дело: она твоя, и
     * пришедший текст остаётся на месте, так что автор останавливает её всегда.
     *
     * Преподавателю чужая нужна по-настоящему: разогнавшийся ответ висит на
     * проекторе у всей комнаты, а спросил его кто-то из зала. Роль — та же, по
     * которой этот же файл выше решает, кому чинить оракул.
     *
     * Звонок отдельной проверки больше не требует: `actsAfterClass` разрешала
     * ровно то же — преподавателя всегда, участника до конца пары, — а участник
     * и до звонка теперь ходит только за своей записью.
     */
    if (auth.role !== 'host' && !askedBy(req.params.id, entryId, auth.participantId)) {
      return res.status(403).json({
        error:
          tr("server.youMayStopYourOwnQuestionOnly.9631c6"),
      })
    }
    /*
     * Ход оракула — не поток, и обрывается он иначе: см. agent.stopWork. Обе
     * остановки зовутся здесь, потому что кнопка на записи одна, но через
     * запятую их звать нельзя: `cancel` тут же помечает запись законченной, а
     * ход после «Стоп» ещё дописывает начатый шаг — запись выглядела бы
     * готовой, и под ней появлялись бы новые строки ленты. Состояние хода
     * ставит он сам, когда правда закончил.
     */
    if (!stopWork(req.params.id, entryId)) cancel(req.params.id, entryId)
    appendActivity(req.params.id, auth.participantId, 'oracle.cancel_requested', { entryId }, auth.role)
    res.json({ ok: true })
  })

  router.delete('/api/sessions/:id/ai/thread', (req, res) => {
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    // То же, что и в cancel: clearThread поднимает комнату, а поднимать нечего.
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })
    // The thread belongs to the room, so clearing it is the host's call — a
    // student must not be able to wipe what the class asked.
    // Стирать общее — то же право, что и стереть всю доску: лента вопросов
    // принадлежит комнате, а не тому, кто спросил последним.
    if (!allows(getRules(req.params.id).wipe, auth.role)) {
      return res.status(403).json({
        // После конца занятия `wipe` ужесточается сам (db.getRules), но называть
        // человеку правило тут уже неверно: он пойдёт искать преподавателя,
        // который ничего не менял.
        error: isFinished(req.params.id)
          ? tr(CLASS_IS_OVER)
          : tr("server.onlyTheTeacherCanClearTheShared.684c21"),
      })
    }
    /*
     * Стереть ленту — это и «остановить».
     *
     * Поток оракула clearThread обрывает сам; ход агента жил дальше и ещё
     * десяток шагов правил файлы и запускал скрипты — без строки в треде,
     * которая бы это объяснила, и без кнопки отмены, потому что выставить её
     * стало некуда. Здесь же, где рядом стоит та же пара для «Стоп».
     */
    /*
     * С именами — вычистить только их записи, без имён — весь тред. Список
     * приходит от преподавателя, который увидел в ленте сотню одинаковых
     * «участников» и хочет снять их, не теряя вопросы группы.
     */
    const listed: unknown = (req.body as { participantIds?: unknown } | undefined)?.participantIds
    if (Array.isArray(listed)) {
      if (listed.length > MAX_PRUNE_IDS) {
        return res.status(400).json({ error: tr("server.tooManyParticipantsToPrune.7a1c2e", { p0: MAX_PRUNE_IDS }) })
      }
      const ids = new Set(
        listed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID),
      )
      const byTeacher = getParticipant(req.params.id, auth.participantId)?.name ?? auth.participantId
      const removed = purgeQuestionsOf(req.params.id, ids, byTeacher, tr("server.beforePruningTheThread.4b0d9f"))
      appendActivity(req.params.id, auth.participantId, 'oracle.thread_pruned', { count: removed }, auth.role)
      return res.json({ ok: true, removed })
    }
    stopAll(req.params.id)
    clearThread(req.params.id)
    appendActivity(req.params.id, auth.participantId, 'oracle.thread_cleared', {}, auth.role)
    res.json({ ok: true })
  })

  return router
}
