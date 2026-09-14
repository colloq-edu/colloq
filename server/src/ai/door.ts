import { tr } from '@shared/i18n'
/**
 * Одна дверь к модели — та, что считает вопросы и говорит «нет» словами.
 *
 * Правила у оракула написаны один раз (`/ai/ask`, routes/ai.ts) и до сих пор
 * жили только там: выключен на инстансе, выключен в комнате, нет ключа, потолок
 * комнаты, личный потолок, новичок ждёт, слоу-мод. Второй вход к той же модели
 * — подсказка студенту в консилиуме (control.ts · council:hint) — ходит не по
 * HTTP, а сокетом, и без общей двери у него завелась бы вторая копия семи
 * проверок. Копия, которая однажды разойдётся с первой: обойти лимит можно
 * будет через ту дверь, где правило забыли поправить.
 *
 * Здесь нет ровно двух вещей из `/ai/ask`, и обе — не потеря. Предел по адресу
 * живёт на HTTP (bans.ts · addressOf читает заголовки запроса); у сокета адрес
 * тоже есть, но пускать его сюда значило бы протащить `Request` в модуль,
 * который про сеть ничего не знает. И режим подсказок: он про то, ЧТО модель
 * отвечает, а не про то, пускать ли спрашивать, — его разбирают зовущие.
 *
 * Потолок комнаты жил в routes/ai.ts и переехал сюда вместе с остальным: его
 * зовут уже трое (вопрос, сводка консилиума, подсказка), и место ему в общем
 * модуле, а не в одном из троих.
 */
import { actsAfterClass, CLASS_IS_OVER, oracleLimitsIn, oracleModeIn } from '@shared/rules'
import { getOracleSettings } from '../admin/settings.js'
import {
  countRecentQuestions,
  countRoomQuestions,
  windowResetAt,
} from '../admin/usage.js'
import { onlineParticipantIds } from '../collab/index.js'
import { getRules, isFinished } from '../db.js'
import { aiReady, streamsInRoom } from './index.js'
import { turnsInRoom } from './agent.js'
import { seconds } from './text.js'

const HOUR_MS = 3_600_000

/**
 * Сколько личных пределов комната может потратить за час, самое меньшее.
 *
 * Тридцать было написано как «полный лекционный зал» и держалось за это число
 * намертво: при инстансовом пределе в 20 вопросов комната получала 600 на всех
 * — чуть больше одного на человека в зале на 500. Теперь это ПОЛ: маленькой
 * комнате достаётся ровно столько же, сколько доставалось, большая считает от
 * своего размера.
 */
const ROOM_MULTIPLIER = 30

/**
 * Сколько вопросов комната может потратить за час.
 *
 * Считается от числа людей, которые сейчас в комнате, — по половине личного
 * предела на человека. Половина, а не целое, потому что этот потолок держит не
 * класс, а вкладки: личный предел обходится перезаходом (имя в комнате ничем не
 * подтверждено — в этом весь смысл «одна ссылка, и всё»), и открывающий вкладки
 * в цикле получает по новому пределу на каждую. Присутствие ему тоже приходится
 * держать открытым, но выиграть он может только вдвое, а не без границы.
 *
 * Присутствие, а не таблица участников: та помнит всякого, кто входил в этот
 * семинар за все его пары, и по ней комната из трёх человек выглядела бы на
 * полторы сотни.
 */
export function roomQuestionCeiling(sessionId: string, limit: number): number {
  const people = onlineParticipantIds(sessionId).length
  return limit * Math.max(ROOM_MULTIPLIER, Math.ceil(people / 2))
}

/**
 * Новичок ждёт две минуты.
 *
 * 13.09.2026: с одного адреса за два часа пятьсот «участников» по одному
 * вопросу каждый. Личный счётчик обходится новым участником, а вот возрастом
 * токена — нет: студент входит по звонку и спрашивает позже, скрипт входит и
 * спрашивает в ту же секунду.
 */
export const NEWCOMER_MS = 120_000

/** Кто спрашивает — ровно то, что двери нужно знать о человеке. */
export interface Asker {
  role: 'host' | 'participant'
  participantId: string
  /** Когда выписан токен участника: по нему считается «новичок ждёт». */
  iat?: number
}

/** Открыта ли дверь. `null` — открыта; строка — отказ теми словами, что показать. */
export interface DoorRefusal {
  error: string
  /** Через сколько секунд пробовать снова — если это ожидание, а не запрет. */
  retryAfter?: number
}

const hintsInRoom = new Map<string, number>()

/** Private hints, public answers and agent turns share the same room capacity. */
export function oracleCapacity(sessionId: string, role: Asker['role']): DoorRefusal | null {
  if (role === 'host') return null
  const busy = streamsInRoom(sessionId) + turnsInRoom(sessionId) + (hintsInRoom.get(sessionId) ?? 0)
  if (busy < 12) return null
  return {
    error: tr('server.thereAreAlreadyOracleRequestsRunningIn.5ae3f8', { p0: busy, p1: seconds(5) }),
    retryAfter: 5,
  }
}

/** Reserve until the provider settles, including failures and empty replies. */
export function holdOracleHint(sessionId: string): () => void {
  hintsInRoom.set(sessionId, (hintsInRoom.get(sessionId) ?? 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    const left = (hintsInRoom.get(sessionId) ?? 1) - 1
    if (left > 0) hintsInRoom.set(sessionId, left)
    else hintsInRoom.delete(sessionId)
  }
}

/**
 * Пустить ли этот вопрос к модели.
 *
 * Порядок отказов тот же, что у `/ai/ask`, и он не случайный: сперва то, что не
 * изменится от ожидания (кончилось занятие, выключено, нет ключа), потом
 * потолки, и только потом промежуток. У кого вопросы на час кончились, тот
 * должен услышать про час, а не про десять секунд, после которых его всё равно
 * развернут.
 *
 * Преподавателя потолки и промежуток не касаются: он ведёт занятие, и вопросы у
 * него идут подряд потому, что подряд идёт разбор.
 */
export function oracleDoor(sessionId: string, who: Asker): DoorRefusal | null {
  const settings = getOracleSettings()
  if (!actsAfterClass(isFinished(sessionId), who.role)) {
    return { error: tr(CLASS_IS_OVER) }
  }
  const mode = oracleModeIn(getRules(sessionId), settings.defaultMode)
  if (mode === 'off') {
    return {
      error:
        settings.defaultMode === 'off'
          ? tr('server.theOracleIsDisabledOnThisColloq.e47e9a')
          : tr('server.theOracleIsDisabledForThisSeminar.48f5c6'),
    }
  }
  if (settings.questionsPerHour === 0) {
    return { error: tr('server.theOracleIsDisabledOnThisColloq.395e3a') }
  }
  if (!aiReady()) {
    return { error: tr('server.noModelIsConfiguredForThisColloq.112833') }
  }
  if (who.role === 'host') return null

  const limits = oracleLimitsIn(getRules(sessionId), settings)
  const limit = limits.questionsPerHour

  const roomLimit = roomQuestionCeiling(sessionId, limit)
  if (countRoomQuestions(sessionId, HOUR_MS) >= roomLimit) {
    return {
      error: tr('server.thisSeminarHasUsedAllOracleQuestions.5ff314', { p0: roomLimit }),
      retryAfter: 600,
    }
  }

  if (countRecentQuestions(sessionId, who.participantId, HOUR_MS) >= limit) {
    const resetAt = windowResetAt(sessionId, who.participantId, HOUR_MS, limit)
    const minutes = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000)) : 60
    // «все 1 вопрос оракулу» — не фраза. Предел в один преподаватель ставит
    // осознанно чаще любого другого, и у него своя строка.
    const spent =
      limit === 1
        ? tr('server.youHaveUsedYourOneOracleQuestion.61ab29')
        : tr('server.youHaveUsedAllOfYourOracle.7a4f7f', { count: limit })
    return {
      error: tr('server.askAgain', { spent, count: minutes }),
      retryAfter: resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : 3600,
    }
  }

  const age = typeof who.iat === 'number' ? Date.now() - who.iat : Infinity
  if (age < NEWCOMER_MS) {
    const left = Math.ceil((NEWCOMER_MS - age) / 1000)
    return {
      error: tr('server.theOracleAnswersThoseWhoHaveBeen.91d4c0', { p0: seconds(left) }),
      retryAfter: left,
    }
  }

  const gap = limits.slowModeSeconds
  if (gap > 0) {
    const freeAt = windowResetAt(sessionId, who.participantId, gap * 1000, 1)
    const left = freeAt === null ? 0 : Math.ceil((freeAt - Date.now()) / 1000)
    if (left > 0) {
      return {
        error: tr('server.waitBetweenQuestionsTryAgainIn.f64333', {
          p0: seconds(gap),
          p1: seconds(left),
        }),
        retryAfter: left,
      }
    }
  }
  return null
}
