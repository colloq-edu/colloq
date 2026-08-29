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
import { stopWork, work } from '../ai/agent.js'
import { allows, allowsAgent, oracleModeIn } from '@shared/rules'
import { getParticipant, getRules, getSession } from '../db.js'
import { sessionAuth } from './sessions.js'
import {
  actionAllowedIn,
  colorForId,
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
const MAX_ENTRY_ID = 128

const HOUR_MS = 3_600_000

/**
 * How many per-student allowances one room may spend in an hour.
 *
 * Thirty is a full lecture hall: the ceiling only ever meets a room where the
 * same person keeps coming back under new names, or a script.
 */
const ROOM_MULTIPLIER = 30

/**
 * The mode this seminar actually runs in.
 *
 * `inherit` is what every room is until somebody says otherwise. A room may
 * tighten — full down to hints, hints down to off — and may not loosen: an
 * instance that is off cannot be talked back on by a seminar's own settings,
 * because that decision belongs to whoever pays for the model rather than to
 * whoever booked the room.
 */
/** The room's mode, by the one rule shared with the panel. */
function oracleModeFor(
  sessionId: string,
  instance: 'off' | 'hints' | 'full',
): 'off' | 'hints' | 'full' {
  return oracleModeIn(getRules(sessionId), instance)
}

export function aiRoutes(): Router {
  const router = Router()

  router.get('/api/ai/status', (_req, res) => {
    const settings = getOracleSettings()
    // A student's panel asks one question — "is there an oracle here?" — and
    // a mode of 'off' or a limit of zero is the same answer as no API key.
    const enabled = aiReady() && settings.defaultMode !== 'off' && settings.questionsPerHour > 0
    res.json({ enabled, model: aiModel(), mode: settings.defaultMode })
  })

  router.post('/api/sessions/:id/ai/ask', (req, res) => {
    const sessionId = req.params.id
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    if (!getSession(sessionId)) return res.status(404).json({ error: 'session not found' })

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
            ? 'The oracle is switched off for this instance.'
            : 'The oracle is switched off for this seminar.',
      })
    }
    if (settings.questionsPerHour === 0) {
      return res
        .status(403)
        .json({ error: 'The oracle is switched off for this instance — no questions are allowed.' })
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
            ? 'No model is set up on this Colloq yet — add a key under Oracle in the teaching panel.'
            : 'No model is set up on this Colloq yet, so there is nobody to ask here.',
      })
    }

    const body = req.body as Partial<AiAskRequest> | undefined
    const raw = typeof body?.message === 'string' ? body.message : ''
    if (raw.length > MAX_MESSAGE) {
      return res.status(400).json({
        error: `That question is longer than ${MAX_MESSAGE.toLocaleString('en-GB')} characters. The notebook travels with it anyway — say the short version.`,
      })
    }
    const message = raw.trim()
    const requested = ACTIONS.includes(body?.action as AiAction) ? (body?.action as AiAction) : undefined
    const cellId = typeof body?.cellId === 'string' ? body.cellId : null
    /*
     * Выделение спрашивающего. Потолок — не про безопасность, а про смысл:
     * «сосредоточься на сорока ячейках» значит «ни на чём», а место в кадре
     * они займут за счёт остальной тетради.
     */
    const cellIds = Array.isArray(body?.cellIds)
      ? body.cellIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 20)
      : []
    if (!message && !requested) return res.status(400).json({ error: 'nothing to ask' })

    // Hints mode: the allowed action set is exactly {hint}. The quick actions
    // that exist to produce a solution — fix, improve, explain, debug — are
    // refused outright, and a typed question is answered as a nudge instead of
    // being bounced, so the composer still works during an exercise.
    let action = requested
    if (mode === 'hints') {
      if (action && !actionAllowedIn('hints', action)) {
        return res.status(403).json({
          error: 'This oracle is in hints mode: it can point you at the problem, but it will not write the answer for you. Ask for a hint instead.',
        })
      }
      action = 'hint'
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
            'Этот оракул работает подсказками: он покажет, где смотреть, но не станет делать за вас.',
        })
      }
      if (!allowsAgent(getRules(sessionId).agent, auth.role)) {
        return res.status(403).json({
          error:
            getRules(sessionId).agent === 'off'
              ? 'В этом семинаре оракул файлы не трогает.'
              : 'Просить оракула править файлы здесь может преподаватель.',
        })
      }
    }

    const limit = settings.questionsPerHour

    /*
     * Потолок на комнату, а не только на человека.
     *
     * Личный предел обходится перезаходом: имя в этой комнате ничем не
     * подтверждено — в этом весь смысл «одна ссылка, и всё», — так что новая
     * вкладка инкогнито даёт нового участника и свежие N вопросов. Настоящей
     * границы у счёта не было вовсе, а панель обещала защиту.
     *
     * Тридцать личных пределов на всю комнату: класс из двадцати человек, где
     * каждый спросил вдвое больше положенного, в него ещё укладывается, а
     * один человек, который открывает вкладки в цикле, — уже нет.
     */
    const roomLimit = limit * ROOM_MULTIPLIER
    const roomUsed = countRoomQuestions(sessionId, HOUR_MS)
    if (roomUsed >= roomLimit) {
      res.setHeader('Retry-After', '600')
      return res.status(429).json({
        error: `This seminar has used all ${roomLimit} of its oracle questions for the hour. Ask your teacher — they can raise the limit in the panel.`,
      })
    }

    const used = countRecentQuestions(sessionId, auth.participantId, HOUR_MS)
    if (used >= limit) {
      const resetAt = windowResetAt(sessionId, auth.participantId, HOUR_MS, limit)
      const minutes = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000)) : 60
      if (resetAt) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))))
      // "all 1 oracle question" is not a sentence. A cap of one is the one
      // case a teacher is most likely to set deliberately, so it gets its own.
      const spent =
        limit === 1
          ? 'You have used your one oracle question for this hour in this seminar'
          : `You have used all ${limit} of your oracle questions for this hour in this seminar`
      return res.status(429).json({
        error: `${spent}. You can ask again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      })
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
      action: action ?? 'ask',
    })

    const entryId = doing
      ? work({
          sessionId,
          participantId: auth.participantId,
          participantName: participant?.name ?? 'Someone',
          participantColor: participant?.color ?? colorForId(auth.participantId),
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
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    /*
     * 404 до того, как кто-нибудь тронет документ.
     *
     * `cancel` идёт в `docOf`, а тот в `getSessionDoc`, который поднимает
     * комнату: заводит историю строкой «opened», сеет стартовую тетрадь и
     * пишет снимок. Для удалённого семинара это воскрешение — по старому
     * токену, из строки, которой в списке уже нет.
     */
    if (!getSession(req.params.id)) return res.status(404).json({ error: 'session not found' })

    const entryId = typeof req.body?.entryId === 'string' ? req.body.entryId : ''
    if (!entryId || entryId.length > MAX_ENTRY_ID) {
      return res.status(400).json({ error: 'entryId is required' })
    }
    // Open to anyone present: a runaway answer is on every screen in the room,
    // and stopping it destroys nothing — the text that arrived stays put.
    // Ход оракула — не поток, и обрывается он иначе: см. agent.stopWork. Обе
    // остановки зовутся здесь, потому что кнопка на записи одна.
    stopWork(req.params.id, entryId)
    cancel(req.params.id, entryId)
    res.json({ ok: true })
  })

  router.delete('/api/sessions/:id/ai/thread', (req, res) => {
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    // То же, что и в cancel: clearThread поднимает комнату, а поднимать нечего.
    if (!getSession(req.params.id)) return res.status(404).json({ error: 'session not found' })
    // The thread belongs to the room, so clearing it is the host's call — a
    // student must not be able to wipe what the class asked.
    // Стирать общее — то же право, что и стереть всю доску: лента вопросов
    // принадлежит комнате, а не тому, кто спросил последним.
    if (!allows(getRules(req.params.id).wipe, auth.role)) {
      return res.status(403).json({
        error: 'Only the host can clear the oracle thread — those questions belong to the room.',
      })
    }
    clearThread(req.params.id)
    res.json({ ok: true })
  })

  return router
}
