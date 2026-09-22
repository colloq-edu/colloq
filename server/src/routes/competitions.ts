/**
 * Публичные двери соревнований — всё, что открыто по адресу `/k`.
 *
 * Здесь нет ни одной двери преподавателя: те живут в `/api/admin/competitions`
 * и спрашивают `requireStaff`. Разделение не косметическое — это граница, по
 * которой проходит ВСЁ право соревнования. Ниже не отдаётся ни код метрики, ни
 * зерно деления строк, ни скрытые ответы, ни приватный результат до открытия
 * лидерборда, ни чужая посылка, ни чужой трейс. Каждое из этих «не» стоит
 * своего теста (tests/competitions-entrants.test.mts), потому что каждое
 * ломается молча: ответ становится чуть шире, экран выглядит так же, а
 * соревнование можно выиграть, не решая задачу.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ. Личность участника (ключ входа, вход, выход), список
 * соревнований со сводкой, страница одного, вступление, мои посылки, отправка
 * тетради файлом, отмена своей посылки, выбор зачётной, лидерборды, живой поток
 * и скачивание — открытых файлов данных и своей собственной тетради.
 *
 * Отмена не убивает контейнер сама: она зовёт `cancelSubmission(id, 'entrant')`
 * прогонщика, потому что знать, что и как убивать, — его дело, а проверить, что
 * посылка ТВОЯ и ещё идёт, — здешнее.
 *
 * ЧЕГО НЕТ НАРОЧНО. Загрузки «из тетради в занятии»: владелец убрал её из
 * макета, единственный способ прислать решение — файл.
 */
import busboy from 'busboy'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import { tr } from '@shared/i18n'
import { readEnvironmentInventory } from '../environment-inventory.js'
import { acceptPinnedSubmission, executionRevision, publicExecution } from '../dependencies/service.js'
import { DependencyStoreError } from '../dependencies/store.js'
import { dependencyMessage } from '../dependencies/messages.js'
import { addressOf } from '../bans.js'
import { config } from '../config.js'
import { downloadHeldFile, type HeldFile } from '../secure-files.js'
import {
  clearEntrantCookie,
  currentEntrant,
  issueEntrantCookie,
  requireEntrant,
  slideEntrantCookie,
  type EntrantRequest,
} from '../competitions/identity.js'
import {
  chooseSubmission,
  createEntrant,
  entrantByKey,
  entrantKeyOf,
  findCompetition,
  getSubmission,
  inFlightCount,
  joinCompetition,
  joinedAt,
  leaderboard,
  leftToday,
  listCompetitions,
  listEntrantSubmissions,
  listFiles,
  listSubmissions,
  acceptSubmission,
  competitionSummary,
  getEntrant,
  leaveQueue,
  myCompetitionIds,
  queuePaused,
  queueRows,
  submissionCounts,
  updateSubmission,
} from '../competitions/store.js'
import { fairOrder, waitEtas, withoutBaseline } from '../competitions/panel.js'
import { cancelSubmission, queueSlots, wakeCompetitionPump } from '../competitions/runner.js'
import {
  ensureCompetition,
  holdOpenFile,
  holdResultFile,
  holdSubmittedNotebook,
  putSubmissionNotebook,
  NOTEBOOK_FILE,
} from '../competitions/storage.js'
import {
  entrantSubmission,
  ENTRANT_SIGN_IN_PATH,
  isTerminal,
  LIMITS,
  normalizeEntrantKey,
  privateBoardOpen,
  publicCompetition,
  submissionsOpen,
  whyNotebookRefused,
  type Competition,
  type CompetitionRefusal,
  type Entrant,
  type RankedRow,
} from '@shared/competitions'
import type { CompetitionCounts } from '@shared/competitions-api'
import type {
  EntrantBoardLine,
  EntrantCompetitionList,
  EntrantCompetitionView,
  EntrantLeaderboard,
  EntrantMe,
  EntrantSubmissions,
  SubmissionAccepted,
  SubmissionLive,
} from '@shared/competitions-entrant'

/*
 * Ответы собираются через `reply<T>`, а не голым `res.json({…})`.
 *
 * `res.json` принимает `any`: поле, переименованное в `competitions-entrant.ts`,
 * не роняет ни сборку сервера, ни сборку браузера — страница просто рисует
 * пустое место там, где было число, и узнают об этом на паре. Одна аннотация
 * на дверь превращает такое расхождение в ошибку компиляции.
 */
function reply<T>(res: Response, body: T): void {
  res.json(body)
}

function refuse(res: Response, status: number, reason: CompetitionRefusal, error: string): void {
  res.status(status).json({ error, reason })
}

/* ------------------------------------------------------------- частота */

/**
 * Сколько раз с одного адреса — тем же способом, что у входа в комнату и у
 * оракула (routes/sessions.ts, routes/ai.ts).
 *
 * Считается по адресу, а не по человеку, и это весь смысл: у скрипта нет
 * человека, он его заводит. Класс за одним NAT входит разом, поэтому окна
 * длинные, а числа — с запасом на поток; цикл упирается сюда в первые секунды.
 */
function tooOften(bucket: Map<string, number[]>, address: string | null, windowMs: number, max: number): boolean {
  if (!address) return false
  const now = Date.now()
  const recent = (bucket.get(address) ?? []).filter((at) => now - at < windowMs)
  if (recent.length >= max) {
    bucket.set(address, recent)
    return true
  }
  recent.push(now)
  bucket.set(address, recent)
  // Карта иначе растёт весь семестр: адресов за пару больше, чем людей.
  if (bucket.size > 5000) {
    for (const [key, hits] of bucket) if (hits.every((at) => now - at >= windowMs)) bucket.delete(key)
  }
  return false
}

const MINUTE = 60_000
/** Подбор ключа: 31⁹ вариантов, так что это защита от шума, а не от перебора. */
const signIns = new Map<string, number[]>()
const SIGN_IN_WINDOW = 10 * MINUTE
const MAX_SIGN_INS = 40
/** Вступление заводит СТРОКУ УЧАСТНИКА — ровно то, чем скрипт раздувает базу. */
const joins = new Map<string, number[]>()
const JOIN_WINDOW = 10 * MINUTE
const MAX_JOINS = 60
/** Отправка: настоящий предел — дневная норма, этот стоит за разбор тетради. */
const uploads = new Map<string, number[]>()
const UPLOAD_WINDOW = MINUTE
const MAX_UPLOADS = 12

/* --------------------------------------------------------------- помощники */

/**
 * Соревнование, каким его видит участник, — или `null`.
 *
 * Черновик не существует на `/k` вовсе: у него ещё нет ни данных, ни
 * проверенного бейзлайна, а адрес уже есть, и открытый заранее он раздал бы
 * классу задачу, которую преподаватель ещё пишет.
 */
function visible(slugOrId: string): Competition | null {
  const competition = findCompetition(slugOrId)
  if (!competition || competition.state === 'draft') return null
  return competition
}

/** Публичное число бейзлайна — строка «бейзлайн 0.0587» в карточке (P1). */
function baselineScore(competition: Competition): number | null {
  if (!competition.baselineSubmissionId) return null
  return getSubmission(competition.baselineSubmissionId)?.publicScore ?? null
}

/** Кому записана сэмпл-тетрадь: её строку таблица отбивает пунктиром внизу. */
function baselineEntrantOf(competition: Competition): string | null {
  if (!competition.baselineSubmissionId) return null
  return getSubmission(competition.baselineSubmissionId)?.entrantId ?? null
}

/**
 * Сводка соревнования БЕЗ базового решения — теми же числами, что у панели.
 *
 * Сэмпл-тетрадь записана обычной посылкой служебного участника, иначе её
 * незачем было бы гонять тем же путём. Но «2 участника» на соревновании, где
 * человек один, и «лидер 0.5023», где лидер — это бейзлайн, — ровно та мелочь,
 * по которой перестают верить всему экрану. Панель убирает её через
 * `withoutBaseline` (competitions/panel.ts), и здесь то же самое: два разных
 * ответа на один вопрос хуже одного неверного.
 */
function summaryOf(competition: Competition): CompetitionCounts {
  const baseline = baselineEntrantOf(competition)
  const rows = baseline ? listEntrantSubmissions(competition.id, baseline) : []
  const best = leaderboard(competition.id, 'public').find(
    (row) => row.entrantId !== baseline,
  )?.score ?? null
  return withoutBaseline(competitionSummary(competition.id), rows, best)
}

/**
 * Строка лидерборда с именем: место без имени не показать.
 *
 * Номер посылки и то, выбрал ли её автор, едут сюда ради колонки «ПОСЫЛКА В
 * ЗАЧЁТ» (P3): «#12 · выбор участника» и «#19 · лучший публичный результат» —
 * разные вещи, и по одному идентификатору их не различить.
 */
function withNames(
  rows: readonly RankedRow[],
  counts: Map<string, number>,
  me: Entrant | null,
  baseline: string | null,
): EntrantBoardLine[] {
  return rows.map((row) => {
    const submission = getSubmission(row.submissionId)
    return {
      place: row.place,
      entrantId: row.entrantId,
      name: getEntrant(row.entrantId)?.name ?? '',
      score: row.score,
      submissionId: row.submissionId,
      number: submission?.number ?? 0,
      chosen: submission?.chosen ?? false,
      submissions: counts.get(row.entrantId) ?? 0,
      baseline: baseline !== null && row.entrantId === baseline,
      you: me !== null && row.entrantId === me.id,
    }
  })
}

/* ----------------------------------------------------------- живая очередь */

/**
 * Сколько в среднем идёт посылка ЭТОГО соревнования, мс.
 *
 * Своё число, а не общее по инстансу: рядом может идти соревнование, где
 * тетрадь учит бустинг десять минут, и «≈ 6 мин» под простой задачей — это
 * обещание, из-за которого человек уходит с экрана.
 *
 * По последним двадцати заходам, а не по всем: соревнование живёт неделями, и
 * первые посылки — это чужая задача, решённая в три строки до того, как класс
 * взялся за настоящую.
 */
function averageRunMs(competition: Competition): number | null {
  const spans = listSubmissions(competition.id)
    .map((submission) => submission.durationMs)
    .filter((ms): ms is number => typeof ms === 'number' && ms > 0)
    .slice(-20)
  if (spans.length === 0) return null
  return Math.round(spans.reduce((sum, ms) => sum + ms, 0) / spans.length)
}

/**
 * Очередь глазами одного человека — то, что движется на экране само.
 *
 * Место считается по ВСЕЙ очереди инстанса и тем же порядком, каким берёт
 * работу исполнитель (`fairOrder`): «третья в очереди» должно означать то же
 * самое, что означает оно у преподавателя, иначе два экрана спорят о числе,
 * которое человек проверяет секундомером.
 */
function liveOf(competition: Competition, me: Entrant, now = Date.now()): SubmissionLive[] {
  const mine = listEntrantSubmissions(competition.id, me.id).filter(
    (submission) => !isTerminal(submission.state),
  )
  if (mine.length === 0) return []
  const rows = queueRows()
  const running = rows.filter((row) => row.state === 'running')
  const ordered = fairOrder(
    rows.filter((row) => row.state === 'waiting'),
    new Set(running.map((row) => row.entrantId)),
  )
  const limitMs = competition.limits.wallSeconds * 1000
  const average = averageRunMs(competition)
  const left = running.map((row) => {
    const guess = average === null ? limitMs : Math.min(average, limitMs)
    return Math.max(0, guess - (now - (row.startedAt ?? now)))
  })
  const etas = waitEtas(ordered.length, {
    runningLeftMs: left,
    averageMs: average,
    slots: queueSlots(),
  })
  return mine.map((submission): SubmissionLive => {
    const at = ordered.findIndex((row) => row.submissionId === submission.id)
    /*
     * Чья посылка идёт прямо передо мной — и только МОЯ: «запуск после
     * завершения посылки #12» про чужой номер не говорит ничего, а сам номер
     * это чужая строка в чужом списке.
     */
    const ahead = at < 0
      ? null
      : [...running, ...ordered.slice(0, at)]
          .reverse()
          .find((row) => row.entrantId === me.id) ?? null
    return {
      submissionId: submission.id,
      place: at < 0 ? null : at + 1,
      etaMs: at < 0 ? null : (etas[at] ?? null),
      startedAt: running.find((row) => row.submissionId === submission.id)?.startedAt ?? null,
      limitMs,
      aheadNumber: ahead ? (getSubmission(ahead.submissionId)?.number ?? null) : null,
      stage: submission.stage,
      cellsDone: submission.cellsDone,
      cellsTotal: submission.cellsTotal,
    }
  })
}

/** «Мои посылки» одним куском — его же отдаёт живой поток. */
function submissionsView(competition: Competition, me: Entrant): EntrantSubmissions {
  const now = Date.now()
  const open = privateBoardOpen(competition, now)
  return {
    submissions: listEntrantSubmissions(competition.id, me.id).map((s) => entrantSubmission(publicExecution(s, competition.environment), open)),
    leftToday: leftToday(competition, me.id),
    perDay: competition.limits.perDay,
    inFlight: inFlightCount(competition.id, me.id),
    accepting: submissionsOpen(competition, now),
    joined: joinedAt(competition.id, me.id) !== null,
    live: liveOf(competition, me, now),
    paused: queuePaused(),
  }
}

/**
 * Что человек знает о себе в этом соревновании — блок «ВЫ» карточки P1.
 *
 * Место считается СРЕДИ ЛЮДЕЙ: базовое решение стоит в таблице обычной
 * строкой (так в макете P3), но в знаменателе везде участники, и место из
 * общей таблицы однажды даёт «2 из 1» — на соревновании, где бейзлайн ещё
 * никто не обошёл.
 */
function mineIn(competition: Competition, me: Entrant) {
  const baseline = baselineEntrantOf(competition)
  const board = leaderboard(competition.id, 'public').filter((row) => row.entrantId !== baseline)
  const at = board.findIndex((row) => row.entrantId === me.id)
  const mySubmissions = listEntrantSubmissions(competition.id, me.id)
  return {
    joined: joinedAt(competition.id, me.id) !== null || mySubmissions.length > 0,
    place: at < 0 ? null : at + 1,
    score: at < 0 ? null : board[at].score,
    submissions: mySubmissions.length,
    inFlight: inFlightCount(competition.id, me.id),
    leftToday: leftToday(competition, me.id),
  }
}

/** Ключ и ссылка — только своему хозяину, и только этими двумя полями. */
function keyCard(entrant: Entrant): { key: string | null; link: string | null } {
  const key = entrantKeyOf(entrant.id)
  return { key, link: key ? `${config.publicUrl}${ENTRANT_SIGN_IN_PATH}${key}` : null }
}

function sendHeld(res: Response, hold: () => HeldFile, name: string): void {
  let file: HeldFile
  try {
    file = hold()
  } catch {
    return refuse(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
  }
  downloadHeldFile(res, file, name)
}

/* ------------------------------------------------------------------ двери */

export function competitionRoutes(inventory = readEnvironmentInventory): Router {
  const router = Router()

  /*
   * Печенье продлевается работой на ВСЕХ страницах `/k`, а не только там, где
   * спрашивают право: человек неделю читает задачу и лидерборд, ничего не
   * отправляя, и выйти из-за этого не должен.
   */
  router.use('/api/k', (req, res, next) => {
    slideEntrantCookie(req, res)
    next()
  })

  /* ------------------------------------------------------------ личность */

  /** Кто я, мой ключ и ссылка для входа — карточка «ВАШ КЛЮЧ ВХОДА» (P1). */
  router.get('/api/k/me', (req, res) => {
    const entrant = currentEntrant(req)
    if (!entrant) return reply<EntrantMe>(res, { entrant: null, key: null, link: null })
    reply<EntrantMe>(res, { entrant, ...keyCard(entrant) })
  })

  /**
   * Вход по ключу — и по полю «Введите ключ», и по ссылке `/k/t/<ключ>`.
   *
   * Ключ едет телом POST, а не в адресе двери: адрес попадает в журнал сервера
   * и в заголовок `Referer` любой картинки на странице. То, что он всё-таки
   * виден в строке браузера у ссылки для входа, — плата за саму ссылку, и
   * страница стирает его оттуда сразу после обмена.
   */
  router.post('/api/k/sign-in', (req, res) => {
    if (tooOften(signIns, addressOf(req), SIGN_IN_WINDOW, MAX_SIGN_INS)) {
      res.setHeader('Retry-After', '60')
      return refuse(res, 429, 'too_often', tr('competitions.refusal.tooOften'))
    }
    const key = normalizeEntrantKey(typeof req.body?.key === 'string' ? req.body.key : '')
    if (!key) return refuse(res, 404, 'key_unknown', tr('competitions.refusal.keyUnknown'))
    const entrant = entrantByKey(key)
    if (!entrant) return refuse(res, 404, 'key_unknown', tr('competitions.refusal.keyUnknown'))
    /*
     * «Отключён» и «нет такого» — разные отказы нарочно (см. store · entrantByKey):
     * в первом случае человеку уже выдали новый ключ и идти надо за ним, во
     * втором он ошибся буквой. Одно слово на оба случая отправило бы половину
     * класса к преподавателю за ключом, который у них и так есть.
     */
    if (entrant.disabled) return refuse(res, 403, 'key_disabled', tr('competitions.refusal.keyDisabled'))
    issueEntrantCookie(res, entrant)
    reply<EntrantMe>(res, { entrant, ...keyCard(entrant) })
  })

  router.post('/api/k/sign-out', (_req, res) => {
    clearEntrantCookie(res)
    res.json({ ok: true })
  })

  /* ------------------------------------------------------- соревнования */

  /** Список для P1: идущие и завершённые, с тем, что человек знает о себе. */
  router.get('/api/k/competitions', (req, res) => {
    const me = currentEntrant(req)
    const mine = me ? myCompetitionIds(me.id) : new Set<string>()
    const rows = listCompetitions()
      .filter((competition) => competition.state !== 'draft')
      .map((competition) => {
        const summary = summaryOf(competition)
        const about = me ? mineIn(competition, me) : null
        return {
          competition: publicCompetition(competition),
          entrants: summary.entrants,
          submissions: summary.submissions,
          bestPublic: summary.bestPublic,
          baselinePublic: baselineScore(competition),
          privateOpen: privateBoardOpen(competition, Date.now()),
          mine: about && { ...about, joined: about.joined || mine.has(competition.id) },
        }
      })
    reply<EntrantCompetitionList>(res, { entrant: me, competitions: rows })
  })

  /** Страница одного соревнования: задача, файлы на скачивание, условия проверки. */
  router.get('/api/k/competitions/:slug', (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = currentEntrant(req)
    const summary = summaryOf(competition)
    reply<EntrantCompetitionView>(res, {
      // publicCompetition — не украшение ответа, а единственное место, где с
      // соревнования снимают код метрики и зерно деления строк.
      competition: publicCompetition(competition),
      files: listFiles(competition.id, 'open').map((file) => ({
        name: file.name,
        bytes: file.bytes,
        rows: file.rows,
      })),
      entrants: summary.entrants,
      submissions: summary.submissions,
      bestPublic: summary.bestPublic,
      baselinePublic: baselineScore(competition),
      privateOpen: privateBoardOpen(competition, Date.now()),
      accepting: submissionsOpen(competition, Date.now()),
      mine: me ? mineIn(competition, me) : null,
    })
  })

  /** Installed packages are public only through a published competition. */
  router.get('/api/k/competitions/:slug/environment', async (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    try {
      res.json(await inventory(competition.environment))
    } catch {
      refuse(res, 503, 'unavailable', tr('common.environmentUnavailable'))
    }
  })

  /**
   * «УЧАСТВОВАТЬ»: назваться и получить ключ.
   *
   * Одна дверь на два случая — новичок и вернувшийся, — потому что на экране
   * это одна кнопка. Новичку заводится личность инстанса и выдаётся ключ,
   * который он увидит один раз крупно; вошедший просто вступает, и ключа в
   * ответе нет: он у него уже есть.
   */
  router.post('/api/k/competitions/:slug/join', (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    /*
     * Вступают только в идущее. У завершённого на P1 нет кнопки «УЧАСТВОВАТЬ»
     * вовсе — одна ссылка «Итоги и разбор», — и заводить в нём новых людей
     * значит добавлять имена в таблицу, которая уже посчитана.
     */
    const accepting = submissionsOpen(competition, Date.now())
    if (accepting === 'not_open') return refuse(res, 403, 'not_open', tr('competitions.refusal.notOpen'))
    if (accepting === 'closed') return refuse(res, 403, 'closed', tr('competitions.refusal.closed'))
    const known = currentEntrant(req)
    const wanted = String(req.body?.name ?? '').trim()
    const name = wanted || known?.name || ''
    if (!name) return refuse(res, 400, 'invalid', tr('competitions.refusal.nameEmpty'))

    if (!known && tooOften(joins, addressOf(req), JOIN_WINDOW, MAX_JOINS)) {
      res.setHeader('Retry-After', '60')
      return refuse(res, 429, 'too_often', tr('competitions.refusal.tooOften'))
    }

    /*
     * Тёзка проверяется ДО того, как заводится новая личность: иначе отказ
     * «такое имя занято» оставлял бы за собой участника без соревнования и без
     * ключа, которого человек не видел, — строку, которую некому убрать.
     */
    if (known) {
      if (joinCompetition(competition.id, known.id, name) === 'taken') {
        return refuse(res, 409, 'name_taken', tr('competitions.refusal.nameTaken'))
      }
      return reply<EntrantMe>(res, { entrant: getEntrant(known.id), key: null, link: null })
    }
    const minted = createEntrant(name)
    if (joinCompetition(competition.id, minted.entrant.id, name) === 'taken') {
      // Личность остаётся: она уровня инстанса, и человек вступит под другим
      // именем тем же ключом. Печенье поэтому выдаётся и здесь.
      issueEntrantCookie(res, minted.entrant)
      return refuse(res, 409, 'name_taken', tr('competitions.refusal.nameTaken'))
    }
    issueEntrantCookie(res, minted.entrant)
    reply<EntrantMe>(res, {
      entrant: getEntrant(minted.entrant.id),
      key: minted.key,
      link: `${config.publicUrl}${ENTRANT_SIGN_IN_PATH}${minted.key}`,
    })
  })

  /**
   * Лидерборды — оба сразу, но приватный только когда он открыт.
   *
   * Одной дверью, потому что экран P3 показывает их рядом: «ИТОГОВЫЙ MAPE» и
   * «ПУБЛИЧНЫЙ MAPE · место» в соседних колонках, а стрелка сдвига считается из
   * разницы мест. Два запроса за этим дали бы две картины разных секунд.
   *
   * `private: null` — не «пусто», а «ещё закрыт», и это ровно то, ради чего
   * приватная часть существует: под неё нельзя подогнаться, обновляя страницу.
   */
  router.get('/api/k/competitions/:slug/leaderboard', (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = currentEntrant(req)
    const counts = submissionCounts(competition.id)
    const open = privateBoardOpen(competition, Date.now())
    const baseline = baselineEntrantOf(competition)
    reply<EntrantLeaderboard>(res, {
      public: withNames(leaderboard(competition.id, 'public'), counts, me, baseline),
      private: open
        ? withNames(leaderboard(competition.id, 'private'), counts, me, baseline)
        : null,
      privateOpen: open,
      baselinePublic: baselineScore(competition),
    })
  })

  /** Открытые файлы данных. Скрытых ответов здесь нет — и другой двери тоже. */
  router.get('/api/k/competitions/:slug/files/:name', (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const name = req.params.name
    /*
     * Имя сверяется со СПИСКОМ открытых файлов, а не только с буквами пути.
     * `storage.checkName` не пускает `..` и слэши, но имя `solution.csv` он
     * пропустит — и если такой файл когда-нибудь окажется в `data/`, дверь
     * отдаст его. Список — единственный источник правды о том, что открыто.
     */
    if (!listFiles(competition.id, 'open').some((file) => file.name === name)) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.fileMissing'))
    }
    sendHeld(res, () => holdOpenFile(competition.id, name), name)
  })

  /* ------------------------------------------------------------- посылки */

  /** «Мои посылки»: приватного числа и трейса здесь нет — см. entrantSubmission. */
  router.get('/api/k/competitions/:slug/submissions', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    reply<EntrantSubmissions>(res, submissionsView(competition, (req as EntrantRequest).entrant!))
  })

  /**
   * То же самое, но само, — пока у человека что-то идёт.
   *
   * Server-sent events, как у живого журнала сборки окружений и как у экрана
   * преподавателя (`/api/admin/competitions/:id/stream`): поток в одну сторону,
   * браузер переподключается сам, и никакого второго протокола ради трёх чисел.
   * Сокет комнаты сюда не годится вовсе — это страница вне занятия, у неё нет
   * ни комнаты, ни документа, ни присутствия.
   *
   * Отдаётся не по таймеру, а по изменению: страница, на которой ничего не
   * происходит, не должна перерисовываться раз в секунду — а происходит здесь
   * ровно две вещи, смена этапа и смена места в очереди.
   */
  router.get('/api/k/competitions/:slug/stream', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Ретранслятор по умолчанию копит ответ — то есть превращает живой
      // экран в один пакет в конце пары.
      'X-Accel-Buffering': 'no',
    })
    let last = ''
    const push = (): void => {
      const fresh = findCompetition(competition.id)
      if (!fresh) return
      const body = JSON.stringify(submissionsView(fresh, me))
      if (body === last) return
      last = body
      res.write(`event: state\ndata: ${body}\n\n`)
    }
    push()
    const tick = setInterval(push, 1000)
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000)
    req.on('close', () => {
      clearInterval(tick)
      clearInterval(beat)
    })
  })

  /**
   * Отправка тетради файлом.
   *
   * Отказы стоят в том порядке, в каком человек их понимает: сначала «приём
   * закрыт», потом «вы не вступили», потом «прошлая ещё идёт», потом «на
   * сегодня хватит», и только после этого разбирается файл. Наоборот было бы
   * жестоко: двадцать мегабайт по телефонному интернету ради ответа «дедлайн
   * прошёл ещё вчера».
   */
  router.post('/api/k/competitions/:slug/submissions', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!

    const accepting = submissionsOpen(competition, Date.now())
    if (accepting === 'not_open') return refuse(res, 403, 'not_open', tr('competitions.refusal.notOpen'))
    if (accepting === 'closed') return refuse(res, 403, 'closed', tr('competitions.refusal.closed'))
    /*
     * «Вступил» — это строка в таблице ИЛИ хоть одна прежняя посылка. Второе
     * условие держит на плаву соревнования, заведённые до того, как вступление
     * стало отдельным шагом: человек с двенадцатью посылками не должен на
     * тринадцатой услышать «сначала вступите».
     */
    const joined = joinedAt(competition.id, me.id) !== null
      || listEntrantSubmissions(competition.id, me.id).length > 0
    if (!joined) return refuse(res, 403, 'not_joined', tr('competitions.refusal.notJoined'))
    /*
     * Одна посылка в полёте на человека — не из вежливости к очереди, а из
     * честности: исполнитель один на весь инстанс, и десять тетрадей одного
     * человека, поставленные разом, это пара, в которой больше никто ничего не
     * отправит. Очередь и так пропускает его вперёд по разу (store · turn), но
     * это про порядок, а не про число.
     */
    if (inFlightCount(competition.id, me.id) > 0) {
      return refuse(res, 409, 'in_flight', tr('competitions.refusal.inFlight'))
    }
    const left = leftToday(competition, me.id)
    if (left !== null && left <= 0) {
      return refuse(res, 429, 'quota', tr('competitions.refusal.dailyQuota', { count: competition.limits.perDay }))
    }
    if (tooOften(uploads, addressOf(req), UPLOAD_WINDOW, MAX_UPLOADS)) {
      res.setHeader('Retry-After', '60')
      return refuse(res, 429, 'too_often', tr('competitions.refusal.tooOften'))
    }

    readNotebook(req, res, async (fileName, body, bundleId) => {
      const revision = await executionRevision(competition)
      const submission = acceptPinnedSubmission(competition, me.id, fileName, body.length, revision, bundleId)
      try {
        ensureCompetition(competition.id)
        putSubmissionNotebook(competition.id, submission.id, body)
      } catch (error) {
        /*
         * Тетрадь не легла на диск — значит исполнять нечего. Строка снимается
         * с очереди и помечается снятой: оставить её ждущей значило бы отдать
         * исполнителю посылку, которая в первую же секунду скажет «нет
         * тетради», и потратить на это дневную норму человека.
         */
        leaveQueue(submission.id)
        updateSubmission(submission.id, { state: 'cancelled', stage: 'accepted' })
        throw error
      }
      /*
       * Будим исполнителя сразу, а не ждём его секундного такта.
       *
       * Тетрадь уже на диске, место в очереди может быть свободно — и всё же
       * посылка до секунды стояла бы в «В ОЧЕРЕДИ» просто потому, что таймер
       * ещё не тикнул. Студент в эту секунду смотрит на экран телефона и
       * ничего другого не делает. Все двери преподавателя будят насос тем же
       * вызовом; эта осталась единственной, которая молчала.
       */
      wakeCompetitionPump()
      reply<SubmissionAccepted>(res, {
        submission: entrantSubmission(
          publicExecution(getSubmission(submission.id)!, competition.environment),
          privateBoardOpen(competition, Date.now()),
        ),
        leftToday: leftToday(competition, me.id),
      })
    })
  })

  /** «Выбрать в зачёт». Чужую посылку выбрать нельзя — это проверяет store. */
  router.post('/api/k/competitions/:slug/submissions/:id/choose', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    const submission = getSubmission(req.params.id)
    if (!submission || submission.competitionId !== competition.id) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    }
    if (submission.entrantId !== me.id) {
      // 404 сказал бы «такой посылки нет», и это было бы неправдой; 403 с этим
      // словом честнее и ничего не выдаёт: номер посылки человек и так видел.
      return refuse(res, 403, 'forbidden', tr('competitions.refusal.notYours'))
    }
    /*
     * Выбор замерзает на дедлайне — вместе с приёмом.
     *
     * Иначе приватная часть перестаёт быть скрытой для всех, кто прислал больше
     * одной посылки: итоги открываются, человек видит приватное число КАЖДОЙ
     * своей посылки в «моих посылках» и ставит в зачёт лучшую. Это не обход
     * правила, а прямая подгонка под скрытую часть — ровно то, ради чего она и
     * заведена. Свободы это не отнимает: до дедлайна выбор меняют сколько
     * угодно раз.
     */
    if (submissionsOpen(competition, Date.now()) !== 'open') {
      return refuse(res, 403, 'closed', tr('competitions.refusal.chooseClosed'))
    }
    if (!chooseSubmission(competition.id, me.id, submission.id)) {
      return refuse(res, 409, 'invalid', tr('competitions.refusal.notScored'))
    }
    // Весь список целиком, а не одна строка: выбор снимает пометку с прежней
    // посылки, и экран, дорисовавший только нажатую, показал бы две «в зачёт».
    reply<EntrantSubmissions>(res, submissionsView(competition, me))
  })

  /**
   * «Отменить» — снять свою посылку с очереди или оборвать её прогон.
   *
   * Ждущая уходит из очереди строкой в базе; идущую снимает прогонщик, убивая
   * контейнер (runner · cancelSubmission). Отдельной двери «убить» у участника
   * нет и быть не может: он называет посылку, а что с ней делать — решает тот,
   * кто знает, чем она сейчас занята.
   *
   * `false` от прогонщика — не ошибка, а «не успели»: пока запрос ехал, прогон
   * кончился сам. Этот случай в макете не нарисован, и врать про него нельзя.
   */
  router.post('/api/k/competitions/:slug/submissions/:id/cancel', requireEntrant, async (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    const submission = getSubmission(req.params.id)
    if (!submission || submission.competitionId !== competition.id) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    }
    if (submission.entrantId !== me.id) {
      return refuse(res, 403, 'forbidden', tr('competitions.refusal.notYours'))
    }
    if (!(await cancelSubmission(submission.id, 'entrant'))) {
      return refuse(res, 409, 'invalid', tr('competitions.refusal.tooLateToCancel'))
    }
    reply<EntrantSubmissions>(res, submissionsView(competition, me))
  })

  /**
   * Своя тетрадь: исполненная, а до конца прогона — присланная.
   *
   * «Скачать тетрадь с выводом» (P2) — это то, ради чего человек вообще
   * смотрит на упавшую посылку: трейс в списке короткий, а причина бывает
   * видна только в выводе соседней ячейки.
   */
  router.get('/api/k/competitions/:slug/submissions/:id/notebook', requireEntrant, (req, res) => {
    const competition = visible(req.params.slug)
    if (!competition) return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    const me = (req as EntrantRequest).entrant!
    const submission = getSubmission(req.params.id)
    if (!submission || submission.competitionId !== competition.id) {
      return refuse(res, 404, 'not_found', tr('competitions.refusal.notFound'))
    }
    if (submission.entrantId !== me.id) {
      return refuse(res, 403, 'forbidden', tr('competitions.refusal.notYours'))
    }
    sendHeld(
      res,
      () => {
        try {
          return holdResultFile(competition.id, submission.id, NOTEBOOK_FILE)
        } catch {
          return holdSubmittedNotebook(competition.id, submission.id)
        }
      },
      submission.fileName,
    )
  })

  return router
}

/* ------------------------------------------------------- разбор тетради */

/**
 * Прочитать одну тетрадь из multipart и отдать её байты.
 *
 * В память, а не во временный файл, и это решение про число: потолок здесь
 * свой — `LIMITS.notebookBytes`, двадцать мегабайт, — потому что `nbformat.read`
 * в контейнере всё равно разберёт файл целиком. Настоящие тетради на два
 * порядка меньше; те, что больше, — это забытый вывод ячеек с картинками, и
 * честный ответ на них «очистите вывод», а не «не хватило памяти» через десять
 * минут исполнения.
 *
 * `config.maxUploadBytes` (файлы комнаты) здесь не годится ни как потолок, ни
 * как ориентир: он про датасет, который студент приносит на пару.
 */
function readNotebook(req: Request, res: Response, done: (fileName: string, body: Buffer, bundleId: string | null) => void | Promise<void>): void {
  let bb: ReturnType<typeof busboy>
  try {
    bb = busboy({
      headers: req.headers,
      // Иначе busboy читает имя файла как latin-1, и `модель.ipynb` приезжает
      // крокозябрами — ровно та же правка, что в routes/files.ts.
      defParamCharset: 'utf8',
      limits: { fileSize: LIMITS.notebookBytes, files: 1, fields: 2, fieldSize: 4096 },
    })
  } catch {
    return refuse(res, 400, 'invalid', tr('competitions.refusal.noFile'))
  }

  const chunks: Buffer[] = []
  let fileName = ''
  let answered = false
  let tooBig = false
  let bundleId: string | null = null
  let sawBundle = false

  const say = (status: number, reason: CompetitionRefusal, error: string) => {
    if (answered) return
    answered = true
    req.unpipe(bb)
    req.resume()
    refuse(res, status, reason, error)
  }

  bb.on('file', (field, stream, info) => {
    if (field !== 'file' || fileName) return stream.resume()
    fileName = path.basename(info.filename ?? '')
    stream.on('limit', () => {
      tooBig = true
      stream.resume()
    })
    stream.on('data', (chunk: Buffer) => {
      if (!tooBig) chunks.push(chunk)
    })
  })

  bb.on('field', (field, value, info) => {
    if (field !== 'bundleId') return
    if (sawBundle || info.valueTruncated || (value !== '' && !/^[a-f0-9]{32}$/.test(value))) {
      say(400, 'invalid', dependencyMessage('dependency_owner'))
      return
    }
    sawBundle = true
    bundleId = value || null
  })
  bb.on('fieldsLimit', () => say(400, 'invalid', dependencyMessage('dependency_limits')))
  bb.on('filesLimit', () => say(400, 'invalid', tr('competitions.refusal.notIpynb')))

  bb.on('error', () => say(400, 'invalid', tr('competitions.refusal.noFile')))

  bb.on('close', () => {
    if (answered) return
    if (tooBig) {
      return say(413, 'too_big', tr('competitions.refusal.tooBig', { count: Math.round(LIMITS.notebookBytes / (1024 * 1024)) }))
    }
    if (!fileName || chunks.length === 0) return say(400, 'invalid', tr('competitions.refusal.noFile'))
    if (!fileName.toLowerCase().endsWith('.ipynb')) {
      return say(400, 'invalid', tr('competitions.refusal.notIpynb'))
    }
    const body = Buffer.concat(chunks)
    /*
     * Разбор ДО очереди. Битый JSON в одноразовом контейнере становится «упала
     * тетрадь» — приговором коду, которого человек не писал, да ещё и потраченной
     * посылкой из пяти дневных (@shared/competitions · whyNotebookRefused).
     */
    const refusal = whyNotebookRefused(body.toString('utf8'))
    if (refusal) return say(400, 'invalid', refusal)
    answered = true
    void Promise.resolve().then(() => done(fileName, body, bundleId)).catch((error: unknown) => {
      if (res.headersSent) return
      if (error instanceof DependencyStoreError) {
        refuse(res, error.status, 'invalid', dependencyMessage(error.code))
      } else {
        console.error('[competitions] accepting notebook failed', error)
        refuse(res, 503, 'unavailable', tr('common.requestFailed', { status: 503 }))
      }
    })
  })

  req.pipe(bb)
}
