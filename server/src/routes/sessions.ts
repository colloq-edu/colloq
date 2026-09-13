import { tr } from '@shared/i18n'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { kernelRetirementInProgress } from '../kernel/retirement.js'
import { currentStaff, staffFromCookieHeader } from '../admin/auth.js'
import { getTeacher } from '../admin/store.js'
import {
  HANDOFF_TTL_MS,
  newParticipantId,
  newSessionId,
  signHandoffToken,
  signHostToken,
  signToken,
  spendHandoffToken,
  type TokenPayload,
  verifyHostToken,
  verifyToken,
} from '../auth.js'
import { addressOf, banFor, banRefusal, deviceOf } from '../bans.js'
import { config } from '../config.js'
import {
  createSession,
  getParticipant,
  storedRules,
  getSession,
  isFinished,
  isTokenHost,
  listParticipants,
  setRules,
  setSessionCpus,
  setSessionMemoryMb,
  upsertParticipant,
} from '../db.js'
import { onlineParticipantIds } from '../collab/index.js'
import { freeMark } from '@shared/marks'
import { seldom, tally } from '../log.js'
import { ensureKernel } from '../kernel/index.js'
import { forgetResources, readCpuInput, readMemoryInput } from '../kernel/resources.js'
import { activeName, exists as environmentExists } from '../environments.js'
import { publicationOf, stepCount } from '../publish/store.js'
import { broadcast } from '../control.js'
import { readRules } from '@shared/rules'
import { normalizeLabel } from '@shared/text'
import { courseOfSeminar } from './course-view.js'
import { isArchived, setSeminarCreator } from './admin-instance.js'
import { ENVIRONMENT_NAME, type AdminErrorBody } from '@shared/admin'
import { SESSION_MISSING } from '@shared/protocol'
import type {
  CreateSessionResponse,
  HandoffResponse,
  JoinResponse,
  ParticipantRole,
  SessionMe,
} from '@shared/protocol'

/*
 * Lengths that have to survive being drawn, not just stored. A seminar name is
 * a display heading and a person's name sits in a cell footer and an avatar
 * tooltip, so both are cut where the layout stops coping rather than where the
 * column would. The avatar is one emoji, and 512 UTF-16 code units is
 * room for the longest of them — flags and family sequences run long.
 */
const MAX_SESSION_NAME = 80
const MAX_PARTICIPANT_NAME = 40
const MAX_AVATAR = 512

/**
 * Collapse whitespace and drop control characters so a name cannot break the
 * roster layout.
 *
 * Правило одно на все двери и живёт в shared/text.ts: то же имя приезжает из
 * панели, из списка штата и из импорта, и трёх дословных копий этой функции
 * хватило, чтобы четвёртая дверь обошлась голым trim().
 */
const normalize = normalizeLabel

/**
 * Аватар — знак, а не адрес.
 *
 * Проверялась одна длина, а рисуется эта строка как `<img src>`, если
 * начинается с http или data: (web/src/components/ui/Avatar.svelte). То есть
 * один запрос заставлял браузер КАЖДОГО в комнате сходить на чужой сервер — и
 * в ростере, и в подписи каждой его ячейки, включая опоздавших. Схему
 * отвергаем здесь; в комнате аватар приезжает ещё и через awareness, и это
 * закрывается не тут, а на отрисовке.
 */
function readAvatar(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const avatar = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!avatar || avatar.length > MAX_AVATAR) return null
  // Любая схема, а не только http и data: эмодзи двоеточием не начинается, а
  // список поддерживаемых картинок у браузера длиннее нашей памяти.
  if (/^[a-z][a-z0-9+.-]*:/i.test(avatar)) return null
  return avatar
}

/**
 * Сколько НОВЫХ участников комната принимает за минуту.
 *
 * Вход не требует ничего, кроме ссылки, и без доказанной пары
 * participantId+token заводит новую строку. Скрипт в цикле раздувал этим
 * ростер и базу семинара до десятков тысяч «людей», которых никто никогда не
 * видел, — и список приезжал каждому настоящему участнику целиком.
 * Возвращающийся со своим токеном сюда не попадает вовсе, и штат тоже.
 *
 * Число было 120 и опиралось на «больше, чем даёт любая настоящая пара».
 * Это перестало быть правдой: нагрузочный стенд на потоке в пятьсот человек
 * показал 122 вошедших и 378 отказов — вся вторая половина зала упиралась в
 * защиту от скрипта и должна была нажимать заново, а клиент повторять не
 * умеет. Шестьсот — это полный поток плюс перезаходы тех, у кого моргнул
 * вайфай, и по-прежнему на порядки меньше, чем даёт цикл: тот делает тысячи
 * в минуту и упирается сюда в первые секунды.
 */
const ARRIVAL_WINDOW_MS = 60_000
const MAX_NEW_PARTICIPANTS = 600
const arrivals = new Map<string, number[]>()

/*
 * И по адресу тоже. Шестьсот в минуту на комнату — про звонок, когда входит
 * весь поток; но пятьсот «участников» с одного адреса за два часа (13.09.2026,
 * скрипт против оракула) под этот потолок не попали. Класс за одним NAT
 * входит разом, поэтому окно длиннее, а число — с запасом на аудиторию.
 */
const ADDRESS_WINDOW_MS = 10 * 60_000
const MAX_NEW_PER_ADDRESS = 60
const arrivalsByAddress = new Map<string, number[]>()

function tooManyArrivalsFrom(sessionId: string, address: string | null): boolean {
  if (!address) return false
  const key = `${sessionId} ${address}`
  const now = Date.now()
  const recent = (arrivalsByAddress.get(key) ?? []).filter((at) => now - at < ADDRESS_WINDOW_MS)
  if (recent.length >= MAX_NEW_PER_ADDRESS) {
    arrivalsByAddress.set(key, recent)
    return true
  }
  recent.push(now)
  arrivalsByAddress.set(key, recent)
  if (arrivalsByAddress.size > 5000) {
    for (const [k, v] of arrivalsByAddress) if (v.every((at) => now - at >= ADDRESS_WINDOW_MS)) arrivalsByAddress.delete(k)
  }
  return false
}

function tooManyArrivals(sessionId: string): boolean {
  const now = Date.now()
  const recent = (arrivals.get(sessionId) ?? []).filter((at) => now - at < ARRIVAL_WINDOW_MS)
  if (recent.length >= MAX_NEW_PARTICIPANTS) {
    arrivals.set(sessionId, recent)
    return true
  }
  recent.push(now)
  arrivals.set(sessionId, recent)
  return false
}

/**
 * Метка выдаётся на входе, и судья у неё один — сервер.
 *
 * Экран входа выбирает зверя по ростеру и обещает: «Picked from the ones
 * nobody in this room has taken». Клиент это обещание сузил до круга сети
 * (web/src/components/join/pick.ts перечитывает ростер прямо перед стуком), но
 * закрыть не может: две вкладки, постучавшие в одну и ту же секунду, друг
 * друга не видят. Сорок меток на класс из тридцати дают около одиннадцати пар
 * с одним зверем — то есть с одинаковым курсором в тетради, а цвет их не
 * различает (он минтуется из id). Замечают это на двадцатой минуте.
 *
 * Занятыми считаются двое: те, кто В КОМНАТЕ сейчас (тот же список, что отдаёт
 * `/participants` полем `online`), и те, кому метку выдали здесь только что.
 * Второе — не перестраховка, а весь смысл: между `/join` и первым кадром
 * присутствия проходит секунда, и без короткой памяти класс, открывший ссылку
 * разом, весь укладывается в эту секунду и расходится с одинаковыми зверями.
 *
 * Своё прошлое место не в счёт: вернувшийся занимает ровно ту метку, что была
 * его, и подменять её нечем и незачем.
 */
const MARK_HOLD_MS = 60_000
/** Комнат, после которых память чистится вся: иначе она растёт до перезапуска. */
const MARK_ROOMS_KEPT = 200

interface HandedMark {
  id: string
  mark: string
  at: number
}

const handedOut = new Map<string, HandedMark[]>()

function recentMarks(sessionId: string): HandedMark[] {
  const now = Date.now()
  const fresh = (handedOut.get(sessionId) ?? []).filter((row) => now - row.at < MARK_HOLD_MS)
  if (fresh.length > 0) handedOut.set(sessionId, fresh)
  else handedOut.delete(sessionId)
  return fresh
}

function rememberMark(sessionId: string, id: string, mark: string): void {
  // Свою прошлую метку человек не держит: вход второй вкладкой — это он же.
  const fresh = recentMarks(sessionId).filter((row) => row.id !== id)
  fresh.push({ id, mark, at: Date.now() })
  handedOut.set(sessionId, fresh)
  // Комнаты, из которых давно никто не входил, вычищаются оптом: минута
  // жизни у строки, а сама карта иначе помнит каждую комнату инстанса.
  if (handedOut.size > MARK_ROOMS_KEPT) for (const id of [...handedOut.keys()]) recentMarks(id)
}

/**
 * Метка, с которой человек войдёт на самом деле.
 *
 * Подменяется занятая И невыбранная: человек мог ткнуть в конкретного зверя
 * руками (`picked`), и менять выбранное просто потому, что нам так удобнее, —
 * худшее из двух зол. Подборщик занятые метки нажать не даёт и перечитывает
 * ростер при открытии (web/src/components/join/MarkPicker.svelte), так что
 * выбранная руками совпадёт разве что в круге сети, — а два ежа в комнате
 * дешевле экрана, который молча сделал вид, что не услышал.
 *
 * Пустую метку не выдумываем: вошедший без неё — это вход мимо экрана (пульт,
 * скрипт), и раздавать ему зверя незачем.
 */
function markToHand(
  sessionId: string,
  asked: string | null,
  mine: string | null,
  picked: boolean,
): string | null {
  if (!asked || picked) return asked
  const inside = new Set(onlineParticipantIds(sessionId))
  const taken = new Set<string>()
  for (const person of listParticipants(sessionId)) {
    if (person.id === mine || !person.avatar || !inside.has(person.id)) continue
    taken.add(person.avatar)
  }
  for (const row of recentMarks(sessionId)) if (row.id !== mine) taken.add(row.mark)
  return taken.has(asked) ? freeMark(taken, null) : asked
}

/**
 * Почему вошедший оказался НОВЫМ человеком, а не собой прежним.
 *
 * На боевой машине в одном семинаре набралось пятьсот строк участника с одним
 * и тем же именем, и по коду причина не видна: браузер шлёт и participantId, и
 * токен, а строка всё равно заводится новая. Условие возврата — конъюнкция из
 * четырёх частей, и в журнале нужна та её часть, которая не выполнилась,
 * иначе выяснять это можно только гаданием.
 *
 * Ни имени, ни аватара, ни содержимого токена: только то, какая проверка
 * не прошла.
 */
type JoinedAs =
  | 'back'
  | 'no id'
  | 'no token'
  | 'bad token'
  | 'other room'
  | 'other person'
  | 'row gone'

function joinedAs(
  sessionId: string,
  claimed: string | null,
  sent: unknown,
  proof: TokenPayload | null,
  returning: boolean,
): JoinedAs {
  if (returning) return 'back'
  if (claimed === null) return 'no id'
  if (typeof sent !== 'string' || !sent) return 'no token'
  // Разбор проваливается двумя способами сразу — кривая подпись и возраст
  // старше TOKEN_MAX_AGE_MS, — и различить их снаружи `verifyToken` нельзя.
  // Для расследования этого хватает: и то и другое означает «предъявить нечего».
  if (proof === null) return 'bad token'
  if (proof.sessionId !== sessionId) return 'other room'
  if (proof.participantId !== claimed) return 'other person'
  // Всё сошлось, а строки нет: семинар чистили или базу разворачивали заново.
  return 'row gone'
}

/**
 * Провал прогрева — одной строкой на комнату, а не на каждого вошедшего.
 *
 * `ensureKernel` отдаёт одно общее обещание всем, кто позвал его в ту же
 * миллисекунду, а `.catch` вешает каждый: в журнале лежало по шестнадцать
 * одинаковых строк на комнату за одну миллисекунду, и настоящая причина в них
 * тонула. Комната узнаёт о провале своим путём — записью в журнал ядра внутри
 * `ensureKernel`; журналу процесса довольно одной строки в минуту.
 */
const WARMUP_QUIET_MS = 60_000
const warmupWarnedAt = new Map<string, number>()

function noteWarmupFailure(sessionId: string, err: unknown): void {
  const now = Date.now()
  if (now - (warmupWarnedAt.get(sessionId) ?? 0) < WARMUP_QUIET_MS) return
  for (const [id, at] of warmupWarnedAt) if (now - at >= WARMUP_QUIET_MS) warmupWarnedAt.delete(id)
  warmupWarnedAt.set(sessionId, now)
  console.warn(
    `[session ${sessionId}] kernel warmup failed:`,
    err instanceof Error ? err.message : err,
  )
}

/**
 * Токен из заголовка, если он про ЭТУ комнату.
 *
 * Header only. The query string used to be accepted here as well, for the
 * one route that needs it — a download is an `<a href download>` and an
 * anchor cannot send a header — but accepting it everywhere meant the string
 * that opens the control socket travelled in a URL a teacher could copy into
 * a group chat. The download route has its own short-lived credential now
 * (signDownloadToken); this one takes a header and nothing else.
 */
function bearerFor(req: Request): TokenPayload | null {
  const header = req.headers.authorization ?? ''
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const payload = verifyToken(raw)
  if (!payload || payload.sessionId !== req.params.id) return null
  return payload
}

/**
 * Бан на пороге всего, что живёт под /api/sessions/:id.
 *
 * Одна дверь на все REST-маршруты комнаты — файлы, история, оракул,
 * консилиум, правила, — и висит она в каждом роутере отдельно, потому что
 * порядок монтирования в app.ts — не то место, где такое можно помнить.
 * `sessionAuth` про бан знает и сам; здесь смысл в словах: человек должен
 * прочитать «преподаватель закрыл вам доступ», а не «войдите в семинар».
 *
 * Отказ — только тому, кто предъявил токен этой комнаты. Гость без токена
 * проходит: по этому же пути идёт экран входа и `/join`, а у них про бан свой
 * разговор — и отказать раньше значило бы показать пришедшему «семинар не
 * найден» вместо объяснения. Метка устройства при этом считается: она у
 * `banFor` вторая половина совпадения.
 */
export function banDoor(req: Request, res: Response, next: NextFunction): void {
  if (kernelRetirementInProgress(String(req.params.id))) {
    res.status(503).json({ error: tr("server.theSeminarIsStoppingTryAgainShortly.b8256e") })
    return
  }
  const payload = bearerFor(req)
  if (!payload) return next()
  const ban = banFor(payload.sessionId, payload.participantId, req.headers.cookie)
  if (!ban) return next()
  res.status(403).json(banRefusal(ban))
}

/**
 * Bearer credential that must belong to the `:id` in the path. Lives here
 * because this module mints the tokens; the file and AI routes import it.
 *
 * A staff cookie outranks the role the token was minted with — the same rule
 * the WebSocket upgrade applies in effectiveRole(), and it has to be the same
 * rule or the product answers one question two ways. It did: a teacher who
 * opened the seminar link before signing in holds a participant token for a
 * room that is theirs, and while the sockets let them interrupt the kernel, the
 * HTTP side refused them a checkpoint, a restore and the thread's own eraser.
 * Same person, same browser, same second, two answers.
 *
 * Re-read per request rather than baked into the token, so signing out of the
 * teaching side takes the powers with it on the next call.
 */
export function sessionAuth(req: Request): TokenPayload | null {
  const payload = bearerFor(req)
  if (!payload) return null
  /*
   * Забаненный не проходит и здесь.
   *
   * Проверка бана стояла на двух дверях из трёх — `/join` и рукопожатие
   * сокета, — а токен участника подписан и живёт до тридцати суток, отобрать
   * его нечем. То есть закрытый доступ закрывал комнату и не закрывал ничего
   * по HTTP: раздатка, история, загрузка файлов (тот самый спам, за который и
   * банят) и вопросы оракулу за ключ инстанса оставались открыты до истечения
   * токена. Словами про бан отвечает `banDoor` ниже; здесь — чтобы маршрут,
   * который его забыл повесить, всё равно не пустил.
   */
  if (banFor(payload.sessionId, payload.participantId, req.headers.cookie)) return null
  /*
   * The role is decided here, on every request, and never read from the token.
   *
   * It used to be baked in at join time, which made `host` permanent: a teacher
   * removed from the staff list kept Restart, Clear and Restore in every room
   * they had ever opened, because their old token still said so. The cookie is
   * the only thing that can be taken away, so it is the only thing that grants.
   * The one exception is a seminar created straight against the API, where a
   * host token is the only credential there is — that is minted host and stays
   * host, and it is the path no browser walks.
   */
  return { ...payload, role: roleFor(req.headers.cookie, payload) }
}

/**
 * Кто это — на этот запрос, а не на момент входа.
 *
 * Одна функция на оба входа нарочно. Их было две, и они отвечали по-разному:
 * HTTP помнил выданные хост-токены в множестве в памяти, а сокет про это
 * множество не знал вовсе — так что автор семинара, заведённого скриптом,
 * получал `host` на кнопках и `participant` на соединении, которым эти кнопки
 * работают. Расходиться им теперь негде.
 */
export function roleFor(
  cookieHeader: string | undefined,
  payload: Pick<TokenPayload, 'sessionId' | 'participantId'> & { staff?: string },
): TokenPayload['role'] {
  // Кука сильнее и проверяется первой: её можно отобрать, и в этом смысл.
  if (staffFromCookieHeader(cookieHeader)) return 'host'
  /*
   * Пульт, уехавший на планшет: куки там нет, но и вечного права быть не
   * должно. Токен называет преподавателя, чьей кукой это право держится, и
   * спрашивается оно здесь — убранный из штата теряет пульт вместе со всем
   * остальным, ровно как если бы он сидел за ноутбуком.
   */
  if (payload.staff && getTeacher(payload.staff)) return 'host'
  return isTokenHost(payload.sessionId, payload.participantId) ? 'host' : 'participant'
}

/**
 * Греть ли ядро на входе.
 *
 * `/join` звал `ensureKernel` безусловно, а при изоляции это старт контейнера
 * комнаты — и он живёт два часа простоя. Вечером перед контрольной класс
 * открывает десяток ЗАКОНЧЕННЫХ семинаров курса перечитать разбор, и каждый
 * такой заход поднимал по контейнеру (порядка двух гигабайт) на той же машине,
 * где в это время идёт живая пара. Запускать студенту там всё равно нельзя:
 * конец занятия отдаёт `run` преподавателю (shared/rules.ts · rulesAfterClass).
 *
 * Преподаватель греет всегда: он приходит в законченную комнату как раз затем,
 * чтобы что-то в ней пересчитать, и ждать подъёма ядра после нажатия Run ему
 * незачем. Архивный семинар — то же самое: метка «убран из списка» и означает,
 * что работать в нём больше не собираются.
 */
export function warmsKernel(sessionId: string, role: ParticipantRole): boolean {
  if (role === 'host') return true
  return !isFinished(sessionId) && !isArchived(sessionId)
}

export function sessionRoutes(): Router {
  const router = Router()

  /**
   * «А меня-то пускают» — единственная дверь, отвечающая забаненному.
   *
   * Стоит ДО `banDoor` намеренно, и это не оплошность порядка: вкладка, которой
   * отказали в рукопожатии сокета, не знает, что с ней случилось. Сокет
   * закрывается до апгрейда и без слов — браузер видит 1006, — и различить
   * «комнаты нет», «ключ протух» и «преподаватель закрыл доступ» можно только
   * спросив. Отказ на этот вопрос отказом («вам сюда нельзя») оставлял бы
   * человека ровно там же, где он был: за 403 без объяснения. Поэтому здесь
   * `banFor` спрашивается сам и его срок едет в ответе.
   *
   * И дёшево: зовёт её каждая отвалившаяся вкладка примерно раз в полминуты,
   * то есть на большой лекции — сотнями в минуту. Ни дерева файлов, ни
   * документа комнаты, ни ростера: строка семинара, разбор подписи и одна
   * строка бана.
   *
   * Что значит каждое поле — у `SessionMe` в shared/protocol.ts.
   */
  router.get('/api/sessions/:id/me', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })

    const payload = bearerFor(req)
    if (!payload) {
      // Ключа нет или он про другую комнату — «предъявите ключ», а не «вас
      // удалили»: про бан без доказанного идентификатора сказать нечего.
      const nobody: SessionMe = {
        tokenValid: false,
        ban: null,
        participantId: null,
        role: null,
      }
      return res.json(nobody)
    }

    const ban = banFor(payload.sessionId, payload.participantId, req.headers.cookie)
    const me: SessionMe = {
      tokenValid: true,
      ban: ban ? { until: ban.until } : null,
      participantId: payload.participantId,
      // Роль — та, которой сервер будет действовать на этом ключе прямо
      // сейчас (кука сильнее токена, см. roleFor). У забаненного её нет: он
      // ничего не может, и называть его ведущим было бы неправдой.
      role: ban ? null : roleFor(req.headers.cookie, payload),
    }
    res.json(me)
  })

  // Бан закрывает и эту дверь: /rules, /participants, /handoff и всё, что
  // авторизуется токеном комнаты. `/join` проходит мимо (токен у него в теле,
  // а не в заголовке) и отказывает сам, своими словами.
  router.use('/api/sessions/:id', banDoor)

  router.post('/api/sessions', (req, res) => {
    // Who may open a room. An instance with OPEN_SEMINAR_CREATION off is one
    // where a visitor spinning up a seminar would be spending the owner's API
    // key, so staff are the only ones left; the students who matter here arrive
    // through /join with a link and never touch this route.
    const staff = currentStaff(req)
    if (!config.openSeminarCreation && !staff) {
      const denied: AdminErrorBody = {
        error:
          tr("server.onlyStaffCanCreateASeminarOn.eb0b8c"),
        reason: 'forbidden',
      }
      return res.status(403).json(denied)
    }

    const name = normalize(req.body?.name)
    if (!name) return res.status(400).json({ error: tr("server.aSessionNameIsRequired.15da74") })
    if (name.length > MAX_SESSION_NAME) {
      return res.status(400).json({
        error: tr("server.sessionNameMustBeCharactersOrFewer.a4c426", { p0: MAX_SESSION_NAME }),
      })
    }

    /*
     * Окружение записывается ИМЕНЕМ, и всегда.
     *
     * `createSession(id, name)` писал NULL, а NULL для ядра означает «следуй за
     * инстансом»: следующее «Make default» уводило Python такой комнаты на
     * другой образ, а панель показывала у неё пустую колонку и не считала её в
     * тех, кто держит окружение от удаления. Панель это состояние отменила
     * (routes/admin-instance.ts · «A concrete name is always recorded»), и
     * скриптовая дверь обязана жить по тому же правилу — иначе их два.
     *
     * Имя можно и прислать: та же проверка, что в панели, чтобы в строку
     * семинара не легло имя несуществующего образа.
     */
    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return res.status(400).json({ error: tr("server.thereIsNoEnvironmentCalled.a8903e", { p0: wanted }) })
    }

    /*
     * Память комнаты — только штату, и только в границах машины.
     *
     * На открытом инстансе эту дверь толкает кто угодно, и «сколько памяти
     * отдать» — не тот вопрос, который решает гость: комната, взявшая всё,
     * убивает не себя, а сервер под собой. Штат шлёт число, все остальные —
     * молчат, и тогда комната живёт умолчанием своего окружения.
     */
    const memory = readMemoryInput(req.body?.memoryMb)
    if (!memory.ok) {
      return res.status(400).json({ error: tr('server.memoryMustBeWholeMegabytes') })
    }
    if (memory.mb !== null && !staff) {
      return res.status(403).json({ error: tr('server.memoryIsStaffOnly'), reason: 'forbidden' })
    }
    const cpu = readCpuInput(req.body?.cpus)
    if (!cpu.ok) {
      return res.status(400).json({ error: tr('server.cpusMustBeWholeCores') })
    }
    if (cpu.cpus !== null && !staff) {
      return res.status(403).json({ error: tr('server.memoryIsStaffOnly'), reason: 'forbidden' })
    }

    const id = newSessionId()
    const session = createSession(id, name, wanted || activeName())
    if (memory.mb !== null) {
      setSessionMemoryMb(id, memory.mb)
      forgetResources()
    }
    if (cpu.cpus !== null) {
      setSessionCpus(id, cpu.cpus)
      forgetResources()
    }
    // A seminar created straight against this endpoint by a signed-in teacher
    // is still theirs. There is no page that does it — the panel has its own
    // route — so this is the scripted path, and on an open instance it produces
    // a seminar with nobody's name on it.
    if (staff) setSeminarCreator(id, staff.name)
    const body: CreateSessionResponse = {
      session,
      hostToken: signHostToken(id),
    }
    res.status(201).json(body)
  })

  router.get('/api/sessions/:id', (req, res) => {
    const session = getSession(req.params.id)
    if (!session) return res.status(404).json({ error: SESSION_MISSING })
    /*
     * Указатель на опубликованную версию — здесь, потому что здесь его читает
     * экран входа. Это чинит единственный адрес, который у студента правда
     * есть: ссылка в чате ведёт в комнату, и без подсказки человек через
     * неделю вводит имя в закончившееся занятие и остаётся в нём один.
     */
    const pub = publicationOf(session.id)
    const course = pub ? courseOfSeminar(session.id) : null
    res.json({
      ...session,
      published:
        pub && pub.state === 'published'
          ? { id: pub.id, slug: pub.slug, steps: stepCount(pub.id) }
          : null,
      course: course ? { id: course.id, name: course.name } : null,
    })
  })

  router.post('/api/sessions/:id/join', (req, res) => {
    const sessionId = req.params.id
    const session = getSession(sessionId)
    if (!session) return res.status(404).json({ error: SESSION_MISSING })

    const name = normalize(req.body?.name).slice(0, MAX_PARTICIPANT_NAME)
    if (!name) return res.status(400).json({ error: tr("server.aNameIsRequired.d1287e") })

    const asked = readAvatar(req.body?.avatar)
    // Строго `=== true`: поле приходит из браузера, и «истинное» вроде строки
    // или единицы права молчаливо не подменять метку не даёт.
    const picked = req.body?.picked === true

    /*
     * Role never comes from the client's stored identity — anyone could paste in
     * someone else's participantId and inherit their badge. Two things grant it:
     *
     *  - a signed host token, minted at creation and kept by whoever made the
     *    room, which is how an open instance with no staff list works;
     *  - a staff cookie. Seminars created in the admin panel never handed a host
     *    token to anybody, so nobody could interrupt or restart the kernel in
     *    them — the controls were dead for the whole room. A teacher signed in
     *    to this instance is exactly the person those controls are for, and the
     *    cookie is a stronger credential than the token.
     */
    const staff = currentStaff(req)
    // Два источника роли различаются в журнале, поэтому и считаются порознь.
    // `!staff &&` сохраняет прежний порядок: куке хост-токен не нужен.
    const byHostToken = !staff && verifyHostToken(sessionId, req.body?.hostToken)
    const role: ParticipantRole = staff || byHostToken ? 'host' : 'participant'

    /*
     * Coming back as yourself has to be proved.
     *
     * Awareness broadcasts every participant id to the whole room, because that
     * is how a caret gets a face — so "I am p_xyz" is a sentence any student in
     * the seminar can say about anybody in it. It never granted the badge: the
     * role is decided above, from credentials this request carries. But an
     * unproved claim still overwrote the row it named, which meant one person
     * could rename another in the participants list, take their avatar, and set
     * the role recorded against them back to participant.
     *
     * The proof is the token minted for that participant when they joined. Only
     * their own browser has it. Without it — a cleared store, another machine —
     * the visitor is somebody new, which is the honest reading of "I cannot show
     * you anything that says I was here before".
     */
    const claimed = typeof req.body?.participantId === 'string' ? req.body.participantId : null
    const proof = verifyToken(typeof req.body?.token === 'string' ? req.body.token : null)
    const proved =
      claimed !== null &&
      proof !== null &&
      proof.sessionId === sessionId &&
      proof.participantId === claimed
    const known = proved ? getParticipant(sessionId, claimed) : null

    /*
     * Забаненный узнаёт об этом здесь, до всего остального.
     *
     * Проверяется доказанный идентификатор, а не присланный: «я p_xyz» —
     * фраза, которую про любого может сказать любой (см. выше), и по ней можно
     * было бы примерить чужой бан на себя. Второй метки, устройства, это не
     * касается: её присылает браузер и только свою.
     *
     * До счётчика новых участников: наплыв — это про комнату, а бан — про
     * одного человека, и получить в ответ «слишком много входов» вместо
     * «преподаватель закрыл вам доступ» значит не понять ничего.
     */
    const ban = banFor(sessionId, known?.id ?? null, req.headers.cookie)
    if (ban) {
      console.log(
        `[join ${sessionId}] banned ${known ? known.id : 'by device'} · until ${ban.until}`,
      )
      return res.status(403).json(banRefusal(ban))
    }

    // Незнакомец заводит строку — и это единственное место, где комната растёт
    // от чужого запроса. Штат и вернувшиеся со своим токеном проходят мимо.
    if (!known && !staff && (tooManyArrivals(sessionId) || tooManyArrivalsFrom(sessionId, addressOf(req)))) {
      tally('joins')
      // Первый отказ за минуту — словами, остальные числом в сводке: стенд на
      // пятистах студентах дал 378 таких подряд, и это ровно тот поток, от
      // которого журнал и лечим.
      if (seldom(`arrivals:${sessionId}`)) {
        console.warn(`[join ${sessionId}] refused — more than ${MAX_NEW_PARTICIPANTS} new/min`)
      }
      return res.status(429).json({
        error: tr("server.tooManyPeopleAreJoiningThisSeminar.11739b"),
      })
    }
    const participantId = known ? known.id : newParticipantId()
    /*
     * По строке на каждый вход — и это сознательно не считается в сводку.
     *
     * Пятьсот входов за пару — пятьсот строк, столько журнал выносит; а вот
     * понять по нему, почему один и тот же человек заводится заново, без такой
     * строки нельзя вовсе. Ни имени, ни аватара, ни токена здесь нет: только
     * комната, участник, роль и то, какая проверка возврата не прошла.
     */
    const how = joinedAs(sessionId, claimed, req.body?.token, proof, known !== null)
    const why = staff ? 'staff' : byHostToken ? 'host-token' : 'link'
    console.log(
      `[join ${sessionId}] ${how === 'back' ? 'back' : 'new'} ${participantId} · ` +
        `${role} by ${why}${how === 'back' ? '' : ` · ${how}`}`,
    )

    /*
     * Метка — уже после того, как стало известно, кто вошёл: своё прошлое
     * место занятым не считается (см. markToHand). Ответ несёт ту, что выдана
     * на самом деле, — экран входа сохраняет её как есть и рисует ею курсор.
     */
    const avatar = markToHand(sessionId, asked, known?.id ?? null, picked)
    if (avatar) rememberMark(sessionId, participantId, avatar)

    // Хост-токен — единственное, что записывается насовсем: куку перечитывают
    // на каждом запросе, и «ведущий по куке» в строке был бы навсегда.
    const participant = upsertParticipant({
      id: participantId,
      sessionId,
      name,
      avatar,
      role,
      tokenHost: role === 'host' && !staff,
      // Метка браузера — чтобы бан по одному идентификатору закрывал и то
      // окно, из которого он через минуту придёт «новым человеком».
      device: deviceOf(req.headers.cookie),
    })
    const token = signToken({ sessionId, participantId, role })

    // Warm the kernel while the student is still reading the page; a failure
    // here is not fatal, the control socket reports kernel health on its own.
    // Но только там, где на нём будут работать, — см. warmsKernel.
    if (warmsKernel(sessionId, role)) {
      void ensureKernel(sessionId).catch((err: unknown) => noteWarmupFailure(sessionId, err))
    }

    const body: JoinResponse = { session, participant, token }
    res.json(body)
  })

  /**
   * Отдать свой пульт своему планшету.
   *
   * Лекцию ведут с айпада: страницу листают пальцем, пишут Pencil'ом, а
   * проектор показывает то, что приезжает по сети. Но чтобы планшет стал
   * пультом, он должен войти в комнату ТЕМ ЖЕ человеком и с теми же правами —
   * а прав у преподавателя ровно два источника, и оба на другой машине: кука
   * панели и токен в её localStorage.
   *
   * Эта дверь выдаёт ключ на обмен (см. signHandoffToken): десять минут, один
   * обмен. Права едут в самом ключе — либо это ведущий по своему хост-токену,
   * и тогда везти нечего, либо ведущий по куке, и тогда ключ называет его: на
   * планшете, где куки нет, тот же самый человек иначе оказался бы студентом,
   * а лекцию по правилу `board` вёл бы не он.
   *
   * Названо вслух: ключ пускает в комнату ВАМИ. Кто откроет ссылку первым, тот
   * и преподаватель — поэтому она живёт десять минут, гасится первым же
   * обменом и поэтому экран, который её показывает, говорит об этом прямо.
   */
  router.post('/api/sessions/:id/handoff', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const payload = sessionAuth(req)
    if (!payload) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (payload.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherMaySharePresenterControls.d098fa") })
    }
    const known = getParticipant(sessionId, payload.participantId)
    if (!known) return res.status(404).json({ error: tr("server.participantNotFound.d59506") })
    /*
     * Право переезжает вместе с человеком, но остаётся отзываемым.
     *
     * Здесь стояло `tokenHost: true` — и это ломало главный инвариант ролей:
     * семинар, заведённый в панели, хост-токена не имеет вовсе, преподаватель
     * в нём ведущий только по куке, и одно нажатие «Пульт» записывало ему
     * `token_host` навсегда. Снятый из штата сохранял Restart, Clear и Restore
     * в каждой комнате, где хоть раз открывал пульт, — ровно та дыра, ради
     * которой роль сделали невечной.
     *
     * Поэтому в ключ едет не флаг в базе, а имя преподавателя: планшет получит
     * токен с ним, а `roleFor` на каждом запросе спросит, есть ли такой в
     * штате. Ведущему по собственному хост-токену вписывать нечего — у него
     * `token_host` и так стоит, и отбирать его никто не собирался.
     */
    const staff = currentStaff(req)
    const grantedBy = staff?.id ?? payload.staff ?? null
    /*
     * Адрес отдаём мы, а не браузер преподавателя.
     *
     * Ссылку на пульт строили от `location.origin`, а комнату преподаватель
     * чаще всего открывает на `http://localhost:3000` — такая ссылка на
     * планшете не откроется вовсе, хотя семинар выставлен наружу. `PUBLIC_URL`
     * в комнате взять неоткуда, поэтому он едет в ответе; выбирает из двух
     * адресов уже клиент тем же правилом, что и панель (seminar-link.ts):
     * верить настройке, когда она называет адрес, который можно открыть.
     */
    const body: HandoffResponse = {
      key: signHandoffToken(sessionId, known.id, grantedBy),
      livesMs: HANDOFF_TTL_MS,
      origin: config.publicUrl,
    }
    res.json(body)
  })

  /**
   * Планшет меняет ключ на обычный вход.
   *
   * Ответ той же формы, что и у `/join`: дальше планшет ничем не отличается от
   * всякого вошедшего — тот же токен, та же личность в localStorage, тот же
   * сокет. Имени не спрашивает и спросить не может: человек тут уже известен,
   * и предлагать ему назваться заново значило бы заводить второго.
   */
  router.post('/api/sessions/:id/handoff/claim', (req, res) => {
    const sessionId = req.params.id
    const session = getSession(sessionId)
    if (!session) return res.status(404).json({ error: SESSION_MISSING })
    // Гасится здесь же: ключ обещан на один обмен, и это обещание держится
    // только тем, что второй обмен того же ключа получает отказ.
    const who = spendHandoffToken(sessionId, req.body?.key)
    if (!who) {
      return res.status(401).json({ error: tr("server.thisPresenterLinkIsInvalidOrHas.0f5b09") })
    }
    const known = getParticipant(sessionId, who.participantId)
    if (!known) return res.status(404).json({ error: tr("server.participantNotFound.d59506") })
    // Роль в строке — для значка в списке; `token_host` не трогаем: у ведущего
    // по своему ключу он уже стоит, а ведущему по куке его ставить нельзя.
    const participant = upsertParticipant({
      id: known.id,
      sessionId,
      name: known.name,
      avatar: known.avatar,
      role: 'host',
    })
    const body: JoinResponse = {
      session,
      participant,
      token: signToken({
        sessionId,
        participantId: known.id,
        role: 'host',
        ...(who.staff ? { staff: who.staff } : {}),
      }),
    }
    res.json(body)
  })

  /**
   * Правила комнаты — из самой комнаты.
   *
   * Без этой двери модель есть, а настроить её нечем: панель задаёт правила
   * только при создании, а ведущий по хост-токену в панель вообще не ходит —
   * семинар может быть целиком его, а правила в нём неизменяемы.
   *
   * Присланное накладывается на текущее, а не заменяет его: экран, который
   * трогает один переключатель, не должен уметь молча вернуть остальные к
   * умолчаниям.
   *
   * Законченное занятие эту дверь не закрывает: преподаватель готовит в той же
   * комнате следующую пару, а правила — выбор, который конец занятия ужесточает
   * поверх, не переписывая (shared/rules.ts · rulesAfterClass). Поэтому и
   * накладывается на `storedRules`: возьми проверка действующие, одно нажатие
   * посреди законченного занятия записало бы «всё преподавателю» насовсем.
   */
  router.patch('/api/sessions/:id/rules', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const payload = sessionAuth(req)
    if (!payload) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (payload.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherMayChangeThisSeminar.a9e299") })
    }
    const incoming: unknown = req.body?.rules
    if (typeof incoming !== 'object' || incoming === null) {
      return res.status(400).json({ error: tr("server.rulesMustBeAnObject.c2a9d1") })
    }
    const rules = setRules(sessionId, readRules({ ...storedRules(sessionId), ...incoming }))
    /*
     * Комната узнаёт сейчас, а не при следующей перезагрузке: интерфейс гасит
     * по этому кнопки, и правило, о котором не сказали, выглядит как поломка —
     * кнопка перестала работать и никто не знает почему.
     *
     * Едет выбранное, а не действующее: конец занятия комната накладывает сама
     * (web/src/lib/may.ts), и прислать ей уже ужесточённое значило бы показать
     * преподавателю в настройках не его выбор.
     */
    broadcast(sessionId, { t: 'rules', rules })
    res.json({ rules })
  })

  router.get('/api/sessions/:id/participants', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    /*
     * `participants` — все, кто когда-либо заходил; `online` — кто в комнате
     * сейчас. Экрану входа нужно второе, чтобы сказать «трое уже внутри» и не
     * посчитать позапрошлый поток.
     *
     * И ровно поэтому не вошедшему отдаётся только второе. Ссылка на семинар —
     * восемь символов, которые читают вслух; она открывает комнату, и это
     * задумано, но она не должна перечислять поимённо весь курс, ходивший на
     * него весь семестр. Тот, кто уже внутри, видит список целиком: он и так
     * видит их курсоры.
     */
    const online = onlineParticipantIds(sessionId)
    const everyone = listParticipants(sessionId)
    if (sessionAuth(req)) return res.json({ participants: everyone, online })
    const inside = new Set(online)
    res.json({
      participants: everyone.filter((p) => inside.has(p.id)),
      online,
    })
  })

  router.get('/api/sessions/:id/link', (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })
    res.json({ url: `${config.publicUrl}/s/${req.params.id}` })
  })

  return router
}
